import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConversationPlayerProfileSchema,
  SceneManifestSchema,
  type Conversation,
  type ConversationPlayerProfile,
  type ConversationSceneState,
  type InstalledScene,
  type SceneCatalog,
} from '@tavernnext/domain';
import {
  decodeEmbeddedCharacterBook,
  decodeInspectedCharacter,
  normalizeAttachedExtensions,
} from '@tavernnext/st-compat';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { persistDecodedWorldbook } from '../services/worldbook-import-handler.js';
import { builtInPackage, verifiedOfficialCatalog } from './official-package.js';
import { SceneModuleRegistry } from './scene-module-host.js';

const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SCENE_STATE_BYTES = 4 * 1024 * 1024;

const HookInitializeResultSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  initialState: z.record(z.string(), z.unknown()),
  openingMessages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }).strict()).max(16).default([]),
}).strict();

const ScenePatchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'remove', 'move', 'copy', 'test', 'delta']),
  path: z.string().startsWith('/'),
  from: z.string().startsWith('/').optional(),
  value: z.unknown().optional(),
}).strict();

export class SceneServiceError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeRelativePath(value: string): string {
  const portable = value.replaceAll('\\', '/');
  if (portable === '' || portable.includes('\0') || portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) {
    throw new SceneServiceError('scene_package_path_invalid', 422);
  }
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new SceneServiceError('scene_package_path_invalid', 422);
  }
  return segments.join('/');
}

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function assertSceneState(value: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SCENE_STATE_BYTES) {
    throw new SceneServiceError('scene_state_too_large', 422);
  }
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new SceneServiceError('scene_patch_invalid', 400);
  return pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function parentAt(root: Record<string, unknown>, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string } {
  const parts = pointerParts(pointer);
  const key = parts.pop();
  if (key === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || current[index] === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
      current = current[index];
    } else {
      const item = record(current);
      if (item === undefined || item[part] === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
      current = item[part];
    }
  }
  if (!Array.isArray(current) && record(current) === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function valueAt(root: Record<string, unknown>, pointer: string): unknown {
  let value: unknown = root;
  for (const part of pointerParts(pointer)) {
    value = Array.isArray(value) ? value[Number(part)] : record(value)?.[part];
    if (value === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
  }
  return value;
}

export function applyScenePatch(
  source: Record<string, unknown>,
  rawOperations: unknown,
): Record<string, unknown> {
  const operations = z.array(ScenePatchOperationSchema).max(512).parse(rawOperations);
  const value = structuredClone(source);
  const remove = (path: string) => {
    const { parent, key } = parentAt(value, path);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= parent.length) throw new SceneServiceError('scene_patch_invalid', 400);
      return parent.splice(index, 1)[0];
    }
    if (!Object.hasOwn(parent, key)) throw new SceneServiceError('scene_patch_invalid', 400);
    const removed = parent[key];
    delete parent[key];
    return removed;
  };
  const put = (path: string, next: unknown, replaceOnly: boolean) => {
    const { parent, key } = parentAt(value, path);
    if (Array.isArray(parent)) {
      if (key === '-' && !replaceOnly) parent.push(next);
      else {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (replaceOnly && index >= parent.length)) {
          throw new SceneServiceError('scene_patch_invalid', 400);
        }
        if (replaceOnly) parent[index] = next;
        else parent.splice(index, 0, next);
      }
      return;
    }
    if (replaceOnly && !Object.hasOwn(parent, key)) throw new SceneServiceError('scene_patch_invalid', 400);
    parent[key] = next;
  };
  for (const operation of operations) {
    if (operation.op === 'remove') remove(operation.path);
    else if (operation.op === 'add') put(operation.path, structuredClone(operation.value), false);
    else if (operation.op === 'replace') put(operation.path, structuredClone(operation.value), true);
    else if (operation.op === 'delta') {
      const current = valueAt(value, operation.path);
      if (typeof current !== 'number' || typeof operation.value !== 'number') throw new SceneServiceError('scene_patch_invalid', 400);
      put(operation.path, current + operation.value, true);
    } else if (operation.op === 'test') {
      if (JSON.stringify(valueAt(value, operation.path)) !== JSON.stringify(operation.value)) {
        throw new SceneServiceError('scene_patch_test_failed', 409);
      }
    } else {
      if (operation.from === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
      const moved = operation.op === 'move' ? remove(operation.from) : structuredClone(valueAt(value, operation.from));
      put(operation.path, moved, false);
    }
  }
  assertSceneState(value);
  return value;
}

function characterDepthPrompt(extensions: Record<string, unknown>): string {
  const depth = record(extensions.depth_prompt);
  return typeof depth?.prompt === 'string' ? depth.prompt : '';
}

function packageCharacter(files: Record<string, Uint8Array>, repositories: Repositories): {
  characterId: string;
  presetId: string;
} {
  const cardBytes = files['content/character.png'];
  if (cardBytes === undefined) throw new SceneServiceError('scene_character_missing', 422);
  const decoded = decodeInspectedCharacter(cardBytes, 'character.png');
  const character = decoded.character;
  if (character === null) throw new SceneServiceError('scene_character_invalid', 422);
  const attached = normalizeAttachedExtensions(character.extensions);
  const worldbook = character.characterBook === undefined
    ? undefined
    : persistDecodedWorldbook(
      repositories,
      decodeEmbeddedCharacterBook(character.characterBook, `${character.name} Worldbook`),
      [],
    );
  const id = randomUUID();
  repositories.characters.create({
    id,
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
    depthPrompt: characterDepthPrompt(attached.extensions),
    alternateGreetings: character.alternateGreetings,
    tags: character.tags,
    extensions: attached.extensions,
    ...(character.characterBook === undefined ? {} : { characterBook: character.characterBook }),
    ...(worldbook === undefined ? {} : { worldbookId: worldbook.id }),
  });
  const preset = repositories.presets.create({
    id: randomUUID(), name: '命定之诗内置生成配方', kind: 'chat',
    settings: {
      prompts: [
        { identifier: 'main', role: 'system', content: character.systemPrompt || 'You are the narrator and game master for {{char}}.', system_prompt: true },
        { identifier: 'charDescription', marker: true, system_prompt: true },
        { identifier: 'personaDescription', marker: true, system_prompt: true },
        { identifier: 'worldInfoBefore', marker: true, role: 'system', system_prompt: true },
        { identifier: 'chatHistory', marker: true, system_prompt: true },
        { identifier: 'worldInfoAfter', marker: true, role: 'system', system_prompt: true },
      ],
      prompt_order: [{
        character_id: id,
        order: ['main', 'charDescription', 'personaDescription', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter']
          .map((identifier) => ({ identifier, enabled: true })),
      }],
      tokenizer: 0,
      temperature: 1,
      max_tokens: 32768,
      wi_format: '{0}',
      new_chat_prompt: '',
    },
  });
  return { characterId: id, presetId: preset.id };
}

function packageFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SceneServiceError('scene_package_corrupt', 422);
  }
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_PACKAGE_FILES) throw new SceneServiceError('scene_package_limit', 422);
  let total = 0;
  const normalized: Record<string, Uint8Array> = {};
  for (const [rawPath, contents] of entries) {
    const path = safeRelativePath(rawPath);
    if (contents.byteLength > MAX_PACKAGE_FILE_BYTES) throw new SceneServiceError('scene_package_limit', 422);
    total += contents.byteLength;
    if (total > MAX_PACKAGE_TOTAL_BYTES) throw new SceneServiceError('scene_package_limit', 422);
    normalized[path] = contents;
  }
  return normalized;
}

