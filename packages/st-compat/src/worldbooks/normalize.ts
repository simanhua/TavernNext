import { randomUUID } from 'node:crypto';
import type { ImportDiagnostic } from '../warnings.js';
import { diagnostic } from '../warnings.js';
import type { JsonObject } from './schemas.js';

export type WorldbookSourceFormat = 'st-native' | 'character-book' | 'novel' | 'agnai' | 'risu' | 'naidata' | 'unknown';
export type SourceUid = string | number;

export interface WorldbookFilter {
  isExclude: boolean;
  names: string[];
  tags: string[];
  /** Nested future fields retained without making them executable. */
  unknownFields?: JsonObject;
}

export interface NormalizedWorldbookEntry {
  /** TavernNext-owned identity. Never derived from a source array position. */
  id: string;
  /** Exact source identity, including its original string/number type. */
  sourceUid: SourceUid;
  /** Stable source collection position, independent from TavernNext identity. */
  sourceOrdinal: number;
  keys: string[];
  secondaryKeys: string[];
  useRegex: boolean;
  selective: boolean;
  selectiveLogic: number;
  constant: boolean;
  vectorized: boolean;
  probability: number;
  useProbability: boolean;
  group: string;
  groupWeight: number;
  groupOverride: boolean;
  priority: number | null;
  order: number;
  position: number | string;
  depth: number;
  role: number;
  ignoreBudget: boolean;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean | number;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  characterFilter: WorldbookFilter;
  personaFilter: WorldbookFilter;
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  comment: string;
  displayName: string;
  content: string;
  enabled: boolean;
  addMemo: boolean;
  displayIndex: number | null;
  outletName: string;
  automationId: string;
  triggers: string[];
  extensions: JsonObject;
  unknownFields: JsonObject;
}

export interface NormalizedWorldbook {
  name: string;
  description: string;
  enabled: boolean;
  scanDepth: number | null;
  tokenBudget: number | null;
  recursiveScanning: boolean;
  extensions: JsonObject;
  unknownFields: JsonObject;
  entries: NormalizedWorldbookEntry[];
}

export interface NormalizationResult {
  worldbook: NormalizedWorldbook;
  warnings: ImportDiagnostic[];
}

const nativeBookFields = new Set([
  'name', 'description', 'enabled', 'scan_depth', 'token_budget', 'recursive_scanning', 'extensions', 'entries',
]);
const characterBookFields = new Set(nativeBookFields);
const nativeEntryFields = new Set([
  'uid', 'key', 'keysecondary', 'comment', 'displayName', 'content', 'constant', 'vectorized', 'selective',
  'selectiveLogic', 'addMemo', 'order', 'priority', 'position', 'disable', 'ignoreBudget', 'excludeRecursion',
  'preventRecursion', 'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
  'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes', 'delayUntilRecursion', 'probability',
  'useProbability', 'depth', 'outletName', 'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive',
  'matchWholeWords', 'useGroupScoring', 'automationId', 'role', 'sticky', 'cooldown', 'delay', 'characterFilter',
  'personaFilter', 'triggers', 'displayIndex', 'useRegex', 'extensions',
]);
const characterEntryFields = new Set([
  'id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective', 'insertion_order',
  'enabled', 'position', 'extensions',
]);
const filterFields = new Set(['isExclude', 'names', 'tags']);
export const MAX_WORLDBOOK_FIELD_WARNINGS = 64;

const knownPositions = new Set<number | string>([
  0, 1, 2, 3, 4, 5, 6, 7,
  'before_char', 'after_char', 'before_character', 'after_character', 'before', 'after',
  'an_top', 'an_bottom', 'at_depth', 'em_top', 'em_bottom', 'outlet',
]);

