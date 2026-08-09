import type { Character, GenerationMode, Persona, Preset } from '@tavernnext/domain';

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptChatMessage {
  readonly [key: string]: unknown;
  role: PromptRole;
  content: string;
  name?: string;
}

export interface PromptHistoryMessage {
  id?: string;
  role: string;
  content: string;
  name?: string;
}

export interface PromptTokenizer {
  countText(text: string): number | Promise<number>;
  countMessages(messages: readonly PromptChatMessage[]): number | Promise<number>;
}

export interface PromptWarning {
  code: string;
  message: string;
  source?: string;
  macro?: string;
}

export type TokenOmissionReason =
  | 'disabled'
  | 'trigger_mismatch'
  | 'duplicate_identifier'
  | 'duplicate_order_reference'
  | 'missing_prompt'
  | 'unknown_marker'
  | 'unsupported_role'
  | 'not_applicable'
  | 'history_budget'
  | 'optional_budget'
  | 'budget_search_limit'
  | 'context_overflow';

export interface TokenBreakdownEntry {
  source: string;
  includedTokens: number;
  omittedTokens: number;
  reason?: TokenOmissionReason;
}

export interface MacroLimits {
  maxDepth?: number;
  maxExpandedLength?: number;
}

export interface WorldInfoPlacementContent {
  source: string;
  content: string;
}

export interface WorldInfoDepthPlacement extends WorldInfoPlacementContent {
  depth: number;
  role: PromptRole;
}

export interface WorldInfoCompilerPlacements {
  beforeCharacter: string;
  afterCharacter: string;
  examplesBefore: readonly WorldInfoPlacementContent[];
  examplesAfter: readonly WorldInfoPlacementContent[];
  authorNote: {
    before: readonly WorldInfoPlacementContent[];
    content: string;
    after: readonly WorldInfoPlacementContent[];
    /** SillyTavern extension prompt position: 0=in prompt, 1=in chat, 2=before prompt. */
    position: 0 | 1 | 2;
    depth: number;
    role: PromptRole;
  };
  atDepth: readonly WorldInfoDepthPlacement[];
  outlets: Readonly<Record<string, readonly WorldInfoPlacementContent[]>>;
}

interface CompilationInputBase {
  character: Character;
  persona: Persona;
  history: readonly PromptHistoryMessage[];
  tokenizer: PromptTokenizer;
  maxPromptTokens: number;
  stop?: readonly string[];
  macroLimits?: MacroLimits;
}

export interface CompileChatPromptInput extends CompilationInputBase {
  preset: Preset;
  /** This compiler models solo chat only; group and forced-avatar name rules are intentionally outside its contract. */
  chatMode?: 'solo';
  generationType?: GenerationMode;
  promptOrderCharacterId?: string | number;
  worldInfoBefore?: string;
  worldInfoAfter?: string;
  worldInfoPlacements?: WorldInfoCompilerPlacements;
}

export interface CompileTextPromptInput extends CompilationInputBase {
  textPreset: Preset;
  contextPreset: Preset;
  instructPreset?: Preset;
  systemPreset?: Preset;
  worldInfoBefore?: string;
  worldInfoAfter?: string;
  worldInfoPlacements?: WorldInfoCompilerPlacements;
  anchorBefore?: string;
  anchorAfter?: string;
  generationType?: GenerationMode;
}

interface CompilationResultBase {
  stop: string[];
  tokenBreakdown: TokenBreakdownEntry[];
  totalTokens: number;
  warnings: PromptWarning[];
}

export interface ChatPromptCompilation extends CompilationResultBase {
  kind: 'chat';
  messages: PromptChatMessage[];
  worldInfoOutlets: Record<string, string>;
}

export interface TextPromptCompilation extends CompilationResultBase {
  kind: 'text';
  text: string;
  worldInfoOutlets: Record<string, string>;
}

export type PromptCompilationErrorCode =
  | 'invalid_budget'
  | 'invalid_preset'
  | 'macro_expansion_limit'
  | 'budget_search_limit'
  | 'tokenizer_error'
  | 'unsupported_worldbook_placement'
  | 'context_overflow';

export interface PromptCompilationFailure<TTarget extends 'chat' | 'text' = 'chat' | 'text'> extends CompilationResultBase {
  kind: 'error';
  target: TTarget;
  code: PromptCompilationErrorCode;
  message: string;
}

export type PromptCompilationResult = ChatPromptCompilation | TextPromptCompilation | PromptCompilationFailure;
export type ChatPromptCompilationResult = ChatPromptCompilation | PromptCompilationFailure<'chat'>;
export type TextPromptCompilationResult = TextPromptCompilation | PromptCompilationFailure<'text'>;
