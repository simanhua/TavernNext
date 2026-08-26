import { z } from 'zod';
import {
  RoleplayDocumentSchema,
  roleplayDocumentPlainText,
} from './roleplay-document.js';
import { CompatibilityMetadataSchema } from './compatibility.js';
import { WorldbookTimedStateSchema } from './generation.js';
import { ScenePatchOperationSchema, SceneStateDiagnosticSchema } from './scene-state.js';

export const DomainIdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });

const MutableEntitySchema = z.object({
  id: DomainIdSchema,
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const WithCompatibilitySchema = z.object({
  compatibility: CompatibilityMetadataSchema.optional(),
});

export const CharacterSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  firstMessage: z.string(),
  examples: z.string().default(''),
  systemPrompt: z.string().default(''),
  postHistoryInstructions: z.string().default(''),
  creatorNotes: z.string().default(''),
  creator: z.string().default(''),
  characterVersion: z.string().default(''),
  depthPrompt: z.string().default(''),
  alternateGreetings: z.array(z.string()),
  tags: z.array(z.string()),
  extensions: z.record(z.string(), z.unknown()).default({}),
  characterBook: z.record(z.string(), z.unknown()).optional(),
  worldbookId: DomainIdSchema.optional(),
  avatarPath: z.string().optional(),
}).extend(WithCompatibilitySchema.shape);

export const PersonaSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  description: z.string(),
  isDefault: z.boolean(),
  sceneInternal: z.boolean().optional(),
  avatarPath: z.string().optional(),
}).extend(WithCompatibilitySchema.shape);

export const WorldbookSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  scanDepth: z.number().nonnegative().nullable().default(null),
  tokenBudget: z.number().nonnegative().nullable().default(null),
  recursiveScanning: z.boolean().default(false),
  isGlobal: z.boolean().default(false),
  extensions: z.record(z.string(), z.unknown()).default({}),
}).extend(WithCompatibilitySchema.shape);

const WorldbookFilterSchema = z.object({
  isExclude: z.boolean().default(false),
  names: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const WorldbookEntrySchema = MutableEntitySchema.extend({
  worldbookId: DomainIdSchema,
  sourceUid: z.union([z.string(), z.number().finite()]).optional(),
  sourceOrdinal: z.number().int().nonnegative().optional(),
  keys: z.array(z.string()),
  secondaryKeys: z.array(z.string()).default([]),
  useRegex: z.boolean().default(true),
  selective: z.boolean().default(true),
  selectiveLogic: z.number().int().default(0),
  constant: z.boolean().default(false),
  vectorized: z.boolean().default(false),
  probability: z.number().default(100),
  useProbability: z.boolean().default(true),
  group: z.string().default(''),
  groupWeight: z.number().default(100),
  groupOverride: z.boolean().default(false),
  priority: z.number().nullable().default(null),
  content: z.string(),
  enabled: z.boolean().default(true),
  position: z.union([z.number(), z.string()]).default('before_character'),
  order: z.number().int().default(0),
  depth: z.number().default(4),
  role: z.number().int().default(0),
  ignoreBudget: z.boolean().default(false),
  scanDepth: z.number().nullable().default(null),
  caseSensitive: z.boolean().nullable().default(null),
  matchWholeWords: z.boolean().nullable().default(null),
  useGroupScoring: z.boolean().nullable().default(null),
  excludeRecursion: z.boolean().default(false),
  preventRecursion: z.boolean().default(false),
  delayUntilRecursion: z.union([z.boolean(), z.number()]).default(0),
  sticky: z.number().nullable().default(null),
  cooldown: z.number().nullable().default(null),
  delay: z.number().nullable().default(null),
  characterFilter: WorldbookFilterSchema.default({ isExclude: false, names: [], tags: [] }),
  personaFilter: WorldbookFilterSchema.default({ isExclude: false, names: [], tags: [] }),
  matchPersonaDescription: z.boolean().default(false),
  matchCharacterDescription: z.boolean().default(false),
  matchCharacterPersonality: z.boolean().default(false),
  matchCharacterDepthPrompt: z.boolean().default(false),
  matchScenario: z.boolean().default(false),
  matchCreatorNotes: z.boolean().default(false),
  comment: z.string().default(''),
  displayName: z.string().default(''),
  addMemo: z.boolean().default(false),
  displayIndex: z.number().nullable().default(null),
  outletName: z.string().default(''),
  automationId: z.string().default(''),
  triggers: z.array(z.string()).default([]),
  extensions: z.record(z.string(), z.unknown()).default({}),
}).extend(WithCompatibilitySchema.shape);

export const PresetKindSchema = z.enum(['chat', 'text', 'context', 'instruct', 'system', 'reasoning']);
export const PresetSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  kind: PresetKindSchema,
  settings: z.record(z.string(), z.unknown()).default({}),
  extensions: z.record(z.string(), z.unknown()).default({}),
}).extend(WithCompatibilitySchema.shape);

