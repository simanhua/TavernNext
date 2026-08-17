import type { ImportPreview, InspectionLimits } from '../artifact.js';
import { DEFAULT_INSPECTION_LIMITS } from '../artifact.js';
import { inspectArtifact, type InspectionOptions } from '../detect-format.js';
import { diagnostic } from '../warnings.js';
import { encodeNativeWorldbook, type WorldbookExportArtifact } from './export.js';
import { normalizeWorldbookPayload } from './foreign-codecs.js';
import { decodeJsonWorldbook, MAX_WORLDBOOK_PREVIEW_BYTES, WorldbookCodecError } from './native-codec.js';
import { MAX_WORLDBOOK_FIELD_WARNINGS, type NormalizedWorldbook, type WorldbookSourceFormat } from './normalize.js';
import { decodeNaidataPng } from './png-codec.js';
import type { JsonObject } from './schemas.js';
import {
  boundedWorldbookDiagnostics,
  validateNormalizedWorldbook,
  validateRawWorldbookFilters,
  WorldbookValidationError,
} from './validation.js';

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const previewMetadataReserveBytes = 64 * 1024;
const encoder = new TextEncoder();

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

function sourceStem(fileName: string): string {
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  const rawStem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const stem = rawStem.trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[. ]+$/g, '');
  return stem === '' ? 'Imported Worldbook' : stem.slice(0, 120);
}

function boundedWarnings(...groups: ReadonlyArray<ImportPreview['warnings']>): ImportPreview['warnings'] {
  const warnings: ImportPreview['warnings'] = [];
  for (const group of groups) {
    for (const issue of group) {
      if (warnings.length < MAX_WORLDBOOK_FIELD_WARNINGS) warnings.push(issue);
      else if (warnings.length === MAX_WORLDBOOK_FIELD_WARNINGS) {
        warnings.push(diagnostic(
          'worldbook_diagnostics_truncated',
          `Additional Worldbook diagnostics were omitted after ${MAX_WORLDBOOK_FIELD_WARNINGS} field-specific warnings.`,
        ));
      }
    }
  }
  return warnings;
}

export interface DecodedWorldbookArtifact {
  sourceFormat: Exclude<WorldbookSourceFormat, 'unknown'>;
  rawPayload: JsonObject;
  worldbook: NormalizedWorldbook;
  warnings: ImportPreview['warnings'];
}

/**
 * Decodes a Character Card's already-parsed Character Book without applying
 * the standalone preview's raw-plus-normalized duplication limit. The source
 * envelope and logical collection bounds are still enforced by the JSON codec.
 */
export function decodeEmbeddedCharacterBook(
  rawPayload: JsonObject,
  fallbackName = 'Imported Worldbook',
): DecodedWorldbookArtifact {
  const decoded = decodeJsonWorldbook(encoder.encode(JSON.stringify(rawPayload)));
  if (decoded.sourceFormat !== 'character-book') {
    throw new WorldbookCodecError(
      'worldbook_decode_failed',
      'The embedded Character Book does not match the Character Book schema.',
    );
  }
  const normalized = normalizeWorldbookPayload(
    structuredClone(decoded.rawPayload),
    decoded.sourceFormat,
    fallbackName,
  );
  const validationIssues = boundedWorldbookDiagnostics(
    validateRawWorldbookFilters(decoded.rawPayload, decoded.sourceFormat),
    validateNormalizedWorldbook(normalized.worldbook),
  );
  if (validationIssues.length > 0) throw new WorldbookValidationError(validationIssues);
  return { ...decoded, ...normalized };
}

function serializedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function assertDecodedPreviewBounded(
  decoded: Pick<DecodedWorldbookArtifact, 'rawPayload'>,
  normalized: Pick<DecodedWorldbookArtifact, 'worldbook' | 'warnings'>,
): void {
  const payloadBytes = serializedBytes({
    rawPayload: decoded.rawPayload,
    worldbook: normalized.worldbook,
    normalizedPreview: normalized.worldbook,
    warnings: normalized.warnings,
  });
  if (payloadBytes > MAX_WORLDBOOK_PREVIEW_BYTES - previewMetadataReserveBytes) {
    throw new WorldbookCodecError(
      'worldbook_preview_limit',
      `Worldbook inspection previews are limited to ${MAX_WORLDBOOK_PREVIEW_BYTES} bytes.`,
    );
  }
}

export function decodeWorldbookArtifact(bytes: Uint8Array, fileName: string): DecodedWorldbookArtifact {
  const decoded = isPng(bytes, fileName)
    ? { sourceFormat: 'naidata' as const, rawPayload: decodeNaidataPng(bytes) }
    : decodeJsonWorldbook(bytes);
  // Keep the source envelope immutable from the caller's perspective. Editors
  // may freely mutate normalized extensions before export without corrupting
  // the exact payload retained for diagnostics or future migrations.
  const normalized = normalizeWorldbookPayload(
    structuredClone(decoded.rawPayload),
    decoded.sourceFormat,
    sourceStem(fileName),
  );
  const validationIssues = boundedWorldbookDiagnostics(
    validateRawWorldbookFilters(decoded.rawPayload, decoded.sourceFormat),
    validateNormalizedWorldbook(normalized.worldbook),
  );
  if (validationIssues.length > 0) throw new WorldbookValidationError(validationIssues);
  assertDecodedPreviewBounded(decoded, normalized);
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
    const completed: WorldbookImportPreview = {
      ...preview,
      sourceFormat: decoded.sourceFormat,
      rawPayload: decoded.rawPayload,
      worldbook: decoded.worldbook,
      normalizedPreview: decoded.worldbook,
      warnings: boundedWarnings(base.warnings, decoded.warnings),
      detected: {
      container: decoded.sourceFormat === 'naidata' ? 'png' : 'json',
      kind: 'worldbook',
      version: '1',
      candidates: ['worldbook'],
      },
    };
    if (serializedBytes(completed) > MAX_WORLDBOOK_PREVIEW_BYTES) {
      throw new WorldbookCodecError(
        'worldbook_preview_limit',
        `Worldbook inspection previews are limited to ${MAX_WORLDBOOK_PREVIEW_BYTES} bytes.`,
      );
    }
    Object.assign(preview, completed);
  } catch (error) {
    if (error instanceof WorldbookValidationError) preview.blockingErrors.push(...error.issues);
    else {
      const issue = error instanceof WorldbookCodecError
        ? diagnostic(error.code, error.message)
        : diagnostic('worldbook_decode_failed', 'The Worldbook could not be decoded safely.');
      preview.blockingErrors.push(issue);
    }
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
export * from './native-codec.js';
export * from './schemas.js';
export * from './validation.js';
