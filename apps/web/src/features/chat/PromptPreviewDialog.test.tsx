// @vitest-environment jsdom

import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '../../api/client.js';
import { renderWithApp } from '../../test/render.js';
import { PromptPreviewDialog } from './PromptPreviewDialog.js';

const now = '2026-08-08T00:00:00.000Z';
const conversation: Conversation = {
  id: '018f0000-0000-7000-8000-000000000941', revision: 7, createdAt: now, updatedAt: now,
  characterId: '018f0000-0000-7000-8000-000000000942', personaId: '018f0000-0000-7000-8000-000000000943',
  providerId: '018f0000-0000-7000-8000-000000000944', presetId: '018f0000-0000-7000-8000-000000000945',
  title: 'Preview chat', worldbookIds: [], maxPromptTokens: 4096, maxResponseTokens: 4096,
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
};

let previewKind: 'chat' | 'text' = 'chat';
let previewCalls = 0;
let generationCalls = 0;

const timed = {
  messageIndex: 3,
  sticky: [{ entryKey: 'book:42', fingerprint: 'must-not-render-fingerprint', hmac: 'must-not-render-hmac', start: 2, end: 4, protected: true }],
  cooldown: [{ entryKey: 'book:43', fingerprint: 'must-not-render-fingerprint', start: 4, end: 7, protected: false }],
};

