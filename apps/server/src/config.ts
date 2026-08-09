import { join, resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  sensitiveHeaders?: readonly string[];
}

export interface BoundProviderSecret {
  providerId: string;
  baseUrl: string;
  value: string;
}

export type ProviderSecretMap = Readonly<Record<string, BoundProviderSecret>>;

function sensitiveHeadersFrom(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  const headers: string[] = [];
  for (const candidate of value.split(',')) {
    const header = candidate.trim().toLowerCase();
    if (header === '' || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(header)) {
      throw new Error('Invalid TAVERNNEXT_SENSITIVE_HEADERS');
    }
    if (!headers.includes(header)) headers.push(header);
  }
  return headers;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(environment.TAVERNNEXT_DATA_DIR ?? join(process.cwd(), '.tavernnext'));
  return {
    host: environment.TAVERNNEXT_HOST ?? '127.0.0.1',
    port: Number(environment.TAVERNNEXT_PORT ?? 4312),
    dataDir,
    databasePath: resolve(environment.TAVERNNEXT_DATABASE_PATH ?? join(dataDir, 'tavernnext.sqlite')),
    sensitiveHeaders: sensitiveHeadersFrom(environment.TAVERNNEXT_SENSITIVE_HEADERS),
  };
}

export function loadProviderSecrets(environment: NodeJS.ProcessEnv = process.env): ProviderSecretMap {
  const encoded = environment.TAVERNNEXT_PROVIDER_SECRETS_JSON;
  if (encoded === undefined || encoded === '') return {};
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid map');
    return Object.fromEntries(Object.entries(parsed).map(([reference, candidate]) => {
      if (reference === '' || typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new Error('invalid entry');
      }
      const value = candidate as Record<string, unknown>;
      if (typeof value.providerId !== 'string' || typeof value.baseUrl !== 'string' || typeof value.value !== 'string') {
        throw new Error('invalid entry');
      }
      new URL(value.baseUrl);
      return [reference, { providerId: value.providerId, baseUrl: value.baseUrl, value: value.value }];
    }));
  } catch {
    throw new Error('Invalid TAVERNNEXT_PROVIDER_SECRETS_JSON');
  }
}
