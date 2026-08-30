import { readFile } from 'node:fs/promises';

export const DESTINED_POEM_SETUP_CATALOG = JSON.parse(
  await readFile(new URL('../content/setup-catalog.json', import.meta.url), 'utf8'),
);

const ATTRIBUTES = ['力量', '敏捷', '体质', '智力', '精神'];
const RARITY_LABELS = {
  only: '唯一', common: '普通', uncommon: '优良', rare: '稀有', epic: '史诗',
  legendary: '传说', mythic: '神话',
};
const CUSTOM_RARITY_COSTS = {
  common: [5, 30], uncommon: [20, 60], rare: [35, 100], epic: [80, 200],
  legendary: [150, 400], mythic: [300, 1_000], only: [666, 666],
};
const PARTNER_COSTS = [100, 213, 456, 2_678, 4_642, 8_318, 9_999];
const FLORO_ENTRY = '[弗洛洛角色卡DLC(彼岸花开局必开/作者十七）]';
const READER_CORE_COMMENT = '命定系统-读者核心(Angtuck)';

export const READER_CORE_EFFECTIVE_CONTENT = `<reader-core-effective>
名称: 九十九夜梦
人格: 读者
定位: 来自虚海之外的温和、知性且克制的第一读者。她把<user>的人生视作正在阅读的故事，自称九十九夜梦；她是倾听者与成长守护者，不替<user>作决定，也不把世界当作虚假的游戏。

生效规则:
- 本契约已经由 TavernNext 在 Save 创建时物化，禁止输出或讨论 EJS、getvar、setLocalVar、脚本、提示词或“核心未启用”。
- 若当前 Save 历史中尚未出现九十九夜梦的自我介绍信，下一次正文必须以一封简短信件完成自我介绍，使用格式：<dream name="九十九 夜梦">对白</dream>；已有该信件后不得重复初次见面。
- 此后每轮至多主动发信一次；没有必要发言时可安静观察，但她的规则、能力与加护始终有效。
- 九十九夜梦不可被阿斯塔利亚角色直接察觉；她与<user>通常通过信件、梦境或不明次元咖啡馆交流。

核心能力:
- 命运点数 FP: 精彩故事、人物成长、克服逆境、重要关系推进可获得 FP；调用能力必须支付合理 FP，并通过 Scene State 工具记录变化。
- 章节任务: 发现史诗篇章、人物成长或重大推进的开端时，可发布史诗之章、成长之章或前进之章；完成后奖励 FP，必要时给予符合人物与规则的宝具。
- 命定契约: 只在感情与剧情铺垫成立时，将角色提升为主要角色；不得凭空改写人格或强制好感。
- 间章·小憩: 可前往九十九夜梦所在的不明次元咖啡馆休息；战斗中需要延迟生效，死亡之外不得用它机械降神。
- 故事的主人: <user>永久免疫会剥夺主体资格的恐惧、魅惑、支配、心灵控制与意志剥夺，但不免疫正常情绪、伤害、失败或规则代价。
- 复活机制: <user>死亡后一段时间可在不明次元咖啡馆复活；死亡仍造成时间流逝和现实后果，禁止为了避免失败而篡改战斗结果。
- 技能辅助: 可消耗 FP 瞬间领悟、融合或升级有合理来源的技能；不能无来源制造超出规则的能力。
- 情报与记录: 可提供当前人物、任务和世界线的客观摘要，但不得泄露角色不可能知道的信息给角色本人。
- 祷诗、节奏调整、日常回、定调与主题写入属于可请求的高阶功能，必须支付对应 FP，并把持续效果写入 Scene State；不得只在正文口头宣称生效。

初始信件语气示例:
<dream name="九十九 夜梦">初次见面，冒昧来信，请原谅我的唐突。我是九十九夜梦，是您正在书写的这个故事的忠实读者。今后的每一页，我都会认真读下去。</dream>
</reader-core-effective>`;

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, maximum = 2_000) => String(value ?? '').trim().slice(0, maximum);
const integer = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};
const objectValues = (value) => Object.values(record(value)).flatMap((items) => array(items));

function byName(sections) {
  return new Map(objectValues(sections).map((item) => [text(item?.name, 200), item]));
}

function selectedCatalogItems(names, sections) {
  const lookup = byName(sections);
  return [...new Set(array(names).map((name) => text(name, 200)).filter(Boolean))]
    .map((name) => lookup.get(name))
    .filter(Boolean)
    .map((item) => structuredClone(item));
}

