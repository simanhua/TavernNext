import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorCode } from '../../api/client.js';

const schema = z.object({
  name: z.string().trim().min(1, 'Display name is required'),
  baseUrl: z.string().url('Enter a valid Base URL'),
  model: z.string().trim().min(1, 'Model is required'),
  apiKey: z.string(),
  apiMode: z.enum(['chat', 'text']),
});
type Values = z.infer<typeof schema>;

export function ConnectionPage() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const current = providers.data?.[0];
  const { register, handleSubmit, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '', apiMode: 'chat' },
  });
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
    onSuccess: async () => {
      reset((values) => ({ ...values, apiKey: '' }));
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });

  return (
    <main className="settings-page">
      <h1>Connection</h1>
      <p>Configure the local server's OpenAI-compatible provider. The saved key is never returned to this browser.</p>
      <form onSubmit={handleSubmit((values) => { void save.mutateAsync(values).catch(() => undefined); })}>
        <label>Display name<input {...register('name')} /></label>
        <label>Base URL<input type="url" {...register('baseUrl')} /></label>
        <label>Model<input {...register('model')} /></label>
        <label>
          API key
          <input type="password" autoComplete="new-password" placeholder={current?.hasApiKey ? 'Saved key (leave blank to keep)' : ''} {...register('apiKey')} />
        </label>
        <label>Mode<select {...register('apiMode')}><option value="chat">Chat</option><option value="text">Text</option></select></label>
        {current !== undefined && !current.hasApiKey ? (
          <p role="status">The API key is not loaded. Re-enter it after a server restart or Base URL change.</p>
        ) : null}
        {Object.values(formState.errors).map((error) => <span role="alert" key={error.message}>{error.message}</span>)}
        {save.error ? <span role="alert">Unable to save connection: {errorCode(save.error)}</span> : null}
        <button type="submit" disabled={save.isPending}>Save connection</button>
        {save.isSuccess ? <span role="status">Connection saved{save.data.hasApiKey ? ' with an API key' : ''}.</span> : null}
      </form>
    </main>
  );
}
