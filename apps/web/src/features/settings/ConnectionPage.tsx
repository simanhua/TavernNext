import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  api,
  errorCode,
  type ProviderCatalogEntryView,
  type ProviderModelView,
  type ProviderProbeInput,
} from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { ActiveProviderConfiguration } from './GlobalGenerationConfiguration.js';

const schema = z.object({
  name: z.string().trim().min(1, 'Display name is required'),
  providerId: z.string().trim().min(1, 'Provider is required'),
  modelId: z.string().trim().min(1, 'Model is required'),
  customBaseUrl: z.string(),
  toolCalls: z.boolean(),
  apiKey: z.string(),
}).superRefine((value, context) => {
  if (value.providerId !== 'custom-openai-compatible') return;
  if (!z.string().url().safeParse(value.customBaseUrl).success) context.addIssue({
    code: 'custom', path: ['customBaseUrl'], message: 'Enter a valid Base URL',
  });
});
type Values = z.infer<typeof schema>;

const emptyValues: Values = {
  name: '',
  providerId: 'custom-openai-compatible',
  modelId: '',
  customBaseUrl: 'http://127.0.0.1:8080/v1',
  toolCalls: false,
  apiKey: '',
};

function firstAgentModel(provider: ProviderCatalogEntryView | undefined): string {
  return provider?.models.find((model) => model.toolCalls)?.id ?? '';
}

