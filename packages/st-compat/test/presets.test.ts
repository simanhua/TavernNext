import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportPreset, inspectPreset } from '../src/index.js';

const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'presets');
const encoder = new TextEncoder();

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtureRoot, path)));
}

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
          unknown_prompt_nested: { retain: [0, false, 'yes'] },
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
      openrouter_model: 'synthetic/never-called',
      vendor_provider_payload: { nested: { retain: true } },
      top_unknown: { nested: ['preserve', { all: true }] },
    });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider_field_preserved_not_executable' }),
    ]));
    expect(preview.settings).not.toHaveProperty('openrouter_model');
    expect(preview.settings).not.toHaveProperty('vendor_provider_payload');
  });

  it('preserves Text sampler/tokenizer settings, Context story formatting, Instruct sequences/stops, System Prompt placement, and Reasoning extraction fields', async () => {
    const text = await inspectPreset(bytes('text/synthetic-text.json'), 'text.bin');
    const context = await inspectPreset(bytes('context/synthetic-context.json'), 'context.bin');
    const instruct = await inspectPreset(bytes('instruct/synthetic-instruct.json'), 'instruct.bin');
    const system = await inspectPreset(bytes('system/synthetic-system.json'), 'system.bin');
    const reasoning = await inspectPreset(bytes('reasoning/synthetic-reasoning.json'), 'reasoning.bin');

    expect(text.settings).toMatchObject({
      temperature: 0.61, top_p: 0.88, top_k: 42, rep_pen: 1.08,
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
    expect(system.settings).toEqual({ content: 'Write only synthetic notes.', post_history: true });
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
});

describe('lossless deterministic preset export', () => {
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
});
