import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_WORLD_INFO_HASH = '5ba94f74ab7c1f13db7c2ac3dc8778f0174d95278cc9698b24bb1a9c8ab76d61';
const EXPECTED_REVISION = '8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8';

export interface OracleEntryFixture {
  uid: string;
  keys?: string[];
  content: string;
  order: number;
  constant?: boolean;
  enabled?: boolean;
  group?: string;
  groupWeight?: number;
  groupOverride?: boolean;
  ignoreBudget?: boolean;
  preventRecursion?: boolean;
  useProbability?: boolean;
  probability?: number;
  triggers?: string[];
  sticky?: number | null;
  cooldown?: number | null;
  characterFilter?: { isExclude: boolean; names: string[]; tags: string[] };
}

export const ORACLE_MATCH_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'high-order', content: 'HIGH', order: 150, constant: true },
  { uid: 'character-filter', content: 'FILTERED', order: 100, constant: true, characterFilter: { isExclude: true, names: ['Aster.png'], tags: [] } },
  { uid: 'disabled', content: 'DISABLED', order: 100, constant: true, enabled: false },
  { uid: 'group-a', keys: ['alpha'], content: 'GROUP_A', order: 100, group: 'weather', groupWeight: 25 },
  { uid: 'group-b', keys: ['alpha'], content: 'GROUP_B', order: 100, group: 'weather', groupWeight: 75 },
  { uid: 'probability', content: 'PROBABILITY', order: 100, constant: true, useProbability: true, probability: 20 },
  { uid: 'trigger', content: 'TRIGGER', order: 100, constant: true, triggers: ['continue'] },
  { uid: 'low-order', content: 'LOW', order: 50, constant: true },
];

export const ORACLE_TIMED_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'clock', content: 'CLOCK', order: 100, constant: true, sticky: 2, cooldown: 2 },
];

export const ORACLE_GROUP_ORDER_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'z-one', content: 'Z_ONE', order: 200, constant: true, group: 'z', groupWeight: 50 },
  { uid: 'z-two', content: 'Z_TWO', order: 200, constant: true, group: 'z', groupWeight: 50 },
  { uid: 'a-one', content: 'A_ONE', order: 100, constant: true, group: 'a', groupWeight: 50 },
  { uid: 'a-two', content: 'A_TWO', order: 100, constant: true, group: 'a', groupWeight: 50 },
];

export const ORACLE_ACTIVE_MULTI_GROUP_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'multi', keys: ['alpha'], content: 'beta', order: 200, group: 'a,b' },
  { uid: 'a-weighted', keys: ['beta'], content: 'WEIGHTED', order: 100, group: 'a' },
  { uid: 'a-override', keys: ['beta'], content: 'OVERRIDE', order: 90, group: 'a', groupOverride: true },
];

export const ORACLE_BUDGET_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'boundary', content: 'AB', order: 100, constant: true },
];

export const ORACLE_BUDGET_ACCUMULATOR_FIXTURE: readonly OracleEntryFixture[] = [
  { uid: 'normal-a', content: 'A', order: 200, constant: true },
  { uid: 'ignored-b', content: 'B', order: 100, constant: true, ignoreBudget: true },
];

export interface OracleProjection {
  activated: Array<{ uid: string; content: string; order: number }>;
  excluded: Array<{ uid: string; reason: string }>;
  timedState: {
    sticky: Array<{ uid: string; start: number; end: number; protected: boolean }>;
    cooldown: Array<{ uid: string; start: number; end: number; protected: boolean }>;
  };
  tokens: { used: number };
}

export interface WorldbookOracle {
  provenance: {
    packageName: string;
    version: string;
    revision: string;
    revisionVerifiedBy: string;
    worldInfoSha256: string;
    execution: string;
    declarations: string[];
  };
  matching: OracleProjection;
  timed: {
    started: OracleProjection;
    held: OracleProjection;
    cooling: OracleProjection;
  };
  groups: {
    firstOccurrence: OracleProjection;
    activeMultiGroup: OracleProjection;
  };
  budget: {
    fits: OracleBudgetProjection;
    boundary: OracleBudgetProjection;
    rejectedThenIgnored: OracleBudgetProjection;
  };
}