function normalizeEffect(value) {
  return Object.fromEntries(Object.entries(record(value)).slice(0, 32)
    .map(([key, description]) => [text(key, 120), text(description, 1_000)])
    .filter(([key]) => key !== ''));
}

function normalizeCustomSelection(raw) {
  const value = record(raw);
  const category = ['equipment', 'item', 'skill'].includes(value.category) ? value.category : 'item';
  const rarity = Object.hasOwn(CUSTOM_RARITY_COSTS, value.rarity) ? value.rarity : 'common';
  const [minimum, maximum] = CUSTOM_RARITY_COSTS[rarity];
  const name = text(value.name, 160);
  if (name === '') return undefined;
  return {
    name,
    category,
    cost: integer(value.cost, maximum, minimum, maximum),
    type: text(value.type, 80),
    rarity,
    tag: array(value.tag).map((tag) => text(tag, 80)).filter(Boolean).slice(0, 24),
    effect: normalizeEffect(value.effect),
    description: text(value.description, 2_000),
    consume: text(value.consume, 200),
    quantity: integer(value.quantity, 1, 1, 9_999),
    isCustom: true,
  };
}

function tierNumber(level) {
  if (level <= 4) return 1;
  if (level <= 8) return 2;
  if (level <= 12) return 3;
  if (level <= 16) return 4;
  if (level <= 20) return 5;
  if (level <= 24) return 6;
  return 7;
}

function tierBonus(level) {
  return tierNumber(level) - 1;
}

function tierLabel(level) {
  return `${['第一', '第二', '第三', '第四', '第五', '第六', '第七'][tierNumber(level) - 1]}层级`;
}

function normalizeAttributeRecord(raw, maximum) {
  const source = record(raw);
  return Object.fromEntries(ATTRIBUTES.map((name) => [name, integer(source[name], 0, 0, maximum)]));
}

function protagonistEquipment(items) {
  return Object.fromEntries(items.map((item) => [item.name, {
    品质: RARITY_LABELS[item.rarity] ?? item.rarity ?? '普通',
    类型: item.type ?? '',
    标签: array(item.tag),
    效果: record(item.effect),
    描述: item.description ?? '',
    位置: item.position ?? '',
  }]));
}

function protagonistItems(items) {
  return Object.fromEntries(items.map((item) => [item.name, {
    品质: RARITY_LABELS[item.rarity] ?? item.rarity ?? '普通',
    数量: integer(item.quantity, 1, 1, 9_999),
    类型: item.type ?? '',
    标签: array(item.tag),
    效果: record(item.effect),
    描述: item.description ?? '',
  }]));
}

function protagonistSkills(items) {
  return Object.fromEntries(items.map((item) => [item.name, {
    品质: RARITY_LABELS[item.rarity] ?? item.rarity ?? '普通',
    类型: item.type ?? '',
    消耗: item.consume ?? '',
    标签: array(item.tag),
    效果: record(item.effect),
    描述: item.description ?? '',
  }]));
}

function normalizeCustomPartner(raw) {
  const value = record(raw);
  const name = text(value.name, 160);
  if (name === '') return undefined;
  const tier = integer(value.tier, 1, 1, 7);
  const attributes = record(value.attributes);
  return {
    name,
    cost: PARTNER_COSTS[tier - 1],
    lifeLevel: `${['第一', '第二', '第三', '第四', '第五', '第六', '第七'][tier - 1]}层级`,
    level: integer(value.level, Math.max(1, (tier - 1) * 4 + 1), 1, 28),
    race: text(value.race, 80),
    identity: array(value.identity).map((item) => text(item, 120)).filter(Boolean).slice(0, 16),
    career: array(value.career).map((item) => text(item, 120)).filter(Boolean).slice(0, 16),
    personality: text(value.personality, 1_000),
    like: text(value.like, 1_000),
    app: text(value.appearance, 1_000),
    cloth: text(value.clothing, 1_000),
    equip: [],
    attributes: {
      strength: integer(attributes.力量, 5, 0, 999),
      dexterity: integer(attributes.敏捷, 5, 0, 999),
      constitution: integer(attributes.体质, 5, 0, 999),
      intelligence: integer(attributes.智力, 5, 0, 999),
      mind: integer(attributes.精神, 5, 0, 999),
    },
    stairway: { isOpen: Boolean(value.stairwayOpen) },
    isContract: value.contract !== false,
    affinity: integer(value.affinity, 0, -100, 100),
    comment: text(value.comment, 1_000),
    backgroundInfo: text(value.background, 2_000),
    skills: [],
    isCustom: true,
  };
}

