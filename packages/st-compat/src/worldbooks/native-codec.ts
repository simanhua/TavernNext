import {
  AgnaiWorldbookSchema,
  CharacterBookSchema,
  NativeWorldbookSchema,
  NovelWorldbookSchema,
  RisuWorldbookSchema,
  type JsonObject,
} from './schemas.js';
import type { WorldbookSourceFormat } from './normalize.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export class WorldbookCodecError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new WorldbookCodecError('invalid_json', 'The Worldbook JSON document is malformed.');
  }
}

function hasStringFields(entries: JsonObject[], field: string): boolean {
  return entries.every((entry) => typeof entry[field] === 'string');
}

export interface DecodedJsonWorldbook {
  sourceFormat: Exclude<WorldbookSourceFormat, 'naidata' | 'unknown'>;
  rawPayload: JsonObject;
}

export function decodeJsonWorldbook(bytes: Uint8Array): DecodedJsonWorldbook {
  const value = parseJson(bytes);

  const novel = NovelWorldbookSchema.safeParse(value);
  if (novel.success) {
    if (!hasStringFields(novel.data.entries, 'text')) {
      throw new WorldbookCodecError('worldbook_decode_failed', 'NovelAI entries must contain text.');
    }
    return { sourceFormat: 'novel', rawPayload: novel.data };
  }

  const agnai = AgnaiWorldbookSchema.safeParse(value);
  if (agnai.success) {
    if (!hasStringFields(agnai.data.entries, 'entry')) {
      throw new WorldbookCodecError('worldbook_decode_failed', 'Agnai entries must contain entry text.');
    }
    return { sourceFormat: 'agnai', rawPayload: agnai.data };
  }

  const risu = RisuWorldbookSchema.safeParse(value);
  if (risu.success) {
    if (!hasStringFields(risu.data.data, 'content')) {
      throw new WorldbookCodecError('worldbook_decode_failed', 'Risu entries must contain content.');
    }
    return { sourceFormat: 'risu', rawPayload: risu.data };
  }

  const characterBook = CharacterBookSchema.safeParse(value);
  if (characterBook.success) {
    if (!hasStringFields(characterBook.data.entries, 'content')) {
      throw new WorldbookCodecError('worldbook_decode_failed', 'Character Book entries must contain content.');
    }
    return { sourceFormat: 'character-book', rawPayload: characterBook.data };
  }

  const native = NativeWorldbookSchema.safeParse(value);
  if (native.success) {
    if (!hasStringFields(Object.values(native.data.entries), 'content')) {
      throw new WorldbookCodecError('worldbook_decode_failed', 'Native Worldbook entries must contain content.');
    }
    return { sourceFormat: 'st-native', rawPayload: native.data };
  }

  throw new WorldbookCodecError('worldbook_decode_failed', 'The document is not a supported Worldbook family shape.');
}
