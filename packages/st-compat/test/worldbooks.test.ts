import type { InspectionLimits, NormalizedWorldbook, NormalizedWorldbookEntry, WorldbookImportPreview } from '../src/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { decode as decodePngText, encode as encodePngText } from 'png-chunk-text';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_INSPECTION_LIMITS, decodeEmbeddedCharacterBook, decodeWorldbookArtifact, inspectWorldbook } from '../src/index.js';
import { WorldbookCodecError } from '../src/worldbooks/native-codec.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'worldbooks');

const encoder = new TextEncoder();
const naidataRawTextLimit = 2 * 1024 * 1024;

function bytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureRoot, name)));
}

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8')) as Record<string, unknown>;
}

function requireBook(preview: WorldbookImportPreview): NormalizedWorldbook {
  expect(preview.blockingErrors).toEqual([]);
  expect(preview.worldbook).not.toBeNull();
  return preview.worldbook!;
}

function limited(overrides: Partial<InspectionLimits>): InspectionLimits {
  return { ...DEFAULT_INSPECTION_LIMITS, ...overrides };
}

function pngWithAdditionalMetadata(source: Uint8Array, keyword: string, text: string): Uint8Array {
  const chunks = extractPngChunks(source);
  chunks.splice(-1, 0, encodePngText(keyword, text));
  return encodePngChunks(chunks);
}

async function withLargeTypedArrayAllocationRejected<T>(
  threshold: number,
  action: () => T | Promise<T>,
): Promise<T> {
  const guardedUint8Array = new Proxy(globalThis.Uint8Array, {
    construct(target, argumentsList, newTarget) {
      const requestedLength = argumentsList[0];
      if (typeof requestedLength === 'number' && requestedLength > threshold) {
        throw new WorldbookCodecError('allocation_probe', 'The PNG parser attempted an oversized allocation.');
      }
      return Reflect.construct(target, argumentsList, newTarget);
    },
  });
  vi.stubGlobal('Uint8Array', guardedUint8Array);
  try {
    return await action();
  } finally {
    vi.unstubAllGlobals();
  }
}

function codecErrorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorldbookCodecError);
    return (error as WorldbookCodecError).code;
  }
  throw new Error('Expected the Worldbook codec to reject the PNG.');
}

function chunkHeaderOffset(bytes: Uint8Array, expectedName: string): number {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (name === expectedName) return offset;
    offset += length + 12;
  }
  throw new Error(`PNG chunk ${expectedName} was not found.`);
}

describe('Worldbook all-field normalization', () => {
  it('maps every SillyTavern 1.18 runtime field while retaining extensions and unknown fields', async () => {
    const preview = await inspectWorldbook(bytes('all-fields.json'), 'all-fields.json');
    const book = requireBook(preview);

    expect(preview.sourceFormat).toBe('st-native');
    expect(book).toMatchObject({
      name: 'All Fields 世界書',
      description: 'Synthetic coverage for every SillyTavern 1.18 Worldbook runtime field.',
      enabled: true,
      scanDepth: 12,
      tokenBudget: 2048,
      recursiveScanning: true,
      extensions: { book_extension: { keep: 'all-fields' } },
      unknownFields: { book_unknown: { preserve: true } },
    });
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      sourceUid: 7,
      sourceOrdinal: 0,
      keys: ['alpha', '/βeta/iu'],
      secondaryKeys: ['gamma', 'delta'],
      useRegex: true,
      selective: true,
      selectiveLogic: 3,
      constant: true,
      vectorized: true,
      probability: 73,
      useProbability: true,
      group: 'synthetic-group',
      groupWeight: 144,
      groupOverride: true,
      priority: 654,
      order: 321,
      position: 4,
      depth: 6,
      role: 2,
      ignoreBudget: true,
      scanDepth: 8,
      caseSensitive: true,
      matchWholeWords: false,
      useGroupScoring: true,
      excludeRecursion: true,
      preventRecursion: true,
      delayUntilRecursion: 2,
      sticky: 3,
      cooldown: 4,
      delay: 5,
      characterFilter: { isExclude: true, names: ['hero.png'], tags: ['character-tag'] },
      personaFilter: { isExclude: false, names: ['Archivist Persona'], tags: ['persona-tag'] },
      matchPersonaDescription: true,
      matchCharacterDescription: true,
      matchCharacterPersonality: true,
      matchCharacterDepthPrompt: true,
      matchScenario: true,
      matchCreatorNotes: true,
      comment: 'All runtime fields',
      displayName: 'Explicit display name',
      content: 'Synthetic all-field lore content.',
      enabled: true,
      addMemo: true,
      displayIndex: 42,
      outletName: 'synthetic-outlet',
      automationId: 'automation-fixture',
      triggers: ['normal', 'continue'],
      extensions: { entry_extension: { keep: 'all-fields-entry' } },
      unknownFields: { entry_unknown: { preserve: true } },
    });
  });

  it('preserves an unknown native position rather than silently changing its execution semantics', async () => {
    const source = json('native.json');
    const entries = source.entries as Record<string, Record<string, unknown>>;
    entries['alpha-source-key']!.position = 99;
    const preview = await inspectWorldbook(encoder.encode(JSON.stringify(source)), 'unknown-position.json');
    const book = requireBook(preview);

    expect(book.entries[0]?.position).toBe(99);
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'worldbook_unknown_position',
      path: 'entries.alpha-source-key.position',
    }));
  });
});

