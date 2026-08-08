import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type MessageView } from '../../api/client.js';
import { useChatUi } from './chat-store.js';

interface MessageListProps {
  conversationId: string | null;
  messages: MessageView[];
  streamedText: string;
  controlsDisabled: boolean;
}

function visibleContent(message: MessageView, selectedVariantId: string | null): string {
  if (message.role !== 'assistant') return message.content;
  const selected = message.variants.find((variant) => variant.id === selectedVariantId);
  const active = message.variants.find((variant) => variant.id === message.activeVariantId);
  return (selected ?? active ?? message.variants[0])?.content ?? message.content;
}

export function MessageList({ conversationId, messages, streamedText, controlsDisabled }: MessageListProps) {
  const queryClient = useQueryClient();
  const selectedVariantId = useChatUi((state) => state.selectedVariantId);
  const setSelectedVariantId = useChatUi((state) => state.setSelectedVariantId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const refresh = async () => queryClient.refetchQueries({ queryKey: ['conversation', conversationId] });
  const edit = useMutation({
    mutationFn: ({ message, content }: { message: MessageView; content: string }) => api.updateMessage(message, content),
    onSuccess: async () => { setEditingId(null); await refresh(); },
  });
  const remove = useMutation({ mutationFn: api.deleteMessage, onSuccess: refresh });

  if (conversationId === null) return <div className="empty-state">Choose a Character and Persona to begin.</div>;
  return (
    <section className="messages" aria-label="Messages">
      {messages.map((message) => {
        const content = visibleContent(message, selectedVariantId);
        const label = `${message.role} message ${content}`;
        return (
          <article className={`message message-${message.role}`} key={message.id}>
            <header>{message.role === 'assistant' ? 'Assistant' : 'You'}</header>
            {editingId === message.id ? (
              <form onSubmit={(event) => { event.preventDefault(); edit.mutate({ message, content: editText }); }}>
                <label htmlFor={`edit-${message.id}`}>Edit message</label>
                <textarea id={`edit-${message.id}`} value={editText} onChange={(event) => setEditText(event.target.value)} />
                <button type="submit" disabled={edit.isPending || editText.trim() === ''}>Save edit</button>
                <button type="button" onClick={() => setEditingId(null)}>Cancel edit</button>
              </form>
            ) : <p>{content}</p>}
            {message.role === 'assistant' && message.variants.length > 1 ? (
              <label>
                Variant
                <select value={selectedVariantId ?? message.activeVariantId ?? ''} onChange={(event) => setSelectedVariantId(event.target.value)}>
                  {message.variants.map((variant, index) => <option key={variant.id} value={variant.id}>{index + 1}</option>)}
                </select>
              </label>
            ) : null}
            <div className="message-actions">
              {message.role === 'user' ? (
                <button
                  type="button"
                  disabled={controlsDisabled}
                  aria-label={`Edit ${label}`}
                  onClick={() => { setEditingId(message.id); setEditText(message.content); }}
                >Edit</button>
              ) : null}
              <button
                type="button"
                disabled={controlsDisabled || remove.isPending}
                aria-label={`Delete ${label}`}
                onClick={() => remove.mutate(message)}
              >Delete</button>
            </div>
          </article>
        );
      })}
      {streamedText !== '' ? (
        <article className="message message-assistant" aria-live="polite">
          <header>Assistant</header>
          <p>{streamedText}</p>
        </article>
      ) : null}
    </section>
  );
}