export interface OracleBudgetProjection {
  activated: string[];
  excluded: string[];
  tokenizerInputs: string[];
  tokenUsage: { budget: number; used: number; overflowed: boolean };
}

type UpstreamEntry = Record<string, unknown> & { uid: string; content: string; order: number; world: string; hash: number };
type UpstreamState = { timedWorldInfo: { sticky: Record<string, unknown>; cooldown: Record<string, unknown> } };

function sourceAt(root: string, relativePath: string): string {
  return readFileSync(join(root, ...relativePath.split('/')), 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function declaration(source: string, sourceName: string, name: string, kind: 'function' | 'class'): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = kind === 'function' ? '(?:async\\s+)?function' : 'class';
  const startMatch = new RegExp(`^(?:export\\s+)?${prefix}\\s+${escapedName}\\b`, 'm').exec(source);
  if (startMatch === null) throw new Error(`Unable to extract upstream ${kind} ${name} from ${sourceName}.`);
  const start = startMatch.index;
  let searchStart = start + startMatch[0].length;
  if (kind === 'function') {
    const open = source.indexOf('(', searchStart);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '(') depth += 1;
      if (source[index] !== ')') continue;
      depth -= 1;
      if (depth === 0) {
        searchStart = index + 1;
        break;
      }
    }
  }
  const openingBrace = source.indexOf('{', searchStart);
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/^export\s+/, '');
  }
  throw new Error(`Unable to find end of upstream ${kind} ${name}.`);
}

function topLevelFunctionDeclaration(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`Unable to extract upstream function ${name}.`);
  const remainder = source.slice(start);
  const closing = /\r?\n}\r?\n/.exec(remainder);
  if (closing === null) throw new Error(`Unable to find end of upstream function ${name}.`);
  return remainder.slice(0, closing.index + closing[0].indexOf('}') + 1).replace(/^export\s+/, '');
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function upstreamEntry(fixture: OracleEntryFixture, index: number): UpstreamEntry {
  return {
    uid: fixture.uid,
    world: 'oracle',
    hash: 10_000 + index,
    key: fixture.keys ?? [],
    keysecondary: [],
    content: fixture.content,
    order: fixture.order,
    priority: null,
    constant: fixture.constant ?? false,
    selective: false,
    selectiveLogic: 0,
    disable: fixture.enabled === false,
    probability: fixture.probability ?? 100,
    useProbability: fixture.useProbability ?? false,
    group: fixture.group ?? '',
    groupWeight: fixture.groupWeight ?? 100,
    groupOverride: fixture.groupOverride ?? false,
    useGroupScoring: false,
    ignoreBudget: fixture.ignoreBudget ?? false,
    scanDepth: null,
    caseSensitive: false,
    matchWholeWords: false,
    excludeRecursion: false,
    preventRecursion: fixture.preventRecursion ?? false,
    delayUntilRecursion: 0,
    sticky: fixture.sticky ?? null,
    cooldown: fixture.cooldown ?? null,
    delay: null,
    characterFilter: fixture.characterFilter ?? { isExclude: false, names: [], tags: [] },
    personaFilter: { isExclude: false, names: [], tags: [] },
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    triggers: fixture.triggers ?? [],
    decorators: [],
    position: 0,
    depth: 4,
    role: 0,
    outletName: '',
  };
}

function lineFrom(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object' && 'uid' in value) return `[entry ${String((value as { uid: unknown }).uid)}]`;
    return '[object]';
  }).join(' ');
}