describe('Worldbook family codecs', () => {
  it('decodes a bounded embedded Character Book without the standalone preview duplication limit', () => {
    const raw = {
      name: 'Large embedded lore',
      entries: [{
        id: 1,
        keys: ['large'],
        content: 'x'.repeat(1_100_000),
        enabled: true,
        extensions: {},
      }],
    };
    expect(() => decodeWorldbookArtifact(
      encoder.encode(JSON.stringify(raw)),
      'standalone-character-book.json',
    )).toThrowError(expect.objectContaining({ code: 'worldbook_preview_limit' }));

    const decoded = decodeEmbeddedCharacterBook(raw, 'Fallback name');

    expect(decoded.sourceFormat).toBe('character-book');
    expect(decoded.worldbook).toMatchObject({
      name: 'Large embedded lore',
      entries: [expect.objectContaining({ sourceUid: 1, keys: ['large'] })],
    });
    expect(decoded.worldbook.entries[0]?.content).toHaveLength(1_100_000);
  });

  it.each([
    {
      file: 'native.json', format: 'st-native', name: 'Native Synthetic Lore', uid: 'alpha-uid',
      keys: ['archive'], content: 'Native synthetic alpha content.', order: 100, selective: true, addMemo: false, displayIndex: null,
    },
    {
      file: 'character-book.json', format: 'character-book', name: 'Synthetic Character Book', uid: 42,
      keys: ['character', '/book/i'], content: 'Synthetic Character Book content.', order: 222, selective: true, addMemo: true, displayIndex: 12,
    },
    {
      file: 'novel.json', format: 'novel', name: 'Synthetic Novel Lorebook', uid: 'novel-entry-id',
      keys: ['novel', 'lore'], content: 'Synthetic NovelAI lore content.', order: 27, selective: false, addMemo: true, displayIndex: 0,
    },
    {
      file: 'agnai.json', format: 'agnai', name: 'Synthetic Agnai Memory', uid: 'agnai-entry-id',
      keys: ['agnai', 'memory'], content: 'Synthetic Agnai memory content.', order: 64, selective: false, addMemo: true, displayIndex: 0,
    },
    {
      file: 'risu.json', format: 'risu', name: 'Synthetic Risu Lorebook', uid: 'risu-entry-id',
      keys: ['risu', 'realm'], content: 'Synthetic Risu lore content.', order: 41, selective: true, addMemo: true, displayIndex: 0,
    },
    {
      file: 'naidata.png', format: 'naidata', name: 'Native Synthetic Lore', uid: 'alpha-uid',
      keys: ['archive'], content: 'Native synthetic alpha content.', order: 100, selective: true, addMemo: false, displayIndex: null,
    },
  ])('normalizes synthetic $format input through its passthrough family schema', async ({ file, format, name, uid, keys, content, order, selective, addMemo, displayIndex }) => {
    const preview = await inspectWorldbook(bytes(file), file);
    const book = requireBook(preview);

    expect(preview.sourceFormat).toBe(format);
    expect(book.name).toBe(name);
    expect(book.entries[0]).toMatchObject({ sourceUid: uid, keys, content, order, selective, addMemo, displayIndex });
    expect(preview.rawPayload).toEqual(file === 'naidata.png' ? json('native.json') : json(file));
  });

  it('keeps the raw source snapshot isolated from edits to normalized extension envelopes', async () => {
    const preview = await inspectWorldbook(bytes('all-fields.json'), 'all-fields.json');
    const book = requireBook(preview);

    (book.extensions.book_extension as Record<string, unknown>).keep = 'edited-book-extension';
    (book.unknownFields.book_unknown as Record<string, unknown>).preserve = false;
    (book.entries[0]!.extensions.entry_extension as Record<string, unknown>).keep = 'edited-entry-extension';
    (book.entries[0]!.unknownFields.entry_unknown as Record<string, unknown>).preserve = false;

    const raw = preview.rawPayload!;
    expect(raw.extensions).toEqual({ book_extension: { keep: 'all-fields' } });
    expect(raw.book_unknown).toEqual({ preserve: true });
    const rawEntry = Object.values(raw.entries as Record<string, Record<string, unknown>>)[0];
    expect(rawEntry).toMatchObject({
      extensions: { entry_extension: { keep: 'all-fields-entry' } },
      entry_unknown: { preserve: true },
    });
  });

  it('maps the Character Book envelope and both UID types without substituting array indexes', async () => {
    const preview = await inspectWorldbook(bytes('character-book.json'), 'embedded-book.json');
    const book = requireBook(preview);

    expect(book).toMatchObject({ scanDepth: 9, tokenBudget: 1234, recursiveScanning: true });
    expect(book.entries.map((entry) => entry.sourceUid)).toEqual([
      42,
      'string-uid',
      expect.stringMatching(/^tn-[0-9a-f-]{36}$/),
    ]);
    expect(new Set(book.entries.map((entry) => entry.id)).size).toBe(3);
    expect(book.entries[0]).toMatchObject({
      useRegex: true,
      priority: null,
      position: 4,
      role: 1,
      characterFilter: { isExclude: false, names: ['linked-character.png'], tags: ['linked-character-tag'] },
      personaFilter: { isExclude: true, names: ['Excluded Persona'], tags: [] },
      extensions: expect.objectContaining({ entry_unknown: { keep: 'character-book-extension' } }),
      unknownFields: { entry_extra: 'keep-character-book-entry' },
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'worldbook_source_uid_generated',
      path: 'entries[2].id',
    }));
  });

  it('preserves lossy foreign concepts with a separate warning for every unmapped field', async () => {
    const novel = await inspectWorldbook(bytes('novel.json'), 'novel.json');
    const entry = requireBook(novel).entries[0]!;
    expect(entry.extensions).toMatchObject({
      tavernnext: {
        sourceFormat: 'novel',
        original: expect.objectContaining({ novel_entry_unknown: 'preserved' }),
      },
    });
    expect(novel.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'worldbook_foreign_field_preserved', path: 'entries[0].contextConfig.searchRange' }),
      expect.objectContaining({ code: 'worldbook_foreign_field_preserved', path: 'entries[0].contextConfig.reservedTokens' }),
      expect.objectContaining({ code: 'worldbook_foreign_field_preserved', path: 'entries[0].contextConfig.trimDirection' }),
      expect.objectContaining({ code: 'worldbook_foreign_field_preserved', path: 'entries[0].novel_entry_unknown' }),
    ]));

    for (const file of ['agnai.json', 'risu.json']) {
      const preview = await inspectWorldbook(bytes(file), file);
      expect(requireBook(preview).entries[0]?.extensions).toMatchObject({
        tavernnext: { sourceFormat: file.slice(0, -5), original: expect.any(Object) },
      });
      expect(preview.warnings.some((warning) => warning.code === 'worldbook_foreign_field_preserved' && warning.path?.includes('_unknown'))).toBe(true);
    }
  });

  it('preserves mixed UID types, diagnoses only true duplicates, and generates safe UIDs for malformed values', async () => {
    const source = {
      name: 'UID edge cases', extensions: {}, entries: [
        { id: 1, keys: ['one'], content: 'number', enabled: true, insertion_order: 4, extensions: {} },
        { id: '1', keys: ['one string'], content: 'string', enabled: true, insertion_order: 3, extensions: {} },
        { id: 1, keys: ['duplicate'], content: 'duplicate', enabled: true, insertion_order: 2, extensions: {} },
        { id: { invalid: true }, keys: ['invalid'], content: 'invalid', enabled: true, insertion_order: 1, extensions: {} },
      ],
    };
    const preview = await inspectWorldbook(encoder.encode(JSON.stringify(source)), 'uid-edge-cases.json');
    const book = requireBook(preview);

    expect(book.entries.map((entry) => entry.sourceUid)).toEqual([
      1,
      '1',
      1,
      expect.stringMatching(/^tn-[0-9a-f-]{36}$/),
    ]);
    expect(new Set(book.entries.map((entry) => entry.id)).size).toBe(4);
    expect(preview.warnings.filter((warning) => warning.code === 'worldbook_source_uid_duplicate')).toEqual([
      expect.objectContaining({ path: 'entries[2].id' }),
    ]);
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'worldbook_source_uid_invalid', path: 'entries[3].id',
    }));
  });
});

