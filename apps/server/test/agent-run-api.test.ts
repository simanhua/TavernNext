import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Agent Run development API', () => {
  it('queries at most the newest 100 runs in SQL and exposes no global detail endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-agent-run-api-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Character', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Audit Save',
    });
    const revision = { id: randomUUID(), revision: 0 };
    const insert = database.sqlite.prepare(`
      INSERT INTO agent_runs (
        id, revision, created_at, updated_at, payload, conversation_id, generation_id, status
      ) VALUES (?, 0, ?, ?, ?, ?, ?, 'completed')
    `);
    database.transaction(() => {
      for (let index = 0; index < 101; index += 1) {
        const suffix = index.toString(16).padStart(12, '0');
        const createdAt = new Date(Date.UTC(2099, 7, 27, 0, 0, 0, index)).toISOString();
        const value = {
          id: `018f3000-0000-7000-8000-${suffix}`,
          revision: 0,
          createdAt,
          updatedAt: createdAt,
          conversationId: conversation.id,
          generationId: `018f4000-0000-7000-8000-${suffix}`,
          snapshotId: `018f5000-0000-7000-8000-${suffix}`,
          status: 'completed',
          startedAt: createdAt,
          finishedAt: createdAt,
          limits: { maxModelTurns: 8, maxToolCalls: 16, timeoutMs: 120_000 },
          counts: { modelTurns: 1, toolCalls: 0 },
          usage: { inputTokens: 1, outputTokens: 1 },
          promptPlan: { schemaVersion: 1, hash: 'a'.repeat(64), promptTokens: 1, messageCount: 1 },
          revisions: {
            conversation: { id: conversation.id, revision: 0 },
            character: { id: character.id, revision: 0 },
            persona: { id: persona.id, revision: 0 },
            provider: revision,
            saveAgentConfiguration: revision,
            sceneState: null,
          },
          lifecycle: [],
          activities: [],
          diagnostics: [],
        };
        insert.run(value.id, createdAt, createdAt, JSON.stringify(value), conversation.id, value.generationId);
      }
    });
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();

    const response = await app.inject({
      method: 'GET', url: `/api/development/agent-runs?conversationId=${conversation.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(100);
    expect(response.json()[0].id).toBe('018f3000-0000-7000-8000-000000000064');
    expect(response.payload).not.toContain('018f3000-0000-7000-8000-000000000000');
    expect((await app.inject({
      method: 'GET', url: '/api/development/agent-runs/018f3000-0000-7000-8000-000000000064',
    })).statusCode).toBe(404);
  });
});
