import { readFile, writeFile } from 'node:fs/promises';
import JSON5 from 'json5';

const sourceVersion = '1.8.2';
const dataBaseUrl = `https://testingcf.jsdelivr.net/gh/The-poem-of-destiny/FrontEnd-for-destined-journey@${sourceVersion}/public/assets/data`;
const characterPath = new URL('../apps/server/assets/official-scenes/destined-poem/content/character.png', import.meta.url);
const outputPath = new URL('../apps/server/assets/official-scenes/destined-poem/content/setup-catalog.json', import.meta.url);
const dataFiles = [
  'baseInfo.json',
  'backgrounds.json',
  'partners.json',
  'equipments.json',
  'items.json',
  'skills.json',
  'coreClassification.json',
];

function decodeCharacterCard(buffer) {
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const separator = data.indexOf(0);
    if (type === 'tEXt' && separator >= 0 && data.subarray(0, separator).toString('utf8') === 'ccv3') {
      return JSON.parse(Buffer.from(data.subarray(separator + 1).toString('utf8'), 'base64').toString('utf8'));
    }
    offset += length + 12;
  }
  throw new Error('destined_poem_ccv3_chunk_missing');
}

async function fetchDataFile(name) {
  const response = await fetch(`${dataBaseUrl}/${name}`);
  if (!response.ok) throw new Error(`destined_poem_setup_data_fetch_failed:${name}:${response.status}`);
  return JSON5.parse(await response.text());
}

function finalParenthesis(value) {
  return value.match(/\(([^)]+)\)(?=[^()]*$)/)?.[1]?.trim() ?? '';
}

function authorInfo(entries) {
  for (const entry of entries) {
    const suffix = finalParenthesis(entry.comment);
    if (suffix === '') continue;
    const separator = suffix.indexOf('-');
    return separator > 0
      ? { author: suffix.slice(0, separator).trim(), info: suffix.slice(separator + 1).trim() }
      : { author: suffix, info: '' };
  }
  return { author: '', info: '' };
}

function markers(entries, pattern) {
  const values = new Set();
  for (const entry of entries) {
    for (const match of entry.comment.matchAll(pattern)) values.add(match[1]);
  }
  return [...values];
}

function coreCatalog(entries, classification) {
  return entries.filter((entry) => entry.comment.startsWith('命定系统-')).map((entry) => {
    const raw = entry.comment.replace(/^命定系统-/, '');
    const author = finalParenthesis(raw);
    const label = raw.replace(/\(([^)]*)\)$/, '');
    return {
      entryComment: entry.comment,
      label,
      author,
      note: classification.ALL?.[label]?.note ?? '',
      enabled: entry.enabled,
    };
  }).sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function dlcCatalog(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const match = entry.comment.match(/^(\[DLC\]\[(角色|事件|扩展)\]\[([^\]]+)\])/);
    if (match === null) continue;
    const group = groups.get(match[1]) ?? { key: match[1], category: match[2], label: match[3], entries: [] };
    group.entries.push(entry);
    groups.set(group.key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    category: group.category,
    label: group.label,
    ...authorInfo(group.entries),
    entryComments: group.entries.map((entry) => entry.comment),
    enabled: group.entries.every((entry) => entry.enabled),
    exclusionTargets: markers(group.entries, /\[!([^\]]+)\]/g),
    replacementTargets: markers(group.entries, /\[>([^\]]+)\]/g),
    prerequisiteTargets: markers(group.entries, /\[<([^\]]+)\]/g),
  })).sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

const card = decodeCharacterCard(await readFile(characterPath));
const datasets = Object.fromEntries(await Promise.all(dataFiles.map(async (name) => [name, await fetchDataFile(name)])));
const entries = card.data.character_book.entries;
const catalog = {
  sourceVersion,
  generatedFrom: 'v4.2.1 Character Card and pinned FrontEnd-for-destined-journey assets',
  baseInfo: datasets['baseInfo.json'],
  backgrounds: datasets['backgrounds.json'],
  partners: datasets['partners.json'],
  equipments: datasets['equipments.json'],
  items: datasets['items.json'],
  skills: datasets['skills.json'],
  cores: coreCatalog(entries, datasets['coreClassification.json']),
  dlcs: dlcCatalog(entries),
  worldbookEntries: entries.map((entry) => ({ comment: entry.comment, enabled: entry.enabled })),
};

await writeFile(outputPath, `${JSON.stringify(catalog)}\n`, 'utf8');
console.log(`Wrote ${catalog.cores.length} cores, ${catalog.dlcs.length} DLC groups, and custom-start catalogs to ${outputPath.pathname}`);
