import { afterEach, describe, expect, it } from 'vitest';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  requestGeneration,
  requestPreview,
  seedFullPromptGraph,
} from './prompt-integration-fixtures.js';

afterEach(closePromptIntegrationContexts);

function insertOverflowingGlobalWorldbooks(database: Awaited<ReturnType<typeof createPromptIntegrationContext>>['database']) {
  const digits = '(VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))';
  database.sqlite.exec(`
    WITH seq(n) AS (
      SELECT a.column1 + 10*b.column1 FROM ${digits} a, ${digits} b LIMIT 64
    ) INSERT INTO worldbooks (id, revision, created_at, updated_at, payload, name, is_global)
      SELECT printf('overflow-global-%03d', n), 0, '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z', '{}', printf('overflow-%03d', n), 1 FROM seq;
  `);
}

describe('bounded global Worldbook prompt integration', () => {
  it('maps an initial global relation overflow to aggregate_limit before parsing rows', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    insertOverflowingGlobalWorldbooks(database);

    const response = await requestPreview(app);

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'aggregate_limit' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.generationSnapshots.list()).toEqual([]);
    expect(repositories.messages.list()).toHaveLength(2);
  });

  it('maps a revalidation overflow to snapshot_stale with no provider or state changes', async () => {
    const provider = capturedProvider();
    const { app, database, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const preview = (await requestPreview(app)).json();
    const beforeMessages = repositories.messages.list();
    insertOverflowingGlobalWorldbooks(database);

    const response = await requestGeneration(app, preview.snapshotId);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'snapshot_stale' });
    expect(provider.chat).toEqual([]);
    expect(provider.text).toEqual([]);
    expect(repositories.messages.list()).toEqual(beforeMessages);
    expect(repositories.worldbookRuntimeStates.list()).toEqual([]);
  });
});
