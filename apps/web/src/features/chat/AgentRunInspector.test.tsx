// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test/render.js';
import { AgentRunInspector } from './AgentRunInspector.js';

const conversationId = '018f0000-0000-7000-8000-000000000921';
const server = setupServer(
  http.get('/api/development/agent-runs', () => HttpResponse.json([])),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); localStorage.clear(); });
afterAll(() => server.close());

describe('AgentRunInspector', () => {
  it('localizes the panel and provides an explicit close action', async () => {
    localStorage.setItem('tavernnext.language', 'zh-CN');
    const user = userEvent.setup();
    const { container } = renderWithApp(<AgentRunInspector conversationId={conversationId} />);

    expect(await screen.findByText('智能体运行检查')).not.toBeNull();
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary svg.runtime-panel-icon')).not.toBeNull();
    details!.open = true;
    await user.click(screen.getByRole('button', { name: '关闭智能体运行检查' }));
    expect(details!.open).toBe(false);
  });
});
