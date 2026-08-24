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

type PresetSelection = Pick<GlobalGenerationConfigPatch,
  'chatPresetId' | 'textPresetId' | 'contextPresetId' | 'instructPresetId' | 'systemPresetId'>;

const emptyPresetSelection: PresetSelection = {
  chatPresetId: null,
  textPresetId: null,
  contextPresetId: null,
  instructPresetId: null,
  systemPresetId: null,
};

export function ActiveProviderConfiguration({ providers }: { providers: ProviderProfileView[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const configuration = useQuery({ queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig });
  const [providerId, setProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (configuration.data !== undefined) setProviderId(configuration.data.providerId);
  }, [configuration.data]);

  const save = useMutation({
    mutationFn: () => api.saveGlobalGenerationConfig(configuration.data!.revision, { providerId }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['global-generation-config'], saved);
      void queryClient.invalidateQueries({ queryKey: ['active-resource-context'] });
      setProviderId(saved.providerId);
    },
  });

  return (
    <section className="global-generation-configuration" aria-labelledby="active-provider-configuration-heading">
      <div className="section-heading">
        <div>
          <h2 id="active-provider-configuration-heading">{t('Provider activation')}</h2>
          <span>{t('Used across every Conversation')}</span>
        </div>
      </div>
      {configuration.isLoading ? <p>{t('Loading generation configuration…')}</p> : null}
      {configuration.error ? (
        <p role="alert">{t('Unable to load generation configuration: {{error}}', {
          error: errorCode(configuration.error),
        })}</p>
      ) : null}
      {configuration.data?.selectionNotice?.kind === 'provider' ? (
        <p role="status">{t('The active Provider was cleared after deletion. Choose a replacement and save.')}</p>
      ) : null}
      <div className="connection-form-grid">
        <label>
          {t('Active Provider')}
          <select
            value={providerId ?? ''}
            onChange={(event) => {
              save.reset();
              setProviderId(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">{t('Not selected')}</option>
            {providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={configuration.data === undefined || save.isPending}
        onClick={() => { void save.mutateAsync().catch(() => undefined); }}
      >{t('Save active Provider')}</button>
      {save.isSuccess ? <span role="status">{t('Active Provider saved.')}</span> : null}
      {save.error ? <span role="alert">{t('Unable to save active Provider: {{error}}', { error: errorCode(save.error) })}</span> : null}
    </section>
  );
}

export function ActivePresetConfiguration() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const configuration = useQuery({ queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig });
  const [selection, setSelection] = useState<PresetSelection>(emptyPresetSelection);

  useEffect(() => {
    if (configuration.data === undefined) return;
    const { chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId } = configuration.data;
    setSelection({ chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId });
  }, [configuration.data]);

  const save = useMutation({
    mutationFn: () => api.saveGlobalGenerationConfig(configuration.data!.revision, selection),
    onSuccess: (saved) => {
      queryClient.setQueryData(['global-generation-config'], saved);
      void queryClient.invalidateQueries({ queryKey: ['active-resource-context'] });
      const { chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId } = saved;
      setSelection({ chatPresetId, textPresetId, contextPresetId, instructPresetId, systemPresetId });
    },
  });
  const setSelectionField = (key: keyof PresetSelection, value: string) => {
    save.reset();
    setSelection((current) => ({ ...current, [key]: value === '' ? null : value }));
  };
  const presetSelect = (label: string, key: keyof PresetSelection, kind: PresetKind) => (
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

  return (
    <section className="global-generation-configuration" aria-labelledby="active-preset-configuration-heading">
      <div className="section-heading">
        <div>
          <h2 id="active-preset-configuration-heading">{t('Active Presets')}</h2>
          <span>{t('Used across every Conversation')}</span>
        </div>
      </div>
      {configuration.isLoading || presets.isLoading ? <p>{t('Loading generation configuration…')}</p> : null}
      {configuration.error || presets.error ? (
        <p role="alert">{t('Unable to load generation configuration: {{error}}', {
          error: errorCode(configuration.error ?? presets.error),
        })}</p>
      ) : null}
      {configuration.data?.selectionNotice?.kind === 'preset' ? (
        <p role="status">{t('An active Preset was cleared after deletion. Choose a replacement and save.')}</p>
      ) : null}
      <div className="connection-form-grid">
        {presetSelect('Chat preset', 'chatPresetId', 'chat')}
        {presetSelect('Text preset', 'textPresetId', 'text')}
        {presetSelect('Context preset', 'contextPresetId', 'context')}
        {presetSelect('Instruct preset', 'instructPresetId', 'instruct')}
        {presetSelect('System preset', 'systemPresetId', 'system')}
      </div>
      <button
        type="button"
        disabled={configuration.data === undefined || save.isPending}
        onClick={() => { void save.mutateAsync().catch(() => undefined); }}
      >{t('Save active Presets')}</button>
      {save.isSuccess ? <span role="status">{t('Active Presets saved.')}</span> : null}
      {save.error ? <span role="alert">{t('Unable to save active Presets: {{error}}', { error: errorCode(save.error) })}</span> : null}
    </section>
  );
}
