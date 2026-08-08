import { z } from 'zod';
import { CompatibilityMetadataSchema } from './compatibility.js';

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
  alternateGreetings: z.array(z.string()),
  tags: z.array(z.string()),
  characterBook: z.record(z.string(), z.unknown()).optional(),
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
  description: z.string().optional(),
  enabled: z.boolean().default(true),
}).extend(WithCompatibilitySchema.shape);

export const WorldbookEntrySchema = MutableEntitySchema.extend({
  worldbookId: DomainIdSchema,
  keys: z.array(z.string()),
  content: z.string(),
  enabled: z.boolean().default(true),
  position: z.string().default('before_character'),
  order: z.number().int().default(0),
}).extend(WithCompatibilitySchema.shape);

export const PresetKindSchema = z.enum(['chat', 'text', 'context', 'instruct', 'system', 'reasoning']);
export const PresetSchema = MutableEntitySchema.extend({
  name: z.string().min(1),
  kind: PresetKindSchema,
  settings: z.record(z.string(), z.unknown()).default({}),
}).extend(WithCompatibilitySchema.shape);

export const ConversationSchema = MutableEntitySchema.extend({
  characterId: DomainIdSchema,
  personaId: DomainIdSchema,
  title: z.string().min(1),
  presetId: DomainIdSchema.optional(),
  worldbookIds: z.array(DomainIdSchema).default([]),
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
  content: z.string(),
  status: MessageVariantStatusSchema,
  finishReason: z.string().optional(),
  reasoning: z.string().optional(),
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

export type Character = z.infer<typeof CharacterSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Worldbook = z.infer<typeof WorldbookSchema>;
export type WorldbookEntry = z.infer<typeof WorldbookEntrySchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageVariant = z.infer<typeof MessageVariantSchema>;
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ImportArtifact = z.infer<typeof ImportArtifactSchema>;
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;
