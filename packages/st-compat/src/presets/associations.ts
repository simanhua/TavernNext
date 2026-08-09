import { createHash, randomUUID } from 'node:crypto';
import { isDirectNovelPreset, record, type PresetKind } from './schemas.js';

const presetSourceAssociationKey = '__tavernnextPresetSource';
const presetSourceAssociationMarkerType = 'tavernnext:preset-source-association';
const presetSourceAssociationEnvelopeType = 'tavernnext:preset-source-associations';
const presetSourceAssociationVersion = 1 as const;

type SourcePath = Array<string | number>;
type StableIdentityKey = 'identifier' | 'character_id' | 'id';
type PresetSourceLocation =
  | 'chat.prompts'
  | 'chat.prompt_order'
  | 'chat.prompt_order.order'
  | 'text.order';

interface PresetSourceAssociationMarker {
  type: typeof presetSourceAssociationMarkerType;
  version: typeof presetSourceAssociationVersion;
  token: string;
}

export interface PresetSourceAssociationEntry {
  token: string;
  location: PresetSourceLocation;
  path: SourcePath;
  sourceDigest: string;
}

export interface PresetSourceAssociationEnvelope {
  type: typeof presetSourceAssociationEnvelopeType;
  version: typeof presetSourceAssociationVersion;
  kind: PresetKind;
  entries: PresetSourceAssociationEntry[];
}

export interface PresetSourceAssociationInput {
  kind: PresetKind | null;
  settings: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
}

export interface PersistedPresetSourceAssociations {
  settings: Record<string, unknown>;
  associationEnvelope: PresetSourceAssociationEnvelope;
}

export interface PresetCompatibilitySource {
  rawPayload: unknown;
}

export interface ValidatedPresetSourceAssociation {
  token: string;
  path: readonly (string | number)[];
  raw: Record<string, unknown>;
}

export interface ValidatedPresetSourceAssociations {
  envelopePresent: boolean;
  byEntry: ReadonlyMap<Record<string, unknown>, ValidatedPresetSourceAssociation>;
}

interface LocatedEntry {
  value: Record<string, unknown>;
  location: PresetSourceLocation;
  identityKey: StableIdentityKey;
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const presetKinds = new Set<PresetKind>(['chat', 'text', 'context', 'instruct', 'system', 'reasoning']);
const sourceLocations = new Set<PresetSourceLocation>([
  'chat.prompts',
  'chat.prompt_order',
  'chat.prompt_order.order',
  'text.order',
]);

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function identity(value: unknown, key: StableIdentityKey): string | number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined;
}

function sameIdentity(left: unknown, right: unknown, key: StableIdentityKey): boolean {
  const leftIdentity = identity(left, key);
  const rightIdentity = identity(right, key);
  return leftIdentity !== undefined
    && rightIdentity !== undefined
    && typeof leftIdentity === typeof rightIdentity
    && leftIdentity === rightIdentity;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  const object = record(value);
  if (object === undefined) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, stableJsonValue(nested)]),
  );
}

function sourceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableJsonValue(value))).digest('hex');
}

function marker(token: string): PresetSourceAssociationMarker {
  return { type: presetSourceAssociationMarkerType, version: presetSourceAssociationVersion, token };
}

function parseMarker(value: unknown): PresetSourceAssociationMarker | undefined {
  const candidate = record(value);
  if (candidate === undefined || !exactKeys(candidate, ['type', 'version', 'token'])) return undefined;
  if (candidate.type !== presetSourceAssociationMarkerType
    || candidate.version !== presetSourceAssociationVersion
    || typeof candidate.token !== 'string'
    || !uuidV4.test(candidate.token)) return undefined;
  return candidate as unknown as PresetSourceAssociationMarker;
}

