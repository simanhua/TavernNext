let root;
import { bindDestinedPoemMessageBlocks, renderDestinedPoemMessage } from './message-blocks.mjs?v=2.15.0';
import { bindDestinedPoemWorldMap, renderDestinedPoemWorldMap } from './map-viewer.mjs?v=2.16.4';
import { bindDestinedPoemDetails, renderDestinedPoemDetailDialog, renderDestinedPoemDetailRow } from './details.mjs?v=2.17.0';
import { attributeAllocationAction } from './status-rail.mjs?v=2.15.0';
import {
  DESTINED_POEM_OPENINGS,
  destinedPoemOpeningOptionsMarkup,
  renderDestinedPoemSetup,
} from './setup.mjs?v=2.15.0';

export { DESTINED_POEM_OPENINGS, destinedPoemOpeningOptionsMarkup };

let sdk;
let context;
let activeTab = 'chat';
let generationView = { status: 'idle', streamedText: '', streamedReasoning: '', error: null };
let mapCleanup;
let speechInputController;
const openSidebarSections = new Set(['attributes', 'effects', 'equipment', 'skills', 'inventory', 'quests']);

export const DESTINED_POEM_THEMES = [
  { id: 'gilded', label: '余烬金', description: '黑曜石、旧金与冷灰' },
  { id: 'moonlit', label: '月蚀蓝', description: '深海蓝、青辉与暮紫' },
  { id: 'crimson', label: '猩红夜', description: '暗酒红、赤铜与烛火' },
];

const THEME_STORAGE_KEY = 'tavernnext.destined-poem.theme';
const coverImageUrl = new URL('../content/cover.png', import.meta.url).href;
let activePoemTheme = 'gilded';

export function normalizeDestinedPoemTheme(theme) {
  return DESTINED_POEM_THEMES.some((item) => item.id === theme) ? theme : 'gilded';
}

function readPoemTheme() {
  try { return normalizeDestinedPoemTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return 'gilded'; }
}

function setPoemTheme(theme, persist = true) {
  activePoemTheme = normalizeDestinedPoemTheme(theme);
  document.documentElement.dataset.destinedPoemTheme = activePoemTheme;
  root?.setAttribute('data-poem-theme', activePoemTheme);
  if (!persist) return;
  try { window.localStorage.setItem(THEME_STORAGE_KEY, activePoemTheme); }
  catch { /* Browser storage can be unavailable in restricted contexts. */ }
}

const request = (method, args = []) => {
  const [scope, name] = method.split('.');
  const target = sdk?.[scope]?.[name];
  return typeof target === 'function'
    ? Promise.resolve(target(...args))
    : Promise.reject(new Error('scene_sdk_method_unknown'));
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const valueAt = (source, path, fallback = '') => {
  let value = source;
  for (const part of path.split('.')) value = value?.[part];
  return value ?? fallback;
};

function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.classList.toggle('dark', theme.scheme === 'dark');
  document.documentElement.style.colorScheme = theme.scheme || 'dark';
  for (const [name, value] of Object.entries(theme.tokens || {})) {
    if (name.startsWith('--vp-')) document.documentElement.style.setProperty(name, String(value));
  }
}

function updateGeneration(value) {
  generationView = { ...generationView, ...(value || {}) };
  const running = ['starting', 'streaming', 'stopping'].includes(generationView.status);
  const status = document.querySelector('#generation-status');
  const send = document.querySelector('#send');
  const draft = document.querySelector('#draft');
  if (send) send.disabled = running;
  if (draft) draft.disabled = running;
  if (status) {
    const latestActivity = Array.isArray(generationView.activities) ? generationView.activities.at(-1)?.label : '';
    status.className = `generation-status${generationView.error ? ' error' : ''}`;
    status.innerHTML = generationView.error
      ? esc(generationView.error)
      : running ? `<span>${esc(latestActivity || '正在生成回复…')}</span><div class="progress"></div>` : '';
  }
  const messages = document.querySelector('.messages');
  if (!messages) return;
  let streaming = document.querySelector('#streaming-message');
  if (running && (generationView.streamedText || generationView.streamedReasoning || generationView.viewPlaceholders?.length)) {
    if (!streaming) {
      streaming = document.createElement('article');
      streaming.id = 'streaming-message';
      streaming.className = 'message assistant streaming';
      messages.append(streaming);
    }
    streaming.innerHTML = streamingMarkup();
    bindDestinedPoemMessageBlocks(streaming);
  } else streaming?.remove();
}

