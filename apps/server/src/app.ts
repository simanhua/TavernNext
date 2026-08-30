import multipart from '@fastify/multipart';
import {
  createOpenAICompatibleClient,
  createPiAgentModelRuntime,
  type OpenAICompatibleProfile,
} from '@tavernnext/provider-openai-compatible';
import { DEFAULT_INSPECTION_LIMITS } from '@tavernnext/st-compat';
import { countMessages, countText, selectTokenizer } from '@tavernnext/tokenizer-engine';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, loadProviderSecrets, type ProviderSecretMap, type ServerConfig } from './config.js';
import { createDatabase, type TavernDatabase } from './db/client.js';
import { AGENT_FIRST_RESET_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, migrateDatabase, readSchemaVersion } from './db/migrate.js';
import { createRepositories } from './db/repositories.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerCharacterExportRoutes } from './routes/character-exports.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerGlobalGenerationConfigRoutes } from './routes/global-generation-config.js';
import { registerExtensionAssetRoutes } from './routes/extension-assets.js';
import { registerRuntimeStateRoutes } from './routes/runtime-states.js';
import { registerExtensionTrustRoutes } from './routes/extension-trust.js';
import { registerExtensionRuntimeRpcRoutes } from './routes/extension-runtime-rpc.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerInteractiveActionRoutes } from './routes/interactive-actions.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerPresetExportRoutes } from './routes/preset-exports.js';
import { registerPresetRoutes } from './routes/presets.js';
import { registerProviderRoutes } from './routes/providers.js';
import type { ProviderProbeFactory } from './routes/providers.js';
import { registerWorldbookExportRoutes } from './routes/worldbook-exports.js';
import { registerWorldbookRoutes } from './routes/worldbooks.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { registerSaveAgentConfigurationRoutes } from './routes/save-agent-configurations.js';
import { registerAgentRunRoutes } from './routes/agent-runs.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { createGenerationService } from './services/generation-service.js';
import type { PiAgentRuntimeFactory } from './services/scene-director-agent.js';
import type { SaveAgentRuntime } from './services/save-agent-runtime.js';
import { createPromptSnapshotService, type ServerTokenizerRuntime } from './services/prompt-snapshot-service.js';
import { createCharacterImportHandler } from './services/character-import-handler.js';
import { createPresetImportHandler } from './services/preset-import-handler.js';
import { synchronizeOfficialPresets } from './services/official-preset-registry.js';
import { createWorldbookImportHandler } from './services/worldbook-import-handler.js';
import { createImportService, type ImportHandler, type ImportStagingLimits } from './services/import-service.js';
import { createExtensionTrustService, type ExtensionRemoteFetcher } from './services/extension-trust-service.js';
import {
  acquireDatabaseOwnership,
  createPreMigrationBackup,
  type DatabaseOwnership,
} from './services/backup-service.js';
import { REDACTED_LOG_VALUE, redactLogValue } from './services/log-redaction.js';
import { createSecretStore } from './services/secret-store.js';
import { injectedSnapshotIntegrityKey, loadSnapshotIntegrityKey } from './snapshot-integrity-key.js';
import { createSceneService } from './scenes/scene-service.js';
import { upgradeInstalledOfficialScenes } from './scenes/official-scene-upgrade.js';
import { createOpenAICompatibleDenseSearch } from './services/memory-embedding.js';
import { createPiMemoryExtractor, createSaveMemoryService } from './services/save-memory-service.js';

export type StartupMigrationResult = 'writable' | 'read_only_migration_failed';

declare module 'fastify' {
  interface FastifyInstance {
    readonly startupMigrationResult?: StartupMigrationResult;
  }
}

