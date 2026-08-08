import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  inspectArtifact,
  type ImportDiagnostic,
  type ImportPreview,
  type SourceArtifact,
} from '@tavernnext/st-compat';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';

export const INSPECTION_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ImportHandlerInspection {
  normalizedPreview: unknown;
  warnings: ImportDiagnostic[];
  blockingErrors: ImportDiagnostic[];
}

export interface ImportInspectionContext {
  artifact: SourceArtifact;
  preview: ImportPreview;
}

export interface ImportCommitContext {
  artifact: SourceArtifact;
  preview: ImportPreview;
  repositories: Repositories;
  /** Writes one task-owned asset and returns its data-directory-relative final path. */
  writeAsset(relativePath: string, bytes: Uint8Array): string;
}

export interface ImportCommitResult {
  entityId?: string;
}

/** Later compatibility tasks register typed handlers through this boundary. */
export interface ImportHandler {
  id: string;
  matches(preview: ImportPreview): boolean;
  inspect?(context: ImportInspectionContext): Promise<ImportHandlerInspection>;
  commit(context: ImportCommitContext): ImportCommitResult;
}

export interface ImportServiceOptions {
  dataDir: string;
  database: TavernDatabase;
  repositories: Repositories;
  handlers?: readonly ImportHandler[];
  clock?: () => number;
  moveAssets?: (source: string, destination: string) => void;
}

export interface StagedImportPreview extends ImportPreview {
  inspectionToken: string;
  expiresAt: string;
}

export interface ImportCommitReceipt {
  artifactId: string;
  entityId?: string;
  assetPath: string;
}

interface InspectionStage {
  path: string;
  preview: ImportPreview;
  artifact: Omit<SourceArtifact, 'bytes'>;
  expiresAt: number;
  handler: ImportHandler | undefined;
}

export class ImportTokenError extends Error {
  constructor(readonly code: 'inspection_token_invalid' | 'inspection_token_expired' | 'inspection_token_consumed', readonly statusCode: number) {
    super(code);
  }
}

export class ImportCommitError extends Error {
  constructor(readonly causeError: unknown) {
    super('import_commit_failed');
  }
}

function safeAssetPath(root: string, requestedPath: string): { absolute: string; portable: string } {
  const portable = requestedPath.replaceAll('\\', '/');
  if (portable === '' || portable.includes('\0') || isAbsolute(portable) || portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) {
    throw new Error('Invalid import asset path');
  }
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error('Invalid import asset path');
  const absolute = resolve(root, ...segments);
  const withinRoot = relative(root, absolute);
  if (withinRoot.startsWith(`..${sep}`) || withinRoot === '..' || isAbsolute(withinRoot)) throw new Error('Invalid import asset path');
  return { absolute, portable: segments.join('/') };
}

export interface ImportService {
  inspect(artifact: SourceArtifact): Promise<ImportPreview | StagedImportPreview>;
  commit(inspectionToken: string): ImportCommitReceipt;
  close(): void;
}

