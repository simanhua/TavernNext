import type { ExtensionAsset, Preset, ProviderProfile } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';

export interface ActivePresetExtensionResources {
  mode: ProviderProfile['apiMode'] | null;
  primaryPreset: Preset | null;
  assets: ExtensionAsset[];
}

export function resolveActivePresetExtensionResources(
  repositories: Repositories,
): ActivePresetExtensionResources {
  const config = repositories.globalGenerationConfig.get();
  const provider = config.providerId === null ? undefined : repositories.providerProfiles.get(config.providerId);
  const mode = provider?.apiMode ?? null;
  const presetId = mode === 'chat' ? config.chatPresetId : mode === 'text' ? config.textPresetId : null;
  const primaryPreset = presetId === null ? undefined : repositories.presets.get(presetId);
  if (mode === null || primaryPreset === undefined || primaryPreset.kind !== mode) {
    return { mode, primaryPreset: null, assets: [] };
  }
  return {
    mode,
    primaryPreset,
    assets: repositories.extensionAssets.listByOwner('preset', primaryPreset.id),
  };
}
