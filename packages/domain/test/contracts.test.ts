import { describe, expect, it } from 'vitest';
import { CharacterSchema, CompatibilityMetadataSchema, ConversationSchema, GenerationRequestSchema } from '../src/index.js';

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

  it('keeps the Worldbook depth prompt in a dedicated typed Character field', () => {
    const character = CharacterSchema.parse({
      id: '018f0000-0000-7000-8000-000000000002', revision: 0,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      name: 'Aster', description: '', personality: '', scenario: '', firstMessage: '',
      alternateGreetings: [], tags: [], depthPrompt: 'Depth only',
      extensions: { depth_prompt: ['malformed legacy value'], arbitrary_export_field: { keep: true } },
    });

    expect(character.depthPrompt).toBe('Depth only');
    expect(character.extensions).toEqual({
      depth_prompt: ['malformed legacy value'], arbitrary_export_field: { keep: true },
    });
  });

  it('defaults to large reasoning-capable token budgets and rejects values above the UI limits', () => {
    const base = {
      id: '018f0000-0000-7000-8000-000000000003', revision: 0,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
      characterId: '018f0000-0000-7000-8000-000000000004',
      personaId: '018f0000-0000-7000-8000-000000000005', title: 'Large context chat',
    };
    expect(ConversationSchema.parse(base)).toMatchObject({
      maxPromptTokens: 128_000,
      maxResponseTokens: 32_768,
    });
    expect(ConversationSchema.safeParse({ ...base, maxPromptTokens: 1_000_001 }).success).toBe(false);
    expect(ConversationSchema.safeParse({ ...base, maxResponseTokens: 384_001 }).success).toBe(false);
  });
});
