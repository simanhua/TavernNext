// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage.js';
import { useChatUi } from './chat-store.js';
import type { Conversation } from '../../api/client.js';
import { I18nProvider } from '../../app/i18n.js';

const now = '2026-08-08T00:00:00.000Z';
const ids = {
  character: '018f0000-0000-7000-8000-000000000101',
  persona: '018f0000-0000-7000-8000-000000000102',
  conversation: '018f0000-0000-7000-8000-000000000103',
  otherConversation: '018f0000-0000-7000-8000-000000000104',
  userMessage: '018f0000-0000-7000-8000-000000000105',
  assistantMessage: '018f0000-0000-7000-8000-000000000106',
  assistantVariant: '018f0000-0000-7000-8000-000000000107',
  assistantSibling: '018f0000-0000-7000-8000-000000000110',
  generatedVariant: '018f0000-0000-7000-8000-000000000111',
  provider: '018f0000-0000-7000-8000-000000000108',
  chatPreset: '018f0000-0000-7000-8000-000000000109',
  importedConversation: '018f0000-0000-7000-8000-000000000112',
};

const character = {
  id: ids.character, revision: 0, createdAt: now, updatedAt: now,
  name: 'Aster', description: 'An archivist', personality: '', scenario: '', firstMessage: '',
  alternateGreetings: [], tags: [],
};
const persona = {
  id: ids.persona, revision: 0, createdAt: now, updatedAt: now,
  name: 'Traveler', description: 'A curious visitor', isDefault: true,
};
const provider = {
  id: ids.provider, revision: 0, createdAt: now, updatedAt: now,
  name: 'Local Chat', baseUrl: 'http://127.0.0.1:8080/v1', model: 'mock', apiMode: 'chat', hasApiKey: false,
};
const chatPreset = {
  id: ids.chatPreset, revision: 0, createdAt: now, updatedAt: now,
  name: 'Role Chat', kind: 'chat', settings: {},
};
const otherConversation: Conversation = {
  id: ids.otherConversation, revision: 0, createdAt: now, updatedAt: now,
  characterId: ids.character, personaId: ids.persona, providerId: ids.provider, presetId: ids.chatPreset,
  title: 'Saved chat', worldbookIds: [], maxPromptTokens: 4096, maxResponseTokens: 512,
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
};
const conversation: Conversation = {
  id: ids.conversation, revision: 0, createdAt: now, updatedAt: now,
  characterId: ids.character, personaId: ids.persona, providerId: ids.provider, presetId: ids.chatPreset,
  title: 'Aster chat', worldbookIds: [], maxPromptTokens: 4096, maxResponseTokens: 512,
  authorNote: '', authorNotePosition: 1, authorNoteDepth: 4, authorNoteRole: 0,
};

type MessageView = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant';
  speakerLabel?: string;
  content: string;
  activeVariantId: string | null;
  variants: Array<{
    id: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    messageId: string;
    ordinal?: number;
    content: string;
    status: 'completed' | 'aborted';
    finishReason?: string;
  }>;
};

let conversations = [otherConversation];
let conversationRevision = 0;
let messages: MessageView[] = [];
let generationCount = 0;
let conversationCreateCount = 0;
let seedGreetingOnCreate = false;
let stopRequests = 0;
let abortedRequests = 0;
let holdFirstGeneration = false;
let conversationCreateFailure = false;
let generationNetworkFailure = false;
let generationStartupFailureStatus: 409 | 422 | undefined;
let generationAcceptedFailure = false;
let messagePatchConflict = false;
let messageDeleteFailure = false;
let conversationConfigurationPatches = 0;
let requestedGenerationModes: string[] = [];
let activeVariantSwitches: string[] = [];
let promptPreviewRequests = 0;
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
let chatImportBlocking = false;
let chatImportExpired = false;
let chatCommitBodies: Array<Record<string, unknown>> = [];
let chatExportRequests = 0;
const encoder = new TextEncoder();
const frame = (type: string, data: object = {}) => encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

