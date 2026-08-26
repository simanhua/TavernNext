// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SceneDetailPage } from './SceneDetailPage.js';

const sceneId = '018f2000-0000-7000-8000-000000000001';
const conversationId = '84c8e405-ee95-46f0-ad14-d43a764daabc';
const now = new Date().toISOString();
const save = {
  id: conversationId, revision: 2, createdAt: now, updatedAt: now,
  characterId: '018f2000-0000-7000-8000-000000000002',
  personaId: '018f2000-0000-7000-8000-000000000003',
  sceneId, title: '新的命运', worldbookIds: [], maxPromptTokens: 128_000, maxResponseTokens: 32_768,
  playerProfile: { name: '风信子', description: '' }, setup: { origin: '梵尼亚' },
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
};
let saves = [save];
let deleteRequests = 0;
const scene = {
  id: sceneId, revision: 6, createdAt: now, updatedAt: now, slug: 'destined-poem', version: '2.3.0',
  archiveDigest: 'a'.repeat(64), installPath: 'scenes/test', installedAt: now,
  backingCharacterId: save.characterId, backingPresetId: '018f2000-0000-7000-8000-000000000004',
  manifest: {
    id: sceneId, slug: 'destined-poem', version: '2.3.0', name: '命定之诗与黄昏之歌',
    summary: '命运场景', description: '场景详情', author: 'The Poem of Destiny',
    minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 2, frontendEntry: 'frontend/app.js',
    frontendStyles: ['frontend/styles.css'], setupSchema: {}, stateSchema: {}, files: ['frontend/app.js'],
  },
  fullyTrusted: true, trustNotice: 'trusted', messageCount: 5,
};

const server = setupServer(
  http.get(`/api/scenes/${sceneId}`, () => HttpResponse.json({ ...scene, conversationCount: saves.length })),
  http.get(`/api/scenes/${sceneId}/conversations`, () => HttpResponse.json(saves)),
  http.delete(`/api/conversations/${conversationId}`, () => {
    deleteRequests += 1;
    saves = [];
    return new HttpResponse(null, { status: 204 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  saves = [save];
  deleteRequests = 0;
});
afterAll(() => server.close());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[`/scenes/${sceneId}`]}>
      <QueryClientProvider client={client}>
        <Routes><Route path="/scenes/:sceneId" element={<SceneDetailPage />} /></Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SceneDetailPage Save deletion', () => {
  it('cancels without deleting or opening the Save', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '删除存档 新的命运' }));
    expect(deleteRequests).toBe(0);
    expect(screen.getByRole('button', { name: '删除存档 新的命运' })).not.toBeNull();
  });

  it('deletes one Save after confirmation and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await user.click(await screen.findByRole('button', { name: '删除存档 新的命运' }));
    await waitFor(() => expect(deleteRequests).toBe(1));
    expect(await screen.findByText('还没有存档，从自定义开局开始。')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '删除存档 新的命运' })).toBeNull();
  });
});
