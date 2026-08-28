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
  SceneActionResultSchema,
  SceneBeforeGenerationResultSchema,
  SceneInitializeResultSchema,
  SceneManifestSchema,
  ScenePatchOperationSchema,
  type Conversation,
  type ConversationPlayerProfile,
  type ConversationSceneState,
  type InstalledScene,
  type Message,
  type MessageVariant,
  type SceneCatalog,
  type SceneManifest,
  type ScenePatchFailure,
  type ScenePatchOperation,
  type SceneStateTransitionSourceKind,
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
import { persistPresetBytes } from '../services/preset-import-handler.js';
import {
  createSaveAgentConfiguration,
  SaveAgentConfigurationError,
} from '../services/save-agent-configuration-service.js';
import { persistDecodedWorldbook } from '../services/worldbook-import-handler.js';
import { builtInPackage, officialCatalog } from './official-package.js';
import { SceneModuleRegistry } from './scene-module-host.js';

const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SCENE_STATE_BYTES = 4 * 1024 * 1024;

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

export function assertSceneState(value: Record<string, unknown>, _manifest?: SceneManifest): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SCENE_STATE_BYTES) {
    throw new SceneServiceError('scene_state_too_large', 422);
  }
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw new SceneServiceError('scene_patch_invalid', 400);
  return pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function parentAt(
  root: Record<string, unknown>,
  pointer: string,
  createMissingObjects = false,
): { parent: Record<string, unknown> | unknown[]; key: string } {
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
      if (item === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
      let child = Object.hasOwn(item, part) ? item[part] : undefined;
      if (child === undefined && createMissingObjects) {
        child = {};
        Object.defineProperty(item, part, {
          value: child, enumerable: true, configurable: true, writable: true,
        });
      }
      if (child === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
      current = child;
    }
  }
  if (!Array.isArray(current) && record(current) === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
  return { parent: current as Record<string, unknown> | unknown[], key };
}

function valueAt(root: Record<string, unknown>, pointer: string): unknown {
  let value: unknown = root;
  for (const part of pointerParts(pointer)) {
    if (Array.isArray(value)) value = value[Number(part)];
    else {
      const item = record(value);
      value = item !== undefined && Object.hasOwn(item, part) ? item[part] : undefined;
    }
    if (value === undefined) throw new SceneServiceError('scene_patch_invalid', 400);
  }
  return value;
}

export function applyScenePatch(
  source: Record<string, unknown>,
  rawOperations: unknown,
  manifest?: SceneManifest,
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
    const { parent, key } = parentAt(value, path, !replaceOnly);
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
    Object.defineProperty(parent, key, {
      value: next, enumerable: true, configurable: true, writable: true,
    });
  };
  for (const operation of operations) {
    if (operation.op === 'remove') remove(operation.path);
    else if (operation.op === 'add' || operation.op === 'insert') {
      put(operation.path, structuredClone(operation.value), false);
    }
    else if (operation.op === 'replace') put(operation.path, structuredClone(operation.value), true);
    else if (operation.op === 'delta') {
      const current = valueAt(value, operation.path);
      if (typeof current !== 'number' || typeof operation.value !== 'number') throw new SceneServiceError('scene_patch_invalid', 400);
      put(operation.path, current + operation.value, true);
    } else if (operation.op === 'test') {
      if (JSON.stringify(valueAt(value, operation.path)) !== JSON.stringify(operation.value)) {
        throw new SceneServiceError('scene_patch_test_failed', 409);
      }
    } else if (operation.op === 'copy') {
      put(operation.path, structuredClone(valueAt(value, operation.from)), false);
    } else if (operation.op === 'move') {
      const target = 'to' in operation ? operation.to : operation.path;
      put(target, remove(operation.from), false);
    } else {
      throw new SceneServiceError('scene_patch_invalid', 400);
    }
  }
  assertSceneState(value, manifest);
  return value;
}

export interface ScenePatchApplication {
  value: Record<string, unknown>;
  operations: ScenePatchOperation[];
  failures: ScenePatchFailure[];
}

