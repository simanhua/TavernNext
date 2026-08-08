import { z } from 'zod';

export const PresetKindSchema = z.enum(['chat', 'text', 'context', 'instruct', 'system', 'reasoning']);
export type PresetKind = z.infer<typeof PresetKindSchema>;

/** The codec intentionally validates only the shared envelope and retains every other field. */
export const PresetDocumentSchema = z.object({
  name: z.string().optional(),
}).passthrough();

export interface ParsedPresetDocument {
  root: Record<string, unknown>;
  document: Record<string, unknown>;
  wrapperKey?: 'preset' | 'settings';
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasFamilyDiscriminator(value: Record<string, unknown>): boolean {
  return [
    'prompts', 'prompt_order', 'story_string', 'input_sequence', 'output_sequence', 'system_sequence',
    'sampler_order', 'samplers', 'prefix', 'separator', 'suffix', 'content', 'post_history',
  ].some((key) => key in value);
}

/**
 * `.preset` and exported settings envelopes may wrap the actual settings.
 * The wrapper is structural: filename extensions are deliberately ignored.
 */
export function parsePresetDocument(value: unknown): ParsedPresetDocument {
  const root = record(value);
  if (root === undefined) throw new Error('preset_root_invalid');
  const parsedRoot = PresetDocumentSchema.parse(root) as Record<string, unknown>;
  if ('preset' in parsedRoot) {
    const document = record(parsedRoot.preset);
    if (document === undefined) throw new Error('preset_wrapper_invalid');
    return { root: parsedRoot, document, wrapperKey: 'preset' };
  }
  if (!hasFamilyDiscriminator(parsedRoot) && 'settings' in parsedRoot) {
    const document = record(parsedRoot.settings);
    if (document === undefined) throw new Error('preset_wrapper_invalid');
    return { root: parsedRoot, document, wrapperKey: 'settings' };
  }
  return { root: parsedRoot, document: parsedRoot };
}
