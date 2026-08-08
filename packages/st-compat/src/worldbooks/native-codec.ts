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

export const MAX_WORLDBOOK_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_WORLDBOOK_ENTRIES = 4_096;
export const MAX_WORLDBOOK_KEYS = 256;
export const MAX_WORLDBOOK_FILTER_VALUES = 256;
export const MAX_WORLDBOOK_FILTER_PROPERTIES = 256;

export class WorldbookCodecError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_WORLDBOOK_PREVIEW_BYTES) {
    throw new WorldbookCodecError(
      'worldbook_preview_limit',
      `Worldbook source envelopes are limited to ${MAX_WORLDBOOK_PREVIEW_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new WorldbookCodecError('invalid_json', 'The Worldbook JSON document is malformed.');
  }
}

function record(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function* sourceEntries(value: unknown): Generator<unknown> {
  const root = record(value);
  if (root === undefined) return;
  if (Array.isArray(root.entries)) {
    yield* root.entries;
  } else {
    const entries = record(root.entries);
    if (entries !== undefined) {
      for (const key in entries) {
        if (!Object.hasOwn(entries, key)) continue;
        yield entries[key];
      }
    }
  }
  if (Array.isArray(root.data)) {
    yield* root.data;
  }
}

function propertyCount(value: unknown): number {
  const root = record(value);
  if (root === undefined) return 0;
  let count = 0;
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      count += current.length;
      if (count > MAX_WORLDBOOK_FILTER_PROPERTIES) return count;
      pending.push(...current);
      continue;
    }
    const object = record(current);
    if (object === undefined) continue;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      count += 1;
      if (count > MAX_WORLDBOOK_FILTER_PROPERTIES) return count;
      pending.push(object[key]);
    }
  }
  return count;
}

function commaDelimitedValueCount(value: unknown, optional = false): number {
  if (typeof value !== 'string' || (optional && value === '')) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 44) continue;
    count += 1;
    if (count > MAX_WORLDBOOK_KEYS) return count;
  }
  return count;
}

function enforceLogicalBounds(value: unknown): void {
  let entryCount = 0;
  for (const sourceEntry of sourceEntries(value)) {
    entryCount += 1;
    if (entryCount > MAX_WORLDBOOK_ENTRIES) {
      throw new WorldbookCodecError('worldbook_entry_limit', `Worldbooks are limited to ${MAX_WORLDBOOK_ENTRIES} entries.`);
    }
    const entry = record(sourceEntry);
    if (entry === undefined) continue;
    for (const field of ['key', 'keysecondary', 'keys', 'secondary_keys', 'keywords']) {
      const keys = entry[field];
      if (Array.isArray(keys) && keys.length > MAX_WORLDBOOK_KEYS) {
        throw new WorldbookCodecError('worldbook_key_limit', `Worldbook entry key lists are limited to ${MAX_WORLDBOOK_KEYS} values.`);
      }
    }
    if (commaDelimitedValueCount(entry.key) > MAX_WORLDBOOK_KEYS
      || commaDelimitedValueCount(entry.secondkey, true) > MAX_WORLDBOOK_KEYS) {
      throw new WorldbookCodecError('worldbook_key_limit', `Worldbook entry key lists are limited to ${MAX_WORLDBOOK_KEYS} values.`);
    }
    const extensions = record(entry.extensions);
    for (const candidate of [entry.characterFilter, entry.personaFilter, extensions?.character_filter, extensions?.persona_filter]) {
      const filter = record(candidate);
      if (filter === undefined) continue;
      for (const field of ['names', 'tags']) {
        const values = filter[field];
        if (Array.isArray(values) && values.length > MAX_WORLDBOOK_FILTER_VALUES) {
          throw new WorldbookCodecError(
            'worldbook_filter_value_limit',
            `Worldbook filter value lists are limited to ${MAX_WORLDBOOK_FILTER_VALUES} values.`,
          );
        }
      }
      if (propertyCount(filter) > MAX_WORLDBOOK_FILTER_PROPERTIES) {
        throw new WorldbookCodecError(
          'worldbook_filter_property_limit',
          `Worldbook filters are limited to ${MAX_WORLDBOOK_FILTER_PROPERTIES} nested properties.`,
        );
      }
    }
  }
}

function hasStringFields(entries: JsonObject[], field: string): boolean {
  return entries.every((entry) => typeof entry[field] === 'string');
}

interface Candidate {
  sourceFormat: Exclude<WorldbookSourceFormat, 'naidata' | 'unknown'>;
  rawPayload: JsonObject;
  populated: boolean;
}

export interface DecodedJsonWorldbook {
  sourceFormat: Exclude<WorldbookSourceFormat, 'naidata' | 'unknown'>;
  rawPayload: JsonObject;
}

export function decodeJsonWorldbook(bytes: Uint8Array): DecodedJsonWorldbook {
  const value = parseJson(bytes);
  enforceLogicalBounds(value);
  const root = record(value);
  const candidates: Candidate[] = [];

  const novel = NovelWorldbookSchema.safeParse(value);
  if (root !== undefined && novel.success && hasStringFields(novel.data.entries, 'text')) {
    candidates.push({ sourceFormat: 'novel', rawPayload: root, populated: novel.data.entries.length > 0 });
  }

  const agnai = AgnaiWorldbookSchema.safeParse(value);
  if (root !== undefined && agnai.success && hasStringFields(agnai.data.entries, 'entry')) {
    candidates.push({ sourceFormat: 'agnai', rawPayload: root, populated: agnai.data.entries.length > 0 });
  }

  const risu = RisuWorldbookSchema.safeParse(value);
  if (root !== undefined && risu.success
    && hasStringFields(risu.data.data, 'content')
    && hasStringFields(risu.data.data, 'key')) {
    candidates.push({ sourceFormat: 'risu', rawPayload: root, populated: risu.data.data.length > 0 });
  }

  const characterBook = CharacterBookSchema.safeParse(value);
  if (root !== undefined && characterBook.success && hasStringFields(characterBook.data.entries, 'content')) {
    candidates.push({
      sourceFormat: 'character-book', rawPayload: root, populated: characterBook.data.entries.length > 0,
    });
  }

  const native = NativeWorldbookSchema.safeParse(value);
  if (root !== undefined && native.success && hasStringFields(Object.values(native.data.entries), 'content')) {
    candidates.push({
      sourceFormat: 'st-native', rawPayload: root, populated: Object.keys(native.data.entries).length > 0,
    });
  }

  const populated = candidates.filter((candidate) => candidate.populated);
  const complete = populated.length > 0 ? populated : candidates;
  if (complete.length > 1) {
    throw new WorldbookCodecError(
      'worldbook_format_ambiguous',
      `The document completely matches multiple Worldbook families: ${complete.map(({ sourceFormat }) => sourceFormat).join(', ')}.`,
    );
  }
  const decoded = complete[0];
  if (decoded === undefined) {
    throw new WorldbookCodecError('worldbook_decode_failed', 'The document is not a supported Worldbook family shape.');
  }
  return { sourceFormat: decoded.sourceFormat, rawPayload: decoded.rawPayload };
}
