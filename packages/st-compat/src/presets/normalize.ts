import type { ImportDiagnostic } from '../warnings.js';
import { diagnostic } from '../warnings.js';
import { detectPresetKinds } from './detect.js';
import {
  executablePresetFields,
  parsePresetDocument,
  type PresetKind,
  record,
  validatePresetFamily,
} from './schemas.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const noUnknown = Symbol('no-preset-unknown-field');

function isProviderSetting(key: string): boolean {
  return /^(?:ai21|chutes|claude|custom|electronhub|google|minimax|mistralai|openai|openrouter|vertexai)_/i.test(key)
    || /(?:^|_)(?:provider|vendor)(?:_|$)/i.test(key)
    || [
      'reverse_proxy', 'proxy_password', 'chat_completion_source', 'stream_openai',
      'use_cache', 'return_full_text', 'phrase_rep_pen', 'preamble', 'extensions',
    ].includes(key);
}

function containsProviderSetting(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProviderSetting);
  const object = record(value);
  if (object === undefined) return false;
  return Object.entries(object).some(([key, nested]) => isProviderSetting(key) || containsProviderSetting(nested));
}

function withoutProviderSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProviderSettings);
  const object = record(value);
  if (object === undefined) return structuredClone(value);
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !isProviderSetting(key))
      .map(([key, nested]) => [key, withoutProviderSettings(nested)]),
  );
}

function fallbackName(fileName: string): string {
  const name = fileName.replace(/[\\/]/g, '/').split('/').at(-1) ?? 'preset';
  const stem = name.replace(/\.[^.]*$/, '').trim();
  return stem === '' ? 'Imported Preset' : stem;
}

function stableWarnings(candidates: readonly PresetKind[], unknownFields: Record<string, unknown>): ImportDiagnostic[] {
  const warnings: ImportDiagnostic[] = [];
  if (candidates.length > 1) {
    warnings.push(diagnostic('ambiguous_preset', `The document matches multiple preset families: ${candidates.join(', ')}.`));
  }
  const parameterUnknowns = record(unknownFields.parameters);
  if (containsProviderSetting(unknownFields) || (parameterUnknowns !== undefined && Object.keys(parameterUnknowns).length > 0)) {
    warnings.push(diagnostic(
      'provider_field_preserved_not_executable',
      'Provider-specific settings are preserved for export but will not be executed by TavernNext.',
    ));
  }
  return warnings;
}

function placeholderFor(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (record(value) !== undefined) return {};
  return null;
}

function unknownDifference(raw: unknown, known: unknown): unknown | typeof noUnknown {
  if (Array.isArray(raw) && Array.isArray(known)) {
    let found = false;
    const values = raw.map((value, index) => {
      if (index >= known.length) {
        found = true;
        return structuredClone(value);
      }
      const nested = unknownDifference(value, known[index]);
      if (nested === noUnknown) return placeholderFor(value);
      found = true;
      return nested;
    });
    return found ? values : noUnknown;
  }
  const rawObject = record(raw);
  const knownObject = record(known);
  if (rawObject !== undefined && knownObject !== undefined) {
    const difference: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawObject)) {
      if (!Object.hasOwn(knownObject, key)) {
        difference[key] = structuredClone(value);
        continue;
      }
      const nested = unknownDifference(value, knownObject[key]);
      if (nested !== noUnknown) difference[key] = nested;
    }
    return Object.keys(difference).length === 0 ? noUnknown : difference;
  }
  return noUnknown;
}

function compatibilityFields(
  raw: Record<string, unknown>,
  knownRawFields: Record<string, unknown>,
): Record<string, unknown> {
  const knownWithName = structuredClone(knownRawFields);
  if (typeof raw.name === 'string') knownWithName.name = raw.name;
  const difference = unknownDifference(raw, knownWithName);
  return difference === noUnknown ? {} : difference as Record<string, unknown>;
}

