import type {
  NormalizedWorldbook,
  NormalizedWorldbookEntry,
  SourceUid,
} from '@tavernnext/st-compat';

/** Hard API bounds. Oversized evaluations fail closed before regex or tokenizer work. */
export const MAX_WORLDBOOK_RUNTIME_BOOKS = 64;
export const MAX_WORLDBOOK_RUNTIME_ENTRIES = 4_096;
export const MAX_WORLDBOOK_MESSAGES = 2_048;
export const MAX_WORLDBOOK_ADDITIONAL_SOURCES = 128;
export const MAX_WORLDBOOK_SCAN_CHARACTERS = 2 * 1024 * 1024;
export const MAX_WORLDBOOK_KEYS_PER_ENTRY = 256;
export const MAX_WORLDBOOK_TOTAL_KEYS = 65_536;
export const MAX_WORLDBOOK_KEY_CHARACTERS = 4_096;
export const MAX_WORLDBOOK_REGEX_CHARACTERS = 1_024;
export const MAX_WORLDBOOK_REGEX_PROGRAM_SIZE = 8_192;
export const MAX_WORLDBOOK_IDENTITY_CHARACTERS = 4_096;
export const MAX_WORLDBOOK_CONTENT_CHARACTERS = 1024 * 1024;
export const MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS = 8 * 1024 * 1024;
export const MAX_WORLDBOOK_MATCH_OPERATIONS = 100_000;
export const MAX_WORLDBOOK_RECURSION_STEPS = 64;
export const MAX_WORLDBOOK_TIMED_EFFECTS = 8_192;
export const MAX_WORLDBOOK_WARNINGS = 256;

export interface WorldbookRuntimeBook {
  /** Caller-owned stable identity. Array position is the locked book-order tie break. */
  id: string;
  book: NormalizedWorldbook;
}

export interface WorldbookAdditionalScanSource {
  /** Stable caller label used for diagnostics only. */
  id: string;
  content: string;
}

export interface WorldbookCharacterScanSource {
  name: string;
  tags: readonly string[];
  description: string;
  personality: string;
  depthPrompt: string;
  scenario: string;
  creatorNotes: string;
}

export interface WorldbookPersonaScanSource {
  name: string;
  tags: readonly string[];
  description: string;
}

export interface WorldbookScanSources {
  /** Newest message first, matching the SillyTavern world-info scan contract. */
  messages: readonly string[];
  /** Scanned after enabled card/persona fields, in supplied order. */
  additional: readonly WorldbookAdditionalScanSource[];
  trigger: string;
  character?: WorldbookCharacterScanSource;
  persona?: WorldbookPersonaScanSource;
}

export interface WorldbookEvaluationSettings {
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  useGroupScoring?: boolean;
  /** Overrides the normalized books when supplied. */
  recursiveScanning?: boolean;
  minActivations?: number;
  minActivationsDepthMax?: number;
  /** Counts the initial scan. Zero and omission use the safe runtime cap. */
  maxRecursionSteps?: number;
}

export interface WorldbookTokenCounter {
  /** Must be synchronous so evaluation remains one pure state transition. */
  countText(text: string): number;
}

export interface WorldbookTimedEffect {
  entryKey: string;
  fingerprint: string;
  start: number;
  end: number;
  protected: boolean;
}

export interface WorldbookTimedState {
  messageIndex: number | null;
  readonly sticky: readonly WorldbookTimedEffect[];
  readonly cooldown: readonly WorldbookTimedEffect[];
}

export interface WorldbookEvaluationInput {
  seed: string | number;
  messageIndex: number;
  previousTimedState: WorldbookTimedState;
  scanSources: WorldbookScanSources;
  /** Input order is locked and is used as a deterministic tie break. */
  readonly books: readonly WorldbookRuntimeBook[];
  /** Exact final-text budget. Like ST 1.18 World Info, equality does not fit. */
  tokenBudget: number;
  tokenizer: WorldbookTokenCounter;
  settings?: WorldbookEvaluationSettings;
}

export type WorldbookExclusionReason =
  | 'book_disabled'
  | 'entry_disabled'
  | 'invalid_entry'
  | 'trigger_mismatch'
  | 'character_filter'
  | 'persona_filter'
  | 'delay'
  | 'cooldown'
  | 'recursion_delayed'
  | 'recursion_excluded'
  | 'missing_keys'
  | 'primary_key_miss'
  | 'secondary_key_miss'
  | 'invalid_regex'
  | 'unsafe_regex'
  | 'group_loser'
  | 'group_already_active'
  | 'probability'
  | 'budget'
  | 'recursion_limit'
  | 'evaluation_limit'
  | 'tokenizer_error';

export interface WorldbookExcludedEntry {
  entryKey: string;
  bookId: string;
  sourceUid: SourceUid;
  sourceOrdinal: number;
  reason: WorldbookExclusionReason;
}

export interface WorldbookWarning {
  code: string;
  message: string;
  entryKey?: string;
  bookId?: string;
  keyIndex?: number;
}

export type WorldbookActivationKind = 'constant' | 'keyword' | 'sticky';

export interface ActivatedWorldbookEntry {
  entryKey: string;
  bookId: string;
  bookName: string;
  sourceUid: SourceUid;
  sourceOrdinal: number;
  content: string;
  position: number | string;
  depth: number;
  role: number;
  outletName: string;
  order: number;
  priority: number | null;
  ignoreBudget: boolean;
  activation: WorldbookActivationKind;
  activationStep: number;
  /** Exact token count of all retained Worldbook text after this entry. */
  tokenUsageAfter: number;
}

export interface WorldbookTokenUsage {
  budget: number;
  used: number;
  overflowed: boolean;
}

export interface WorldbookEvaluationResult {
  activated: ActivatedWorldbookEntry[];
  excluded: WorldbookExcludedEntry[];
  timedState: WorldbookTimedState;
  tokenUsage: WorldbookTokenUsage;
  recursionSteps: number;
  warnings: WorldbookWarning[];
}

export interface PreparedWorldbookEntry {
  entryKey: string;
  fingerprint: string;
  bookId: string;
  bookName: string;
  bookIndex: number;
  entryIndex: number;
  bookScanDepth: number | null;
  entry: NormalizedWorldbookEntry;
}

export interface MatchedWorldbookEntry {
  prepared: PreparedWorldbookEntry;
  activation: WorldbookActivationKind;
  activationStep: number;
  score: number;
}
