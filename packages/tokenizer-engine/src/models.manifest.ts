import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

import { TokenizerId } from './ids.js';
import type { TokenizerModelManifestEntry } from './model-cache.js';

function bundled(fileName: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageDirectory = basename(dirname(moduleDirectory)) === 'dist'
    ? resolve(moduleDirectory, '..', '..')
    : resolve(moduleDirectory, '..');
  return resolve(packageDirectory, 'models', fileName);
}

export const TOKENIZER_MODEL_MANIFEST: Readonly<Partial<Record<TokenizerId, TokenizerModelManifestEntry>>> = {
  [TokenizerId.LLAMA]: {
    tokenizerId: TokenizerId.LLAMA,
    fileName: 'llama.model',
    format: 'sentencepiece',
    sha256: '9e556afd44213b6bd1be2b850ebbbd98f5481437a8021afaf58ee7fb1818d347',
    bundledPath: bundled('llama.model'),
  },
  [TokenizerId.NERD]: {
    tokenizerId: TokenizerId.NERD,
    fileName: 'nerdstash.model',
    format: 'sentencepiece',
    sha256: '578fa0ed4d6dbee435f21d7f7a741506d09cdd93cce241008abf725407cbdb41',
    bundledPath: bundled('nerdstash.model'),
  },
  [TokenizerId.NERD2]: {
    tokenizerId: TokenizerId.NERD2,
    fileName: 'nerdstash_v2.model',
    format: 'sentencepiece',
    sha256: '005ad680b10f1abd406bdb0ca9c6a5d83fc1f6e0a855bdd1942c1ceab1fb47ab',
    bundledPath: bundled('nerdstash_v2.model'),
  },
  [TokenizerId.MISTRAL]: {
    tokenizerId: TokenizerId.MISTRAL,
    fileName: 'mistral.model',
    format: 'sentencepiece',
    sha256: 'dadfd56d766715c61d2ef780a525ab43b8e6da4de6865bda3d95fdef5e134055',
    bundledPath: bundled('mistral.model'),
  },
  [TokenizerId.YI]: {
    tokenizerId: TokenizerId.YI,
    fileName: 'yi.model',
    format: 'sentencepiece',
    sha256: '386c49cf943d71aa110361135338c50e38beeff0a66593480421f37b319e1a39',
    bundledPath: bundled('yi.model'),
  },
  [TokenizerId.CLAUDE]: {
    tokenizerId: TokenizerId.CLAUDE,
    fileName: 'claude.json',
    format: 'web-tokenizer',
    sha256: 'c241737df24b4e7f7c9af4fdcee29a0ca903dcb288a8b753bc346a3092911767',
    bundledPath: bundled('claude.json'),
  },
  [TokenizerId.LLAMA3]: {
    tokenizerId: TokenizerId.LLAMA3,
    fileName: 'llama3.json',
    format: 'web-tokenizer',
    sha256: '126f3c57d297e9a5a18427338812d9fed68f132c612b3c42e361ce3157beb729',
    bundledPath: bundled('llama3.json'),
  },
  [TokenizerId.GEMMA]: {
    tokenizerId: TokenizerId.GEMMA,
    fileName: 'gemma.model',
    format: 'sentencepiece',
    sha256: '61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2',
    bundledPath: bundled('gemma.model'),
  },
  [TokenizerId.JAMBA]: {
    tokenizerId: TokenizerId.JAMBA,
    fileName: 'jamba.model',
    format: 'sentencepiece',
    sha256: '8b0df4fb43262c452ef37061951a06df4c63ca191d02a60ea08f14428af24376',
    bundledPath: bundled('jamba.model'),
  },
  [TokenizerId.QWEN2]: {
    tokenizerId: TokenizerId.QWEN2,
    fileName: 'qwen2.json',
    format: 'web-tokenizer',
    url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz',
    compression: 'gzip',
    fallbackTokenizerId: TokenizerId.LLAMA3,
  },
  [TokenizerId.COMMAND_R]: {
    tokenizerId: TokenizerId.COMMAND_R,
    fileName: 'command-r.json',
    format: 'web-tokenizer',
    url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz',
    compression: 'gzip',
    fallbackTokenizerId: TokenizerId.LLAMA3,
  },
  [TokenizerId.NEMO]: {
    tokenizerId: TokenizerId.NEMO,
    fileName: 'nemo.json',
    format: 'web-tokenizer',
    url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/nemo.json.gz',
    compression: 'gzip',
    fallbackTokenizerId: TokenizerId.LLAMA3,
  },
  [TokenizerId.DEEPSEEK]: {
    tokenizerId: TokenizerId.DEEPSEEK,
    fileName: 'deepseek.json',
    format: 'web-tokenizer',
    url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/deepseek.json.gz',
    compression: 'gzip',
    fallbackTokenizerId: TokenizerId.LLAMA3,
  },
  [TokenizerId.COMMAND_A]: {
    tokenizerId: TokenizerId.COMMAND_A,
    fileName: 'command-a.json',
    format: 'web-tokenizer',
    url: 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz',
    compression: 'gzip',
    fallbackTokenizerId: TokenizerId.LLAMA3,
  },
};

export function getTokenizerModelManifestEntry(id: TokenizerId): TokenizerModelManifestEntry | undefined {
  return TOKENIZER_MODEL_MANIFEST[id];
}
