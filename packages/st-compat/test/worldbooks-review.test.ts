import { describe, expect, it } from 'vitest';
import {
  exportCharacterBook,
  exportWorldbook,
  inspectWorldbook,
  type NormalizedWorldbook,
  type WorldbookImportPreview,
} from '../src/index.js';

const encoder = new TextEncoder();

function encoded(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function requireBook(preview: WorldbookImportPreview): NormalizedWorldbook {
  expect(preview.blockingErrors).toEqual([]);
  expect(preview.worldbook).not.toBeNull();
  return preview.worldbook!;
}

function characterEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry',
    keys: ['key'],
    content: 'content',
    enabled: true,
    insertion_order: 10,
    extensions: {},
    ...overrides,
  };
}

describe('reviewer UID and prototype reproductions', () => {
  it('exports __proto__ and constructor as own native entry keys without prototype mutation', async () => {
    const source = encoder.encode('{"entries":{"__proto__":{"uid":"__proto__","key":[],"content":"proto"},"constructor":{"uid":"constructor","key":[],"content":"ctor"}}}');
    const preview = await inspectWorldbook(source, 'prototype.json');
    const document = JSON.parse(Buffer.from(exportWorldbook(preview).bytes).toString('utf8')) as {
      entries: Record<string, { uid: string; content: string }>;
    };

    expect(Object.keys(document.entries)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(document.entries, '__proto__')).toBe(true);
    expect(document.entries.__proto__).toEqual({
      uid: '__proto__',
      key: [],
      keysecondary: [],
      comment: '',
      displayName: '',
      content: 'proto',
      constant: false,
      vectorized: false,
      selective: true,
      selectiveLogic: 0,
      addMemo: false,
      order: 100,
      priority: null,
      position: 0,
      disable: false,
      ignoreBudget: false,
      excludeRecursion: false,
      preventRecursion: false,
      matchPersonaDescription: false,
      matchCharacterDescription: false,
      matchCharacterPersonality: false,
      matchCharacterDepthPrompt: false,
      matchScenario: false,
      matchCreatorNotes: false,
      delayUntilRecursion: 0,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: '',
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      characterFilter: { isExclude: false, names: [], tags: [] },
      personaFilter: { isExclude: false, names: [], tags: [] },
      triggers: [],
      displayIndex: null,
      useRegex: true,
      extensions: {},
    });
  });

  it('keeps the canonical native object key for a unique numeric UID', async () => {
    const preview = await inspectWorldbook(encoded({
      entries: { original: { uid: 7, key: ['seven'], content: 'seven' } },
    }), 'numeric-uid.json');
    const document = JSON.parse(Buffer.from(exportWorldbook(preview).bytes).toString('utf8')) as {
      entries: Record<string, { uid: number }>;
    };

    expect(Object.keys(document.entries)).toEqual(['7']);
    expect(document.entries['7']).toMatchObject({ uid: 7 });
    expect(document.entries[String(document.entries['7']!.uid)]).toBe(document.entries['7']);
  });

  it('uses stable source ordinals for duplicate and marker-colliding UIDs across independent imports', async () => {
    const source = {
      extensions: {},
      entries: [
        characterEntry({ id: 'same', content: 'first' }),
        characterEntry({ id: 'same', content: 'second' }),
        characterEntry({ id: 'same~1', content: 'marker' }),
        characterEntry({ id: 1, content: 'numeric' }),
        characterEntry({ id: '1', content: 'string' }),
        characterEntry({ id: '__proto__', content: 'proto' }),
        characterEntry({ id: 'constructor', content: 'ctor' }),
      ],
    };
    const first = await inspectWorldbook(encoded(source), 'duplicates.json');
    const second = await inspectWorldbook(encoded(source), 'duplicates.json');
    const firstBook = requireBook(first);

    expect(firstBook.entries.map((entry) => (entry as unknown as { sourceOrdinal?: number }).sourceOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(exportWorldbook(first).bytes).toEqual(exportWorldbook(second).bytes);
    const exported = JSON.parse(Buffer.from(exportWorldbook(first).bytes).toString('utf8')) as { entries: Record<string, { uid: string | number }> };
    expect(Object.keys(exported.entries)).toEqual([
      '1', 'same', 'same~1~1', 'same~1', '1~1', '__proto__', 'constructor',
    ]);
    expect(Object.values(exported.entries).map((entry) => entry.uid)).toEqual([
      1, 'same', 'same', 'same~1', '1', '__proto__', 'constructor',
    ]);
  });

  it('preserves empty and whitespace-only string UIDs deterministically', async () => {
    const source = {
      extensions: {},
      entries: [
        characterEntry({ id: '', content: 'empty' }),
        characterEntry({ id: '  ', content: 'spaces' }),
      ],
    };
    const first = await inspectWorldbook(encoded(source), 'string-uids.json');
    const second = await inspectWorldbook(encoded(source), 'string-uids.json');

    expect(requireBook(first).entries.map((entry) => entry.sourceUid)).toEqual(['', '  ']);
    expect(exportWorldbook(first).bytes).toEqual(exportWorldbook(second).bytes);
  });
});

describe('reviewer structural detection reproductions', () => {
  it.each([
    ['Novel marker', { lorebookVersion: 1, extensions: {}, entries: [characterEntry()] }],
    ['Agnai marker', { kind: 'memory', extensions: {}, entries: [characterEntry()] }],
    ['Risu marker', { type: 'risu', data: [], extensions: {}, entries: [characterEntry()] }],
  ])('does not let a passthrough %s steal a structurally valid Character Book', async (_label, source) => {
    const preview = await inspectWorldbook(encoded(source), 'character-book.json');
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.sourceFormat).toBe('character-book');
  });

  it('returns an explicit blocker when two complete family structures match', async () => {
    const both = {
      lorebookVersion: 1,
      extensions: {},
      entries: [characterEntry({ text: 'novel text', contextConfig: { budgetPriority: 3 } })],
    };
    const preview = await inspectWorldbook(encoded(both), 'ambiguous.json');
    expect(preview.worldbook).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_format_ambiguous' }));
  });
});

describe('reviewer filename and converter-semantics reproductions', () => {
  it('uses a sanitized source filename stem only when the native book omits its name', async () => {
    const unnamed = await inspectWorldbook(encoded({ entries: {} }), '../Eldoria.json');
    const named = await inspectWorldbook(encoded({ name: 'Explicit Name', entries: {} }), 'ignored.json');

    expect(requireBook(unnamed).name).toBe('Eldoria');
    expect(exportWorldbook(unnamed).fileName).toBe('Eldoria.json');
    expect(requireBook(named).name).toBe('Explicit Name');
  });

  it('matches Character conversion defaults and retains fields the pinned converter ignores', async () => {
    const source = {
      extensions: {},
      entries: [characterEntry({
        id: 8,
        comment: 'converter memo',
        name: 'ignored display name',
        priority: 99,
        use_regex: false,
        case_sensitive: false,
        extensions: { case_sensitive: true, delay_until_recursion: false },
      })],
    };
    const preview = await inspectWorldbook(encoded(source), 'character-book.json');
    const entry = requireBook(preview).entries[0]!;

    expect(entry).toMatchObject({
      sourceUid: 8,
      position: 1,
      useRegex: true,
      caseSensitive: true,
      delayUntilRecursion: false,
      priority: null,
      displayName: 'converter memo',
      unknownFields: {
        name: 'ignored display name',
        priority: 99,
        use_regex: false,
        case_sensitive: false,
      },
    });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'entries[0].name' }),
      expect.objectContaining({ path: 'entries[0].priority' }),
      expect.objectContaining({ path: 'entries[0].use_regex' }),
      expect.objectContaining({ path: 'entries[0].case_sensitive' }),
    ]));
    expect((exportCharacterBook(requireBook(preview)).entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'ignored display name',
      priority: 99,
      use_regex: false,
      case_sensitive: false,
      extensions: { case_sensitive: true, delay_until_recursion: false },
    });
  });

  it('uses the pinned Character converter position ternary for every top-level position value', async () => {
    const preview = await inspectWorldbook(encoded({
      extensions: {},
      entries: [
        characterEntry({ id: 'before', position: 'before_char' }),
        characterEntry({ id: 'near-match', position: 'before_character' }),
        characterEntry({ id: 'after', position: 'after_char' }),
        characterEntry({ id: 'unknown', position: 'future_position' }),
        characterEntry({ id: 'null-extension', extensions: { position: null } }),
      ],
    }), 'character-positions.json');

    expect(requireBook(preview).entries.map((entry) => entry.position)).toEqual([0, 1, 1, 1, 1]);
  });

  it('ignores and warns on Character extensions.add_memo while preserving it as passthrough', async () => {
    const preview = await inspectWorldbook(encoded({
      extensions: {},
      entries: [characterEntry({ id: 'memo', comment: '', extensions: { add_memo: true } })],
    }), 'character-add-memo.json');
    const book = requireBook(preview);

    expect(book.entries[0]!.addMemo).toBe(false);
    expect(preview.warnings).toContainEqual(expect.objectContaining({
      code: 'worldbook_foreign_field_preserved', path: 'entries[0].extensions.add_memo',
    }));
    expect((exportCharacterBook(book).entries as Array<Record<string, any>>)[0]!.extensions.add_memo).toBe(true);
  });

  it('preserves boolean and numeric delay-until-recursion values in native and Character books', async () => {
    const native = await inspectWorldbook(encoded({
      entries: {
        falseDelay: { uid: 'falseDelay', key: [], content: 'false', delayUntilRecursion: false },
        levelDelay: { uid: 'levelDelay', key: [], content: 'level', delayUntilRecursion: 3 },
      },
    }), 'native.json');
    const character = await inspectWorldbook(encoded({
      extensions: {},
      entries: [
        characterEntry({ id: 'falseDelay', extensions: { delay_until_recursion: false } }),
        characterEntry({ id: 'levelDelay', extensions: { delay_until_recursion: 3 } }),
      ],
    }), 'character.json');

    expect(requireBook(native).entries.map((entry) => entry.delayUntilRecursion)).toEqual([false, 3]);
    expect(requireBook(character).entries.map((entry) => entry.delayUntilRecursion)).toEqual([false, 3]);
  });

  it('matches Risu activationPercent nullish and truthiness behavior', async () => {
    const preview = await inspectWorldbook(encoded({
      type: 'risu',
      data: [
        { id: 'zero', key: 'zero', content: 'zero', activationPercent: 0 },
        { id: 'null', key: 'null', content: 'null', activationPercent: null },
        { id: 'missing', key: 'missing', content: 'missing' },
        { id: 'fifty', key: 'fifty', content: 'fifty', activationPercent: 50 },
      ],
    }), 'risu.json');

    expect(requireBook(preview).entries.map(({ probability, useProbability }) => ({ probability, useProbability }))).toEqual([
      { probability: 0, useProbability: false },
      { probability: 100, useProbability: true },
      { probability: 100, useProbability: true },
      { probability: 50, useProbability: true },
    ]);
  });

  it('matches the pinned foreign converters boolean recursion-delay default', async () => {
    const sources = [
      { fileName: 'novel.json', value: { lorebookVersion: 1, entries: [{ id: 'n', keys: [], text: '', enabled: true, contextConfig: {} }] } },
      { fileName: 'agnai.json', value: { kind: 'memory', entries: [{ id: 'a', keywords: [], entry: '', enabled: true, weight: 0 }] } },
      { fileName: 'risu.json', value: { type: 'risu', data: [{ id: 'r', key: '', content: '' }] } },
    ];

    for (const source of sources) {
      expect(requireBook(await inspectWorldbook(encoded(source.value), source.fileName)).entries[0]!.delayUntilRecursion).toBe(false);
    }
  });

  it('sidecars every ignored Character field that collides with canonical native output', async () => {
    const source = {
      extensions: {},
      entries: [characterEntry({
        id: 'canonical-id', uid: 'ignored-uid', key: ['ignored-key'], order: 777, disable: true,
      })],
    };
    const preview = await inspectWorldbook(encoded(source), 'character-collisions.json');
    const native = exportWorldbook(preview);
    const reimported = await inspectWorldbook(native.bytes, 'character-collisions-native.json');
    const character = (exportCharacterBook(requireBook(reimported)).entries as Array<Record<string, unknown>>)[0]!;

    expect(character).toMatchObject({ uid: 'ignored-uid', key: ['ignored-key'], order: 777, disable: true });
  });
});

