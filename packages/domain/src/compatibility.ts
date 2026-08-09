import { z } from 'zod';

/** Lossless envelope for data that TavernNext does not yet interpret. */
export const CompatibilityMetadataSchema = z.object({
  sourceFormat: z.string().min(1),
  rawPayload: z.unknown(),
  unknownFields: z.record(z.string(), z.unknown()),
  compatWarnings: z.array(z.string()),
  parserVersion: z.string().min(1),
});

export type CompatibilityMetadata = z.infer<typeof CompatibilityMetadataSchema>;