function excludedReason(lines: readonly string[], uid: string): string {
  const relevant = lines.filter((line) => line.includes(`Entry ${uid}`) || line.includes(`entry ${uid}`));
  const joined = relevant.join('\n');
  if (joined.includes('disabled')) return 'entry_disabled';
  if (joined.includes('generation type trigger filter')) return 'trigger_mismatch';
  if (joined.includes('filtered out by character') || joined.includes('filtered out by tag')) return 'character_filter';
  if (joined.includes('suppressed by cooldown')) return 'cooldown';
  if (joined.includes('removed as loser') || joined.includes('removed as score loser') || joined.includes('non-sticky loser')) return 'group_loser';
  if (joined.includes('failed probability check')) return 'probability';
  throw new Error(`Oracle fixture entry ${uid} had no observable upstream exclusion reason.\n${joined}`);
}

function normalizeState(state: UpstreamState): OracleProjection['timedState'] {
  const normalize = (effects: Record<string, unknown>) => Object.entries(effects).map(([key, raw]) => {
    const effect = raw as { start: number; end: number; protected: boolean };
    return { uid: key.slice(key.indexOf('.') + 1), start: effect.start, end: effect.end, protected: effect.protected };
  }).sort((left, right) => left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0);
  return {
    sticky: normalize(state.timedWorldInfo.sticky),
    cooldown: normalize(state.timedWorldInfo.cooldown),
  };
}

async function runOracleCase(input: {
  checkWorldInfo: (...args: unknown[]) => Promise<{ allActivatedEntries: Set<UpstreamEntry> }>;
  fixtures: readonly OracleEntryFixture[];
  state: UpstreamState;
  chatLength: number;
  lines: string[];
  tokenInputs: string[];
  chat?: string[];
  maxContext?: number;
  knownExcludedReason?: string;
}): Promise<OracleProjection> {
  input.lines.splice(0, input.lines.length);
  input.tokenInputs.splice(0, input.tokenInputs.length);
  const chat = input.chat ?? Array.from({ length: input.chatLength }, (_, index) => index === 0 ? 'alpha' : `pad-${index}`);
  const result = await input.checkWorldInfo(chat, input.maxContext ?? 64, false, {
    trigger: 'normal', personaDescription: '', characterDescription: '', characterPersonality: '',
    characterDepthPrompt: '', scenario: '', creatorNotes: '',
  });
  const activated = [...result.allActivatedEntries].map((entry) => ({
    uid: entry.uid,
    content: entry.content,
    order: entry.order,
  }));
  const active = new Set(activated.map((entry) => entry.uid));
  return {
    activated,
    excluded: input.fixtures.filter((entry) => !active.has(entry.uid)).map((entry) => ({
      uid: entry.uid,
      reason: input.knownExcludedReason ?? excludedReason(input.lines, entry.uid),
    })),
    timedState: normalizeState(input.state),
    tokens: { used: activated.length === 0 ? 0 : (input.tokenInputs.at(-1)?.length ?? 0) },
  };
}

async function runBudgetOracleCase(input: {
  checkWorldInfo: (...args: unknown[]) => Promise<{ allActivatedEntries: Set<UpstreamEntry> }>;
  fixtures: readonly OracleEntryFixture[];
  state: UpstreamState;
  lines: string[];
  tokenInputs: string[];
  budget: number;
  used: number;
}): Promise<OracleBudgetProjection> {
  const projected = await runOracleCase({
    checkWorldInfo: input.checkWorldInfo,
    fixtures: input.fixtures,
    state: input.state,
    chatLength: 0,
    chat: [],
    maxContext: input.budget,
    lines: input.lines,
    tokenInputs: input.tokenInputs,
    knownExcludedReason: 'budget',
  });
  const activated = projected.activated.map((entry) => entry.uid);
  const excluded = input.fixtures
    .filter((entry) => !activated.includes(entry.uid))
    .map((entry) => entry.uid);
  return {
    activated,
    excluded,
    tokenizerInputs: [...input.tokenInputs],
    tokenUsage: {
      budget: input.budget,
      used: input.used,
      overflowed: excluded.length > 0,
    },
  };
}