function pathMatchesLocation(location: PresetSourceLocation, path: readonly (string | number)[]): boolean {
  const index = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
  switch (location) {
    case 'chat.prompts':
      return path.length === 2 && path[0] === 'prompts' && index(path[1]);
    case 'chat.prompt_order':
      return path.length === 2 && path[0] === 'prompt_order' && index(path[1]);
    case 'chat.prompt_order.order':
      return path.length === 4
        && path[0] === 'prompt_order' && index(path[1])
        && path[2] === 'order' && index(path[3]);
    case 'text.order':
      return (path.length === 2 && path[0] === 'order' && index(path[1]))
        || (path.length === 3 && path[0] === 'parameters' && path[1] === 'order' && index(path[2]));
  }
}

function locationMatchesKind(location: PresetSourceLocation, kind: PresetKind): boolean {
  return (kind === 'chat' && location.startsWith('chat.'))
    || (kind === 'text' && location === 'text.order');
}

function identityKeyForLocation(location: PresetSourceLocation): StableIdentityKey {
  if (location === 'chat.prompt_order') return 'character_id';
  if (location === 'text.order') return 'id';
  return 'identifier';
}

function parseEnvelope(value: unknown): PresetSourceAssociationEnvelope | undefined {
  const candidate = record(value);
  if (candidate === undefined || !exactKeys(candidate, ['type', 'version', 'kind', 'entries'])) return undefined;
  if (candidate.type !== presetSourceAssociationEnvelopeType
    || candidate.version !== presetSourceAssociationVersion
    || typeof candidate.kind !== 'string'
    || !presetKinds.has(candidate.kind as PresetKind)
    || !Array.isArray(candidate.entries)) return undefined;

  const entries: PresetSourceAssociationEntry[] = [];
  const tokens = new Set<string>();
  const paths = new Set<string>();
  for (const valueEntry of candidate.entries) {
    const entry = record(valueEntry);
    if (entry === undefined || !exactKeys(entry, ['token', 'location', 'path', 'sourceDigest'])) return undefined;
    if (typeof entry.token !== 'string' || !uuidV4.test(entry.token)) return undefined;
    if (typeof entry.location !== 'string' || !sourceLocations.has(entry.location as PresetSourceLocation)) return undefined;
    if (!locationMatchesKind(entry.location as PresetSourceLocation, candidate.kind as PresetKind)) return undefined;
    if (!Array.isArray(entry.path)
      || entry.path.some((part) => typeof part !== 'string' && !Number.isInteger(part))
      || !pathMatchesLocation(entry.location as PresetSourceLocation, entry.path as SourcePath)) return undefined;
    if (typeof entry.sourceDigest !== 'string' || !sha256.test(entry.sourceDigest)) return undefined;
    const pathToken = JSON.stringify(entry.path);
    if (tokens.has(entry.token) || paths.has(pathToken)) return undefined;
    tokens.add(entry.token);
    paths.add(pathToken);
    entries.push({
      token: entry.token,
      location: entry.location as PresetSourceLocation,
      path: [...entry.path] as SourcePath,
      sourceDigest: entry.sourceDigest,
    });
  }
  return {
    type: presetSourceAssociationEnvelopeType,
    version: presetSourceAssociationVersion,
    kind: candidate.kind as PresetKind,
    entries,
  };
}

function sourceAtPath(root: Record<string, unknown>, path: readonly (string | number)[]): unknown {
  let value: unknown = root;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(value) || part < 0 || part >= value.length) return undefined;
      value = value[part];
      continue;
    }
    const object = record(value);
    if (object === undefined || !Object.hasOwn(object, part)) return undefined;
    value = object[part];
  }
  return value;
}

function locatedEntries(kind: PresetKind, settings: Record<string, unknown>): LocatedEntry[] {
  const result: LocatedEntry[] = [];
  const add = (value: unknown, location: PresetSourceLocation, identityKey: StableIdentityKey) => {
    const object = record(value);
    if (object !== undefined) result.push({ value: object, location, identityKey });
  };

  if (kind === 'chat') {
    array(settings.prompts).forEach((value) => add(value, 'chat.prompts', 'identifier'));
    array(settings.prompt_order).forEach((value) => {
      add(value, 'chat.prompt_order', 'character_id');
      const group = record(value);
      if (group !== undefined) {
        array(group.order).forEach((entry) => add(entry, 'chat.prompt_order.order', 'identifier'));
      }
    });
  }
  if (kind === 'text') {
    array(settings.order).forEach((value) => add(value, 'text.order', 'id'));
  }
  return result;
}

