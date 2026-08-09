import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_INSPECTION_LIMITS,
  inspectArtifact,
  MEBIBYTE,
  type ImportDiagnostic,
  type ImportPreview,
  type SourceArtifact,
} from '@tavernnext/st-compat';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';

export const INSPECTION_TOKEN_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_IMPORT_STAGING_LIMITS = Object.freeze({
  maxLiveStages: 64,
  maxStagedBytes: 512 * MEBIBYTE,
  maxConcurrentInspections: 2,
});
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_CLEANUP_RETRIES = 3;
const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertDirectManagedDirectory(dataDir: string, directory: string): void {
  const relativePath = relative(resolve(dataDir), resolve(directory));
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('Unsafe managed asset directory');
  let current = resolve(dataDir);
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error('Managed asset directory cannot contain links');
    const actual = resolve(realpathSync(current));
    const expected = resolve(current);
    if (process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) {
      throw new Error('Managed asset directory cannot contain reparse points');
    }
  }
}

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
  commitOptions?: unknown;
  /** Writes one task-owned asset and returns its data-directory-relative final path. */
  writeAsset(relativePath: string, bytes: Uint8Array): string;
  /** Stages one image into an entity-bound avatar directory and returns its data-directory-relative final path. */
  writeEntityAvatar(kind: 'characters' | 'personas', entityId: string, extension: 'png' | 'jpg' | 'gif' | 'webp', bytes: Uint8Array): string;
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

export interface ImportStagingLimits {
  maxLiveStages: number;
  maxStagedBytes: number;
  maxConcurrentInspections: number;
}

export interface ImportServiceOptions {
  dataDir: string;
  database: TavernDatabase;
  repositories: Repositories;
  handlers?: readonly ImportHandler[];
  clock?: () => number;
  moveAssets?: (source: string, destination: string) => void;
  removeStage?: (path: string) => void;
  cleanupIntervalMs?: number;
  limits?: ImportStagingLimits;
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
  size: number;
  liveAccounted: boolean;
  bytesAccounted: boolean;
}

interface ProvisionalInspection {
  path: string;
  size: number;
  liveAccounted: boolean;
  bytesAccounted: boolean;
}

type ExpiryItem =
  | { at: number; kind: 'stage'; token: string }
  | { at: number; kind: 'consumed'; token: string }
  | { at: number; kind: 'expired'; token: string }
  | { at: number; kind: 'orphan'; path: string }
  | { at: number; kind: 'cleanup'; path: string; retry: number };

interface CleanupTarget {
  path: string;
  stage?: ProvisionalInspection;
}

class ExpiryHeap {
  readonly values: ExpiryItem[] = [];

  peek(): ExpiryItem | undefined {
    return this.values[0];
  }

