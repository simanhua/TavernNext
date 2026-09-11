import { WorldbookEntrySchema, WorldbookSchema } from '@tavernnext/domain';
import { z } from 'zod';
import { MAX_ENTRIES_PER_WORLDBOOK } from '../db/repositories.js';

export const BookEditableSchema = WorldbookSchema.pick({
  name: true,
  description: true,
  enabled: true,
  scanDepth: true,
  tokenBudget: true,
  recursiveScanning: true,
  isGlobal: true,
}).strict();
export const BookPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: BookEditableSchema.partial().strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();
export const EntryEditableSchema = WorldbookEntrySchema.pick({
  keys: true,
  secondaryKeys: true,
  useRegex: true,
  selective: true,
  selectiveLogic: true,
  constant: true,
  vectorized: true,
  probability: true,
  useProbability: true,
  group: true,
  groupWeight: true,
  groupOverride: true,
  priority: true,
  content: true,
  enabled: true,
  position: true,
  order: true,
  depth: true,
  role: true,
  ignoreBudget: true,
  scanDepth: true,
  caseSensitive: true,
  matchWholeWords: true,
  useGroupScoring: true,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  sticky: true,
  cooldown: true,
  delay: true,
  characterFilter: true,
  personaFilter: true,
  matchPersonaDescription: true,
  matchCharacterDescription: true,
  matchCharacterPersonality: true,
  matchCharacterDepthPrompt: true,
  matchScenario: true,
  matchCreatorNotes: true,
  comment: true,
  displayName: true,
  addMemo: true,
  displayIndex: true,
  outletName: true,
  automationId: true,
  triggers: true,
}).strict();
export const EntryPatchSchema = z.object({
  revision: z.number().int().nonnegative(),
  patch: EntryEditableSchema.partial().strict().refine((patch) => Object.keys(patch).length > 0),
}).strict();
export const ReorderSchema = z.object({
  entries: z.array(z.object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    order: z.number().int(),
  }).strict()).max(MAX_ENTRIES_PER_WORLDBOOK),
}).strict();

export function explicitPatchFields<T extends Record<string, unknown>>(raw: unknown, parsed: T): Partial<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.keys(raw).flatMap((key) => (
    Object.prototype.hasOwnProperty.call(parsed, key) ? [[key, parsed[key]]] : []
  ))) as Partial<T>;
}

export function rawPatch(body: unknown): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && 'patch' in body
    ? (body as { patch: unknown }).patch
    : undefined;
}
