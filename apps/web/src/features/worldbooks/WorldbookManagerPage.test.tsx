// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorldbookEntryView, WorldbookView } from '../../api/client.js';
import { renderWithApp } from '../../test/render.js';
import { WorldbookManagerPage } from './WorldbookManagerPage.js';

const now = '2026-08-08T00:00:00.000Z';
const bookId = '018f0000-0000-7000-8000-000000000931';
const firstEntryId = '018f0000-0000-7000-8000-000000000932';
const secondEntryId = '018f0000-0000-7000-8000-000000000933';
const baseEntry: WorldbookEntryView = {
  id: firstEntryId, revision: 0, createdAt: now, updatedAt: now, worldbookId: bookId,
  sourceUid: 42, sourceOrdinal: 0,
  keys: ['archive'], secondaryKeys: ['door'], useRegex: true, selective: true, selectiveLogic: 0,
  constant: false, vectorized: false, probability: 80, useProbability: true, group: 'places',
  groupWeight: 100, groupOverride: false, priority: 5, content: 'The archive remembers.', enabled: true,
  position: 'before_character', order: 10, depth: 4, role: 0, ignoreBudget: false, scanDepth: 3,
  caseSensitive: false, matchWholeWords: true, useGroupScoring: true,
  excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
  sticky: 2, cooldown: 1, delay: 0,
  characterFilter: { isExclude: false, names: ['Aster'], tags: ['lore'] },
  personaFilter: { isExclude: true, names: ['Intruder'], tags: [] },
  matchPersonaDescription: true, matchCharacterDescription: true, matchCharacterPersonality: false,
  matchCharacterDepthPrompt: true, matchScenario: true, matchCreatorNotes: false,
  comment: 'Archive memo', displayName: 'Archive', addMemo: true, displayIndex: 7,
  outletName: 'knowledge', automationId: 'automation-1', triggers: ['normal'],
  compatibilitySummary: { sourceFormat: 'worldbook-entry:st-native', warnings: ['foreign_field_preserved'], unknownFieldCount: 2 },
};
let detail: WorldbookView = {
  id: bookId, revision: 0, createdAt: now, updatedAt: now, name: 'Archive Lore', description: 'Library facts',
  enabled: true, scanDepth: 4, tokenBudget: 512, recursiveScanning: true, isGlobal: false,
  compatibilitySummary: { sourceFormat: 'worldbook:st-native', warnings: [], unknownFieldCount: 1 },
  entries: [baseEntry, { ...baseEntry, id: secondEntryId, sourceUid: 'second', sourceOrdinal: 1, displayName: 'Second', order: 20, content: 'Second fact.' }],
};
let entryPatchCalls = 0;
let reorderCalls = 0;
let conflictOnce = false;
let bookPatches: Array<{ revision: number; patch: Record<string, unknown> }> = [];
let entryPatches: Array<{ revision: number; patch: Record<string, unknown> }> = [];

