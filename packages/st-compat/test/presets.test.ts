import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exportPreset,
  inspectPreset,
  persistPresetSourceAssociations,
  presetSettingsForExecution,
} from '../src/index.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'presets');
const encoder = new TextEncoder();
const sourceAssociationKey = '__tavernnextPresetSource';

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureRoot, path)));
}

type PresetPreview = Awaited<ReturnType<typeof inspectPreset>>;

function storedCompatibility(preview: PresetPreview, associationEnvelope: unknown) {
  return {
    rawPayload: {
      rawDocument: structuredClone(preview.rawPayload),
      ...(preview.wrapperKey === undefined ? {} : { wrapperKey: preview.wrapperKey }),
      associationEnvelope: structuredClone(associationEnvelope),
    },
  };
}

async function duplicateOrderFixture(): Promise<{
  source: {
    name: string;
    kind: 'chat';
    settings: Record<string, unknown>;
    compatibility: ReturnType<typeof storedCompatibility>;
  };
  associationEnvelope: unknown;
  group: Record<string, unknown>;
  first: Record<string, unknown>;
  second: Record<string, unknown>;
}> {
  const preview = await inspectPreset(encoder.encode(JSON.stringify({
    prompts: [],
    prompt_order: [{
      character_id: 7,
      order: [
        { identifier: 'duplicate', enabled: true, opaque: { origin: 'first' } },
        { identifier: 'duplicate', enabled: false, opaque: { origin: 'second' } },
      ],
    }],
  })), 'duplicate-order.settings');
  const persisted = persistPresetSourceAssociations(preview);
  const source = {
    name: preview.name,
    kind: 'chat' as const,
    settings: persisted.settings,
    compatibility: storedCompatibility(preview, persisted.associationEnvelope),
  };
  const group = (source.settings.prompt_order as Array<Record<string, unknown>>)[0]!;
  const order = group.order as Array<Record<string, unknown>>;
  return { source, associationEnvelope: persisted.associationEnvelope, group, first: order[0]!, second: order[1]! };
}

async function exportDuplicateOrder(
  source: Awaited<ReturnType<typeof duplicateOrderFixture>>['source'],
  group: Record<string, unknown>,
  order: Array<Record<string, unknown>>,
  compatibility = source.compatibility,
): Promise<Record<string, unknown>> {
  const artifact = await exportPreset({
    ...source,
    compatibility,
    settings: { ...source.settings, prompt_order: [{ ...group, order }] },
  });
  return JSON.parse(Buffer.from(artifact.bytes).toString('utf8')) as Record<string, unknown>;
}

function exportedChatOrder(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const groups = document.prompt_order as Array<Record<string, unknown>>;
  return groups[0]!.order as Array<Record<string, unknown>>;
}

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;
const oracleFamilies = [
  ['openai', 'chat'],
  ['textgen', 'text'],
  ['kobold', 'text'],
  ['novel', 'text'],
  ['context', 'context'],
  ['instruct', 'instruct'],
  ['sysprompt', 'system'],
  ['reasoning', 'reasoning'],
] as const;
const oracleCases: Array<readonly [string, string, (typeof oracleFamilies)[number][1]]> = oracleRoot === undefined
  ? [['oracle-disabled', '', 'text']]
  : oracleFamilies.flatMap(([directory, kind]) => readdirSync(join(oracleRoot, 'default', 'content', 'presets', directory))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => [directory, fileName, kind] as const));

describe.runIf(oracleRoot !== undefined)('read-only SillyTavern default preset oracle', () => {
  it.each(oracleCases)('accepts official %s/%s as %s', async (directory, fileName, kind) => {
    const source = new Uint8Array(readFileSync(join(oracleRoot!, 'default', 'content', 'presets', directory, fileName)));
    const preview = await inspectPreset(source, fileName);

    expect(preview.blockingErrors, `${directory}/${fileName}`).toEqual([]);
    expect(preview.kind, `${directory}/${fileName}`).toBe(kind);
  });
});