function activeDiagnostics(message) {
  const variant = message.variants?.find((item) => item.id === message.activeVariantId);
  return variant?.diagnostics || [];
}

const percent = (value, maximum) => maximum > 0
  ? Math.max(0, Math.min(100, Number(value || 0) / Number(maximum) * 100))
  : 0;

function resourceMarkup(label, value, maximum, tone) {
  return `<div class="poem-resource ${tone}"><div><span>${esc(label)}</span><strong>${esc(value)} / ${esc(maximum)}</strong></div><div class="poem-resource-track"><i style="width:${percent(value, maximum)}%"></i></div></div>`;
}

function collectionPreview(value, limit = 3) {
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item]) : Object.entries(value || {});
  return entries.slice(0, limit).map(([key, item]) => ({
    name: item?.名称 ?? item?.name ?? key,
    detail: item?.描述 ?? item?.description ?? item?.品质 ?? item?.类型 ?? '',
    raw: item,
  }));
}

function collectionSize(value) {
  return Array.isArray(value) ? value.length : Object.keys(value || {}).length;
}

function collapsibleSidebarSection(id, title, aside, body, className = '') {
  return `<details class="sidebar-section sidebar-collapsible${className ? ` ${className}` : ''}" data-sidebar-section="${id}"${openSidebarSections.has(id) ? ' open' : ''}><summary><span>${esc(title)}</span><small>${esc(aside)}</small><i class="sidebar-chevron" aria-hidden="true"></i></summary><div class="sidebar-section-body">${body}</div></details>`;
}

