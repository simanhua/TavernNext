import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  RoleplayDocumentSchema,
  RoleplaySceneViewBlockSchema,
  type Conversation,
  type InstalledScene,
  type RoleplayDocument,
  type SceneStateDiagnostic,
  type SceneViewDeclaration,
} from '@tavernnext/domain';
import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { isBundledOfficialScene } from '../scenes/official-package.js';
import type { SceneModuleHost } from '../scenes/scene-module-host.js';
import type { TurnWorkspace } from './turn-workspace.js';

const MAX_STAGED_VIEWS = 16;
const MAX_VIEW_RESULT_BYTES = 64 * 1024;
const VIEW_PREFIX = '<!--tavernnext:view:';
const COMPLETE_REFERENCE = /<!--tavernnext:view:([0-9A-Za-z_-]{1,160})-->/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedView {
  id: string;
  reference: string;
  kind: string;
  relatedEntities: string[];
  insertionIntent: 'inline' | 'before' | 'after';
}

export interface ResolvedSceneViews {
  document: RoleplayDocument;
  diagnostics: SceneStateDiagnostic[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedJson(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) throw new Error('scene_view_projection_invalid');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (typeof item !== 'object') throw new Error('scene_view_projection_invalid');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('scene_view_projection_invalid');
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .map(([key, entry]) => [key, visit(entry, depth + 1)]));
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_VIEW_RESULT_BYTES) {
    throw new Error('scene_view_projection_too_large');
  }
  return normalized;
}

function diagnostic(code: string, staged?: Partial<StagedView>): SceneStateDiagnostic {
  return {
    source: 'scene-view',
    code,
    failures: [],
    ...(staged?.reference === undefined ? {} : { viewRef: staged.reference }),
    ...(staged?.kind === undefined ? {} : { viewKind: staged.kind }),
  };
}

export class SceneViewRuntime {
  private readonly definitions: Map<string, SceneViewDeclaration>;
  private readonly staged = new Map<string, StagedView>();

  constructor(private readonly input: {
    scene: Pick<InstalledScene, 'id' | 'slug' | 'version' | 'archiveDigest'>;
    declarations: SceneViewDeclaration[];
    host: SceneModuleHost;
    setup: Record<string, unknown>;
    playerProfile: Conversation['playerProfile'];
    workspace: TurnWorkspace;
  }) {
    this.definitions = new Map(structuredClone(input.declarations).map((view) => [view.kind, view]));
  }

