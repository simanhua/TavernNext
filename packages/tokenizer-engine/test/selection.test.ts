import { describe, expect, it } from 'vitest';

import { TokenizerId, selectTokenizer } from '../src/index.js';

describe('tokenizer selection', () => {
  it.each([
    ['meta-llama/Llama-3.3-70B-Instruct', TokenizerId.LLAMA3],
    ['mistralai/Mixtral-8x7B-Instruct', TokenizerId.MISTRAL],
    ['google/gemma-2-9b-it', TokenizerId.GEMMA],
    ['mistralai/pixtral-12b', TokenizerId.NEMO],
    ['deepseek-ai/DeepSeek-V3', TokenizerId.DEEPSEEK],
    ['01-ai/Yi-34B-Chat', TokenizerId.YI],
    ['ai21labs/Jamba-1.5-Large', TokenizerId.JAMBA],
    ['CohereForAI/c4ai-command-r-plus', TokenizerId.COMMAND_R],
    ['CohereLabs/c4ai-command-a-03-2025', TokenizerId.COMMAND_A],
    ['Qwen/Qwen2.5-72B-Instruct', TokenizerId.QWEN2],
    ['meta-llama/Llama-2-70b-chat-hf', TokenizerId.LLAMA],
  ])('matches model family %s before the generic Llama fallback', (model, tokenizerId) => {
    expect(selectTokenizer({
      requestedId: TokenizerId.BEST_MATCH,
      api: 'textgenerationwebui',
      model,
    }).tokenizerId).toBe(tokenizerId);
  });

  it('honors an explicit local tokenizer choice', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.NERD2,
      api: 'textgenerationwebui',
      model: 'llama-3',
    })).toMatchObject({ requestedId: TokenizerId.NERD2, tokenizerId: TokenizerId.NERD2 });
  });

  it('dispatches OPENAI mode to a known local model family', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'vendor/llama-3.1-8b',
    })).toMatchObject({ requestedId: TokenizerId.OPENAI, tokenizerId: TokenizerId.LLAMA3 });
  });

  it('dispatches OPENAI mode to the bundled Claude tokenizer', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'anthropic/claude-3.7-sonnet',
    })).toMatchObject({ requestedId: TokenizerId.OPENAI, tokenizerId: TokenizerId.CLAUDE });
  });

  it('uses the baseline OpenAI tokenizer for an unknown model', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.OPENAI,
      api: 'openai',
      model: 'provider/model-not-in-the-registry',
    })).toMatchObject({
      tokenizerId: TokenizerId.OPENAI,
      tiktokenModel: 'gpt-3.5-turbo',
    });
  });

  it('uses a remote tokenizer only when an explicit endpoint is configured', () => {
    const endpoint = 'http://127.0.0.1:5001/tokenize';
    expect(selectTokenizer({
      requestedId: TokenizerId.API_TEXTGENERATIONWEBUI,
      api: 'textgenerationwebui',
      model: 'llama-3.1',
      remoteEndpoint: endpoint,
    })).toMatchObject({
      requestedId: TokenizerId.API_TEXTGENERATIONWEBUI,
      tokenizerId: TokenizerId.API_TEXTGENERATIONWEBUI,
      remoteEndpoint: endpoint,
    });
  });

  it('warns and selects the matching local family when a requested remote endpoint is absent', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.API_KOBOLD,
      api: 'kobold',
      model: 'llama-3.1',
    })).toMatchObject({
      requestedId: TokenizerId.API_KOBOLD,
      tokenizerId: TokenizerId.LLAMA3,
      fallbackFrom: TokenizerId.API_KOBOLD,
      warning: expect.stringContaining('explicit tokenizer endpoint'),
    });
  });

  it('resolves API_CURRENT to the current API remote mode', () => {
    const endpoint = 'http://127.0.0.1:5001/extra/tokencount';
    expect(selectTokenizer({
      requestedId: TokenizerId.API_CURRENT,
      api: 'kobold',
      model: 'llama-2',
      remoteEndpoint: endpoint,
    })).toMatchObject({
      requestedId: TokenizerId.API_CURRENT,
      tokenizerId: TokenizerId.API_KOBOLD,
      remoteEndpoint: endpoint,
    });
  });

  it('warns and uses Llama 3 when a downloadable web model is known unavailable', () => {
    expect(selectTokenizer({
      requestedId: TokenizerId.QWEN2,
      model: 'qwen2.5',
      unavailableTokenizerIds: [TokenizerId.QWEN2],
    })).toMatchObject({
      requestedId: TokenizerId.QWEN2,
      tokenizerId: TokenizerId.LLAMA3,
      fallbackFrom: TokenizerId.QWEN2,
      warning: expect.stringContaining('Llama 3'),
    });
  });
});
