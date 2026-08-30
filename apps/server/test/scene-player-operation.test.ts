import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENE_ACTION_ENVELOPE_PROTOCOL } from '@tavernnext/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { SCENE_LAB_SCENE_ID, TAIXU_CHRONICLES_SCENE_ID } from '../src/scenes/official-package.js';
import type { SaveAgentRuntime } from '../src/services/save-agent-runtime.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTaixuSave(activeGeneration: boolean | (() => boolean) = false) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-player-operation-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  const activeRuntime: SaveAgentRuntime = {
    start: async () => ({ ok: false, reason: 'generation_active' }),
    triggerLastUser: async () => ({ ok: false, reason: 'generation_active' }),
    cancel: () => false,
    isConversationActive: typeof activeGeneration === 'function' ? activeGeneration : () => activeGeneration,
  };
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    ...(activeGeneration ? { saveAgentRuntime: activeRuntime } : {}),
  });
  apps.push(app);
  await app.ready();
  await app.inject({ method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/install` });
  const created = await app.inject({
    method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/conversations`,
    payload: {
      title: '同路问山', playerProfile: { name: '沈照微', description: '同行剑修' },
      setup: {
        opening: 'ruined-temple', loreDetail: 'concise', relationshipMode: 'adventure-focus',
        redThread: 'none', contentMode: 'general', theme: 'xuanqing',
      },
    },
  });
  return { app, conversationId: created.json().id as string };
}

