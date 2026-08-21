import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';

export function useGlobalGenerationConfiguration() {
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
  const configuration = useQuery({
    queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig,
  });
  const provider = providers.data?.find((candidate) => candidate.id === configuration.data?.providerId);
  const primaryId = provider?.apiMode === 'text' ? configuration.data?.textPresetId : configuration.data?.chatPresetId;
  const primaryKind = provider?.apiMode === 'text' ? 'text' : 'chat';
  const primaryValid = presets.data?.some((preset) => preset.id === primaryId && preset.kind === primaryKind) === true;
  const companionsValid = provider?.apiMode !== 'text' || (
    presets.data?.some((preset) => preset.id === configuration.data?.contextPresetId && preset.kind === 'context') === true
    && presets.data?.some((preset) => preset.id === configuration.data?.instructPresetId && preset.kind === 'instruct') === true
    && presets.data?.some((preset) => preset.id === configuration.data?.systemPresetId && preset.kind === 'system') === true
  );
  return {
    ready: provider !== undefined && primaryValid && companionsValid,
    isLoading: providers.isLoading || presets.isLoading || configuration.isLoading,
    error: providers.error ?? presets.error ?? configuration.error,
  };
}
