import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api, errorCode, type PresetKind, type PresetView } from '../../api/client.js';
import { CompatibilitySummary } from '../shared/CompatibilitySummary.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { DeleteConfirmation } from '../shared/DeleteConfirmation.js';

const kinds = ['chat', 'text', 'context', 'instruct', 'system', 'reasoning'] as const;
const ChatKeys = new Set([
  'prompts', 'prompt_order', 'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
  'frequency_penalty', 'presence_penalty', 'seed', 'tokenizer', 'max_tokens', 'squash_system_messages',
  'send_if_empty', 'assistant_prefill', 'continue_prefill', 'continue_postfix', 'continue_nudge_prompt',
  'new_chat_prompt', 'new_example_chat_prompt', 'new_group_chat_prompt', 'group_nudge_prompt',
  'impersonation_prompt', 'personality_format', 'scenario_format', 'wi_format', 'names_behavior',
  'use_sysprompt', 'max_context_unlocked', 'n',
]);
const ChatPromptKeys = new Set([
  'identifier', 'name', 'role', 'content', 'system_prompt', 'enabled', 'marker', 'injection_position',
  'injection_depth', 'injection_order', 'forbid_overrides', 'injection_trigger', 'generation_trigger',
]);
const TextKeys = new Set([
  'temperature', 'temp', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'typical', 'tail_free_sampling',
  'tfs', 'repetition_penalty', 'repetition_penalty_range', 'repetition_penalty_slope',
  'repetition_penalty_frequency', 'repetition_penalty_presence', 'repetition_penalty_decay',
  'repetition_penalty_size', 'rep_pen', 'rep_pen_range', 'rep_pen_slope', 'rep_pen_decay', 'rep_pen_size',
  'frequency_penalty', 'presence_penalty', 'freq_pen', 'encoder_rep_pen', 'sampler_order', 'sampler_priority',
  'samplers', 'samplers_priorities', 'order', 'tokenizer', 'max_context', 'max_length', 'max_new_tokens',
  'min_length', 'min_keep', 'length_penalty', 'min_temp', 'max_temp', 'add_bos_token', 'ban_eos_token',
  'banned_tokens', 'do_sample', 'dry_allowed_length', 'dry_base', 'dry_multiplier', 'dry_penalty_last_n',
  'dry_sequence_breakers', 'dynatemp', 'dynatemp_exponent', 'epsilon_cutoff', 'eta_cutoff', 'guidance_scale',
  'ignore_eos_token', 'json_schema', 'json_schema_allow_empty', 'mirostat_mode', 'mirostat', 'mirostat_eta',
  'mirostat_tau', 'mirostat_lr', 'negative_prompt', 'no_repeat_ngram_size', 'nsigma', 'num_beams',
  'penalty_alpha', 'skew', 'skip_special_tokens', 'smoothing_curve', 'smoothing_factor',
  'spaces_between_special_tokens', 'speculative_ngram', 'temperature_last', 'xtc_probability', 'xtc_threshold',
  'grammar_string', 'grammar', 'early_stopping', 'logit_bias', 'use_default_badwordsids', 'phrase_rep_pen',
  'math1_temp', 'math1_quad', 'math1_quad_entropy_scale',
]);
const FamilyKeys: Record<Exclude<PresetKind, 'chat' | 'text'>, Set<string>> = {
  context: new Set(['story_string', 'story_string_position', 'story_string_depth', 'story_string_role', 'example_separator', 'chat_start', 'use_stop_strings', 'names_as_stop_strings', 'always_force_name2', 'single_line', 'trim_sentences']),
  instruct: new Set(['input_sequence', 'output_sequence', 'system_sequence', 'activation_regex', 'first_input_sequence', 'first_output_sequence', 'input_suffix', 'last_input_sequence', 'last_output_sequence', 'last_system_sequence', 'macro', 'names_behavior', 'output_suffix', 'sequences_as_stop_strings', 'skip_examples', 'stop_sequence', 'story_string_prefix', 'story_string_suffix', 'system_same_as_user', 'system_suffix', 'user_alignment_message', 'wrap']),
  system: new Set(['content', 'post_history']),
  reasoning: new Set(['prefix', 'separator', 'suffix', 'extract_regex', 'reasoning', 'reasoning_config']),
};
const OptionalBooleanSchema = z.enum(['', 'true', 'false']);
const OptionalNumberSchema = z.string().refine(
  (value) => value === '' || Number.isFinite(Number(value)),
  'Optional numeric prompt fields must be numbers',
);
const OptionalStringArraySchema = z.string().refine((value) => {
  if (value === '') return true;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string');
  } catch {
    return false;
  }
}, 'Prompt triggers must be a JSON string array');
const ExplicitPromptKeys = [
  'identifier', 'name', 'role', 'content', 'enabled', 'system_prompt', 'marker', 'injection_position',
  'injection_depth', 'injection_order', 'forbid_overrides', 'injection_trigger', 'generation_trigger',
] as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pick(source: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  return Object.fromEntries([...allowed].flatMap((key) => Object.hasOwn(source, key) ? [[key, structuredClone(source[key])]] : []));
}

