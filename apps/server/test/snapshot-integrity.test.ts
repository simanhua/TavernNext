import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('snapshot integrity trust anchor', () => {
  it('creates one owner-private 256-bit local key and reuses it across app restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-integrity-key-'));
    directories.push(directory);
    const config = {
      host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'tavernnext.sqlite'),
    };
    const keyPath = join(directory, 'snapshot-integrity.key');
    const firstApp = createApp({ config });
    await firstApp.ready();
    await firstApp.close();
    const first = await readFile(keyPath);
    const firstStats = await stat(keyPath);

    const secondApp = createApp({ config });
    await secondApp.ready();
    await secondApp.close();
    const second = await readFile(keyPath);

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    if (process.platform !== 'win32') expect(firstStats.mode & 0o777).toBe(0o600);
  });
});
