import type { Preset } from '@tavernnext/domain';
import {
  executablePresetFields,
  presetSettingsForExecution,
  validatePresetFamily,
  type PresetKind,
} from '@tavernnext/st-compat';

export function sanitizedPresetSettings(preset: Preset, expectedKind: PresetKind): Record<string, unknown> {
  if (preset.kind !== expectedKind) {
    throw new TypeError(`Expected a ${expectedKind} preset, received ${preset.kind}.`);
  }
  const markerFree = preset.compatibility === undefined
    ? presetSettingsForExecution(preset.settings)
    : presetSettingsForExecution(preset.settings, preset.compatibility, expectedKind);
  return executablePresetFields(expectedKind, validatePresetFamily(expectedKind, markerFree)).settings;
}

export function stringSetting(settings: Record<string, unknown>, key: string): string {
  return typeof settings[key] === 'string' ? settings[key] : '';
}

export function booleanSetting(settings: Record<string, unknown>, key: string, fallback = false): boolean {
  return typeof settings[key] === 'boolean' ? settings[key] : fallback;
}