describe('Worldbook validation and naidata safety', () => {
  it('returns blocking diagnostics for malformed documents and bounded oversized text lines', async () => {
    const malformed = await inspectWorldbook(encoder.encode('{"entries":['), 'malformed.json');
    expect(malformed.blockingErrors).toContainEqual(expect.objectContaining({ code: 'invalid_json' }));

    const wrongShape = await inspectWorldbook(encoder.encode(JSON.stringify({ entries: 'not-a-collection' })), 'wrong.json');
    expect(wrongShape.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_decode_failed' }));

    const large = encoder.encode(JSON.stringify({ entries: { one: { uid: 'one', key: [], content: 'x'.repeat(1024) } } }));
    const bounded = await inspectWorldbook(large, 'large.json', { limits: limited({ maxTextLineBytes: 256 }) });
    expect(bounded.blockingErrors).toContainEqual(expect.objectContaining({ code: 'text_line_limit' }));
  });

  it('checks naidata CRCs, rejects duplicate case-folded metadata, and rejects invalid metadata payloads', async () => {
    const good = bytes('naidata.png');
    expect(requireBook(await inspectWorldbook(good, 'naidata.png')).entries).toHaveLength(2);

    const corrupt = Uint8Array.from(good);
    corrupt[20] = corrupt[20]! ^ 1;
    expect((await inspectWorldbook(corrupt, 'corrupt.png')).blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_png' }));

    const naidata = extractPngChunks(good)
      .filter((chunk) => chunk.name === 'tEXt')
      .map((chunk) => decodePngText(chunk))
      .find(({ keyword }) => keyword.toLowerCase() === 'naidata')!;
    const duplicate = pngWithAdditionalMetadata(good, 'NAIDATA', naidata.text);
    expect((await inspectWorldbook(duplicate, 'duplicate.png')).blockingErrors).toContainEqual(expect.objectContaining({
      code: 'worldbook_png_metadata_duplicate',
    }));

    const invalid = pngWithAdditionalMetadata(
      encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt')),
      'naidata',
      'not base64!',
    );
    expect((await inspectWorldbook(invalid, 'invalid.png')).blockingErrors).toContainEqual(expect.objectContaining({
      code: 'worldbook_png_metadata_invalid',
    }));

    const malformedJson = pngWithAdditionalMetadata(
      encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt')),
      'naidata',
      Buffer.from('{"entries":', 'utf8').toString('base64'),
    );
    expect((await inspectWorldbook(malformedJson, 'malformed-metadata.png')).blockingErrors).toContainEqual(expect.objectContaining({
      code: 'worldbook_png_metadata_invalid',
    }));
  });

  it.each([
    ['leading', (value: string) => ` ${value}`],
    ['trailing', (value: string) => `${value}\n`],
  ])('rejects %s whitespace around otherwise canonical naidata base64', async (_label, surround) => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const canonical = Buffer.from('{"entries":{}}', 'utf8').toString('base64');
    const preview = await inspectWorldbook(
      pngWithAdditionalMetadata(blank, 'naidata', surround(canonical)),
      'noncanonical-naidata.png',
    );

    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_png_metadata_invalid' }));
    expect(preview.worldbook).toBeNull();
  });

  it('bounds the raw naidata text before trimming a padded small valid payload', async () => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const canonical = Buffer.from('{"entries":{}}', 'utf8').toString('base64');
    const padded = `${' '.repeat(1_572_864)}${canonical}${' '.repeat(1_572_864)}`;
    const preview = await inspectWorldbook(
      pngWithAdditionalMetadata(blank, 'naidata', padded),
      'padded-small-naidata.png',
    );

    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_preview_limit' }));
    expect(preview.worldbook).toBeNull();
    expect(preview.rawPayload).toBeNull();
  });

  it('rejects oversized naidata before the shared or typed PNG extractor allocates the raw value', async () => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const canonical = Buffer.from('{"entries":{}}', 'utf8').toString('base64');
    const padded = `${' '.repeat(1_572_864)}${canonical}${' '.repeat(1_572_864)}`;
    const oversized = pngWithAdditionalMetadata(blank, 'NAIDATA', padded);

    const typedCode = await withLargeTypedArrayAllocationRejected(
      naidataRawTextLimit,
      () => codecErrorCode(() => decodeWorldbookArtifact(oversized, 'typed-oversized-naidata.png')),
    );
    const sharedPreview = await withLargeTypedArrayAllocationRejected(
      naidataRawTextLimit,
      () => inspectWorldbook(oversized, 'shared-oversized-naidata.png'),
    );

    expect(typedCode).toBe('worldbook_preview_limit');
    expect(sharedPreview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_preview_limit' }));
  });

  it('rejects a malformed declared naidata chunk length before the typed PNG extractor allocates it', async () => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const canonical = Buffer.from('{"entries":{}}', 'utf8').toString('base64');
    const malformed = Uint8Array.from(pngWithAdditionalMetadata(blank, 'naidata', canonical));
    const textHeader = chunkHeaderOffset(malformed, 'tEXt');
    malformed.fill(0xff, textHeader, textHeader + 4);

    const typedCode = await withLargeTypedArrayAllocationRejected(
      malformed.byteLength,
      () => codecErrorCode(() => decodeWorldbookArtifact(malformed, 'malformed-length-naidata.png')),
    );

    expect(typedCode).toBe('corrupt_png');
  });

  it('bounds oversized raw naidata bytes before decoding malformed tEXt content', async () => {
    const chunks = extractPngChunks(bytes('naidata.png')).filter((chunk) => chunk.name !== 'tEXt');
    const keyword = Buffer.from('naidata', 'latin1');
    const rawText = new Uint8Array(keyword.length + 1 + naidataRawTextLimit + 1);
    rawText.set(keyword);
    chunks.splice(-1, 0, { name: 'tEXt', data: rawText });

    const preview = await inspectWorldbook(encodePngChunks(chunks), 'malformed-oversized-naidata.png');

    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_preview_limit' }));
    expect(preview.worldbook).toBeNull();
  });

  it.each([
    ['boundary minus one', naidataRawTextLimit - 1, 'worldbook_png_metadata_invalid'],
    ['boundary', naidataRawTextLimit, 'worldbook_png_metadata_invalid'],
    ['boundary plus one', naidataRawTextLimit + 1, 'worldbook_preview_limit'],
  ])('applies the raw naidata text limit at %s', async (_label, length, code) => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const preview = await inspectWorldbook(
      pngWithAdditionalMetadata(blank, 'naidata', 'A'.repeat(length)),
      'raw-naidata-boundary.png',
    );

    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code }));
    expect(preview.worldbook).toBeNull();
  });

  it('accepts canonical naidata base64 without surrounding whitespace', async () => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const canonical = Buffer.from('{"entries":{}}', 'utf8').toString('base64');
    const preview = await inspectWorldbook(
      pngWithAdditionalMetadata(blank, 'naidata', canonical),
      'canonical-naidata.png',
    );

    expect(preview.blockingErrors).toEqual([]);
    expect(requireBook(preview).entries).toEqual([]);
  });

  it('applies pre-normalization logical entry caps to naidata metadata', async () => {
    const good = bytes('naidata.png');
    const blank = encodePngChunks(extractPngChunks(good).filter((chunk) => chunk.name !== 'tEXt'));
    const entries = Object.fromEntries(Array.from(
      { length: 4_097 },
      (_, index) => [String(index), { uid: index, key: [], content: '' }],
    ));
    const oversized = pngWithAdditionalMetadata(
      blank,
      'naidata',
      Buffer.from(JSON.stringify({ entries }), 'utf8').toString('base64'),
    );

    const preview = await inspectWorldbook(oversized, 'oversized-naidata.png');
    expect(preview.worldbook).toBeNull();
    expect(preview.rawPayload).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_entry_limit' }));
  });
});

