import { z } from 'zod';

export const GenerationModeSchema = z.enum(['normal', 'regenerate', 'swipe', 'continue']);

export const WorldbookTimedEffectSchema = z.object({
  entryKey: z.string().min(1),
  fingerprint: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  protected: z.boolean(),
}).strict();

export const WorldbookTimedStateSchema = z.object({
  messageIndex: z.number().int().nonnegative().nullable(),
  sticky: z.array(WorldbookTimedEffectSchema),
  cooldown: z.array(WorldbookTimedEffectSchema),
}).strict();

export const EMPTY_WORLDBOOK_TIMED_STATE = {
  messageIndex: null,
  sticky: [],
  cooldown: [],
} as const;

export const GenerationRequestSchema = z.object({
  conversationId: z.string().uuid(),
  conversationRevision: z.number().int().nonnegative(),
  mode: GenerationModeSchema,
  userText: z.string().optional(),
  snapshotId: z.string().uuid().optional(),
  seed: z.union([z.string(), z.number().finite()]).optional(),
  messageIndex: z.number().int().nonnegative().optional(),
});

export const PromptHookMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(4_000_000),
  name: z.string().max(256).optional(),
}).strict();
export const GenerationCandidateTransportSchema = z.object({
  candidateId: z.string().uuid(),
  expiresAt: z.string().datetime({ offset: true }),
  executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['chat', 'text']),
  messages: z.array(PromptHookMessageSchema).max(100_000).optional(),
  text: z.string().max(16_000_000).optional(),
  stop: z.array(z.string().max(1_024)).max(128),
  entityRevisions: z.record(z.string(), z.unknown()),
  compiledRequestHash: z.string().regex(/^[a-f0-9]{64}$/),
  spreset: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export const TrustedPromptPatchSchema = z.object({
  messages: z.array(PromptHookMessageSchema).max(100_000).optional(),
  text: z.string().max(16_000_000).optional(),
  stop: z.array(z.string().max(1_024)).max(128).optional(),
}).strict();
export const SealGenerationCandidateSchema = z.object({ patch: TrustedPromptPatchSchema }).strict();

export type GenerationMode = z.infer<typeof GenerationModeSchema>;
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
export type GenerationCandidateTransport = z.infer<typeof GenerationCandidateTransportSchema>;
export type TrustedPromptPatch = z.infer<typeof TrustedPromptPatchSchema>;
export type WorldbookTimedEffect = z.infer<typeof WorldbookTimedEffectSchema>;
export type WorldbookTimedState = z.infer<typeof WorldbookTimedStateSchema>;
