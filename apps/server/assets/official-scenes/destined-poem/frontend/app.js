let root;
import { bindActionInfoPanels, renderCombatActionInfoMessage } from './action-info.mjs?v=2.6.0';
import {
  attributeAllocationPatch,
  createDestinedPoemStatusRailModel,
} from './status-rail.mjs?v=2.6.0';

let sdk;
let context;
let activeTab = 'chat';
let activeStatusRailTab = 'status';
let statusRailOpen = false;
let statusRailController;
let generationView = { status: 'idle', streamedText: '', streamedReasoning: '', error: null };

const request = (method, args = []) => {
  const [scope, name] = method.split('.');
  const target = sdk?.[scope]?.[name];
  return typeof target === 'function'
    ? Promise.resolve(target(...args))
    : Promise.reject(new Error('scene_sdk_method_unknown'));
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const valueAt = (source, path, fallback = '') => {
  let value = source;
  for (const part of path.split('.')) value = value?.[part];
  return value ?? fallback;
};

function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.classList.toggle('dark', theme.scheme === 'dark');
  document.documentElement.style.colorScheme = theme.scheme || 'dark';
  for (const [name, value] of Object.entries(theme.tokens || {})) {
    if (name.startsWith('--vp-')) document.documentElement.style.setProperty(name, String(value));
  }
}

function updateGeneration(value) {
  generationView = { ...generationView, ...(value || {}) };
  const running = ['starting', 'streaming', 'stopping'].includes(generationView.status);
  const status = document.querySelector('#generation-status');
  const send = document.querySelector('#send');
  const draft = document.querySelector('#draft');
  if (send) send.disabled = running;
  if (draft) draft.disabled = running;
  if (status) {
    status.className = `generation-status${generationView.error ? ' error' : ''}`;
    status.innerHTML = generationView.error
      ? esc(generationView.error)
      : running ? '<span>正在生成回复…</span><div class="progress"></div>' : '';
  }
  const messages = document.querySelector('.messages');
  if (!messages) return;
  let streaming = document.querySelector('#streaming-message');
  if (running && (generationView.streamedText || generationView.streamedReasoning)) {
    if (!streaming) {
      streaming = document.createElement('article');
      streaming.id = 'streaming-message';
      streaming.className = 'message assistant streaming';
      messages.append(streaming);
    }
    streaming.innerHTML = renderCombatActionInfoMessage(
      generationView.streamedText || generationView.streamedReasoning,
      'streaming-action',
      { suppressIncomplete: true },
    );
    bindActionInfoPanels(streaming);
  } else streaming?.remove();
}

function renderSetup() {
  root.innerHTML = `<main class="panel setup">
    <h1>命定之诗与黄昏之歌</h1>
    <p class="muted">在阿斯塔利亚开启一段独立命运。每次开局都会创建完全隔离的存档。</p>
    <label>导入 Persona<select id="persona"><option value="">不导入</option></select></label>
    <label>主角姓名<input id="name" maxlength="80" required></label>
    <label>主角描述<textarea id="description" rows="5"></textarea></label>
    <label>开局地点<select id="origin"><option>梵尼亚</option><option>奥古斯提姆帝国</option><option>卡拉什利亚斯</option><option>诺斯加德联盟</option><option>索伦蒂斯王国</option><option>萨赫拉联邦</option></select></label>
    <label>存档名称<input id="title" value="新的命运"></label>
    <button class="action primary" id="start">创建存档</button><p id="status"></p>
  </main>`;
  request('setup.listPersonas').then((items) => {
    const select = document.querySelector('#persona');
    for (const persona of items) {
      const option = document.createElement('option');
      option.value = persona.id;
      option.textContent = persona.name;
      select.append(option);
    }
    select.onchange = () => {
      const persona = items.find((item) => item.id === select.value);
      if (!persona) return;
      document.querySelector('#name').value = persona.name;
      document.querySelector('#description').value = persona.description;
    };
  });
  document.querySelector('#start').onclick = async () => {
    const status = document.querySelector('#status');
    status.textContent = '正在创建…';
    try {
      await request('setup.createConversation', [{
        title: document.querySelector('#title').value,
        personaTemplateId: document.querySelector('#persona').value || undefined,
        playerProfile: {
          name: document.querySelector('#name').value || '旅人',
          description: document.querySelector('#description').value,
        },
        setup: { origin: document.querySelector('#origin').value },
      }]);
    } catch (error) {
      status.className = 'error';
      status.textContent = error.message || String(error);
    }
  };
}

