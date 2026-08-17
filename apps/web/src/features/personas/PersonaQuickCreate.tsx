import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorCode } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

const schema = z.object({ name: z.string().trim().min(1, 'Name is required'), description: z.string() });
type Values = z.infer<typeof schema>;

export function PersonaQuickCreate() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { register, handleSubmit, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema), defaultValues: { name: '', description: '' },
  });
  const create = useMutation({
    mutationFn: api.createPersona,
    onSuccess: async () => { reset(); await queryClient.invalidateQueries({ queryKey: ['personas'] }); },
  });
  return (
    <form className="quick-create" onSubmit={handleSubmit((values) => { void create.mutateAsync(values).catch(() => undefined); })}>
      <h3>{t('Quick-create Persona')}</h3>
      <label>{t('Name')}<input {...register('name')} /></label>
      {formState.errors.name ? <span role="alert">{t(formState.errors.name.message ?? '')}</span> : null}
      <label>{t('Description')}<textarea {...register('description')} /></label>
      {create.error ? <span role="alert">{t('Unable to create Persona: {{error}}', { error: errorCode(create.error) })}</span> : null}
      <button type="submit" disabled={create.isPending}>{t('Create Persona')}</button>
    </form>
  );
}
