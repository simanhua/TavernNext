import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { SCENE_LAB_SCENE_ID, builtInPackage } from '../src/scenes/official-package.js';
import { TEST_REPOSITORY_OPTIONS } from './test-integrity-key.js';

describe('Save Worldbook migration', () => {
  it('copies a legacy Scene template, materializes overrides, and preserves the template', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tavernnext-save-worldbook-migration-'));
    const database = createDatabase(join(directory, 'test.sqlite'));
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const source = repositories.worldbooks.create({
      id: randomUUID(), name: 'Scene template', description: '', enabled: true,
      scanDepth: 4, tokenBudget: 2_048, recursiveScanning: true, isGlobal: false, extensions: {},
    });
    repositories.worldbookEntries.create({
      id: randomUUID(), worldbookId: source.id, keys: ['reader'], comment: 'Reader core',
      content: 'Template rule', enabled: false, order: 0,
    });
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Guide', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [], worldbookId: source.id,
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Reader', description: '', isDefault: false, sceneInternal: true,
    });
    const builtIn = builtInPackage('builtin:scene-lab')!;
    repositories.installedScenes.create({
      id: SCENE_LAB_SCENE_ID,
      slug: builtIn.manifest.slug,
      version: builtIn.manifest.version,
      archiveDigest: builtIn.digest,
      installPath: 'memory://scene-lab',
      installedAt: new Date().toISOString(),
      manifest: builtIn.manifest,
      backingCharacterId: character.id,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id,
      sceneId: SCENE_LAB_SCENE_ID, title: 'Legacy Save',
    });
    repositories.worldbookRuntimeStates.create({
      id: randomUUID(), conversationId: conversation.id,
      timedState: { messageIndex: null, sticky: [], cooldown: [] },
      entryOverrides: [{ source: 'character', comment: 'Reader core', enabled: true, content: 'Save rule' }],
    });
    database.sqlite.exec(`
      DROP TRIGGER save_worldbooks_delete_owned_worldbook;
      DROP TABLE save_worldbooks;
      UPDATE tavernnext_schema_version SET version = ${CURRENT_SCHEMA_VERSION - 1};
    `);

    migrateDatabase(database);
    const migrated = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const ownership = migrated.saveWorldbooks.getByConversationId(conversation.id)!;
    const entry = migrated.worldbookEntries.listByWorldbookId(ownership.worldbookId)[0]!;
    expect(ownership).toMatchObject({
      conversationId: conversation.id,
      sourceWorldbookId: source.id,
      sourceWorldbookRevision: source.revision,
    });
    expect(entry).toMatchObject({ comment: 'Reader core', enabled: true, content: 'Save rule' });
    expect(migrated.worldbookEntries.listByWorldbookId(source.id)[0]).toMatchObject({
      enabled: false, content: 'Template rule',
    });
    expect(migrated.worldbookRuntimeStates.getByConversationId(conversation.id)?.entryOverrides).toEqual([]);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