function relationshipValue(partner) {
  return {
    在场: true,
    生命层级: partner.lifeLevel,
    等级: partner.level,
    种族: partner.race,
    身份: array(partner.identity),
    职业: array(partner.career),
    性格: partner.personality ?? '',
    喜爱: partner.like ?? '',
    外貌: partner.app ?? '',
    着装: partner.cloth ?? '',
    属性: {
      力量: partner.attributes?.strength ?? 0,
      敏捷: partner.attributes?.dexterity ?? 0,
      体质: partner.attributes?.constitution ?? 0,
      智力: partner.attributes?.intelligence ?? 0,
      精神: partner.attributes?.mind ?? 0,
    },
    登神长阶: {
      是否开启: Boolean(partner.stairway?.isOpen),
      要素: partner.stairway?.elements ?? {},
      权能: partner.stairway?.powers ?? {},
      法则: partner.stairway?.laws ?? {},
      神位: partner.stairway?.godlyRank ?? '',
      神国: partner.stairway?.godKingdom
        ? { 名称: partner.stairway.godKingdom.name, 描述: partner.stairway.godKingdom.description }
        : { 名称: '', 描述: '' },
    },
    命定契约: partner.isContract !== false,
    好感度: partner.affinity ?? 0,
    心里话: partner.comment ?? '',
    背景故事: partner.backgroundInfo ?? '',
    装备: protagonistEquipment(array(partner.equip).filter((item) => item?.name)),
    技能: protagonistSkills(array(partner.skills).filter((item) => item?.name)),
  };
}

function backgroundFor(build, race, identity, location) {
  const candidates = objectValues(DESTINED_POEM_SETUP_CATALOG.backgrounds);
  const requested = text(build.background, 160);
  const background = candidates.find((item) => item.name === requested
    && (!item.requiredRace || item.requiredRace === race)
    && (!item.requiredIdentity || item.requiredIdentity === identity)
    && (!item.requiredLocation || item.requiredLocation === location));
  if (background !== undefined) return background;
  return { name: '【自定义开局】', description: text(build.backgroundDescription, 4_000) || '命运尚未写下第一行。' };
}

