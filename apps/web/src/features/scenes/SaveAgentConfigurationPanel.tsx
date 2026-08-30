import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorCode, type SaveAgentConfiguration } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { RuntimePanelCloseButton } from '../shared/RuntimePanelCloseButton.js';
import { RuntimePanelIcon } from '../shared/RuntimePanelIcon.js';

function settingsText(configuration: SaveAgentConfiguration): string {
  return JSON.stringify(configuration.settings, null, 2);
}

export function SaveAgentConfigurationPanel({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const configuration = useQuery({
    queryKey: ['save-agent-configuration', conversationId],
    queryFn: () => api.getSaveAgentConfiguration(conversationId),
  });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const [name, setName] = useState('');
  const [settings, setSettings] = useState('{}');
  const [templateId, setTemplateId] = useState('');
  const [parseError, setParseError] = useState<string>();

  useEffect(() => {
    if (configuration.data === undefined) return;
    setName(configuration.data.name);
    setSettings(settingsText(configuration.data));
    setTemplateId(configuration.data.sourcePresetId ?? '');
    setParseError(undefined);
  }, [configuration.data]);

  const adopt = (value: SaveAgentConfiguration) => {
    queryClient.setQueryData(['save-agent-configuration', conversationId], value);
    setName(value.name);
    setSettings(settingsText(value));
    setTemplateId(value.sourcePresetId ?? '');
    setParseError(undefined);
  };
  const save = useMutation({
    mutationFn: (value: Record<string, unknown>) => api.updateSaveAgentConfiguration(
      conversationId,
      configuration.data!.revision,
      { name: name.trim(), settings: value },
    ),
    onSuccess: adopt,
  });
  const replace = useMutation({
    mutationFn: () => api.replaceSaveAgentConfiguration(
      conversationId,
      configuration.data!.revision,
      templateId,
    ),
    onSuccess: adopt,
  });
  const sync = useMutation({
    mutationFn: () => api.syncSaveAgentConfiguration(conversationId, configuration.data!.revision),
    onSuccess: adopt,
  });
  const busy = save.isPending || replace.isPending || sync.isPending;
  const mutationError = save.error ?? replace.error ?? sync.error;

  return (
    <details className="scene-agent-configuration">
      <summary><RuntimePanelIcon kind="configuration" /><span className="runtime-panel-title">{t('Save Agent configuration')}</span></summary>
      <RuntimePanelCloseButton label={t('Close Save Agent configuration')} text={t('Close')} />
      {configuration.isLoading || presets.isLoading ? <p>{t('Loading Agent configuration…')}</p> : null}
      {configuration.error || presets.error ? (
        <p role="alert">{t('Unable to load Agent configuration: {{error}}', {
          error: errorCode(configuration.error ?? presets.error),
        })}</p>
      ) : null}
      {configuration.data === undefined ? null : (
        <div className="scene-agent-configuration-form">
          <label>{t('Preset name')}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t('Executable settings JSON')}<textarea rows={12} value={settings} onChange={(event) => setSettings(event.target.value)} /></label>
          <button
            type="button"
            disabled={busy || name.trim() === ''}
            onClick={() => {
              try {
                const parsed = JSON.parse(settings) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid');
                setParseError(undefined);
                void save.mutateAsync(parsed as Record<string, unknown>).catch(() => undefined);
              } catch {
                setParseError(t('Executable settings must be a plain JSON object'));
              }
            }}
          >{t('Save configuration')}</button>
          <label>
            {t('Template')}
            <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">{t('Not selected')}</option>
              {(presets.data ?? []).filter((preset) => preset.kind === 'chat').map((preset) => (
                <option value={preset.id} key={preset.id}>
                  {preset.name}{preset.official ? ` · ${t('Official')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy || templateId === ''} onClick={() => { void replace.mutateAsync().catch(() => undefined); }}>
            {t('Replace from template')}
          </button>
          <button
            type="button"
            disabled={busy || configuration.data.sourcePresetId === null}
            onClick={() => {
              if (!window.confirm(t('Synchronizing discards all private Preset changes. Continue?'))) return;
              void sync.mutateAsync().catch(() => undefined);
            }}
          >{t('Synchronize template')}</button>
          {parseError === undefined ? null : <p role="alert">{parseError}</p>}
          {mutationError === null || mutationError === undefined ? null : (
            <p role="alert">{t('Unable to save Agent configuration: {{error}}', { error: errorCode(mutationError) })}</p>
          )}
        </div>
      )}
    </details>
  );
}
