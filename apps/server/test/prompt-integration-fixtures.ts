import { TokenizerId, type TokenizerDecision, type TokenizerSelectionInput } from '@tavernnext/tokenizer-engine';

export interface TestTokenizerRuntime {
  selectTokenizer(input: TokenizerSelectionInput): TokenizerDecision;
  countText(text: string, decision: TokenizerDecision): Promise<number>;
  countMessages(messages: readonly { role: string; content: string; name?: string }[], decision: TokenizerDecision): Promise<number>;
}

export function unitTokenizerRuntime(overrides: Partial<TestTokenizerRuntime> = {}): TestTokenizerRuntime {
  return {
    selectTokenizer(input) {
      const selected = input.requestedId === TokenizerId.BEST_MATCH ? TokenizerId.NONE : input.requestedId;
      return {
        requestedId: input.requestedId,
        tokenizerId: selected,
        tokenizerName: selected === TokenizerId.NONE ? 'None / Estimated' : `Test ${selected}`,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.api === undefined ? {} : { api: input.api }),
      };
    },
    countText: async (text) => text.length,
    countMessages: async (messages) => messages.reduce((total, message) => total + message.content.length + 1, 0),
    ...overrides,
  };
}