function activeDiagnostics(message) {
  const variant = message.variants?.find((item) => item.id === message.activeVariantId);
  return variant?.diagnostics || [];
}

function messageMarkup(message) {
  return message.role === 'assistant'
    ? renderCombatActionInfoMessage(message.content, `action-${message.id}`)
    : `<div class="action-message-narrative">${esc(message.content)}</div>`;
}

function diagnosticMarkup(diagnostics, messageId) {
  if (!diagnostics.length) return '';
  const failures = diagnostics.flatMap((diagnostic) => diagnostic.failures || []);
  const appliedCount = diagnostics.reduce((total, diagnostic) => total + Number(diagnostic.appliedCount || 0), 0);
  const rows = failures.length
    ? failures.map((failure) => {
      const operation = [failure.op, failure.path || failure.to].filter(Boolean).join(' ');
      return `<li><strong>#${Number(failure.operationIndex) + 1} ${esc(operation || '未知操作')}</strong><span>${esc(failure.code)}</span></li>`;
    })
    : diagnostics.map((diagnostic) => `<li><strong>${esc(diagnostic.code)}</strong><span>变量块无法解析，未产生可独立应用的操作。</span></li>`);
  const title = appliedCount > 0 ? '状态已部分更新' : '正文已保留，状态未更新';
  const summary = failures.length
    ? `成功应用 ${appliedCount} 项，失败 ${failures.length} 项。`
    : '变量更新格式无效，可查看失败原因后重生成。';
  return `<aside class="state-warning"><strong>${title}</strong><span>${summary}</span><button type="button" class="state-failure-toggle" data-diagnostic="${messageId}" aria-expanded="false">查看失败列表 (${rows.length})</button><ul class="state-failure-list" data-diagnostic-list="${messageId}" hidden>${rows.join('')}</ul></aside>`;
}

function bindStatusRail(state) {
  statusRailController?.destroy();
  const shell = document.querySelector('.shell');
  const toggle = document.querySelector('#status-rail-toggle');
  if (!shell || !toggle) return;
  statusRailController = sdk.ui.statusRail.mount({
    container: shell,
    trigger: toggle,
    model: createDestinedPoemStatusRailModel(state, context.playerProfile.name),
    activeTab: activeStatusRailTab,
    open: statusRailOpen,
    onTabChange(tabId) { activeStatusRailTab = tabId; },
    onOpenChange(open) { statusRailOpen = open; },
    async onAction(actionId) {
      if (!actionId.startsWith('attribute:')) return;
      try {
        const result = await request('state.patch', [attributeAllocationPatch(actionId.slice('attribute:'.length))]);
        if (result.failures?.length) window.alert(`有 ${result.failures.length} 项状态操作失败。`);
        await renderWorkspace();
      } catch (error) {
        window.alert(error.message || String(error));
      }
    },
  });
}