function sanitizeSettings(kind: PresetKind, value: unknown): Record<string, unknown> {
  const source = record(value);
  if (kind === 'text') return pick(source, TextKeys);
  if (kind !== 'chat') return pick(source, FamilyKeys[kind]);
  const output = pick(source, ChatKeys);
  output.prompts = Array.isArray(source.prompts)
    ? source.prompts.map((prompt) => pick(record(prompt), ChatPromptKeys))
    : [];
  output.prompt_order = Array.isArray(source.prompt_order) ? source.prompt_order.map((group) => {
    const item = record(group);
    return {
      ...(typeof item.character_id === 'number' || typeof item.character_id === 'string' ? { character_id: item.character_id } : {}),
      order: Array.isArray(item.order) ? item.order.map((entry) => {
        const ordered = record(entry);
        return { identifier: String(ordered.identifier ?? ''), enabled: ordered.enabled !== false };
      }).filter((entry) => entry.identifier !== '') : [],
    };
  }) : [];
  return output;
}

function defaultSettings(kind: PresetKind): Record<string, unknown> {
  if (kind === 'chat') return { prompts: [], prompt_order: [] };
  if (kind === 'context') return { story_string: '' };
  if (kind === 'instruct') return { input_sequence: '', output_sequence: '', system_sequence: '' };
  if (kind === 'system') return { content: '', post_history: '' };
  if (kind === 'reasoning') return { prefix: '', separator: '', suffix: '' };
  return {};
}

const FormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  kind: z.enum(kinds),
  temperature: z.string().refine((value) => value === '' || Number.isFinite(Number(value)), 'Temperature must be a number'),
  executableSettings: z.string().refine((value) => {
    try { return typeof JSON.parse(value) === 'object'; } catch { return false; }
  }, 'Executable settings must be valid JSON'),
  prompts: z.array(z.object({
    identifier: z.string(), name: z.string(), role: z.string(), content: z.string(), enabled: z.boolean(),
    systemPrompt: OptionalBooleanSchema, marker: OptionalBooleanSchema,
    injectionPosition: OptionalNumberSchema, injectionDepth: OptionalNumberSchema, injectionOrder: OptionalNumberSchema,
    forbidOverrides: OptionalBooleanSchema, injectionTrigger: OptionalStringArraySchema, generationTrigger: OptionalStringArraySchema,
    extras: z.record(z.string(), z.unknown()),
  })),
});
type FormValues = z.infer<typeof FormSchema>;

function optionalBoolean(value: unknown): '' | 'true' | 'false' {
  return typeof value === 'boolean' ? String(value) as 'true' | 'false' : '';
}

function optionalNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function optionalStringArray(value: unknown): string {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? JSON.stringify(value) : '';
}

