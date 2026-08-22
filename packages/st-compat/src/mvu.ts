import { parse as parseYaml } from 'yaml';

export interface MvuInitEntry {
  id: string;
  content: string;
}

interface JsonPatchOperation {
  op: 'add' | 'insert' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeValue);
  const object = record(value);
  return object === undefined || Object.entries(object).every(([key, nested]) => (
    !dangerousKeys.has(key) && safeValue(nested)
  ));
}

function merge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    if (dangerousKeys.has(key)) continue;
    const leftNested = record(result[key]);
    const rightNested = record(value);
    result[key] = leftNested !== undefined && rightNested !== undefined
      ? merge(leftNested, rightNested)
      : structuredClone(value);
  }
  return result;
}

function pointer(path: string): string[] | undefined {
  if (path === '') return [];
  if (!path.startsWith('/')) return undefined;
  const parts = path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  return parts.some((part) => dangerousKeys.has(part)) ? undefined : parts;
}

function applyOperation(root: Record<string, unknown>, operation: JsonPatchOperation): void {
  const parts = pointer(operation.path);
  if (parts === undefined || parts.length === 0) return;
  let parent: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) return;
      parent = parent[index];
      continue;
    }
    const object = record(parent);
    if (object === undefined) return;
    if (record(object[part]) === undefined && !Array.isArray(object[part])) object[part] = {};
    parent = object[part];
  }
  const key = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (operation.op === 'remove') {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < parent.length) parent.splice(index, 1);
      return;
    }
    if (key === '-') parent.push(structuredClone(operation.value));
    else {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) return;
      if (operation.op === 'insert' || operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else if (index < parent.length) parent[index] = structuredClone(operation.value);
    }
    return;
  }
  const object = record(parent);
  if (object === undefined) return;
  if (operation.op === 'remove') delete object[key];
  else object[key] = structuredClone(operation.value);
}

function patches(content: string): JsonPatchOperation[] {
  const results: JsonPatchOperation[] = [];
  for (const match of content.matchAll(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/gi)) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const candidate of parsed) {
        const item = record(candidate);
        if (!['add', 'insert', 'replace', 'remove'].includes(String(item?.op)) || typeof item?.path !== 'string') continue;
        if (Object.hasOwn(item, 'value') && !safeValue(item.value)) continue;
        results.push({
          op: item.op as JsonPatchOperation['op'], path: item.path,
          ...(Object.hasOwn(item, 'value') ? { value: structuredClone(item.value) } : {}),
        });
      }
    } catch {
      // A malformed model update is ignored without discarding the completed reply.
    }
  }
  return results;
}

export function createMvuState(entries: readonly MvuInitEntry[], openingContent = ''): Record<string, unknown> {
  let statData: Record<string, unknown> = {};
  const initialized: Record<string, string[]> = {};
  for (const entry of entries) {
    try {
      const parsed = record(parseYaml(entry.content, { maxAliasCount: 0 }));
      if (parsed === undefined || !safeValue(parsed)) continue;
      statData = merge(statData, parsed);
      initialized[entry.id] = [];
    } catch {
      // Invalid InitVar entries fail open so the chat remains usable.
    }
  }
  const state: Record<string, unknown> = {
    initialized_lorebooks: initialized,
    stat_data: statData,
    schema: {},
  };
  return applyMvuMessage(state, openingContent);
}

export function applyMvuMessage(
  prior: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const state = structuredClone(prior);
  const statData = record(state.stat_data) ?? {};
  state.stat_data = statData;
  for (const operation of patches(content)) applyOperation(statData, operation);
  return state;
}
