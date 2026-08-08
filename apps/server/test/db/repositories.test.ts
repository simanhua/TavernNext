import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createRepositories } from '../../src/db/repositories.js';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTestRepositories() {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-db-'));
  testDirectories.push(directory);
  const database = createDatabase(join(directory, 'tavernnext.sqlite'));
  migrateDatabase(database);
  return { database, repositories: createRepositories(database) };
}

describe('SQLite repositories', () => {
  it('creates every planned persistence table', async () => {
    const { database } = await createTestRepositories();
    const tables = database.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'characters', 'personas', 'worldbooks', 'worldbook_entries', 'presets',
      'conversations', 'messages', 'message_variants', 'provider_profiles',
      'import_artifacts', 'generation_snapshots',
    ]));
  });

  it('preserves character compatibility metadata through a create and get cycle', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000010',
      name: 'Aster',
      description: 'A careful archivist.',
      personality: '',
      scenario: '',
      firstMessage: 'Hello.',
      alternateGreetings: [],
      tags: [],
      compatibility: {
        sourceFormat: 'st-character-v3',
        rawPayload: { data: { novelField: ['kept'] } },
        unknownFields: { novelField: ['kept'] },
        compatWarnings: [],
        parserVersion: '1',
      },
    });

    expect(repositories.characters.get(character.id)?.compatibility?.rawPayload).toEqual({ data: { novelField: ['kept'] } });
  });

  it('advances a matching revision and reports a stale revision conflict', async () => {
    const { repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000011',
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });

    expect(repositories.characters.update(character.id, 0, { name: 'Aster Prime' })).toMatchObject({ ok: true, value: { revision: 1, name: 'Aster Prime' } });
    expect(repositories.characters.update(character.id, 0, { name: 'Stale write' })).toEqual({ ok: false, reason: 'conflict' });
  });

  it('cascades deleted conversations to messages and variants without deleting their character or persona', async () => {
    const { database, repositories } = await createTestRepositories();
    const character = repositories.characters.create({
      id: '018f0000-0000-7000-8000-000000000020', name: 'Character', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], tags: [],
    });
    const persona = repositories.personas.create({
      id: '018f0000-0000-7000-8000-000000000021', name: 'Persona', description: '', isDefault: true,
    });
    const conversation = repositories.conversations.create({
      id: '018f0000-0000-7000-8000-000000000022', characterId: character.id, personaId: persona.id, title: 'Test chat',
    });
    const message = repositories.messages.create({
      id: '018f0000-0000-7000-8000-000000000023', conversationId: conversation.id, role: 'assistant', content: '', activeVariantId: null,
    });
    const variant = repositories.messageVariants.create({
      id: '018f0000-0000-7000-8000-000000000024', messageId: message.id, content: 'Hello', status: 'completed',
    });

    expect(database.sqlite.prepare('PRAGMA foreign_keys').all()).toEqual([{ foreign_keys: 1 }]);
    expect(repositories.conversations.delete(conversation.id, 0)).toEqual({ ok: true });
    expect(repositories.messages.get(message.id)).toBeUndefined();
    expect(repositories.messageVariants.get(variant.id)).toBeUndefined();
    expect(repositories.characters.get(character.id)).toMatchObject({ id: character.id });
    expect(repositories.personas.get(persona.id)).toMatchObject({ id: persona.id });
  });
});