export const ExtensionOwnerKindSchema = z.enum(['character', 'preset']);
export const ExtensionAssetKindSchema = z.enum(['regex', 'tavern_helper']);
export const ExtensionAssetSchema = MutableEntitySchema.extend({
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: DomainIdSchema,
  kind: ExtensionAssetKindSchema,
  sourceKey: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  enabled: z.boolean(),
  payload: z.unknown(),
  diagnostics: z.array(z.string()).default([]),
});
export const ExtensionStateScopeSchema = z.enum([
  'global', 'character', 'preset', 'conversation', 'message-variant', 'script',
]);
export const ExtensionStateSchema = MutableEntitySchema.extend({
  scope: ExtensionStateScopeSchema,
  scopeId: z.string().min(1).max(1024),
  value: z.record(z.string(), z.unknown()).default({}),
});
export const ExtensionTrustGrantSchema = MutableEntitySchema.extend({
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: DomainIdSchema,
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  riskVersion: z.number().int().positive(),
  grantedAt: TimestampSchema,
});
export const ExtensionRemoteResourceSchema = MutableEntitySchema.extend({
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: DomainIdSchema,
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string(),
  mediaType: z.string().min(1),
  fetchedAt: TimestampSchema,
});
export const ExtensionAuditEventSchema = MutableEntitySchema.extend({
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: DomainIdSchema,
  event: z.enum(['remote_refresh', 'trust_granted', 'trust_revoked', 'trust_invalidated', 'remote_fetch_failed']),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const GLOBAL_GENERATION_CONFIG_ID = '018f0000-0000-7000-8000-000000000001' as const;
export const GlobalGenerationSelectionSchema = z.object({
  providerId: DomainIdSchema.nullable(),
  chatPresetId: DomainIdSchema.nullable(),
  textPresetId: DomainIdSchema.nullable(),
  contextPresetId: DomainIdSchema.nullable(),
  instructPresetId: DomainIdSchema.nullable(),
  systemPresetId: DomainIdSchema.nullable(),
});
export const GlobalGenerationSelectionNoticeSchema = z.object({
  kind: z.enum(['provider', 'preset']),
  deletedId: DomainIdSchema,
  createdAt: TimestampSchema,
});
export const GlobalGenerationConfigSchema = MutableEntitySchema
  .extend(GlobalGenerationSelectionSchema.shape)
  .extend({ selectionNotice: GlobalGenerationSelectionNoticeSchema.nullable() });

const SceneRelativePathSchema = z.string().min(1).max(512).refine((value) => (
  !value.includes('\\')
  && !value.startsWith('/')
  && !/^[A-Za-z]:/.test(value)
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
), 'scene_path_invalid');

const SceneModulePathSchema = SceneRelativePathSchema.refine(
  (value) => /\.(?:mjs|js)$/i.test(value),
  'scene_frontend_entry_invalid',
);

const SceneStylesheetPathSchema = SceneRelativePathSchema.refine(
  (value) => /\.css$/i.test(value),
  'scene_frontend_stylesheet_invalid',
);

export const SceneAgentToolDeclarationSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().min(1).max(2_000),
  parameters: z.record(z.string(), z.unknown()).refine(
    (value) => value.type === 'object',
    'scene_agent_tool_parameters_must_be_object_schema',
  ),
}).strict();

