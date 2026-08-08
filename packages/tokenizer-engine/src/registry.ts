import { TOKENIZER_IDS, TokenizerId } from './ids.js';

export type TokenizerKind = 'estimate' | 'tiktoken' | 'sentencepiece' | 'web-tokenizer' | 'remote' | 'selector';

export interface TokenizerRegistryEntry {
  readonly id: TokenizerId;
  readonly key: keyof typeof TokenizerId;
  readonly name: string;
  readonly kind: TokenizerKind;
  readonly canEncode: boolean;
  readonly canDecode: boolean;
}

const entries: Record<number, Omit<TokenizerRegistryEntry, 'id'>> = {
  [TokenizerId.NONE]: { key: 'NONE', name: 'None / Estimated', kind: 'estimate', canEncode: false, canDecode: false },
  [TokenizerId.GPT2]: { key: 'GPT2', name: 'GPT-2', kind: 'tiktoken', canEncode: true, canDecode: true },
  [TokenizerId.OPENAI]: { key: 'OPENAI', name: 'OpenAI model', kind: 'tiktoken', canEncode: true, canDecode: true },
  [TokenizerId.LLAMA]: { key: 'LLAMA', name: 'Llama 1/2', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.NERD]: { key: 'NERD', name: 'NerdStash', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.NERD2]: { key: 'NERD2', name: 'NerdStash v2', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.API_CURRENT]: { key: 'API_CURRENT', name: 'Current API', kind: 'remote', canEncode: true, canDecode: false },
  [TokenizerId.MISTRAL]: { key: 'MISTRAL', name: 'Mistral V1', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.YI]: { key: 'YI', name: 'Yi', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.API_TEXTGENERATIONWEBUI]: { key: 'API_TEXTGENERATIONWEBUI', name: 'Text-generation API', kind: 'remote', canEncode: true, canDecode: false },
  [TokenizerId.API_KOBOLD]: { key: 'API_KOBOLD', name: 'Kobold API', kind: 'remote', canEncode: true, canDecode: false },
  [TokenizerId.CLAUDE]: { key: 'CLAUDE', name: 'Claude 1/2', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.LLAMA3]: { key: 'LLAMA3', name: 'Llama 3', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.GEMMA]: { key: 'GEMMA', name: 'Gemma / Gemini', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.JAMBA]: { key: 'JAMBA', name: 'Jamba', kind: 'sentencepiece', canEncode: true, canDecode: true },
  [TokenizerId.QWEN2]: { key: 'QWEN2', name: 'Qwen2', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.COMMAND_R]: { key: 'COMMAND_R', name: 'Command R', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.NEMO]: { key: 'NEMO', name: 'Mistral Nemo', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.DEEPSEEK]: { key: 'DEEPSEEK', name: 'DeepSeek', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.COMMAND_A]: { key: 'COMMAND_A', name: 'Command A', kind: 'web-tokenizer', canEncode: true, canDecode: true },
  [TokenizerId.BEST_MATCH]: { key: 'BEST_MATCH', name: 'Best match', kind: 'selector', canEncode: false, canDecode: false },
};

export const TOKENIZER_REGISTRY: readonly TokenizerRegistryEntry[] = TOKENIZER_IDS.map((id) => ({
  id,
  ...entries[id],
}));

export function getTokenizerRegistryEntry(id: TokenizerId): TokenizerRegistryEntry {
  const entry = TOKENIZER_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new RangeError(`Unknown tokenizer ID: ${id}`);
  }
  return entry;
}
