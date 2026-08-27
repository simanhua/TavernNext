import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SceneManifest, ScenePatchFailure, ScenePatchOperation } from '@tavernnext/domain';
import { Type } from 'typebox';
import {
  applyScenePatchPartial,
  type ScenePatchApplication,
} from '../scenes/scene-service.js';
import type { PromptSnapshotPayload } from './prompt-snapshot-service.js';

const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_WORLD_RESULTS = 20;
const MAX_STATE_CATALOG_NODES = 96;
const MAX_STATE_CATALOG_DEPTH = 3;
const MAX_STATE_CATALOG_CHILDREN = 16;
const MAX_STATE_PATH_SUGGESTIONS = 5;

export const PLATFORM_AGENT_TOOL_NAMES = [
  'save_state_read', 'world_query', 'deterministic_check', 'scene_patch_stage', 'scene_view_stage',
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= MAX_TOOL_RESULT_BYTES) return value;
  return { ok: false, code: 'tool_result_too_large', bytes: Buffer.byteLength(serialized) };
}

function result(value: unknown) {
  const safe = bounded(value);
  return { content: [{ type: 'text' as const, text: JSON.stringify(safe) }], details: structuredClone(safe) };
}

function pointerParts(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('state_path_invalid');
  return pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerPath(parts: readonly string[]): string {
  return parts.length === 0 ? '' : `/${parts.map(pointerSegment).join('/')}`;
}

function stateType(value: unknown): 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'unknown' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (record(value) !== undefined) return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

function stateChildren(value: unknown): string[] {
  if (Array.isArray(value)) return value.slice(0, MAX_STATE_CATALOG_CHILDREN).map((_item, index) => String(index));
  const object = record(value);
  return object === undefined ? [] : Object.keys(object).slice(0, MAX_STATE_CATALOG_CHILDREN);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        current[rightIndex]! + 1,
        previous[rightIndex + 1]! + 1,
        previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function suggestedPaths(parent: unknown, resolved: readonly string[], requested: string): string[] {
  const children = stateChildren(parent);
  const containing = children.filter((child) => child.includes(requested) || requested.includes(child));
  const ranked = (containing.length > 0 ? containing : children.sort((left, right) => (
    editDistance(requested, left) - editDistance(requested, right) || left.localeCompare(right)
  ))).slice(0, MAX_STATE_PATH_SUGGESTIONS);
  return ranked.map((child) => pointerPath([...resolved, child]));
}

function readStatePath(root: Record<string, unknown>, pointer: string):
  | { ok: true; value: unknown }
  | { ok: false; code: 'state_path_invalid' | 'state_path_not_found'; nearestPath: string; suggestions: string[] } {
  let parts: string[];
  try {
    parts = pointerParts(pointer);
  } catch {
    return {
      ok: false, code: 'state_path_invalid', nearestPath: '', suggestions: suggestedPaths(root, [], pointer),
    };
  }
  let value: unknown = root;
  const resolved: string[] = [];
  for (const part of parts) {
    if (Array.isArray(value)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) return {
        ok: false,
        code: 'state_path_not_found',
        nearestPath: pointerPath(resolved),
        suggestions: suggestedPaths(value, resolved, part),
      };
      value = value[index];
    } else {
      const item = record(value);
      if (item === undefined || !Object.hasOwn(item, part)) return {
        ok: false,
        code: 'state_path_not_found',
        nearestPath: pointerPath(resolved),
        suggestions: suggestedPaths(value, resolved, part),
      };
      value = item[part];
    }
    resolved.push(part);
  }
  return { ok: true, value: structuredClone(value) };
}

function topLevelKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).slice(0, 32);
}

function topLevelPaths(value: Record<string, unknown>): string[] {
  return topLevelKeys(value).map((key) => pointerPath([key]));
}

function stateCatalog(root: unknown, baseParts: readonly string[] = []): {
  catalog: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  const catalog: Array<Record<string, unknown>> = [];
  let truncated = false;
  const visit = (value: unknown, parts: string[], depth: number) => {
    if (catalog.length >= MAX_STATE_CATALOG_NODES) {
      truncated = true;
      return;
    }
    const path = pointerPath(parts);
    if (path.length > 512) {
      truncated = true;
      return;
    }
    const type = stateType(value);
    const node: Record<string, unknown> = { path, type };
    if (type === 'string') node.chars = (value as string).length;
    else if (type === 'array') node.length = (value as unknown[]).length;
    else if (type === 'object') node.childCount = Object.keys(value as Record<string, unknown>).length;
    catalog.push(node);
    if (depth >= MAX_STATE_CATALOG_DEPTH) {
      if (stateChildren(value).length > 0) truncated = true;
      return;
    }
    const children = stateChildren(value);
    if ((Array.isArray(value) ? value.length : Object.keys(record(value) ?? {}).length) > children.length) truncated = true;
    for (const child of children) {
      const nested = Array.isArray(value) ? value[Number(child)] : record(value)?.[child];
      visit(nested, [...parts, child], depth + 1);
    }
  };
  const children = stateChildren(root);
  for (const child of children) {
    const value = Array.isArray(root) ? root[Number(child)] : record(root)?.[child];
    visit(value, [...baseParts, child], 1);
  }
  return { catalog, truncated };
}