export function ConnectionPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const catalog = useQuery({ queryKey: ['provider-catalog'], queryFn: api.listProviderCatalog });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>();
  const current = selectedProviderId === null || selectedProviderId === undefined
    ? undefined
    : providers.data?.find((provider) => provider.id === selectedProviderId);
  const [detectedModels, setDetectedModels] = useState<ProviderModelView[]>([]);
  const { register, handleSubmit, reset, getValues, setValue, trigger, watch, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: emptyValues,
  });
  const selectedCatalogId = watch('providerId');
  const selectedCatalog = catalog.data?.find((provider) => provider.id === selectedCatalogId);
  const customEndpoint = selectedCatalog?.customBaseUrl ?? selectedCatalogId === 'custom-openai-compatible';
  const providerActionable = selectedCatalog?.available !== false;

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
    reset({
      name: current.name,
      providerId: current.providerId,
      modelId: current.modelId,
      customBaseUrl: current.customBaseUrl ?? current.baseUrl,
      toolCalls: current.toolCalls,
      apiKey: '',
    });
  }, [current, reset]);

  const save = useMutation({
    mutationFn: (values: Values) => api.saveProvider({
      ...(current === undefined ? {} : { id: current.id, revision: current.revision }),
      name: values.name,
      providerId: values.providerId,
      modelId: values.modelId,
      ...(values.providerId === 'custom-openai-compatible'
        ? { customBaseUrl: values.customBaseUrl, toolCalls: values.toolCalls }
        : {}),
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
      baseUrl: values.customBaseUrl,
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
  const chooseCatalogProvider = (providerId: string) => {
    const metadata = catalog.data?.find((provider) => provider.id === providerId);
    setValue('providerId', providerId, { shouldDirty: true, shouldValidate: true });
    setValue('modelId', firstAgentModel(metadata), { shouldDirty: true, shouldValidate: true });
    if (current === undefined && getValues('name').trim() === '') {
      setValue('name', metadata?.name ?? '', { shouldDirty: true, shouldValidate: true });
    }
    resetOperationState();
  };
  const validateCustomEndpointThen = async (operation: () => void) => {
    if (await trigger('customBaseUrl')) operation();
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
      <p>{t('Choose a Pi Provider and Agent-capable model. Saved credentials are never returned to this browser.')}</p>
      <ActiveProviderConfiguration providers={providers.data ?? []} />
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
              <span className="saved-connection-name"><strong>{provider.name}</strong><small>{provider.modelId}</small></span>
              <span className={`connection-key-status ${provider.hasApiKey ? 'connection-key-saved' : ''}`}>
                {t(provider.hasApiKey ? 'API key saved' : 'API key required')}
              </span>
            </button>
          ))}
        </div>
      </section>
      <form onSubmit={handleSubmit((values) => { void save.mutateAsync(values).catch(() => undefined); })}>
        <h2>{t(current === undefined ? 'New connection' : 'Edit connection')}</h2>
        {catalog.isLoading ? <p>{t('Loading Provider catalog…')}</p> : null}
        {catalog.error ? <p role="alert">{t('Unable to load Provider catalog: {{error}}', { error: errorCode(catalog.error) })}</p> : null}
        <div className="connection-form-grid">
          <label>{t('Display name')}<input {...register('name')} /></label>
          <label>
            {t('Provider')}
            <select
              aria-label={t('Provider')}
              value={selectedCatalogId}
              onChange={(event) => chooseCatalogProvider(event.target.value)}
            >
              {(catalog.data ?? []).map((provider) => (
                <option value={provider.id} key={provider.id} disabled={!provider.available}>
                  {provider.name}{provider.available ? '' : ` — ${t('Unavailable')}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <section aria-label={t('Unavailable Providers')}>
          {(catalog.data ?? []).filter((provider) => !provider.available).map((provider) => (
            <p key={provider.id}><strong>{provider.name}</strong>: {t(provider.unavailableReason ?? 'This Provider is unavailable.')}</p>
          ))}
        </section>
        {!providerActionable ? (
          <p role="status">{t('This Provider is documentation-only and cannot be configured in TavernNext.')}</p>
        ) : null}
        {customEndpoint ? (
          <>
            <label>{t('Model')}<input disabled={!providerActionable} list="detected-provider-models" {...register('modelId')} /></label>
            <label>Base URL<input disabled={!providerActionable} type="url" {...register('customBaseUrl')} /></label>
            <label><input disabled={!providerActionable} type="checkbox" {...register('toolCalls')} />{t('Model supports tool calls')}</label>
          </>
        ) : (
          <label>
            {t('Model')}
            <select disabled={!providerActionable} {...register('modelId')}>
              {(selectedCatalog?.models ?? []).filter((model) => model.toolCalls).map((model) => (
                <option value={model.id} key={model.id}>{model.name}</option>
              ))}
            </select>
          </label>
        )}
        <datalist id="detected-provider-models">{detectedModels.map((model) => <option value={model.id} key={model.id} />)}</datalist>
        <label>
          {t(selectedCatalog?.credentialLabel ?? 'API key')}
          <input disabled={!providerActionable} type="password" aria-label={t('API key')} autoComplete="new-password" placeholder={current?.hasApiKey ? t('Saved key (leave blank to keep)') : ''} {...register('apiKey')} />
        </label>
        {customEndpoint ? (
          <div className="connection-probe-actions">
            <button
              type="button"
              disabled={probing || !providerActionable}
              onClick={() => { void validateCustomEndpointThen(() => connectionProbe.mutate(probeInput())); }}
            >{connectionProbe.isPending ? t('Checking connection…') : t('Test connection')}</button>
            <button
              type="button"
              disabled={probing || !providerActionable}
              onClick={() => { void validateCustomEndpointThen(() => modelProbe.mutate(probeInput())); }}
            >{modelProbe.isPending ? t('Detecting models…') : t('Detect models')}</button>
          </div>
        ) : null}
        {connectionProbe.isSuccess ? <p className="probe-result probe-result-success" role="status">{t('Connection successful. {{count}} models available.', { count: connectionProbe.data.modelCount })}</p> : null}
        {connectionProbe.error ? <p className="probe-result" role="alert">{t('Connection test failed: {{error}}', { error: t(errorCode(connectionProbe.error)) })}</p> : null}
        {modelProbe.error ? <p className="probe-result" role="alert">{t('Model detection failed: {{error}}', { error: t(errorCode(modelProbe.error)) })}</p> : null}
        {detectedModels.length === 0 ? null : (
          <section className="detected-models" aria-label={t('Detected models')}>
            <div><strong>{t('Detected models')}</strong><span>{t('{{count}} models', { count: detectedModels.length })}</span></div>
            <div className="detected-model-list">
              {detectedModels.map((model) => (
                <button disabled={!providerActionable} type="button" key={model.id} onClick={() => setValue('modelId', model.id, { shouldDirty: true, shouldValidate: true })}>
                  {model.id}
                </button>
              ))}
            </div>
          </section>
        )}
        {current !== undefined && !current.hasApiKey ? (
          <p role="status">{t('The API key is not loaded. Re-enter it after a server restart or endpoint change.')}</p>
        ) : null}
        {Object.values(formState.errors).map((error) => <span role="alert" key={error.message}>{t(error.message ?? '')}</span>)}
        {save.error ? <span role="alert">{t('Unable to save connection: {{error}}', { error: errorCode(save.error) })}</span> : null}
        <button className="save-connection-button" type="submit" disabled={!providerActionable || save.isPending || probing}>{t('Save connection')}</button>
        {save.isSuccess ? <span role="status">{t(save.data.hasApiKey ? 'Connection saved with an API key.' : 'Connection saved.')}</span> : null}
      </form>
    </main>
  );
}
