import { parsedRegexAssets, type TavernRegex } from '@tavernnext/extension-runtime';
import { useActiveExtensionAssetCollections } from '../extensions/useActiveExtensionAssetCollections.js';

export interface ActiveRegexScripts {
  preset: TavernRegex[];
  character: TavernRegex[];
}

const EMPTY: ActiveRegexScripts = { preset: [], character: [] };

export function useActiveRegexScripts(conversationId: string | null): ActiveRegexScripts {
  const { owners, assetQueries } = useActiveExtensionAssetCollections(conversationId);
  if (owners.length === 0 || assetQueries.some((query) => query.data === undefined)) return EMPTY;
  const scripts: ActiveRegexScripts = { preset: [], character: [] };
  owners.forEach((owner, index) => {
    scripts[owner.kind].push(...parsedRegexAssets(assetQueries[index]?.data?.assets ?? []));
  });
  return scripts;
}
