import multipart from '@fastify/multipart';
import { createOpenAICompatibleClient } from '@tavernnext/provider-openai-compatible';
import { DEFAULT_INSPECTION_LIMITS } from '@tavernnext/st-compat';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, loadProviderSecrets, type ProviderSecretMap, type ServerConfig } from './config.js';
import { createDatabase, type TavernDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { createRepositories } from './db/repositories.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerProviderRoutes } from './routes/providers.js';
import { createGenerationService, type ProviderClientFactory } from './services/generation-service.js';
import { createImportService, type ImportHandler } from './services/import-service.js';

export interface CreateAppOptions {
  config?: ServerConfig;
  database?: TavernDatabase;
  providerClientFactory?: ProviderClientFactory;
  providerSecrets?: ProviderSecretMap;
  importHandlers?: readonly ImportHandler[];
  importClock?: () => number;
  importMoveAssets?: (source: string, destination: string) => void;
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
  const database = options.database ?? createDatabase(config.databasePath);
  migrateDatabase(database);
  const repositories = createRepositories(database);
  const imports = createImportService({
    dataDir: config.dataDir,
    database,
    repositories,
    ...(options.importHandlers === undefined ? {} : { handlers: options.importHandlers }),
    ...(options.importClock === undefined ? {} : { clock: options.importClock }),
    ...(options.importMoveAssets === undefined ? {} : { moveAssets: options.importMoveAssets }),
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
  const generations = createGenerationService({ database, repositories, providerClientFactory });

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
  registerCharacterRoutes(app, repositories);
  registerPersonaRoutes(app, repositories);
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
  registerConversationRoutes(app, repositories);
  registerMessageRoutes(app, repositories);
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