describe('SillyTavern preset structural inspection', () => {
  it.each([
    ['chat/synthetic-chat.settings', 'not-the-extension.bin', 'chat'],
    ['text/synthetic-text.json', 'not-a-text-preset.bin', 'text'],
    ['text/wrapped-text.preset', 'opaque-input.data', 'text'],
    ['context/synthetic-context.json', 'renamed.input', 'context'],
    ['context/wrapped-context.settings', 'opaque-input.data', 'context'],
    ['instruct/synthetic-instruct.json', 'renamed.input', 'instruct'],
    ['system/synthetic-system.json', 'renamed.input', 'system'],
    ['reasoning/synthetic-reasoning.json', 'renamed.input', 'reasoning'],
  ] as const)('detects synthetic %s as %s from its shape, not its filename', async (fixture, fileName, kind) => {
    const preview = await inspectPreset(bytes(fixture), fileName);

    expect(preview).toMatchObject({ kind, candidates: [kind], blockingErrors: [] });
  });

  it('retains empty and duplicate Chat prompt ordering plus roles, markers, triggers, nested fields, and unexecutable providers', async () => {
    const preview = await inspectPreset(bytes('chat/synthetic-chat.settings'), 'renamed.bin');

    expect(preview.kind).toBe('chat');
    expect(preview.settings).toMatchObject({
      prompts: [
        expect.objectContaining({
          identifier: 'system-main', role: 'system', marker: false,
          generation_trigger: ['normal', 'regenerate'],
        }),
        expect.objectContaining({
          identifier: 'empty-marker', content: '', role: 'assistant', marker: true,
          generation_trigger: ['continue'],
        }),
      ],
      prompt_order: [{
        character_id: 100000,
        order: [
          { identifier: 'empty-marker', enabled: true },
          { identifier: 'system-main', enabled: true },
          { identifier: 'empty-marker', enabled: false },
        ],
      }],
      temperature: 0.73,
      top_p: 0.91,
      tokenizer: 17,
    });
    expect(preview.unknownFields).toMatchObject({
      prompts: [
        { unknown_prompt_nested: { retain: [0, false, 'yes'] } },
        { unknown_prompt_nested: { retain: 'empty-content' } },
      ],
      openrouter_model: 'synthetic/never-called',
      vendor_provider_payload: { nested: { retain: true } },
      top_unknown: { nested: ['preserve', { all: true }] },
    });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_field_preserved_not_executable' }),
    ]));
    expect(preview.settings).not.toHaveProperty('openrouter_model');
    expect(preview.settings).not.toHaveProperty('vendor_provider_payload');
    expect(preview.settings.prompts).toEqual(expect.arrayContaining([
      expect.not.objectContaining({ unknown_prompt_nested: expect.anything() }),
    ]));
  });

  it('keeps recursively nested provider fields compatibility-only and preserves them through nested edits', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      name: 'Nested Provider Chat',
      prompts: [{
        identifier: 'main', name: 'Main', role: 'system', content: 'Before', enabled: true, marker: false,
        generation_trigger: ['normal'], provider_prompt: { secret_ref: 'opaque' },
      }],
      prompt_order: [{
        character_id: 100000,
        order: [{ identifier: 'main', enabled: true, vendor_order: { retain: true } }],
        provider_order_metadata: { retain: 'root' },
      }],
      temperature: 0.7,
    })), 'nested-provider.settings');

    expect(preview.blockingErrors).toEqual([]);
    expect(preview.settings).toMatchObject({
      prompts: [expect.objectContaining({ identifier: 'main', content: 'Before' })],
      prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
    });
    expect(preview.settings.prompts).toEqual([
      expect.not.objectContaining({ provider_prompt: expect.anything() }),
    ]);
    expect(preview.settings.prompt_order).toEqual([
      expect.not.objectContaining({ provider_order_metadata: expect.anything() }),
    ]);
    expect(preview.unknownFields).toMatchObject({
      prompts: [{ provider_prompt: { secret_ref: 'opaque' } }],
      prompt_order: [{
        order: [{ vendor_order: { retain: true } }],
        provider_order_metadata: { retain: 'root' },
      }],
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));

    const prompts = structuredClone(preview.settings.prompts) as Array<Record<string, unknown>>;
    prompts[0]!.content = 'After';
    const exported = await exportPreset({ ...preview, settings: { ...preview.settings, prompts } });
    expect(JSON.parse(Buffer.from(exported.bytes).toString('utf8'))).toMatchObject({
      prompts: [{ content: 'After', provider_prompt: { secret_ref: 'opaque' } }],
      prompt_order: [{
        order: [{ vendor_order: { retain: true } }],
        provider_order_metadata: { retain: 'root' },
      }],
    });
  });

  it('removes recursively nested provider keys from otherwise executable configuration objects', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prefix: '<think>', separator: '</think>', suffix: '<answer>',
      reasoning_config: {
        mode: 'visible',
        provider_endpoint: 'https://example.invalid/not-executed',
      },
    })), 'reasoning.settings');

    expect(preview.settings).toMatchObject({ reasoning_config: { mode: 'visible' } });
    expect(preview.settings.reasoning_config).not.toHaveProperty('provider_endpoint');
    expect(preview.unknownFields).toMatchObject({
      reasoning_config: { provider_endpoint: 'https://example.invalid/not-executed' },
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));
  });

  it('filters actual reasoning provider settings without stripping schema-like opaque descendants', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prefix: '<think>', separator: '</think>', suffix: '<answer>',
      reasoning_config: {
        mode: 'visible',
        provider_endpoint: 'https://example.invalid/not-executed',
        response_schema: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            vendor_code: { type: 'integer' },
          },
          required: ['provider', 'vendor_code'],
        },
        examples: [{ provider: 'literal-data', vendor_code: 7 }],
      },
    })), 'reasoning-opaque.settings');

    expect(preview.settings).toMatchObject({
      reasoning_config: {
        mode: 'visible',
        response_schema: {
          properties: {
            provider: { type: 'string' },
            vendor_code: { type: 'integer' },
          },
          required: ['provider', 'vendor_code'],
        },
        examples: [{ provider: 'literal-data', vendor_code: 7 }],
      },
    });
    expect(preview.settings.reasoning_config).not.toHaveProperty('provider_endpoint');
    expect(preview.unknownFields).toEqual({
      reasoning_config: { provider_endpoint: 'https://example.invalid/not-executed' },
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));

    const exported = JSON.parse(Buffer.from((await exportPreset(preview)).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      reasoning_config: {
        provider_endpoint: 'https://example.invalid/not-executed',
        response_schema: {
          properties: {
            provider: { type: 'string' },
            vendor_code: { type: 'integer' },
          },
          required: ['provider', 'vendor_code'],
        },
        examples: [{ provider: 'literal-data', vendor_code: 7 }],
      },
    });
  });

  it('preserves provider-named data inside recognized opaque Text values atomically', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      temperature: 0.7,
      top_p: 0.9,
      json_schema: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          vendor_code: { type: 'integer' },
        },
        required: ['provider', 'vendor_code'],
      },
      logit_bias: [{ provider: 'literal-token', vendor_code: 42, bias: -1 }],
    })), 'opaque-values.settings');

    expect(preview.blockingErrors).toEqual([]);
    expect(preview.settings).toMatchObject({
      json_schema: {
        properties: {
          provider: { type: 'string' },
          vendor_code: { type: 'integer' },
        },
        required: ['provider', 'vendor_code'],
      },
      logit_bias: [{ provider: 'literal-token', vendor_code: 42, bias: -1 }],
    });
    expect(preview.unknownFields).toEqual({});
    expect(preview.warnings).not.toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));

    const exported = JSON.parse(Buffer.from((await exportPreset(preview)).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      json_schema: {
        properties: {
          provider: { type: 'string' },
          vendor_code: { type: 'integer' },
        },
        required: ['provider', 'vendor_code'],
      },
      logit_bias: [{ provider: 'literal-token', vendor_code: 42, bias: -1 }],
    });
  });

  it('still separates provider fields at actual family schema nodes', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      temperature: 0.7,
      top_p: 0.9,
      json_schema: { properties: { provider: { const: 'data' } }, required: ['provider'] },
      phrase_rep_pen: 'medium',
      vendor_transport: { endpoint: 'https://example.invalid/not-executed' },
    })), 'provider-node.settings');

    expect(preview.settings).toMatchObject({
      json_schema: { properties: { provider: { const: 'data' } }, required: ['provider'] },
    });
    expect(preview.settings).not.toHaveProperty('phrase_rep_pen');
    expect(preview.settings).not.toHaveProperty('vendor_transport');
    expect(preview.unknownFields).toEqual({
      phrase_rep_pen: 'medium',
      vendor_transport: { endpoint: 'https://example.invalid/not-executed' },
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));

    const novel = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.7,
        phrase_rep_pen: 'aggressive',
        json_schema: { properties: { provider: { const: 'data' } }, required: ['provider'] },
      },
    })), 'provider-node.preset');
    expect(novel.settings).toMatchObject({
      json_schema: { properties: { provider: { const: 'data' } }, required: ['provider'] },
    });
    expect(novel.settings).not.toHaveProperty('phrase_rep_pen');
    expect(novel.unknownFields).toEqual({ parameters: { phrase_rep_pen: 'aggressive' } });
    expect(novel.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));
  });

  it('keeps OpenAI transport and token-limit fields outside executable Chat settings', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [], prompt_order: [], temperature: 0.5,
      openai_max_tokens: 321, openai_max_context: 4096, stream_openai: true,
    })), 'chat.settings');

    expect(preview.settings).toEqual({ prompts: [], prompt_order: [], temperature: 0.5 });
    expect(preview.unknownFields).toMatchObject({
      openai_max_tokens: 321, openai_max_context: 4096, stream_openai: true,
    });
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));
  });

  it('preserves Text sampler/tokenizer settings, Context story formatting, Instruct sequences/stops, System Prompt placement, and Reasoning extraction fields', async () => {
    const text = await inspectPreset(bytes('text/synthetic-text.json'), 'text.bin');
    const context = await inspectPreset(bytes('context/synthetic-context.json'), 'context.bin');
    const instruct = await inspectPreset(bytes('instruct/synthetic-instruct.json'), 'instruct.bin');
    const system = await inspectPreset(bytes('system/synthetic-system.json'), 'system.bin');
    const reasoning = await inspectPreset(bytes('reasoning/synthetic-reasoning.json'), 'reasoning.bin');

    expect(text.settings).toMatchObject({
      temperature: 0.61, top_p: 0.88, top_k: 42, repetition_penalty: 1.08,
      sampler_order: [6, 0, 1, 3], samplers: ['top_k', 'top_p', 'temperature'], tokenizer: 19,
    });
    expect(context.settings).toMatchObject({
      story_string: '{{description}}\n{{personality}}\n{{scenario}}', story_string_position: 1,
      story_string_depth: 3, story_string_role: 0, example_separator: '<EXAMPLE>', chat_start: '<CHAT>',
      use_stop_strings: true, names_as_stop_strings: false,
    });
    expect(instruct.settings).toMatchObject({
      input_sequence: '<|user|>', output_sequence: '<|assistant|>', system_sequence: '<|system|>',
      input_suffix: '</u>', output_suffix: '</a>', system_suffix: '</s>', first_input_sequence: '',
      last_output_sequence: '<|end|>', stop_sequence: ['<|stop|>', ''], sequences_as_stop_strings: true,
    });
    expect(system.settings).toEqual({ content: 'Write only synthetic notes.', post_history: 'After the chat, add a concise archive note.' });
    expect(reasoning.settings).toEqual({
      prefix: '<think>', separator: '</think>\n', suffix: '</answer>', extract_regex: '<think>([\\s\\S]*?)</think>',
    });
  });

  it('warns with an explicit stable candidate list for an ambiguous wrapper shape', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      name: 'Ambiguous Synthetic',
      prompts: [],
      prompt_order: [],
      story_string: '{{description}}',
    })), 'ambiguous.data');

    expect(preview).toMatchObject({ kind: 'chat', candidates: ['chat', 'context'], blockingErrors: [] });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous_preset' }),
    ]));
  });

  it.each([
    ['malformed JSON', encoder.encode('{'), 'preset_json_invalid'],
    ['non-object JSON', encoder.encode('[]'), 'preset_root_invalid'],
    ['non-object preset wrapper', encoder.encode('{"preset": false}'), 'preset_wrapper_invalid'],
    ['unrecognized object', encoder.encode('{"name":"Not a preset"}'), 'preset_unrecognized'],
  ])('blocks %s without creating executable settings', async (_label, source, code) => {
    const preview = await inspectPreset(source, 'invalid.bin');

    expect(preview.settings).toEqual({});
    expect(preview.blockingErrors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it('blocks malformed known nested and scalar Chat fields before they become executable settings', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [42],
      prompt_order: [{ order: 'bad' }],
      temperature: 'hot',
    })), 'malformed.settings');

    expect(preview.settings).toEqual({});
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'preset_fields_invalid' }));
  });

  it('normalizes official flat TextGen and Kobold aliases to canonical executable settings', async () => {
    const textgen = await inspectPreset(encoder.encode(JSON.stringify({
      temp: 0.72,
      top_p: 0.9,
      tfs: 0.8,
      rep_pen: 1.1,
      rep_pen_range: 512,
      rep_pen_slope: 0.2,
      length_penalty: 1.25,
      min_temp: 0.3,
      max_temp: 1.4,
      logit_bias: [{ token: 42, bias: -1 }],
    })), 'direct-textgen.settings');
    const kobold = await inspectPreset(encoder.encode(JSON.stringify({
      temp: 0.81,
      top_p: 0.92,
      typical: 0.77,
      mirostat: 2,
      grammar: 'root ::= "ok"',
      tfs: 0.66,
      rep_pen: 1.08,
    })), 'direct-kobold.preset');

    expect(textgen).toMatchObject({
      kind: 'text',
      settings: {
        temperature: 0.72,
        tail_free_sampling: 0.8,
        repetition_penalty: 1.1,
        repetition_penalty_range: 512,
        repetition_penalty_slope: 0.2,
        length_penalty: 1.25,
        min_temp: 0.3,
        max_temp: 1.4,
        logit_bias: [{ token: 42, bias: -1 }],
      },
      blockingErrors: [],
    });
    expect(textgen.settings).not.toHaveProperty('temp');
    expect(textgen.settings).not.toHaveProperty('tfs');
    expect(kobold).toMatchObject({
      kind: 'text',
      settings: {
        temperature: 0.81,
        typical_p: 0.77,
        mirostat_mode: 2,
        grammar_string: 'root ::= "ok"',
        tail_free_sampling: 0.66,
        repetition_penalty: 1.08,
      },
      blockingErrors: [],
    });

    const exportedTextgen = JSON.parse(Buffer.from((await exportPreset({
      ...textgen,
      settings: { ...textgen.settings, temperature: 0.93, tail_free_sampling: 0.61 },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exportedTextgen).toMatchObject({ temp: 0.93, tfs: 0.61, rep_pen: 1.1 });
    expect(exportedTextgen).not.toHaveProperty('temperature');
    expect(exportedTextgen).not.toHaveProperty('tail_free_sampling');

    const exportedKobold = JSON.parse(Buffer.from((await exportPreset({
      ...kobold,
      settings: { ...kobold.settings, typical_p: 0.64, mirostat_mode: 1, grammar_string: 'root ::= "edited"' },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exportedKobold).toMatchObject({ typical: 0.64, mirostat: 1, grammar: 'root ::= "edited"' });
    expect(exportedKobold).not.toHaveProperty('typical_p');
    expect(exportedKobold).not.toHaveProperty('mirostat_mode');
    expect(exportedKobold).not.toHaveProperty('grammar_string');
  });

  it('normalizes direct NovelAI parameters without making the envelope executable', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.63,
        top_p: 0.88,
        order: [{ id: 'temperature', enabled: true }],
        tail_free_sampling: 0.75,
        repetition_penalty: 1.12,
        repetition_penalty_range: 2048,
        repetition_penalty_frequency: 0.01,
        repetition_penalty_presence: 0.02,
        provider_payload: { retain: true },
      },
    })), 'novel-direct.preset');

    expect(preview).toMatchObject({
      kind: 'text',
      settings: {
        temperature: 0.63,
        top_p: 0.88,
        order: [{ id: 'temperature', enabled: true }],
        tail_free_sampling: 0.75,
        repetition_penalty: 1.12,
        repetition_penalty_range: 2048,
        repetition_penalty_frequency: 0.01,
        repetition_penalty_presence: 0.02,
      },
      unknownFields: { parameters: { provider_payload: { retain: true } } },
      blockingErrors: [],
    });
    expect(preview.settings).not.toHaveProperty('parameters');
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'provider_field_preserved_not_executable' }));
  });
});

