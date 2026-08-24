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

describe('schema 17 Scene migration', () => {
  it('preserves Persona and Provider while clearing the legacy asset workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-scene-migration-'));
    directories.push(directory);
    const database = createDatabase(join(directory, 'tavernnext.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, { snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    const persona = repositories.personas.create({ id: randomUUID(), name: 'Traveler', description: 'Kept', isDefault: true });
    const provider = repositories.providerProfiles.create({ id: randomUUID(), name: 'Local', baseUrl: 'http://127.0.0.1:1234', model: 'model' });
    const worldbook = repositories.worldbooks.create({ id: randomUUID(), name: 'Legacy lore', description: '', enabled: true });
    const character = repositories.characters.create({ id: randomUUID(), name: 'Legacy card', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [], worldbookId: worldbook.id });
    repositories.presets.create({ id: randomUUID(), name: 'Legacy preset', kind: 'chat', settings: {} });
    repositories.conversations.create({ id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Legacy chat' });
    database.sqlite.exec('DELETE FROM tavernnext_schema_version; INSERT INTO tavernnext_schema_version(version) VALUES (16)');

    migrateDatabase(database);

    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    expect(repositories.personas.get(persona.id)?.name).toBe('Traveler');
    expect(repositories.providerProfiles.get(provider.id)?.name).toBe('Local');
    expect(repositories.characters.list()).toEqual([]);
    expect(repositories.worldbooks.list()).toEqual([]);
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.conversations.list()).toEqual([]);
    database.close();
  });

  it('upgrades the installed official v1 frontend without changing its saves or backing resources', async () => {
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
      slug: 'destined-poem', version: '1.0.1', archiveDigest: oldDigest,
      installPath: oldPath, installedAt: now,
      manifest: {
        id: DESTINED_POEM_SCENE_ID, slug: 'destined-poem', version: '1.0.1',
        name: '命定之诗与黄昏之歌', summary: '', description: '', author: 'The Poem of Destiny',
        minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 1,
        frontendEntry: 'frontend/index.html', setupSchema: {}, stateSchema: {},
        files: ['frontend/index.html'],
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
      id: randomUUID(), conversationId: conversation.id, schemaVersion: 1, value: { points: 7 },
    });

    upgradeInstalledOfficialSceneRuntime(database, directory);

    const upgraded = repositories.installedScenes.get(DESTINED_POEM_SCENE_ID)!;
    expect(upgraded.manifest.sceneSdkVersion).toBe(2);
    expect(upgraded.manifest.frontendEntry).toBe('frontend/app.js');
    expect(upgraded.archiveDigest).not.toBe(oldDigest);
    expect(upgraded.backingCharacterId).toBe(character.id);
    expect(repositories.conversations.get(conversation.id)?.title).toBe('Kept Save');
    expect(repositories.conversationSceneStates.getByConversationId(conversation.id)?.value).toEqual({ points: 7 });
    database.close();
  }, 30_000);
});
