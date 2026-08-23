import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatRequest,
  OpenAICompatibleClient,
  ProviderEvent,
  TextRequest,
} from '@tavernnext/provider-openai-compatible';
import { TokenizerId, type TokenizerDecision, type TokenizerSelectionInput } from '@tavernnext/tokenizer-engine';
import { createApp, type CreateAppOptions } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

export const integrationIds = {
  character: '018f1000-0000-7000-8000-000000000101',
  persona: '018f1000-0000-7000-8000-000000000102',
  provider: '018f1000-0000-7000-8000-000000000103',
  conversation: '018f1000-0000-7000-8000-000000000104',
  chatPreset: '018f1000-0000-7000-8000-000000000105',
  textPreset: '018f1000-0000-7000-8000-000000000106',
  contextPreset: '018f1000-0000-7000-8000-000000000107',
  instructPreset: '018f1000-0000-7000-8000-000000000108',
  systemPreset: '018f1000-0000-7000-8000-000000000109',
  globalBook: '018f1000-0000-7000-8000-000000000110',
  characterBook: '018f1000-0000-7000-8000-000000000111',
  conversationBook: '018f1000-0000-7000-8000-000000000112',
  globalEntry: '018f1000-0000-7000-8000-000000000113',
  characterEntry: '018f1000-0000-7000-8000-000000000114',
  conversationEntry: '018f1000-0000-7000-8000-000000000115',
  disabledEntry: '018f1000-0000-7000-8000-000000000116',
  historyUser: '018f1000-0000-7000-8000-000000000117',
  historyAssistant: '018f1000-0000-7000-8000-000000000118',
  historyVariant: '018f1000-0000-7000-8000-000000000119',
} as const;

export interface CapturedProvider {
  chat: ChatRequest[];
  text: TextRequest[];
  client: OpenAICompatibleClient;
}

export function capturedProvider(
  events: readonly ProviderEvent[] = [{ type: 'completed', finishReason: 'stop' }],
): CapturedProvider {
  const chat: ChatRequest[] = [];
  const text: TextRequest[] = [];
  return {
    chat,
    text,
    client: {
      listModels: async () => [],
      async *streamChat(request) {
        chat.push(structuredClone(request));
        for (const event of events) yield event;
      },
      async *streamText(request) {
        text.push(structuredClone(request));
        for (const event of events) yield event;
      },
    },
  };
}

export interface TestTokenizerRuntime {
  selectTokenizer(input: TokenizerSelectionInput): TokenizerDecision;
  countText(text: string, decision: TokenizerDecision): Promise<number>;
  countMessages(messages: readonly { role: string; content: string; name?: string }[], decision: TokenizerDecision): Promise<number>;
}

export function unitTokenizerRuntime(overrides: Partial<TestTokenizerRuntime> = {}): TestTokenizerRuntime {
  return {
    selectTokenizer(input) {
      const selected = input.requestedId === TokenizerId.BEST_MATCH ? TokenizerId.NONE : input.requestedId;
      return {
        requestedId: input.requestedId,
        tokenizerId: selected,
        tokenizerName: selected === TokenizerId.NONE ? 'None / Estimated' : `Test ${selected}`,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.api === undefined ? {} : { api: input.api }),
      };
    },
    countText: async (text) => text.length,
    countMessages: async (messages) => messages.reduce((total, message) => total + message.content.length + 1, 0),
    ...overrides,
  };
}

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const databasesByRepository = new WeakMap<Repositories, ReturnType<typeof createDatabase>>();

