import type { ExportArtifact } from '../characters/export.js';
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

function stableIdentityKey(propertyKey: string | undefined, values: readonly unknown[]): StableIdentityKey | undefined {
  const candidates: readonly StableIdentityKey[] = propertyKey === 'prompts'
    ? ['identifier']
    : propertyKey === 'prompt_order'
      ? ['character_id']
      : propertyKey === 'order'
        ? ['identifier', 'id']
        : [];
  return candidates.find((candidate) => values.some((value) => {
    const object = record(value);
    return object !== undefined && (typeof object[candidate] === 'string' || typeof object[candidate] === 'number');
  }));
}

function identity(value: unknown, key: StableIdentityKey): string | number | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === 'string' || typeof candidate === 'number' ? candidate : undefined;
}

function identityToken(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function overlayArray(raw: unknown, edited: unknown[], propertyKey: string | undefined): unknown[] {
  const rawArray = Array.isArray(raw) ? raw : [];
  const identityKey = stableIdentityKey(propertyKey, [...rawArray, ...edited]);
  if (identityKey === undefined) {
    return edited.map((value, index) => deepOverlay(rawArray[index], value));
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
  return edited.map((value) => {
    const valueIdentity = identity(value, identityKey);
    const rawValue = valueIdentity === undefined
      ? undefined
      : rawByIdentity.get(identityToken(valueIdentity))?.shift();
    return deepOverlay(rawValue, value);
  });
}

function deepOverlay(raw: unknown, edited: unknown, propertyKey?: string): unknown {
  if (Array.isArray(edited)) {
    return overlayArray(raw, edited, propertyKey);
  }
  const editedObject = record(edited);
  if (editedObject !== undefined) {
    const result = record(raw) === undefined ? {} : structuredClone(record(raw)!);
    for (const [key, value] of Object.entries(editedObject)) {
      result[key] = deepOverlay(result[key], value, key);
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

function overlayTextSettings(body: Record<string, unknown>, settings: Record<string, unknown>): void {
  const directNovel = isDirectNovelPreset(body);
  const target = directNovel ? record(body.parameters)! : body;
  for (const [canonicalKey, value] of Object.entries(settings)) {
    if (directNovel && canonicalKey === 'presetVersion') {
      body.presetVersion = structuredClone(value);
      continue;
    }
    if (directNovel && canonicalKey === 'parameters' && record(value) !== undefined) {
      body.parameters = deepOverlay(body.parameters, value);
      continue;
    }
    const aliases = aliasesFor(canonicalKey);
    const rawKey = aliases.find((key) => Object.hasOwn(target, key)) ?? aliases[0]!;
    target[rawKey] = deepOverlay(target[rawKey], value, rawKey);
  }
  if (directNovel) body.parameters = target;
}

export async function exportPreset(source: PresetExportInput): Promise<ExportArtifact> {
  if (source.kind === null) throw new Error('Cannot export an invalid Preset preview');
  const document = sourceDocument(source);
  let body = document.wrapperKey === undefined
    ? document.root
    : record(document.root[document.wrapperKey]) ?? {};
  if (source.kind === 'text') overlayTextSettings(body, source.settings);
  else body = deepOverlay(body, source.settings) as Record<string, unknown>;
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
