import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileChatPrompt } from '../src/index.js';
import { character, persona, preset, unitTokenizer } from './fixtures.js';

const golden = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/prompts/chat-golden.json', import.meta.url),
  'utf8',
)) as { expected: { messages: unknown[]; stop: string[] } };

function chatPreset() {
  return preset('chat', {
    prompts: [
      { identifier: 'main', role: 'system', content: 'MAIN {{char}}/{{user}}', system_prompt: true },
      { identifier: 'hidden', role: 'system', content: 'DO NOT SEND', system_prompt: true },
      { identifier: 'charDescription', marker: true, system_prompt: true },
      { identifier: 'personaDescription', marker: true, system_prompt: true },
      { identifier: 'charPersonality', marker: true, system_prompt: true },
      { identifier: 'scenario', marker: true, system_prompt: true },
      { identifier: 'userRule', role: 'user', content: 'User rule', generation_trigger: ['normal'] },
      { identifier: 'continueOnly', role: 'assistant', content: 'Continue only', generation_trigger: ['continue'] },
      { identifier: 'dialogueExamples', marker: true, system_prompt: true },
      { identifier: 'chatHistory', marker: true, system_prompt: true },
      { identifier: 'jailbreak', role: 'system', content: 'preset post-history', system_prompt: true },
    ],
    prompt_order: [
      { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
      {
        character_id: '018f0000-0000-7000-8000-000000000101',
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'hidden', enabled: false },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'charPersonality', enabled: true },
          { identifier: 'scenario', enabled: true },
          { identifier: 'userRule', enabled: true },
          { identifier: 'continueOnly', enabled: true },
          { identifier: 'dialogueExamples', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'jailbreak', enabled: true },
        ],
      },
    ],
    new_chat_prompt: '[Start a new Chat]',
    new_example_chat_prompt: '[Example Chat]',
    custom_url: 'SYSTEM LEAK',
  }, {
    compatibility: {
      sourceFormat: 'preset:json',
      rawPayload: { rawDocument: { custom_url: 'SYSTEM LEAK' }, associationEnvelope: { forged: true } },
      unknownFields: { provider_system_prompt: 'SYSTEM LEAK' },
      compatWarnings: ['provider_field_preserved_not_executable'],
      parserVersion: '1',
    },
  });
}