function valuesFrom(kind: PresetKind, name: string, settingsValue: unknown): FormValues {
  const settings = sanitizeSettings(kind, settingsValue);
  const prompts = Array.isArray(settings.prompts) ? settings.prompts.map((value) => {
    const prompt = record(value);
    const extras = { ...prompt };
    for (const key of ExplicitPromptKeys) delete extras[key];
    return {
      identifier: String(prompt.identifier ?? ''), name: String(prompt.name ?? ''), role: String(prompt.role ?? 'system'),
      content: String(prompt.content ?? ''), enabled: prompt.enabled !== false, extras,
      systemPrompt: optionalBoolean(prompt.system_prompt), marker: optionalBoolean(prompt.marker),
      injectionPosition: optionalNumber(prompt.injection_position), injectionDepth: optionalNumber(prompt.injection_depth),
      injectionOrder: optionalNumber(prompt.injection_order), forbidOverrides: optionalBoolean(prompt.forbid_overrides),
      injectionTrigger: optionalStringArray(prompt.injection_trigger), generationTrigger: optionalStringArray(prompt.generation_trigger),
    };
  }) : [];
  const advanced = { ...settings };
  delete advanced.prompts;
  delete advanced.prompt_order;
  delete advanced.temperature;
  return {
    name,
    kind,
    temperature: typeof settings.temperature === 'number' ? String(settings.temperature) : '',
    executableSettings: JSON.stringify(advanced, null, 2),
    prompts,
  };
}