describe('native source identity normalization', () => {
  it('preserves native source UIDs independently of array indexes', async () => {
    const preview = await inspectWorldbook(bytes('native.json'), 'native.json');

    expect(preview.worldbook?.entries.map((entry) => entry.sourceUid)).toEqual(['alpha-uid', 9]);
  });

});

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;
const oraclePackage = oracleRoot === undefined ? '' : join(oracleRoot, 'package.json');
const oracleWorldInfo = oracleRoot === undefined ? '' : join(oracleRoot, 'src', 'endpoints', 'worldinfo.js');
const oracleValidator = oracleRoot === undefined ? '' : join(oracleRoot, 'src', 'validator', 'TavernCardValidator.js');
const oracleWorldInfoRuntime = oracleRoot === undefined ? '' : join(oracleRoot, 'public', 'scripts', 'world-info.js');
const oracleCharacters = oracleRoot === undefined ? '' : join(oracleRoot, 'src', 'endpoints', 'characters.js');
const oracleCharacterBookTypes = oracleRoot === undefined ? '' : join(oracleRoot, 'src', 'types', 'spec-v2.d.ts');
const oracleEldoria = oracleRoot === undefined ? '' : join(oracleRoot, 'default', 'content', 'Eldoria.json');

function sha256(fileName: string): string {
  return createHash('sha256').update(readFileSync(fileName)).digest('hex').toUpperCase();
}

