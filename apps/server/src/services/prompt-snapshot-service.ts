import { createHash, randomUUID } from 'node:crypto';
import {
  EMPTY_WORLDBOOK_TIMED_STATE,
  roleplayDocumentPlainText,
  WorldbookTimedStateSchema,
  type Character,
  type Conversation,
  type GenerationMode,
  type Message,
  type MessageVariant,
  type Persona,
  type Preset,
  type SaveAgentConfiguration,
  type ProviderProfile,
  type Worldbook,
  type WorldbookEntry,
  type WorldbookRuntimeState,
  type WorldbookTimedState,
  type ScenePromptAddition,
} from '@tavernnext/domain';
import {
  parsedRegexAssets,
  regexWorkerLimitsForProjection,
  REGEX_PLACEMENT,
  runOwnedRegexModeProjectionInWorker,
  type OwnedRegexTraceEntry,
  type TavernRegex,
} from '@tavernnext/extension-runtime';
import { createNodeRegexWorker } from '@tavernnext/extension-runtime/node';
import {
  compileChatPrompt,
  evaluateWorldbooks,
  type PromptChatMessage,
  type PromptWarning,
  type TokenBreakdownEntry,
  type WorldInfoCompilerPlacements,
  type WorldbookEvaluationResult,
  type WorldbookRuntimeBook,
} from '@tavernnext/prompt-engine';
import type { ChatRequest } from '@tavernnext/provider-openai-compatible';
import {
  executablePresetFields,
  normalizeCharacterBook,
  presetSettingsForExecution,
  validatePresetFamily,
  type NormalizedWorldbook,
  type NormalizedWorldbookEntry,
  type PresetKind,
} from '@tavernnext/st-compat';
import {
  TOKENIZER_IDS,
  TokenizerId,
  type TokenizerDecision,
  type TokenizerSelectionInput,
} from '@tavernnext/tokenizer-engine';
import type { TavernDatabase } from '../db/client.js';
import {
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_VARIANTS_PER_RELATION,
  RelationshipLimitError,
  type Repositories,
} from '../db/repositories.js';
import { normalizedWorldbookFromRows } from './worldbook-import-handler.js';

export const PROMPT_SNAPSHOT_SCHEMA_VERSION = 5 as const;
const EXECUTABLE_AUDIT_SCHEMA_VERSION = 4 as const;

export interface ServerTokenizerRuntime {
  selectTokenizer(input: TokenizerSelectionInput): TokenizerDecision;
  countText(text: string, decision: TokenizerDecision): Promise<number>;
  countMessages(messages: readonly PromptChatMessage[], decision: TokenizerDecision): Promise<number>;
}

export interface PromptSnapshotInput {
  conversationId: string;
  conversationRevision: number;
  mode: GenerationMode;
  userText?: string;
  seed?: string | number;
  messageIndex?: number;
  targetMessageId?: string;
  targetVariantId?: string;
  /** Internal /trigger path: compile the already-persisted final user message without duplicating it. */
  reuseLastUser?: boolean;
}

export interface ScenePromptContext {
  state: Record<string, unknown>;
  additions: ScenePromptAddition[];
  memoryRecall?: MemoryRecallSnapshotEntry[];
  memoryQueryCorpus?: MemoryRecallSnapshotEntry[];
}

export interface MemoryRecallSnapshotEntry {
  id: string;
  revision: number;
  kind: string;
  tier: string;
  summary: string;
  detail: string;
  tokenCount: number;
}

export interface RevisionRef {
  id: string;
  revision: number;
}

export interface PresetRevisionRef extends RevisionRef {
  kind: PresetKind;
}

export interface WorldbookRevisionRef extends RevisionRef {
  source: 'global' | 'character' | 'conversation';
  entries: RevisionRef[];
}

export interface MessageRevisionRef extends RevisionRef {
  activeVariant: RevisionRef | null;
}

export interface PromptEntityRevisionManifest {
  globalGenerationConfig: RevisionRef;
  conversation: RevisionRef;
  character: RevisionRef;
  persona: RevisionRef;
  provider: RevisionRef;
  presets: PresetRevisionRef[];
  saveAgentConfiguration: RevisionRef;
  globalWorldbooks: RevisionRef[];
  worldbooks: WorldbookRevisionRef[];
  messages: MessageRevisionRef[];
  runtimeState: RevisionRef | null;
  installedScene?: RevisionRef | null;
  sceneState?: RevisionRef | null;
}

export interface SnapshotInputPayload {
  conversationId: string;
  conversationRevision: number;
  mode: GenerationMode;
  userText: string | null;
  seed: string | number;
  messageIndex: number;
  targetMessageId: string | null;
  targetVariantId: string | null;
  reuseLastUser?: boolean;
}

export interface PromptSnapshotPayload {
  schemaVersion: typeof PROMPT_SNAPSHOT_SCHEMA_VERSION;
  input: SnapshotInputPayload;
  kind: 'chat';
  seed: string | number;
  messageIndex: number;
  entityRevisions: PromptEntityRevisionManifest;
  executable: Record<string, unknown>;
  worldbook: WorldbookEvaluationResult;
  tokenizerDecision: TokenizerDecision;
  messages: PromptChatMessage[];
  stop: string[];
  tokenBreakdown: TokenBreakdownEntry[];
  totalTokens: number;
  warnings: PromptWarning[];
  worldInfoOutlets: Record<string, string>;
  memoryRecall: MemoryRecallSnapshotEntry[];
  memoryQueryCorpus: MemoryRecallSnapshotEntry[];
  compiledRequest: ChatRequest;
  compiledRequestHash: string;
  payloadHash: string;
}

export type PromptSnapshotErrorCode =
  | 'invalid_user_text'
  | 'invalid_target'
  | 'unsupported_mode'
  | 'not_found'
  | 'provider_not_configured'
  | 'model_not_agent_capable'
  | 'preset_not_configured'
  | 'invalid_preset'
  | 'revision_conflict'
  | 'snapshot_stale'
  | 'snapshot_mismatch'
  | 'snapshot_invalid'
  | 'snapshot_unsupported'
  | 'aggregate_limit'
  | 'invalid_runtime_state'
  | 'unsupported_worldbook_placement'
  | 'context_overflow'
  | 'tokenizer_error';

export class PromptSnapshotError extends Error {
  constructor(readonly code: PromptSnapshotErrorCode) {
    super(code);
    this.name = 'PromptSnapshotError';
  }
}

export function promptSnapshotErrorStatus(code: PromptSnapshotErrorCode): 400 | 404 | 409 | 422 {
  if (code === 'invalid_user_text' || code === 'invalid_target' || code === 'unsupported_mode') return 400;
  if (code === 'not_found') return 404;
  if (code === 'revision_conflict' || code === 'snapshot_stale'
    || code === 'snapshot_mismatch' || code === 'snapshot_invalid' || code === 'snapshot_unsupported') return 409;
  return 422;
}

interface LoadedBookBase {
  id: string;
  book: NormalizedWorldbook;
}

interface LoadedPersistedBook extends LoadedBookBase {
  source: 'global' | 'character' | 'conversation';
  row: Worldbook;
  entries: WorldbookEntry[];
}

interface LoadedEmbeddedBook extends LoadedBookBase {
  source: 'embedded';
  compatibilityWarnings: PromptWarning[];
}

type LoadedBook = LoadedPersistedBook | LoadedEmbeddedBook;

interface LoadedAggregate {
  input: SnapshotInputPayload;
  globalGenerationConfig: ReturnType<Repositories['globalGenerationConfig']['get']>;
  conversation: Conversation;
  character: Character;
  persona: Persona;
  provider: ProviderProfile;
  presets: Preset[];
  history: Array<{ id: string; role: string; content: string }>;
  books: LoadedBook[];
  previousTimedState: WorldbookTimedState;
  manifest: PromptEntityRevisionManifest;
  compatibilityWarnings: PromptWarning[];
  regexScripts: { preset: TavernRegex[]; character: TavernRegex[] };
  scenePromptAdditions: ScenePromptAddition[];
  memoryRecall: MemoryRecallSnapshotEntry[];
  memoryQueryCorpus: MemoryRecallSnapshotEntry[];
}

interface BuiltSnapshot {
  payload: PromptSnapshotPayload;
  manifest: PromptEntityRevisionManifest;
}

export interface AcceptedPromptSnapshot {
  snapshotId: string;
  payload: PromptSnapshotPayload;
  provider: ProviderProfile;
  saveAgentConfiguration: SaveAgentConfiguration;
  deferredSnapshotCommit?: true;
}

export type PromptSnapshotBeforeAccept = (
  candidate: AcceptedPromptSnapshot,
) => Promise<void | { deferSnapshotCommit: true }>;

export interface PromptSnapshotService {
  createAndAccept(
    input: PromptSnapshotInput,
    snapshotId: string,
    sceneContext?: ScenePromptContext,
    beforeAccept?: PromptSnapshotBeforeAccept,
  ): Promise<AcceptedPromptSnapshot>;
  commitDeferredSnapshot(snapshotId: string, payload: PromptSnapshotPayload): void;
  completeDeferredSnapshot(snapshotId: string): void;
  releaseDeferredSnapshot(snapshotId: string): void;
  commitTimedState(payload: PromptSnapshotPayload): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function deepJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function ref(value: { id: string; revision: number }): RevisionRef {
  return { id: value.id, revision: value.revision };
}

function validCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PromptSnapshotError('tokenizer_error');
  return value;
}

function safePreset(preset: Preset, expectedKind: PresetKind): Preset {
  if (preset.kind !== expectedKind) throw new PromptSnapshotError('invalid_preset');
  try {
    const markerFree = preset.compatibility === undefined
      ? presetSettingsForExecution(preset.settings)
      : presetSettingsForExecution(preset.settings, preset.compatibility, expectedKind);
    const settings = executablePresetFields(
      expectedKind,
      validatePresetFamily(expectedKind, markerFree),
    ).settings;
    return {
      id: preset.id,
      revision: preset.revision,
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
      name: preset.name,
      kind: preset.kind,
      settings: deepJson(settings),
      extensions: {},
    };
  } catch (error) {
    if (error instanceof PromptSnapshotError) throw error;
    throw new PromptSnapshotError('invalid_preset');
  }
}

