import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFieldArray, useForm, type Control, type UseFormRegister } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api, errorCode, type CharacterView } from '../../api/client.js';
import { ImportDialog } from '../imports/ImportDialog.js';
import { CompatibilitySummary } from '../shared/CompatibilitySummary.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { DeleteConfirmation } from '../shared/DeleteConfirmation.js';
import { hasPatchFields, minimalPatch } from '../shared/minimalPatch.js';
import { useI18n } from '../../app/i18n.js';

const CharacterFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  firstMessage: z.string(),
  examples: z.string(),
  creatorNotes: z.string(),
  creator: z.string(),
  characterVersion: z.string(),
  systemPrompt: z.string(),
  postHistoryInstructions: z.string(),
  depthPrompt: z.string(),
  tags: z.array(z.object({ value: z.string() })),
  worldbookId: z.string(),
  alternateGreetings: z.array(z.object({ value: z.string() })),
});
type CharacterForm = z.infer<typeof CharacterFormSchema>;

const emptyCharacter: CharacterForm = {
  name: '', description: '', personality: '', scenario: '', firstMessage: '', examples: '', creatorNotes: '',
  creator: '', characterVersion: '', systemPrompt: '', postHistoryInstructions: '', depthPrompt: '', tags: [],
  worldbookId: '', alternateGreetings: [],
};

function formFromCharacter(value: CharacterView): CharacterForm {
  return {
    name: value.name,
    description: value.description,
    personality: value.personality,
    scenario: value.scenario,
    firstMessage: value.firstMessage,
    examples: value.examples,
    creatorNotes: value.creatorNotes,
    creator: value.creator,
    characterVersion: value.characterVersion,
    systemPrompt: value.systemPrompt,
    postHistoryInstructions: value.postHistoryInstructions,
    depthPrompt: value.depthPrompt,
    tags: value.tags.map((tag) => ({ value: tag })),
    worldbookId: value.worldbookId ?? '',
    alternateGreetings: value.alternateGreetings.map((alternate) => ({ value: alternate })),
  };
}

function fieldsFromForm(value: CharacterForm) {
  return {
    name: value.name.trim(),
    description: value.description,
    personality: value.personality,
    scenario: value.scenario,
    firstMessage: value.firstMessage,
    examples: value.examples,
    creatorNotes: value.creatorNotes,
    creator: value.creator,
    characterVersion: value.characterVersion,
    systemPrompt: value.systemPrompt,
    postHistoryInstructions: value.postHistoryInstructions,
    depthPrompt: value.depthPrompt,
    alternateGreetings: value.alternateGreetings.map((item) => item.value),
    tags: value.tags.map((tag) => tag.value),
  };
}

function CharacterTagField({ formControl, register }: {
  formControl: Control<CharacterForm>;
  register: UseFormRegister<CharacterForm>;
}) {
  const { t } = useI18n();
  const tags = useFieldArray({ control: formControl, name: 'tags' });
  return (
    <fieldset aria-label={t('Tags')}>
      <legend>{t('Tags')}</legend>
      {tags.fields.map((field, index) => (
        <div className="array-row" key={field.id}>
          <label>{t('Tag {{number}}', { number: index + 1 })}<input {...register(`tags.${index}.value`)} /></label>
          <button type="button" aria-label={t('Move tag {{number}} up', { number: index + 1 })} disabled={index === 0} onClick={() => tags.move(index, index - 1)}>↑</button>
          <button type="button" aria-label={t('Move tag {{number}} down', { number: index + 1 })} disabled={index === tags.fields.length - 1} onClick={() => tags.move(index, index + 1)}>↓</button>
          <button type="button" aria-label={t('Remove tag {{number}}', { number: index + 1 })} onClick={() => tags.remove(index)}>{t('Remove')}</button>
        </div>
      ))}
      <button type="button" onClick={() => tags.append({ value: '' })}>{t('Add tag')}</button>
    </fieldset>
  );
}

function createFromForm(value: CharacterForm) {
  return {
    ...fieldsFromForm(value),
    ...(value.worldbookId === '' ? {} : { worldbookId: value.worldbookId }),
  };
}

function patchFromForm(value: CharacterForm) {
  return {
    ...fieldsFromForm(value),
    worldbookId: value.worldbookId === '' ? null : value.worldbookId,
  };
}

