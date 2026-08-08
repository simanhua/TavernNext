import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import type { ImportHandler } from '../src/services/import-service.js';

const encoder = new TextEncoder();
const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'presets');
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context(options: Partial<NonNullable<Parameters<typeof createApp>[0]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-preset-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database);
  const app = createApp({
    ...options,
    database,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

function multipart(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-preset-api-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function fixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureRoot, path)));
}

async function inspectAndCommit(app: ReturnType<typeof createApp>, path: string, fileName = path) {
  const inspected = await app.inject({
    method: 'POST', url: '/api/imports/inspect', ...multipart(fileName, await fixture(path)),
  });
  expect(inspected.statusCode).toBe(200);
  const committed = await app.inject({
    method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
  });
  return { inspected, committed };
}

describe('typed SillyTavern Preset import and export API', () => {
  it('uses the default handler to reparse staged bytes into a fresh Preset plus one ImportArtifact without merging same-name imports', async () => {
    const { app, repositories } = await context();
    const first = await inspectAndCommit(app, 'chat/synthetic-chat.settings', 'first-rename.bin');
    const second = await inspectAndCommit(app, 'chat/synthetic-chat.settings', 'second-rename.bin');

    expect(first.inspected.json()).toMatchObject({
      detected: { kind: 'preset' },
      normalizedPreview: { kind: 'chat', settings: { tokenizer: 17 } },
      warnings: expect.arrayContaining([expect.objectContaining({ code: 'provider_field_preserved_not_executable' })]),
    });
    expect(first.committed.statusCode).toBe(201);
    expect(second.committed.statusCode).toBe(201);
    expect(first.committed.json().entityId).not.toBe(second.committed.json().entityId);
    expect(repositories.presets.list()).toEqual([
      expect.objectContaining({ name: 'Synthetic Chat Settings', kind: 'chat', settings: expect.objectContaining({ tokenizer: 17 }) }),
      expect.objectContaining({ name: 'Synthetic Chat Settings', kind: 'chat' }),
    ]);
    expect(repositories.importArtifacts.list()).toEqual([
      expect.objectContaining({ entityId: first.committed.json().entityId, sourceName: 'first-rename.bin' }),
      expect.objectContaining({ entityId: second.committed.json().entityId, sourceName: 'second-rename.bin' }),
    ]);
  });

  it('rolls back both the typed Preset and ImportArtifact when the outer asset move fails', async () => {
    const { app, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Preset move failure'); },
    });
    const { committed } = await inspectAndCommit(app, 'context/synthetic-context.json');

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('keeps an explicit import-handler override instead of appending the default Preset handler', async () => {
    const override: ImportHandler = {
      id: 'test-preset-override',
      matches: (preview) => preview.detected.kind === 'preset',
      async inspect() {
        return { normalizedPreview: { override: true }, warnings: [], blockingErrors: [] };
      },
      commit() {
        return {};
      },
    };
    const { app, repositories } = await context({ importHandlers: [override] });
    const { inspected, committed } = await inspectAndCommit(app, 'text/synthetic-text.json');

    expect(inspected.json().normalizedPreview).toEqual({ override: true });
    expect(committed.statusCode).toBe(201);
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toHaveLength(1);
  });

  it('exports JSON through a real listener with safe ASCII and RFC 5987 Unicode filenames, plus 400 and 404 boundaries', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app, 'context/synthetic-context.json');
    const id = committed.json().entityId as string;
    expect(repositories.presets.update(id, 0, {
      name: '雪姬\r\nX-Injected: yes',
      settings: { ...repositories.presets.get(id)!.settings, story_string: 'Edited story.' },
    })).toMatchObject({ ok: true });

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/presets/${id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="___X-Injected_yes.json"; filename*=UTF-8\'\'%E9%9B%AA%E5%A7%AC_X-Injected_yes.json',
    );
    expect(response.headers.get('x-injected')).toBeNull();
    expect(await response.json()).toMatchObject({ story_string: 'Edited story.', context_unknown: { retain: { empty: '' } } });

    expect((await app.inject({ method: 'GET', url: `/api/presets/${id}/export?format=png` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/presets/018f0000-0000-7000-8000-000000000999/export' })).statusCode).toBe(404);
  });
});
