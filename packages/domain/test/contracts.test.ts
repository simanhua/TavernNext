import { describe, expect, it } from 'vitest';
import { CharacterSchema, CompatibilityMetadataSchema, GenerationRequestSchema } from '../src/index.js';

describe('domain contracts', () => {
  it('retains unknown compatibility fields verbatim', () => {
    const metadata = CompatibilityMetadataSchema.parse({
      sourceFormat: 'st-character-v3',
      rawPayload: { future: true },
      unknownFields: { future: true },
      compatWarnings: [],
      parserVersion: '1',
    });

    expect(metadata.unknownFields).toEqual({ future: true });
  });

  it('accepts every planned generation mode', () => {
    expect(GenerationRequestSchema.parse({
      conversationId: '018f0000-0000-7000-8000-000000000001',
      conversationRevision: 3,
      mode: 'swipe',
    }).mode).toBe('swipe');
  });

  it('retains typed Character extensions including the Worldbook depth prompt', () => {
    const character = CharacterSchema.parse({
      id: '018f0000-0000-7000-8000-000000000002', revision: 0,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [], extensions: { depth_prompt: { prompt: 'Depth only' } },
    });

    expect(character.extensions).toEqual({ depth_prompt: { prompt: 'Depth only' } });
  });
});
