import type {
  Conversation,
  GenerationMode,
  GlobalGenerationConfig,
  GlobalGenerationSelection,
  InstalledScene,
  ConversationSceneState,
  SceneCatalogEntry,
  ScenePatchFailure,
  SaveAgentConfiguration,
  Message,
  MessageVariant,
  AgentRun,
  PresetKind,
  SaveMemory,
  SaveMemoryConfiguration,
  MemoryJob,
  PlayerOperation,
} from '@tavernnext/domain';
import { SCENE_ACTION_ENVELOPE_PROTOCOL } from '@tavernnext/domain';

export type { Conversation, Message, MessageVariant, PresetKind, SaveAgentConfiguration };
export type { AgentRun };
export type MemoryCenterView = {
  configuration: SaveMemoryConfiguration | null;
  memories: SaveMemory[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  jobs: Array<Omit<MemoryJob, 'payload'>>;
  embedding: { enabled: boolean; configured: boolean; model: string | null; dimensions: number | null };
};

export interface SceneCatalogEntryView extends SceneCatalogEntry { installed: boolean; coverUrl?: string }
export interface InstalledSceneView extends InstalledScene {
  coverUrl?: string;
  conversationCount: number;
  messageCount: number;
  fullyTrusted: true;
  trustNotice: string;
}
export type ConversationSceneStateView = ConversationSceneState;

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

export interface PersonaView extends MutableView {
  name: string;
  description: string;
  isDefault: boolean;
  compatibilitySummary?: CompatibilitySummary;
}

export interface PresetSelectorView {
  id: string;
  revision: number;
  name: string;
  kind: PresetKind;
  official: boolean;
}

export interface PresetView extends PresetSelectorView, MutableView {
  settings: Record<string, unknown>;
  compatibilitySummary?: CompatibilitySummary;
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
  effectiveEnabled?: boolean;
  activationSource?: 'template' | 'save';
  saveOverrideEnabled?: boolean;
  contentOverridden?: boolean;
  effectiveContent?: string;
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
  effectiveEnabled?: boolean;
}

export type WorldbookEntryInput = Omit<WorldbookEntryView, keyof MutableView | 'worldbookId' | 'sourceUid' | 'sourceOrdinal' | 'compatibilitySummary' | 'effectiveEnabled' | 'activationSource' | 'saveOverrideEnabled' | 'contentOverridden' | 'effectiveContent'>;
export type WorldbookEntryPatch = Partial<WorldbookEntryInput>;

export interface SaveRuntimeReferencesView {
  configuration: SaveAgentConfiguration;
  worldbooks: Array<{
    source: 'global' | 'character' | 'conversation';
    saveOwned: boolean;
    templateLineage?: { worldbookId: string | null; revision: number | null };
    value: WorldbookView;
  }>;
}

export interface ProviderProfileView {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  customBaseUrl?: string;
  toolCalls: boolean;
  hasApiKey: boolean;
}

export interface ProviderCatalogEntryView {
  id: string;
  name: string;
  authentication: 'api_key' | 'oauth' | 'subscription' | 'composite';
  available: boolean;
  customBaseUrl: boolean;
  baseUrl?: string;
  credentialLabel?: string;
  unavailableReason?: string;
  models: Array<{ id: string; name: string; baseUrl: string; toolCalls: boolean }>;
}

export interface ProviderModelView {
  id: string;
  ownedBy?: string;
}

export type GlobalGenerationConfigView = Pick<GlobalGenerationConfig, 'revision' | 'providerId' | 'chatPresetId' | 'selectionNotice'>;
export type GlobalGenerationConfigPatch = Partial<Pick<GlobalGenerationSelection, 'providerId' | 'chatPresetId'>>;

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
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error ? error.message : 'unknown_error';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>;
    throw new ApiError(response.status, payload.error ?? `http_${response.status}`, payload);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  listSceneCatalog: () => request<SceneCatalogEntryView[]>('/api/scenes/catalog'),
  listScenes: () => request<InstalledSceneView[]>('/api/scenes'),
  getScene: (id: string) => request<InstalledSceneView>(`/api/scenes/${encodeURIComponent(id)}`),
  listAgentRuns: (conversationId: string) => request<AgentRun[]>(
    `/api/development/agent-runs?conversationId=${encodeURIComponent(conversationId)}`,
  ),
  getMemoryCenter: (conversationId: string, page = 1, pageSize = 20) => request<MemoryCenterView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/memories?page=${page}&pageSize=${pageSize}`,
  ),
  updateMemorySettings: (conversationId: string, revision: number | null, enabled: boolean) => request<SaveMemoryConfiguration>(
    `/api/conversations/${encodeURIComponent(conversationId)}/memory-settings`,
    { method: 'PATCH', body: JSON.stringify({ revision, enabled }) },
  ),
  updateMemory: (memory: SaveMemory, patch: Pick<SaveMemory, 'pinned' | 'excluded'>) => request<SaveMemory>(
    `/api/memories/${encodeURIComponent(memory.id)}`,
    { method: 'PATCH', body: JSON.stringify({ revision: memory.revision, ...patch }) },
  ),
  deleteMemory: (memory: SaveMemory) => request<void>(
    `/api/memories/${encodeURIComponent(memory.id)}?revision=${memory.revision}`,
    { method: 'DELETE' },
  ),
  rebuildMemoryIndex: (conversationId: string) => request<MemoryJob>(
    `/api/conversations/${encodeURIComponent(conversationId)}/memory-index/rebuild`, { method: 'POST' },
  ),
  retryMemoryJob: (jobId: string) => request<MemoryJob>(
    `/api/memory-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' },
  ),
  backfillMemory: (conversationId: string) => request<{ created: number; skipped: number }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/memory-backfill`, { method: 'POST' },
  ),
  installScene: (id: string) => request<InstalledSceneView>(`/api/scenes/${encodeURIComponent(id)}/install`, { method: 'POST' }),
  uninstallScene: (scene: InstalledSceneView) => request<{ backupPath: string }>(`/api/scenes/${encodeURIComponent(scene.id)}`, {
    method: 'DELETE', body: JSON.stringify({ revision: scene.revision, cascade: true }),
  }),
  listSceneConversations: (sceneId: string) => request<Conversation[]>(`/api/scenes/${encodeURIComponent(sceneId)}/conversations`),
  createSceneConversation: (sceneId: string, input: {
    title: string;
    personaTemplateId?: string;
    playerProfile: { name: string; description: string };
    setup: Record<string, unknown>;
    maxPromptTokens?: number;
    maxResponseTokens?: number;
  }) => request<Conversation>(`/api/scenes/${encodeURIComponent(sceneId)}/conversations`, {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  getSceneState: (conversationId: string) => request<ConversationSceneStateView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/scene-state`,
  ),
  patchSceneState: (conversationId: string, revision: number, patch: unknown[]) => request<{
    state: ConversationSceneStateView;
    failures: ScenePatchFailure[];
  }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/scene-state`,
    { method: 'PATCH', body: JSON.stringify({ revision, patch }) },
  ),
  runSceneAction: (conversationId: string, action: unknown, operation?: PlayerOperation) => request<{
    state: ConversationSceneStateView;
    result: unknown;
    operation?: PlayerOperation & { messageId: string };
  }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/scene-actions`,
    {
      method: 'POST',
      body: JSON.stringify(operation === undefined
        ? action
        : { $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL, action, operation }),
    },
  ),
  listPersonas: () => request<PersonaView[]>('/api/personas'),
  getPersona: (id: string) => request<PersonaView>(`/api/personas/${id}`),
  createPersona: (input: { name: string; description: string; isDefault?: boolean }) => request<PersonaView>('/api/personas', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input, isDefault: input.isDefault ?? false }),
  }),
  updatePersona: (id: string, revision: number, patch: Partial<Pick<PersonaView, 'name' | 'description' | 'isDefault'>>) => request<PersonaView>(`/api/personas/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deletePersona: (id: string, revision: number) => request<void>(`/api/personas/${id}?revision=${revision}`, { method: 'DELETE' }),
  listProviders: () => request<ProviderProfileView[]>('/api/providers'),
  listProviderCatalog: () => request<ProviderCatalogEntryView[]>('/api/providers/catalog'),
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
  getSaveAgentConfiguration: (conversationId: string) => request<SaveAgentConfiguration>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent-configuration`,
  ),
  getSaveRuntimeReferences: (conversationId: string) => request<SaveRuntimeReferencesView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/runtime-references`,
  ),
  toggleSavePrompt: (conversationId: string, revision: number, identifier: string, enabled: boolean) => request<SaveAgentConfiguration>(
    `/api/conversations/${encodeURIComponent(conversationId)}/runtime-references/preset-prompts/${encodeURIComponent(identifier)}`,
    { method: 'PATCH', body: JSON.stringify({ revision, enabled }) },
  ),
  toggleRuntimeWorldbook: (conversationId: string, worldbookId: string, revision: number, enabled: boolean) => request<WorldbookView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/runtime-references/worldbooks/${encodeURIComponent(worldbookId)}`,
    { method: 'PATCH', body: JSON.stringify({ revision, enabled }) },
  ),
  toggleRuntimeWorldbookEntry: (
    conversationId: string,
    worldbookId: string,
    entryId: string,
    revision: number,
    enabled: boolean,
  ) => request<WorldbookEntryView>(
    `/api/conversations/${encodeURIComponent(conversationId)}/runtime-references/worldbooks/${encodeURIComponent(worldbookId)}/entries/${encodeURIComponent(entryId)}`,
    { method: 'PATCH', body: JSON.stringify({ revision, enabled }) },
  ),
  updateSaveAgentConfiguration: (
    conversationId: string,
    revision: number,
    patch: Pick<SaveAgentConfiguration, 'name' | 'settings'>,
  ) => request<SaveAgentConfiguration>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent-configuration`,
    { method: 'PATCH', body: JSON.stringify({ revision, patch }) },
  ),
  replaceSaveAgentConfiguration: (conversationId: string, revision: number, presetId: string) => (
    request<SaveAgentConfiguration>(
      `/api/conversations/${encodeURIComponent(conversationId)}/agent-configuration/replace`,
      { method: 'POST', body: JSON.stringify({ revision, presetId }) },
    )
  ),
  syncSaveAgentConfiguration: (conversationId: string, revision: number) => request<SaveAgentConfiguration>(
    `/api/conversations/${encodeURIComponent(conversationId)}/agent-configuration/sync`,
    { method: 'POST', body: JSON.stringify({ revision }) },
  ),
  getPreset: (id: string) => request<PresetView>(`/api/presets/${id}`),
  createPreset: (input: { name: string; kind: 'chat'; settings: Record<string, unknown> }) => request<PresetView>('/api/presets', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  updatePreset: (id: string, revision: number, patch: Partial<{ name: string; settings: Record<string, unknown>; deleteSettingKeys: string[] }>) => request<PresetView>(`/api/presets/${id}`, {
    method: 'PATCH', body: JSON.stringify({ revision, patch }),
  }),
  deletePreset: (id: string, revision: number) => request<void>(`/api/presets/${id}?revision=${revision}`, { method: 'DELETE' }),
  updateSaveWorldbook: (conversationId: string, worldbookId: string, revision: number, patch: Partial<Pick<WorldbookView, 'name' | 'description' | 'enabled' | 'scanDepth' | 'tokenBudget' | 'recursiveScanning'>>) => request<WorldbookView>(
    `/api/conversations/${conversationId}/save-worldbook/${worldbookId}`,
    { method: 'PATCH', body: JSON.stringify({ revision, patch }) },
  ),
  createSaveWorldbookEntry: (conversationId: string, worldbookId: string, input: WorldbookEntryInput) => request<WorldbookEntryView>(
    `/api/conversations/${conversationId}/save-worldbook/${worldbookId}/entries`,
    { method: 'POST', body: JSON.stringify(input) },
  ),
  updateSaveWorldbookEntry: (conversationId: string, worldbookId: string, entryId: string, revision: number, patch: WorldbookEntryPatch) => request<WorldbookEntryView>(
    `/api/conversations/${conversationId}/save-worldbook/${worldbookId}/entries/${entryId}`,
    { method: 'PATCH', body: JSON.stringify({ revision, patch }) },
  ),
  deleteSaveWorldbookEntry: (conversationId: string, worldbookId: string, entryId: string, revision: number) => request<void>(
    `/api/conversations/${conversationId}/save-worldbook/${worldbookId}/entries/${entryId}?revision=${revision}`,
    { method: 'DELETE' },
  ),
  reorderSaveWorldbookEntries: (conversationId: string, worldbookId: string, entries: Array<{ id: string; revision: number; order: number }>) => request<WorldbookEntryView[]>(
    `/api/conversations/${conversationId}/save-worldbook/${worldbookId}/entries/order`,
    { method: 'PUT', body: JSON.stringify({ entries }) },
  ),
  saveProvider: (input: {
    id?: string;
    revision?: number;
    name: string;
    providerId: string;
    modelId: string;
    customBaseUrl?: string;
    toolCalls?: boolean;
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
  deleteConversation: (conversation: Conversation) => request<void>(
    `/api/conversations/${conversation.id}?revision=${conversation.revision}`,
    { method: 'DELETE' },
  ),
  getConversationMessages: (id: string) => request<ConversationDetail>(`/api/conversations/${id}/messages`),
  updateMessage: (message: Message, content: string) => request<Message>(`/api/messages/${message.id}`, {
    method: 'PATCH', body: JSON.stringify({ revision: message.revision, patch: { content } }),
  }),
  deleteMessage: (message: Message) => request<void>(`/api/messages/${message.id}?revision=${message.revision}`, { method: 'DELETE' }),
  switchActiveVariant: (message: Message, variantId: string) => request<Message>(`/api/messages/${message.id}/active-variant`, {
    method: 'PUT', body: JSON.stringify({ revision: message.revision, variantId }),
  }),
  regenerateActionOptions: (conversationId: string, message: Message, variant: MessageVariant) => request<MessageVariant>(
    `/api/messages/${message.id}/action-options/regenerate`,
    {
      method: 'POST',
      body: JSON.stringify({ conversationId, variantId: variant.id, variantRevision: variant.revision }),
    },
  ),
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
