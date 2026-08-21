import { createHash, randomUUID } from 'node:crypto';
import {
  EMPTY_WORLDBOOK_TIMED_STATE,
  WorldbookTimedStateSchema,
  type Character,
  type Conversation,
  type GenerationMode,
  type Message,
  type MessageVariant,
  type Persona,
  type Preset,
  type ProviderProfile,
  type Worldbook,
  type WorldbookEntry,
  type WorldbookRuntimeState,
  type WorldbookTimedState,
} from '@tavernnext/domain';
import {
  compileChatPrompt,
  compileTextPrompt,
  evaluateWorldbooks,
  type PromptChatMessage,
  type PromptWarning,
  type TokenBreakdownEntry,
  type WorldInfoCompilerPlacements,
  type WorldbookEvaluationResult,
  type WorldbookRuntimeBook,
} from '@tavernnext/prompt-engine';
import type { ChatRequest, TextRequest } from '@tavernnext/provider-openai-compatible';
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

export const PROMPT_SNAPSHOT_SCHEMA_VERSION = 4 as const;
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
  continuationByteBoundary?: number;
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
  globalWorldbooks: RevisionRef[];
  worldbooks: WorldbookRevisionRef[];
  messages: MessageRevisionRef[];
  runtimeState: RevisionRef | null;
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
  continuationByteBoundary: number | null;
}

export interface PromptSnapshotPayload {
  schemaVersion: typeof PROMPT_SNAPSHOT_SCHEMA_VERSION;
  input: SnapshotInputPayload;
  kind: 'chat' | 'text';
  seed: string | number;
  messageIndex: number;
  entityRevisions: PromptEntityRevisionManifest;
  executable: Record<string, unknown>;
  worldbook: WorldbookEvaluationResult;
  tokenizerDecision: TokenizerDecision;
  messages?: PromptChatMessage[];
  text?: string;
  stop: string[];
  tokenBreakdown: TokenBreakdownEntry[];
  totalTokens: number;
  warnings: PromptWarning[];
  worldInfoOutlets: Record<string, string>;
  compiledRequest: ChatRequest | TextRequest;
  compiledRequestHash: string;
  payloadHash: string;
}

export interface PromptSnapshotPreview extends PromptSnapshotPayload {
  snapshotId: string;
}

export type PromptSnapshotErrorCode =
  | 'invalid_user_text'
  | 'invalid_target'
  | 'unsupported_mode'
  | 'not_found'
  | 'provider_not_configured'
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
}

interface BuiltSnapshot {
  payload: PromptSnapshotPayload;
  manifest: PromptEntityRevisionManifest;
}

export interface AcceptedPromptSnapshot {
  snapshotId: string;
  payload: PromptSnapshotPayload;
  provider: ProviderProfile;
}

