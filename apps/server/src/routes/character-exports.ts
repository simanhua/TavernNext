import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  decodeInspectedCharacter,
  exportCharacter,
  exportCharacterBook,
  type CharacterAuxiliaryAsset,
  type CharacterExportFormat,
  type CharacterUnknownFields,
} from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import type { StoredCharacterSource } from '../services/character-import-handler.js';
import { normalizedWorldbookFromRows } from '../services/worldbook-import-handler.js';
import { readOwnerAvatarBytes } from './avatars.js';

const defaultCardPaths = [
  fileURLToPath(new URL('../../assets/default-card.png', import.meta.url)),
  fileURLToPath(new URL('../../../assets/default-card.png', import.meta.url)),
];

function readDefaultCard(): Uint8Array {
  for (const path of defaultCardPaths) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      // Source tests and compiled runtime resolve import.meta.url from different depths.
    }
  }
  throw new Error('The default Character Card image is unavailable');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedSource(value: unknown): StoredCharacterSource | undefined {
  const object = record(value);
  if (object === undefined || typeof object.sourceFormat !== 'string' || typeof object.version !== 'string') return undefined;
  return object as unknown as StoredCharacterSource;
}

function readDataAsset(dataDir: string, portablePath: string | undefined): Uint8Array | undefined {
  if (portablePath === undefined || portablePath.includes('\0') || isAbsolute(portablePath)) return undefined;
  const root = resolve(dataDir);
  const path = resolve(root, ...portablePath.replaceAll('\\', '/').split('/'));
  const within = relative(root, path);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}

function asset(dataDir: string, originalPath: string, storedPath: string): CharacterAuxiliaryAsset | undefined {
  const bytes = readDataAsset(dataDir, storedPath);
  return bytes === undefined ? undefined : { path: originalPath, bytes };
}

function rfc5987(value: string): string {
  const attrChar = /^[A-Za-z0-9!#$&+.^_`|~-]$/;
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return attrChar.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function attachmentHeader(fileName: string): string {
  const clean = fileName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '_');
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const base = `attachment; filename="${fallback}"`;
  return clean === fallback ? base : `${base}; filename*=UTF-8''${rfc5987(clean)}`;
}

export function registerCharacterExportRoutes(
  app: FastifyInstance,
  repositories: Repositories,
  dataDir: string,
): void {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/characters/:id/export',
    async (request, reply) => {
      const format = request.query.format;
      if (format !== 'json-v2' && format !== 'json-v3' && format !== 'png') {
        return reply.code(400).send({ error: 'invalid_character_export_format' });
      }
      const character = repositories.characters.get(request.params.id);
      if (character === undefined) return reply.code(404).send({ error: 'not_found' });
      const source = storedSource(character.compatibility?.rawPayload);
      const auxiliaryAssets = (source?.auxiliaryAssets ?? []).flatMap((stored) => {
        const value = asset(dataDir, stored.originalPath, stored.storedPath);
        return value === undefined ? [] : [value];
      });
      const currentAvatarBytes = character.avatarPath === undefined
        ? undefined
        : await readOwnerAvatarBytes(repositories, dataDir, 'characters', character.id, character.avatarPath);
      const currentAvatar = currentAvatarBytes === undefined ? undefined : { path: 'avatar', bytes: currentAvatarBytes };
      const sourceAvatarBytes = source?.avatar === undefined
        ? undefined
        : await readOwnerAvatarBytes(repositories, dataDir, 'characters', character.id, source.avatar.storedPath);
      const sourceAvatar = source?.avatar === undefined || sourceAvatarBytes === undefined
        ? undefined
        : { path: source.avatar.originalPath, bytes: sourceAvatarBytes };
      const avatar = currentAvatar ?? sourceAvatar;
      const sourcePng = readDataAsset(dataDir, source?.sourcePngPath);
      let recoveredPngPayloads: Record<string, unknown> | undefined;
      if (source?.rawPayloads === undefined && sourcePng !== undefined) {
        try {
          recoveredPngPayloads = decodeInspectedCharacter(sourcePng, 'source.png', undefined, 'png').rawPayloads;
        } catch {
          // A current Character remains exportable from normalized fields even
          // when its retained source PNG metadata can no longer be recovered.
        }
      }
      const unknownFields = (source?.unknownFields ?? character.compatibility?.unknownFields ?? {
        topLevel: {}, data: {},
      }) as CharacterUnknownFields;
      try {
        const linkedWorldbook = character.worldbookId === undefined
          ? undefined
          : repositories.worldbooks.get(character.worldbookId);
        const characterBook = linkedWorldbook === undefined
          ? character.characterBook
          : exportCharacterBook(normalizedWorldbookFromRows(
            linkedWorldbook,
            repositories.worldbookEntries.listByWorldbookId(linkedWorldbook.id),
          ));
        const sourceExtensions = source?.extensions ?? {};
        const mergedExtensions = {
          ...structuredClone(sourceExtensions),
          ...structuredClone(character.extensions),
        };
        const existingDepthPrompt = record(mergedExtensions.depth_prompt) ?? {};
        const exportExtensions = character.depthPrompt !== '' || Object.hasOwn(mergedExtensions, 'depth_prompt')
          ? { ...mergedExtensions, depth_prompt: { ...existingDepthPrompt, prompt: character.depthPrompt } }
          : mergedExtensions;
        const artifact = await exportCharacter({
          character: {
            name: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
            firstMessage: character.firstMessage,
            examples: character.examples,
            systemPrompt: character.systemPrompt,
            postHistoryInstructions: character.postHistoryInstructions,
            alternateGreetings: character.alternateGreetings,
            creatorNotes: character.creatorNotes,
            tags: character.tags,
            creator: character.creator,
            characterVersion: character.characterVersion,
            extensions: exportExtensions,
            ...(characterBook === undefined ? {} : { characterBook }),
          },
          unknownFields,
          rawPayloads: source?.rawPayloads ?? recoveredPngPayloads,
          ...(sourcePng === undefined ? {} : { sourcePng }),
          ...(avatar === undefined ? {} : { avatar }),
          auxiliaryAssets,
        }, format as CharacterExportFormat, format === 'png'
          ? { defaultPng: readDefaultCard() }
          : {});
        reply.header('Content-Type', artifact.contentType);
        reply.header('Content-Disposition', attachmentHeader(artifact.fileName));
        return reply.send(Buffer.from(artifact.bytes));
      } catch {
        return reply.code(500).send({ error: 'character_export_failed' });
      }
    },
  );
}
