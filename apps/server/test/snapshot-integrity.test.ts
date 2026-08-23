import { readFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { canonicalHash } from '../src/services/prompt-snapshot-service.js';
import {
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  previewPayload,
  requestGeneration,
  seedFullPromptGraph,
} from './prompt-integration-fixtures.js';

const directories: string[] = [];
const testIntegrityKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected record fixture.');
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array fixture.');
  return value;
}

function recomputePublicHashes(payload: Record<string, unknown>): void {
  payload.compiledRequestHash = canonicalHash(payload.compiledRequest);
  const { payloadHash: ignoredPayloadHash, ...unsigned } = payload;
  void ignoredPayloadHash;
  payload.payloadHash = canonicalHash(unsigned);
}

async function requestSealedCandidate(app: ReturnType<typeof createApp>) {
  const candidate = (await app.inject({
    method: 'POST', url: `/api/conversations/${integrationIds.conversation}/generation-candidates`,
    payload: previewPayload(),
  })).json();
  const sealed = await app.inject({
    method: 'POST', url: `/api/generation-candidates/${candidate.candidateId as string}/seal`,
    payload: { patch: {} },
  });
  expect(sealed.statusCode).toBe(201);
  return sealed.json() as { snapshotId: string };
}

afterEach(async () => {
  await closePromptIntegrationContexts();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('snapshot integrity trust anchor', () => {
  it.each([
    ['Character audit', (payload: Record<string, unknown>) => {
      record(record(payload.executable).character).description = 'FORGED-CHARACTER';
    }],
    ['history audit', (payload: Record<string, unknown>) => {
      record(array(record(payload.executable).history)[0]).content = 'FORGED-HISTORY';
    }],
    ['tokenizer decision', (payload: Record<string, unknown>) => {
      record(payload.tokenizerDecision).tokenizerName = 'FORGED-TOKENIZER';
    }],
    ['next timed state', (payload: Record<string, unknown>) => {
      record(record(payload.worldbook).timedState).messageIndex = 999;
    }],
    ['root messages and compiled request', (payload: Record<string, unknown>) => {
      record(array(payload.messages)[0]).content = 'FORGED-REPLAY-MESSAGE';
      record(array(record(payload.compiledRequest).messages)[0]).content = 'FORGED-REPLAY-MESSAGE';
    }],
  ] as const)('rejects a fully rehashed %s mutation before every side effect', async (_label, mutate) => {
    const { app, database, repositories, provider } = await createPromptIntegrationContext({
      appOptions: { snapshotIntegrityKey: testIntegrityKey },
    });
    seedFullPromptGraph(repositories);
    const preview = await requestSealedCandidate(app);
    const beforeMessages = repositories.messages.list();
    const beforeTimedState = repositories.worldbookRuntimeStates.list();
    const row = database.sqlite.prepare('SELECT payload FROM generation_snapshots WHERE id = ?').get(preview.snapshotId);
    const storedEntity = record(JSON.parse(String(row?.payload)));
    const payload = record(storedEntity.payload);
    mutate(payload);
    recomputePublicHashes(payload);
    database.sqlite.prepare('UPDATE generation_snapshots SET payload = ? WHERE id = ?')
      .run(JSON.stringify(storedEntity), preview.snapshotId);

    const response = await requestGeneration(app, preview.snapshotId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_invalid' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toEqual(beforeMessages);
    expect(repositories.worldbookRuntimeStates.list()).toEqual(beforeTimedState);
  });

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