interface WorldEntry {
  bookId: string;
  bookName: string;
  source: string;
  entryKey: string;
  keys: string[];
  content: string;
}

function worldEntries(payload: PromptSnapshotPayload): WorldEntry[] {
  const rows = Array.isArray(payload.executable.worldbooks) ? payload.executable.worldbooks : [];
  return rows.flatMap((rawBook, bookIndex) => {
    const row = record(rawBook);
    const book = record(row?.book);
    if (row === undefined || book === undefined || !Array.isArray(book.entries)) return [];
    const bookId = typeof row.id === 'string' ? row.id : `book-${bookIndex}`;
    const bookName = typeof book.name === 'string' ? book.name : bookId;
    const source = typeof row.source === 'string' ? row.source : 'unknown';
    return book.entries.flatMap((rawEntry, entryIndex): WorldEntry[] => {
      const entry = record(rawEntry);
      if (entry === undefined || entry.enabled === false || typeof entry.content !== 'string') return [];
      const keys = [
        ...(Array.isArray(entry.keys) ? entry.keys : []),
        ...(Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : []),
      ].filter((key): key is string => typeof key === 'string');
      return [{
        bookId,
        bookName,
        source,
        entryKey: typeof entry.id === 'string' ? entry.id : `${bookId}:${entryIndex}`,
        keys,
        content: entry.content,
      }];
    });
  });
}

function queryWorld(entries: readonly WorldEntry[], query: string, requestedLimit?: number) {
  const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 16);
  const limit = Math.min(MAX_WORLD_RESULTS, Math.max(1, Math.floor(requestedLimit ?? 8)));
  return entries.map((entry, index) => {
    const keyText = entry.keys.join(' ').toLocaleLowerCase();
    const content = entry.content.toLocaleLowerCase();
    const name = entry.bookName.toLocaleLowerCase();
    const score = terms.reduce((total, term) => total
      + (keyText.includes(term) ? 8 : 0)
      + (name.includes(term) ? 3 : 0)
      + (content.includes(term) ? 1 : 0), 0);
    return { entry, index, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...entry, score, content: entry.content.slice(0, 2_048) }));
}

export interface TurnWorkspaceSnapshot {
  stateRevision: number | null;
  baseValue: Record<string, unknown>;
  stagedValue: Record<string, unknown>;
  operations: ScenePatchOperation[];
  failures: ScenePatchFailure[];
}

export class TurnWorkspace {
  private readonly generationId: string;
  private readonly seed: string | number;
  private readonly stateRevision: number | null;
  private readonly manifest: SceneManifest | undefined;
  private readonly entries: WorldEntry[];
  private readonly baseValue: Record<string, unknown>;
  private stagedValue: Record<string, unknown>;
  private readonly operations: ScenePatchOperation[] = [];
  private readonly failures: ScenePatchFailure[] = [];

  constructor(input: {
    generationId: string;
    payload: PromptSnapshotPayload;
    state?: {
      revision: number;
      value: Record<string, unknown>;
      manifest: SceneManifest;
      initialOperations?: ScenePatchOperation[];
      initialFailures?: ScenePatchFailure[];
    };
  }) {
    this.generationId = input.generationId;
    this.seed = structuredClone(input.payload.seed);
    this.stateRevision = input.state?.revision ?? null;
    this.manifest = input.state === undefined ? undefined : structuredClone(input.state.manifest);
    this.entries = structuredClone(worldEntries(input.payload));
    this.baseValue = structuredClone(input.state?.value ?? {});
    this.stagedValue = structuredClone(this.baseValue);
    if (input.state?.initialFailures !== undefined) {
      this.failures.push(...structuredClone(input.state.initialFailures));
    }
    if (input.state?.initialOperations !== undefined) this.stagePatch(input.state.initialOperations);
  }

  private applyPatch(rawOperations: unknown): ScenePatchApplication {
    if (this.manifest === undefined) {
      const raws = Array.isArray(rawOperations) ? rawOperations : [rawOperations];
      const failure = raws.slice(0, 512).map((raw, operationIndex): ScenePatchFailure => {
        const operation = record(raw);
        return {
          operationIndex,
          code: 'scene_state_unavailable',
          ...(typeof operation?.op === 'string' ? { op: operation.op } : {}),
          ...(typeof operation?.path === 'string' ? { path: operation.path } : {}),
        };
      });
      return { value: structuredClone(this.stagedValue), operations: [], failures: failure };
    }
    return applyScenePatchPartial(this.stagedValue, rawOperations, this.manifest);
  }

  previewPatch(rawOperations: unknown): ScenePatchApplication {
    return structuredClone(this.applyPatch(rawOperations));
  }

  stagePatch(rawOperations: unknown): ScenePatchApplication {
    const applied = this.applyPatch(rawOperations);
    this.stagedValue = applied.value;
    this.operations.push(...structuredClone(applied.operations));
    this.failures.push(...structuredClone(applied.failures));
    return structuredClone(applied);
  }

