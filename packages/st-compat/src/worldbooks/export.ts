import type { JsonObject } from './schemas.js';
import type { NormalizedWorldbook, NormalizedWorldbookEntry } from './normalize.js';

export interface WorldbookExportArtifact {
  bytes: Uint8Array;
  contentType: 'application/json; charset=utf-8';
  fileName: string;
}

function compareEntries(left: NormalizedWorldbookEntry, right: NormalizedWorldbookEntry): number {
  if (left.order !== right.order) return right.order - left.order;
  return left.sourceOrdinal - right.sourceOrdinal;
}

function sourceObjectKey(sourceUid: NormalizedWorldbookEntry['sourceUid']): string {
  return String(sourceUid);
}

function exportedFilter(filter: NormalizedWorldbookEntry['characterFilter']): JsonObject {
  return {
    ...structuredClone(filter.unknownFields ?? {}),
    isExclude: filter.isExclude,
    names: [...filter.names],
    tags: [...filter.tags],
  };
}

function nativeEntry(entry: NormalizedWorldbookEntry): JsonObject {
  const canonical: JsonObject = {
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
    characterFilter: exportedFilter(entry.characterFilter),
    personaFilter: exportedFilter(entry.personaFilter),
    triggers: entry.triggers,
    displayIndex: entry.displayIndex,
    useRegex: entry.useRegex,
    extensions: entry.extensions,
  };
  const characterBookPassthrough = Object.fromEntries(
    Object.entries(entry.unknownFields)
      .filter(([key]) => Object.hasOwn(canonical, key))
      .map(([key, value]) => [key, structuredClone(value)]),
  );
  const existingTavernNext = typeof entry.extensions.tavernnext === 'object'
    && entry.extensions.tavernnext !== null
    && !Array.isArray(entry.extensions.tavernnext)
    ? entry.extensions.tavernnext as JsonObject
    : {};
  if (Object.keys(characterBookPassthrough).length > 0) {
    canonical.extensions = {
      ...entry.extensions,
      tavernnext: { ...existingTavernNext, characterBookPassthrough },
    };
  }
  return {
    ...entry.unknownFields,
    ...canonical,
  };
}

export function nativeWorldbookDocument(worldbook: NormalizedWorldbook): JsonObject {
  const ordered = [...worldbook.entries].sort(compareEntries);
  const entries = Object.create(null) as JsonObject;
  const reservedSourceKeys = new Set(ordered.map((entry) => sourceObjectKey(entry.sourceUid)));
  const occurrences = new Map<string, number>();
  const usedKeys = new Set<string>();
  for (const entry of ordered) {
    const baseKey = sourceObjectKey(entry.sourceUid);
    const occurrence = occurrences.get(baseKey) ?? 0;
    let key = baseKey;
    if (occurrence > 0 || usedKeys.has(key)) {
      let disambiguator = 0;
      do {
        key = `${baseKey}~${occurrence}${disambiguator === 0 ? '' : `~${disambiguator}`}`;
        disambiguator += 1;
      } while (reservedSourceKeys.has(key) || usedKeys.has(key));
    }
    occurrences.set(baseKey, occurrence + 1);
    usedKeys.add(key);
    Object.defineProperty(entries, key, {
      value: nativeEntry(entry), enumerable: true, configurable: true, writable: true,
    });
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
      character_filter: exportedFilter(entry.characterFilter),
      persona_filter: exportedFilter(entry.personaFilter),
    },
    ...entry.unknownFields,
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