function patchFailure(operationIndex: number, raw: unknown, code: string): ScenePatchFailure {
  const operation = record(raw);
  const field = (key: string) => typeof operation?.[key] === 'string' ? operation[key] as string : undefined;
  return {
    operationIndex,
    code,
    ...(field('op') === undefined ? {} : { op: field('op') }),
    ...(field('path') === undefined ? {} : { path: field('path') }),
    ...(field('from') === undefined ? {} : { from: field('from') }),
    ...(field('to') === undefined ? {} : { to: field('to') }),
  };
}

export function applyScenePatchPartial(
  source: Record<string, unknown>,
  rawOperations: unknown,
  manifest?: SceneManifest,
): ScenePatchApplication {
  if (!Array.isArray(rawOperations) || rawOperations.length > 512) {
    throw new SceneServiceError('scene_patch_invalid', 400);
  }
  let value = structuredClone(source);
  const operations: ScenePatchOperation[] = [];
  const failures: ScenePatchFailure[] = [];
  for (const [operationIndex, raw] of rawOperations.entries()) {
    const parsed = ScenePatchOperationSchema.safeParse(raw);
    if (!parsed.success) {
      failures.push(patchFailure(operationIndex, raw, 'scene_patch_operation_invalid'));
      continue;
    }
    try {
      value = applyScenePatch(value, [parsed.data], manifest);
      operations.push(parsed.data);
    } catch (error) {
      failures.push(patchFailure(
        operationIndex,
        raw,
        error instanceof SceneServiceError ? error.code : 'scene_patch_operation_failed',
      ));
    }
  }
  return { value, operations, failures };
}

function characterDepthPrompt(extensions: Record<string, unknown>): string {
  const depth = record(extensions.depth_prompt);
  return typeof depth?.prompt === 'string' ? depth.prompt : '';
}

