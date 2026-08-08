import type { JsonObject } from './schemas.js';
import type { NormalizedWorldbook, NormalizedWorldbookEntry } from './normalize.js';

export interface WorldbookExportArtifact {
  bytes: Uint8Array;
  contentType: 'application/json; charset=utf-8';
  fileName: string;
}

function compareEntries(left: NormalizedWorldbookEntry, right: NormalizedWorldbookEntry): number {
  if (left.order !== right.order) return right.order - left.order;
  const leftUid = `${typeof left.sourceUid}:${String(left.sourceUid)}`;
  const rightUid = `${typeof right.sourceUid}:${String(right.sourceUid)}`;
  if (leftUid !== rightUid) return leftUid < rightUid ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

function nativeEntry(entry: NormalizedWorldbookEntry): JsonObject {
  return {
    ...entry.unknownFields,
    uid: entry.sourceUid,
    key: entry.keys,
    keysecondary: entry.secondaryKeys,
    comment: entry.comment,
    displayName: entry.displayName,
    content: entry.content,
    constant: entry.constant,
    vectorized: entry.vectorized,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    addMemo: entry.addMemo,
    order: entry.order,
    priority: entry.priority,
    position: entry.position,
    disable: !entry.enabled,
    ignoreBudget: entry.ignoreBudget,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
    delayUntilRecursion: entry.delayUntilRecursion,
    probability: entry.probability,
    useProbability: entry.useProbability,
    depth: entry.depth,
    outletName: entry.outletName,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring,
    automationId: entry.automationId,
    role: entry.role,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    characterFilter: entry.characterFilter,
    personaFilter: entry.personaFilter,
    triggers: entry.triggers,
    displayIndex: entry.displayIndex,
    useRegex: entry.useRegex,
    extensions: entry.extensions,
  };
}

export function nativeWorldbookDocument(worldbook: NormalizedWorldbook): JsonObject {
  const entries: JsonObject = {};
  for (const entry of [...worldbook.entries].sort(compareEntries)) {
    const baseKey = String(entry.sourceUid);
    let key = baseKey;
    if (Object.hasOwn(entries, key)) key = `${baseKey}~${entry.id}`;
    entries[key] = nativeEntry(entry);
  }
  return {
    ...worldbook.unknownFields,
    name: worldbook.name,
    description: worldbook.description,
    enabled: worldbook.enabled,
    scan_depth: worldbook.scanDepth,
    token_budget: worldbook.tokenBudget,
    recursive_scanning: worldbook.recursiveScanning,
    extensions: worldbook.extensions,
    entries,
  };
}

function characterBookEntry(entry: NormalizedWorldbookEntry): JsonObject {
  return {
    ...entry.unknownFields,
    id: entry.sourceUid,
    keys: entry.keys,
    secondary_keys: entry.secondaryKeys,
    comment: entry.comment,
    name: entry.displayName,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    insertion_order: entry.order,
    priority: entry.priority,
    enabled: entry.enabled,
    position: entry.position === 1 || entry.position === 'after_char' ? 'after_char' : 'before_char',
    use_regex: entry.useRegex,
    case_sensitive: entry.caseSensitive,
    extensions: {
      ...entry.extensions,
      position: entry.position,
      exclude_recursion: entry.excludeRecursion,
      prevent_recursion: entry.preventRecursion,
      delay_until_recursion: entry.delayUntilRecursion,
      display_index: entry.displayIndex,
      probability: entry.probability,
      useProbability: entry.useProbability,
      depth: entry.depth,
      selectiveLogic: entry.selectiveLogic,
      outlet_name: entry.outletName,
      group: entry.group,
      group_override: entry.groupOverride,
      group_weight: entry.groupWeight,
      scan_depth: entry.scanDepth,
      case_sensitive: entry.caseSensitive,
      match_whole_words: entry.matchWholeWords,
      use_group_scoring: entry.useGroupScoring,
      automation_id: entry.automationId,
      role: entry.role,
      vectorized: entry.vectorized,
      sticky: entry.sticky,
      cooldown: entry.cooldown,
      delay: entry.delay,
      match_persona_description: entry.matchPersonaDescription,
      match_character_description: entry.matchCharacterDescription,
      match_character_personality: entry.matchCharacterPersonality,
      match_character_depth_prompt: entry.matchCharacterDepthPrompt,
      match_scenario: entry.matchScenario,
      match_creator_notes: entry.matchCreatorNotes,
      triggers: entry.triggers,
      ignore_budget: entry.ignoreBudget,
      add_memo: entry.addMemo,
      character_filter: entry.characterFilter,
      persona_filter: entry.personaFilter,
    },
  };
}

export function exportCharacterBook(worldbook: NormalizedWorldbook): JsonObject {
  return {
    ...worldbook.unknownFields,
    name: worldbook.name,
    description: worldbook.description,
    enabled: worldbook.enabled,
    scan_depth: worldbook.scanDepth,
    token_budget: worldbook.tokenBudget,
    recursive_scanning: worldbook.recursiveScanning,
    extensions: worldbook.extensions,
    entries: [...worldbook.entries].sort(compareEntries).map(characterBookEntry),
  };
}

function safeStem(value: string): string {
  const stem = value.trim()
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[. ]+$/g, '');
  return stem === '' ? 'worldbook' : stem.slice(0, 120);
}

export function encodeNativeWorldbook(worldbook: NormalizedWorldbook): WorldbookExportArtifact {
  return {
    bytes: new TextEncoder().encode(`${JSON.stringify(nativeWorldbookDocument(worldbook), null, 2)}\n`),
    contentType: 'application/json; charset=utf-8',
    fileName: `${safeStem(worldbook.name)}.json`,
  };
}
