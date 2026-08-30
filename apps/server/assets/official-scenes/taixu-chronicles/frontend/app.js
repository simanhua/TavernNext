import {
  renderTaixuActionOptions,
  stripTaixuActionOptions,
  taixuActionOptionsForMessages,
} from './action-options.mjs?v=1.3.3';

let generationCleanup;
let workspaceMode = 'story';
let generationWasBusy = false;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const entries = (value) => Object.entries(record(value));

function activeVariant(message) {
  return message.variants?.find((variant) => variant.id === message.activeVariantId) ?? message.variants?.[0];
}

function textMarkup(value) {
  return esc(value).split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`).join('');
}

export function renderSceneView({ root, block }) {
  const props = record(block.props);
  if (block.kind === 'status' && block.rendererId === 'taixu-status-v1') {
    root.innerHTML = `<section class="tx-view tx-view-status"><header><strong>${esc(props.name)}</strong><span>${esc(props.identity)}</span></header><div class="tx-view-grid"><div><small>境界</small><b>${esc(props.realm)}</b></div><div><small>修行</small><b>${esc(props.progress)}%</b></div><div><small>魂力</small><b>${esc(props.soul)}%</b></div><div><small>风险</small><b>${esc(props.risk)}%</b></div></div></section>`;
  } else if (block.kind === 'relationship' && block.rendererId === 'taixu-relationship-v1') {
    root.innerHTML = `<section class="tx-view"><header><strong>因缘录</strong><span>${props.entries?.length ?? 0} 人</span></header><div class="tx-view-list">${(props.entries ?? []).map((item) => `<div><b>${esc(item.name)}</b><span>${esc(item.relation)} · ${esc(item.stage)}</span><em>${esc(item.affinity)}/500</em></div>`).join('')}</div></section>`;
  } else if (block.kind === 'investigation' && block.rendererId === 'taixu-investigation-v1') {
    root.innerHTML = `<section class="tx-view"><header><strong>长生局 · ${esc(props.stage)}</strong><span>${props.clues?.length ?? 0} 条线索</span></header><p>${esc(props.goal)}</p><div class="tx-view-list">${(props.clues ?? []).map((item) => `<div><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></div>`).join('') || '<div class="empty">尚无足以落笔的线索</div>'}</div></section>`;
  } else if (block.kind === 'map' && block.rendererId === 'taixu-map-v1') {
    root.innerHTML = `<section class="tx-view"><header><strong>九州舆图</strong><span>${esc(props.location)}</span></header><div class="tx-view-grid">${(props.regions ?? []).map((item) => `<div class="${item.unlocked ? '' : 'locked'}"><small>${item.unlocked ? '已知' : '未至'}</small><b>${esc(item.name)}</b></div>`).join('')}</div></section>`;
  } else throw new Error('taixu_scene_view_unsupported');
  return () => root.replaceChildren();
}

function messageBody(message) {
  const variant = activeVariant(message);
  const document = variant?.document;
  if (!Array.isArray(document?.blocks)) {
    return textMarkup(stripTaixuActionOptions(variant?.content ?? message.content ?? ''));
  }
  return document.blocks.map((block, index) => block.type === 'scene-view'
    ? `<div data-scene-view="${index}"></div>`
    : textMarkup(stripTaixuActionOptions(block.content ?? ''))).join('');
}

function playerOperationMarkup(operation) {
  return `<article class="tx-player-operation"><small>${esc(operation.kind)}</small><strong>${esc(operation.title)}</strong><p>${esc(operation.summary)}</p></article>`;
}

function mountMessageViews(root, messages) {
  for (const message of messages) {
    const blocks = activeVariant(message)?.document?.blocks;
    if (!Array.isArray(blocks)) continue;
    const article = root.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
    blocks.forEach((block, index) => {
      if (block.type !== 'scene-view') return;
      const target = article?.querySelector(`[data-scene-view="${index}"]`);
      if (target) renderSceneView({ root: target, block });
    });
  }
}

const themeOptions = [
  ['xuanqing', '玄青'], ['danxia', '丹霞'], ['xuanzang', '玄藏'], ['yuebai', '月白'],
];

function themePicker(theme) {
  return `<div class="tx-themes" role="group" aria-label="主题皮肤">${themeOptions.map(([id, label]) => `<button type="button" data-theme="${id}" class="${theme === id ? 'active' : ''}" aria-label="${label}主题" aria-pressed="${theme === id}"><i></i>${label}</button>`).join('')}</div>`;
}

const openingCards = [
  ['ruined-temple', '云梦雨夜', '陌生相逢', '荒庙、冷雨与一块被拨近的木柴。'],
  ['market-red-thread', '坊市红线', '命数初显', '青石坊市擦肩而过，看见只有彼此可见的红线。'],
];

const chapterEvents = {
  'journey-to-sect': { eyebrow: '第一章 · 序', title: '前往太虚仙宗', description: '晨雾漫过古道尽头，太虚山门已在云间显出轮廓。走完最后一段问山路，才算真正踏入棋局。', action: '踏上问山路' },
  'water-root-test': { eyebrow: '入门试炼 · 第一关', title: '水灵根测试', description: '踏上问心坪，将手按上测灵石。石中阵纹会判断楚霁寒对外显露的灵根。', action: '接受测灵石检验' },
  'concealment-check': { eyebrow: '灵光将起', title: '藏拙判定', description: '混沌灵根引发了极淡的五行残响。必须在执事察觉前把异象压回水色。', action: '收束五行灵息' },
  'taixuzi-first-spend': { eyebrow: '戒中传音', title: '太虚子第一次消耗魂力', description: '旧阵纹仍在回应混沌气息。太虚子可以用残魂之力遮去最后一层痕迹。', action: '请太虚子遮掩残响' },
  'meet-talent': { eyebrow: '丹阁来客', title: '与天骄相遇', description: '丹阁真传沈寒棠停在测灵石旁。她似乎注意到了那一瞬不合常理的稳定。', action: '平静回应沈寒棠' },
  'first-clue': { eyebrow: '石中旧痕', title: '第一条长生局线索', description: '测灵石边缘剥落了一枚碎屑，其内五行轮转的手法与太虚子的记忆同源。', action: '收起碎屑并领取玉牌' },
  completed: { eyebrow: '第一章完成', title: '山门留名', description: '楚霁寒取得外门记名弟子身份。真正的调查，将从这块不起眼的玉牌开始。', action: '' },
};

const fallbackActionOptions = [
  '先观察四周，不急着开口。',
  '询问太虚仙宗的方向与开山试炼。',
  '留意楚霁寒手上的青铜古戒。',
];

function actionOptionsMarkup(messages) {
  const generated = taixuActionOptionsForMessages(messages);
  const options = generated.length > 0 ? generated : fallbackActionOptions;
  return renderTaixuActionOptions(options, generated.length > 0 ? 'generated' : 'fallback');
}

async function renderSetup(root, sdk) {
  const personas = await sdk.setup.listPersonas();
  const state = {
    opening: 'ruined-temple', loreDetail: 'concise', relationshipMode: 'adventure-focus',
    redThread: 'none', contentMode: 'general', theme: 'xuanqing',
    name: '', description: '', personaId: '', status: '', error: '',
  };
  const background = sdk.scene.assetUrl('content/background.png');
  const portrait = sdk.scene.assetUrl('content/character.png');
  const render = () => {
    root.innerHTML = `<main class="tx-setup theme-${state.theme}" style="--tx-bg:url('${background}')">
      <div class="tx-setup-backdrop"></div>
      <header class="tx-setup-head"><a href="/"><span class="tx-seal">太</span><div><strong>太虚问道</strong><small>TAIXU CHRONICLES</small></div></a>${themePicker(state.theme)}</header>
      <div class="tx-setup-layout">
        <section class="tx-setup-copy"><span>楚霁寒角色卡 · SCENE ADAPTATION</span><h1>藏锋入世，<br>问道太虚</h1><p>选择相逢方式。世界、境界、关系、任务与万年前的线索，将在这个存档里独立生长。</p><div class="tx-setup-character"><img src="${portrait}" alt="楚霁寒"><div><small>同行角色</small><strong>楚霁寒</strong><span>金丹中期 · 水灵根散修</span></div></div></section>
        <form class="tx-setup-panel"><section><header><span>壹</span><div><small>OPENING</small><h2>从何处落笔</h2></div></header><div class="tx-opening-grid">${openingCards.map(([id, title, meta, description]) => `<button type="button" data-opening="${id}" class="${state.opening === id ? 'selected' : ''}"><span>${esc(meta)}</span><strong>${esc(title)}</strong><p>${esc(description)}</p></button>`).join('')}</div></section>
          <section><header><span>贰</span><div><small>PLAYER</small><h2>同行之人</h2></div></header>${personas.length ? `<label>从 Persona 模板取用<select data-field="personaId"><option value="">手动填写</option>${personas.map((persona) => `<option value="${esc(persona.id)}" ${state.personaId === persona.id ? 'selected' : ''}>${esc(persona.name)}</option>`).join('')}</select></label>` : ''}<div class="tx-form-row"><label>称谓<input data-field="name" value="${esc(state.name)}" maxlength="120" placeholder="你的名字"></label><label>存档名称<input data-field="title" value="${esc(state.title ?? '')}" maxlength="200" placeholder="自动使用开场名称"></label></div><label>身份与来历<textarea data-field="description" rows="3" placeholder="楚霁寒眼中的你，以及你为何踏上这条路。">${esc(state.description)}</textarea></label></section>
          <section><header><span>叁</span><div><small>RULES</small><h2>世界与关系</h2></div></header><div class="tx-form-row"><label>设定密度<select data-field="loreDetail"><option value="concise">精简九州设定</option><option value="full" ${state.loreDetail === 'full' ? 'selected' : ''}>完整九州设定</option></select></label><label>关系模式<select data-field="relationshipMode"><option value="adventure-focus">冒险调查优先</option><option value="original-multi-romance" ${state.relationshipMode === 'original-multi-romance' ? 'selected' : ''}>原卡多重真心</option></select></label><label>红线规则<select data-field="redThread"><option value="none">无红线</option><option value="fated" ${state.redThread === 'fated' ? 'selected' : ''}>姻缘红线</option><option value="intimacy" ${state.redThread === 'intimacy' ? 'selected' : ''}>亲密红线（成人）</option></select></label><label>内容模式<select data-field="contentMode"><option value="general">通用成年线</option><option value="mature" ${state.contentMode === 'mature' ? 'selected' : ''}>成人内容</option></select></label></div><p class="tx-content-note">本版固定为20岁成年时间线；成人条目仅在主动选择成人模式时启用。</p></section>
          <p class="tx-form-status ${state.error ? 'error' : ''}">${esc(state.error || state.status)}</p><button class="tx-create" type="submit">立下此卷 <span>→</span></button>
        </form>
      </div>
    </main>`;
    const form = root.querySelector('form');
    form.onsubmit = async (event) => {
      event.preventDefault(); state.error = '';
      if (!state.name.trim()) { state.error = '请先写下同行之人的称谓。'; render(); return; }
      if (state.redThread === 'intimacy' && state.contentMode !== 'mature') { state.error = '亲密红线需要同时选择成人内容模式。'; render(); return; }
      state.status = '正在立卷…'; render();
      try {
        const opening = openingCards.find(([id]) => id === state.opening);
        await sdk.setup.createConversation({
          title: state.title?.trim() || `${opening?.[1] ?? '太虚问道'} · ${state.name.trim()}`,
          ...(state.personaId ? { personaTemplateId: state.personaId } : {}),
          playerProfile: { name: state.name.trim(), description: state.description.trim() },
          setup: { opening: state.opening, loreDetail: state.loreDetail, relationshipMode: state.relationshipMode, redThread: state.redThread, contentMode: state.contentMode, theme: state.theme },
        });
      } catch (error) { state.status = ''; state.error = error.message || String(error); render(); }
    };
  };
  root.onclick = (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.type === 'submit') return;
    if (button.dataset.opening) {
      state.opening = button.dataset.opening;
      if (state.opening === 'market-red-thread') state.redThread = 'fated';
    }
    if (button.dataset.theme) state.theme = button.dataset.theme;
    render();
  };
  root.onchange = (event) => {
    const field = event.target.dataset.field; if (!field) return;
    state[field] = event.target.value;
    if (field === 'personaId') {
      const persona = personas.find((item) => item.id === state.personaId);
      if (persona) { state.name = persona.name; state.description = persona.description; }
    }
    if (field === 'contentMode' && state.contentMode !== 'mature' && state.redThread === 'intimacy') state.redThread = 'none';
    render();
  };
  root.oninput = (event) => { const field = event.target.dataset.field; if (field) state[field] = event.target.value; };
  render();
}

function meter(label, value, tone = '') {
  return `<div class="tx-meter ${tone}"><div><span>${esc(label)}</span><strong>${esc(value)}%</strong></div><i><b style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></b></i></div>`;
}

function characterPanel(state, portrait) {
  const character = record(state.楚霁寒); const realm = record(character.境界);
  return `<aside class="tx-character-panel"><div class="tx-portrait"><img src="${portrait}" alt="楚霁寒"><span>楚</span></div><div class="tx-character-title"><small>${esc(character.公开身份)}</small><h2>${esc(character.姓名)}</h2><p>${esc(record(character.灵根).对外)} · ${esc(character.年龄)}岁</p></div>${meter(`${realm.名称}·${realm.阶段}`, realm.进度)}<nav><button type="button" data-mode="story" class="${workspaceMode === 'story' ? 'active' : ''}"><span>卷</span>浮生录</button><button type="button" data-mode="fate" class="${workspaceMode === 'fate' ? 'active' : ''}"><span>命</span>混沌命盘</button><button type="button" data-mode="clues" class="${workspaceMode === 'clues' ? 'active' : ''}"><span>案</span>长生局</button><button type="button" data-mode="map" class="${workspaceMode === 'map' ? 'active' : ''}"><span>山</span>九州舆图</button></nav><div class="tx-secret"><small>藏锋</small><strong>${esc(record(character.灵根).真实)}</strong><p>暴露风险 ${esc(character.暴露风险)}%</p></div></aside>`;
}

function statusPanel(state) {
  const world = record(state.世界); const soul = record(state.太虚子); const relationships = record(state.关系); const clues = record(state.长生局).线索 ?? [];
  return `<aside class="tx-status-panel"><header><div><small>此身此世</small><strong>命格录</strong></div><span class="tx-seal small">命</span></header><div class="tx-world"><span>${esc(world.日期)} · ${esc(world.时辰)}</span><strong>${esc(world.地点)}</strong><small>${esc(world.天气)} · ${esc(world.章节)}</small></div>${meter('太虚子魂力', soul.魂力, 'soul')}<section><h3>当前牵绊 <span>${Object.keys(relationships).length}</span></h3>${entries(relationships).map(([id, relation]) => `<div class="tx-bond"><i>${esc(relation.姓名?.slice(0, 1) || '?')}</i><div><strong>${esc(relation.姓名 || id)}</strong><small>${esc(relation.关系)} · ${esc(relation.阶段)}</small></div><em>${esc(relation.好感)}/500</em></div>`).join('')}</section><section><h3>长生局 <span>${clues.length} 线索</span></h3><p class="tx-goal">${esc(record(state.长生局).目标)}</p>${clues.slice(-3).map((clue) => `<div class="tx-clue"><i></i>${esc(clue.标题)}</div>`).join('') || '<p class="tx-empty">雾锁太虚，尚待叩门。</p>'}</section><section><h3>当前任务 <span>${Object.keys(record(state.任务)).length}</span></h3>${entries(state.任务).map(([, quest]) => `<div class="tx-quest"><span>${esc(quest.状态)}</span><strong>${esc(quest.标题)}</strong><p>${esc(quest.描述)}</p></div>`).join('')}</section></aside>`;
}

function fateMarkup(state) {
  const character = record(state.楚霁寒); const root = record(character.灵根); const soul = record(state.太虚子); const realm = record(character.境界);
  const nodes = [...(root.已解锁 ?? []).map((name) => [name, '已通']), ...(root.未解锁 ?? []).map((name) => [name, '未启'])];
  return `<section class="tx-module tx-fate"><header><span>INNER REALM</span><h1>混沌命盘</h1><p>公开身份只是一层水色。真正的根骨与师徒代价，皆藏在无人得见的内景中。</p></header><div class="tx-fate-board"><div class="tx-orbit one"></div><div class="tx-orbit two"></div><div class="tx-fate-core"><small>当前境界</small><strong>${esc(realm.名称)}</strong><span>${esc(realm.阶段)} · ${esc(realm.进度)}%</span></div>${nodes.map(([name, status], index) => `<div class="tx-fate-node n${index + 1} ${status === '未启' ? 'locked' : ''}"><span>${esc(name)}</span><small>${esc(status)}</small></div>`).join('')}</div><div class="tx-module-cards"><article><small>师承</small><strong>太虚子</strong><p>${esc(soul.状态)} · 魂力 ${esc(soul.魂力)}%</p></article><article><small>丹道</small><strong>${esc(record(character.丹道).品阶)}</strong><p>${esc(record(character.丹道).下一目标)}</p></article><article><small>绝密</small><strong>${esc(root.真实)}</strong><p>对外仅显露：${esc(root.对外)}</p></article></div></section>`;
}

function cluesMarkup(state) {
  const investigation = record(state.长生局); const clues = investigation.线索 ?? [];
  return `<section class="tx-module tx-investigation"><header><span>THE LONG-LIFE SCHEME</span><h1>长生局</h1><p>${esc(investigation.阶段)} · ${esc(investigation.目标)}</p></header><div class="tx-investigation-grid"><section><h2>所得线索</h2>${clues.map((clue, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(clue.标题)}</strong><p>${esc(clue.详情)}</p></div></article>`).join('') || '<div class="tx-large-empty">一张空白的案牍。<br><small>每一条结论都必须由行动换来。</small></div>'}</section><section><h2>七名弟子</h2>${(investigation.嫌疑人 ?? []).map((suspect) => `<article><span>${esc(suspect.姓名.slice(0, 1))}</span><div><strong>${esc(suspect.姓名)}</strong><p>${esc(suspect.状态)}</p></div></article>`).join('')}</section></div></section>`;
}

function mapMarkup(state) {
  const regions = record(state.地图).区域 ?? []; const location = record(state.世界).地点;
  return `<section class="tx-module tx-map-module"><header><span>NINE PROVINCES</span><h1>九州舆图</h1><p>当前行迹 · ${esc(location)}</p></header><div class="tx-region-grid">${regions.map((region, index) => `<article class="${region.已解锁 ? '' : 'locked'}"><span>${String(index + 1).padStart(2, '0')}</span><h2>${esc(region.名称)}</h2><p>${esc(region.描述)}</p><small>${region.已解锁 ? '已录入行迹' : '云深不知处'}</small></article>`).join('')}</div></section>`;
}

function chapterEventMarkup(state) {
  const chapter = record(state.第一章);
  const eventId = chapter.当前事件 || 'completed';
  const event = chapterEvents[eventId] ?? chapterEvents.completed;
  return `<section class="tx-chapter-event" data-chapter-event="${esc(eventId)}"><div><small>${esc(event.eyebrow)}</small><strong>${esc(event.title)}</strong><p>${esc(event.description)}</p></div><span>${(chapter.已完成事件 ?? []).length}/5</span>${event.action === '' ? '<b>临时身份已取得</b>' : `<button type="button" data-run-chapter-event="${esc(eventId)}">${esc(event.action)} <i>→</i></button>`}</section>`;
}

function storyMarkup(detail, state) {
  return `<section class="tx-story"><header><div><small>当前篇章</small><strong>${esc(detail.conversation.title)}</strong></div><span id="tx-generation">灵台清明</span></header><div class="tx-messages">${detail.messages.map((message) => message.playerOperation
    ? playerOperationMarkup(message.playerOperation)
    : `<article class="tx-message ${message.role === 'user' ? 'user' : 'assistant'}" data-message-id="${esc(message.id)}"><header>${message.role === 'user' ? esc(detail.conversation.playerProfile?.name || '你') : '楚霁寒'}</header><div>${messageBody(message)}</div></article>`).join('')}</div>${chapterEventMarkup(state)}${actionOptionsMarkup(detail.messages)}<form class="tx-composer"><button type="button" data-stop title="停止生成">止</button><textarea id="tx-draft" rows="1" placeholder="你打算如何应对……"></textarea><button type="submit">遣</button></form></section>`;
}

async function renderWorkspace(root, sdk) {
  const [detail, stateRow] = await Promise.all([sdk.messages.list(), sdk.state.get()]);
  const state = stateRow.value; const theme = record(state.界面).主题 || 'xuanqing';
  const background = sdk.scene.assetUrl('content/background.png'); const portrait = sdk.scene.assetUrl('content/character.png');
  const center = workspaceMode === 'fate' ? fateMarkup(state) : workspaceMode === 'clues' ? cluesMarkup(state) : workspaceMode === 'map' ? mapMarkup(state) : storyMarkup(detail, state);
  root.innerHTML = `<main class="tx-workspace theme-${esc(theme)}" style="--tx-bg:url('${background}')"><div class="tx-backdrop"></div><header class="tx-header"><a href="/"><span class="tx-seal">太</span><div><strong>太虚问道</strong><small>TAIXU CHRONICLES</small></div></a><div class="tx-chapter"><span>${esc(record(state.世界).章节)}</span><i></i><strong>${esc(record(state.世界).地点)}</strong></div>${themePicker(theme)}</header><div class="tx-layout">${characterPanel(state, portrait)}${center}${statusPanel(state)}</div></main>`;
  mountMessageViews(root, detail.messages);
  root.querySelectorAll('[data-mode]').forEach((button) => { button.onclick = () => { workspaceMode = button.dataset.mode; void renderWorkspace(root, sdk); }; });
  root.querySelectorAll('[data-theme]').forEach((button) => { button.onclick = async () => { await sdk.scene.action({ type: 'set-theme', theme: button.dataset.theme }); await renderWorkspace(root, sdk); }; });
  root.querySelectorAll('[data-choice]').forEach((button) => { button.onclick = () => { const draft = root.querySelector('#tx-draft'); if (draft) { draft.value = button.dataset.choice; draft.focus(); } }; });
  root.querySelector('[data-run-chapter-event]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const eventId = button.dataset.runChapterEvent;
    const definition = chapterEvents[eventId];
    button.disabled = true;
    try {
      await sdk.scene.action({ type: 'chapter-event', eventId }, { operation: {
        kind: 'chapter-event', title: definition?.title || '章节行动',
        summary: `玩家确认${definition?.action || '推进章节事件'}。`,
      } });
    }
    finally { await renderWorkspace(root, sdk); }
  });
  const composer = root.querySelector('.tx-composer');
  if (composer) composer.onsubmit = async (event) => { event.preventDefault(); const draft = root.querySelector('#tx-draft'); const text = draft.value.trim(); if (!text) return; draft.value = ''; await sdk.messages.send(text); await renderWorkspace(root, sdk); };
  root.querySelector('[data-stop]')?.addEventListener('click', () => sdk.messages.stop());
  root.querySelector('.tx-messages')?.scrollTo({ top: root.querySelector('.tx-messages').scrollHeight });
}

export async function mount({ root, mode, sdk }) {
  generationCleanup?.();
  if (mode === 'setup') await renderSetup(root, sdk);
  else await renderWorkspace(root, sdk);
  generationCleanup = sdk.generation.subscribe((event) => {
    if (event.type !== 'snapshot') return;
    const status = root.querySelector('#tx-generation');
    const busy = event.value.status !== 'idle';
    if (status) status.textContent = busy ? '推演天机中…' : '灵台清明';
    if (!busy && generationWasBusy && mode === 'workspace') void renderWorkspace(root, sdk);
    generationWasBusy = busy;
  });
  return () => { generationCleanup?.(); generationCleanup = undefined; root.replaceChildren(); };
}
