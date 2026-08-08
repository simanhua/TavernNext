import { z } from 'zod';

export const GenerationModeSchema = z.enum(['normal', 'regenerate', 'swipe', 'continue']);

export const GenerationRequestSchema = z.object({
  conversationId: z.string().uuid(),
  conversationRevision: z.number().int().nonnegative(),
  mode: GenerationModeSchema,
  userText: z.string().optional(),
});

export type GenerationMode = z.infer<typeof GenerationModeSchema>;
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;