export const SceneManifestSchema = z.object({
  id: DomainIdSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(96),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  name: z.string().min(1).max(160),
  summary: z.string().max(500),
  description: z.string().max(20_000),
  author: z.string().min(1).max(160),
  minimumTavernNextVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  sceneSdkVersion: z.literal(2),
  frontendEntry: SceneModulePathSchema,
  frontendStyles: z.array(SceneStylesheetPathSchema).max(64).default([]),
  serverEntry: SceneRelativePathSchema.optional(),
  coverPath: SceneRelativePathSchema.optional(),
  setupSchema: z.record(z.string(), z.unknown()).default({}),
  stateSchema: z.record(z.string(), z.unknown()).default({}),
  generationRecipe: z.record(z.string(), z.unknown()).optional(),
  agentTools: z.array(SceneAgentToolDeclarationSchema).max(32).default([]),
  files: z.array(SceneRelativePathSchema).min(1).max(2_048),
}).strict().superRefine((manifest, context) => {
  const toolNames = new Set<string>();
  for (const [index, tool] of manifest.agentTools.entries()) {
    if (toolNames.has(tool.name)) {
      context.addIssue({ code: 'custom', message: 'scene_agent_tool_name_duplicate', path: ['agentTools', index, 'name'] });
    }
    toolNames.add(tool.name);
  }
  const declared = new Set(manifest.files);
  const required = [
    manifest.frontendEntry,
    ...manifest.frontendStyles,
    manifest.serverEntry,
    manifest.coverPath,
  ].filter((value): value is string => value !== undefined);
  for (const path of required) {
    if (!declared.has(path)) {
      context.addIssue({ code: 'custom', message: 'scene_manifest_file_not_declared', path: ['files'] });
    }
  }
});

export const SceneCatalogEntrySchema = z.object({
  sceneId: DomainIdSchema,
  version: SceneManifestSchema.shape.version,
  packageUrl: z.string().min(1),
  minimumTavernNextVersion: SceneManifestSchema.shape.minimumTavernNextVersion,
  name: z.string().min(1),
  summary: z.string(),
  author: z.string().min(1),
}).strict();

export const SceneCatalogSchema = z.object({
  version: z.literal(1),
  generatedAt: TimestampSchema,
  scenes: z.array(SceneCatalogEntrySchema),
}).strict();

export const InstalledSceneSchema = MutableEntitySchema.extend({
  slug: SceneManifestSchema.shape.slug,
  version: SceneManifestSchema.shape.version,
  archiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
  installPath: z.string().min(1),
  installedAt: TimestampSchema,
  manifest: SceneManifestSchema,
  backingCharacterId: DomainIdSchema,
  backingPresetId: DomainIdSchema.optional(),
});

export const ConversationPlayerProfileSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(20_000),
  sourcePersonaId: DomainIdSchema.optional(),
}).strict();

export const ConversationSchema = MutableEntitySchema.extend({
  characterId: DomainIdSchema,
  personaId: DomainIdSchema,
  sceneId: DomainIdSchema.optional(),
  playerProfile: ConversationPlayerProfileSchema.optional(),
  setup: z.record(z.string(), z.unknown()).optional(),
  title: z.string().min(1),
  worldbookIds: z.array(DomainIdSchema).default([]),
  maxPromptTokens: z.number().int().nonnegative().max(1_000_000).default(128_000),
  maxResponseTokens: z.number().int().nonnegative().max(384_000).default(32_768),
  authorNote: z.string().default(''),
  authorNotePosition: z.number().int().min(0).max(2).default(1),
  authorNoteDepth: z.number().int().nonnegative().default(4),
  authorNoteRole: z.number().int().min(0).max(2).default(0),
}).extend(WithCompatibilitySchema.shape);

