import type {
  Character,
  CompatibilityMetadata,
  ExtensionAsset,
  Persona,
  Preset,
  Worldbook,
  WorldbookEntry,
} from '@tavernnext/domain';
import {
  attachedExtensionOverview,
  executablePresetFields,
  normalizeAttachedExtensions,
  presetSettingsForExecution,
  summarizeSPreset,
  validatePresetFamily,
} from '@tavernnext/st-compat';

const MAX_SUMMARY_WARNINGS = 64;
const MAX_SUMMARY_TEXT = 256;

function boundedText(value: string): string {
  return value.slice(0, MAX_SUMMARY_TEXT);
}

export interface CompatibilitySummary {
  sourceFormat: string;
  warnings: string[];
  unknownFieldCount: number;
}

export function compatibilitySummary(value: CompatibilityMetadata | undefined): CompatibilitySummary | undefined {
  if (value === undefined) return undefined;
  return {
    sourceFormat: boundedText(value.sourceFormat),
    warnings: value.compatWarnings.slice(0, MAX_SUMMARY_WARNINGS).map(boundedText),
    unknownFieldCount: Object.keys(value.unknownFields).length,
  };
}

function mutableFields(value: { id: string; revision: number; createdAt: string; updatedAt: string }) {
  return { id: value.id, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function characterSummary(character: Character) {
  return {
    ...mutableFields(character),
    name: character.name,
    ...(character.avatarPath === undefined ? {} : { avatarUrl: `/api/characters/${character.id}/avatar` }),
    ...(compatibilitySummary(character.compatibility) === undefined
      ? {}
      : { compatibilitySummary: compatibilitySummary(character.compatibility) }),
  };
}

export function characterDetail(character: Character, extensionAssets: readonly ExtensionAsset[] = []) {
  const normalizedExtensions = normalizeAttachedExtensions(character.extensions);
  const persistedOverview = extensionAssets.length === 0
    ? normalizedExtensions.overview
    : attachedExtensionOverview(extensionAssets, normalizedExtensions.extensions);
  const attachedExtensions = {
    ...persistedOverview,
    diagnostics: [...new Set([
      ...normalizedExtensions.overview.diagnostics,
      ...persistedOverview.diagnostics,
    ])],
  };
  return {
    ...characterSummary(character),
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    firstMessage: character.firstMessage,
    examples: character.examples,
    systemPrompt: character.systemPrompt,
    postHistoryInstructions: character.postHistoryInstructions,
    creatorNotes: character.creatorNotes,
    creator: character.creator,
    characterVersion: character.characterVersion,
    depthPrompt: character.depthPrompt,
    alternateGreetings: [...character.alternateGreetings],
    tags: [...character.tags],
    attachedExtensions,
    ...(character.worldbookId === undefined ? {} : { worldbookId: character.worldbookId }),
  };
}

export function personaDetail(persona: Persona) {
  return {
    ...mutableFields(persona),
    name: persona.name,
    description: persona.description,
    isDefault: persona.isDefault,
    ...(persona.avatarPath === undefined ? {} : { avatarUrl: `/api/personas/${persona.id}/avatar` }),
    ...(compatibilitySummary(persona.compatibility) === undefined
      ? {}
      : { compatibilitySummary: compatibilitySummary(persona.compatibility) }),
  };
}

export function presetSummary(preset: Preset) {
  return { id: preset.id, revision: preset.revision, name: preset.name, kind: preset.kind };
}

export function safePresetSettings(preset: Preset): Record<string, unknown> {
  const markerFree = preset.compatibility === undefined
    ? presetSettingsForExecution(preset.settings)
    : presetSettingsForExecution(preset.settings, preset.compatibility, preset.kind);
  return executablePresetFields(preset.kind, validatePresetFamily(preset.kind, markerFree)).settings;
}

export function presetDetail(preset: Preset, extensionAssets: readonly ExtensionAsset[] = []) {
  const normalized = normalizeAttachedExtensions(preset.extensions);
  const persistedOverview = extensionAssets.length === 0
    ? normalized.overview
    : attachedExtensionOverview(extensionAssets, normalized.extensions);
  const attachedExtensions = {
    ...persistedOverview,
    diagnostics: [...new Set([...normalized.overview.diagnostics, ...persistedOverview.diagnostics])],
  };
  return {
    ...mutableFields(preset),
    name: preset.name,
    kind: preset.kind,
    settings: safePresetSettings(preset),
    attachedExtensions,
    spreset: summarizeSPreset(normalized.extensions),
    ...(compatibilitySummary(preset.compatibility) === undefined
      ? {}
      : { compatibilitySummary: compatibilitySummary(preset.compatibility) }),
  };
}

export function worldbookSummary(worldbook: Worldbook, entryCount: number) {
  return {
    id: worldbook.id,
    revision: worldbook.revision,
    name: worldbook.name,
    enabled: worldbook.enabled,
    entryCount,
  };
}

export function worldbookEntryDetail(entry: WorldbookEntry) {
  return {
    ...mutableFields(entry),
    worldbookId: entry.worldbookId,
    ...(entry.sourceUid === undefined ? {} : { sourceUid: entry.sourceUid }),
    ...(entry.sourceOrdinal === undefined ? {} : { sourceOrdinal: entry.sourceOrdinal }),
    keys: [...entry.keys],
    secondaryKeys: [...entry.secondaryKeys],
    useRegex: entry.useRegex,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    constant: entry.constant,
    vectorized: entry.vectorized,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupWeight: entry.groupWeight,
    groupOverride: entry.groupOverride,
    priority: entry.priority,
    content: entry.content,
    enabled: entry.enabled,
    position: entry.position,
    order: entry.order,
    depth: entry.depth,
    role: entry.role,
    ignoreBudget: entry.ignoreBudget,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    characterFilter: structuredClone(entry.characterFilter),
    personaFilter: structuredClone(entry.personaFilter),
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
    comment: entry.comment,
    displayName: entry.displayName,
    addMemo: entry.addMemo,
    displayIndex: entry.displayIndex,
    outletName: entry.outletName,
    automationId: entry.automationId,
    triggers: [...entry.triggers],
    ...(compatibilitySummary(entry.compatibility) === undefined
      ? {}
      : { compatibilitySummary: compatibilitySummary(entry.compatibility) }),
  };
}

function compareWorldbookEntries(left: WorldbookEntry, right: WorldbookEntry): number {
  return left.order - right.order
    || (left.sourceOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.sourceOrdinal ?? Number.MAX_SAFE_INTEGER)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function worldbookDetail(worldbook: Worldbook, entries: readonly WorldbookEntry[]) {
  return {
    ...mutableFields(worldbook),
    name: worldbook.name,
    description: worldbook.description,
    enabled: worldbook.enabled,
    scanDepth: worldbook.scanDepth,
    tokenBudget: worldbook.tokenBudget,
    recursiveScanning: worldbook.recursiveScanning,
    isGlobal: worldbook.isGlobal,
    ...(compatibilitySummary(worldbook.compatibility) === undefined
      ? {}
      : { compatibilitySummary: compatibilitySummary(worldbook.compatibility) }),
    entries: [...entries].sort(compareWorldbookEntries).map(worldbookEntryDetail),
  };
}
