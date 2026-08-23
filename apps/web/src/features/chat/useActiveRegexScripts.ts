import { parsedRegexAssets, type TavernRegex } from '@tavernnext/extension-runtime';
import { useActiveExtensionAssetCollections } from '../extensions/useActiveExtensionAssetCollections.js';

export interface ActiveRegexScripts {
  preset: TavernRegex[];
  character: TavernRegex[];
}

const EMPTY: ActiveRegexScripts = { preset: [], character: [] };

export function useActiveRegexScripts(conversationId: string | null): { scripts: ActiveRegexScripts; ready: boolean } {
  const { owners, assetQueries, loading, activeContext } = useActiveExtensionAssetCollections(conversationId);
  if (loading || activeContext.data === undefined || assetQueries.some((query) => query.data === undefined)) {
    return { scripts: EMPTY, ready: false };
  }
  const scripts: ActiveRegexScripts = { preset: [], character: [] };
  owners.forEach((owner, index) => {
    scripts[owner.kind].push(...parsedRegexAssets(assetQueries[index]?.data?.assets ?? []));
  });
  return { scripts, ready: true };
}