export function PresetEditor({ preset, creating, onSaved, onDeleted }: {
  preset?: PresetView;
  creating: boolean;
  onSaved: (preset: PresetView) => void;
  onDeleted: () => void;
}) {
  const initialKind = preset?.kind ?? 'chat';
  const [baseSettings, setBaseSettings] = useState<Record<string, unknown>>(sanitizeSettings(initialKind, preset?.settings ?? defaultSettings(initialKind)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<PresetView>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: valuesFrom(initialKind, preset?.name ?? '', baseSettings) });
  const prompts = useFieldArray({ control: form.control, name: 'prompts' });

  useEffect(() => {
    const kind = preset?.kind ?? 'chat';
    const settings = sanitizeSettings(kind, preset?.settings ?? defaultSettings(kind));
    setBaseSettings(settings);
    form.reset(valuesFrom(kind, preset?.name ?? '', settings));
    setConflict(undefined);
    setError(undefined);
  }, [preset?.id, creating]);

  const submit = async (values: FormValues, revision = preset?.revision) => {
    setPending(true);
    setError(undefined);
    const advanced = sanitizeSettings(values.kind, JSON.parse(values.executableSettings));
    let settings: Record<string, unknown> = advanced;
    if (values.kind === 'chat') {
      const promptValues = values.prompts.map((prompt) => ({
        ...prompt.extras,
        identifier: prompt.identifier,
        name: prompt.name,
        role: prompt.role,
        content: prompt.content,
        enabled: prompt.enabled,
        ...(prompt.systemPrompt === '' ? {} : { system_prompt: prompt.systemPrompt === 'true' }),
        ...(prompt.marker === '' ? {} : { marker: prompt.marker === 'true' }),
        ...(prompt.injectionPosition === '' ? {} : { injection_position: Number(prompt.injectionPosition) }),
        ...(prompt.injectionDepth === '' ? {} : { injection_depth: Number(prompt.injectionDepth) }),
        ...(prompt.injectionOrder === '' ? {} : { injection_order: Number(prompt.injectionOrder) }),
        ...(prompt.forbidOverrides === '' ? {} : { forbid_overrides: prompt.forbidOverrides === 'true' }),
        ...(prompt.injectionTrigger === '' ? {} : { injection_trigger: JSON.parse(prompt.injectionTrigger) as string[] }),
        ...(prompt.generationTrigger === '' ? {} : { generation_trigger: JSON.parse(prompt.generationTrigger) as string[] }),
      }));
      const priorOrders = Array.isArray(baseSettings.prompt_order) ? baseSettings.prompt_order : [];
      const priorPromptIds = new Set(Array.isArray(baseSettings.prompts)
        ? baseSettings.prompts.map((prompt) => String(record(prompt).identifier ?? '')).filter(Boolean)
        : []);
      const activeIds = new Set(promptValues.map((prompt) => prompt.identifier));
      const defaultOrderIndex = priorOrders.findIndex((groupValue) => record(groupValue).character_id === 100000);
      let promptOrder = priorOrders.length === 0
        ? [{ character_id: 100000, order: promptValues.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled })) }]
        : priorOrders.map((groupValue, groupIndex) => {
          const group = record(groupValue);
          const prior = Array.isArray(group.order) ? group.order.map((item) => {
            const entry = record(item);
            return { identifier: String(entry.identifier ?? ''), enabled: entry.enabled !== false };
          }).filter((entry) => entry.identifier !== '') : [];
          const priorEnabled = new Map(prior.map((entry) => [entry.identifier, entry.enabled]));
          return {
            ...(Object.hasOwn(group, 'character_id') ? { character_id: group.character_id } : {}),
            order: groupIndex === defaultOrderIndex
              ? promptValues.filter((prompt) => priorEnabled.has(prompt.identifier))
                .map((prompt) => ({ identifier: prompt.identifier, enabled: priorEnabled.get(prompt.identifier)! }))
              : prior.filter((entry) => activeIds.has(entry.identifier)),
          };
        });
      const added = promptValues.filter((prompt) => !priorPromptIds.has(prompt.identifier));
      if (priorOrders.length > 0 && added.length > 0) {
        if (defaultOrderIndex < 0) {
          promptOrder.push({ character_id: 100000, order: added.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled })) });
        } else {
          promptOrder = promptOrder.map((group, index) => index === defaultOrderIndex
            ? { ...group, order: [...group.order, ...added.map((prompt) => ({ identifier: prompt.identifier, enabled: prompt.enabled }))] }
            : group);
        }
      }
      settings = { ...advanced, prompts: promptValues, prompt_order: promptOrder };
      if (values.temperature !== '') settings.temperature = Number(values.temperature);
    }
    try {
      const saved = creating
        ? await api.createPreset({ name: values.name.trim(), kind: values.kind, settings })
        : await api.updatePreset(preset!.id, revision!, { name: values.name.trim(), settings });
      setBaseSettings(sanitizeSettings(saved.kind, saved.settings));
      setConflict(undefined);
      onSaved(saved);
    } catch (cause) {
      if (!creating && cause instanceof ApiError && cause.status === 409 && preset !== undefined) {
        try { setConflict(await api.getPreset(preset.id)); } catch (loadError) { setError(errorCode(loadError)); }
      } else setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    if (preset === undefined) return;
    setPending(true);
    try {
      await api.deletePreset(preset.id, preset.revision);
      setDeleteOpen(false);
      onDeleted();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const currentKind = form.watch('kind');
  const promptValidationMessages = Array.isArray(form.formState.errors.prompts)
    ? form.formState.errors.prompts.flatMap((promptErrors) => promptErrors === undefined ? [] : [
      promptErrors.systemPrompt?.message,
      promptErrors.marker?.message,
      promptErrors.injectionPosition?.message,
      promptErrors.injectionDepth?.message,
      promptErrors.injectionOrder?.message,
      promptErrors.forbidOverrides?.message,
      promptErrors.injectionTrigger?.message,
      promptErrors.generationTrigger?.message,
    ].filter((message): message is string => typeof message === 'string'))
    : [];

  return (
    <form onSubmit={form.handleSubmit((values) => void submit(values))}>
      <h2>{creating ? 'New Preset' : preset?.name}</h2>
      <CompatibilitySummary value={preset?.compatibilitySummary} />
      <label>Name<input {...form.register('name')} /></label>
      {creating ? <label>Kind<select {...form.register('kind')}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label> : <p>Family: {preset?.kind}</p>}
      {currentKind === 'chat' ? (
        <>
          <label>Temperature<input inputMode="decimal" {...form.register('temperature')} /></label>
          <fieldset>
            <legend>Chat prompts</legend>
            {prompts.fields.map((field, index) => (
              <div className="array-row" key={field.id}>
                <label>Prompt {index + 1} identifier<input {...form.register(`prompts.${index}.identifier`)} /></label>
                <label>Prompt {index + 1} name<input {...form.register(`prompts.${index}.name`)} /></label>
                <label>Prompt {index + 1} role<input {...form.register(`prompts.${index}.role`)} /></label>
                <label>Prompt {index + 1} content<textarea {...form.register(`prompts.${index}.content`)} /></label>
                <label className="checkbox-label"><input type="checkbox" {...form.register(`prompts.${index}.enabled`)} />Prompt {index + 1} enabled</label>
                <label>Prompt {index + 1} system prompt<select {...form.register(`prompts.${index}.systemPrompt`)}><option value="">Unset</option><option value="true">True</option><option value="false">False</option></select></label>
                <label>Prompt {index + 1} marker<select {...form.register(`prompts.${index}.marker`)}><option value="">Unset</option><option value="true">True</option><option value="false">False</option></select></label>
                <label>Prompt {index + 1} injection position<input inputMode="numeric" {...form.register(`prompts.${index}.injectionPosition`)} /></label>
                <label>Prompt {index + 1} injection depth<input inputMode="numeric" {...form.register(`prompts.${index}.injectionDepth`)} /></label>
                <label>Prompt {index + 1} injection order<input inputMode="numeric" {...form.register(`prompts.${index}.injectionOrder`)} /></label>
                <label>Prompt {index + 1} forbid overrides<select {...form.register(`prompts.${index}.forbidOverrides`)}><option value="">Unset</option><option value="true">True</option><option value="false">False</option></select></label>
                <label>Prompt {index + 1} injection triggers<input {...form.register(`prompts.${index}.injectionTrigger`)} /></label>
                <label>Prompt {index + 1} generation triggers<input {...form.register(`prompts.${index}.generationTrigger`)} /></label>
                <button type="button" aria-label={`Move prompt ${index + 1} up`} disabled={index === 0} onClick={() => prompts.move(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Move prompt ${index + 1} down`} disabled={index === prompts.fields.length - 1} onClick={() => prompts.move(index, index + 1)}>↓</button>
                <button type="button" onClick={() => prompts.remove(index)}>Remove prompt</button>
              </div>
            ))}
            <button type="button" onClick={() => prompts.append({
              identifier: crypto.randomUUID(), name: '', role: 'system', content: '', enabled: true,
              systemPrompt: '', marker: '', injectionPosition: '', injectionDepth: '', injectionOrder: '',
              forbidOverrides: '', injectionTrigger: '', generationTrigger: '', extras: {},
            })}>Add prompt</button>
          </fieldset>
        </>
      ) : null}
      <label>Executable settings JSON<textarea rows={12} {...form.register('executableSettings')} /></label>
      {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
      {form.formState.errors.temperature ? <p role="alert">{form.formState.errors.temperature.message}</p> : null}
      {form.formState.errors.executableSettings ? <p role="alert">{form.formState.errors.executableSettings.message}</p> : null}
      {promptValidationMessages.length === 0 ? null : (
        <div role="alert" tabIndex={-1}>
          <strong>Correct the Chat prompt fields</strong>
          <ul>{[...new Set(promptValidationMessages)].map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      )}
      {conflict === undefined ? null : (
        <ConflictBanner
          revision={conflict.revision}
          onReload={() => { setBaseSettings(sanitizeSettings(conflict.kind, conflict.settings)); form.reset(valuesFrom(conflict.kind, conflict.name, conflict.settings)); setConflict(undefined); }}
          onRetry={() => void form.handleSubmit((values) => submit(values, conflict.revision))()}
        />
      )}
      {error === undefined ? null : <p role="alert">Unable to save Preset: {error}</p>}
      <div className="editor-actions">
        <button type="submit" disabled={pending}>{creating ? 'Create Preset' : 'Save Preset'}</button>
        {preset === undefined ? null : (
          <>
            <button type="button" onClick={async () => { try { await api.exportPreset(preset.id); } catch (cause) { setError(errorCode(cause)); } }}>Export Preset</button>
            <button type="button" onClick={() => setDeleteOpen(true)}>Delete Preset</button>
          </>
        )}
      </div>
      <DeleteConfirmation noun="Preset" open={deleteOpen} pending={pending} onOpenChange={setDeleteOpen} onConfirm={() => void remove()} />
    </form>
  );
}
