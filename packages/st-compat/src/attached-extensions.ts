import type { ExtensionAsset } from '@tavernnext/domain';

export interface ExtractedAttachedExtensionAsset {
  kind: 'regex' | 'tavern_helper';
  sourceKey: string;
  ordinal: number;
  enabled: boolean;
  payload: unknown;
  diagnostics: string[];
}

export interface AttachedExtensionResourceView {
  type: 'regex' | 'script' | 'folder' | 'unknown';
  order: number[];
  sourceKey: string;
  name: string;
  enabled: boolean;
  diagnostics: string[];
}

export interface AttachedExtensionOverview {
  execution: 'not_executed';
  counts: { regex: number; scripts: number; folders: number; variableContainers: number };
  resources: AttachedExtensionResourceView[];
  variables: Array<{ source: string; keyCount: number; diagnostics: string[] }>;
  diagnostics: string[];
}

export interface NormalizedAttachedExtensions {
  extensions: Record<string, unknown>;
  assets: ExtractedAttachedExtensionAsset[];
  overview: AttachedExtensionOverview;
}

export interface SPresetSummary {
  present: boolean;
  features: { ChatSquash: boolean; RegexBinding: boolean; MacroNest: boolean; ToolBindings: boolean };
}

type AssetSource = Pick<ExtensionAsset, 'kind' | 'sourceKey' | 'ordinal' | 'enabled' | 'payload' | 'diagnostics'>
  | ExtractedAttachedExtensionAsset;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function entriesRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || !value.every((item) => (
    Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'
  ))) return undefined;
  return Object.fromEntries((value as Array<[string, unknown]>).map(([key, entry]) => [key, structuredClone(entry)]));
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function regexDiagnostics(payload: unknown): string[] {
  const value = record(payload);
  if (value === undefined) return ['regex_not_object'];
  const diagnostics: string[] = [];
  if (typeof value.findRegex !== 'string') diagnostics.push('regex_find_missing');
  if (typeof value.replaceString !== 'string') diagnostics.push('regex_replace_missing');
  return diagnostics;
}

function scriptDiagnostics(payload: unknown): string[] {
  const value = record(payload);
  if (value === undefined) return ['script_node_not_object'];
  if (value.type !== 'script' && value.type !== 'folder') return ['script_node_type_invalid'];
  if (value.type === 'script' && typeof value.content !== 'string') return ['script_content_missing'];
  return [];
}

function sourceKey(payload: unknown, fallback: string): string {
  const value = record(payload);
  return text(value?.id, text(value?.name, fallback));
}