function record(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recursionDelay(value: unknown, fallback: boolean | number): boolean | number {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function unknownFields(value: JsonObject, known: ReadonlySet<string>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

function filter(value: unknown): WorldbookFilter {
  const source = record(value);
  const unknown = unknownFields(source, filterFields);
  return {
    isExclude: boolean(source.isExclude),
    names: strings(source.names),
    tags: strings(source.tags),
    ...(Object.keys(unknown).length === 0 ? {} : { unknownFields: unknown }),
  };
}

function pushWarning(warnings: ImportDiagnostic[], issue: ImportDiagnostic): void {
  if (warnings.length < MAX_WORLDBOOK_FIELD_WARNINGS) {
    warnings.push(issue);
    return;
  }
  if (warnings.length === MAX_WORLDBOOK_FIELD_WARNINGS) {
    warnings.push(diagnostic(
      'worldbook_diagnostics_truncated',
      `Additional Worldbook diagnostics were omitted after ${MAX_WORLDBOOK_FIELD_WARNINGS} field-specific warnings.`,
    ));
  }
}

function nativePosition(value: unknown): number | string {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return 0;
}

function characterPosition(value: unknown): number | string {
  return value === 'before_char' ? 0 : 1;
}

function warnUnknownPosition(position: number | string, path: string, warnings: ImportDiagnostic[]): void {
  if (!knownPositions.has(position)) {
    pushWarning(warnings, diagnostic(
      'worldbook_unknown_position',
      'The source position is not known to SillyTavern 1.18 and was preserved without changing its semantics.',
      path,
    ));
  }
}

class UidAllocator {
  private readonly seen = new Set<string>();

  allocate(value: unknown, path: string, warnings: ImportDiagnostic[], fallback?: unknown): SourceUid {
    let source = value;
    if (source === undefined && (typeof fallback === 'string' || typeof fallback === 'number')) source = fallback;
    let uid: SourceUid;
    if (typeof source === 'string' || (typeof source === 'number' && Number.isFinite(source))) {
      uid = source;
    } else {
      uid = `tn-${randomUUID()}`;
      pushWarning(warnings, diagnostic(
        source === undefined ? 'worldbook_source_uid_generated' : 'worldbook_source_uid_invalid',
        source === undefined
          ? 'The entry had no source UID, so a new source-safe UID was generated.'
          : 'The entry source UID was malformed, so a new source-safe UID was generated.',
        path,
      ));
    }
    const identity = `${typeof uid}:${String(uid)}`;
    if (this.seen.has(identity)) {
      pushWarning(warnings, diagnostic(
        'worldbook_source_uid_duplicate',
        'The source UID is duplicated. Its exact value was preserved and TavernNext assigned a separate UUID.',
        path,
      ));
    }
    this.seen.add(identity);
    return uid;
  }
}

function baseEntry(sourceUid: SourceUid, sourceOrdinal: number): NormalizedWorldbookEntry {
  return {
    id: randomUUID(),
    sourceUid,
    sourceOrdinal,
    keys: [],
    secondaryKeys: [],
    useRegex: true,
    selective: true,
    selectiveLogic: 0,
    constant: false,
    vectorized: false,
    probability: 100,
    useProbability: true,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    priority: null,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    ignoreBudget: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    characterFilter: filter(undefined),
    personaFilter: filter(undefined),
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    comment: '',
    displayName: '',
    content: '',
    enabled: true,
    addMemo: false,
    displayIndex: null,
    outletName: '',
    automationId: '',
    triggers: [],
    extensions: {},
    unknownFields: {},
  };
}

function bookBase(raw: JsonObject, known: ReadonlySet<string>, fallbackName = 'Imported Worldbook'): Omit<NormalizedWorldbook, 'entries'> {
  return {
    name: typeof raw.name === 'string' ? raw.name : fallbackName,
    description: string(raw.description),
    enabled: boolean(raw.enabled, true),
    scanDepth: nullableNumber(raw.scan_depth),
    tokenBudget: nullableNumber(raw.token_budget),
    recursiveScanning: boolean(raw.recursive_scanning),
    extensions: record(raw.extensions),
    unknownFields: unknownFields(raw, known),
  };
}

function nativeEntry(raw: JsonObject, sourceUid: SourceUid, sourceOrdinal: number): NormalizedWorldbookEntry {
  const sourceExtensions = record(raw.extensions);
  const sourceTavernNext = record(sourceExtensions.tavernnext);
  const compatibility = record(sourceTavernNext.characterBookPassthrough);
  const { characterBookPassthrough: ignoredPassthrough, ...retainedTavernNext } = sourceTavernNext;
  void ignoredPassthrough;
  const { tavernnext: ignoredTavernNext, ...retainedExtensions } = sourceExtensions;
  void ignoredTavernNext;
  const extensions = compatibility === undefined
    ? sourceExtensions
    : {
      ...retainedExtensions,
      ...(Object.keys(retainedTavernNext).length === 0 ? {} : { tavernnext: retainedTavernNext }),
    };
  return {
    ...baseEntry(sourceUid, sourceOrdinal),
    keys: strings(raw.key),
    secondaryKeys: strings(raw.keysecondary),
    useRegex: boolean(raw.useRegex, true),
    selective: boolean(raw.selective, true),
    selectiveLogic: number(raw.selectiveLogic, 0),
    constant: boolean(raw.constant),
    vectorized: boolean(raw.vectorized),
    probability: number(raw.probability, 100),
    useProbability: boolean(raw.useProbability, true),
    group: string(raw.group),
    groupWeight: number(raw.groupWeight, 100),
    groupOverride: boolean(raw.groupOverride),
    priority: nullableNumber(raw.priority),
    order: number(raw.order, 100),
    position: nativePosition(raw.position),
    depth: number(raw.depth, 4),
    role: number(raw.role, 0),
    ignoreBudget: boolean(raw.ignoreBudget),
    scanDepth: nullableNumber(raw.scanDepth),
    caseSensitive: typeof raw.caseSensitive === 'boolean' ? raw.caseSensitive : null,
    matchWholeWords: typeof raw.matchWholeWords === 'boolean' ? raw.matchWholeWords : null,
    useGroupScoring: typeof raw.useGroupScoring === 'boolean' ? raw.useGroupScoring : null,
    excludeRecursion: boolean(raw.excludeRecursion),
    preventRecursion: boolean(raw.preventRecursion),
    delayUntilRecursion: recursionDelay(raw.delayUntilRecursion, 0),
    sticky: nullableNumber(raw.sticky),
    cooldown: nullableNumber(raw.cooldown),
    delay: nullableNumber(raw.delay),
    characterFilter: filter(raw.characterFilter),
    personaFilter: filter(raw.personaFilter),
    matchPersonaDescription: boolean(raw.matchPersonaDescription),
    matchCharacterDescription: boolean(raw.matchCharacterDescription),
    matchCharacterPersonality: boolean(raw.matchCharacterPersonality),
    matchCharacterDepthPrompt: boolean(raw.matchCharacterDepthPrompt),
    matchScenario: boolean(raw.matchScenario),
    matchCreatorNotes: boolean(raw.matchCreatorNotes),
    comment: string(raw.comment),
    displayName: string(raw.displayName, string(raw.comment)),
    content: string(raw.content),
    enabled: !boolean(raw.disable),
    addMemo: boolean(raw.addMemo),
    displayIndex: nullableNumber(raw.displayIndex),
    outletName: string(raw.outletName),
    automationId: string(raw.automationId),
    triggers: strings(raw.triggers),
    extensions,
    unknownFields: { ...unknownFields(raw, nativeEntryFields), ...compatibility },
  };
}

export function normalizeNative(
  raw: JsonObject,
  sourceFormat: 'st-native' | 'naidata' = 'st-native',
  fallbackName = 'Imported Worldbook',
): NormalizationResult {
  const warnings: ImportDiagnostic[] = [];
  const allocator = new UidAllocator();
  const entries = Object.entries(record(raw.entries)).map(([key, value], sourceOrdinal) => {
    const entryRaw = record(value);
    const entry = nativeEntry(entryRaw, allocator.allocate(entryRaw.uid, `entries.${key}.uid`, warnings, key), sourceOrdinal);
    warnUnknownPosition(entry.position, `entries.${key}.position`, warnings);
    return entry;
  }).sort((left, right) => {
    if (left.order !== right.order) return right.order - left.order;
    const leftUid = `${typeof left.sourceUid}:${String(left.sourceUid)}`;
    const rightUid = `${typeof right.sourceUid}:${String(right.sourceUid)}`;
    return leftUid === rightUid ? 0 : leftUid < rightUid ? -1 : 1;
  });
  const base = bookBase(raw, nativeBookFields, fallbackName);
  if (sourceFormat === 'naidata') {
    // The decoded JSON is native ST data; sourceFormat is retained only by the preview.
  }
  return { worldbook: { ...base, entries }, warnings };
}

function extensionValue(extensions: JsonObject, key: string, fallback?: unknown): unknown {
  return extensions[key] === undefined ? fallback : extensions[key];
}

export function normalizeCharacterBook(raw: JsonObject, fallbackName = 'Imported Worldbook'): NormalizationResult {
  const warnings: ImportDiagnostic[] = [];
  const allocator = new UidAllocator();
  const entries = (raw.entries as JsonObject[]).map((entryRaw, index) => {
    const sourceUid = allocator.allocate(entryRaw.id, `entries[${index}].id`, warnings);
    const extensions = record(entryRaw.extensions);
    const fallbackPosition = characterPosition(entryRaw.position);
    const position = nativePosition(extensions.position ?? fallbackPosition);
    if (Object.hasOwn(extensions, 'add_memo')) {
      pushWarning(warnings, diagnostic(
        'worldbook_foreign_field_preserved',
        'Character Book extensions.add_memo is ignored by SillyTavern and was preserved verbatim.',
        `entries[${index}].extensions.add_memo`,
      ));
    }
    const entry: NormalizedWorldbookEntry = {
      ...baseEntry(sourceUid, index),
      keys: strings(entryRaw.keys),
      secondaryKeys: strings(entryRaw.secondary_keys),
      useRegex: true,
      selective: boolean(entryRaw.selective),
      selectiveLogic: number(extensionValue(extensions, 'selectiveLogic'), 0),
      constant: boolean(entryRaw.constant),
      vectorized: boolean(extensionValue(extensions, 'vectorized')),
      probability: number(extensionValue(extensions, 'probability'), 100),
      useProbability: boolean(extensionValue(extensions, 'useProbability'), true),
      group: string(extensionValue(extensions, 'group')),
      groupWeight: number(extensionValue(extensions, 'group_weight'), 100),
      groupOverride: boolean(extensionValue(extensions, 'group_override')),
      priority: null,
      order: number(entryRaw.insertion_order, 100),
      position,
      depth: number(extensionValue(extensions, 'depth'), 4),
      role: number(extensionValue(extensions, 'role'), 0),
      ignoreBudget: boolean(extensionValue(extensions, 'ignore_budget')),
      scanDepth: nullableNumber(extensionValue(extensions, 'scan_depth')),
      caseSensitive: typeof extensionValue(extensions, 'case_sensitive') === 'boolean'
        ? extensionValue(extensions, 'case_sensitive') as boolean
        : null,
      matchWholeWords: typeof extensions.match_whole_words === 'boolean' ? extensions.match_whole_words : null,
      useGroupScoring: typeof extensions.use_group_scoring === 'boolean' ? extensions.use_group_scoring : null,
      excludeRecursion: boolean(extensionValue(extensions, 'exclude_recursion')),
      preventRecursion: boolean(extensionValue(extensions, 'prevent_recursion')),
      delayUntilRecursion: recursionDelay(extensionValue(extensions, 'delay_until_recursion'), false),
      sticky: nullableNumber(extensionValue(extensions, 'sticky')),
      cooldown: nullableNumber(extensionValue(extensions, 'cooldown')),
      delay: nullableNumber(extensionValue(extensions, 'delay')),
      characterFilter: filter(extensionValue(extensions, 'character_filter')),
      personaFilter: filter(extensionValue(extensions, 'persona_filter')),
      matchPersonaDescription: boolean(extensionValue(extensions, 'match_persona_description')),
      matchCharacterDescription: boolean(extensionValue(extensions, 'match_character_description')),
      matchCharacterPersonality: boolean(extensionValue(extensions, 'match_character_personality')),
      matchCharacterDepthPrompt: boolean(extensionValue(extensions, 'match_character_depth_prompt')),
      matchScenario: boolean(extensionValue(extensions, 'match_scenario')),
      matchCreatorNotes: boolean(extensionValue(extensions, 'match_creator_notes')),
      comment: string(entryRaw.comment),
      displayName: string(entryRaw.comment),
      content: string(entryRaw.content),
      enabled: boolean(entryRaw.enabled, true),
      addMemo: Boolean(entryRaw.comment),
      displayIndex: nullableNumber(extensionValue(extensions, 'display_index')) ?? index,
      outletName: string(extensionValue(extensions, 'outlet_name')),
      automationId: string(extensionValue(extensions, 'automation_id')),
      triggers: strings(extensionValue(extensions, 'triggers')),
      extensions,
      unknownFields: warnForeignUnknown(entryRaw, characterEntryFields, `entries[${index}]`, warnings),
    };
    warnUnknownPosition(entry.position, `entries[${index}].extensions.position`, warnings);
    return entry;
  });
  return { worldbook: { ...bookBase(raw, characterBookFields, fallbackName), entries }, warnings };
}

function foreignExtensions(format: Exclude<WorldbookSourceFormat, 'st-native' | 'character-book' | 'naidata' | 'unknown'>, raw: JsonObject): JsonObject {
  const existing = record(raw.extensions);
  return {
    ...existing,
    tavernnext: {
      ...record(existing.tavernnext),
      sourceFormat: format,
      original: raw,
    },
  };
}

function warnForeignUnknown(
  raw: JsonObject,
  known: ReadonlySet<string>,
  path: string,
  warnings: ImportDiagnostic[],
): JsonObject {
  const unknown = unknownFields(raw, known);
  for (const key of Object.keys(unknown)) {
    pushWarning(warnings, diagnostic(
      'worldbook_foreign_field_preserved',
      'This foreign field has no verified SillyTavern runtime mapping and was preserved verbatim.',
      `${path}.${key}`,
    ));
  }
  return unknown;
}

function foreignBook(
  raw: JsonObject,
  format: 'novel' | 'agnai' | 'risu',
  known: ReadonlySet<string>,
  entries: NormalizedWorldbookEntry[],
  warnings: ImportDiagnostic[],
): NormalizedWorldbook {
  const unknown = warnForeignUnknown(raw, known, '$', warnings);
  return {
    name: string(raw.name, 'Imported Worldbook'),
    description: string(raw.description),
    enabled: true,
    scanDepth: null,
    tokenBudget: null,
    recursiveScanning: false,
    extensions: foreignExtensions(format, raw),
    unknownFields: unknown,
    entries,
  };
}

export function normalizeNovel(raw: JsonObject, fallbackName = 'Imported Worldbook'): NormalizationResult {
  const warnings: ImportDiagnostic[] = [];
  const allocator = new UidAllocator();
  const entries = (raw.entries as JsonObject[]).map((entryRaw, index) => {
    const context = record(entryRaw.contextConfig);
    const known = new Set(['id', 'displayName', 'keys', 'text', 'enabled', 'contextConfig', 'extensions']);
    const unknown = warnForeignUnknown(entryRaw, known, `entries[${index}]`, warnings);
    warnForeignUnknown(context, new Set(['budgetPriority']), `entries[${index}].contextConfig`, warnings);
    return {
      ...baseEntry(allocator.allocate(entryRaw.id, `entries[${index}].id`, warnings), index),
      keys: strings(entryRaw.keys),
      comment: string(entryRaw.displayName),
      displayName: string(entryRaw.displayName),
      content: string(entryRaw.text),
      enabled: boolean(entryRaw.enabled, true),
      selective: false,
      delayUntilRecursion: false,
      order: number(context.budgetPriority, 0),
      addMemo: string(entryRaw.displayName).trim() !== '',
      displayIndex: index,
      extensions: foreignExtensions('novel', entryRaw),
      unknownFields: unknown,
    };
  });
  return {
    worldbook: { ...foreignBook(raw, 'novel', new Set(['lorebookVersion', 'name', 'description', 'entries', 'extensions']), entries, warnings), name: typeof raw.name === 'string' ? raw.name : fallbackName },
    warnings,
  };
}

export function normalizeAgnai(raw: JsonObject, fallbackName = 'Imported Worldbook'): NormalizationResult {
  const warnings: ImportDiagnostic[] = [];
  const allocator = new UidAllocator();
  const entries = (raw.entries as JsonObject[]).map((entryRaw, index) => {
    const known = new Set(['id', 'name', 'keywords', 'entry', 'enabled', 'weight', 'extensions']);
    return {
      ...baseEntry(allocator.allocate(entryRaw.id, `entries[${index}].id`, warnings), index),
      keys: strings(entryRaw.keywords),
      comment: string(entryRaw.name),
      displayName: string(entryRaw.name),
      content: string(entryRaw.entry),
      enabled: boolean(entryRaw.enabled, true),
      selective: false,
      delayUntilRecursion: false,
      order: number(entryRaw.weight, 100),
      addMemo: Boolean(entryRaw.name),
      displayIndex: index,
      extensions: foreignExtensions('agnai', entryRaw),
      unknownFields: warnForeignUnknown(entryRaw, known, `entries[${index}]`, warnings),
    };
  });
  return {
    worldbook: { ...foreignBook(raw, 'agnai', new Set(['kind', 'name', 'description', 'entries', 'extensions']), entries, warnings), name: typeof raw.name === 'string' ? raw.name : fallbackName },
    warnings,
  };
}

function commaSeparated(value: unknown, optional = false): string[] {
  if (Array.isArray(value)) return strings(value);
  if (typeof value !== 'string' || (optional && value === '')) return [];
  return value.split(',').map((item) => item.trim());
}

export function normalizeRisu(raw: JsonObject, fallbackName = 'Imported Worldbook'): NormalizationResult {
  const warnings: ImportDiagnostic[] = [];
  const allocator = new UidAllocator();
  const entries = (raw.data as JsonObject[]).map((entryRaw, index) => {
    const known = new Set([
      'id', 'key', 'secondkey', 'comment', 'content', 'alwaysActive', 'selective', 'insertorder',
      'activationPercent', 'extensions',
    ]);
    return {
      ...baseEntry(allocator.allocate(entryRaw.id, `data[${index}].id`, warnings), index),
      keys: commaSeparated(entryRaw.key),
      secondaryKeys: commaSeparated(entryRaw.secondkey, true),
      comment: string(entryRaw.comment),
      displayName: string(entryRaw.comment),
      content: string(entryRaw.content),
      constant: boolean(entryRaw.alwaysActive),
      selective: boolean(entryRaw.selective),
      delayUntilRecursion: false,
      probability: number(entryRaw.activationPercent, 100),
      useProbability: Boolean(entryRaw.activationPercent ?? true),
      order: number(entryRaw.insertorder, 100),
      addMemo: true,
      displayIndex: index,
      extensions: foreignExtensions('risu', entryRaw),
      unknownFields: warnForeignUnknown(entryRaw, known, `data[${index}]`, warnings),
    };
  });
  return {
    worldbook: { ...foreignBook(raw, 'risu', new Set(['type', 'name', 'description', 'data', 'extensions']), entries, warnings), name: typeof raw.name === 'string' ? raw.name : fallbackName },
    warnings,
  };
}