describe('reviewer nested filter and logical-bound reproductions', () => {
  it('deeply overlays known filter edits while retaining nested future fields and raw isolation', async () => {
    const source = {
      entries: {
        filter: {
          uid: 'filter', key: ['filter'], content: 'filter',
          characterFilter: { isExclude: true, names: ['A'], tags: ['B'], future: { nested: { value: 1 } } },
          personaFilter: { isExclude: false, names: ['P'], tags: [], futureFlag: 'keep' },
        },
      },
    };
    const preview = await inspectWorldbook(encoded(source), 'filters.json');
    const entry = requireBook(preview).entries[0]! as unknown as {
      characterFilter: { names: string[]; unknownFields?: Record<string, unknown> };
      personaFilter: { unknownFields?: Record<string, unknown> };
    };

    expect(entry.characterFilter.unknownFields).toEqual({ future: { nested: { value: 1 } } });
    expect(entry.personaFilter.unknownFields).toEqual({ futureFlag: 'keep' });
    entry.characterFilter.names = ['Edited'];
    (entry.characterFilter.unknownFields!.future as { nested: { value: number } }).nested.value = 2;
    expect(((preview.rawPayload!.entries as Record<string, any>).filter.characterFilter.future.nested.value)).toBe(1);

    const reimported = await inspectWorldbook(exportWorldbook(preview).bytes, 'filters-export.json');
    expect((requireBook(reimported).entries[0]!.characterFilter as unknown as { names: string[]; unknownFields: unknown })).toMatchObject({
      names: ['Edited'], unknownFields: { future: { nested: { value: 2 } } },
    });
  });

  it('blocks 10k entries before normalized entry allocation', async () => {
    const entries = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [String(index), { uid: index, key: [], content: '' }]));
    const preview = await inspectWorldbook(encoded({ entries }), 'too-many-entries.json');
    const malformed = await inspectWorldbook(encoded({ entries: Array.from({ length: 10_000 }, () => null) }), 'too-many-malformed-entries.json');
    expect(preview.worldbook).toBeNull();
    expect(preview.rawPayload).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_entry_limit' }));
    expect(malformed.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_entry_limit' }));
  });

  it('blocks excessive keys and filter values before normalization', async () => {
    const keys = await inspectWorldbook(encoded({
      entries: { one: { uid: 'one', key: Array.from({ length: 1_000 }, (_, index) => `k${index}`), content: '' } },
    }), 'too-many-keys.json');
    const filters = await inspectWorldbook(encoded({
      entries: { one: { uid: 'one', key: [], content: '', characterFilter: { names: Array.from({ length: 1_000 }, (_, index) => `n${index}`) } } },
    }), 'too-many-filter-values.json');
    const risuKeys = await inspectWorldbook(encoded({
      type: 'risu', data: [{ key: Array.from({ length: 1_000 }, () => 'k').join(','), content: '' }],
    }), 'too-many-risu-keys.json');
    const risuSecondary = await inspectWorldbook(encoded({
      type: 'risu', data: [{ key: 'k', secondkey: Array.from({ length: 1_000 }, () => '').join(','), content: '' }],
    }), 'too-many-risu-secondary-keys.json');
    expect(keys.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_key_limit' }));
    expect(filters.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_filter_value_limit' }));
    expect(risuKeys.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_key_limit' }));
    expect(risuSecondary.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_key_limit' }));
  });

  it('blocks excessive nested filter properties before deep cloning', async () => {
    const future = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`p${index}`, { value: index }]));
    const preview = await inspectWorldbook(encoded({
      entries: { one: { uid: 'one', key: [], content: '', personaFilter: { names: [], tags: [], future } } },
    }), 'nested-filter.json');
    expect(preview.worldbook).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_filter_property_limit' }));
  });

  it('caps field-specific diagnostics with one stable truncation warning', async () => {
    const unknown = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`future_${index}`, index]));
    const preview = await inspectWorldbook(encoded({
      lorebookVersion: 1,
      entries: [{ id: 'novel', keys: ['novel'], text: 'text', enabled: true, contextConfig: {}, ...unknown }],
    }), 'diagnostics.json');
    expect(preview.warnings.length).toBeLessThanOrEqual(65);
    expect(preview.warnings.at(-1)).toMatchObject({ code: 'worldbook_diagnostics_truncated' });
  });

  it('caps blocking diagnostics and blocks an amplified normalized preview over 2 MiB', async () => {
    const invalidEntries = Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [String(index), {
      uid: index, key: [], content: '', order: 1.5, role: 1.5, depth: -1,
    }]));
    const invalid = await inspectWorldbook(encoded({ entries: invalidEntries }), 'many-invalid-fields.json');
    expect(invalid.blockingErrors).toHaveLength(65);
    expect(invalid.blockingErrors.at(-1)).toMatchObject({ code: 'worldbook_diagnostics_truncated' });

    const validEntries = Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [String(index), {
      uid: index, key: [], content: '',
    }]));
    const amplified = await inspectWorldbook(encoded({ entries: validEntries }), 'amplified-preview.json');
    expect(amplified.worldbook).toBeNull();
    expect(amplified.rawPayload).toBeNull();
    expect(amplified.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_preview_limit' }));
    expect(new TextEncoder().encode(JSON.stringify(amplified)).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('blocks a normalized preview whose source envelope exceeds the Worldbook preview budget', async () => {
    const preview = await inspectWorldbook(encoded({
      entries: { one: { uid: 'one', key: [], content: 'x'.repeat(2 * 1024 * 1024 + 1) } },
    }), 'preview-limit.json');
    expect(preview.worldbook).toBeNull();
    expect(preview.rawPayload).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'worldbook_preview_limit' }));
  });
});

describe('reviewer persisted-domain validation reproductions', () => {
  it.each([
    ['empty book name', { name: '', entries: {} }, 'name'],
    ['fractional insertion order', {
      entries: { one: { uid: 'one', key: [], content: '', order: 1.5 } },
    }, 'entries[0].order'],
    ['negative entry depth', {
      entries: { one: { uid: 'one', key: [], content: '', depth: -1 } },
    }, 'entries[0].depth'],
    ['invalid nested filter values', {
      entries: { one: { uid: 'one', key: [], content: '', characterFilter: { names: 'not-an-array' } } },
    }, 'entries.one.characterFilter.names'],
  ])('blocks %s during inspect with a typed path', async (_label, source, path) => {
    const preview = await inspectWorldbook(encoded(source), 'invalid-domain.json');

    expect(preview.worldbook).toBeNull();
    expect(preview.rawPayload).toBeNull();
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({
      code: 'worldbook_content_invalid',
      path,
    }));
  });
});
