import type { Character, Persona, Preset } from '@tavernnext/domain';
import type { PromptTokenizer } from '../src/index.js';

const createdAt = '2026-08-08T00:00:00.000Z';

export function character(overrides: Partial<Character> = {}): Character {
  return {
    id: '018f0000-0000-7000-8000-000000000101',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    name: 'Aster',
    description: 'Guide for {{user}}',
    personality: 'Calm',
    scenario: 'Library',
    firstMessage: 'Hello',
    examples: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: '',
    characterVersion: '',
    alternateGreetings: [],
    tags: [],
    ...overrides,
    depthPrompt: overrides.depthPrompt ?? '',
    extensions: overrides.extensions ?? {},
  };
}

export function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: '018f0000-0000-7000-8000-000000000102',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    name: 'You',
    description: 'Traveler',
    isDefault: true,
    ...overrides,
  };
}

export function preset(kind: Preset['kind'], settings: Record<string, unknown>, overrides: Partial<Preset> = {}): Preset {
  return {
    id: `018f0000-0000-7000-8000-0000000001${kind.length.toString().padStart(2, '0')}`,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    name: `${kind} fixture`,
    kind,
    settings,
    ...overrides,
  };
}

export function unitTokenizer(calls: Array<{ kind: 'text' | 'messages'; value: unknown }> = []): PromptTokenizer {
  return {
    async countText(text) {
      calls.push({ kind: 'text', value: text });
      return text.length === 0 ? 0 : 1;
    },
    async countMessages(messages) {
      calls.push({ kind: 'messages', value: structuredClone(messages) });
      return messages.length;
    },
  };
}
