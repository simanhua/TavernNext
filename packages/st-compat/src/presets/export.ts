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

function deepOverlay(raw: unknown, edited: unknown): unknown {
  if (Array.isArray(edited)) {
    const rawArray = Array.isArray(raw) ? raw : [];
    return edited.map((value, index) => deepOverlay(rawArray[index], value));
  }
  const editedObject = record(edited);
  if (editedObject !== undefined) {
    const result = record(raw) === undefined ? {} : structuredClone(record(raw)!);
    for (const [key, value] of Object.entries(editedObject)) {
      result[key] = deepOverlay(result[key], value);
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
    target[rawKey] = deepOverlay(target[rawKey], value);
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
