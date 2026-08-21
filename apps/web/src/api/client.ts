import type {
  Conversation,
  GenerationMode,
  GlobalGenerationConfig,
  GlobalGenerationSelection,
  Message,
  MessageVariant,
  PresetKind,
} from '@tavernnext/domain';

export type { Conversation, Message, MessageVariant, PresetKind };

export interface CompatibilitySummary {
  sourceFormat: string;
  warnings: string[];
  unknownFieldCount: number;
}

export interface MutableView {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterSummaryView extends MutableView {
  name: string;
  avatarUrl?: string;
  compatibilitySummary?: CompatibilitySummary;
}

export interface AttachedExtensionOverviewView {
  execution: 'not_executed';
  counts: { regex: number; scripts: number; folders: number; variableContainers: number };
  resources: Array<{
    type: 'regex' | 'script' | 'folder' | 'unknown';
    order: number[];
    sourceKey: string;
    name: string;
    enabled: boolean;
    diagnostics: string[];
  }>;
  variables: Array<{ source: string; keyCount: number; diagnostics: string[] }>;
  diagnostics: string[];
}

export interface CharacterView extends CharacterSummaryView {
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  examples: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  creator: string;
  characterVersion: string;
  depthPrompt: string;
  alternateGreetings: string[];
  tags: string[];
  worldbookId?: string;
  attachedExtensions: AttachedExtensionOverviewView;
}

type CharacterWritableView = Omit<CharacterView, keyof MutableView | 'avatarUrl' | 'compatibilitySummary' | 'attachedExtensions'>;
type CharacterPatchView = Partial<Omit<CharacterWritableView, 'worldbookId'>> & { worldbookId?: string | null };

export interface PersonaView extends MutableView {
  name: string;
  description: string;
  isDefault: boolean;
  avatarUrl?: string;
  compatibilitySummary?: CompatibilitySummary;
}

export interface PresetSelectorView {
  id: string;
  revision: number;
  name: string;
  kind: PresetKind;
}

export interface PresetView extends PresetSelectorView, MutableView {
  settings: Record<string, unknown>;
  compatibilitySummary?: CompatibilitySummary;
}

export interface WorldbookSummaryView {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  entryCount: number;
}

export interface WorldbookFilterView {
  isExclude: boolean;
  names: string[];
  tags: string[];
}

export interface WorldbookEntryView extends MutableView {
  worldbookId: string;
  sourceUid?: string | number;
  sourceOrdinal?: number;
  keys: string[];
  secondaryKeys: string[];
  useRegex: boolean;
  selective: boolean;
  selectiveLogic: number;
  constant: boolean;
  vectorized: boolean;
  probability: number;
  useProbability: boolean;
  group: string;
  groupWeight: number;
  groupOverride: boolean;
  priority: number | null;
  content: string;
  enabled: boolean;
  position: string | number;
  order: number;
  depth: number;
  role: number;
  ignoreBudget: boolean;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean | number;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  characterFilter: WorldbookFilterView;
  personaFilter: WorldbookFilterView;
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  comment: string;
  displayName: string;
  addMemo: boolean;
  displayIndex: number | null;
  outletName: string;
  automationId: string;
  triggers: string[];
  compatibilitySummary?: CompatibilitySummary;
}

export interface WorldbookView extends MutableView {
  name: string;
  description: string;
  enabled: boolean;
  scanDepth: number | null;
  tokenBudget: number | null;
  recursiveScanning: boolean;
  isGlobal: boolean;
  compatibilitySummary?: CompatibilitySummary;
  entries: WorldbookEntryView[];
}

export interface ImportPreview {
  source: { fileName: string; mediaType: string; size: number; sha256: string };
  detected: { container: string; kind: string; version?: string; candidates: string[] };
  normalizedPreview: unknown;
  warnings: Array<{ code: string; message: string; path?: string }>;
  blockingErrors: Array<{ code: string; message: string; path?: string }>;
  inspectionToken?: string;
  expiresAt?: string;
}

export interface ImportReceipt {
  artifactId: string;
  entityId?: string;
  assetPath?: string;
}

export interface PromptTimedEntryView {
  entryKey: string;
  start: number;
  end: number;
  protected: boolean;
}

export interface PromptTimedStateView {
  messageIndex: number | null;
  stickyCount: number;
  cooldownCount: number;
  sticky: PromptTimedEntryView[];
  cooldown: PromptTimedEntryView[];
}

export interface PromptPreviewView {
  snapshotId: string;
  kind: 'chat' | 'text';
  messages?: Array<{ role: string; content: string }>;
  text?: string;
  stop: string[];
  tokenBreakdown: Array<{ source: string; includedTokens: number; omittedTokens: number; reason?: string }>;
  totalTokens: number;
  tokenizerDecision: { requestedId?: number; tokenizerId: number; tokenizerName: string; model?: string; warning?: string; fallbackFrom?: number; fallbackTokenizerId?: number };
  worldbook: {
    activated: Array<{ entryKey: string; bookName?: string; sourceUid?: string | number; content?: string; activation?: string; tokenUsageAfter?: number }>;
    excluded: Array<{ entryKey: string; reason: string }>;
    timedState: PromptTimedStateView;
    tokenUsage: { budget: number; used: number; overflowed: boolean };
    recursionSteps: number;
    warnings: Array<{ code: string; message: string }>;
  };
  previousTimedState?: PromptTimedStateView;
  warnings: Array<{ code: string; message: string; source?: string }>;
  entityRevisions: {
    globalGenerationConfig: { revision: number };
    conversation: { revision: number };
    character: { revision: number };
    persona: { revision: number };
    provider: { revision: number };
    presets: Array<{ revision: number; kind: string }>;
    globalWorldbookCount: number;
    worldbookCount: number;
    messageCount: number;
    runtimeStateRevision: number | null;
  };
}

interface PromptTimedStateResponse {
  messageIndex: number | null;
  sticky: unknown[];
  cooldown: unknown[];
}

interface PromptPreviewResponse extends Omit<PromptPreviewView, 'worldbook' | 'previousTimedState' | 'entityRevisions'> {
  worldbook: Omit<PromptPreviewView['worldbook'], 'timedState'> & { timedState: PromptTimedStateResponse };
  previousTimedState?: PromptTimedStateResponse;
  entityRevisions: {
    globalGenerationConfig: { id?: string; revision: number };
    conversation: { id?: string; revision: number };
    character: { id?: string; revision: number };
    persona: { id?: string; revision: number };
    provider: { id?: string; revision: number };
    presets: Array<{ id?: string; revision: number; kind: string }>;
    globalWorldbooks?: Array<{ id?: string; revision: number }>;
    worldbooks?: Array<{ id?: string; revision: number }>;
    messages?: Array<{ id?: string; revision: number }>;
    runtimeState?: { id?: string; revision: number } | null;
  };
}

export interface ProviderProfileView {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  baseUrl: string;
  model: string;
  apiMode: 'chat' | 'text';
  hasApiKey: boolean;
}

export interface ProviderModelView {
  id: string;
  ownedBy?: string;
}

export type GlobalGenerationConfigView = GlobalGenerationConfig;
export type GlobalGenerationConfigPatch = GlobalGenerationSelection;

export interface ProviderProbeInput {
  id?: string;
  baseUrl: string;
  apiKey?: string;
}

export interface MessageView extends Message {
  speakerLabel?: string;
  variants: MessageVariant[];
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: MessageView[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error ? error.message : 'unknown_error';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function fileNameFromDisposition(value: string | null): string {
  if (value === null) return 'download';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded !== undefined) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return /filename="([^"]+)"/i.exec(value)?.[1] ?? 'download';
}