export const SaveAgentConfigurationSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  sourcePresetId: DomainIdSchema.nullable(),
  sourcePresetRevision: z.number().int().nonnegative().nullable(),
  name: z.string().min(1),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const ConversationSceneStateSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  schemaVersion: z.number().int().positive().default(1),
  baseValue: z.record(z.string(), z.unknown()).default({}),
  headTransitionId: DomainIdSchema.nullable().default(null),
  value: z.record(z.string(), z.unknown()).default({}),
});

export const SceneStateTransitionSourceKindSchema = z.enum([
  'message-variant', 'scene-action', 'sdk-patch',
]);
export const SceneStateTransitionSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  parentTransitionId: DomainIdSchema.nullable().default(null),
  sourceKind: SceneStateTransitionSourceKindSchema,
  sourceId: DomainIdSchema,
  operations: z.array(ScenePatchOperationSchema).default([]),
  value: z.record(z.string(), z.unknown()).default({}),
});

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export const MessageSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  role: MessageRoleSchema,
  content: z.string(),
  activeVariantId: DomainIdSchema.nullable(),
}).extend(WithCompatibilitySchema.shape);

export const MessageVariantStatusSchema = z.enum(['streaming', 'completed', 'aborted', 'failed']);
const MessageVariantValueSchema = MutableEntitySchema.extend({
  messageId: DomainIdSchema,
  ordinal: z.number().int().nonnegative().default(0),
  content: z.string(),
  document: RoleplayDocumentSchema,
  status: MessageVariantStatusSchema,
  finishReason: z.string().optional(),
  reasoning: z.string().optional(),
  continuationBoundaries: z.array(z.number().int().nonnegative()).default([]),
  sendDate: z.union([z.string(), z.number().finite()]).optional(),
  generationStarted: z.union([z.string(), z.number().finite()]).optional(),
  generationFinished: z.union([z.string(), z.number().finite()]).optional(),
  api: z.string().optional(),
  model: z.string().optional(),
  tokenCount: z.number().finite().nonnegative().optional(),
  reasoningDuration: z.number().finite().nonnegative().optional(),
  diagnostics: z.array(SceneStateDiagnosticSchema).default([]),
}).extend(WithCompatibilitySchema.shape).superRefine((variant, context) => {
  if (variant.content !== roleplayDocumentPlainText(variant.document)) {
    context.addIssue({ code: 'custom', message: 'message_variant_content_must_match_document', path: ['content'] });
  }
});

export const MessageVariantSchema = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  return value.document === undefined && typeof value.content === 'string'
    ? {
        ...value,
        document: {
          version: 1,
          blocks: value.content === '' ? [] : [{ type: 'markdown', content: value.content }],
        },
      }
    : input;
}, MessageVariantValueSchema);

const ProviderProfileValueSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  baseUrl: z.string().url(),
  customBaseUrl: z.string().url().optional(),
  toolCalls: z.boolean(),
  model: z.string().min(1),
  secretRef: z.string().min(1).optional(),
  apiMode: z.enum(['chat', 'text']).default('chat'),
  headerSecretRefs: z.record(z.string(), z.string()).default({}),
}).extend(WithCompatibilitySchema.shape);

export const ProviderProfileSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    providerId: record.providerId ?? 'custom-openai-compatible',
    modelId: record.modelId ?? record.model,
    toolCalls: record.toolCalls ?? true,
  };
}, ProviderProfileValueSchema);

export const ImportArtifactSchema = MutableEntitySchema.extend({
  kind: z.string().min(1),
  sourceName: z.string().min(1),
  mediaType: z.string().min(1),
  rawArtifact: z.string(),
  entityId: DomainIdSchema.optional(),
}).extend(WithCompatibilitySchema.shape);

export const GenerationSnapshotSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  conversationRevision: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  sceneId: DomainIdSchema.optional(),
  sceneVersion: SceneManifestSchema.shape.version.optional(),
  scenePackageDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sceneStateRevision: z.number().int().nonnegative().optional(),
  recipeSource: z.enum(['scene', 'global-fallback']).optional(),
});

