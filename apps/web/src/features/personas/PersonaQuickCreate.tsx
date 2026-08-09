import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, errorCode } from '../../api/client.js';

const schema = z.object({ name: z.string().trim().min(1, 'Name is required'), description: z.string() });
type Values = z.infer<typeof schema>;

export function PersonaQuickCreate() {
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
      <h3>Quick-create Persona</h3>
      <label>Name<input {...register('name')} /></label>
      {formState.errors.name ? <span role="alert">{formState.errors.name.message}</span> : null}
      <label>Description<textarea {...register('description')} /></label>
      {create.error ? <span role="alert">Unable to create Persona: {errorCode(create.error)}</span> : null}
      <button type="submit" disabled={create.isPending}>Create Persona</button>
    </form>
  );
}