function packageCharacter(
  files: Record<string, Uint8Array>,
  manifest: SceneManifest,
  repositories: Repositories,
): {
  characterId: string;
  presetId?: string;
} {
  const characterPath = manifest.backingCharacterPath ?? 'content/character.png';
  const cardBytes = files[characterPath];
  if (cardBytes === undefined) throw new SceneServiceError('scene_character_missing', 422);
  const decoded = decodeInspectedCharacter(cardBytes, characterPath);
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
  if (manifest.backingPresetPath === undefined) return { characterId: id };
  const presetBytes = files[manifest.backingPresetPath];
  if (presetBytes === undefined) throw new SceneServiceError('scene_preset_missing', 422);
  let preset;
  try {
    preset = persistPresetBytes(repositories, presetBytes, manifest.backingPresetPath);
  } catch {
    throw new SceneServiceError('scene_preset_invalid', 422);
  }
  if (preset.kind !== 'chat') throw new SceneServiceError('scene_preset_invalid', 422);
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
  patchState(conversationId: string, expectedRevision: number, patch: unknown): {
    state: ConversationSceneState;
    failures: ScenePatchFailure[];
  };
  commitStateTransition(
    conversationId: string,
    expectedRevision: number,
    patch: unknown,
    source: {
      kind: SceneStateTransitionSourceKind;
      id: string;
      parentTransitionId?: string | null;
      baseValue?: Record<string, unknown>;
    },
  ): ConversationSceneState;
  switchVariantState(message: Message, variant: MessageVariant): ConversationSceneState | undefined;
  deleteMessageState(message: Message): void;
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

  const sceneForConversation = (conversationId: string) => {
    const conversation = repositories.conversations.get(conversationId);
    const scene = conversation?.sceneId === undefined ? undefined : get(conversation.sceneId);
    if (conversation === undefined || scene === undefined) throw new SceneServiceError('scene_not_found', 404);
    return { conversation, scene };
  };

  const commitStateTransition: SceneService['commitStateTransition'] = (
    conversationId,
    expectedRevision,
    rawPatch,
    source,
  ) => {
    const current = repositories.conversationSceneStates.getByConversationId(conversationId);
    if (current === undefined) throw new SceneServiceError('scene_state_not_found', 404);
    if (current.revision !== expectedRevision) throw new SceneServiceError('conflict', 409);
    const { scene } = sceneForConversation(conversationId);
    const operations = z.array(ScenePatchOperationSchema).max(512).parse(rawPatch) as ScenePatchOperation[];
    const baseValue = source.baseValue ?? current.value;
    const value = applyScenePatch(baseValue, operations, scene.manifest);
    return database.transaction(() => {
      const existing = repositories.sceneStateTransitions.getBySource(source.kind, source.id);
      if (existing !== undefined) {
        if (source.kind !== 'message-variant' || current.headTransitionId !== existing.id) {
          throw new SceneServiceError('scene_transition_conflict', 409);
        }
        const updatedTransition = repositories.sceneStateTransitions.update(existing.id, existing.revision, {
          operations: [...existing.operations, ...operations],
          value,
        });
        if (!updatedTransition.ok) throw new SceneServiceError(updatedTransition.reason, 409);
        const updatedState = repositories.conversationSceneStates.update(current.id, current.revision, { value });
        if (!updatedState.ok) throw new SceneServiceError(updatedState.reason, 409);
        return updatedState.value;
      }
      const transition = repositories.sceneStateTransitions.create({
        id: randomUUID(), conversationId,
        parentTransitionId: source.parentTransitionId === undefined ? current.headTransitionId : source.parentTransitionId,
        sourceKind: source.kind, sourceId: source.id, operations, value,
      });
      const updated = repositories.conversationSceneStates.update(current.id, current.revision, {
        headTransitionId: transition.id,
        value,
      });
      if (!updated.ok) throw new SceneServiceError(updated.reason, updated.reason === 'not_found' ? 404 : 409);
      return updated.value;
    });
  };

  const tailMessage = (message: Message): void => {
    const messages = repositories.messages.listByConversationId(message.conversationId);
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) throw new SceneServiceError('not_found', 404);
    if (index !== messages.length - 1) throw new SceneServiceError('scene_branch_has_descendants', 409);
  };

  return {
    catalog: officialCatalog,
    list: () => repositories.installedScenes.list(512),
    get,
    async install(sceneId) {
      const entry = officialCatalog().scenes.find((candidate) => candidate.sceneId === sceneId);
      if (entry === undefined) throw new SceneServiceError('scene_not_found', 404);
      const existing = get(sceneId);
      if (existing !== undefined) {
        if (existing.version === entry.version) return existing;
        throw new SceneServiceError('scene_update_not_supported', 409);
      }
      const builtIn = builtInPackage(entry.packageUrl);
      if (builtIn === undefined) throw new SceneServiceError('scene_package_source_unsupported', 422);
      const bytes = builtIn.bytes;
      const digest = createHash('sha256').update(bytes).digest('hex');
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
          const backing = packageCharacter(files, manifest, repositories);
          return repositories.installedScenes.create({
            id: manifest.id,
            slug: manifest.slug,
            version: manifest.version,
            archiveDigest: digest,
            installPath: target,
            installedAt: new Date().toISOString(),
            manifest,
            backingCharacterId: backing.characterId,
            ...(backing.presetId === undefined ? {} : { backingPresetId: backing.presetId }),
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
        : SceneInitializeResultSchema.parse(await module(scene)!.call('initializeConversation', {
          setup: parsed.data.setup, playerProfile, manifest: scene.manifest,
        }));
      assertSceneState(initialized.initialState, scene.manifest);
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
        try {
          createSaveAgentConfiguration(repositories, conversation.id, scene.backingPresetId);
        } catch (error) {
          if (error instanceof SaveAgentConfigurationError) {
            throw new SceneServiceError(error.code, error.code === 'preset_not_configured' ? 409 : 422);
          }
          throw error;
        }
        repositories.saveMemoryConfigurations.create({
          id: randomUUID(), conversationId: conversation.id, enabled: true,
        });
        repositories.conversationSceneStates.create({
          id: randomUUID(), conversationId: conversation.id, schemaVersion: 1,
          baseValue: initialized.initialState, headTransitionId: null, value: initialized.initialState,
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
      const { scene } = sceneForConversation(conversationId);
      const applied = applyScenePatchPartial(current.value, patch, scene.manifest);
      const state = applied.operations.length === 0
        ? current
        : commitStateTransition(conversationId, expectedRevision, applied.operations, {
          kind: 'sdk-patch', id: randomUUID(),
        });
      return { state, failures: applied.failures };
    },
    commitStateTransition,
    switchVariantState(message, variant) {
      const conversation = repositories.conversations.get(message.conversationId);
      if (conversation?.sceneId === undefined) return undefined;
      tailMessage(message);
      const current = repositories.conversationSceneStates.getByConversationId(message.conversationId);
      if (current === undefined) throw new SceneServiceError('scene_state_not_found', 404);
      const siblings = new Set(repositories.messageVariants.listByMessageId(message.id).map((item) => item.id));
      const siblingTransitions = [...siblings].flatMap((id) => {
        const transition = repositories.sceneStateTransitions.getBySource('message-variant', id);
        return transition === undefined ? [] : [transition];
      });
      const fallbackParentId = siblingTransitions.length > 0
        ? siblingTransitions[0]!.parentTransitionId
        : current.headTransitionId;
      const head = current.headTransitionId === null ? undefined : repositories.sceneStateTransitions.get(current.headTransitionId);
      if (head !== undefined && head.id !== fallbackParentId
        && (head.sourceKind !== 'message-variant' || !siblings.has(head.sourceId))) {
        throw new SceneServiceError('scene_branch_has_descendants', 409);
      }
      const selected = repositories.sceneStateTransitions.getBySource('message-variant', variant.id);
      const fallbackParent = fallbackParentId === null ? undefined : repositories.sceneStateTransitions.get(fallbackParentId);
      const value = selected?.value ?? fallbackParent?.value ?? current.baseValue;
      const updated = repositories.conversationSceneStates.update(current.id, current.revision, {
        headTransitionId: selected?.id ?? fallbackParent?.id ?? null,
        value,
      });
      if (!updated.ok) throw new SceneServiceError(updated.reason, 409);
      return updated.value;
    },
    deleteMessageState(message) {
      const conversation = repositories.conversations.get(message.conversationId);
      if (conversation?.sceneId === undefined) return;
      tailMessage(message);
      if (message.role !== 'assistant') return;
      const current = repositories.conversationSceneStates.getByConversationId(message.conversationId);
      if (current === undefined) throw new SceneServiceError('scene_state_not_found', 404);
      const variants = repositories.messageVariants.listByMessageId(message.id);
      const variantTransitions = variants.flatMap((variant) => {
        const transition = repositories.sceneStateTransitions.getBySource('message-variant', variant.id);
        return transition === undefined ? [] : [transition];
      });
      if (variantTransitions.length === 0) return;
      const removedIds = new Set(variantTransitions.map((transition) => transition.id));
      const all = repositories.sceneStateTransitions.listByConversationId(message.conversationId);
      for (;;) {
        const priorSize = removedIds.size;
        for (const transition of all) {
          if (transition.parentTransitionId !== null && removedIds.has(transition.parentTransitionId)) {
            removedIds.add(transition.id);
          }
        }
        if (removedIds.size === priorSize) break;
      }
      const fallbackParentId = variantTransitions[0]?.parentTransitionId ?? null;
      if (current.headTransitionId !== null && current.headTransitionId !== fallbackParentId
        && !removedIds.has(current.headTransitionId)) {
        throw new SceneServiceError('scene_branch_has_descendants', 409);
      }
      const active = message.activeVariantId === null
        ? undefined
        : repositories.sceneStateTransitions.getBySource('message-variant', message.activeVariantId);
      const activeParentId = active?.parentTransitionId ?? fallbackParentId;
      const parent = activeParentId === null
        ? undefined
        : repositories.sceneStateTransitions.get(activeParentId);
      const updated = repositories.conversationSceneStates.update(current.id, current.revision, {
        headTransitionId: parent?.id ?? null,
        value: parent?.value ?? current.baseValue,
      });
      if (!updated.ok) throw new SceneServiceError(updated.reason, 409);
      for (const transition of all.filter((item) => removedIds.has(item.id)).reverse()) {
        const deleted = repositories.sceneStateTransitions.delete(transition.id, transition.revision);
        if (!deleted.ok) throw new SceneServiceError(deleted.reason, 409);
      }
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
