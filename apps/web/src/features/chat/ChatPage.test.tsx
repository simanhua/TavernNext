// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatPage } from './ChatPage.js';
import { useChatUi } from './chat-store.js';

const now = '2026-08-08T00:00:00.000Z';
const ids = {
  character: '018f0000-0000-7000-8000-000000000101',
  persona: '018f0000-0000-7000-8000-000000000102',
  conversation: '018f0000-0000-7000-8000-000000000103',
  otherConversation: '018f0000-0000-7000-8000-000000000104',
  userMessage: '018f0000-0000-7000-8000-000000000105',
  assistantMessage: '018f0000-0000-7000-8000-000000000106',
  assistantVariant: '018f0000-0000-7000-8000-000000000107',
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
const otherConversation = {
  id: ids.otherConversation, revision: 0, createdAt: now, updatedAt: now,
  characterId: ids.character, personaId: ids.persona, title: 'Saved chat', worldbookIds: [],
};
const conversation = {
  id: ids.conversation, revision: 0, createdAt: now, updatedAt: now,
  characterId: ids.character, personaId: ids.persona, title: 'Aster chat', worldbookIds: [],
};

type MessageView = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  activeVariantId: string | null;
  variants: Array<{
    id: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    messageId: string;
    content: string;
    status: 'completed' | 'aborted';
    finishReason?: string;
  }>;
};

let conversations = [otherConversation];
let conversationRevision = 0;
let messages: MessageView[] = [];
let generationCount = 0;
let stopRequests = 0;
let abortedRequests = 0;
let holdFirstGeneration = false;
let conversationCreateFailure = false;
let generationNetworkFailure = false;
let messagePatchConflict = false;
let messageDeleteFailure = false;
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
const encoder = new TextEncoder();
const frame = (type: string, data: object = {}) => encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

const server = setupServer(
  http.get('/api/characters', () => HttpResponse.json([character])),
  http.get('/api/personas', () => HttpResponse.json([persona])),
  http.get('/api/conversations', () => HttpResponse.json(conversations)),
  http.post('/api/conversations', async ({ request }) => {
    if (conversationCreateFailure) return HttpResponse.error();
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ characterId: ids.character, personaId: ids.persona });
    conversations = [otherConversation, conversation];
    return HttpResponse.json(conversation, { status: 201 });
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
  http.post('/api/conversations/:id/generations', async ({ request }) => {
    if (generationNetworkFailure) return HttpResponse.error();
    generationCount += 1;
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ conversationRevision, mode: 'normal' });
    const userText = String(body.userText);
    request.signal.addEventListener('abort', () => { abortedRequests += 1; }, { once: true });
    conversationRevision += 1;
    messages.push({
      id: generationCount === 1 ? ids.userMessage : `018f0000-0000-7000-8000-00000000030${generationCount}`,
      revision: 0, createdAt: now, updatedAt: now, conversationId: ids.conversation,
      role: 'user', content: userText, activeVariantId: null, variants: [],
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame('started', { generationId: `generation-${generationCount}` }));
        if (generationCount === 1 && !holdFirstGeneration) {
          controller.enqueue(frame('delta', { text: 'Hel' }));
          controller.enqueue(frame('delta', { text: 'lo' }));
          messages.push({
            id: ids.assistantMessage, revision: 1, createdAt: now, updatedAt: now,
            conversationId: ids.conversation, role: 'assistant', content: '', activeVariantId: ids.assistantVariant,
            variants: [{
              id: ids.assistantVariant, revision: 1, createdAt: now, updatedAt: now,
              messageId: ids.assistantMessage, content: 'Hello', status: 'completed', finishReason: 'stop',
            }],
          });
          controller.enqueue(frame('usage', { inputTokens: 4, outputTokens: 1 }));
          controller.enqueue(frame('completed', { finishReason: 'stop' }));
          controller.close();
        } else {
          controller.enqueue(frame('delta', { text: 'Partial answer' }));
          activeStream = controller;
        }
      },
    });
    return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
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
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  conversations = [otherConversation];
  conversationRevision = 0;
  messages = [];
  generationCount = 0;
  stopRequests = 0;
  abortedRequests = 0;
  holdFirstGeneration = false;
  conversationCreateFailure = false;
  generationNetworkFailure = false;
  messagePatchConflict = false;
  messageDeleteFailure = false;
  activeStream = undefined;
  useChatUi.setState({ activeConversationId: null, draft: '', selectedVariantId: null });
});
afterAll(() => server.close());

function renderChatPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatPage />
    </QueryClientProvider>,
  );
}

describe('ChatPage', () => {
  it('creates, streams, stops, edits, deletes, and switches persisted chats', async () => {
    const user = userEvent.setup();
    renderChatPage();

    const composer = await screen.findByRole('textbox', { name: 'Message' });
    expect((composer as HTMLTextAreaElement).disabled).toBe(true);

    await screen.findByRole('option', { name: 'Aster' });
    await screen.findByRole('option', { name: 'Traveler' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Character' }), ids.character);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Persona' }), ids.persona);
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

  it('aborts one in-flight request on navigation and can generate in the same conversation after returning', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    holdFirstGeneration = true;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '', selectedVariantId: null });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Link to="/">Chat</Link>
          <Link to="/away">Away</Link>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/away" element={<h1>Away</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
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
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Will fail');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to create conversation');
  });

  it('reports send network failures without an unhandled rejection', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    generationNetworkFailure = true;
    useChatUi.setState({ activeConversationId: conversation.id, draft: '', selectedVariantId: null });
    renderChatPage();
    await screen.findByRole('heading', { name: 'Aster chat' });
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await user.type(composer, 'Will fail to send');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Generation error');
  });

  it('reports revision conflicts and delete network failures', async () => {
    const user = userEvent.setup();
    conversations = [conversation];
    messages = [{
      id: ids.userMessage, revision: 0, createdAt: now, updatedAt: now,
      conversationId: ids.conversation, role: 'user', content: 'Editable', activeVariantId: null, variants: [],
    }];
    useChatUi.setState({ activeConversationId: conversation.id, draft: '', selectedVariantId: null });
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