const server = setupServer(
  http.get('/api/worldbooks', () => HttpResponse.json([{ id: bookId, revision: detail.revision, name: detail.name, enabled: detail.enabled, entryCount: detail.entries.length }])),
  http.get('/api/worldbooks/:id', () => HttpResponse.json(detail)),
  http.patch('/api/worldbooks/:bookId', async ({ request }) => {
    const body = await request.json() as { revision: number; patch: Record<string, unknown> };
    bookPatches.push(body);
    detail = { ...detail, ...body.patch as Partial<typeof detail>, revision: body.revision + 1 };
    return HttpResponse.json(detail);
  }),
  http.patch('/api/worldbooks/:bookId/entries/:entryId', async ({ params, request }) => {
    entryPatchCalls += 1;
    const body = await request.json() as { revision: number; patch: Partial<WorldbookEntryView> };
    entryPatches.push({ revision: body.revision, patch: body.patch });
    expect(body.patch).not.toHaveProperty('sourceUid');
    expect(body.patch).not.toHaveProperty('sourceOrdinal');
    if (conflictOnce) {
      conflictOnce = false;
      detail = {
        ...detail,
        entries: detail.entries.map((entry) => entry.id === params.entryId ? { ...entry, revision: 5, content: 'Server entry content' } : entry),
      };
      return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    }
    const current = detail.entries.find((entry) => entry.id === params.entryId);
    if (current === undefined || current.revision !== body.revision) {
      return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    }
    let updated: WorldbookEntryView | undefined;
    detail = {
      ...detail,
      entries: detail.entries.map((entry) => {
        if (entry.id !== params.entryId) return entry;
        updated = { ...entry, ...body.patch, revision: body.revision + 1 };
        return updated;
      }),
    };
    return HttpResponse.json(updated);
  }),
  http.put('/api/worldbooks/:bookId/entries/order', async ({ request }) => {
    reorderCalls += 1;
    const body = await request.json() as { entries: Array<{ id: string; revision: number; order: number }> };
    const requested = new Map(body.entries.map((entry) => [entry.id, entry.order]));
    const entries = detail.entries.map((entry) => ({ ...entry, order: requested.get(entry.id) ?? entry.order }));
    entries.sort((left, right) => left.order - right.order || (left.sourceOrdinal ?? 0) - (right.sourceOrdinal ?? 0));
    detail = { ...detail, entries };
    return HttpResponse.json(detail.entries);
  }),
  http.post('/api/worldbooks/:bookId/entries', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    const created: WorldbookEntryView = { ...baseEntry, ...body, id: '018f0000-0000-7000-8000-000000000934', sourceUid: undefined, sourceOrdinal: 2 };
    detail = { ...detail, entries: [...detail.entries, created] };
    return HttpResponse.json(created, { status: 201 });
  }),
  http.delete('/api/worldbooks/:bookId/entries/:entryId', ({ params }) => {
    detail = { ...detail, entries: detail.entries.filter((entry) => entry.id !== params.entryId) };
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  detail = {
    id: bookId, revision: 0, createdAt: now, updatedAt: now, name: 'Archive Lore', description: 'Library facts',
    enabled: true, scanDepth: 4, tokenBudget: 512, recursiveScanning: true, isGlobal: false,
    compatibilitySummary: { sourceFormat: 'worldbook:st-native', warnings: [], unknownFieldCount: 1 },
    entries: [baseEntry, { ...baseEntry, id: secondEntryId, sourceUid: 'second', sourceOrdinal: 1, displayName: 'Second', order: 20, content: 'Second fact.' }],
  };
  entryPatchCalls = 0;
  reorderCalls = 0;
  conflictOnce = false;
  bookPatches = [];
  entryPatches = [];
});
afterAll(() => server.close());

