// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// Scene browser assets intentionally stay framework-free and ship as native ES modules.
// @ts-expect-error The runtime asset has no declaration file.
import { bindDestinedPoemWorldMap, renderDestinedPoemWorldMap } from '../assets/official-scenes/destined-poem/frontend/map-viewer.mjs';

const marker = (
  id: string,
  name: string,
  group: string,
  nx: number,
  ny: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  group,
  description: `${name}的说明`,
  color: '#63d7df',
  icon: 'fa-solid fa-location-dot',
  position: { nx, ny },
  imageUrls: [],
  ...extra,
});

const state = {
  世界: { 地点: '大陆东南部区域-索伦蒂斯王国-银帆城-晨曦区', 时间: '清晨' },
  地图: {
    标记: [
      marker('kingdom', '索伦蒂斯王国', '国家', .25, .45),
      marker('city', '银帆城', '城市', .4, .55),
      marker('ruin', '灰烬遗迹', '遗迹', .7, .25, {
        description: '<img src=x onerror=alert(1)>灰烬中的旧王城',
        imageUrls: ['https://images.example/ruin.webp', 'javascript:alert(2)'],
      }),
    ],
  },
};

describe('Destined Poem native world map', () => {
  it('ships the native viewer and all 91 original-card markers in the official Scene Package', () => {
    const root = resolve('apps/server/assets/official-scenes/destined-poem');
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
    const initialState = JSON.parse(readFileSync(resolve(root, 'content/initial-state.json'), 'utf8'));
    const host = document.createElement('div');
    host.innerHTML = renderDestinedPoemWorldMap(initialState);

    expect(manifest.version).toBe('2.17.2');
    expect(manifest.files).toContain('frontend/map-viewer.mjs');
    expect(manifest.files).toContain('frontend/map-viewer.css');
    expect(manifest.frontendStyles).toContain('frontend/map-viewer.css');
    expect(host.querySelectorAll('[data-map-marker-id]')).toHaveLength(91);
  });

  it('renders every Save-local marker and highlights the deepest current-location match', () => {
    const html = renderDestinedPoemWorldMap(state);
    const host = document.createElement('div');
    host.innerHTML = html;

    expect(host.querySelectorAll('[data-map-marker-id]')).toHaveLength(3);
    expect(host.querySelector('[data-map-marker-id="city"]')?.getAttribute('data-current')).toBe('true');
    expect(host.querySelector('[data-map-marker-id="kingdom"]')?.getAttribute('data-current')).toBe('false');
    expect(host.textContent).toContain('当前位置 · 大陆东南部区域-索伦蒂斯王国-银帆城-晨曦区');
  });

  it('filters markers and opens an escaped detail gallery through the map interface', () => {
    const host = document.createElement('div');
    host.innerHTML = renderDestinedPoemWorldMap(state);
    const cleanup = bindDestinedPoemWorldMap(host);

    const search = host.querySelector<HTMLInputElement>('[data-map-search]')!;
    search.value = '灰烬';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.querySelector<HTMLButtonElement>('[data-map-marker-id="ruin"]')!.hidden).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-map-marker-id="city"]')!.hidden).toBe(true);
    expect(host.querySelector('[data-map-result-count]')?.textContent).toBe('1 / 3');

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const group = host.querySelector<HTMLSelectElement>('[data-map-group-filter]')!;
    group.value = '城市';
    group.dispatchEvent(new Event('change', { bubbles: true }));
    expect(host.querySelector<HTMLButtonElement>('[data-map-marker-id="city"]')!.hidden).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-map-marker-id="ruin"]')!.hidden).toBe(true);

    group.value = '';
    group.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-map-marker-id="ruin"]')!.click();
    const detail = host.querySelector<HTMLElement>('[data-map-detail]')!;
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('灰烬中的旧王城');
    expect(detail.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(detail.querySelectorAll('img')).toHaveLength(1);
    expect(detail.querySelector('img')?.getAttribute('src')).toBe('https://images.example/ruin.webp');
    expect(detail.querySelector('script')).toBeNull();

    cleanup();
  });

  it('pans, zooms, resets, and switches the fixed map source without changing Scene State', () => {
    const host = document.createElement('div');
    host.innerHTML = renderDestinedPoemWorldMap(state);
    const cleanup = bindDestinedPoemWorldMap(host);
    const stage = host.querySelector<HTMLElement>('[data-map-stage]')!;
    const content = host.querySelector<HTMLElement>('[data-map-content]')!;
    const image = host.querySelector<HTMLImageElement>('[data-map-image]')!;

    const pointer = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 }, clientX: { value: x }, clientY: { value: y }, pointerId: { value: 1 },
      });
      stage.dispatchEvent(event);
    };
    pointer('pointerdown', 20, 30);
    pointer('pointermove', 80, 90);
    pointer('pointerup', 80, 90);
    expect(content.style.transform).toContain('translate3d(60px, 60px, 0)');

    const zoom = host.querySelector<HTMLSelectElement>('[data-map-zoom]')!;
    const source = host.querySelector<HTMLSelectElement>('[data-map-source]')!;
    source.value = 'high';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    expect(image.src).toBe('https://i.ibb.co/xK5pckf7/Map-4161-P.avif');
    expect(zoom.value).toBe('1');
    expect(content.dataset.mapScale).toBe('1');
    expect(content.style.transform).toContain('translate3d(60px, 60px, 0)');

    zoom.value = 'reset';
    zoom.dispatchEvent(new Event('change', { bubbles: true }));
    expect(content.dataset.mapScale).toBe('1');
    expect(content.style.transform).toContain('translate3d(0px, 0px, 0) scale(1)');

    zoom.value = '1.25';
    zoom.dispatchEvent(new Event('change', { bubbles: true }));
    expect(content.dataset.mapScale).toBe('1.25');
    expect(content.style.transform).toContain('scale(1.25)');
    zoom.value = '1';
    zoom.dispatchEvent(new Event('change', { bubbles: true }));
    expect(content.dataset.mapScale).toBe('1');
    expect(content.style.transform).toContain('translate3d(0px, 0px, 0) scale(1)');

    cleanup();
  });
});
