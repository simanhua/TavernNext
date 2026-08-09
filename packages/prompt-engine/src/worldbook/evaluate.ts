import type { NormalizedWorldbookEntry, SourceUid, WorldbookFilter } from '@tavernnext/st-compat';
import { allocateWorldbookBudget } from './budget.js';
import {
  compareMatchedEntries,
  comparePreparedEntries,
  createWorldbookRandom,
  entryGroups,
  filterWorldbookGroups,
} from './groups.js';
import {
  buildWorldbookScanText,
  MatchOperationLimitError,
  matchWorldbookEntry,
  type MatchOperationBudget,
} from './match.js';
import {
  applyWorldbookTimedEffects,
  fingerprintPreparedEntry,
  processWorldbookTimedEffects,
} from './timed-effects.js';
import {
  MAX_WORLDBOOK_ADDITIONAL_SOURCES,
  MAX_WORLDBOOK_CONTENT_CHARACTERS,
  MAX_WORLDBOOK_KEY_CHARACTERS,
  MAX_WORLDBOOK_KEYS_PER_ENTRY,
  MAX_WORLDBOOK_MESSAGES,
  MAX_WORLDBOOK_RECURSION_STEPS,
  MAX_WORLDBOOK_RUNTIME_BOOKS,
  MAX_WORLDBOOK_RUNTIME_ENTRIES,
  MAX_WORLDBOOK_SCAN_CHARACTERS,
  MAX_WORLDBOOK_TIMED_EFFECTS,
  MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS,
  MAX_WORLDBOOK_TOTAL_KEYS,
  MAX_WORLDBOOK_WARNINGS,
  type ActivatedWorldbookEntry,
  type MatchedWorldbookEntry,
  type PreparedWorldbookEntry,
  type WorldbookEvaluationInput,
  type WorldbookEvaluationResult,
  type WorldbookEvaluationSettings,
  type WorldbookExcludedEntry,
  type WorldbookExclusionReason,
  type WorldbookRuntimeBook,
  type WorldbookWarning,
} from './types.js';

interface RawEntryReference {
  entryKey: string;
  bookId: string;
  bookIndex: number;
  entryIndex: number;
  sourceUid: SourceUid;
  sourceOrdinal: number;
  rawEntry: unknown;
  rawBook: unknown;
}

interface WarningCollector {
  warnings: WorldbookWarning[];
  warn: (warning: WorldbookWarning) => void;
}

type ScanMode = 'initial' | 'recursion' | 'minimum';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, max = MAX_WORLDBOOK_KEYS_PER_ENTRY): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every((item) => typeof item === 'string' && item.length <= MAX_WORLDBOOK_KEY_CHARACTERS);
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validFilter(value: unknown): value is WorldbookFilter {
  return record(value)
    && typeof value.isExclude === 'boolean'
    && strings(value.names)
    && strings(value.tags);
}

