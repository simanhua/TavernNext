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

async function context() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-extension-assets-api-'));
  directories.push(directory);
  const path = join(directory, 'test.sqlite');
  const database = createDatabase(path);
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: path },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

describe('Attached Extension Resource API', () => {
  it('edits Preset script trees atomically, reports conflicts, and overlays export without changing unknown fields', async () => {
    const { app, repositories } = await context();
    const preset = repositories.presets.create({
      id: '018f0000-0000-7000-8000-000000002101', name: 'Editable resources', kind: 'chat',
      settings: { prompts: [], prompt_order: [] },
      extensions: {
        unknown_extension: { keep: 42 },
        unknown_nested: { untouched: true },
        regex_scripts: [{ id: 'old-regex', scriptName: 'Old regex', findRegex: '/old/g', replaceString: 'new' }],
        tavern_helper: { variables: { keep: true }, scripts: [{
          id: 'old-script', type: 'script', name: 'Old script', enabled: true, content: 'old();',
        }] },
      },
      compatibility: {
        sourceFormat: 'preset:json',
        rawPayload: {
          rawDocument: {
            name: 'Editable resources', prompts: [], prompt_order: [],
            extensions: { unknown_extension: { keep: 42 }, unknown_nested: { untouched: true } },
          },
          associationEnvelope: { type: 'tavernnext:preset-source-associations', version: 1, kind: 'chat', entries: [] },
        },
        unknownFields: {}, compatWarnings: [], parserVersion: '1',
      },
    });
    repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000002102', ownerKind: 'preset', ownerId: preset.id,
      kind: 'regex', sourceKey: 'old-regex', ordinal: 0, enabled: true,
      payload: { id: 'old-regex', scriptName: 'Old regex', findRegex: '/old/g', replaceString: 'new' },
    });
    repositories.extensionAssets.create({
      id: '018f0000-0000-7000-8000-000000002103', ownerKind: 'preset', ownerId: preset.id,
      kind: 'tavern_helper', sourceKey: 'old-script', ordinal: 0, enabled: true,
      payload: { id: 'old-script', type: 'script', name: 'Old script', enabled: true, content: 'old();' },
    });
    repositories.extensionStates.create({
      id: '018f0000-0000-7000-8000-000000002104', scope: 'script',
      scopeId: `preset:${preset.id}:old-script`, value: { retainedUntilRemoval: true },
    });

    const loaded = await app.inject({
      method: 'GET', url: `/api/extension-assets?ownerKind=preset&ownerId=${preset.id}`,
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ owner: { kind: 'preset', id: preset.id, revision: 0 }, assets: [{ kind: 'regex' }, { kind: 'tavern_helper' }] });

    const draft = [{
      kind: 'tavern_helper', sourceKey: 'edited-script', ordinal: 0, enabled: false,
      payload: {
        id: 'edited-script', type: 'script', name: 'Edited script', enabled: false,
        content: 'edited();', info: 'Notes', button: { label: 'Run' }, data: { count: 1 },
        export_with: { character: true, preset: true },
      }, diagnostics: [],
    }, {
      kind: 'tavern_helper', sourceKey: 'new-folder', ordinal: 1, enabled: true,
      payload: {
        id: 'new-folder', type: 'folder', name: 'New folder', enabled: true,
        children: [{ id: 'nested', type: 'script', name: 'Nested', enabled: true, content: 'nested();' }],
      }, diagnostics: [],
    }];
    const saved = await app.inject({
      method: 'PUT', url: `/api/extension-assets?ownerKind=preset&ownerId=${preset.id}`,
      payload: { ownerRevision: 0, assets: draft },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ owner: { revision: 1 }, assets: draft });
    expect(repositories.extensionStates.getByScope('script', `preset:${preset.id}:old-script`)).toBeUndefined();

    const conflict = await app.inject({
      method: 'PUT', url: `/api/extension-assets?ownerKind=preset&ownerId=${preset.id}`,
      payload: { ownerRevision: 0, assets: [] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: 'conflict', ownerRevision: 1 });
    expect(repositories.extensionAssets.listByOwner('preset', preset.id)).toHaveLength(2);

    const exported = await app.inject({ method: 'GET', url: `/api/presets/${preset.id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().extensions).toMatchObject({
      unknown_extension: { keep: 42 },
      unknown_nested: { untouched: true },
      regex_scripts: [],
      tavern_helper: {
        variables: { keep: true },
        scripts: [draft[0]!.payload, draft[1]!.payload],
      },
    });
  });

  it('uses the same revisioned replacement contract for Character owners', async () => {
    const { app, repositories } = await context();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000002111', name: 'Character owner',
      description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const response = await app.inject({
      method: 'PUT', url: `/api/extension-assets?ownerKind=character&ownerId=${character.id}`,
      payload: { ownerRevision: 0, assets: [{
        kind: 'regex', sourceKey: 'new-regex', ordinal: 0, enabled: true, diagnostics: [],
        payload: { id: 'new-regex', scriptName: 'New regex', findRegex: '/x/g', replaceString: 'y' },
      }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ owner: { kind: 'character', revision: 1 }, assets: [{ sourceKey: 'new-regex' }] });
    expect(repositories.characters.get(character.id)).toMatchObject({
      revision: 1, extensions: { regex_scripts: [{ id: 'new-regex' }] },
    });
  });

  it('round-trips diagnosed scalar and array payloads without silently coercing them', async () => {
    const { app, repositories } = await context();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000002121', name: 'Opaque payload owner',
      description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
      extensions: { regex_scripts: ['opaque-regex'], tavern_helper: { scripts: [['opaque-script']] } },
    });
    const assets = [{
      kind: 'regex', sourceKey: 'opaque-regex', ordinal: 0, enabled: false,
      payload: 'opaque-regex', diagnostics: ['regex_not_object'],
    }, {
      kind: 'tavern_helper', sourceKey: 'opaque-script', ordinal: 0, enabled: true,
      payload: ['opaque-script'], diagnostics: ['script_node_not_object'],
    }];
    const saved = await app.inject({
      method: 'PUT', url: `/api/extension-assets?ownerKind=character&ownerId=${character.id}`,
      payload: { ownerRevision: 0, assets },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().assets).toEqual(assets);
    expect(repositories.characters.get(character.id)?.extensions).toMatchObject({
      regex_scripts: ['opaque-regex'], tavern_helper: { scripts: [['opaque-script']] },
    });
  });
});
