import { createHash } from 'node:crypto';
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

describe('Attached Extension trust API', () => {
  it('requires hashed refresh before grant and invalidates only executable changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-extension-trust-'));
    directories.push(directory);
    const path = join(directory, 'test.sqlite');
    const database = createDatabase(path);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000002401', name: 'Trust owner',
      description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const script = repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000002402', ownerKind: 'character', ownerId: character.id,
      kind: 'tavern_helper', sourceKey: 'trusted-script', ordinal: 0, enabled: true,
      payload: {
        id: 'trusted-script', type: 'script', name: 'Trusted script', enabled: true,
        content: "import 'https://cdn.example/entry.js';", info: 'notes', button: { label: 'Run' }, data: {},
      },
    });
    const nested = repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000002404', ownerKind: 'character', ownerId: character.id,
      kind: 'tavern_helper', sourceKey: 'nested-tree', ordinal: 1, enabled: true,
      payload: {
        id: 'nested-tree', type: 'folder', name: 'Nested tree', enabled: true,
        value: [{
          id: 'nested-script', type: 'script', name: 'Nested script', enabled: true,
          content: "import 'https://cdn.example/nested.js';", info: '', button: {}, data: {},
        }],
      },
    });
    repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000002403', ownerKind: 'character', ownerId: character.id,
      kind: 'regex', sourceKey: 'frontend', ordinal: 0, enabled: true,
      payload: {
        id: 'frontend', scriptName: 'Frontend', findRegex: '/x/',
        replaceString: "$('body').load('https://cdn.example/view.html'); $('body').load('https://cdn.example/plain.html')",
      },
    });
    const fetched: string[] = [];
    const bodies = new Map([
      ['https://cdn.example/entry.js', 'export const value = 1;'],
      ['https://cdn.example/nested.js', 'export const nested = 1;'],
      ['https://cdn.example/plain.html', 'not an html document'],
      ['https://cdn.example/view.html', '<!doctype html><html><body><p>view</p></body></html>'],
    ]);
    const app = createApp({
      database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: path },
      extensionRemoteFetcher: async (url) => {
        fetched.push(url);
        const body = bodies.get(url);
        if (body === undefined) throw new Error('missing');
        return { bytes: new TextEncoder().encode(body), mediaType: url.endsWith('.js') ? 'text/javascript' : 'text/plain' };
      },
    });
    apps.push(app); await app.ready();
    const base = `/api/extension-trust/character/${character.id}`;

    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({
      trusted: false, sameOriginRisk: true,
      scripts: [
        { sourceKey: 'trusted-script', order: [0] },
        { sourceKey: 'nested-script', order: [1, 0] },
      ],
      remotes: [
        { url: 'https://cdn.example/entry.js', fetched: false },
        { url: 'https://cdn.example/nested.js', fetched: false },
        { url: 'https://cdn.example/plain.html', fetched: false },
        { url: 'https://cdn.example/view.html', fetched: false },
      ],
    });
    expect(fetched).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${base}/manifest` })).json().scripts).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `${base}/grant` })).statusCode).toBe(409);

    expect((await app.inject({ method: 'POST', url: `${base}/refresh` })).statusCode).toBe(200);
    expect(fetched).toEqual([
      'https://cdn.example/entry.js',
      'https://cdn.example/nested.js',
      'https://cdn.example/plain.html',
      'https://cdn.example/view.html',
    ]);
    const granted = await app.inject({ method: 'POST', url: `${base}/grant` });
    expect(granted.json()).toMatchObject({ trusted: true, dynamicNetworkDisclaimer: expect.stringContaining('dynamically') });
    expect((await app.inject({ method: 'GET', url: `${base}/manifest` })).json().scripts).toHaveLength(2);

    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000002405', name: 'Frontend user', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000002406', characterId: character.id, personaId: persona.id, title: 'Frontend cache',
    });
    const message = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000002407', conversationId: conversation.id,
      role: 'assistant', content: 'status', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000002408', messageId: message.id,
      content: 'status', status: 'completed', finishReason: 'stop',
    });
    expect(repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id })).toMatchObject({ ok: true });
    const approvedHtml = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/interactive-resource?sourceVariantId=${variant.id}&url=${encodeURIComponent('https://cdn.example/view.html')}`,
    });
    expect(approvedHtml.statusCode).toBe(200);
    const approvedHtmlBody = '<!doctype html><html><body><p>view</p></body></html>';
    expect(approvedHtml.payload).toBe(approvedHtmlBody);
    expect(approvedHtml.headers['content-type']).toContain('text/html');
    expect(approvedHtml.headers['x-content-sha256']).toBe(createHash('sha256').update(approvedHtmlBody).digest('hex'));
    expect((await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/interactive-resource?sourceVariantId=${variant.id}&url=${encodeURIComponent('https://cdn.example/plain.html')}`,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/interactive-resource?sourceVariantId=${variant.id}&url=${encodeURIComponent('https://cdn.example/unapproved.html')}`,
    })).statusCode).toBe(403);

    bodies.delete('https://cdn.example/view.html');
    const failedRefresh = await app.inject({ method: 'POST', url: `${base}/refresh` });
    expect(failedRefresh.statusCode).toBe(502);
    const failedReview = failedRefresh.json().review;
    expect(failedReview).toMatchObject({
      trusted: false,
      auditEvents: expect.arrayContaining([expect.objectContaining({ event: 'remote_fetch_failed' })]),
    });
    expect(failedReview.remotes.find((remote: { url: string }) => remote.url.endsWith('view.html'))).toMatchObject({
      fetched: false,
      fetchStatus: 'failed',
    });
    expect((await app.inject({ method: 'POST', url: `${base}/grant` })).statusCode).toBe(409);
    bodies.set('https://cdn.example/view.html', approvedHtmlBody);
    expect((await app.inject({ method: 'POST', url: `${base}/refresh` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${base}/grant` })).statusCode).toBe(200);

    const nestedPayload = structuredClone(nested.payload as Record<string, unknown>);
    const nestedValue = (nestedPayload.value as Array<Record<string, unknown>>);
    nestedValue[0] = { ...nestedValue[0], content: "import 'https://cdn.example/nested.js'; console.log('changed');" };
    expect(repositories.extensionAssets.update(nested.id, nested.revision, { payload: nestedPayload })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({ trusted: false });
    const changedNested = repositories.extensionAssets.get(nested.id)!;
    expect(repositories.extensionAssets.update(changedNested.id, changedNested.revision, { payload: nested.payload })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({ trusted: false });
    expect((await app.inject({ method: 'POST', url: `${base}/grant` })).statusCode).toBe(200);

    const metadataOnly = {
      ...(script.payload as Record<string, unknown>),
      info: "documentation example: fetch('https://cdn.example/note-only.js')",
      button: { label: 'Changed' },
      data: { mutable: true },
    };
    expect(repositories.extensionAssets.update(script.id, script.revision, { payload: metadataOnly })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({
      trusted: true,
      remotes: [
        { url: 'https://cdn.example/entry.js' },
        { url: 'https://cdn.example/nested.js' },
        { url: 'https://cdn.example/plain.html' },
        { url: 'https://cdn.example/view.html' },
      ],
    });
    const afterMetadata = repositories.extensionAssets.get(script.id)!;
    expect(repositories.extensionAssets.update(afterMetadata.id, afterMetadata.revision, {
      payload: { ...metadataOnly, content: "import 'https://cdn.example/entry.js'; console.log('changed');" },
    })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({ trusted: false });
    expect((await app.inject({ method: 'GET', url: `${base}/manifest` })).json().scripts).toEqual([]);
    const afterExecutableChange = repositories.extensionAssets.get(script.id)!;
    expect(repositories.extensionAssets.update(afterExecutableChange.id, afterExecutableChange.revision, {
      payload: metadataOnly,
    })).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'GET', url: base })).json()).toMatchObject({ trusted: false });

    bodies.set('https://cdn.example/entry.js', 'export const value = 2;');
    expect((await app.inject({ method: 'POST', url: `${base}/refresh` })).statusCode).toBe(200);
    const refreshed = (await app.inject({ method: 'GET', url: base })).json();
    const entry = refreshed.remotes.find((remote: { url: string }) => remote.url.endsWith('entry.js'));
    expect(entry.sha256).toBe(createHash('sha256').update('export const value = 2;').digest('hex'));
    const cached = await app.inject({ method: 'GET', url: `${base}/cache/${entry.sha256}` });
    expect(cached.payload).toBe('export const value = 2;');
    expect((await app.inject({ method: 'DELETE', url: base })).json()).toMatchObject({ trusted: false });
    expect(repositories.extensionAuditEvents.listByOwner('character', character.id).map((event) => event.event))
      .toEqual([
        'remote_refresh', 'trust_granted', 'remote_fetch_failed', 'remote_refresh', 'trust_granted',
        'trust_invalidated', 'trust_granted', 'trust_invalidated', 'remote_refresh', 'trust_revoked',
      ]);
  });
});