function validEntry(value: unknown): value is NormalizedWorldbookEntry {
  if (!record(value)) return false;
  const sourceUidValid = typeof value.sourceUid === 'string'
    || (typeof value.sourceUid === 'number' && Number.isFinite(value.sourceUid));
  return typeof value.id === 'string'
    && sourceUidValid
    && Number.isSafeInteger(value.sourceOrdinal)
    && Number(value.sourceOrdinal) >= 0
    && strings(value.keys)
    && strings(value.secondaryKeys)
    && typeof value.useRegex === 'boolean'
    && typeof value.selective === 'boolean'
    && Number.isSafeInteger(value.selectiveLogic)
    && Number(value.selectiveLogic) >= 0
    && Number(value.selectiveLogic) <= 3
    && typeof value.constant === 'boolean'
    && typeof value.vectorized === 'boolean'
    && typeof value.probability === 'number'
    && Number.isFinite(value.probability)
    && typeof value.useProbability === 'boolean'
    && typeof value.group === 'string'
    && value.group.length <= MAX_WORLDBOOK_KEY_CHARACTERS
    && typeof value.groupWeight === 'number'
    && Number.isFinite(value.groupWeight)
    && typeof value.groupOverride === 'boolean'
    && finiteOrNull(value.priority)
    && typeof value.order === 'number'
    && Number.isFinite(value.order)
    && (typeof value.position === 'string' || (typeof value.position === 'number' && Number.isFinite(value.position)))
    && typeof value.depth === 'number'
    && Number.isFinite(value.depth)
    && Number.isSafeInteger(value.role)
    && typeof value.ignoreBudget === 'boolean'
    && finiteOrNull(value.scanDepth)
    && (value.caseSensitive === null || typeof value.caseSensitive === 'boolean')
    && (value.matchWholeWords === null || typeof value.matchWholeWords === 'boolean')
    && (value.useGroupScoring === null || typeof value.useGroupScoring === 'boolean')
    && typeof value.excludeRecursion === 'boolean'
    && typeof value.preventRecursion === 'boolean'
    && (typeof value.delayUntilRecursion === 'boolean'
      || (typeof value.delayUntilRecursion === 'number' && Number.isFinite(value.delayUntilRecursion)))
    && finiteOrNull(value.sticky)
    && finiteOrNull(value.cooldown)
    && finiteOrNull(value.delay)
    && validFilter(value.characterFilter)
    && validFilter(value.personaFilter)
    && typeof value.matchPersonaDescription === 'boolean'
    && typeof value.matchCharacterDescription === 'boolean'
    && typeof value.matchCharacterPersonality === 'boolean'
    && typeof value.matchCharacterDepthPrompt === 'boolean'
    && typeof value.matchScenario === 'boolean'
    && typeof value.matchCreatorNotes === 'boolean'
    && typeof value.comment === 'string'
    && typeof value.displayName === 'string'
    && typeof value.content === 'string'
    && value.content.length <= MAX_WORLDBOOK_CONTENT_CHARACTERS
    && typeof value.enabled === 'boolean'
    && typeof value.addMemo === 'boolean'
    && finiteOrNull(value.displayIndex)
    && typeof value.outletName === 'string'
    && typeof value.automationId === 'string'
    && strings(value.triggers);
}

function warningCollector(): WarningCollector {
  const warnings: WorldbookWarning[] = [];
  const seen = new Set<string>();
  let truncated = false;
  return {
    warnings,
    warn(warning) {
      const key = JSON.stringify([warning.code, warning.entryKey, warning.bookId, warning.keyIndex]);
      if (seen.has(key)) return;
      seen.add(key);
      if (warnings.length < MAX_WORLDBOOK_WARNINGS) {
        warnings.push(warning);
      } else if (!truncated) {
        warnings[MAX_WORLDBOOK_WARNINGS - 1] = {
          code: 'warnings_truncated',
          message: `Worldbook warnings were truncated after ${MAX_WORLDBOOK_WARNINGS} entries.`,
        };
        truncated = true;
      }
    },
  };
}

function safeUid(value: unknown, entryIndex: number): SourceUid {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : `invalid-${entryIndex}`;
}

function encodeIdentityComponent(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const safeAscii = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 45 || code === 46 || code === 95 || code === 126;
    encoded += safeAscii ? value[index] : `%${code.toString(16).padStart(4, '0')}`;
  }
  return encoded;
}

function uidIdentity(value: SourceUid): string {
  return `${typeof value}:${encodeIdentityComponent(String(value))}`;
}

function collectRawEntries(books: readonly WorldbookRuntimeBook[]): RawEntryReference[] {
  const collisions = new Map<string, number>();
  const references: RawEntryReference[] = [];
  books.forEach((runtimeBook, bookIndex) => {
    const rawRuntime = runtimeBook as unknown;
    const runtime = record(rawRuntime) ? rawRuntime : {};
    const bookId = typeof runtime.id === 'string' && runtime.id !== '' ? runtime.id : `book-${bookIndex}`;
    const rawBook = record(runtime.book) ? runtime.book : {};
    const entries = Array.isArray(rawBook.entries) ? rawBook.entries : [];
    entries.forEach((rawEntry, entryIndex) => {
      const source = record(rawEntry) ? rawEntry : {};
      const sourceUid = safeUid(source.sourceUid, entryIndex);
      const sourceOrdinal = Number.isSafeInteger(source.sourceOrdinal) && Number(source.sourceOrdinal) >= 0
        ? Number(source.sourceOrdinal)
        : entryIndex;
      const baseKey = `${encodeIdentityComponent(bookId)}|${uidIdentity(sourceUid)}@${sourceOrdinal}`;
      const collision = collisions.get(baseKey) ?? 0;
      collisions.set(baseKey, collision + 1);
      references.push({
        entryKey: collision === 0 ? baseKey : `${baseKey}#${collision}`,
        bookId,
        bookIndex,
        entryIndex,
        sourceUid,
        sourceOrdinal,
        rawEntry,
        rawBook,
      });
    });
  });
  return references;
}