export function renderDestinedPoemSidebar(state, playerName = '旅人') {
  const protagonist = state?.主角 || {};
  const world = state?.世界 || {};
  const equipment = collectionPreview(protagonist.装备, Number.POSITIVE_INFINITY);
  const skills = collectionPreview(protagonist.技能, Number.POSITIVE_INFINITY);
  const inventory = collectionPreview(protagonist.背包, Number.POSITIVE_INFINITY);
  const effects = collectionPreview(protagonist.状态效果, Number.POSITIVE_INFINITY);
  const quests = collectionPreview(state?.任务列表, Number.POSITIVE_INFINITY);
  const attributes = protagonist.属性 || {};
  const identity = `${protagonist.种族 || '未知种族'} · ${(protagonist.职业 || []).join('、') || protagonist.生命层级 || '旅人'}`;
  const row = (item, kind, index, icon = '◇') => renderDestinedPoemDetailRow(item, kind, index, icon);
  return `<aside class="poem-sidebar" aria-label="角色状态">
    <section class="sidebar-section identity-block">
      <header><span>旅者状态</span><small>LV. ${esc(protagonist.等级 ?? 1)}</small></header>
      <div class="portrait-row"><div class="portrait-mark">✦</div><div><h2>${esc(protagonist.姓名 || playerName)}</h2><p>${esc(identity)}</p></div></div>
      <div class="resource-stack">
        ${resourceMarkup('生命', protagonist.生命值 ?? 0, protagonist.生命值上限 ?? 0, 'hp')}
        ${resourceMarkup('法力', protagonist.法力值 ?? 0, protagonist.法力值上限 ?? 0, 'mp')}
        ${resourceMarkup('体力', protagonist.体力值 ?? 0, protagonist.体力值上限 ?? 0, 'sp')}
        ${resourceMarkup('经验', protagonist.累计经验值 ?? 0, protagonist.升级所需经验 ?? 0, 'xp')}
      </div>
      <div class="sidebar-stat-grid"><div><strong>${esc(protagonist.金钱 ?? 0)}</strong><small>金币</small></div><div><strong>${esc(state?.命运点数 ?? 0)}</strong><small>命运</small></div><div><strong>${esc(protagonist.属性点 ?? 0)}</strong><small>属性点</small></div></div>
      <div class="sidebar-meta-grid"><div><small>地点</small><strong>${esc(world.地点 || '未知')}</strong></div><div><small>时间</small><strong>${esc(world.时间 || '未知')}</strong></div><div><small>天气</small><strong>${esc(world.天气 || '天气未知')}</strong></div><div><small>冒险者等级</small><strong>${esc(protagonist.冒险者等级 || '未评级')}</strong></div></div>
    </section>
    ${collapsibleSidebarSection('attributes', '基础属性', `可用点数 ${protagonist.属性点 ?? 0}`, `<div class="sidebar-attributes">${['力量', '敏捷', '体质', '智力', '精神'].map((name) => `<div><span>${name}</span><strong>${esc(attributes[name] ?? 0)}</strong><button type="button" data-sidebar-attribute="${name}" aria-label="增加${name}"${Number(protagonist.属性点 ?? 0) < 1 ? ' disabled' : ''}>+</button></div>`).join('')}</div>`, 'attribute-section')}
    ${collapsibleSidebarSection('effects', '状态效果', effects.length, `<div class="sidebar-list">${effects.length ? effects.map((item, index) => row(item, 'effect', index, '✦')).join('') : '<p class="sidebar-empty">当前没有状态效果</p>'}</div>`)}
    ${collapsibleSidebarSection('equipment', '装备', `${collectionSize(protagonist.装备)} / 8`, `<div class="sidebar-list">${equipment.length ? equipment.map((item, index) => row(item, 'equipment', index, '⚔')).join('') : '<p class="sidebar-empty">尚未装备物品</p>'}</div>`)}
    ${collapsibleSidebarSection('skills', '技能', skills.length, `<div class="sidebar-list">${skills.length ? skills.map((item, index) => row(item, 'skill', index, '✧')).join('') : '<p class="sidebar-empty">尚未掌握技能</p>'}</div>`)}
    ${collapsibleSidebarSection('inventory', '背包', `${collectionSize(protagonist.背包)} / 20`, `<div class="sidebar-list">${inventory.length ? inventory.map((item, index) => row(item, 'inventory', index, '◇')).join('') : '<p class="sidebar-empty">背包为空</p>'}</div>`)}
    ${collapsibleSidebarSection('quests', '任务', quests.length, `<div class="sidebar-list">${quests.length ? quests.map((item, index) => row(item, 'quest', index, '◆')).join('') : '<p class="sidebar-empty">命运尚未给出指引</p>'}</div>`, 'quest-section')}
    ${renderDestinedPoemDetailDialog({ effect: effects, equipment, skill: skills, inventory, quest: quests })}
  </aside>`;
}

function bindSidebarActions() {
  bindDestinedPoemDetails(document);
  document.querySelectorAll('[data-sidebar-section]').forEach((section) => {
    section.ontoggle = () => {
      if (section.open) openSidebarSections.add(section.dataset.sidebarSection);
      else openSidebarSections.delete(section.dataset.sidebarSection);
    };
  });
  document.querySelectorAll('[data-sidebar-attribute]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const operation = attributeAllocationAction(button.dataset.sidebarAttribute);
        const result = await request('scene.action', [operation.action, operation.options]);
        if (result.result?.ok !== true) window.alert('属性分配未能完成。');
        await renderWorkspace();
      } catch (error) {
        button.disabled = false;
        window.alert(error.message || String(error));
      }
    };
  });
}

function nearbyMarkers(state) {
  const markers = Array.isArray(state?.地图?.标记) ? state.地图.标记 : [];
  if (markers.length <= 6) return markers;
  const location = String(state?.世界?.地点 || '').trim();
  const active = markers.find((marker) => marker.name === location) || markers[0];
  const anchor = active?.position || { nx: .5, ny: .5 };
  return [...markers].sort((left, right) => {
    if (left === active) return -1;
    if (right === active) return 1;
    const distance = (marker) => ((marker.position?.nx ?? .5) - anchor.nx) ** 2 + ((marker.position?.ny ?? .5) - anchor.ny) ** 2;
    return distance(left) - distance(right);
  }).slice(0, 6);
}

