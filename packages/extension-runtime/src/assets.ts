import type { ExtensionAssetKind } from '@tavernnext/domain';
import { TavernRegexSchema, type TavernRegex } from './regex.js';

export function parsedRegexAssets(assets: ReadonlyArray<{
  kind: ExtensionAssetKind; ordinal: number; payload: unknown; enabled?: boolean;
}>): TavernRegex[] {
  return assets.filter((asset) => asset.kind === 'regex' && asset.enabled !== false).sort((a, b) => a.ordinal - b.ordinal).flatMap((asset) => {
    const result = TavernRegexSchema.safeParse(asset.payload);
    return result.success ? [result.data] : [];
  });
}
