// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { MemoryCenter } from './MemoryCenter.js';

const conversationId = '018f0000-0000-7000-8000-000000000911';
const memoryId = '018f0000-0000-7000-8000-000000000912';
const now = '2026-08-28T00:00:00.000Z';
let patched: unknown;
let rebuilt = false;
let requestedPages: number[] = [];

const memory = {
  id: memoryId, revision: 0, createdAt: now, updatedAt: now, conversationId,
  kind: 'commitment', tier: 'near', summary: 'Aster will return before dawn.', detail: '',
  entities: [], salience: 1, confidence: 0.9,
  sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
  sourceMemoryIds: [], supersedesId: null, contentHash: 'a'.repeat(64), tokenCount: 8,
  pinned: false, excluded: false, status: 'active',
};
const secondMemory = { ...memory, id: '018f0000-0000-7000-8000-000000000915', summary: 'The second memory page.' };

const server = setupServer(
  http.get(`/api/conversations/${conversationId}/memories`, ({ request }) => {
    const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
    requestedPages.push(page);
    return HttpResponse.json({
      configuration: { id: '018f0000-0000-7000-8000-000000000913', revision: 0, createdAt: now, updatedAt: now, conversationId, enabled: true, disabledAt: null },
      memories: page === 1 ? [memory] : [secondMemory],
      pagination: { page, pageSize: 20, total: 2, totalPages: 2 },
      jobs: [], embedding: { enabled: false, configured: false, model: null, dimensions: null },
    });
  }),
  http.patch(`/api/memories/${memoryId}`, async ({ request }) => {
    patched = await request.json();
    return HttpResponse.json({ ...memory, revision: 1, pinned: true });
  }),
  http.post(`/api/conversations/${conversationId}/memory-index/rebuild`, () => {
    rebuilt = true;
    return HttpResponse.json({ id: '018f0000-0000-7000-8000-000000000914' }, { status: 202 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => localStorage.setItem('tavernnext.language', 'en'));
afterEach(() => { cleanup(); localStorage.clear(); patched = undefined; rebuilt = false; requestedPages = []; });
afterAll(() => server.close());

describe('MemoryCenter', () => {
  it('localizes the panel and provides an explicit close action', async () => {
    localStorage.setItem('tavernnext.language', 'zh-CN');
    const user = userEvent.setup();
    const { container } = renderWithApp(<MemoryCenter conversationId={conversationId} />);

    expect(await screen.findByText('存档记忆')).not.toBeNull();
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary svg.runtime-panel-icon')).not.toBeNull();
    details!.open = true;
    await user.click(screen.getByRole('button', { name: '关闭存档记忆' }));
    expect(details!.open).toBe(false);
  });

  it('shows Save Memory and exposes pin and rebuild controls', async () => {
    const user = userEvent.setup();
    renderWithApp(<MemoryCenter conversationId={conversationId} />);

    expect(await screen.findByText('Aster will return before dawn.')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(patched).toEqual({ revision: 0, pinned: true, excluded: false }));
    await user.click(screen.getByRole('button', { name: 'Rebuild index' }));
    await waitFor(() => expect(rebuilt).toBe(true));
  });

  it('moves between paged Save Memory results', async () => {
    const user = userEvent.setup();
    renderWithApp(<MemoryCenter conversationId={conversationId} />);

    expect(await screen.findByText('Aster will return before dawn.')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('The second memory page.')).not.toBeNull();
    expect(requestedPages).toEqual([1, 2]);
  });
});