async function download(path: string): Promise<{ fileName: string; mimeType: string }> {
  const response = await fetch(path);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
  }
  const blob = await response.blob();
  const fileName = fileNameFromDisposition(response.headers.get('content-disposition'));
  const mimeType = response.headers.get('content-type') ?? (blob.type || 'application/octet-stream');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return { fileName, mimeType };
}

async function inspectImport(file: File): Promise<ImportPreview> {
  const multipart = await multipartFile(file);
  const response = await fetch('/api/imports/inspect', { method: 'POST', ...multipart });
  if (response.ok || response.status === 422) return response.json() as Promise<ImportPreview>;
  const payload = await response.json().catch(() => ({})) as { error?: string };
  throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
}

async function bytesFromFile(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

function ensureFileStreamingSupport(): void {
  if (typeof File === 'undefined' || typeof FileReader === 'undefined') return;
  if (typeof File.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value(this: File) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'));
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
  if (typeof File.prototype.stream !== 'function') {
    Object.defineProperty(File.prototype, 'stream', {
      configurable: true,
      value(this: File) {
        const file = this;
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(new Uint8Array(await file.arrayBuffer()));
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          },
        });
      },
    });
  }
}

async function multipartFile(file: File): Promise<{ body: BodyInit; headers?: HeadersInit }> {
  ensureFileStreamingSupport();
  if (typeof file.stream === 'function') {
    const body = new FormData();
    body.append('file', file);
    return { body };
  }
  const boundary = `----TavernNext${crypto.randomUUID().replaceAll('-', '')}`;
  const safeName = file.name.replace(/["\\\r\n]/g, '_');
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`);
  const content = await bytesFromFile(file);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + content.length + suffix.length);
  body.set(prefix);
  body.set(content, prefix.length);
  body.set(suffix, prefix.length + content.length);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadAvatar<T>(kind: 'characters' | 'personas', id: string, revision: number, file: File): Promise<T> {
  const multipart = await multipartFile(file);
  return request<T>(`/api/${kind}/${id}/avatar?revision=${revision}`, { method: 'PUT', ...multipart });
}

function projectTimedState(state: PromptTimedStateResponse): PromptTimedStateView {
  return {
    messageIndex: state.messageIndex,
    stickyCount: state.sticky.length,
    cooldownCount: state.cooldown.length,
    sticky: state.sticky.flatMap(projectTimedEntry),
    cooldown: state.cooldown.flatMap(projectTimedEntry),
  };
}

function projectTimedEntry(value: unknown): PromptTimedEntryView[] {
  if (typeof value !== 'object' || value === null) return [];
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.entryKey !== 'string'
    || typeof entry.start !== 'number'
    || typeof entry.end !== 'number'
    || typeof entry.protected !== 'boolean'
  ) return [];
  return [{ entryKey: entry.entryKey, start: entry.start, end: entry.end, protected: entry.protected }];
}

function projectPromptPreview(response: PromptPreviewResponse): PromptPreviewView {
  const revisions = response.entityRevisions;
  return {
    snapshotId: response.snapshotId,
    kind: response.kind,
    ...(response.messages === undefined
      ? {}
      : { messages: response.messages.map(({ role, content }) => ({ role, content })) }),
    ...(response.text === undefined ? {} : { text: response.text }),
    stop: [...response.stop],
    tokenBreakdown: response.tokenBreakdown.map(({ source, includedTokens, omittedTokens, reason }) => ({
      source, includedTokens, omittedTokens, ...(reason === undefined ? {} : { reason }),
    })),
    totalTokens: response.totalTokens,
    tokenizerDecision: {
      tokenizerId: response.tokenizerDecision.tokenizerId,
      tokenizerName: response.tokenizerDecision.tokenizerName,
      ...(response.tokenizerDecision.requestedId === undefined ? {} : { requestedId: response.tokenizerDecision.requestedId }),
      ...(response.tokenizerDecision.model === undefined ? {} : { model: response.tokenizerDecision.model }),
      ...(response.tokenizerDecision.warning === undefined ? {} : { warning: response.tokenizerDecision.warning }),
      ...(response.tokenizerDecision.fallbackFrom === undefined ? {} : { fallbackFrom: response.tokenizerDecision.fallbackFrom }),
      ...(response.tokenizerDecision.fallbackTokenizerId === undefined ? {} : { fallbackTokenizerId: response.tokenizerDecision.fallbackTokenizerId }),
    },
    worldbook: {
      activated: response.worldbook.activated.map((entry) => ({
        entryKey: entry.entryKey,
        ...(entry.bookName === undefined ? {} : { bookName: entry.bookName }),
        ...(entry.sourceUid === undefined ? {} : { sourceUid: entry.sourceUid }),
        ...(entry.content === undefined ? {} : { content: entry.content }),
        ...(entry.activation === undefined ? {} : { activation: entry.activation }),
        ...(entry.tokenUsageAfter === undefined ? {} : { tokenUsageAfter: entry.tokenUsageAfter }),
      })),
      excluded: response.worldbook.excluded.map(({ entryKey, reason }) => ({ entryKey, reason })),
      timedState: projectTimedState(response.worldbook.timedState),
      tokenUsage: { ...response.worldbook.tokenUsage },
      recursionSteps: response.worldbook.recursionSteps,
      warnings: response.worldbook.warnings.map(({ code, message }) => ({ code, message })),
    },
    ...(response.previousTimedState === undefined ? {} : { previousTimedState: projectTimedState(response.previousTimedState) }),
    warnings: response.warnings.map(({ code, message, source }) => ({ code, message, ...(source === undefined ? {} : { source }) })),
    entityRevisions: {
      globalGenerationConfig: { revision: revisions.globalGenerationConfig.revision },
      conversation: { revision: revisions.conversation.revision },
      character: { revision: revisions.character.revision },
      persona: { revision: revisions.persona.revision },
      provider: { revision: revisions.provider.revision },
      presets: revisions.presets.map(({ revision, kind }) => ({ revision, kind })),
      globalWorldbookCount: revisions.globalWorldbooks?.length ?? 0,
      worldbookCount: revisions.worldbooks?.length ?? 0,
      messageCount: revisions.messages?.length ?? 0,
      runtimeStateRevision: revisions.runtimeState?.revision ?? null,
    },
  };
}

export const api = {
  listCharacters: () => request<CharacterSummaryView[]>('/api/characters'),
  getCharacter: (id: string) => request<CharacterView>(`/api/characters/${id}`),
  createCharacter: (input: { name: string; description: string; firstMessage: string }) => request<CharacterView>('/api/characters', {
    method: 'POST',
    body: JSON.stringify({
      id: crypto.randomUUID(), ...input, personality: '', scenario: '', alternateGreetings: [], tags: [],
    }),
  }),
  createManagedCharacter: (input: CharacterWritableView) => request<CharacterView>('/api/characters', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  updateCharacter: (id: string, revision: number, patch: CharacterPatchView) => request<CharacterView>(`/api/characters/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deleteCharacter: (id: string, revision: number) => request<void>(`/api/characters/${id}?revision=${revision}`, { method: 'DELETE' }),
  uploadCharacterAvatar: (id: string, revision: number, file: File) => uploadAvatar<CharacterView>('characters', id, revision, file),
  exportCharacter: (id: string) => download(`/api/characters/${id}/export?format=json-v3`),
  listPersonas: () => request<PersonaView[]>('/api/personas'),
  getPersona: (id: string) => request<PersonaView>(`/api/personas/${id}`),
  createPersona: (input: { name: string; description: string; isDefault?: boolean }) => request<PersonaView>('/api/personas', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input, isDefault: input.isDefault ?? false }),
  }),
  updatePersona: (id: string, revision: number, patch: Partial<Pick<PersonaView, 'name' | 'description' | 'isDefault'>>) => request<PersonaView>(`/api/personas/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deletePersona: (id: string, revision: number) => request<void>(`/api/personas/${id}?revision=${revision}`, { method: 'DELETE' }),
  uploadPersonaAvatar: (id: string, revision: number, file: File) => uploadAvatar<PersonaView>('personas', id, revision, file),
  listProviders: () => request<ProviderProfileView[]>('/api/providers'),
  getGlobalGenerationConfig: () => request<GlobalGenerationConfigView>('/api/settings/generation'),
  saveGlobalGenerationConfig: (revision: number, patch: GlobalGenerationConfigPatch) => request<GlobalGenerationConfigView>(
    '/api/settings/generation', { method: 'PATCH', body: JSON.stringify({ revision, patch }) },
  ),
  probeProvider: (input: ProviderProbeInput) => request<{ ok: true; modelCount: number }>('/api/providers/probe', {
    method: 'POST', body: JSON.stringify(input),
  }),
  detectProviderModels: (input: ProviderProbeInput) => request<{ models: ProviderModelView[] }>('/api/providers/models', {
    method: 'POST', body: JSON.stringify(input),
  }),
  listPresets: () => request<PresetSelectorView[]>('/api/presets'),
  getPreset: (id: string) => request<PresetView>(`/api/presets/${id}`),
  createPreset: (input: { name: string; kind: PresetKind; settings: Record<string, unknown> }) => request<PresetView>('/api/presets', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  updatePreset: (id: string, revision: number, patch: Partial<{ name: string; settings: Record<string, unknown>; deleteSettingKeys: string[] }>) => request<PresetView>(`/api/presets/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deletePreset: (id: string, revision: number) => request<void>(`/api/presets/${id}?revision=${revision}`, { method: 'DELETE' }),
  exportPreset: (id: string) => download(`/api/presets/${id}/export`),
  listWorldbooks: () => request<WorldbookSummaryView[]>('/api/worldbooks'),
  getWorldbook: (id: string) => request<WorldbookView>(`/api/worldbooks/${id}`),
  createWorldbook: (input: Pick<WorldbookView, 'name' | 'description' | 'enabled' | 'scanDepth' | 'tokenBudget' | 'recursiveScanning' | 'isGlobal'>) => request<WorldbookView>('/api/worldbooks', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  updateWorldbook: (id: string, revision: number, patch: Partial<Pick<WorldbookView, 'name' | 'description' | 'enabled' | 'scanDepth' | 'tokenBudget' | 'recursiveScanning' | 'isGlobal'>>) => request<WorldbookView>(`/api/worldbooks/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deleteWorldbook: (id: string, revision: number) => request<void>(`/api/worldbooks/${id}?revision=${revision}`, { method: 'DELETE' }),
  exportWorldbook: (id: string) => download(`/api/worldbooks/${id}/export?format=st-native`),
  createWorldbookEntry: (worldbookId: string, input: Omit<WorldbookEntryView, keyof MutableView | 'worldbookId' | 'sourceUid' | 'sourceOrdinal' | 'compatibilitySummary'>) => request<WorldbookEntryView>(`/api/worldbooks/${worldbookId}/entries`, {
    method: 'POST', body: JSON.stringify(input),
  }),
  updateWorldbookEntry: (worldbookId: string, entryId: string, revision: number, patch: Partial<Omit<WorldbookEntryView, keyof MutableView | 'worldbookId' | 'sourceUid' | 'sourceOrdinal' | 'compatibilitySummary'>>) => request<WorldbookEntryView>(`/api/worldbooks/${worldbookId}/entries/${entryId}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deleteWorldbookEntry: (worldbookId: string, entryId: string, revision: number) => request<void>(`/api/worldbooks/${worldbookId}/entries/${entryId}?revision=${revision}`, { method: 'DELETE' }),
  reorderWorldbookEntries: (worldbookId: string, entries: Array<{ id: string; revision: number; order: number }>) => request<WorldbookEntryView[]>(`/api/worldbooks/${worldbookId}/entries/order`, {
    method: 'PUT', body: JSON.stringify({ entries }),
  }),
  inspectImport,
  commitImport: (inspectionToken: string) => request<ImportReceipt>('/api/imports/commit', {
    method: 'POST', body: JSON.stringify({ inspectionToken }),
  }),
  commitChatImport: (inspectionToken: string, input: {
    characterId: string;
    personaId: string;
    title: string;
  }) => request<ImportReceipt>('/api/chats/imports/commit', {
    method: 'POST', body: JSON.stringify({ inspectionToken, ...input }),
  }),
  exportChat: (id: string) => download(`/api/conversations/${id}/export?format=st-jsonl`),
  saveProvider: (input: {
    id?: string;
    revision?: number;
    name: string;
    baseUrl: string;
    model: string;
    apiMode: 'chat' | 'text';
    apiKey?: string;
  }) => {
    const { id, revision, ...fields } = input;
    return id === undefined
      ? request<ProviderProfileView>('/api/providers', {
        method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...fields }),
      })
      : request<ProviderProfileView>(`/api/providers/${id}`, {
        method: 'PATCH', body: JSON.stringify({ revision, patch: fields }),
      });
  },
  listConversations: () => request<Conversation[]>('/api/conversations'),
  createConversation: (input: {
    characterId: string;
    personaId: string;
    title: string;
    maxPromptTokens: number;
    maxResponseTokens: number;
  }) => request<Conversation>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  updateConversationSettings: (conversation: Conversation, patch: {
    maxPromptTokens: number;
    maxResponseTokens: number;
  }) => request<Conversation>(`/api/conversations/${conversation.id}`, {
    method: 'PATCH', body: JSON.stringify({ revision: conversation.revision, patch }),
  }),
  deleteConversation: (conversation: Conversation) => request<void>(
    `/api/conversations/${conversation.id}?revision=${conversation.revision}`,
    { method: 'DELETE' },
  ),
  getConversationMessages: (id: string) => request<ConversationDetail>(`/api/conversations/${id}/messages`),
  previewPrompt: async (conversation: Conversation, userText: string) => projectPromptPreview(await request<PromptPreviewResponse>(
    `/api/conversations/${conversation.id}/prompt-preview`,
    { method: 'POST', body: JSON.stringify({ conversationRevision: conversation.revision, mode: 'normal', userText }) },
  )),
  updateMessage: (message: Message, content: string) => request<Message>(`/api/messages/${message.id}`, {
    method: 'PATCH', body: JSON.stringify({ revision: message.revision, patch: { content } }),
  }),
  deleteMessage: (message: Message) => request<void>(`/api/messages/${message.id}?revision=${message.revision}`, { method: 'DELETE' }),
  switchActiveVariant: (message: Message, variantId: string) => request<Message>(`/api/messages/${message.id}/active-variant`, {
    method: 'PUT', body: JSON.stringify({ revision: message.revision, variantId }),
  }),
  startGeneration: async (
    conversation: Conversation,
    input: { mode: GenerationMode; userText?: string },
    signal?: AbortSignal,
  ) => {
    const response = await fetch(`/api/conversations/${conversation.id}/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationRevision: conversation.revision, ...input }),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
    }
    return response;
  },
  stopGeneration: async (generationId: string) => {
    const response = await fetch(`/api/generations/${generationId}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
    }
  },
};