function scriptChildren(value: Record<string, unknown>): unknown[] {
  for (const key of ['children', 'scripts', 'value']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function flattenScript(
  payload: unknown,
  order: number[],
  inheritedSourceKey: string,
  inheritedDiagnostics: readonly string[],
): AttachedExtensionResourceView[] {
  const value = record(payload);
  const diagnostics = [...new Set([...inheritedDiagnostics, ...scriptDiagnostics(payload)])];
  if (value === undefined) {
    return [{
      type: 'unknown', order, sourceKey: inheritedSourceKey,
      name: inheritedSourceKey, enabled: false, diagnostics,
    }];
  }
  const type = value.type === 'script' || value.type === 'folder' ? value.type : 'unknown';
  const key = sourceKey(value, inheritedSourceKey);
  const current: AttachedExtensionResourceView = {
    type,
    order,
    sourceKey: key,
    name: text(value.name, key),
    enabled: value.enabled !== false,
    diagnostics,
  };
  if (type !== 'folder') return [current];
  return [
    current,
    ...scriptChildren(value).flatMap((child, ordinal) => flattenScript(child, [...order, ordinal], key, [])),
  ];
}

function variableViews(extensions: Record<string, unknown>): AttachedExtensionOverview['variables'] {
  const helper = record(extensions.tavern_helper);
  const candidates = [
    ['tavern_helper.variables', helper?.variables] as const,
    ['variables', extensions.variables] as const,
  ];
  return candidates.flatMap(([source, payload]) => {
    if (payload === undefined) return [];
    const value = record(payload);
    return [{
      source,
      keyCount: value === undefined ? 0 : Object.keys(value).length,
      diagnostics: value === undefined ? ['variables_not_object'] : [],
    }];
  });
}

export function attachedExtensionOverview(
  assets: readonly AssetSource[],
  extensions: Record<string, unknown>,
): AttachedExtensionOverview {
  const ordered = [...assets].sort((left, right) => (
    (left.kind === right.kind ? 0 : left.kind === 'regex' ? -1 : 1)
    || left.ordinal - right.ordinal
    || compareText(left.sourceKey, right.sourceKey)
  ));
  const resources = ordered.flatMap((asset): AttachedExtensionResourceView[] => {
    if (asset.kind === 'regex') {
      const value = record(asset.payload);
      return [{
        type: 'regex', order: [asset.ordinal], sourceKey: asset.sourceKey,
        name: text(value?.scriptName, asset.sourceKey), enabled: asset.enabled,
        diagnostics: [...asset.diagnostics],
      }];
    }
    return flattenScript(asset.payload, [asset.ordinal], asset.sourceKey, asset.diagnostics);
  });
  const variables = variableViews(extensions);
  const diagnostics = [...new Set([
    ...resources.flatMap((resource) => resource.diagnostics),
    ...variables.flatMap((variable) => variable.diagnostics),
  ])];
  return {
    execution: 'not_executed',
    counts: {
      regex: resources.filter((resource) => resource.type === 'regex').length,
      scripts: resources.filter((resource) => resource.type === 'script').length,
      folders: resources.filter((resource) => resource.type === 'folder').length,
      variableContainers: variables.length,
    },
    resources,
    variables,
    diagnostics,
  };
}

export function normalizeAttachedExtensions(extensions: unknown): NormalizedAttachedExtensions {
  const normalized = structuredClone(record(extensions) ?? {});
  const rootDiagnostics: string[] = [];
  const helperEntries = entriesRecord(normalized.tavern_helper);
  if (helperEntries !== undefined) normalized.tavern_helper = helperEntries;
  else if (normalized.tavern_helper !== undefined && record(normalized.tavern_helper) === undefined) {
    rootDiagnostics.push('tavern_helper_not_object');
  }

  const regexPayloads = Array.isArray(normalized.regex_scripts) ? normalized.regex_scripts : [];
  if (normalized.regex_scripts !== undefined && !Array.isArray(normalized.regex_scripts)) {
    rootDiagnostics.push('regex_scripts_not_array');
  }
  const helper = record(normalized.tavern_helper);
  const scriptPayloads = Array.isArray(helper?.scripts) ? helper.scripts : [];
  if (helper?.scripts !== undefined && !Array.isArray(helper.scripts)) rootDiagnostics.push('tavern_helper_scripts_not_array');

  const assets: ExtractedAttachedExtensionAsset[] = [
    ...regexPayloads.map((payload, ordinal) => ({
      kind: 'regex' as const,
      sourceKey: sourceKey(payload, `regex:${ordinal}`),
      ordinal,
      enabled: record(payload)?.disabled !== true,
      payload: structuredClone(payload),
      diagnostics: regexDiagnostics(payload),
    })),
    ...scriptPayloads.map((payload, ordinal) => ({
      kind: 'tavern_helper' as const,
      sourceKey: sourceKey(payload, `script:${ordinal}`),
      ordinal,
      enabled: record(payload)?.enabled !== false,
      payload: structuredClone(payload),
      diagnostics: scriptDiagnostics(payload),
    })),
  ];
  const overview = attachedExtensionOverview(assets, normalized);
  return {
    extensions: normalized,
    assets,
    overview: { ...overview, diagnostics: [...new Set([...rootDiagnostics, ...overview.diagnostics])] },
  };
}

function featureEnabled(value: unknown): boolean {
  if (value === true) return true;
  const object = record(value);
  if (object === undefined) return false;
  if (typeof object.enabled === 'boolean') return object.enabled;
  return Object.keys(object).length > 0;
}

export function summarizeSPreset(extensions: unknown): SPresetSummary {
  const object = record(extensions) ?? {};
  const value = record(object.SPreset ?? object.spreset);
  return {
    present: value !== undefined,
    features: {
      ChatSquash: featureEnabled(value?.ChatSquash),
      RegexBinding: featureEnabled(value?.RegexBinding),
      MacroNest: featureEnabled(value?.MacroNest),
      ToolBindings: featureEnabled(value?.ToolBindings),
    },
  };
}

export function overlayAttachedExtensionAssets(
  extensions: unknown,
  assets: readonly AssetSource[],
  options: { replaceKinds?: boolean } = {},
): Record<string, unknown> {
  const normalized = normalizeAttachedExtensions(extensions).extensions;
  const regex = assets.filter((asset) => asset.kind === 'regex').sort((a, b) => a.ordinal - b.ordinal);
  const scripts = assets.filter((asset) => asset.kind === 'tavern_helper').sort((a, b) => a.ordinal - b.ordinal);
  if (regex.length > 0 || (options.replaceKinds === true && Object.hasOwn(normalized, 'regex_scripts'))) {
    normalized.regex_scripts = regex.map((asset) => structuredClone(asset.payload));
  }
  if (scripts.length > 0 || (options.replaceKinds === true && Object.hasOwn(normalized, 'tavern_helper'))) {
    normalized.tavern_helper = {
      ...(record(normalized.tavern_helper) ?? {}),
      scripts: scripts.map((asset) => structuredClone(asset.payload)),
    };
  }
  return normalized;
}
