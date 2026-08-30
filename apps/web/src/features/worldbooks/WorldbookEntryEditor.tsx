import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm, type Control, type UseFormRegister } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api, errorCode, type WorldbookEntryInput, type WorldbookEntryPatch, type WorldbookEntryView } from '../../api/client.js';
import { CompatibilitySummary } from '../shared/CompatibilitySummary.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { hasPatchFields, minimalPatch } from '../shared/minimalPatch.js';
import { useI18n } from '../../app/i18n.js';

const numeric = z.string().refine((value) => value !== '' && Number.isFinite(Number(value)), 'Enter a number');
const nullableNumeric = z.string().refine((value) => value === '' || Number.isFinite(Number(value)), 'Enter a number');
const triState = z.enum(['default', 'true', 'false']);
const StringItemSchema = z.object({ value: z.string() });
const FormSchema = z.object({
  keys: z.array(StringItemSchema), secondaryKeys: z.array(StringItemSchema), useRegex: z.boolean(), selective: z.boolean(), selectiveLogic: numeric,
  content: z.string(), enabled: z.boolean(), constant: z.boolean(), vectorized: z.boolean(), caseSensitive: triState,
  matchWholeWords: triState, position: z.string(), order: numeric, priority: nullableNumeric, probability: numeric,
  useProbability: z.boolean(), group: z.string(), groupWeight: numeric, groupOverride: z.boolean(), ignoreBudget: z.boolean(),
  scanDepth: nullableNumeric, useGroupScoring: triState, excludeRecursion: z.boolean(), preventRecursion: z.boolean(),
  delayUntilRecursion: z.string(), sticky: nullableNumeric, cooldown: nullableNumeric, delay: nullableNumeric,
  depth: numeric, role: numeric, outletName: z.string(),
  characterFilterNames: z.array(StringItemSchema), characterFilterTags: z.array(StringItemSchema), characterFilterExclude: z.boolean(),
  personaFilterNames: z.array(StringItemSchema), personaFilterTags: z.array(StringItemSchema), personaFilterExclude: z.boolean(),
  matchPersonaDescription: z.boolean(), matchCharacterDescription: z.boolean(), matchCharacterPersonality: z.boolean(),
  matchCharacterDepthPrompt: z.boolean(), matchScenario: z.boolean(), matchCreatorNotes: z.boolean(),
  comment: z.string(), displayName: z.string(), addMemo: z.boolean(), displayIndex: nullableNumeric,
  automationId: z.string(), triggers: z.array(StringItemSchema),
});
type FormValues = z.infer<typeof FormSchema>;
type StringArrayName = 'keys' | 'secondaryKeys' | 'characterFilterNames' | 'characterFilterTags'
  | 'personaFilterNames' | 'personaFilterTags' | 'triggers';

const emptyValues: FormValues = {
  keys: [], secondaryKeys: [], useRegex: true, selective: true, selectiveLogic: '0', content: '', enabled: true,
  constant: false, vectorized: false, caseSensitive: 'default', matchWholeWords: 'default', position: 'before_character',
  order: '0', priority: '', probability: '100', useProbability: true, group: '', groupWeight: '100',
  groupOverride: false, ignoreBudget: false, scanDepth: '', useGroupScoring: 'default', excludeRecursion: false,
  preventRecursion: false, delayUntilRecursion: '0', sticky: '', cooldown: '', delay: '', depth: '4', role: '0',
  outletName: '', characterFilterNames: [], characterFilterTags: [], characterFilterExclude: false,
  personaFilterNames: [], personaFilterTags: [], personaFilterExclude: false, matchPersonaDescription: false,
  matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
  matchScenario: false, matchCreatorNotes: false, comment: '', displayName: '', addMemo: false, displayIndex: '',
  automationId: '', triggers: [],
};

const stringItems = (values: string[]) => values.map((value) => ({ value }));
const nullableText = (value: number | null) => value === null ? '' : String(value);
const triText = (value: boolean | null): 'default' | 'true' | 'false' => value === null ? 'default' : value ? 'true' : 'false';
const triValue = (value: 'default' | 'true' | 'false'): boolean | null => value === 'default' ? null : value === 'true';
const numberOrString = (value: string): number | string => /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
const delayValue = (value: string): boolean | number => value === 'true' ? true : value === 'false' ? false : Number(value || 0);

