const MAP_SOURCES = Object.freeze({
  low: Object.freeze({ label: '低清', url: 'https://i.ibb.co/gF7WXfmp/Map-2774-P.avif' }),
  high: Object.freeze({ label: '高清', url: 'https://i.ibb.co/xK5pckf7/Map-4161-P.avif' }),
  ultra: Object.freeze({ label: '超清', url: 'https://i.ibb.co/wF37W2MR/Map-8322-P.avif' }),
});
const ZOOM_LEVELS = Object.freeze(Array.from({ length: 21 }, (_value, index) => 1 + index * .25));

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const normalizeMapCoordinate = (value, fallback = .5) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
};

function markersFromState(state) {
  const source = Array.isArray(state?.地图?.标记) ? state.地图.标记 : [];
  return source.map((raw, index) => ({
    id: String(raw?.id ?? `marker-${index}`),
    name: String(raw?.name ?? raw?.名称 ?? `地点 ${index + 1}`),
    group: String(raw?.group ?? raw?.分组 ?? '未分组'),
    description: String(raw?.description ?? raw?.描述 ?? ''),
    color: /^#[0-9a-f]{3,8}$/i.test(String(raw?.color ?? '')) ? String(raw.color) : '#63d7df',
    position: {
      nx: normalizeMapCoordinate(raw?.position?.nx),
      ny: normalizeMapCoordinate(raw?.position?.ny),
    },
    imageUrls: Array.isArray(raw?.imageUrls) ? raw.imageUrls.map(String) : [],
  }));
}

function currentMarkerId(markers, location) {
  const path = String(location);
  const matches = markers.flatMap((marker) => {
    const position = marker.name === '' ? -1 : path.lastIndexOf(marker.name);
    return position < 0 ? [] : [{ marker, position }];
  });
  return matches.sort((left, right) => (
    right.position - left.position || right.marker.name.length - left.marker.name.length
  ))[0]?.marker.id ?? '';
}

const safeJson = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll('>', '\\u003e')
  .replaceAll('&', '\\u0026');

const safeImageUrl = (value) => {
  const source = String(value ?? '').trim();
  return /^(?:https:\/\/|\/)/i.test(source) ? source : '';
};