function markerLayout(markers) {
  if (!markers.length) return [];
  const xs = markers.map((item) => Number(item.position?.nx ?? .5));
  const ys = markers.map((item) => Number(item.position?.ny ?? .5));
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return markers.map((marker) => ({
    ...marker,
    x: 12 + ((Number(marker.position?.nx ?? .5) - minX) / Math.max(.01, maxX - minX)) * 76,
    y: 18 + ((Number(marker.position?.ny ?? .5) - minY) / Math.max(.01, maxY - minY)) * 64,
  })).sort((left, right) => left.x - right.x);
}

function mapPanelMarkup(state, expanded = false) {
  const markers = markerLayout(nearbyMarkers(state));
  const location = state?.世界?.地点 || markers[0]?.name || '未知区域';
  const points = markers.map((marker) => `${marker.x.toFixed(1)},${marker.y.toFixed(1)}`).join(' ');
  return `<section class="map-panel${expanded ? ' expanded' : ''}" aria-label="旅途地图">
    <header><span>地图</span><small>${esc(state?.世界?.时间 || '时间未知')}</small></header>
    <div class="route-map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="terrain-line one" d="M-5 78 C18 52 26 67 44 42 S74 22 106 12"/><path class="terrain-line two" d="M-4 34 C24 8 45 45 105 30"/><polyline points="${points}"/></svg>
      ${markers.map((marker) => `<button type="button" class="map-marker${marker.name === location ? ' active' : ''}" style="left:${marker.x}%;top:${marker.y}%" title="${esc(marker.group || '')}: ${esc(marker.description || '')}"><i></i><span>${esc(marker.name)}</span></button>`).join('')}
    </div>
    <footer><span>当前位置 · ${esc(location)}</span><small>${markers.length} 个邻近地点</small></footer>
  </section>`;
}

function intelRailMarkup(state) {
  const markers = nearbyMarkers(state).slice(0, 4);
  const relationships = collectionPreview(state?.关系列表, 3);
  return `<aside class="intel-rail" aria-label="地图与情报">
    ${mapPanelMarkup(state)}
    <section class="discovery-panel"><header><span>遗迹与图鉴</span><small>${markers.length} / 64</small></header><div class="discovery-grid">${markers.map((marker) => `<article${marker.imageUrls?.[0] ? ` style="--discovery-image:url('${esc(marker.imageUrls[0])}')"` : ''}><div></div><strong>${esc(marker.name)}</strong><small>${esc(marker.group)}</small></article>`).join('')}</div></section>
    <section class="chronicle-panel"><header><span>命运记录</span><small>LIVE</small></header>${relationships.length ? relationships.map((item, index) => `<article><time>00:${String(45 - index * 3).padStart(2, '0')}</time><p>${esc(item.name)} · ${esc(item.detail || '关系发生了微妙的变化')}</p></article>`).join('') : '<p class="sidebar-empty">新的记录会在旅途中出现</p>'}</section>
  </aside>`;
}

function settingsMarkup() {
  return `<div class="header-actions"><div class="settings-wrap"><button type="button" class="round-control" id="settings-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="场景设置"><svg class="poem-ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.64 5.64l1.42 1.42M16.94 16.94l1.42 1.42M18.36 5.64l-1.42 1.42M7.06 16.94l-1.42 1.42"/></svg></button><div class="settings-menu" id="settings-menu" role="menu" hidden><header><strong>界面风格</strong><small>即时切换，不影响存档</small></header><div class="theme-options" role="radiogroup" aria-label="命定之诗主题">${DESTINED_POEM_THEMES.map((theme) => `<button type="button" role="radio" aria-checked="${theme.id === activePoemTheme}" data-poem-theme-option="${theme.id}" class="${theme.id === activePoemTheme ? 'active' : ''}"><i class="theme-swatch ${theme.id}"></i><span><strong>${theme.label}</strong><small>${theme.description}</small></span><b>✓</b></button>`).join('')}</div><div class="settings-hint">设置保存在当前浏览器</div></div></div></div>`;
}