export interface CreateAppOptions {
  config?: ServerConfig;
  database?: TavernDatabase;
  piAgentRuntimeFactory?: PiAgentRuntimeFactory;
  saveAgentRuntime?: SaveAgentRuntime;
  providerProbeFactory?: ProviderProbeFactory;
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
  loggerStream?: { write(message: string): void };
  backupClock?: () => Date;
  migrationRunner?: (database: TavernDatabase) => void;
  extensionRemoteFetcher?: ExtensionRemoteFetcher;
  databaseOwnershipTimeoutMs?: number;
  memoryWorkerIntervalMs?: number | false;
  synchronizeOfficialPresetCatalog?: boolean;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function startupDatabase(config: ServerConfig, options: CreateAppOptions): {
  database: TavernDatabase;
  result: StartupMigrationResult;
  ownership?: DatabaseOwnership;
  backupPath?: string;
} {
  const ownership = options.database === undefined
    ? acquireDatabaseOwnership(config.databasePath, options.databaseOwnershipTimeoutMs)
    : undefined;
  try {
    let backupPath: string | undefined;
    ownership?.assertHeld(config.databasePath);
    if (options.database === undefined && existsSync(config.databasePath)) {
      const closedConnection = createDatabase(config.databasePath);
      let schemaVersion: number | null;
      try {
        schemaVersion = readSchemaVersion(closedConnection);
      } finally {
        // The SQL.js image has no background writer; closing this inspection
        // connection is its boundary before WAL validation/checkpoint backup.
        closedConnection.close();
      }
      const needsMigration = schemaVersion !== CURRENT_SCHEMA_VERSION || options.migrationRunner !== undefined;
      const hasRecoveryWal = existsSync(`${config.databasePath}-wal`);
      if (needsMigration || hasRecoveryWal) {
        backupPath = createPreMigrationBackup({
          dataDir: config.dataDir,
          databasePath: config.databasePath,
          schemaVersion,
          retention: schemaVersion === null || schemaVersion < AGENT_FIRST_RESET_SCHEMA_VERSION ? 'pinned' : 'rolling',
          ...(ownership === undefined ? {} : { databaseOwnership: ownership }),
          ...(options.backupClock === undefined ? {} : { clock: options.backupClock }),
        }).path;
      }
    }

    const database = options.database ?? createDatabase(config.databasePath);
    try {
      (options.migrationRunner ?? migrateDatabase)(database);
      return {
        database,
        result: 'writable',
        ...(ownership === undefined ? {} : { ownership }),
        ...(backupPath === undefined ? {} : { backupPath }),
      };
    } catch {
      return {
        database,
        result: 'read_only_migration_failed',
        ...(ownership === undefined ? {} : { ownership }),
        ...(backupPath === undefined ? {} : { backupPath }),
      };
    }
  } catch {
    ownership?.release();
    throw new Error('Database startup failed.');
  }
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const loadedConfig = options.config ?? loadConfig();
  const config = options.config === undefined && options.database !== undefined
    ? { ...loadedConfig, dataDir: dirname(options.database.path), databasePath: options.database.path }
    : loadedConfig;
  const sensitiveHeaders = config.sensitiveHeaders ?? [];
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.x-api-key',
          ...sensitiveHeaders.map((header) => `req.headers[${JSON.stringify(header)}]`),
        ],
        censor: REDACTED_LOG_VALUE,
      },
      serializers: {
        req(request) {
          const candidate = request as unknown as {
            method?: unknown;
            url?: unknown;
            headers?: unknown;
            hostname?: unknown;
            ip?: unknown;
            socket?: { remoteAddress?: unknown };
          };
          return redactLogValue({
            method: candidate.method,
            url: candidate.url,
            host: candidate.hostname,
            remoteAddress: candidate.ip ?? candidate.socket?.remoteAddress,
            headers: candidate.headers,
          }, { sensitiveHeaders }) as Record<string, unknown>;
        },
        err(error) {
          const projected = redactLogValue(error, { sensitiveHeaders }) as Record<string, unknown>;
          return {
            ...projected,
            type: typeof projected.name === 'string' ? projected.name : 'Error',
            message: typeof projected.message === 'string' ? projected.message : 'Request failed',
            stack: typeof projected.stack === 'string' ? projected.stack : '',
          };
        },
        res(response) {
          return { statusCode: response.statusCode };
        },
      },
      ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
    },
  });

  const snapshotIntegrityKey = options.snapshotIntegrityKey === undefined
    ? loadSnapshotIntegrityKey(config.dataDir)
    : injectedSnapshotIntegrityKey(options.snapshotIntegrityKey);
  const secretStore = createSecretStore(config.dataDir);
  const startup = startupDatabase(config, options);
  try {
  const { database } = startup;
  app.decorate('startupMigrationResult', startup.result);
  if (startup.result === 'read_only_migration_failed') {
    app.log.warn({ code: 'migration_failed' }, 'Startup migration failed; read-only recovery mode is active.');
  }
  const repositories = createRepositories(database, { snapshotIntegrityKey });
  if (startup.result === 'writable') {
    const syncOfficialPresets = options.synchronizeOfficialPresetCatalog
      ?? (process.env.NODE_ENV !== 'test' && options.database === undefined);
    if (syncOfficialPresets) database.transaction(() => synchronizeOfficialPresets(repositories));
    for (const failure of upgradeInstalledOfficialScenes(database, config.dataDir, repositories)) {
      app.log.error(failure, 'Official Scene upgrade failed; the prior installed package remains active.');
    }
  }
  const scenes = createSceneService({ dataDir: config.dataDir, database, repositories });
  const imports = createImportService({
    dataDir: config.dataDir,
    database,
    repositories,
    handlers: options.importHandlers ?? [
      createCharacterImportHandler(),
      createPresetImportHandler(),
      createWorldbookImportHandler(),
    ],
    ...(options.importClock === undefined ? {} : { clock: options.importClock }),
    ...(options.importMoveAssets === undefined ? {} : { moveAssets: options.importMoveAssets }),
    ...(options.importRemoveStage === undefined ? {} : { removeStage: options.importRemoveStage }),
    ...(options.importCleanupIntervalMs === undefined ? {} : { cleanupIntervalMs: options.importCleanupIntervalMs }),
    ...(options.importLimits === undefined ? {} : { limits: options.importLimits }),
    ...(options.avatarMaxBytes === undefined ? {} : { avatarMaxBytes: options.avatarMaxBytes }),
  });
  const providerSecrets = options.providerSecrets ?? loadProviderSecrets();
  for (const [secretRef, secret] of Object.entries(providerSecrets)) {
    const existing = secretStore.get(secretRef);
    if (existing?.profileId === secret.providerId && existing.baseUrl === secret.baseUrl
      && existing.credential.type === 'api_key' && existing.credential.key === secret.value) continue;
    secretStore.set(secretRef, {
      profileId: secret.providerId,
      baseUrl: secret.baseUrl,
      credential: { type: 'api_key', key: secret.value },
    });
  }
  const resolveSecret = (profileId: string, baseUrl: string, secretRef: string): string | undefined => {
    const secret = secretStore.get(secretRef);
    if (secret === undefined) return undefined;
    if (secret.profileId !== profileId || normalizedBaseUrl(secret.baseUrl) !== normalizedBaseUrl(baseUrl)) return undefined;
    return secret.credential.type === 'api_key' ? secret.credential.key : undefined;
  };
  const resolvedProviderAuth = (profile: Parameters<PiAgentRuntimeFactory>[0]) => {
    const headers = Object.fromEntries(
      Object.entries(profile.headerSecretRefs).flatMap(([name, secretRef]) => {
        const value = resolveSecret(profile.id, profile.baseUrl, secretRef);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const apiKey = profile.secretRef === undefined
      ? undefined
      : resolveSecret(profile.id, profile.baseUrl, profile.secretRef);
    return { headers, apiKey };
  };
  const piAgentRuntimeFactory = options.piAgentRuntimeFactory ?? ((profile) => {
        const { headers, apiKey } = resolvedProviderAuth(profile);
        if (apiKey === undefined && profile.providerId !== 'custom-openai-compatible') {
          throw new Error('Provider credential is unavailable.');
        }
        return createPiAgentModelRuntime({
          providerId: profile.providerId,
          modelId: profile.modelId,
          baseUrl: profile.baseUrl,
          apiKey: apiKey ?? 'tavernnext-keyless-endpoint',
          headers,
        });
      }) satisfies PiAgentRuntimeFactory;
  const tokenizerRuntime: ServerTokenizerRuntime = options.tokenizerRuntime ?? {
    selectTokenizer,
    countText: (text, decision) => countText(text, decision, { dataDir: config.dataDir }),
    countMessages: (messages, decision) => countMessages(messages, decision, { dataDir: config.dataDir }),
  };
  const promptSnapshots = createPromptSnapshotService({ database, repositories, tokenizerRuntime });
  const memoryDenseSearch = createOpenAICompatibleDenseSearch({
    dataDir: config.dataDir,
    repositories,
    resolveSecret(secretRef) {
      const secret = secretStore.get(secretRef);
      return secret?.credential.type === 'api_key' ? secret.credential.key : undefined;
    },
  });
  const saveMemory = createSaveMemoryService(repositories, memoryDenseSearch, database);
  const memoryExtractor = createPiMemoryExtractor(repositories, piAgentRuntimeFactory);
  const memoryWorkerIntervalMs = options.memoryWorkerIntervalMs
    ?? (options.database === undefined ? 1_000 : false);
  let memoryWorkerRunning = false;
  const memoryWorkerTimer = memoryWorkerIntervalMs === false ? undefined : setInterval(() => {
    if (memoryWorkerRunning) return;
    memoryWorkerRunning = true;
    void saveMemory.processReadyJobs(memoryExtractor).catch((error) => {
      app.log.warn({ error }, 'Save Memory worker failed; pending jobs remain retryable.');
    }).finally(() => { memoryWorkerRunning = false; });
  }, Math.max(100, memoryWorkerIntervalMs));
  memoryWorkerTimer?.unref?.();
  const generations = options.saveAgentRuntime ?? createGenerationService({
    database,
    repositories,
    piAgentRuntimeFactory,
    promptSnapshotService: promptSnapshots,
    sceneService: scenes,
    saveMemoryService: saveMemory,
  });
  const extensionTrust = createExtensionTrustService(repositories, options.extensionRemoteFetcher ?? (async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('remote_fetch_failed');
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
    };
  }));

  if (startup.result === 'read_only_migration_failed') {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
      return reply.status(503).send({ error: 'read_only_migration_failed' });
    });
  }
  app.register(multipart, {
    limits: {
      fileSize: DEFAULT_INSPECTION_LIMITS.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
    throwFileSizeLimit: true,
  });
  app.get('/api/health', async () => startup.result === 'writable'
    ? {
        status: 'ok',
        app: 'TavernNext',
        ...(startup.backupPath === undefined ? {} : {
          backup: { kind: 'pre_migration', path: startup.backupPath },
        }),
      }
    : {
        status: 'warning',
        app: 'TavernNext',
        mode: 'read_only_migration_failed',
        ...(startup.backupPath === undefined ? {} : {
          backup: { kind: 'pre_migration', path: startup.backupPath },
        }),
        warning: {
          code: 'migration_failed',
          message: 'A database migration failed. Reads remain available; all mutations are disabled.',
        },
      });
  const legacyAssetApiEnabled = process.env.NODE_ENV === 'test'
    || process.env.TAVERNNEXT_ENABLE_LEGACY_ASSET_API === 'true';
  if (legacyAssetApiEnabled) {
    registerImportRoutes(app, imports);
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
    registerWorldbookRoutes(app, database, repositories);
    registerWorldbookExportRoutes(app, repositories);
    registerExtensionAssetRoutes(app, database, repositories);
    registerRuntimeStateRoutes(app, database, repositories);
    registerExtensionTrustRoutes(app, repositories, extensionTrust);
    registerExtensionRuntimeRpcRoutes(app, database, repositories, generations, extensionTrust);
    registerInteractiveActionRoutes(app, database, repositories, generations, extensionTrust);
  }
  registerPresetRoutes(app, database, repositories);
  registerPersonaRoutes(app, database, repositories);
  registerProviderRoutes(app, database, repositories, {
    has(profile) {
      return profile.secretRef !== undefined
        && resolveSecret(profile.id, profile.baseUrl, profile.secretRef) !== undefined;
    },
    read(profile) {
      return profile.secretRef === undefined ? undefined : resolveSecret(profile.id, profile.baseUrl, profile.secretRef);
    },
    put(profileId, baseUrl, apiKey) {
      const secretRef = `browser:${profileId}`;
      const previous = secretStore.get(secretRef);
      secretStore.set(secretRef, {
        profileId,
        baseUrl,
        credential: { type: 'api_key', key: apiKey },
      });
      return {
        secretRef,
        rollback() {
          if (previous === undefined) secretStore.delete(secretRef);
          else secretStore.set(secretRef, previous);
        },
      };
    },
    remove(secretRef) {
      const previous = secretStore.get(secretRef);
      secretStore.delete(secretRef);
      return {
        rollback() {
          if (previous !== undefined) secretStore.set(secretRef, previous);
        },
      };
    },
  }, options.providerProbeFactory ?? ((profile: OpenAICompatibleProfile) => createOpenAICompatibleClient(profile)));
  registerGlobalGenerationConfigRoutes(app, repositories);
  registerConversationRoutes(app, database, repositories, generations);
  registerMessageRoutes(app, database, repositories, generations, scenes);
  registerGenerationRoutes(app, generations);
  registerSaveAgentConfigurationRoutes(app, database, repositories);
  registerSceneRoutes(app, scenes, repositories, generations);
  registerAgentRunRoutes(app, repositories);
  registerMemoryRoutes(app, repositories);

  app.addHook('onClose', async () => {
    if (memoryWorkerTimer !== undefined) clearInterval(memoryWorkerTimer);
    try {
      await scenes.close();
    } finally {
      try {
        imports.close();
      } finally {
        try {
          database.close();
        } finally {
          startup.ownership?.release();
        }
      }
    }
  });

  return app;
  } catch (error) {
    try {
      startup.database.close();
    } finally {
      startup.ownership?.release();
    }
    throw error;
  }
}
