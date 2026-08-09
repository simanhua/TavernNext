// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Conversation } from './client.js';

const now = '2026-08-08T00:00:00.000Z';
const conversation: Conversation = {
  id: '018f0000-0000-7000-8000-000000000901', revision: 3, createdAt: now, updatedAt: now,
  characterId: '018f0000-0000-7000-8000-000000000902', personaId: '018f0000-0000-7000-8000-000000000903',
  providerId: '018f0000-0000-7000-8000-000000000904', presetId: '018f0000-0000-7000-8000-000000000905',
  title: 'Projection test', worldbookIds: [], maxPromptTokens: 4096, maxResponseTokens: 512,
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('prompt preview client boundary', () => {
  it('projects the audit response to the read-only UI DTO before returning it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      snapshotId: '018f0000-0000-7000-8000-000000000906',
      kind: 'chat',
      messages: [{ role: 'system', content: 'Safe prompt' }],
      stop: ['<END>'],
      tokenBreakdown: [{ source: 'character', includedTokens: 2, omittedTokens: 0 }],
      totalTokens: 2,
      tokenizerDecision: { tokenizerId: 12, tokenizerName: 'Llama 3' },
      worldbook: {
        activated: [], excluded: [], timedState: { messageIndex: 1, sticky: [], cooldown: [] },
        tokenUsage: { budget: 64, used: 0, overflowed: false }, recursionSteps: 0, warnings: [],
      },
      warnings: [],
      entityRevisions: {
        conversation: { id: conversation.id, revision: 3 },
        character: { id: conversation.characterId, revision: 2 },
        persona: { id: conversation.personaId, revision: 1 },
        provider: { id: conversation.providerId, revision: 0 },
        presets: [{ id: conversation.presetId, revision: 4, kind: 'chat' }],
      },
      payloadHash: 'must-not-cross-ui-boundary',
      compiledRequestHash: 'must-not-cross-ui-boundary',
      executable: { apiKey: 'must-not-cross-ui-boundary' },
    }), { status: 201, headers: { 'content-type': 'application/json' } })));

    const preview = await api.previewPrompt(conversation, 'Draft');

    expect(preview).not.toHaveProperty('payloadHash');
    expect(preview).not.toHaveProperty('compiledRequestHash');
    expect(preview).not.toHaveProperty('executable');
    expect(preview.entityRevisions.conversation).toEqual({ revision: 3 });
    expect(preview.messages).toEqual([{ role: 'system', content: 'Safe prompt' }]);
  });
});
