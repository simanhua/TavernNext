import type { PresetKind } from './schemas.js';
import { record } from './schemas.js';

const candidateOrder: readonly PresetKind[] = ['chat', 'text', 'context', 'instruct', 'system', 'reasoning'];

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasSamplerShape(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.sampler_order) || Array.isArray(value.samplers)) return true;
  if (typeof value.presetVersion === 'number' && record(value.parameters) !== undefined) return true;
  return ['temperature', 'top_p', 'top_k', 'rep_pen', 'repetition_penalty', 'min_p']
    .filter((key) => typeof value[key] === 'number').length >= 2;
}

export function detectPresetKinds(value: Record<string, unknown>): PresetKind[] {
  const candidates = new Set<PresetKind>();
  const hasChatShape = Array.isArray(value.prompts) && Array.isArray(value.prompt_order);
  if (hasChatShape) candidates.add('chat');
  // ST Chat presets commonly carry sampler knobs too; their prompt shape is the stronger discriminator.
  if (!hasChatShape && hasSamplerShape(value)) candidates.add('text');
  if (isString(value.story_string)) candidates.add('context');
  if (isString(value.input_sequence) && isString(value.output_sequence) && isString(value.system_sequence)) candidates.add('instruct');
  if (isString(value.content) && typeof value.post_history === 'boolean') candidates.add('system');
  if (isString(value.prefix) && isString(value.separator) && isString(value.suffix)) candidates.add('reasoning');
  return candidateOrder.filter((candidate) => candidates.has(candidate));
}

/** A lightweight structural probe for Task 7's generic family detector. */
export function isPresetDocument(value: unknown): boolean {
  const root = record(value);
  if (root === undefined) return false;
  const nested = record(root.preset) ?? (!hasOwnFamilyField(root) ? record(root.settings) : undefined) ?? root;
  return detectPresetKinds(nested).length > 0;
}

function hasOwnFamilyField(value: Record<string, unknown>): boolean {
  return [
    'prompts', 'prompt_order', 'story_string', 'input_sequence', 'output_sequence', 'system_sequence',
    'sampler_order', 'samplers', 'prefix', 'separator', 'suffix', 'content', 'post_history',
  ].some((key) => key in value);
}
