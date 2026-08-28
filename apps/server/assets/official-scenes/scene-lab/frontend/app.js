let cleanupGeneration;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export function renderSceneView({ root, block }) {
  if (block.kind !== 'status' || block.rendererId !== 'scene-lab-status-v1') {
    throw new Error('scene_view_renderer_unsupported');
  }
  const props = block.props ?? {};
  root.innerHTML = `<section class="scene-lab-view" role="region" aria-label="实验状态">
    <header><strong>${escapeHtml(props.experimentName || '未命名实验')}</strong><span>${escapeHtml(props.phase || 'ready')}</span></header>
    <div class="scene-lab-signal">Signal ${escapeHtml(props.signal ?? 0)}</div>
  </section>`;
  return () => root.replaceChildren();
}

function activeDocument(message) {
  return message.variants?.find((variant) => variant.id === message.activeVariantId)?.document;
}

function messageMarkup(message) {
  const document = activeDocument(message);
  if (!Array.isArray(document?.blocks)) return escapeHtml(message.content);
  return document.blocks.map((block, index) => block.type === 'scene-view'
    ? `<div data-scene-lab-view="${index}"></div>`
    : escapeHtml(block.content || '')).join('');
}

async function renderWorkspace(root, sdk) {
  const [detail, stateRow] = await Promise.all([sdk.messages.list(), sdk.state.get()]);
  root.innerHTML = `<main class="scene-lab-page"><section class="scene-lab-panel">
    <header><h1>${escapeHtml(stateRow.value.experimentName)}</h1><p>Phase ${escapeHtml(stateRow.value.phase)} · Signal ${escapeHtml(stateRow.value.signal)}</p></header>
    <div id="scene-lab-messages">${detail.messages.map((message) => `<article class="scene-lab-message" data-message-id="${escapeHtml(message.id)}">${messageMarkup(message)}</article>`).join('')}</div>
    <label>输入观察<textarea id="scene-lab-draft" placeholder="记录一次观察"></textarea></label>
    <button id="scene-lab-send" type="button">发送</button>
    <button id="scene-lab-stop" type="button">停止</button>
    <p id="scene-lab-status" class="scene-lab-status"></p>
  </section></main>`;
  for (const message of detail.messages) {
    const document = activeDocument(message);
    if (!Array.isArray(document?.blocks)) continue;
    const article = root.querySelector(`[data-message-id="${message.id}"]`);
    for (const [index, block] of document.blocks.entries()) {
      if (block.type !== 'scene-view') continue;
      const target = article?.querySelector(`[data-scene-lab-view="${index}"]`);
      if (target) renderSceneView({ root: target, block });
    }
  }
  const status = root.querySelector('#scene-lab-status');
  root.querySelector('#scene-lab-send').onclick = async () => {
    const draft = root.querySelector('#scene-lab-draft');
    if (!draft.value.trim()) return;
    status.textContent = '正在生成回复…';
    try { await sdk.messages.send(draft.value); await renderWorkspace(root, sdk); }
    catch (error) { status.textContent = error.message || String(error); }
  };
  root.querySelector('#scene-lab-stop').onclick = () => sdk.messages.stop();
}

export async function mount({ root, mode, sdk }) {
  cleanupGeneration?.();
  if (mode === 'setup') {
    root.innerHTML = `<main class="scene-lab-page"><section class="scene-lab-panel">
      <h1>场景实验室</h1><p>创建一个隔离的状态实验。</p>
      <label>实验名称<input id="scene-lab-name" value="信号观测"></label>
      <label>观察者名称<input id="scene-lab-player" value="观察者"></label>
      <button id="scene-lab-create" type="button">创建存档</button><p id="scene-lab-status" class="scene-lab-status"></p>
    </section></main>`;
    root.querySelector('#scene-lab-create').onclick = async () => {
      const experimentName = root.querySelector('#scene-lab-name').value.trim() || '未命名实验';
      const name = root.querySelector('#scene-lab-player').value.trim() || '观察者';
      const status = root.querySelector('#scene-lab-status');
      status.textContent = '正在创建…';
      try { await sdk.setup.createConversation({ title: experimentName, playerProfile: { name, description: '' }, setup: { experimentName } }); }
      catch (error) { status.textContent = error.message || String(error); }
    };
  } else await renderWorkspace(root, sdk);
  cleanupGeneration = sdk.generation.subscribe((event) => {
    const status = root.querySelector('#scene-lab-status');
    if (status && event.type === 'snapshot') status.textContent = event.value.status === 'idle' ? '' : '正在生成回复…';
  });
  return () => { cleanupGeneration?.(); cleanupGeneration = undefined; root.replaceChildren(); };
}
