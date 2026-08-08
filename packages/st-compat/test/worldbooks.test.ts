import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { decode as decodePngText, encode as encodePngText } from 'png-chunk-text';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_LIMITS,
  exportCharacterBook,
  exportWorldbook,
  inspectWorldbook,
  type InspectionLimits,
  type NormalizedWorldbook,
  type NormalizedWorldbookEntry,
  type WorldbookImportPreview,
} from '../src/index.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'worldbooks');
const characterFixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'characters');
const encoder = new TextEncoder();

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

function executableEntry(entry: NormalizedWorldbookEntry): Omit<NormalizedWorldbookEntry, 'id' | 'sourceOrdinal' | 'unknownFields'> {
  const { id: ignoredId, sourceOrdinal: ignoredOrdinal, unknownFields: ignoredUnknown, ...value } = entry;
  void ignoredId;
  void ignoredOrdinal;
  void ignoredUnknown;
  return value;
}

function executableBook(book: NormalizedWorldbook) {
  return {
    name: book.name,
    description: book.description,
    enabled: book.enabled,
    scanDepth: book.scanDepth,
    tokenBudget: book.tokenBudget,
    recursiveScanning: book.recursiveScanning,
    extensions: book.extensions,
    entries: book.entries.map(executableEntry),
  };
}

function pngWithAdditionalMetadata(source: Uint8Array, keyword: string, text: string): Uint8Array {
  const chunks = extractPngChunks(source);
  chunks.splice(-1, 0, encodePngText(keyword, text));
  return encodePngChunks(chunks);
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
    const exported = await exportWorldbook(preview);
    expect((JSON.parse(Buffer.from(exported.bytes).toString('utf8')) as any).entries['alpha-uid'].position).toBe(99);
  });
});

