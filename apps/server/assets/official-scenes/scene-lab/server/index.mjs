const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, fallback = '') => typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export default {
  initializeConversation({ setup, playerProfile }) {
    const experimentName = text(object(setup).experimentName, '未命名实验');
    return {
      title: experimentName,
      initialState: { experimentName, phase: 'ready', signal: 0 },
      openingMessages: [{
        role: 'assistant',
        content: `${text(playerProfile?.name, '观察者')}，实验“${experimentName}”已经就绪。`,
      }],
    };
  },
  beforeGeneration() {
    return { promptAdditions: [{ role: 'system', content: 'Use scene_lab_adjust_signal when the observed signal changes.' }] };
  },
  afterGeneration() { return {}; },
  handleAction({ action }) {
    if (object(action).type !== 'reset') return { result: { ok: false, code: 'scene_lab_action_unknown' } };
    return {
      statePatch: [
        { op: 'replace', path: '/phase', value: 'ready' },
        { op: 'replace', path: '/signal', value: 0 },
      ],
      result: { ok: true },
    };
  },
  executeAgentTool({ toolName, arguments: args, workspace }) {
    if (toolName !== 'scene_lab_adjust_signal') throw new Error('scene_agent_tool_not_found');
    const delta = finite(object(args).delta);
    if (!Number.isInteger(delta) || delta < -10 || delta > 10) throw new Error('scene_agent_tool_arguments_invalid');
    const before = finite(object(workspace?.state).signal);
    return {
      content: `Experiment signal changes from ${before} to ${before + delta}.`,
      detail: { before, after: before + delta },
      statePatch: [
        { op: 'delta', path: '/signal', value: delta },
        { op: 'replace', path: '/phase', value: 'observing' },
      ],
    };
  },
  projectSceneView({ kind, workspace }) {
    if (kind !== 'status') throw new Error('scene_view_kind_not_found');
    const state = object(workspace?.state);
    return { props: {
      experimentName: text(state.experimentName, '未命名实验'),
      phase: text(state.phase, 'ready'),
      signal: finite(state.signal),
    } };
  },
};
