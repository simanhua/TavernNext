import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  exportCharacter,
  type CharacterAuxiliaryAsset,
  type CharacterExportFormat,
  type CharacterUnknownFields,
} from '@tavernnext/st-compat';
import type { FastifyInstance } from 'fastify';
import type { Repositories } from '../db/repositories.js';
import type { StoredCharacterSource } from '../services/character-import-handler.js';

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
      const avatar = source?.avatar === undefined
        ? character.avatarPath === undefined
          ? undefined
          : asset(dataDir, 'avatar', character.avatarPath)
        : asset(dataDir, source.avatar.originalPath, source.avatar.storedPath);
      const sourcePng = readDataAsset(dataDir, source?.sourcePngPath);
      const unknownFields = (source?.unknownFields ?? character.compatibility?.unknownFields ?? {
        topLevel: {}, data: {},
      }) as CharacterUnknownFields;
      try {
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
            extensions: structuredClone(source?.extensions ?? {}),
            ...(character.characterBook === undefined ? {} : { characterBook: character.characterBook }),
          },
          unknownFields,
          rawPayloads: source?.rawPayloads,
          ...(sourcePng === undefined ? {} : { sourcePng }),
          ...(avatar === undefined ? {} : { avatar }),
          auxiliaryAssets,
        }, format as CharacterExportFormat, format === 'png'
          ? { defaultPng: readDefaultCard() }
          : {});
        reply.header('Content-Type', artifact.contentType);
        reply.header('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
        return reply.send(Buffer.from(artifact.bytes));
      } catch {
        return reply.code(500).send({ error: 'character_export_failed' });
      }
    },
  );
}
