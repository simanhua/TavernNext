import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeStChatJsonl } from '@tavernnext/st-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const encoder = new TextEncoder();
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const ids = {
  character: '018f2000-0000-7000-8000-000000000101',
  persona: '018f2000-0000-7000-8000-000000000102',
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function multipart(fileName: string, bytes: Uint8Array) {
  const boundary = '----tavernnext-chat-import-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/x-ndjson\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-chat-import-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
  repositories.characters.create({
    id: ids.character, name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '',
    alternateGreetings: [], tags: [],
  });
  repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
  const app = createApp({
    database,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
  });
  apps.push(app);
  await app.ready();
  return { app, database, repositories };
}

describe('ST chat import/export API', () => {
  it('inspects without mutation, atomically commits one Conversation with ordered variants, and exports it', async () => {
    const { app, repositories } = await context();
    const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'chats', 'swipes.jsonl'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('swipes.jsonl', bytes) });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json()).toMatchObject({
      detected: { container: 'jsonl', kind: 'chat' },
      normalizedPreview: { header: { characterName: 'Aster' }, messages: [{ role: 'user' }, { role: 'assistant' }] },
      inspectionToken: expect.any(String),
    });
    expect(repositories.conversations.list()).toEqual([]);

    const committed = await app.inject({
      method: 'POST',
      url: '/api/chats/imports/commit',
      payload: {
        inspectionToken: inspect.json().inspectionToken,
        characterId: ids.character,
        personaId: ids.persona,
        title: 'Imported archive',
      },
    });
    expect(committed.statusCode).toBe(201);
    const conversationId = committed.json().entityId as string;
    const messages = repositories.messages.listByConversationId(conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const variants = repositories.messageVariants.listByMessageId(messages[1]!.id);
    expect(variants.map((variant) => ({ ordinal: variant.ordinal, content: variant.content }))).toEqual([
      { ordinal: 0, content: 'The first door opens.' },
      { ordinal: 1, content: 'The second door opens.' },
      { ordinal: 2, content: 'The third door opens.' },
    ]);
    expect(messages[1]!.activeVariantId).toBe(variants[1]!.id);

    const exported = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl` });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    expect(exported.headers['content-disposition']).toContain("filename*=UTF-8''Imported%20archive.jsonl");
    const roundTrip = decodeStChatJsonl(exported.rawPayload);
    expect(roundTrip.messages[1]).toMatchObject({
      activeVariantIndex: 1,
      variants: [
        { content: 'The first door opens.', reasoning: 'first thought' },
        { content: 'The second door opens.', reasoning: 'second thought' },
        { content: 'The third door opens.', reasoning: 'third thought' },
      ],
    });

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${messages[0]!.id}`,
      payload: { revision: messages[0]!.revision, content: 'Which door should I choose?' },
    });
    expect(edited.statusCode).toBe(200);
    const editedExport = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl` });
    const editedRoundTrip = decodeStChatJsonl(editedExport.rawPayload);
    expect(editedRoundTrip.messages[0]).toMatchObject({
      content: 'Which door should I choose?',
      variants: [expect.objectContaining({ content: 'Which door should I choose?' })],
    });

    const editedAssistant = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${messages[1]!.id}`,
      payload: { revision: messages[1]!.revision, content: 'The edited second door opens.' },
    });
    expect(editedAssistant.statusCode).toBe(200);
    expect(repositories.messageVariants.listByMessageId(messages[1]!.id).map(({ content }) => content)).toEqual([
      'The first door opens.',
      'The edited second door opens.',
      'The third door opens.',
    ]);
    const assistantExport = decodeStChatJsonl((await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl`,
    })).rawPayload);
    expect(assistantExport.messages[1]).toMatchObject({
      content: 'The edited second door opens.',
      activeVariantIndex: 1,
    });
  });

  it('keeps compatibility envelopes server-side while losslessly re-exporting unknown fields', async () => {
    const { app } = await context();
    const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'chats', 'unknown-extra.jsonl'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('unknown-extra.jsonl', bytes) });
    const committed = await app.inject({
      method: 'POST', url: '/api/chats/imports/commit',
      payload: { inspectionToken: inspect.json().inspectionToken, characterId: ids.character, personaId: ids.persona, title: 'Unknowns' },
    });
    const conversationId = committed.json().entityId as string;

    const detail = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(detail.statusCode).toBe(200);
    expect(detail.payload).not.toContain('future_header');
    expect(detail.payload).not.toContain('future_swipe_info');
    expect(detail.payload).not.toContain('api_key');
    const list = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(list.payload).not.toContain('future_header');
    expect(list.payload).not.toContain('api_key');
    const exported = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl` });
    expect(exported.payload).toContain('future_header');
    expect(exported.payload).toContain('future_swipe_info');
    expect(exported.payload).toContain('future_variant');
  });

  it('round-trips explicit user swipes but rejects switching non-assistant variants', async () => {
    const { app, repositories } = await context();
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      JSON.stringify({
        name: 'Traveler', is_user: true, is_system: false, mes: 'Question B',
        swipes: ['Question A', 'Question B'], swipe_id: 1, swipe_info: [{}, {}], extra: {},
      }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'Answer', extra: {} }),
    ].join('\n'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('user-swipes.jsonl', bytes) });
    expect(inspect.statusCode).toBe(200);
    const committed = await app.inject({
      method: 'POST', url: '/api/chats/imports/commit',
      payload: { inspectionToken: inspect.json().inspectionToken, characterId: ids.character, personaId: ids.persona, title: 'User swipes' },
    });
    expect(committed.statusCode).toBe(201);
    const conversationId = committed.json().entityId as string;
    const userMessage = repositories.messages.listByConversationId(conversationId)[0]!;
    const variants = repositories.messageVariants.listByMessageId(userMessage.id);
    expect(userMessage).toMatchObject({ role: 'user', content: 'Question B', activeVariantId: variants[1]!.id });

    const before = decodeStChatJsonl((await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl`,
    })).rawPayload);
    expect(before.messages[0]).toMatchObject({
      content: 'Question B', activeVariantIndex: 1,
      variants: [{ content: 'Question A' }, { content: 'Question B' }],
    });

    const switched = await app.inject({
      method: 'PUT',
      url: `/api/messages/${userMessage.id}/active-variant`,
      payload: { revision: userMessage.revision, variantId: variants[0]!.id },
    });
    expect(switched.statusCode).toBe(400);
    expect(switched.json()).toEqual({ error: 'variant_role_unsupported' });
    expect(repositories.messages.get(userMessage.id)).toMatchObject({ activeVariantId: variants[1]!.id, content: 'Question B' });
  });

  it('commits and re-exports native null and negative compatibility metadata without a 500', async () => {
    const { app } = await context();
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      JSON.stringify({
        name: 'Aster', is_user: false, is_system: false, mes: 'Metadata',
        extra: { token_count: -1, reasoning_duration: null, future: 'kept' },
      }),
      JSON.stringify({
        name: 'Aster', is_user: false, is_system: false, mes: 'Negative duration',
        extra: { reasoning_duration: -2, future: 'also-kept' },
      }),
    ].join('\n'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('metadata.jsonl', bytes) });
    expect(inspect.statusCode).toBe(200);
    const committed = await app.inject({
      method: 'POST', url: '/api/chats/imports/commit',
      payload: { inspectionToken: inspect.json().inspectionToken, characterId: ids.character, personaId: ids.persona, title: 'Metadata' },
    });
    expect(committed.statusCode).toBe(201);
    const exported = (await app.inject({
      method: 'GET', url: `/api/conversations/${committed.json().entityId}/export?format=st-jsonl`,
    })).payload.trim().split('\n').map((line) => JSON.parse(line));
    expect(exported[1].extra).toEqual({ token_count: -1, reasoning_duration: null, future: 'kept' });
    expect(exported[2].extra).toEqual({ reasoning_duration: -2, future: 'also-kept' });
  });

  it('preserves JSONL message order when imported rows share the same persisted timestamp', async () => {
    const { app, database, repositories } = await context();
    database.sqlite.exec(`
      CREATE TRIGGER tie_imported_message_times AFTER INSERT ON messages
      BEGIN UPDATE messages SET created_at = '2026-08-08T00:00:00.000Z' WHERE id = NEW.id; END;
      CREATE TRIGGER keep_imported_message_times_tied AFTER UPDATE ON messages
      BEGIN UPDATE messages SET created_at = '2026-08-08T00:00:00.000Z' WHERE id = NEW.id; END;
    `);
    const expected = Array.from({ length: 12 }, (_, index) => `line-${String(index).padStart(2, '0')}`);
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      ...expected.map((content, index) => JSON.stringify({
        name: index % 2 === 0 ? 'Traveler' : 'Aster',
        is_user: index % 2 === 0,
        is_system: false,
        mes: content,
        extra: {},
      })),
    ].join('\n'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('tied-order.jsonl', bytes) });
    expect(inspect.statusCode).toBe(200);
    const committed = await app.inject({
      method: 'POST', url: '/api/chats/imports/commit',
      payload: { inspectionToken: inspect.json().inspectionToken, characterId: ids.character, personaId: ids.persona, title: 'Tied order' },
    });
    expect(committed.statusCode).toBe(201);
    const conversationId = committed.json().entityId as string;
    expect(repositories.messages.listByConversationId(conversationId).map(({ content }) => content)).toEqual(expected);

    const exported = decodeStChatJsonl((await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/export?format=st-jsonl`,
    })).rawPayload);
    expect(exported.messages.map(({ content }) => content)).toEqual(expected);
  });

  it('rejects mixed/group chat during inspect and creates no partial entities', async () => {
    const { app, repositories } = await context();
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'Traveler', character_name: 'Aster', chat_metadata: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, mes: 'A', extra: {} }),
      JSON.stringify({ name: 'Borin', is_user: false, mes: 'B', extra: { gen_id: 2 } }),
    ].join('\n'));
    const response = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('group.jsonl', bytes) });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ blockingErrors: [expect.objectContaining({ code: 'chat_group_not_supported' })] });
    expect(response.json()).not.toHaveProperty('inspectionToken');
    expect(repositories.conversations.list()).toEqual([]);
    expect(repositories.messages.list()).toEqual([]);
    expect(repositories.messageVariants.list()).toEqual([]);
  });

  it('rolls back the Conversation and all child rows when commit fails after creation begins', async () => {
    const { app, database, repositories } = await context();
    const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'chats', 'basic.jsonl'));
    const inspect = await app.inject({ method: 'POST', url: '/api/imports/inspect', ...multipart('basic.jsonl', bytes) });
    database.sqlite.exec(`
      CREATE TRIGGER reject_imported_message BEFORE INSERT ON messages
      BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;
    `);
    const response = await app.inject({
      method: 'POST',
      url: '/api/chats/imports/commit',
      payload: {
        inspectionToken: inspect.json().inspectionToken,
        characterId: ids.character,
        personaId: ids.persona,
        title: 'Must roll back',
      },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.conversations.list()).toEqual([]);
    expect(repositories.messages.list()).toEqual([]);
    expect(repositories.messageVariants.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('uses RFC 5987 headers without CRLF/path injection', async () => {
    const { app, repositories } = await context();
    const conversation = repositories.conversations.create({
      id: '018f2000-0000-7000-8000-000000000190',
      characterId: ids.character,
      personaId: ids.persona,
      title: 'bad\r\n名字/..',
    });
    const response = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.id}/export?format=st-jsonl` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).not.toContain('\r');
    expect(response.headers['content-disposition']).not.toContain('\n');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''bad__%E5%90%8D%E5%AD%97_...jsonl");
  });
});