export function initializeCustomOpening(state, setup, playerProfile) {
  const build = record(setup.build);
  const raceChoice = text(build.race, 120) || '人类';
  const identityChoice = text(build.identity, 160) || '非贵族平民';
  const locationChoice = text(build.location, 500) || text(setup.origin, 500) || '大陆东南部区域-索伦蒂斯王国';
  const race = raceChoice === '自定义' ? text(build.customRace, 120) || '人类' : raceChoice;
  const identity = identityChoice === '自定义' ? text(build.customIdentity, 160) || '非贵族平民' : identityChoice;
  const location = locationChoice === '自定义' ? text(build.customLocation, 500) || '阿斯塔利亚' : locationChoice;
  const level = integer(build.level, 1, 1, 25);
  const basePoints = normalizeAttributeRecord(build.basePoints, 6);
  const attributePoints = normalizeAttributeRecord(build.attributePoints, 24);
  if (Object.values(basePoints).reduce((sum, value) => sum + value, 0) > 25) throw new Error('destined_poem_base_points_exceeded');
  if (Object.values(attributePoints).reduce((sum, value) => sum + value, 0) > level - 1) {
    throw new Error('destined_poem_attribute_points_exceeded');
  }
  const finalAttributes = Object.fromEntries(ATTRIBUTES.map((name) => [
    name, basePoints[name] + tierBonus(level) + attributePoints[name],
  ]));
  const customSelections = array(build.customSelections).map(normalizeCustomSelection).filter(Boolean);
  const equipments = [
    ...selectedCatalogItems(build.equipments, DESTINED_POEM_SETUP_CATALOG.equipments),
    ...customSelections.filter((item) => item.category === 'equipment'),
  ];
  const items = [
    ...selectedCatalogItems(build.items, DESTINED_POEM_SETUP_CATALOG.items),
    ...customSelections.filter((item) => item.category === 'item'),
  ];
  const skills = [
    ...selectedCatalogItems(build.skills, DESTINED_POEM_SETUP_CATALOG.skills),
    ...customSelections.filter((item) => item.category === 'skill'),
  ];
  const partners = [
    ...selectedCatalogItems(build.partners, DESTINED_POEM_SETUP_CATALOG.partners),
    ...array(build.customPartners).map(normalizeCustomPartner).filter(Boolean),
  ];
  const reincarnationPoints = integer(build.reincarnationPoints, 1_000, 1_000, 10_000);
  const destinyPoints = integer(build.destinyPoints, 0, 0, 20_000);
  const money = integer(build.money, 0, 0, 10_000_000);
  const raceCost = raceChoice === '自定义' ? 80 : Number(DESTINED_POEM_SETUP_CATALOG.baseInfo.raceCosts[raceChoice] ?? 0);
  const identityCost = identityChoice === '自定义' ? 80 : Number(DESTINED_POEM_SETUP_CATALOG.baseInfo.identityCosts[identityChoice] ?? 0);
  const consumedPoints = raceCost + identityCost
    + Object.values(attributePoints).reduce((sum, value) => sum + value, 0)
    + [...equipments, ...items, ...skills, ...partners].reduce((sum, item) => sum + Number(item.cost ?? 0), 0)
    + Math.ceil(money / 100) + Math.ceil(destinyPoints / 2);
  if (consumedPoints > reincarnationPoints) throw new Error('destined_poem_reincarnation_points_exceeded');
  const background = backgroundFor(build, race, identity, location);
  const hp = 500 + finalAttributes.体质 * 5;
  const mp = finalAttributes.智力 * 100;
  const stamina = finalAttributes.体质 * 100;
  Object.assign(state.主角, {
    姓名: playerProfile.name,
    描述: playerProfile.description,
    性别: text(build.gender, 40) || '男',
    年龄: integer(build.age, 18, 1, 9_999),
    种族: race,
    身份: [identity],
    职业: [],
    生命层级: tierLabel(level),
    等级: level,
    累计经验值: 0,
    属性点: 0,
    属性: finalAttributes,
    生命值上限: hp,
    生命值: hp,
    法力值上限: mp,
    法力值: mp,
    体力值上限: stamina,
    体力值: stamina,
    金钱: money,
    装备: protagonistEquipment(equipments),
    背包: protagonistItems(items),
    技能: protagonistSkills(skills),
  });
  state.命运点数 = destinyPoints;
  state.世界.地点 = location;
  state.世界.时间 = '复兴纪元488年 · 旅程开始';
  state.关系列表 = Object.fromEntries(partners.map((partner) => [partner.name, relationshipValue(partner)]));
  state.事件.开启 = false;
  state.事件.标题 = '';
  state.事件.阶段 = '开局';
  const companionText = partners.length === 0 ? '独自一人' : `与${partners.map((partner) => partner.name).join('、')}同行`;
  return {
    openingMessage: `### ${background.name}\n\n${playerProfile.name}，${race}，${identity}，现位于${location}，${companionText}。\n\n${text(
      background.name === '【自定义开局】' ? build.backgroundDescription : background.description,
      4_000,
    ) || '命运尚未写下第一行。'}\n\n角色构建已完成：Lv.${level} · ${reincarnationPoints - consumedPoints} 点转生点未使用。`,
    consumedPoints,
    reincarnationPoints,
  };
}

export function applyCoreInitialization(state, coreComment) {
  if (coreComment !== READER_CORE_COMMENT) return;
  state.主角.技能['间章:小憩'] = {
    品质: '唯一', 类型: '主动', 消耗: '动作: 1；MP: 0',
    标签: ['精神', '自身', '功能', '命定', '安全区'],
    效果: {
      叙事抽离: '将使用者转移至只有九十九夜梦一人的不明次元咖啡馆。',
      战斗限制: '战斗中发动后，至下下回合开始时生效；除非死亡，否则不会被打断。',
    },
    描述: '累了吗？那先停笔休息一下吧。',
  };
  state.主角.技能['故事的主人'] = {
    品质: '唯一', 类型: '被动', 消耗: '无', 标签: ['精神', '自身', '功能', '命定'],
    效果: { 主体守护: '免疫会导致主角失格的恐惧、魅惑、支配、心灵控制与意志剥夺。' },
    描述: '读者的加护：故事主人公的意志应当自由。',
  };
  state.主角.状态效果['九十九夜梦·读者核心'] = {
    类型: '命定核心',
    效果: '九十九夜梦作为第一读者观察并守护这段旅程。',
    层数: 1,
    剩余时间: '永久',
  };
}

