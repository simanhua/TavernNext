import { createOpenAICompatibleClient } from '@tavernnext/provider-openai-compatible';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, loadProviderSecrets, type ProviderSecretMap, type ServerConfig } from './config.js';
import { createDatabase, type TavernDatabase } from './db/client.js';
import { migrateDatabase } from './db/migrate.js';
import { createRepositories } from './db/repositories.js';
import { registerCharacterRoutes } from './routes/characters.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerGenerationRoutes } from './routes/generations.js';
import { registerPersonaRoutes } from './routes/personas.js';
import { registerProviderRoutes } from './routes/providers.js';
import { createGenerationService, type ProviderClientFactory } from './services/generation-service.js';

export interface CreateAppOptions {
  config?: ServerConfig;
  database?: TavernDatabase;
  providerClientFactory?: ProviderClientFactory;
  providerSecrets?: ProviderSecretMap;
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

  const database = options.database ?? createDatabase((options.config ?? loadConfig()).databasePath);
  migrateDatabase(database);
  const repositories = createRepositories(database);
  const providerSecrets = options.providerSecrets ?? loadProviderSecrets();
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

  app.get('/api/health', async () => ({ status: 'ok', app: 'TavernNext' }));
  registerCharacterRoutes(app, repositories);
  registerPersonaRoutes(app, repositories);
  registerProviderRoutes(app, repositories);
  registerConversationRoutes(app, repositories);
  registerGenerationRoutes(app, generations);

  app.addHook('onClose', async () => {
    database.close();
  });

  return app;
}