export function createImportService(options: ImportServiceOptions): ImportService {
  const clock = options.clock ?? Date.now;
  const moveAssets = options.moveAssets ?? renameSync;
  const handlers = options.handlers ?? [];
  const stagingRoot = join(options.dataDir, 'tmp', 'imports');
  const assetRoot = join(options.dataDir, 'assets', 'imports');
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(assetRoot, { recursive: true });
  const stages = new Map<string, InspectionStage>();
  const consumed = new Map<string, number>();
  const expired = new Map<string, number>();

  const removeStage = (stage: InspectionStage) => {
    rmSync(stage.path, { recursive: true, force: true });
  };
  const purge = () => {
    const now = clock();
    for (const [token, stage] of stages) {
      if (now < stage.expiresAt) continue;
      stages.delete(token);
      removeStage(stage);
      expired.set(token, now + INSPECTION_TOKEN_TTL_MS);
    }
    for (const [token, forgetAt] of consumed) if (now >= forgetAt) consumed.delete(token);
    for (const [token, forgetAt] of expired) if (now >= forgetAt) expired.delete(token);
  };

  return {
    async inspect(artifact) {
      purge();
      const originalArtifact: SourceArtifact = {
        fileName: artifact.fileName,
        bytes: artifact.bytes.slice(),
        ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      };
      let preview = await inspectArtifact(originalArtifact);
      if (preview.blockingErrors.length > 0) return preview;
      const handler = handlers.find((candidate) => candidate.matches(structuredClone(preview)));
      if (handler?.inspect !== undefined) {
        const handlerPreview = await handler.inspect({
          artifact: { ...originalArtifact, bytes: originalArtifact.bytes.slice() },
          preview: structuredClone(preview),
        });
        preview = {
          ...preview,
          normalizedPreview: handlerPreview.normalizedPreview,
          warnings: [...preview.warnings, ...handlerPreview.warnings],
          blockingErrors: [...preview.blockingErrors, ...handlerPreview.blockingErrors],
        };
        if (preview.blockingErrors.length > 0) return preview;
      } else if (handler === undefined) {
        preview = {
          ...preview,
          warnings: [...preview.warnings, {
            code: 'artifact_preserved_without_entity',
            message: 'No typed codec is registered yet; commit will preserve only the ImportArtifact row.',
          }],
        };
      }

      const stageId = randomUUID();
      const stagePath = join(stagingRoot, stageId);
      mkdirSync(stagePath, { mode: 0o700 });
      try {
        writeFileSync(join(stagePath, 'original.bin'), originalArtifact.bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        rmSync(stagePath, { recursive: true, force: true });
        throw error;
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = clock() + INSPECTION_TOKEN_TTL_MS;
      stages.set(token, {
        path: stagePath,
        preview,
        artifact: { fileName: originalArtifact.fileName, ...(originalArtifact.mediaType === undefined ? {} : { mediaType: originalArtifact.mediaType }) },
        expiresAt,
        handler,
      });
      return { ...preview, inspectionToken: token, expiresAt: new Date(expiresAt).toISOString() };
    },

    commit(inspectionToken) {
      const now = clock();
      for (const [token, forgetAt] of consumed) if (now >= forgetAt) consumed.delete(token);
      for (const [token, forgetAt] of expired) if (now >= forgetAt) expired.delete(token);
      if (expired.has(inspectionToken)) throw new ImportTokenError('inspection_token_expired', 410);
      if (consumed.has(inspectionToken)) throw new ImportTokenError('inspection_token_consumed', 409);
      const stage = stages.get(inspectionToken);
      if (stage === undefined) throw new ImportTokenError('inspection_token_invalid', 404);
      stages.delete(inspectionToken);
      if (now >= stage.expiresAt) {
        removeStage(stage);
        expired.set(inspectionToken, now + INSPECTION_TOKEN_TTL_MS);
        throw new ImportTokenError('inspection_token_expired', 410);
      }
      consumed.set(inspectionToken, now + INSPECTION_TOKEN_TTL_MS);

      const artifactId = randomUUID();
      const temporaryAssets = join(stage.path, 'assets.tmp');
      const finalAssets = join(assetRoot, artifactId);
      mkdirSync(temporaryAssets, { mode: 0o700 });
      let assetsMoved = false;
      try {
        const originalBytes = new Uint8Array(readFileSync(join(stage.path, 'original.bin')));
        const artifact: SourceArtifact = { ...stage.artifact, bytes: originalBytes.slice() };
        let result: ImportCommitResult = {};
        options.database.transaction(() => {
          const writeAsset = (requestedPath: string, contents: Uint8Array) => {
            const target = safeAssetPath(temporaryAssets, requestedPath);
            mkdirSync(dirname(target.absolute), { recursive: true });
            writeFileSync(target.absolute, contents, { flag: 'wx', mode: 0o600 });
            return ['assets', 'imports', artifactId, ...target.portable.split('/')].join('/');
          };
          result = stage.handler?.commit({ artifact, preview: structuredClone(stage.preview), repositories: options.repositories, writeAsset }) ?? {};
          options.repositories.importArtifacts.create({
            id: artifactId,
            kind: stage.preview.detected.kind === 'unknown' ? stage.preview.detected.container : stage.preview.detected.kind,
            sourceName: artifact.fileName,
            mediaType: artifact.mediaType?.trim() || 'application/octet-stream',
            rawArtifact: Buffer.from(originalBytes).toString('base64'),
            ...(result.entityId === undefined ? {} : { entityId: result.entityId }),
            compatibility: {
              sourceFormat: [stage.preview.detected.container, stage.preview.detected.kind, stage.preview.detected.version].filter(Boolean).join(':'),
              rawPayload: {
                sha256: stage.preview.source.sha256,
                detected: stage.preview.detected,
                normalizedPreview: stage.preview.normalizedPreview,
              },
              unknownFields: {},
              compatWarnings: stage.preview.warnings.map((warning) => warning.code),
              parserVersion: '1',
            },
          });
          // Moving before the transaction callback returns lets a move failure roll back rows.
          moveAssets(temporaryAssets, finalAssets);
          assetsMoved = true;
        });
        removeStage(stage);
        return {
          artifactId,
          ...(result.entityId === undefined ? {} : { entityId: result.entityId }),
          assetPath: ['assets', 'imports', artifactId].join('/'),
        };
      } catch (error) {
        if (assetsMoved) rmSync(finalAssets, { recursive: true, force: true });
        removeStage(stage);
        throw new ImportCommitError(error);
      }
    },

    close() {
      for (const stage of stages.values()) removeStage(stage);
      stages.clear();
      consumed.clear();
      expired.clear();
    },
  };
}
