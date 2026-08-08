import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { decode as decodePngText, encode as encodePngText } from 'png-chunk-text';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_LIMITS,
  exportCharacter,
  inspectCharacter,
  type CharacterImportPreview,
  type InspectionLimits,
} from '../src/index.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'characters');
const encoder = new TextEncoder();
const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const basePng = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));
const syntheticGif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));

function bytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureRoot, name)));
}

function json(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8')) as Record<string, unknown>;
}

function metadataPng(payloads: readonly [keyword: 'chara' | 'ccv3', payload: unknown][], includeNote = false): Uint8Array {
  const chunks = extractPngChunks(basePng);
  const additions = [
    ...(includeNote ? [encodePngText('fixture-note', 'unrelated chunk bytes')] : []),
    ...payloads.map(([keyword, payload]) => encodePngText(keyword, Buffer.from(JSON.stringify(payload)).toString('base64'))),
  ];
  chunks.splice(-1, 0, ...additions);
  return encodePngChunks(chunks);
}

function limited(overrides: Partial<InspectionLimits>): InspectionLimits {
  return { ...DEFAULT_INSPECTION_LIMITS, ...overrides };
}

function requireCharacter(preview: CharacterImportPreview) {
  expect(preview.blockingErrors).toEqual([]);
  expect(preview.character).not.toBeNull();
  return preview.character!;
}

