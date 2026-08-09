import type {
  MatchedWorldbookEntry,
  PreparedWorldbookEntry,
  WorldbookTimedEffect,
  WorldbookTimedState,
  WorldbookWarning,
} from './types.js';

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export function fingerprintPreparedEntry(prepared: Omit<PreparedWorldbookEntry, 'fingerprint'>): string {
  const { entry } = prepared;
  const canonical = JSON.stringify({
    version: 2,
    entryKey: prepared.entryKey,
    bookScanDepth: prepared.bookScanDepth,
    entry: {
      id: entry.id,
      sourceUid: entry.sourceUid,
      sourceOrdinal: entry.sourceOrdinal,
      keys: entry.keys,
      secondaryKeys: entry.secondaryKeys,
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
      order: entry.order,
      position: entry.position,
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
      characterFilter: {
        isExclude: entry.characterFilter.isExclude,
        names: entry.characterFilter.names,
        tags: entry.characterFilter.tags,
      },
      personaFilter: {
        isExclude: entry.personaFilter.isExclude,
        names: entry.personaFilter.names,
        tags: entry.personaFilter.tags,
      },
      matchPersonaDescription: entry.matchPersonaDescription,
      matchCharacterDescription: entry.matchCharacterDescription,
      matchCharacterPersonality: entry.matchCharacterPersonality,
      matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
      matchScenario: entry.matchScenario,
      matchCreatorNotes: entry.matchCreatorNotes,
      content: entry.content,
      enabled: entry.enabled,
      outletName: entry.outletName,
      triggers: entry.triggers,
    },
  });
  return `v2:${canonical.length}:${hashText(canonical)}`;
}

function validEffect(value: unknown): value is WorldbookTimedEffect {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as WorldbookTimedEffect).entryKey === 'string'
    && typeof (value as WorldbookTimedEffect).fingerprint === 'string'
    && Number.isSafeInteger((value as WorldbookTimedEffect).start)
    && Number.isSafeInteger((value as WorldbookTimedEffect).end)
    && (value as WorldbookTimedEffect).end >= (value as WorldbookTimedEffect).start
    && typeof (value as WorldbookTimedEffect).protected === 'boolean';
}