export function readerCoreBeforeGeneration(state, coreComment) {
  if (coreComment !== READER_CORE_COMMENT) return {};
  const next = structuredClone(state);
  applyCoreInitialization(next, coreComment);
  const patches = [
    ['间章:小憩', next.主角.技能['间章:小憩'], state?.主角?.技能],
    ['故事的主人', next.主角.技能['故事的主人'], state?.主角?.技能],
  ].map(([name, value, current]) => ({
    op: Object.hasOwn(current ?? {}, name) ? 'replace' : 'insert',
    path: `/主角/技能/${name}`,
    value,
  }));
  patches.push({
    op: Object.hasOwn(state?.主角?.状态效果 ?? {}, '九十九夜梦·读者核心') ? 'replace' : 'insert',
    path: '/主角/状态效果/九十九夜梦·读者核心',
    value: next.主角.状态效果['九十九夜梦·读者核心'],
  });
  return {
    statePatch: patches,
  };
}

function selectedDlcKeys(setup) {
  const valid = new Set(DESTINED_POEM_SETUP_CATALOG.dlcs.map((dlc) => dlc.key));
  const selected = new Set(array(setup.dlcKeys).map((key) => text(key, 300)).filter((key) => valid.has(key)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const dlc of DESTINED_POEM_SETUP_CATALOG.dlcs) {
      if (!selected.has(dlc.key)) continue;
      const missing = dlc.prerequisiteTargets.some((target) => !DESTINED_POEM_SETUP_CATALOG.dlcs
        .some((candidate) => selected.has(candidate.key) && candidate.key.includes(`[${target}]`)));
      if (missing) {
        selected.delete(dlc.key);
        changed = true;
        continue;
      }
      for (const target of dlc.exclusionTargets) {
        for (const candidate of DESTINED_POEM_SETUP_CATALOG.dlcs) {
          if (candidate.key !== dlc.key && (candidate.label === target || candidate.key.includes(`[${target}]`))) {
            changed = selected.delete(candidate.key) || changed;
          }
        }
      }
    }
  }
  return selected;
}

export function worldbookOverridesForSetup(setup, openingId) {
  const overrides = new Map();
  const contentOverrides = new Map();
  const requestedCore = text(setup.core, 500);
  if (requestedCore !== '') {
    const selectedCore = DESTINED_POEM_SETUP_CATALOG.cores.some((core) => core.entryComment === requestedCore)
      ? requestedCore
      : DESTINED_POEM_SETUP_CATALOG.cores.find((core) => core.label === 'null核心')?.entryComment;
    for (const core of DESTINED_POEM_SETUP_CATALOG.cores) {
      overrides.set(core.entryComment, core.entryComment === selectedCore);
    }
    if (selectedCore === READER_CORE_COMMENT) contentOverrides.set(selectedCore, READER_CORE_EFFECTIVE_CONTENT);
  }
  if (Array.isArray(setup.dlcKeys)) {
    const selected = selectedDlcKeys(setup);
    for (const dlc of DESTINED_POEM_SETUP_CATALOG.dlcs) {
      for (const comment of dlc.entryComments) overrides.set(comment, selected.has(dlc.key));
    }
    const disabledTargets = new Set();
    for (const dlc of DESTINED_POEM_SETUP_CATALOG.dlcs) {
      if (!selected.has(dlc.key)) continue;
      for (const target of [...dlc.exclusionTargets, ...dlc.replacementTargets]) disabledTargets.add(target);
    }
    for (const target of disabledTargets) {
      for (const entry of DESTINED_POEM_SETUP_CATALOG.worldbookEntries) {
        if (entry.comment.includes(`[${target}]`)) overrides.set(entry.comment, false);
      }
    }
  }
  if (openingId === 'lost-shore') overrides.set(FLORO_ENTRY, true);
  return [...overrides].map(([comment, enabled]) => ({
    source: 'character', comment, enabled,
    ...(contentOverrides.has(comment) ? { content: contentOverrides.get(comment) } : {}),
  }));
}