function stripBookAuditFields(book: NormalizedWorldbook): NormalizedWorldbook {
  return {
    name: book.name,
    description: book.description,
    enabled: book.enabled,
    scanDepth: book.scanDepth,
    tokenBudget: book.tokenBudget,
    recursiveScanning: book.recursiveScanning,
    extensions: {},
    unknownFields: {},
    entries: book.entries.map((entry) => ({
      ...deepJson(entry),
      extensions: {},
      unknownFields: {},
      characterFilter: {
        isExclude: entry.characterFilter.isExclude,
        names: [...entry.characterFilter.names],
        tags: [...entry.characterFilter.tags],
      },
      personaFilter: {
        isExclude: entry.personaFilter.isExclude,
        names: [...entry.personaFilter.names],
        tags: [...entry.personaFilter.tags],
      },
    })),
  };
}

function boundedRelation<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RelationshipLimitError) throw new PromptSnapshotError('aggregate_limit');
    throw error;
  }
}

function revalidatedRelation<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof RelationshipLimitError
      || (error instanceof PromptSnapshotError && error.code === 'aggregate_limit')) stale();
    throw error;
  }
}

function appendCompatibilityWarnings(
  target: PromptWarning[],
  value: { compatibility?: { compatWarnings: string[] } },
  source: string,
): void {
  for (const message of value.compatibility?.compatWarnings ?? []) {
    target.push({ code: 'compatibility_warning', message, source });
  }
}

function stableEmbeddedBook(character: Character): LoadedEmbeddedBook | undefined {
  // Imports persist an embedded Character Book as a first-class linked Worldbook.
  // Do not inject the raw embedded copy a second time when that normalized link exists.
  if (character.worldbookId !== undefined) return undefined;
  if (character.characterBook === undefined) return undefined;
  const result = normalizeCharacterBook(
    deepJson(character.characterBook),
    `${character.name} Book`,
  );
  const normalized = result.worldbook;
  const rawEntries = Array.isArray(character.characterBook.entries) ? character.characterBook.entries : [];
  const occurrences = new Map<string, number>();
  normalized.entries = normalized.entries.map((entry, index): NormalizedWorldbookEntry => {
    const raw = rawEntries[index] ?? {};
    const fingerprint = canonicalHash(raw);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const rawRecord = record(raw) ? raw : {};
    const rawUid = rawRecord.id;
    return {
      ...entry,
      id: `embedded-${canonicalHash([character.id, fingerprint, occurrence])}`,
      sourceUid: typeof rawUid === 'string' || (typeof rawUid === 'number' && Number.isFinite(rawUid))
        ? rawUid
        : `embedded-${fingerprint}`,
      sourceOrdinal: index,
    };
  });
  return {
    id: `embedded:${character.id}`,
    source: 'embedded',
    book: stripBookAuditFields(normalized),
    compatibilityWarnings: result.warnings.map((warning) => ({
      code: 'compatibility_warning',
      message: `${warning.code}: ${warning.message}`,
      source: `embedded-worldbook:${character.id}`,
    })),
  };
}

function historyRows(repositories: Repositories, conversationId: string): {
  history: LoadedAggregate['history'];
  manifest: MessageRevisionRef[];
  compatibilityWarnings: PromptWarning[];
  messages: Message[];
  variants: Map<string, MessageVariant>;
} {
  const variantRows = boundedRelation(() => repositories.messageVariants.listByConversationId(conversationId));
  const variants = new Map(variantRows.map((variant) => [variant.id, variant]));
  const messages = boundedRelation(() => repositories.messages.listByConversationId(conversationId));
  for (const message of messages) {
    if (message.activeVariantId === null) continue;
    const variant = variants.get(message.activeVariantId);
    if (variant === undefined || variant.messageId !== message.id) throw new PromptSnapshotError('invalid_target');
  }
  return {
    history: messages.map((message) => {
      const variant = message.activeVariantId === null ? undefined : variants.get(message.activeVariantId);
      return {
        id: message.id,
        role: message.role,
        content: message.role === 'assistant' && variant !== undefined
          ? roleplayDocumentPlainText(variant.document)
          : message.content,
      };
    }),
    manifest: messages.map((message) => {
      const variant = message.activeVariantId === null ? undefined : variants.get(message.activeVariantId);
      return {
        ...ref(message),
        activeVariant: variant === undefined ? null : ref(variant),
      };
    }),
    compatibilityWarnings: [
      ...messages.flatMap((message) => (message.compatibility?.compatWarnings ?? []).map((warning) => ({
        code: 'compatibility_warning', message: warning, source: `message:${message.id}`,
      } as PromptWarning))),
      ...variantRows.flatMap((variant) => (variant.compatibility?.compatWarnings ?? []).map((warning) => ({
        code: 'compatibility_warning', message: warning, source: `variant:${variant.id}`,
      } as PromptWarning))),
    ],
    messages,
    variants,
  };
}

function requestedPreset(
  repositories: Repositories,
  id: string | undefined,
  kind: PresetKind,
  compatibilityWarnings: PromptWarning[],
): Preset {
  if (id === undefined) throw new PromptSnapshotError('preset_not_configured');
  const preset = repositories.presets.get(id);
  if (preset === undefined) throw new PromptSnapshotError('not_found');
  for (const message of preset.compatibility?.compatWarnings ?? []) {
    compatibilityWarnings.push({ code: 'compatibility_warning', message, source: `preset:${preset.id}` });
  }
  return safePreset(preset, kind);
}

function privateSavePreset(configuration: SaveAgentConfiguration): Preset {
  const requiredMarkers = [
    { identifier: 'charDescription', marker: true, role: 'system', system_prompt: true },
    { identifier: 'personaDescription', marker: true, role: 'system', system_prompt: true },
    { identifier: 'worldInfoBefore', marker: true, role: 'system', system_prompt: true },
    { identifier: 'chatHistory', marker: true, system_prompt: true },
    { identifier: 'worldInfoAfter', marker: true, role: 'system', system_prompt: true },
  ];
  const rawPrompts = Array.isArray(configuration.settings.prompts)
    ? configuration.settings.prompts.filter(record)
    : [];
  const requiredIds = new Set(requiredMarkers.map(({ identifier }) => identifier));
  const prompts = [
    ...rawPrompts.filter((prompt) => !requiredIds.has(String(prompt.identifier))),
    ...requiredMarkers,
  ];
  const rawOrders = Array.isArray(configuration.settings.prompt_order)
    ? configuration.settings.prompt_order.filter(record)
    : [];
  const orders = (rawOrders.length === 0 ? [{ character_id: 100001, order: [] }] : rawOrders).map((row) => ({
    ...row,
    order: [
      ...(Array.isArray(row.order) ? row.order.filter(record) : [])
        .filter((item) => !requiredIds.has(String(item.identifier))),
      ...requiredMarkers.map(({ identifier }) => ({ identifier, enabled: true })),
    ],
  }));
  return {
    id: configuration.id,
    revision: configuration.revision,
    createdAt: configuration.createdAt,
    updatedAt: configuration.updatedAt,
    name: configuration.name,
    kind: 'chat',
    settings: { ...configuration.settings, prompts, prompt_order: orders },
    extensions: {},
  };
}

function persistedBook(
  repositories: Repositories,
  row: Worldbook,
  source: LoadedPersistedBook['source'],
): LoadedPersistedBook {
  const entries = boundedRelation(() => repositories.worldbookEntries.listByWorldbookId(row.id));
  return {
    id: row.id,
    source,
    row,
    entries,
    book: stripBookAuditFields(normalizedWorldbookFromRows(row, entries)),
  };
}

export function applySceneWorldbookEntryOverrides(
  book: LoadedBook,
  entryOverrides: WorldbookRuntimeState['entryOverrides'],
): LoadedBook {
  const overrides = new Map(entryOverrides
    .filter((override) => override.source === book.source)
    .map((override) => [override.comment, override]));
  return {
    ...book,
    book: {
      ...book.book,
      entries: book.book.entries.map((entry) => {
        const label = `${entry.comment}\n${entry.displayName}`;
        const override = overrides.get(entry.comment);
        const enabled = label.includes('使用额外模型更新变量开')
          ? false
          : override?.enabled ?? entry.enabled;
        const content = override?.content ?? entry.content;
        return enabled === entry.enabled && content === entry.content ? entry : { ...entry, enabled, content };
      }),
    },
  };
}

function runtimeStateFor(repositories: Repositories, conversationId: string): WorldbookRuntimeState | undefined {
  try {
    return repositories.worldbookRuntimeStates.getByConversationId(conversationId);
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      throw new PromptSnapshotError('invalid_runtime_state');
    }
    throw error;
  }
}

