import { readFile } from 'node:fs/promises';

const baseState = JSON.parse(await readFile(new URL('../content/initial-state.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

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
        content: `保持阿斯塔利亚世界观一致，正文使用中文叙事。变量字段及更新条件以世界书中的 variables_update_rules 与当前状态系统段为准。
当本轮发生人物初始化、属性、资源、背包、技能、任务、关系、事件、时间或地点变化时，必须在正文末尾输出且只输出一个变量块：
<UpdateVariable>
<Analysis>用不超过80词简要分析本轮变量变化</Analysis>
<JSONPatch>
[
  { "op": "replace", "path": "/已有字段", "value": "新值" },
  { "op": "delta", "path": "/已有数字字段", "value": 1 },
  { "op": "insert", "path": "/对象/新键", "value": {} },
  { "op": "insert", "path": "/数组/-", "value": "新项" },
  { "op": "remove", "path": "/已有字段" },
  { "op": "move", "from": "/原路径", "to": "/目标路径" }
]
</JSONPatch>
</UpdateVariable>
只输出实际需要的操作，不要照抄示例，不要在结束标签后追加内容。各操作独立执行，单项失败不会撤销其他成功项。`,
      }],
    };
  },
};