export function renderDestinedPoemWorldMap(state) {
  const markers = markersFromState(state);
  const location = String(state?.世界?.地点 ?? '未知区域');
  const currentId = currentMarkerId(markers, location);
  const groups = [...new Set(markers.map((marker) => marker.group))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  return `<section class="poem-world-map" aria-label="阿斯塔利亚世界地图">
    <header class="poem-world-map-heading"><div><span>World Atlas</span><h1>阿斯塔利亚世界地图</h1></div><p>当前位置 · ${escapeHtml(location)}</p></header>
    <div class="poem-world-map-toolbar">
      <label><span>搜索地点</span><input type="search" placeholder="名称、分组或说明" data-map-search></label>
      <label><span>分组</span><select data-map-group-filter><option value="">全部分组</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('')}</select></label>
      <label><span>地图精度</span><select data-map-source>${Object.entries(MAP_SOURCES).map(([key, source]) => `<option value="${key}">${source.label}</option>`).join('')}</select></label>
      <label><span>缩放 / 复位</span><select data-map-zoom><option value="reset">复位视图</option>${ZOOM_LEVELS.map((scale) => `<option value="${scale}"${scale === 1 ? ' selected' : ''}>${Math.round(scale * 100)}%</option>`).join('')}</select></label>
      <output data-map-result-count>${markers.length} / ${markers.length}</output>
    </div>
    <div class="poem-world-map-layout">
      <div class="poem-world-map-stage" data-map-stage>
        <div class="poem-world-map-content" data-map-content>
          <img src="${MAP_SOURCES.low.url}" alt="阿斯塔利亚世界地图" draggable="false" data-map-image>
          ${markers.map((marker) => `<button type="button" class="poem-world-map-marker" data-map-marker-id="${escapeHtml(marker.id)}" data-map-group="${escapeHtml(marker.group)}" data-current="${marker.id === currentId}" style="--marker-x:${marker.position.nx * 100}%;--marker-y:${marker.position.ny * 100}%;--marker-color:${marker.color}" aria-label="${escapeHtml(marker.name)}"><i></i><span>${escapeHtml(marker.name)}</span></button>`).join('')}
        </div>
      </div>
      <aside class="poem-world-map-workbench">
        <div class="poem-world-map-list" data-map-list>${markers.map((marker) => `<button type="button" data-map-list-marker-id="${escapeHtml(marker.id)}"><span>${escapeHtml(marker.name)}</span><small>${escapeHtml(marker.group)}</small></button>`).join('')}</div>
        <article class="poem-world-map-detail" data-map-detail hidden><button type="button" aria-label="关闭地点详情" data-map-detail-close>×</button><span data-map-detail-group></span><h2 data-map-detail-name></h2><p data-map-detail-description></p><div data-map-detail-gallery></div></article>
      </aside>
    </div>
    <script type="application/json" data-map-data>${safeJson({ markers, currentId })}</script>
  </section>`;
}

export function bindDestinedPoemWorldMap(container) {
  const root = container.querySelector('.poem-world-map');
  if (root === null) return () => undefined;
  let data;
  try {
    data = JSON.parse(root.querySelector('[data-map-data]')?.textContent ?? '{}');
  } catch {
    return () => undefined;
  }
  const markers = Array.isArray(data.markers) ? data.markers : [];
  const markerById = new Map(markers.map((marker) => [String(marker.id), marker]));
  const search = root.querySelector('[data-map-search]');
  const group = root.querySelector('[data-map-group-filter]');
  const source = root.querySelector('[data-map-source]');
  const zoom = root.querySelector('[data-map-zoom]');
  const count = root.querySelector('[data-map-result-count]');
  const detail = root.querySelector('[data-map-detail]');
  const stage = root.querySelector('[data-map-stage]');
  const content = root.querySelector('[data-map-content]');
  const image = root.querySelector('[data-map-image]');
  const indexedButtons = (selector, attribute) => new Map([...root.querySelectorAll(selector)]
    .map((button) => [button.getAttribute(attribute), button]));
  const markerButtons = indexedButtons('[data-map-marker-id]', 'data-map-marker-id');
  const listButtons = indexedButtons('[data-map-list-marker-id]', 'data-map-list-marker-id');
  const listeners = [];
  const view = { x: 0, y: 0, scale: 1 };
  let drag;
  const listen = (target, type, listener) => {
    target?.addEventListener(type, listener);
    if (target !== null) listeners.push(() => target.removeEventListener(type, listener));
  };

  const applyFilter = () => {
    const keyword = String(search?.value ?? '').trim().toLocaleLowerCase('zh-CN');
    const selectedGroup = String(group?.value ?? '');
    let visible = 0;
    for (const marker of markers) {
      const matchesGroup = selectedGroup === '' || marker.group === selectedGroup;
      const haystack = `${marker.name}\n${marker.group}\n${marker.description}`.toLocaleLowerCase('zh-CN');
      const matchesSearch = keyword === '' || haystack.includes(keyword);
      const hidden = !matchesGroup || !matchesSearch;
      markerButtons.get(String(marker.id))?.toggleAttribute('hidden', hidden);
      listButtons.get(String(marker.id))?.toggleAttribute('hidden', hidden);
      if (!hidden) visible += 1;
    }
    if (count !== null) count.textContent = `${visible} / ${markers.length}`;
  };

  const applyView = () => {
    if (content === null) return;
    if (zoom !== null) zoom.value = String(view.scale);
    content.dataset.mapScale = String(view.scale);
    content.style.setProperty('--map-inverse-scale', String(1 / view.scale));
    content.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
  };

  const setScale = (nextScale, originX = 0, originY = 0) => {
    const scale = Math.max(1, Math.min(6, Math.round(nextScale * 100) / 100));
    if (scale === view.scale) return;
    const ratio = scale / view.scale;
    view.x = originX - (originX - view.x) * ratio;
    view.y = originY - (originY - view.y) * ratio;
    view.scale = scale;
    applyView();
  };

  const resetView = () => {
    view.x = 0;
    view.y = 0;
    view.scale = 1;
    applyView();
  };

  const showMarker = (id) => {
    const marker = markerById.get(String(id));
    if (marker === undefined || detail === null) return;
    detail.hidden = false;
    detail.querySelector('[data-map-detail-group]').textContent = marker.group;
    detail.querySelector('[data-map-detail-name]').textContent = marker.name;
    detail.querySelector('[data-map-detail-description]').textContent = marker.description || '暂无地点说明';
    const gallery = detail.querySelector('[data-map-detail-gallery]');
    gallery.replaceChildren(...marker.imageUrls.flatMap((rawUrl) => {
      const url = safeImageUrl(rawUrl);
      if (url === '') return [];
      const image = document.createElement('img');
      image.src = url;
      image.alt = `${marker.name} 地点图片`;
      image.loading = 'lazy';
      return [image];
    }));
    root.querySelectorAll('[data-map-marker-id]').forEach((button) => {
      button.toggleAttribute('data-selected', button.getAttribute('data-map-marker-id') === String(marker.id));
    });
  };

  listen(search, 'input', applyFilter);
  listen(group, 'change', applyFilter);
  listen(source, 'change', () => {
    const selected = MAP_SOURCES[String(source.value)] ?? MAP_SOURCES.low;
    if (image !== null) image.src = selected.url;
  });
  listen(zoom, 'change', () => {
    if (zoom.value === 'reset') {
      resetView();
      return;
    }
    const next = Number(zoom.value);
    if (next === 1) resetView();
    else setScale(next);
  });
  listen(stage, 'wheel', (event) => {
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    setScale(view.scale + (event.deltaY < 0 ? .25 : -.25), event.clientX - rect.left, event.clientY - rect.top);
  });
  listen(stage, 'pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest?.('button')) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture?.(event.pointerId);
    stage.toggleAttribute('data-dragging', true);
  });
  listen(stage, 'pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    view.x += event.clientX - drag.x;
    view.y += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    applyView();
  });
  const stopDrag = (event) => {
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    stage.releasePointerCapture?.(event.pointerId);
    drag = undefined;
    stage.toggleAttribute('data-dragging', false);
  };
  listen(stage, 'pointerup', stopDrag);
  listen(stage, 'pointercancel', stopDrag);
  const bindMarkerEntrypoints = (selector, attribute) => {
    root.querySelectorAll(selector).forEach((button) => {
      listen(button, 'click', () => showMarker(button.getAttribute(attribute)));
    });
  };
  bindMarkerEntrypoints('[data-map-marker-id]', 'data-map-marker-id');
  bindMarkerEntrypoints('[data-map-list-marker-id]', 'data-map-list-marker-id');
  listen(root.querySelector('[data-map-detail-close]'), 'click', () => { detail.hidden = true; });

  applyView();

  return () => listeners.splice(0).forEach((remove) => remove());
}
