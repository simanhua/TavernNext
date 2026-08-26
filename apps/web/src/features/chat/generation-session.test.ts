import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../api/client.js';
import { GenerationSessionController } from './generation-session.js';

const mocks = vi.hoisted(() => ({
  createCandidate: vi.fn(),
  sealCandidate: vi.fn(),
  startGeneration: vi.fn(),
  stopGeneration: vi.fn(),
  discardCandidate: vi.fn(),
  trustedHooks: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  api: {
    createGenerationCandidate: mocks.createCandidate,
    sealGenerationCandidate: mocks.sealCandidate,
    startGeneration: mocks.startGeneration,
    stopGeneration: mocks.stopGeneration,
    discardGenerationCandidate: mocks.discardCandidate,
  },
}));

vi.mock('../extensions/TrustedPromptHooks.js', () => ({ runTrustedPromptHooks: mocks.trustedHooks }));

vi.mock('../../api/generation-stream.js', () => ({
  readGenerationEvents: async function* () {
    yield { type: 'started', generationId: 'generation-1' };
    yield { type: 'reasoning_delta', text: 'think' };
    yield { type: 'delta', text: 'hello' };
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
  mocks.createCandidate.mockResolvedValue({
    candidateId: 'candidate-1', kind: 'chat', messages: [], stop: [], spreset: {},
  });
  mocks.trustedHooks.mockResolvedValue({});
  mocks.sealCandidate.mockResolvedValue({ snapshotId: 'snapshot-1' });
  mocks.startGeneration.mockResolvedValue({});
});

describe('GenerationSessionController', () => {
  it('shares the existing generation pipeline while publishing only incremental text events', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new GenerationSessionController({ refreshAuthoritativeState: refresh });
    const events: Array<{ type: string; text?: string }> = [];
    controller.subscribeEvents((event) => events.push(event));

    await expect(controller.start(conversation, { mode: 'normal', userText: 'go' })).resolves.toBe('accepted');

    expect(mocks.createCandidate).toHaveBeenCalledOnce();
    expect(mocks.trustedHooks).toHaveBeenCalledOnce();
    expect(mocks.sealCandidate).toHaveBeenCalledOnce();
    expect(mocks.startGeneration).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(conversation.id);
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'text-delta', text: ' world' },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', streamedText: '', streamedReasoning: '' });
  });

  it('uses the server-owned Scene recipe without sealing a client candidate', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new GenerationSessionController({ refreshAuthoritativeState: refresh });

    await expect(controller.start(sceneConversation, { mode: 'normal', userText: 'go' })).resolves.toBe('accepted');

    expect(mocks.createCandidate).not.toHaveBeenCalled();
    expect(mocks.trustedHooks).not.toHaveBeenCalled();
    expect(mocks.sealCandidate).not.toHaveBeenCalled();
    expect(mocks.startGeneration).toHaveBeenCalledWith(
      sceneConversation,
      { mode: 'normal', userText: 'go' },
      expect.any(AbortSignal),
    );
    expect(refresh).toHaveBeenCalledWith(sceneConversation.id);
  });
});
