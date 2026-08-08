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
}

export interface CompileTextPromptInput extends CompilationInputBase {
  textPreset: Preset;
  contextPreset: Preset;
  instructPreset?: Preset;
  systemPreset?: Preset;
  worldInfoBefore?: string;
  worldInfoAfter?: string;
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
}

export interface TextPromptCompilation extends CompilationResultBase {
  kind: 'text';
  text: string;
}

export type PromptCompilationErrorCode =
  | 'invalid_budget'
  | 'invalid_preset'
  | 'macro_expansion_limit'
  | 'tokenizer_error'
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
