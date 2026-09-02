const SECRET_ROOT_AFFINITY = 160;
const LEGACY_ITEM_AFFINITY = new Map([
  ['青铜古戒', 30],
  ['母亲手札', 80],
]);
const LEGACY_SKILL_AFFINITY = new Map([
  ['太虚剑诀·残篇', 30],
  ['太虚混元功·基础篇', 60],
  ['太虚丹经·前三卷', 100],
]);
const TAIXUZI_DEFAULT_ITEMS = [
  { id: 'soul-ring', 名称: '寄魂青铜古戒', 品阶: '残破灵器', 描述: '太虚子残魂寄居的容器，戒内留有层层封禁。', 解锁好感: 30 },
  { id: 'resurrection-recipe', 名称: '还魂丹残方', 品阶: '上古残方', 描述: '重塑魂魄与肉身所需的丹方，目前仍缺失关键药引。', 解锁好感: 100 },
  { id: 'ancestor-token', 名称: '太虚祖师信物', 品阶: '绝密', 描述: '与万年前太虚传承有关的信物，真实用途尚未明言。', 解锁好感: 160 },
];
const TAIXUZI_DEFAULT_SKILLS = [
  { id: 'soul-speech', 名称: '神识传音', 品阶: '残魂秘术', 描述: '越过耳目直接在识海中传音，消耗极少魂力。', 解锁好感: 30 },
  { id: 'root-concealment', 名称: '遮掩灵根', 品阶: '上古秘术', 描述: '以残魂之力遮蔽楚霁寒的真实灵根与气机。', 解锁好感: 60 },
  { id: 'soul-takeover', 名称: '残魂接管', 品阶: '禁术', 描述: '危急时短暂接管楚霁寒的身体，每次都会重创魂力。', 解锁好感: 80 },
  { id: 'ancient-memory', 名称: '万年前记忆', 品阶: '绝密', 描述: '太虚子仍未完全开放的旧日记忆，牵连长生局真相。', 解锁好感: 160 },
];

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function entry(value, index, kind, legacyAffinity = new Map()) {
  if (typeof value === 'string') return {
    id: `${kind}-${index}`,
    name: value,
    rank: '未鉴定',
    description: kind === 'item' ? '尚未记录详细来历。' : '尚未记录完整层次。',
    unlockAffinity: legacyAffinity.get(value) ?? 0,
  };
  const source = record(value);
  return {
    id: text(source.id, `${kind}-${index}`),
    name: text(source.名称 ?? source.name, '未命名'),
    rank: text(source.品阶 ?? source.rank, '未鉴定'),
    description: text(source.描述 ?? source.description, '尚无详细记录。'),
    unlockAffinity: Math.max(0, finite(source.解锁好感 ?? source.unlockAffinity)),
  };
}

function attributes(value, fallback) {
  const source = record(value);
  const rows = Object.keys(source).length > 0 ? Object.entries(source) : fallback;
  return rows.slice(0, 12).map(([label, raw]) => ({ label, value: String(raw ?? '未记录') }));
}

function normalizedEntries(preferred, legacy, kind, affinity) {
  const source = array(preferred).length > 0 ? array(preferred) : array(legacy);
  return source.slice(0, 32).map((value, index) => entry(value, index, kind, affinity));
}

