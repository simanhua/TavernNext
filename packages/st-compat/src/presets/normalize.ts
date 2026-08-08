import type { ImportDiagnostic } from '../warnings.js';
import { diagnostic } from '../warnings.js';
import { detectPresetKinds } from './detect.js';
import { parsePresetDocument, type PresetKind, record } from './schemas.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

const knownSettings: Record<PresetKind, ReadonlySet<string>> = {
  chat: new Set([
    'prompts', 'prompt_order', 'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
    'frequency_penalty', 'presence_penalty', 'seed', 'tokenizer', 'max_tokens', 'openai_max_tokens',
    'openai_max_context', 'stream_openai', 'squash_system_messages', 'send_if_empty', 'assistant_prefill',
    'continue_prefill', 'continue_postfix', 'continue_nudge_prompt', 'new_chat_prompt', 'new_example_chat_prompt',
    'new_group_chat_prompt', 'group_nudge_prompt', 'impersonation_prompt', 'personality_format', 'scenario_format',
    'wi_format', 'names_behavior', 'use_sysprompt', 'max_context_unlocked', 'n',
  ]),
  text: new Set([
    'presetVersion', 'parameters', 'temperature', 'temp', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p',
    'tfs', 'rep_pen', 'rep_pen_range', 'rep_pen_slope', 'rep_pen_size', 'rep_pen_decay', 'repetition_penalty',
    'frequency_penalty', 'presence_penalty', 'freq_pen', 'presence_pen', 'encoder_rep_pen', 'sampler_order',
    'sampler_priority', 'samplers', 'samplers_priorities', 'tokenizer', 'max_context', 'max_length', 'max_new_tokens',
    'add_bos_token', 'ban_eos_token', 'banned_tokens', 'do_sample', 'dry_allowed_length', 'dry_base',
    'dry_multiplier', 'dry_penalty_last_n', 'dry_sequence_breakers', 'dynatemp', 'dynatemp_exponent',
    'epsilon_cutoff', 'eta_cutoff', 'guidance_scale', 'ignore_eos_token', 'json_schema', 'json_schema_allow_empty',
    'min_keep', 'min_length', 'mirostat_eta', 'mirostat_mode', 'mirostat_tau', 'negative_prompt',
    'no_repeat_ngram_size', 'nsigma', 'num_beams', 'penalty_alpha', 'skew', 'skip_special_tokens',
    'smoothing_curve', 'smoothing_factor', 'spaces_between_special_tokens', 'speculative_ngram',
    'temperature_last', 'typical_p', 'xtc_probability', 'xtc_threshold', 'grammar_string', 'early_stopping',
  ]),
  context: new Set([
    'story_string', 'story_string_position', 'story_string_depth', 'story_string_role', 'example_separator',
    'chat_start', 'use_stop_strings', 'names_as_stop_strings', 'always_force_name2', 'single_line', 'trim_sentences',
  ]),
  instruct: new Set([
    'activation_regex', 'first_input_sequence', 'first_output_sequence', 'input_sequence', 'input_suffix',
    'last_input_sequence', 'last_output_sequence', 'last_system_sequence', 'macro', 'names_behavior',
    'output_sequence', 'output_suffix', 'sequences_as_stop_strings', 'skip_examples', 'stop_sequence',
    'story_string_prefix', 'story_string_suffix', 'system_same_as_user', 'system_sequence', 'system_suffix',
    'user_alignment_message', 'wrap',
  ]),
  system: new Set(['content', 'post_history']),
  reasoning: new Set(['prefix', 'separator', 'suffix', 'extract_regex', 'reasoning', 'reasoning_config']),
};

function isProviderSetting(key: string): boolean {
  return /^(?:ai21|chutes|claude|custom|electronhub|google|minimax|mistralai|openrouter|vertexai|vendor|provider)_/i.test(key)
    || key === 'reverse_proxy' || key === 'proxy_password' || key === 'chat_completion_source';
}

function fallbackName(fileName: string): string {
  const name = fileName.replace(/[\\/]/g, '/').split('/').at(-1) ?? 'preset';
  const stem = name.replace(/\.[^.]*$/, '').trim();
  return stem === '' ? 'Imported Preset' : stem;
}

