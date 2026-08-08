import type { ImportPreview, InspectionLimits } from '../artifact.js';
import { DEFAULT_INSPECTION_LIMITS } from '../artifact.js';
import { inspectArtifact, type InspectionOptions } from '../detect-format.js';
import { diagnostic } from '../warnings.js';
import { encodeNativeWorldbook, type WorldbookExportArtifact } from './export.js';
import { normalizeWorldbookPayload } from './foreign-codecs.js';
import { decodeJsonWorldbook, WorldbookCodecError } from './native-codec.js';
import type { NormalizedWorldbook, WorldbookSourceFormat } from './normalize.js';
import { decodeNaidataPng } from './png-codec.js';
import type { JsonObject } from './schemas.js';

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface WorldbookInspectionOptions extends InspectionOptions {
  limits?: InspectionLimits;
}

export interface WorldbookImportPreview extends ImportPreview {
  sourceFormat: WorldbookSourceFormat;
  rawPayload: JsonObject | null;
  worldbook: NormalizedWorldbook | null;
}

function isPng(bytes: Uint8Array, fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.png')
    || (bytes.length >= pngSignature.length && pngSignature.every((value, index) => bytes[index] === value));
}

export interface DecodedWorldbookArtifact {
  sourceFormat: Exclude<WorldbookSourceFormat, 'unknown'>;
  rawPayload: JsonObject;
  worldbook: NormalizedWorldbook;
  warnings: ImportPreview['warnings'];
}

export function decodeWorldbookArtifact(bytes: Uint8Array, fileName: string): DecodedWorldbookArtifact {
  const decoded = isPng(bytes, fileName)
    ? { sourceFormat: 'naidata' as const, rawPayload: decodeNaidataPng(bytes) }
    : decodeJsonWorldbook(bytes);
  // Keep the source envelope immutable from the caller's perspective. Editors
  // may freely mutate normalized extensions before export without corrupting
  // the exact payload retained for diagnostics or future migrations.
  const normalized = normalizeWorldbookPayload(structuredClone(decoded.rawPayload), decoded.sourceFormat);
  return { ...decoded, ...normalized };
}

export async function inspectWorldbook(
  bytes: Uint8Array,
  fileName: string,
  options: WorldbookInspectionOptions = {},
): Promise<WorldbookImportPreview> {
  const base = await inspectArtifact(
    { bytes, fileName },
    options.limits ?? DEFAULT_INSPECTION_LIMITS,
    options,
  );
  const preview: WorldbookImportPreview = {
    ...base,
    sourceFormat: 'unknown',
    rawPayload: null,
    worldbook: null,
  };
  if (base.blockingErrors.length > 0) return preview;
  try {
    const decoded = decodeWorldbookArtifact(bytes, fileName);
    preview.sourceFormat = decoded.sourceFormat;
    preview.rawPayload = decoded.rawPayload;
    preview.worldbook = decoded.worldbook;
    preview.normalizedPreview = decoded.worldbook;
    preview.warnings = [...base.warnings, ...decoded.warnings];
    preview.detected = {
      container: decoded.sourceFormat === 'naidata' ? 'png' : 'json',
      kind: 'worldbook',
      version: '1',
      candidates: ['worldbook'],
    };
  } catch (error) {
    const issue = error instanceof WorldbookCodecError
      ? diagnostic(error.code, error.message)
      : diagnostic('worldbook_decode_failed', 'The Worldbook could not be decoded safely.');
    preview.blockingErrors.push(issue);
  }
  return preview;
}

export function exportWorldbook(
  value: WorldbookImportPreview | NormalizedWorldbook,
): WorldbookExportArtifact {
  const worldbook = 'worldbook' in value ? value.worldbook : value;
  if (worldbook === null) throw new Error('Cannot export a Worldbook preview with blocking errors.');
  return encodeNativeWorldbook(worldbook);
}

export * from './export.js';
export * from './normalize.js';
export * from './schemas.js';