function StringArrayField({ formControl, register, name, label }: {
  formControl: Control<FormValues>;
  register: UseFormRegister<FormValues>;
  name: StringArrayName;
  label: string;
}) {
  const { t } = useI18n();
  const translatedLabel = t(label);
  const items = useFieldArray({ control: formControl, name });
  return (
    <fieldset aria-label={translatedLabel}>
      <legend>{translatedLabel}</legend>
      {items.fields.map((field, index) => (
        <div className="array-row" key={field.id}>
          <label>{t('{{label}} {{number}}', { label: translatedLabel, number: index + 1 })}<input {...register(`${name}.${index}.value`)} /></label>
          <button type="button" aria-label={t('Move {{label}} {{number}} up', { label: translatedLabel, number: index + 1 })} disabled={index === 0} onClick={() => items.move(index, index - 1)}>↑</button>
          <button type="button" aria-label={t('Move {{label}} {{number}} down', { label: translatedLabel, number: index + 1 })} disabled={index === items.fields.length - 1} onClick={() => items.move(index, index + 1)}>↓</button>
          <button type="button" aria-label={t('Remove {{label}} {{number}}', { label: translatedLabel, number: index + 1 })} onClick={() => items.remove(index)}>{t('Remove')}</button>
        </div>
      ))}
      <button type="button" onClick={() => items.append({ value: '' })}>{t('Add {{label}}', { label: translatedLabel })}</button>
    </fieldset>
  );
}

function valuesFrom(entry: WorldbookEntryView): FormValues {
  return {
    keys: stringItems(entry.keys), secondaryKeys: stringItems(entry.secondaryKeys), useRegex: entry.useRegex,
    selective: entry.selective, selectiveLogic: String(entry.selectiveLogic), content: entry.content, enabled: entry.enabled,
    constant: entry.constant, vectorized: entry.vectorized, caseSensitive: triText(entry.caseSensitive),
    matchWholeWords: triText(entry.matchWholeWords), position: String(entry.position), order: String(entry.order),
    priority: nullableText(entry.priority), probability: String(entry.probability), useProbability: entry.useProbability,
    group: entry.group, groupWeight: String(entry.groupWeight), groupOverride: entry.groupOverride,
    ignoreBudget: entry.ignoreBudget, scanDepth: nullableText(entry.scanDepth), useGroupScoring: triText(entry.useGroupScoring),
    excludeRecursion: entry.excludeRecursion, preventRecursion: entry.preventRecursion,
    delayUntilRecursion: String(entry.delayUntilRecursion), sticky: nullableText(entry.sticky),
    cooldown: nullableText(entry.cooldown), delay: nullableText(entry.delay), depth: String(entry.depth), role: String(entry.role),
    outletName: entry.outletName, characterFilterNames: stringItems(entry.characterFilter.names),
    characterFilterTags: stringItems(entry.characterFilter.tags), characterFilterExclude: entry.characterFilter.isExclude,
    personaFilterNames: stringItems(entry.personaFilter.names), personaFilterTags: stringItems(entry.personaFilter.tags),
    personaFilterExclude: entry.personaFilter.isExclude, matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription, matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt, matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes, comment: entry.comment, displayName: entry.displayName,
    addMemo: entry.addMemo, displayIndex: nullableText(entry.displayIndex), automationId: entry.automationId,
    triggers: stringItems(entry.triggers),
  };
}

function payload(values: FormValues) {
  return {
    keys: values.keys.map((item) => item.value), secondaryKeys: values.secondaryKeys.map((item) => item.value), useRegex: values.useRegex,
    selective: values.selective, selectiveLogic: Number(values.selectiveLogic), content: values.content,
    enabled: values.enabled, constant: values.constant, vectorized: values.vectorized,
    caseSensitive: triValue(values.caseSensitive), matchWholeWords: triValue(values.matchWholeWords),
    position: numberOrString(values.position), order: Number(values.order),
    priority: values.priority === '' ? null : Number(values.priority), probability: Number(values.probability),
    useProbability: values.useProbability, group: values.group, groupWeight: Number(values.groupWeight),
    groupOverride: values.groupOverride, ignoreBudget: values.ignoreBudget,
    scanDepth: values.scanDepth === '' ? null : Number(values.scanDepth), useGroupScoring: triValue(values.useGroupScoring),
    excludeRecursion: values.excludeRecursion, preventRecursion: values.preventRecursion,
    delayUntilRecursion: delayValue(values.delayUntilRecursion), sticky: values.sticky === '' ? null : Number(values.sticky),
    cooldown: values.cooldown === '' ? null : Number(values.cooldown), delay: values.delay === '' ? null : Number(values.delay),
    depth: Number(values.depth), role: Number(values.role), outletName: values.outletName,
    characterFilter: { isExclude: values.characterFilterExclude, names: values.characterFilterNames.map((item) => item.value), tags: values.characterFilterTags.map((item) => item.value) },
    personaFilter: { isExclude: values.personaFilterExclude, names: values.personaFilterNames.map((item) => item.value), tags: values.personaFilterTags.map((item) => item.value) },
    matchPersonaDescription: values.matchPersonaDescription, matchCharacterDescription: values.matchCharacterDescription,
    matchCharacterPersonality: values.matchCharacterPersonality, matchCharacterDepthPrompt: values.matchCharacterDepthPrompt,
    matchScenario: values.matchScenario, matchCreatorNotes: values.matchCreatorNotes, comment: values.comment,
    displayName: values.displayName, addMemo: values.addMemo,
    displayIndex: values.displayIndex === '' ? null : Number(values.displayIndex), automationId: values.automationId,
    triggers: values.triggers.map((item) => item.value),
  };
}

