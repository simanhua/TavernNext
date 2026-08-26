import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';
import { DESTINED_POEM_SCENE_ID } from '../src/scenes/official-package.js';
import { upgradeInstalledOfficialSceneRuntime } from '../src/scenes/official-scene-upgrade.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('Scene migrations', () => {
  it('resets schema 19 Saves while retaining the new Agent-owned tables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-agent-run-migration-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Character', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Preserved Save',
    });
    database.sqlite.exec(`
      DROP TABLE agent_runs;
      DELETE FROM tavernnext_schema_version;
      INSERT INTO tavernnext_schema_version(version) VALUES (19);
    `);

    migrateDatabase(database);

    expect(CURRENT_SCHEMA_VERSION).toBe(22);
    expect(repositories.conversations.get(conversation.id)).toBeUndefined();
    expect(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").get())
      .toEqual({ name: 'agent_runs' });
    database.close();
  });

  it('preserves reusable libraries and Provider while clearing schema 16 Saves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-migration-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const persona = repositories.personas.create({ id: randomUUID(), name: 'Traveler', description: 'Kept', isDefault: true });
    const provider = repositories.providerProfiles.create({ id: randomUUID(), name: 'Local', baseUrl: 'http://127.0.0.1:1234', model: 'model' });
    const worldbook = repositories.worldbooks.create({ id: randomUUID(), name: 'Legacy lore', description: '', enabled: true });
    const character = repositories.characters.create({ id: randomUUID(), name: 'Legacy card', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [], worldbookId: worldbook.id });
    const preset = repositories.presets.create({ id: randomUUID(), name: 'Legacy preset', kind: 'chat', settings: {} });
    repositories.conversations.create({ id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Legacy chat' });
    database.sqlite.exec('DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version(version) VALUES (16)');

    migrateDatabase(database);

    expect(CURRENT_SCHEMA_VERSION).toBe(22);
    expect(repositories.personas.get(persona.id)?.name).toBe('Traveler');
    expect(repositories.providerProfiles.get(provider.id)?.name).toBe('Local');
    expect(repositories.characters.get(character.id)?.name).toBe('Legacy card');
    expect(repositories.worldbooks.get(worldbook.id)?.name).toBe('Legacy lore');
    expect(repositories.presets.get(preset.id)?.name).toBe('Legacy preset');
    expect(repositories.conversations.list()).toEqual([]);
    database.close();
  });

  it('resets schema 20 assistant Variants instead of carrying legacy generation artifacts forward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-roleplay-document-migration-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Character', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Document migration',
    });
    const message = repositories.messages.create({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, ordinal: 0,
      content: 'First paragraph.\n\nSecond paragraph.', status: 'completed',
    });
    const oversizedContent = 'x'.repeat(256 * 1024);
    const oversizedVariant = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, ordinal: 1,
      content: oversizedContent, status: 'completed',
    });
    const raw = database.sqlite.prepare('SELECT payload FROM message_variants WHERE id = ?').get(variant.id) as {
      payload: string;
    };
    const legacy = JSON.parse(raw.payload) as Record<string, unknown>;
    delete legacy.document;
    database.sqlite.prepare('UPDATE message_variants SET payload = ? WHERE id = ?')
      .run(JSON.stringify(legacy), variant.id);
    const oversizedRaw = database.sqlite.prepare('SELECT payload FROM message_variants WHERE id = ?')
      .get(oversizedVariant.id) as { payload: string };
    const oversizedLegacy = JSON.parse(oversizedRaw.payload) as Record<string, unknown>;
    delete oversizedLegacy.document;
    database.sqlite.prepare('UPDATE message_variants SET payload = ? WHERE id = ?')
      .run(JSON.stringify(oversizedLegacy), oversizedVariant.id);
    database.sqlite.exec('DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version(version) VALUES (20)');

    migrateDatabase(database);

    expect(repositories.messageVariants.get(variant.id)).toBeUndefined();
    expect(repositories.messageVariants.get(oversizedVariant.id)).toBeUndefined();
    migrateDatabase(database);
    expect(repositories.messageVariants.listByConversationId(conversation.id)).toEqual([]);
    database.close();
  });

  it('upgrades the installed official 2.6 package without changing its saves or backing resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-runtime-upgrade-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const now = '2026-08-24T00:00:00.000Z';
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Scene Character', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Save Persona', description: '', isDefault: false, sceneInternal: true,
    });
    const oldPath = join(directory, 'scenes', DESTINED_POEM_SCENE_ID, 'v1-digest');
    await mkdir(join(oldPath, 'frontend'), { recursive: true });
    await writeFile(join(oldPath, 'frontend', 'index.html'), '<!doctype html>');
    const oldDigest = 'a'.repeat(64);
    const installed = {
      id: DESTINED_POEM_SCENE_ID, revision: 0, createdAt: now, updatedAt: now,
      slug: 'destined-poem', version: '2.5.0', archiveDigest: oldDigest,
      installPath: oldPath, installedAt: now,
      manifest: {
        id: DESTINED_POEM_SCENE_ID, slug: 'destined-poem', version: '2.5.0',
        name: '命定之诗与黄昏之歌', summary: '', description: '', author: 'The Poem of Destiny',
        minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 2,
        frontendEntry: 'frontend/index.html', frontendStyles: [], setupSchema: {}, stateSchema: {},
        agentTools: [], sceneViews: [], files: ['frontend/index.html'],
      },
      backingCharacterId: character.id,
    };
    database.sqlite.prepare(`
      INSERT INTO installed_scenes(id, revision, created_at, updated_at, payload, slug, version, archive_digest)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?)
    `).run(DESTINED_POEM_SCENE_ID, now, now, JSON.stringify(installed), installed.slug, installed.version, oldDigest);
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, sceneId: DESTINED_POEM_SCENE_ID,
      playerProfile: { name: 'Traveler', description: '' }, setup: { origin: '梵尼亚' }, title: 'Kept Save',
    });
    repositories.conversationSceneStates.create({
      id: randomUUID(), conversationId: conversation.id, schemaVersion: 1,
      value: { points: 7, 主角: { 背包: null } },
    });
    const transition = repositories.sceneStateTransitions.create({
      id: randomUUID(), conversationId: conversation.id, parentTransitionId: null,
      sourceKind: 'sdk-patch', sourceId: randomUUID(), operations: [],
      value: { points: 7, 主角: { 背包: null } },
    });

    upgradeInstalledOfficialSceneRuntime(database, directory);

    const upgraded = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    expect(upgraded.manifest.sceneSdkVersion).toBe(2);
    expect(upgraded.version).toBe('2.7.0');
    expect(upgraded.manifest.sceneViews).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'combat', schemaVersion: 1, renderer: { id: 'destined-poem-combat-v1' } }),
      ...['status', 'map', 'relationship', 'progress'].map((kind) => expect.objectContaining({ kind })),
    ]));
    expect(upgraded.manifest.frontendEntry).toBe('frontend/app.js');
    expect(upgraded.archiveDigest).not.toBe(oldDigest);
    expect(upgraded.backingCharacterId).toBe(character.id);
    expect(repositories.conversations.get(conversation.id)?.title).toBe('Kept Save');
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)?.value).toEqual({
      points: 7, 主角: { 装备: {}, 背包: {} },
    });
    expect(repositories.sceneStateTransitions.get(transition.id)?.value).toEqual({
      points: 7, 主角: { 装备: {}, 背包: {} },
    });
    database.close();
  }, 30_000);

  it('does not retain the schema 18 Scene state after the schema 19 Save reset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-state-kernel-migration-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Character', description: '', personality: '', scenario: '',
      firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Legacy Scene State',
    });
    const state = repositories.conversationSceneStates.create({
      id: randomUUID(), conversationId: conversation.id, schemaVersion: 1, value: { points: 7 },
    });
    const legacy = { ...state, baseValue: undefined, headTransitionId: undefined };
    delete legacy.baseValue;
    delete legacy.headTransitionId;
    database.sqlite.prepare('UPDATE conversation_scene_states SET payload = ? WHERE id = ?')
      .run(JSON.stringify(legacy), state.id);
    database.sqlite.exec('DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version(version) VALUES (17)');

    migrateDatabase(database);

    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)).toBeUndefined();
    expect(repositories.conversations.get(conversation.id)).toBeUndefined();
    expect(repositories.sceneStateTransitions.listByConversationId(conversation.id)).toEqual([]);
    database.close();
  });
});
