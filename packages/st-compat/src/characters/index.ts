import {
  DEFAULT_INSPECTION_LIMITS,
  type InspectionLimits,
  type SourceArtifact,
} from '../artifact.js';
import { inspectArtifact, type InspectionOptions } from '../detect-format.js';
import { diagnostic } from '../warnings.js';
import { decodeByaf, decodeCharX } from './archive-codec.js';
import { CharacterCodecError, decodeCharacterJson } from './json-codec.js';
import {
  emptyCharacterPreview,
  type CharacterImportPreview,
} from './normalize.js';
import { decodeCharacterPng } from './png-codec.js';
export { encodeCharacterPng, stripPngTextMetadata } from './png-codec.js';
import { decodeCharacterYaml } from './yaml-codec.js';

export interface InspectCharacterOptions extends InspectionOptions {
  limits?: InspectionLimits;
}

function extension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
}

function decodedFormat(fileName: string, detectedContainer?: string): CharacterImportPreview['sourceFormat'] {
  if (detectedContainer === 'png' || extension(fileName) === '.png') return 'png';
  if (detectedContainer === 'charx' || extension(fileName) === '.charx') return 'charx';
  if (detectedContainer === 'byaf' || extension(fileName) === '.byaf') return 'byaf';
  if (detectedContainer === 'yaml' || ['.yaml', '.yml'].includes(extension(fileName))) return 'yaml';
  return 'json';
}

/** Decode bytes that have already passed Task 7 structural and archive validation. */
export function decodeInspectedCharacter(
  bytes: Uint8Array,
  fileName: string,
  limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
  detectedContainer?: string,
): Omit<CharacterImportPreview, 'warnings' | 'blockingErrors'> {
  const sourceFormat = decodedFormat(fileName, detectedContainer);
  if (sourceFormat === 'png') {
    const decoded = decodeCharacterPng(bytes, limits.maxInMemoryEntryBytes);
    return {
      sourceFormat,
      version: decoded.selected.version,
      selectedPayload: decoded.selectedPayload,
      character: decoded.selected.character,
      rawPayloads: decoded.rawPayloads,
      unknownFields: decoded.selected.unknownFields,
      auxiliaryAssets: [],
      sourcePng: Uint8Array.from(bytes),
    };
  }
  if (sourceFormat === 'charx' || sourceFormat === 'byaf') {
    const decoded = sourceFormat === 'charx'
      ? decodeCharX(bytes, limits.maxInMemoryEntryBytes)
      : decodeByaf(bytes, limits.maxInMemoryEntryBytes);
    return {
      sourceFormat,
      version: decoded.selected.version,
      selectedPayload: decoded.selectedPayload,
      character: decoded.selected.character,
      rawPayloads: decoded.rawPayloads,
      unknownFields: decoded.selected.unknownFields,
      auxiliaryAssets: decoded.auxiliaryAssets,
      ...(decoded.avatar === undefined ? {} : { avatar: decoded.avatar }),
    };
  }
  const decoded = sourceFormat === 'yaml' ? decodeCharacterYaml(bytes) : decodeCharacterJson(bytes);
  return {
    sourceFormat,
    version: decoded.version,
    selectedPayload: 'document',
    character: decoded.character,
    rawPayloads: { document: decoded.raw },
    unknownFields: decoded.unknownFields,
    auxiliaryAssets: [],
  };
}

export async function inspectCharacter(
  bytes: Uint8Array,
  fileName: string,
  options: InspectCharacterOptions = {},
): Promise<CharacterImportPreview> {
  const limits = options.limits ?? DEFAULT_INSPECTION_LIMITS;
  const artifact: SourceArtifact = { bytes, fileName };
  const generic = await inspectArtifact(artifact, limits, {
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  });
  if (generic.blockingErrors.length > 0) {
    if (decodedFormat(fileName, generic.detected.container) === 'png') {
      try {
        decodeCharacterPng(bytes, limits.maxInMemoryEntryBytes);
      } catch (error) {
        if (error instanceof CharacterCodecError && error.diagnostic.code.startsWith('character_')) {
          return { ...emptyCharacterPreview(), sourceFormat: 'png', blockingErrors: [error.diagnostic] };
        }
      }
    }
    return {
      ...emptyCharacterPreview(),
      sourceFormat: decodedFormat(fileName, generic.detected.container),
      warnings: generic.warnings,
      blockingErrors: generic.blockingErrors,
    };
  }
  if (generic.detected.kind !== 'character') {
    return {
      ...emptyCharacterPreview(),
      sourceFormat: decodedFormat(fileName, generic.detected.container),
      warnings: generic.warnings,
      blockingErrors: [diagnostic('character_card_unrecognized', 'Artifact is not a recognized Character Card.')],
    };
  }
  try {
    return {
      ...decodeInspectedCharacter(bytes, fileName, limits, generic.detected.container),
      warnings: generic.warnings,
      blockingErrors: [],
    };
  } catch (error) {
    return {
      ...emptyCharacterPreview(),
      sourceFormat: decodedFormat(fileName, generic.detected.container),
      warnings: generic.warnings,
      blockingErrors: [error instanceof CharacterCodecError
        ? error.diagnostic
        : diagnostic('character_decode_failed', 'Character Card could not be decoded safely.')],
    };
  }
}

export * from './normalize.js';
