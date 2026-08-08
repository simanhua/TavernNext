import { randomUUID } from 'node:crypto';
import {
  decodeInspectedPreset,
  diagnostic,
  persistPresetSourceAssociations,
  presetWarnings,
  type PresetImportPreview,
} from '@tavernnext/st-compat';
import type { ImportHandler } from './import-service.js';

export interface StoredPresetSource {
  rawDocument: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
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
        return {
          normalizedPreview: {
            name: decoded.name,
            kind: decoded.kind,
            candidates: decoded.candidates,
            settings: decoded.settings,
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
      const source: StoredPresetSource = {
        rawDocument: structuredClone(decoded.rawPayload),
        ...(decoded.wrapperKey === undefined ? {} : { wrapperKey: decoded.wrapperKey }),
      };
      const value = context.repositories.presets.create({
        id: randomUUID(),
        name: decoded.name,
        kind: decoded.kind,
        settings: persistPresetSourceAssociations({
          kind: decoded.kind,
          settings: decoded.settings,
          rawPayload: decoded.rawPayload,
          ...(decoded.wrapperKey === undefined ? {} : { wrapperKey: decoded.wrapperKey }),
        }),
        compatibility: {
          sourceFormat: 'preset:json',
          rawPayload: source,
          unknownFields: structuredClone(decoded.unknownFields),
          compatWarnings: context.preview.warnings.map((warning) => warning.code),
          parserVersion: '1',
        },
      });
      return { entityId: value.id };
    },
  };
}
