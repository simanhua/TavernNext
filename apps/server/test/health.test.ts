import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

describe('GET /api/health', () => {
  it('reports the local API as ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-health-'));
    const app = createApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: directory,
        databasePath: join(directory, 'test.sqlite'),
      },
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', app: 'TavernNext' });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
