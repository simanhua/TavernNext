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

  it('places every Worldbook target without collapsing examples, author note, depth roles, or outlets', async () => {
    const result = await compileChatPrompt({
      character: character({ examples: '<START>\nYou: CARD-EXAMPLE\nAster: CARD-ANSWER' }),
      persona: persona(), preset: chatPreset(), maxPromptTokens: 1_000, tokenizer: unitTokenizer(),
      history: [
        { id: 'old', role: 'user', content: 'OLD' },
        { id: 'new', role: 'assistant', content: 'NEW' },
      ],
      worldInfoPlacements: {
        beforeCharacter: 'WI-BEFORE',
        afterCharacter: 'WI-AFTER',
        // SillyTavern world-info.js has already unshifted these collections. The
        // downstream example insertion performs the second unshift for EMTop.
        examplesBefore: [
          { source: 'wi:em-top-second', content: '<START>\nYou: EM-TOP-SECOND\nAster: EM-TOP-SECOND-A' },
          { source: 'wi:em-top-first', content: '<START>\nYou: EM-TOP-FIRST\nAster: EM-TOP-FIRST-A' },
        ],
        examplesAfter: [
          { source: 'wi:em-bottom-second', content: '<START>\nYou: EM-BOTTOM-SECOND\nAster: EM-BOTTOM-SECOND-A' },
          { source: 'wi:em-bottom-first', content: '<START>\nYou: EM-BOTTOM-FIRST\nAster: EM-BOTTOM-FIRST-A' },
        ],
        authorNote: {
          before: [
            { source: 'wi:an-top-second', content: 'AN-TOP-SECOND' },
            { source: 'wi:an-top-first', content: 'AN-TOP-FIRST' },
          ],
          content: 'CONFIGURED-AUTHOR-NOTE',
          after: [
            { source: 'wi:an-bottom-second', content: 'AN-BOTTOM-SECOND' },
            { source: 'wi:an-bottom-first', content: 'AN-BOTTOM-FIRST' },
          ],
          position: 1,
          depth: 2,
          role: 'user',
        },
        atDepth: [
          { source: 'wi:depth-system-second', content: 'DEPTH-SYSTEM-SECOND', depth: 1, role: 'system' },
          { source: 'wi:depth-system-first', content: 'DEPTH-SYSTEM-FIRST', depth: 1, role: 'system' },
          { source: 'wi:depth-user', content: 'DEPTH-USER', depth: 1, role: 'user' },
          { source: 'wi:depth-assistant', content: 'DEPTH-ASSISTANT', depth: 1, role: 'assistant' },
        ],
        outlets: { sidebar: [{ source: 'wi:outlet', content: 'OUTLET-ONLY' }] },
      },
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    const contents = result.messages.map((message) => message.content);
    expect(contents.indexOf('WI-BEFORE')).toBeGreaterThan(-1);
    expect(contents.indexOf('WI-AFTER')).toBeGreaterThan(-1);
    expect(contents.indexOf('EM-TOP-FIRST')).toBeLessThan(contents.indexOf('EM-TOP-SECOND'));
    expect(contents.indexOf('EM-TOP-SECOND')).toBeLessThan(contents.indexOf('CARD-EXAMPLE'));
    expect(contents.indexOf('CARD-EXAMPLE')).toBeLessThan(contents.indexOf('EM-BOTTOM-SECOND'));
    expect(contents.indexOf('EM-BOTTOM-SECOND')).toBeLessThan(contents.indexOf('EM-BOTTOM-FIRST'));
    expect(result.messages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'AN-TOP-SECOND\nAN-TOP-FIRST\nCONFIGURED-AUTHOR-NOTE\nAN-BOTTOM-SECOND\nAN-BOTTOM-FIRST' },
      { role: 'system', content: 'DEPTH-SYSTEM-SECOND\nDEPTH-SYSTEM-FIRST' },
      { role: 'user', content: 'DEPTH-USER' },
      { role: 'assistant', content: 'DEPTH-ASSISTANT' },
    ]));
    expect(contents.indexOf('DEPTH-SYSTEM-SECOND\nDEPTH-SYSTEM-FIRST')).toBeGreaterThan(contents.indexOf('OLD'));
    expect(contents.indexOf('DEPTH-SYSTEM-SECOND\nDEPTH-SYSTEM-FIRST')).toBeLessThan(contents.indexOf('NEW'));
    expect(JSON.stringify(result.messages)).not.toContain('OUTLET-ONLY');
    expect(result.worldInfoOutlets).toEqual({ sidebar: 'OUTLET-ONLY' });
  });

  it.each([
    [2, 'assistant', 'before'],
    [0, 'user', 'after'],
  ] as const)('places configured relative Author Note position %s exactly %s main', async (position, role, side) => {
    const result = await compileChatPrompt({
      character: character({ description: '', personality: '', scenario: '' }),
      persona: persona({ description: '' }), preset: chatPreset(), maxPromptTokens: 1_000,
      tokenizer: unitTokenizer(), history: [],
      worldInfoPlacements: {
        beforeCharacter: '', afterCharacter: '', examplesBefore: [], examplesAfter: [], atDepth: [], outlets: {},
        authorNote: {
          before: [{ source: 'wi:an-top', content: 'AN-TOP' }],
          content: 'ACTUAL-NOTE',
          after: [{ source: 'wi:an-bottom', content: 'AN-BOTTOM' }],
          position, depth: 37, role,
        },
      },
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    const mainIndex = result.messages.findIndex(({ content }) => content === 'MAIN Aster/You');
    const noteIndex = result.messages.findIndex(({ content }) => content === 'AN-TOP\nACTUAL-NOTE\nAN-BOTTOM');
    expect(result.messages[noteIndex]).toEqual({ role, content: 'AN-TOP\nACTUAL-NOTE\nAN-BOTTOM' });
    expect(side === 'before' ? noteIndex : mainIndex).toBeLessThan(side === 'before' ? mainIndex : noteIndex);
  });

  it('applies the selected authorsNote absolute position, depth, order, and role overrides', async () => {
    const result = await compileChatPrompt({
      character: character({ description: '', personality: '', scenario: '' }),
      persona: persona({ description: '' }), maxPromptTokens: 1_000, tokenizer: unitTokenizer(),
      preset: preset('chat', {
        prompts: [
          { identifier: 'main', role: 'system', content: 'MAIN' },
          { identifier: 'authorsNote', role: 'assistant', content: 'PRESET-CONTENT-IS-REPLACED', injection_position: 1, injection_depth: 0, injection_order: 250 },
          { identifier: 'low', role: 'assistant', content: 'LOW-ORDER', injection_position: 1, injection_depth: 0, injection_order: 100 },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'main', enabled: true },
          { identifier: 'low', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ] }],
        new_chat_prompt: '',
      }),
      history: [
        { id: 'old', role: 'user', content: 'OLD' },
        { id: 'new', role: 'assistant', content: 'NEW' },
      ],
      worldInfoPlacements: {
        beforeCharacter: '', afterCharacter: '', examplesBefore: [], examplesAfter: [], atDepth: [], outlets: {},
        authorNote: {
          before: [{ source: 'wi:an-top', content: 'AN-TOP' }], content: 'ACTUAL-NOTE', after: [],
          position: 0, depth: 37, role: 'user',
        },
      },
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages.slice(-4)).toEqual([
      { role: 'user', content: 'OLD' },
      { role: 'assistant', content: 'NEW' },
      { role: 'assistant', content: 'LOW-ORDER' },
      { role: 'assistant', content: 'AN-TOP\nACTUAL-NOTE' },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain('PRESET-CONTENT-IS-REPLACED');
  });

  it('maps a relative Author Note beside an absolute main prompt in the same absolute bucket', async () => {
    const result = await compileChatPrompt({
      character: character({ description: '', personality: '', scenario: '' }),
      persona: persona({ description: '' }), maxPromptTokens: 1_000, tokenizer: unitTokenizer(),
      preset: preset('chat', {
        prompts: [
          { identifier: 'main', role: 'assistant', content: 'ABSOLUTE-MAIN', injection_position: 1, injection_depth: 1, injection_order: 300 },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ] }],
        new_chat_prompt: '',
      }),
      history: [
        { id: 'old', role: 'user', content: 'OLD' },
        { id: 'new', role: 'assistant', content: 'NEW' },
      ],
      worldInfoPlacements: {
        beforeCharacter: '', afterCharacter: '', examplesBefore: [], examplesAfter: [], atDepth: [], outlets: {},
        authorNote: {
          before: [{ source: 'wi:an-top', content: 'AN-TOP' }], content: 'ACTUAL-NOTE', after: [],
          position: 2, depth: 37, role: 'user',
        },
      },
    });

    expect(result.kind).toBe('chat');
    if (result.kind !== 'chat') throw new Error(result.message);
    expect(result.messages).toEqual([
      { role: 'user', content: 'OLD' },
      { role: 'assistant', content: 'AN-TOP\nACTUAL-NOTE\nABSOLUTE-MAIN' },
      { role: 'assistant', content: 'NEW' },
    ]);
  });

  it('fails closed when an activated Worldbook example has no executable dialogue-example target', async () => {
    const result = await compileChatPrompt({
      character: character(), persona: persona(), maxPromptTokens: 100, tokenizer: unitTokenizer(), history: [],
      preset: preset('chat', {
        prompts: [{ identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }],
      }),
      worldInfoPlacements: {
        beforeCharacter: '', afterCharacter: '',
        examplesBefore: [{ source: 'wi:missing-target', content: '<START>\nYou: hidden' }],
        examplesAfter: [], atDepth: [], outlets: {},
        authorNote: { before: [], content: '', after: [], position: 1, depth: 4, role: 'system' },
      },
    });

    expect(result).toMatchObject({ kind: 'error', target: 'chat', code: 'unsupported_worldbook_placement' });
  });
});