describe('lossless deterministic preset export', () => {
  it('keeps prompt metadata with stable identifiers across reorder, insertion, and deletion', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [
        { identifier: 'alpha', content: 'A', opaque: { source: 'alpha' } },
        { identifier: 'beta', content: 'B', opaque: { source: 'beta' } },
      ],
      prompt_order: [],
    })), 'chat.settings');
    const prompts = structuredClone(preview.settings.prompts) as Array<Record<string, unknown>>;
    const alpha = prompts[0]!;
    const beta = prompts[1]!;
    const inserted = { identifier: 'inserted', content: 'new' };

    const reordered = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: { ...preview.settings, prompts: [beta, inserted, alpha] },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(reordered.prompts).toEqual([
      expect.objectContaining({ identifier: 'beta', opaque: { source: 'beta' } }),
      { identifier: 'inserted', content: 'new' },
      expect.objectContaining({ identifier: 'alpha', opaque: { source: 'alpha' } }),
    ]);

    const deleted = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: { ...preview.settings, prompts: [beta] },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(deleted.prompts).toEqual([
      expect.objectContaining({ identifier: 'beta', opaque: { source: 'beta' } }),
    ]);
  });

  it('keeps Chat prompt metadata through the versioned persistence sidecar', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [
        { identifier: 'alpha', content: 'A', opaque: { source: 'alpha' } },
        { identifier: 'beta', content: 'B', opaque: { source: 'beta' } },
      ],
      prompt_order: [],
    })), 'persisted-chat.settings');
    const persisted = persistPresetSourceAssociations(preview);
    const prompts = persisted.settings.prompts as Array<Record<string, unknown>>;
    const source = {
      name: preview.name,
      kind: 'chat' as const,
      settings: { ...persisted.settings, prompts: [{ ...prompts[1]!, content: 'B edited' }, prompts[0]!] },
      compatibility: storedCompatibility(preview, persisted.associationEnvelope),
    };

    const document = JSON.parse(Buffer.from((await exportPreset(source)).bytes).toString('utf8')) as Record<string, unknown>;

    expect(document.prompts).toEqual([
      { identifier: 'beta', content: 'B edited', opaque: { source: 'beta' } },
      { identifier: 'alpha', content: 'A', opaque: { source: 'alpha' } },
    ]);
  });

  it('matches prompt-order groups and duplicate order entries occurrence-aware', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [],
      prompt_order: [
        {
          character_id: 1,
          group_opaque: 'one',
          order: [
            { identifier: 'dup', enabled: true, opaque: 'first-dup' },
            { identifier: 'solo', enabled: true, opaque: 'solo' },
            { identifier: 'dup', enabled: false, opaque: 'second-dup' },
          ],
        },
        { character_id: 2, group_opaque: 'two', order: [] },
      ],
    })), 'chat.settings');
    const groups = structuredClone(preview.settings.prompt_order) as Array<Record<string, unknown>>;
    const first = groups[0]!;
    const second = groups[1]!;
    const firstOrder = first.order as Array<Record<string, unknown>>;
    first.order = [firstOrder[1]!, firstOrder[0]!, firstOrder[2]!];

    const document = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: { ...preview.settings, prompt_order: [second, first] },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(document.prompt_order).toEqual([
      expect.objectContaining({ character_id: 2, group_opaque: 'two', order: [] }),
      expect.objectContaining({
        character_id: 1,
        group_opaque: 'one',
        order: [
          expect.objectContaining({ identifier: 'solo', opaque: 'solo' }),
          expect.objectContaining({ identifier: 'dup', opaque: 'first-dup' }),
          expect.objectContaining({ identifier: 'dup', opaque: 'second-dup' }),
        ],
      }),
    ]);
  });

  it('keeps duplicate-id metadata attached through swaps and known-field edits', async () => {
    const { source, group, first, second } = await duplicateOrderFixture();

    const document = await exportDuplicateOrder(source, group, [
      { ...second, enabled: true },
      { ...first, enabled: false },
    ]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true, opaque: { origin: 'second' } },
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
    ]);
  });

  it('does not migrate duplicate-id metadata when either original occurrence is deleted', async () => {
    const { source, group, first, second } = await duplicateOrderFixture();

    const withoutFirst = await exportDuplicateOrder(source, group, [{ ...second, enabled: true }]);
    expect(exportedChatOrder(withoutFirst)).toEqual([
      { identifier: 'duplicate', enabled: true, opaque: { origin: 'second' } },
    ]);

    const withoutSecond = await exportDuplicateOrder(source, group, [{ ...first, enabled: false }]);
    expect(exportedChatOrder(withoutSecond)).toEqual([
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
    ]);
  });

  it('leaves new duplicate ids clean before, between, and after associated originals', async () => {
    const { source, group, first, second } = await duplicateOrderFixture();

    const document = await exportDuplicateOrder(source, group, [
      { identifier: 'duplicate', enabled: true },
      { ...first, enabled: false },
      { identifier: 'duplicate', enabled: false },
      { ...second, enabled: true },
      { identifier: 'duplicate', enabled: true },
    ]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
      { identifier: 'duplicate', enabled: false },
      { identifier: 'duplicate', enabled: true, opaque: { origin: 'second' } },
      { identifier: 'duplicate', enabled: true },
    ]);
  });

  it('rejects a copied source token for both the copy and original regardless of ordering', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const copiedToken = structuredClone(first[sourceAssociationKey]);
    const copy = {
      identifier: 'duplicate',
      enabled: false,
      [sourceAssociationKey]: copiedToken,
    };

    for (const order of [[copy, first], [first, copy]]) {
      const document = await exportDuplicateOrder(source, group, order);
      const exportedOrder = exportedChatOrder(document);
      expect(exportedOrder).toEqual([
        expect.not.objectContaining({ opaque: expect.anything() }),
        expect.not.objectContaining({ opaque: expect.anything() }),
      ]);
      expect(exportedOrder[0]?.[sourceAssociationKey]).toEqual(copiedToken);
      expect(exportedOrder[1]?.[sourceAssociationKey]).toEqual(copiedToken);
    }
  });

  it('allows one deliberate same-identity token move and strips the validated marker', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const moved = {
      identifier: 'duplicate',
      enabled: false,
      [sourceAssociationKey]: structuredClone(first[sourceAssociationKey]),
    };

    const document = await exportDuplicateOrder(source, group, [moved]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
    ]);
  });

  it('does not consume forged legacy paths or sidecar-unknown tokens', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const marker = first[sourceAssociationKey] as Record<string, unknown>;
    const forgedToken = { ...marker, token: '018f0000-0000-7000-8000-000000000999' };
    const forgedPath = ['prompt_order', 0, 'order', 0];

    const document = await exportDuplicateOrder(source, group, [
      { identifier: 'duplicate', enabled: true, [sourceAssociationKey]: forgedPath },
      { identifier: 'duplicate', enabled: false, [sourceAssociationKey]: forgedToken },
    ]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true, [sourceAssociationKey]: forgedPath },
      { identifier: 'duplicate', enabled: false, [sourceAssociationKey]: forgedToken },
    ]);
  });

  it('fails closed when a valid token sidecar path is stale or out of range', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const compatibility = structuredClone(source.compatibility);
    const envelope = compatibility.rawPayload.associationEnvelope as {
      entries: Array<{ token: string; path: Array<string | number> }>;
    };
    const token = (first[sourceAssociationKey] as { token: string }).token;
    envelope.entries.find((entry) => entry.token === token)!.path = ['prompt_order', 0, 'order', 99];

    const document = await exportDuplicateOrder(source, group, [first], compatibility);
    const [exported] = exportedChatOrder(document);

    expect(exported).not.toHaveProperty('opaque');
    expect(exported?.[sourceAssociationKey]).toEqual(first[sourceAssociationKey]);
  });

  it('rejects a sidecar path redirected to a different same-identity source entry', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const compatibility = structuredClone(source.compatibility);
    const firstToken = (first[sourceAssociationKey] as { token: string }).token;
    const envelope = compatibility.rawPayload.associationEnvelope as {
      entries: Array<{ token: string; location: string; path: Array<string | number> }>;
    };
    const redirected = envelope.entries.find((entry) => entry.token === firstToken)!;
    const other = envelope.entries.find((entry) => entry.location === redirected.location && entry.token !== firstToken)!;
    envelope.entries = envelope.entries.filter((entry) => entry !== other);
    redirected.path = structuredClone(other.path);

    const document = await exportDuplicateOrder(source, group, [first], compatibility);
    const [exported] = exportedChatOrder(document);

    expect(exported).not.toHaveProperty('opaque');
    expect(exported?.[sourceAssociationKey]).toEqual(first[sourceAssociationKey]);
  });

  it('does not legacy-match replacements after every tokenized original is deleted', async () => {
    const { source, group } = await duplicateOrderFixture();

    const document = await exportDuplicateOrder(source, group, [
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false },
    ]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false },
    ]);
  });

  it.each([
    ['unsupported version', (envelope: Record<string, unknown>) => { envelope.version = 999; }],
    ['wrong preset kind', (envelope: Record<string, unknown>) => { envelope.kind = 'text'; }],
  ])('disables legacy fallback when the association envelope has %s', async (_label, tamper) => {
    const { source, group } = await duplicateOrderFixture();
    const compatibility = structuredClone(source.compatibility);
    tamper(compatibility.rawPayload.associationEnvelope as Record<string, unknown>);

    const document = await exportDuplicateOrder(source, group, [
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false },
    ], compatibility);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false },
    ]);
  });

  it('rejects duplicate sidecar tokens on distinct paths before either association can be consumed', async () => {
    const { source, group, first } = await duplicateOrderFixture();
    const compatibility = structuredClone(source.compatibility);
    const envelope = compatibility.rawPayload.associationEnvelope as {
      entries: Array<{ token: string; location: string; path: Array<string | number> }>;
    };
    const token = (first[sourceAssociationKey] as { token: string }).token;
    const matching = envelope.entries.find((entry) => entry.token === token)!;
    const other = envelope.entries.find((entry) => entry.location === matching.location && entry.token !== token)!;
    expect(other.path).not.toEqual(matching.path);
    other.token = token;

    const document = await exportDuplicateOrder(source, group, [first], compatibility);
    const [exported] = exportedChatOrder(document);

    expect(exported).not.toHaveProperty('opaque');
    expect(exported?.[sourceAssociationKey]).toEqual(first[sourceAssociationKey]);
  });

  it('honors a compatibility envelope even when a caller also supplies a direct raw payload', async () => {
    const { source, group } = await duplicateOrderFixture();
    const compatibility = structuredClone(source.compatibility);
    (compatibility.rawPayload.associationEnvelope as Record<string, unknown>).version = 999;
    const artifact = await exportPreset({
      ...source,
      rawPayload: structuredClone(compatibility.rawPayload.rawDocument),
      compatibility,
      settings: {
        ...source.settings,
        prompt_order: [{
          ...group,
          order: [
            { identifier: 'duplicate', enabled: true },
            { identifier: 'duplicate', enabled: false },
          ],
        }],
      },
    });
    const document = JSON.parse(Buffer.from(artifact.bytes).toString('utf8')) as Record<string, unknown>;

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: true },
      { identifier: 'duplicate', enabled: false },
    ]);
  });

  it('rebuilds duplicate source associations after JSON persistence', async () => {
    const reimported = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [],
      prompt_order: [{
        character_id: 7,
        order: [
          { identifier: 'duplicate', enabled: true },
          { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
          { identifier: 'duplicate', enabled: false },
          { identifier: 'duplicate', enabled: true, opaque: { origin: 'second' } },
          { identifier: 'duplicate', enabled: true },
        ],
      }],
    })), 'persisted-duplicates.settings');
    const persisted = persistPresetSourceAssociations(reimported);
    const source = {
      name: reimported.name,
      kind: 'chat' as const,
      settings: JSON.parse(JSON.stringify(persisted.settings)) as Record<string, unknown>,
      compatibility: JSON.parse(JSON.stringify(storedCompatibility(reimported, persisted.associationEnvelope))) as ReturnType<typeof storedCompatibility>,
    };
    const group = (source.settings.prompt_order as Array<Record<string, unknown>>)[0]!;
    const order = group.order as Array<Record<string, unknown>>;

    const document = await exportDuplicateOrder(source, group, [
      { ...order[3]!, enabled: false },
      { ...order[1]!, enabled: true },
    ]);

    expect(exportedChatOrder(document)).toEqual([
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'second' } },
      { identifier: 'duplicate', enabled: true, opaque: { origin: 'first' } },
    ]);
  });

  it('keeps NovelAI order metadata with stable ids and leaves new ids clean', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.7,
        order: [
          { id: 'temperature', enabled: true, opaque: 'temperature' },
          { id: 'top_p', enabled: true, opaque: 'top-p' },
        ],
      },
    })), 'novel.preset');
    const order = structuredClone(preview.settings.order) as Array<Record<string, unknown>>;

    const document = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: {
        ...preview.settings,
        order: [order[1]!, { id: 'min_p', enabled: false }, order[0]!],
      },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({
      parameters: {
        order: [
          { id: 'top_p', enabled: true, opaque: 'top-p' },
          { id: 'min_p', enabled: false },
          { id: 'temperature', enabled: true, opaque: 'temperature' },
        ],
      },
    });
  });

  it('uses required NovelAI order ids even when entries carry opaque identifiers', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.7,
        order: [
          { id: 'temperature', identifier: 'opaque-first', enabled: true, opaque: 'temperature' },
          { id: 'top_p', identifier: 'opaque-second', enabled: false, opaque: 'top-p' },
        ],
      },
    })), 'novel-opaque-identifiers.preset');
    const order = structuredClone(preview.settings.order) as Array<Record<string, unknown>>;

    const document = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: { ...preview.settings, order: [order[1]!, order[0]!] },
    })).bytes).toString('utf8')) as Record<string, unknown>;

    expect(document).toMatchObject({
      parameters: {
        order: [
          { id: 'top_p', identifier: 'opaque-second', enabled: false, opaque: 'top-p' },
          { id: 'temperature', identifier: 'opaque-first', enabled: true, opaque: 'temperature' },
        ],
      },
    });
  });

  it('keeps NovelAI order metadata through the versioned persistence sidecar', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.7,
        order: [
          { id: 'temperature', enabled: true, opaque: 'temperature' },
          { id: 'top_p', enabled: false, opaque: 'top-p' },
        ],
      },
    })), 'persisted-novel.preset');
    const persisted = persistPresetSourceAssociations(preview);
    const order = persisted.settings.order as Array<Record<string, unknown>>;
    const source = {
      name: preview.name,
      kind: 'text' as const,
      settings: { ...persisted.settings, order: [{ ...order[1]!, enabled: true }, order[0]!] },
      compatibility: storedCompatibility(preview, persisted.associationEnvelope),
    };

    const document = JSON.parse(Buffer.from((await exportPreset(source)).bytes).toString('utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({
      parameters: {
        order: [
          { id: 'top_p', enabled: true, opaque: 'top-p' },
          { id: 'temperature', enabled: true, opaque: 'temperature' },
        ],
      },
    });
    expect(presetSettingsForExecution(source.settings, source.compatibility, 'text').order).toEqual([
      { id: 'top_p', enabled: true },
      { id: 'temperature', enabled: true },
    ]);
  });

  it('uses positional overlay for arrays without a defined stable identity', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      temperature: 0.7,
      top_p: 0.9,
      logit_bias: [
        { token: 1, bias: -1, opaque: 'first-position' },
        { token: 2, bias: -2, opaque: 'second-position' },
      ],
    })), 'text.settings');

    const document = JSON.parse(Buffer.from((await exportPreset({
      ...preview,
      settings: {
        ...preview.settings,
        logit_bias: [{ token: 20, bias: -0.2 }, { token: 10, bias: -0.1 }],
      },
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(document.logit_bias).toEqual([
      { token: 20, bias: -0.2, opaque: 'first-position' },
      { token: 10, bias: -0.1, opaque: 'second-position' },
    ]);
  });

  it('changes one executable field while losslessly reconstructing nested passthrough, provider, and wrapper fields', async () => {
    const preview = await inspectPreset(bytes('text/wrapped-text.preset'), 'looks-like-anything.bin');
    const edited = {
      ...preview,
      settings: { ...preview.settings, temperature: 0.99 },
    };

    const first = await exportPreset(edited);
    const second = await exportPreset(edited);
    expect(first).toMatchObject({ contentType: 'application/json; charset=utf-8', fileName: 'Wrapped Synthetic Text.json' });
    expect(first.bytes).toEqual(second.bytes);

    const exported = JSON.parse(Buffer.from(first.bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      wrapper_unknown: { keep: 'at-root' },
      preset: {
        name: 'Wrapped Synthetic Text',
        temperature: 0.99,
        parameters: { vendor: { retained: true } },
      },
    });
    const reimported = await inspectPreset(first.bytes, first.fileName);
    expect(reimported).toMatchObject({ kind: 'text', settings: { temperature: 0.99 } });
    expect(reimported.unknownFields).toEqual(preview.unknownFields);
  });

  it('re-emits provider and vendor fields verbatim while changing only a Chat sampler setting', async () => {
    const preview = await inspectPreset(bytes('chat/synthetic-chat.settings'), 'opaque.bin');
    const exported = await exportPreset({
      ...preview,
      settings: { ...preview.settings, temperature: 0.55 },
    });
    const document = JSON.parse(Buffer.from(exported.bytes).toString('utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({
      temperature: 0.55,
      openrouter_model: 'synthetic/never-called',
      vendor_provider_payload: { nested: { retain: true } },
      top_unknown: { nested: ['preserve', { all: true }] },
      prompts: expect.arrayContaining([
        expect.objectContaining({ unknown_prompt_nested: { retain: [0, false, 'yes'] } }),
      ]),
    });
    const reimported = await inspectPreset(exported.bytes, 'renamed.bin');
    expect(reimported.unknownFields).toEqual(preview.unknownFields);
  });

  it('round-trips an edited Context story, formatting fields, stops, sampler values, and unknown data without using the filename', async () => {
    const preview = await inspectPreset(bytes('context/synthetic-context.json'), 'not-context.bin');
    const exported = await exportPreset({
      ...preview,
      settings: { ...preview.settings, story_string: 'Edited {{description}} only.' },
    });
    const reimported = await inspectPreset(exported.bytes, 'changed.extension');

    expect(reimported).toMatchObject({
      kind: 'context',
      settings: expect.objectContaining({
        story_string: 'Edited {{description}} only.',
        story_string_position: 1,
        use_stop_strings: true,
      }),
      unknownFields: { context_unknown: { retain: { empty: '' } } },
    });
  });

  it('writes direct NovelAI edits back into parameters without adding a wrong flat field', async () => {
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.41,
        top_p: 0.73,
        tail_free_sampling: 0.82,
        vendor_nested: { keep: ['all'] },
      },
      root_vendor: { keep: true },
    })), 'direct-novel.preset');
    const exported = await exportPreset({
      ...preview,
      settings: { ...preview.settings, temperature: 0.94 },
    });
    const document = JSON.parse(Buffer.from(exported.bytes).toString('utf8')) as Record<string, unknown>;

    expect(document).toMatchObject({
      presetVersion: 3,
      parameters: {
        temperature: 0.94,
        top_p: 0.73,
        tail_free_sampling: 0.82,
        vendor_nested: { keep: ['all'] },
      },
      root_vendor: { keep: true },
    });
    expect(document).not.toHaveProperty('temperature');
  });

  it('strips validated markers only at structured entries while preserving non-marker user fields', async () => {
    const { source } = await duplicateOrderFixture();
    const userValue = { user: true, purpose: 'not an internal marker' };
    const settings = {
      ...source.settings,
      prompts: [{
        identifier: 'user-owned',
        content: 'plain prompt',
        [sourceAssociationKey]: userValue,
      }],
    };

    const exported = JSON.parse(Buffer.from((await exportPreset({ ...source, settings })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported.prompts).toEqual([{
      identifier: 'user-owned',
      content: 'plain prompt',
      [sourceAssociationKey]: userValue,
    }]);

    const executable = presetSettingsForExecution(settings, source.compatibility, 'chat');
    expect(executable.prompts).toEqual([{
      identifier: 'user-owned',
      content: 'plain prompt',
      [sourceAssociationKey]: userValue,
    }]);
    const executableGroup = (executable.prompt_order as Array<Record<string, unknown>>)[0]!;
    expect(executableGroup).not.toHaveProperty(sourceAssociationKey);
    for (const entry of executableGroup.order as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty(sourceAssociationKey);
    }
  });

  it('does not overwrite a same-named non-marker field already present on an imported structured entry', async () => {
    const userValue = { user: true, purpose: 'source-owned data' };
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prompts: [{
        identifier: 'source-owned',
        content: 'plain prompt',
        [sourceAssociationKey]: userValue,
      }],
      prompt_order: [],
    })), 'source-owned-marker.settings');
    const normalizedPrompt = (preview.settings.prompts as Array<Record<string, unknown>>)[0]!;
    const persisted = persistPresetSourceAssociations({
      ...preview,
      settings: {
        ...preview.settings,
        prompts: [{ ...normalizedPrompt, [sourceAssociationKey]: userValue }],
      },
    });
    const compatibility = storedCompatibility(preview, persisted.associationEnvelope);
    const persistedPrompt = (persisted.settings.prompts as Array<Record<string, unknown>>)[0]!;

    expect(persistedPrompt[sourceAssociationKey]).toEqual(userValue);
    expect(presetSettingsForExecution(persisted.settings, compatibility, 'chat'))
      .toMatchObject({ prompts: [{ [sourceAssociationKey]: userValue }] });
    const exported = JSON.parse(Buffer.from((await exportPreset({
      name: preview.name,
      kind: 'chat',
      settings: persisted.settings,
      compatibility,
    })).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({ prompts: [{ [sourceAssociationKey]: userValue }] });
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'text' as const],
  ])('does not validate execution markers against a %s preset kind', async (_label, kind) => {
    const { source } = await duplicateOrderFixture();
    const sanitize = presetSettingsForExecution as (
      settings: Record<string, unknown>,
      compatibility: typeof source.compatibility,
      kind?: 'text',
    ) => Record<string, unknown>;

    const executable = sanitize(source.settings, source.compatibility, kind);
    const group = (executable.prompt_order as Array<Record<string, unknown>>)[0]!;

    expect(group).toHaveProperty(sourceAssociationKey);
    for (const entry of group.order as Array<Record<string, unknown>>) {
      expect(entry).toHaveProperty(sourceAssociationKey);
    }
  });

  it('preserves same-named user data in opaque descendants during export and execution', async () => {
    const userValue = { type: 'string', description: 'ordinary user schema data' };
    const preview = await inspectPreset(encoder.encode(JSON.stringify({
      prefix: '<think>',
      separator: '</think>',
      suffix: '<answer>',
      reasoning_config: {
        response_schema: {
          type: 'object',
          properties: { [sourceAssociationKey]: userValue },
          required: [sourceAssociationKey],
        },
      },
    })), 'reasoning-user-marker.settings');

    const exported = JSON.parse(Buffer.from((await exportPreset(preview)).bytes).toString('utf8')) as Record<string, unknown>;
    expect(exported).toMatchObject({
      reasoning_config: {
        response_schema: {
          properties: { [sourceAssociationKey]: userValue },
          required: [sourceAssociationKey],
        },
      },
    });
    expect(presetSettingsForExecution(preview.settings)).toMatchObject({
      reasoning_config: {
        response_schema: {
          properties: { [sourceAssociationKey]: userValue },
          required: [sourceAssociationKey],
        },
      },
    });
  });
});
