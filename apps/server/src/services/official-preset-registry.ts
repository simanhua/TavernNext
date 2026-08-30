import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ExtensionAssetSchema,
  ExtensionStateSchema,
  PresetKindSchema,
  PresetSchema,
  type ExtensionAsset,
  type ExtensionState,
  type Preset,
} from '@tavernnext/domain';
import {
  decodeInspectedPreset,
  executablePresetFields,
  presetSettingsForExecution,
  validatePresetFamily,
} from '@tavernnext/st-compat';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';

const CatalogSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    kind: PresetKindSchema,
    file: z.string().regex(/^\d{2}-[a-f0-9]{12}\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(512),
}).strict();

const PresetInputSchema = PresetSchema.omit({
  id: true, revision: true, createdAt: true, updatedAt: true,
});
const ExtensionAssetInputSchema = ExtensionAssetSchema.omit({
  revision: true, createdAt: true, updatedAt: true, ownerKind: true, ownerId: true,
});
const ExtensionStateInputSchema = ExtensionStateSchema.omit({
  revision: true, createdAt: true, updatedAt: true, scope: true, scopeId: true,
});
const AssetSchema = PresetInputSchema.extend({
  extensionAssets: z.array(ExtensionAssetInputSchema).max(512).default([]),
  runtimeState: ExtensionStateInputSchema.optional(),
});

type Catalog = z.infer<typeof CatalogSchema>;
type Asset = z.infer<typeof AssetSchema>;
type CatalogEntry = Catalog['entries'][number];

export interface OfficialPresetDefinition {
  entry: CatalogEntry;
  asset: Asset;
}

export interface DuplicateOfficialPreset {
  duplicateId: string;
  officialId: string;
}

function assetRoot(): string {
  const candidates = [
    resolve(process.cwd(), 'apps/server/assets/official-presets'),
    resolve(process.cwd(), 'assets/official-presets'),
  ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error('official_preset_assets_missing');
  return found;
}

function safeSettings(preset: Pick<Preset, 'kind' | 'settings' | 'compatibility'>): Record<string, unknown> {
  const markerFree = preset.compatibility === undefined
    ? presetSettingsForExecution(preset.settings)
    : presetSettingsForExecution(preset.settings, preset.compatibility, preset.kind);
  return executablePresetFields(
    preset.kind,
    validatePresetFamily(preset.kind, markerFree),
  ).settings;
}

function settingsDigest(kind: Preset['kind'], settings: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ kind, settings })).digest('hex');
}

let cachedCatalog: Catalog | undefined;

function officialPresetCatalog(): Catalog {
  if (cachedCatalog !== undefined) return cachedCatalog;
  const root = assetRoot();
  const catalog = CatalogSchema.parse(JSON.parse(readFileSync(resolve(root, 'catalog.json'), 'utf8')));
  const ids = new Set(catalog.entries.map((entry) => entry.id));
  const files = new Set(catalog.entries.map((entry) => entry.file));
  if (ids.size !== catalog.entries.length || files.size !== catalog.entries.length) {
    throw new Error('official_preset_catalog_duplicate');
  }
  cachedCatalog = catalog;
  return catalog;
}

function loadDefinitions(): OfficialPresetDefinition[] {
  const root = assetRoot();
  const catalog = officialPresetCatalog();
  return catalog.entries.map((entry) => {
    const asset = AssetSchema.parse(JSON.parse(readFileSync(resolve(root, entry.file), 'utf8')));
    if (asset.name !== entry.name || asset.kind !== entry.kind) {
      throw new Error(`official_preset_catalog_mismatch:${entry.id}`);
    }
    if (settingsDigest(asset.kind, safeSettings({ ...asset, compatibility: asset.compatibility })) !== entry.sha256) {
      throw new Error(`official_preset_digest_mismatch:${entry.id}`);
    }
    return { entry, asset };
  });
}

export function officialPresetDefinitions(): OfficialPresetDefinition[] {
  return loadDefinitions();
}

export function officialPresetIds(): string[] {
  return officialPresetCatalog().entries.map((entry) => entry.id);
}

export function isOfficialPresetId(id: string): boolean {
  return officialPresetCatalog().entries.some((entry) => entry.id === id);
}

export function officialPresetIdForPreset(
  preset: Pick<Preset, 'kind' | 'settings' | 'compatibility'>,
): string | undefined {
  const digest = settingsDigest(preset.kind, safeSettings(preset));
  return officialPresetCatalog().entries.find((entry) => entry.sha256 === digest)?.id;
}

export function officialPresetIdForBytes(bytes: Uint8Array, fileName: string): string | undefined {
  const decoded = decodeInspectedPreset(bytes, fileName);
  if (decoded.kind === null) return undefined;
  const digest = settingsDigest(decoded.kind, decoded.settings);
  return officialPresetCatalog().entries.find((entry) => entry.sha256 === digest)?.id;
}

export function duplicateOfficialPresets(repositories: Repositories): DuplicateOfficialPreset[] {
  return repositories.presets.list().flatMap((preset) => {
    if (isOfficialPresetId(preset.id)) return [];
    const officialId = officialPresetIdForPreset(preset);
    if (officialId === undefined) return [];
    const official = repositories.presets.get(officialId);
    return official !== undefined && official.name === preset.name
      ? [{ duplicateId: preset.id, officialId }]
      : [];
  });
}

