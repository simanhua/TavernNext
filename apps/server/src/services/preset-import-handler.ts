import { randomUUID } from 'node:crypto';
import {
  decodeInspectedPreset,
  normalizeAttachedExtensions,
  attachedVariableValue,
  persistPresetSourceAssociations,
  type PresetSourceAssociationEnvelope,
  type PresetImportPreview,
} from '@tavernnext/st-compat';
import { assertExtensionAssetLimit } from '../extension-assets.js';
import type { Preset } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';

export interface StoredPresetSource {
  rawDocument: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
  associationEnvelope: PresetSourceAssociationEnvelope;
}

function decode(bytes: Uint8Array, fileName: string): Omit<PresetImportPreview, 'warnings' | 'blockingErrors'> {
  return decodeInspectedPreset(bytes, fileName);
}

export function persistPresetBytes(
  repositories: Repositories,
  bytes: Uint8Array,
  fileName: string,
  compatWarnings: string[] = [],
): Preset {
  const decoded = decode(bytes, fileName);
  if (decoded.kind === null) throw new Error('Preset has no recognized kind');
  const attached = normalizeAttachedExtensions(decoded.extensions);
  assertExtensionAssetLimit(attached.assets.length);
  const associations = persistPresetSourceAssociations({
    kind: decoded.kind,
    settings: decoded.settings,
    rawPayload: decoded.rawPayload,
    ...(decoded.wrapperKey === undefined ? {} : { wrapperKey: decoded.wrapperKey }),
  });
  const source: StoredPresetSource = {
    rawDocument: structuredClone(decoded.rawPayload),
    ...(decoded.wrapperKey === undefined ? {} : { wrapperKey: decoded.wrapperKey }),
    associationEnvelope: associations.associationEnvelope,
  };
  const value = repositories.presets.create({
    id: randomUUID(),
    name: decoded.name,
    kind: decoded.kind,
    settings: associations.settings,
    extensions: attached.extensions,
    compatibility: {
      sourceFormat: 'preset:json',
      rawPayload: source,
      unknownFields: structuredClone(decoded.unknownFields),
      compatWarnings,
      parserVersion: '1',
    },
  });
  for (const asset of attached.assets) {
    repositories.extensionAssets.create({
      id: randomUUID(), ownerKind: 'preset', ownerId: value.id,
      kind: asset.kind, sourceKey: asset.sourceKey, ordinal: asset.ordinal,
      enabled: asset.enabled, payload: asset.payload, diagnostics: asset.diagnostics,
    });
  }
  const variables = attachedVariableValue(attached.extensions);
  if (variables !== undefined) {
    repositories.extensionStates.create({
      id: randomUUID(), scope: 'preset', scopeId: value.id, value: variables,
    });
  }
  return value;
}