export const AgentRunStatusSchema = z.enum(['running', 'completed', 'failed', 'aborted', 'budget_exhausted']);
export const AgentRunLifecycleEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.enum(['agent_start', 'turn_start', 'turn_end', 'agent_end']),
  at: z.string().datetime(),
}).strict();
export const AgentRunRevisionSchema = z.object({
  id: DomainIdSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export const AgentRunSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  generationId: DomainIdSchema,
  snapshotId: DomainIdSchema,
  status: AgentRunStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  limits: z.object({
    maxModelTurns: z.number().int().positive().max(64),
    maxToolCalls: z.number().int().positive().max(1_024),
    timeoutMs: z.number().int().positive().max(600_000),
  }).strict(),
  counts: z.object({
    modelTurns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
  }).strict(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict(),
  promptPlan: z.object({
    schemaVersion: z.literal(1),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    promptTokens: z.number().int().nonnegative(),
    messageCount: z.number().int().positive(),
  }).strict(),
  revisions: z.object({
    conversation: AgentRunRevisionSchema,
    character: AgentRunRevisionSchema,
    persona: AgentRunRevisionSchema,
    provider: AgentRunRevisionSchema,
    saveAgentConfiguration: AgentRunRevisionSchema,
    sceneState: AgentRunRevisionSchema.nullable(),
  }).strict(),
  lifecycle: z.array(AgentRunLifecycleEventSchema).max(64),
  diagnostics: z.array(z.string().max(128)).max(32),
  failureCode: z.string().max(128).optional(),
});

export const WorldbookRuntimeStateSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  timedState: WorldbookTimedStateSchema,
});

export type Character = z.infer<typeof CharacterSchema>;
export type ExtensionOwnerKind = z.infer<typeof ExtensionOwnerKindSchema>;
export type ExtensionAssetKind = z.infer<typeof ExtensionAssetKindSchema>;
export type ExtensionAsset = z.infer<typeof ExtensionAssetSchema>;
export type ExtensionStateScope = z.infer<typeof ExtensionStateScopeSchema>;
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;
export type ExtensionTrustGrant = z.infer<typeof ExtensionTrustGrantSchema>;
export type ExtensionRemoteResource = z.infer<typeof ExtensionRemoteResourceSchema>;
export type ExtensionAuditEvent = z.infer<typeof ExtensionAuditEventSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Worldbook = z.infer<typeof WorldbookSchema>;
export type WorldbookEntry = z.infer<typeof WorldbookEntrySchema>;
export type PresetKind = z.infer<typeof PresetKindSchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type GlobalGenerationConfig = z.infer<typeof GlobalGenerationConfigSchema>;
export type GlobalGenerationSelection = z.infer<typeof GlobalGenerationSelectionSchema>;
export type SceneManifest = z.infer<typeof SceneManifestSchema>;
export type SceneCatalogEntry = z.infer<typeof SceneCatalogEntrySchema>;
export type SceneCatalog = z.infer<typeof SceneCatalogSchema>;
export type InstalledScene = z.infer<typeof InstalledSceneSchema>;
export type SceneAgentToolDeclaration = z.infer<typeof SceneAgentToolDeclarationSchema>;
export type ConversationPlayerProfile = z.infer<typeof ConversationPlayerProfileSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type SaveAgentConfiguration = z.infer<typeof SaveAgentConfigurationSchema>;
export type ConversationSceneState = z.infer<typeof ConversationSceneStateSchema>;
export type SceneStateTransitionSourceKind = z.infer<typeof SceneStateTransitionSourceKindSchema>;
export type SceneStateTransition = z.infer<typeof SceneStateTransitionSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageVariant = z.infer<typeof MessageVariantSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ImportArtifact = z.infer<typeof ImportArtifactSchema>;
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type WorldbookRuntimeState = z.infer<typeof WorldbookRuntimeStateSchema>;