export function deduplicateOfficialPresets(
  repositories: Repositories,
  duplicates = duplicateOfficialPresets(repositories),
): number {
  const targetByDuplicate = new Map(duplicates.map((item) => [item.duplicateId, item.officialId]));
  if (targetByDuplicate.size === 0) return 0;

  const global = repositories.globalGenerationConfig.get();
  const globalPatch = Object.fromEntries(
    (['chatPresetId', 'textPresetId', 'contextPresetId', 'instructPresetId', 'systemPresetId'] as const)
      .flatMap((key) => {
        const value = global[key];
        const officialId = value === null ? undefined : targetByDuplicate.get(value);
        return officialId === undefined ? [] : [[key, officialId]];
      }),
  );
  if (Object.keys(globalPatch).length > 0) {
    const result = repositories.globalGenerationConfig.update(global.revision, globalPatch);
    if (!result.ok) throw new Error(`official_preset_global_${result.reason}`);
  }

  for (const scene of repositories.installedScenes.list()) {
    const officialId = scene.backingPresetId === undefined
      ? undefined
      : targetByDuplicate.get(scene.backingPresetId);
    if (officialId === undefined) continue;
    const result = repositories.installedScenes.update(scene.id, scene.revision, { backingPresetId: officialId });
    if (!result.ok) throw new Error(`official_preset_scene_${result.reason}`);
  }

  for (const configuration of repositories.saveAgentConfigurations.list()) {
    const officialId = configuration.sourcePresetId === null
      ? undefined
      : targetByDuplicate.get(configuration.sourcePresetId);
    if (officialId === undefined) continue;
    const official = repositories.presets.get(officialId);
    if (official === undefined) throw new Error('official_preset_missing');
    const result = repositories.saveAgentConfigurations.update(configuration.id, configuration.revision, {
      sourcePresetId: official.id,
      sourcePresetRevision: official.revision,
    });
    if (!result.ok) throw new Error(`official_preset_save_${result.reason}`);
  }

  for (const artifact of repositories.importArtifacts.list()) {
    const officialId = artifact.entityId === undefined ? undefined : targetByDuplicate.get(artifact.entityId);
    if (officialId === undefined) continue;
    const result = repositories.importArtifacts.update(artifact.id, artifact.revision, { entityId: officialId });
    if (!result.ok) throw new Error(`official_preset_artifact_${result.reason}`);
  }

  for (const audit of repositories.extensionAuditEvents.list()) {
    if (audit.ownerKind !== 'preset') continue;
    const officialId = targetByDuplicate.get(audit.ownerId);
    if (officialId === undefined) continue;
    const result = repositories.extensionAuditEvents.update(audit.id, audit.revision, { ownerId: officialId });
    if (!result.ok) throw new Error(`official_preset_audit_${result.reason}`);
  }

  for (const { duplicateId } of duplicates) {
    repositories.extensionTrustGrants.deleteByOwner('preset', duplicateId);
    repositories.extensionRemoteResources.deleteByOwner('preset', duplicateId);
    repositories.extensionAssets.deleteByOwner('preset', duplicateId);
    repositories.extensionStates.deleteByScope('preset', duplicateId);
    repositories.extensionStates.deleteScriptStatesByOwner('preset', duplicateId);
    const preset = repositories.presets.get(duplicateId);
    if (preset === undefined) continue;
    const result = repositories.presets.delete(preset.id, preset.revision);
    if (!result.ok) throw new Error(`official_preset_delete_${result.reason}`);
  }
  return duplicates.length;
}

function presetInput(value: Preset) {
  return {
    name: value.name,
    kind: value.kind,
    settings: value.settings,
    extensions: value.extensions,
    ...(value.compatibility === undefined ? {} : { compatibility: value.compatibility }),
  };
}

function extensionAssetInput(value: ExtensionAsset) {
  return {
    id: value.id,
    kind: value.kind,
    sourceKey: value.sourceKey,
    ordinal: value.ordinal,
    enabled: value.enabled,
    payload: value.payload,
    diagnostics: value.diagnostics,
  };
}

function extensionStateInput(value: ExtensionState) {
  return { id: value.id, value: value.value };
}

export function synchronizeOfficialPresets(repositories: Repositories): void {
  for (const { entry, asset } of officialPresetDefinitions()) {
    const expectedPreset = PresetInputSchema.parse(asset);
    const current = repositories.presets.get(entry.id);
    if (current === undefined) {
      repositories.presets.create({ id: entry.id, ...expectedPreset });
    } else if (!isDeepStrictEqual(presetInput(current), expectedPreset)) {
      const result = repositories.presets.update(current.id, current.revision, expectedPreset);
      if (!result.ok) throw new Error(`official_preset_sync_${result.reason}:${entry.id}`);
    }

    const currentAssets = repositories.extensionAssets.listByOwner('preset', entry.id)
      .map(extensionAssetInput);
    if (!isDeepStrictEqual(currentAssets, asset.extensionAssets)) {
      repositories.extensionAssets.deleteByOwner('preset', entry.id);
      for (const expected of asset.extensionAssets) {
        repositories.extensionAssets.create({ ...expected, ownerKind: 'preset', ownerId: entry.id });
      }
    }

    const currentState = repositories.extensionStates.getByScope('preset', entry.id);
    if (asset.runtimeState === undefined) {
      if (currentState !== undefined) repositories.extensionStates.deleteByScope('preset', entry.id);
    } else if (currentState === undefined) {
      repositories.extensionStates.create({ ...asset.runtimeState, scope: 'preset', scopeId: entry.id });
    } else if (!isDeepStrictEqual(extensionStateInput(currentState), asset.runtimeState)) {
      const result = repositories.extensionStates.update(currentState.id, currentState.revision, asset.runtimeState);
      if (!result.ok) throw new Error(`official_preset_state_sync_${result.reason}:${entry.id}`);
    }
  }
}
