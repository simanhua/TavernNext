import { readFile } from 'node:fs/promises';

const baseState = JSON.parse(await readFile(new URL('../content/initial-state.json', import.meta.url), 'utf8'));
const originalRuinedTempleOpening = (await readFile(new URL('../content/openings/ruined-temple.md', import.meta.url), 'utf8')).trim();
const originalMarketRedThreadOpening = (await readFile(new URL('../content/openings/market-red-thread.md', import.meta.url), 'utf8')).trim();
const clone = (value) => structuredClone(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const short = (value, maximum = 500) => String(value ?? '').trim().slice(0, maximum);
const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const OPENINGS = {
  'ruined-temple': {
    title: '云梦雨夜', location: '江南·云梦泽外围荒庙', weather: '大雨', time: '戌时五刻', affinity: 5, relation: '陌生',
    message: () => originalRuinedTempleOpening,
  },
  'market-red-thread': {
    title: '坊市红线', location: '中州边境·青石坊市', weather: '阴', time: '申时末', affinity: 20, relation: '陌生',
    message: () => originalMarketRedThreadOpening,
  },
  'traveling-companion': {
    title: '同路问山', location: '中州·前往太虚仙宗的古道', weather: '薄雾', time: '卯时二刻', affinity: 86, relation: '同行道友',
    message: (name) => `### 同路问山\n\n晨雾压在古道两侧，远处群峰只剩淡墨般的轮廓。你与楚霁寒同行已有三月，他依旧少言，却会在每次宿营时把背风的位置留给你。\n\n今日，太虚仙宗的接引剑光第一次出现在天际。楚霁寒停下脚步，戒中老人也罕见地沉默。\n\n他看向${name}：“到了山门，跟紧我。”`,
  },
};

const THEMES = new Set(['xuanqing', 'danxia', 'xuanzang', 'yuebai']);

function normalizeSetup(raw) {
  const setup = record(raw);
  const contentMode = setup.contentMode === 'mature' ? 'mature' : 'general';
  const requestedRedThread = ['none', 'fated', 'intimacy'].includes(setup.redThread) ? setup.redThread : 'none';
  const opening = Object.hasOwn(OPENINGS, setup.opening) ? setup.opening : 'ruined-temple';
  return {
    opening,
    loreDetail: setup.loreDetail === 'full' ? 'full' : 'concise',
    relationshipMode: setup.relationshipMode === 'original-multi-romance' ? 'original-multi-romance' : 'adventure-focus',
    contentMode,
    redThread: opening === 'market-red-thread'
      ? 'fated'
      : requestedRedThread === 'intimacy' && contentMode !== 'mature' ? 'none' : requestedRedThread,
    theme: THEMES.has(setup.theme) ? setup.theme : 'xuanqing',
  };
}

function affinityStage(value) {
  if (value <= 60) return '路人';
  if (value <= 150) return '上心';
  if (value <= 250) return '动真心';
  if (value <= 350) return '不能没有';
  if (value <= 450) return '认定';
  return '不可撼动';
}

function worldbookOverrides(setup) {
  const enabled = new Map([
    ['char灵根功法', true],
    ['九州地域图（简洁版）', setup.loreDetail !== 'full'],
    ['门派势力（简洁版）', setup.loreDetail !== 'full'],
    ['人人天骄', true],
    ['门派势力（详细版）', setup.loreDetail === 'full'],
    ['九州地域图（详细版）', setup.loreDetail === 'full'],
    ['修仙大佬', true],
    ['太虚子及七弟子', true],
    ['主线（跑主线再开）', true],
    ['修仙世界观', true],
    ['(可选)阶段性任务目标', true],
    ['修仙必备知识宝库(选开)', setup.loreDetail === 'full'],
    ['(选一)2.爱情向好感阶段', setup.relationshipMode === 'original-multi-romance'],
    ['char恋爱观', setup.relationshipMode === 'original-multi-romance'],
    ['龙傲天桃花一（已相遇）', setup.relationshipMode === 'original-multi-romance'],
    ['龙傲天桃花二（未相遇时选开，两百年后，必开）', setup.relationshipMode === 'original-multi-romance'],
    ['爱情的人选不是唯一', setup.relationshipMode === 'original-multi-romance'],
    ['花心一点', setup.relationshipMode === 'original-multi-romance' && setup.contentMode === 'mature'],
    ['nsfw（用时开）', setup.contentMode === 'mature'],
    ['第一个设定:性爱红线', setup.contentMode === 'mature' && setup.redThread === 'intimacy'],
    ['第二个设定:姻缘红线', setup.redThread === 'fated'],
    ['修仙状态栏', false],
    ['古风多人状态栏', false],
    ['现代状态栏', false],
    ['（选一）②两百年后，我们已是陌路', false],
    ['十年后（默认以前爱过后分开）', false],
    ['两百年后的char', false],
    ['（选一）①两百年前没放下的爱', false],
    ['假如c失忆(二十岁)', false],
    ['(选一)1.亲情向好感阶段', false],
    ['❷系统VS太虚子', false],
    ['❶假如c是现代人穿越', false],
    ['除bg外开，性取向规范', false],
    ['⑴反穿设定', false],
    ['⑵约束及npc', false],
    ['⑶原主白月光（非u）', false],
  ]);
  return [...enabled].map(([comment, value]) => ({ source: 'character', comment, enabled: value }));
}

function openingFor(setup) {
  return OPENINGS[setup.opening] ?? OPENINGS['ruined-temple'];
}

function relationshipModePrompt(setup) {
  if (setup.relationshipMode === 'original-multi-romance') {
    return '关系模式使用原卡的多重真心逻辑，但关系变化必须有剧情依据并通过 taixu_update_relationship 更新。';
  }
  return '本 Save 以冒险和调查为主。不要主动安排恋爱或亲密关系；只有玩家明确推动且剧情成立时才发展关系。';
}

export default {
  async initializeConversation({ setup, playerProfile }) {
    const normalizedSetup = normalizeSetup(setup);
    const state = clone(baseState);
    const opening = openingFor(normalizedSetup);
    const openingTitle = opening.title;
    state.世界.地点 = opening.location;
    state.世界.天气 = opening.weather;
    state.世界.时辰 = opening.time;
    state.世界.章节 = `第一卷·${openingTitle}`;
    state.界面.主题 = normalizedSetup.theme;
    state.关系.player = {
      姓名: short(playerProfile.name, 160) || '无名旅人',
      关系: opening.relation,
      好感: opening.affinity,
      阶段: affinityStage(opening.affinity),
      描述: short(playerProfile.description, 500),
      红线: normalizedSetup.redThread === 'fated'
        ? '姻缘红线'
        : normalizedSetup.redThread === 'intimacy' ? '亲密红线规则已启用·尚未连接' : '无',
    };
    return {
      title: `${openingTitle} · ${playerProfile.name || '无名旅人'}`,
      initialState: state,
      openingMessages: [{ role: 'assistant', content: opening.message(playerProfile.name || '旅人', normalizedSetup) }],
      worldbookEntryOverrides: worldbookOverrides(normalizedSetup),
    };
  },

  async beforeGeneration({ setup }) {
    const normalizedSetup = normalizeSetup(setup);
    return { promptAdditions: [{ role: 'system', content: `当前为20岁成年时间线。${relationshipModePrompt(normalizedSetup)}
Scene State 是世界时间、楚霁寒境界、太虚子魂力、关系、任务与长生局线索的唯一权威。变化必须调用 taixu 工具，禁止输出旧卡的 <status_bar>、<xianxia_status>、HTML 或变量更新文本。
长生局必须以玩家与楚霁寒实际取得的碎片线索推进；不得提前揭露凶手。太虚子能教导、遮掩和在濒死时短暂接管身体，但不能直接常驻出手。` }] };
  },

  handleAction({ action, state }) {
    const value = record(action);
    if (value.type === 'set-theme' && THEMES.has(value.theme)) {
      return { accepted: true, statePatch: [{ op: 'replace', path: '/界面/主题', value: value.theme }], result: { ok: true } };
    }
    if (value.type === 'chapter-event') {
      const chapter = record(record(state).第一章);
      const eventId = short(value.eventId, 120);
      if (eventId !== chapter.当前事件) {
        return { accepted: false, result: { ok: false, code: 'chapter_event_out_of_order', expected: chapter.当前事件 } };
      }
      if (eventId === 'journey-to-sect') {
        return {
          accepted: true,
          statePatch: [
            { op: 'replace', path: '/世界/地点', value: '太虚仙宗·山门石阶' },
            { op: 'replace', path: '/世界/章节', value: '第一章·问山路' },
            { op: 'replace', path: '/第一章/阶段', value: '抵达山门' },
            { op: 'replace', path: '/第一章/当前事件', value: 'water-root-test' },
          ],
          result: { ok: true, eventId, nextEvent: 'water-root-test' },
        };
      }
      if (eventId === 'water-root-test') {
        return {
          accepted: true,
          statePatch: [
            { op: 'replace', path: '/世界/地点', value: '太虚仙宗·问心坪' },
            { op: 'replace', path: '/世界/章节', value: '第一章·叩问山门' },
            { op: 'replace', path: '/第一章/阶段', value: '入门试炼' },
            { op: 'replace', path: '/第一章/当前事件', value: 'concealment-check' },
            { op: 'replace', path: '/第一章/已完成事件', value: ['water-root-test'] },
          ],
          result: { ok: true, eventId, nextEvent: 'concealment-check' },
        };
      }
      if (eventId === 'concealment-check') {
        return {
          accepted: true,
          statePatch: [
            { op: 'replace', path: '/楚霁寒/暴露风险', value: 12 },
            { op: 'replace', path: '/第一章/当前事件', value: 'taixuzi-first-spend' },
            { op: 'replace', path: '/第一章/藏拙判定', value: '成功·测灵石仅显露水属性单灵根' },
            { op: 'replace', path: '/第一章/已完成事件', value: [...chapter.已完成事件, eventId] },
          ],
          result: { ok: true, eventId, nextEvent: 'taixuzi-first-spend' },
        };
      }
      if (eventId === 'taixuzi-first-spend') {
        const soulAfterSpend = Math.max(0, finite(record(record(state).太虚子).魂力) - 8);
        return {
          accepted: true,
          statePatch: [
            { op: 'replace', path: '/太虚子/魂力', value: soulAfterSpend },
            { op: 'replace', path: '/太虚子/状态', value: '短暂虚弱' },
            { op: 'replace', path: '/第一章/当前事件', value: 'meet-talent' },
            { op: 'replace', path: '/第一章/已完成事件', value: [...chapter.已完成事件, eventId] },
          ],
          result: { ok: true, eventId, nextEvent: 'meet-talent' },
        };
      }
      if (eventId === 'meet-talent') {
        return {
          accepted: true,
          statePatch: [
            {
              op: 'insert', path: '/关系/shen-hantang', value: {
                姓名: '沈寒棠',
                关系: '同届试炼者·丹阁真传',
                好感: 18,
                阶段: '路人',
                描述: '在测灵石异响时注意到楚霁寒的丹阁真传。',
                红线: '无',
              },
            },
            { op: 'replace', path: '/第一章/当前事件', value: 'first-clue' },
            { op: 'replace', path: '/第一章/已完成事件', value: [...chapter.已完成事件, eventId] },
          ],
          result: { ok: true, eventId, nextEvent: 'first-clue' },
        };
      }
      if (eventId === 'first-clue') {
        return {
          accepted: true,
          statePatch: [
            { op: 'replace', path: '/世界/地点', value: '太虚仙宗·外门临时居所' },
            { op: 'replace', path: '/世界/章节', value: '第一章·山门留名' },
            { op: 'replace', path: '/楚霁寒/公开身份', value: '太虚仙宗外门记名弟子' },
            { op: 'replace', path: '/第一章/阶段', value: '已获得临时身份' },
            { op: 'replace', path: '/第一章/当前事件', value: 'completed' },
            { op: 'replace', path: '/第一章/已完成事件', value: [...chapter.已完成事件, eventId] },
            { op: 'replace', path: '/长生局/目标', value: '在外门站稳脚跟，查明测灵石五行残响的来源' },
            {
              op: 'replace', path: '/长生局/线索', value: [{
                id: 'spirit-stone-fivefold-echo',
                标题: '测灵石中的五行残响',
                详情: '太虚子遮掩灵根时，测灵石内部回应了不属于当代阵纹的五行轮转。',
              }],
            },
            {
              op: 'replace', path: '/任务/enter-taixu', value: {
                标题: '叩问太虚',
                状态: 'completed',
                描述: '楚霁寒以水灵根散修身份通过入门试炼，取得外门记名弟子玉牌。',
              },
            },
            {
              op: 'insert', path: '/任务/outer-sect-foothold', value: {
                标题: '外门藏锋',
                状态: 'active',
                描述: '在外门建立可信身份，同时追查测灵石中的五行残响。',
              },
            },
          ],
          result: { ok: true, eventId, nextEvent: 'completed' },
        };
      }
    }
    return { accepted: false, result: { ok: false, code: 'taixu_action_unknown' } };
  },

  executeAgentTool({ toolName, arguments: args, workspace }) {
    const state = record(workspace?.state);
    if (toolName === 'taixu_advance_world') {
      const location = short(args?.location, 160);
      if (location === '') throw new Error('scene_agent_tool_arguments_invalid');
      const fields = [['地点', location], ['日期', short(args?.date, 120)], ['时辰', short(args?.time, 120)], ['天气', short(args?.weather, 120)], ['章节', short(args?.chapter, 160)]];
      return {
        content: `行程已推进至${location}。`, detail: { location },
        statePatch: fields.filter(([, value]) => value !== '').map(([field, value]) => ({ op: 'replace', path: `/世界/${field}`, value })),
      };
    }
    if (toolName === 'taixu_adjust_cultivation') {
      const amount = Number(args?.amount);
      const reason = short(args?.reason, 240);
      if (!Number.isInteger(amount) || amount < -25 || amount > 25 || reason === '') throw new Error('scene_agent_tool_arguments_invalid');
      const character = record(state.楚霁寒);
      const realm = record(character.境界);
      const root = record(character.灵根);
      const before = finite(realm.进度);
      const after = clamp(before + amount, 0, 100);
      const realmName = short(args?.realmName, 80);
      const realmStage = short(args?.realmStage, 80);
      const unlockElement = short(args?.unlockElement, 20);
      const unlocked = Array.isArray(root.已解锁) ? root.已解锁 : [];
      const locked = Array.isArray(root.未解锁) ? root.未解锁 : [];
      const canUnlock = unlockElement !== '' && locked.includes(unlockElement) && !unlocked.includes(unlockElement);
      return {
        content: `楚霁寒的修行进度因“${reason}”由${before}%变为${after}%。`, detail: { before, after, reason, ...(canUnlock ? { unlockElement } : {}) },
        statePatch: [
          { op: 'replace', path: '/楚霁寒/境界/进度', value: after },
          ...(realmName === '' ? [] : [{ op: 'replace', path: '/楚霁寒/境界/名称', value: realmName }]),
          ...(realmStage === '' ? [] : [{ op: 'replace', path: '/楚霁寒/境界/阶段', value: realmStage }]),
          ...(canUnlock ? [
            { op: 'replace', path: '/楚霁寒/灵根/已解锁', value: [...unlocked, unlockElement] },
            { op: 'replace', path: '/楚霁寒/灵根/未解锁', value: locked.filter((name) => name !== unlockElement) },
          ] : []),
        ],
      };
    }
    if (toolName === 'taixu_update_relationship') {
      const entityId = short(args?.entityId, 120);
      const name = short(args?.name, 160);
      const relation = short(args?.relation, 160);
      const affinityDelta = Number(args?.affinityDelta);
      if (entityId === '' || name === '' || relation === '' || !Number.isInteger(affinityDelta)) throw new Error('scene_agent_tool_arguments_invalid');
      const relationships = record(state.关系);
      const prior = record(relationships[entityId]);
      const affinity = clamp(finite(prior.好感) + affinityDelta, 0, 500);
      const value = { ...prior, 姓名: name, 关系: relation, 好感: affinity, 阶段: affinityStage(affinity), 描述: short(args?.description ?? prior.描述, 500) };
      return { content: `楚霁寒与${name}的关系已更新。`, detail: { entityId, affinity, stage: value.阶段 }, statePatch: [{ op: Object.hasOwn(relationships, entityId) ? 'replace' : 'insert', path: `/关系/${pointer(entityId)}`, value }] };
    }
    if (toolName === 'taixu_add_clue') {
      const id = short(args?.id, 120); const title = short(args?.title, 160); const detail = short(args?.detail, 1000);
      if (id === '' || title === '' || detail === '') throw new Error('scene_agent_tool_arguments_invalid');
      const investigation = record(state.长生局);
      const clues = Array.isArray(investigation.线索) ? investigation.线索 : [];
      const next = [...clues.filter((clue) => record(clue).id !== id), { id, 标题: title, 详情: detail }].slice(-64);
      const suspectId = short(args?.suspectId, 120);
      const suspectStatus = short(args?.suspectStatus, 160);
      const suspects = Array.isArray(investigation.嫌疑人) ? investigation.嫌疑人 : [];
      const updatesSuspect = suspectId !== '' && suspectStatus !== '' && suspects.some((suspect) => record(suspect).id === suspectId);
      return { content: `长生局新增线索：“${title}”。`, detail: { id, title, ...(updatesSuspect ? { suspectId, suspectStatus } : {}) }, statePatch: [
        { op: 'replace', path: '/长生局/线索', value: next },
        ...(updatesSuspect ? [{ op: 'replace', path: '/长生局/嫌疑人', value: suspects.map((suspect) => record(suspect).id === suspectId ? { ...record(suspect), 状态: suspectStatus } : suspect) }] : []),
      ] };
    }
    if (toolName === 'taixu_update_quest') {
      const questId = short(args?.questId, 120); const title = short(args?.title, 160); const status = short(args?.status, 32); const description = short(args?.description, 1000);
      if (questId === '' || title === '' || !['active', 'completed', 'failed'].includes(status)) throw new Error('scene_agent_tool_arguments_invalid');
      const quests = record(state.任务); const value = { 标题: title, 状态: status, 描述: description };
      return { content: `任务“${title}”已更新为${status}。`, detail: { questId, status }, statePatch: [{ op: Object.hasOwn(quests, questId) ? 'replace' : 'insert', path: `/任务/${pointer(questId)}`, value }] };
    }
    if (toolName === 'taixu_adjust_soul') {
      const amount = Number(args?.amount); const reason = short(args?.reason, 240);
      if (!Number.isInteger(amount) || amount < -30 || amount > 10 || reason === '') throw new Error('scene_agent_tool_arguments_invalid');
      const soul = record(state.太虚子); const before = finite(soul.魂力); const after = clamp(before + amount, 0, 100);
      const status = short(args?.status, 80);
      const takeoverDelta = args?.takeoverDelta === undefined ? 0 : Number(args.takeoverDelta);
      const resurrectionProgressDelta = args?.resurrectionProgressDelta === undefined ? 0 : Number(args.resurrectionProgressDelta);
      if (!Number.isInteger(takeoverDelta) || !Number.isInteger(resurrectionProgressDelta)) throw new Error('scene_agent_tool_arguments_invalid');
      const sleepingUntil = short(args?.sleepingUntil, 120);
      return { content: `太虚子的魂力因“${reason}”由${before}%变为${after}%。`, detail: { before, after, reason }, statePatch: [
        { op: 'replace', path: '/太虚子/魂力', value: after },
        ...(status === '' ? [] : [{ op: 'replace', path: '/太虚子/状态', value: status }]),
        ...(sleepingUntil === '' ? [] : [{ op: 'replace', path: '/太虚子/沉睡至', value: sleepingUntil }]),
        ...(takeoverDelta === 0 ? [] : [{ op: 'replace', path: '/太虚子/可接管次数', value: Math.max(0, finite(soul.可接管次数) + takeoverDelta) }]),
        ...(resurrectionProgressDelta === 0 ? [] : [{ op: 'replace', path: '/太虚子/还魂丹进度', value: clamp(finite(soul.还魂丹进度) + resurrectionProgressDelta, 0, 100) }]),
      ] };
    }
    if (toolName === 'taixu_adjust_exposure') {
      const amount = Number(args?.amount); const reason = short(args?.reason, 240);
      if (!Number.isInteger(amount) || amount < -30 || amount > 30 || reason === '') throw new Error('scene_agent_tool_arguments_invalid');
      const before = finite(record(state.楚霁寒).暴露风险); const after = clamp(before + amount, 0, 100);
      return { content: `楚霁寒的身份暴露风险因“${reason}”由${before}%变为${after}%。`, detail: { before, after, reason }, statePatch: [{ op: 'replace', path: '/楚霁寒/暴露风险', value: after }] };
    }
    if (toolName === 'taixu_unlock_region') {
      const regionId = short(args?.regionId, 120); const reason = short(args?.reason, 240);
      if (regionId === '' || reason === '') throw new Error('scene_agent_tool_arguments_invalid');
      const regions = Array.isArray(record(state.地图).区域) ? state.地图.区域 : [];
      if (!regions.some((region) => record(region).id === regionId)) throw new Error('scene_agent_tool_arguments_invalid');
      return { content: `九州舆图因“${reason}”解锁了新的区域。`, detail: { regionId, reason }, statePatch: [{ op: 'replace', path: '/地图/区域', value: regions.map((region) => record(region).id === regionId ? { ...record(region), 已解锁: true } : region) }] };
    }
    throw new Error('scene_agent_tool_not_found');
  },

  projectSceneView({ kind, relatedEntities, workspace }) {
    const state = record(workspace?.state);
    const character = record(state.楚霁寒);
    if (kind === 'status') {
      const realm = record(character.境界);
      return { props: { name: short(character.姓名, 160), identity: short(character.公开身份, 160), realm: `${short(realm.名称, 60)}·${short(realm.阶段, 60)}`, progress: finite(realm.进度), soul: finite(record(state.太虚子).魂力), risk: finite(character.暴露风险) } };
    }
    if (kind === 'relationship') {
      const relationships = record(state.关系);
      const ids = relatedEntities.length > 0 ? relatedEntities : Object.keys(relationships);
      return { props: { entries: ids.slice(0, 32).flatMap((id) => {
        const relation = record(relationships[id]);
        return relation.姓名 ? [{ id: short(id, 120), name: short(relation.姓名, 160), relation: short(relation.关系, 160), affinity: finite(relation.好感), stage: short(relation.阶段, 80) }] : [];
      }) } };
    }
    if (kind === 'investigation') {
      const investigation = record(state.长生局);
      const clues = Array.isArray(investigation.线索) ? investigation.线索 : [];
      return { props: { stage: short(investigation.阶段, 160), goal: short(investigation.目标, 500), clues: clues.slice(0, 64).map((raw) => { const clue = record(raw); return { id: short(clue.id, 120), title: short(clue.标题, 160), detail: short(clue.详情, 1000) }; }) } };
    }
    if (kind === 'map') {
      const regions = Array.isArray(record(state.地图).区域) ? state.地图.区域 : [];
      return { props: { location: short(record(state.世界).地点, 160), regions: regions.slice(0, 16).map((raw) => { const region = record(raw); return { id: short(region.id, 120), name: short(region.名称, 160), description: short(region.描述, 500), unlocked: Boolean(region.已解锁) }; }) } };
    }
    throw new Error('scene_view_kind_not_found');
  },
};
