import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorCode, type ProviderModelView, type ProviderProbeInput } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { ActiveGenerationConfiguration } from './GlobalGenerationConfiguration.js';

const schema = z.object({
  name: z.string().trim().min(1, 'Display name is required'),
  baseUrl: z.string().url('Enter a valid Base URL'),
  model: z.string().trim().min(1, 'Model is required'),
  apiKey: z.string(),
  apiMode: z.enum(['chat', 'text']),
});
type Values = z.infer<typeof schema>;

const emptyValues: Values = {
  name: '',
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: '',
  apiKey: '',
  apiMode: 'chat',
};

const providerTemplates: Array<Values & { id: string; description: string }> = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek official OpenAI-compatible API',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: '',
    apiMode: 'chat',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    description: 'OpenCode curated model gateway',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'deepseek-v4-flash',
    apiKey: '',
    apiMode: 'chat',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    description: 'OpenCode low-cost subscription gateway',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4-flash',
    apiKey: '',
    apiMode: 'chat',
  },
  {
    id: 'custom',
    name: 'OpenAI-compatible',
    description: 'Local or custom OpenAI-compatible service',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: '',
    apiKey: '',
    apiMode: 'chat',
  },
];

export function ConnectionPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>();
  const current = selectedProviderId === null || selectedProviderId === undefined
    ? undefined
    : providers.data?.find((provider) => provider.id === selectedProviderId);
  const [detectedModels, setDetectedModels] = useState<ProviderModelView[]>([]);
  const { register, handleSubmit, reset, getValues, setValue, trigger, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: emptyValues,
  });

  useEffect(() => {
    if (providers.data === undefined) return;
    if (selectedProviderId === undefined) {
      setSelectedProviderId(providers.data[0]?.id ?? null);
      return;
    }
    if (selectedProviderId !== null && !providers.data.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(providers.data[0]?.id ?? null);
    }
  }, [providers.data, selectedProviderId]);

  useEffect(() => {
    if (current === undefined) return;
    reset({ name: current.name, baseUrl: current.baseUrl, model: current.model, apiMode: current.apiMode, apiKey: '' });
  }, [current, reset]);

  const save = useMutation({
    mutationFn: (values: Values) => api.saveProvider({
      ...(current === undefined ? {} : { id: current.id, revision: current.revision }),
      name: values.name, baseUrl: values.baseUrl, model: values.model, apiMode: values.apiMode,
      ...(values.apiKey.trim() === '' ? {} : { apiKey: values.apiKey }),
    }),
    onSuccess: async (saved) => {
      reset((values) => ({ ...values, apiKey: '' }));
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      setSelectedProviderId(saved.id);
    },
  });
  const probeInput = (): ProviderProbeInput => {
    const values = getValues();
    return {
      ...(current === undefined ? {} : { id: current.id }),
      baseUrl: values.baseUrl,
      ...(values.apiKey.trim() === '' ? {} : { apiKey: values.apiKey }),
    };
  };
  const connectionProbe = useMutation({ mutationFn: api.probeProvider });
  const modelProbe = useMutation({
    mutationFn: api.detectProviderModels,
    onSuccess: ({ models }) => setDetectedModels(models),
  });
  const probing = connectionProbe.isPending || modelProbe.isPending;
  const resetOperationState = () => {
    setDetectedModels([]);
    connectionProbe.reset();
    modelProbe.reset();
    save.reset();
  };
  const selectProvider = (id: string) => {
    setSelectedProviderId(id);
    resetOperationState();
  };
  const createProvider = () => {
    setSelectedProviderId(null);
    reset(emptyValues);
    resetOperationState();
  };
  const applyTemplate = (template: Values) => {
    setSelectedProviderId(null);
    reset(template);
    resetOperationState();
  };
  const validateThen = async (operation: () => void) => {
    if (await trigger('baseUrl')) operation();
  };

  return (
    <main className="settings-page">
      <header className="settings-header">
        <div>
          <span>{t('Provider gateway')}</span>
          <h1>{t('Connection')}</h1>
        </div>
        <span className="settings-security-note">{t('API keys stay on this device')}</span>
      </header>
      <p>{t("Configure the local server's OpenAI-compatible provider. The saved key is never returned to this browser.")}</p>
      <ActiveGenerationConfiguration providers={providers.data ?? []} />
      <section className="saved-connections" aria-labelledby="saved-connections-heading">
        <div className="section-heading">
          <div>
            <h2 id="saved-connections-heading">{t('Saved connections')}</h2>
            <span>{t('{{count}} saved connections', { count: providers.data?.length ?? 0 })}</span>
          </div>
          <button type="button" onClick={createProvider}>{t('New connection')}</button>
        </div>
        {providers.isLoading ? <p>{t('Loading connections…')}</p> : null}
        {providers.isError ? <p role="alert">{t('Unable to load connections: {{error}}', { error: errorCode(providers.error) })}</p> : null}
        {providers.data?.length === 0 ? <p className="saved-connections-empty">{t('No connections saved yet.')}</p> : null}
        <div className="saved-connection-list">
          {(providers.data ?? []).map((provider) => (
            <button
              type="button"
              key={provider.id}
              className={provider.id === selectedProviderId ? 'saved-connection-active' : undefined}
              aria-current={provider.id === selectedProviderId ? 'true' : undefined}
              aria-label={t('Edit {{provider}} connection', { provider: provider.name })}
              onClick={() => selectProvider(provider.id)}
            >
              <span className="saved-connection-name"><strong>{provider.name}</strong><small>{provider.model}</small></span>
              <span className={`connection-key-status ${provider.hasApiKey ? 'connection-key-saved' : ''}`}>
                {t(provider.hasApiKey ? 'API key saved' : 'API key required')}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="provider-template-section" aria-labelledby="provider-templates-heading">
        <div className="section-heading">
          <h2 id="provider-templates-heading">{t('Provider presets')}</h2>
          <span>{t('Choose a preset, then enter your API key.')}</span>
        </div>
        <div className="provider-templates">
          {providerTemplates.map((template) => (
            <button
              className={`provider-template provider-template-${template.id}`}
              type="button"
              key={template.id}
              aria-label={t('Use {{provider}} preset', { provider: template.name })}
              onClick={() => applyTemplate(template)}
            >
              <span className="provider-template-mark" aria-hidden="true">{template.name.slice(0, 1)}</span>
              <span><strong>{template.name}</strong><small>{t(template.description)}</small></span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </section>
      <form onSubmit={handleSubmit((values) => { void save.mutateAsync(values).catch(() => undefined); })}>
        <h2>{t(current === undefined ? 'New connection' : 'Edit connection')}</h2>
        <div className="connection-form-grid">
          <label>{t('Display name')}<input {...register('name')} /></label>
          <label>Base URL<input type="url" {...register('baseUrl')} /></label>
        </div>
        <label>{t('Model')}<input list="detected-provider-models" {...register('model')} /></label>
        <datalist id="detected-provider-models">{detectedModels.map((model) => <option value={model.id} key={model.id} />)}</datalist>
        <label>
          {t('API key')}
          <input type="password" autoComplete="new-password" placeholder={current?.hasApiKey ? t('Saved key (leave blank to keep)') : ''} {...register('apiKey')} />
        </label>
        <label>{t('Mode')}<select {...register('apiMode')}><option value="chat">{t('Chat')}</option><option value="text">{t('Text')}</option></select></label>
        <div className="connection-probe-actions">
          <button
            type="button"
            disabled={probing}
            onClick={() => { void validateThen(() => connectionProbe.mutate(probeInput())); }}
          >{connectionProbe.isPending ? t('Checking connection…') : t('Test connection')}</button>
          <button
            type="button"
            disabled={probing}
            onClick={() => { void validateThen(() => modelProbe.mutate(probeInput())); }}
          >{modelProbe.isPending ? t('Detecting models…') : t('Detect models')}</button>
        </div>
        {connectionProbe.isSuccess ? <p className="probe-result probe-result-success" role="status">{t('Connection successful. {{count}} models available.', { count: connectionProbe.data.modelCount })}</p> : null}
        {connectionProbe.error ? <p className="probe-result" role="alert">{t('Connection test failed: {{error}}', { error: t(errorCode(connectionProbe.error)) })}</p> : null}
        {modelProbe.error ? <p className="probe-result" role="alert">{t('Model detection failed: {{error}}', { error: t(errorCode(modelProbe.error)) })}</p> : null}
        {detectedModels.length === 0 ? null : (
          <section className="detected-models" aria-label={t('Detected models')}>
            <div><strong>{t('Detected models')}</strong><span>{t('{{count}} models', { count: detectedModels.length })}</span></div>
            <div className="detected-model-list">
              {detectedModels.map((model) => (
                <button type="button" key={model.id} onClick={() => setValue('model', model.id, { shouldDirty: true, shouldValidate: true })}>
                  {model.id}
                </button>
              ))}
            </div>
          </section>
        )}
        {current !== undefined && !current.hasApiKey ? (
          <p role="status">{t('The API key is not loaded. Re-enter it after a server restart or Base URL change.')}</p>
        ) : null}
        {Object.values(formState.errors).map((error) => <span role="alert" key={error.message}>{t(error.message ?? '')}</span>)}
        {save.error ? <span role="alert">{t('Unable to save connection: {{error}}', { error: errorCode(save.error) })}</span> : null}
        <button className="save-connection-button" type="submit" disabled={save.isPending || probing}>{t('Save connection')}</button>
        {save.isSuccess ? <span role="status">{t(save.data.hasApiKey ? 'Connection saved with an API key.' : 'Connection saved.')}</span> : null}
      </form>
    </main>
  );
}
