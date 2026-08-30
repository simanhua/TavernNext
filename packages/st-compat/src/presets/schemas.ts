import { z } from 'zod';

export const PresetKindSchema = z.enum(['chat', 'text', 'context', 'instruct', 'system', 'reasoning']);
export type PresetKind = z.infer<typeof PresetKindSchema>;

const nameShape = { name: z.string().optional() };
const numericOrderValue = z.union([z.number(), z.string()]);

const ChatPromptSchema = z.object({
  identifier: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  content: z.string().optional(),
  system_prompt: z.boolean().optional(),
  enabled: z.boolean().optional(),
  marker: z.boolean().optional(),
  injection_position: z.number().optional(),
  injection_depth: z.number().optional(),
  injection_order: z.number().optional(),
  forbid_overrides: z.boolean().optional(),
  injection_trigger: z.array(z.string()).optional(),
  generation_trigger: z.array(z.string()).optional(),
}).passthrough();

const ChatPromptOrderItemSchema = z.object({
  identifier: z.string(),
  enabled: z.boolean(),
}).passthrough();

const ChatPromptOrderSchema = z.object({
  character_id: z.union([z.number(), z.string()]).optional(),
  order: z.array(ChatPromptOrderItemSchema),
}).passthrough();

const ChatPromptOrderExecutableSchema = z.object({
  character_id: z.union([z.number(), z.string()]).optional(),
  order: z.array(ChatPromptOrderItemSchema.strip()),
}).strip();

export const ChatPresetSchema = z.object({
  ...nameShape,
  prompts: z.array(ChatPromptSchema),
  prompt_order: z.array(ChatPromptOrderSchema),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  top_a: z.number().optional(),
  min_p: z.number().optional(),
  repetition_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().optional(),
  tokenizer: z.union([z.number(), z.string()]).optional(),
  max_tokens: z.number().optional(),
  reasoning_effort: z.enum([
    'auto', 'none', 'disabled', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  ]).optional(),
  squash_system_messages: z.boolean().optional(),
  send_if_empty: z.string().optional(),
  assistant_prefill: z.string().optional(),
  continue_prefill: z.boolean().optional(),
  continue_postfix: z.string().optional(),
  continue_nudge_prompt: z.string().optional(),
  new_chat_prompt: z.string().optional(),
  new_example_chat_prompt: z.string().optional(),
  new_group_chat_prompt: z.string().optional(),
  group_nudge_prompt: z.string().optional(),
  impersonation_prompt: z.string().optional(),
  personality_format: z.string().optional(),
  scenario_format: z.string().optional(),
  wi_format: z.string().optional(),
  names_behavior: z.number().optional(),
  use_sysprompt: z.boolean().optional(),
  max_context_unlocked: z.boolean().optional(),
  n: z.number().optional(),
  openai_max_tokens: z.number().optional(),
  openai_max_context: z.number().optional(),
  stream_openai: z.boolean().optional(),
}).passthrough();

const NovelOrderEntrySchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
}).passthrough();

const TextSettingsShape = {
  temperature: z.number().optional(),
  temp: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  top_a: z.number().optional(),
  min_p: z.number().optional(),
  typical_p: z.number().optional(),
  typical: z.number().optional(),
  tail_free_sampling: z.number().optional(),
  tfs: z.number().optional(),
  repetition_penalty: z.number().optional(),
  repetition_penalty_range: z.number().optional(),
  repetition_penalty_slope: z.number().optional(),
  repetition_penalty_frequency: z.number().optional(),
  repetition_penalty_presence: z.number().optional(),
  repetition_penalty_decay: z.number().optional(),
  repetition_penalty_size: z.number().optional(),
  rep_pen: z.number().optional(),
  rep_pen_range: z.number().optional(),
  rep_pen_slope: z.number().optional(),
  rep_pen_decay: z.number().optional(),
  rep_pen_size: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  freq_pen: z.number().optional(),
  presence_pen: z.number().optional(),
  encoder_rep_pen: z.number().optional(),
  sampler_order: z.array(numericOrderValue).optional(),
  sampler_priority: z.array(z.string()).optional(),
  samplers: z.array(z.string()).optional(),
  samplers_priorities: z.array(z.string()).optional(),
  order: z.array(z.union([z.number(), NovelOrderEntrySchema])).optional(),
  tokenizer: z.union([z.number(), z.string()]).optional(),
  max_context: z.number().optional(),
  max_length: z.number().optional(),
  max_new_tokens: z.number().optional(),
  min_length: z.number().optional(),
  min_keep: z.number().optional(),
  length_penalty: z.number().optional(),
  min_temp: z.number().optional(),
  max_temp: z.number().optional(),
  add_bos_token: z.boolean().optional(),
  ban_eos_token: z.boolean().optional(),
  banned_tokens: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
  do_sample: z.boolean().optional(),
  dry_allowed_length: z.number().optional(),
  dry_base: z.number().optional(),
  dry_multiplier: z.number().optional(),
  dry_penalty_last_n: z.number().optional(),
  dry_sequence_breakers: z.union([z.string(), z.array(z.string())]).optional(),
  dynatemp: z.boolean().optional(),
  dynatemp_exponent: z.number().optional(),
  epsilon_cutoff: z.number().optional(),
  eta_cutoff: z.number().optional(),
  guidance_scale: z.number().optional(),
  ignore_eos_token: z.boolean().optional(),
  json_schema: z.record(z.string(), z.unknown()).nullable().optional(),
  json_schema_allow_empty: z.boolean().optional(),
  mirostat_mode: z.number().optional(),
  mirostat: z.number().optional(),
  mirostat_eta: z.number().optional(),
  mirostat_tau: z.number().optional(),
  mirostat_lr: z.number().optional(),
  negative_prompt: z.string().optional(),
  no_repeat_ngram_size: z.number().optional(),
  nsigma: z.number().optional(),
  num_beams: z.number().optional(),
  penalty_alpha: z.number().optional(),
  skew: z.number().optional(),
  skip_special_tokens: z.boolean().optional(),
  smoothing_curve: z.number().optional(),
  smoothing_factor: z.number().optional(),
  spaces_between_special_tokens: z.boolean().optional(),
  speculative_ngram: z.boolean().optional(),
  temperature_last: z.boolean().optional(),
  xtc_probability: z.number().optional(),
  xtc_threshold: z.number().optional(),
  grammar_string: z.string().optional(),
  grammar: z.string().optional(),
  early_stopping: z.boolean().optional(),
  logit_bias: z.array(z.unknown()).optional(),
  use_default_badwordsids: z.boolean().optional(),
  phrase_rep_pen: z.string().optional(),
  math1_temp: z.number().optional(),
  math1_quad: z.number().optional(),
  math1_quad_entropy_scale: z.number().optional(),
};

