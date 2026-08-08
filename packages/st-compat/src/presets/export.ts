import type { ExportArtifact } from '../characters/export.js';
import {
  isPresetSourceAssociationKey,
  presetSourceAssociation,
} from './associations.js';
import {
  isDirectNovelPreset,
  record,
  textSettingAliases,
  type PresetKind,
} from './schemas.js';
import type { PresetImportPreview } from './normalize.js';

export interface PresetExportSource {
  name: string;
  kind: PresetKind;
  settings: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
  compatibility?: { rawPayload: unknown };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function safeFileStem(value: string): string {
  const cleaned = value
    .trim()
    .replace(/\s*[<>:"/\\|?*\u0000-\u001f]\s*/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '');
  return cleaned === '' ? 'preset' : cleaned.slice(0, 120);
}

type PresetExportInput = PresetExportSource | PresetImportPreview;

function sourceDocument(source: PresetExportInput): { root: Record<string, unknown>; wrapperKey?: 'preset' | 'settings' } {
  if (source.rawPayload !== undefined) return { root: structuredClone(source.rawPayload), ...(source.wrapperKey === undefined ? {} : { wrapperKey: source.wrapperKey }) };
  const raw = 'compatibility' in source ? source.compatibility?.rawPayload : undefined;
  const stored = record(raw);
  const storedRoot = record(stored?.rawDocument);
  const wrapperKey = stored?.wrapperKey === 'preset' || stored?.wrapperKey === 'settings' ? stored.wrapperKey : undefined;
  if (storedRoot !== undefined) return { root: structuredClone(storedRoot), ...(wrapperKey === undefined ? {} : { wrapperKey }) };
  return { root: {}, wrapperKey: undefined };
}

type StableIdentityKey = 'identifier' | 'character_id' | 'id';

function stableIdentityKey(kind: PresetKind, path: readonly string[], values: readonly unknown[]): StableIdentityKey | undefined {
  const pathToken = path.join('/');
  const candidate: StableIdentityKey | undefined = kind === 'chat'
    ? pathToken === 'prompts' || pathToken === 'prompt_order/order'
      ? 'identifier'
      : pathToken === 'prompt_order'
        ? 'character_id'
        : undefined
    : kind === 'text' && (pathToken === 'order' || pathToken === 'parameters/order')
      ? 'id'
      : undefined;
  if (candidate === undefined) return undefined;
  return values.some((value) => {
    const object = record(value);
    return object !== undefined && (typeof object[candidate] === 'string' || typeof object[candidate] === 'number');
  }) ? candidate : undefined;
}

function identity(value: unknown, key: StableIdentityKey): string | number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined;
}

function identityToken(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

interface OverlayContext {
  kind: PresetKind;
  rawRoot: Record<string, unknown>;
  consumedAssociations: Set<string>;
}

interface AssociatedRaw {
  raw: unknown;
  token: string;
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

function equalJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJsonValue(value, right[index]));
  }
  const leftObject = record(left);
  const rightObject = record(right);
  if (leftObject === undefined || rightObject === undefined) return false;
  const leftEntries = Object.entries(leftObject).filter(([key]) => !isPresetSourceAssociationKey(key));
  const rightEntries = Object.entries(rightObject).filter(([key]) => !isPresetSourceAssociationKey(key));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => Object.hasOwn(rightObject, key) && equalJsonValue(value, rightObject[key]));
}

function matchesKnownFields(raw: unknown, edited: unknown): boolean {
  const rawObject = record(raw);
  const editedObject = record(edited);
  if (rawObject === undefined || editedObject === undefined) return false;
  return Object.entries(editedObject)
    .filter(([key]) => !isPresetSourceAssociationKey(key))
    .every(([key, value]) => Object.hasOwn(rawObject, key) && equalJsonValue(rawObject[key], value));
}

