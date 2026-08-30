import { readFile } from 'node:fs/promises';
import {
  applyCoreInitialization,
  initializeCustomOpening,
  readerCoreBeforeGeneration,
  worldbookOverridesForSetup,
} from './setup.mjs';

const baseState = JSON.parse(await readFile(new URL('../content/initial-state.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value, maximum) => String(value ?? '').slice(0, maximum);
const stableEntries = (value, maximum) => Object.entries(record(value))
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .slice(0, maximum);
const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const attributes = new Set(['力量', '敏捷', '体质', '智力', '精神']);
const stableRoll = (key, state, sides) => {
  const source = `${key}:${JSON.stringify(state)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % sides + 1;
};

export const DESTINED_POEM_OPENING_IDS = [
  'custom',
  'summoned-hero',
  'lost-shore',
  'divine-party',
];

const openingDefinition = (id) => ({
  custom: {
    title: '',
    stage: '等待落笔',
    time: '',
    message: ({ name, location }) => `【首页】\n命运的书页已经翻开。${name}已抵达${location}。\n\n这是一个自定义开局：请在第一条消息中写下你想要的时代、身份、同行者、眼前事件，或任何必须遵守的开场条件。`,
  },
  'summoned-hero': {
    title: '无光的第四位勇者',
    stage: '召唤仪式',
    time: '复兴纪元488年 · 风信之月15日 · 14:00',
    location: '阿斯塔利亚大陆 · 奥古斯提姆帝国 · 布劳尔子爵领 · 子爵城堡 · 仪式大厅',
    message: ({ name }) => `### 无光的第四位勇者

强烈的失重感骤然停止，${name}的鞋底落在冰冷石板上。彩窗、残烛与尚未熄灭的召唤阵勾勒出一座破败而宏伟的仪式大厅。布劳尔子爵和他的宫廷法师站在台阶上，宣称四名异界人是拯救领地的勇者。

与你一同到来的三人先后显露神迹：金色护盾、元素火花与流动的符文。轮到你时，什么也没有发生。法师低声猜测你或许只是随从，卫兵的目光从戒备变成轻慢。

然而，在众人的失望声里，你分明感觉到某种不属于光、火焰或魔力的东西正在意识深处苏醒。子爵正等待你对这场荒唐召唤作出回应。`,
  },
  'lost-shore': {
    title: '失亡彼岸的重逢',
    stage: '泣空遗迹',
    time: '复兴纪元488年 · 风信之月15日 · 12:00',
    location: '阿斯塔利亚大陆上空 · 泣歌云海 · 泣空遗迹 · 中央大圣堂',
    message: ({ name }) => `### 失亡彼岸

游戏终章的门扉在屏幕上开启。${name}以“漂泊者”的身份踏入失亡彼岸，本应播放的过场却化作撕裂感官的坠落。再次睁眼时，脚下只剩漂浮于万丈云海之上的白色神殿废墟。

风穿过断裂穹顶。女神像的阴影下，一袭深红礼裙的弗洛洛缓缓转身。那个本应在旧世界结局里消逝的少女如今真实地站在这里，异色眼瞳里没有重逢的喜悦，只有漫长等待沉淀出的爱、恨与戒备。

“既然你追到了这里……”她望向云海，彼岸花法杖在风里洒落虚幻花瓣，“那就陪我看完这场不知何时才会落幕的歌剧吧。”`,
  },
  'divine-party': {
    title: '神恩日的不速之客',
    stage: '诸神宴席',
    time: '复兴纪元488年 · 神恩日',
    location: '万象神殿',
    message: ({ name }) => `### 误入诸神宴席

神恩日的雪落在诺瓦瓦伦蒂亚。刚完成公会委托的${name}还坐在酒馆里，端着一杯麦酒思考来年的去向；下一瞬，炉火与喧闹同时碎裂，脚下已变成由星辰和凝固光辉铺成的神殿地面。

辉煌女神、先祖之魂、潮汐女神、翡翠之母与月之低语者齐齐望来。观测咒文与幸运神力的意外共鸣，竟把水镜里的凡人直接带进了诸神的年度宴席。

幸运女神泰珂看了看你手中一滴未洒的麦酒，露出略显心虚的笑容：“嗨？欢迎来到诸神派对，幸运的凡人。神恩日快乐？”`,
  },
}[id]);

const initializeProtagonist = (state, values) => {
  Object.assign(state.主角, {
    种族: '人类',
    身份: values.identity,
    职业: ['暂无'],
    生命层级: '第一层级/普通',
    等级: 1,
    累计经验值: 0,
    属性点: 0,
    属性: {
      力量: values.attribute,
      敏捷: values.attribute,
      体质: values.attribute,
      智力: values.attribute,
      精神: values.attribute,
    },
    生命值上限: values.maxHp,
    生命值: values.hp,
    法力值上限: values.resource,
    法力值: values.resource,
    体力值上限: values.resource,
    体力值: values.resource,
  });
  state.命运点数 = values.fate;
};

export default {
  async initializeConversation({ setup, playerProfile }) {
    const state = clone(baseState);
    state.世界.天气 = '';
    const requestedOpening = String(setup.opening || 'custom');
    const openingId = DESTINED_POEM_OPENING_IDS.includes(requestedOpening) ? requestedOpening : 'custom';
    const opening = openingDefinition(openingId);
    state.世界.地点 = opening.location || String(setup.origin || '梵尼亚');
    state.世界.时间 = opening.time;
    state.事件.开启 = openingId !== 'custom';
    state.事件.标题 = opening.title;
    state.事件.阶段 = opening.stage;
    state.主角.姓名 = playerProfile.name;
    state.主角.描述 = playerProfile.description;
    const custom = openingId === 'custom' && setup.build && typeof setup.build === 'object'
      ? initializeCustomOpening(state, setup, playerProfile)
      : undefined;
    if (openingId === 'summoned-hero') {
      initializeProtagonist(state, {
        identity: ['被召唤的勇者'], attribute: 5, maxHp: 525, hp: 500, resource: 500, fate: 500,
      });
    } else if (openingId === 'lost-shore') {
      initializeProtagonist(state, {
        identity: ['漂泊者'], attribute: 5, maxHp: 525, hp: 525, resource: 500, fate: 200,
      });
      state.关系列表.弗洛洛 = {
        姓名: '弗洛洛',
        在场: true,
        种族: '人类',
        身份: ['吟游诗人', '异世界的猩红女巫'],
        生命层级: '第四层级/史诗',
        好感度: 49,
        命定契约: true,
        描述: '来自旧世界的猩红女巫。她与漂泊者一同越过失亡彼岸，在新世界重逢。',
      };
    } else if (openingId === 'divine-party') {
      initializeProtagonist(state, {
        identity: ['冒险者'], attribute: 4, maxHp: 400, hp: 400, resource: 400, fate: 0,
      });
    }
    applyCoreInitialization(state, String(setup.core || ''));
    return {
      initialState: state,
      openingMessages: [{
        role: 'assistant',
        content: custom?.openingMessage ?? opening.message({ name: playerProfile.name, location: state.世界.地点 }),
      }],
      worldbookEntryOverrides: worldbookOverridesForSetup(setup, openingId),
    };
  },
  async beforeGeneration({ state, setup }) {
    const readerCore = readerCoreBeforeGeneration(state, String(setup?.core || ''));
    return {
      ...readerCore,
      promptAdditions: [{
        role: 'system',
        content: `保持阿斯塔利亚世界观一致，正文使用中文叙事。所有状态和规则变化必须通过提供的工具完成，禁止在正文中输出 <UpdateVariable>、JSON Patch 或隐藏状态命令。
在资源、旅行、天气、关系、任务或命运变化时调用对应的 destined_poem 工具；一般字段变化使用 scene_patch_stage；需要规则判定时调用 destined_poem_rule_check 或 deterministic_check。<tp> 仅为兼容展示标记，其中时间、地点和天气不修改也不覆盖 Scene State。
当战斗、状态、地图、关系或任务进展值得读者查看时，自主调用 scene_view_stage，并把返回的引用放在正文最合适的位置。`,
      }],
    };
  },
  async handleAction({ action, state }) {
    const command = record(action);
    if (command.type !== 'allocate-attribute' || !attributes.has(command.attribute)) {
      return { accepted: false, result: { ok: false, code: 'attribute_allocation_invalid' } };
    }
    const protagonist = record(record(state).主角);
    const available = finite(protagonist.属性点);
    if (available < 1) {
      return { accepted: false, result: { ok: false, code: 'attribute_points_exhausted' } };
    }
    const attribute = String(command.attribute);
    const before = finite(record(protagonist.属性)[attribute]);
    return {
      accepted: true,
      statePatch: [
        { op: 'delta', path: '/主角/属性点', value: -1 },
        { op: 'delta', path: `/主角/属性/${attribute}`, value: 1 },
      ],
      result: { ok: true, attribute, before, after: before + 1, remainingPoints: available - 1 },
    };
  },
  async executeAgentTool({ toolName, arguments: args, workspace }) {
    const state = record(workspace?.state);
    if (toolName === 'destined_poem_adjust_fate') {
      const amount = Number(args?.amount);
      const reason = String(args?.reason ?? '').trim();
      if (!Number.isInteger(amount) || amount < -10 || amount > 10 || reason === '') {
        throw new Error('scene_agent_tool_arguments_invalid');
      }
      const before = finite(state.命运点数, Number.NaN);
      if (!Number.isFinite(before)) throw new Error('scene_agent_tool_state_invalid');
      return {
        content: `命运点数因“${reason}”${amount >= 0 ? '增加' : '减少'}${Math.abs(amount)}点。`,
        detail: { before, after: before + amount, amount, reason },
        statePatch: [{ op: 'delta', path: '/命运点数', value: amount }],
      };
    }
    if (toolName === 'destined_poem_adjust_vitals') {
      const protagonist = record(state.主角);
      const changes = [
        ['hpDelta', '生命值', '生命值上限'], ['mpDelta', '法力值', '法力值上限'],
        ['staminaDelta', '体力值', '体力值上限'],
      ];
      const statePatch = changes.flatMap(([argument, field, maximum]) => {
        if (args?.[argument] === undefined) return [];
        const delta = Number(args[argument]);
        if (!Number.isInteger(delta)) throw new Error('scene_agent_tool_arguments_invalid');
        const next = Math.max(0, Math.min(finite(protagonist[maximum]), finite(protagonist[field]) + delta));
        return [{ op: 'replace', path: `/主角/${field}`, value: next }];
      });
      const effects = record(protagonist.状态效果);
      const addStatus = args?.addStatus === undefined ? '' : String(args.addStatus).trim();
      const removeStatus = args?.removeStatus === undefined ? '' : String(args.removeStatus).trim();
      if (addStatus !== '') statePatch.push({
        op: Object.hasOwn(effects, addStatus) ? 'replace' : 'insert', path: `/主角/状态效果/${pointer(addStatus)}`, value: true,
      });
      if (removeStatus !== '' && Object.hasOwn(effects, removeStatus)) {
        statePatch.push({ op: 'remove', path: `/主角/状态效果/${pointer(removeStatus)}` });
      }
      if (statePatch.length === 0) throw new Error('scene_agent_tool_arguments_invalid');
      return { content: '主角资源与状态已按本轮事件更新。', detail: { operationCount: statePatch.length }, statePatch };
    }
    if (toolName === 'destined_poem_travel') {
      const location = String(args?.location ?? '').trim();
      const time = args?.time === undefined ? '' : String(args.time).trim();
      const weather = args?.weather === undefined ? '' : String(args.weather).trim();
      if (location === '') throw new Error('scene_agent_tool_arguments_invalid');
      const world = record(state.世界);
      return {
        content: `旅程已推进至${location}${time === '' ? '' : `（${time}）`}${weather === '' ? '' : `，天气为${weather}`}。`,
        detail: { location, ...(time === '' ? {} : { time }), ...(weather === '' ? {} : { weather }) },
        statePatch: [
          { op: 'replace', path: '/世界/地点', value: location },
          ...(time === '' ? [] : [{ op: 'replace', path: '/世界/时间', value: time }]),
          ...(weather === '' ? [] : [{
            op: Object.hasOwn(world, '天气') ? 'replace' : 'insert', path: '/世界/天气', value: weather,
          }]),
        ],
      };
    }
    if (toolName === 'destined_poem_update_relationship') {
      const entityId = String(args?.entityId ?? '').trim();
      const name = String(args?.name ?? '').trim();
      const description = String(args?.description ?? '');
      const affinityDelta = Number(args?.affinityDelta);
      if (entityId === '' || name === '' || !Number.isInteger(affinityDelta)) {
        throw new Error('scene_agent_tool_arguments_invalid');
      }
      const relationships = record(state.关系列表);
      const prior = Object.hasOwn(relationships, entityId) ? record(relationships[entityId]) : {};
      const next = { ...prior, 姓名: name, 好感度: finite(prior.好感度) + affinityDelta, 描述: description };
      return {
        content: `与${name}的关系已更新。`, detail: { entityId, affinity: next.好感度 },
        statePatch: [{
          op: Object.hasOwn(relationships, entityId) ? 'replace' : 'insert',
          path: `/关系列表/${pointer(entityId)}`, value: next,
        }],
      };
    }
    if (toolName === 'destined_poem_update_quest') {
      const questId = String(args?.questId ?? '').trim();
      const title = String(args?.title ?? '').trim();
      const status = String(args?.status ?? '');
      const description = String(args?.description ?? '');
      if (questId === '' || title === '' || !['active', 'completed', 'failed'].includes(status)) {
        throw new Error('scene_agent_tool_arguments_invalid');
      }
      const quests = record(state.任务列表);
      const value = { 标题: title, 状态: status, 描述: description };
      return {
        content: `任务“${title}”已标记为 ${status}。`, detail: { questId, status },
        statePatch: [{
          op: Object.hasOwn(quests, questId) ? 'replace' : 'insert', path: `/任务列表/${pointer(questId)}`, value,
        }],
      };
    }
    if (toolName === 'destined_poem_rule_check') {
      const key = String(args?.key ?? '').trim();
      const difficulty = Number(args?.difficulty);
      const modifier = args?.modifier === undefined ? 0 : Number(args.modifier);
      const sides = args?.sides === undefined ? 20 : Number(args.sides);
      if (key === '' || !Number.isInteger(difficulty) || !Number.isInteger(modifier) || !Number.isInteger(sides)) {
        throw new Error('scene_agent_tool_arguments_invalid');
      }
      const roll = stableRoll(key, state, sides);
      const total = roll + modifier;
      return {
        content: `规则判定 ${key}: ${roll}+${modifier}=${total}，${total >= difficulty ? '成功' : '失败'}。`,
        detail: { key, roll, modifier, total, difficulty, sides, success: total >= difficulty },
      };
    }
    throw new Error('scene_agent_tool_not_found');
  },
  async projectSceneView({ kind, relatedEntities, workspace }) {
    const state = workspace?.state ?? {};
    const protagonist = state.主角 ?? {};
    const relationships = state.关系列表 ?? {};
    const statuses = stableEntries(protagonist.状态效果, 32).map(([name]) => short(name, 80));
    if (kind === 'status') return { props: {
      name: short(protagonist.姓名 || '主角', 160), level: finite(protagonist.等级),
      rank: short(protagonist.冒险者等级, 80), fate: finite(state.命运点数),
      resources: {
        hp: finite(protagonist.生命值), maxHp: finite(protagonist.生命值上限),
        mp: finite(protagonist.法力值), maxMp: finite(protagonist.法力值上限),
        stamina: finite(protagonist.体力值), maxStamina: finite(protagonist.体力值上限),
      },
      attributes: Object.fromEntries(stableEntries(protagonist.属性, 32).map(([key, value]) => [short(key, 80), finite(value)])),
      statuses,
    } };
    if (kind === 'map') {
      const markers = Array.isArray(state.地图?.标记) ? state.地图.标记 : [];
      const selected = (relatedEntities.length === 0
        ? [...markers].sort((left, right) => (
          String(right?.name ?? right?.名称 ?? '') === String(state.世界?.地点 || '') ? 1 : 0
        ) - (
          String(left?.name ?? left?.名称 ?? '') === String(state.世界?.地点 || '') ? 1 : 0
        ))
        : markers.filter((marker) => relatedEntities.includes(String(marker?.id)))).slice(0, 12);
      return { props: {
        location: short(state.世界?.地点, 160), time: short(state.世界?.时间, 160),
        markers: selected.map((marker) => ({
          id: short(marker?.id, 120), name: short(marker?.name ?? marker?.名称, 160),
          group: short(marker?.group, 80), description: short(marker?.description, 320),
          active: String(marker?.name ?? marker?.名称 ?? '') === String(state.世界?.地点 || ''),
        })),
      } };
    }
    if (kind === 'relationship') {
      const ids = (relatedEntities.length === 0
        ? stableEntries(relationships, 32).map(([id]) => id)
        : [...new Set(relatedEntities)].sort().slice(0, 32));
      return { props: { entries: ids.map((id) => {
        const relation = record(relationships[id]);
        return {
          id: short(id, 120), name: short(relation.姓名 ?? relation.名称 ?? id, 160), affinity: finite(relation.好感度),
          description: short(relation.描述, 500),
        };
      }) } };
    }
    if (kind === 'progress') {
      const quests = record(state.任务列表);
      return { props: {
        event: { title: short(state.事件?.标题, 160), stage: short(state.事件?.阶段, 160) },
        quests: stableEntries(quests, 32).map(([id, raw]) => {
          const quest = record(raw);
          return {
            id: short(id, 120), title: short(quest.标题 ?? quest.name ?? id, 160),
            status: short(quest.状态 ?? quest.status ?? 'active', 32), description: short(quest.描述 ?? quest.description, 1000),
          };
        }),
        level: finite(protagonist.等级), experience: finite(protagonist.累计经验值),
        nextExperience: finite(protagonist.升级所需经验),
      } };
    }
    if (kind !== 'combat') throw new Error('scene_view_kind_not_found');
    const opponents = relatedEntities.map((id) => {
      const relation = relationships[id] && typeof relationships[id] === 'object' ? relationships[id] : {};
      const combat = relation.战斗 && typeof relation.战斗 === 'object' ? relation.战斗 : relation;
      return {
        id: short(id, 120),
        name: short(relation.姓名 ?? relation.名称 ?? id, 160),
        hp: Number.isFinite(Number(combat.生命值)) ? Number(combat.生命值) : 0,
        maxHp: Number.isFinite(Number(combat.生命值上限)) ? Number(combat.生命值上限) : 0,
        statuses: stableEntries(combat.状态效果, 8).map(([name]) => short(name, 40)),
      };
    });
    return {
      props: {
        title: short(state.事件?.标题 || '战斗态势', 160),
        location: short(state.世界?.地点, 160),
        protagonist: {
          name: short(protagonist.姓名 || '主角', 160),
          hp: Number.isFinite(Number(protagonist.生命值)) ? Number(protagonist.生命值) : 0,
          maxHp: Number.isFinite(Number(protagonist.生命值上限)) ? Number(protagonist.生命值上限) : 0,
          statuses,
        },
        opponents: opponents.slice(0, 16),
      },
    };
  },
};
