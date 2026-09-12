import { z } from 'zod';

export const PlayerOperationSchema = z.object({
  kind: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(500),
}).strict();
