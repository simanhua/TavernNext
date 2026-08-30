import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../api/client.js';
import { GenerationSessionController } from './generation-session.js';

const mocks = vi.hoisted(() => ({
  startGeneration: vi.fn(),
  stopGeneration: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  api: {
    startGeneration: mocks.startGeneration,
    stopGeneration: mocks.stopGeneration,
  },
}));

vi.mock('../../api/generation-stream.js', () => ({
  readGenerationEvents: async function* () {
    yield { type: 'started', generationId: 'generation-1' };
    yield { type: 'reasoning_delta', text: 'think' };
    yield { type: 'delta', text: 'hello' };
    yield { type: 'activity', kind: 'query-lore', label: 'Querying world lore' };
    yield { type: 'view_placeholder', viewId: 'view-1', kind: 'combat' };
    yield { type: 'view_placeholder', viewId: 'view-1', kind: 'combat' };
    yield { type: 'delta', text: ' world' };
    yield { type: 'completed', finishReason: 'stop' };
  },
}));

const conversation = {
  id: '018f0000-0000-7000-8000-000000000001', revision: 0,
  createdAt: '', updatedAt: '', characterId: '018f0000-0000-7000-8000-000000000002',
  personaId: '018f0000-0000-7000-8000-000000000003', title: 'Scene Save', worldbookIds: [],
  maxPromptTokens: 128_000, maxResponseTokens: 32_768,
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
} satisfies Conversation;

const sceneConversation = {
  ...conversation,
  id: '018f0000-0000-7000-8000-000000000004',
  sceneId: '018f0000-0000-7000-8000-000000000005',
} satisfies Conversation;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startGeneration.mockResolvedValue({});
});

describe('GenerationSessionController', () => {
  it('shares the existing generation pipeline while publishing only incremental text events', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new GenerationSessionController({ refreshAuthoritativeState: refresh });
    const events: Array<{ type: string; text?: string; label?: string; offset?: number }> = [];
    controller.subscribeEvents((event) => events.push(event));

    await expect(controller.start(conversation, { mode: 'normal', userText: 'go' })).resolves.toBe('accepted');

    expect(mocks.startGeneration).toHaveBeenCalledWith(
      conversation,
      { mode: 'normal', userText: 'go' },
      expect.any(AbortSignal),
    );
    expect(refresh).toHaveBeenCalledWith(conversation.id);
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'text-delta', text: ' world' },
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'activity', label: 'Querying world lore' }),
      expect.objectContaining({ type: 'view-placeholder', offset: 5 }),
    ]));
    expect(events.filter((event) => event.type === 'view-placeholder')).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle', streamedText: '', streamedReasoning: '', activities: [], viewPlaceholders: [],
    });
  });

  it('uses the same server-owned Agent runtime for Scene saves', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new GenerationSessionController({ refreshAuthoritativeState: refresh });

    await expect(controller.start(sceneConversation, { mode: 'normal', userText: 'go' })).resolves.toBe('accepted');

    expect(mocks.startGeneration).toHaveBeenCalledWith(
      sceneConversation,
      { mode: 'normal', userText: 'go' },
      expect.any(AbortSignal),
    );
    expect(refresh).toHaveBeenCalledWith(sceneConversation.id);
  });
});
