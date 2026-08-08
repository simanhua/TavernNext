import { describe, expect, it } from 'vitest';

import { TOKENIZER_MODEL_MANIFEST, TOKENIZER_REGISTRY, TokenizerId } from '../src/index.js';

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

  it.each([
    [TokenizerId.LLAMA, 'llama.model', '9e556afd44213b6bd1be2b850ebbbd98f5481437a8021afaf58ee7fb1818d347'],
    [TokenizerId.NERD, 'nerdstash.model', '578fa0ed4d6dbee435f21d7f7a741506d09cdd93cce241008abf725407cbdb41'],
    [TokenizerId.NERD2, 'nerdstash_v2.model', '005ad680b10f1abd406bdb0ca9c6a5d83fc1f6e0a855bdd1942c1ceab1fb47ab'],
    [TokenizerId.MISTRAL, 'mistral.model', 'dadfd56d766715c61d2ef780a525ab43b8e6da4de6865bda3d95fdef5e134055'],
    [TokenizerId.YI, 'yi.model', '386c49cf943d71aa110361135338c50e38beeff0a66593480421f37b319e1a39'],
    [TokenizerId.CLAUDE, 'claude.json', 'c241737df24b4e7f7c9af4fdcee29a0ca903dcb288a8b753bc346a3092911767'],
    [TokenizerId.LLAMA3, 'llama3.json', '126f3c57d297e9a5a18427338812d9fed68f132c612b3c42e361ce3157beb729'],
    [TokenizerId.GEMMA, 'gemma.model', '61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2'],
    [TokenizerId.JAMBA, 'jamba.model', '8b0df4fb43262c452ef37061951a06df4c63ca191d02a60ea08f14428af24376'],
  ])('publishes redistribution provenance for bundled tokenizer %s', (tokenizerId, fileName, sha256) => {
    expect(TOKENIZER_MODEL_MANIFEST[tokenizerId]).toMatchObject({
      fileName,
      sha256,
      provenance: {
        sourceRepository: 'https://github.com/SillyTavern/SillyTavern',
        sourcePath: `src/tokenizers/${fileName}`,
        version: '1.18.0',
        commit: '51ad27fb86d39a3daca3adaa970375c9670c12df',
        sha256,
        licenseIdentifier: 'AGPL-3.0',
        licenseUrl: 'https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/LICENSE',
        noticeFile: 'THIRD_PARTY_NOTICES.md',
      },
    });
  });
});
