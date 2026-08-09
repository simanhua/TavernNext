import type {
  NormalizedWorldbook,
  NormalizedWorldbookEntry,
} from '@tavernnext/st-compat';
import type {
  WorldbookEvaluationInput,
  WorldbookRuntimeBook,
} from '../../src/worldbook/types.js';

export function worldbookEntry(
  sourceUid: string | number,
  overrides: Partial<NormalizedWorldbookEntry> = {},
): NormalizedWorldbookEntry {
  return {
    id: `entry-${String(sourceUid)}`,
    sourceUid,
    sourceOrdinal: 0,
    keys: [],
    secondaryKeys: [],
    useRegex: true,
    selective: false,
    selectiveLogic: 0,
    constant: false,
    vectorized: false,
    probability: 100,
    useProbability: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    priority: null,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    ignoreBudget: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    characterFilter: { isExclude: false, names: [], tags: [] },
    personaFilter: { isExclude: false, names: [], tags: [] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    comment: '',
    displayName: `Entry ${String(sourceUid)}`,
    content: `content:${String(sourceUid)}`,
    enabled: true,
    addMemo: false,
    displayIndex: null,
    outletName: '',
    automationId: '',
    triggers: [],
    extensions: {},
    unknownFields: {},
    ...overrides,
  };
}

export function runtimeBook(
  id: string,
  entries: NormalizedWorldbookEntry[],
  overrides: Partial<NormalizedWorldbook> = {},
): WorldbookRuntimeBook {
  return {
    id,
    book: {
      name: id,
      description: '',
      enabled: true,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning: false,
      extensions: {},
      unknownFields: {},
      entries: entries.map((entry, index) => entry.sourceOrdinal === 0 && index > 0
        ? { ...entry, sourceOrdinal: index }
        : entry),
      ...overrides,
    },
  };
}

export function evaluationInput(
  books: WorldbookRuntimeBook[],
  overrides: Partial<WorldbookEvaluationInput> = {},
): WorldbookEvaluationInput {
  return {
    seed: 1,
    messageIndex: 0,
    previousTimedState: { messageIndex: null, sticky: [], cooldown: [] },
    scanSources: {
      messages: [],
      additional: [],
      trigger: 'normal',
    },
    books,
    tokenBudget: 10_000,
    tokenizer: { countText: (text) => text.length },
    settings: {},
    ...overrides,
  };
}