const server = setupServer(
  http.post('/api/conversations/:id/prompt-preview', async ({ request }) => {
    previewCalls += 1;
    expect(await request.json()).toEqual({ conversationRevision: 7, mode: 'normal', userText: 'Draft turn' });
    return HttpResponse.json({
      snapshotId: '018f0000-0000-7000-8000-000000000946',
      kind: previewKind,
      ...(previewKind === 'chat'
        ? { messages: [{ role: 'system', content: 'You are Aster.' }, { role: 'user', content: 'Draft turn' }] }
        : { text: 'SYSTEM\nYou are Aster.\nUSER\nDraft turn\nASSISTANT\n' }),
      stop: ['<END>', 'Traveler:', '\nUser:  '],
      tokenBreakdown: [
        { source: 'character', includedTokens: 12, omittedTokens: 0 },
        { source: 'history', includedTokens: 7, omittedTokens: 2, reason: 'history_budget' },
      ],
      totalTokens: 19,
      tokenizerDecision: {
        requestedId: 99, tokenizerId: 12, tokenizerName: 'Llama 3', model: 'missing-command-r',
        fallbackFrom: 16, fallbackTokenizerId: 12, warning: 'Command R tokenizer unavailable; estimated with Llama 3.',
      },
      worldbook: {
        activated: [{ entryKey: 'book:42', bookName: 'Archive Lore', sourceUid: 42, content: 'The archive remembers.', activation: 'keyword', tokenUsageAfter: 6 }],
        excluded: [{ entryKey: 'book:99', bookId: 'book', sourceUid: 99, sourceOrdinal: 1, reason: 'budget' }],
        timedState: timed,
        tokenUsage: { budget: 64, used: 6, overflowed: false }, recursionSteps: 1,
        warnings: [{ code: 'unsafe_regex', message: 'One regex was excluded.' }],
      },
      previousTimedState: {
        messageIndex: 2,
        sticky: [{ entryKey: 'book:40', fingerprint: 'must-not-render-fingerprint', start: 0, end: 2, protected: false }],
        cooldown: [{ entryKey: 'book:41', hmac: 'must-not-render-hmac', start: 1, end: 3, protected: true }],
      },
      warnings: [{ code: 'compatibility_warning', message: 'A future field is preserved.', source: 'character' }],
      entityRevisions: {
        globalGenerationConfig: { id: '018f0000-0000-7000-8000-000000000001', revision: 0 },
        conversation: { id: conversation.id, revision: 7 },
        character: { id: conversation.characterId, revision: 2 },
        persona: { id: conversation.personaId, revision: 1 },
        provider: { id: conversation.providerId, revision: 0 },
        presets: [{ id: conversation.presetId, revision: 4, kind: 'chat' }],
        globalWorldbooks: [], worldbooks: [], messages: [], runtimeState: null,
      },
      payloadHash: 'must-not-render-payload-hash',
      compiledRequestHash: 'must-not-render-request-hash',
      executable: { apiKey: 'must-not-render-secret' },
    }, { status: 201 });
  }),
  http.post('/api/conversations/:id/generations', () => {
    generationCalls += 1;
    return HttpResponse.json({ error: 'must_not_call' }, { status: 500 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  previewKind = 'chat';
  previewCalls = 0;
  generationCalls = 0;
});
afterAll(() => server.close());

describe('PromptPreviewDialog', () => {
  it('renders the exact Chat prompt and complete read-only decision ledgers without internal audit data', async () => {
    const user = userEvent.setup();
    renderWithApp(<PromptPreviewDialog conversation={conversation} userText="Draft turn" />);
    await user.click(screen.getByRole('button', { name: 'Preview prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt Preview' });

    expect(within(dialog).getByText('Chat prompt')).not.toBeNull();
    expect(within(dialog).getByText('system')).not.toBeNull();
    expect(within(dialog).getByText('You are Aster.')).not.toBeNull();
    expect(within(dialog).getByText('"<END>"')).not.toBeNull();
    expect(within(dialog).getByText('Llama 3 · ID 12')).not.toBeNull();
    expect(within(dialog).getByText('Requested tokenizer ID 99')).not.toBeNull();
    expect(within(dialog).getByText('Fallback decision: ID 16 → ID 12')).not.toBeNull();
    expect(within(dialog).getByText('Model missing-command-r')).not.toBeNull();
    expect(within(dialog).getByText(/estimated with Llama 3/)).not.toBeNull();
    expect(within(dialog).getByText('19 total tokens')).not.toBeNull();
    expect(within(dialog).getByText('character: 12 included / 0 omitted')).not.toBeNull();
    expect(within(dialog).getByText('Archive Lore · UID 42')).not.toBeNull();
    expect(within(dialog).getByText('book:99 · budget')).not.toBeNull();
    expect(within(dialog).getByText('Previous timed state · message 2')).not.toBeNull();
    expect(within(dialog).getByText('Previous: 1 sticky · 1 cooldown')).not.toBeNull();
    expect(within(dialog).getByText('Next timed state · message 3')).not.toBeNull();
    expect(within(dialog).getByText('Next: 1 sticky · 1 cooldown')).not.toBeNull();
    expect(within(dialog).getByRole('list', { name: 'Previous sticky entries' }).textContent).toContain('book:40');
    expect(within(dialog).getByRole('list', { name: 'Previous sticky entries' }).textContent).toContain('start 0 · end 2 · protected no');
    expect(within(dialog).getByRole('list', { name: 'Previous cooldown entries' }).textContent).toContain('book:41');
    expect(within(dialog).getByRole('list', { name: 'Previous cooldown entries' }).textContent).toContain('start 1 · end 3 · protected yes');
    expect(within(dialog).getByRole('list', { name: 'Next sticky entries' }).textContent).toContain('book:42');
    expect(within(dialog).getByRole('list', { name: 'Next sticky entries' }).textContent).toContain('start 2 · end 4 · protected yes');
    expect(within(dialog).getByRole('list', { name: 'Next cooldown entries' }).textContent).toContain('book:43');
    expect(within(dialog).getByRole('list', { name: 'Next cooldown entries' }).textContent).toContain('start 4 · end 7 · protected no');
    expect(within(dialog).getByText('A future field is preserved.')).not.toBeNull();
    expect(within(dialog).getByText('Conversation r7 · Character r2 · Persona r1 · Provider r0')).not.toBeNull();
    expect(within(dialog).getByText('Presets: chat r4')).not.toBeNull();
    expect(within(dialog).getByText('0 global Worldbooks · 0 linked Worldbooks · 0 messages')).not.toBeNull();
    expect(within(dialog).queryByText('must-not-render-payload-hash')).toBeNull();
    expect(within(dialog).queryByText('must-not-render-secret')).toBeNull();
    expect(dialog.textContent).not.toContain('must-not-render-fingerprint');
    expect(dialog.textContent).not.toContain('must-not-render-hmac');
    expect(generationCalls).toBe(0);

    await user.click(within(dialog).getByRole('button', { name: 'Close Prompt Preview' }));
    expect(previewCalls).toBe(1);
    expect(generationCalls).toBe(0);
  });

  it('renders the exact Text prompt read-only', async () => {
    const user = userEvent.setup();
    previewKind = 'text';
    renderWithApp(<PromptPreviewDialog conversation={conversation} userText="Draft turn" />);
    await user.click(screen.getByRole('button', { name: 'Preview prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt Preview' });
    expect(within(dialog).getByText('Text prompt')).not.toBeNull();
    expect(within(dialog).getByLabelText('Compiled text prompt').textContent).toContain('SYSTEM\nYou are Aster.\nUSER');
    expect(generationCalls).toBe(0);
  });

  it('renders whitespace-sensitive stop strings as an exact escaped representation', async () => {
    const user = userEvent.setup();
    renderWithApp(<PromptPreviewDialog conversation={conversation} userText="Draft turn" />);
    await user.click(screen.getByRole('button', { name: 'Preview prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt Preview' });

    const exactStop = within(dialog).getByText((_content, element) => (
      element?.tagName === 'CODE' && element.textContent === JSON.stringify('\nUser:  ')
    ));
    expect(exactStop.textContent).toBe(JSON.stringify('\nUser:  '));
  });
});