type EntryPatch = ReturnType<typeof payload>;
const entryPatchFields = [
  'keys', 'secondaryKeys', 'useRegex', 'selective', 'selectiveLogic', 'content', 'enabled', 'constant', 'vectorized',
  'caseSensitive', 'matchWholeWords', 'position', 'order', 'priority', 'probability', 'useProbability', 'group',
  'groupWeight', 'groupOverride', 'ignoreBudget', 'scanDepth', 'useGroupScoring', 'excludeRecursion', 'preventRecursion',
  'delayUntilRecursion', 'sticky', 'cooldown', 'delay', 'depth', 'role', 'outletName', 'characterFilter',
  'personaFilter', 'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
  'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'comment', 'displayName', 'addMemo', 'displayIndex',
  'automationId', 'triggers',
] as const satisfies readonly (keyof EntryPatch)[];

export interface WorldbookEntryEditorOperations {
  create(input: WorldbookEntryInput): Promise<WorldbookEntryView>;
  update(entryId: string, revision: number, patch: WorldbookEntryPatch): Promise<WorldbookEntryView>;
}

export function WorldbookEntryEditor({ worldbookId, entry, onSaved, onCancel, loadLatest, operations }: {
  worldbookId: string;
  entry?: WorldbookEntryView;
  onSaved: (entry: WorldbookEntryView) => void;
  onCancel: () => void;
  loadLatest: (entryId: string) => Promise<WorldbookEntryView | undefined>;
  operations?: WorldbookEntryEditorOperations;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<WorldbookEntryView>();
  const [baseline, setBaseline] = useState(entry);
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: entry === undefined ? emptyValues : valuesFrom(entry) });
  const validationMessages = Object.values(form.formState.errors).flatMap((field) => (
    typeof field?.message === 'string' ? [field.message] : []
  ));
  useEffect(() => {
    form.reset(entry === undefined ? emptyValues : valuesFrom(entry));
    setBaseline(entry);
    setConflict(undefined);
  }, [entry?.id]);

  const save = async (values: FormValues, revision = baseline?.revision) => {
    setPending(true);
    setError(undefined);
    try {
      const next = payload(values);
      const patch = baseline === undefined ? undefined : minimalPatch(payload(valuesFrom(baseline)), next, entryPatchFields);
      if (patch !== undefined && !hasPatchFields(patch)) return;
      const saved = baseline === undefined
        ? await (operations?.create(next) ?? api.createWorldbookEntry(worldbookId, next))
        : await (operations?.update(baseline.id, revision!, patch!)
          ?? api.updateWorldbookEntry(worldbookId, baseline.id, revision!, patch!));
      setConflict(undefined);
      setBaseline(saved);
      form.reset(valuesFrom(saved));
      onSaved(saved);
    } catch (cause) {
      if (baseline !== undefined && cause instanceof ApiError && cause.status === 409) {
        try { setConflict(await loadLatest(baseline.id)); } catch (loadError) { setError(errorCode(loadError)); }
      } else setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="worldbook-entry-editor" onSubmit={form.handleSubmit((values) => void save(values))}>
      <h3>{entry === undefined ? t('New Worldbook entry') : entry.displayName || t('Worldbook entry')}</h3>
      {entry?.sourceUid === undefined ? null : <p>{t('Source UID: {{type}} {{uid}} · ordinal {{ordinal}}', { type: typeof entry.sourceUid, uid: String(entry.sourceUid), ordinal: entry.sourceOrdinal ?? '' })}</p>}
      <CompatibilitySummary value={entry?.compatibilitySummary} />
      <StringArrayField formControl={form.control} register={form.register} name="keys" label="Primary keys" />
      <StringArrayField formControl={form.control} register={form.register} name="secondaryKeys" label="Secondary keys" />
      <label className="checkbox-label"><input type="checkbox" {...form.register('useRegex')} />{t('Use regular expressions')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('selective')} />{t('Selective activation')}</label>
      <label>{t('Selective logic')}<input type="number" {...form.register('selectiveLogic')} /></label>
      <label>{t('Entry content')}<textarea {...form.register('content')} /></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('enabled')} />{t('Entry enabled')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('constant')} />{t('Constant activation')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('vectorized')} />{t('Vectorized')}</label>
      <label>{t('Case sensitive')}<select {...form.register('caseSensitive')}><option value="default">{t('Default')}</option><option value="true">{t('Yes')}</option><option value="false">{t('No')}</option></select></label>
      <label>{t('Whole-word matching')}<select {...form.register('matchWholeWords')}><option value="default">{t('Default')}</option><option value="true">{t('Yes')}</option><option value="false">{t('No')}</option></select></label>
      <label>{t('Position')}<input {...form.register('position')} /></label>
      <label>{t('Order')}<input type="number" {...form.register('order')} /></label>
      <label>{t('Priority')}<input type="number" {...form.register('priority')} /></label>
      <label>{t('Probability')}<input type="number" {...form.register('probability')} /></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('useProbability')} />{t('Use probability')}</label>
      <label>{t('Group')}<input {...form.register('group')} /></label>
      <label>{t('Group weight')}<input type="number" {...form.register('groupWeight')} /></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('groupOverride')} />{t('Group override')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('ignoreBudget')} />{t('Ignore token budget')}</label>
      <label>{t('Entry scan depth')}<input type="number" {...form.register('scanDepth')} /></label>
      <label>{t('Use group scoring')}<select {...form.register('useGroupScoring')}><option value="default">{t('Default')}</option><option value="true">{t('Yes')}</option><option value="false">{t('No')}</option></select></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('excludeRecursion')} />{t('Exclude recursion')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('preventRecursion')} />{t('Prevent recursion')}</label>
      <label>{t('Delay until recursion')}<input {...form.register('delayUntilRecursion')} /></label>
      <label>{t('Sticky')}<input type="number" {...form.register('sticky')} /></label>
      <label>{t('Cooldown')}<input type="number" {...form.register('cooldown')} /></label>
      <label>{t('Delay')}<input type="number" {...form.register('delay')} /></label>
      <label>{t('Depth')}<input type="number" {...form.register('depth')} /></label>
      <label>{t('Role')}<input type="number" {...form.register('role')} /></label>
      <label>{t('Outlet')}<input {...form.register('outletName')} /></label>
      <StringArrayField formControl={form.control} register={form.register} name="characterFilterNames" label="Character filter names" />
      <StringArrayField formControl={form.control} register={form.register} name="characterFilterTags" label="Character filter tags" />
      <label className="checkbox-label"><input type="checkbox" {...form.register('characterFilterExclude')} />{t('Exclude Character filter')}</label>
      <StringArrayField formControl={form.control} register={form.register} name="personaFilterNames" label="Persona filter names" />
      <StringArrayField formControl={form.control} register={form.register} name="personaFilterTags" label="Persona filter tags" />
      <label className="checkbox-label"><input type="checkbox" {...form.register('personaFilterExclude')} />{t('Exclude Persona filter')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchPersonaDescription')} />{t('Match Persona description')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchCharacterDescription')} />{t('Match Character description')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchCharacterPersonality')} />{t('Match Character personality')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchCharacterDepthPrompt')} />{t('Match Character depth prompt')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchScenario')} />{t('Match scenario')}</label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('matchCreatorNotes')} />{t('Match creator notes')}</label>
      <label>{t('Comment')}<input {...form.register('comment')} /></label>
      <label>{t('Display name')}<input {...form.register('displayName')} /></label>
      <label className="checkbox-label"><input type="checkbox" {...form.register('addMemo')} />{t('Add memo')}</label>
      <label>{t('Display index')}<input type="number" {...form.register('displayIndex')} /></label>
      <label>{t('Automation ID')}<input {...form.register('automationId')} /></label>
      <StringArrayField formControl={form.control} register={form.register} name="triggers" label="Triggers" />
      {validationMessages.length === 0 ? null : (
        <div role="alert" tabIndex={-1}>
          <strong>{t('Correct the Worldbook entry form')}</strong>
          <ul>{[...new Set(validationMessages)].map((message) => <li key={message}>{t(message)}</li>)}</ul>
        </div>
      )}
      {conflict === undefined ? null : (
        <ConflictBanner
          revision={conflict.revision}
          onReload={() => { setBaseline(conflict); form.reset(valuesFrom(conflict)); setConflict(undefined); onSaved(conflict); }}
          onRetry={() => void form.handleSubmit((values) => save(values, conflict.revision))()}
        />
      )}
      {error === undefined ? null : <p role="alert">{t('Unable to save Worldbook entry: {{error}}', { error })}</p>}
      <div className="editor-actions">
        <button type="submit" disabled={pending}>{t(entry === undefined ? 'Create Worldbook entry' : 'Save Worldbook entry')}</button>
        <button type="button" onClick={onCancel}>{t('Close entry editor')}</button>
      </div>
    </form>
  );
}