function stableWarnings(candidates: readonly PresetKind[], unknownFields: Record<string, unknown>): ImportDiagnostic[] {
  const warnings: ImportDiagnostic[] = [];
  if (candidates.length > 1) {
    warnings.push(diagnostic('ambiguous_preset', `The document matches multiple preset families: ${candidates.join(', ')}.`));
  }
  if (Object.keys(unknownFields).some(isProviderSetting)) {
    warnings.push(diagnostic(
      'provider_field_preserved_not_executable',
      'Provider-specific settings are preserved for export but will not be executed by TavernNext.',
    ));
  }
  return warnings;
}

export interface PresetImportPreview {
  name: string;
  kind: PresetKind | null;
  candidates: PresetKind[];
  settings: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
  warnings: ImportDiagnostic[];
  blockingErrors: ImportDiagnostic[];
}

export class PresetCodecError extends Error {
  constructor(readonly issue: ImportDiagnostic) {
    super(issue.message);
  }
}

function invalid(code: string, message: string): never {
  throw new PresetCodecError(diagnostic(code, message));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return invalid('preset_json_invalid', 'Preset documents must contain valid UTF-8 JSON.');
  }
}

/** Reparse exact staged source bytes; filenames are used only for a nameless-preset display fallback. */
export function decodeInspectedPreset(bytes: Uint8Array, fileName: string): Omit<PresetImportPreview, 'warnings' | 'blockingErrors'> {
  let parsed;
  try {
    parsed = parsePresetDocument(parseJson(bytes));
  } catch (error) {
    if (error instanceof PresetCodecError) throw error;
    const code = error instanceof Error ? error.message : '';
    if (code === 'preset_root_invalid') invalid(code, 'Preset root must be an object.');
    if (code === 'preset_wrapper_invalid') invalid(code, 'Preset wrapper must contain an object.');
    invalid('preset_decode_failed', 'Preset document could not be decoded safely.');
  }
  const candidates = detectPresetKinds(parsed.document);
  if (candidates.length === 0) invalid('preset_unrecognized', 'Document does not contain a recognized preset shape.');
  const kind = candidates[0]!;
  const settings = Object.fromEntries(
    Object.entries(parsed.document)
      .filter(([key]) => knownSettings[kind].has(key))
      .map(([key, value]) => [key, structuredClone(value)]),
  );
  const unknownFields: Record<string, unknown> = Object.fromEntries(
    Object.entries(parsed.document)
      .filter(([key]) => key !== 'name' && !knownSettings[kind].has(key))
      .map(([key, value]) => [key, structuredClone(value)]),
  );
  if (parsed.wrapperKey !== undefined) {
    for (const [key, value] of Object.entries(parsed.root)) {
      if (key === parsed.wrapperKey || key === 'name') continue;
      unknownFields[key] = structuredClone(value);
    }
  }
  const name = typeof parsed.document.name === 'string' && parsed.document.name.trim() !== ''
    ? parsed.document.name
    : typeof parsed.root.name === 'string' && parsed.root.name.trim() !== ''
      ? parsed.root.name
      : fallbackName(fileName);
  return {
    name,
    kind,
    candidates,
    settings,
    unknownFields,
    rawPayload: structuredClone(parsed.root),
    ...(parsed.wrapperKey === undefined ? {} : { wrapperKey: parsed.wrapperKey }),
  };
}

function emptyPresetPreview(): PresetImportPreview {
  return {
    name: '', kind: null, candidates: [], settings: {}, unknownFields: {}, rawPayload: {}, warnings: [], blockingErrors: [],
  };
}

export async function inspectPreset(bytes: Uint8Array, fileName: string): Promise<PresetImportPreview> {
  try {
    const decoded = decodeInspectedPreset(bytes, fileName);
    return {
      ...decoded,
      warnings: stableWarnings(decoded.candidates, decoded.unknownFields),
      blockingErrors: [],
    };
  } catch (error) {
    const preview = emptyPresetPreview();
    return {
      ...preview,
      blockingErrors: [error instanceof PresetCodecError
        ? error.issue
        : diagnostic('preset_decode_failed', 'Preset document could not be decoded safely.')],
    };
  }
}

export function presetWarnings(decoded: Omit<PresetImportPreview, 'warnings' | 'blockingErrors'>): ImportDiagnostic[] {
  return stableWarnings(decoded.candidates, decoded.unknownFields);
}

export function presetRawDocument(value: unknown): Record<string, unknown> | undefined {
  return record(value);
}
