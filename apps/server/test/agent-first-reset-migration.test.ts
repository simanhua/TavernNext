import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import { createSecretStore } from '../src/services/secret-store.js';
import { createPreMigrationBackup } from '../src/services/backup-service.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('Agent-first breaking reset migration', () => {
  it.each([16, 21])('backs up schema v%s and clears every Save/Agent row while preserving reusable libraries, Scenes, Providers, and secrets', async (startingVersion) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'tavernnext-agent-first-reset-'));
    directories.push(dataDir);
    const databasePath = join(dataDir, 'tavernnext.sqlite');
    const database = createDatabase(databasePath);
    migrateDatabase(database);
    const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
    const character = repositories.characters.create({
      id: randomUUID(), name: 'Kept Character', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: randomUUID(), name: 'Kept Persona', description: '', isDefault: true,
    });
    const worldbook = repositories.worldbooks.create({
      id: randomUUID(), name: 'Kept Worldbook', description: '', enabled: true, isGlobal: false,
    });
    repositories.worldbookEntries.create({
      id: randomUUID(), worldbookId: worldbook.id, keys: ['kept'], content: 'Kept lore', enabled: true,
    });
    const preset = repositories.presets.create({
      id: randomUUID(), name: 'Kept Chat template', kind: 'chat', settings: { prompts: [], prompt_order: [] },
    });
    const provider = repositories.providerProfiles.create({
      id: randomUUID(), name: 'Kept Provider', baseUrl: 'http://127.0.0.1:8080/v1', model: 'agent-model',
      apiMode: 'chat', secretRef: 'migration-secret', toolCalls: true,
    });
    const sceneId = randomUUID();
    repositories.installedScenes.create({
      id: sceneId, slug: 'kept-scene', version: '1.0.0', archiveDigest: 'a'.repeat(64), installPath: dataDir,
      installedAt: new Date().toISOString(), backingCharacterId: character.id, backingPresetId: preset.id,
      manifest: {
        id: sceneId, slug: 'kept-scene', version: '1.0.0', name: 'Kept Scene', summary: '', description: '', author: 'Test',
        minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 2, frontendEntry: 'frontend.js', frontendStyles: [],
        setupSchema: {}, stateSchema: {}, agentTools: [], sceneViews: [], files: ['frontend.js'],
      },
    });
    const artifact = repositories.importArtifacts.create({
      id: randomUUID(), kind: 'character', sourceName: 'kept.json', mediaType: 'application/json', rawArtifact: '{}',
      entityId: character.id,
    });
    const conversation = repositories.conversations.create({
      id: randomUUID(), characterId: character.id, personaId: persona.id, title: 'Reset Save', worldbookIds: [worldbook.id],
    });
    const configuration = repositories.saveAgentConfigurations.create({
      id: randomUUID(), conversationId: conversation.id, sourcePresetId: preset.id, sourcePresetRevision: preset.revision,
      name: preset.name, settings: preset.settings,
    });
    const message = repositories.messages.create({
      id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: randomUUID(), messageId: message.id, ordinal: 0, content: 'Reset reply', status: 'completed', finishReason: 'stop',
    });
    expect(repositories.messages.update(message.id, message.revision, { activeVariantId: variant.id }).ok).toBe(true);
    const snapshot = repositories.generationSnapshots.create({
      id: randomUUID(), conversationId: conversation.id, conversationRevision: conversation.revision, payload: { witness: true },
    });
    repositories.worldbookRuntimeStates.create({
      id: randomUUID(), conversationId: conversation.id, timedState: { messageIndex: 1, sticky: [], cooldown: [] },
      entryOverrides: [],
    });
    const state = repositories.conversationSceneStates.create({
      id: randomUUID(), conversationId: conversation.id, schemaVersion: 1, baseValue: { points: 0 }, value: { points: 1 },
      headTransitionId: null,
    });
    const transition = repositories.sceneStateTransitions.create({
      id: randomUUID(), conversationId: conversation.id, parentTransitionId: null, sourceKind: 'message-variant',
      sourceId: variant.id, operations: [{ op: 'replace', path: '/points', value: 1 }], value: { points: 1 },
    });
    expect(repositories.conversationSceneStates.update(state.id, state.revision, {
      headTransitionId: transition.id,
    }).ok).toBe(true);
    repositories.agentRuns.create({
      id: randomUUID(), conversationId: conversation.id, generationId: randomUUID(), snapshotId: snapshot.id,
      status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      limits: { maxModelTurns: 8, maxToolCalls: 16, timeoutMs: 120_000 },
      counts: { modelTurns: 1, toolCalls: 0 }, usage: { inputTokens: 1, outputTokens: 1 },
      promptPlan: { schemaVersion: 1, hash: 'b'.repeat(64), promptTokens: 1, messageCount: 1 },
      revisions: {
        conversation: { id: conversation.id, revision: conversation.revision },
        character: { id: character.id, revision: character.revision }, persona: { id: persona.id, revision: persona.revision },
        provider: { id: provider.id, revision: provider.revision },
        saveAgentConfiguration: { id: configuration.id, revision: configuration.revision }, sceneState: { id: state.id, revision: 0 },
      },
      lifecycle: [], activities: [], diagnostics: [],
    });
    repositories.extensionStates.create({
      id: randomUUID(), scope: 'conversation', scopeId: conversation.id, value: { reset: true },
    });
    repositories.extensionStates.create({
      id: randomUUID(), scope: 'character', scopeId: character.id, value: { kept: true },
    });
    expect(repositories.globalGenerationConfig.update(0, {
      providerId: provider.id, chatPresetId: preset.id, textPresetId: preset.id,
      contextPresetId: preset.id, instructPresetId: preset.id, systemPresetId: preset.id,
    }).ok).toBe(true);
    createSecretStore(dataDir).set('migration-secret', {
      profileId: provider.id, baseUrl: provider.baseUrl, credential: { type: 'api_key', key: 'KEPT-SECRET' },
    });
    database.sqlite.prepare('UPDATE tavernnext_schema_version SET version = ?').run(startingVersion);
    database.close();

    const app = createApp({
      config: { host: '127.0.0.1', port: 0, dataDir, databasePath },
      snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
      backupClock: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    await app.ready();
    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health).toMatchObject({ status: 'ok', backup: { kind: 'pre_migration', path: expect.any(String) } });
    await app.close();

    const backupDatabase = createDatabase(join(health.backup.path, basename(databasePath)));
    expect(backupDatabase.sqlite.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 1 });
    expect(backupDatabase.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_runs').get()).toEqual({ count: 1 });
    backupDatabase.close();

    const migrated = createDatabase(databasePath);
    const resetTables = [
      'conversations', 'save_agent_configurations', 'messages', 'message_variants', 'generation_snapshots',
      'consumed_generation_snapshots', 'agent_runs', 'worldbook_runtime_states', 'conversation_scene_states',
      'scene_state_transitions', 'conversation_worldbooks',
    ];
    for (const table of resetTables) {
      expect(migrated.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    expect(migrated.sqlite.prepare("SELECT COUNT(*) AS count FROM extension_states WHERE scope = 'conversation'").get())
      .toEqual({ count: 0 });
    expect(migrated.sqlite.prepare("SELECT COUNT(*) AS count FROM extension_states WHERE scope = 'character'").get())
      .toEqual({ count: 1 });
    const preserved = createRepositories(migrated, TEST_REPOSITORY_OPTIONS);
    expect(preserved.characters.get(character.id)?.name).toBe(character.name);
    expect(preserved.personas.get(persona.id)?.name).toBe(persona.name);
    expect(preserved.worldbooks.get(worldbook.id)?.name).toBe(worldbook.name);
    expect(preserved.presets.get(preset.id)?.name).toBe(preset.name);
    expect(preserved.providerProfiles.get(provider.id)).toMatchObject({ name: provider.name, apiMode: 'chat' });
    expect(preserved.installedScenes.get(sceneId)?.slug).toBe('kept-scene');
    expect(preserved.importArtifacts.get(artifact.id)?.sourceName).toBe('kept.json');
    expect(preserved.globalGenerationConfig.get()).toMatchObject({
      providerId: provider.id, chatPresetId: preset.id,
      textPresetId: null, contextPresetId: null, instructPresetId: null, systemPresetId: null,
    });
    const beforeSecondMigration = migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get();
    migrateDatabase(migrated);
    expect(migrated.sqlite.prepare('SELECT COUNT(*) AS count FROM characters').get()).toEqual(beforeSecondMigration);
    expect(migrated.sqlite.prepare('SELECT version FROM tavernnext_schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    migrated.close();
    expect(createSecretStore(dataDir).get('migration-secret')).toMatchObject({ credential: { key: 'KEPT-SECRET' } });
    expect(JSON.parse(await readFile(join(health.backup.path, 'metadata.json'), 'utf8'))).toMatchObject({
      schemaVersion: startingVersion, integrityCheck: 'ok', retention: 'pinned',
    });
    for (let index = 0; index < 3; index += 1) {
      const restarted = createApp({
        config: { host: '127.0.0.1', port: 0, dataDir, databasePath },
        snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
        backupClock: () => new Date(Date.UTC(2026, 7, 27, 0, 0, index)),
      });
      await restarted.ready();
      expect((await restarted.inject({ method: 'GET', url: '/api/health' })).json()).not.toHaveProperty('backup');
      await restarted.close();
    }
    expect(await readdir(join(dataDir, 'backups'))).toHaveLength(1);
    for (let index = 0; index < 7; index += 1) {
      createPreMigrationBackup({
        dataDir,
        databasePath,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        clock: () => new Date(Date.UTC(2026, 7, 28, 0, 0, index)),
      });
    }
    const retained = await readdir(join(dataDir, 'backups'));
    expect(retained).toContain(basename(health.backup.path));
    expect(retained).toHaveLength(6);
  }, 60_000);
});
