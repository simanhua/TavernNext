import type { ImportDiagnostic } from '../warnings.js';
import {
  normalizeAgnai,
  normalizeCharacterBook,
  normalizeNative,
  normalizeNovel,
  normalizeRisu,
  type NormalizedWorldbook,
  type WorldbookSourceFormat,
} from './normalize.js';
import type { JsonObject } from './schemas.js';

export interface NormalizedDecodedWorldbook {
  worldbook: NormalizedWorldbook;
  warnings: ImportDiagnostic[];
}

export function normalizeWorldbookPayload(
  rawPayload: JsonObject,
  sourceFormat: Exclude<WorldbookSourceFormat, 'unknown'>,
  fallbackName = 'Imported Worldbook',
): NormalizedDecodedWorldbook {
  switch (sourceFormat) {
    case 'st-native': return normalizeNative(rawPayload, 'st-native', fallbackName);
    case 'naidata': return normalizeNative(rawPayload, 'naidata', fallbackName);
    case 'character-book': return normalizeCharacterBook(rawPayload, fallbackName);
    case 'novel': return normalizeNovel(rawPayload, fallbackName);
    case 'agnai': return normalizeAgnai(rawPayload, fallbackName);
    case 'risu': return normalizeRisu(rawPayload, fallbackName);
  }
}