const characterPatchFields = [
  'name', 'description', 'personality', 'scenario', 'firstMessage', 'examples', 'creatorNotes', 'creator',
  'characterVersion', 'systemPrompt', 'postHistoryInstructions', 'depthPrompt', 'alternateGreetings', 'tags',
  'worldbookId',
] as const;

function editableCharacter(value: CharacterView) {
  return { ...fieldsFromForm(formFromCharacter(value)), worldbookId: value.worldbookId ?? null };
}

export function CharacterLibraryPage() {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const characters = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters });
  const worldbooks = useQuery({ queryKey: ['worldbooks'], queryFn: api.listWorldbooks });
  const [selected, setSelected] = useState<CharacterView>();
  const [creating, setCreating] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<CharacterView>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [downloadType, setDownloadType] = useState<string>();
  const [search, setSearch] = useState('');
  const form = useForm<CharacterForm>({ resolver: zodResolver(CharacterFormSchema), defaultValues: emptyCharacter });
  const alternates = useFieldArray({ control: form.control, name: 'alternateGreetings' });

  const refreshList = () => queryClient.invalidateQueries({ queryKey: ['characters'] });
  const openCharacter = async (id: string) => {
    setLoadingDetail(true);
    setError(undefined);
    setConflict(undefined);
    try {
      const value = await api.getCharacter(id);
      setSelected(value);
      setCreating(false);
      form.reset(formFromCharacter(value));
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setLoadingDetail(false);
    }
  };
  const persist = async (values: CharacterForm, revision = selected?.revision) => {
    setPending(true);
    setError(undefined);
    try {
      const patch = creating ? undefined : minimalPatch(editableCharacter(selected!), patchFromForm(values), characterPatchFields);
      if (patch !== undefined && !hasPatchFields(patch)) return;
      const saved = creating
        ? await api.createManagedCharacter(createFromForm(values))
        : await api.updateCharacter(selected!.id, revision!, patch!);
      setSelected(saved);
      setCreating(false);
      setConflict(undefined);
      form.reset(formFromCharacter(saved));
      await refreshList();
    } catch (cause) {
      if (!creating && cause instanceof ApiError && cause.status === 409 && selected !== undefined) {
        try { setConflict(await api.getCharacter(selected.id)); } catch (loadError) { setError(errorCode(loadError)); }
      } else {
        setError(errorCode(cause));
      }
    } finally {
      setPending(false);
    }
  };
  const uploadAvatar = async (file: File | undefined) => {
    if (file === undefined || selected === undefined || pending) return;
    setPending(true);
    try {
      const updated = await api.uploadCharacterAvatar(selected.id, selected.revision, file);
      setSelected(updated);
      await refreshList();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    if (selected === undefined) return;
    setPending(true);
    try {
      await api.deleteCharacter(selected.id, selected.revision);
      setSelected(undefined);
      setDeleteOpen(false);
      form.reset(emptyCharacter);
      await refreshList();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="manager-page">
      <aside className="manager-sidebar">
        <h1>{t('Characters')}</h1>
        <input aria-label={t('Search Characters')} placeholder={t('Search')} value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="manager-list">
          {(characters.data ?? []).filter((character) => character.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((character) => (
            <button type="button" key={character.id} onClick={() => void openCharacter(character.id)}>{character.name}</button>
          ))}
        </div>
        <button type="button" onClick={() => { setSelected(undefined); setCreating(true); setConflict(undefined); form.reset(emptyCharacter); }}>{t('New Character')}</button>
        <button type="button" onClick={() => setImportOpen(true)}>{t('Import Character')}</button>
      </aside>
      <section className="manager-editor">
        {loadingDetail ? <p role="status">{t('Loading Character…')}</p> : null}
        {!creating && selected === undefined ? <p>{t('Select a Character to edit.')}</p> : (
          <form onSubmit={form.handleSubmit((values) => void persist(values))}>
            <h2>{creating ? t('New Character') : selected?.name}</h2>
            <CompatibilitySummary value={selected?.compatibilitySummary} />
            {selected?.avatarUrl === undefined ? null : <img className="avatar-preview" src={selected.avatarUrl} alt={language === 'en' ? `${selected.name} avatar` : `${selected.name} ${t('Character avatar')}`} />}
            <label>{t('Name')}<input {...form.register('name')} /></label>
            <label>{t('Description')}<textarea {...form.register('description')} /></label>
            <label>{t('Personality')}<textarea {...form.register('personality')} /></label>
            <label>{t('Scenario')}<textarea {...form.register('scenario')} /></label>
            <label>{t('First message')}<textarea {...form.register('firstMessage')} /></label>
            <label>{t('Message examples')}<textarea {...form.register('examples')} /></label>
            <label>{t('Creator notes')}<textarea {...form.register('creatorNotes')} /></label>
            <label>{t('Creator')}<input {...form.register('creator')} /></label>
            <label>{t('Character version')}<input {...form.register('characterVersion')} /></label>
            <label>{t('System prompt')}<textarea {...form.register('systemPrompt')} /></label>
            <label>{t('Post-history instructions')}<textarea {...form.register('postHistoryInstructions')} /></label>
            <label>{t('Depth prompt')}<textarea {...form.register('depthPrompt')} /></label>
            <CharacterTagField formControl={form.control} register={form.register} />
            <label>{t('Worldbook')}<select {...form.register('worldbookId')}><option value="">{t('None')}</option>{(worldbooks.data ?? []).map((book) => <option value={book.id} key={book.id}>{book.name}</option>)}</select></label>
            <fieldset>
              <legend>{t('Alternate greetings')}</legend>
              {alternates.fields.map((field, index) => (
                <div className="array-row" key={field.id}>
                  <label>{t('Alternate greeting {{number}}', { number: index + 1 })}<textarea {...form.register(`alternateGreetings.${index}.value`)} /></label>
                  <button type="button" aria-label={t('Move alternate greeting {{number}} up', { number: index + 1 })} disabled={index === 0} onClick={() => alternates.move(index, index - 1)}>↑</button>
                  <button type="button" aria-label={t('Move alternate greeting {{number}} down', { number: index + 1 })} disabled={index === alternates.fields.length - 1} onClick={() => alternates.move(index, index + 1)}>↓</button>
                  <button type="button" aria-label={t('Remove alternate greeting {{number}}', { number: index + 1 })} onClick={() => alternates.remove(index)}>{t('Remove')}</button>
                </div>
              ))}
              <button type="button" onClick={() => alternates.append({ value: '' })}>{t('Add alternate greeting')}</button>
            </fieldset>
            {form.formState.errors.name ? <p role="alert">{t(form.formState.errors.name.message ?? '')}</p> : null}
            {conflict === undefined ? null : (
              <ConflictBanner
                revision={conflict.revision}
                onReload={() => { setSelected(conflict); form.reset(formFromCharacter(conflict)); setConflict(undefined); }}
                onRetry={() => void form.handleSubmit((values) => persist(values, conflict.revision))()}
              />
            )}
            {error === undefined ? null : <p role="alert">{t('Unable to save Character: {{error}}', { error })}</p>}
            <div className="editor-actions">
              <button type="submit" disabled={pending}>{t(creating ? 'Create Character' : 'Save Character')}</button>
              {selected === undefined ? null : (
                <>
                  <label>{t('Avatar file')}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void uploadAvatar(event.target.files?.[0])} /></label>
                  <button type="button" onClick={async () => { try { setDownloadType((await api.exportCharacter(selected.id)).mimeType); } catch (cause) { setError(errorCode(cause)); } }}>{t('Export JSON V3')}</button>
                  <button type="button" onClick={() => setDeleteOpen(true)}>{t('Delete Character')}</button>
                </>
              )}
            </div>
            {downloadType === undefined ? null : <p>{downloadType}</p>}
          </form>
        )}
      </section>
      <ImportDialog open={importOpen} expectedKind="character" title={t('Import Character')} onOpenChange={setImportOpen} onCommitted={async (receipt) => { await refreshList(); if (receipt.entityId !== undefined) await openCharacter(receipt.entityId); }} />
      <DeleteConfirmation noun="Character" open={deleteOpen} pending={pending} onOpenChange={setDeleteOpen} onConfirm={() => void remove()} />
    </main>
  );
}