function scanCharacterCount(input: WorldbookEvaluationInput): number {
  let count = input.scanSources.trigger.length
    + input.scanSources.messages.reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
  for (const source of input.scanSources.additional) {
    count += typeof source?.id === 'string' ? source.id.length : 0;
    count += typeof source?.content === 'string' ? source.content.length : 0;
  }
  const character = input.scanSources.character;
  if (character !== undefined) {
    count += character.name.length + character.tags.reduce((sum, value) => sum + value.length, 0)
      + character.description.length + character.personality.length + character.depthPrompt.length
      + character.scenario.length + character.creatorNotes.length;
  }
  const persona = input.scanSources.persona;
  if (persona !== undefined) {
    count += persona.name.length + persona.tags.reduce((sum, value) => sum + value.length, 0) + persona.description.length;
  }
  return count;
}

function rawEntryCharacterCount(value: unknown): number {
  if (!record(value)) return 0;
  const stringCharacterCount = (values: readonly unknown[]): number => {
    let total = 0;
    for (const item of values) {
      if (typeof item === 'string') total += item.length;
    }
    return total;
  };
  const directFields = [
    value.id, value.sourceUid, value.group, value.position, value.comment,
    value.displayName, value.content, value.outletName, value.automationId,
  ];
  let count = stringCharacterCount(directFields);
  for (const field of [value.keys, value.secondaryKeys, value.triggers]) {
    if (Array.isArray(field)) count += stringCharacterCount(field);
  }
  for (const field of [value.characterFilter, value.personaFilter]) {
    if (!record(field)) continue;
    for (const values of [field.names, field.tags]) {
      if (Array.isArray(values)) count += stringCharacterCount(values);
    }
  }
  return count;
}

function limitResult(
  references: readonly RawEntryReference[],
  input: WorldbookEvaluationInput,
  code: string,
  message: string,
): WorldbookEvaluationResult {
  return {
    activated: [],
    excluded: references.map((reference) => ({
      entryKey: reference.entryKey,
      bookId: reference.bookId,
      sourceUid: reference.sourceUid,
      sourceOrdinal: reference.sourceOrdinal,
      reason: 'evaluation_limit',
    })),
    timedState: { messageIndex: input.messageIndex, sticky: [], cooldown: [] },
    tokenUsage: {
      budget: Number.isSafeInteger(input.tokenBudget) && input.tokenBudget >= 0 ? input.tokenBudget : 0,
      used: 0,
      overflowed: false,
    },
    recursionSteps: 0,
    warnings: [{ code, message }],
  };
}

function validIdentitySource(value: unknown, kind: 'character' | 'persona'): boolean {
  if (value === undefined) return true;
  if (!record(value) || typeof value.name !== 'string' || !strings(value.tags)) return false;
  if (kind === 'persona') return typeof value.description === 'string';
  return typeof value.description === 'string'
    && typeof value.personality === 'string'
    && typeof value.depthPrompt === 'string'
    && typeof value.scenario === 'string'
    && typeof value.creatorNotes === 'string';
}

