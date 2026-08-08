import { z } from 'zod';

const UnknownObjectSchema = z.record(z.string(), z.unknown());
const StringArraySchema = z.array(z.string());

export const CharacterDataSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  creator_notes: z.string().optional(),
  system_prompt: z.string().optional(),
  post_history_instructions: z.string().optional(),
  alternate_greetings: StringArraySchema.optional(),
  tags: StringArraySchema.optional(),
  creator: z.string().optional(),
  character_version: z.string().optional(),
  extensions: UnknownObjectSchema.optional(),
  character_book: UnknownObjectSchema.optional(),
}).passthrough();

export const CharacterCardV1Schema = CharacterDataSchema.extend({
  creatorcomment: z.string().optional(),
}).passthrough();

export const CharacterCardV2Schema = z.object({
  spec: z.literal('chara_card_v2'),
  spec_version: z.union([z.literal('2.0'), z.number().refine((value) => value === 2)]),
  data: CharacterDataSchema,
}).passthrough();

export const CharacterCardV3Schema = z.object({
  spec: z.literal('chara_card_v3'),
  spec_version: z.union([z.string(), z.number()]).refine((value) => {
    const version = Number(value);
    return Number.isFinite(version) && version >= 3 && version < 4;
  }),
  data: CharacterDataSchema,
}).passthrough();

export type CharacterDataSource = z.infer<typeof CharacterDataSchema>;

export interface ParsedCharacterDocument {
  version: string;
  topLevel: Record<string, unknown>;
  data: CharacterDataSource;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseCharacterDocument(value: unknown): ParsedCharacterDocument {
  const object = record(value);
  if (object === undefined) throw new Error('Character Card root must be an object');
  if (object.spec === 'chara_card_v2') {
    const card = CharacterCardV2Schema.parse(object);
    return { version: '2.0', topLevel: card, data: card.data };
  }
  if (object.spec === 'chara_card_v3') {
    const card = CharacterCardV3Schema.parse(object);
    return { version: String(card.spec_version), topLevel: card, data: card.data };
  }
  if (typeof object.spec === 'string' && object.spec.startsWith('chara_card_')) {
    throw new Error(`Unsupported Character Card spec: ${object.spec}`);
  }
  const card = CharacterCardV1Schema.parse(object);
  return { version: '1', topLevel: card, data: card };
}