const server = setupServer(
  http.get('/api/characters', () => HttpResponse.json([character])),
  http.get('/api/personas', () => HttpResponse.json([persona])),
  http.get('/api/providers', () => HttpResponse.json([provider])),
  http.get('/api/presets', () => HttpResponse.json([chatPreset])),
  http.get('/api/conversations', () => HttpResponse.json(conversations)),
  http.post('/api/conversations', async ({ request }) => {
    if (conversationCreateFailure) return HttpResponse.error();
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      characterId: ids.character, personaId: ids.persona,
      providerId: ids.provider, presetId: ids.chatPreset,
    });
    conversationCreateCount += 1;
    conversations = [otherConversation, conversation];
    if (seedGreetingOnCreate) {
      messages = [{
        id: ids.assistantMessage, revision: 1, createdAt: now, updatedAt: now,
        conversationId: ids.conversation, role: 'assistant', content: 'Greeting A', activeVariantId: ids.assistantVariant,
        variants: [
          { id: ids.assistantVariant, revision: 0, createdAt: now, updatedAt: now, messageId: ids.assistantMessage, ordinal: 0, content: 'Greeting A', status: 'completed', finishReason: 'stop' },
          { id: ids.assistantSibling, revision: 0, createdAt: now, updatedAt: now, messageId: ids.assistantMessage, ordinal: 1, content: 'Greeting B', status: 'completed', finishReason: 'stop' },
        ],
      }];
    }
    return HttpResponse.json(conversation, { status: 201 });
  }),
  http.patch('/api/conversations/:id', async ({ request }) => {
    const body = await request.json() as { revision: number; patch: Record<string, unknown> };
    expect(body.patch).toMatchObject({ providerId: ids.provider, presetId: ids.chatPreset });
    conversationConfigurationPatches += 1;
    conversationRevision += 1;
    const configured = { ...conversation, ...body.patch, revision: conversationRevision };
    conversations = conversations.map((item) => item.id === conversation.id ? configured : item);
    return HttpResponse.json(configured);
  }),
  http.get('/api/conversations/:id/messages', ({ params }) => {
    if (params.id === ids.otherConversation) {
      return HttpResponse.json({
        conversation: otherConversation,
        messages: [{
          id: '018f0000-0000-7000-8000-000000000201', revision: 0, createdAt: now, updatedAt: now,
          conversationId: ids.otherConversation, role: 'assistant', content: '',
          activeVariantId: '018f0000-0000-7000-8000-000000000202',
          variants: [{
            id: '018f0000-0000-7000-8000-000000000202', revision: 0, createdAt: now, updatedAt: now,
            messageId: '018f0000-0000-7000-8000-000000000201', content: 'Old persisted answer',
            status: 'completed', finishReason: 'stop',
          }],
        }],
      });
    }
    return HttpResponse.json({
      conversation: { ...conversation, revision: conversationRevision },
      messages,
    });
  }),
  http.post('/api/conversations/:id/prompt-preview', async ({ request }) => {
    promptPreviewRequests += 1;
    expect(await request.json()).toEqual({ conversationRevision, mode: 'normal', userText: 'Preview me' });
    return HttpResponse.json({
      snapshotId: '018f0000-0000-7000-8000-000000000119', kind: 'chat',
      messages: [{ role: 'system', content: 'Preview from ChatPage' }], stop: [], tokenBreakdown: [], totalTokens: 3,
      tokenizerDecision: { requestedId: 12, tokenizerId: 12, tokenizerName: 'Llama 3' },
      worldbook: {
        activated: [], excluded: [], timedState: { messageIndex: 0, sticky: [], cooldown: [] },
        tokenUsage: { budget: 0, used: 0, overflowed: false }, recursionSteps: 1, warnings: [],
      },
      previousTimedState: { messageIndex: null, sticky: [], cooldown: [] }, warnings: [],
      entityRevisions: {
        conversation: { id: ids.conversation, revision: conversationRevision },
        character: { id: ids.character, revision: 0 }, persona: { id: ids.persona, revision: 0 },
        provider: { id: ids.provider, revision: 0 }, presets: [], globalWorldbooks: [], worldbooks: [], messages: [], runtimeState: null,
      },
    }, { status: 201 });
  }),
  http.post('/api/conversations/:id/generations', async ({ request }) => {
    if (generationNetworkFailure) return HttpResponse.error();
    if (generationStartupFailureStatus !== undefined) {
      return HttpResponse.json({ error: `startup_${generationStartupFailureStatus}` }, { status: generationStartupFailureStatus });
    }
    generationCount += 1;
    const body = await request.json() as Record<string, unknown>;
    const mode = String(body.mode);
    requestedGenerationModes.push(mode);
    expect(body).toMatchObject({ conversationRevision, mode });
    request.signal.addEventListener('abort', () => { abortedRequests += 1; }, { once: true });
    if (mode === 'normal') {
      conversationRevision += 1;
      messages.push({
        id: generationCount === 1 ? ids.userMessage : `018f0000-0000-7000-8000-00000000030${generationCount}`,
        revision: 0, createdAt: now, updatedAt: now, conversationId: ids.conversation,
        role: 'user', content: String(body.userText), activeVariantId: null, variants: [],
      });
    }

    const delta = mode === 'regenerate'
      ? 'Third answer'
      : mode === 'continue'
        ? ' continued'
        : generationCount === 1 && !holdFirstGeneration
          ? 'Hello'
          : 'Partial answer';
    const commitNonNormal = () => {
      const assistant = messages.find((message) => message.id === ids.assistantMessage)!;
      if (mode === 'regenerate') {
        assistant.variants.push({
          id: ids.generatedVariant, revision: 1, createdAt: now, updatedAt: now,
          messageId: assistant.id, content: delta, status: 'completed', finishReason: 'stop',
        });
        assistant.activeVariantId = ids.generatedVariant;
        assistant.revision += 1;
      } else if (mode === 'continue') {
        const active = assistant.variants.find((variant) => variant.id === assistant.activeVariantId)!;
        active.content += delta;
        active.revision += 1;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame('started', { generationId: `generation-${generationCount}` }));
        if (generationAcceptedFailure) {
          controller.enqueue(frame('delta', { text: 'Accepted partial' }));
          controller.enqueue(frame('failed', { code: 'accepted_stream_failed' }));
          controller.close();
          return;
        }
        const completesImmediately = !holdFirstGeneration && (mode !== 'normal' || generationCount === 1);
        if (completesImmediately) {
          if (mode === 'normal') {
            controller.enqueue(frame('delta', { text: 'Hel' }));
            controller.enqueue(frame('delta', { text: 'lo' }));
          } else {
            controller.enqueue(frame('delta', { text: delta }));
            commitNonNormal();
          }
          if (mode === 'normal') {
          const responseMessageId = seedGreetingOnCreate ? '018f0000-0000-7000-8000-000000000131' : ids.assistantMessage;
          const responseVariantId = seedGreetingOnCreate ? '018f0000-0000-7000-8000-000000000132' : ids.assistantVariant;
          messages.push({
            id: responseMessageId, revision: 1, createdAt: now, updatedAt: now,
            conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: responseVariantId,
            variants: [{
              id: responseVariantId, revision: 1, createdAt: now, updatedAt: now,
              messageId: responseMessageId, content: 'Hello', status: 'completed', finishReason: 'stop',
            }],
          });
          }
          controller.enqueue(frame('usage', { inputTokens: 4, outputTokens: 1 }));
          controller.enqueue(frame('completed', { finishReason: 'stop' }));
          controller.close();
        } else {
          controller.enqueue(frame('delta', { text: delta }));
          activeStream = controller;
        }
      },
    });
    return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
  }),
  http.put('/api/messages/:id/active-variant', async ({ params, request }) => {
    const body = await request.json() as { revision: number; variantId: string };
    const target = messages.find((message) => message.id === params.id)!;
    const variant = target.variants.find((candidate) => candidate.id === body.variantId);
    if (variant === undefined) return HttpResponse.json({ error: 'variant_ownership_conflict' }, { status: 409 });
    if (target.revision !== body.revision) return HttpResponse.json({ error: 'conflict' }, { status: 409 });
    activeVariantSwitches.push(body.variantId);
    target.activeVariantId = body.variantId;
    target.revision += 1;
    return HttpResponse.json(target);
  }),
  http.delete('/api/generations/:id', () => {
    stopRequests += 1;
    messages.push({
      id: '018f0000-0000-7000-8000-000000000401', revision: 1, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'assistant', content: '',
      activeVariantId: '018f0000-0000-7000-8000-000000000402',
      variants: [{
        id: '018f0000-0000-7000-8000-000000000402', revision: 1, createdAt: now, updatedAt: now,
        messageId: '018f0000-0000-7000-8000-000000000401', content: 'Partial answer', status: 'aborted',
      }],
    });
    activeStream?.enqueue(frame('aborted'));
    activeStream?.close();
    activeStream = undefined;
    return HttpResponse.json({ status: 'cancelling' }, { status: 202 });
  }),
  http.patch('/api/messages/:id', async ({ params, request }) => {
    if (messagePatchConflict) return HttpResponse.json({ error: 'revision_conflict' }, { status: 409 });
    const body = await request.json() as { revision: number; patch: { content: string } };
    const target = messages.find((message) => message.id === params.id)!;
    target.content = body.patch.content;
    target.revision += 1;
    return HttpResponse.json(target);
  }),
  http.delete('/api/messages/:id', ({ params }) => {
    if (messageDeleteFailure) return HttpResponse.error();
    messages = messages.filter((message) => message.id !== params.id);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/imports/inspect', () => HttpResponse.json({
    source: { fileName: 'import.jsonl', mediaType: 'application/x-ndjson', size: 10, sha256: 'chat-sha' },
    detected: { container: 'jsonl', kind: 'chat', candidates: ['chat'] },
    normalizedPreview: { header: { userName: 'Traveler', characterName: 'Aster' }, messages: [] },
    warnings: [],
    blockingErrors: chatImportBlocking ? [{ code: 'chat_blocked', message: 'Blocked chat fixture' }] : [],
    ...(chatImportBlocking ? {} : { inspectionToken: 'chat-inspection-token', expiresAt: '2026-08-09T01:00:00.000Z' }),
  }, { status: chatImportBlocking ? 422 : 200 })),
  http.post('/api/chats/imports/commit', async ({ request }) => {
    if (chatImportExpired) return HttpResponse.json({ error: 'inspection_token_expired' }, { status: 410 });
    const body = await request.json() as Record<string, unknown>;
    chatCommitBodies.push(body);
    conversations.push({
      ...conversation,
      id: ids.importedConversation,
      title: String(body.title),
      characterId: String(body.characterId),
      personaId: String(body.personaId),
    });
    return HttpResponse.json({ artifactId: '018f0000-0000-7000-8000-000000000113', entityId: ids.importedConversation }, { status: 201 });
  }),
  http.get('/api/conversations/:id/export', () => {
    chatExportRequests += 1;
    return new HttpResponse('{"user_name":"Traveler","character_name":"Aster"}\n', {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="chat.jsonl"',
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  conversations = [otherConversation];
  conversationRevision = 0;
  messages = [];
  generationCount = 0;
  conversationCreateCount = 0;
  seedGreetingOnCreate = false;
  stopRequests = 0;
  abortedRequests = 0;
  holdFirstGeneration = false;
  conversationCreateFailure = false;
  generationNetworkFailure = false;
  generationStartupFailureStatus = undefined;
  generationAcceptedFailure = false;
  messagePatchConflict = false;
  messageDeleteFailure = false;
  conversationConfigurationPatches = 0;
  requestedGenerationModes = [];
  activeVariantSwitches = [];
  promptPreviewRequests = 0;
  activeStream = undefined;
  chatImportBlocking = false;
  chatImportExpired = false;
  chatCommitBodies = [];
  chatExportRequests = 0;
  useChatUi.setState({ activeConversationId: null, draft: '' });
});
afterAll(() => server.close());

function renderChatPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('ChatPage', () => {
  it('starts one persisted chat, shows and switches its greeting before the first provider request, then sends in place', async () => {
    const user = userEvent.setup();
    seedGreetingOnCreate = true;
    renderChatPage();

    await screen.findByRole('option', { name: 'Traveler' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), ids.provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat preset' }), ids.chatPreset);
    await user.dblClick(screen.getByRole('button', { name: 'Start chat' }));

    expect(await screen.findByText('Greeting A')).not.toBeNull();
    expect(screen.getByText('1 / 2')).not.toBeNull();
    expect(conversationCreateCount).toBe(1);
    expect(generationCount).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Next variant' }));
    expect(await screen.findByText('Greeting B')).not.toBeNull();
    expect(screen.getByText('2 / 2')).not.toBeNull();
    expect(activeVariantSwitches).toEqual([ids.assistantSibling]);
    expect(generationCount).toBe(0);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'First question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Hello');
    expect(conversationCreateCount).toBe(1);
    expect(generationCount).toBe(1);
    expect(messages.filter((message) => message.id === ids.assistantMessage)).toHaveLength(1);
    expect(messages.find((message) => message.id === ids.assistantMessage)?.activeVariantId).toBe(ids.assistantSibling);
  });

  it('opens Prompt Preview for the configured conversation without starting generation', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    useChatUi.setState({ activeConversationId: conversation.id, draft: 'Preview me' });
    renderChatPage();

    await user.click(await screen.findByRole('button', { name: 'Preview prompt' }));
    expect(await screen.findByText('Preview from ChatPage')).not.toBeNull();
    expect(promptPreviewRequests).toBe(1);
    expect(generationCount).toBe(0);
    expect(conversationRevision).toBe(0);
  });

  it('persists per-message Swipe selection and exposes Regenerate and Continue without a user turn', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    messages = [{
      id: ids.assistantMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: ids.assistantVariant,
      variants: [
        {
          id: ids.assistantSibling, revision: 0, createdAt: now, updatedAt: now,
          messageId: ids.assistantMessage, ordinal: 1, content: 'Second answer', status: 'completed', finishReason: 'stop',
        },
        {
          id: ids.assistantVariant, revision: 0, createdAt: now, updatedAt: now,
          messageId: ids.assistantMessage, ordinal: 0, content: 'First answer', status: 'completed', finishReason: 'stop',
        },
      ],
    }];
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();

    expect(await screen.findByText('First answer')).not.toBeNull();
    expect(screen.getByText('1 / 2')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next variant' }));
    expect(await screen.findByText('Second answer')).not.toBeNull();
    expect(activeVariantSwitches).toEqual([ids.assistantSibling]);
    expect(generationCount).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Regenerate response' }));
    expect(await screen.findByText('Third answer')).not.toBeNull();
    expect(requestedGenerationModes).toEqual(['regenerate']);
    expect(messages).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Continue response' }));
    expect(await screen.findByText('Third answer continued')).not.toBeNull();
    expect(requestedGenerationModes).toEqual(['regenerate', 'continue']);
    expect(messages).toHaveLength(1);
    expect(conversationRevision).toBe(0);
  });

  it('persists selected configuration before non-normal generation on an imported conversation', async () => {
    const user = userEvent.setup();
    const imported = { ...conversation, providerId: undefined, presetId: undefined };
    conversations = [imported];
    messages = [{
      id: ids.assistantMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: ids.assistantVariant,
      variants: [{
        id: ids.assistantVariant, revision: 0, createdAt: now, updatedAt: now,
        messageId: ids.assistantMessage, content: 'Imported answer', status: 'completed', finishReason: 'stop',
      }, {
        id: ids.assistantSibling, revision: 0, createdAt: now, updatedAt: now,
        messageId: ids.assistantMessage, content: 'Second imported answer', status: 'completed', finishReason: 'stop',
      }],
    }];
    useChatUi.setState({ activeConversationId: imported.id, draft: '' });
    renderChatPage();

    const regenerate = await screen.findByRole('button', { name: 'Regenerate response' });
    expect((regenerate as HTMLButtonElement).disabled).toBe(true);
    const next = screen.getByRole('button', { name: 'Next variant' });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    await user.click(next);
    expect(await screen.findByText('Second imported answer')).not.toBeNull();
    expect(activeVariantSwitches).toEqual([ids.assistantSibling]);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), ids.provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat preset' }), ids.chatPreset);
    expect((regenerate as HTMLButtonElement).disabled).toBe(false);
    await user.click(regenerate);

    await waitFor(() => expect(conversationConfigurationPatches).toBe(1));
    expect(await screen.findByText('Third answer')).not.toBeNull();
    expect(requestedGenerationModes).toEqual(['regenerate']);
    expect(conversationRevision).toBe(1);
  });

  it('hides assistant generation controls when the persisted tail message is not that assistant', async () => {
    conversations = [conversation];
    messages = [{
      id: ids.assistantMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: ids.assistantVariant,
      variants: [{
        id: ids.assistantVariant, revision: 0, createdAt: now, updatedAt: now,
        messageId: ids.assistantMessage, content: 'Earlier answer', status: 'completed', finishReason: 'stop',
      }],
    }, {
      id: ids.userMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'user', content: 'Accepted user tail', activeVariantId: null, variants: [],
    }];
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();

    expect(await screen.findByText('Earlier answer')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous variant' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next variant' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate response' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue response' })).toBeNull();
  });

  it('creates, streams, stops, edits, deletes, and switches persisted chats', async () => {
    const user = userEvent.setup();
    renderChatPage();

    const composer = await screen.findByRole('textbox', { name: 'Message' });
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);

    await screen.findByRole('option', { name: 'Aster' });
    await screen.findByRole('option', { name: 'Traveler' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Persona' }), ids.persona);
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), ids.provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat preset' }), ids.chatPreset);
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);

    await user.type(composer, 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findAllByText('Hello')).toHaveLength(2);
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));

    await user.type(composer, 'Again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Partial answer')).not.toBeNull();
    expect((screen.getByRole('combobox', { name: 'Conversation' }) as HTMLSelectElement).disabled).toBe(true);
    const stop = screen.getByRole('button', { name: 'Stop' });
    await user.click(stop);
    fireEvent.click(stop);
    expect(stopRequests).toBe(1);
    await waitFor(() => expect((composer as HTMLTextAreaElement).disabled).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Edit user message Hello' }));
    const editor = screen.getByRole('textbox', { name: 'Edit message' });
    await user.clear(editor);
    await user.type(editor, 'Hello edited');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Hello edited')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete assistant message Hello' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete assistant message Hello' })).toBeNull());

    await user.selectOptions(screen.getByRole('combobox', { name: 'Conversation' }), ids.otherConversation);
    expect(await screen.findByText('Old persisted answer')).not.toBeNull();
  });

  it('configures a migrated conversation explicitly before its first generation', async () => {
    const user = userEvent.setup();
    const migrated = {
      ...conversation,
      providerId: undefined,
      presetId: undefined,
    };
    conversations = [migrated];
    useChatUi.setState({ activeConversationId: migrated.id, draft: '' });
    renderChatPage();

    const composer = await screen.findByRole('textbox', { name: 'Message' });
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), ids.provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat preset' }), ids.chatPreset);
    await user.type(composer, 'Configure then send');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(conversationConfigurationPatches).toBe(1));
    expect(generationCount).toBe(1);
  });

  it('aborts one in-flight request on navigation and can generate in the same conversation after returning', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    holdFirstGeneration = true;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/']}>
            <Link to="/">Chat</Link>
            <Link to="/away">Away</Link>
            <Routes>
              <Route path="/" element={<ChatPage />} />
              <Route path="/away" element={<h1>Away</h1>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByRole('heading', { name: 'Aster chat' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Before navigation');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Partial answer')).not.toBeNull();

    await user.click(screen.getByRole('link', { name: 'Away' }));
    expect(await screen.findByRole('heading', { name: 'Away' })).not.toBeNull();
    await waitFor(() => expect(abortedRequests).toBe(1));

    await user.click(screen.getByRole('link', { name: 'Chat' }));
    await screen.findByRole('heading', { name: 'Aster chat' });
    const restoredComposer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(restoredComposer, 'After navigation');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Partial answer')).not.toBeNull();
    expect(generationCount).toBe(2);
    expect(abortedRequests).toBe(1);
  });

  it('reports conversation network failures without an unhandled rejection', async () => {
    const user = userEvent.setup();
    conversationCreateFailure = true;
    renderChatPage();
    await screen.findByRole('option', { name: 'Aster' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Persona' }), ids.persona);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), ids.provider);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat preset' }), ids.chatPreset);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Will fail');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to create conversation');
  });

  it('reports send network failures without an unhandled rejection', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    generationNetworkFailure = true;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();
    await screen.findByRole('heading', { name: 'Aster chat' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Will fail to send');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Generation error');
    expect((composer as HTMLTextAreaElement).value).toBe('Will fail to send');
  });

  it.each([409, 422] as const)('retains the draft when generation startup returns HTTP %s', async (status) => {
    const user = userEvent.setup();
    conversations = [conversation];
    generationStartupFailureStatus = status;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();
    await screen.findByRole('heading', { name: 'Aster chat' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, `Retry after ${status}`);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain(`startup_${status}`);
    expect((composer as HTMLTextAreaElement).value).toBe(`Retry after ${status}`);
  });

  it('does not restore a draft after the stream was accepted and then failed with partial output', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    generationAcceptedFailure = true;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();
    await screen.findByRole('heading', { name: 'Aster chat' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Accepted then failed');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''));
    expect((await screen.findByRole('alert')).textContent).toContain('Generation error');
  });

  it('selects the default Persona for a new chat and imports then exports solo JSONL through the UI', async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi.fn(() => 'blob:chat-export');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderChatPage();

    await screen.findByRole('option', { name: 'Traveler' });
    const personaSelect = screen.getByRole('combobox', { name: 'Persona' }) as HTMLSelectElement;
    await waitFor(() => expect(personaSelect.value).toBe(ids.persona));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    const title = screen.getByRole('textbox', { name: 'Imported chat title' });
    await user.clear(title);
    await user.type(title, 'Imported from UI');
    await user.click(screen.getByRole('button', { name: 'Import chat' }));
    const file = new File(['{"user_name":"Traveler","character_name":"Aster"}\n'], 'chat.jsonl', { type: 'application/x-ndjson' });
    await user.upload(await screen.findByLabelText('Choose a file'), file);
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));

    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Conversation' }) as HTMLSelectElement).value).toBe(ids.importedConversation));
    expect(chatCommitBodies).toEqual([{
      inspectionToken: 'chat-inspection-token',
      characterId: ids.character,
      personaId: ids.persona,
      title: 'Imported from UI',
    }]);
    await user.click(screen.getByRole('button', { name: 'Export chat' }));
    await waitFor(() => expect(chatExportRequests).toBe(1));
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:chat-export');
  });

  it('blocks invalid chat imports and reports an expired inspection token', async () => {
    const user = userEvent.setup();
    renderChatPage();
    await screen.findByRole('option', { name: 'Traveler' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    await user.click(screen.getByRole('button', { name: 'Import chat' }));
    const file = new File(['{}\n'], 'chat.jsonl', { type: 'application/x-ndjson' });
    chatImportBlocking = true;
    await user.upload(await screen.findByLabelText('Choose a file'), file);
    expect(await screen.findByText('Blocked chat fixture')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel import' }));

    chatImportBlocking = false;
    chatImportExpired = true;
    await user.click(screen.getByRole('button', { name: 'Import chat' }));
    await user.upload(await screen.findByLabelText('Choose a file'), file);
    await user.click(await screen.findByRole('button', { name: 'Commit import' }));
    expect((await screen.findByRole('alert')).textContent).toContain('inspection_token_expired');
  });

  it('renders user, assistant, system, and narrator speaker labels distinctly', async () => {
    conversations = [conversation];
    messages = [
      { id: '018f0000-0000-7000-8000-000000000121', revision: 0, createdAt: now, updatedAt: now, conversationId: ids.conversation, role: 'system', speakerLabel: 'System', content: 'Policy', activeVariantId: null, variants: [] },
      { id: '018f0000-0000-7000-8000-000000000122', revision: 0, createdAt: now, updatedAt: now, conversationId: ids.conversation, role: 'system', speakerLabel: 'Narrator', content: 'Rain fell', activeVariantId: null, variants: [] },
      { id: ids.userMessage, revision: 0, createdAt: now, updatedAt: now, conversationId: ids.conversation, role: 'user', content: 'Hello', activeVariantId: null, variants: [] },
    ];
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    renderChatPage();
    expect(await screen.findByText('Policy')).not.toBeNull();
    const articles = screen.getAllByRole('article');
    expect(articles.map((article) => article.querySelector('header')?.textContent)).toEqual(['System', 'Narrator', 'You']);
  });

  it('reports revision conflicts and delete network failures', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    messages = [{
      id: ids.userMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'user', content: 'Editable', activeVariantId: null, variants: [],
    }];
    useChatUi.setState({ activeConversationId: conversation.id, draft: '' });
    messagePatchConflict = true;
    messageDeleteFailure = true;
    renderChatPage();

    await user.click(await screen.findByRole('button', { name: 'Edit user message Editable' }));
    await user.clear(screen.getByRole('textbox', { name: 'Edit message' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), 'Changed');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    expect((await screen.findByRole('alert')).textContent).toContain('revision_conflict');

    await user.click(screen.getByRole('button', { name: 'Delete user message Editable' }));
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Unable to delete message'))).toBe(true));
  });
});