export interface SceneService {
  catalog(): SceneCatalog;
  list(): InstalledScene[];
  get(sceneId: string): InstalledScene | undefined;
  install(sceneId: string): Promise<InstalledScene>;
  listConversations(sceneId: string): Conversation[];
  createConversation(sceneId: string, input: unknown): Promise<Conversation>;
  state(conversationId: string): ConversationSceneState | undefined;
  patchState(conversationId: string, expectedRevision: number, patch: unknown): ConversationSceneState;
  module(scene: InstalledScene): ReturnType<SceneModuleRegistry['get']> | undefined;
  assetPath(sceneId: string, path: string): string;
  uninstall(sceneId: string, expectedRevision: number): Promise<{ backupPath: string }>;
  close(): Promise<void>;
}

export function createSceneService(options: {
  dataDir: string;
  database: TavernDatabase;
  repositories: Repositories;
}): SceneService {
  const { dataDir, database, repositories } = options;
  const sceneRoot = resolve(dataDir, 'scenes');
  const moduleRegistry = new SceneModuleRegistry();
  mkdirSync(sceneRoot, { recursive: true });

  const get = (sceneId: string) => repositories.installedScenes.get(sceneId);
  const module = (scene: InstalledScene) => scene.manifest.serverEntry === undefined
    ? undefined
    : moduleRegistry.get(scene.id, pathToFileURL(join(scene.installPath, scene.manifest.serverEntry)).href);

  return {
    catalog: verifiedOfficialCatalog,
    list: () => repositories.installedScenes.list(512),
    get,
    async install(sceneId) {
      const entry = verifiedOfficialCatalog().scenes.find((candidate) => candidate.sceneId === sceneId);
      if (entry === undefined) throw new SceneServiceError('scene_not_found', 404);
      const existing = get(sceneId);
      if (existing !== undefined) {
        if (existing.archiveDigest === entry.archiveSha256) return existing;
        throw new SceneServiceError('scene_update_not_supported', 409);
      }
      const builtIn = builtInPackage(entry.packageUrl);
      const bytes = builtIn?.bytes ?? new Uint8Array(await (await fetch(entry.packageUrl)).arrayBuffer());
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== entry.archiveSha256) throw new SceneServiceError('scene_package_digest_invalid', 422);
      const files = packageFiles(bytes);
      const rawManifest = files['manifest.json'];
      if (rawManifest === undefined) throw new SceneServiceError('scene_manifest_missing', 422);
      let manifest;
      try { manifest = SceneManifestSchema.parse(JSON.parse(Buffer.from(rawManifest).toString('utf8'))); }
      catch { throw new SceneServiceError('scene_manifest_invalid', 422); }
      if (manifest.id !== sceneId || manifest.version !== entry.version) throw new SceneServiceError('scene_manifest_invalid', 422);
      for (const file of manifest.files) if (files[file] === undefined) throw new SceneServiceError('scene_package_file_missing', 422);
      const target = resolve(sceneRoot, sceneId, digest);
      const stage = resolve(sceneRoot, `.stage-${randomUUID()}`);
      if (!within(sceneRoot, target) || !within(sceneRoot, stage)) throw new SceneServiceError('scene_package_path_invalid', 422);
      mkdirSync(stage, { recursive: true });
      try {
        for (const [path, contents] of Object.entries(files)) {
          const destination = resolve(stage, ...path.split('/'));
          if (!within(stage, destination)) throw new SceneServiceError('scene_package_path_invalid', 422);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, contents);
        }
        mkdirSync(dirname(target), { recursive: true });
        renameSync(stage, target);
        return database.transaction(() => {
          const backing = packageCharacter(files, repositories);
          return repositories.installedScenes.create({
            id: manifest.id,
            slug: manifest.slug,
            version: manifest.version,
            archiveDigest: digest,
            installPath: target,
            installedAt: new Date().toISOString(),
            manifest,
            backingCharacterId: backing.characterId,
            backingPresetId: backing.presetId,
          });
        });
      } catch (error) {
        if (existsSync(stage) && within(sceneRoot, stage)) rmSync(stage, { recursive: true, force: true });
        if (existsSync(target) && get(sceneId) === undefined && within(sceneRoot, target)) rmSync(target, { recursive: true, force: true });
        throw error;
      }
    },
    listConversations(sceneId) {
      return repositories.conversations.list(4_096).filter((conversation) => conversation.sceneId === sceneId);
    },
    async createConversation(sceneId, rawInput) {
      const scene = get(sceneId);
      if (scene === undefined) throw new SceneServiceError('scene_not_found', 404);
      const parsed = z.object({
        id: z.string().uuid().optional(),
        title: z.string().min(1).max(200),
        personaTemplateId: z.string().uuid().optional(),
        playerProfile: ConversationPlayerProfileSchema.omit({ sourcePersonaId: true }),
        setup: z.record(z.string(), z.unknown()).default({}),
        maxPromptTokens: z.number().int().positive().max(1_000_000).default(128_000),
        maxResponseTokens: z.number().int().positive().max(384_000).default(32_768),
      }).strict().safeParse(rawInput);
      if (!parsed.success) throw new SceneServiceError('invalid_request', 400);
      const sourcePersona = parsed.data.personaTemplateId === undefined
        ? undefined
        : repositories.personas.get(parsed.data.personaTemplateId);
      if (parsed.data.personaTemplateId !== undefined && (sourcePersona === undefined || sourcePersona.sceneInternal)) {
        throw new SceneServiceError('persona_not_found', 404);
      }
      const playerProfile: ConversationPlayerProfile = {
        ...parsed.data.playerProfile,
        ...(sourcePersona === undefined ? {} : { sourcePersonaId: sourcePersona.id }),
      };
      const initialized = scene.manifest.serverEntry === undefined
        ? { initialState: {}, openingMessages: [] }
        : HookInitializeResultSchema.parse(await module(scene)!.call('initializeConversation', {
          setup: parsed.data.setup, playerProfile, manifest: scene.manifest,
        }));
      assertSceneState(initialized.initialState);
      return database.transaction(() => {
        const persona = repositories.personas.create({
          id: randomUUID(), name: playerProfile.name, description: playerProfile.description,
          isDefault: false, sceneInternal: true,
        });
        const conversation = repositories.conversations.create({
          id: parsed.data.id ?? randomUUID(),
          characterId: scene.backingCharacterId,
          personaId: persona.id,
          sceneId: scene.id,
          playerProfile,
          setup: parsed.data.setup,
          title: initialized.title ?? parsed.data.title,
          maxPromptTokens: parsed.data.maxPromptTokens,
          maxResponseTokens: parsed.data.maxResponseTokens,
        });
        repositories.conversationSceneStates.create({
          id: randomUUID(), conversationId: conversation.id, schemaVersion: 1, value: initialized.initialState,
        });
        for (const opening of initialized.openingMessages) {
          const message = repositories.messages.create({
            id: randomUUID(), conversationId: conversation.id, role: opening.role,
            content: opening.content, activeVariantId: null,
          });
          const variant = repositories.messageVariants.create({
            id: randomUUID(), messageId: message.id, ordinal: 0, content: opening.content,
            status: 'completed', finishReason: 'stop',
          });
          const activated = repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id });
          if (!activated.ok) throw new Error('scene_opening_activation_failed');
        }
        return conversation;
      });
    },
    state(conversationId) {
      return repositories.conversationSceneStates.getByConversationId(conversationId);
    },
    patchState(conversationId, expectedRevision, patch) {
      const current = repositories.conversationSceneStates.getByConversationId(conversationId);
      if (current === undefined) throw new SceneServiceError('scene_state_not_found', 404);
      if (current.revision !== expectedRevision) throw new SceneServiceError('conflict', 409);
      const value = applyScenePatch(current.value, patch);
      const updated = repositories.conversationSceneStates.update(current.id, current.revision, { value });
      if (!updated.ok) throw new SceneServiceError(updated.reason, updated.reason === 'not_found' ? 404 : 409);
      return updated.value;
    },
    module,
    assetPath(sceneId, rawPath) {
      const scene = get(sceneId);
      if (scene === undefined) throw new SceneServiceError('scene_not_found', 404);
      const path = safeRelativePath(rawPath);
      if (!scene.manifest.files.includes(path)) throw new SceneServiceError('scene_asset_not_found', 404);
      const target = resolve(scene.installPath, ...path.split('/'));
      if (!within(scene.installPath, target) || !existsSync(target)) throw new SceneServiceError('scene_asset_not_found', 404);
      return target;
    },
    async uninstall(sceneId, expectedRevision) {
      const scene = get(sceneId);
      if (scene === undefined) throw new SceneServiceError('scene_not_found', 404);
      if (scene.revision !== expectedRevision) throw new SceneServiceError('conflict', 409);
      const backupRoot = resolve(dataDir, 'backups', `scene-delete-${new Date().toISOString().replaceAll(':', '-')}-${scene.id}`);
      mkdirSync(backupRoot, { recursive: true });
      const backupPath = join(backupRoot, 'tavernnext.sqlite');
      copyFileSync(database.path, backupPath);
      const conversations = repositories.conversations.list(4_096).filter((item) => item.sceneId === scene.id);
      database.transaction(() => {
        for (const conversation of conversations) {
          const deleted = repositories.conversations.delete(conversation.id, conversation.revision);
          if (!deleted.ok) throw new Error(deleted.reason);
          const persona = repositories.personas.get(conversation.personaId);
          if (persona?.sceneInternal) repositories.personas.delete(persona.id, persona.revision);
        }
        const deleted = repositories.installedScenes.delete(scene.id, scene.revision);
        if (!deleted.ok) throw new Error(deleted.reason);
        const character = repositories.characters.get(scene.backingCharacterId);
        if (character !== undefined) {
          if (character.worldbookId !== undefined) {
            repositories.worldbookEntries.deleteByWorldbookId(character.worldbookId);
            const book = repositories.worldbooks.get(character.worldbookId);
            if (book !== undefined) repositories.worldbooks.delete(book.id, book.revision);
          }
          repositories.characters.delete(character.id, character.revision);
        }
        if (scene.backingPresetId !== undefined) {
          const preset = repositories.presets.get(scene.backingPresetId);
          if (preset !== undefined) repositories.presets.delete(preset.id, preset.revision);
        }
      });
      await moduleRegistry.remove(scene.id);
      if (within(sceneRoot, scene.installPath) && existsSync(scene.installPath)) {
        rmSync(scene.installPath, { recursive: true, force: true });
      }
      return { backupPath };
    },
    close: () => moduleRegistry.close(),
  };
}
