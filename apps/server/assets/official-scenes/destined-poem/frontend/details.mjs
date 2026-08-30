const KIND_LABELS = {
  effect: '状态',
  equipment: '装备',
  skill: '技能',
  inventory: '物品',
  quest: '任务',
};

const KIND_KICKERS = {
  effect: 'STATUS EFFECT',
  equipment: 'EQUIPMENT ARCHIVE',
  skill: 'SKILL CODEX',
  inventory: 'ITEM ARCHIVE',
  quest: 'QUEST RECORD',
};

const RARITIES = {
  only: { label: '唯一', aliases: ['only', '唯一'] },
  mythic: { label: '神话', aliases: ['mythic', '神话'] },
  legendary: { label: '传说', aliases: ['legendary', '传说'] },
  epic: { label: '史诗', aliases: ['epic', '史诗'] },
  rare: { label: '稀有', aliases: ['rare', '稀有'] },
  uncommon: { label: '优良', aliases: ['uncommon', '优良', '优秀'] },
  common: { label: '普通', aliases: ['common', '普通'] },
};

const KNOWN_FIELDS = new Set([
  '名称', 'name', '品质', '品阶', '稀有度', 'rarity', 'quality',
  '类型', 'type', '数量', 'quantity', '标签', 'tag', 'tags',
  '效果', 'effect', 'effects', '描述', 'description', '消耗', 'consume', 'cost',
]);

const first = (object, keys, fallback = '') => {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return fallback;
};

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function displayValue(value) {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, child]) => `${key}：${displayValue(child)}`).join('；');
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value ?? '');
}

export function normalizeDestinedPoemRarity(value) {
  const source = String(value ?? '').trim().toLowerCase();
  for (const [id, rarity] of Object.entries(RARITIES)) {
    if (rarity.aliases.some((alias) => alias.toLowerCase() === source)) return { id, label: rarity.label };
  }
  return { id: 'unknown', label: source ? String(value) : '未定品阶' };
}

export function normalizeDestinedPoemDetail(kind, item, index = 0) {
  const source = record(item?.raw ?? item);
  const fallbackDescription = item?.detail && item.detail !== item?.name ? item.detail : '';
  const name = first(item, ['name'], first(source, ['名称', 'name'], `${KIND_LABELS[kind] || '记录'} ${index + 1}`));
  const rarity = normalizeDestinedPoemRarity(first(source, ['品质', '品阶', '稀有度', 'rarity', 'quality']));
  const type = first(source, ['类型', 'type'], KIND_LABELS[kind] || '其他');
  const description = first(source, ['描述', 'description'], fallbackDescription);
  const quantity = first(source, ['数量', 'quantity'], '');
  const consume = first(source, ['消耗', 'consume'], '');
  const tags = list(first(source, ['标签', 'tag', 'tags'], [])).map(displayValue).filter(Boolean);
  const effectSource = first(source, ['效果', 'effect', 'effects'], {});
  const effects = Array.isArray(effectSource)
    ? effectSource.map((value, effectIndex) => ({ label: `效果 ${effectIndex + 1}`, value: displayValue(value) }))
    : Object.entries(record(effectSource)).map(([label, value]) => ({ label, value: displayValue(value) }));
  const fields = Object.entries(source)
    .filter(([key, value]) => !KNOWN_FIELDS.has(key) && value !== '' && value !== undefined && value !== null)
    .map(([label, value]) => ({ label, value: displayValue(value) }))
    .filter((field) => field.value !== '');

  return {
    id: `${kind}-${index}`,
    kind,
    kindLabel: KIND_LABELS[kind] || '记录',
    kicker: KIND_KICKERS[kind] || 'ARCHIVE RECORD',
    name: String(name),
    rarity,
    type: String(type),
    description: String(description || '暂无更多描述。'),
    quantity: quantity === '' ? '' : String(quantity),
    consume: consume === '' ? '' : String(consume),
    tags,
    effects,
    fields,
  };
}

export function renderDestinedPoemDetailRow(item, kind, index, icon = '◆') {
  const detail = normalizeDestinedPoemDetail(kind, item, index);
  const secondary = detail.rarity.id === 'unknown'
    ? (detail.type || detail.description)
    : `${detail.rarity.label} · ${detail.type}`;
  return `<article class="sidebar-list-row detail-kind-${esc(kind)} rarity-${detail.rarity.id}"><b aria-hidden="true">${esc(icon)}</b><div><strong>${esc(detail.name)}</strong><small>${esc(secondary)}</small></div><button type="button" class="sidebar-detail-button" data-poem-detail="${detail.id}" aria-haspopup="dialog">详情</button></article>`;
}

function detailCard(detail) {
  const quantity = detail.quantity ? `<small class="poem-detail-quantity">×${esc(detail.quantity)}</small>` : '';
  const consume = detail.consume ? `<span><b>消耗</b>${esc(detail.consume)}</span>` : '';
  const effects = detail.effects.length ? `<section class="poem-detail-effects"><h3>效果</h3>${detail.effects.map((effect) => `<article><strong>${esc(effect.label)}</strong><p>${esc(effect.value)}</p></article>`).join('')}</section>` : '';
  const fields = detail.fields.length ? `<dl class="poem-detail-fields">${detail.fields.map((field) => `<div><dt>${esc(field.label)}</dt><dd>${esc(field.value)}</dd></div>`).join('')}</dl>` : '';
  const tags = detail.tags.length ? `<div class="poem-detail-tags">${detail.tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>` : '';
  return `<article class="poem-detail-card detail-kind-${esc(detail.kind)} rarity-${detail.rarity.id}" data-poem-detail-card="${detail.id}" hidden tabindex="-1"><i class="poem-detail-rarity-line" aria-hidden="true"></i><header><div><span>${esc(detail.kicker)}</span><h2>${esc(detail.name)}</h2></div>${quantity}</header><div class="poem-detail-badges"><span><b>类型</b>${esc(detail.type)}</span><span class="rarity-badge"><b>品阶</b>${esc(detail.rarity.label)}</span>${consume}</div><p class="poem-detail-description">${esc(detail.description)}</p>${effects}${fields}${tags}</article>`;
}

export function renderDestinedPoemDetailDialog(collections) {
  const details = Object.entries(collections || {}).flatMap(([kind, items]) => (
    Array.isArray(items) ? items.map((item, index) => normalizeDestinedPoemDetail(kind, item, index)) : []
  ));
  return `<dialog class="poem-detail-dialog" data-poem-detail-dialog aria-label="详情"><button type="button" class="poem-detail-close" data-poem-detail-close aria-label="关闭详情">×</button>${details.map(detailCard).join('')}<footer><button type="button" data-poem-detail-close>返回旅程</button></footer></dialog>`;
}

export function bindDestinedPoemDetails(host = document) {
  const dialog = host.querySelector('[data-poem-detail-dialog]');
  if (!dialog) return;
  const close = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  };
  host.querySelectorAll('[data-poem-detail]').forEach((button) => {
    button.onclick = () => {
      const target = button.dataset.poemDetail;
      dialog.querySelectorAll('[data-poem-detail-card]').forEach((card) => { card.hidden = card.dataset.poemDetailCard !== target; });
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
      } else dialog.setAttribute('open', '');
      dialog.querySelector(`[data-poem-detail-card="${target}"]`)?.focus();
    };
  });
  dialog.querySelectorAll('[data-poem-detail-close]').forEach((button) => { button.onclick = close; });
  dialog.onclick = (event) => { if (event.target === dialog) close(); };
}
