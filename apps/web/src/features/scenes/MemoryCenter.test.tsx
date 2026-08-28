// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { MemoryCenter } from './MemoryCenter.js';

const conversationId = '018f0000-0000-7000-8000-000000000911';
const memoryId = '018f0000-0000-7000-8000-000000000912';
const now = '2026-08-28T00:00:00.000Z';
let patched: unknown;
let rebuilt = false;

const memory = {
  id: memoryId, revision: 0, createdAt: now, updatedAt: now, conversationId,
  kind: 'commitment', tier: 'near', summary: 'Aster will return before dawn.', detail: '',
  entities: [], salience: 1, confidence: 0.9,
  sourceMessageId: null, sourceVariantId: null, sourceTransitionId: null, sourceAgentRunId: null,
  sourceMemoryIds: [], supersedesId: null, contentHash: 'a'.repeat(64), tokenCount: 8,
  pinned: false, excluded: false, status: 'active',
};

const server = setupServer(
  http.get(`/api/conversations/${conversationId}/memories`, () => HttpResponse.json({
    configuration: { id: '018f0000-0000-7000-8000-000000000913', revision: 0, createdAt: now, updatedAt: now, conversationId, enabled: true, disabledAt: null },
    memories: [memory], jobs: [], embedding: { enabled: false, configured: false, model: null, dimensions: null },
  })),
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
afterEach(() => { cleanup(); patched = undefined; rebuilt = false; });
afterAll(() => server.close());

describe('MemoryCenter', () => {
  it('shows Save Memory and exposes pin and rebuild controls', async () => {
    const user = userEvent.setup();
    renderWithApp(<MemoryCenter conversationId={conversationId} />);

    expect(await screen.findByText('Aster will return before dawn.')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(patched).toEqual({ revision: 0, pinned: true, excluded: false }));
    await user.click(screen.getByRole('button', { name: 'Rebuild index' }));
    await waitFor(() => expect(rebuilt).toBe(true));
  });
});