function exactConverter(runtime: string, name: string): (input: any) => { entries: Record<string, Record<string, unknown>> } {
  const marker = name === 'convertCharacterBook' ? `export function ${name}` : `function ${name}`;
  const start = runtime.indexOf(marker);
  if (start < 0) throw new Error(`Pinned converter ${name} was not found`);
  const brace = runtime.indexOf('{', start);
  let depth = 0;
  let end = brace;
  for (; end < runtime.length; end += 1) {
    if (runtime[end] === '{') depth += 1;
    if (runtime[end] === '}') depth -= 1;
    if (depth === 0) break;
  }
  const source = runtime.slice(start, end + 1).replace(/^export\s+/, '');
  const template = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false,
    selective: true, selectiveLogic: 0, addMemo: false, order: 100, position: 0, disable: false,
    ignoreBudget: false, excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false,
    matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
    matchScenario: false, matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100,
    useProbability: true, depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100,
    scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '',
    role: 0, sticky: null, cooldown: null, delay: null, triggers: [],
  };
  return Function(
    'newWorldInfoEntryTemplate', 'world_info_position', 'world_info_logic', 'DEFAULT_DEPTH', 'DEFAULT_WEIGHT', 'extension_prompt_roles',
    `"use strict"; ${source}; return ${name};`,
  )(template, { before: 0, after: 1 }, { AND_ANY: 0 }, 4, 100, { SYSTEM: 0 }) as ReturnType<typeof exactConverter>;
}