function overlayArray(raw: unknown, edited: unknown[], context: OverlayContext, path: readonly string[]): unknown[] {
  const rawArray = Array.isArray(raw) ? raw : [];
  const identityKey = stableIdentityKey(context.kind, path, [...rawArray, ...edited]);
  if (identityKey === undefined) {
    return edited.map((value, index) => deepOverlay(rawArray[index], value, context, path));
  }

  const rawByIdentity = new Map<string, unknown[]>();
  for (const value of rawArray) {
    const valueIdentity = identity(value, identityKey);
    if (valueIdentity === undefined) continue;
    const token = identityToken(valueIdentity);
    const matches = rawByIdentity.get(token) ?? [];
    matches.push(value);
    rawByIdentity.set(token, matches);
  }

  const associatedByEdited = new Map<unknown, AssociatedRaw>();
  const identityHasAssociation = new Set<string>();
  for (const value of edited) {
    const association = presetSourceAssociation(value);
    const valueIdentity = identity(value, identityKey);
    if (association === undefined || valueIdentity === undefined) continue;
    const associatedRaw = sourceAtPath(context.rawRoot, association);
    if (!rawArray.includes(associatedRaw) || identity(associatedRaw, identityKey) !== valueIdentity) continue;
    const token = JSON.stringify(association);
    associatedByEdited.set(value, { raw: associatedRaw, token });
    identityHasAssociation.add(identityToken(valueIdentity));
  }

  const editedByIdentity = new Map<string, unknown[]>();
  for (const value of edited) {
    const valueIdentity = identity(value, identityKey);
    if (valueIdentity === undefined) continue;
    const token = identityToken(valueIdentity);
    const matches = editedByIdentity.get(token) ?? [];
    matches.push(value);
    editedByIdentity.set(token, matches);
  }

  const fallbackByEdited = new Map<unknown, unknown>();
  for (const [token, editedMatches] of editedByIdentity) {
    if (identityHasAssociation.has(token)) continue;
    const rawMatches = rawByIdentity.get(token) ?? [];
    if (rawMatches.length === 1 && editedMatches.length === 1) {
      fallbackByEdited.set(editedMatches[0], rawMatches[0]);
      continue;
    }
    if (rawMatches.length < 2 || rawMatches.length !== editedMatches.length) continue;
    const exactMatches = editedMatches.map((value) => ({
      value,
      candidates: rawMatches.filter((candidate) => matchesKnownFields(candidate, value)),
    }));
    if (exactMatches.some(({ candidates }) => candidates.length !== 1)) continue;
    const selected = exactMatches.map(({ candidates }) => candidates[0]!);
    if (new Set(selected).size !== selected.length) continue;
    exactMatches.forEach(({ value, candidates }) => fallbackByEdited.set(value, candidates[0]));
  }

  return edited.map((value) => {
    const associated = associatedByEdited.get(value);
    let rawValue: unknown;
    if (associated !== undefined && !context.consumedAssociations.has(associated.token)) {
      context.consumedAssociations.add(associated.token);
      rawValue = associated.raw;
    } else {
      rawValue = fallbackByEdited.get(value);
    }
    return deepOverlay(rawValue, value, context, path);
  });
}

function deepOverlay(raw: unknown, edited: unknown, context: OverlayContext, path: readonly string[] = []): unknown {
  if (Array.isArray(edited)) {
    return overlayArray(raw, edited, context, path);
  }
  const editedObject = record(edited);
  if (editedObject !== undefined) {
    const rawObject = record(raw);
    const result = rawObject === undefined ? {} : structuredClone(rawObject);
    for (const [key, value] of Object.entries(editedObject)) {
      if (isPresetSourceAssociationKey(key)) continue;
      result[key] = deepOverlay(rawObject?.[key], value, context, [...path, key]);
    }
    return result;
  }
  return structuredClone(edited);
}

function aliasesFor(setting: string): readonly string[] {
  return setting in textSettingAliases
    ? textSettingAliases[setting as keyof typeof textSettingAliases]
    : [setting];
}

function overlayTextSettings(
  rawBody: Record<string, unknown>,
  settings: Record<string, unknown>,
  context: OverlayContext,
): Record<string, unknown> {
  const body = structuredClone(rawBody);
  const directNovel = isDirectNovelPreset(rawBody);
  const rawTarget = directNovel ? record(rawBody.parameters)! : rawBody;
  let target = directNovel ? record(body.parameters)! : body;
  for (const [canonicalKey, value] of Object.entries(settings)) {
    if (isPresetSourceAssociationKey(canonicalKey)) continue;
    if (directNovel && canonicalKey === 'presetVersion') {
      body.presetVersion = structuredClone(value);
      continue;
    }
    if (directNovel && canonicalKey === 'parameters' && record(value) !== undefined) {
      body.parameters = deepOverlay(rawBody.parameters, value, context, ['parameters']);
      target = record(body.parameters)!;
      continue;
    }
    const aliases = aliasesFor(canonicalKey);
    const rawKey = aliases.find((key) => Object.hasOwn(rawTarget, key)) ?? aliases[0]!;
    target[rawKey] = deepOverlay(rawTarget[rawKey], value, context, [canonicalKey]);
  }
  if (directNovel) body.parameters = target;
  return body;
}

export async function exportPreset(source: PresetExportInput): Promise<ExportArtifact> {
  if (source.kind === null) throw new Error('Cannot export an invalid Preset preview');
  const document = sourceDocument(source);
  let body = document.wrapperKey === undefined
    ? document.root
    : record(document.root[document.wrapperKey]) ?? {};
  const context: OverlayContext = { kind: source.kind, rawRoot: body, consumedAssociations: new Set() };
  if (source.kind === 'text') body = overlayTextSettings(body, source.settings, context);
  else body = deepOverlay(body, source.settings, context) as Record<string, unknown>;
  body.name = source.name;
  if (document.wrapperKey !== undefined) document.root[document.wrapperKey] = body;
  else document.root = body;
  const serialized = `${JSON.stringify(stableValue(document.root), null, 2)}\n`;
  return {
    bytes: new TextEncoder().encode(serialized),
    contentType: 'application/json; charset=utf-8',
    fileName: `${safeFileStem(source.name)}.json`,
    auxiliaryAssets: [],
  };
}
