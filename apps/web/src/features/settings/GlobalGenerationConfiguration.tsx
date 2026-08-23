import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  errorCode,
  type GlobalGenerationConfigPatch,
  type PresetKind,
  type ProviderProfileView,
} from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

const emptySelection: GlobalGenerationConfigPatch = {
  providerId: null,
  chatPresetId: null,
  textPresetId: null,
  contextPresetId: null,
  instructPresetId: null,
  systemPresetId: null,
};

export function ActiveGenerationConfiguration({ providers }: { providers: ProviderProfileView[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const configuration = useQuery({ queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig });
  const [selection, setSelection] = useState<GlobalGenerationConfigPatch>(emptySelection);

  useEffect(() => {
    if (configuration.data === undefined) return;
    const { providerId, chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId } = configuration.data;
    setSelection({ providerId, chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId });
  }, [configuration.data]);

  const save = useMutation({
    mutationFn: () => api.saveGlobalGenerationConfig(configuration.data!.revision, selection),
    onSuccess: (saved) => {
      queryClient.setQueryData(['global-generation-config'], saved);
      void queryClient.invalidateQueries({ queryKey: ['active-resource-context'] });
      const { providerId, chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId } = saved;
      setSelection({ providerId, chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId });
    },
  });
  const setSelectionField = (key: keyof GlobalGenerationConfigPatch, value: string) => {
    save.reset();
    setSelection((current) => ({ ...current, [key]: value === '' ? null : value }));
  };
  const presetSelect = (label: string, key: keyof GlobalGenerationConfigPatch, kind: PresetKind) => (
    <label>
      {t(label)}
      <select value={selection[key] ?? ''} onChange={(event) => setSelectionField(key, event.target.value)}>
        <option value="">{t('Not selected')}</option>
        {(presets.data ?? []).filter((preset) => preset.kind === kind).map((preset) => (
          <option value={preset.id} key={preset.id}>{preset.name}</option>
        ))}
      </select>
    </label>
  );
  const provider = providers.find((candidate) => candidate.id === selection.providerId);
  const missingPrimary = provider?.apiMode === 'chat'
    ? selection.chatPresetId === null
    : provider?.apiMode === 'text' ? selection.textPresetId === null : false;

  return (
    <section className="global-generation-configuration" aria-labelledby="global-generation-configuration-heading">
      <div className="section-heading">
        <div>
          <h2 id="global-generation-configuration-heading">{t('Active generation configuration')}</h2>
          <span>{t('Used across every Conversation')}</span>
        </div>
      </div>
      {configuration.isLoading || presets.isLoading ? <p>{t('Loading generation configuration…')}</p> : null}
      {configuration.error || presets.error ? (
        <p role="alert">{t('Unable to load generation configuration: {{error}}', {
          error: errorCode(configuration.error ?? presets.error),
        })}</p>
      ) : null}
      {configuration.data?.selectionNotice === undefined || configuration.data.selectionNotice === null ? null : (
        <p role="status">{t('An active {{kind}} selection was cleared after deletion. Choose a replacement and save.', {
          kind: configuration.data.selectionNotice.kind,
        })}</p>
      )}
      <div className="connection-form-grid">
        <label>
          {t('Active Provider')}
          <select value={selection.providerId ?? ''} onChange={(event) => setSelectionField('providerId', event.target.value)}>
            <option value="">{t('Not selected')}</option>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        {presetSelect('Chat Preset', 'chatPresetId', 'chat')}
        {presetSelect('Text Preset', 'textPresetId', 'text')}
        {presetSelect('Context Preset', 'contextPresetId', 'context')}
        {presetSelect('Instruct Preset', 'instructPresetId', 'instruct')}
        {presetSelect('System Preset', 'systemPresetId', 'system')}
      </div>
      {provider?.apiMode === 'chat' && selection.chatPresetId === null
        ? <p role="alert">{t('Select a Chat Preset for the active Chat Provider.')}</p>
        : null}
      {provider?.apiMode === 'text' && selection.textPresetId === null
        ? <p role="alert">{t('Select a Text Preset for the active Text Provider.')}</p>
        : null}
      <button
        type="button"
        disabled={configuration.data === undefined || save.isPending || missingPrimary}
        onClick={() => { void save.mutateAsync().catch(() => undefined); }}
      >{t('Save active generation configuration')}</button>
      {save.isSuccess ? <span role="status">{t('Active generation configuration saved.')}</span> : null}
      {save.error ? <span role="alert">{t('Unable to save generation configuration: {{error}}', { error: errorCode(save.error) })}</span> : null}
    </section>
  );
}
