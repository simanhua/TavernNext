import { diagnostic, type ImportDiagnostic } from '../warnings.js';
import { normalizeParsedCharacter } from './normalize.js';
import { parseCharacterDocument } from './schemas.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export class CharacterCodecError extends Error {
  constructor(readonly diagnostic: ImportDiagnostic) {
    super(diagnostic.message);
  }
}

export function strictCharacterText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CharacterCodecError(diagnostic('character_text_encoding_invalid', 'Character metadata must contain valid UTF-8.'));
  }
}

export function decodeCharacterValue(value: unknown) {
  try {
    const parsed = parseCharacterDocument(value);
    return { ...parsed, ...normalizeParsedCharacter(parsed) };
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic(
      'character_card_invalid',
      error instanceof Error ? error.message : 'Character Card does not match a supported V1, V2, or V3 schema.',
    ));
  }
}

export function decodeCharacterJson(bytes: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(strictCharacterText(bytes));
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic('character_metadata_invalid_json', 'Character metadata is not valid JSON.'));
  }
  return { ...decodeCharacterValue(value), raw: structuredClone(value) };
}
