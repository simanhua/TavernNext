// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneLibraryPage } from './SceneLibraryPage.js';

const sceneId = '018f2000-0000-7000-8000-000000000001';
let installed = false;
const catalog = {
  sceneId, version: '2.0.0', packageUrl: 'builtin:destined-poem', archiveSha256: 'a'.repeat(64),
  minimumTavernNextVersion: '1.0.0', name: '命定之诗与黄昏之歌', summary: '命运场景', author: 'The Poem of Destiny',
};
const installedScene = {
  id: sceneId, revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  slug: 'destined-poem', version: '2.0.0', archiveDigest: 'a'.repeat(64), installPath: 'scenes/test',
  installedAt: new Date().toISOString(), backingCharacterId: '018f2000-0000-7000-8000-000000000002',
  manifest: { id: sceneId, slug: 'destined-poem', version: '2.0.0', name: catalog.name, summary: catalog.summary, description: '', author: catalog.author, minimumTavernNextVersion: '1.0.0', sceneSdkVersion: 2, frontendEntry: 'frontend/app.js', frontendStyles: ['frontend/styles.css'], setupSchema: {}, stateSchema: {}, files: ['frontend/app.js', 'frontend/styles.css'] },
  conversationCount: 0, messageCount: 0, fullyTrusted: true, trustNotice: 'trusted',
};
const server = setupServer(
  http.get('/api/scenes', () => HttpResponse.json(installed ? [installedScene] : [])),
  http.get('/api/scenes/catalog', () => HttpResponse.json([{ ...catalog, installed }])),
  http.post(`/api/scenes/${sceneId}/install`, () => { installed = true; return HttpResponse.json(installedScene, { status: 201 }); }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); installed = false; });
afterAll(() => server.close());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SceneLibraryPage /></QueryClientProvider></MemoryRouter>);
}

describe('SceneLibraryPage', () => {
  it('installs an official Scene and promotes it into the card library', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('heading', { name: '命定之诗与黄昏之歌' })).not.toBeNull();
    await user.click(screen.getByRole('button', { name: '安装官方场景' }));
    expect(await screen.findByText('0 个存档')).not.toBeNull();
    expect(screen.getByRole('link', { name: /命定之诗与黄昏之歌/ })).not.toBeNull();
  });
});
