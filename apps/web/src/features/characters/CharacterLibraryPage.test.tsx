// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { CharacterLibraryPage } from './CharacterLibraryPage.js';

const now = '2026-08-08T00:00:00.000Z';
const id = '018f0000-0000-7000-8000-000000000901';
const worldbookId = '018f0000-0000-7000-8000-000000000902';

const summary = {
  id, revision: 0, createdAt: now, updatedAt: now, name: 'Aster',
  avatarUrl: `/api/characters/${id}/avatar`,
  compatibilitySummary: { sourceFormat: 'st-character-v3', warnings: ['future_field_preserved'], unknownFieldCount: 3 },
};
const otherSummary = { ...summary, id: '018f0000-0000-7000-8000-000000000909', name: 'Bramble' };
let detail = {
  ...summary,
  description: 'Archivist', personality: 'Patient', scenario: 'Old library', firstMessage: 'Welcome.',
  examples: '<START>\nAster: Hello', systemPrompt: 'Stay in character.', postHistoryInstructions: 'Remain concise.',
  creatorNotes: 'Synthetic fixture', creator: 'TavernNext', characterVersion: '1.0', depthPrompt: 'Remember the key.',
  alternateGreetings: ['Welcome.', 'You found the archive.'], tags: ['lore', 'helper'], worldbookId,
  attachedExtensions: {
    execution: 'not_executed',
    counts: { regex: 12, scripts: 6, folders: 0, variableContainers: 1 },
    resources: [
      { type: 'regex', order: [0], sourceKey: 'regex-one', name: 'Hide state', enabled: true, diagnostics: [] },
      { type: 'script', order: [0], sourceKey: 'script-one', name: 'MVU bootstrap', enabled: false, diagnostics: ['script_content_missing'] },
    ],
    variables: [{ source: 'tavern_helper.variables', keyCount: 2, diagnostics: [] }],
    diagnostics: ['script_content_missing'],
  },
};
let patchCalls = 0;
let lastPatch: Record<string, unknown> | undefined;
let exportCalls = 0;
let deleteCalls = 0;
let avatarCalls = 0;
let conflictOnce = false;

