import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiError, api, errorCode, type WorldbookEntryView, type WorldbookView } from '../../api/client.js';
import { ImportDialog } from '../imports/ImportDialog.js';
import { CompatibilitySummary } from '../shared/CompatibilitySummary.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { DeleteConfirmation } from '../shared/DeleteConfirmation.js';
import { hasPatchFields, minimalPatch } from '../shared/minimalPatch.js';
import { WorldbookEntryEditor } from './WorldbookEntryEditor.js';

const nullableNumber = z.string().refine((value) => value === '' || Number.isFinite(Number(value)), 'Enter a number');
const BookSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'), description: z.string(), enabled: z.boolean(),
  scanDepth: nullableNumber, tokenBudget: nullableNumber, recursiveScanning: z.boolean(), isGlobal: z.boolean(),
});
type BookForm = z.infer<typeof BookSchema>;
const emptyBook: BookForm = { name: '', description: '', enabled: true, scanDepth: '', tokenBudget: '', recursiveScanning: false, isGlobal: false };

function bookValues(value: WorldbookView): BookForm {
  return {
    name: value.name, description: value.description, enabled: value.enabled,
    scanDepth: value.scanDepth === null ? '' : String(value.scanDepth),
    tokenBudget: value.tokenBudget === null ? '' : String(value.tokenBudget),
    recursiveScanning: value.recursiveScanning, isGlobal: value.isGlobal,
  };
}

function bookPatch(value: BookForm) {
  return {
    name: value.name.trim(), description: value.description, enabled: value.enabled,
    scanDepth: value.scanDepth === '' ? null : Number(value.scanDepth),
    tokenBudget: value.tokenBudget === '' ? null : Number(value.tokenBudget),
    recursiveScanning: value.recursiveScanning, isGlobal: value.isGlobal,
  };
}

const bookPatchFields = ['name', 'description', 'enabled', 'scanDepth', 'tokenBudget', 'recursiveScanning', 'isGlobal'] as const;

function entryName(entry: WorldbookEntryView): string {
  return entry.displayName || entry.comment || 'Untitled entry';
}

