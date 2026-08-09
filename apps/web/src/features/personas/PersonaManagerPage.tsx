import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api, errorCode, type PersonaView } from '../../api/client.js';
import { CompatibilitySummary } from '../shared/CompatibilitySummary.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { DeleteConfirmation } from '../shared/DeleteConfirmation.js';
import { hasPatchFields, minimalPatch } from '../shared/minimalPatch.js';

const PersonaFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string(),
  isDefault: z.boolean(),
});
type PersonaForm = z.infer<typeof PersonaFormSchema>;
const emptyPersona: PersonaForm = { name: '', description: '', isDefault: false };

export function PersonaManagerPage() {
  const queryClient = useQueryClient();
  const personas = useQuery({ queryKey: ['personas'], queryFn: api.listPersonas });
  const [selected, setSelected] = useState<PersonaView>();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<PersonaView>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const form = useForm<PersonaForm>({ resolver: zodResolver(PersonaFormSchema), defaultValues: emptyPersona });
  const resetFrom = (value: PersonaView) => form.reset({ name: value.name, description: value.description, isDefault: value.isDefault });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['personas'] });

  const openPersona = async (id: string) => {
    setError(undefined);
    setConflict(undefined);
    try {
      const value = await api.getPersona(id);
      setSelected(value);
      setCreating(false);
      resetFrom(value);
    } catch (cause) {
      setError(errorCode(cause));
    }
  };
  const persist = async (values: PersonaForm, revision = selected?.revision) => {
    setPending(true);
    setError(undefined);
    try {
      const next = { ...values, name: values.name.trim() };
      const patch = creating ? undefined : minimalPatch(
        { name: selected!.name, description: selected!.description, isDefault: selected!.isDefault },
        next,
        ['name', 'description', 'isDefault'] as const,
      );
      if (patch !== undefined && !hasPatchFields(patch)) return;
      const saved = creating
        ? await api.createPersona(next)
        : await api.updatePersona(selected!.id, revision!, patch!);
      setSelected(saved);
      setCreating(false);
      setConflict(undefined);
      resetFrom(saved);
      await refresh();
    } catch (cause) {
      if (!creating && cause instanceof ApiError && cause.status === 409 && selected !== undefined) {
        try { setConflict(await api.getPersona(selected.id)); } catch (loadError) { setError(errorCode(loadError)); }
      } else setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const uploadAvatar = async (file: File | undefined) => {
    if (file === undefined || selected === undefined) return;
    setPending(true);
    try {
      const saved = await api.uploadPersonaAvatar(selected.id, selected.revision, file);
      setSelected(saved);
      await refresh();
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
      await api.deletePersona(selected.id, selected.revision);
      setSelected(undefined);
      setDeleteOpen(false);
      form.reset(emptyPersona);
      await refresh();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="manager-page">
      <aside className="manager-sidebar">
        <h1>Personas</h1>
        <div className="manager-list">
          {(personas.data ?? []).map((persona) => (
            <button type="button" key={persona.id} aria-label={`Edit persona ${persona.name}`} onClick={() => void openPersona(persona.id)}>
              {persona.name}{persona.isDefault ? ' · Default' : ''}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => { setSelected(undefined); setCreating(true); setConflict(undefined); form.reset(emptyPersona); }}>New Persona</button>
      </aside>
      <section className="manager-editor">
        {!creating && selected === undefined ? <p>Select a Persona to edit.</p> : (
          <form onSubmit={form.handleSubmit((values) => void persist(values))}>
            <h2>{creating ? 'New Persona' : selected?.name}</h2>
            <CompatibilitySummary value={selected?.compatibilitySummary} />
            {selected?.avatarUrl === undefined ? null : <img className="avatar-preview" src={selected.avatarUrl} alt={`${selected.name} avatar`} />}
            <label>Name<input {...form.register('name')} /></label>
            <label>Description<textarea {...form.register('description')} /></label>
            <label className="checkbox-label"><input type="checkbox" {...form.register('isDefault')} />Default Persona</label>
            {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
            {conflict === undefined ? null : (
              <ConflictBanner
                revision={conflict.revision}
                onReload={() => { setSelected(conflict); resetFrom(conflict); setConflict(undefined); }}
                onRetry={() => void form.handleSubmit((values) => persist(values, conflict.revision))()}
              />
            )}
            {error === undefined ? null : <p role="alert">Unable to save Persona: {error}</p>}
            <div className="editor-actions">
              <button type="submit" disabled={pending}>{creating ? 'Create Persona' : 'Save Persona'}</button>
              {selected === undefined ? null : (
                <>
                  <label>Avatar file<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void uploadAvatar(event.target.files?.[0])} /></label>
                  <button type="button" onClick={() => setDeleteOpen(true)}>Delete Persona</button>
                </>
              )}
            </div>
          </form>
        )}
      </section>
      <DeleteConfirmation noun="Persona" open={deleteOpen} pending={pending} onOpenChange={setDeleteOpen} onConfirm={() => void remove()} />
    </main>
  );
}
