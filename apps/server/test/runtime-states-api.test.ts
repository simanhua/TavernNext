import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import { MAX_RUNTIME_STATE_ENTRIES } from '../src/runtime-state-validation.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-runtime-state-api-'));
  directories.push(directory);
  const path = join(directory, 'test.sqlite');
  const database = createDatabase(path);
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const character = repositories.characters.create({
    id: '018f0000-0000-7000-8000-000000002301', name: 'State Character',
    description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
  });
  const persona = repositories.personas.create({
    id: '018f0000-0000-7000-8000-000000002302', name: 'State Persona', description: '', isDefault: true,
  });
  const preset = repositories.presets.create({
    id: '018f0000-0000-7000-8000-000000002303', name: 'State Preset', kind: 'chat',
    settings: { prompts: [], prompt_order: [] },
  });
  repositories.extensionAssets.create({
    id: '018f0000-0000-7000-8000-000000002308', ownerKind: 'character', ownerId: character.id,
    kind: 'tavern_helper', sourceKey: 'script-one', ordinal: 0, enabled: true,
    payload: { id: 'script-one', type: 'script', name: 'Script one', enabled: true, content: '' },
  });
  const conversation = repositories.conversations.create({
    id: '018f0000-0000-7000-8000-000000002304', characterId: character.id, personaId: persona.id,
    title: 'State Conversation',
  });
  const message = repositories.messages.create({
    id: '018f0000-0000-7000-8000-000000002305', conversationId: conversation.id,
    role: 'assistant', content: '', activeVariantId: null,
  });
  const firstVariant = repositories.messageVariants.create({
    id: '018f0000-0000-7000-8000-000000002306', messageId: message.id,
    content: 'First', status: 'completed', ordinal: 0,
  });
  const secondVariant = repositories.messageVariants.create({
    id: '018f0000-0000-7000-8000-000000002307', messageId: message.id,
    content: 'Second', status: 'completed', ordinal: 1,
  });
  expect(repositories.messages.update(message.id, message.revision, { activeVariantId: firstVariant.id })).toMatchObject({ ok: true });
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: path },
  });
  apps.push(app);
  await app.ready();
  return { app, character, preset, conversation, message: repositories.messages.get(message.id)!, firstVariant, secondVariant };
}

async function operate(app: ReturnType<typeof createApp>, scope: string, scopeId: string, body: unknown) {
  return await app.inject({
    method: 'POST', url: `/api/runtime-states/${scope}/${encodeURIComponent(scopeId)}`,
    payload: body as Record<string, unknown>,
  });
}

describe('six-scope Runtime State API', () => {
  it('supports versioned replace, merge, insert, and delete for all six scopes', async () => {
    const { app, character, preset, conversation, firstVariant } = await context();
    const scopes = [
      ['global', 'global'],
      ['character', character.id],
      ['preset', preset.id],
      ['conversation', conversation.id],
      ['message-variant', firstVariant.id],
      ['script', `character:${character.id}:script-one`],
    ] as const;
    for (const [scope, scopeId] of scopes) {
      const empty = await app.inject({ method: 'GET', url: `/api/runtime-states/${scope}/${encodeURIComponent(scopeId)}` });
      expect(empty.statusCode, scope).toBe(200);
      expect(empty.json(), scope).toEqual({ scope, scopeId, revision: null, value: {} });
      expect((await operate(app, scope, scopeId, {
        expectedRevision: null, operation: 'replace', value: { nested: { first: 1 }, keep: 1 },
      })).json(), scope).toMatchObject({ revision: 0, value: { nested: { first: 1 }, keep: 1 } });
      expect((await operate(app, scope, scopeId, {
        expectedRevision: 0, operation: 'merge', value: { nested: { second: 2 } },
      })).json(), scope).toMatchObject({ revision: 1, value: { nested: { first: 1, second: 2 }, keep: 1 } });
      expect((await operate(app, scope, scopeId, {
        expectedRevision: 1, operation: 'insert', value: { keep: 99, added: 3 },
      })).json(), scope).toMatchObject({ revision: 2, value: { keep: 1, added: 3 } });
      expect((await operate(app, scope, scopeId, {
        expectedRevision: 2, operation: 'delete', keys: ['keep'],
      })).json(), scope).toMatchObject({ revision: 3, value: { added: 3 } });
    }
    expect((await app.inject({ method: 'GET', url: '/api/runtime-states/not-a-scope/value' })).json())
      .toEqual({ error: 'invalid_scope' });
  });

  it('resolves message variables through the active variant without contaminating sibling state', async () => {
    const { app, message, firstVariant, secondVariant } = await context();
    await operate(app, 'message-variant', firstVariant.id, {
      expectedRevision: null, operation: 'replace', value: { swipe: 'first' },
    });
    await operate(app, 'message-variant', secondVariant.id, {
      expectedRevision: null, operation: 'replace', value: { swipe: 'second' },
    });
    let active = await app.inject({ method: 'GET', url: `/api/messages/${message.id}/runtime-state` });
    expect(active.json()).toMatchObject({ scopeId: firstVariant.id, value: { swipe: 'first' } });

    const switched = await app.inject({
      method: 'PUT', url: `/api/messages/${message.id}/active-variant`,
      payload: { revision: message.revision, variantId: secondVariant.id },
    });
    expect(switched.statusCode).toBe(200);
    active = await app.inject({ method: 'GET', url: `/api/messages/${message.id}/runtime-state` });
    expect(active.json()).toMatchObject({ scopeId: secondVariant.id, value: { swipe: 'second' } });
    expect((await app.inject({ method: 'GET', url: `/api/runtime-states/message-variant/${firstVariant.id}` })).json())
      .toMatchObject({ value: { swipe: 'first' } });
  });

  it('revalidates computed merge output against the recursive state limit', async () => {
    const { app } = await context();
    const half = Math.floor(MAX_RUNTIME_STATE_ENTRIES / 2) + 1;
    const first = Object.fromEntries(Array.from({ length: half }, (_, index) => [`first${index}`, index]));
    const second = Object.fromEntries(Array.from({ length: half }, (_, index) => [`second${index}`, index]));
    expect((await operate(app, 'global', 'global', {
      expectedRevision: null, operation: 'replace', value: first,
    })).statusCode).toBe(200);
    const rejected = await operate(app, 'global', 'global', {
      expectedRevision: 0, operation: 'merge', value: second,
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({ error: 'runtime_state_limit' });
    expect((await app.inject({ method: 'GET', url: '/api/runtime-states/global/global' })).json())
      .toMatchObject({ revision: 0, value: first });
  }, 30_000);
});
