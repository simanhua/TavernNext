import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presetSettingsForExecution } from '@tavernnext/st-compat';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db/client.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { createRepositories } from '../src/db/repositories.js';
import type { ImportHandler } from '../src/services/import-service.js';
import { TEST_REPOSITORY_OPTIONS, TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const encoder = new TextEncoder();
const sourceAssociationKey = '__tavernnextPresetSource';
const fixtureRoot = join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'presets');
const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function context(options: Partial<NonNullable<Parameters<typeof createApp>[0]>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-preset-api-'));
  directories.push(directory);
  const database = createDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database);
  const repositories = createRepositories(database, TEST_REPOSITORY_OPTIONS);
  const app = createApp({
    ...options,
    database,
    snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
    config: { host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.sqlite') },
  });
  apps.push(app);
  await app.ready();
  return { app, repositories };
}

function multipart(fileName: string, bytes: Uint8Array, mediaType = 'application/json') {
  const boundary = '----tavernnext-preset-api-boundary';
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mediaType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function fixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fixtureRoot, path)));
}

async function inspectAndCommitBytes(app: ReturnType<typeof createApp>, source: Uint8Array, fileName: string) {
  const inspected = await app.inject({
    method: 'POST', url: '/api/imports/inspect', ...multipart(fileName, source),
  });
  expect(inspected.statusCode).toBe(200);
  const committed = await app.inject({
    method: 'POST', url: '/api/imports/commit', payload: { inspectionToken: inspected.json().inspectionToken },
  });
  return { inspected, committed };
}

async function inspectAndCommit(app: ReturnType<typeof createApp>, path: string, fileName = path) {
  return inspectAndCommitBytes(app, await fixture(path), fileName);
}

function attachedPresetBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({
    name: 'Attached Preset fixture', prompts: [], prompt_order: [], temperature: 0.7,
    unknown_root: { keep: 42 },
    extensions: {
      unknown_extension: { keep: ['preset'] },
      SPreset: {
        ChatSquash: { enabled: true, squashed_post_script_enable: true, squashed_post_script: 'value => value' },
        RegexBinding: { regexes: [{ id: 'bound-regex' }] },
        MacroNest: false,
        ToolBindings: { enabled: false, bindings: [{ name: 'retained-disabled-binding' }] },
      },
      regex_scripts: Array.from({ length: 9 }, (_, ordinal) => ({
        id: `preset-regex-${ordinal}`, scriptName: `Preset regex ${ordinal}`,
        findRegex: '/x/g', replaceString: 'y', disabled: ordinal === 8,
      })),
      tavern_helper: [
        ['scripts', [
          { type: 'folder', id: 'preset-folder', name: 'Preset folder', enabled: true, children: [
            { type: 'script', id: 'nested-preset-script', name: 'Nested preset script', enabled: true, content: 'globalThis.__presetImportExecuted = true;' },
          ] },
          { type: 'script', id: 'preset-script', name: 'Preset script', enabled: false, content: 'globalThis.__presetImportExecuted = true;' },
        ]],
        ['variables', {}],
      ],
    },
  }));
}