describe('WorldbookManagerPage', () => {
  it('announces book validation errors instead of silently blocking submit', async () => {
    const user = userEvent.setup();
    renderWithApp(<WorldbookManagerPage />);
    await user.click(screen.getByRole('button', { name: 'New Worldbook' }));
    await user.click(screen.getByRole('button', { name: 'Create Worldbook' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Name is required');
  });

  it('announces entry validation errors and does not send an invalid patch', async () => {
    const user = userEvent.setup();
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    await user.clear(screen.getByLabelText('Order'));
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Enter a number');
    expect(entryPatchCalls).toBe(0);
  });

  it('round-trips comma-containing entry arrays without changing their elements', async () => {
    const user = userEvent.setup();
    const commaArrays = {
      keys: ['archive, east', 'annex'],
      secondaryKeys: ['sealed, door'],
      characterFilter: { isExclude: false, names: ['Aster, Prime'], tags: ['lore, keeper'] },
      personaFilter: { isExclude: true, names: ['Visitor, Lost'], tags: ['outsider, wary'] },
      triggers: ['normal, quiet'],
    };
    detail = {
      ...detail,
      entries: detail.entries.map((entry, index) => index === 0 ? { ...entry, ...commaArrays } : entry),
    };
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));

    await waitFor(() => expect(entryPatchCalls).toBe(0));
    expect(detail.entries[0]).toMatchObject(commaArrays);
  });

  it('sends only changed allowlisted Worldbook and Entry fields', async () => {
    const user = userEvent.setup();
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.clear(screen.getByLabelText('Worldbook description'));
    await user.type(screen.getByLabelText('Worldbook description'), 'Changed book description');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook' }));
    await waitFor(() => expect(bookPatches).toHaveLength(1));
    expect(bookPatches[0]!.patch).toEqual({ description: 'Changed book description' });

    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    await user.clear(screen.getByLabelText('Entry content'));
    await user.type(screen.getByLabelText('Entry content'), 'Only entry content changed');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await waitFor(() => expect(entryPatches).toHaveLength(1));
    expect(entryPatches[0]!.patch).toEqual({ content: 'Only entry content changed' });
  });

  it('labels the finite executable book settings without exposing raw extensions', async () => {
    const user = userEvent.setup();
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));

    const settings = screen.getByRole('group', { name: 'Executable Worldbook settings' });
    expect(settings).not.toBeNull();
    expect(screen.getByText(/Editable executable Worldbook extensions are unavailable in this MVP/)).not.toBeNull();
    expect(screen.queryByLabelText(/extensions JSON/i)).toBeNull();
  });

  it('covers the book and complete runtime entry surface without allowing source identity edits', async () => {
    const user = userEvent.setup();
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));

    for (const label of [
      'Primary keys', 'Secondary keys', 'Use regular expressions', 'Selective activation', 'Selective logic',
      'Entry content', 'Entry enabled', 'Constant activation', 'Vectorized', 'Case sensitive', 'Whole-word matching',
      'Position', 'Order', 'Priority', 'Probability', 'Use probability', 'Group', 'Group weight', 'Group override',
      'Ignore token budget', 'Entry scan depth', 'Use group scoring', 'Exclude recursion', 'Prevent recursion',
      'Delay until recursion', 'Sticky', 'Cooldown', 'Delay', 'Depth', 'Role', 'Outlet',
      'Character filter names', 'Character filter tags', 'Exclude Character filter',
      'Persona filter names', 'Persona filter tags', 'Exclude Persona filter',
      'Match Persona description', 'Match Character description', 'Match Character personality',
      'Match Character depth prompt', 'Match scenario', 'Match creator notes',
      'Comment', 'Display name', 'Add memo', 'Display index', 'Automation ID', 'Triggers',
    ]) expect(screen.getByLabelText(label)).not.toBeNull();
    expect(screen.getByText('Source UID: number 42 · ordinal 0')).not.toBeNull();
    expect(screen.queryByLabelText('Source UID')).toBeNull();
    expect(screen.getByText('foreign_field_preserved')).not.toBeNull();

    const content = screen.getByLabelText('Entry content');
    await user.clear(content);
    await user.type(content, 'Edited archive fact.');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await waitFor(() => expect(entryPatchCalls).toBe(1));
    expect(detail.entries[0]!.content).toBe('Edited archive fact.');
  });

  it('reorders by stable IDs and supports entry enable, add, and delete', async () => {
    const user = userEvent.setup();
    detail = { ...detail, entries: detail.entries.map((entry) => ({ ...entry, order: 10 })) };
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Move entry Archive down' }));
    await waitFor(() => expect(reorderCalls).toBe(1));
    expect(detail.entries.map((entry) => entry.id)).toEqual([secondEntryId, firstEntryId]);

    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    await user.click(screen.getByLabelText('Entry enabled'));
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await waitFor(() => expect(detail.entries.find((entry) => entry.id === firstEntryId)?.enabled).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Add Worldbook entry' }));
    await user.type(screen.getByLabelText('Entry content'), 'New entry');
    await user.click(screen.getByRole('button', { name: 'Create Worldbook entry' }));
    expect(await screen.findByRole('button', { name: 'Edit entry Untitled entry' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete entry Untitled entry' }));
    await waitFor(() => expect(detail.entries).toHaveLength(2));
  });

  it('freezes the Entry baseline after conflict until explicit Retry adopts the latest revision', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    const content = screen.getByLabelText('Entry content');
    await user.clear(content);
    await user.type(content, 'Local Worldbook draft');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server revision 5');
    expect((content as HTMLTextAreaElement).value).toBe('Local Worldbook draft');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await waitFor(() => expect(entryPatchCalls).toBe(2));
    expect(entryPatches.map((body) => body.revision)).toEqual([0, 0]);
    expect(detail.entries[0]!.content).toBe('Server entry content');

    await user.click(screen.getByRole('button', { name: 'Retry with server revision' }));
    await waitFor(() => expect(entryPatches.map((body) => body.revision)).toEqual([0, 0, 5]));
    expect(detail.entries[0]!.content).toBe('Local Worldbook draft');
  });

  it('Reload replaces the Entry draft and baseline for the next ordinary Save', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<WorldbookManagerPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Worldbook Archive Lore' }));
    await user.click(screen.getByRole('button', { name: 'Edit entry Archive' }));
    await user.clear(screen.getByLabelText('Entry content'));
    await user.type(screen.getByLabelText('Entry content'), 'Discard this local draft');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await screen.findByText(/Server revision 5/);

    await user.click(screen.getByRole('button', { name: 'Reload server version' }));
    expect((screen.getByLabelText('Entry content') as HTMLTextAreaElement).value).toBe('Server entry content');
    await user.clear(screen.getByLabelText('Entry content'));
    await user.type(screen.getByLabelText('Entry content'), 'Saved after entry Reload');
    await user.click(screen.getByRole('button', { name: 'Save Worldbook entry' }));
    await waitFor(() => expect(detail.entries[0]!.content).toBe('Saved after entry Reload'));
    expect(entryPatches.map((body) => body.revision)).toEqual([0, 5]);
  });
});
