import { join, resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(environment.TAVERNNEXT_DATA_DIR ?? join(process.cwd(), '.tavernnext'));
  return {
    host: environment.TAVERNNEXT_HOST ?? '127.0.0.1',
    port: Number(environment.TAVERNNEXT_PORT ?? 4312),
    dataDir,
    databasePath: resolve(environment.TAVERNNEXT_DATABASE_PATH ?? join(dataDir, 'tavernnext.sqlite')),
  };
}
