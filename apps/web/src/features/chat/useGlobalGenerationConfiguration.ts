import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';

export function useGlobalGenerationConfiguration() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const configuration = useQuery({
    queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig,
  });
  const provider = providers.data?.find((candidate) => candidate.id === configuration.data?.providerId);
  const primaryValid = presets.data?.some((preset) => (
    preset.id === configuration.data?.chatPresetId && preset.kind === 'chat'
  )) === true;
  return {
    ready: provider !== undefined && primaryValid,
    isLoading: providers.isLoading || presets.isLoading || configuration.isLoading,
    error: providers.error ?? presets.error ?? configuration.error,
  };
}