/** Full shared executable surface; identity and passthrough envelopes intentionally stay outside converter parity. */
function normalizedConverterProjection(entry: NormalizedWorldbookEntry) {
  return {
    keys: entry.keys, secondaryKeys: entry.secondaryKeys, useRegex: entry.useRegex,
    selective: entry.selective, selectiveLogic: entry.selectiveLogic,
    constant: entry.constant, vectorized: entry.vectorized,
    probability: entry.probability, useProbability: entry.useProbability,
    group: entry.group, groupWeight: entry.groupWeight, groupOverride: entry.groupOverride,
    priority: entry.priority, order: entry.order, position: entry.position, depth: entry.depth, role: entry.role,
    ignoreBudget: entry.ignoreBudget, scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive, matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring, excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion, delayUntilRecursion: entry.delayUntilRecursion,
    sticky: entry.sticky, cooldown: entry.cooldown, delay: entry.delay,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario, matchCreatorNotes: entry.matchCreatorNotes,
    comment: entry.comment, content: entry.content, enabled: entry.enabled, addMemo: entry.addMemo,
    displayIndex: entry.displayIndex, outletName: entry.outletName,
    automationId: entry.automationId, triggers: entry.triggers,
  };
}

function oracleConverterProjection(entry: Record<string, any>) {
  return {
    keys: entry.key, secondaryKeys: entry.keysecondary, useRegex: entry.useRegex ?? true,
    selective: entry.selective, selectiveLogic: entry.selectiveLogic,
    constant: entry.constant, vectorized: entry.vectorized,
    probability: entry.probability, useProbability: Boolean(entry.useProbability),
    group: entry.group, groupWeight: entry.groupWeight, groupOverride: entry.groupOverride,
    priority: entry.priority ?? null, order: entry.order, position: entry.position, depth: entry.depth, role: entry.role,
    ignoreBudget: entry.ignoreBudget, scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive, matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring, excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion, delayUntilRecursion: entry.delayUntilRecursion,
    sticky: entry.sticky, cooldown: entry.cooldown, delay: entry.delay,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario, matchCreatorNotes: entry.matchCreatorNotes,
    comment: entry.comment, content: entry.content, enabled: !entry.disable, addMemo: entry.addMemo,
    displayIndex: entry.displayIndex, outletName: entry.outletName,
    automationId: entry.automationId, triggers: entry.triggers,
  };
}

