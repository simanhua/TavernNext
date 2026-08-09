import multipart from '@fastify/multipart';
import { createOpenAICompatibleClient } from '@tavernnext/provider-openai-compatible';
import { DEFAULT_INSPECTION_LIMITS } from '@tavernnext/st-compat';
import { countMessages, countText, selectTokenizer } from '@tavernnext/tokenizer-engine';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, loadProviderSecrets, type ProviderSecretMap, type ServerConfig } from './config.js';
import { createDatabase, type TavernDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { createRepositories } from './db/repositories.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerCharacterExportRoutes } from './routes/character-exports.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerPromptPreviewRoutes } from './routes/prompt-preview.js';
import { registerPresetExportRoutes } from './routes/preset-exports.js';
import { registerPresetRoutes } from './routes/presets.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerWorldbookExportRoutes } from './routes/worldbook-exports.js';
import { registerWorldbookRoutes } from './routes/worldbooks.js';
import { registerChatImportExportRoutes } from './routes/chat-import-export.js';
import { createGenerationService, type ProviderClientFactory } from './services/generation-service.js';
import { createPromptPreviewService } from './services/prompt-preview-service.js';
import { createPromptSnapshotService, type ServerTokenizerRuntime } from './services/prompt-snapshot-service.js';
import { createCharacterImportHandler } from './services/character-import-handler.js';
import { createPresetImportHandler } from './services/preset-import-handler.js';
import { createWorldbookImportHandler } from './services/worldbook-import-handler.js';
import { createChatImportHandler } from './services/chat-import-handler.js';
import { createImportService, type ImportHandler, type ImportStagingLimits } from './services/import-service.js';
import { injectedSnapshotIntegrityKey, loadSnapshotIntegrityKey } from './snapshot-integrity-key.js';

export interface CreateAppOptions {
  config?: ServerConfig;
  database?: TavernDatabase;
  providerClientFactory?: ProviderClientFactory;
  providerSecrets?: ProviderSecretMap;
  tokenizerRuntime?: ServerTokenizerRuntime;
  importHandlers?: readonly ImportHandler[];
  importClock?: () => number;
  importMoveAssets?: (source: string, destination: string) => void;
  importRemoveStage?: (path: string) => void;
  importCleanupIntervalMs?: number;
  importLimits?: ImportStagingLimits;
  avatarBeforeCommit?: () => void;
  avatarLegacyAfterFirstChunk?: () => void;
  avatarMaxBytes?: number;
  snapshotIntegrityKey?: Uint8Array;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.x-api-key'],
    },
  });

  const config = options.config ?? loadConfig();
  const snapshotIntegrityKey = options.snapshotIntegrityKey === undefined
    ? loadSnapshotIntegrityKey(config.dataDir)
    : injectedSnapshotIntegrityKey(options.snapshotIntegrityKey);
  const database = options.database ?? createDatabase(config.databasePath);
  migrateDatabase(database);
  const repositories = createRepositories(database, { snapshotIntegrityKey });
  const imports = createImportService({
    dataDir: config.dataDir,
    database,
    repositories,
    handlers: options.importHandlers ?? [
      createCharacterImportHandler(),
      createPresetImportHandler(),
      createWorldbookImportHandler(),
      createChatImportHandler(),
    ],
    ...(options.importClock === undefined ? {} : { clock: options.importClock }),
    ...(options.importMoveAssets === undefined ? {} : { moveAssets: options.importMoveAssets }),
    ...(options.importRemoveStage === undefined ? {} : { removeStage: options.importRemoveStage }),
    ...(options.importCleanupIntervalMs === undefined ? {} : { cleanupIntervalMs: options.importCleanupIntervalMs }),
    ...(options.importLimits === undefined ? {} : { limits: options.importLimits }),
    ...(options.avatarMaxBytes === undefined ? {} : { avatarMaxBytes: options.avatarMaxBytes }),
  });
  const providerSecrets: Record<string, { providerId: string; baseUrl: string; value: string }> = {
    ...(options.providerSecrets ?? loadProviderSecrets()),
  };
  const resolveSecret = (profileId: string, baseUrl: string, secretRef: string): string | undefined => {
    const secret = providerSecrets[secretRef];
    if (secret === undefined) return undefined;
    if (secret.providerId !== profileId || normalizedBaseUrl(secret.baseUrl) !== normalizedBaseUrl(baseUrl)) return undefined;
    return secret.value;
  };
  const providerClientFactory: ProviderClientFactory = options.providerClientFactory ?? ((profile) => {
    const headers = Object.fromEntries(
      Object.entries(profile.headerSecretRefs).flatMap(([name, secretRef]) => {
        const value = resolveSecret(profile.id, profile.baseUrl, secretRef);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    return createOpenAICompatibleClient({
      baseUrl: profile.baseUrl,
      ...(profile.secretRef === undefined ? {} : { apiKey: resolveSecret(profile.id, profile.baseUrl, profile.secretRef) }),
      headers,
    });
  });
  const tokenizerRuntime: ServerTokenizerRuntime = options.tokenizerRuntime ?? {
    selectTokenizer,
    countText: (text, decision) => countText(text, decision, { dataDir: config.dataDir }),
    countMessages: (messages, decision) => countMessages(messages, decision, { dataDir: config.dataDir }),
  };
  const promptSnapshots = createPromptSnapshotService({ database, repositories, tokenizerRuntime });
  const promptPreviews = createPromptPreviewService(promptSnapshots);
  const generations = createGenerationService({
    database,
    repositories,
    providerClientFactory,
    promptSnapshotService: promptSnapshots,
  });

  app.register(multipart, {
    limits: {
      fileSize: DEFAULT_INSPECTION_LIMITS.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
    throwFileSizeLimit: true,
  });
  app.get('/api/health', async () => ({ status: 'ok', app: 'TavernNext' }));
  registerImportRoutes(app, imports);
  registerChatImportExportRoutes(app, imports, repositories);
  registerCharacterRoutes(app, database, repositories);
  registerAvatarRoutes(
    app,
    database,
    repositories,
    config.dataDir,
    options.avatarBeforeCommit,
    options.avatarMaxBytes,
    options.avatarLegacyAfterFirstChunk,
  );
  registerCharacterExportRoutes(app, repositories, config.dataDir);
  registerPresetExportRoutes(app, repositories);
  registerPresetRoutes(app, repositories);
  registerWorldbookRoutes(app, database, repositories);
  registerWorldbookExportRoutes(app, repositories);
  registerPersonaRoutes(app, database, repositories);
  registerProviderRoutes(app, repositories, {
    has(profile) {
      return profile.secretRef !== undefined
        && resolveSecret(profile.id, profile.baseUrl, profile.secretRef) !== undefined;
    },
    put(profileId, baseUrl, apiKey) {
      const secretRef = `browser:${profileId}`;
      providerSecrets[secretRef] = { providerId: profileId, baseUrl, value: apiKey };
      return secretRef;
    },
    remove(secretRef) {
      delete providerSecrets[secretRef];
    },
  });
  registerConversationRoutes(app, repositories, generations);
  registerMessageRoutes(app, database, repositories, generations);
  registerPromptPreviewRoutes(app, promptPreviews);
  registerGenerationRoutes(app, generations);

  app.addHook('onClose', async () => {
    try {
      imports.close();
    } finally {
      database.close();
    }
  });

  return app;
}
