// @vitest-environment jsdom
import type { SceneStatusRailModel } from '@tavernnext/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSceneStatusRail } from './status-rail.js';

const model: SceneStatusRailModel = {
  overline: 'Scene State',
  title: '<Traveler>',
  ariaLabel: 'Test status',
  closeLabel: 'Close test status',
  tabs: [
    {
      id: 'status', label: 'Status', sections: [
        { kind: 'identity', title: '<Traveler>', subtitle: 'Explorer', badge: { label: 'LV', value: '2' } },
        { kind: 'fields', fields: [{ label: 'Place', value: '<script>bad()</script>' }] },
        { kind: 'meters', meters: [{ label: 'Health', value: 75, maximum: 100, tone: 'hp' }] },
        {
          kind: 'stats', title: 'Attributes', stats: [{
            label: 'Power', value: '3', action: { id: 'increase:power', label: '+', ariaLabel: 'Increase power' },
          }],
        },
      ],
    },
    {
      id: 'items', label: 'Items', sections: [{
        kind: 'cards', cards: [{ title: 'Potion', fields: [{ label: 'Count', value: '2' }] }], emptyText: 'Empty',
      }],
    },
  ],
};

beforeEach(() => { document.body.replaceChildren(); });

describe('Scene SDK status rail', () => {
  it('renders a Scene-owned model safely and switches tabs', () => {
    const container = document.createElement('div');
    const trigger = document.createElement('button');
    document.body.append(container, trigger);
    const onTabChange = vi.fn();
    const controller = mountSceneStatusRail({ container, trigger, model, onTabChange });

    expect(container.textContent).toContain('<Traveler>');
    expect(container.textContent).toContain('<script>bad()</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector<HTMLElement>('.tn-status-rail-meter-track i')?.style.width).toBe('75%');
    container.querySelector<HTMLButtonElement>('[data-tn-status-rail-tab="items"]')?.click();
    expect(onTabChange).toHaveBeenCalledWith('items');
    expect(container.textContent).toContain('Potion');
    controller.destroy();
  });

  it('owns actions, responsive open state, Escape close, and focus restoration', async () => {
    const container = document.createElement('div');
    const trigger = document.createElement('button');
    const onAction = vi.fn();
    document.body.append(container, trigger);
    const controller = mountSceneStatusRail({ container, trigger, model, onAction });

    trigger.click();
    expect(container.classList.contains('tn-status-rail-open')).toBe(true);
    container.querySelector<HTMLButtonElement>('[data-tn-status-rail-action="increase:power"]')?.click();
    await Promise.resolve();
    expect(onAction).toHaveBeenCalledWith('increase:power');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(container.classList.contains('tn-status-rail-open')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    controller.destroy();
    expect(container.querySelector('.tn-status-rail')).toBeNull();
  });
});