function bindSettings() {
  const toggle = document.querySelector('#settings-toggle');
  const menu = document.querySelector('#settings-menu');
  if (!toggle || !menu) return;
  const setOpen = (open) => {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.onclick = (event) => { event.stopPropagation(); setOpen(menu.hidden); };
  menu.onclick = (event) => event.stopPropagation();
  document.querySelectorAll('[data-poem-theme-option]').forEach((button) => {
    button.onclick = () => {
      setPoemTheme(button.dataset.poemThemeOption);
      document.querySelectorAll('[data-poem-theme-option]').forEach((item) => {
        const selected = item.dataset.poemThemeOption === activePoemTheme;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-checked', String(selected));
      });
      setOpen(false);
    };
  });
  root.onclick = () => setOpen(false);
  root.onkeydown = (event) => { if (event.key === 'Escape') setOpen(false); };
}

function activeVariant(message) {
  return message.variants?.find((item) => item.id === message.activeVariantId);
}

function sceneViewMarkup(block) {
  const props = block?.props && typeof block.props === 'object' ? block.props : {};
  const shell = (kind, title, body) => `<section class="inline-scene-view ${kind}" role="region" aria-label="${esc(title)}" data-scene-view-id="${esc(block.viewId)}"><header><strong>${esc(title)}</strong></header>${body}</section>`;
  if (block.kind === 'combat') {
    const entries = [props.protagonist, ...(Array.isArray(props.opponents) ? props.opponents : [])].filter(Boolean);
    return shell('combat', props.title || '战斗态势', `<div class="inline-view-grid">${entries.map((item) => `<article><strong>${esc(item.name)}</strong><span>${esc(item.hp)} / ${esc(item.maxHp)} HP</span></article>`).join('')}</div>`);
  }
  if (block.kind === 'status') {
    const resources = props.resources || {};
    return shell('status', `${props.name || '主角'}状态`, `<p>等级 ${esc(props.level)} · ${esc(props.rank)} · 命运 ${esc(props.fate)}</p><div class="inline-view-grid"><article>HP ${esc(resources.hp)} / ${esc(resources.maxHp)}</article><article>MP ${esc(resources.mp)} / ${esc(resources.maxMp)}</article><article>体力 ${esc(resources.stamina)} / ${esc(resources.maxStamina)}</article></div>`);
  }
  if (block.kind === 'map') {
    const markers = Array.isArray(props.markers) ? props.markers : [];
    return shell('map', `${props.location || '世界'}地图`, `<p>${esc(props.time)}</p><div class="inline-view-grid">${markers.map((item) => `<article data-active="${item.active === true}"><strong>${esc(item.name)}</strong><span>${esc(item.description)}</span></article>`).join('')}</div>`);
  }
  if (block.kind === 'relationship') {
    const entries = Array.isArray(props.entries) ? props.entries : [];
    return shell('relationship', '关系进展', `<div class="inline-view-grid">${entries.map((item) => `<article><strong>${esc(item.name)}</strong><span>好感 ${esc(item.affinity)}</span><p>${esc(item.description)}</p></article>`).join('')}</div>`);
  }
  if (block.kind === 'progress') {
    const quests = Array.isArray(props.quests) ? props.quests : [];
    return shell('progress', props.event?.title || '旅程进展', `<p>${esc(props.event?.stage)} · Lv.${esc(props.level)} · XP ${esc(props.experience)} / ${esc(props.nextExperience)}</p><div class="inline-view-grid">${quests.map((item) => `<article><strong>${esc(item.title)}</strong><span>${esc(item.status)}</span><p>${esc(item.description)}</p></article>`).join('')}</div>`);
  }
  return '';
}

export function renderSceneView({ root, block }) {
  const markup = sceneViewMarkup(block);
  if (!markup) throw new Error('scene_view_renderer_unsupported');
  root.innerHTML = markup;
  return () => root.replaceChildren();
}

function roleplayDocumentMarkup(message) {
  const variant = activeVariant(message);
  const blocks = variant?.document?.blocks;
  if (!Array.isArray(blocks)) return renderDestinedPoemMessage(message.content, { idPrefix: `message-${message.id}` });
  return blocks.map((block, index) => block.type === 'scene-view'
    ? sceneViewMarkup(block)
    : block.type === 'action-options'
      ? renderDestinedPoemMessage(`<options>\n${block.options.map((option, optionIndex) => `${optionIndex + 1}. ${option.text}`).join('\n')}\n</options>`, { idPrefix: `message-${message.id}-${index}` })
      : renderDestinedPoemMessage(block.content || '', { idPrefix: `message-${message.id}-${index}` })).join('');
}

function streamingMarkup() {
  const text = generationView.streamedText || generationView.streamedReasoning || '';
  const placeholders = Array.isArray(generationView.viewPlaceholders) ? generationView.viewPlaceholders : [];
  const chunks = [];
  let cursor = 0;
  for (const placeholder of [...placeholders].sort((left, right) => left.offset - right.offset)) {
    const offset = Math.max(cursor, Math.min(text.length, Number(placeholder.offset) || 0));
    chunks.push(renderDestinedPoemMessage(text.slice(cursor, offset), {
      idPrefix: `streaming-${cursor}`,
      streaming: true,
    }));
    chunks.push(`<span class="inline-view-placeholder" data-view-id="${esc(placeholder.viewId)}">正在准备 ${esc(placeholder.kind)} 视图…</span>`);
    cursor = offset;
  }
  chunks.push(renderDestinedPoemMessage(text.slice(cursor), {
    idPrefix: 'streaming-tail',
    streaming: true,
  }));
  return chunks.join('');
}

function messageMarkup(message) {
  if (message.playerOperation) {
    return `<aside class="player-operation-card"><span>${esc(message.playerOperation.kind)}</span><strong>${esc(message.playerOperation.title)}</strong><p>${esc(message.playerOperation.summary)}</p></aside>`;
  }
  return message.role === 'assistant'
    ? roleplayDocumentMarkup(message)
    : `<div class="action-message-narrative">${esc(message.content)}</div>`;
}

function diagnosticMarkup(diagnostics, messageId) {
  if (!diagnostics.length) return '';
  const failures = diagnostics.flatMap((diagnostic) => diagnostic.failures || []);
  const appliedCount = diagnostics.reduce((total, diagnostic) => total + Number(diagnostic.appliedCount || 0), 0);
  const rows = failures.length
    ? failures.map((failure) => {
      const operation = [failure.op, failure.path || failure.to].filter(Boolean).join(' ');
      return `<li><strong>#${Number(failure.operationIndex) + 1} ${esc(operation || '未知操作')}</strong><span>${esc(failure.code)}</span></li>`;
    })
    : diagnostics.map((diagnostic) => `<li><strong>${esc(diagnostic.code)}</strong><span>变量块无法解析，未产生可独立应用的操作。</span></li>`);
  const title = appliedCount > 0 ? '状态已部分更新' : '正文已保留，状态未更新';
  const summary = failures.length
    ? `成功应用 ${appliedCount} 项，失败 ${failures.length} 项。`
    : '变量更新格式无效，可查看失败原因后重生成。';
  return `<aside class="state-warning"><strong>${title}</strong><span>${summary}</span><button type="button" class="state-failure-toggle" data-diagnostic="${messageId}" aria-expanded="false">查看失败列表 (${rows.length})</button><ul class="state-failure-list" data-diagnostic-list="${messageId}" hidden>${rows.join('')}</ul></aside>`;
}

async function renderWorkspace() {
  speechInputController?.destroy();
  speechInputController = undefined;
  mapCleanup?.();
  mapCleanup = undefined;
  const [detail, stateRow] = await Promise.all([request('messages.list'), request('state.get')]);
  const state = stateRow.value || {};
  const tabs = [['chat', '对话'], ['quests', '任务'], ['relationships', '关系'], ['map', '地图']];
  const event = state?.事件 || {};
  const world = state?.世界 || {};
  root.innerHTML = `<div class="shell"><header class="scene-header">
    <div class="scene-brand"><i>†</i><div><strong>命定之诗</strong><small>OATH OF THE ASHEN CROWN</small></div></div>
    <div class="journey-meta"><strong>${esc(world.地点 || detail.conversation.title || '阿斯塔利亚')}</strong><small>${esc(world.时间 || '命运的时针尚未转动')}</small></div>
    <nav class="primary-tabs" aria-label="场景页面">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${activeTab === id ? 'active' : ''}">${label}</button>`).join('')}</nav>
    ${settingsMarkup()}
  </header>${renderDestinedPoemSidebar(state, context.playerProfile.name)}<main class="main"><section class="content" id="content"></section></main>${intelRailMarkup(state)}</div>`;
  document.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { activeTab = button.dataset.tab; renderWorkspace(); }; });
  bindSettings();
  bindSidebarActions();
  const area = document.querySelector('#content');
  if (activeTab === 'chat') {
    const chapterTitle = event.标题 || detail.conversation.title || '未命名的诗篇';
    const chapterStage = event.阶段 || '命运初启';
    area.innerHTML = `<div class="story-hero" style="--hero-image:url('${esc(coverImageUrl)}')"><div class="hero-copy"><span>CHAPTER I · ${esc(chapterStage)}</span><h1>${esc(chapterTitle)}</h1><p>${esc(world.地点 || '阿斯塔利亚')} · ${esc(world.时间 || '群星无言')}</p></div><div class="danger-seal">△ 命运等级 III</div></div><div class="panel chat"><header class="chapter-heading"><div><span>当前篇章</span><h2>${esc(chapterTitle)}</h2></div><small>${detail.messages.length} 则命运记录</small></header><div class="messages">${detail.messages.map((message) => {
      const diagnostics = activeDiagnostics(message);
      const tailAssistant = message.role === 'assistant' && message === detail.messages.at(-1);
      const operation = message.playerOperation !== undefined;
      const menu = operation ? '' : `<menu><button data-op="edit" data-id="${message.id}">编辑</button><button data-op="delete" data-id="${message.id}">删除</button>${tailAssistant ? `<button data-op="regenerate" data-id="${message.id}">重生成</button><button data-op="swipe" data-id="${message.id}">换一个回复</button>` : ''}</menu>`;
      return `<article class="message ${operation ? 'player-operation' : message.role}">${message.role === 'user' ? '<span class="speaker-rune">你</span>' : ''}<div class="message-body">${messageMarkup(message)}</div>${operation ? '' : diagnosticMarkup(diagnostics, message.id)}${menu}</article>`;
    }).join('') || '<div class="empty-story"><i>◇</i><p>诗篇尚未落下第一行文字。</p></div>'}</div><div class="composer-wrap"><div class="composer"><textarea id="draft" placeholder="你准备做什么？"></textarea><button class="action" id="voice-input" type="button" aria-label="开始语音输入"></button><button class="action primary" id="send" aria-label="发送">➤</button><button class="action" id="stop">停止</button></div><div id="generation-status" class="generation-status"></div></div></div>`;
    speechInputController = sdk.ui.speechInput.mount({
      input: document.querySelector('#draft'),
      button: document.querySelector('#voice-input'),
      language: 'zh-CN',
      labels: { start: '开始语音输入', stop: '停止语音输入', unsupported: '当前浏览器不支持语音输入', permissionDenied: '麦克风权限被拒绝', unavailable: '语音输入当前不可用', noSpeech: '未检测到语音' },
    });
    bindDestinedPoemMessageBlocks(area, (value) => {
      const draft = document.querySelector('#draft');
      if (!draft) return;
      draft.value = value;
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      draft.focus();
    });
    document.querySelectorAll('[data-diagnostic]').forEach((button) => { button.onclick = () => {
      const list = document.querySelector(`[data-diagnostic-list="${button.dataset.diagnostic}"]`);
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      button.textContent = `${expanded ? '查看' : '收起'}失败列表 (${list.children.length})`;
    }; });
    document.querySelector('#send').onclick = async () => {
      const draft = document.querySelector('#draft');
      const text = draft.value.trim();
      if (!text) return;
      updateGeneration({
        status: 'starting', error: null, streamedText: '', streamedReasoning: '', activities: [], viewPlaceholders: [],
      });
      try { await request('messages.send', [text]); draft.value = ''; await renderWorkspace(); }
      catch (error) { updateGeneration({ status: 'idle', error: error.message || String(error) }); }
    };
    document.querySelector('#stop').onclick = () => request('messages.stop').catch((error) => updateGeneration({ error: error.message || String(error) }));
    document.querySelectorAll('[data-op]').forEach((button) => { button.onclick = async () => {
      const { op, id } = button.dataset;
      try {
        if (op === 'edit') {
          const message = detail.messages.find((item) => item.id === id);
          const next = prompt('编辑消息', message?.content || '');
          if (next === null) return;
          await request('messages.edit', [id, next]);
        } else if (op === 'delete') await request('messages.delete', [id]);
        else await request(`messages.${op}`);
        await renderWorkspace();
      } catch (error) { updateGeneration({ status: 'idle', error: error.message || String(error) }); }
    }; });
    updateGeneration(generationView);
    return;
  }
  if (activeTab === 'map') {
    area.innerHTML = renderDestinedPoemWorldMap(state);
    mapCleanup = bindDestinedPoemWorldMap(area);
    return;
  }
  const mapping = { quests: ['任务', '任务列表'], relationships: ['关系', '关系列表'] };
  const [title, path] = mapping[activeTab];
  const data = valueAt(state, path, {});
  const entries = Array.isArray(data) ? data.map((value, index) => [index, value]) : Object.entries(data || {});
  area.innerHTML = `<div class="panel archive-page"><header class="archive-heading"><span>ARCHIVE · ${esc(title)}</span><h1>${esc(title)}</h1><p>记录在这份存档中的${esc(title)}资料。</p></header>${entries.length ? `<div class="grid">${entries.map(([key, value]) => `<article class="card"><span>◇</span><div><strong>${esc(value?.title ?? value?.name ?? key)}</strong><p>${esc(typeof value === 'object' ? value.description ?? value.描述 ?? JSON.stringify(value) : value)}</p></div></article>`).join('')}</div>` : '<div class="empty">暂无内容</div>'}</div>`;
}

export async function mount(input) {
  root = input.root;
  sdk = input.sdk;
  context = await sdk.context.get();
  setPoemTheme(readPoemTheme(), false);
  generationView = { ...generationView, ...sdk.generation.getSnapshot() };
  applyTheme(sdk.theme.getSnapshot());
  const unsubscribeTheme = sdk.theme.subscribe(applyTheme);
  const unsubscribeGeneration = sdk.generation.subscribe((event) => {
    if (event.type === 'snapshot') updateGeneration(event.value);
    else if (event.type === 'text-delta') updateGeneration({ ...generationView, streamedText: generationView.streamedText + event.text });
    else if (event.type === 'reasoning-delta') updateGeneration({ ...generationView, streamedReasoning: generationView.streamedReasoning + event.text });
    else if (event.type === 'activity') updateGeneration({ ...generationView, activities: [...(generationView.activities || []), { kind: event.kind, label: event.label }].slice(-32) });
    else if (event.type === 'view-placeholder') updateGeneration({ ...generationView, viewPlaceholders: [...(generationView.viewPlaceholders || []), event].slice(-16) });
  });
  if (input.mode === 'setup') await renderDestinedPoemSetup({ root, sdk, request }); else await renderWorkspace();
  return () => {
    unsubscribeTheme();
    unsubscribeGeneration();
    speechInputController?.destroy();
    speechInputController = undefined;
    mapCleanup?.();
    mapCleanup = undefined;
    root.onclick = null;
    root.onkeydown = null;
    root.onsubmit = null;
    delete document.documentElement.dataset.destinedPoemTheme;
    root.replaceChildren();
  };
}