  snapshot(): TurnWorkspaceSnapshot {
    return {
      stateRevision: this.stateRevision,
      baseValue: structuredClone(this.baseValue),
      stagedValue: structuredClone(this.stagedValue),
      operations: structuredClone(this.operations),
      failures: structuredClone(this.failures),
    };
  }

  tools(): AgentTool[] {
    const workspace = this;
    return [
      {
        name: 'save_state_read',
        label: 'Read Save State',
        description: 'Read the current staged Save State with exact RFC 6901 JSON Pointer paths. The state is summarized in the prompt: use its exact keys, do not guess missing paths, and use returned nearestPath/suggestions to recover. Omit paths only to request a bounded path catalog when the full state is too large. Later reads include successful earlier staged patches.',
        parameters: Type.Object({
          paths: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
        }, { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const args = params as { paths?: string[] };
          const snapshot = workspace.snapshot();
          if (snapshot.stateRevision === null) return result({ ok: false, code: 'scene_state_unavailable' });
          const rootKeys = topLevelKeys(snapshot.stagedValue);
          const rootPaths = topLevelPaths(snapshot.stagedValue);
          if (args.paths === undefined || args.paths.length === 0) {
            const full = {
              ok: true, mode: 'full', stateRevision: snapshot.stateRevision,
              topLevelKeys: rootKeys, topLevelPaths: rootPaths, value: snapshot.stagedValue,
            };
            const bytes = Buffer.byteLength(JSON.stringify(full));
            if (bytes <= MAX_TOOL_RESULT_BYTES) return result(full);
            const catalog = stateCatalog(snapshot.stagedValue);
            return result({
              ok: true, mode: 'catalog', stateRevision: snapshot.stateRevision, bytes,
              topLevelKeys: rootKeys, topLevelPaths: rootPaths,
              catalog: catalog.catalog, catalogTruncated: catalog.truncated,
            });
          }
          const values = args.paths.map((path) => {
            const read = readStatePath(snapshot.stagedValue, path);
            if (!read.ok) return { path, ...read };
            const valueResult = { path, ok: true as const, value: read.value };
            if (Buffer.byteLength(JSON.stringify(valueResult)) <= MAX_TOOL_RESULT_BYTES / 2) return valueResult;
            const catalog = stateCatalog(read.value, pointerParts(path));
            return {
              path, ok: true as const, mode: 'catalog' as const,
              bytes: Buffer.byteLength(JSON.stringify(valueResult)),
              catalog: catalog.catalog, catalogTruncated: catalog.truncated,
            };
          });
          return result({
            ok: true, mode: 'paths', stateRevision: snapshot.stateRevision,
            topLevelKeys: rootKeys, topLevelPaths: rootPaths, values,
          });
        },
      },
      {
        name: 'world_query',
        label: 'Query World Lore',
        description: 'Search the immutable Worldbook and world lore captured for this Agent Run.',
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 256 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORLD_RESULTS })),
        }, { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const args = params as { query: string; limit?: number };
          return result({ ok: true, query: args.query, results: queryWorld(workspace.entries, args.query, args.limit) });
        },
      },
      {
        name: 'deterministic_check',
        label: 'Run Deterministic Check',
        description: 'Resolve a reproducible bounded check. Use a stable unique key for each intended check.',
        parameters: Type.Object({
          key: Type.String({ minLength: 1, maxLength: 128 }),
          difficulty: Type.Number({ minimum: -1_000_000, maximum: 1_000_000 }),
          modifier: Type.Optional(Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })),
          sides: Type.Optional(Type.Integer({ minimum: 2, maximum: 10_000 })),
        }, { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const args = params as { key: string; difficulty: number; modifier?: number; sides?: number };
          const sides = args.sides ?? 20;
          const modifier = args.modifier ?? 0;
          const digest = createHash('sha256').update(JSON.stringify({
            generationId: workspace.generationId,
            seed: workspace.seed,
            key: args.key,
            sides,
          })).digest();
          const roll = Number(digest.readBigUInt64BE(0) % BigInt(sides)) + 1;
          const total = roll + modifier;
          return result({
            ok: true, key: args.key, sides, roll, modifier, total,
            difficulty: args.difficulty, success: total >= args.difficulty,
            margin: total - args.difficulty,
          });
        },
      },
      {
        name: 'scene_patch_stage',
        label: 'Stage Scene Patch',
        description: 'Stage ordered Save State patch operations. Valid operations apply immediately; invalid operations return structured failures.',
        parameters: Type.Object({
          operations: Type.Array(Type.Unknown(), { maxItems: 32 }),
        }, { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const args = params as { operations: unknown[] };
          const applied = workspace.stagePatch(args.operations);
          return result({
            ok: applied.failures.length === 0,
            appliedCount: applied.operations.length,
            applied: applied.operations.map((operation) => ({
              op: operation.op,
              ...('path' in operation ? { path: operation.path } : {}),
              ...('from' in operation ? { from: operation.from } : {}),
              ...('to' in operation ? { to: operation.to } : {}),
            })),
            failureCount: applied.failures.length,
            failures: applied.failures,
            stagedOperationCount: workspace.operations.length,
          });
        },
      },
    ];
  }
}