describe('Chat preset compiler', () => {
  it('matches the static ordered-role golden including markers, examples, history, post-history, and triggers', async () => {
    const calls: Array<{ kind: 'text' | 'messages'; value: unknown }> = [];
    const input = {
      character: character({
        examples: '<START>\nYou: Hello\nAster: Welcome',
        postHistoryInstructions: 'Stay kind.',
      }),
      persona: persona(),
      preset: chatPreset(),
      history: [
        { id: 'h1', role: 'user', content: 'Question' },
        { id: 'h2', role: 'assistant', content: 'Answer' },
      ],
      generationType: 'normal' as const,
      maxPromptTokens: 100,
      stop: ['END'],
      tokenizer: unitTokenizer(calls),
    };
    const before = JSON.stringify(input, (_key, value) => typeof value === 'function' ? '[function]' : value);

    const result = await compileChatPrompt(input);

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual(golden.expected.messages);
    expect(result.stop).toEqual(golden.expected.stop);
    expect(result.messages.some((message) => message.content.includes('SYSTEM LEAK'))).toBe(false);
    expect(result.tokenBreakdown.find((entry) => entry.source === 'prompt:hidden')).toMatchObject({
      includedTokens: 0, omittedTokens: 1, reason: 'disabled',
    });
    expect(result.tokenBreakdown.find((entry) => entry.source === 'prompt:continueOnly')).toMatchObject({
      includedTokens: 0, omittedTokens: 1, reason: 'trigger_mismatch',
    });
    expect(calls.filter((call) => call.kind === 'messages').length).toBeGreaterThanOrEqual(
      result.tokenBreakdown.filter((entry) => entry.includedTokens > 0 || entry.omittedTokens > 0).length,
    );
    expect(JSON.stringify(input, (_key, value) => typeof value === 'function' ? '[function]' : value)).toBe(before);
  });

  it('drops oldest history first at the exact token boundary', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 3,
      generationType: 'normal', stop: [],
      preset: preset('chat', {
        prompts: [
          { identifier: 'main', role: 'system', content: 'main', system_prompt: true },
          { identifier: 'chatHistory', marker: true, system_prompt: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
        ] }],
        new_chat_prompt: '',
      }),
      history: [
        { id: 'old', role: 'user', content: 'old' },
        { id: 'middle', role: 'assistant', content: 'middle' },
        { id: 'new', role: 'user', content: 'new' },
      ],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages.map((message) => message.content)).toEqual(['main', 'middle', 'new']);
    expect(result.tokenBreakdown.find((entry) => entry.source === 'history:old')).toMatchObject({
      omittedTokens: 1, reason: 'history_budget',
    });
  });

  it('does not re-include omitted history when message ids are duplicated', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 1,
      generationType: 'normal', stop: [],
      preset: preset('chat', {
        prompts: [{ identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
        new_chat_prompt: '',
      }),
      history: [
        { id: 'same', role: 'user', content: 'old' },
        { id: 'same', role: 'assistant', content: 'new' },
      ],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual([{ role: 'assistant', content: 'new' }]);
  });

  it('does not borrow another character order and lets order entries control enablement', async () => {
    const settings = {
      prompts: [{ identifier: 'main', role: 'system', content: 'main', enabled: false }],
      prompt_order: [{ character_id: 'other-character', order: [{ identifier: 'main', enabled: true }] }],
    };
    const unrelated = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10,
      preset: preset('chat', settings), history: [], generationType: 'normal', stop: [],
    });
    const selected = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10,
      preset: preset('chat', settings), promptOrderCharacterId: 'other-character',
      history: [], generationType: 'normal', stop: [],
    });

    expect(unrelated).toMatchObject({ kind: 'chat', messages: [] });
    expect(selected).toMatchObject({ kind: 'chat', messages: [{ role: 'system', content: 'main' }] });
  });

  it('does not expand disabled prompts and honors the official injection_trigger field', async () => {
    const disabled = await compileChatPrompt({
      character: character({ description: '{{description}}' }), persona: persona(),
      tokenizer: unitTokenizer(), maxPromptTokens: 10,
      preset: preset('chat', {
        prompts: [{ identifier: 'charDescription', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'charDescription', enabled: false }] }],
      }),
      history: [], generationType: 'normal', stop: [], macroLimits: { maxDepth: 2 },
    });
    const trigger = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10,
      preset: preset('chat', {
        prompts: [{ identifier: 'continue-only', role: 'system', content: 'continue', injection_trigger: ['continue'] }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'continue-only', enabled: true }] }],
      }),
      history: [], generationType: 'normal', stop: [],
    });

    expect(disabled).toMatchObject({
      kind: 'chat', messages: [],
      tokenBreakdown: [{ source: 'marker:charDescription', includedTokens: 0, reason: 'disabled' }],
    });
    expect(trigger).toMatchObject({
      kind: 'chat', messages: [],
      tokenBreakdown: [{ source: 'prompt:continue-only', includedTokens: 0, reason: 'trigger_mismatch' }],
    });
  });

  it('applies wi_format and overwrites duplicate order references at their first collection index', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 3,
      preset: preset('chat', {
        prompts: [
          { identifier: 'worldInfoBefore', marker: true },
          { identifier: 'repeat', role: 'user', content: 'repeat' },
          { identifier: 'worldInfoAfter', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'repeat', enabled: true },
          { identifier: 'repeat', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
        ] }],
        wi_format: '[WI]\n{0}\n[/WI]',
      }),
      worldInfoBefore: 'before', worldInfoAfter: 'after',
      history: [], generationType: 'normal', stop: [],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual([
      { role: 'system', content: '[WI]\nbefore\n[/WI]' },
      { role: 'user', content: 'repeat' },
      { role: 'system', content: '[WI]\nafter\n[/WI]' },
    ]);
    expect(result.tokenBreakdown.find((entry) => entry.reason === 'duplicate_order_reference')).toMatchObject({
      source: 'prompt:repeat', includedTokens: 0,
    });
  });

  it('applies solo DEFAULT, CONTENT, and COMPLETION name behavior to history', async () => {
    const base = {
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 10,
      history: [
        { id: 'user', role: 'user', name: 'You Name!', content: 'hello' },
        { id: 'assistant', role: 'assistant', name: 'Aster Name!', content: 'reply' },
      ],
      presetSettings: {
        prompts: [{ identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
        new_chat_prompt: '',
      },
    };
    const compile = (namesBehavior: number) => compileChatPrompt({
      character: base.character,
      persona: base.persona,
      tokenizer: base.tokenizer,
      maxPromptTokens: base.maxPromptTokens,
      history: base.history,
      preset: preset('chat', { ...base.presetSettings, names_behavior: namesBehavior }),
    });

    const defaultNames = await compile(0);
    const contentNames = await compile(2);
    const completionNames = await compile(1);

    if (defaultNames.kind !== 'chat') throw new Error(defaultNames.message);
    if (contentNames.kind !== 'chat') throw new Error(contentNames.message);
    if (completionNames.kind !== 'chat') throw new Error(completionNames.message);
    expect(defaultNames.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'reply' },
    ]);
    expect(contentNames.messages).toEqual([
      { role: 'user', content: 'You Name!: hello' },
      { role: 'assistant', content: 'Aster Name!: reply' },
    ]);
    expect(completionNames.messages).toEqual([
      { role: 'user', content: 'hello', name: 'You_Name_' },
      { role: 'assistant', content: 'reply', name: 'Aster_Name_' },
    ]);
  });

  it('squashes eligible system messages before exact counting while preserving the new-chat boundary', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), maxPromptTokens: 2, history: [],
      tokenizer: {
        countText: async (text) => text.length,
        countMessages: async (messages) => messages.length,
      },
      preset: preset('chat', {
        prompts: [
          { identifier: 'first', role: 'system', content: 'one' },
          { identifier: 'second', role: 'system', content: 'two' },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'first', enabled: true },
          { identifier: 'second', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ] }],
        new_chat_prompt: 'new chat',
        squash_system_messages: true,
      }),
    });

    expect(result).toMatchObject({
      kind: 'chat', totalTokens: 2,
      messages: [
        { role: 'system', content: 'one\ntwo' },
        { role: 'system', content: 'new chat' },
      ],
    });
  });

  it('injects absolute prompts into history by depth, descending order group, and role', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 30,
      generationType: 'normal', stop: [],
      preset: preset('chat', {
        prompts: [
          { identifier: 'before', role: 'system', content: 'before' },
          { identifier: 'deep-high', role: 'user', content: 'deep-high', injection_position: 1, injection_depth: 1, injection_order: 200 },
          { identifier: 'chatHistory', marker: true },
          { identifier: 'deep-low', role: 'user', content: 'deep-low', injection_position: 1, injection_depth: 1, injection_order: 100 },
          { identifier: 'latest-system', role: 'system', content: 'latest-system', injection_position: 1, injection_depth: 0, injection_order: 100 },
          { identifier: 'after', role: 'assistant', content: 'after' },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'before', enabled: true },
          { identifier: 'deep-high', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'deep-low', enabled: true },
          { identifier: 'latest-system', enabled: true },
          { identifier: 'after', enabled: true },
        ] }],
        new_chat_prompt: '',
      }),
      history: [
        { id: 'old', role: 'user', content: 'old' },
        { id: 'middle', role: 'assistant', content: 'middle' },
        { id: 'new', role: 'user', content: 'new' },
      ],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual([
      { role: 'system', content: 'before' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'middle' },
      { role: 'user', content: 'deep-low' },
      { role: 'user', content: 'deep-high' },
      { role: 'user', content: 'new' },
      { role: 'system', content: 'latest-system' },
      { role: 'assistant', content: 'after' },
    ]);
  });

  it('warns and omits duplicate identifiers, unsupported roles, and unsupported history roles', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), tokenizer: unitTokenizer(), maxPromptTokens: 20,
      generationType: 'normal', stop: [],
      preset: preset('chat', {
        prompts: [
          { identifier: 'dup', role: 'system', content: 'first' },
          { identifier: 'dup', role: 'system', content: 'second' },
          { identifier: 'tool', role: 'tool', content: 'bad' },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'dup', enabled: true }, { identifier: 'tool', enabled: true }, { identifier: 'chatHistory', enabled: true },
        ] }],
      }),
      history: [{ id: 'bad-history', role: 'tool', content: 'also bad' }],
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual([{ role: 'system', content: 'first' }]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'duplicate_prompt_identifier', 'unsupported_role', 'unsupported_role',
    ]);
  });

  it('returns typed invalid-budget, immutable-overflow, macro-limit, and tokenizer failures before output', async () => {
    const base = {
      character: character(), persona: persona(), preset: preset('chat', {
        prompts: [{ identifier: 'main', role: 'system', content: 'main' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
      }),
      history: [], generationType: 'normal' as const, stop: [], tokenizer: unitTokenizer(),
    };

    expect(await compileChatPrompt({ ...base, maxPromptTokens: -1 })).toMatchObject({ kind: 'error', target: 'chat', code: 'invalid_budget' });
    expect(await compileChatPrompt({ ...base, maxPromptTokens: 0 })).toMatchObject({ kind: 'error', target: 'chat', code: 'context_overflow' });
    expect(await compileChatPrompt({
      ...base,
      maxPromptTokens: 10,
      character: character({ description: '{{description}}' }),
      preset: preset('chat', {
        prompts: [{ identifier: 'charDescription', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'charDescription', enabled: true }] }],
      }),
      macroLimits: { maxDepth: 2 },
    })).toMatchObject({ kind: 'error', target: 'chat', code: 'macro_expansion_limit' });
    expect(await compileChatPrompt({
      ...base,
      maxPromptTokens: 10,
      tokenizer: { countText: async () => 0, countMessages: async () => { throw new Error('broken'); } },
    })).toMatchObject({ kind: 'error', target: 'chat', code: 'tokenizer_error' });
  });

  it('is byte-deterministic across repeated compilation', async () => {
    const input = {
      character: character(), persona: persona(), preset: chatPreset(), history: [],
      generationType: 'normal' as const, maxPromptTokens: 100, stop: ['END'], tokenizer: unitTokenizer(),
    };
    expect(JSON.stringify(await compileChatPrompt(input))).toBe(JSON.stringify(await compileChatPrompt(input)));
  });
});