function loadAggregate(
  repositories: Repositories,
  input: PromptSnapshotInput,
  sceneContext?: ScenePromptContext,
): LoadedAggregate {
  if (input.mode === 'normal' && (typeof input.userText !== 'string' || input.userText.trim() === '')) {
    throw new PromptSnapshotError('invalid_user_text');
  }
  if (input.mode !== 'normal' && input.userText !== undefined) throw new PromptSnapshotError('invalid_user_text');
  const conversation = repositories.conversations.get(input.conversationId);
  if (conversation === undefined) throw new PromptSnapshotError('not_found');
  if (conversation.revision !== input.conversationRevision) throw new PromptSnapshotError('revision_conflict');
  const character = repositories.characters.get(conversation.characterId);
  const persona = repositories.personas.get(conversation.personaId);
  if (character === undefined || persona === undefined) throw new PromptSnapshotError('not_found');
  const globalGenerationConfig = repositories.globalGenerationConfig.get();
  const providerId = globalGenerationConfig.providerId ?? undefined;
  if (providerId === undefined) throw new PromptSnapshotError('provider_not_configured');
  const provider = repositories.providerProfiles.get(providerId);
  if (provider === undefined) throw new PromptSnapshotError('provider_not_configured');

  const compatibilityWarnings: PromptWarning[] = [];
  appendCompatibilityWarnings(compatibilityWarnings, conversation, `conversation:${conversation.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, character, `character:${character.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, persona, `persona:${persona.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, provider, `provider:${provider.id}`);

  const saveAgentConfiguration = repositories.saveAgentConfigurations.getByConversationId(conversation.id);
  if (saveAgentConfiguration === undefined) throw new PromptSnapshotError('preset_not_configured');
  const presets = [privateSavePreset(saveAgentConfiguration)];
  const installedScene = conversation.sceneId === undefined ? undefined : repositories.installedScenes.get(conversation.sceneId);
  if (conversation.sceneId !== undefined && installedScene === undefined) throw new PromptSnapshotError('not_found');
  const sceneState = repositories.conversationSceneStates.getByConversationId(conversation.id);
  if (installedScene !== undefined && sceneState === undefined) throw new PromptSnapshotError('invalid_runtime_state');
  if (sceneContext !== undefined && installedScene === undefined) throw new PromptSnapshotError('invalid_runtime_state');
  const saveWorldbook = installedScene === undefined
    ? undefined
    : repositories.saveWorldbooks.getByConversationId(conversation.id);
  if (installedScene !== undefined && saveWorldbook === undefined) throw new PromptSnapshotError('invalid_runtime_state');

  const seen = new Set<string>();
  const books: LoadedBook[] = [];
  const addPersisted = (row: Worldbook | undefined, source: LoadedPersistedBook['source']) => {
    if (row === undefined || seen.has(row.id)) return;
    seen.add(row.id);
    appendCompatibilityWarnings(compatibilityWarnings, row, `worldbook:${row.id}`);
    const loaded = persistedBook(repositories, row, source);
    for (const entry of loaded.entries) {
      appendCompatibilityWarnings(compatibilityWarnings, entry, `worldbook-entry:${entry.id}`);
    }
    books.push(loaded);
  };
  const globalBooks = boundedRelation(() => repositories.worldbooks.listGlobal());
  for (const row of globalBooks) addPersisted(row, 'global');
  const characterWorldbookId = saveWorldbook?.worldbookId ?? character.worldbookId;
  if (characterWorldbookId !== undefined) addPersisted(repositories.worldbooks.get(characterWorldbookId), 'character');
  const embedded = saveWorldbook === undefined ? stableEmbeddedBook(character) : undefined;
  if (embedded !== undefined) {
    compatibilityWarnings.push(...embedded.compatibilityWarnings);
    books.push(embedded);
  }
  for (const id of conversation.worldbookIds) addPersisted(repositories.worldbooks.get(id), 'conversation');
  for (const id of [characterWorldbookId, ...conversation.worldbookIds]) {
    if (id !== undefined && repositories.worldbooks.get(id) === undefined) throw new PromptSnapshotError('not_found');
  }
  const runtimeState = runtimeStateFor(repositories, conversation.id);
  if (installedScene !== undefined) {
    for (let index = 0; index < books.length; index += 1) {
      books[index] = applySceneWorldbookEntryOverrides(books[index]!, runtimeState?.entryOverrides ?? []);
    }
  }

  const history = historyRows(repositories, conversation.id);
  compatibilityWarnings.push(...history.compatibilityWarnings);
  if (input.reuseLastUser === true) {
    const last = history.messages.at(-1);
    if (input.mode !== 'normal' || last?.role !== 'user' || last.content !== input.userText) {
      throw new PromptSnapshotError('invalid_user_text');
    }
  }
  const targetMessage = input.mode === 'normal' ? undefined : history.messages.at(-1);
  if (input.mode !== 'normal' && (targetMessage === undefined || targetMessage.role !== 'assistant'
    || targetMessage.activeVariantId === null)) throw new PromptSnapshotError('invalid_target');
  const targetVariant = targetMessage?.activeVariantId === null || targetMessage?.activeVariantId === undefined
    ? undefined
    : history.variants.get(targetMessage.activeVariantId);
  if (input.mode !== 'normal' && (targetVariant === undefined || targetVariant.messageId !== targetMessage?.id)) {
    throw new PromptSnapshotError('invalid_target');
  }
  const requiredMessageHeadroom = input.mode === 'normal' ? input.reuseLastUser === true ? 1 : 2 : 0;
  const requiredVariantHeadroom = 1;
  if (history.messages.length + requiredMessageHeadroom > MAX_MESSAGES_PER_CONVERSATION
    || history.variants.size + requiredVariantHeadroom > MAX_VARIANTS_PER_RELATION) {
    throw new PromptSnapshotError('aggregate_limit');
  }
  if (input.targetMessageId !== undefined && input.targetMessageId !== targetMessage?.id) {
    throw new PromptSnapshotError('invalid_target');
  }
  if (input.targetVariantId !== undefined && input.targetVariantId !== targetVariant?.id) {
    throw new PromptSnapshotError('invalid_target');
  }
  const seed = input.seed ?? `${conversation.id}:${conversation.revision}`;
  const messageIndex = input.messageIndex ?? history.history.length;
  const snapshotInput: SnapshotInputPayload = {
    conversationId: conversation.id,
    conversationRevision: conversation.revision,
    mode: input.mode,
    userText: input.mode === 'normal' ? input.userText! : null,
    seed,
    messageIndex,
    targetMessageId: targetMessage?.id ?? null,
    targetVariantId: targetVariant?.id ?? null,
    ...(input.reuseLastUser === true ? { reuseLastUser: true } : {}),
  };
  const globalWorldbooks = globalBooks.map(ref);
  const manifest: PromptEntityRevisionManifest = {
    globalGenerationConfig: ref(globalGenerationConfig),
    conversation: ref(conversation),
    character: ref(character),
    persona: ref(persona),
    provider: ref(provider),
    presets: presets.map((preset) => ({ ...ref(preset), kind: preset.kind })),
    saveAgentConfiguration: ref(saveAgentConfiguration),
    globalWorldbooks,
    worldbooks: books.flatMap((loaded) => loaded.source === 'embedded' ? [] : [{
      ...ref(loaded.row),
      source: loaded.source,
      entries: loaded.entries.map(ref),
    }]),
    messages: history.manifest,
    runtimeState: runtimeState === undefined ? null : ref(runtimeState),
    installedScene: installedScene === undefined ? null : ref(installedScene),
    sceneState: sceneState === undefined ? null : ref(sceneState),
  };

  return {
    input: snapshotInput,
    globalGenerationConfig: deepJson(globalGenerationConfig),
    conversation: deepJson(conversation),
    character: deepJson(character),
    persona: deepJson(persona),
    provider: deepJson(provider),
    presets: deepJson(presets),
    history: deepJson(input.mode === 'swipe' || input.mode === 'regenerate'
      ? history.history.slice(0, -1)
      : history.history),
    books: deepJson(books),
    previousTimedState: WorldbookTimedStateSchema.parse(
      deepJson(runtimeState?.timedState ?? EMPTY_WORLDBOOK_TIMED_STATE),
    ),
    manifest: deepJson(manifest),
    compatibilityWarnings: deepJson(compatibilityWarnings),
    regexScripts: {
      preset: parsedRegexAssets(repositories.extensionAssets.listByOwner('preset', presets[0]!.id)),
      character: parsedRegexAssets(repositories.extensionAssets.listByOwner('character', character.id)),
    },
    scenePromptAdditions: sceneState === undefined ? [] : [
      {
        role: 'system' as const,
        content: '<scene_state>\n'
          + `${JSON.stringify(sceneContext?.state ?? sceneState.value)}\n`
          + '</scene_state>\nCanonical Scene State may be changed only through the provided Agent tools.',
      },
      ...(sceneContext?.additions ?? []),
    ],
    memoryRecall: deepJson(sceneContext?.memoryRecall ?? []),
    memoryQueryCorpus: deepJson(sceneContext?.memoryQueryCorpus ?? []),
  };
}

function currentMessageManifest(repositories: Repositories, conversationId: string): MessageRevisionRef[] {
  return historyRows(repositories, conversationId).manifest;
}

function sceneSnapshotMetadata(repositories: Repositories, conversationId: string) {
  const conversation = repositories.conversations.get(conversationId);
  const scene = conversation?.sceneId === undefined ? undefined : repositories.installedScenes.get(conversation.sceneId);
  const state = conversation === undefined ? undefined : repositories.conversationSceneStates.getByConversationId(conversation.id);
  if (scene === undefined) return {};
  return {
    sceneId: scene.id,
    sceneVersion: scene.version,
    scenePackageDigest: scene.archiveDigest,
    ...(state === undefined ? {} : { sceneStateRevision: state.revision }),
    recipeSource: scene.manifest.generationRecipe === undefined ? 'global-fallback' as const : 'scene' as const,
  };
}

function stale(): never {
  throw new PromptSnapshotError('snapshot_stale');
}

function revalidateManifest(repositories: Repositories, manifest: PromptEntityRevisionManifest): void {
  const exact = (current: { id: string; revision: number } | undefined, expected: RevisionRef) => {
    if (current === undefined || current.id !== expected.id || current.revision !== expected.revision) stale();
  };
  const globalGenerationConfig = repositories.globalGenerationConfig.get();
  exact(globalGenerationConfig, manifest.globalGenerationConfig);
  const conversation = repositories.conversations.get(manifest.conversation.id);
  exact(conversation, manifest.conversation);
  const character = repositories.characters.get(manifest.character.id);
  exact(character, manifest.character);
  exact(repositories.personas.get(manifest.persona.id), manifest.persona);
  const provider = repositories.providerProfiles.get(manifest.provider.id);
  exact(provider, manifest.provider);
  if (conversation === undefined || character === undefined || provider === undefined
    || conversation.characterId !== manifest.character.id
    || conversation.personaId !== manifest.persona.id
    || globalGenerationConfig.providerId !== manifest.provider.id) stale();
  const configuration = repositories.saveAgentConfigurations.getByConversationId(conversation.id);
  exact(configuration, manifest.saveAgentConfiguration);
  if (!sameCanonical(manifest.presets, [{ ...manifest.saveAgentConfiguration, kind: 'chat' }])) stale();
  const currentGlobals = revalidatedRelation(() => repositories.worldbooks.listGlobal()).map(ref);
  if (!sameCanonical(currentGlobals, manifest.globalWorldbooks)) stale();
  const expectedWorldbooks: Array<{ id: string; source: WorldbookRevisionRef['source'] }> = [];
  const seenWorldbooks = new Set<string>();
  const addExpectedWorldbook = (id: string | undefined, source: WorldbookRevisionRef['source']) => {
    if (id === undefined || seenWorldbooks.has(id)) return;
    seenWorldbooks.add(id);
    expectedWorldbooks.push({ id, source });
  };
  for (const global of currentGlobals) addExpectedWorldbook(global.id, 'global');
  const saveWorldbook = conversation.sceneId === undefined
    ? undefined
    : repositories.saveWorldbooks.getByConversationId(conversation.id);
  if (conversation.sceneId !== undefined && saveWorldbook === undefined) stale();
  addExpectedWorldbook(saveWorldbook?.worldbookId ?? character.worldbookId, 'character');
  for (const id of conversation.worldbookIds) addExpectedWorldbook(id, 'conversation');
  if (!sameCanonical(
    manifest.worldbooks.map(({ id, source }) => ({ id, source })),
    expectedWorldbooks,
  )) stale();
  for (const book of manifest.worldbooks) {
    exact(repositories.worldbooks.get(book.id), book);
    const entries = revalidatedRelation(() => repositories.worldbookEntries.listByWorldbookId(book.id)).map(ref);
    if (!sameCanonical(entries, book.entries)) stale();
  }
  if (!sameCanonical(
    revalidatedRelation(() => currentMessageManifest(repositories, manifest.conversation.id)),
    manifest.messages,
  )) stale();
  const runtimeState = runtimeStateFor(repositories, manifest.conversation.id);
  if (manifest.runtimeState === null) {
    if (runtimeState !== undefined) stale();
  } else {
    exact(runtimeState, manifest.runtimeState);
  }
  const installedScene = conversation.sceneId === undefined ? undefined : repositories.installedScenes.get(conversation.sceneId);
  if (manifest.installedScene === undefined) {
    // Snapshot created before Scene Packages.
  } else if (manifest.installedScene === null) {
    if (installedScene !== undefined) stale();
  } else {
    exact(installedScene, manifest.installedScene);
  }
  const sceneState = repositories.conversationSceneStates.getByConversationId(conversation.id);
  if (manifest.sceneState === undefined) {
    // Snapshot created before Scene Packages.
  } else if (manifest.sceneState === null) {
    if (sceneState !== undefined) stale();
  } else {
    exact(sceneState, manifest.sceneState);
  }
}

function acceptedSaveAgentConfiguration(
  repositories: Repositories,
  payload: PromptSnapshotPayload,
): SaveAgentConfiguration {
  const expected = payload.entityRevisions.saveAgentConfiguration;
  const configuration = repositories.saveAgentConfigurations.getByConversationId(payload.input.conversationId);
  if (configuration === undefined || configuration.id !== expected.id || configuration.revision !== expected.revision) stale();
  return deepJson(configuration);
}

function tokenizerRequest(preset: Preset, provider: ProviderProfile): TokenizerSelectionInput {
  const requested = preset.settings.tokenizer;
  return {
    requestedId: typeof requested === 'number' && Number.isSafeInteger(requested)
      ? requested as TokenizerId
      : TokenizerId.BEST_MATCH,
    model: provider.model,
    api: 'openai',
  };
}

function decisionFingerprint(decision: TokenizerDecision): string {
  return canonicalJson(decision);
}

async function countWorldbookTexts(
  runtime: ServerTokenizerRuntime,
  decision: TokenizerDecision,
  input: Omit<Parameters<typeof evaluateWorldbooks>[0], 'tokenizer' | 'tokenBudget'>,
  tokenBudget: number,
): Promise<WorldbookEvaluationResult> {
  const requested: string[] = [];
  evaluateWorldbooks({
    ...input,
    tokenBudget: Number.MAX_SAFE_INTEGER,
    tokenizer: { countText(text) { requested.push(text); return 0; } },
  });
  const counts = new Map<string, number>();
  try {
    for (const text of requested) {
      if (!counts.has(text)) counts.set(text, validCount(await runtime.countText(text, decision)));
    }
  } catch (error) {
    if (error instanceof PromptSnapshotError) throw error;
    throw new PromptSnapshotError('tokenizer_error');
  }
  let missing = false;
  const result = evaluateWorldbooks({
    ...input,
    tokenBudget,
    tokenizer: { countText(text) {
      const count = counts.get(text);
      if (count === undefined) {
        missing = true;
        return 0;
      }
      return count;
    } },
  });
  if (missing || result.warnings.some((warning) => warning.code === 'tokenizer_error')) {
    throw new PromptSnapshotError('tokenizer_error');
  }
  return result;
}

function authorNotePosition(value: number): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new PromptSnapshotError('unsupported_worldbook_placement');
}

function authorNoteRole(value: number): 'system' | 'user' | 'assistant' {
  if (value === 0) return 'system';
  if (value === 1) return 'user';
  if (value === 2) return 'assistant';
  throw new PromptSnapshotError('unsupported_worldbook_placement');
}

function worldInfo(result: WorldbookEvaluationResult, conversation: Conversation): WorldInfoCompilerPlacements {
  const before: string[] = [];
  const after: string[] = [];
  const examplesBefore: Array<{ source: string; content: string }> = [];
  const examplesAfter: Array<{ source: string; content: string }> = [];
  const authorBefore: Array<{ source: string; content: string }> = [];
  const authorAfter: Array<{ source: string; content: string }> = [];
  const atDepth: WorldInfoCompilerPlacements['atDepth'][number][] = [];
  const outlets: Record<string, Array<{ source: string; content: string }>> = {};
  const beforePositions = new Set<number | string>([0, 'before', 'before_char', 'before_character']);
  const afterPositions = new Set<number | string>([1, 'after', 'after_char', 'after_character']);
  const authorTopPositions = new Set<number | string>([2, 'an_top']);
  const authorBottomPositions = new Set<number | string>([3, 'an_bottom']);
  const atDepthPositions = new Set<number | string>([4, 'at_depth']);
  const examplesTopPositions = new Set<number | string>([5, 'em_top']);
  const examplesBottomPositions = new Set<number | string>([6, 'em_bottom']);
  const outletPositions = new Set<number | string>([7, 'outlet']);
  for (const entry of result.activated) {
    const item = { source: entry.entryKey, content: entry.content };
    if (beforePositions.has(entry.position)) before.unshift(entry.content);
    else if (afterPositions.has(entry.position)) after.unshift(entry.content);
    else if (authorTopPositions.has(entry.position)) authorBefore.unshift(item);
    else if (authorBottomPositions.has(entry.position)) authorAfter.unshift(item);
    else if (atDepthPositions.has(entry.position)) {
      const placementRole = entry.role === 0 ? 'system' : entry.role === 1 ? 'user' : entry.role === 2 ? 'assistant' : undefined;
      if (!Number.isSafeInteger(entry.depth) || entry.depth < 0 || placementRole === undefined) {
        throw new PromptSnapshotError('unsupported_worldbook_placement');
      }
      atDepth.unshift({ ...item, depth: entry.depth, role: placementRole });
    } else if (examplesTopPositions.has(entry.position)) examplesBefore.unshift(item);
    else if (examplesBottomPositions.has(entry.position)) examplesAfter.unshift(item);
    else if (outletPositions.has(entry.position)) {
      if (entry.outletName.trim() === '') throw new PromptSnapshotError('unsupported_worldbook_placement');
      (outlets[entry.outletName] ??= []).push(item);
    } else {
      throw new PromptSnapshotError('unsupported_worldbook_placement');
    }
  }
  return {
    beforeCharacter: before.join('\n'),
    afterCharacter: after.join('\n'),
    examplesBefore,
    examplesAfter,
    authorNote: {
      before: authorBefore,
      content: conversation.authorNote,
      after: authorAfter,
      position: authorNotePosition(conversation.authorNotePosition),
      depth: conversation.authorNoteDepth,
      role: authorNoteRole(conversation.authorNoteRole),
    },
    atDepth,
    outlets,
  };
}

function finiteSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function responseTokens(conversation: Conversation, preset: Preset): number | undefined {
  const requested = finiteSetting(preset.settings, preset.kind === 'chat' ? 'max_tokens' : 'max_length');
  if (requested === undefined) return conversation.maxResponseTokens;
  return Math.max(0, Math.min(Math.floor(requested), conversation.maxResponseTokens));
}

function executableAudit(aggregate: LoadedAggregate): Record<string, unknown> {
  return {
    schemaVersion: EXECUTABLE_AUDIT_SCHEMA_VERSION,
    input: aggregate.input,
    entityRevisions: aggregate.manifest,
    conversation: {
      id: aggregate.conversation.id,
      revision: aggregate.conversation.revision,
      maxPromptTokens: aggregate.conversation.maxPromptTokens,
      maxResponseTokens: aggregate.conversation.maxResponseTokens,
      authorNote: aggregate.conversation.authorNote,
      authorNotePosition: aggregate.conversation.authorNotePosition,
      authorNoteDepth: aggregate.conversation.authorNoteDepth,
      authorNoteRole: aggregate.conversation.authorNoteRole,
    },
    character: {
      id: aggregate.character.id,
      revision: aggregate.character.revision,
      name: aggregate.character.name,
      description: aggregate.character.description,
      personality: aggregate.character.personality,
      scenario: aggregate.character.scenario,
      firstMessage: aggregate.character.firstMessage,
      examples: aggregate.character.examples,
      systemPrompt: aggregate.character.systemPrompt,
      postHistoryInstructions: aggregate.character.postHistoryInstructions,
      creatorNotes: aggregate.character.creatorNotes,
      tags: aggregate.character.tags,
      depthPrompt: aggregate.character.depthPrompt,
    },
    persona: {
      id: aggregate.persona.id,
      revision: aggregate.persona.revision,
      name: aggregate.persona.name,
      description: aggregate.persona.description,
    },
    provider: {
      id: aggregate.provider.id,
      revision: aggregate.provider.revision,
      model: aggregate.provider.model,
      apiMode: aggregate.provider.apiMode,
    },
    presets: aggregate.presets.map((preset) => ({
      id: preset.id,
      revision: preset.revision,
      kind: preset.kind,
      settings: preset.settings,
    })),
    worldbooks: aggregate.books.map((book) => ({ id: book.id, source: book.source, book: book.book })),
    history: aggregate.history,
    previousTimedState: aggregate.previousTimedState,
  };
}

function compilerError(code: string): never {
  if (code === 'context_overflow' || code === 'invalid_budget') throw new PromptSnapshotError('context_overflow');
  if (code === 'tokenizer_error') throw new PromptSnapshotError('tokenizer_error');
  if (code === 'unsupported_worldbook_placement') throw new PromptSnapshotError('unsupported_worldbook_placement');
  throw new PromptSnapshotError('invalid_preset');
}

async function projectPromptHistory(
  aggregate: LoadedAggregate,
  history: LoadedAggregate['history'],
): Promise<{ history: LoadedAggregate['history']; warnings: PromptWarning[] }> {
  const warnings: PromptWarning[] = [];
  const projected: LoadedAggregate['history'] = [];
  const limits = regexWorkerLimitsForProjection();
  for (const [index, message] of history.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      projected.push(message);
      continue;
    }
    const context = {
      placement: message.role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      depth: history.length - index - 1,
      values: {
        user: aggregate.persona.name,
        char: aggregate.character.name,
        group: aggregate.character.name,
        charIfNotGroup: aggregate.character.name,
        notChar: aggregate.persona.name,
        model: aggregate.provider.model,
        description: aggregate.character.description,
        personality: aggregate.character.personality,
        scenario: aggregate.character.scenario,
        persona: aggregate.persona.description,
        mesExamplesRaw: aggregate.character.examples,
        charVersion: aggregate.character.characterVersion,
        char_version: aggregate.character.characterVersion,
        creatorNotes: aggregate.character.creatorNotes,
        charPrompt: aggregate.character.systemPrompt,
        charInstruction: aggregate.character.postHistoryInstructions,
        charJailbreak: aggregate.character.postHistoryInstructions,
        charDepthPrompt: aggregate.character.depthPrompt,
      },
      characterName: aggregate.character.name,
    } as const;
    const prompt = await runOwnedRegexModeProjectionInWorker(
      message.content, aggregate.regexScripts, context, 'prompt', createNodeRegexWorker, limits,
    );
    const failed = prompt.trace.filter((entry) => (
      entry.reason === 'timeout' || entry.reason === 'aggregate_timeout' || entry.reason === 'error'
    ));
    warnings.push(...failed.map((entry: OwnedRegexTraceEntry) => ({
      code: `regex_${entry.reason}`,
      message: `${entry.owner} regex ${entry.scriptName || entry.scriptId} failed open (${entry.reason}).`,
      source: `${entry.owner}-regex:${entry.scriptId}`,
    })));
    projected.push({ ...message, content: prompt.value });
  }
  return { history: projected, warnings };
}

async function compileAggregate(
  aggregate: LoadedAggregate,
  runtime: ServerTokenizerRuntime,
): Promise<PromptSnapshotPayload> {
  let decision: TokenizerDecision;
  try {
    decision = runtime.selectTokenizer(tokenizerRequest(aggregate.presets[0]!, aggregate.provider));
  } catch {
    throw new PromptSnapshotError('tokenizer_error');
  }
  if (!isTokenizerDecision(decision)) throw new PromptSnapshotError('tokenizer_error');
  const rawHistory = aggregate.input.mode === 'normal' && aggregate.input.reuseLastUser !== true
    ? [...aggregate.history, {
      id: `proposed:${canonicalHash(aggregate.input)}`,
      role: 'user',
      content: aggregate.input.userText!,
    }]
    : [...aggregate.history];
  const promptProjection = await projectPromptHistory(aggregate, rawHistory);
  const history = promptProjection.history;
  const books: WorldbookRuntimeBook[] = aggregate.books.map((book) => ({ id: book.id, book: book.book }));
  const bookBudgets = aggregate.books.map((book) => book.book.tokenBudget)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const tokenBudget = Math.min(aggregate.conversation.maxPromptTokens, ...bookBudgets);
  const scanSources = {
    messages: [...rawHistory].reverse().map((message) => message.content),
    additional: [],
    trigger: aggregate.input.mode,
    character: {
      name: aggregate.character.name,
      tags: aggregate.character.tags,
      description: aggregate.character.description,
      personality: aggregate.character.personality,
      depthPrompt: aggregate.character.depthPrompt,
      scenario: aggregate.character.scenario,
      creatorNotes: aggregate.character.creatorNotes,
    },
    persona: {
      name: aggregate.persona.name,
      tags: [],
      description: aggregate.persona.description,
    },
  } as const;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isTokenizerDecision(decision)) throw new PromptSnapshotError('tokenizer_error');
    const initialDecision = decisionFingerprint(decision);
    const worldbook = await countWorldbookTexts(runtime, decision, {
      seed: aggregate.input.seed,
      messageIndex: aggregate.input.messageIndex,
      previousTimedState: aggregate.previousTimedState,
      scanSources,
      books,
    }, tokenBudget);
    const placements = worldInfo(worldbook, aggregate.conversation);
    const tokenizer = {
      countText: async (text: string) => {
        try {
          return validCount(await runtime.countText(text, decision));
        } catch (error) {
          if (error instanceof PromptSnapshotError) throw error;
          throw new PromptSnapshotError('tokenizer_error');
        }
      },
      countMessages: async (messages: readonly PromptChatMessage[]) => {
        try {
          return validCount(await runtime.countMessages(messages, decision));
        } catch (error) {
          if (error instanceof PromptSnapshotError) throw error;
          throw new PromptSnapshotError('tokenizer_error');
        }
      },
    };

    let reservedRuntimeTokens = 0;
    for (const addition of aggregate.scenePromptAdditions) {
      reservedRuntimeTokens += await tokenizer.countText(addition.content);
    }
    const compilerPromptBudget = aggregate.conversation.maxPromptTokens - reservedRuntimeTokens;
    if (compilerPromptBudget <= 0) throw new PromptSnapshotError('context_overflow');

    const compilation = await compileChatPrompt({
        character: aggregate.character,
        persona: aggregate.persona,
        history,
        preset: aggregate.presets[0]!,
        tokenizer,
        maxPromptTokens: compilerPromptBudget,
        generationType: aggregate.input.mode,
        promptOrderCharacterId: aggregate.character.id,
        worldInfoPlacements: placements,
      });

    if (compilation.kind === 'error') compilerError(compilation.code);
    if (!isTokenizerDecision(decision)) throw new PromptSnapshotError('tokenizer_error');
    if (decisionFingerprint(decision) !== initialDecision) continue;

    const compiledMessages = compilation.messages;
    const triggerIndex = compiledMessages.map((message) => message.role).lastIndexOf('user');
    const runtimeMessages = [
      ...compiledMessages.slice(0, triggerIndex < 0 ? compiledMessages.length : triggerIndex),
      ...aggregate.scenePromptAdditions,
      ...compiledMessages.slice(triggerIndex < 0 ? compiledMessages.length : triggerIndex),
    ];
    const runtimeTotalTokens = await tokenizer.countMessages(runtimeMessages);
    const runtimeMaxPromptTokens = aggregate.conversation.maxPromptTokens;
    if (runtimeTotalTokens > runtimeMaxPromptTokens) throw new PromptSnapshotError('context_overflow');
    const injectionBreakdown: TokenBreakdownEntry[] = [];
    for (const [index, addition] of aggregate.scenePromptAdditions.entries()) injectionBreakdown.push({
      source: `scene-prompt-addition:${index}`,
      includedTokens: await tokenizer.countText(addition.content),
      omittedTokens: 0,
    });

    const primaryPreset = aggregate.presets[0]!;
    const temperature = finiteSetting(primaryPreset.settings, 'temperature');
    const maxTokens = responseTokens(aggregate.conversation, primaryPreset);
    const compiledRequest: ChatRequest = {
        model: aggregate.provider.model,
        messages: deepJson(runtimeMessages),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        stop: [...compilation.stop],
      };
    const warnings: PromptWarning[] = [
      ...worldbook.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
        ...(warning.entryKey === undefined ? {} : { source: warning.entryKey }),
      })),
      ...compilation.warnings,
      ...aggregate.compatibilityWarnings,
      ...promptProjection.warnings,
      ...(decision.warning === undefined ? [] : [{
        code: 'tokenizer_fallback',
        message: decision.warning,
      }]),
    ];
    const withoutPayloadHash: Omit<PromptSnapshotPayload, 'payloadHash'> = {
      schemaVersion: PROMPT_SNAPSHOT_SCHEMA_VERSION,
      input: aggregate.input,
      kind: 'chat',
      seed: aggregate.input.seed,
      messageIndex: aggregate.input.messageIndex,
      entityRevisions: aggregate.manifest,
      executable: executableAudit(aggregate),
      worldbook: deepJson(worldbook),
      tokenizerDecision: deepJson(decision),
      messages: deepJson(runtimeMessages),
      stop: [...compilation.stop],
      tokenBreakdown: deepJson([...compilation.tokenBreakdown, ...injectionBreakdown]),
      totalTokens: runtimeTotalTokens,
      warnings: deepJson(warnings),
      worldInfoOutlets: deepJson(compilation.worldInfoOutlets),
      memoryRecall: deepJson(aggregate.memoryRecall),
      memoryQueryCorpus: deepJson(aggregate.memoryQueryCorpus),
      compiledRequest: deepJson(compiledRequest),
      compiledRequestHash: canonicalHash(compiledRequest),
    };
    return deepJson({
      ...withoutPayloadHash,
      payloadHash: canonicalHash(withoutPayloadHash),
    });
  }
  throw new PromptSnapshotError('tokenizer_error');
}

async function buildSnapshot(
  database: TavernDatabase,
  repositories: Repositories,
  runtime: ServerTokenizerRuntime,
  input: PromptSnapshotInput,
  sceneContext?: ScenePromptContext,
): Promise<BuiltSnapshot> {
  const aggregate = database.transaction(() => loadAggregate(repositories, input, sceneContext));
  const payload = await compileAggregate(aggregate, runtime);
  return { payload, manifest: aggregate.manifest };
}

function isRevisionRef(value: unknown): value is RevisionRef {
  return record(value) && typeof value.id === 'string'
    && nonNegativeInteger(value.revision)
    && hasOnlyKeys(value, ['id', 'revision']);
}

function isManifest(value: unknown): value is PromptEntityRevisionManifest {
  if (!record(value)
    || !isRevisionRef(value.globalGenerationConfig)
    || !isRevisionRef(value.conversation)
    || !isRevisionRef(value.character)
    || !isRevisionRef(value.persona)
    || !isRevisionRef(value.provider)
    || !Array.isArray(value.presets)
    || !Array.isArray(value.globalWorldbooks)
    || !Array.isArray(value.worldbooks)
    || !Array.isArray(value.messages)
    || !hasOnlyKeys(value, [
      'globalGenerationConfig', 'conversation', 'character', 'persona', 'provider', 'presets', 'globalWorldbooks',
      'worldbooks', 'messages', 'runtimeState', 'installedScene', 'sceneState', 'saveAgentConfiguration',
    ])) return false;
  if (!value.presets.every((item) => record(item)
    && typeof item.id === 'string'
    && nonNegativeInteger(item.revision)
    && item.kind === 'chat'
    && hasOnlyKeys(item, ['id', 'revision', 'kind']))) return false;
  if (!value.globalWorldbooks.every(isRevisionRef)) return false;
  if (!value.worldbooks.every((item) => record(item)
    && typeof item.id === 'string'
    && nonNegativeInteger(item.revision)
    && ['global', 'character', 'conversation'].includes(String(item.source))
    && Array.isArray(item.entries)
    && item.entries.every(isRevisionRef)
    && hasOnlyKeys(item, ['id', 'revision', 'source', 'entries']))) return false;
  if (!value.messages.every((item) => record(item)
    && typeof item.id === 'string'
    && nonNegativeInteger(item.revision)
    && (item.activeVariant === null || isRevisionRef(item.activeVariant))
    && hasOnlyKeys(item, ['id', 'revision', 'activeVariant']))) return false;
  return (value.runtimeState === null || isRevisionRef(value.runtimeState))
    && isRevisionRef(value.saveAgentConfiguration)
    && (value.installedScene === undefined || value.installedScene === null || isRevisionRef(value.installedScene))
    && (value.sceneState === undefined || value.sceneState === null || isRevisionRef(value.sceneState));
}

function isInput(value: unknown): value is SnapshotInputPayload {
  if (!record(value)) return false;
  if (typeof value.conversationId !== 'string'
    || !nonNegativeInteger(value.conversationRevision)
    || !['normal', 'swipe', 'regenerate'].includes(String(value.mode))
    || !(typeof value.seed === 'string' || finiteNumber(value.seed))
    || !nonNegativeInteger(value.messageIndex)
    || !hasOnlyKeys(value, [
      'conversationId', 'conversationRevision', 'mode', 'userText', 'seed', 'messageIndex',
      'targetMessageId', 'targetVariantId',
      'reuseLastUser',
    ])) return false;
  if (value.reuseLastUser !== undefined && typeof value.reuseLastUser !== 'boolean') return false;
  if (value.mode === 'normal') {
    return typeof value.userText === 'string' && value.userText.trim() !== ''
      && value.targetMessageId === null && value.targetVariantId === null;
  }
  if (value.userText !== null || typeof value.targetMessageId !== 'string'
    || typeof value.targetVariantId !== 'string') return false;
  return true;
}

function nullableFinite(value: unknown): boolean {
  return value === null || finiteNumber(value);
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === 'boolean';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isExecutableFilter(value: unknown): boolean {
  return record(value)
    && typeof value.isExclude === 'boolean'
    && stringArray(value.names)
    && stringArray(value.tags)
    && hasOnlyKeys(value, ['isExclude', 'names', 'tags']);
}

function isExecutableWorldbookEntry(value: unknown): boolean {
  if (!record(value)
    || typeof value.id !== 'string'
    || !isSourceUid(value.sourceUid)
    || !nonNegativeInteger(value.sourceOrdinal)
    || !stringArray(value.keys)
    || !stringArray(value.secondaryKeys)
    || !['useRegex', 'selective', 'constant', 'vectorized', 'useProbability', 'groupOverride', 'ignoreBudget',
      'excludeRecursion', 'preventRecursion', 'matchPersonaDescription', 'matchCharacterDescription',
      'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
      'enabled', 'addMemo'].every((key) => typeof value[key] === 'boolean')
    || !['selectiveLogic', 'probability', 'groupWeight', 'order', 'depth', 'role']
      .every((key) => finiteNumber(value[key]))
    || typeof value.group !== 'string'
    || !nullableFinite(value.priority)
    || !(typeof value.position === 'string' || finiteNumber(value.position))
    || !nullableFinite(value.scanDepth)
    || !nullableBoolean(value.caseSensitive)
    || !nullableBoolean(value.matchWholeWords)
    || !nullableBoolean(value.useGroupScoring)
    || !(typeof value.delayUntilRecursion === 'boolean' || finiteNumber(value.delayUntilRecursion))
    || !nullableFinite(value.sticky) || !nullableFinite(value.cooldown) || !nullableFinite(value.delay)
    || !isExecutableFilter(value.characterFilter) || !isExecutableFilter(value.personaFilter)
    || !['comment', 'displayName', 'content', 'outletName', 'automationId']
      .every((key) => typeof value[key] === 'string')
    || !nullableFinite(value.displayIndex)
    || !stringArray(value.triggers)
    || !record(value.extensions) || !record(value.unknownFields)) return false;
  return hasOnlyKeys(value, [
    'id', 'sourceUid', 'sourceOrdinal', 'keys', 'secondaryKeys', 'useRegex', 'selective',
    'selectiveLogic', 'constant', 'vectorized', 'probability', 'useProbability', 'group',
    'groupWeight', 'groupOverride', 'priority', 'order', 'position', 'depth', 'role',
    'ignoreBudget', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring',
    'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'sticky', 'cooldown', 'delay',
    'characterFilter', 'personaFilter', 'matchPersonaDescription', 'matchCharacterDescription',
    'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
    'comment', 'displayName', 'content', 'enabled', 'addMemo', 'displayIndex', 'outletName',
    'automationId', 'triggers', 'extensions', 'unknownFields',
  ]);
}

function isExecutableWorldbook(value: unknown): boolean {
  return record(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.enabled === 'boolean'
    && nullableFinite(value.scanDepth)
    && nullableFinite(value.tokenBudget)
    && typeof value.recursiveScanning === 'boolean'
    && record(value.extensions)
    && record(value.unknownFields)
    && Array.isArray(value.entries)
    && value.entries.every(isExecutableWorldbookEntry)
    && hasOnlyKeys(value, [
      'name', 'description', 'enabled', 'scanDepth', 'tokenBudget', 'recursiveScanning',
      'extensions', 'unknownFields', 'entries',
    ]);
}

function isExecutableAudit(value: unknown): value is Record<string, unknown> {
  if (!record(value)
    || value.schemaVersion !== EXECUTABLE_AUDIT_SCHEMA_VERSION
    || !isInput(value.input)
    || !isManifest(value.entityRevisions)
    || !record(value.conversation)
    || !record(value.character)
    || !record(value.persona)
    || !record(value.provider)
    || !Array.isArray(value.presets)
    || !Array.isArray(value.worldbooks)
    || !Array.isArray(value.history)
    || !WorldbookTimedStateSchema.safeParse(value.previousTimedState).success
    || !hasOnlyKeys(value, [
      'schemaVersion', 'input', 'entityRevisions', 'conversation', 'character', 'persona', 'provider',
      'presets', 'worldbooks', 'history', 'previousTimedState',
    ])) return false;
  const conversation = value.conversation;
  if (typeof conversation.id !== 'string'
    || !nonNegativeInteger(conversation.revision)
    || !nonNegativeInteger(conversation.maxPromptTokens)
    || !nonNegativeInteger(conversation.maxResponseTokens)
    || typeof conversation.authorNote !== 'string'
    || (conversation.authorNotePosition !== 0 && conversation.authorNotePosition !== 1 && conversation.authorNotePosition !== 2)
    || !nonNegativeInteger(conversation.authorNoteDepth)
    || (conversation.authorNoteRole !== 0 && conversation.authorNoteRole !== 1 && conversation.authorNoteRole !== 2)
    || !hasOnlyKeys(conversation, [
      'id', 'revision', 'maxPromptTokens', 'maxResponseTokens', 'authorNote',
      'authorNotePosition', 'authorNoteDepth', 'authorNoteRole',
    ])) return false;
  const character = value.character;
  if (typeof character.id !== 'string'
    || !nonNegativeInteger(character.revision)
    || !['name', 'description', 'personality', 'scenario', 'firstMessage', 'examples', 'systemPrompt',
      'postHistoryInstructions', 'creatorNotes', 'depthPrompt'].every((key) => typeof character[key] === 'string')
    || !Array.isArray(character.tags) || !character.tags.every((tag) => typeof tag === 'string')
    || !hasOnlyKeys(character, [
      'id', 'revision', 'name', 'description', 'personality', 'scenario', 'firstMessage',
      'examples', 'systemPrompt', 'postHistoryInstructions', 'creatorNotes', 'tags', 'depthPrompt',
    ])) return false;
  const persona = value.persona;
  if (typeof persona.id !== 'string' || !nonNegativeInteger(persona.revision)
    || typeof persona.name !== 'string' || typeof persona.description !== 'string'
    || !hasOnlyKeys(persona, ['id', 'revision', 'name', 'description'])) return false;
  const provider = value.provider;
  if (typeof provider.id !== 'string' || !nonNegativeInteger(provider.revision)
    || typeof provider.model !== 'string' || provider.apiMode !== 'chat'
    || !hasOnlyKeys(provider, ['id', 'revision', 'model', 'apiMode'])) return false;
  if (!value.presets.every((preset) => record(preset)
    && typeof preset.id === 'string' && nonNegativeInteger(preset.revision)
    && preset.kind === 'chat'
    && record(preset.settings)
    && hasOnlyKeys(preset, ['id', 'revision', 'kind', 'settings']))) return false;
  if (!value.worldbooks.every((book) => record(book)
    && typeof book.id === 'string'
    && ['global', 'character', 'conversation', 'embedded'].includes(String(book.source))
    && isExecutableWorldbook(book.book)
    && hasOnlyKeys(book, ['id', 'source', 'book']))) return false;
  return value.history.every((message) => record(message)
    && typeof message.id === 'string'
    && typeof message.role === 'string'
    && typeof message.content === 'string'
    && hasOnlyKeys(message, ['id', 'role', 'content']));
}

function isWarnings(value: unknown): value is PromptWarning[] {
  return Array.isArray(value) && value.every((item) => record(item)
    && typeof item.code === 'string'
    && typeof item.message === 'string'
    && (item.source === undefined || typeof item.source === 'string')
    && (item.macro === undefined || typeof item.macro === 'string')
    && hasOnlyKeys(item, ['code', 'message', 'source', 'macro']));
}

function isStop(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isWorldInfoOutlets(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isMemoryRecall(value: unknown): value is MemoryRecallSnapshotEntry[] {
  return Array.isArray(value) && value.every((entry) => record(entry)
    && typeof entry.id === 'string'
    && nonNegativeInteger(entry.revision)
    && typeof entry.kind === 'string'
    && typeof entry.tier === 'string'
    && typeof entry.summary === 'string'
    && typeof entry.detail === 'string'
    && nonNegativeInteger(entry.tokenCount)
    && hasOnlyKeys(entry, ['id', 'revision', 'kind', 'tier', 'summary', 'detail', 'tokenCount']));
}

function isSourceUid(value: unknown): boolean {
  return typeof value === 'string' || finiteNumber(value);
}

function isWorldbookResult(value: unknown): value is WorldbookEvaluationResult {
  if (!record(value)
    || !Array.isArray(value.activated)
    || !Array.isArray(value.excluded)
    || !Array.isArray(value.warnings)
    || !record(value.tokenUsage)
    || !WorldbookTimedStateSchema.safeParse(value.timedState).success
    || !nonNegativeInteger(value.recursionSteps)
    || !hasOnlyKeys(value, ['activated', 'excluded', 'timedState', 'tokenUsage', 'recursionSteps', 'warnings'])) {
    return false;
  }
  if (!value.activated.every((entry) => record(entry)
    && typeof entry.entryKey === 'string'
    && typeof entry.bookId === 'string'
    && typeof entry.bookName === 'string'
    && isSourceUid(entry.sourceUid)
    && nonNegativeInteger(entry.sourceOrdinal)
    && typeof entry.content === 'string'
    && (typeof entry.position === 'string' || finiteNumber(entry.position))
    && finiteNumber(entry.depth)
    && finiteNumber(entry.role)
    && typeof entry.outletName === 'string'
    && finiteNumber(entry.order)
    && (entry.priority === null || finiteNumber(entry.priority))
    && typeof entry.ignoreBudget === 'boolean'
    && ['constant', 'keyword', 'sticky'].includes(String(entry.activation))
    && nonNegativeInteger(entry.activationStep)
    && nonNegativeInteger(entry.tokenUsageAfter)
    && hasOnlyKeys(entry, [
      'entryKey', 'bookId', 'bookName', 'sourceUid', 'sourceOrdinal', 'content', 'position',
      'depth', 'role', 'outletName', 'order', 'priority', 'ignoreBudget', 'activation',
      'activationStep', 'tokenUsageAfter',
    ]))) return false;
  if (!value.excluded.every((entry) => record(entry)
    && typeof entry.entryKey === 'string'
    && typeof entry.bookId === 'string'
    && isSourceUid(entry.sourceUid)
    && nonNegativeInteger(entry.sourceOrdinal)
    && typeof entry.reason === 'string'
    && hasOnlyKeys(entry, ['entryKey', 'bookId', 'sourceUid', 'sourceOrdinal', 'reason']))) return false;
  if (!finiteNumber(value.tokenUsage.budget)
    || value.tokenUsage.budget < 0
    || !nonNegativeInteger(value.tokenUsage.used)
    || typeof value.tokenUsage.overflowed !== 'boolean'
    || !hasOnlyKeys(value.tokenUsage, ['budget', 'used', 'overflowed'])) return false;
  return value.warnings.every((warning) => record(warning)
    && typeof warning.code === 'string'
    && typeof warning.message === 'string'
    && (warning.entryKey === undefined || typeof warning.entryKey === 'string')
    && (warning.bookId === undefined || typeof warning.bookId === 'string')
    && (warning.keyIndex === undefined || nonNegativeInteger(warning.keyIndex))
    && hasOnlyKeys(warning, ['code', 'message', 'entryKey', 'bookId', 'keyIndex']));
}

const knownTokenizerIds = new Set<number>(TOKENIZER_IDS);

function isTokenizerDecision(value: unknown): value is TokenizerDecision {
  if (!record(value)
    || !finiteNumber(value.requestedId) || !knownTokenizerIds.has(value.requestedId)
    || !finiteNumber(value.tokenizerId) || !knownTokenizerIds.has(value.tokenizerId)
    || value.tokenizerId === TokenizerId.BEST_MATCH
    || typeof value.tokenizerName !== 'string' || value.tokenizerName === ''
    || !hasOnlyKeys(value, [
      'requestedId', 'tokenizerId', 'tokenizerName', 'api', 'model', 'remoteEndpoint',
      'tiktokenModel', 'fallbackTokenizerId', 'fallbackFrom', 'warning',
    ])) return false;
  for (const key of ['api', 'model', 'remoteEndpoint', 'tiktokenModel', 'warning'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  for (const key of ['fallbackTokenizerId', 'fallbackFrom'] as const) {
    if (value[key] !== undefined && (!finiteNumber(value[key]) || !knownTokenizerIds.has(value[key]))) return false;
  }
  return true;
}

function isTokenBreakdown(value: unknown): value is TokenBreakdownEntry[] {
  return Array.isArray(value) && value.every((entry) => record(entry)
    && typeof entry.source === 'string'
    && nonNegativeInteger(entry.includedTokens)
    && nonNegativeInteger(entry.omittedTokens)
    && (entry.reason === undefined || typeof entry.reason === 'string')
    && hasOnlyKeys(entry, ['source', 'includedTokens', 'omittedTokens', 'reason']));
}

function isChatMessages(value: unknown): value is PromptChatMessage[] {
  return Array.isArray(value) && value.every((message) => record(message)
    && (message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && (message.name === undefined || typeof message.name === 'string')
    && Object.keys(message).every((key) => key === 'role' || key === 'content' || key === 'name'));
}

function hasCommonRequestFields(value: unknown): value is Record<string, unknown> & { model: string } {
  if (!record(value) || typeof value.model !== 'string') return false;
  if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature))) return false;
  if (value.maxTokens !== undefined && (!Number.isSafeInteger(value.maxTokens) || Number(value.maxTokens) < 0)) return false;
  if (value.stop !== undefined && !(typeof value.stop === 'string' || isStop(value.stop))) return false;
  return true;
}

function isChatRequest(value: unknown): value is ChatRequest {
  return hasCommonRequestFields(value)
    && isChatMessages(value.messages)
    && value.prompt === undefined
    && Object.keys(value).every((key) => ['model', 'messages', 'temperature', 'maxTokens', 'stop'].includes(key));
}

function isPromptSnapshotPayload(value: unknown): value is PromptSnapshotPayload {
  if (!record(value)
    || value.schemaVersion !== PROMPT_SNAPSHOT_SCHEMA_VERSION
    || !isInput(value.input)
    || value.kind !== 'chat'
    || !isManifest(value.entityRevisions)
    || !isExecutableAudit(value.executable)
    || !isWorldbookResult(value.worldbook)
    || !isTokenizerDecision(value.tokenizerDecision)
    || !isStop(value.stop)
    || !isTokenBreakdown(value.tokenBreakdown)
    || !nonNegativeInteger(value.totalTokens)
    || !isWarnings(value.warnings)
    || !isWorldInfoOutlets(value.worldInfoOutlets)
    || !isMemoryRecall(value.memoryRecall)
    || !isMemoryRecall(value.memoryQueryCorpus)
    || typeof value.compiledRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.compiledRequestHash)
    || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash)
    || !sameCanonical(value.seed, value.input.seed)
    || value.messageIndex !== value.input.messageIndex) return false;
  const commonKeys = [
    'schemaVersion', 'input', 'kind', 'seed', 'messageIndex', 'entityRevisions', 'executable',
    'worldbook', 'tokenizerDecision', 'stop', 'tokenBreakdown', 'totalTokens', 'warnings',
    'worldInfoOutlets', 'memoryRecall', 'memoryQueryCorpus', 'compiledRequest', 'compiledRequestHash', 'payloadHash',
  ];
  return isChatRequest(value.compiledRequest)
    && isChatMessages(value.messages)
    && hasOnlyKeys(value, [...commonKeys, 'messages']);
}

function executableBindingsMatch(value: PromptSnapshotPayload): boolean {
  const audit = value.executable;
  const manifest = value.entityRevisions;
  const sameRef = (candidate: unknown, expected: RevisionRef) => record(candidate)
    && candidate.id === expected.id && candidate.revision === expected.revision;
  if (!sameRef(audit.conversation, manifest.conversation)
    || !sameRef(audit.character, manifest.character)
    || !sameRef(audit.persona, manifest.persona)
    || !sameRef(audit.provider, manifest.provider)) return false;
  if (!Array.isArray(audit.presets) || !sameCanonical(
    audit.presets.map((preset) => record(preset)
      ? { id: preset.id, revision: preset.revision, kind: preset.kind }
      : preset),
    manifest.presets,
  )) return false;
  if (!Array.isArray(audit.worldbooks)) return false;
  const persistedBooks = audit.worldbooks.flatMap((book) => (
    record(book) && book.source !== 'embedded' && record(book.book) && Array.isArray(book.book.entries)
      ? [{
        id: book.id,
        source: book.source,
        entries: book.book.entries.map((entry) => record(entry) ? entry.id : undefined),
      }]
      : []
  ));
  if (!sameCanonical(persistedBooks, manifest.worldbooks.map((book) => ({
    id: book.id,
    source: book.source,
    entries: book.entries.map(({ id }) => id),
  })))) {
    return false;
  }
  const auditedInput = record(audit.input) ? audit.input : undefined;
  const expectedHistoryIds = auditedInput?.mode === 'swipe' || auditedInput?.mode === 'regenerate'
    ? manifest.messages.filter(({ id }) => id !== auditedInput.targetMessageId).map(({ id }) => id)
    : manifest.messages.map(({ id }) => id);
  if (!Array.isArray(audit.history)
    || !sameCanonical(audit.history.map((message) => record(message) ? message.id : undefined), expectedHistoryIds)) {
    return false;
  }
  const provider = audit.provider;
  if (!record(provider)
    || provider.model !== value.compiledRequest.model
    || provider.apiMode !== 'chat') return false;
  if (value.tokenizerDecision.model !== undefined && value.tokenizerDecision.model !== provider.model) return false;
  if (value.tokenizerDecision.api !== undefined && value.tokenizerDecision.api !== 'openai') return false;
  return true;
}

function parseStoredPayload(value: unknown): PromptSnapshotPayload {
  if (record(value) && nonNegativeInteger(value.schemaVersion)
    && value.schemaVersion !== PROMPT_SNAPSHOT_SCHEMA_VERSION) {
    throw new PromptSnapshotError('snapshot_unsupported');
  }
  if (!isPromptSnapshotPayload(value)) {
    throw new PromptSnapshotError('snapshot_invalid');
  }
  if (!isChatRequest(value.compiledRequest)
    || !sameCanonical(value.messages, value.compiledRequest.messages)) throw new PromptSnapshotError('snapshot_invalid');
  if (!sameCanonical(value.stop, value.compiledRequest.stop ?? [])) throw new PromptSnapshotError('snapshot_invalid');
  if (!sameCanonical(value.executable.input, value.input)
    || !sameCanonical(value.executable.entityRevisions, value.entityRevisions)) {
    throw new PromptSnapshotError('snapshot_invalid');
  }
  if (!executableBindingsMatch(value)) throw new PromptSnapshotError('snapshot_invalid');
  const auditedProvider = value.executable.provider;
  if (!record(auditedProvider)
    || value.compiledRequest.model !== auditedProvider.model
    || auditedProvider.apiMode !== 'chat') {
    throw new PromptSnapshotError('snapshot_invalid');
  }
  if (canonicalHash(value.compiledRequest) !== value.compiledRequestHash) throw new PromptSnapshotError('snapshot_invalid');
  const { payloadHash, ...withoutPayloadHash } = value;
  if (canonicalHash(withoutPayloadHash) !== payloadHash) throw new PromptSnapshotError('snapshot_invalid');
  return structuredClone(value);
}

function assertSnapshotInput(payload: PromptSnapshotPayload, input: PromptSnapshotInput): void {
  if (payload.input.conversationId !== input.conversationId
    || payload.input.conversationRevision !== input.conversationRevision
    || payload.input.mode !== input.mode
    || payload.input.userText !== (input.userText ?? null)
    || (input.targetMessageId !== undefined && payload.input.targetMessageId !== input.targetMessageId)
    || (input.targetVariantId !== undefined && payload.input.targetVariantId !== input.targetVariantId)
    || (payload.input.reuseLastUser ?? false) !== (input.reuseLastUser ?? false)
    || (input.seed !== undefined && !sameCanonical(payload.input.seed, input.seed))
    || (input.messageIndex !== undefined && payload.input.messageIndex !== input.messageIndex)) {
    throw new PromptSnapshotError('snapshot_mismatch');
  }
}

function acceptUserTurn(
  repositories: Repositories,
  payload: PromptSnapshotPayload,
): { provider: ProviderProfile; createdUserMessage?: MessageRevisionRef } {
  revalidateManifest(repositories, payload.entityRevisions);
  const provider = repositories.providerProfiles.get(payload.entityRevisions.provider.id);
  if (provider === undefined) stale();
  if (payload.input.mode === 'normal') {
    if (payload.input.reuseLastUser !== true) {
      const message = repositories.messages.create({
        id: randomUUID(),
        conversationId: payload.input.conversationId,
        role: 'user',
        content: payload.input.userText!,
        activeVariantId: null,
      });
      const revision = repositories.conversations.update(
        payload.input.conversationId,
        payload.input.conversationRevision,
        {},
      );
      if (!revision.ok) stale();
      return { provider, createdUserMessage: { ...ref(message), activeVariant: null } };
    }
    const revision = repositories.conversations.update(
      payload.input.conversationId,
      payload.input.conversationRevision,
      {},
    );
    if (!revision.ok) stale();
  }
  return { provider };
}

function acceptanceCandidate(
  repositories: Repositories,
  snapshotId: string,
  payload: PromptSnapshotPayload,
): AcceptedPromptSnapshot {
  revalidateManifest(repositories, payload.entityRevisions);
  const provider = repositories.providerProfiles.get(payload.entityRevisions.provider.id);
  if (provider === undefined || provider.revision !== payload.entityRevisions.provider.revision) stale();
  return {
    snapshotId,
    payload: deepJson(payload),
    provider: deepJson(provider),
    saveAgentConfiguration: acceptedSaveAgentConfiguration(repositories, payload),
  };
}

export function createPromptSnapshotService(options: {
  database: TavernDatabase;
  repositories: Repositories;
  tokenizerRuntime: ServerTokenizerRuntime;
}): PromptSnapshotService {
  const { database, repositories, tokenizerRuntime } = options;
  const pendingSnapshots = new Map<string, {
    payload: PromptSnapshotPayload;
    createdUserMessage?: MessageRevisionRef;
  }>();
  const isConsumed = (snapshotId: string) => database.sqlite.prepare(`
    SELECT snapshot_id FROM consumed_generation_snapshots WHERE snapshot_id = ?
  `).get(snapshotId) !== undefined;
  const consume = (snapshotId: string) => {
    try {
      database.sqlite.prepare(`
        INSERT INTO consumed_generation_snapshots (snapshot_id, consumed_at) VALUES (?, ?)
      `).run(snapshotId, new Date().toISOString());
    } catch {
      throw new PromptSnapshotError('snapshot_mismatch');
    }
  };
  return {
    async createAndAccept(input, snapshotId, sceneContext, beforeAccept) {
      const built = await buildSnapshot(database, repositories, tokenizerRuntime, input, sceneContext);
      const candidate = acceptanceCandidate(repositories, snapshotId, built.payload);
      const directive = beforeAccept === undefined ? undefined : await beforeAccept(candidate);
      if (directive?.deferSnapshotCommit === true) {
        if (pendingSnapshots.has(snapshotId) || isConsumed(snapshotId)) {
          throw new PromptSnapshotError('snapshot_mismatch');
        }
        const turn = database.transaction(() => acceptUserTurn(repositories, built.payload));
        pendingSnapshots.set(snapshotId, {
          payload: deepJson(built.payload),
          ...(turn.createdUserMessage === undefined ? {} : { createdUserMessage: turn.createdUserMessage }),
        });
        return { ...candidate, deferredSnapshotCommit: true };
      }
      const accepted = database.transaction(() => {
        revalidateManifest(repositories, built.manifest);
        repositories.generationSnapshots.create({
          id: snapshotId,
          conversationId: built.payload.input.conversationId,
          conversationRevision: built.payload.input.conversationRevision,
          payload: Object.fromEntries(Object.entries(deepJson(built.payload))),
          ...sceneSnapshotMetadata(repositories, built.payload.input.conversationId),
        });
        consume(snapshotId);
        const { provider } = acceptUserTurn(repositories, built.payload);
        return {
          snapshotId,
          payload: deepJson(built.payload),
          provider: deepJson(provider),
          saveAgentConfiguration: acceptedSaveAgentConfiguration(repositories, built.payload),
        };
      });
      return accepted;
    },
    commitDeferredSnapshot(snapshotId, payload) {
      const pending = pendingSnapshots.get(snapshotId);
      if (pending === undefined || !sameCanonical(pending.payload, payload) || isConsumed(snapshotId)) {
        throw new PromptSnapshotError('snapshot_mismatch');
      }
      const acceptedManifest: PromptEntityRevisionManifest = {
        ...payload.entityRevisions,
        conversation: {
          ...payload.entityRevisions.conversation,
          revision: payload.entityRevisions.conversation.revision + (payload.input.mode === 'normal' ? 1 : 0),
        },
        messages: [
          ...payload.entityRevisions.messages,
          ...(pending.createdUserMessage === undefined ? [] : [pending.createdUserMessage]),
        ],
      };
      revalidateManifest(repositories, acceptedManifest);
      repositories.generationSnapshots.create({
        id: snapshotId,
        conversationId: payload.input.conversationId,
        conversationRevision: payload.input.conversationRevision,
        payload: Object.fromEntries(Object.entries(deepJson(payload))),
        ...sceneSnapshotMetadata(repositories, payload.input.conversationId),
      });
      consume(snapshotId);
    },
    completeDeferredSnapshot(snapshotId) {
      pendingSnapshots.delete(snapshotId);
    },
    releaseDeferredSnapshot(snapshotId) {
      pendingSnapshots.delete(snapshotId);
    },
    commitTimedState(payload) {
      if (payload.input.mode !== 'normal') return;
      database.transaction(() => {
        const expected = payload.entityRevisions.runtimeState;
        const current = runtimeStateFor(repositories, payload.input.conversationId);
        if (expected === null) {
          if (current !== undefined) stale();
          repositories.worldbookRuntimeStates.create({
            id: randomUUID(),
            conversationId: payload.input.conversationId,
            timedState: WorldbookTimedStateSchema.parse(deepJson(payload.worldbook.timedState)),
            entryOverrides: [],
          });
          return;
        }
        if (current === undefined || current.id !== expected.id || current.revision !== expected.revision) stale();
        const updated = repositories.worldbookRuntimeStates.update(current.id, current.revision, {
          timedState: WorldbookTimedStateSchema.parse(deepJson(payload.worldbook.timedState)),
        });
        if (!updated.ok) stale();
      });
    },
  };
}
