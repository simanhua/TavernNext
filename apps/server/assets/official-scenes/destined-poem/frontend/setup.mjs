const ATTRIBUTES = ['力量', '敏捷', '体质', '智力', '精神'];
const STAGES = ['rules', 'opening', 'character', 'selections', 'companions', 'confirm'];
const STAGE_LABELS = {
  rules: '核心与 DLC', opening: '开局篇章', character: '角色与属性',
  selections: '装备与技能', companions: '同伴与背景', confirm: '确认创建',
};
const RARITY_COSTS = {
  common: [5, 30], uncommon: [20, 60], rare: [35, 100], epic: [80, 200],
  legendary: [150, 400], mythic: [300, 1_000], only: [666, 666],
};
const PARTNER_COSTS = [100, 213, 456, 2_678, 4_642, 8_318, 9_999];

export const DESTINED_POEM_OPENINGS = [
  { id: 'custom', title: '我的故事将由我亲手书写', kicker: '完整自定义开局', description: '分配属性与转生点，选择装备、技能、同伴和初始背景。', defaultTitle: '未题名的命运', origin: '', available: true },
  { id: 'summoned-hero', title: '来自异世界的“勇者”', kicker: '异界召唤', description: '与三名显露天赋的异界人一同被召唤，只有你看起来毫无力量。', defaultTitle: '无光的第四位勇者', origin: '阿斯塔利亚大陆 · 奥古斯提姆帝国 · 布劳尔子爵领 · 子爵城堡 · 仪式大厅', available: true },
  { id: 'red-moon-oath', title: '红月之誓', kicker: '构想中', description: '原角色卡只有“画饼占坑”标题，尚无可初始化内容。', defaultTitle: '红月之誓', origin: '', available: false },
  { id: 'lost-shore', title: '线与天堂与彼岸花', kicker: '失亡彼岸', description: '穿过终章门扉，在泣空遗迹与本应消逝的弗洛洛重逢。', defaultTitle: '失亡彼岸的重逢', origin: '阿斯塔利亚大陆上空 · 泣歌云海 · 泣空遗迹 · 中央大圣堂', available: true },
  { id: 'merciful-demon-king', title: '慈悲的“魔王”', kicker: '构想中', description: '原角色卡只有“画饼占坑”标题，尚无可初始化内容。', defaultTitle: '慈悲的“魔王”', origin: '', available: false },
  { id: 'divine-party', title: '误入诸神宴席', kicker: '隐藏完整问候', description: '从诺瓦瓦伦蒂亚的酒馆被意外拉进万象神殿。', defaultTitle: '神恩日的不速之客', origin: '万象神殿', available: true },
];

