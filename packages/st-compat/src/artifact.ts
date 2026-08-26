import { createHash } from 'node:crypto';
import type { ImportDiagnostic } from './warnings.js';

export const MEBIBYTE = 1024 * 1024;

export interface InspectionLimits {
  maxUploadBytes: number;
  maxDecompressedBytes: number;
  maxArchiveEntries: number;
  maxArchiveNesting: number;
  maxTextLineBytes: number;
  /** Maximum bytes read into memory for a manifest; other archive data streams through task-owned disk. */
  maxInMemoryEntryBytes: number;
}

export const DEFAULT_INSPECTION_LIMITS: Readonly<InspectionLimits> = Object.freeze({
  maxUploadBytes: 64 * MEBIBYTE,
  maxDecompressedBytes: 256 * MEBIBYTE,
  maxArchiveEntries: 2_048,
  maxArchiveNesting: 4,
  maxTextLineBytes: 16 * MEBIBYTE,
  maxInMemoryEntryBytes: 64 * MEBIBYTE,
});

export interface SourceArtifact {
  fileName: string;
  bytes: Uint8Array;
  mediaType?: string;
}

export type ArtifactContainer = 'json' | 'jsonl' | 'png' | 'charx' | 'byaf' | 'yaml' | 'zip' | 'unknown';
export type ArtifactKind = 'character' | 'preset' | 'worldbook' | 'unknown';

export interface DetectedArtifact {
  container: ArtifactContainer;
  kind: ArtifactKind;
  version?: string;
  candidates: ArtifactKind[];
}

export interface ImportPreview {
  source: {
    fileName: string;
    mediaType: string;
    size: number;
    sha256: string;
  };
  detected: DetectedArtifact;
  normalizedPreview: unknown;
  blockingErrors: ImportDiagnostic[];
  warnings: ImportDiagnostic[];
  /** Added only by the server-side staging service after a clean inspection. */
  inspectionToken?: string;
}

export function sourceIdentity(input: SourceArtifact): ImportPreview['source'] {
  return {
    fileName: input.fileName,
    mediaType: input.mediaType?.trim() || 'application/octet-stream',
    size: input.bytes.byteLength,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  };
}

export function emptyPreview(input: SourceArtifact): ImportPreview {
  return {
    source: sourceIdentity(input),
    detected: { container: 'unknown', kind: 'unknown', candidates: [] },
    normalizedPreview: null,
    blockingErrors: [],
    warnings: [],
  };
}
