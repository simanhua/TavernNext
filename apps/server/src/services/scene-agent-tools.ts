import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  SceneAgentToolResultSchema,
  type Conversation,
  type InstalledScene,
  type ScenePatchOperation,
} from '@tavernnext/domain';
import type { TSchema } from 'typebox';
import { isBundledOfficialScene } from '../scenes/official-package.js';
import type { SceneModuleHost } from '../scenes/scene-module-host.js';
import { PLATFORM_AGENT_TOOL_NAMES, type TurnWorkspace } from './turn-workspace.js';

const MAX_SCENE_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_JSON_NODES = 10_000;

export type SceneAgentToolFactory = (workspace: TurnWorkspace) => AgentTool[];

function patchSummary(operations: readonly ScenePatchOperation[]) {
  return operations.map((operation) => ({
    op: operation.op,
    ...('path' in operation ? { path: operation.path } : {}),
    ...('from' in operation ? { from: operation.from } : {}),
    ...('to' in operation ? { to: operation.to } : {}),
  }));
}

function normalizedJson(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > 32) throw new Error('scene_agent_tool_result_invalid');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('scene_agent_tool_result_invalid');
      return item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (typeof item !== 'object') throw new Error('scene_agent_tool_result_invalid');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('scene_agent_tool_result_invalid');
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length > 1_024) throw new Error('scene_agent_tool_result_invalid');
    return Object.fromEntries(entries.map(([key, entry]) => [key, visit(entry, depth + 1)]));
  };
  return visit(value, 0);
}

function assertBounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SCENE_TOOL_RESULT_BYTES) {
    throw new Error('scene_agent_tool_result_too_large');
  }
}

export function createSceneAgentToolFactory(input: {
  scene: InstalledScene;
  host: SceneModuleHost | undefined;
  conversation: Conversation;
}): SceneAgentToolFactory | undefined {
  if (input.host === undefined || input.scene.manifest.agentTools.length === 0
    || !isBundledOfficialScene(input.scene)) return undefined;
  const platformNames = new Set<string>(PLATFORM_AGENT_TOOL_NAMES);
  const definitions = structuredClone(input.scene.manifest.agentTools);
  if (definitions.some((definition) => platformNames.has(definition.name))) {
    throw new Error('scene_agent_tool_name_reserved');
  }
  const scene = {
    id: input.scene.id,
    slug: input.scene.slug,
    version: input.scene.version,
    archiveDigest: input.scene.archiveDigest,
  };
  const setup = structuredClone(input.conversation.setup ?? {});
  const playerProfile = structuredClone(input.conversation.playerProfile);
  const host = input.host;
  return (workspace) => definitions.map((definition): AgentTool => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: structuredClone(definition.parameters) as TSchema,
    executionMode: 'sequential',
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('scene_agent_tool_aborted');
      const before = workspace.snapshot();
      const raw = await host.call('executeAgentTool', {
        toolCallId,
        toolName: definition.name,
        arguments: structuredClone(params),
        workspace: {
          stateRevision: before.stateRevision,
          state: before.stagedValue,
        },
        setup,
        playerProfile,
        scene,
      }, signal);
      if (signal?.aborted) throw new Error('scene_agent_tool_aborted');
      const parsed = SceneAgentToolResultSchema.parse(normalizedJson(raw));
      assertBounded(parsed);
      const preview = parsed.statePatch === undefined
        ? { operations: [], failures: [] }
        : workspace.previewPatch(parsed.statePatch);
      const details = {
        scene: structuredClone(parsed.detail),
        patch: {
          appliedCount: preview.operations.length,
          applied: patchSummary(preview.operations),
          failureCount: preview.failures.length,
          failures: structuredClone(preview.failures),
          stagedOperationCount: before.operations.length + preview.operations.length,
        },
      };
      const patchText = JSON.stringify(details.patch);
      const finalResult = {
        content: [{
          type: 'text' as const,
          text: parsed.content === undefined || parsed.content === ''
            ? patchText
            : `${parsed.content}\n${patchText}`,
        }],
        details,
      };
      assertBounded(finalResult);
      if (parsed.statePatch !== undefined) workspace.stagePatch(parsed.statePatch);
      return finalResult;
    },
  }));
}
