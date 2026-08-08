import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '../../api/client.js';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string(),
  firstMessage: z.string(),
});
type Values = z.infer<typeof schema>;

export function CharacterQuickCreate() {
  const queryClient = useQueryClient();
  const { register, handleSubmit, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema), defaultValues: { name: '', description: '', firstMessage: '' },
  });
  const create = useMutation({
    mutationFn: api.createCharacter,
    onSuccess: async () => { reset(); await queryClient.invalidateQueries({ queryKey: ['characters'] }); },
  });
  return (
    <form className="quick-create" onSubmit={handleSubmit((values) => create.mutate(values))}>
      <h3>Quick-create Character</h3>
      <label>Name<input {...register('name')} /></label>
      {formState.errors.name ? <span role="alert">{formState.errors.name.message}</span> : null}
      <label>Description<textarea {...register('description')} /></label>
      <label>First message<textarea {...register('firstMessage')} /></label>
      <button type="submit" disabled={create.isPending}>Create Character</button>
    </form>
  );
}