describe('Character Card normalization', () => {
  it.each([
    {
      file: 'v1.json', version: '1', name: 'V1 Aster', notes: 'Legacy creator note', examples: 'synthetic example',
      unknown: { topLevel: { legacy_unknown: { keep: 'v1' } }, data: {} },
    },
    {
      file: 'v2.json', version: '2.0', name: 'V2 Aster', notes: 'V2 creator note', examples: 'Is this collection real?',
      unknown: { topLevel: { top_unknown: { keep: 'v2-top' } }, data: { data_unknown: { keep: 'v2' } } },
    },
    {
      file: 'v3.json', version: '3.0', name: 'V3 Aster', notes: 'V3 creator note', examples: 'Every byte is accounted for.',
      unknown: {
        topLevel: { top_unknown: { keep: 'v3-top' } },
        data: {
          assets: expect.any(Array),
          group_only_greetings: ['Synthetic group greeting'],
          data_unknown: { keep: 'v3' },
        },
      },
    },
  ])('normalizes synthetic $file while preserving passthrough fields', async ({ file, version, name, notes, examples, unknown }) => {
    const preview = await inspectCharacter(bytes(file), file);
    const character = requireCharacter(preview);

    expect(preview.sourceFormat).toBe('json');
    expect(preview.version).toBe(version);
    expect(character).toMatchObject({
      name,
      description: expect.stringContaining('synthetic'),
      personality: expect.any(String),
      scenario: expect.any(String),
      firstMessage: expect.any(String),
      examples: expect.stringContaining(examples),
      systemPrompt: expect.any(String),
      postHistoryInstructions: expect.any(String),
      alternateGreetings: expect.any(Array),
      creatorNotes: notes,
      tags: expect.arrayContaining(['synthetic']),
      creator: 'TavernNext tests',
      characterVersion: expect.any(String),
      extensions: expect.objectContaining({ fixture_extension: expect.anything() }),
    });
    expect(preview.unknownFields).toEqual(unknown);
    expect(preview.rawPayloads.document).toEqual(json(file));
  });

  it('normalizes YAML through the same passthrough source schema', async () => {
    const preview = await inspectCharacter(bytes('character.yaml'), 'character.yaml');
    const character = requireCharacter(preview);

    expect(preview.sourceFormat).toBe('yaml');
    expect(character).toMatchObject({
      name: 'YAML Aster',
      description: 'A synthetic YAML archivist.',
      creatorNotes: 'YAML creator note',
      alternateGreetings: ['Another document is ready.'],
      extensions: { yaml_extension: true },
    });
    expect(preview.unknownFields).toEqual({
      topLevel: { top_yaml_unknown: 'preserved' },
      data: { yaml_unknown: { keep: 'yaml' } },
    });
  });

  it('retains an embedded Character Book and its unknown fields intact', async () => {
    const preview = await inspectCharacter(bytes('v2.json'), 'embedded-book.json');
    const character = requireCharacter(preview);

    expect(character.characterBook).toEqual((json('v2.json').data as Record<string, unknown>).character_book);
    expect(character.characterBook).toMatchObject({
      name: 'Synthetic Archive Notes',
      extensions: { book_unknown: 'preserved' },
      entries: [expect.objectContaining({ entry_extra: 'keep', extensions: { entry_unknown: 7 } })],
    });
  });

  it('selects ccv3 from a dual-metadata PNG while retaining both raw payloads and unrelated chunks', async () => {
    const v2 = json('v2.json');
    const v3 = json('v3.json');
    const source = metadataPng([['chara', v2], ['ccv3', v3]], true);
    const preview = await inspectCharacter(source, 'dual.png');
    const character = requireCharacter(preview);

    expect(preview.sourceFormat).toBe('png');
    expect(preview.selectedPayload).toBe('ccv3');
    expect(character.name).toBe('V3 Aster');
    expect(preview.rawPayloads).toMatchObject({ chara: v2, ccv3: v3 });
    expect(preview.sourcePng).toEqual(source);
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'png_multiple_character_chunks' }),
    ]));
  });

  it.each([
    {
      name: 'malformed metadata',
      source: () => {
        const chunks = extractPngChunks(basePng);
        chunks.splice(-1, 0, encodePngText('ccv3', Buffer.from('{not-json').toString('base64')));
        return encodePngChunks(chunks);
      },
      options: undefined,
      code: 'character_metadata_invalid_json',
    },
    {
      name: 'duplicate ccv3 metadata',
      source: () => metadataPng([['ccv3', json('v3.json')], ['ccv3', json('v3.json')]]),
      options: undefined,
      code: 'character_png_metadata_duplicate',
    },
    {
      name: 'oversized metadata',
      source: () => metadataPng([['ccv3', json('v3.json')]]),
      options: { limits: limited({ maxInMemoryEntryBytes: 64 }) },
      code: 'character_metadata_too_large',
    },
  ])('blocks $name without returning a normalized Character', async ({ source, options, code }) => {
    const preview = await inspectCharacter(source(), 'broken.png', options);
    expect(preview.character).toBeNull();
    expect(preview.blockingErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
});

describe('bounded Character archives', () => {
  it('resolves CharX card/assets and retains every non-card entry byte-for-byte', async () => {
    const source = zipSync({
      'card.json': bytes('v3.json'),
      'assets/avatar.gif': syntheticGif,
      'assets/focused.bin': Uint8Array.from([1, 3, 3, 7]),
      'unrecognized/notes.bin': Uint8Array.from([9, 8, 7, 6]),
    });
    const preview = await inspectCharacter(source, 'synthetic.charx');
    const character = requireCharacter(preview);

    expect(preview.sourceFormat).toBe('charx');
    expect(character.name).toBe('V3 Aster');
    expect(preview.avatar).toMatchObject({ path: 'assets/avatar.gif', bytes: syntheticGif });
    expect(preview.auxiliaryAssets).toEqual([
      { path: 'assets/avatar.gif', bytes: syntheticGif },
      { path: 'assets/focused.bin', bytes: Uint8Array.from([1, 3, 3, 7]) },
      { path: 'unrecognized/notes.bin', bytes: Uint8Array.from([9, 8, 7, 6]) },
    ]);
  });

  it('uses BYAF manifest-declared card/scenarios/assets and preserves every raw payload', async () => {
    const source = zipSync({
      'manifest.json': bytes('byaf-manifest.json'),
      'people/aster.json': bytes('byaf-character.json'),
      'people/images/avatar.gif': syntheticGif,
      'scenes/intro.json': bytes('byaf-scenario.json'),
      'scenes/alternate.json': bytes('byaf-alternate.json'),
      'unrecognized/sidecar.bin': Uint8Array.from([4, 2]),
    });
    const preview = await inspectCharacter(source, 'synthetic.byaf');
    const character = requireCharacter(preview);

    expect(preview.sourceFormat).toBe('byaf');
    expect(character).toMatchObject({
      name: 'BYAF Aster',
      description: 'A wholly synthetic BYAF archivist.',
      scenario: 'A synthetic BYAF archive is being inspected.',
      firstMessage: '{{char}}: The BYAF manifest is open.',
      examples: '<START>\n{{char}}: This example is synthetic.',
      systemPrompt: 'Document {{char}} with {{user}}.',
      alternateGreetings: ['{{char}}: Choose another synthetic scenario.'],
      creator: 'TavernNext tests',
      creatorNotes: 'https://example.invalid/synthetic',
      characterBook: expect.objectContaining({ entries: [expect.objectContaining({ keys: ['manifest', 'archive'] })] }),
    });
    expect(preview.avatar).toMatchObject({ path: 'people/images/avatar.gif', bytes: syntheticGif });
    expect(preview.rawPayloads).toMatchObject({
      manifest: json('byaf-manifest.json'),
      character: json('byaf-character.json'),
      scenarios: [json('byaf-scenario.json'), json('byaf-alternate.json')],
    });
    expect(preview.auxiliaryAssets.at(-1)).toEqual({
      path: 'unrecognized/sidecar.bin', bytes: Uint8Array.from([4, 2]),
    });
  });

  it.each([
    {
      label: 'traversal',
      archive: () => zipSync({ 'card.json': bytes('v3.json'), '../escape.bin': Uint8Array.from([1]) }),
      options: undefined,
      code: 'archive_path_traversal',
    },
    {
      label: 'entry count',
      archive: () => zipSync({ 'card.json': bytes('v3.json'), 'one.bin': Uint8Array.from([1]), 'two.bin': Uint8Array.from([2]) }),
      options: { limits: limited({ maxArchiveEntries: 2 }) },
      code: 'archive_entry_limit',
    },
    {
      label: 'decompressed byte',
      archive: () => zipSync({ 'card.json': bytes('v3.json'), 'large.bin': new Uint8Array(512) }),
      options: { limits: limited({ maxDecompressedBytes: 512 }) },
      code: 'archive_decompressed_limit',
    },
    {
      label: 'nesting',
      archive: () => zipSync({
        'card.json': bytes('v3.json'),
        'nested.zip': zipSync({ 'deeper.zip': zipSync({ 'leaf.bin': Uint8Array.from([1]) }) }),
      }),
      options: { limits: limited({ maxArchiveNesting: 2 }) },
      code: 'archive_nesting_limit',
    },
    {
      label: 'metadata memory',
      archive: () => zipSync({ 'card.json': bytes('v3.json') }),
      options: { limits: limited({ maxInMemoryEntryBytes: 64 }) },
      code: 'archive_entry_memory_limit',
    },
  ])('inherits Task 7 $label limits before codec extraction', async ({ archive, options, code }) => {
    const preview = await inspectCharacter(archive(), 'bounded.charx', options);
    expect(preview.character).toBeNull();
    expect(preview.blockingErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
});

describe('deterministic Character export', () => {
  it.each([
    { fixture: 'v2.json', format: 'json-v2' as const, spec: 'chara_card_v2', unknown: 'v2-top' },
    { fixture: 'v3.json', format: 'json-v3' as const, spec: 'chara_card_v3', unknown: 'v3-top' },
  ])('edits only description across $format export/re-import without losing passthrough data', async ({ fixture, format, spec, unknown }) => {
    const preview = await inspectCharacter(bytes(fixture), fixture);
    const edited = { ...preview, character: { ...requireCharacter(preview), description: `Edited ${format} description` } };

    const first = await exportCharacter(edited, format);
    const second = await exportCharacter(edited, format);
    expect(first).toMatchObject({ contentType: 'application/json; charset=utf-8', fileName: expect.stringMatching(/\.json$/) });
    expect(first.bytes).toEqual(second.bytes);
    const document = JSON.parse(Buffer.from(first.bytes).toString('utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({ spec, top_unknown: { keep: unknown } });

    const reimported = await inspectCharacter(first.bytes, first.fileName);
    const character = requireCharacter(reimported);
    expect(character.description).toBe(`Edited ${format} description`);
    expect(character.extensions).toEqual(requireCharacter(preview).extensions);
    expect(reimported.unknownFields).toEqual(preview.unknownFields);
    expect(first.auxiliaryAssets).toEqual(preview.auxiliaryAssets);
  });

  it('rewrites only Character metadata in the source PNG and preserves unrelated image chunks', async () => {
    const source = metadataPng([['chara', json('v2.json')], ['ccv3', json('v3.json')]], true);
    const preview = await inspectCharacter(source, 'dual.png');
    const edited = { ...preview, character: { ...requireCharacter(preview), description: 'Edited PNG description' } };

    const exported = await exportCharacter(edited, 'png');
    const repeated = await exportCharacter(edited, 'png');
    expect(exported).toMatchObject({ contentType: 'image/png', fileName: 'V3 Aster.png' });
    expect(exported.bytes).toEqual(repeated.bytes);
    const note = extractPngChunks(exported.bytes)
      .filter((chunk) => chunk.name === 'tEXt')
      .map((chunk) => decodePngText(chunk))
      .find(({ keyword }) => keyword === 'fixture-note');
    expect(note).toEqual({ keyword: 'fixture-note', text: 'unrelated chunk bytes' });

    const reimported = await inspectCharacter(exported.bytes, exported.fileName);
    expect(requireCharacter(reimported).description).toBe('Edited PNG description');
    expect(reimported.rawPayloads.chara).toMatchObject({
      top_unknown: { keep: 'v2-top' },
      data: { data_unknown: { keep: 'v2' }, description: 'Edited PNG description' },
    });
    expect(reimported.rawPayloads.ccv3).toMatchObject({
      top_unknown: { keep: 'v3-top' },
      data: { data_unknown: { keep: 'v3' }, description: 'Edited PNG description' },
    });
    expect(requireCharacter(reimported).extensions).toEqual(requireCharacter(preview).extensions);
  });

  it('converts a current non-PNG avatar, then falls back to the supplied bundled default card', async () => {
    const preview = await inspectCharacter(bytes('v3.json'), 'v3.json');
    const character = requireCharacter(preview);
    const withAvatar = { ...preview, character, avatar: { path: 'avatar.gif', bytes: syntheticGif } };

    const converted = await exportCharacter(withAvatar, 'png', { defaultPng: basePng });
    expect(converted.bytes.subarray(0, 8)).toEqual(pngSignature);
    const fallback = await exportCharacter({ ...preview, character, avatar: undefined }, 'png', { defaultPng: basePng });
    expect(fallback.bytes.subarray(0, 8)).toEqual(pngSignature);
    expect(fallback.bytes).not.toEqual(converted.bytes);
  });

  it.each([
    { label: 'V1 JSON', fileName: 'v1.json', source: () => bytes('v1.json') },
    { label: 'YAML', fileName: 'character.yaml', source: () => bytes('character.yaml') },
    {
      label: 'CharX',
      fileName: 'round-trip.charx',
      source: () => zipSync({
        'card.json': bytes('v3.json'),
        'assets/avatar.gif': syntheticGif,
        'unknown/sidecar.bin': Uint8Array.from([1, 4, 9]),
      }),
    },
    {
      label: 'BYAF',
      fileName: 'round-trip.byaf',
      source: () => zipSync({
        'manifest.json': bytes('byaf-manifest.json'),
        'people/aster.json': bytes('byaf-character.json'),
        'people/images/avatar.gif': syntheticGif,
        'scenes/intro.json': bytes('byaf-scenario.json'),
        'scenes/alternate.json': bytes('byaf-alternate.json'),
        'unknown/sidecar.bin': Uint8Array.from([2, 7, 1, 8]),
      }),
    },
  ])('round-trips an edited $label import through V3 while carrying every unknown field and asset', async ({ fileName, source }) => {
    const preview = await inspectCharacter(source(), fileName);
    const edited = { ...preview, character: { ...requireCharacter(preview), description: `Edited ${fileName}` } };

    const exported = await exportCharacter(edited, 'json-v3');
    expect(exported.auxiliaryAssets).toEqual(preview.auxiliaryAssets);
    const reimported = await inspectCharacter(exported.bytes, exported.fileName);
    expect(requireCharacter(reimported).description).toBe(`Edited ${fileName}`);
    expect(reimported.unknownFields).toEqual(preview.unknownFields);
    expect(requireCharacter(reimported).extensions).toEqual(requireCharacter(preview).extensions);
  });
});

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;
const validatorPath = oracleRoot === undefined ? '' : join(oracleRoot, 'src', 'validator', 'TavernCardValidator.js');

function validateWithOracle(payloads: readonly unknown[]): unknown[] {
  const program = [
    "import { pathToFileURL } from 'node:url';",
    'const { TavernCardValidator } = await import(pathToFileURL(process.argv[1]).href);',
    "let input = '';",
    'for await (const chunk of process.stdin) input += chunk;',
    'process.stdout.write(JSON.stringify(JSON.parse(input).map((card) => new TavernCardValidator(card).validate())));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program, validatorPath], {
    input: JSON.stringify(payloads),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`SillyTavern oracle failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown[];
}

describe.skipIf(oracleRoot === undefined || !existsSync(validatorPath))('SillyTavern 1.18.0 oracle export validation', () => {
  it('accepts deterministic JSON V2/V3 and both metadata payloads in PNG exports', async () => {
    const preview = await inspectCharacter(bytes('v3.json'), 'v3.json');
    const exportedV2 = await exportCharacter(preview, 'json-v2');
    const exportedV3 = await exportCharacter(preview, 'json-v3');
    expect(validateWithOracle([
      JSON.parse(Buffer.from(exportedV2.bytes).toString('utf8')),
      JSON.parse(Buffer.from(exportedV3.bytes).toString('utf8')),
    ])).toEqual([2, 3]);

    const png = await exportCharacter(preview, 'png', { defaultPng: basePng });
    const payloads = extractPngChunks(png.bytes)
      .filter((chunk) => chunk.name === 'tEXt')
      .map((chunk) => decodePngText(chunk))
      .filter(({ keyword }) => keyword === 'chara' || keyword === 'ccv3')
      .map(({ text }) => JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as unknown);
    expect(validateWithOracle(payloads)).toEqual([2, 3]);
  });
});
