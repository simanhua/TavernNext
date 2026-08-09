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

export type GenerationMode = z.infer<typeof GenerationModeSchema>;
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
export type WorldbookTimedEffect = z.infer<typeof WorldbookTimedEffectSchema>;
export type WorldbookTimedState = z.infer<typeof WorldbookTimedStateSchema>;
