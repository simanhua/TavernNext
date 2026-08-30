import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TAIXU_CHRONICLES_SCENE_ID } from '../src/scenes/official-package.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Taixu Chronicles Scene Package', () => {
  it('installs the Scene Package and creates isolated Scene State and Save Worldbook selections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-taixu-chronicles-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const app = createApp({ database, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(app);
    await app.ready();

    expect((await app.inject({ method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/install` })).statusCode).toBe(201);
    const installed = repositories.installedScenes.get(TAIXU_CHRONICLES_SCENE_ID)!;
    const backingCharacter = repositories.characters.get(installed.backingCharacterId)!;
    expect(backingCharacter.name).toBe('楚霁寒（衍生）');
    expect(backingCharacter.alternateGreetings).toEqual([]);
    expect(repositories.extensionAssets.listByOwner('character', backingCharacter.id)).toEqual([]);
    const templateEntries = repositories.worldbookEntries.listByWorldbookId(backingCharacter.worldbookId!);
    expect(templateEntries.map((entry) => entry.comment)).not.toEqual(expect.arrayContaining([
      '修仙状态栏', '古风多人状态栏', '现代状态栏',
    ]));
    expect(repositories.presets.get(installed.backingPresetId!)?.name).toBe('太虚问道 Scene 生成配置');
    expect(repositories.presets.get(installed.backingPresetId!)?.settings.reasoning_effort).toBe('max');

    const created = await app.inject({
      method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/conversations`,
      payload: {
        title: '坊市红线', playerProfile: { name: '沈照微', description: '游历中州的剑修' },
        setup: {
          opening: 'market-red-thread', loreDetail: 'concise', relationshipMode: 'adventure-focus',
          redThread: 'fated', contentMode: 'general', theme: 'xuanzang',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id as string;
    const marketMessage = repositories.messages.listByConversationId(conversationId)[0]!;
    const marketVariant = repositories.messageVariants.get(marketMessage.activeVariantId!)!;
    const originalMarketOpening = (await readFile(new URL(
      '../assets/official-scenes/taixu-chronicles/content/openings/market-red-thread.md', import.meta.url,
    ), 'utf8')).trim();
    expect(marketVariant.content).toBe(originalMarketOpening);
    expect(marketVariant.content).not.toContain('<status_bar>');
    expect(marketVariant.content).not.toContain('【返回】');
    expect(repositories.conversationSceneStates.getByConversationId(conversationId)?.value).toMatchObject({
      世界: { 地点: '中州边境·青石坊市', 天气: '阴' },
      楚霁寒: { 年龄: 20, 公开身份: '水灵根散修' },
      太虚子: { 魂力: 72 },
      关系: { player: { 姓名: '沈照微', 红线: '姻缘红线' } },
      界面: { 主题: 'xuanzang' },
    });

    const invalidAdultGuard = await app.inject({
      method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/conversations`,
      payload: {
        title: '无效开局', playerProfile: { name: '试剑人', description: '' },
        setup: {
          opening: 'market-red-thread', loreDetail: 'concise', relationshipMode: 'adventure-focus',
          redThread: 'intimacy', contentMode: 'general', theme: 'xuanqing',
        },
      },
    });
    expect(invalidAdultGuard.statusCode).toBe(201);
    const guardedConversationId = invalidAdultGuard.json().id as string;
    expect(repositories.conversationSceneStates.getByConversationId(guardedConversationId)?.value).toMatchObject({
      关系: { player: { 红线: '姻缘红线' } },
    });

    const second = await app.inject({
      method: 'POST', url: `/api/scenes/${TAIXU_CHRONICLES_SCENE_ID}/conversations`,
      payload: {
        title: '云梦雨夜', playerProfile: { name: '陆无咎', description: '避雨的散修' },
        setup: {
          opening: 'ruined-temple', loreDetail: 'full', relationshipMode: 'original-multi-romance',
          redThread: 'intimacy', contentMode: 'mature', theme: 'danxia',
        },
      },
    });
    expect(second.statusCode).toBe(201);
    const secondConversationId = second.json().id as string;
    const ruinedTempleMessage = repositories.messages.listByConversationId(secondConversationId)[0]!;
    const ruinedTempleVariant = repositories.messageVariants.get(ruinedTempleMessage.activeVariantId!)!;
    const originalRuinedTempleOpening = (await readFile(new URL(
      '../assets/official-scenes/taixu-chronicles/content/openings/ruined-temple.md', import.meta.url,
    ), 'utf8')).trim();
    expect(ruinedTempleVariant.content).toBe(originalRuinedTempleOpening);
    expect(ruinedTempleVariant.content).not.toContain('<status_bar>');
    expect(ruinedTempleVariant.content).not.toContain('【返回】');
    expect(repositories.conversationSceneStates.getByConversationId(secondConversationId)?.value).toMatchObject({
      世界: { 地点: '江南·云梦泽外围荒庙', 天气: '大雨' },
      关系: { player: { 姓名: '陆无咎', 红线: '亲密红线规则已启用·尚未连接' } },
      界面: { 主题: 'danxia' },
    });

    const ownership = repositories.saveWorldbooks.getByConversationId(conversationId)!;
    const guardedOwnership = repositories.saveWorldbooks.getByConversationId(guardedConversationId)!;
    const secondOwnership = repositories.saveWorldbooks.getByConversationId(secondConversationId)!;
    expect(secondOwnership.worldbookId).not.toBe(ownership.worldbookId);
    const enabled = new Map(repositories.worldbookEntries.listByWorldbookId(ownership.worldbookId)
      .map((entry) => [entry.comment, entry.enabled]));
    const secondEnabled = new Map(repositories.worldbookEntries.listByWorldbookId(secondOwnership.worldbookId)
      .map((entry) => [entry.comment, entry.enabled]));
    const guardedEnabled = new Map(repositories.worldbookEntries.listByWorldbookId(guardedOwnership.worldbookId)
      .map((entry) => [entry.comment, entry.enabled]));
    expect(enabled.get('主线（跑主线再开）')).toBe(true);
    expect(enabled.get('第二个设定:姻缘红线')).toBe(true);
    expect(enabled.get('两百年后的char')).toBe(false);
    expect(enabled.get('古风多人状态栏')).toBeUndefined();
    expect(secondEnabled.get('九州地域图（详细版）')).toBe(true);
    expect(secondEnabled.get('九州地域图（简洁版）')).toBe(false);
    expect(secondEnabled.get('nsfw（用时开）')).toBe(true);
    expect(enabled.get('nsfw（用时开）')).toBe(false);
    expect(guardedEnabled.get('nsfw（用时开）')).toBe(false);
    expect(guardedEnabled.get('第一个设定:性爱红线')).toBe(false);
  }, 30_000);
});
