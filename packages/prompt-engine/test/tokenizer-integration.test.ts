import {
  TokenizerId,
  countMessages,
  countText,
  selectTokenizer,
} from '@tavernnext/tokenizer-engine';
import { describe, expect, it } from 'vitest';
import {
  allocateGroupedPromptBudget,
  compileChatPrompt,
  type PromptTokenizer,
} from '../src/index.js';
import { character, persona, preset } from './fixtures.js';

describe('Task 6 tokenizer integration', () => {
  it('budgets Chat blocks by the exact final message framing count', async () => {
    const decision = selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'gpt-3.5-turbo',
    });
    const tokenizer: PromptTokenizer = {
      countText: (text) => countText(text, decision),
      countMessages: (messages) => countMessages(messages, decision),
    };
    const input = {
      character: character(),
      persona: persona(),
      tokenizer,
      preset: preset('chat', {
        prompts: [
          { identifier: 'system', role: 'system', content: 'You are terse.' },
          { identifier: 'user', role: 'user', content: 'Hello' },
        ],
        prompt_order: [{ character_id: 100001, order: [
          { identifier: 'system', enabled: true },
          { identifier: 'user', enabled: true },
        ] }],
      }),
      history: [],
      generationType: 'normal' as const,
      stop: [],
    };

    const exact = await compileChatPrompt({ ...input, maxPromptTokens: 16 });
    const overflow = await compileChatPrompt({ ...input, maxPromptTokens: 15 });

    expect(exact.kind).toBe('chat');
    if (exact.kind !== 'chat') throw new Error(exact.message);
    expect(await countMessages(exact.messages, decision)).toBe(16);
    expect(exact.totalTokens).toBe(16);
    expect(exact.tokenBreakdown.reduce((sum, entry) => sum + entry.includedTokens, 0)).toBe(16);
    expect(overflow).toMatchObject({ kind: 'error', target: 'chat', code: 'context_overflow' });
  });

  it('counts OpenAI empty-request framing and reports a disabled message by marginal cost', async () => {
    const decision = selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'gpt-3.5-turbo',
    });
    const tokenizer: PromptTokenizer = {
      countText: (text) => countText(text, decision),
      countMessages: (messages) => countMessages(messages, decision),
    };
    const input = {
      character: character(), persona: persona(), tokenizer, history: [], stop: [],
      preset: preset('chat', {
        prompts: [{ identifier: 'disabled', role: 'user', content: 'Hello' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'disabled', enabled: false }] }],
      }),
    };

    const exact = await compileChatPrompt({ ...input, maxPromptTokens: 3 });
    const overflow = await compileChatPrompt({ ...input, maxPromptTokens: 2 });

    expect(exact).toMatchObject({
      kind: 'chat', messages: [], totalTokens: 3,
      tokenBreakdown: [
        { source: 'tokenizer:request-framing', includedTokens: 3, omittedTokens: 0 },
        { source: 'prompt:disabled', includedTokens: 0, omittedTokens: 5, reason: 'disabled' },
      ],
    });
    expect(overflow).toMatchObject({ kind: 'error', target: 'chat', code: 'context_overflow' });
  });

  it('rescues an over-budget immutable GPT2 prefix with a merging history block', async () => {
    const decision = selectTokenizer({ requestedId: TokenizerId.GPT2 });
    expect(await countText('cg', decision)).toBe(2);
    expect(await countText('i', decision)).toBe(1);
    expect(await countText('cgi', decision)).toBe(1);

    const result = await allocateGroupedPromptBudget({
      maxTokens: 1,
      blocks: [
        { source: 'immutable:story', policy: 'immutable' as const, value: 'cg' },
        { source: 'history:newest', policy: 'history' as const, value: 'i' },
      ],
      countSelection: (selected) => countText(selected.map((block) => block.value).join(''), decision),
    });

    expect(result).toMatchObject({
      ok: true,
      includedBlockIndexes: [0, 1],
      includedSources: ['immutable:story', 'history:newest'],
      totalTokens: 1,
    });
    expect(result.tokenBreakdown).toEqual([
      { source: 'immutable:story', includedTokens: 1, omittedTokens: 0 },
      { source: 'history:newest', includedTokens: 0, omittedTokens: 0 },
    ]);
    expect(result.tokenBreakdown.reduce((sum, entry) => sum + entry.includedTokens, 0)).toBe(1);
  });
});
