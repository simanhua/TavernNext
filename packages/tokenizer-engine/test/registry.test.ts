import { describe, expect, it } from 'vitest';

import { TOKENIZER_REGISTRY, TokenizerId } from '../src/index.js';

describe('SillyTavern tokenizer registry', () => {
  it('preserves every public tokenizer numeric ID', () => {
    expect({
      NONE: TokenizerId.NONE,
      GPT2: TokenizerId.GPT2,
      OPENAI: TokenizerId.OPENAI,
      LLAMA: TokenizerId.LLAMA,
      NERD: TokenizerId.NERD,
      NERD2: TokenizerId.NERD2,
      API_CURRENT: TokenizerId.API_CURRENT,
      MISTRAL: TokenizerId.MISTRAL,
      YI: TokenizerId.YI,
      API_TEXTGENERATIONWEBUI: TokenizerId.API_TEXTGENERATIONWEBUI,
      API_KOBOLD: TokenizerId.API_KOBOLD,
      CLAUDE: TokenizerId.CLAUDE,
      LLAMA3: TokenizerId.LLAMA3,
      GEMMA: TokenizerId.GEMMA,
      JAMBA: TokenizerId.JAMBA,
      QWEN2: TokenizerId.QWEN2,
      COMMAND_R: TokenizerId.COMMAND_R,
      NEMO: TokenizerId.NEMO,
      DEEPSEEK: TokenizerId.DEEPSEEK,
      COMMAND_A: TokenizerId.COMMAND_A,
      BEST_MATCH: TokenizerId.BEST_MATCH,
    }).toEqual({
      NONE: 0,
      GPT2: 1,
      OPENAI: 2,
      LLAMA: 3,
      NERD: 4,
      NERD2: 5,
      API_CURRENT: 6,
      MISTRAL: 7,
      YI: 8,
      API_TEXTGENERATIONWEBUI: 9,
      API_KOBOLD: 10,
      CLAUDE: 11,
      LLAMA3: 12,
      GEMMA: 13,
      JAMBA: 14,
      QWEN2: 15,
      COMMAND_R: 16,
      NEMO: 17,
      DEEPSEEK: 18,
      COMMAND_A: 19,
      BEST_MATCH: 99,
    });
  });

  it('exposes one registry entry for every numeric ID and no extras', () => {
    expect(TOKENIZER_REGISTRY.map(({ id }) => id)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 99,
    ]);
    expect(new Set(TOKENIZER_REGISTRY.map(({ key }) => key)).size).toBe(21);
  });

  it('marks estimation and remote modes as unable to decode local token IDs', () => {
    const byId = new Map(TOKENIZER_REGISTRY.map((entry) => [entry.id, entry]));

    expect(byId.get(TokenizerId.NONE)).toMatchObject({ kind: 'estimate', canEncode: false, canDecode: false });
    expect(byId.get(TokenizerId.API_CURRENT)).toMatchObject({ kind: 'remote', canDecode: false });
    expect(byId.get(TokenizerId.API_TEXTGENERATIONWEBUI)).toMatchObject({ kind: 'remote', canDecode: false });
    expect(byId.get(TokenizerId.API_KOBOLD)).toMatchObject({ kind: 'remote', canDecode: false });
  });
});
