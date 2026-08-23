import type { ExtensionAsset, Preset, ProviderProfile } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';

export interface ActiveResourceOwner {
  kind: 'preset' | 'character';
  id: string;
  revision: number;
  name: string;
}

export interface ActiveResourceContext {
  globalGenerationConfigRevision: number;
  mode: ProviderProfile['apiMode'] | null;
  primaryPreset: Pick<Preset, 'id' | 'revision' | 'name' | 'kind'> | null;
  conversation: { id: string; revision: number } | null;
  character: { id: string; revision: number; name: string } | null;
  owners: ActiveResourceOwner[];
}

function resolvePrimaryPreset(repositories: Repositories): {
  globalGenerationConfigRevision: number;
  mode: ProviderProfile['apiMode'] | null;
  primaryPreset: Preset | null;
} {
  const config = repositories.globalGenerationConfig.get();
  const provider = config.providerId === null ? undefined : repositories.providerProfiles.get(config.providerId);
  const mode = provider?.apiMode ?? null;
  const presetId = mode === 'chat' ? config.chatPresetId : mode === 'text' ? config.textPresetId : null;
  const selectedPreset = presetId === null ? undefined : repositories.presets.get(presetId);
  return {
    globalGenerationConfigRevision: config.revision,
    mode,
    primaryPreset: mode !== null && selectedPreset?.kind === mode ? selectedPreset : null,
  };
}

export interface ActivePresetExtensionResources {
  mode: ProviderProfile['apiMode'] | null;
  primaryPreset: Preset | null;
  assets: ExtensionAsset[];
}

export function resolveActiveResourceContext(
  repositories: Repositories,
  conversationId?: string,
): ActiveResourceContext {
  const resolvedPreset = resolvePrimaryPreset(repositories);
  const { mode } = resolvedPreset;
  const primaryPreset = resolvedPreset.primaryPreset === null ? null : {
    id: resolvedPreset.primaryPreset.id,
    revision: resolvedPreset.primaryPreset.revision,
    name: resolvedPreset.primaryPreset.name,
    kind: resolvedPreset.primaryPreset.kind,
  };
  const selectedConversation = conversationId === undefined ? undefined : repositories.conversations.get(conversationId);
  const conversation = selectedConversation === undefined ? null : {
    id: selectedConversation.id,
    revision: selectedConversation.revision,
  };
  const selectedCharacter = selectedConversation === undefined
    ? undefined
    : repositories.characters.get(selectedConversation.characterId);
  const character = selectedCharacter === undefined ? null : {
    id: selectedCharacter.id,
    revision: selectedCharacter.revision,
    name: selectedCharacter.name,
  };
  return {
    globalGenerationConfigRevision: resolvedPreset.globalGenerationConfigRevision,
    mode,
    primaryPreset,
    conversation,
    character,
    owners: [
      ...(primaryPreset === null ? [] : [{
        kind: 'preset' as const,
        id: primaryPreset.id,
        revision: primaryPreset.revision,
        name: primaryPreset.name,
      }]),
      ...(character === null ? [] : [{
        kind: 'character' as const,
        id: character.id,
        revision: character.revision,
        name: character.name,
      }]),
    ],
  };
}

export function resolveActivePresetExtensionResources(
  repositories: Repositories,
): ActivePresetExtensionResources {
  const { mode, primaryPreset } = resolvePrimaryPreset(repositories);
  if (primaryPreset === null) return { mode, primaryPreset: null, assets: [] };
  return {
    mode,
    primaryPreset,
    assets: repositories.extensionAssets.listByOwner('preset', primaryPreset.id),
  };
}
