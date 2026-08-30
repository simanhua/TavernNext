import {
  bindActionInfoPanels,
  escapeActionInfoHtml,
  renderCombatActionInfoMessage,
} from './action-info.mjs?v=2.15.0';

const TAG_PATTERN = /<\s*(\/?)\s*(tp|gametxt|options|action_options|summary)\b[^>]*>/gi;
const OPTION_PATTERN = /^\s*\d+\s*[.、：:)]\s*(.*)$/;
const TAG_UNDERSCORE_SENTINEL = '\uE101';

function tokensFor(source) {
  const tokens = [];
  for (const match of source.matchAll(TAG_PATTERN)) {
    tokens.push({
      name: match[2].toLowerCase(),
      closing: match[1] === '/',
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
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
  return { pairs, unclosed: stack };
}

function optionValues(raw) {
  const values = [];
  let current = '';
  for (const rawLine of String(raw).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const match = OPTION_PATTERN.exec(line);
    if (match !== null) {
      if (current !== '') values.push(current);
      current = match[1].trim();
    } else if (current !== '' && line !== '') {
      current += ` ${line}`;
    }
  }
  if (current !== '') values.push(current);
  if (values.length > 0) return values;
  return String(raw).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
}

function optionsMarkup(raw, streaming) {
  const values = optionValues(raw);
  if (values.length === 0) return '';
  return `<section class="poem-message-options" aria-label="行动选项"><header><strong>行动选项</strong><small>选择后可在输入框中修改</small></header><div class="poem-option-list">${values.map((value, index) => (
    `<button type="button" class="poem-option" data-poem-option-text="${escapeActionInfoHtml(value)}"${streaming ? ' disabled' : ''}><span>${index + 1}</span><b>${escapeActionInfoHtml(value)}</b></button>`
  )).join('')}</div></section>`;
}

function summaryMarkup(raw, idPrefix, streaming) {
  const body = renderDestinedPoemMessage(raw, { idPrefix: `${idPrefix}-summary`, streaming });
  return `<details class="poem-message-summary"><summary>摘要</summary><div>${body}</div></details>`;
}

function narrativeMarkup(raw, idPrefix, streaming) {
  const protectedTags = String(raw).replace(/<[^>\n]*>/g, (tag) => (
    /^<\s*\/?\s*action_info\b/i.test(tag)
      ? tag
      : tag.replaceAll('_', TAG_UNDERSCORE_SENTINEL)
  ));
  return renderCombatActionInfoMessage(protectedTags, idPrefix, { suppressIncomplete: streaming })
    .replaceAll(TAG_UNDERSCORE_SENTINEL, '_');
}

export function renderDestinedPoemMessage(content, options = {}) {
  const source = String(content ?? '');
  const idPrefix = String(options.idPrefix ?? 'poem-message');
  const streaming = options.streaming === true;
  const { pairs, unclosed } = pairedBlocks(source);
  let visibleSource = source;
  let partialGameText;
  if (streaming && unclosed.length > 0) {
    const first = unclosed[0];
    if (first.name === 'gametxt') {
      visibleSource = source.slice(0, first.start);
      partialGameText = source.slice(first.end);
    } else {
      visibleSource = source.slice(0, first.start);
    }
  }

  const visiblePairs = pairs.filter((pair) => pair.end <= visibleSource.length);
  const chunks = [];
  let cursor = 0;
  for (const [index, pair] of visiblePairs.entries()) {
    chunks.push(narrativeMarkup(visibleSource.slice(cursor, pair.start), `${idPrefix}-narrative-${index}`, streaming));
    const inner = visibleSource.slice(pair.openEnd, pair.closeStart);
    if (pair.name === 'gametxt') {
      chunks.push(renderDestinedPoemMessage(inner, { idPrefix: `${idPrefix}-gametxt-${index}`, streaming }));
    } else if (pair.name === 'options' || pair.name === 'action_options') {
      chunks.push(optionsMarkup(inner, streaming));
    } else if (pair.name === 'summary') {
      chunks.push(summaryMarkup(inner, `${idPrefix}-${index}`, streaming));
    }
    cursor = pair.end;
  }
  chunks.push(narrativeMarkup(visibleSource.slice(cursor), `${idPrefix}-narrative-tail`, streaming));
  if (partialGameText !== undefined) {
    chunks.push(renderDestinedPoemMessage(partialGameText, { idPrefix: `${idPrefix}-gametxt-stream`, streaming: true }));
  }
  return chunks.join('');
}

export function bindDestinedPoemMessageBlocks(container, onOption) {
  bindActionInfoPanels(container);
  container.querySelectorAll('[data-poem-option-text]').forEach((button) => {
    button.onclick = () => {
      if (button.disabled || typeof onOption !== 'function') return;
      onOption(button.dataset.poemOptionText ?? '');
    };
  });
}

export function parseDestinedPoemOptions(content) {
  return optionValues(content);
}