function storedSource(compatibility: PresetCompatibilitySource | undefined): {
  rawRoot: Record<string, unknown>;
  associationEnvelopePresent: boolean;
  associationEnvelope: unknown;
} | undefined {
  const stored = record(compatibility?.rawPayload);
  const root = record(stored?.rawDocument);
  if (stored === undefined || root === undefined) return undefined;
  const wrapperKey = stored.wrapperKey === 'preset' || stored.wrapperKey === 'settings' ? stored.wrapperKey : undefined;
  const rawRoot = wrapperKey === undefined ? root : record(root[wrapperKey]) ?? {};
  return {
    rawRoot,
    associationEnvelopePresent: Object.hasOwn(stored, 'associationEnvelope'),
    associationEnvelope: stored.associationEnvelope,
  };
}

function associateAtIndex(
  settings: unknown[],
  raw: unknown[],
  path: readonly (string | number)[],
  location: PresetSourceLocation,
  identityKey: StableIdentityKey,
  entries: PresetSourceAssociationEntry[],
): void {
  settings.forEach((value, index) => {
    const object = record(value);
    const rawValue = raw[index];
    if (object === undefined || !sameIdentity(value, rawValue, identityKey)) return;
    if (Object.hasOwn(object, presetSourceAssociationKey)) return;
    const token = randomUUID();
    const sourcePath = [...path, index] satisfies SourcePath;
    object[presetSourceAssociationKey] = marker(token);
    entries.push({ token, location, path: sourcePath, sourceDigest: sourceDigest(rawValue) });
  });
}

/**
 * Adds JSON-stable, per-entry markers and returns their versioned compatibility
 * sidecar. A marker is intentionally meaningless without this envelope.
 */
export function persistPresetSourceAssociations(source: PresetSourceAssociationInput): PersistedPresetSourceAssociations {
  if (source.kind === null) throw new Error('Preset source associations require a recognized preset kind');
  const settings = structuredClone(source.settings);
  const entries: PresetSourceAssociationEntry[] = [];
  const rawBody = source.wrapperKey === undefined
    ? source.rawPayload
    : record(source.rawPayload[source.wrapperKey]) ?? {};

  if (source.kind === 'chat') {
    const settingsPrompts = array(settings.prompts);
    associateAtIndex(settingsPrompts, array(rawBody.prompts), ['prompts'], 'chat.prompts', 'identifier', entries);

    const settingsGroups = array(settings.prompt_order);
    const rawGroups = array(rawBody.prompt_order);
    associateAtIndex(settingsGroups, rawGroups, ['prompt_order'], 'chat.prompt_order', 'character_id', entries);
    settingsGroups.forEach((value, groupIndex) => {
      const settingsGroup = record(value);
      const rawGroup = record(rawGroups[groupIndex]);
      if (settingsGroup === undefined || rawGroup === undefined) return;
      associateAtIndex(
        array(settingsGroup.order),
        array(rawGroup.order),
        ['prompt_order', groupIndex, 'order'],
        'chat.prompt_order.order',
        'identifier',
        entries,
      );
    });
  }

  if (source.kind === 'text') {
    const directNovel = isDirectNovelPreset(rawBody);
    const rawSettings = directNovel ? record(rawBody.parameters) ?? {} : rawBody;
    associateAtIndex(
      array(settings.order),
      array(rawSettings.order),
      directNovel ? ['parameters', 'order'] : ['order'],
      'text.order',
      'id',
      entries,
    );
  }

  return {
    settings,
    associationEnvelope: {
      type: presetSourceAssociationEnvelopeType,
      version: presetSourceAssociationVersion,
      kind: source.kind,
      entries,
    },
  };
}

