import { readFile } from 'node:fs/promises';

const baseState = JSON.parse(await readFile(new URL('../content/initial-state.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value, maximum) => String(value ?? '').slice(0, maximum);
const stableEntries = (value, maximum) => Object.entries(record(value))
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .slice(0, maximum);
const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const stableRoll = (key, state, sides) => {
  const source = `${key}:${JSON.stringify(state)}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % sides + 1;
};

export default {
  async initializeConversation({ setup, playerProfile }) {
    const state = clone(baseState);
    state.世界.地点 = String(setup.origin || '梵尼亚');
    state.主角.姓名 = playerProfile.name;
    state.主角.描述 = playerProfile.description;
    return {
      initialState: state,
      openingMessages: [{
        role: 'assistant',
        content: `【首页】\n命运的书页已经翻开。${playerProfile.name}在${state.世界.地点}醒来，远方的钟声正为一段尚未书写的旅途而鸣。`,
      }],
    };
  },
  async beforeGeneration() {
    return {
      promptAdditions: [{
        role: 'system',
        content: `保持阿斯塔利亚世界观一致，正文使用中文叙事。所有状态和规则变化必须通过提供的工具完成，禁止在正文中输出 <UpdateVariable>、JSON Patch 或隐藏状态命令。
在资源、旅行、关系、任务或命运变化时调用对应的 destined_poem 工具；一般字段变化使用 scene_patch_stage；需要规则判定时调用 destined_poem_rule_check 或 deterministic_check。
当战斗、状态、地图、关系或任务进展值得读者查看时，自主调用 scene_view_stage，并把返回的引用放在正文最合适的位置。`,
      }],
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
      if (location === '') throw new Error('scene_agent_tool_arguments_invalid');
      return {
        content: `旅程已推进至${location}${time === '' ? '' : `（${time}）`}。`,
        detail: { location, ...(time === '' ? {} : { time }) },
        statePatch: [
          { op: 'replace', path: '/世界/地点', value: location },
          ...(time === '' ? [] : [{ op: 'replace', path: '/世界/时间', value: time }]),
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