function validateGlobalInput(
  input: WorldbookEvaluationInput,
  references: readonly RawEntryReference[],
): { code: string; message: string } | undefined {
  if (input.books.length > MAX_WORLDBOOK_RUNTIME_BOOKS) {
    return { code: 'book_limit', message: `Worldbook evaluation accepts at most ${MAX_WORLDBOOK_RUNTIME_BOOKS} books.` };
  }
  if (references.length > MAX_WORLDBOOK_RUNTIME_ENTRIES) {
    return { code: 'entry_limit', message: `Worldbook evaluation accepts at most ${MAX_WORLDBOOK_RUNTIME_ENTRIES} entries.` };
  }
  if (!Number.isSafeInteger(input.messageIndex) || input.messageIndex < 0
    || !Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0
    || !(typeof input.seed === 'string' || (typeof input.seed === 'number' && Number.isFinite(input.seed)))) {
    return { code: 'invalid_evaluation_input', message: 'Worldbook seed, message index, or token budget is invalid.' };
  }
  if (!record(input.scanSources)
    || !Array.isArray(input.scanSources.messages)
    || input.scanSources.messages.length > MAX_WORLDBOOK_MESSAGES
    || !input.scanSources.messages.every((value) => typeof value === 'string')
    || !Array.isArray(input.scanSources.additional)
    || input.scanSources.additional.length > MAX_WORLDBOOK_ADDITIONAL_SOURCES
    || !input.scanSources.additional.every((value) => record(value)
      && typeof value.id === 'string' && typeof value.content === 'string')
    || typeof input.scanSources.trigger !== 'string'
    || !validIdentitySource(input.scanSources.character, 'character')
    || !validIdentitySource(input.scanSources.persona, 'persona')) {
    return { code: 'scan_source_limit', message: 'Worldbook scan sources are malformed or exceed their item limit.' };
  }
  if (scanCharacterCount(input) > MAX_WORLDBOOK_SCAN_CHARACTERS) {
    return { code: 'scan_source_limit', message: `Worldbook scan sources are limited to ${MAX_WORLDBOOK_SCAN_CHARACTERS} characters.` };
  }
  const effects = input.previousTimedState;
  if (!record(effects)
    || !Array.isArray(effects.sticky)
    || !Array.isArray(effects.cooldown)
    || effects.sticky.length + effects.cooldown.length > MAX_WORLDBOOK_TIMED_EFFECTS) {
    return { code: 'timed_state_limit', message: `Worldbook timed state accepts at most ${MAX_WORLDBOOK_TIMED_EFFECTS} effects.` };
  }
  const totalKeys = references.reduce((sum, reference) => {
    if (!record(reference.rawEntry)) return sum;
    return sum
      + (Array.isArray(reference.rawEntry.keys) ? reference.rawEntry.keys.length : 0)
      + (Array.isArray(reference.rawEntry.secondaryKeys) ? reference.rawEntry.secondaryKeys.length : 0);
  }, 0);
  if (totalKeys > MAX_WORLDBOOK_TOTAL_KEYS) {
    return { code: 'key_limit', message: `Worldbook evaluation accepts at most ${MAX_WORLDBOOK_TOTAL_KEYS} total keys.` };
  }
  const totalEntryCharacters = references.reduce(
    (sum, reference) => sum + rawEntryCharacterCount(reference.rawEntry),
    0,
  );
  if (totalEntryCharacters > MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS) {
    return {
      code: 'entry_character_limit',
      message: `Worldbook entry fields are limited to ${MAX_WORLDBOOK_TOTAL_ENTRY_CHARACTERS} aggregate characters.`,
    };
  }
  return undefined;
}