describe('typed SillyTavern Preset import and export API', () => {
  it('normalizes Preset extensions, keeps SPreset data, and round-trips after settings edits without execution', async () => {
    const { app, repositories } = await context();
    delete (globalThis as Record<string, unknown>).__presetImportExecuted;
    const { inspected, committed } = await inspectAndCommitBytes(app, attachedPresetBytes(), 'attached-preset.json');

    expect(inspected.json().normalizedPreview).toMatchObject({
      kind: 'chat',
      attachedExtensions: {
        execution: 'not_executed',
        counts: { regex: 9, scripts: 2, folders: 1, variableContainers: 1 },
      },
      spreset: {
        present: true,
        features: { ChatSquash: true, RegexBinding: true, MacroNest: false, ToolBindings: false },
      },
    });
    expect(committed.statusCode).toBe(201);
    expect((globalThis as Record<string, unknown>).__presetImportExecuted).toBeUndefined();
    const id = committed.json().entityId as string;
    expect(repositories.presets.get(id)).toMatchObject({
      extensions: { unknown_extension: { keep: ['preset'] }, SPreset: { MacroNest: false } },
    });
    expect(repositories.extensionAssets.listByOwner('preset', id)).toHaveLength(11);
    const detail = (await app.inject({ method: 'GET', url: `/api/presets/${id}` })).json();
    expect(detail).toMatchObject({
      attachedExtensions: { counts: { regex: 9, scripts: 2, folders: 1, variableContainers: 1 } },
      spreset: { present: true, features: { ChatSquash: true, RegexBinding: true } },
    });
    expect(JSON.stringify(detail)).not.toContain('__presetImportExecuted');

    const edited = await app.inject({
      method: 'PATCH', url: `/api/presets/${id}`,
      payload: { revision: 0, patch: { settings: { temperature: 0.93 } } },
    });
    expect(edited.statusCode).toBe(200);
    const exported = await app.inject({ method: 'GET', url: `/api/presets/${id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      temperature: 0.93,
      unknown_root: { keep: 42 },
      extensions: {
        unknown_extension: { keep: ['preset'] },
        SPreset: { ChatSquash: { enabled: true }, RegexBinding: { regexes: [{ id: 'bound-regex' }] } },
        tavern_helper: { variables: {} },
      },
    });
    expect(Array.isArray(exported.json().extensions.tavern_helper)).toBe(false);
    const roundTrip = await inspectAndCommitBytes(app, exported.rawPayload, 'round-trip-preset.json');
    expect(roundTrip.inspected.json().normalizedPreview.attachedExtensions)
      .toEqual(inspected.json().normalizedPreview.attachedExtensions);
    expect(roundTrip.inspected.json().normalizedPreview.spreset).toEqual(inspected.json().normalizedPreview.spreset);
    expect((globalThis as Record<string, unknown>).__presetImportExecuted).toBeUndefined();

    const removed = await app.inject({ method: 'DELETE', url: `/api/presets/${id}?revision=1` });
    expect(removed.statusCode).toBe(204);
    expect(repositories.extensionAssets.listByOwner('preset', id)).toEqual([]);
  });

  it.runIf(existsSync('F:/SillyTavern-release/data/default-user/OpenAI Settings/命定之诗Kemini5-3.8.json'))(
    'recognizes the local 命定之诗Kemini5-3.8 acceptance Preset',
    async () => {
      const { app } = await context();
      const source = await readFile('F:/SillyTavern-release/data/default-user/OpenAI Settings/命定之诗Kemini5-3.8.json');
      const { inspected, committed } = await inspectAndCommitBytes(app, source, '命定之诗Kemini5-3.8.json');
      expect(inspected.json().normalizedPreview).toMatchObject({
        kind: 'chat',
        attachedExtensions: { execution: 'not_executed', counts: { regex: 9, scripts: 3, variableContainers: 1 } },
        spreset: { present: true, features: { ChatSquash: true, RegexBinding: true, MacroNest: false, ToolBindings: false } },
      });
      expect(committed.statusCode).toBe(201);
    },
    30_000,
  );

  it('uses the default handler to reparse staged bytes into a fresh Preset plus one ImportArtifact without merging same-name imports', async () => {
    const { app, repositories } = await context();
    const first = await inspectAndCommit(app, 'chat/synthetic-chat.settings', 'first-rename.bin');
    const second = await inspectAndCommit(app, 'chat/synthetic-chat.settings', 'second-rename.bin');

    expect(first.inspected.json()).toMatchObject({
      detected: { kind: 'preset' },
      normalizedPreview: { kind: 'chat', settings: { tokenizer: 17 } },
      warnings: expect.arrayContaining([expect.objectContaining({ code: 'provider_field_preserved_not_executable' })]),
    });
    expect(first.committed.statusCode).toBe(201);
    expect(second.committed.statusCode).toBe(201);
    expect(first.committed.json().entityId).not.toBe(second.committed.json().entityId);
    expect(repositories.presets.list()).toEqual([
      expect.objectContaining({ name: 'Synthetic Chat Settings', kind: 'chat', settings: expect.objectContaining({ tokenizer: 17 }) }),
      expect.objectContaining({ name: 'Synthetic Chat Settings', kind: 'chat' }),
    ]);
    expect(repositories.importArtifacts.list()).toEqual([
      expect.objectContaining({ entityId: first.committed.json().entityId, sourceName: 'first-rename.bin' }),
      expect.objectContaining({ entityId: second.committed.json().entityId, sourceName: 'second-rename.bin' }),
    ]);
    expect(Buffer.from(repositories.importArtifacts.list()[0]!.rawArtifact, 'base64'))
      .toEqual(Buffer.from(await fixture('chat/synthetic-chat.settings')));
  });

  it('rolls back both the typed Preset and ImportArtifact when the outer asset move fails', async () => {
    const { app, repositories } = await context({
      importMoveAssets: () => { throw new Error('injected Preset move failure'); },
    });
    const { committed } = await inspectAndCommit(app, 'context/synthetic-context.json');

    expect(committed.statusCode).toBe(500);
    expect(committed.json()).toEqual({ error: 'import_commit_failed' });
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toEqual([]);
  });

  it('keeps an explicit import-handler override instead of appending the default Preset handler', async () => {
    const override: ImportHandler = {
      id: 'test-preset-override',
      matches: (preview) => preview.detected.kind === 'preset',
      async inspect() {
        return { normalizedPreview: { override: true }, warnings: [], blockingErrors: [] };
      },
      commit() {
        return {};
      },
    };
    const { app, repositories } = await context({ importHandlers: [override] });
    const { inspected, committed } = await inspectAndCommit(app, 'text/synthetic-text.json');

    expect(inspected.json().normalizedPreview).toEqual({ override: true });
    expect(committed.statusCode).toBe(201);
    expect(repositories.presets.list()).toEqual([]);
    expect(repositories.importArtifacts.list()).toHaveLength(1);
  });

  it('exports JSON through a real listener with safe ASCII and RFC 5987 Unicode filenames, plus 400 and 404 boundaries', async () => {
    const { app, repositories } = await context();
    const { committed } = await inspectAndCommit(app, 'context/synthetic-context.json');
    const id = committed.json().entityId as string;
    expect(repositories.presets.update(id, 0, {
      name: '雪姬\r\nX-Injected: yes',
      settings: { ...repositories.presets.get(id)!.settings, story_string: 'Edited story.' },
    })).toMatchObject({ ok: true });

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/api/presets/${id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="___X-Injected_yes.json"; filename*=UTF-8\'\'%E9%9B%AA%E5%A7%AC_X-Injected_yes.json',
    );
    expect(response.headers.get('x-injected')).toBeNull();
    expect(await response.json()).toMatchObject({ story_string: 'Edited story.', context_unknown: { retain: { empty: '' } } });

    expect((await app.inject({ method: 'GET', url: `/api/presets/${id}/export?format=png` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/presets/018f0000-0000-7000-8000-000000000999/export' })).statusCode).toBe(404);
  });

  it.each([
    ['system/synthetic-system.json', 'system', { content: 'Write only synthetic notes.', post_history: 'After the chat, add a concise archive note.' }],
    ['instruct/synthetic-instruct.json', 'instruct', { input_sequence: '<|user|>', output_sequence: '<|assistant|>' }],
    ['reasoning/synthetic-reasoning.json', 'reasoning', { prefix: '<think>', separator: '</think>\n' }],
  ] as const)('imports and exports a typed %s preset', async (path, kind, settings) => {
    const { app, repositories } = await context();
    const { inspected, committed } = await inspectAndCommit(app, path, `renamed-${kind}.settings`);

    expect(inspected.json()).toMatchObject({
      detected: { kind: 'preset' },
      normalizedPreview: { kind, settings },
      blockingErrors: [],
    });
    expect(committed.statusCode).toBe(201);
    const id = committed.json().entityId as string;
    expect(repositories.presets.get(id)).toMatchObject({ kind, settings });

    const exported = await app.inject({ method: 'GET', url: `/api/presets/${id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject(settings);
  });

  it('imports direct NovelAI parameters as typed settings and exports edits back to the nested source shape', async () => {
    const { app, repositories } = await context();
    const source = encoder.encode(JSON.stringify({
      presetVersion: 3,
      parameters: {
        temperature: 0.43,
        top_p: 0.8,
        tail_free_sampling: 0.7,
        repetition_penalty: 1.15,
        provider_metadata: { retain: true },
      },
    }));
    const { inspected, committed } = await inspectAndCommitBytes(app, source, 'direct-novel.preset');

    expect(inspected.json()).toMatchObject({
      detected: { kind: 'preset' },
      normalizedPreview: {
        kind: 'text',
        settings: {
          temperature: 0.43,
          top_p: 0.8,
          tail_free_sampling: 0.7,
          repetition_penalty: 1.15,
        },
        unknownFields: { parameters: { provider_metadata: { retain: true } } },
      },
      warnings: expect.arrayContaining([expect.objectContaining({ code: 'provider_field_preserved_not_executable' })]),
    });
    expect(committed.statusCode).toBe(201);
    const id = committed.json().entityId as string;
    expect(repositories.presets.get(id)).toMatchObject({ kind: 'text', settings: { temperature: 0.43 } });
    expect(repositories.presets.update(id, 0, {
      settings: { ...repositories.presets.get(id)!.settings, temperature: 0.91 },
    })).toMatchObject({ ok: true });

    const exported = await app.inject({ method: 'GET', url: `/api/presets/${id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      presetVersion: 3,
      parameters: { temperature: 0.91, provider_metadata: { retain: true } },
    });
    expect(exported.json()).not.toHaveProperty('temperature');
    expect(Buffer.from(repositories.importArtifacts.list()[0]!.rawArtifact, 'base64')).toEqual(Buffer.from(source));
  });

  it('keeps duplicate prompt-order metadata associated after repository JSON persistence, edits, and reorder', async () => {
    const { app, repositories } = await context();
    const source = encoder.encode(JSON.stringify({
      prompts: [],
      prompt_order: [{
        character_id: 7,
        order: [
          { identifier: 'duplicate', enabled: true, opaque: { origin: 'first' } },
          { identifier: 'duplicate', enabled: false, opaque: { origin: 'second' } },
        ],
      }],
    }));
    const { committed } = await inspectAndCommitBytes(app, source, 'duplicate-order.settings');
    expect(committed.statusCode).toBe(201);
    const id = committed.json().entityId as string;

    const persistedPreset = repositories.presets.get(id)!;
    const persistedSettings = JSON.parse(JSON.stringify(persistedPreset.settings)) as Record<string, unknown>;
    const persistedCompatibility = JSON.parse(JSON.stringify(persistedPreset.compatibility)) as NonNullable<typeof persistedPreset.compatibility>;
    expect(persistedCompatibility.rawPayload).toMatchObject({
      associationEnvelope: {
        type: 'tavernnext:preset-source-associations',
        version: 1,
        kind: 'chat',
        entries: expect.arrayContaining([
          expect.objectContaining({ location: 'chat.prompt_order.order' }),
        ]),
      },
    });
    const group = (persistedSettings.prompt_order as Array<Record<string, unknown>>)[0]!;
    const order = group.order as Array<Record<string, unknown>>;
    expect(presetSettingsForExecution(persistedSettings, persistedCompatibility, 'chat')).toEqual({
      prompts: [],
      prompt_order: [{
        character_id: 7,
        order: [
          { identifier: 'duplicate', enabled: true },
          { identifier: 'duplicate', enabled: false },
        ],
      }],
    });
    const opaqueUserValue = { type: 'string', description: 'Task10 user schema data' };
    const executableWithOpaqueData = presetSettingsForExecution({
      ...persistedSettings,
      reasoning_config: {
        response_schema: {
          properties: { [sourceAssociationKey]: opaqueUserValue },
          required: [sourceAssociationKey],
        },
      },
    }, persistedCompatibility, 'chat');
    expect(executableWithOpaqueData).toMatchObject({
      reasoning_config: {
        response_schema: {
          properties: { [sourceAssociationKey]: opaqueUserValue },
          required: [sourceAssociationKey],
        },
      },
    });
    expect((executableWithOpaqueData.prompt_order as Array<Record<string, unknown>>)[0])
      .not.toHaveProperty(sourceAssociationKey);
    expect(repositories.presets.update(id, 0, {
      settings: {
        ...persistedSettings,
        prompt_order: [{
          ...group,
          order: [
            { ...order[1]!, enabled: true },
            { ...order[0]!, enabled: false },
          ],
        }],
      },
    })).toMatchObject({ ok: true });

    const exported = await app.inject({ method: 'GET', url: `/api/presets/${id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().prompt_order[0].order).toEqual([
      { identifier: 'duplicate', enabled: true, opaque: { origin: 'second' } },
      { identifier: 'duplicate', enabled: false, opaque: { origin: 'first' } },
    ]);
    expect(JSON.stringify(exported.json())).not.toContain('tavernnextPresetSource');
  });
});
