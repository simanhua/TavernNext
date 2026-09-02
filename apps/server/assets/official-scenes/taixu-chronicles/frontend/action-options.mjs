const TAG_PATTERN = /<\s*(\/?)\s*(suot|options|action_options)\b[^>]*>/gi;
const OPTION_PATTERN = /^\s*(?:[-*]\s*)?(\d{1,2})\s*[.、．：:)]\s*(.+?)\s*$/;
const MAX_OPTIONS = 7;
const MAX_OPTION_LENGTH = 300;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function tokensFor(source) {
  return [...String(source ?? '').matchAll(new RegExp(TAG_PATTERN.source, 'gi'))].map((match) => ({
    name: match[2].toLowerCase(),
    closing: match[1] === '/',
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function pairedBlocks(source) {
  const stack = [];
  const pairs = [];
  for (const token of tokensFor(source)) {
    if (!token.closing) {
      stack.push({ ...token, depth: stack.length });
      continue;
    }
    const opening = stack.at(-1);
    if (opening?.name !== token.name) continue;
    stack.pop();
    if (opening.depth === 0) {
      pairs.push({
        name: opening.name,
        start: opening.start,
        openEnd: opening.end,
        closeStart: token.start,
        end: token.end,
      });
    }
  }
  return pairs;
}

function normalizedOption(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function optionValues(raw) {
  const values = [];
  let current = '';
  const flush = () => {
    const value = normalizedOption(current);
    if (value !== '' && value.length <= MAX_OPTION_LENGTH && !values.includes(value)) values.push(value);
    current = '';
  };
  for (const rawLine of String(raw ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const match = OPTION_PATTERN.exec(line);
    if (match !== null) {
      flush();
      current = match[2];
    } else if (current !== '' && line !== '') {
      current += ` ${line}`;
    }
  }
  flush();
  return values.length >= 2 ? values.slice(0, MAX_OPTIONS) : [];
}

function messageSource(message) {
  const variants = Array.isArray(message?.variants) ? message.variants : [];
  const variant = variants.find((candidate) => candidate.id === message?.activeVariantId) ?? variants[0];
  const blocks = variant?.document?.blocks;
  if (Array.isArray(blocks)) {
    return blocks.flatMap((block) => block?.type === 'markdown' ? [String(block.content ?? '')] : []).join('\n');
  }
  return String(variant?.content ?? message?.content ?? '');
}

function typedActionOptions(message) {
  const variants = Array.isArray(message?.variants) ? message.variants : [];
  const variant = variants.find((candidate) => candidate.id === message?.activeVariantId) ?? variants[0];
  const blocks = variant?.document?.blocks;
  if (!Array.isArray(blocks)) return [];
  const block = [...blocks].reverse().find((candidate) => candidate?.type === 'action-options');
  if (!Array.isArray(block?.options) || block.options.length !== MAX_OPTIONS) return [];
  const values = block.options.map((option) => normalizedOption(option?.text));
  return values.every((value) => value !== '' && value.length <= MAX_OPTION_LENGTH) ? values : [];
}

export function parseTaixuActionOptions(content) {
  const source = String(content ?? '');
  const pair = pairedBlocks(source).at(-1);
  return pair === undefined ? [] : optionValues(source.slice(pair.openEnd, pair.closeStart));
}

export function stripTaixuActionOptions(content) {
  const source = String(content ?? '');
  const pairs = pairedBlocks(source);
  if (pairs.length === 0) return source;
  let visible = '';
  let cursor = 0;
  for (const pair of pairs) {
    visible += source.slice(cursor, pair.start);
    cursor = pair.end;
  }
  return `${visible}${source.slice(cursor)}`.replace(/\n{3,}/g, '\n\n').trim();
}

export function taixuActionOptionsForMessages(messages) {
  const latestAssistant = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === 'assistant');
  if (latestAssistant === undefined) return [];
  const typed = typedActionOptions(latestAssistant);
  return typed.length > 0 ? typed : parseTaixuActionOptions(messageSource(latestAssistant));
}

export function renderTaixuActionOptions(options, source = 'generated', retry = false) {
  const values = Array.isArray(options) ? options.slice(0, MAX_OPTIONS) : [];
  const safeSource = source === 'generated' ? 'generated' : 'fallback';
  return `<div class="tx-choice-area"><div class="tx-choices" data-choice-source="${safeSource}" aria-label="行动选项">${values.map((option, index) => (
    `<button type="button" data-choice="${escapeHtml(option)}"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(option)}</button>`
  )).join('')}</div>${retry ? '<button type="button" class="tx-options-retry" data-regenerate-action-options>重新生成剧情选项</button>' : ''}</div>`;
}

export function bindTaixuActionOptions(root, handlers = {}) {
  root.querySelectorAll('[data-choice]').forEach((button) => { button.onclick = () => {
    if (typeof handlers.onSelect === 'function') handlers.onSelect(button.dataset.choice || '');
  }; });
  const retry = root.querySelector('[data-regenerate-action-options]');
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    retry.textContent = '正在重新生成…';
    try { await handlers.onRetry?.(); }
    finally { retry.disabled = false; }
  };
}