export function isPresetSourceAssociationKey(key: string): boolean {
  return key === presetSourceAssociationKey;
}

/**
 * Validates the entire marker set before any association may be consumed.
 * Repeated tokens invalidate every contender. One unique token may move with a
 * same-identity entry (including across reorder/edit operations), but it cannot
 * change schema location, identity, raw path binding, or Preset kind.
 */
export function validatePresetSourceAssociations(input: {
  kind: PresetKind;
  settings: Record<string, unknown>;
  rawRoot: Record<string, unknown>;
  associationEnvelopePresent: boolean;
  associationEnvelope: unknown;
}): ValidatedPresetSourceAssociations {
  const byEntry = new Map<Record<string, unknown>, ValidatedPresetSourceAssociation>();
  if (!input.associationEnvelopePresent) return { envelopePresent: false, byEntry };
  const envelope = parseEnvelope(input.associationEnvelope);
  if (envelope === undefined || envelope.kind !== input.kind) return { envelopePresent: true, byEntry };

  const sidecarByToken = new Map(envelope.entries.map((entry) => [entry.token, entry]));
  const occurrences = new Map<string, LocatedEntry[]>();
  for (const located of locatedEntries(input.kind, input.settings)) {
    const valueMarker = parseMarker(located.value[presetSourceAssociationKey]);
    if (valueMarker === undefined || !sidecarByToken.has(valueMarker.token)) continue;
    const matches = occurrences.get(valueMarker.token) ?? [];
    matches.push(located);
    occurrences.set(valueMarker.token, matches);
  }

  for (const [token, matches] of occurrences) {
    if (matches.length !== 1) continue;
    const located = matches[0]!;
    const sidecar = sidecarByToken.get(token)!;
    if (sidecar.location !== located.location || located.identityKey !== identityKeyForLocation(sidecar.location)) continue;
    const raw = record(sourceAtPath(input.rawRoot, sidecar.path));
    if (raw === undefined
      || sourceDigest(raw) !== sidecar.sourceDigest
      || !sameIdentity(located.value, raw, located.identityKey)) continue;
    byEntry.set(located.value, { token, path: sidecar.path, raw });
  }
  return { envelopePresent: true, byEntry };
}

/** Produces a legacy/provider copy when no compatibility association data exists. */
export function presetSettingsForExecution(settings: Record<string, unknown>): Record<string, unknown>;
/** Produces the provider/generation copy while removing only markers validated for the supplied Preset kind. */
export function presetSettingsForExecution(
  settings: Record<string, unknown>,
  compatibility: PresetCompatibilitySource,
  kind: PresetKind,
): Record<string, unknown>;
export function presetSettingsForExecution(
  settings: Record<string, unknown>,
  compatibility?: PresetCompatibilitySource,
  kind?: PresetKind,
): Record<string, unknown> {
  const stored = storedSource(compatibility);
  const envelope = stored === undefined ? undefined : parseEnvelope(stored.associationEnvelope);
  const validation = stored === undefined || envelope === undefined || kind === undefined
    ? { envelopePresent: stored?.associationEnvelopePresent ?? false, byEntry: new Map<Record<string, unknown>, ValidatedPresetSourceAssociation>() }
    : validatePresetSourceAssociations({
      kind,
      settings,
      rawRoot: stored.rawRoot,
      associationEnvelopePresent: stored.associationEnvelopePresent,
      associationEnvelope: stored.associationEnvelope,
    });

  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    const object = record(value);
    if (object === undefined) return structuredClone(value);
    const validated = validation.byEntry.has(object);
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => key !== presetSourceAssociationKey || !validated)
        .map(([key, nested]) => [key, clean(nested)]),
    );
  };
  return clean(settings) as Record<string, unknown>;
}
