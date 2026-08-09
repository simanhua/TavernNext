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
  return hashText(JSON.stringify([
    prepared.entryKey,
    entry.content,
    entry.keys,
    entry.secondaryKeys,
    entry.constant,
    entry.group,
    entry.sticky,
    entry.cooldown,
    entry.delay,
    entry.enabled,
  ]));
}

function validEffect(value: WorldbookTimedEffect): boolean {
  return typeof value.entryKey === 'string'
    && typeof value.fingerprint === 'string'
    && Number.isSafeInteger(value.start)
    && Number.isSafeInteger(value.end)
    && value.end >= value.start
    && typeof value.protected === 'boolean';
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
  for (const effect of input.previous.cooldown) {
    if (validEffect(effect)) cooldown.set(effect.entryKey, copyEffect(effect));
  }

  for (const rawEffect of input.previous.sticky) {
    if (!validEffect(rawEffect)) continue;
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