export interface PromptSnapshotService {
  createPreview(input: PromptSnapshotInput): Promise<PromptSnapshotPreview>;
  createAndAccept(input: PromptSnapshotInput, snapshotId: string): Promise<AcceptedPromptSnapshot>;
  acceptExisting(input: PromptSnapshotInput & { snapshotId: string }): Promise<AcceptedPromptSnapshot>;
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
        content: message.role === 'assistant' && variant !== undefined ? variant.content : message.content,
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

function resolveGenerationBinding(
  configuration: ReturnType<Repositories['globalGenerationConfig']['get']>,
  providerMode?: ProviderProfile['apiMode'],
): {
  providerId: string | undefined;
  presets: Array<{ id: string | undefined; kind: PresetKind }>;
} {
  const providerId = configuration.providerId ?? undefined;
  const selected = (id: string | null) => id ?? undefined;
  if (providerMode === undefined) return { providerId, presets: [] };
  return {
    providerId,
    presets: providerMode === 'chat'
      ? [{ id: selected(configuration.chatPresetId), kind: 'chat' }]
      : [
        { id: selected(configuration.textPresetId), kind: 'text' },
        { id: selected(configuration.contextPresetId), kind: 'context' },
        { id: selected(configuration.instructPresetId), kind: 'instruct' },
        { id: selected(configuration.systemPresetId), kind: 'system' },
      ],
  };
}

function loadAggregate(repositories: Repositories, input: PromptSnapshotInput): LoadedAggregate {
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
  const providerId = resolveGenerationBinding(globalGenerationConfig).providerId;
  if (providerId === undefined) throw new PromptSnapshotError('provider_not_configured');
  const provider = repositories.providerProfiles.get(providerId);
  if (provider === undefined) throw new PromptSnapshotError('provider_not_configured');

  const compatibilityWarnings: PromptWarning[] = [];
  appendCompatibilityWarnings(compatibilityWarnings, conversation, `conversation:${conversation.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, character, `character:${character.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, persona, `persona:${persona.id}`);
  appendCompatibilityWarnings(compatibilityWarnings, provider, `provider:${provider.id}`);

  const binding = resolveGenerationBinding(globalGenerationConfig, provider.apiMode);
  const presets = binding.presets.map(({ id, kind }) => requestedPreset(repositories, id, kind, compatibilityWarnings));

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
  if (character.worldbookId !== undefined) addPersisted(repositories.worldbooks.get(character.worldbookId), 'character');
  const embedded = stableEmbeddedBook(character);
  if (embedded !== undefined) {
    compatibilityWarnings.push(...embedded.compatibilityWarnings);
    books.push(embedded);
  }
  for (const id of conversation.worldbookIds) addPersisted(repositories.worldbooks.get(id), 'conversation');
  for (const id of [character.worldbookId, ...conversation.worldbookIds]) {
    if (id !== undefined && repositories.worldbooks.get(id) === undefined) throw new PromptSnapshotError('not_found');
  }

  const history = historyRows(repositories, conversation.id);
  compatibilityWarnings.push(...history.compatibilityWarnings);
  const targetMessage = input.mode === 'normal' ? undefined : history.messages.at(-1);
  if (input.mode !== 'normal' && (targetMessage === undefined || targetMessage.role !== 'assistant'
    || targetMessage.activeVariantId === null)) throw new PromptSnapshotError('invalid_target');
  const targetVariant = targetMessage?.activeVariantId === null || targetMessage?.activeVariantId === undefined
    ? undefined
    : history.variants.get(targetMessage.activeVariantId);
  if (input.mode !== 'normal' && (targetVariant === undefined || targetVariant.messageId !== targetMessage?.id)) {
    throw new PromptSnapshotError('invalid_target');
  }
  const requiredMessageHeadroom = input.mode === 'normal' ? 2 : 0;
  const requiredVariantHeadroom = input.mode === 'continue' ? 0 : 1;
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
  const continuationByteBoundary = input.mode === 'continue'
    ? Buffer.byteLength(targetVariant!.content, 'utf8')
    : null;
  if (input.continuationByteBoundary !== undefined
    && input.continuationByteBoundary !== continuationByteBoundary) throw new PromptSnapshotError('invalid_target');
  const runtimeState = runtimeStateFor(repositories, conversation.id);
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
    continuationByteBoundary,
  };
  const globalWorldbooks = globalBooks.map(ref);
  const manifest: PromptEntityRevisionManifest = {
    globalGenerationConfig: ref(globalGenerationConfig),
    conversation: ref(conversation),
    character: ref(character),
    persona: ref(persona),
    provider: ref(provider),
    presets: presets.map((preset) => ({ ...ref(preset), kind: preset.kind })),
    globalWorldbooks,
    worldbooks: books.flatMap((loaded) => loaded.source === 'embedded' ? [] : [{
      ...ref(loaded.row),
      source: loaded.source,
      entries: loaded.entries.map(ref),
    }]),
    messages: history.manifest,
    runtimeState: runtimeState === undefined ? null : ref(runtimeState),
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
  };
}

function currentMessageManifest(repositories: Repositories, conversationId: string): MessageRevisionRef[] {
  return historyRows(repositories, conversationId).manifest;
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
    || resolveGenerationBinding(globalGenerationConfig).providerId !== manifest.provider.id) stale();
  const configuredPresets = resolveGenerationBinding(globalGenerationConfig, provider.apiMode).presets;
  if (configuredPresets.some(({ id }) => id === undefined)
    || !sameCanonical(
      manifest.presets.map(({ id, kind }) => ({ id, kind })),
      configuredPresets,
    )) stale();
  for (const preset of manifest.presets) {
    const current = repositories.presets.get(preset.id);
    exact(current, preset);
    if (current?.kind !== preset.kind) stale();
  }
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
  addExpectedWorldbook(character.worldbookId, 'character');
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
  const history = aggregate.input.mode === 'normal'
    ? [...aggregate.history, {
      id: `proposed:${canonicalHash(aggregate.input)}`,
      role: 'user',
      content: aggregate.input.userText!,
    }]
    : [...aggregate.history];
  const books: WorldbookRuntimeBook[] = aggregate.books.map((book) => ({ id: book.id, book: book.book }));
  const bookBudgets = aggregate.books.map((book) => book.book.tokenBudget)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const tokenBudget = Math.min(aggregate.conversation.maxPromptTokens, ...bookBudgets);
  const scanSources = {
    messages: [...history].reverse().map((message) => message.content),
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

    const compilation = aggregate.provider.apiMode === 'chat'
      ? await compileChatPrompt({
        character: aggregate.character,
        persona: aggregate.persona,
        history,
        preset: aggregate.presets[0]!,
        tokenizer,
        maxPromptTokens: aggregate.conversation.maxPromptTokens,
        generationType: aggregate.input.mode,
        promptOrderCharacterId: aggregate.character.id,
        worldInfoPlacements: placements,
      })
      : await compileTextPrompt({
        character: aggregate.character,
        persona: aggregate.persona,
        history,
        textPreset: aggregate.presets[0]!,
        contextPreset: aggregate.presets[1]!,
        ...(aggregate.presets.find((preset) => preset.kind === 'instruct') === undefined ? {} : {
          instructPreset: aggregate.presets.find((preset) => preset.kind === 'instruct'),
        }),
        ...(aggregate.presets.find((preset) => preset.kind === 'system') === undefined ? {} : {
          systemPreset: aggregate.presets.find((preset) => preset.kind === 'system'),
        }),
        tokenizer,
        maxPromptTokens: Math.min(
          aggregate.conversation.maxPromptTokens,
          finiteSetting(aggregate.presets[0]!.settings, 'max_context') ?? aggregate.conversation.maxPromptTokens,
        ),
        generationType: aggregate.input.mode,
        worldInfoPlacements: placements,
      });

    if (compilation.kind === 'error') compilerError(compilation.code);
    if (!isTokenizerDecision(decision)) throw new PromptSnapshotError('tokenizer_error');
    if (decisionFingerprint(decision) !== initialDecision) continue;

    const primaryPreset = aggregate.presets[0]!;
    const temperature = finiteSetting(primaryPreset.settings, 'temperature');
    const maxTokens = responseTokens(aggregate.conversation, primaryPreset);
    const compiledRequest: ChatRequest | TextRequest = compilation.kind === 'chat'
      ? {
        model: aggregate.provider.model,
        messages: deepJson(compilation.messages),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        stop: [...compilation.stop],
      }
      : {
        model: aggregate.provider.model,
        prompt: compilation.text,
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
      ...(decision.warning === undefined ? [] : [{
        code: 'tokenizer_fallback',
        message: decision.warning,
      }]),
    ];
    const withoutPayloadHash: Omit<PromptSnapshotPayload, 'payloadHash'> = {
      schemaVersion: PROMPT_SNAPSHOT_SCHEMA_VERSION,
      input: aggregate.input,
      kind: compilation.kind,
      seed: aggregate.input.seed,
      messageIndex: aggregate.input.messageIndex,
      entityRevisions: aggregate.manifest,
      executable: executableAudit(aggregate),
      worldbook: deepJson(worldbook),
      tokenizerDecision: deepJson(decision),
      ...(compilation.kind === 'chat'
        ? { messages: deepJson(compilation.messages) }
        : { text: compilation.text }),
      stop: [...compilation.stop],
      tokenBreakdown: deepJson(compilation.tokenBreakdown),
      totalTokens: compilation.totalTokens,
      warnings: deepJson(warnings),
      worldInfoOutlets: deepJson(compilation.worldInfoOutlets),
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
): Promise<BuiltSnapshot> {
  const aggregate = database.transaction(() => loadAggregate(repositories, input));
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
      'worldbooks', 'messages', 'runtimeState',
    ])) return false;
  if (!value.presets.every((item) => record(item)
    && typeof item.id === 'string'
    && nonNegativeInteger(item.revision)
    && ['chat', 'text', 'context', 'instruct', 'system', 'reasoning'].includes(String(item.kind))
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
  return value.runtimeState === null || isRevisionRef(value.runtimeState);
}

function isInput(value: unknown): value is SnapshotInputPayload {
  if (!record(value)) return false;
  if (typeof value.conversationId !== 'string'
    || !nonNegativeInteger(value.conversationRevision)
    || !['normal', 'swipe', 'regenerate', 'continue'].includes(String(value.mode))
    || !(typeof value.seed === 'string' || finiteNumber(value.seed))
    || !nonNegativeInteger(value.messageIndex)
    || !hasOnlyKeys(value, [
      'conversationId', 'conversationRevision', 'mode', 'userText', 'seed', 'messageIndex',
      'targetMessageId', 'targetVariantId', 'continuationByteBoundary',
    ])) return false;
  if (value.mode === 'normal') {
    return typeof value.userText === 'string' && value.userText.trim() !== ''
      && value.targetMessageId === null && value.targetVariantId === null
      && value.continuationByteBoundary === null;
  }
  if (value.userText !== null || typeof value.targetMessageId !== 'string'
    || typeof value.targetVariantId !== 'string') return false;
  return value.mode === 'continue'
    ? nonNegativeInteger(value.continuationByteBoundary)
    : value.continuationByteBoundary === null;
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
    || typeof provider.model !== 'string' || (provider.apiMode !== 'chat' && provider.apiMode !== 'text')
    || !hasOnlyKeys(provider, ['id', 'revision', 'model', 'apiMode'])) return false;
  if (!value.presets.every((preset) => record(preset)
    && typeof preset.id === 'string' && nonNegativeInteger(preset.revision)
    && ['chat', 'text', 'context', 'instruct', 'system', 'reasoning'].includes(String(preset.kind))
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

function isTextRequest(value: unknown): value is TextRequest {
  return hasCommonRequestFields(value)
    && typeof value.prompt === 'string'
    && value.messages === undefined
    && Object.keys(value).every((key) => ['model', 'prompt', 'temperature', 'maxTokens', 'stop'].includes(key));
}

function isPromptSnapshotPayload(value: unknown): value is PromptSnapshotPayload {
  if (!record(value)
    || value.schemaVersion !== PROMPT_SNAPSHOT_SCHEMA_VERSION
    || !isInput(value.input)
    || (value.kind !== 'chat' && value.kind !== 'text')
    || !isManifest(value.entityRevisions)
    || !isExecutableAudit(value.executable)
    || !isWorldbookResult(value.worldbook)
    || !isTokenizerDecision(value.tokenizerDecision)
    || !isStop(value.stop)
    || !isTokenBreakdown(value.tokenBreakdown)
    || !nonNegativeInteger(value.totalTokens)
    || !isWarnings(value.warnings)
    || !isWorldInfoOutlets(value.worldInfoOutlets)
    || typeof value.compiledRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.compiledRequestHash)
    || typeof value.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadHash)
    || !sameCanonical(value.seed, value.input.seed)
    || value.messageIndex !== value.input.messageIndex) return false;
  const commonKeys = [
    'schemaVersion', 'input', 'kind', 'seed', 'messageIndex', 'entityRevisions', 'executable',
    'worldbook', 'tokenizerDecision', 'stop', 'tokenBreakdown', 'totalTokens', 'warnings',
    'worldInfoOutlets', 'compiledRequest', 'compiledRequestHash', 'payloadHash',
  ];
  return value.kind === 'chat'
    ? isChatRequest(value.compiledRequest)
      && isChatMessages(value.messages)
      && value.text === undefined
      && hasOnlyKeys(value, [...commonKeys, 'messages'])
    : isTextRequest(value.compiledRequest)
      && typeof value.text === 'string'
      && value.messages === undefined
      && hasOnlyKeys(value, [...commonKeys, 'text']);
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
    || (provider.apiMode === 'chat') !== (value.kind === 'chat')) return false;
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
  if (value.kind === 'chat') {
    if (!isChatRequest(value.compiledRequest)
      || !sameCanonical(value.messages, value.compiledRequest.messages)
      || value.text !== undefined) throw new PromptSnapshotError('snapshot_invalid');
  } else if (!isTextRequest(value.compiledRequest)
    || !sameCanonical(value.text, value.compiledRequest.prompt)
    || value.messages !== undefined) throw new PromptSnapshotError('snapshot_invalid');
  if (!sameCanonical(value.stop, value.compiledRequest.stop ?? [])) throw new PromptSnapshotError('snapshot_invalid');
  if (!sameCanonical(value.executable.input, value.input)
    || !sameCanonical(value.executable.entityRevisions, value.entityRevisions)) {
    throw new PromptSnapshotError('snapshot_invalid');
  }
  if (!executableBindingsMatch(value)) throw new PromptSnapshotError('snapshot_invalid');
  const auditedProvider = value.executable.provider;
  if (!record(auditedProvider)
    || value.compiledRequest.model !== auditedProvider.model
    || (value.kind === 'chat') !== (auditedProvider.apiMode === 'chat')) {
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
    || (input.continuationByteBoundary !== undefined
      && payload.input.continuationByteBoundary !== input.continuationByteBoundary)
    || (input.seed !== undefined && !sameCanonical(payload.input.seed, input.seed))
    || (input.messageIndex !== undefined && payload.input.messageIndex !== input.messageIndex)) {
    throw new PromptSnapshotError('snapshot_mismatch');
  }
}