export function normalizeTaixuStatusProfiles(state, playerProfile = {}) {
  const root = record(state);
  const playerState = record(root.玩家);
  const character = record(root.楚霁寒);
  const taixuziState = record(root.太虚子);
  const realm = record(character.境界);
  const spiritualRoot = record(character.灵根);
  const alchemy = record(character.丹道);
  const affinity = Math.max(0, finite(record(record(root.关系).player).好感));
  const playerRealm = record(playerState.境界);
  const player = {
    key: 'player',
    name: text(playerState.姓名, text(playerProfile.name, '{{user}}')),
    identity: text(playerState.身份, text(playerProfile.description, '身份尚未记录')),
    rank: text(playerState.品阶, [text(playerRealm.名称), text(playerRealm.阶段)].filter(Boolean).join('·') || '品阶未定'),
    progress: finite(playerRealm.进度),
    attributes: attributes(playerState.基本属性, [
      ['体魄', '未记录'], ['身法', '未记录'], ['灵识', '未记录'], ['悟性', '未记录'],
    ]),
    items: normalizedEntries(playerState.物品, [], 'item', new Map()),
    skills: normalizedEntries(playerState.技能, [], 'skill', new Map()),
  };
  const characterProfile = {
    key: 'chu-jihan',
    name: text(character.姓名, '楚霁寒'),
    identity: text(character.公开身份, '水灵根散修'),
    rank: [text(realm.名称), text(realm.阶段)].filter(Boolean).join('·') || '境界未明',
    progress: finite(realm.进度),
    attributes: attributes(character.基本属性, [
      ['境界', [text(realm.名称), text(realm.阶段)].filter(Boolean).join('·') || '未明'],
      ['对外灵根', text(spiritualRoot.对外, '未明')],
      ['公开丹道', text(alchemy.公开品阶, '未明')],
      ['暴露风险', `${finite(character.暴露风险)}%`],
    ]),
    items: normalizedEntries(character.状态栏物品, character.背包, 'item', LEGACY_ITEM_AFFINITY),
    skills: normalizedEntries(character.状态栏技能, character.功法, 'skill', LEGACY_SKILL_AFFINITY),
  };
  if (!characterProfile.skills.some((skill) => skill.name === text(spiritualRoot.真实))) {
    characterProfile.skills.push({
      id: 'true-spiritual-root',
      name: text(spiritualRoot.真实, '未知命格'),
      rank: '绝密',
      description: '楚霁寒从不向缺乏信任之人显露的真正根骨。',
      unlockAffinity: SECRET_ROOT_AFFINITY,
    });
  }
  const soulStrength = finite(taixuziState.魂力);
  const taixuzi = {
    key: 'taixuzi',
    name: '太虚子',
    identity: '寄魂于青铜古戒的太虚祖师残魂',
    rank: `残魂·${text(taixuziState.状态, '状态未明')}`,
    progress: soulStrength,
    attributes: [
      { label: '状态', value: text(taixuziState.状态, '未明') },
      { label: '魂力', value: `${soulStrength}%` },
      { label: '可接管次数', value: String(Math.max(0, finite(taixuziState.可接管次数))) },
      { label: '沉睡至', value: text(taixuziState.沉睡至, '未沉睡') },
      { label: '还魂丹进度', value: `${Math.max(0, finite(taixuziState.还魂丹进度))}%` },
    ],
    items: normalizedEntries(taixuziState.状态栏物品, TAIXUZI_DEFAULT_ITEMS, 'item', new Map()),
    skills: normalizedEntries(taixuziState.状态栏技能, TAIXUZI_DEFAULT_SKILLS, 'skill', new Map()),
  };
  return { affinity, player, character: characterProfile, taixuzi };
}

function entriesMarkup(entries, affinity, privateProfile) {
  if (entries.length === 0) return '<p class="tx-status-empty">尚未记录</p>';
  return `<div class="tx-status-entry-grid">${entries.map((item) => {
    const locked = privateProfile && affinity < item.unlockAffinity;
    return `<article class="tx-status-entry${locked ? ' locked' : ''}"><div class="tx-status-entry-content"><small>${esc(item.rank)}</small><strong>${esc(item.name)}</strong><p>${esc(item.description)}</p></div>${locked ? `<div class="tx-status-lock"><span>锁</span><strong>当前好感度不足</strong><small>${affinity} / ${item.unlockAffinity}</small></div>` : ''}</article>`;
  }).join('')}</div>`;
}

export function renderTaixuStatusProfile(profile, options = {}) {
  const affinity = Math.max(0, finite(options.affinity));
  const privateProfile = options.privateProfile === true;
  return `<section class="tx-module tx-status-profile" data-status-profile="${esc(profile.key)}"><header><span>${privateProfile ? 'COMPANION STATUS' : 'PLAYER STATUS'}</span><h1>${esc(profile.name)}</h1><p>${esc(profile.identity)}</p></header><div class="tx-status-rank"><div><small>当前品阶</small><strong>${esc(profile.rank)}</strong></div><span>${esc(profile.progress)}%</span></div><section><h2>基本属性</h2><div class="tx-status-attributes">${profile.attributes.map((item) => `<article><small>${esc(item.label)}</small><strong>${esc(item.value)}</strong></article>`).join('')}</div></section><section><h2>物品 · 品阶</h2>${entriesMarkup(profile.items, affinity, privateProfile)}</section><section><h2>技能 · 能力</h2>${entriesMarkup(profile.skills, affinity, privateProfile)}</section></section>`;
}

export function renderTaixuStatusTabs(activeSubject = 'chu-jihan') {
  const active = activeSubject === 'taixuzi' ? 'taixuzi' : 'chu-jihan';
  return `<nav class="tx-status-subtabs" aria-label="同伴状态"><button type="button" data-status-subject="chu-jihan" class="${active === 'chu-jihan' ? 'active' : ''}" aria-pressed="${active === 'chu-jihan'}">楚霁寒</button><button type="button" data-status-subject="taixuzi" class="${active === 'taixuzi' ? 'active' : ''}" aria-pressed="${active === 'taixuzi'}">太虚子</button></nav>`;
}

export function taixuSecretIdentity(spiritualRoot, affinity) {
  return affinity < SECRET_ROOT_AFFINITY
    ? { locked: true, label: '命格未解' }
    : { locked: false, label: text(record(spiritualRoot).真实, '未知命格') };
}
