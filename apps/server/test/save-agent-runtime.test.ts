import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { registerGenerationRoutes } from '../src/routes/generations.js';
import type {
  SaveAgentRunInput,
  SaveAgentRuntime,
  SaveAgentRuntimeEvent,
} from '../src/services/save-agent-runtime.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const conversationId = '018f0000-0000-7000-8000-000000000601';

function createRuntimeStub(overrides: Partial<SaveAgentRuntime>): SaveAgentRuntime {
  return {
    async start() {
      return { ok: false, reason: 'not_found' };
    },
    async triggerLastUser() {
      return { ok: false, reason: 'not_found' };
    },
    async regenerateActionOptions() {
      return { ok: false, reason: 'not_found' };
    },
    cancel() {
      return false;
    },
    isConversationActive() {
      return false;
    },
    ...overrides,
  };
}

describe('Save Agent Runtime seam', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('drives the generation route through an injected runtime input, signal, and event stream', async () => {
    const app = Fastify();
    apps.push(app);
    let receivedInput: SaveAgentRunInput | undefined;
    let receivedSignal: AbortSignal | undefined;
    const runtime = createRuntimeStub({
      async start(input, signal) {
        receivedInput = input;
        receivedSignal = signal;
        const events: SaveAgentRuntimeEvent[] = [
          { type: 'started', generationId: 'generation-1' },
          { type: 'delta', text: 'Hello from the runtime' },
          { type: 'completed', finishReason: 'stop' },
        ];
        return {
          ok: true,
          generationId: 'generation-1',
          events: (async function* () { yield* events; })(),
        };
      },
    });
    registerGenerationRoutes(app, runtime);

    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/generations`,
      payload: { conversationRevision: 7, mode: 'normal', userText: 'Hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(receivedInput).toEqual({
      conversationId,
      conversationRevision: 7,
      mode: 'normal',
      userText: 'Hello',
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(response.payload).toContain('event: started\ndata: {"generationId":"generation-1"}');
    expect(response.payload).toContain('event: delta\ndata: {"text":"Hello from the runtime"}');
    expect(response.payload).toContain('event: completed\ndata: {"finishReason":"stop"}');
  });

  it('lets the application host replace the current generation adapter at the shared seam', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-save-agent-runtime-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    let starts = 0;
    const runtime = createRuntimeStub({
      async start() {
        starts += 1;
        return {
          ok: true,
          generationId: 'injected-run',
          events: (async function* () {
            yield { type: 'started', generationId: 'injected-run' } as const;
            yield { type: 'delta', text: 'Injected response' } as const;
            yield { type: 'completed', finishReason: 'stop' } as const;
          })(),
        };
      },
    });
    const app = createApp({
      database,
      saveAgentRuntime: runtime,
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir: directory,
        databasePath: database.path,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/generations`,
      payload: { conversationRevision: 0, mode: 'normal', userText: 'Hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(starts).toBe(1);
    expect(response.payload).toContain('event: delta\ndata: {"text":"Injected response"}');
  });
});
