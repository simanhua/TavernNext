import { randomUUID } from 'node:crypto';
import {
  decodeInspectedCharacter,
  diagnostic,
} from '@tavernnext/st-compat';
import type { ImportHandler } from './import-service.js';
import { sanitizePublicPng, validatePngRaster } from './avatar-png.js';

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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function characterDepthPrompt(extensions: Record<string, unknown>): string {
  const depthPrompt = record(extensions.depth_prompt);
  return depthPrompt !== undefined && typeof depthPrompt.prompt === 'string' ? depthPrompt.prompt : '';
}

function avatarExtension(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  const signature = Buffer.from(bytes.subarray(0, 12)).toString('ascii');
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) return 'gif';
  if (signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP') return 'webp';
  throw new Error('Imported Character avatar is not a supported image');
}

function publicAvatarBytes(bytes: Uint8Array): Uint8Array {
  return avatarExtension(bytes) === 'png' ? sanitizePublicPng(bytes) : bytes;
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
        const avatarBytes = decoded.avatar?.bytes ?? decoded.sourcePng;
        if (avatarBytes !== undefined && avatarExtension(avatarBytes) === 'png') validatePngRaster(avatarBytes);
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
      const characterId = randomUUID();
      const storedAssets = decoded.auxiliaryAssets.map((asset, index) => ({
        originalPath: asset.path,
        storedPath: context.writeAsset(`character/auxiliary/${String(index).padStart(6, '0')}.bin`, asset.bytes),
      }));
      const sourcePngPath = decoded.sourcePng === undefined
        ? undefined
        : context.writeAsset('character/source.png', decoded.sourcePng);
      const avatarBytes = decoded.avatar?.bytes ?? decoded.sourcePng;
      const sanitizedAvatarBytes = avatarBytes === undefined ? undefined : publicAvatarBytes(avatarBytes);
      const avatarStoredPath = sanitizedAvatarBytes === undefined
        ? undefined
        : context.writeEntityAvatar('characters', characterId, avatarExtension(sanitizedAvatarBytes), sanitizedAvatarBytes);
      const source: StoredCharacterSource = {
        sourceFormat: decoded.sourceFormat,
        version: decoded.version,
        selectedPayload: decoded.selectedPayload,
        rawPayloads: structuredClone(decoded.rawPayloads),
        unknownFields: structuredClone(decoded.unknownFields),
        extensions: structuredClone(character.extensions),
        ...(sourcePngPath === undefined ? {} : { sourcePngPath }),
        ...(avatarStoredPath === undefined ? {} : {
          avatar: { originalPath: decoded.avatar?.path ?? context.artifact.fileName, storedPath: avatarStoredPath },
        }),
        auxiliaryAssets: storedAssets,
      };
      const value = context.repositories.characters.create({
        id: characterId,
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
        depthPrompt: characterDepthPrompt(character.extensions),
        alternateGreetings: character.alternateGreetings,
        tags: character.tags,
        extensions: structuredClone(character.extensions),
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
