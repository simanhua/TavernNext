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

function valueAt(root: Record<string, unknown>, pointer: string): unknown {
  let value: unknown = root;
  for (const part of pointerParts(pointer)) {
    if (Array.isArray(value)) {
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) throw new Error('state_path_not_found');
      value = value[index];
    } else {
      const item = record(value);
      if (item === undefined || !Object.hasOwn(item, part)) throw new Error('state_path_not_found');
      value = item[part];
    }
  }
  return structuredClone(value);
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

  stagePatch(rawOperations: unknown): ScenePatchApplication {
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
      this.failures.push(...failure);
      return { value: structuredClone(this.stagedValue), operations: [], failures: failure };
    }
    const applied = applyScenePatchPartial(this.stagedValue, rawOperations, this.manifest);
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
        description: 'Read the current staged Save State. Later reads include successful earlier staged patches.',
        parameters: Type.Object({
          paths: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 64 })),
        }, { additionalProperties: false }),
        executionMode: 'sequential',
        async execute(_toolCallId, params) {
          const args = params as { paths?: string[] };
          const snapshot = workspace.snapshot();
          if (snapshot.stateRevision === null) return result({ ok: false, code: 'scene_state_unavailable' });
          if (args.paths === undefined || args.paths.length === 0) {
            return result({ ok: true, stateRevision: snapshot.stateRevision, value: snapshot.stagedValue });
          }
          const values = args.paths.map((path) => {
            try { return { path, ok: true as const, value: valueAt(snapshot.stagedValue, path) }; }
            catch { return { path, ok: false as const, code: 'state_path_not_found' }; }
          });
          return result({ ok: true, stateRevision: snapshot.stateRevision, values });
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