const server = setupServer(
  http.get('/api/characters', () => HttpResponse.json([summary, otherSummary])),
  http.get('/api/characters/:id', () => HttpResponse.json(detail)),
  http.patch('/api/characters/:id', async ({ request }) => {
    patchCalls += 1;
    const body = await request.json() as { revision: number; patch: Record<string, unknown> };
    lastPatch = body.patch;
    expect(body.patch).not.toHaveProperty('compatibility');
    expect(body.patch).not.toHaveProperty('avatarPath');
    if (conflictOnce) {
      conflictOnce = false;
      detail = { ...detail, revision: 2, description: 'Server description' };
      return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    }
    detail = { ...detail, ...body.patch, revision: body.revision + 1 };
    if (body.patch.worldbookId === null) delete (detail as Partial<typeof detail>).worldbookId;
    return HttpResponse.json(detail);
  }),
  http.delete('/api/characters/:id', () => {
    deleteCalls += 1;
    return new HttpResponse(null, { status: 204 });
  }),
  http.put('/api/characters/:id/avatar', async ({ request }) => {
    avatarCalls += 1;
    const file = (await request.formData()).get('file');
    expect(file !== null && typeof file !== 'string' && file.name === 'portrait.png').toBe(true);
    detail = { ...detail, revision: detail.revision + 1, avatarUrl: `/api/characters/${id}/avatar?v=1` };
    return HttpResponse.json(detail);
  }),
  http.get('/api/characters/:id/export', ({ request }) => {
    expect(new URL(request.url).searchParams.get('format')).toBe('json-v3');
    exportCalls += 1;
    return new HttpResponse('{"spec":"chara_card_v3"}', {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="character.json"; filename*=UTF-8\'\'Aster%20Card.json',
      },
    });
  }),
  http.get('/api/worldbooks', () => HttpResponse.json([{ id: worldbookId, revision: 0, name: 'Archive Lore', enabled: true, entryCount: 2 }])),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  detail = {
    ...summary,
    description: 'Archivist', personality: 'Patient', scenario: 'Old library', firstMessage: 'Welcome.',
    examples: '<START>\nAster: Hello', systemPrompt: 'Stay in character.', postHistoryInstructions: 'Remain concise.',
    creatorNotes: 'Synthetic fixture', creator: 'TavernNext', characterVersion: '1.0', depthPrompt: 'Remember the key.',
    alternateGreetings: ['Welcome.', 'You found the archive.'], tags: ['lore', 'helper'], worldbookId,
    attachedExtensions: {
      execution: 'not_executed',
      counts: { regex: 12, scripts: 6, folders: 0, variableContainers: 1 },
      resources: [
        { type: 'regex', order: [0], sourceKey: 'regex-one', name: 'Hide state', enabled: true, diagnostics: [] },
        { type: 'script', order: [0], sourceKey: 'script-one', name: 'MVU bootstrap', enabled: false, diagnostics: ['script_content_missing'] },
      ],
      variables: [{ source: 'tavern_helper.variables', keyCount: 2, diagnostics: [] }],
      diagnostics: ['script_content_missing'],
    },
  };
  patchCalls = 0;
  lastPatch = undefined;
  exportCalls = 0;
  deleteCalls = 0;
  avatarCalls = 0;
  conflictOnce = false;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('CharacterLibraryPage', () => {
  it('shows a safe ordered Attached Extension Resource inventory without exposing code', async () => {
    const user = userEvent.setup();
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));

    expect(screen.getByRole('heading', { name: 'Attached Extension Resources' })).not.toBeNull();
    expect(screen.getByText('12 regexes')).not.toBeNull();
    expect(screen.getByText('6 scripts')).not.toBeNull();
    expect(screen.getByText('1 variable container')).not.toBeNull();
    expect(screen.getByText('#1 · Regex · Hide state · Enabled')).not.toBeNull();
    expect(screen.getByText('#1 · Script · MVU bootstrap · Disabled')).not.toBeNull();
    expect(screen.getAllByText('script_content_missing').length).toBeGreaterThan(0);
    expect(screen.queryByText(/globalThis|function|import\s*\(/)).toBeNull();
  });

  it('round-trips comma-containing Character tags without changing their elements', async () => {
    const user = userEvent.setup();
    detail = { ...detail, tags: ['lore, mystery', 'helper'] };
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));
    await user.click(screen.getByRole('button', { name: 'Save Character' }));

    await waitFor(() => expect(patchCalls).toBe(0));
    expect(detail.tags).toEqual(['lore, mystery', 'helper']);
  });

  it('sends only changed allowlisted Character fields and omits unchanged arrays', async () => {
    const user = userEvent.setup();
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));
    await user.clear(screen.getByLabelText('Description'));
    await user.type(screen.getByLabelText('Description'), 'Only this field changed');
    await user.click(screen.getByRole('button', { name: 'Save Character' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(lastPatch).toEqual({ description: 'Only this field changed' });
  });

  it('filters the bounded Character list without losing the original results', async () => {
    const user = userEvent.setup();
    renderWithApp(<CharacterLibraryPage />);
    expect(await screen.findByRole('button', { name: 'Aster' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Bramble' })).not.toBeNull();

    await user.type(screen.getByLabelText('Search Characters'), 'bram');
    expect(screen.queryByRole('button', { name: 'Aster' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Bramble' })).not.toBeNull();
    await user.clear(screen.getByLabelText('Search Characters'));
    expect(screen.getByRole('button', { name: 'Aster' })).not.toBeNull();
  });

  it('edits every standard field and keeps alternate greetings stable while reordering', async () => {
    const user = userEvent.setup();
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));
    expect((screen.getByRole('img', { name: 'Aster avatar' }) as HTMLImageElement).src).toContain(`/api/characters/${id}/avatar`);

    for (const label of [
      'Name', 'Description', 'Personality', 'Scenario', 'First message', 'Message examples', 'Creator notes',
      'Creator', 'Character version', 'System prompt', 'Post-history instructions', 'Depth prompt', 'Tags',
    ]) expect(screen.getByLabelText(label)).not.toBeNull();
    expect(screen.getByText('st-character-v3')).not.toBeNull();
    expect(screen.getByText('future_field_preserved')).not.toBeNull();
    expect(screen.queryByText('rawPayload')).toBeNull();

    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Keeper of a quiet archive');
    await user.selectOptions(screen.getByLabelText('Worldbook'), '');
    await user.click(screen.getByRole('button', { name: 'Move alternate greeting 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Add alternate greeting' }));
    await user.type(screen.getByLabelText('Alternate greeting 3'), 'A third opening.');
    await user.click(screen.getByRole('button', { name: 'Save Character' }));

    await waitFor(() => expect(patchCalls).toBe(1));
    expect(detail.description).toBe('Keeper of a quiet archive');
    expect(detail.worldbookId).toBeUndefined();
    expect(detail.alternateGreetings).toEqual(['You found the archive.', 'Welcome.', 'A third opening.']);
  });

  it('preserves the local draft on 409 and retries only after showing the server revision', async () => {
    const user = userEvent.setup();
    conflictOnce = true;
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));
    const description = screen.getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Local unsaved description');
    await user.click(screen.getByRole('button', { name: 'Save Character' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Server revision 2');
    expect((description as HTMLTextAreaElement).value).toBe('Local unsaved description');
    await user.click(screen.getByRole('button', { name: 'Retry with server revision' }));
    await waitFor(() => expect(patchCalls).toBe(2));
    expect(detail.description).toBe('Local unsaved description');
  });

  it('uploads avatars, exports with the server filename and MIME, and deletes revision-safely', async () => {
    const user = userEvent.setup();
    let downloadedName = '';
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:character') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      downloadedName = this.download;
    });
    renderWithApp(<CharacterLibraryPage />);
    await user.click(await screen.findByRole('button', { name: 'Aster' }));

    await user.upload(screen.getByLabelText('Avatar file'), new File(['png'], 'portrait.png', { type: 'image/png' }));
    await waitFor(() => expect(avatarCalls).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Export JSON V3' }));
    await waitFor(() => expect(exportCalls).toBe(1));
    expect(downloadedName).toBe('Aster Card.json');
    expect(screen.getByText(/application\/json/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete Character' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete Character' }));
    await waitFor(() => expect(deleteCalls).toBe(1));
  });
});
