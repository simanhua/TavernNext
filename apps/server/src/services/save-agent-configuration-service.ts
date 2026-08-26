import { randomUUID } from 'node:crypto';
import type { Preset, SaveAgentConfiguration } from '@tavernnext/domain';
import {
  executablePresetFields,
  presetSettingsForExecution,
  validatePresetFamily,
} from '@tavernnext/st-compat';
import type { Repositories } from '../db/repositories.js';

export class SaveAgentConfigurationError extends Error {
  constructor(readonly code: 'not_found' | 'preset_not_configured' | 'invalid_preset') {
    super(code);
    this.name = 'SaveAgentConfigurationError';
  }
}

export function executableChatPresetSettings(
  settings: Record<string, unknown>,
  source?: Pick<Preset, 'compatibility'>,
): Record<string, unknown> {
  const markerFree = source?.compatibility === undefined
    ? presetSettingsForExecution(settings)
    : presetSettingsForExecution(settings, source.compatibility, 'chat');
  return executablePresetFields('chat', validatePresetFamily('chat', markerFree)).settings;
}

export function saveAgentConfigurationFields(
  repositories: Repositories,
  sourcePresetId: string,
): Pick<SaveAgentConfiguration, 'sourcePresetId' | 'sourcePresetRevision' | 'name' | 'settings'> {
  const source = repositories.presets.get(sourcePresetId);
  if (source === undefined) throw new SaveAgentConfigurationError('not_found');
  if (source.kind !== 'chat') throw new SaveAgentConfigurationError('invalid_preset');
  return {
    sourcePresetId: source.id,
    sourcePresetRevision: source.revision,
    name: source.name,
    settings: executableChatPresetSettings(source.settings, source),
  };
}

export function createSaveAgentConfiguration(
  repositories: Repositories,
  conversationId: string,
  preferredPresetId?: string,
): SaveAgentConfiguration {
  const sourcePresetId = preferredPresetId ?? repositories.globalGenerationConfig.get().chatPresetId ?? undefined;
  if (sourcePresetId === undefined) throw new SaveAgentConfigurationError('preset_not_configured');
  return repositories.saveAgentConfigurations.create({
    id: randomUUID(),
    conversationId,
    ...saveAgentConfigurationFields(repositories, sourcePresetId),
  });
}