function duration(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function copyEffect(effect: WorldbookTimedEffect): WorldbookTimedEffect {
  return {
    entryKey: effect.entryKey,
    fingerprint: effect.fingerprint,
    start: effect.start,
    end: effect.end,
    protected: effect.protected,
  };
}

function orderedEffects(effects: Iterable<WorldbookTimedEffect>): WorldbookTimedEffect[] {
  return [...effects].sort((left, right) => left.entryKey < right.entryKey ? -1 : left.entryKey > right.entryKey ? 1 : 0);
}

export interface ProcessedTimedEffects {
  state: WorldbookTimedState;
  stickyEntryKeys: Set<string>;
  cooldownEntryKeys: Set<string>;
}

export function processWorldbookTimedEffects(input: {
  messageIndex: number;
  previous: WorldbookTimedState;
  entries: ReadonlyMap<string, PreparedWorldbookEntry>;
  warn: (warning: WorldbookWarning) => void;
}): ProcessedTimedEffects {
  const sticky = new Map<string, WorldbookTimedEffect>();
  const cooldown = new Map<string, WorldbookTimedEffect>();
  const invalidEffect = (): void => input.warn({
    code: 'timed_effect_invalid',
    message: 'A malformed Worldbook timed-state effect was ignored.',
  });
  for (const effect of input.previous.cooldown as readonly unknown[]) {
    if (validEffect(effect)) cooldown.set(effect.entryKey, copyEffect(effect));
    else invalidEffect();
  }

  for (const rawEffect of input.previous.sticky as readonly unknown[]) {
    if (!validEffect(rawEffect)) {
      invalidEffect();
      continue;
    }
    const effect = copyEffect(rawEffect);
    const prepared = input.entries.get(effect.entryKey);
    if (prepared === undefined) {
      input.warn({
        code: 'timed_entry_missing',
        message: 'A timed Worldbook entry no longer exists and its state was removed.',
        entryKey: effect.entryKey,
      });
      continue;
    }
    if (prepared.fingerprint !== effect.fingerprint) {
      input.warn({
        code: 'timed_entry_changed',
        message: 'A changed Worldbook entry invalidated its previous timed state.',
        entryKey: effect.entryKey,
        bookId: prepared.bookId,
      });
      continue;
    }
    if (duration(prepared.entry.sticky) === 0) continue;
    if (input.messageIndex <= effect.start && !effect.protected) continue;
    if (input.messageIndex >= effect.end) {
      const cooldownDuration = duration(prepared.entry.cooldown);
      if (cooldownDuration > 0) {
        cooldown.set(effect.entryKey, {
          entryKey: effect.entryKey,
          fingerprint: prepared.fingerprint,
          start: input.messageIndex,
          end: input.messageIndex + cooldownDuration,
          protected: true,
        });
      }
      continue;
    }
    sticky.set(effect.entryKey, effect);
  }

  for (const [entryKey, rawEffect] of [...cooldown]) {
    const effect = copyEffect(rawEffect);
    const prepared = input.entries.get(entryKey);
    if (prepared === undefined) {
      input.warn({
        code: 'timed_entry_missing',
        message: 'A timed Worldbook entry no longer exists and its state was removed.',
        entryKey,
      });
      cooldown.delete(entryKey);
      continue;
    }
    if (prepared.fingerprint !== effect.fingerprint) {
      input.warn({
        code: 'timed_entry_changed',
        message: 'A changed Worldbook entry invalidated its previous timed state.',
        entryKey,
        bookId: prepared.bookId,
      });
      cooldown.delete(entryKey);
      continue;
    }
    if (duration(prepared.entry.cooldown) === 0) {
      cooldown.delete(entryKey);
      continue;
    }
    if (input.messageIndex <= effect.start && !effect.protected) {
      cooldown.delete(entryKey);
      continue;
    }
    if (input.messageIndex >= effect.end) {
      cooldown.delete(entryKey);
      continue;
    }
    cooldown.set(entryKey, effect);
  }

  return {
    state: {
      messageIndex: input.messageIndex,
      sticky: orderedEffects(sticky.values()),
      cooldown: orderedEffects(cooldown.values()),
    },
    stickyEntryKeys: new Set(sticky.keys()),
    cooldownEntryKeys: new Set(cooldown.keys()),
  };
}

export function applyWorldbookTimedEffects(
  state: WorldbookTimedState,
  activated: readonly MatchedWorldbookEntry[],
  messageIndex: number,
): WorldbookTimedState {
  const sticky = new Map(state.sticky.map((effect) => [effect.entryKey, copyEffect(effect)]));
  const cooldown = new Map(state.cooldown.map((effect) => [effect.entryKey, copyEffect(effect)]));
  for (const candidate of activated) {
    const prepared = candidate.prepared;
    const stickyDuration = duration(prepared.entry.sticky);
    if (stickyDuration > 0 && !sticky.has(prepared.entryKey)) {
      sticky.set(prepared.entryKey, {
        entryKey: prepared.entryKey,
        fingerprint: prepared.fingerprint,
        start: messageIndex,
        end: messageIndex + stickyDuration,
        protected: false,
      });
    }
    const cooldownDuration = duration(prepared.entry.cooldown);
    if (cooldownDuration > 0 && !cooldown.has(prepared.entryKey)) {
      cooldown.set(prepared.entryKey, {
        entryKey: prepared.entryKey,
        fingerprint: prepared.fingerprint,
        start: messageIndex,
        end: messageIndex + cooldownDuration,
        protected: false,
      });
    }
  }
  return {
    messageIndex,
    sticky: orderedEffects(sticky.values()),
    cooldown: orderedEffects(cooldown.values()),
  };
}
