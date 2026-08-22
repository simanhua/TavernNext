// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { ExtensionTrustPanel } from './ExtensionTrustPanel.js';

const ownerId = '018f0000-0000-7000-8000-000000002401';
let fetched = false;
let trusted = false;
let auditEvents: Array<{ event: string; createdAt: string; detail: Record<string, unknown> }> = [];

function review() {
  return {
    owner: { kind: 'character', id: ownerId },
    scripts: [{ sourceKey: 'entry', ordinal: 0, order: [0], enabled: true, name: 'Entry script' }],
    remotes: [{
      url: 'https://cdn.example/entry.js', fetched,
      fetchStatus: fetched ? 'fetched' as const : 'not_fetched' as const,
      sha256: fetched ? 'a'.repeat(64) : null,
      mediaType: fetched ? 'text/javascript' : null,
    }],
    bundleDigest: 'b'.repeat(64), trusted, sameOriginRisk: true,
    dynamicNetworkDisclaimer: 'Trusted scripts may dynamically contact other origins.',
    auditEvents,
  };
}

const server = setupServer(
  http.get('/api/extension-trust/character/:id', () => HttpResponse.json(review())),
  http.post('/api/extension-trust/character/:id/refresh', () => {
    fetched = true;
    auditEvents = [{ event: 'remote_refresh', createdAt: '2026-08-22T00:00:00.000Z', detail: {} }];
    return HttpResponse.json(review());
  }),
  http.post('/api/extension-trust/character/:id/grant', () => {
    trusted = true;
    auditEvents = [...auditEvents, { event: 'trust_granted', createdAt: '2026-08-22T00:01:00.000Z', detail: {} }];
    return HttpResponse.json(review());
  }),
  http.delete('/api/extension-trust/character/:id', () => {
    trusted = false;
    auditEvents = [...auditEvents, { event: 'trust_revoked', createdAt: '2026-08-22T00:02:00.000Z', detail: {} }];
    return HttpResponse.json(review());
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  fetched = false;
  trusted = false;
  auditEvents = [];
});
afterAll(() => server.close());

describe('ExtensionTrustPanel', () => {
  it('requires a reviewed remote entry before granting and exposes revoke audit history', async () => {
    const user = userEvent.setup();
    renderWithApp(<ExtensionTrustPanel ownerKind="character" ownerId={ownerId} />);

    expect(await screen.findByText((_text, element) => element?.tagName === 'LI' && element.textContent?.includes('Entry script') === true)).not.toBeNull();
    expect(screen.getByText('https://cdn.example/entry.js')).not.toBeNull();
    expect(screen.getByText('Same-origin scripts can access TavernNext and parent page data.')).not.toBeNull();
    expect(screen.getByText('Trusted scripts may dynamically contact other origins.')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Grant trust' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Refresh remote entries' }));
    await waitFor(() => expect(screen.getByText('a'.repeat(64))).not.toBeNull());
    expect((screen.getByRole('button', { name: 'Grant trust' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Grant trust' }));
    expect(await screen.findByText('Trusted')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke trust' }));
    expect(await screen.findByText((_text, element) => element?.tagName === 'LI'
      && element.textContent?.includes('trust_revoked') === true
      && element.textContent.includes('2026-08-22T00:02:00.000Z'))).not.toBeNull();
    expect(screen.getByText('Not trusted')).not.toBeNull();
  });

  it('shows the failed fetch result and audit returned with a refresh error', async () => {
    server.use(http.post('/api/extension-trust/character/:id/refresh', () => HttpResponse.json({
      error: 'remote_fetch_failed',
      review: {
        ...review(),
        remotes: [{
          url: 'https://cdn.example/entry.js', fetched: false, fetchStatus: 'failed',
          sha256: 'c'.repeat(64), mediaType: 'text/javascript',
        }],
        auditEvents: [{ event: 'remote_fetch_failed', createdAt: '2026-08-22T00:03:00.000Z', detail: {} }],
      },
    }, { status: 502 })));
    const user = userEvent.setup();
    renderWithApp(<ExtensionTrustPanel ownerKind="character" ownerId={ownerId} />);

    await user.click(await screen.findByRole('button', { name: 'Refresh remote entries' }));
    expect(await screen.findByText('Failed')).not.toBeNull();
    expect(screen.getByText((_text, element) => element?.tagName === 'LI'
      && element.textContent?.includes('remote_fetch_failed') === true)).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('remote_fetch_failed');
  });
});
