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
): NormalizedDecodedWorldbook {
  switch (sourceFormat) {
    case 'st-native': return normalizeNative(rawPayload);
    case 'naidata': return normalizeNative(rawPayload, 'naidata');
    case 'character-book': return normalizeCharacterBook(rawPayload);
    case 'novel': return normalizeNovel(rawPayload);
    case 'agnai': return normalizeAgnai(rawPayload);
    case 'risu': return normalizeRisu(rawPayload);
  }
}
