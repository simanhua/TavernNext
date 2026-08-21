import { randomUUID } from 'node:crypto';
import {
  decodeInspectedPreset,
  diagnostic,
  normalizeAttachedExtensions,
  persistPresetSourceAssociations,
  presetWarnings,
  summarizeSPreset,
  type PresetSourceAssociationEnvelope,
  type PresetImportPreview,
} from '@tavernnext/st-compat';
import type { ImportHandler } from './import-service.js';
import { assertExtensionAssetLimit } from '../extension-assets.js';

export interface StoredPresetSource {
  rawDocument: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
  associationEnvelope: PresetSourceAssociationEnvelope;
}

function decode(bytes: Uint8Array, fileName: string): Omit<PresetImportPreview, 'warnings' | 'blockingErrors'> {
  return decodeInspectedPreset(bytes, fileName);
}

/** Typed commits always decode the digest-checked staged bytes rather than trusting client-visible preview data. */
export function createPresetImportHandler(): ImportHandler {
  return {
    id: 'tavernnext-sillytavern-preset',
    matches: (preview) => preview.detected.kind === 'preset',
    async inspect(context) {
      try {
        const decoded = decode(context.artifact.bytes, context.artifact.fileName);
        const warnings = presetWarnings(decoded);
        const attached = normalizeAttachedExtensions(decoded.extensions);
        return {
          normalizedPreview: {
            name: decoded.name,
            kind: decoded.kind,
            candidates: decoded.candidates,
            settings: decoded.settings,
            extensions: attached.extensions,
            attachedExtensions: attached.overview,
            spreset: summarizeSPreset(attached.extensions),
            unknownFields: decoded.unknownFields,
          },
          warnings,
          blockingErrors: [],
        };
      } catch (error) {
        return {
          normalizedPreview: null,
          warnings: [],
          blockingErrors: [diagnostic(
            'preset_decode_failed',
            error instanceof Error ? error.message : 'Preset could not be decoded safely.',
          )],
        };
      }
    },
    commit(context) {
      const decoded = decode(context.artifact.bytes, context.artifact.fileName);
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
      const value = context.repositories.presets.create({
        id: randomUUID(),
        name: decoded.name,
        kind: decoded.kind,
        settings: associations.settings,
        extensions: attached.extensions,
        compatibility: {
          sourceFormat: 'preset:json',
          rawPayload: source,
          unknownFields: structuredClone(decoded.unknownFields),
          compatWarnings: context.preview.warnings.map((warning) => warning.code),
          parserVersion: '1',
        },
      });
      for (const asset of attached.assets) {
        context.repositories.extensionAssets.create({
          id: randomUUID(), ownerKind: 'preset', ownerId: value.id,
          kind: asset.kind, sourceKey: asset.sourceKey, ordinal: asset.ordinal,
          enabled: asset.enabled, payload: asset.payload, diagnostics: asset.diagnostics,
        });
      }
      return { entityId: value.id };
    },
  };
}