export function WorldbookManagerPage() {
  const queryClient = useQueryClient();
  const books = useQuery({ queryKey: ['worldbooks'], queryFn: api.listWorldbooks });
  const [detail, setDetail] = useState<WorldbookView>();
  const [creating, setCreating] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [addingEntry, setAddingEntry] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<WorldbookView>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const form = useForm<BookForm>({ resolver: zodResolver(BookSchema), defaultValues: emptyBook });
  const refreshList = () => queryClient.invalidateQueries({ queryKey: ['worldbooks'] });

  useEffect(() => {
    if (detail !== undefined) form.reset(bookValues(detail));
  }, [detail?.id]);

  const openBook = async (id: string) => {
    setError(undefined);
    setConflict(undefined);
    setEditingEntryId(undefined);
    setAddingEntry(false);
    try {
      const value = await api.getWorldbook(id);
      setDetail(value);
      setCreating(false);
      form.reset(bookValues(value));
    } catch (cause) {
      setError(errorCode(cause));
    }
  };
  const saveBook = async (values: BookForm, revision = detail?.revision) => {
    setPending(true);
    setError(undefined);
    try {
      const next = bookPatch(values);
      const patch = creating ? undefined : minimalPatch(bookPatch(bookValues(detail!)), next, bookPatchFields);
      if (patch !== undefined && !hasPatchFields(patch)) return;
      const saved = creating
        ? await api.createWorldbook(next)
        : await api.updateWorldbook(detail!.id, revision!, patch!);
      setDetail(saved);
      setCreating(false);
      setConflict(undefined);
      form.reset(bookValues(saved));
      await refreshList();
    } catch (cause) {
      if (!creating && cause instanceof ApiError && cause.status === 409 && detail !== undefined) {
        try { setConflict(await api.getWorldbook(detail.id)); } catch (loadError) { setError(errorCode(loadError)); }
      } else setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const reorder = async (from: number, to: number) => {
    if (detail === undefined || to < 0 || to >= detail.entries.length || pending) return;
    const moved = [...detail.entries];
    const [entry] = moved.splice(from, 1);
    moved.splice(to, 0, entry!);
    setPending(true);
    try {
      const entries = await api.reorderWorldbookEntries(detail.id, moved.map((item, index) => ({ id: item.id, revision: item.revision, order: index })));
      setDetail({ ...detail, entries });
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const deleteEntry = async (entry: WorldbookEntryView) => {
    if (detail === undefined) return;
    setPending(true);
    try {
      await api.deleteWorldbookEntry(detail.id, entry.id, entry.revision);
      setDetail({ ...detail, entries: detail.entries.filter((candidate) => candidate.id !== entry.id) });
      if (editingEntryId === entry.id) setEditingEntryId(undefined);
      await refreshList();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const removeBook = async () => {
    if (detail === undefined) return;
    setPending(true);
    try {
      await api.deleteWorldbook(detail.id, detail.revision);
      setDetail(undefined);
      setDeleteOpen(false);
      await refreshList();
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const replaceEntry = (saved: WorldbookEntryView) => {
    if (detail === undefined) return;
    const exists = detail.entries.some((entry) => entry.id === saved.id);
    setDetail({ ...detail, entries: exists ? detail.entries.map((entry) => entry.id === saved.id ? saved : entry) : [...detail.entries, saved] });
    setEditingEntryId(saved.id);
    setAddingEntry(false);
    void refreshList();
  };
  const loadLatestEntry = async (entryId: string) => {
    if (detail === undefined) return undefined;
    const latest = await api.getWorldbook(detail.id);
    return latest.entries.find((entry) => entry.id === entryId);
  };
  const selectedEntry = detail?.entries.find((entry) => entry.id === editingEntryId);
  const bookValidationMessages = [
    form.formState.errors.name?.message,
    form.formState.errors.scanDepth?.message,
    form.formState.errors.tokenBudget?.message,
  ].filter((message): message is string => typeof message === 'string');

  return (
    <main className="manager-page worldbook-manager">
      <aside className="manager-sidebar">
        <h1>Worldbooks</h1>
        <div className="manager-list">
          {(books.data ?? []).map((book) => <button type="button" key={book.id} aria-label={`Edit Worldbook ${book.name}`} onClick={() => void openBook(book.id)}>{book.name} · {book.entryCount}</button>)}
        </div>
        <button type="button" onClick={() => { setDetail(undefined); setCreating(true); setEditingEntryId(undefined); form.reset(emptyBook); }}>New Worldbook</button>
        <button type="button" onClick={() => setImportOpen(true)}>Import Worldbook</button>
      </aside>
      <section className="manager-editor">
        {!creating && detail === undefined ? <p>Select a Worldbook to edit.</p> : (
          <>
            <form onSubmit={form.handleSubmit((values) => void saveBook(values))}>
              <h2>{creating ? 'New Worldbook' : detail?.name}</h2>
              <CompatibilitySummary value={detail?.compatibilitySummary} />
              <fieldset aria-label="Executable Worldbook settings">
                <legend>Executable Worldbook settings</legend>
                <label>Worldbook name<input {...form.register('name')} /></label>
                <label>Worldbook description<textarea {...form.register('description')} /></label>
                <label className="checkbox-label"><input type="checkbox" {...form.register('enabled')} />Worldbook enabled</label>
                <label>Worldbook scan depth<input type="number" {...form.register('scanDepth')} /></label>
                <label>Worldbook token budget<input type="number" {...form.register('tokenBudget')} /></label>
                <label className="checkbox-label"><input type="checkbox" {...form.register('recursiveScanning')} />Recursive scanning</label>
              </fieldset>
              <p>Editable executable Worldbook extensions are unavailable in this MVP. Preserved compatibility extensions are inert and are not executed.</p>
              <label className="checkbox-label"><input type="checkbox" {...form.register('isGlobal')} />Global Worldbook</label>
              {bookValidationMessages.length === 0 ? null : (
                <div role="alert" tabIndex={-1}>
                  <strong>Correct the Worldbook form</strong>
                  <ul>{[...new Set(bookValidationMessages)].map((message) => <li key={message}>{message}</li>)}</ul>
                </div>
              )}
              {conflict === undefined ? null : (
                <ConflictBanner revision={conflict.revision} onReload={() => { setDetail(conflict); form.reset(bookValues(conflict)); setConflict(undefined); }} onRetry={() => void form.handleSubmit((values) => saveBook(values, conflict.revision))()} />
              )}
              <div className="editor-actions">
                <button type="submit" disabled={pending}>{creating ? 'Create Worldbook' : 'Save Worldbook'}</button>
                {detail === undefined ? null : (
                  <>
                    <button type="button" onClick={async () => { try { await api.exportWorldbook(detail.id); } catch (cause) { setError(errorCode(cause)); } }}>Export Worldbook</button>
                    <button type="button" onClick={() => setDeleteOpen(true)}>Delete Worldbook</button>
                  </>
                )}
              </div>
            </form>
            {detail === undefined ? null : (
              <section className="entry-list" aria-label="Worldbook entries">
                <header><h3>Entries</h3><button type="button" onClick={() => { setAddingEntry(true); setEditingEntryId(undefined); }}>Add Worldbook entry</button></header>
                {detail.entries.map((entry, index) => (
                  <div className="entry-row" key={entry.id}>
                    <button type="button" aria-label={`Edit entry ${entryName(entry)}`} onClick={() => { setEditingEntryId(entry.id); setAddingEntry(false); }}>{entryName(entry)}</button>
                    <button type="button" aria-label={`Move entry ${entryName(entry)} up`} disabled={index === 0 || pending} onClick={() => void reorder(index, index - 1)}>↑</button>
                    <button type="button" aria-label={`Move entry ${entryName(entry)} down`} disabled={index === detail.entries.length - 1 || pending} onClick={() => void reorder(index, index + 1)}>↓</button>
                    <button type="button" aria-label={`Delete entry ${entryName(entry)}`} disabled={pending} onClick={() => void deleteEntry(entry)}>Delete</button>
                  </div>
                ))}
              </section>
            )}
            {detail !== undefined && (addingEntry || selectedEntry !== undefined) ? (
              <WorldbookEntryEditor
                worldbookId={detail.id}
                entry={selectedEntry}
                onSaved={replaceEntry}
                onCancel={() => { setEditingEntryId(undefined); setAddingEntry(false); }}
                loadLatest={loadLatestEntry}
              />
            ) : null}
          </>
        )}
        {error === undefined ? null : <p role="alert">Worldbook operation failed: {error}</p>}
      </section>
      <ImportDialog open={importOpen} expectedKind="worldbook" title="Import Worldbook" onOpenChange={setImportOpen} onCommitted={async (receipt) => { await refreshList(); if (receipt.entityId !== undefined) await openBook(receipt.entityId); }} />
      <DeleteConfirmation noun="Worldbook" open={deleteOpen} pending={pending} onOpenChange={setDeleteOpen} onConfirm={() => void removeBook()} />
    </main>
  );
}
