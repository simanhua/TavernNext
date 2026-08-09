import { copyFileSync, linkSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSnapshotIntegrityKey,
  SNAPSHOT_INTEGRITY_KEY_FILE,
} from '../src/snapshot-integrity-key.js';

const directories: string[] = [];
const emptyEnvironment: NodeJS.ProcessEnv = {};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-key-publication-'));
  directories.push(directory);
  return directory;
}

function temporaryKeyNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => (
    name.startsWith(`.${SNAPSHOT_INTEGRITY_KEY_FILE}.`) && name.endsWith('.tmp')
  ));
}

function temporaryKeyName(pid: number, entropy: string): string {
  return `.${SNAPSHOT_INTEGRITY_KEY_FILE}.${pid}-${entropy.padEnd(32, '0')}.tmp`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('snapshot integrity key atomic publication', () => {
  it('lets a concurrent creator publish while the first creator is paused without exposing or overwriting a partial key', async () => {
    const directory = await temporaryDirectory();
    let concurrentWinner: Uint8Array | undefined;
    let pausedPublishCalls = 0;

    const resumedCreator = loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      publish(temporaryPath, publishedPath) {
        pausedPublishCalls += 1;
        concurrentWinner = loadSnapshotIntegrityKey(directory, emptyEnvironment);
        linkSync(temporaryPath, publishedPath);
      },
    });

    expect(pausedPublishCalls).toBe(1);
    expect(concurrentWinner).toBeDefined();
    expect(resumedCreator).toEqual(concurrentWinner);
    expect(await readFile(join(directory, SNAPSHOT_INTEGRITY_KEY_FILE))).toEqual(Buffer.from(concurrentWinner!));
    expect(temporaryKeyNames(directory)).toEqual([]);
  });

  it('recovers after a creator crashes before publication and removes abandoned task temporaries after publishing', async () => {
    const directory = await temporaryDirectory();
    const abandonedName = temporaryKeyName(2_147_483_647, 'dead');
    const abandonedPath = join(directory, abandonedName);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      publish(temporaryPath) {
        copyFileSync(temporaryPath, abandonedPath);
        throw new Error('simulated creator crash before publication');
      },
    })).toThrow('Snapshot integrity key could not be created.');
    expect(temporaryKeyNames(directory)).toEqual([abandonedName]);

    const recovered = loadSnapshotIntegrityKey(directory, emptyEnvironment);

    expect(recovered).toHaveLength(32);
    expect(temporaryKeyNames(directory)).toEqual([]);
    expect(loadSnapshotIntegrityKey(directory, emptyEnvironment)).toEqual(recovered);
  });

  it('does not remove another live creator temporary while reclaiming a crashed creator temporary', async () => {
    const directory = await temporaryDirectory();
    loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const liveName = temporaryKeyName(process.pid, '1a');
    const crashedName = temporaryKeyName(2_147_483_647, 'dead');
    writeFileSync(join(directory, liveName), Buffer.alloc(1));
    writeFileSync(join(directory, crashedName), Buffer.alloc(1));

    loadSnapshotIntegrityKey(directory, emptyEnvironment);

    expect(temporaryKeyNames(directory)).toEqual([liveName]);
  });

  it('strictly refuses a malformed published key instead of replacing it with a task temporary', async () => {
    const directory = await temporaryDirectory();
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    const malformed = Buffer.alloc(31, 0x5a);
    writeFileSync(publishedPath, malformed);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');
    expect(await readFile(publishedPath)).toEqual(malformed);
    expect(temporaryKeyNames(directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('fsyncs the POSIX parent directory after publication and temporary cleanup', async () => {
    const directory = await temporaryDirectory();
    const syncedDirectories: string[] = [];

    loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      syncDirectory(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([resolve(directory), resolve(directory)]);
    syncedDirectories.length = 0;

    loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      syncDirectory(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([resolve(directory)]);
  });
});