export async function closePromptIntegrationContexts(): Promise<void> {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function createPromptIntegrationContext(options: {
  provider?: CapturedProvider;
  tokenizerRuntime?: TestTokenizerRuntime;
  appOptions?: Partial<CreateAppOptions>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-full-prompt-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const snapshotIntegrityKey = options.appOptions?.snapshotIntegrityKey ?? TEST_SNAPSHOT_INTEGRITY_KEY;
  const repositories = createRepositories(database, { snapshotIntegrityKey });
  databasesByRepository.set(repositories, database);
  const provider = options.provider ?? capturedProvider();
  const app = createApp({
    database,
    providerClientFactory: () => provider.client,
    tokenizerRuntime: options.tokenizerRuntime ?? unitTokenizerRuntime(),
    snapshotIntegrityKey,
    ...options.appOptions,
  });
  apps.push(app);
  await app.ready();
  return { app, database, repositories, provider };
}

function createBook(
  repositories: Repositories,
  input: { id: string; name: string; isGlobal?: boolean; entryId: string; content: string; position?: number | string },
) {
  const book = repositories.worldbooks.create({
    id: input.id,
    name: input.name,
    description: '',
    enabled: true,
    scanDepth: 8,
    tokenBudget: 10_000,
    recursiveScanning: true,
    isGlobal: input.isGlobal ?? false,
  });
  const entry = repositories.worldbookEntries.create({
    id: input.entryId,
    worldbookId: book.id,
    sourceUid: input.content,
    sourceOrdinal: 0,
    keys: [],
    constant: true,
    content: input.content,
    position: input.position ?? 0,
    order: 100,
    sticky: 2,
  });
  return { book, entry };
}

export function seedFullPromptGraph(repositories: Repositories, mode: 'chat' | 'text' = 'chat') {
  const seed = () => {
  const global = createBook(repositories, {
    id: integrationIds.globalBook,
    name: 'Global lore',
    isGlobal: true,
    entryId: integrationIds.globalEntry,
    content: 'GLOBAL-LORE',
    position: 0,
  });
  const linked = createBook(repositories, {
    id: integrationIds.characterBook,
    name: 'Character lore',
    entryId: integrationIds.characterEntry,
    content: 'CHARACTER-LORE',
    position: 0,
  });
  const conversationBook = createBook(repositories, {
    id: integrationIds.conversationBook,
    name: 'Conversation lore',
    entryId: integrationIds.conversationEntry,
    content: 'CONVERSATION-LORE',
    position: 1,
  });
  repositories.worldbookEntries.create({
    id: integrationIds.disabledEntry,
    worldbookId: conversationBook.book.id,
    sourceUid: 'disabled',
    sourceOrdinal: 1,
    keys: ['never'],
    content: 'DISABLED-LORE',
    enabled: false,
  });

  const character = repositories.characters.create({
    id: integrationIds.character,
    name: 'Aster',
    description: 'A careful archivist.',
    personality: 'Patient',
    scenario: 'An old archive',
    firstMessage: 'Welcome.',
    examples: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: 'Card notes',
    alternateGreetings: [],
    tags: ['archive'],
    worldbookId: linked.book.id,
    characterBook: {
      name: 'Embedded lore',
      entries: [{
        id: 77,
        keys: [],
        secondary_keys: [],
        content: 'EMBEDDED-LORE',
        constant: true,
        selective: false,
        insertion_order: 100,
        enabled: true,
        position: 'before_char',
        extensions: { sticky: 2 },
      }],
    },
  });
  const persona = repositories.personas.create({
    id: integrationIds.persona,
    name: 'Traveler',
    description: 'A curious visitor.',
    isDefault: true,
  });
  const provider = repositories.providerProfiles.create({
    id: integrationIds.provider,
    name: 'Local mock',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'mock-model',
    apiMode: mode,
    secretRef: 'TOP-SECRET-API-KEY-REFERENCE',
    headerSecretRefs: { 'x-private': 'TOP-SECRET-HEADER-REFERENCE' },
    compatibility: {
      sourceFormat: 'test',
      rawPayload: { secret_vendor_value: 'TOP-SECRET-COMPATIBILITY-VALUE' },
      unknownFields: { secret_vendor_value: 'TOP-SECRET-COMPATIBILITY-VALUE' },
      compatWarnings: [],
      parserVersion: '1',
    },
  });

  const chatPreset = repositories.presets.create({
    id: integrationIds.chatPreset,
    name: 'Chat executable',
    kind: 'chat',
    settings: {
      prompts: [
        { identifier: 'main', role: 'system', content: 'MAIN {{char}}/{{user}}', system_prompt: true },
        { identifier: 'charDescription', marker: true, system_prompt: true },
        { identifier: 'personaDescription', marker: true, system_prompt: true },
        { identifier: 'worldInfoBefore', marker: true, role: 'system', system_prompt: true },
        { identifier: 'chatHistory', marker: true, system_prompt: true },
        { identifier: 'worldInfoAfter', marker: true, role: 'system', system_prompt: true },
      ],
      prompt_order: [{
        character_id: character.id,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
        ],
      }],
      tokenizer: TokenizerId.NONE,
      temperature: 0.25,
      max_tokens: 64,
      wi_format: '{0}',
      new_chat_prompt: '',
      vendor_api_key: 'TOP-SECRET-PRESET-COMPATIBILITY-VALUE',
    },
  });
  const textPreset = repositories.presets.create({
    id: integrationIds.textPreset,
    name: 'Text executable',
    kind: 'text',
    settings: { tokenizer: TokenizerId.NONE, temperature: 0.4, max_length: 72, max_context: 4_000 },
  });
  const contextPreset = repositories.presets.create({
    id: integrationIds.contextPreset,
    name: 'Context executable',
    kind: 'context',
    settings: {
      story_string: '{{description}}\n{{wiBefore}}\n{{wiAfter}}',
      example_separator: '',
      chat_start: '<CHAT>',
      use_stop_strings: true,
      names_as_stop_strings: true,
      always_force_name2: true,
    },
  });
  const instructPreset = repositories.presets.create({
    id: integrationIds.instructPreset,
    name: 'Instruct executable',
    kind: 'instruct',
    settings: {
      input_sequence: '<U>',
      output_sequence: '<A>',
      system_sequence: '<S>',
      input_suffix: '</U>\n',
      output_suffix: '</A>\n',
      system_suffix: '</S>\n',
      stop_sequence: ['<STOP>'],
      sequences_as_stop_strings: true,
      names_behavior: 'always',
      wrap: true,
      macro: true,
    },
  });
  const systemPreset = repositories.presets.create({
    id: integrationIds.systemPreset,
    name: 'System executable',
    kind: 'system',
    settings: { content: 'SYSTEM {{char}}', post_history: '' },
  });
  expectGlobalGenerationConfig(repositories, {
    providerId: provider.id,
    chatPresetId: chatPreset.id,
    textPresetId: textPreset.id,
    contextPresetId: contextPreset.id,
    instructPresetId: instructPreset.id,
    systemPresetId: systemPreset.id,
  });
  const conversation = repositories.conversations.create({
    id: integrationIds.conversation,
    characterId: character.id,
    personaId: persona.id,
    title: 'Full prompt graph',
    worldbookIds: [conversationBook.book.id],
    maxPromptTokens: 4_000,
    maxResponseTokens: 128,
  });

  const historyUser = repositories.messages.create({
    id: integrationIds.historyUser,
    conversationId: conversation.id,
    role: 'user',
    content: 'Earlier question',
    activeVariantId: null,
  });
  const historyAssistant = repositories.messages.create({
    id: integrationIds.historyAssistant,
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    activeVariantId: null,
  });
  const historyVariant = repositories.messageVariants.create({
    id: integrationIds.historyVariant,
    messageId: historyAssistant.id,
    content: 'Earlier answer',
    status: 'completed',
    finishReason: 'stop',
  });
  const linkedVariant = repositories.messages.update(historyAssistant.id, historyAssistant.revision, {
    activeVariantId: historyVariant.id,
  });
  if (!linkedVariant.ok) throw new Error('Could not seed active history variant.');

    return {
    global,
    linked,
    conversationBook,
    character,
    persona,
    provider,
    chatPreset,
    textPreset,
    contextPreset,
    instructPreset,
    systemPreset,
    conversation,
    historyUser,
    historyAssistant: linkedVariant.value,
    historyVariant,
    };
  };
  const database = databasesByRepository.get(repositories);
  return database === undefined ? seed() : database.transaction(seed);
}

function expectGlobalGenerationConfig(
  repositories: Repositories,
  selection: Parameters<Repositories['globalGenerationConfig']['update']>[1],
): void {
  const current = repositories.globalGenerationConfig.get();
  const result = repositories.globalGenerationConfig.update(current.revision, selection);
  if (!result.ok) throw new Error('Could not seed global generation configuration.');
}

export function previewPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationRevision: 0,
    mode: 'normal',
    userText: 'Open the portal',
    seed: 'snapshot-seed',
    messageIndex: 2,
    ...overrides,
  };
}

export async function requestPreview(app: ReturnType<typeof createApp>, overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/conversations/${integrationIds.conversation}/prompt-preview`,
    payload: previewPayload(overrides),
  });
}

export async function requestGeneration(
  app: ReturnType<typeof createApp>,
  snapshotId?: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/conversations/${integrationIds.conversation}/generations`,
    payload: previewPayload({ ...(snapshotId === undefined ? {} : { snapshotId }), ...overrides }),
  });
}