describe.skipIf(
  oracleRoot === undefined
  || !existsSync(oraclePackage)
  || !existsSync(oracleWorldInfo)
  || !existsSync(oracleValidator)
  || !existsSync(oracleWorldInfoRuntime)
  || !existsSync(oracleCharacters)
  || !existsSync(oracleCharacterBookTypes)
  || !existsSync(oracleEldoria),
)('read-only SillyTavern 1.18.0 Worldbook oracle', () => {
  it('verifies the pinned source revision and oracle hashes', async () => {
    expect((JSON.parse(readFileSync(oraclePackage, 'utf8')) as { version: string }).version).toBe('1.18.0');
    const revision = spawnSync('git', ['-C', oracleRoot!, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect(revision.status).toBe(0);
    expect(revision.stdout.trim()).toBe('8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8');
    expect({
      endpoint: sha256(oracleWorldInfo),
      validator: sha256(oracleValidator),
      runtime: sha256(oracleWorldInfoRuntime),
      characters: sha256(oracleCharacters),
      types: sha256(oracleCharacterBookTypes),
    }).toEqual({
      endpoint: 'B2BC5EC953727853EBA14A03FD0859A34CFA77C8B043BC01AECD820A62DF49A7',
      validator: '77A0C34C412C205C943FB1EA87CF58CF5F206956FD397708B15DCC02EBF1D928',
      runtime: '5BA94F74AB7C1F13DB7C2AC3DC8778F0174D95278CC9698B24BB1A9C8AB76D61',
      characters: '6B430C2459AA77D3E1A55D7F2AFF664485F9323E2CBC71696DEC05E7F7BAE68E',
      types: '33526C8CDD192473C6165EE269CF9B0F6FAB7BC47A71DB575E4A0DCCC43E0717',
    });
  });

  it('executes the pinned Character, Novel, Agnai, and Risu converters and reads official Eldoria without mutation', async () => {
    const runtime = readFileSync(oracleWorldInfoRuntime, 'utf8');
    const characterSource = {
      extensions: {},
      entries: [{
        id: 8, keys: ['key'], content: 'content', enabled: true, insertion_order: 10,
        comment: '   ', name: 'ignored display name', priority: 99,
        use_regex: false, case_sensitive: false,
        extensions: { case_sensitive: true, delay_until_recursion: false },
      }],
    };
    const characterOracle = exactConverter(runtime, 'convertCharacterBook')(structuredClone(characterSource)).entries['8']!;
    const character = requireBook(await inspectWorldbook(encoder.encode(JSON.stringify(characterSource)), 'character.json')).entries[0]!;
    expect(normalizedConverterProjection(character)).toEqual(oracleConverterProjection(characterOracle));

    for (const [file, converterName] of [
      ['novel.json', 'convertNovelLorebook'],
      ['agnai.json', 'convertAgnaiMemoryBook'],
      ['risu.json', 'convertRisuLorebook'],
    ] as const) {
      const source = json(file);
      if (file === 'agnai.json') {
        ((source.entries as Array<Record<string, unknown>>)[0]!).name = '   ';
      }
      const oracleEntry = Object.values(exactConverter(runtime, converterName)(structuredClone(source)).entries)[0]!;
      const normalized = requireBook(await inspectWorldbook(encoder.encode(JSON.stringify(source)), file)).entries[0]!;
      expect(normalizedConverterProjection(normalized)).toEqual(oracleConverterProjection(oracleEntry));
    }

    const eldoriaBytes = new Uint8Array(readFileSync(oracleEldoria));
    const before = createHash('sha256').update(eldoriaBytes).digest('hex');
    expect(requireBook(await inspectWorldbook(eldoriaBytes, 'Eldoria.json')).name).toBe('Eldoria');
    expect(createHash('sha256').update(readFileSync(oracleEldoria)).digest('hex')).toBe(before);
  });
});