describe('Worldbook family codecs', () => {
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

    const exported = JSON.parse(Buffer.from((await exportWorldbook(preview)).bytes).toString('utf8')) as any;
    expect(Object.keys(exported.entries)).not.toContain('0');
    expect(Object.values(exported.entries).map((value: any) => value.uid)).toEqual([1, '1', 1, book.entries[3]?.sourceUid]);
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

describe('deterministic native export and round trip', () => {
  it.each(['native.json', 'character-book.json', 'novel.json', 'agnai.json', 'risu.json', 'naidata.png'])(
    'edits one field in %s and preserves executable form, raw extensions, and unknown values after native re-import',
    async (file) => {
      const preview = await inspectWorldbook(bytes(file), file);
      const original = requireBook(preview);
      const edited: WorldbookImportPreview = {
        ...preview,
        worldbook: {
          ...original,
          entries: original.entries.map((entry, index) => index === 0
            ? { ...entry, content: `Edited once: ${file}` }
            : entry),
        },
      };

      const first = await exportWorldbook(edited);
      const second = await exportWorldbook(edited);
      expect(first).toMatchObject({ contentType: 'application/json; charset=utf-8', fileName: expect.stringMatching(/\.json$/) });
      expect(first.bytes).toEqual(second.bytes);
      const reimported = requireBook(await inspectWorldbook(first.bytes, first.fileName));
      expect(reimported.entries[0]?.content).toBe(`Edited once: ${file}`);
      expect(executableBook(reimported)).toEqual(executableBook(edited.worldbook!));
      expect(reimported.unknownFields).toEqual(edited.worldbook!.unknownFields);
      expect(reimported.entries.map((entry) => entry.unknownFields)).toEqual(edited.worldbook!.entries.map((entry) => entry.unknownFields));
    },
  );

  it('exports entries in stable runtime order and uses source UIDs instead of array indexes', async () => {
    const preview = await inspectWorldbook(bytes('native.json'), 'native.json');
    const serialized = Buffer.from((await exportWorldbook(preview)).bytes).toString('utf8');
    const exported = JSON.parse(serialized) as any;

    expect(preview.worldbook?.entries.map((entry) => entry.sourceUid)).toEqual(['alpha-uid', 9]);
    // Typed keys avoid ECMAScript's canonical-integer reordering while the exact UID stays in the entry.
    expect(Object.keys(exported.entries)).toEqual(['9', 'alpha-uid']);
    expect(exported.entries['alpha-uid']).toMatchObject({ uid: 'alpha-uid', order: 100 });
    expect(exported.entries['9']).toMatchObject({ uid: 9, order: 90 });
  });

  it('builds a Character Book envelope with the same unknown book and entry extensions', async () => {
    const preview = await inspectWorldbook(bytes('character-book.json'), 'character-book.json');
    const embedded = exportCharacterBook(requireBook(preview));

    expect(embedded).toMatchObject({
      name: 'Synthetic Character Book',
      scan_depth: 9,
      token_budget: 1234,
      recursive_scanning: true,
      extensions: { book_unknown: 'keep-character-book', nested: { value: 1 } },
      character_book_unknown: { preserve: true },
      entries: expect.arrayContaining([expect.objectContaining({
        id: 42,
        content: 'Synthetic Character Book content.',
        entry_extra: 'keep-character-book-entry',
        extensions: expect.objectContaining({ entry_unknown: { keep: 'character-book-extension' } }),
      })]),
    });
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
  it('checks the pinned version/hash and accepts complete native and Character Book exports', async () => {
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

    const preview = await inspectWorldbook(bytes('all-fields.json'), 'all-fields.json');
    const exported = await exportWorldbook(preview);
    const directory = mkdtempSync(join(tmpdir(), 'tavernnext-worldbook-oracle-'));
    try {
      writeFileSync(join(directory, 'oracle.json'), exported.bytes);
      const loaderPath = join(directory, 'oracle-loader.mjs');
      writeFileSync(loaderPath, [
        "const source = (value) => `data:text/javascript,${encodeURIComponent(value)}`;",
        'export async function resolve(specifier, context, nextResolve) {',
        "  if (specifier === 'express') return { url: source(`export default { Router() { return { post() {} }; } };`), shortCircuit: true };",
        "  if (specifier === 'sanitize-filename') return { url: source(`export default value => value;`), shortCircuit: true };",
        "  if (specifier === 'lodash') return { url: source(`export default { isObjectLike: value => value !== null && typeof value === 'object' };`), shortCircuit: true };",
        "  if (specifier === 'write-file-atomic') return { url: source(`export const sync = () => {};`), shortCircuit: true };",
        "  if (specifier === '../util.js' && context.parentURL?.endsWith('/src/endpoints/worldinfo.js')) return { url: source(`export const tryParse = value => { try { return JSON.parse(value); } catch { return null; } };`), shortCircuit: true };",
        '  return nextResolve(specifier, context);',
        '}',
      ].join('\n'));
      const card = JSON.parse(readFileSync(join(characterFixtureRoot, 'v3.json'), 'utf8')) as any;
      card.data.character_book = exportCharacterBook(requireBook(preview));
      const program = [
        "import { pathToFileURL } from 'node:url';",
        'const [{ readWorldInfoFile }, { TavernCardValidator }] = await Promise.all([',
        '  import(pathToFileURL(process.argv[1]).href),',
        '  import(pathToFileURL(process.argv[2]).href),',
        ']);',
        "let input = ''; for await (const chunk of process.stdin) input += chunk;",
        'const book = readWorldInfoFile({ worlds: process.argv[3] }, "oracle", false);',
        'const card = JSON.parse(input);',
        'const entries = Object.values(book.entries);',
        'process.stdout.write(JSON.stringify({ keys: Object.keys(book.entries), editable: entries.every(entry => book.entries[entry.uid] === entry), card: new TavernCardValidator(card).validate() }));',
      ].join('\n');
      const result = spawnSync(
        process.execPath,
        ['--experimental-loader', pathToFileURL(loaderPath).href, '--input-type=module', '--eval', program, oracleWorldInfo, oracleValidator, directory],
        { input: JSON.stringify(card), encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(oracleWorldInfoRuntime, 'utf8')).toContain('if (!data.entries[entry.uid]) return;');
      expect(JSON.parse(result.stdout)).toEqual({ keys: ['7'], editable: true, card: 3 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
