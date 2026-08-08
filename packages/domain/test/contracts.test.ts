import { describe, expect, it } from 'vitest';
import { CompatibilityMetadataSchema, GenerationRequestSchema } from '../src/index.js';

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
});
