import { isDirectNovelPreset, record, type PresetKind } from './schemas.js';

const presetSourceAssociationKey = '__tavernnextPresetSource';

type SourcePath = Array<string | number>;

export interface PresetSourceAssociationInput {
  kind: PresetKind | null;
  settings: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasIdentity(value: unknown, key: 'identifier' | 'character_id' | 'id'): boolean {
  const candidate = record(value)?.[key];
  return typeof candidate === 'string' || typeof candidate === 'number';
}

function associateAtIndex(
  settings: unknown[],
  raw: unknown[],
  path: readonly (string | number)[],
  identityKey: 'identifier' | 'character_id' | 'id',
): void {
  settings.forEach((value, index) => {
    const object = record(value);
    if (object === undefined || !hasIdentity(value, identityKey) || !hasIdentity(raw[index], identityKey)) return;
    object[presetSourceAssociationKey] = [...path, index] satisfies SourcePath;
  });
}

/**
 * Adds JSON-stable compatibility tokens before Preset settings enter persistence.
 * The token points into the separately stored raw source document and travels with
 * an entry across JSON round-trips, object spreads, edits, and reordering.
 */
export function persistPresetSourceAssociations(source: PresetSourceAssociationInput): Record<string, unknown> {
  const settings = structuredClone(source.settings);
  const rawBody = source.wrapperKey === undefined
    ? source.rawPayload
    : record(source.rawPayload[source.wrapperKey]) ?? {};

  if (source.kind === 'chat') {
    const settingsPrompts = array(settings.prompts);
    associateAtIndex(settingsPrompts, array(rawBody.prompts), ['prompts'], 'identifier');

    const settingsGroups = array(settings.prompt_order);
    const rawGroups = array(rawBody.prompt_order);
    associateAtIndex(settingsGroups, rawGroups, ['prompt_order'], 'character_id');
    settingsGroups.forEach((value, groupIndex) => {
      const settingsGroup = record(value);
      const rawGroup = record(rawGroups[groupIndex]);
      if (settingsGroup === undefined || rawGroup === undefined) return;
      associateAtIndex(
        array(settingsGroup.order),
        array(rawGroup.order),
        ['prompt_order', groupIndex, 'order'],
        'identifier',
      );
    });
  }

  if (source.kind === 'text') {
    const directNovel = isDirectNovelPreset(rawBody);
    const rawSettings = directNovel ? record(rawBody.parameters) ?? {} : rawBody;
    associateAtIndex(
      array(settings.order),
      array(rawSettings.order),
      directNovel ? ['parameters', 'order'] : ['order'],
      'id',
    );
  }

  return settings;
}

/** Returns the exact raw-source path carried by a persisted structured entry. */
export function presetSourceAssociation(value: unknown): readonly (string | number)[] | undefined {
  const candidate = record(value)?.[presetSourceAssociationKey];
  if (!Array.isArray(candidate) || candidate.some((part) => typeof part !== 'string' && !Number.isInteger(part))) {
    return undefined;
  }
  return candidate as SourcePath;
}

export function isPresetSourceAssociationKey(key: string): boolean {
  return key === presetSourceAssociationKey;
}

/** Produces the copy provider/generation execution may consume, without compatibility tokens. */
export function presetSettingsForExecution(settings: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    const object = record(value);
    if (object === undefined) return structuredClone(value);
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== presetSourceAssociationKey)
        .map(([key, nested]) => [key, clean(nested)]),
    );
  };
  return clean(settings) as Record<string, unknown>;
}