async function renderWorkspace() {
  const [detail, stateRow] = await Promise.all([request('messages.list'), request('state.get')]);
  const state = stateRow.value || {};
  const tabs = [['chat', '对话'], ['quests', '任务'], ['relationships', '关系'], ['map', '地图']];
  statusRailController?.destroy();
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="scene-brand"><strong>命定之诗</strong><small>Destined Journey</small></div><nav class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${activeTab === id ? 'active' : ''}">${label}</button>`).join('')}</nav><div class="sidebar-foot">TavernNext Scene · v2.6.0</div></aside><main class="main"><header class="top"><div><strong>${esc(context.playerProfile.name)}</strong><span class="muted">${esc(detail.conversation.title)}</span></div><button type="button" id="status-rail-toggle">状态</button></header><section class="content" id="content"></section></main></div>`;
  document.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => { activeTab = button.dataset.tab; renderWorkspace(); }; });
  bindStatusRail(state);
  const area = document.querySelector('#content');
  if (activeTab === 'chat') {
    area.innerHTML = `<div class="panel chat"><div class="messages">${detail.messages.map((message) => {
      const diagnostics = activeDiagnostics(message);
      return `<article class="message ${message.role}"><div class="message-body">${messageMarkup(message)}</div>${diagnosticMarkup(diagnostics, message.id)}<menu><button data-op="edit" data-id="${message.id}">编辑</button><button data-op="delete" data-id="${message.id}">删除</button>${message.role === 'assistant' ? `<button data-op="continue" data-id="${message.id}">续写</button><button data-op="regenerate" data-id="${message.id}">重生成</button><button data-op="swipe" data-id="${message.id}">换一个回复</button>` : ''}</menu></article>`;
    }).join('')}</div><div class="composer-wrap"><div class="composer"><textarea id="draft" placeholder="你准备做什么？"></textarea><button class="action primary" id="send">发送</button><button class="action" id="stop">停止</button></div><div id="generation-status" class="generation-status"></div></div></div>`;
    bindActionInfoPanels(area);
    document.querySelectorAll('[data-diagnostic]').forEach((button) => { button.onclick = () => {
      const list = document.querySelector(`[data-diagnostic-list="${button.dataset.diagnostic}"]`);
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
      button.textContent = `${expanded ? '查看' : '收起'}失败列表 (${list.children.length})`;
    }; });
    document.querySelector('#send').onclick = async () => {
      const draft = document.querySelector('#draft');
      const text = draft.value.trim();
      if (!text) return;
      updateGeneration({ status: 'starting', error: null, streamedText: '', streamedReasoning: '' });
      try { await request('messages.send', [text]); draft.value = ''; await renderWorkspace(); }
      catch (error) { updateGeneration({ status: 'idle', error: error.message || String(error) }); }
    };
    document.querySelector('#stop').onclick = () => request('messages.stop').catch((error) => updateGeneration({ error: error.message || String(error) }));
    document.querySelectorAll('[data-op]').forEach((button) => { button.onclick = async () => {
      const { op, id } = button.dataset;
      try {
        if (op === 'edit') {
          const message = detail.messages.find((item) => item.id === id);
          const next = prompt('编辑消息', message?.content || '');
          if (next === null) return;
          await request('messages.edit', [id, next]);
        } else if (op === 'delete') await request('messages.delete', [id]);
        else await request(`messages.${op}`, [id]);
        await renderWorkspace();
      } catch (error) { updateGeneration({ status: 'idle', error: error.message || String(error) }); }
    }; });
    updateGeneration(generationView);
    return;
  }
  const mapping = { quests: ['任务', '任务列表'], relationships: ['关系', '关系列表'], map: ['地图', '地图.标记'] };
  const [title, path] = mapping[activeTab];
  const data = valueAt(state, path, {});
  const entries = Array.isArray(data) ? data.map((value, index) => [index, value]) : Object.entries(data || {});
  area.innerHTML = `<div class="panel"><h2>${title}</h2>${entries.length ? `<div class="grid">${entries.map(([key, value]) => `<div class="card"><strong>${esc(value?.name ?? key)}</strong><p>${esc(typeof value === 'object' ? value.description ?? JSON.stringify(value) : value)}</p></div>`).join('')}</div>` : '<div class="empty">暂无内容</div>'}</div>`;
}

export async function mount(input) {
  root = input.root;
  sdk = input.sdk;
  context = await sdk.context.get();
  generationView = { ...generationView, ...sdk.generation.getSnapshot() };
  applyTheme(sdk.theme.getSnapshot());
  const unsubscribeTheme = sdk.theme.subscribe(applyTheme);
  const unsubscribeGeneration = sdk.generation.subscribe((event) => {
    if (event.type === 'snapshot') updateGeneration(event.value);
    else if (event.type === 'text-delta') updateGeneration({ ...generationView, streamedText: generationView.streamedText + event.text });
    else if (event.type === 'reasoning-delta') updateGeneration({ ...generationView, streamedReasoning: generationView.streamedReasoning + event.text });
  });
  if (input.mode === 'setup') renderSetup(); else await renderWorkspace();
  return () => {
    statusRailController?.destroy();
    statusRailController = undefined;
    unsubscribeTheme();
    unsubscribeGeneration();
    root.replaceChildren();
  };
}