function acceptUserTurn(
  repositories: Repositories,
  payload: PromptSnapshotPayload,
): ProviderProfile {
  revalidateManifest(repositories, payload.entityRevisions);
  const provider = repositories.providerProfiles.get(payload.entityRevisions.provider.id);
  if (provider === undefined) stale();
  if (payload.input.mode === 'normal') {
    repositories.messages.create({
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
  }
  return provider;
}

export function createPromptSnapshotService(options: {
  database: TavernDatabase;
  repositories: Repositories;
  tokenizerRuntime: ServerTokenizerRuntime;
}): PromptSnapshotService {
  const { database, repositories, tokenizerRuntime } = options;
  return {
    async createPreview(input) {
      const built = await buildSnapshot(database, repositories, tokenizerRuntime, input);
      return database.transaction(() => {
        revalidateManifest(repositories, built.manifest);
        const id = randomUUID();
        repositories.generationSnapshots.create({
          id,
          conversationId: built.payload.input.conversationId,
          conversationRevision: built.payload.input.conversationRevision,
          payload: Object.fromEntries(Object.entries(deepJson(built.payload))),
        });
        return { snapshotId: id, ...deepJson(built.payload) };
      });
    },
    async createAndAccept(input, snapshotId) {
      const built = await buildSnapshot(database, repositories, tokenizerRuntime, input);
      return database.transaction(() => {
        revalidateManifest(repositories, built.manifest);
        repositories.generationSnapshots.create({
          id: snapshotId,
          conversationId: built.payload.input.conversationId,
          conversationRevision: built.payload.input.conversationRevision,
          payload: Object.fromEntries(Object.entries(deepJson(built.payload))),
        });
        const provider = acceptUserTurn(repositories, built.payload);
        return { snapshotId, payload: deepJson(built.payload), provider: deepJson(provider) };
      });
    },
    async acceptExisting(input) {
      const getStoredSnapshot = () => {
        try {
          return repositories.generationSnapshots.get(input.snapshotId);
        } catch {
          throw new PromptSnapshotError('snapshot_invalid');
        }
      };
      const snapshot = getStoredSnapshot();
      if (snapshot === undefined) throw new PromptSnapshotError('not_found');
      let payload: PromptSnapshotPayload;
      try {
        payload = parseStoredPayload(snapshot.payload);
      } catch (error) {
        if (error instanceof PromptSnapshotError) throw error;
        throw new PromptSnapshotError('snapshot_invalid');
      }
      assertSnapshotInput(payload, input);
      return database.transaction(() => {
        const current = getStoredSnapshot();
        if (current === undefined) throw new PromptSnapshotError('not_found');
        let currentPayload: PromptSnapshotPayload;
        try {
          currentPayload = parseStoredPayload(current.payload);
        } catch (error) {
          if (error instanceof PromptSnapshotError) throw error;
          throw new PromptSnapshotError('snapshot_invalid');
        }
        if (!sameCanonical(currentPayload, payload)) throw new PromptSnapshotError('snapshot_invalid');
        assertSnapshotInput(currentPayload, input);
        const provider = acceptUserTurn(repositories, currentPayload);
        return { snapshotId: input.snapshotId, payload: currentPayload, provider: deepJson(provider) };
      });
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
