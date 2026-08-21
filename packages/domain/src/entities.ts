import { z } from 'zod';
import { CompatibilityMetadataSchema } from './compatibility.js';
import { WorldbookTimedStateSchema } from './generation.js';

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

export const ConversationSchema = MutableEntitySchema.extend({
  characterId: DomainIdSchema,
  personaId: DomainIdSchema,
  title: z.string().min(1),
  worldbookIds: z.array(DomainIdSchema).default([]),
  maxPromptTokens: z.number().int().nonnegative().max(1_000_000).default(128_000),
  maxResponseTokens: z.number().int().nonnegative().max(384_000).default(32_768),
  authorNote: z.string().default(''),
  authorNotePosition: z.number().int().min(0).max(2).default(1),
  authorNoteDepth: z.number().int().nonnegative().default(4),
  authorNoteRole: z.number().int().min(0).max(2).default(0),
}).extend(WithCompatibilitySchema.shape);

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export const MessageSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  role: MessageRoleSchema,
  content: z.string(),
  activeVariantId: DomainIdSchema.nullable(),
}).extend(WithCompatibilitySchema.shape);

export const MessageVariantStatusSchema = z.enum(['streaming', 'completed', 'aborted', 'failed']);
export const MessageVariantSchema = MutableEntitySchema.extend({
  messageId: DomainIdSchema,
  ordinal: z.number().int().nonnegative().default(0),
  content: z.string(),
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
}).extend(WithCompatibilitySchema.shape);

export const ProviderProfileSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  secretRef: z.string().min(1).optional(),
  apiMode: z.enum(['chat', 'text']).default('chat'),
  headerSecretRefs: z.record(z.string(), z.string()).default({}),
}).extend(WithCompatibilitySchema.shape);

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
});

export const WorldbookRuntimeStateSchema = MutableEntitySchema.extend({
  conversationId: DomainIdSchema,
  timedState: WorldbookTimedStateSchema,
});

export type Character = z.infer<typeof CharacterSchema>;
export type ExtensionOwnerKind = z.infer<typeof ExtensionOwnerKindSchema>;
export type ExtensionAssetKind = z.infer<typeof ExtensionAssetKindSchema>;
export type ExtensionAsset = z.infer<typeof ExtensionAssetSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Worldbook = z.infer<typeof WorldbookSchema>;
export type WorldbookEntry = z.infer<typeof WorldbookEntrySchema>;
export type PresetKind = z.infer<typeof PresetKindSchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type GlobalGenerationConfig = z.infer<typeof GlobalGenerationConfigSchema>;
export type GlobalGenerationSelection = z.infer<typeof GlobalGenerationSelectionSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageVariant = z.infer<typeof MessageVariantSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ImportArtifact = z.infer<typeof ImportArtifactSchema>;
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
export type WorldbookRuntimeState = z.infer<typeof WorldbookRuntimeStateSchema>;
