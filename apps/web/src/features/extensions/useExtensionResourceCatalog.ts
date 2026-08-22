import { useQueries, useQuery } from '@tanstack/react-query';
import {
  api,
  type ActiveResourceContextView,
  type EditableExtensionAssetView,
  type ExtensionAssetCollectionView,
  type ExtensionTrustReviewView,
} from '../../api/client.js';
import { asRecord, isRecord } from './extension-resource-utils.js';

export type ResourceCatalogView = 'current' | 'all';
export type ResourceSourceFilter = 'all' | 'character' | 'preset';

export interface ResourceCatalogItem {
  key: string;
  owner: ActiveResourceContextView['owners'][number];
  collection: ExtensionAssetCollectionView;
  asset: EditableExtensionAssetView;
  name: string;
  nodeType: 'script' | 'folder' | 'regex';
  nodeEnabled: boolean;
  activeOwner: boolean;
}

function helperChildren(value: Record<string, unknown>): unknown[] {
  for (const key of ['children', 'scripts', 'value']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function helperCatalogNodes(
  value: unknown,
  base: Omit<ResourceCatalogItem, 'key' | 'name' | 'nodeType' | 'nodeEnabled'>,
  path = 'root',
  inheritedEnabled = base.asset.enabled,
): ResourceCatalogItem[] {
  if (!isRecord(value)) return [{
    ...base,
    key: `${base.owner.kind}:${base.owner.id}:${base.asset.sourceKey}:${path}`,
    name: base.asset.sourceKey,
    nodeType: 'script',
    nodeEnabled: inheritedEnabled,
  }];
  const nodeType = value.type === 'folder' ? 'folder' : 'script';
  const nodeEnabled = inheritedEnabled && value.enabled !== false;
  const current: ResourceCatalogItem = {
    ...base,
    key: `${base.owner.kind}:${base.owner.id}:${base.asset.sourceKey}:${path}`,
    name: String(value.name ?? value.id ?? base.asset.sourceKey),
    nodeType,
    nodeEnabled,
  };
  return [
    current,
    ...helperChildren(value).flatMap((child, ordinal) => helperCatalogNodes(child, base, `${path}.${ordinal}`, nodeEnabled)),
  ];
}

export function useExtensionResourceCatalog(input: {
  activeConversationId: string | null;
  view: ResourceCatalogView;
  activeKind: EditableExtensionAssetView['kind'];
  search: string;
  sourceFilter: ResourceSourceFilter;
}) {
  const generationConfig = useQuery({ queryKey: ['global-generation-config'], queryFn: api.getGlobalGenerationConfig });
  const activeContext = useQuery({
    queryKey: ['active-resource-context', input.activeConversationId, generationConfig.data?.revision ?? null],
    queryFn: () => api.getActiveResourceContext(input.activeConversationId),
  });
  const characters = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters, enabled: input.view === 'all' });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets, enabled: input.view === 'all' });
  const contextOwners = activeContext.data?.owners ?? [];
  const allOwners: ActiveResourceContextView['owners'] = [
    ...(characters.data ?? []).map(({ id, revision, name }) => ({ kind: 'character' as const, id, revision, name })),
    ...(presets.data ?? []).map(({ id, revision, name }) => ({ kind: 'preset' as const, id, revision, name })),
  ];
  const owners = input.view === 'current' ? contextOwners : allOwners;
  const activeOwnerKeys = new Set(contextOwners.map((owner) => `${owner.kind}:${owner.id}`));
  const assetQueries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: ['extension-assets', owner.kind, owner.id, owner.revision],
      queryFn: () => api.getExtensionAssets(owner.kind, owner.id),
    })),
  });
  const trustQueries = useQueries({
    queries: owners.map((owner) => ({
      queryKey: ['extension-trust', owner.kind, owner.id, owner.revision],
      queryFn: () => api.getExtensionTrust(owner.kind, owner.id),
    })),
  });
  const assetsLoading = assetQueries.some((query) => query.isLoading);
  const loading = assetsLoading || (input.view === 'all' && (characters.isLoading || presets.isLoading));
  const catalog = owners.flatMap((owner, ownerIndex): ResourceCatalogItem[] => {
    const collection = assetQueries[ownerIndex]?.data;
    if (collection === undefined) return [];
    return collection.assets.flatMap((asset) => {
      const base = { owner, collection, asset, activeOwner: activeOwnerKeys.has(`${owner.kind}:${owner.id}`) };
      if (asset.kind === 'regex') {
        const payload = asRecord(asset.payload);
        return [{
          ...base,
          key: `${owner.kind}:${owner.id}:${asset.sourceKey}`,
          name: String(payload.scriptName ?? payload.id ?? asset.sourceKey),
          nodeType: 'regex' as const,
          nodeEnabled: asset.enabled,
        }];
      }
      return helperCatalogNodes(asset.payload, base);
    });
  });
  const normalizedSearch = input.view === 'all' ? input.search.trim().toLocaleLowerCase() : '';
  const sourceFilter = input.view === 'all' ? input.sourceFilter : 'all';
  const filteredCatalog = catalog.filter((item) => (
    (sourceFilter === 'all' || item.owner.kind === sourceFilter)
    && (normalizedSearch === '' || item.name.toLocaleLowerCase().includes(normalizedSearch))
  ));
  const visibleCatalog = filteredCatalog.filter((item) => item.asset.kind === input.activeKind);
  const trustFor = (owner: ResourceCatalogItem['owner']): ExtensionTrustReviewView | undefined => {
    const index = owners.findIndex((candidate) => candidate.kind === owner.kind && candidate.id === owner.id);
    return index < 0 ? undefined : trustQueries[index]?.data;
  };
  const statusesFor = (item: ResourceCatalogItem) => [
    ...(item.activeOwner ? [] : ['Inactive source']),
    item.nodeEnabled ? 'Enabled' : 'Disabled',
    ...(item.asset.kind === 'tavern_helper'
      ? [trustFor(item.owner)?.trusted === true ? 'Trusted' : 'Untrusted']
      : []),
  ];
  return {
    activeContext,
    catalog,
    filteredCatalog,
    visibleCatalog,
    loading,
    normalizedSearch,
    statusesFor,
  };
}
