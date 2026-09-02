// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test/render.js';

interface PanelProps { open?: boolean; onClose?(): void }

vi.mock('./SaveAgentConfigurationPanel.js', () => ({
  SaveAgentConfigurationPanel: ({ open, onClose }: PanelProps) => (
    <section data-testid="configuration-panel" hidden={!open}><button type="button" onClick={onClose}>关闭配置</button></section>
  ),
}));
vi.mock('./MemoryCenter.js', () => ({
  MemoryCenter: ({ open, onClose }: PanelProps) => (
    <section data-testid="memory-panel" hidden={!open}><button type="button" onClick={onClose}>关闭记忆</button></section>
  ),
}));
vi.mock('../chat/AgentRunInspector.js', () => ({
  AgentRunInspector: ({ open, onClose }: PanelProps) => (
    <section data-testid="inspector-panel" hidden={!open}><button type="button" onClick={onClose}>关闭检查</button></section>
  ),
}));

import { SceneRuntimeTools } from './SceneRuntimeTools.js';

beforeEach(() => localStorage.setItem('tavernnext.language', 'zh-CN'));
afterEach(() => { cleanup(); localStorage.clear(); });

describe('SceneRuntimeTools', () => {
  it('moves all runtime panels behind one exclusive top-right menu', async () => {
    const user = userEvent.setup();
    renderWithApp(<SceneRuntimeTools conversationId="conversation-1" />);

    const trigger = screen.getByRole('button', { name: '打开存档工具' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('configuration-panel').hasAttribute('hidden')).toBe(true);

    await user.click(trigger);
    expect(screen.getByRole('menu', { name: '存档工具' })).not.toBeNull();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '存档智能体配置›', '智能体运行检查›', '存档记忆›',
    ]);
    await user.click(screen.getByRole('menuitem', { name: '存档智能体配置' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('configuration-panel').hasAttribute('hidden')).toBe(false);

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '存档记忆' }));
    expect(screen.getByTestId('configuration-panel').hasAttribute('hidden')).toBe(true);
    expect(screen.getByTestId('memory-panel').hasAttribute('hidden')).toBe(false);
    await user.click(screen.getByRole('button', { name: '关闭记忆' }));
    expect(screen.getByTestId('memory-panel').hasAttribute('hidden')).toBe(true);

    await user.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
