import { randomUUID } from 'node:crypto';
import {
  decodeInspectedCharacter,
  diagnostic,
  type CharacterAuxiliaryAsset,
} from '@tavernnext/st-compat';
import type { ImportHandler } from './import-service.js';

export interface StoredCharacterSource {
  sourceFormat: string;
  version: string;
  selectedPayload: string;
  rawPayloads: Record<string, unknown>;
  unknownFields: { topLevel: Record<string, unknown>; data: Record<string, unknown> };
  extensions: Record<string, unknown>;
  sourcePngPath?: string;
  avatar?: { originalPath: string; storedPath: string };
  auxiliaryAssets: Array<{ originalPath: string; storedPath: string }>;
}

function sameAsset(left: CharacterAuxiliaryAsset, right: CharacterAuxiliaryAsset): boolean {
  return left.path === right.path && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

export function createCharacterImportHandler(): ImportHandler {
  return {
    id: 'tavernnext-character-card',
    matches: (preview) => preview.detected.kind === 'character',
    async inspect(context) {
      try {
        const decoded = decodeInspectedCharacter(
          context.artifact.bytes,
          context.artifact.fileName,
          undefined,
          context.preview.detected.container,
        );
        return {
          normalizedPreview: decoded.character,
          warnings: [],
          blockingErrors: decoded.character === null
            ? [diagnostic('character_card_invalid', 'Character Card has no normalized fields.')]
            : [],
        };
      } catch (error) {
        return {
          normalizedPreview: null,
          warnings: [],
          blockingErrors: [diagnostic(
            'character_decode_failed',
            error instanceof Error ? error.message : 'Character Card could not be decoded.',
          )],
        };
      }
    },
    commit(context) {
      const decoded = decodeInspectedCharacter(
        context.artifact.bytes,
        context.artifact.fileName,
        undefined,
        context.preview.detected.container,
      );
      const character = decoded.character;
      if (character === null) throw new Error('Character Card has no normalized fields');
      const storedAssets = decoded.auxiliaryAssets.map((asset, index) => ({
        originalPath: asset.path,
        storedPath: context.writeAsset(`character/auxiliary/${String(index).padStart(6, '0')}.bin`, asset.bytes),
      }));
      const sourcePngPath = decoded.sourcePng === undefined
        ? undefined
        : context.writeAsset('character/source.png', decoded.sourcePng);
      const existingAvatar = decoded.avatar === undefined
        ? undefined
        : decoded.auxiliaryAssets.findIndex((asset) => sameAsset(asset, decoded.avatar!));
      const avatarStoredPath = sourcePngPath ?? (
        decoded.avatar === undefined
          ? undefined
          : existingAvatar !== undefined && existingAvatar >= 0
            ? storedAssets[existingAvatar]!.storedPath
            : context.writeAsset('character/avatar/current.bin', decoded.avatar.bytes)
      );
      const source: StoredCharacterSource = {
        sourceFormat: decoded.sourceFormat,
        version: decoded.version,
        selectedPayload: decoded.selectedPayload,
        rawPayloads: structuredClone(decoded.rawPayloads),
        unknownFields: structuredClone(decoded.unknownFields),
        extensions: structuredClone(character.extensions),
        ...(sourcePngPath === undefined ? {} : { sourcePngPath }),
        ...(decoded.avatar === undefined || avatarStoredPath === undefined ? {} : {
          avatar: { originalPath: decoded.avatar.path, storedPath: avatarStoredPath },
        }),
        auxiliaryAssets: storedAssets,
      };
      const value = context.repositories.characters.create({
        id: randomUUID(),
        name: character.name,
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        firstMessage: character.firstMessage,
        examples: character.examples,
        systemPrompt: character.systemPrompt,
        postHistoryInstructions: character.postHistoryInstructions,
        creatorNotes: character.creatorNotes,
        creator: character.creator,
        characterVersion: character.characterVersion,
        alternateGreetings: character.alternateGreetings,
        tags: character.tags,
        ...(character.characterBook === undefined ? {} : { characterBook: character.characterBook }),
        ...(avatarStoredPath === undefined ? {} : { avatarPath: avatarStoredPath }),
        compatibility: {
          sourceFormat: `character:${decoded.sourceFormat}:${decoded.version}`,
          rawPayload: source,
          unknownFields: {
            topLevel: structuredClone(decoded.unknownFields.topLevel),
            data: structuredClone(decoded.unknownFields.data),
          },
          compatWarnings: context.preview.warnings.map((warning) => warning.code),
          parserVersion: '1',
        },
      });
      return { entityId: value.id };
    },
  };
}
