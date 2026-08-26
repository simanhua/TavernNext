import { z } from 'zod';

const ScenePointerSchema = z.string().startsWith('/');

const ScenePatchValueOperationSchema = z.object({
  op: z.enum(['insert', 'replace', 'delta', 'add']),
  path: ScenePointerSchema,
  value: z.unknown(),
}).strict();

const ScenePatchRemoveOperationSchema = z.object({
  op: z.literal('remove'),
  path: ScenePointerSchema,
}).strict();

const ScenePatchMoveOperationSchema = z.union([
  z.object({ op: z.literal('move'), from: ScenePointerSchema, to: ScenePointerSchema }).strict(),
  // Read compatibility for Scene transitions written before the legacy MVU contract was restored.
  z.object({ op: z.literal('move'), from: ScenePointerSchema, path: ScenePointerSchema }).strict(),
]);

const ScenePatchCompatibilityOperationSchema = z.union([
  z.object({ op: z.literal('copy'), from: ScenePointerSchema, path: ScenePointerSchema }).strict(),
  z.object({ op: z.literal('test'), path: ScenePointerSchema, value: z.unknown() }).strict(),
]);

export const ScenePatchOperationSchema = z.union([
  ScenePatchValueOperationSchema,
  ScenePatchRemoveOperationSchema,
  ScenePatchMoveOperationSchema,
  ScenePatchCompatibilityOperationSchema,
]);

export const ScenePatchFailureSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  code: z.string().min(1).max(160),
  op: z.string().max(40).optional(),
  path: z.string().max(4_096).optional(),
  from: z.string().max(4_096).optional(),
  to: z.string().max(4_096).optional(),
}).strict();

export const SceneStateDiagnosticSchema = z.object({
  source: z.enum(['scene-output-protocol', 'scene-hook']),
  code: z.string().min(1).max(160),
  appliedCount: z.number().int().nonnegative().optional(),
  failures: z.array(ScenePatchFailureSchema).max(512).default([]),
}).strict();

export const ScenePromptAdditionSchema = z.object({
  role: z.literal('system'),
  content: z.string().max(262_144),
}).strict();

export const SceneInitializeResultSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  initialState: z.record(z.string(), z.unknown()),
  openingMessages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }).strict()).max(16).default([]),
}).strict();

export const SceneBeforeGenerationResultSchema = z.object({
  statePatch: z.array(ScenePatchOperationSchema).optional(),
  promptAdditions: z.array(ScenePromptAdditionSchema).max(16).optional(),
}).strict();

export const SceneAfterGenerationResultSchema = z.object({
  displayContent: z.string().optional(),
  statePatch: z.array(ScenePatchOperationSchema).optional(),
}).strict();

export const SceneActionResultSchema = z.object({
  statePatch: z.array(ScenePatchOperationSchema).optional(),
  result: z.unknown().optional(),
}).strict();

export type ScenePatchOperation = z.infer<typeof ScenePatchOperationSchema>;
export type ScenePatchFailure = z.infer<typeof ScenePatchFailureSchema>;
export type SceneStateDiagnostic = z.infer<typeof SceneStateDiagnosticSchema>;
export type ScenePromptAddition = z.infer<typeof ScenePromptAdditionSchema>;
export type SceneInitializeResult = z.infer<typeof SceneInitializeResultSchema>;
export type SceneBeforeGenerationResult = z.infer<typeof SceneBeforeGenerationResultSchema>;
export type SceneAfterGenerationResult = z.infer<typeof SceneAfterGenerationResultSchema>;
export type SceneActionResult = z.infer<typeof SceneActionResultSchema>;
