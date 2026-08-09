import { z } from 'zod';

export const JsonObjectSchema = z.record(z.string(), z.unknown());

const NativeEntriesSchema = z.record(z.string(), JsonObjectSchema);
const ArrayEntriesSchema = z.array(JsonObjectSchema);

/** SillyTavern's native World Info document. Unknown fields are compatibility data. */
export const NativeWorldbookSchema = z.object({
  entries: NativeEntriesSchema,
}).passthrough();

/** Character Card V2/V3 embedded Character Book envelope. */
export const CharacterBookSchema = z.object({
  entries: ArrayEntriesSchema,
}).passthrough();

export const NovelWorldbookSchema = z.object({
  lorebookVersion: z.union([z.string(), z.number()]),
  entries: ArrayEntriesSchema,
}).passthrough();

export const AgnaiWorldbookSchema = z.object({
  kind: z.literal('memory'),
  entries: ArrayEntriesSchema,
}).passthrough();

export const RisuWorldbookSchema = z.object({
  type: z.literal('risu'),
  data: ArrayEntriesSchema,
}).passthrough();

export type JsonObject = z.infer<typeof JsonObjectSchema>;
