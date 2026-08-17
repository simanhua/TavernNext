import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorCode, type PresetView } from '../../api/client.js';
import { ImportDialog } from '../imports/ImportDialog.js';
import { PresetEditor } from './PresetEditor.js';
import { useI18n } from '../../app/i18n.js';

function titleCase(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

export function PresetManagerPage() {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const [selected, setSelected] = useState<PresetView>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['presets'] });
  const openPreset = async (id: string) => {
    setError(undefined);
    try {
      setSelected(await api.getPreset(id));
      setCreating(false);
    } catch (cause) {
      setError(errorCode(cause));
    }
  };
  return (
    <main className="manager-page">
      <aside className="manager-sidebar">
        <h1>{t('Presets')}</h1>
        <div className="manager-list">
          {(presets.data ?? []).map((preset) => (
            <div key={preset.id} className="preset-row">
              <button type="button" aria-label={t('Edit preset {{name}}', { name: preset.name })} onClick={() => void openPreset(preset.id)}>{preset.name}</button>
              <span className="kind-badge">{language === 'en' ? titleCase(preset.kind) : t(preset.kind)}</span>
            </div>
          ))}
        </div>
        <button type="button" onClick={() => { setSelected(undefined); setCreating(true); }}>{t('New Preset')}</button>
        <button type="button" onClick={() => setImportOpen(true)}>{t('Import Preset')}</button>
      </aside>
      <section className="manager-editor">
        {error === undefined ? null : <p role="alert">{t('Unable to load Preset: {{error}}', { error })}</p>}
        {!creating && selected === undefined ? <p>{t('Select a Preset to edit.')}</p> : (
          <PresetEditor
            key={creating ? 'new' : selected!.id}
            preset={selected}
            creating={creating}
            onSaved={async (value) => { setSelected(value); setCreating(false); await refresh(); }}
            onDeleted={async () => { setSelected(undefined); await refresh(); }}
          />
        )}
      </section>
      <ImportDialog open={importOpen} expectedKind="preset" title={t('Import Preset')} onOpenChange={setImportOpen} onCommitted={async (receipt) => { await refresh(); if (receipt.entityId !== undefined) await openPreset(receipt.entityId); }} />
    </main>
  );
}