export interface PresetImportPreview {
  name: string;
  kind: PresetKind | null;
  candidates: PresetKind[];
  settings: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
  warnings: ImportDiagnostic[];
  blockingErrors: ImportDiagnostic[];
}

export class PresetCodecError extends Error {
  constructor(readonly issue: ImportDiagnostic) {
    super(issue.message);
  }
}

function invalid(code: string, message: string): never {
  throw new PresetCodecError(diagnostic(code, message));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return invalid('preset_json_invalid', 'Preset documents must contain valid UTF-8 JSON.');
  }
}

/** Reparse exact staged source bytes; filenames are used only for a nameless-preset display fallback. */
export function decodeInspectedPreset(bytes: Uint8Array, fileName: string): Omit<PresetImportPreview, 'warnings' | 'blockingErrors'> {
  let parsed;
  try {
    parsed = parsePresetDocument(parseJson(bytes));
  } catch (error) {
    if (error instanceof PresetCodecError) throw error;
    const code = error instanceof Error ? error.message : '';
    if (code === 'preset_root_invalid') invalid(code, 'Preset root must be an object.');
    if (code === 'preset_wrapper_invalid') invalid(code, 'Preset wrapper must contain an object.');
    invalid('preset_decode_failed', 'Preset document could not be decoded safely.');
  }
  const candidates = detectPresetKinds(parsed.document);
  if (candidates.length === 0) invalid('preset_unrecognized', 'Document does not contain a recognized preset shape.');
  const kind = candidates[0]!;
  let validated: Record<string, unknown>;
  try {
    validated = validatePresetFamily(kind, parsed.document);
  } catch {
    invalid('preset_fields_invalid', 'Preset contains malformed fields for its detected family.');
  }
  const executable = executablePresetFields(kind, validated);
  const settings = withoutProviderSettings(executable.settings) as Record<string, unknown>;
  const knownRawFields = withoutProviderSettings(executable.knownRawFields) as Record<string, unknown>;
  const unknownFields = compatibilityFields(parsed.document, knownRawFields);
  if (parsed.wrapperKey !== undefined) {
    for (const [key, value] of Object.entries(parsed.root)) {
      if (key === parsed.wrapperKey || key === 'name') continue;
      unknownFields[key] = structuredClone(value);
    }
  }
  const name = typeof parsed.document.name === 'string' && parsed.document.name.trim() !== ''
    ? parsed.document.name
    : typeof parsed.root.name === 'string' && parsed.root.name.trim() !== ''
      ? parsed.root.name
      : fallbackName(fileName);
  return {
    name,
    kind,
    candidates,
    settings,
    unknownFields,
    rawPayload: structuredClone(parsed.root),
    ...(parsed.wrapperKey === undefined ? {} : { wrapperKey: parsed.wrapperKey }),
  };
}

function emptyPresetPreview(): PresetImportPreview {
  return {
    name: '', kind: null, candidates: [], settings: {}, unknownFields: {}, rawPayload: {}, warnings: [], blockingErrors: [],
  };
}

export async function inspectPreset(bytes: Uint8Array, fileName: string): Promise<PresetImportPreview> {
  try {
    const decoded = decodeInspectedPreset(bytes, fileName);
    return {
      ...decoded,
      warnings: stableWarnings(decoded.candidates, decoded.unknownFields),
      blockingErrors: [],
    };
  } catch (error) {
    const preview = emptyPresetPreview();
    return {
      ...preview,
      blockingErrors: [error instanceof PresetCodecError
        ? error.issue
        : diagnostic('preset_decode_failed', 'Preset document could not be decoded safely.')],
    };
  }
}

export function presetWarnings(decoded: Omit<PresetImportPreview, 'warnings' | 'blockingErrors'>): ImportDiagnostic[] {
  return stableWarnings(decoded.candidates, decoded.unknownFields);
}

export function presetRawDocument(value: unknown): Record<string, unknown> | undefined {
  return record(value);
}
