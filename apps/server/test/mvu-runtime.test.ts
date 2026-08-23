import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import {
  capturedProvider,
  closePromptIntegrationContexts,
  createPromptIntegrationContext,
  integrationIds,
  requestGeneration,
  seedFullPromptGraph,
} from './prompt-integration-fixtures.js';

const ids = {
  book: '018f0000-0000-7000-8000-000000004101',
  entry: '018f0000-0000-7000-8000-000000004102',
  character: '018f0000-0000-7000-8000-000000004103',
  persona: '018f0000-0000-7000-8000-000000004104',
  conversation: '018f0000-0000-7000-8000-000000004105',
  untrustedConversation: '018f0000-0000-7000-8000-000000004106',
} as const;
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
const encoder = new TextEncoder();

function multipart(fileName: string, bytes: Uint8Array, mediaType: string) {
  const boundary = '----tavernnext-mvu-boundary';
  return {
    payload: Buffer.concat([
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      bytes,
      encoder.encode(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

afterEach(async () => {
  await closePromptIntegrationContexts();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-mvu-runtime-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  repositories.worldbooks.create({
    id: ids.book, name: 'Character book', description: '', enabled: true,
    scanDepth: 8, tokenBudget: 8_000, recursiveScanning: true, isGlobal: false,
  });
  repositories.worldbookEntries.create({
    id: ids.entry, worldbookId: ids.book, sourceUid: 1, sourceOrdinal: 0,
    keys: [], comment: '[InitVar] Synthetic state', content: `
世界:
  地点: 初始地点
主角:
  等级: 1
  背包: {}
`, enabled: false,
  });
  repositories.characters.create({
    id: ids.character, name: 'MVU Character', description: '', personality: '', scenario: '',
    firstMessage: `<gametxt>Main greeting</gametxt>
<UpdateVariable><JSONPatch>[
  { "op": "replace", "path": "/世界/地点", "value": "主问候" }
]</JSONPatch></UpdateVariable>
<StatusPlaceHolderImpl/>`,
    alternateGreetings: [`<gametxt>Alternate greeting</gametxt>
<UpdateVariable><JSONPatch>[
  { "op": "replace", "path": "/世界/地点", "value": "备用问候" },
  { "op": "replace", "path": "/主角/等级", "value": 3 }
]</JSONPatch></UpdateVariable>
<StatusPlaceHolderImpl/>`],
    tags: [], worldbookId: ids.book,
  });
  repositories.extensionAssets.create({
    id: crypto.randomUUID(), ownerKind: 'character', ownerId: ids.character,
    kind: 'tavern_helper', sourceKey: 'mvu', ordinal: 0, enabled: true,
    payload: {
      type: 'script', id: 'mvu', name: 'MVU beta', enabled: true,
      content: 'MagVarUpdate',
      button: { enabled: true, buttons: [] }, data: {},
    },
  });
  repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
  const app = createApp({
    database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

describe('MVU compatibility runtime', () => {
  it('initializes every greeting variant from disabled InitVar data and applies its own opening patch', async () => {
    const { app } = await context();
    const untrusted = await app.inject({
      method: 'POST', url: '/api/conversations',
      payload: {
        id: ids.untrustedConversation, characterId: ids.character, personaId: ids.persona,
        title: 'Untrusted MVU', maxPromptTokens: 4_096, maxResponseTokens: 512,
      },
    });
    expect(untrusted.statusCode).toBe(201);
    const untrustedDetail = (await app.inject({
      method: 'GET', url: `/api/conversations/${ids.untrustedConversation}/messages`,
    })).json();
    const untrustedVariant = untrustedDetail.messages[0].activeVariantId as string;
    expect((await app.inject({
      method: 'GET', url: `/api/runtime-states/message-variant/${untrustedVariant}`,
    })).json().value).toEqual({});
    expect((await app.inject({
      method: 'POST', url: `/api/extension-trust/character/${ids.character}/grant`,
    })).statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST', url: '/api/conversations',
      payload: {
        id: ids.conversation, characterId: ids.character, personaId: ids.persona,
        title: 'MVU greetings', maxPromptTokens: 4_096, maxResponseTokens: 512,
      },
    });
    expect(created.statusCode).toBe(201);
    const detail = (await app.inject({
      method: 'GET', url: `/api/conversations/${ids.conversation}/messages`,
    })).json();
    const variants = detail.messages[0].variants as Array<{ id: string }>;
    expect(variants).toHaveLength(2);

    const states = await Promise.all(variants.map(async (variant) => (
      (await app.inject({ method: 'GET', url: `/api/runtime-states/message-variant/${variant.id}` })).json().value
    )));
    expect(states).toEqual([
      expect.objectContaining({ stat_data: { 世界: { 地点: '主问候' }, 主角: { 等级: 1, 背包: {} } } }),
      expect.objectContaining({ stat_data: { 世界: { 地点: '备用问候' }, 主角: { 等级: 3, 背包: {} } } }),
    ]);
  });

  it('applies a completed reply update to the new active message variant', async () => {
    const provider = capturedProvider([
      { type: 'delta', text: `<gametxt>The road continues.</gametxt>
<UpdateVariable><JSONPatch>[
  { "op": "replace", "path": "/世界/地点", "value": "新地点" },
  { "op": "insert", "path": "/主角/背包/钥匙", "value": { "数量": 1 } }
]</JSONPatch></UpdateVariable>
<StatusPlaceHolderImpl/>` },
      { type: 'completed', finishReason: 'stop' },
    ]);
    const { app, repositories } = await createPromptIntegrationContext({ provider });
    seedFullPromptGraph(repositories, 'chat');
    const entry = repositories.worldbookEntries.get(integrationIds.characterEntry)!;
    expect(repositories.worldbookEntries.update(entry.id, entry.revision, {
      comment: '[InitVar] Generated state',
      content: `世界:\n  地点: 初始地点\n主角:\n  等级: 1\n  背包: {}`,
    })).toMatchObject({ ok: true });
    repositories.extensionAssets.create({
      id: crypto.randomUUID(), ownerKind: 'character', ownerId: integrationIds.character,
      kind: 'tavern_helper', sourceKey: 'mvu', ordinal: 0, enabled: true,
      payload: { type: 'script', id: 'mvu', name: 'MVU beta', enabled: true, content: 'MagVarUpdate', button: {}, data: {} },
    });
    expect((await app.inject({
      method: 'POST', url: `/api/extension-trust/character/${integrationIds.character}/grant`,
    })).statusCode).toBe(200);
    repositories.extensionAssets.create({
      id: crypto.randomUUID(), ownerKind: 'character', ownerId: integrationIds.character,
      kind: 'regex', sourceKey: 'hide-status', ordinal: 1, enabled: true,
      payload: {
        id: 'hide-status', scriptName: 'Hide status from AI', findRegex: '<StatusPlaceHolderImpl/>',
        replaceString: '', placement: [2], promptOnly: true,
      },
    });
    repositories.extensionAssets.create({
      id: crypto.randomUUID(), ownerKind: 'character', ownerId: integrationIds.character,
      kind: 'regex', sourceKey: 'hide-update', ordinal: 2, enabled: true,
      payload: {
        id: 'hide-update', scriptName: 'Hide update from AI',
        findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm',
        replaceString: '', placement: [2], promptOnly: true,
      },
    });

    const generated = await requestGeneration(app);
    expect(generated.statusCode).toBe(200);
    const detail = (await app.inject({
      method: 'GET', url: `/api/conversations/${integrationIds.conversation}/messages`,
    })).json();
    const assistant = [...detail.messages].reverse().find((message: { role: string }) => message.role === 'assistant');
    const state = (await app.inject({
      method: 'GET', url: `/api/runtime-states/message-variant/${assistant.activeVariantId as string}`,
    })).json();
    expect(state.value).toMatchObject({
      stat_data: {
        世界: { 地点: '新地点' },
        主角: { 等级: 1, 背包: { 钥匙: { 数量: 1 } } },
      },
    });
    const currentConversation = repositories.conversations.get(integrationIds.conversation)!;
    const nextPreview = await app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/prompt-preview`,
      payload: {
        conversationRevision: currentConversation.revision,
        mode: 'normal', userText: 'Continue after the state update',
      },
    });
    expect(nextPreview.statusCode).toBe(201);
    const modelHistory = JSON.stringify(nextPreview.json().messages);
    expect(modelHistory).not.toContain('StatusPlaceHolderImpl');
    expect(modelHistory).not.toContain('JSONPatch');
    expect(assistant.variants.find((variant: { id: string }) => variant.id === assistant.activeVariantId).content)
      .toContain('<StatusPlaceHolderImpl/>');

    const createdByFrontend = await app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/interactive-actions`,
      payload: {
        sourceVariantId: assistant.activeVariantId,
        method: 'createChatMessages',
        args: [[{ role: 'user', message: 'Custom-start selection' }]],
      },
    });
    expect(createdByFrontend.statusCode).toBe(200);
    const beforeTrigger = (await app.inject({
      method: 'GET', url: `/api/conversations/${integrationIds.conversation}/messages`,
    })).json();
    const createdUserId = beforeTrigger.messages.at(-1).id as string;
    const triggered = await app.inject({
      method: 'POST', url: `/api/conversations/${integrationIds.conversation}/interactive-actions`,
      payload: { sourceVariantId: assistant.activeVariantId, method: 'triggerSlash', args: ['/trigger'] },
    });
    expect(triggered.statusCode).toBe(200);
    expect(triggered.json().value).toContain('The road continues.');
    const afterAction = (await app.inject({
      method: 'GET', url: `/api/conversations/${integrationIds.conversation}/messages`,
    })).json();
    expect(afterAction.messages.slice(-2).map((message: { role: string; content: string }) => ({
      role: message.role, content: message.content,
    }))).toEqual([
      { role: 'user', content: 'Custom-start selection' },
      expect.objectContaining({ role: 'assistant' }),
    ]);
    expect(afterAction.messages.at(-2).id).toBe(createdUserId);
    expect(afterAction.conversation.revision).toBe(2);
  });

  const acceptanceCard = join(import.meta.dirname, '..', '..', '..', 'example-role-card', 'v4.2.1.png');
  it.runIf(existsSync(acceptanceCard))(
    'imports, reviews, grants, and initializes the real v4.2.1 acceptance card from its InitVar entry',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tavernnext-real-mvu-'));
      directories.push(directory);
      const database = createDatabase(join(directory, 'test.sqlite'));
      migrateDatabase(database);
      const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
      repositories.personas.create({ id: ids.persona, name: 'Traveler', description: '', isDefault: true });
      const app = createApp({
        database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
        extensionRemoteFetcher: async () => ({
          bytes: encoder.encode('export {};'), mediaType: 'text/javascript',
        }),
        config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
      });
      apps.push(app);
      await app.ready();
      const inspected = await app.inject({
        method: 'POST', url: '/api/imports/inspect',
        ...multipart('v4.2.1.png', await readFile(acceptanceCard), 'image/png'),
      });
      expect(inspected.statusCode).toBe(200);
      const committed = await app.inject({
        method: 'POST', url: '/api/imports/commit',
        payload: { inspectionToken: inspected.json().inspectionToken },
      });
      expect(committed.statusCode).toBe(201);
      const characterId = committed.json().entityId as string;
      const review = await app.inject({ method: 'GET', url: `/api/extension-trust/character/${characterId}` });
      expect(review.statusCode).toBe(200);
      expect(review.json()).toMatchObject({ trusted: false, scripts: expect.arrayContaining([
        expect.objectContaining({ name: '【命定之诗】MVU beta', enabled: true }),
      ]) });
      const refreshed = await app.inject({ method: 'POST', url: `/api/extension-trust/character/${characterId}/refresh` });
      expect(refreshed.statusCode).toBe(200);
      const granted = await app.inject({ method: 'POST', url: `/api/extension-trust/character/${characterId}/grant` });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().trusted).toBe(true);

      const created = await app.inject({
        method: 'POST', url: '/api/conversations',
        payload: {
          id: ids.conversation, characterId, personaId: ids.persona,
          title: 'Real MVU acceptance', maxPromptTokens: 8_192, maxResponseTokens: 512,
        },
      });
      expect(created.statusCode).toBe(201);
      const detail = (await app.inject({
        method: 'GET', url: `/api/conversations/${ids.conversation}/messages`,
      })).json();
      const variantId = detail.messages[0].activeVariantId as string;
      const state = (await app.inject({
        method: 'GET', url: `/api/runtime-states/message-variant/${variantId}`,
      })).json();
      expect(state.value).toMatchObject({
        initialized_lorebooks: expect.any(Object), schema: {},
        stat_data: {
          事件: { 开启: false, 结束: false, 阶段: '' },
          世界: { 时间: '', 地点: '' },
          主角: { 等级: 1, 背包: {} },
        },
      });
      const alternateId = detail.messages[0].variants[2].id as string;
      const alternateState = (await app.inject({
        method: 'GET', url: `/api/runtime-states/message-variant/${alternateId}`,
      })).json();
      expect(alternateState.value.stat_data.世界.地点).not.toBe('');
      expect(alternateState.value.stat_data.世界.地点).not.toBe(state.value.stat_data.世界.地点);
      const switched = await app.inject({
        method: 'PUT', url: `/api/messages/${detail.messages[0].id as string}/active-variant`,
        payload: { revision: detail.messages[0].revision, variantId: alternateId },
      });
      expect(switched.statusCode).toBe(200);
      const reopenedState = (await app.inject({
        method: 'GET', url: `/api/messages/${detail.messages[0].id as string}/runtime-state`,
      })).json();
      expect(reopenedState.value).toEqual(alternateState.value);
    },
    30_000,
  );
});
