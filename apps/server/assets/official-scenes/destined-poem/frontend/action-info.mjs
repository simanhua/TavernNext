const panelConfig = {
  战况总览: ['📜', '#ffd166'], 戰況總覽: ['📜', '#ffd166'],
  行动顺序: ['⏳', '#63b3ed'], 行動順序: ['⏳', '#63b3ed'],
  攻击行动: ['◎', '#fc8181'], 攻擊行動: ['◎', '#fc8181'],
  伤害基准计算: ['∑', '#ed8936'], 傷害基準計算: ['∑', '#ed8936'],
  结算清单: ['✓', '#68d391'], 結算清單: ['✓', '#68d391'],
  战术动作: ['♞', '#b794f4'], 戰術動作: ['♞', '#b794f4'],
  战意判定: ['♡', '#f56565'], 戰意判定: ['♡', '#f56565'],
  战斗结算: ['⚑', '#48bb78'], 戰鬥結算: ['⚑', '#48bb78'],
  经验结算: ['↗', '#f6e05e'], 經驗結算: ['↗', '#f6e05e'],
  生产准备: ['⚒', '#ed8936'], 生產準備: ['⚒', '#ed8936'],
  制作检定: ['⚗', '#63b3ed'], 製作檢定: ['⚗', '#63b3ed'],
  生产结算: ['◇', '#48bb78'], 生產結算: ['◇', '#48bb78'],
};

export const combatActionTitles = new Set([
  '战况总览', '戰況總覽', '行动顺序', '行動順序', '攻击行动', '攻擊行動',
  '伤害基准计算', '傷害基準計算', '结算清单', '結算清單', '战术动作', '戰術動作',
  '战意判定', '戰意判定', '战斗结算', '戰鬥結算', '经验结算', '經驗結算',
]);

export function isCombatActionSection(section) {
  return combatActionTitles.has(typeof section === 'string' ? section : section?.title);
}

const fieldLabels = [
  '回合', '回合数', '回合數', '类型', '類型', '环境', '環境', '序列', '状态', '狀態',
  '目标', '目標', '角色', '攻方', '守方', '对象', '對象', '对抗', '對抗', '招式',
  '所使武器', '消耗', '执行', '執行', '认证', '認證', '核心属性', '核心屬性',
  '品质', '品質', '检定结果', '檢定結果', '结果', '結果', '战果', '戰果',
  '效果', '状态效果', '狀態效果', '资源预检', '資源預檢', '资源消耗', '資源消耗',
  '结算状态', '結算狀態', '经验明细', '經驗明細', '经验依据', '經驗依據',
  'EXP合计', '上限后实得EXP', '上限後實得EXP', '奖励', '獎勵', '投入物', '投入',
  '损失', '損失', '产出列表', '產出列表', '预估时间', '預估時間', '时间消耗',
  '時間消耗', '批量检查', '批量檢查', '行业', '行業',
];

export function escapeActionInfoHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSections(raw) {
  const sections = [];
  let current;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const title = /^\{(.+?)\}$/.exec(line);
    if (title !== null) {
      current = { title: title[1].trim(), rows: [], notes: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('|') && line.endsWith('|')) current.rows.push(line.slice(1, -1).trim());
    else current.notes.push(line);
  }
  return sections.filter((section) => section.rows.length > 0 || section.notes.length > 0);
}