  push(item: ExpiryItem): void {
    let index = this.values.push(item) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.at <= item.at) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = item;
  }

  pop(): ExpiryItem | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (first === undefined || last === undefined || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child = right < this.values.length && this.values[right]!.at < this.values[left]!.at ? right : left;
      if (this.values[child]!.at >= last.at) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

export class ImportTokenError extends Error {
  constructor(readonly code: 'inspection_token_invalid' | 'inspection_token_expired' | 'inspection_token_consumed', readonly statusCode: number) {
    super(code);
  }
}

export class ImportQuotaError extends Error {
  readonly statusCode = 429;

  constructor(readonly code: 'import_live_stage_limit' | 'import_staged_bytes_limit' | 'import_inspection_concurrency_limit') {
    super(code);
  }
}

export class ImportUploadError extends Error {
  readonly statusCode = 413;

  constructor() {
    super('upload_too_large');
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function digestMatches(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.byteLength === actual.byteLength && timingSafeEqual(actual, expected);
}

export interface ImportService {
  acquireInspection(): ImportInspectionLease;
  inspect(artifact: SourceArtifact): Promise<ImportPreview | StagedImportPreview>;
  commit(inspectionToken: string, commitOptions?: unknown): ImportCommitReceipt;
  close(): void;
}

export interface ImportInspectionLease {
  write(bytes: Uint8Array): void;
  complete(metadata: Omit<SourceArtifact, 'bytes'>): Promise<ImportPreview | StagedImportPreview>;
  abort(): void;
}

export function createImportService(options: ImportServiceOptions): ImportService {
  const clock = options.clock ?? Date.now;
  const moveAssets = options.moveAssets ?? renameSync;
  const removeStagePath = options.removeStage ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const handlers = options.handlers ?? [];
  const limits = options.limits ?? DEFAULT_IMPORT_STAGING_LIMITS;
  const cleanupIntervalMs = Math.max(1, Math.min(options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS, DEFAULT_CLEANUP_INTERVAL_MS));
  const stagingRoot = join(options.dataDir, 'tmp', 'imports');
  const inspectionWorkspaceRoot = join(options.dataDir, 'tmp', 'inspection-workspaces');
  const assetRoot = join(options.dataDir, 'assets', 'imports');
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(inspectionWorkspaceRoot, { recursive: true });
  mkdirSync(assetRoot, { recursive: true });

  const stages = new Map<string, InspectionStage>();
  const consumed = new Map<string, number>();
  const expired = new Map<string, number>();
  const expiry = new ExpiryHeap();
  const pendingCleanup = new Map<string, { target: CleanupTarget; retry: number }>();
  const activeLeases = new Set<ImportInspectionLease>();
  let liveStages = 0;
  let stagedBytes = 0;
  let activeInspections = 0;
  let closed = false;

  const releaseLiveStage = (stage: ProvisionalInspection) => {
    if (!stage.liveAccounted) return;
    stage.liveAccounted = false;
    liveStages -= 1;
  };
  const releaseStageBytes = (stage: ProvisionalInspection) => {
    if (!stage.bytesAccounted) return;
    stage.bytesAccounted = false;
    stagedBytes -= stage.size;
  };
  const attemptCleanup = (target: CleanupTarget, retry = 0) => {
    try {
      removeStagePath(target.path);
      pendingCleanup.delete(target.path);
      if (target.stage !== undefined) releaseStageBytes(target.stage);
    } catch {
      if (closed || retry >= MAX_CLEANUP_RETRIES) return;
      const nextRetry = retry + 1;
      pendingCleanup.set(target.path, { target, retry: nextRetry });
      expiry.push({ at: clock() + cleanupIntervalMs, kind: 'cleanup', path: target.path, retry: nextRetry });
    }
  };
  const rememberTombstone = (kind: 'consumed' | 'expired', token: string, now: number) => {
    const forgetAt = now + INSPECTION_TOKEN_TTL_MS;
    (kind === 'consumed' ? consumed : expired).set(token, forgetAt);
    expiry.push({ at: forgetAt, kind, token });
  };
  const expireStage = (token: string, stage: InspectionStage, now: number) => {
    stages.delete(token);
    releaseLiveStage(stage);
    rememberTombstone('expired', token, now);
    attemptCleanup({ path: stage.path, stage });
  };
  const purgeDue = (now: number) => {
    while ((expiry.peek()?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const item = expiry.pop()!;
      if (item.kind === 'stage') {
        const stage = stages.get(item.token);
        if (stage !== undefined && stage.expiresAt === item.at) expireStage(item.token, stage, now);
      } else if (item.kind === 'consumed' || item.kind === 'expired') {
        const tokens = item.kind === 'consumed' ? consumed : expired;
        if (tokens.get(item.token) === item.at) tokens.delete(item.token);
      } else if (item.kind === 'orphan') {
        attemptCleanup({ path: item.path });
      } else {
        const pending = pendingCleanup.get(item.path);
        if (pending?.retry === item.retry) attemptCleanup(pending.target, item.retry);
      }
    }
  };

  const startupNow = clock();
  const recoverUuidDirectories = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!uuidDirectory.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      const details = lstatSync(path);
      if (!details.isDirectory() || details.isSymbolicLink()) continue;
      const removeAt = details.mtimeMs + INSPECTION_TOKEN_TTL_MS;
      if (removeAt <= startupNow) attemptCleanup({ path });
      else expiry.push({ at: removeAt, kind: 'orphan', path });
    }
  };
  recoverUuidDirectories(stagingRoot);
  recoverUuidDirectories(inspectionWorkspaceRoot);

  const cleanupTimer = setInterval(() => purgeDue(clock()), cleanupIntervalMs);
  cleanupTimer.unref();

  const finalizeInspection = async (
    provisional: ProvisionalInspection,
    metadata: Omit<SourceArtifact, 'bytes'>,
  ): Promise<{ preview: ImportPreview | StagedImportPreview; retained: boolean }> => {
    const originalBytes = readFileSync(join(provisional.path, 'original.bin'));
    const originalArtifact: SourceArtifact = {
      fileName: metadata.fileName,
      bytes: originalBytes,
      ...(metadata.mediaType === undefined ? {} : { mediaType: metadata.mediaType }),
    };
    let preview = await inspectArtifact(originalArtifact, DEFAULT_INSPECTION_LIMITS, { workspaceRoot: inspectionWorkspaceRoot });
    if (preview.blockingErrors.length > 0) return { preview: immutableClone(preview), retained: false };
    const handler = handlers.find((candidate) => candidate.matches(immutableClone(preview)));
    if (handler?.inspect !== undefined) {
      const handlerPreview = await handler.inspect({
        artifact: { ...originalArtifact, bytes: Uint8Array.from(originalBytes) },
        preview: immutableClone(preview),
      });
      preview = {
        ...preview,
        normalizedPreview: structuredClone(handlerPreview.normalizedPreview),
        warnings: [...preview.warnings, ...structuredClone(handlerPreview.warnings)],
        blockingErrors: [...preview.blockingErrors, ...structuredClone(handlerPreview.blockingErrors)],
      };
      if (preview.blockingErrors.length > 0) return { preview: immutableClone(preview), retained: false };
    } else if (handler === undefined) {
      preview = {
        ...preview,
        warnings: [...preview.warnings, {
          code: 'artifact_preserved_without_entity',
          message: 'No typed codec is registered yet; commit will preserve only the ImportArtifact row.',
        }],
      };
    }

    const frozenPreview = immutableClone(preview);
    const stage: InspectionStage = {
      ...provisional,
      preview: frozenPreview,
      artifact: { fileName: metadata.fileName, ...(metadata.mediaType === undefined ? {} : { mediaType: metadata.mediaType }) },
      expiresAt: clock() + INSPECTION_TOKEN_TTL_MS,
      handler,
    };
    const token = randomBytes(32).toString('base64url');
    stages.set(token, stage);
    expiry.push({ at: stage.expiresAt, kind: 'stage', token });
    return {
      preview: immutableClone({
        ...frozenPreview,
        inspectionToken: token,
        expiresAt: new Date(stage.expiresAt).toISOString(),
      }),
      retained: true,
    };
  };

  const acquireInspection = (): ImportInspectionLease => {
    if (closed) throw new Error('Import service is closed');
    purgeDue(clock());
    if (activeInspections >= limits.maxConcurrentInspections) throw new ImportQuotaError('import_inspection_concurrency_limit');
    if (liveStages >= limits.maxLiveStages) throw new ImportQuotaError('import_live_stage_limit');

    activeInspections += 1;
    liveStages += 1;
    const provisional: ProvisionalInspection = {
      path: join(stagingRoot, randomUUID()),
      size: 0,
      liveAccounted: true,
      bytesAccounted: true,
    };
    let descriptor: number | undefined;
    try {
      mkdirSync(provisional.path, { mode: 0o700 });
      descriptor = openSync(join(provisional.path, 'original.bin'), 'wx', 0o600);
    } catch (error) {
      activeInspections -= 1;
      releaseLiveStage(provisional);
      attemptCleanup({ path: provisional.path, stage: provisional });
      throw error;
    }

    let active = true;
    const closeOriginal = () => {
      if (descriptor === undefined) return;
      closeSync(descriptor);
      descriptor = undefined;
    };
    const releaseInspection = () => {
      if (!active) return false;
      active = false;
      activeInspections -= 1;
      activeLeases.delete(lease);
      return true;
    };
    const lease: ImportInspectionLease = {
      write(bytes) {
        if (!active || descriptor === undefined) throw new Error('Inspection lease is no longer active');
        if (bytes.byteLength > DEFAULT_INSPECTION_LIMITS.maxUploadBytes - provisional.size) throw new ImportUploadError();
        if (bytes.byteLength > limits.maxStagedBytes - stagedBytes) throw new ImportQuotaError('import_staged_bytes_limit');
        provisional.size += bytes.byteLength;
        stagedBytes += bytes.byteLength;
        let written = 0;
        while (written < bytes.byteLength) written += writeSync(descriptor, bytes, written, bytes.byteLength - written);
      },
      async complete(metadata) {
        if (!active) throw new Error('Inspection lease is no longer active');
        try {
          closeOriginal();
          const result = await finalizeInspection(provisional, metadata);
          releaseInspection();
          if (!result.retained) {
            releaseLiveStage(provisional);
            attemptCleanup({ path: provisional.path, stage: provisional });
          }
          return result.preview;
        } catch (error) {
          closeOriginal();
          releaseInspection();
          releaseLiveStage(provisional);
          attemptCleanup({ path: provisional.path, stage: provisional });
          throw error;
        }
      },
      abort() {
        if (!releaseInspection()) return;
        closeOriginal();
        releaseLiveStage(provisional);
        attemptCleanup({ path: provisional.path, stage: provisional });
      },
    };
    activeLeases.add(lease);
    return lease;
  };

  return {
    acquireInspection,
    async inspect(artifact) {
      const lease = acquireInspection();
      try {
        lease.write(artifact.bytes);
        return await lease.complete({
          fileName: artifact.fileName,
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
        });
      } catch (error) {
        lease.abort();
        throw error;
      }
    },

    commit(inspectionToken, commitOptions) {
      const now = clock();
      purgeDue(now);
      const expiredUntil = expired.get(inspectionToken);
      if (expiredUntil !== undefined) {
        if (now < expiredUntil) throw new ImportTokenError('inspection_token_expired', 410);
        expired.delete(inspectionToken);
      }
      const consumedUntil = consumed.get(inspectionToken);
      if (consumedUntil !== undefined) {
        if (now < consumedUntil) throw new ImportTokenError('inspection_token_consumed', 409);
        consumed.delete(inspectionToken);
      }
      const stage = stages.get(inspectionToken);
      if (stage === undefined) throw new ImportTokenError('inspection_token_invalid', 404);
      stages.delete(inspectionToken);
      releaseLiveStage(stage);
      if (now >= stage.expiresAt) {
        rememberTombstone('expired', inspectionToken, now);
        attemptCleanup({ path: stage.path, stage });
        throw new ImportTokenError('inspection_token_expired', 410);
      }
      rememberTombstone('consumed', inspectionToken, now);

      const artifactId = randomUUID();
      const temporaryAssets = join(stage.path, 'assets.tmp');
      const temporaryManagedAssets = join(stage.path, 'managed-assets.tmp');
      const finalAssets = join(assetRoot, artifactId);
      let assetsMoved = false;
      const movedManagedAssets: string[] = [];
      let result: ImportCommitResult = {};
      try {
        const originalBytes = new Uint8Array(readFileSync(join(stage.path, 'original.bin')));
        if (!digestMatches(originalBytes, stage.preview.source.sha256)) throw new Error('Staged import source digest mismatch');
        const artifact: SourceArtifact = { ...stage.artifact, bytes: originalBytes.slice() };
        mkdirSync(temporaryAssets, { mode: 0o700 });
        options.database.transaction(() => {
          const writeAsset = (requestedPath: string, contents: Uint8Array) => {
            const target = safeAssetPath(temporaryAssets, requestedPath);
            mkdirSync(dirname(target.absolute), { recursive: true });
            writeFileSync(target.absolute, contents, { flag: 'wx', mode: 0o600 });
            return ['assets', 'imports', artifactId, ...target.portable.split('/')].join('/');
          };
          const managedAssets: Array<{ source: string; destination: string }> = [];
          const writeEntityAvatar = (
            kind: 'characters' | 'personas',
            entityId: string,
            extension: 'png' | 'jpg' | 'gif' | 'webp',
            contents: Uint8Array,
          ) => {
            if (!uuidDirectory.test(entityId)) throw new Error('Invalid avatar entity identifier');
            const fileName = `${randomUUID()}.${extension}`;
            const requestedPath = [kind, entityId, fileName].join('/');
            const staged = safeAssetPath(temporaryManagedAssets, requestedPath);
            mkdirSync(dirname(staged.absolute), { recursive: true, mode: 0o700 });
            writeFileSync(staged.absolute, contents, { flag: 'wx', mode: 0o600 });
            const destination = join(options.dataDir, 'assets', 'avatars', kind, entityId, fileName);
            managedAssets.push({ source: staged.absolute, destination });
            return ['assets', 'avatars', kind, entityId, fileName].join('/');
          };
          result = stage.handler?.commit({
            artifact,
            preview: immutableClone(stage.preview),
            repositories: options.repositories,
            writeAsset,
            writeEntityAvatar,
            ...(commitOptions === undefined ? {} : { commitOptions: immutableClone(commitOptions) }),
          }) ?? {};
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
          for (const managed of managedAssets) {
            mkdirSync(dirname(managed.destination), { recursive: true, mode: 0o700 });
            assertDirectManagedDirectory(options.dataDir, dirname(managed.destination));
            renameSync(managed.source, managed.destination);
            movedManagedAssets.push(managed.destination);
          }
        });
      } catch (error) {
        if (assetsMoved) rmSync(finalAssets, { recursive: true, force: true });
        for (const path of movedManagedAssets) rmSync(path, { force: true });
        attemptCleanup({ path: stage.path, stage });
        throw new ImportCommitError(error);
      }

      // Database durability and the final move are complete. Cleanup cannot roll them back.
      const receipt: ImportCommitReceipt = {
        artifactId,
        ...(result.entityId === undefined ? {} : { entityId: result.entityId }),
        assetPath: ['assets', 'imports', artifactId].join('/'),
      };
      attemptCleanup({ path: stage.path, stage });
      return receipt;
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(cleanupTimer);
      for (const lease of [...activeLeases]) lease.abort();
      const cleanupTargets = new Map<string, CleanupTarget>();
      for (const stage of stages.values()) {
        releaseLiveStage(stage);
        cleanupTargets.set(stage.path, { path: stage.path, stage });
      }
      for (const pending of pendingCleanup.values()) cleanupTargets.set(pending.target.path, pending.target);
      for (const target of cleanupTargets.values()) {
        try {
          removeStagePath(target.path);
          if (target.stage !== undefined) releaseStageBytes(target.stage);
        } catch {
          // Shutdown remains best-effort; bounded retries have already been attempted while live.
        }
      }
      stages.clear();
      pendingCleanup.clear();
      consumed.clear();
      expired.clear();
    },
  };
}
