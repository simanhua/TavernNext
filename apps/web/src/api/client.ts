import type { Character, Conversation, Message, MessageVariant, Persona } from '@tavernnext/domain';

export type { Character, Conversation, Message, MessageVariant, Persona };

export interface ProviderProfileView {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  baseUrl: string;
  model: string;
  apiMode: 'chat' | 'text';
  hasApiKey: boolean;
}

export interface MessageView extends Message {
  variants: MessageVariant[];
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: MessageView[];
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  listCharacters: () => request<Character[]>('/api/characters'),
  createCharacter: (input: { name: string; description: string; firstMessage: string }) => request<Character>('/api/characters', {
    method: 'POST',
    body: JSON.stringify({
      id: crypto.randomUUID(), ...input, personality: '', scenario: '', alternateGreetings: [], tags: [],
    }),
  }),
  listPersonas: () => request<Persona[]>('/api/personas'),
  createPersona: (input: { name: string; description: string }) => request<Persona>('/api/personas', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input, isDefault: false }),
  }),
  listProviders: () => request<ProviderProfileView[]>('/api/providers'),
  saveProvider: (input: {
    id?: string;
    revision?: number;
    name: string;
    baseUrl: string;
    model: string;
    apiMode: 'chat' | 'text';
    apiKey?: string;
  }) => {
    const { id, revision, ...fields } = input;
    return id === undefined
      ? request<ProviderProfileView>('/api/providers', {
        method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...fields }),
      })
      : request<ProviderProfileView>(`/api/providers/${id}`, {
        method: 'PATCH', body: JSON.stringify({ revision, patch: fields }),
      });
  },
  listConversations: () => request<Conversation[]>('/api/conversations'),
  createConversation: (input: { characterId: string; personaId: string; title: string }) => request<Conversation>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), ...input }),
  }),
  getConversationMessages: (id: string) => request<ConversationDetail>(`/api/conversations/${id}/messages`),
  updateMessage: (message: Message, content: string) => request<Message>(`/api/messages/${message.id}`, {
    method: 'PATCH', body: JSON.stringify({ revision: message.revision, patch: { content } }),
  }),
  deleteMessage: (message: Message) => request<void>(`/api/messages/${message.id}?revision=${message.revision}`, { method: 'DELETE' }),
  startGeneration: async (conversation: Conversation, userText: string) => {
    const response = await fetch(`/api/conversations/${conversation.id}/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationRevision: conversation.revision, mode: 'normal', userText }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
    }
    return response;
  },
  stopGeneration: async (generationId: string) => {
    const response = await fetch(`/api/generations/${generationId}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(response.status, payload.error ?? `http_${response.status}`);
    }
  },
};
