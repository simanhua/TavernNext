import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';

export function useActiveExtensionAssetCollections(conversationId: string | null) {
  const generationConfig = useQuery({ queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig });
  const activeContext = useQuery({
    queryKey: ['active-resource-context', conversationId, generationConfig.data?.revision ?? null],
    queryFn: () => api.getActiveResourceContext(conversationId),
  });
  const owners = activeContext.data?.owners ?? [];
  const assetQueries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: ['extension-assets', owner.kind, owner.id, owner.revision],
      queryFn: () => api.getExtensionAssets(owner.kind, owner.id),
    })),
  });
  return {
    activeContext,
    owners,
    assetQueries,
    loading: activeContext.isLoading || assetQueries.some((query) => query.isLoading),
  };
}
