export const statusRailTabs = [
  ['status', '状态'],
  ['equipment', '装备'],
  ['skills', '技能'],
  ['inventory', '背包'],
];

const attributes = ['力量', '敏捷', '体质', '智力', '精神'];

function valueAt(source, path, fallback = '') {
  let value = source;
  for (const part of path.split('.')) value = value?.[part];
  return value ?? fallback;
}

function renderValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('、') || '—';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function collectionEntries(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(index + 1), item]);
  return value !== null && typeof value === 'object' ? Object.entries(value) : [];
}

function collectionCards(value) {
  return collectionEntries(value).map(([key, raw]) => {
    const item = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
    return {
      title: String(item?.名称 ?? item?.name ?? key),
      fields: item === undefined
        ? [{ label: '值', value: renderValue(raw) }]
        : Object.entries(item)
          .filter(([field]) => !['名称', 'name'].includes(field))
          .map(([label, fieldValue]) => ({ label, value: renderValue(fieldValue) })),
    };
  });
}

function statusSections(state, playerName) {
  const protagonist = state?.主角 ?? {};
  const stats = protagonist.属性 ?? {};
  return [
    {
      kind: 'identity',
      overline: `${protagonist.种族 || '未知种族'} · ${protagonist.生命层级 || '未知层级'}`,
      title: protagonist.姓名 || playerName || '旅人',
      subtitle: `${(protagonist.身份 || []).join('、') || '无身份'} · ${(protagonist.职业 || []).join('、') || '无职业'}`,
      badge: { label: 'LV', value: String(protagonist.等级 ?? 1) },
    },
    {
      kind: 'fields',
      fields: [
        { label: '地点', value: String(valueAt(state, '世界.地点', '未知')) },
        { label: '时间', value: String(valueAt(state, '世界.时间', '未知')) },
        { label: '冒险者等级', value: String(protagonist.冒险者等级 || '未评级') },
      ],
    },
    {
      kind: 'meters',
      meters: [
        { label: '生命', value: Number(protagonist.生命值 ?? 0), maximum: Number(protagonist.生命值上限 ?? 0), tone: 'hp' },
        { label: '法力', value: Number(protagonist.法力值 ?? 0), maximum: Number(protagonist.法力值上限 ?? 0), tone: 'mp' },
        { label: '体力', value: Number(protagonist.体力值 ?? 0), maximum: Number(protagonist.体力值上限 ?? 0), tone: 'sp' },
        { label: '经验', value: Number(protagonist.累计经验值 ?? 0), maximum: Number(protagonist.升级所需经验 ?? 0), tone: 'xp' },
      ],
    },
    {
      kind: 'stats',
      title: '基础属性',
      aside: `可用点数 ${protagonist.属性点 ?? 0}`,
      stats: attributes.map((name) => ({
        label: name,
        value: String(stats[name] ?? 0),
        action: {
          id: `attribute:${name}`,
          label: '+',
          ariaLabel: `增加${name}`,
          disabled: Number(protagonist.属性点) < 1,
        },
      })),
    },
    {
      kind: 'fields',
      fields: [
        { label: '金钱', value: String(protagonist.金钱 ?? 0) },
        { label: '命运点数', value: String(state?.命运点数 ?? 0) },
      ],
    },
    {
      kind: 'cards',
      title: '状态效果',
      cards: collectionCards(protagonist.状态效果),
      emptyText: '当前没有状态效果',
    },
  ];
}

export function createDestinedPoemStatusRailModel(state, playerName = '') {
  const protagonist = state?.主角 ?? {};
  return {
    overline: 'Character State',
    title: protagonist.姓名 || playerName || '旅人',
    ariaLabel: '角色状态栏',
    closeLabel: '关闭状态栏',
    tabs: [
      { id: 'status', label: '状态', sections: statusSections(state, playerName) },
      {
        id: 'equipment', label: '装备', sections: [{
          kind: 'cards', cards: collectionCards(protagonist.装备), emptyText: '暂无装备记录',
        }],
      },
      {
        id: 'skills', label: '技能', sections: [{
          kind: 'cards', cards: collectionCards(protagonist.技能), emptyText: '暂无技能记录',
        }],
      },
      {
        id: 'inventory', label: '背包', sections: [{
          kind: 'cards', cards: collectionCards(protagonist.背包), emptyText: '背包为空',
        }],
      },
    ],
  };
}

export function attributeAllocationPatch(attribute) {
  if (!attributes.includes(attribute)) throw new Error('attribute_allocation_invalid');
  return [
    { op: 'delta', path: '/主角/属性点', value: -1 },
    { op: 'delta', path: `/主角/属性/${attribute}`, value: 1 },
  ];
}