export function destinedPoemOpeningOptionsMarkup(selectedId = 'custom') {
  return DESTINED_POEM_OPENINGS.map((opening) => `<button type="button" class="opening-card${opening.id === selectedId ? ' selected' : ''}" data-opening="${opening.id}" aria-pressed="${opening.id === selectedId}"${opening.available ? '' : ' disabled'}><span class="opening-kicker">${esc(opening.kicker)}</span><strong>${esc(opening.title)}</strong><p>${esc(opening.description)}</p><b>${opening.available ? (opening.id === selectedId ? '已选择' : '选择此开局') : '尚未完成'}</b></button>`).join('');
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const values = (sections) => Object.entries(sections || {}).flatMap(([category, items]) => (
  Array.isArray(items) ? items.map((item) => ({ ...item, category })) : []
));
const unique = (items) => [...new Set(items)];
const selectedOpening = (state) => DESTINED_POEM_OPENINGS.find((opening) => opening.id === state.opening);
const tierBonus = (level) => Math.max(0, Math.min(6, Math.floor((Number(level || 1) - 1) / 4)));
const total = (object) => Object.values(object || {}).reduce((sum, value) => sum + Number(value || 0), 0);

export function calculateDestinedPoemBuild(catalog, build) {
  const all = {
    equipments: new Map(values(catalog.equipments).map((item) => [item.name, item])),
    items: new Map(values(catalog.items).map((item) => [item.name, item])),
    skills: new Map(values(catalog.skills).map((item) => [item.name, item])),
    partners: new Map(values(catalog.partners).map((item) => [item.name, item])),
  };
  const picked = [
    ...(build.equipments || []).map((name) => all.equipments.get(name)),
    ...(build.items || []).map((name) => all.items.get(name)),
    ...(build.skills || []).map((name) => all.skills.get(name)),
    ...(build.partners || []).map((name) => all.partners.get(name)),
    ...(build.customSelections || []),
    ...(build.customPartners || []).map((partner) => ({ cost: PARTNER_COSTS[Math.max(0, Number(partner.tier || 1) - 1)] })),
  ].filter(Boolean);
  const raceCost = build.race === '自定义' ? 80 : Number(catalog.baseInfo.raceCosts?.[build.race] ?? 0);
  const identityCost = build.identity === '自定义' ? 80 : Number(catalog.baseInfo.identityCosts?.[build.identity] ?? 0);
  const consumed = raceCost + identityCost + total(build.attributePoints)
    + picked.reduce((sum, item) => sum + Number(item.cost || 0), 0)
    + Math.ceil(Number(build.money || 0) / 100) + Math.ceil(Number(build.destinyPoints || 0) / 2);
  return {
    consumed,
    remaining: Number(build.reincarnationPoints || 0) - consumed,
    remainingBase: 25 - total(build.basePoints),
    remainingExtra: Math.max(0, Number(build.level || 1) - 1) - total(build.attributePoints),
    finalAttributes: Object.fromEntries(ATTRIBUTES.map((name) => [
      name, Number(build.basePoints[name] || 0) + tierBonus(build.level) + Number(build.attributePoints[name] || 0),
    ])),
  };
}

export function toggleDestinedPoemDlc(catalog, currentKeys, key) {
  const selected = new Set(currentKeys);
  const dlc = catalog.dlcs.find((item) => item.key === key);
  if (!dlc) return { selected, error: 'DLC 不存在' };
  const enable = !selected.has(key);
  if (enable) {
    const missing = dlc.prerequisiteTargets.filter((target) => !catalog.dlcs
      .some((candidate) => selected.has(candidate.key) && candidate.key.includes(`[${target}]`)));
    if (missing.length > 0) return { selected, error: `缺少前置需求：${missing.join('、')}` };
    selected.add(key);
    for (const target of dlc.exclusionTargets) {
      for (const candidate of catalog.dlcs) {
        if (candidate.key !== key && (candidate.label === target || candidate.key.includes(`[${target}]`))) selected.delete(candidate.key);
      }
    }
  } else {
    selected.delete(key);
    for (const candidate of catalog.dlcs) {
      if (selected.has(candidate.key) && candidate.prerequisiteTargets.includes(dlc.label)) selected.delete(candidate.key);
    }
  }
  return { selected };
}

function defaultBuild() {
  return {
    gender: '男', age: 18, race: '人类', customRace: '', identity: '非贵族平民', customIdentity: '',
    location: '大陆东南部区域-索伦蒂斯王国', customLocation: '', level: 1,
    basePoints: Object.fromEntries(ATTRIBUTES.map((name) => [name, 5])),
    attributePoints: Object.fromEntries(ATTRIBUTES.map((name) => [name, 0])),
    reincarnationPoints: 1_000, destinyPoints: 0, money: 0,
    equipments: [], items: [], skills: [], partners: [], customSelections: [], customPartners: [],
    background: '日常', backgroundDescription: '',
  };
}

function optionMarkup(value, label = value, selected = false) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function stageHeader(state) {
  const stages = state.opening === 'custom' ? STAGES : ['rules', 'opening', 'confirm'];
  return `<nav class="builder-steps" aria-label="开局构建步骤">${stages.map((stage, index) => `<button type="button" data-stage="${stage}" class="${state.stage === stage ? 'active' : ''}"><b>${String(index + 1).padStart(2, '0')}</b><span>${STAGE_LABELS[stage]}</span></button>`).join('')}</nav>`;
}

function rulesMarkup(catalog, state) {
  const core = catalog.cores.find((item) => item.entryComment === state.core);
  const dlcs = catalog.dlcs.filter((item) => item.category === state.dlcCategory
    && (!state.dlcSearch || `${item.label} ${item.author} ${item.info}`.toLowerCase().includes(state.dlcSearch.toLowerCase())));
  return `<section class="builder-page"><header><span>WORLD RULES</span><h2>选择命定核心与 DLC</h2><p>这些选择会作为 Save 级世界书覆盖保存，不会影响其他存档。</p></header>
    <div class="builder-block"><label>命定核心<select data-model="core">${catalog.cores.map((item) => optionMarkup(item.entryComment, `${item.label}${item.author ? ` · ${item.author}` : ''}`, item.entryComment === state.core)).join('')}</select></label>${core ? `<article class="selection-detail"><strong>${esc(core.label)}</strong><p>${esc(core.note || '原卡未附说明。')}</p></article>` : ''}</div>
    <div class="builder-block"><div class="builder-block-heading"><div><strong>DLC 管理</strong><small>已启用 ${state.dlcKeys.size} / ${catalog.dlcs.length} 组</small></div><button type="button" data-reset-dlc>恢复原卡默认</button></div>
      <div class="filter-row"><div class="segmented">${['角色', '事件', '扩展'].map((category) => `<button type="button" data-dlc-category="${category}" class="${state.dlcCategory === category ? 'active' : ''}">${category}</button>`).join('')}</div><input data-filter="dlcSearch" value="${esc(state.dlcSearch)}" placeholder="搜索 DLC，回车或移开焦点筛选"></div>
      <div class="dlc-grid">${dlcs.map((item) => `<button type="button" data-dlc="${esc(item.key)}" class="dlc-card ${state.dlcKeys.has(item.key) ? 'selected' : ''}"><span>${esc(item.category)}</span><strong>${esc(item.label)}</strong><small>${esc(item.author || '原卡内容')}</small><p>${esc(item.info || `${item.entryComments.length} 个世界书条目`)}</p>${item.prerequisiteTargets.length ? `<i>前置：${esc(item.prerequisiteTargets.join('、'))}</i>` : ''}${item.exclusionTargets.length ? `<i>互斥：${esc(item.exclusionTargets.join('、'))}</i>` : ''}<b>${state.dlcKeys.has(item.key) ? '已启用' : '未启用'}</b></button>`).join('')}</div>
    </div></section>`;
}

function openingMarkup(state) {
  return `<section class="builder-page"><header><span>PROLOGUE</span><h2>你的故事将从何开始</h2><p>前五项来自原卡首页；“诸神宴席”来自原卡隐藏的完整问候。</p></header><div class="opening-grid">${DESTINED_POEM_OPENINGS.map((opening) => `<button type="button" data-opening="${opening.id}" class="opening-card ${state.opening === opening.id ? 'selected' : ''}"${opening.available ? '' : ' disabled'}><span class="opening-kicker">${esc(opening.kicker)}</span><strong>${esc(opening.title)}</strong><p>${esc(opening.description)}</p><b>${opening.available ? (state.opening === opening.id ? '已选择' : '选择此开局') : '尚未完成'}</b></button>`).join('')}</div></section>`;
}

function attributeMarkup(catalog, state) {
  const build = state.build;
  const budget = calculateDestinedPoemBuild(catalog, build);
  return `<div class="attribute-builder"><div class="attribute-summary"><span>基础点剩余 <b>${budget.remainingBase}</b> / 25</span><span>额外点剩余 <b>${budget.remainingExtra}</b> / ${Math.max(0, build.level - 1)}</span></div><div class="attribute-table"><div class="attribute-row heading"><span>属性</span><span>基础</span><span>层级</span><span>额外</span><span>最终</span></div>${ATTRIBUTES.map((name) => `<div class="attribute-row"><strong>${name}</strong><span><button type="button" data-attribute="basePoints" data-name="${name}" data-delta="-1">−</button><b>${build.basePoints[name]}</b><button type="button" data-attribute="basePoints" data-name="${name}" data-delta="1">+</button></span><i>${tierBonus(build.level)}</i><span><button type="button" data-attribute="attributePoints" data-name="${name}" data-delta="-1">−</button><b>${build.attributePoints[name]}</b><button type="button" data-attribute="attributePoints" data-name="${name}" data-delta="1">+</button></span><em>${budget.finalAttributes[name]}</em></div>`).join('')}</div></div>`;
}

function characterMarkup(catalog, state) {
  const build = state.build;
  const budget = calculateDestinedPoemBuild(catalog, build);
  const races = [...Object.keys(catalog.baseInfo.raceCosts), '自定义'];
  const identities = [...Object.keys(catalog.baseInfo.identityCosts), '自定义'];
  const locations = [...catalog.baseInfo.startLocations, '自定义'];
  return `<section class="builder-page"><header><span>CHARACTER</span><h2>基础信息与属性</h2><p>规则与点数完全按原卡 1.8.2：25 点基础属性，等级每提高 1 级获得 1 点额外属性。</p></header>
    <div class="points-banner"><div><span>可用转生点</span><strong class="${budget.remaining < 0 ? 'negative' : ''}">${budget.remaining}</strong><small>/ ${build.reincarnationPoints}</small></div><button type="button" data-roll-points ${budget.consumed === 0 ? '' : 'disabled'}>🎲 Roll 点数</button></div>
    <div class="setup-form-grid"><label>导入 Persona<select data-model="personaId"><option value="">不导入</option>${state.personas.map((persona) => optionMarkup(persona.id, persona.name, state.personaId === persona.id)).join('')}</select></label><label>主角姓名<input data-model="name" value="${esc(state.name)}" maxlength="80"></label><label class="setup-wide">主角描述<textarea data-model="description" rows="4">${esc(state.description)}</textarea></label>
      <label>性别<select data-build="gender">${[...catalog.baseInfo.genders, '自定义'].map((item) => optionMarkup(item, item, build.gender === item)).join('')}</select></label><label>年龄<input type="number" min="1" max="9999" data-build="age" value="${build.age}"></label>
      <label>种族<select data-build="race">${races.map((item) => optionMarkup(item, `${item} (${Number(catalog.baseInfo.raceCosts[item] ?? (item === '自定义' ? 80 : 0)) >= 0 ? '-' : '+'}${Math.abs(Number(catalog.baseInfo.raceCosts[item] ?? (item === '自定义' ? 80 : 0)))}点)`, build.race === item)).join('')}</select></label>${build.race === '自定义' ? `<label>自定义种族<input data-build="customRace" value="${esc(build.customRace)}"></label>` : '<div></div>'}
      <label>身份<select data-build="identity">${identities.map((item) => optionMarkup(item, `${item} (${Number(catalog.baseInfo.identityCosts[item] ?? (item === '自定义' ? 80 : 0)) >= 0 ? '-' : '+'}${Math.abs(Number(catalog.baseInfo.identityCosts[item] ?? (item === '自定义' ? 80 : 0)))}点)`, build.identity === item)).join('')}</select></label>${build.identity === '自定义' ? `<label>自定义身份<input data-build="customIdentity" value="${esc(build.customIdentity)}"></label>` : '<div></div>'}
      <label class="setup-wide">起始地点<select data-build="location">${locations.map((item) => optionMarkup(item, item, build.location === item)).join('')}</select></label>${build.location === '自定义' ? `<label class="setup-wide">自定义地点<input data-build="customLocation" value="${esc(build.customLocation)}"></label>` : ''}
      <label>等级<input type="number" min="1" max="25" data-build="level" value="${build.level}"></label><label>初始金钱<input type="number" min="0" data-build="money" value="${build.money}"><small>每 100 金钱消耗 1 转生点</small></label><label>命运点数<input type="number" min="0" data-build="destinyPoints" value="${build.destinyPoints}"><small>1 转生点兑换 2 命运点</small></label>
    </div>${attributeMarkup(catalog, state)}</section>`;
}

function selectedNames(state, kind) {
  return state.build[`${kind}s`] || [];
}

function catalogFor(catalog, state) {
  const sections = catalog[`${state.selectionKind}s`];
  return values(sections).filter((item) => (!state.selectionCategory || item.category === state.selectionCategory)
    && (!state.selectionSearch || `${item.name} ${item.description} ${(item.tag || []).join(' ')}`.toLowerCase().includes(state.selectionSearch.toLowerCase()))).slice(0, 120);
}

function selectionsMarkup(catalog, state) {
  const sections = catalog[`${state.selectionKind}s`];
  const categories = Object.keys(sections || {});
  if (!categories.includes(state.selectionCategory)) state.selectionCategory = categories[0] || '';
  const selected = selectedNames(state, state.selectionKind);
  const custom = state.build.customSelections;
  return `<section class="builder-page"><header><span>LOADOUT</span><h2>装备、道具与技能</h2><p>完整读取原卡目录：417 件装备、171 件道具、470 个技能；选择会直接写入初始 Scene State。</p></header>
    <div class="segmented large">${[['equipment', '装备'], ['item', '道具'], ['skill', '技能']].map(([kind, label]) => `<button type="button" data-selection-kind="${kind}" class="${state.selectionKind === kind ? 'active' : ''}">${label}</button>`).join('')}</div>
    <div class="filter-row"><select data-filter="selectionCategory">${categories.map((category) => optionMarkup(category, category, category === state.selectionCategory)).join('')}</select><input data-filter="selectionSearch" value="${esc(state.selectionSearch)}" placeholder="搜索名称、描述或标签"></div>
    <div class="catalog-layout"><div class="catalog-grid">${catalogFor(catalog, state).map((item) => `<button type="button" data-select-kind="${state.selectionKind}" data-name="${esc(item.name)}" class="catalog-card ${selected.includes(item.name) ? 'selected' : ''}"><span>${esc(item.category)} · ${esc(item.rarity || 'common')}</span><strong>${esc(item.name)}</strong><p>${esc(item.description || '')}</p><b>${item.cost || 0} 点</b></button>`).join('')}</div><aside class="selected-list"><header><strong>已选内容</strong><small>${state.build.equipments.length + state.build.items.length + state.build.skills.length + custom.length} 项</small></header>${[['equipment', '装备'], ['item', '道具'], ['skill', '技能']].map(([kind, label]) => `<section><b>${label}</b>${selectedNames(state, kind).map((name) => `<button type="button" data-select-kind="${kind}" data-name="${esc(name)}">${esc(name)} ×</button>`).join('') || '<small>未选择</small>'}</section>`).join('')}<section><b>自定义</b>${custom.map((item, index) => `<button type="button" data-remove-custom="${index}">${esc(item.name)} ×</button>`).join('') || '<small>未添加</small>'}</section></aside></div>
    <details class="custom-builder"><summary>＋ 添加自定义装备 / 道具 / 技能</summary><div class="custom-grid"><label>类别<select data-custom="category">${[['equipment', '装备'], ['item', '道具'], ['skill', '技能']].map(([value, label]) => optionMarkup(value, label, state.customSelection.category === value)).join('')}</select></label><label>名称<input data-custom="name" value="${esc(state.customSelection.name)}"></label><label>类型<input data-custom="type" value="${esc(state.customSelection.type)}"></label><label>品质<select data-custom="rarity">${Object.keys(RARITY_COSTS).map((rarity) => optionMarkup(rarity, rarity, state.customSelection.rarity === rarity)).join('')}</select></label><label>标签<input data-custom="tag" value="${esc(state.customSelection.tag)}" placeholder="多个标签用、分隔"></label><label>消耗（技能）<input data-custom="consume" value="${esc(state.customSelection.consume)}"></label><label>数量（道具）<input type="number" min="1" data-custom="quantity" value="${state.customSelection.quantity}"></label><label class="setup-wide">描述<textarea data-custom="description">${esc(state.customSelection.description)}</textarea></label><label>效果名<input data-custom="effectName" value="${esc(state.customSelection.effectName)}"></label><label>效果描述<input data-custom="effectDescription" value="${esc(state.customSelection.effectDescription)}"></label><button type="button" data-add-custom-selection>添加（按品质随机计费）</button></div></details>
  </section>`;
}

function availableBackgrounds(catalog, build) {
  const race = build.race === '自定义' ? build.customRace : build.race;
  const identity = build.identity === '自定义' ? build.customIdentity : build.identity;
  const location = build.location === '自定义' ? build.customLocation : build.location;
  return values(catalog.backgrounds).filter((item) => (!item.requiredRace || item.requiredRace === race)
    && (!item.requiredIdentity || item.requiredIdentity === identity)
    && (!item.requiredLocation || item.requiredLocation === location));
}

function companionsMarkup(catalog, state) {
  const partners = values(catalog.partners);
  const backgrounds = [{ name: '【自定义开局】', description: '自由编写开场。' }, ...availableBackgrounds(catalog, state.build)];
  return `<section class="builder-page"><header><span>COMPANIONS</span><h2>伙伴与初始背景</h2><p>预设伙伴会完整写入关系列表；自定义伙伴按生命层级消耗转生点。</p></header>
    <div class="partner-grid">${partners.map((partner) => `<button type="button" data-partner="${esc(partner.name)}" class="partner-card ${state.build.partners.includes(partner.name) ? 'selected' : ''}"><span>${esc(partner.lifeLevel)} · Lv.${partner.level}</span><strong>${esc(partner.name)}</strong><p>${esc(partner.personality)}</p><b>${partner.cost} 点</b></button>`).join('')}</div>
    <details class="custom-builder"><summary>＋ 添加自定义伙伴</summary><div class="custom-grid"><label>姓名<input data-custom-partner="name" value="${esc(state.customPartner.name)}"></label><label>层级<select data-custom-partner="tier">${[1, 2, 3, 4, 5, 6, 7].map((tier) => optionMarkup(tier, `第${tier}层级 · ${PARTNER_COSTS[tier - 1]}点`, Number(state.customPartner.tier) === tier)).join('')}</select></label><label>等级<input type="number" data-custom-partner="level" value="${state.customPartner.level}"></label><label>种族<input data-custom-partner="race" value="${esc(state.customPartner.race)}"></label><label>身份<input data-custom-partner="identity" value="${esc(state.customPartner.identity)}" placeholder="多个身份用、分隔"></label><label>职业<input data-custom-partner="career" value="${esc(state.customPartner.career)}" placeholder="多个职业用、分隔"></label><label>好感度<input type="number" min="-100" max="100" data-custom-partner="affinity" value="${state.customPartner.affinity}"></label><label class="checkbox-label"><input type="checkbox" data-custom-partner="contract" ${state.customPartner.contract ? 'checked' : ''}>缔结命定契约</label><label class="setup-wide">性格<textarea data-custom-partner="personality">${esc(state.customPartner.personality)}</textarea></label><label class="setup-wide">喜爱与关系倾向<textarea data-custom-partner="like">${esc(state.customPartner.like)}</textarea></label><label class="setup-wide">外貌<textarea data-custom-partner="appearance">${esc(state.customPartner.appearance)}</textarea></label><label class="setup-wide">着装<textarea data-custom-partner="clothing">${esc(state.customPartner.clothing)}</textarea></label><label class="setup-wide">心里话<textarea data-custom-partner="comment">${esc(state.customPartner.comment)}</textarea></label><label class="setup-wide">背景<textarea data-custom-partner="background">${esc(state.customPartner.background)}</textarea></label><button type="button" data-add-custom-partner>添加伙伴</button></div>${state.build.customPartners.map((partner, index) => `<button type="button" class="inline-remove" data-remove-custom-partner="${index}">${esc(partner.name)} · 第${partner.tier}层级 ×</button>`).join('')}</details>
    <div class="builder-block"><label>初始开局剧情<select data-build="background">${backgrounds.map((item) => optionMarkup(item.name, item.name, state.build.background === item.name)).join('')}</select></label>${state.build.background === '【自定义开局】' ? `<label>自定义开场描述<textarea data-build="backgroundDescription" rows="6">${esc(state.build.backgroundDescription)}</textarea></label>` : `<article class="selection-detail"><strong>${esc(state.build.background)}</strong><p>${esc(backgrounds.find((item) => item.name === state.build.background)?.description || '')}</p></article>`}</div>
  </section>`;
}

function confirmMarkup(catalog, state) {
  const opening = selectedOpening(state);
  const budget = calculateDestinedPoemBuild(catalog, state.build);
  return `<section class="builder-page"><header><span>CONFIRM</span><h2>确认命运的第一行</h2><p>创建后，核心、DLC 与角色数据会形成不可串档的 Save 初始化快照。</p></header><div class="confirmation-grid"><article><span>篇章</span><strong>${esc(opening.title)}</strong><p>${esc(opening.origin || state.build.location)}</p></article><article><span>命定核心</span><strong>${esc(catalog.cores.find((item) => item.entryComment === state.core)?.label || '未选择')}</strong><p>${state.dlcKeys.size} 个 DLC 组</p></article><article><span>主角</span><strong>${esc(state.name || '旅人')}</strong><p>${state.opening === 'custom' ? `${esc(state.build.race)} · Lv.${state.build.level} · ${budget.remaining} 转生点剩余` : '由固定篇章初始化'}</p></article><article><span>自定义内容</span><strong>${state.build.equipments.length + state.build.items.length + state.build.skills.length + state.build.customSelections.length} 项</strong><p>${state.build.partners.length + state.build.customPartners.length} 名同伴</p></article></div><div class="setup-form-grid"><label>存档名称<input data-model="title" value="${esc(state.title)}" maxlength="200"></label></div><details class="custom-builder preset-builder"><summary>开局配置预设</summary><div class="custom-grid"><label>预设名称<input data-model="presetName" value="${esc(state.presetName)}"></label><button type="button" data-save-preset>保存当前配置</button><label>已保存预设<select data-model="presetToLoad"><option value="">请选择</option>${state.presets.map((preset) => optionMarkup(preset.name, preset.name, state.presetToLoad === preset.name)).join('')}</select></label><div class="preset-actions"><button type="button" data-load-preset>加载</button><button type="button" data-delete-preset>删除</button><button type="button" data-export-preset>导出</button></div></div></details><div class="validation-summary ${state.error ? 'error' : ''}">${esc(state.error || (budget.remaining < 0 ? `转生点不足 ${Math.abs(budget.remaining)} 点` : '配置有效，可以创建存档。'))}</div></section>`;
}

function pageMarkup(catalog, state) {
  if (state.stage === 'rules') return rulesMarkup(catalog, state);
  if (state.stage === 'opening') return openingMarkup(state);
  if (state.stage === 'character') return characterMarkup(catalog, state);
  if (state.stage === 'selections') return selectionsMarkup(catalog, state);
  if (state.stage === 'companions') return companionsMarkup(catalog, state);
  return confirmMarkup(catalog, state);
}

function stageSequence(state) {
  return state.opening === 'custom' ? STAGES : ['rules', 'opening', 'confirm'];
}

function setByInput(state, element) {
  const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
  if (element.dataset.model) state[element.dataset.model] = value;
  if (element.dataset.build) state.build[element.dataset.build] = value;
  if (element.dataset.custom) state.customSelection[element.dataset.custom] = value;
  if (element.dataset.customPartner) state.customPartner[element.dataset.customPartner] = value;
  if (element.dataset.filter) state[element.dataset.filter] = value;
}

export async function renderDestinedPoemSetup({ root, sdk, request }) {
  root.innerHTML = '<main class="setup-loading"><strong>正在展开原卡开局目录…</strong></main>';
  const [catalog, personas] = await Promise.all([
    fetch(sdk.scene.assetUrl('content/setup-catalog.json')).then((response) => {
      if (!response.ok) throw new Error('destined_poem_setup_catalog_unavailable');
      return response.json();
    }),
    request('setup.listPersonas'),
  ]);
  const nullCore = catalog.cores.find((core) => core.label === 'null核心') ?? catalog.cores[0];
  const presetStorageKey = 'tavernnext.destined-poem.start-presets.v1';
  const loadPresets = () => {
    try { const parsed = JSON.parse(localStorage.getItem(presetStorageKey) || '[]'); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  };
  const state = {
    stage: 'rules', core: nullCore?.entryComment ?? '',
    dlcKeys: new Set(catalog.dlcs.filter((dlc) => dlc.enabled).map((dlc) => dlc.key)),
    dlcCategory: '角色', dlcSearch: '', opening: 'custom', personas, personaId: '',
    name: '', description: '', title: '未题名的命运', titleEdited: false, status: '', error: '',
    presets: loadPresets(), presetName: '', presetToLoad: '',
    build: defaultBuild(), selectionKind: 'equipment', selectionCategory: '', selectionSearch: '',
    customSelection: { category: 'equipment', name: '', type: '', rarity: 'common', tag: '', consume: '', quantity: 1, description: '', effectName: '', effectDescription: '' },
    customPartner: { name: '', tier: 1, level: 1, race: '人类', identity: '', career: '', affinity: 0, contract: true, personality: '', like: '', appearance: '', clothing: '', comment: '', background: '' },
  };
  const createSave = async () => {
    state.status = '正在创建存档…'; render();
    try {
      const opening = selectedOpening(state);
      await request('setup.createConversation', [{
        title: state.title.trim() || opening.defaultTitle,
        personaTemplateId: state.personaId || undefined,
        playerProfile: { name: state.name.trim() || '旅人', description: state.description },
        setup: {
          opening: state.opening,
          core: state.core,
          dlcKeys: [...state.dlcKeys],
          origin: opening.origin || (state.build.location === '自定义' ? state.build.customLocation : state.build.location),
          ...(state.opening === 'custom' ? { build: state.build } : {}),
        },
      }]);
    } catch (error) {
      state.error = error.message || String(error); state.status = ''; render();
    }
  };
  const render = () => {
    const sequence = stageSequence(state);
    if (!sequence.includes(state.stage)) state.stage = sequence.at(-1);
    const current = sequence.indexOf(state.stage);
    const budget = calculateDestinedPoemBuild(catalog, state.build);
    root.innerHTML = `<form class="panel setup opening-setup full-builder"><header class="setup-intro"><span>DESTINED POEM · ORIGINAL START BUILDER ${esc(catalog.sourceVersion)}</span><h1>命定之诗开局构建器</h1><p>核心、DLC、角色构建与世界书条目按原卡协议迁移，并改为 Save 级隔离。</p></header>${stageHeader(state)}${pageMarkup(catalog, state)}<footer class="builder-footer"><button type="button" data-prev ${current <= 0 ? 'disabled' : ''}>上一步</button><div><strong>${esc(STAGE_LABELS[state.stage])}</strong><small>${state.status ? esc(state.status) : `步骤 ${current + 1} / ${sequence.length}`}</small></div>${state.stage === 'confirm' ? `<button type="submit" class="primary" data-create ${!state.name.trim() || !state.core || budget.remaining < 0 ? 'disabled' : ''}>创建存档</button>` : '<button type="button" class="primary" data-next>下一步</button>'}</footer></form>`;
    const form = root.querySelector('form');
    form.addEventListener('submit', (event) => { event.preventDefault(); void createSave(); });
    const createButton = form.querySelector('[data-create]');
    if (createButton) createButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void createSave();
    });
  };
  const toggleNamed = (list, name) => {
    const index = list.indexOf(name);
    if (index >= 0) list.splice(index, 1); else list.push(name);
  };
  root.onclick = async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-create')) return;
    state.error = '';
    if (button.dataset.stage) state.stage = button.dataset.stage;
    else if (button.hasAttribute('data-prev') || button.hasAttribute('data-next')) {
      const sequence = stageSequence(state); const index = sequence.indexOf(state.stage);
      state.stage = sequence[Math.max(0, Math.min(sequence.length - 1, index + (button.hasAttribute('data-next') ? 1 : -1)))];
    } else if (button.dataset.dlcCategory) state.dlcCategory = button.dataset.dlcCategory;
    else if (button.dataset.dlc) {
      const result = toggleDestinedPoemDlc(catalog, state.dlcKeys, button.dataset.dlc);
      state.dlcKeys = result.selected;
      state.error = result.error || '';
      state.status = result.error || '';
    } else if (button.hasAttribute('data-reset-dlc')) state.dlcKeys = new Set(catalog.dlcs.filter((dlc) => dlc.enabled).map((dlc) => dlc.key));
    else if (button.dataset.opening) {
      state.opening = button.dataset.opening;
      const opening = selectedOpening(state);
      if (!state.titleEdited) state.title = opening.defaultTitle;
    } else if (button.hasAttribute('data-roll-points')) {
      const random = Math.random();
      state.build.reincarnationPoints = Math.min(10_000, Math.floor(1_000 + 9_001 * random ** 3));
    } else if (button.dataset.attribute) {
      const group = state.build[button.dataset.attribute]; const name = button.dataset.name; const delta = Number(button.dataset.delta);
      const budget = calculateDestinedPoemBuild(catalog, state.build);
      const maximum = button.dataset.attribute === 'basePoints' ? 6 : Math.max(0, state.build.level - 1);
      if (delta < 0 || (button.dataset.attribute === 'basePoints' ? budget.remainingBase : budget.remainingExtra) > 0) group[name] = Math.max(0, Math.min(maximum, group[name] + delta));
    } else if (button.dataset.selectionKind) {
      state.selectionKind = button.dataset.selectionKind;
      state.selectionCategory = Object.keys(catalog[`${state.selectionKind}s`] || {})[0] || '';
    } else if (button.dataset.selectKind) toggleNamed(state.build[`${button.dataset.selectKind}s`], button.dataset.name);
    else if (button.dataset.partner) toggleNamed(state.build.partners, button.dataset.partner);
    else if (button.hasAttribute('data-remove-custom')) state.build.customSelections.splice(Number(button.dataset.removeCustom), 1);
    else if (button.hasAttribute('data-remove-custom-partner')) state.build.customPartners.splice(Number(button.dataset.removeCustomPartner), 1);
    else if (button.hasAttribute('data-add-custom-selection')) {
      const form = state.customSelection; const [minimum, maximum] = RARITY_COSTS[form.rarity] || RARITY_COSTS.common;
      if (!form.name.trim() || !form.type.trim() || !form.effectName.trim()) state.error = '自定义内容需要名称、类型和至少一条效果。';
      else {
        state.build.customSelections.push({ category: form.category, name: form.name.trim(), type: form.type.trim(), rarity: form.rarity, cost: Math.round(minimum + (maximum - minimum) * (.5 + Math.random() * .5)), tag: unique(form.tag.split('、').map((item) => item.trim()).filter(Boolean)), consume: form.consume.trim(), quantity: Math.max(1, Number(form.quantity || 1)), description: form.description.trim(), effect: { [form.effectName.trim()]: form.effectDescription.trim() } });
        state.customSelection = { category: form.category, name: '', type: '', rarity: 'common', tag: '', consume: '', quantity: 1, description: '', effectName: '', effectDescription: '' };
      }
    } else if (button.hasAttribute('data-add-custom-partner')) {
      const form = state.customPartner;
      if (!form.name.trim()) state.error = '自定义伙伴需要姓名。';
      else {
        state.build.customPartners.push({ ...form, identity: unique(form.identity.split('、').map((item) => item.trim()).filter(Boolean)), career: unique(form.career.split('、').map((item) => item.trim()).filter(Boolean)), attributes: Object.fromEntries(ATTRIBUTES.map((name) => [name, 5])) });
        state.customPartner = { name: '', tier: 1, level: 1, race: '人类', identity: '', career: '', affinity: 0, contract: true, personality: '', like: '', appearance: '', clothing: '', comment: '', background: '' };
      }
    } else if (button.hasAttribute('data-save-preset')) {
      const name = state.presetName.trim();
      if (!name) state.error = '请输入预设名称。';
      else {
        const preset = { name, opening: state.opening, core: state.core, dlcKeys: [...state.dlcKeys], nameValue: state.name, description: state.description, title: state.title, build: structuredClone(state.build) };
        state.presets = [...state.presets.filter((item) => item.name !== name), preset];
        localStorage.setItem(presetStorageKey, JSON.stringify(state.presets));
        state.presetToLoad = name;
      }
    } else if (button.hasAttribute('data-load-preset')) {
      const preset = state.presets.find((item) => item.name === state.presetToLoad);
      if (!preset) state.error = '请选择要加载的预设。';
      else {
        state.opening = preset.opening; state.core = preset.core; state.dlcKeys = new Set(preset.dlcKeys);
        state.name = preset.nameValue; state.description = preset.description; state.title = preset.title;
        state.build = structuredClone(preset.build);
      }
    } else if (button.hasAttribute('data-delete-preset')) {
      state.presets = state.presets.filter((item) => item.name !== state.presetToLoad);
      localStorage.setItem(presetStorageKey, JSON.stringify(state.presets)); state.presetToLoad = '';
    } else if (button.hasAttribute('data-export-preset')) {
      const preset = state.presets.find((item) => item.name === state.presetToLoad);
      if (!preset) state.error = '请选择要导出的预设。';
      else {
        const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `destiny_${preset.name}.preset.json`; link.click(); URL.revokeObjectURL(url);
      }
    }
    render();
  };
  root.oninput = (event) => {
    const element = event.target;
    if (element.matches('[data-model],[data-build],[data-custom],[data-custom-partner]')) setByInput(state, element);
  };
  root.onchange = (event) => {
    const element = event.target;
    setByInput(state, element);
    if (element.dataset.model === 'personaId') {
      const persona = personas.find((item) => item.id === state.personaId);
      if (persona) { state.name = persona.name; state.description = persona.description; }
    }
    if (element.dataset.model === 'title') state.titleEdited = true;
    if (element.dataset.build === 'level') state.build.attributePoints = Object.fromEntries(ATTRIBUTES.map((name) => [name, 0]));
    if (element.dataset.build === 'race') {
      const racialCategories = new Set(Object.keys(catalog.baseInfo.raceCosts));
      const skillLookup = new Map(values(catalog.skills).map((item) => [item.name, item]));
      state.build.skills = state.build.skills.filter((name) => !racialCategories.has(skillLookup.get(name)?.category) || skillLookup.get(name)?.category === state.build.race);
    }
    const structuralChange = element.dataset.filter !== undefined
      || element.dataset.model === 'personaId'
      || element.dataset.model === 'core'
      || ['gender', 'race', 'identity', 'location', 'level', 'background'].includes(element.dataset.build);
    if (structuralChange) render();
  };
  render();
}