describe('Scene Workspace player operations', () => {
  it('records only accepted actions as immutable Save timeline events without starting an Agent Run', async () => {
    const { app, conversationId } = await createTaixuSave();
    const operation = {
      kind: 'chapter-event',
      title: '问山路',
      summary: '玩家确认踏上前往太虚仙宗的问山路。',
    };

    const accepted = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'journey-to-sect' },
        operation,
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      operation,
      state: { value: { 第一章: { 当前事件: 'water-root-test' } } },
    });
    const timeline = await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/messages`,
    });
    expect(timeline.json().messages).toHaveLength(2);
    expect(timeline.json().messages[1]).toMatchObject({
      role: 'system',
      content: operation.summary,
      playerOperation: operation,
    });
    const runs = await app.inject({
      method: 'GET', url: `/api/development/agent-runs?conversationId=${conversationId}`,
    });
    expect(runs.json()).toEqual([]);

    const rejected = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'first-clue' },
        operation: { kind: 'chapter-event', title: '拾取线索', summary: '玩家确认拾取石中线索。' },
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).not.toHaveProperty('operation');
    const unchangedTimeline = await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/messages`,
    });
    expect(unchangedTimeline.json().messages).toHaveLength(2);
  }, 30_000);

  it('rejects editing or deleting a committed player operation', async () => {
    const { app, conversationId } = await createTaixuSave();
    const accepted = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'journey-to-sect' },
        operation: {
          kind: 'chapter-event', title: '问山路', summary: '玩家确认踏上前往太虚仙宗的问山路。',
        },
      },
    });
    const messageId = accepted.json().operation.messageId as string;
    const timeline = await app.inject({
      method: 'GET', url: `/api/conversations/${conversationId}/messages`,
    });
    const message = timeline.json().messages.find((candidate: { id: string }) => candidate.id === messageId);

    const edited = await app.inject({
      method: 'PATCH', url: `/api/messages/${messageId}`,
      payload: { revision: message.revision, patch: { content: '伪造后的操作' } },
    });
    expect(edited.statusCode).toBe(409);
    expect(edited.json()).toEqual({ error: 'player_operation_immutable' });

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/messages/${messageId}?revision=${message.revision}`,
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json()).toEqual({ error: 'player_operation_immutable' });
  }, 30_000);

  it('rejects a player operation while the Save Agent is running', async () => {
    const { app, conversationId } = await createTaixuSave(true);
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'journey-to-sect' },
        operation: { kind: 'chapter-event', title: '问山路', summary: '玩家确认踏上问山路。' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'generation_active' });
    const timeline = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(timeline.json().messages).toHaveLength(1);
  }, 30_000);

  it('rechecks Agent activity after the Scene worker returns and rolls back the action', async () => {
    let checks = 0;
    const { app, conversationId } = await createTaixuSave(() => checks++ > 0);
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'journey-to-sect' },
        operation: { kind: 'chapter-event', title: '问山路', summary: '玩家确认踏上问山路。' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'generation_active' });
    const timeline = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(timeline.json().messages).toHaveLength(1);
    const state = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/scene-state` });
    expect(state.json().value.第一章.当前事件).toBe('journey-to-sect');
  }, 30_000);

  it('anchors an accepted operation without a state patch to the active Save branch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-player-operation-anchor-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();
    await app.inject({ method: 'POST', url: `/api/scenes/${SCENE_LAB_SCENE_ID}/install` });
    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${SCENE_LAB_SCENE_ID}/conversations`,
      payload: {
        title: '信号观测', playerProfile: { name: '观察者', description: '' },
        setup: { experimentName: '信号观测' },
      },
    });
    const conversationId = created.json().id as string;

    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'acknowledge' },
        operation: { kind: 'observation', title: '确认观察', summary: '玩家确认记录这次观察。' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: { kind: 'observation', title: '确认观察' },
      state: { revision: 1, value: { experimentName: '信号观测', phase: 'ready', signal: 0 } },
    });
  }, 30_000);

  it('preserves legacy action objects that contain action or operation fields', async () => {
    const { app, conversationId } = await createTaixuSave();
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        type: 'chapter-event', eventId: 'journey-to-sect',
        action: 'legacy-action-field', operation: 'legacy-operation-field',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: { ok: true, eventId: 'journey-to-sect' },
      state: { value: { 第一章: { 当前事件: 'water-root-test' } } },
    });
  }, 30_000);

  it('rolls back the operation message when an accepted Scene patch is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-player-operation-rollback-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();
    await app.inject({ method: 'POST', url: `/api/scenes/${SCENE_LAB_SCENE_ID}/install` });
    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${SCENE_LAB_SCENE_ID}/conversations`,
      payload: {
        title: '回滚实验', playerProfile: { name: '观察者', description: '' },
        setup: { experimentName: '回滚实验' },
      },
    });
    const conversationId = created.json().id as string;
    const initial = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/scene-state` });
    const removedPhase = await app.inject({
      method: 'PATCH', url: `/api/conversations/${conversationId}/scene-state`,
      payload: { revision: initial.json().revision, patch: [{ op: 'remove', path: '/phase' }] },
    });
    expect(removedPhase.statusCode).toBe(200);

    const failed = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'reset' },
        operation: { kind: 'reset', title: '重置实验', summary: '玩家确认重置实验。' },
      },
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toEqual({ error: 'scene_patch_invalid' });
    const timeline = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(timeline.json().messages).toHaveLength(1);
    const finalState = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/scene-state` });
    expect(finalState.json()).toMatchObject({ revision: removedPhase.json().state.revision, value: { signal: 0 } });
    expect(finalState.json().value).not.toHaveProperty('phase');
  }, 30_000);

  it('rejects out-of-contract operation metadata before changing the Save', async () => {
    const { app, conversationId } = await createTaixuSave();
    const response = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/scene-actions`,
      payload: {
        $tavernnext: SCENE_ACTION_ENVELOPE_PROTOCOL,
        action: { type: 'chapter-event', eventId: 'journey-to-sect' },
        operation: { kind: 'INVALID KIND', title: '问山路', summary: 'x'.repeat(501) },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request' });
    const timeline = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` });
    expect(timeline.json().messages).toHaveLength(1);
    const state = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/scene-state` });
    expect(state.json().value.第一章.当前事件).toBe('journey-to-sect');
  }, 30_000);
});