function normalizedSettings(input: WorldbookEvaluationInput, warn: (warning: WorldbookWarning) => void): Required<WorldbookEvaluationSettings> {
  const source = input.settings ?? {};
  const nonNegative = (value: number | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
  const requestedSteps = nonNegative(source.maxRecursionSteps, MAX_WORLDBOOK_RECURSION_STEPS);
  if (requestedSteps > MAX_WORLDBOOK_RECURSION_STEPS) {
    warn({
      code: 'recursion_limit_clamped',
      message: `Worldbook recursion was clamped to ${MAX_WORLDBOOK_RECURSION_STEPS} safe steps.`,
    });
  }
  return {
    scanDepth: nonNegative(source.scanDepth, 2),
    caseSensitive: source.caseSensitive ?? false,
    matchWholeWords: source.matchWholeWords ?? false,
    useGroupScoring: source.useGroupScoring ?? false,
    recursiveScanning: source.recursiveScanning
      ?? input.books.some((runtimeBook) => runtimeBook.book?.recursiveScanning === true),
    minActivations: nonNegative(source.minActivations, 0),
    minActivationsDepthMax: nonNegative(source.minActivationsDepthMax, 0),
    maxRecursionSteps: requestedSteps === 0
      ? MAX_WORLDBOOK_RECURSION_STEPS
      : Math.min(requestedSteps, MAX_WORLDBOOK_RECURSION_STEPS),
  };
}

function prepareEntries(
  references: readonly RawEntryReference[],
  collector: WarningCollector,
  reasons: Map<string, WorldbookExclusionReason>,
): PreparedWorldbookEntry[] {
  const prepared: PreparedWorldbookEntry[] = [];
  for (const reference of references) {
    if (!validEntry(reference.rawEntry)) {
      reasons.set(reference.entryKey, 'invalid_entry');
      collector.warn({
        code: 'invalid_entry',
        message: 'A malformed Worldbook entry was excluded while valid siblings continued.',
        entryKey: reference.entryKey,
        bookId: reference.bookId,
      });
      continue;
    }
    const rawBook = record(reference.rawBook) ? reference.rawBook : {};
    const base: Omit<PreparedWorldbookEntry, 'fingerprint'> = {
      entryKey: reference.entryKey,
      bookId: reference.bookId,
      bookName: typeof rawBook.name === 'string' ? rawBook.name : reference.bookId,
      bookIndex: reference.bookIndex,
      entryIndex: reference.entryIndex,
      bookScanDepth: typeof rawBook.scanDepth === 'number' && Number.isFinite(rawBook.scanDepth)
        ? rawBook.scanDepth
        : null,
      entry: reference.rawEntry,
    };
    const item: PreparedWorldbookEntry = { ...base, fingerprint: fingerprintPreparedEntry(base) };
    if (rawBook.enabled === false) reasons.set(item.entryKey, 'book_disabled');
    prepared.push(item);
  }
  return prepared.sort(comparePreparedEntries);
}

function filterAllows(filter: WorldbookFilter, identity: { name: string; tags: readonly string[] } | undefined): boolean {
  const nameMatches = identity !== undefined && filter.names.includes(identity.name);
  const tagMatches = identity !== undefined && identity.tags.some((tag) => filter.tags.includes(tag));
  if (filter.isExclude) return !(nameMatches || tagMatches);
  const nameAllowed = filter.names.length === 0 || nameMatches;
  const tagsAllowed = filter.tags.length === 0 || tagMatches;
  return nameAllowed && tagsAllowed;
}

function recursionDelay(value: boolean | number): number {
  if (value === true) return 1;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return 0;
}

function staticExclusion(
  prepared: PreparedWorldbookEntry,
  input: WorldbookEvaluationInput,
): WorldbookExclusionReason | undefined {
  if (record(input.books[prepared.bookIndex]?.book) && input.books[prepared.bookIndex]!.book.enabled === false) {
    return 'book_disabled';
  }
  const entry = prepared.entry;
  if (!entry.enabled) return 'entry_disabled';
  if (entry.triggers.length > 0 && !entry.triggers.includes(input.scanSources.trigger)) return 'trigger_mismatch';
  if (!filterAllows(entry.characterFilter, input.scanSources.character)) return 'character_filter';
  if (!filterAllows(entry.personaFilter, input.scanSources.persona)) return 'persona_filter';
  if (typeof entry.delay === 'number' && entry.delay > 0 && input.messageIndex < entry.delay) return 'delay';
  return undefined;
}

function outputActivation(
  candidate: MatchedWorldbookEntry,
  tokenUsageAfter: number,
): ActivatedWorldbookEntry {
  const { prepared } = candidate;
  return {
    entryKey: prepared.entryKey,
    bookId: prepared.bookId,
    bookName: prepared.bookName,
    sourceUid: prepared.entry.sourceUid,
    sourceOrdinal: prepared.entry.sourceOrdinal,
    content: prepared.entry.content,
    position: prepared.entry.position,
    depth: prepared.entry.depth,
    role: prepared.entry.role,
    outletName: prepared.entry.outletName,
    order: prepared.entry.order,
    priority: prepared.entry.priority,
    ignoreBudget: prepared.entry.ignoreBudget,
    activation: candidate.activation,
    activationStep: candidate.activationStep,
    tokenUsageAfter,
  };
}

function outputExclusions(
  references: readonly RawEntryReference[],
  finalKeys: ReadonlySet<string>,
  reasons: ReadonlyMap<string, WorldbookExclusionReason>,
): WorldbookExcludedEntry[] {
  return references.flatMap((reference) => finalKeys.has(reference.entryKey) ? [] : [{
    entryKey: reference.entryKey,
    bookId: reference.bookId,
    sourceUid: reference.sourceUid,
    sourceOrdinal: reference.sourceOrdinal,
    reason: reasons.get(reference.entryKey) ?? 'primary_key_miss',
  }]);
}

export function evaluateWorldbooks(input: WorldbookEvaluationInput): WorldbookEvaluationResult {
  const references = collectRawEntries(Array.isArray(input.books) ? input.books : []);
  const inputIssue = validateGlobalInput(input, references);
  if (inputIssue !== undefined) return limitResult(references, input, inputIssue.code, inputIssue.message);

  const collector = warningCollector();
  const settings = normalizedSettings(input, collector.warn);
  const reasons = new Map<string, WorldbookExclusionReason>();
  const preparedEntries = prepareEntries(references, collector, reasons);
  const preparedMap = new Map(preparedEntries.map((prepared) => [prepared.entryKey, prepared]));
  const timed = processWorldbookTimedEffects({
    messageIndex: input.messageIndex,
    previous: input.previousTimedState,
    entries: preparedMap,
    warn: collector.warn,
  });
  const random = createWorldbookRandom(input.seed);
  const operations: MatchOperationBudget = { count: 0 };
  const selected = new Map<string, MatchedWorldbookEntry>();
  const probabilityFailed = new Set<string>();
  const recursionText: string[] = [];
  const delayedLevels = [...new Set(preparedEntries
    .map((prepared) => recursionDelay(prepared.entry.delayUntilRecursion))
    .filter((level) => level > 0))].sort((left, right) => left - right);

  let mode: ScanMode = 'initial';
  let activationStep = 0;
  let recursionLevel = 0;
  let globalDepth = settings.scanDepth;
  let passCount = 0;
  let pending = true;
  let fatalMatchLimit = false;

  while (pending && passCount < settings.maxRecursionSteps) {
    pending = false;
    passCount += 1;
    const matches: MatchedWorldbookEntry[] = [];
    try {
      for (const prepared of preparedEntries) {
        if (selected.has(prepared.entryKey) || probabilityFailed.has(prepared.entryKey)) continue;
        const fixedReason = staticExclusion(prepared, input);
        if (fixedReason !== undefined) {
          reasons.set(prepared.entryKey, fixedReason);
          continue;
        }
        const sticky = timed.stickyEntryKeys.has(prepared.entryKey);
        if (timed.cooldownEntryKeys.has(prepared.entryKey) && !sticky) {
          reasons.set(prepared.entryKey, 'cooldown');
          continue;
        }
        const delayLevel = recursionDelay(prepared.entry.delayUntilRecursion);
        if (mode !== 'recursion' && delayLevel > 0 && !sticky) {
          reasons.set(prepared.entryKey, 'recursion_delayed');
          continue;
        }
        if (mode === 'recursion' && delayLevel > recursionLevel && !sticky) {
          reasons.set(prepared.entryKey, 'recursion_delayed');
          continue;
        }
        if (mode === 'recursion' && prepared.entry.excludeRecursion && !sticky) {
          reasons.set(prepared.entryKey, 'recursion_excluded');
          continue;
        }
        if (sticky) {
          matches.push({ prepared, activation: 'sticky', activationStep, score: Number.MAX_SAFE_INTEGER });
          continue;
        }
        if (prepared.entry.constant) {
          matches.push({ prepared, activation: 'constant', activationStep, score: 0 });
          continue;
        }
        const text = buildWorldbookScanText({
          prepared,
          sources: input.scanSources,
          settings,
          globalDepth,
          recursionText,
          includeRecursion: mode === 'recursion',
        });
        const match = matchWorldbookEntry({
          prepared,
          text,
          settings,
          operations,
          warn: collector.warn,
        });
        if (!match.matched) {
          reasons.set(prepared.entryKey, match.reason);
          continue;
        }
        matches.push({ prepared, activation: 'keyword', activationStep, score: match.score });
      }
    } catch (error) {
      if (!(error instanceof MatchOperationLimitError)) throw error;
      fatalMatchLimit = true;
      collector.warn({
        code: 'match_operation_limit',
        message: 'Worldbook evaluation stopped before unbounded keyword matching work.',
      });
      break;
    }

    const activeGroups = new Set([...selected.values()].flatMap((candidate) => entryGroups(candidate.prepared.entry.group)));
    const grouped = filterWorldbookGroups({
      candidates: matches.sort(compareMatchedEntries),
      alreadyActiveGroups: activeGroups,
      stickyEntryKeys: timed.stickyEntryKeys,
      settings,
      random,
      exclude: (prepared, reason) => reasons.set(prepared.entryKey, reason),
    });
    const newlySelected: MatchedWorldbookEntry[] = [];
    for (const candidate of grouped) {
      const entry = candidate.prepared.entry;
      if (candidate.activation !== 'sticky' && entry.useProbability && entry.probability !== 100) {
        if (random() * 100 > entry.probability) {
          probabilityFailed.add(candidate.prepared.entryKey);
          reasons.set(candidate.prepared.entryKey, 'probability');
          continue;
        }
      }
      selected.set(candidate.prepared.entryKey, candidate);
      reasons.delete(candidate.prepared.entryKey);
      newlySelected.push(candidate);
    }

    const recursiveContent = newlySelected
      .filter((candidate) => !candidate.prepared.entry.preventRecursion)
      .map((candidate) => candidate.prepared.entry.content)
      .filter((content) => content !== '');
    const hasUnresolvedEntries = preparedEntries.some((prepared) => !selected.has(prepared.entryKey)
      && !probabilityFailed.has(prepared.entryKey));
    if (settings.recursiveScanning && recursiveContent.length > 0 && hasUnresolvedEntries) {
      recursionText.push(...recursiveContent);
      mode = 'recursion';
      recursionLevel += 1;
      activationStep += 1;
      pending = true;
      continue;
    }

    const nextDelayedLevel = delayedLevels.find((level) => level > recursionLevel);
    if (nextDelayedLevel !== undefined) {
      mode = 'recursion';
      recursionLevel = nextDelayedLevel;
      activationStep = Math.max(activationStep + 1, nextDelayedLevel);
      pending = true;
      continue;
    }

    const maxMinimumDepth = settings.minActivationsDepthMax > 0
      ? Math.min(settings.minActivationsDepthMax, input.scanSources.messages.length)
      : input.scanSources.messages.length;
    if (settings.minActivations > selected.size && globalDepth < maxMinimumDepth) {
      globalDepth += 1;
      mode = 'minimum';
      activationStep += 1;
      pending = true;
    }
  }

  if (fatalMatchLimit) {
    selected.clear();
    for (const prepared of preparedEntries) reasons.set(prepared.entryKey, 'evaluation_limit');
    return {
      activated: [],
      excluded: outputExclusions(references, new Set(), reasons),
      timedState: timed.state,
      tokenUsage: { budget: input.tokenBudget, used: 0, overflowed: false },
      recursionSteps: passCount,
      warnings: collector.warnings,
    };
  }

  if (pending) {
    collector.warn({
      code: 'recursion_limit',
      message: `Worldbook recursion stopped after ${settings.maxRecursionSteps} safe scan steps.`,
    });
    for (const prepared of preparedEntries) {
      if (selected.has(prepared.entryKey)) continue;
      const reason = reasons.get(prepared.entryKey);
      if (reason === 'primary_key_miss' || reason === 'secondary_key_miss' || reason === 'recursion_delayed') {
        reasons.set(prepared.entryKey, 'recursion_limit');
      }
    }
  }

  const budgetCandidates = [...selected.values()].sort(compareMatchedEntries);
  const budget = allocateWorldbookBudget({
    candidates: budgetCandidates,
    budget: input.tokenBudget,
    tokenizer: input.tokenizer,
    exclude: (candidate, reason) => reasons.set(candidate.prepared.entryKey, reason),
  });
  if (budget.tokenizerError) {
    collector.warn({
      code: 'tokenizer_error',
      message: 'The Worldbook tokenizer failed or returned an invalid count.',
    });
  }
  const finalKeys = new Set(budget.selected.map((candidate) => candidate.prepared.entryKey));
  const timedState = applyWorldbookTimedEffects(timed.state, budget.selected, input.messageIndex);
  const activated = budget.selected.map((candidate) => outputActivation(
    candidate,
    budget.tokenUsageAfter.get(candidate.prepared.entryKey) ?? 0,
  ));
  return {
    activated,
    excluded: outputExclusions(references, finalKeys, reasons),
    timedState,
    tokenUsage: budget.usage,
    recursionSteps: passCount,
    warnings: collector.warnings,
  };
}
