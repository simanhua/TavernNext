import { useEffect, useState } from 'react';
import { api, errorCode, type WorldbookEntryView, type WorldbookView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { WorldbookEntryEditor } from '../worldbooks/WorldbookEntryEditor.js';

function entryName(entry: WorldbookEntryView): string {
  return entry.displayName.trim() || entry.comment.trim() || entry.keys[0] || `#${entry.sourceOrdinal ?? entry.order}`;
}

export function SaveWorldbookEditor({ conversationId, value, onChanged, onClose }: {
  conversationId: string;
  value: WorldbookView;
  onChanged(value: WorldbookView): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState(value);
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [addingEntry, setAddingEntry] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState(value.name);
  const [description, setDescription] = useState(value.description);
  const [enabled, setEnabled] = useState(value.enabled);
  const [scanDepth, setScanDepth] = useState(value.scanDepth === null ? '' : String(value.scanDepth));
  const [tokenBudget, setTokenBudget] = useState(value.tokenBudget === null ? '' : String(value.tokenBudget));
  const [recursiveScanning, setRecursiveScanning] = useState(value.recursiveScanning);

  useEffect(() => {
    setDetail(value);
    setName(value.name);
    setDescription(value.description);
    setEnabled(value.enabled);
    setScanDepth(value.scanDepth === null ? '' : String(value.scanDepth));
    setTokenBudget(value.tokenBudget === null ? '' : String(value.tokenBudget));
    setRecursiveScanning(value.recursiveScanning);
  }, [value.id]);

  const replace = (next: WorldbookView) => {
    setDetail(next);
    onChanged(next);
  };
  const saveBook = async () => {
    setPending(true);
    setError(undefined);
    try {
      const next = await api.updateSaveWorldbook(conversationId, detail.id, detail.revision, {
        name: name.trim(), description, enabled,
        scanDepth: scanDepth === '' ? null : Number(scanDepth),
        tokenBudget: tokenBudget === '' ? null : Number(tokenBudget),
        recursiveScanning,
      });
      replace(next);
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const reorder = async (from: number, to: number) => {
    if (to < 0 || to >= detail.entries.length) return;
    const moved = [...detail.entries];
    const [entry] = moved.splice(from, 1);
    moved.splice(to, 0, entry!);
    setPending(true);
    setError(undefined);
    try {
      const entries = await api.reorderSaveWorldbookEntries(
        conversationId,
        detail.id,
        moved.map((item, index) => ({ id: item.id, revision: item.revision, order: index })),
      );
      replace({ ...detail, entries });
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const removeEntry = async (entry: WorldbookEntryView) => {
    setPending(true);
    setError(undefined);
    try {
      await api.deleteSaveWorldbookEntry(conversationId, detail.id, entry.id, entry.revision);
      replace({ ...detail, entries: detail.entries.filter((candidate) => candidate.id !== entry.id) });
      if (editingEntryId === entry.id) setEditingEntryId(undefined);
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const replaceEntry = (entry: WorldbookEntryView) => {
    const exists = detail.entries.some((candidate) => candidate.id === entry.id);
    replace({
      ...detail,
      entries: exists
        ? detail.entries.map((candidate) => candidate.id === entry.id ? entry : candidate)
        : [...detail.entries, entry],
    });
    setEditingEntryId(entry.id);
    setAddingEntry(false);
  };
  const selectedEntry = detail.entries.find((entry) => entry.id === editingEntryId);

  return (
    <section className="save-worldbook-editor" aria-label={t('Edit Save Worldbook')}>
      <header className="scene-reference-section-heading">
        <h3>{t('Edit Save Worldbook')}</h3>
        <button type="button" onClick={onClose}>{t('Back')}</button>
      </header>
      <p>{t('This is an independent Save copy. Changes do not affect the Scene template or other Saves.')}</p>
      <label>{t('Worldbook name')}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('Worldbook description')}<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t('Worldbook enabled')}</label>
      <label>{t('Worldbook scan depth')}<input type="number" value={scanDepth} onChange={(event) => setScanDepth(event.target.value)} /></label>
      <label>{t('Worldbook token budget')}<input type="number" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={recursiveScanning} onChange={(event) => setRecursiveScanning(event.target.checked)} />{t('Recursive scanning')}</label>
      <button type="button" disabled={pending || name.trim() === ''} onClick={() => void saveBook()}>{t('Save Worldbook')}</button>

      <header className="scene-reference-section-heading">
        <h3>{t('Worldbook entries')}</h3>
        <button type="button" onClick={() => { setAddingEntry(true); setEditingEntryId(undefined); }}>{t('Add Worldbook entry')}</button>
      </header>
      <div className="save-worldbook-entry-list">
        {detail.entries.map((entry, index) => (
          <div className="entry-row" key={entry.id}>
            <button type="button" onClick={() => { setEditingEntryId(entry.id); setAddingEntry(false); }}>{entryName(entry)}</button>
            <button type="button" aria-label={t('Move entry {{name}} up', { name: entryName(entry) })} disabled={pending || index === 0} onClick={() => void reorder(index, index - 1)}>↑</button>
            <button type="button" aria-label={t('Move entry {{name}} down', { name: entryName(entry) })} disabled={pending || index === detail.entries.length - 1} onClick={() => void reorder(index, index + 1)}>↓</button>
            <button type="button" disabled={pending} onClick={() => void removeEntry(entry)}>{t('Delete')}</button>
          </div>
        ))}
      </div>
      {addingEntry || selectedEntry !== undefined ? (
        <WorldbookEntryEditor
          worldbookId={detail.id}
          entry={selectedEntry}
          onSaved={replaceEntry}
          onCancel={() => { setAddingEntry(false); setEditingEntryId(undefined); }}
          loadLatest={async (entryId) => detail.entries.find((entry) => entry.id === entryId)}
          operations={{
            create: (input) => api.createSaveWorldbookEntry(conversationId, detail.id, input),
            update: (entryId, revision, patch) => api.updateSaveWorldbookEntry(
              conversationId, detail.id, entryId, revision, patch,
            ),
          }}
        />
      ) : null}
      {error === undefined ? null : <p role="alert">{t('Worldbook operation failed: {{error}}', { error: t(error) })}</p>}
    </section>
  );
}