function decorateRow(raw) {
  let html = escapeActionInfoHtml(raw).replace(/-&gt;|→/g, '<span class="action-arrow">→</span>');
  const labelPattern = new RegExp(`(^|[|\\s])(${fieldLabels.map(escapeRegex).join('|')})([：:])`, 'g');
  html = html.replace(labelPattern, '$1<span class="action-field-label">$2$3</span>');
  html = html.replace(/\b(HP|MP|SP)\s*[：:]?\s*\[?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\]?/g,
    (_match, resource, current, maximum) => {
      const ratio = Number(maximum) > 0 ? Number(current) / Number(maximum) : 0;
      return `<span class="action-resource ${resource.toLowerCase()}${ratio <= .35 ? ' low' : ''}">${resource} ${current}/${maximum}</span>`;
    });
  const stats = { 力: ['力量', 'str'], 敏: ['敏捷', 'agi'], 体: ['体质', 'con'], 智: ['智力', 'int'], 精: ['精神', 'spi'] };
  html = html.replace(/(^|[|\s])(力|敏|体|智|精)\[?(\d+(?:\.\d+)?)\]?/g,
    (_match, prefix, key, value) => `${prefix}<span class="action-stat ${stats[key][1]}">${stats[key][0]} ${value}</span>`);
  const fullStats = { 力量: 'str', 敏捷: 'agi', 体质: 'con', 智力: 'int', 精神: 'spi' };
  html = html.replace(/(^|[|\s])(力量|敏捷|体质|智力|精神)\s*[：:]\s*(\d+(?:\.\d+)?)/g,
    (_match, prefix, key, value) => `${prefix}<span class="action-stat ${fullStats[key]}">${key} ${value}</span>`);
  const qualities = { 普通: 'normal', 优良: 'good', 優良: 'good', 稀有: 'rare', 史诗: 'epic', 史詩: 'epic', 传说: 'legendary', 傳說: 'legendary', 神话: 'mythic', 神話: 'mythic' };
  html = html.replace(/(^|[|\s])(普通|优良|優良|稀有|史诗|史詩|传说|傳說|神话|神話)(?=$|[|\s,，])/g,
    (_match, prefix, quality) => `${prefix}<span class="action-quality ${qualities[quality]}">${quality}</span>`);
  html = html.replace(/(^|[|\s])(大失败|大失敗|失败|失敗|不足|死亡|毁坏|毀壞)(?=$|[|\s,，()])/g,
    '$1<span class="action-result failure">$2</span>');
  html = html.replace(/(^|[|\s])(成功|胜利|勝利|充足|存活|精益求精)(?=$|[|\s,，()])/g,
    '$1<span class="action-result success">$2</span>');
  html = html.replace(/\b(EXP|FP)\s*\+(\d+(?:\.\d+)?)/g, '<span class="action-reward">$1 +$2</span>');
  return html;
}

function renderSection(section, id) {
  const [icon, accent] = panelConfig[section.title] ?? ['◆', '#e8d5b7'];
  const rows = section.rows.map((row) => `<div class="action-data-row">${decorateRow(row)}</div>`).join('');
  const notes = section.notes.map((note) => `<p class="action-panel-note">${escapeActionInfoHtml(note)}</p>`).join('');
  return `<section class="action-panel" style="--action-accent:${accent}"><button type="button" class="action-panel-header" data-action-panel-toggle aria-expanded="true" aria-controls="${id}"><span class="action-panel-icon" aria-hidden="true">${icon}</span><span class="action-panel-title">${escapeActionInfoHtml(section.title)}</span><span class="action-panel-chevron" aria-hidden="true">⌄</span></button><div class="action-panel-content" id="${id}">${rows}${notes}</div></section>`;
}

function narrative(value) {
  return value === '' ? '' : `<div class="action-message-narrative">${escapeActionInfoHtml(value)}</div>`;
}

export function renderActionInfoMessage(content, idPrefix = 'action-info', options = {}) {
  const source = String(content ?? '');
  const sectionFilter = typeof options.sectionFilter === 'function' ? options.sectionFilter : () => true;
  const pattern = /<action_info>([\s\S]*?)<\/action_info>/gi;
  let cursor = 0;
  let panelIndex = 0;
  let output = '';
  for (const match of source.matchAll(pattern)) {
    output += narrative(source.slice(cursor, match.index));
    const parsedSections = parseSections(match[1]);
    const sections = parsedSections.filter(sectionFilter);
    if (parsedSections.length === 0) output += narrative(match[0]);
    else if (sections.length > 0) {
      output += `<div class="action-panels">${sections.map((section, sectionIndex) =>
        renderSection(section, `${idPrefix}-${panelIndex}-${sectionIndex}`)).join('')}</div>`;
      panelIndex += 1;
    }
    cursor = match.index + match[0].length;
  }
  let tail = source.slice(cursor);
  if (options.suppressIncomplete) {
    const incomplete = tail.search(/<action_info>/i);
    if (incomplete >= 0) tail = tail.slice(0, incomplete);
  }
  output += narrative(tail);
  return output;
}

export function renderCombatActionInfoMessage(content, idPrefix = 'action-info', options = {}) {
  return renderActionInfoMessage(content, idPrefix, {
    ...options,
    sectionFilter: isCombatActionSection,
  });
}

export function bindActionInfoPanels(root) {
  root.querySelectorAll('[data-action-panel-toggle]').forEach((button) => {
    button.onclick = () => {
      const content = root.querySelector(`#${CSS.escape(button.getAttribute('aria-controls'))}`);
      if (content === null) return;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      content.hidden = expanded;
    };
  });
}