  tool(): AgentTool {
    return {
      name: 'scene_view_stage',
      label: 'Stage Scene View',
      description: 'Stage a Scene-defined read-only view and receive an opaque reference to place exactly once in the final prose.',
      parameters: Type.Object({
        kind: Type.String({ minLength: 1, maxLength: 64 }),
        relatedEntities: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
        insertionIntent: Type.Optional(Type.Union([
          Type.Literal('inline'), Type.Literal('before'), Type.Literal('after'),
        ])),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async (_toolCallId, raw) => {
        const args = raw as {
          kind: string;
          relatedEntities?: string[];
          insertionIntent?: 'inline' | 'before' | 'after';
        };
        if (!this.definitions.has(args.kind)) throw new Error('scene_view_kind_not_found');
        if (this.staged.size >= MAX_STAGED_VIEWS) throw new Error('scene_view_stage_limit');
        const id = randomUUID();
        const staged: StagedView = {
          id,
          reference: `${VIEW_PREFIX}${id}-->`,
          kind: args.kind,
          relatedEntities: structuredClone(args.relatedEntities ?? []),
          insertionIntent: args.insertionIntent ?? 'inline',
        };
        this.staged.set(id, staged);
        const detail = { ok: true, kind: staged.kind, reference: staged.reference };
        return { content: [{ type: 'text', text: JSON.stringify(detail) }], details: detail };
      },
    };
  }

  async resolve(markdown: string, signal?: AbortSignal): Promise<ResolvedSceneViews> {
    const blocks: RoleplayDocument['blocks'] = [];
    const diagnostics: SceneStateDiagnostic[] = [];
    const used = new Set<string>();
    let cursor = 0;
    const appendMarkdown = (rawContent: string) => {
      let content = rawContent;
      if (content.includes(VIEW_PREFIX)) {
        content = content.replace(/<!--tavernnext:view:[0-9A-Za-z_-]{0,160}/g, '');
        diagnostics.push(diagnostic('scene_view_reference_malformed'));
      }
      if (content !== '') blocks.push({ type: 'markdown', content });
    };
    for (const match of markdown.matchAll(COMPLETE_REFERENCE)) {
      appendMarkdown(markdown.slice(cursor, match.index));
      cursor = match.index! + match[0].length;
      const id = match[1]!;
      if (!UUID.test(id)) {
        diagnostics.push(diagnostic('scene_view_reference_malformed', { reference: match[0] }));
        continue;
      }
      const staged = this.staged.get(id);
      if (staged === undefined) {
        diagnostics.push(diagnostic('scene_view_reference_unknown', { reference: match[0] }));
        continue;
      }
      if (used.has(id)) {
        diagnostics.push(diagnostic('scene_view_reference_duplicate', staged));
        continue;
      }
      used.add(id);
      const declaration = this.definitions.get(staged.kind)!;
      const workspace = this.input.workspace.snapshot();
      if (workspace.stateRevision === null) {
        diagnostics.push(diagnostic('scene_view_projection_failed', staged));
        continue;
      }
      try {
        if (signal?.aborted) throw new Error('scene_view_projection_aborted');
        const raw = await this.input.host.call('projectSceneView', {
          kind: staged.kind,
          schemaVersion: declaration.schemaVersion,
          relatedEntities: structuredClone(staged.relatedEntities),
          insertionIntent: staged.insertionIntent,
          workspace: {
            baseStateRevision: workspace.stateRevision,
            commitStateRevision: workspace.stateRevision + (workspace.operations.length > 0 ? 1 : 0),
            state: workspace.stagedValue,
          },
          setup: structuredClone(this.input.setup),
          playerProfile: structuredClone(this.input.playerProfile),
          scene: structuredClone(this.input.scene),
        }, signal);
        const normalized = normalizedJson(raw);
        const props = record(normalized)?.props;
        if (record(props) === undefined || !Value.Check(declaration.projection.schema as TSchema, props)) {
          throw new Error('scene_view_projection_invalid');
        }
        blocks.push(RoleplaySceneViewBlockSchema.parse({
          type: 'scene-view',
          viewId: staged.id,
          sceneId: this.input.scene.id,
          sceneVersion: this.input.scene.version,
          sceneDigest: this.input.scene.archiveDigest,
          kind: staged.kind,
          schemaVersion: declaration.schemaVersion,
          rendererId: declaration.renderer.id,
          sourceStateRevision: workspace.stateRevision + (workspace.operations.length > 0 ? 1 : 0),
          props,
        }));
      } catch {
        diagnostics.push(diagnostic('scene_view_projection_failed', staged));
      }
    }
    appendMarkdown(markdown.slice(cursor));
    for (const staged of this.staged.values()) {
      if (!used.has(staged.id)) diagnostics.push(diagnostic('scene_view_unused', staged));
    }
    return { document: RoleplayDocumentSchema.parse({ version: 1, blocks }), diagnostics };
  }
}

export type SceneViewRuntimeFactory = (workspace: TurnWorkspace) => SceneViewRuntime;

export function createSceneViewRuntimeFactory(input: {
  scene: InstalledScene;
  host: SceneModuleHost | undefined;
  conversation: Conversation;
}): SceneViewRuntimeFactory | undefined {
  if (input.host === undefined || input.scene.manifest.sceneViews.length === 0
    || !isBundledOfficialScene(input.scene)) return undefined;
  const scene = {
    id: input.scene.id,
    slug: input.scene.slug,
    version: input.scene.version,
    archiveDigest: input.scene.archiveDigest,
  };
  const declarations = structuredClone(input.scene.manifest.sceneViews);
  const setup = structuredClone(input.conversation.setup ?? {});
  const playerProfile = structuredClone(input.conversation.playerProfile);
  const host = input.host;
  return (workspace) => new SceneViewRuntime({ scene, declarations, host, setup, playerProfile, workspace });
}