export const TextParameterSchema = z.object(TextSettingsShape).passthrough();

export const TextPresetSchema = z.object({
  ...nameShape,
  ...TextSettingsShape,
  presetVersion: z.number().optional(),
  parameters: TextParameterSchema.optional(),
  prefix: z.string().optional(),
  preamble: z.string().optional(),
  use_cache: z.boolean().optional(),
  return_full_text: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const ContextPresetSchema = z.object({
  ...nameShape,
  story_string: z.string(),
  story_string_position: z.number().optional(),
  story_string_depth: z.number().optional(),
  story_string_role: z.number().optional(),
  example_separator: z.string().optional(),
  chat_start: z.string().optional(),
  use_stop_strings: z.boolean().optional(),
  names_as_stop_strings: z.boolean().optional(),
  always_force_name2: z.boolean().optional(),
  single_line: z.boolean().optional(),
  trim_sentences: z.boolean().optional(),
}).passthrough();

export const InstructPresetSchema = z.object({
  ...nameShape,
  input_sequence: z.string(),
  output_sequence: z.string(),
  system_sequence: z.string(),
  activation_regex: z.string().optional(),
  first_input_sequence: z.string().optional(),
  first_output_sequence: z.string().optional(),
  input_suffix: z.string().optional(),
  last_input_sequence: z.string().optional(),
  last_output_sequence: z.string().optional(),
  last_system_sequence: z.string().optional(),
  macro: z.boolean().optional(),
  names_behavior: z.string().optional(),
  output_suffix: z.string().optional(),
  sequences_as_stop_strings: z.boolean().optional(),
  skip_examples: z.boolean().optional(),
  stop_sequence: z.union([z.string(), z.array(z.string())]).optional(),
  story_string_prefix: z.string().optional(),
  story_string_suffix: z.string().optional(),
  system_same_as_user: z.boolean().optional(),
  system_suffix: z.string().optional(),
  user_alignment_message: z.string().optional(),
  wrap: z.boolean().optional(),
}).passthrough();

export const SystemPresetSchema = z.object({
  ...nameShape,
  content: z.string(),
  post_history: z.string(),
}).passthrough();

export const ReasoningPresetSchema = z.object({
  ...nameShape,
  prefix: z.string(),
  separator: z.string(),
  suffix: z.string(),
  extract_regex: z.string().optional(),
  reasoning: z.string().optional(),
  reasoning_config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Shared envelope validation happens before the selected family validates its known fields deeply. */
export const PresetDocumentSchema = z.object(nameShape).passthrough();

const ChatExecutableSchema = ChatPresetSchema.omit({
  name: true,
  openai_max_tokens: true,
  openai_max_context: true,
  stream_openai: true,
}).extend({
  prompts: z.array(ChatPromptSchema.strip()),
  prompt_order: z.array(ChatPromptOrderExecutableSchema),
}).strip();
const TextExecutableSchema = z.object({
  ...TextSettingsShape,
  order: z.array(z.union([z.number(), NovelOrderEntrySchema.strip()])).optional(),
}).strip();
const ContextExecutableSchema = ContextPresetSchema.omit({ name: true }).strip();
const InstructExecutableSchema = InstructPresetSchema.omit({ name: true }).strip();
const SystemExecutableSchema = SystemPresetSchema.omit({ name: true }).strip();
const ReasoningExecutableSchema = ReasoningPresetSchema.omit({ name: true }).strip();

export const textSettingAliases = {
  temperature: ['temperature', 'temp'],
  typical_p: ['typical_p', 'typical'],
  tail_free_sampling: ['tail_free_sampling', 'tfs'],
  repetition_penalty: ['repetition_penalty', 'rep_pen'],
  repetition_penalty_range: ['repetition_penalty_range', 'rep_pen_range'],
  repetition_penalty_slope: ['repetition_penalty_slope', 'rep_pen_slope'],
  repetition_penalty_decay: ['repetition_penalty_decay', 'rep_pen_decay'],
  repetition_penalty_size: ['repetition_penalty_size', 'rep_pen_size'],
  frequency_penalty: ['frequency_penalty', 'freq_pen'],
  presence_penalty: ['presence_penalty', 'presence_pen'],
  mirostat_mode: ['mirostat_mode', 'mirostat'],
  grammar_string: ['grammar_string', 'grammar'],
} as const satisfies Record<string, readonly string[]>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isDirectNovelPreset(value: Record<string, unknown>): boolean {
  return typeof value.presetVersion === 'number' && record(value.parameters) !== undefined;
}

export function validatePresetFamily(kind: PresetKind, value: Record<string, unknown>): Record<string, unknown> {
  const parsed = (() => {
    switch (kind) {
      case 'chat': return ChatPresetSchema.parse(value);
      case 'text': return TextPresetSchema.parse(value);
      case 'context': return ContextPresetSchema.parse(value);
      case 'instruct': return InstructPresetSchema.parse(value);
      case 'system': return SystemPresetSchema.parse(value);
      case 'reasoning': return ReasoningPresetSchema.parse(value);
    }
  })();
  return parsed as Record<string, unknown>;
}

export interface ExecutablePresetFields {
  settings: Record<string, unknown>;
  knownRawFields: Record<string, unknown>;
}

function canonicalTextSettings(rawSettings: Record<string, unknown>): Record<string, unknown> {
  const settings = TextExecutableSchema.parse(rawSettings) as Record<string, unknown>;
  const canonical = structuredClone(settings);
  for (const [canonicalKey, aliases] of Object.entries(textSettingAliases)) {
    const sourceKey = aliases.find((key) => key in settings);
    if (sourceKey === undefined) continue;
    canonical[canonicalKey] = structuredClone(settings[sourceKey]);
    for (const alias of aliases) {
      if (alias !== canonicalKey) delete canonical[alias];
    }
  }
  return canonical;
}

export function executablePresetFields(kind: PresetKind, value: Record<string, unknown>): ExecutablePresetFields {
  if (kind === 'text') {
    const directNovel = isDirectNovelPreset(value);
    const rawSource = directNovel ? record(value.parameters)! : value;
    const knownRawSettings = TextExecutableSchema.parse(rawSource) as Record<string, unknown>;
    const knownRawFields = directNovel
      ? { presetVersion: value.presetVersion, parameters: knownRawSettings }
      : knownRawSettings;
    return { settings: canonicalTextSettings(rawSource), knownRawFields };
  }
  const settings = (() => {
    switch (kind) {
      case 'chat': return ChatExecutableSchema.parse(value);
      case 'context': return ContextExecutableSchema.parse(value);
      case 'instruct': return InstructExecutableSchema.parse(value);
      case 'system': return SystemExecutableSchema.parse(value);
      case 'reasoning': return ReasoningExecutableSchema.parse(value);
    }
  })() as Record<string, unknown>;
  return { settings, knownRawFields: structuredClone(settings) };
}

export interface ParsedPresetDocument {
  root: Record<string, unknown>;
  document: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
}

function hasFamilyDiscriminator(value: Record<string, unknown>): boolean {
  return [
    'prompts', 'prompt_order', 'story_string', 'input_sequence', 'output_sequence', 'system_sequence',
    'sampler_order', 'samplers', 'presetVersion', 'parameters', 'prefix', 'separator', 'suffix', 'content', 'post_history',
  ].some((key) => key in value);
}

/**
 * `.preset` and `.settings` may be filename extensions or structural compatibility envelopes.
 * Only object-valued root properties are unwrapped; filenames never select a family or wrapper.
 */
export function parsePresetDocument(value: unknown): ParsedPresetDocument {
  const root = record(value);
  if (root === undefined) throw new Error('preset_root_invalid');
  const parsedRoot = PresetDocumentSchema.parse(root) as Record<string, unknown>;
  if ('preset' in parsedRoot) {
    const document = record(parsedRoot.preset);
    if (document === undefined) throw new Error('preset_wrapper_invalid');
    return { root: parsedRoot, document, wrapperKey: 'preset' };
  }
  if (!hasFamilyDiscriminator(parsedRoot) && 'settings' in parsedRoot) {
    const document = record(parsedRoot.settings);
    if (document === undefined) throw new Error('preset_wrapper_invalid');
    return { root: parsedRoot, document, wrapperKey: 'settings' };
  }
  return { root: parsedRoot, document: parsedRoot };
}