export async function loadSillyTavern118WorldbookOracle(root: string): Promise<WorldbookOracle> {
  const packageDocument = JSON.parse(sourceAt(root, 'package.json')) as { name?: string; version?: string };
  if (packageDocument.name !== 'sillytavern' || packageDocument.version !== '1.18.0') {
    throw new Error(`Expected SillyTavern 1.18.0, received ${String(packageDocument.name)} ${String(packageDocument.version)}.`);
  }
  const source = sourceAt(root, 'public/scripts/world-info.js');
  const actualHash = sha256(source);
  if (actualHash !== EXPECTED_WORLD_INFO_HASH) {
    throw new Error(`SillyTavern world-info oracle hash mismatch: ${actualHash}.`);
  }
  let actualRevision: string;
  try {
    actualRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Unable to verify the SillyTavern oracle Git revision: ${String(error)}`);
  }
  if (actualRevision !== EXPECTED_REVISION) {
    throw new Error(`SillyTavern oracle revision mismatch: ${actualRevision}.`);
  }

  const names: Array<[string, 'function' | 'class']> = [
    ['parseRegexFromString', 'function'],
    ['WorldInfoBuffer', 'class'],
    ['WorldInfoTimedEffects', 'class'],
    ['filterGroupsByScoring', 'function'],
    ['filterGroupsByTimedEffects', 'function'],
    ['filterByInclusionGroups', 'function'],
    ['checkWorldInfo', 'function'],
  ];
  const extracted = names.map(([name, kind]) => name === 'parseRegexFromString'
    ? topLevelFunctionDeclaration(source, name)
    : declaration(source, 'public/scripts/world-info.js', name, kind));
  extracted.forEach((value, index) => {
    try {
      void new Function(value);
    } catch (error) {
      throw new Error(`Extracted upstream declaration ${names[index]![0]} is not executable: ${String(error)}`);
    }
  });
  const fixtures = ORACLE_MATCH_FIXTURE;
  let currentEntries = fixtures.map(upstreamEntry);
  let currentState: UpstreamState = { timedWorldInfo: { sticky: {}, cooldown: {} } };
  let tokenCounter = (text: string): number => text.length;
  const lines: string[] = [];
  const tokenInputs: string[] = [];
  const capturedConsole = {
    debug: (...args: unknown[]) => lines.push(lineFrom(args)),
    log: (...args: unknown[]) => lines.push(lineFrom(args)),
    warn: (...args: unknown[]) => lines.push(lineFrom(args)),
    error: (...args: unknown[]) => lines.push(lineFrom(args)),
  };
  let random = seededRandom(4);
  const deterministicMath = Object.create(Math) as Math;
  Object.defineProperty(deterministicMath, 'random', { value: () => random() });
  const context = { extensionPrompts: {}, tagMap: {}, setExtensionPrompt: () => undefined };
  const dependencies: Record<string, unknown> = {
    MAX_SCAN_DEPTH: 1000,
    DEFAULT_DEPTH: 4,
    DEFAULT_WEIGHT: 100,
    world_info_depth: 2,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_use_group_scoring: false,
    world_info_recursive: false,
    world_info_max_recursion_steps: 16,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 100,
    world_info_budget_cap: 0,
    world_info_overflow_alert: false,
    scan_state: { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 },
    world_info_logic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 },
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 },
    wi_anchor_position: { before: 0, after: 1 },
    extension_prompt_roles: { SYSTEM: 0 },
    regex_placement: { WORLD_INFO: 0 },
    getRegexedString: (value: string) => value,
    shouldWIAddPrompt: false,
    getContext: () => context,
    getExtensionPromptByName: async () => '',
    getSortedEntries: async () => structuredClone(currentEntries),
    getTokenCountAsync: async (text: string) => {
      tokenInputs.push(text);
      return tokenCounter(text);
    },
    substituteParams: (value: string) => value,
    getCharaFilename: () => 'Aster.png',
    this_chid: 0,
    chat_metadata: currentState,
    eventSource: { emit: async () => undefined },
    event_types: { WORLDINFO_SCAN_DONE: 'world_info_scan_done' },
    toastr: { warning: () => undefined },
    escapeRegex: (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    sortFn: (left: { order: number }, right: { order: number }) => right.order - left.order,
    Math: deterministicMath,
    console: capturedConsole,
    NOTE_MODULE_NAME: 'note',
    metadata_keys: {},
    extension_settings: {},
  };
  const factory = new Function(
    ...Object.keys(dependencies),
    `${extracted.join('\n\n')}\nreturn checkWorldInfo;`,
  ) as (...values: unknown[]) => (...args: unknown[]) => Promise<{ allActivatedEntries: Set<UpstreamEntry> }>;
  const checkWorldInfo = factory(...Object.values(dependencies));
  const checkWorldInfoRecursive = factory(...Object.values({ ...dependencies, world_info_recursive: true }));

  const matching = await runOracleCase({
    checkWorldInfo, fixtures, state: currentState, chatLength: 4, lines, tokenInputs,
  });

  currentEntries = ORACLE_TIMED_FIXTURE.map(upstreamEntry);
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  const started = await runOracleCase({
    checkWorldInfo, fixtures: ORACLE_TIMED_FIXTURE, state: currentState, chatLength: 10, lines, tokenInputs,
  });
  const held = await runOracleCase({
    checkWorldInfo, fixtures: ORACLE_TIMED_FIXTURE, state: currentState, chatLength: 11, lines, tokenInputs,
  });
  const cooling = await runOracleCase({
    checkWorldInfo, fixtures: ORACLE_TIMED_FIXTURE, state: currentState, chatLength: 12, lines, tokenInputs,
  });

  currentEntries = ORACLE_GROUP_ORDER_FIXTURE.map(upstreamEntry);
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  const firstOccurrence = await runOracleCase({
    checkWorldInfo,
    fixtures: ORACLE_GROUP_ORDER_FIXTURE,
    state: currentState,
    chatLength: 0,
    lines,
    tokenInputs,
  });

  currentEntries = ORACLE_ACTIVE_MULTI_GROUP_FIXTURE.map(upstreamEntry);
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  const activeMultiGroup = await runOracleCase({
    checkWorldInfo: checkWorldInfoRecursive,
    fixtures: ORACLE_ACTIVE_MULTI_GROUP_FIXTURE,
    state: currentState,
    chatLength: 1,
    chat: ['alpha'],
    lines,
    tokenInputs,
  });

  currentEntries = ORACLE_BUDGET_FIXTURE.map(upstreamEntry);
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  const fits = await runBudgetOracleCase({
    checkWorldInfo, fixtures: ORACLE_BUDGET_FIXTURE, state: currentState, lines, tokenInputs, budget: 4, used: 3,
  });
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  const boundary = await runBudgetOracleCase({
    checkWorldInfo, fixtures: ORACLE_BUDGET_FIXTURE, state: currentState, lines, tokenInputs, budget: 3, used: 0,
  });

  currentEntries = ORACLE_BUDGET_ACCUMULATOR_FIXTURE.map(upstreamEntry);
  currentState.timedWorldInfo = { sticky: {}, cooldown: {} };
  random = seededRandom(1);
  tokenCounter = (text) => {
    if (text.includes('B')) throw new Error('ignoreBudget content reached the upstream tokenizer');
    return text.length;
  };
  const rejectedThenIgnored = await runBudgetOracleCase({
    checkWorldInfo,
    fixtures: ORACLE_BUDGET_ACCUMULATOR_FIXTURE,
    state: currentState,
    lines,
    tokenInputs,
    budget: 2,
    used: 0,
  });

  return {
    provenance: {
      packageName: packageDocument.name,
      version: packageDocument.version,
      revision: actualRevision,
      revisionVerifiedBy: 'git rev-parse HEAD',
      worldInfoSha256: actualHash,
      execution: 'read-only hash-pinned upstream WorldInfoBuffer, WorldInfoTimedEffects, grouping, and checkWorldInfo',
      declarations: names.map(([name]) => name),
    },
    matching,
    timed: { started, held, cooling },
    groups: { firstOccurrence, activeMultiGroup },
    budget: { fits, boundary, rejectedThenIgnored },
  };
}
