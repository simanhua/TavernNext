import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorCode, type MessageView } from '../../api/client.js';
import type { ActiveGenerationTarget } from './useGeneration.js';
import { SwipeControls } from './SwipeControls.js';

interface MessageListProps {
  conversationId: string | null;
  messages: MessageView[];
  streamedText: string;
  generationTarget: ActiveGenerationTarget | null;
  controlsDisabled: boolean;
  generationDisabled: boolean;
  onGenerate(mode: 'swipe' | 'regenerate' | 'continue', message: MessageView, baseContent: string): void;
}

function authoritativeContent(message: MessageView): string {
  if (message.role !== 'assistant') return message.content;
  const active = message.variants.find((variant) => variant.id === message.activeVariantId);
  return (active ?? message.variants[0])?.content ?? message.content;
}

export function MessageList({
  conversationId,
  messages,
  streamedText,
  generationTarget,
  controlsDisabled,
  generationDisabled,
  onGenerate,
}: MessageListProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const refresh = async () => queryClient.refetchQueries({ queryKey: ['conversation', conversationId] });
  const edit = useMutation({
    mutationFn: ({ message, content }: { message: MessageView; content: string }) => api.updateMessage(message, content),
    onSuccess: async () => { setEditingId(null); await refresh(); },
  });
  const remove = useMutation({ mutationFn: api.deleteMessage, onSuccess: refresh });
  const selectVariant = useMutation({
    mutationFn: ({ message, variantId }: { message: MessageView; variantId: string }) => (
      api.switchActiveVariant(message, variantId)
    ),
    onSuccess: refresh,
  });
  const lastMessage = messages.at(-1);
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : undefined;

  if (conversationId === null) return <div className="empty-state">Choose a Character and Persona to begin.</div>;
  return (
    <section className="messages" aria-label="Messages">
      {messages.map((message) => {
        const baseContent = authoritativeContent(message);
        const content = generationTarget?.messageId === message.id && streamedText !== ''
          ? generationTarget.mode === 'continue' ? generationTarget.baseContent + streamedText : streamedText
          : baseContent;
        const label = `${message.role} message ${content}`;
        return (
          <article className={`message message-${message.role}`} key={message.id}>
            <header>{message.role === 'assistant' ? 'Assistant' : 'You'}</header>
            {editingId === message.id ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                void edit.mutateAsync({ message, content: editText }).catch(() => undefined);
              }}>
                <label htmlFor={`edit-${message.id}`}>Edit message</label>
                <textarea id={`edit-${message.id}`} value={editText} onChange={(event) => setEditText(event.target.value)} />
                <button type="submit" disabled={edit.isPending || editText.trim() === ''}>Save edit</button>
                <button type="button" onClick={() => setEditingId(null)}>Cancel edit</button>
              </form>
            ) : <p>{content}</p>}
            {message.id === lastAssistantId ? (
              <SwipeControls
                message={message}
                selectionDisabled={controlsDisabled || selectVariant.isPending}
                generationDisabled={generationDisabled || selectVariant.isPending}
                onSelect={(variantId) => {
                  void selectVariant.mutateAsync({ message, variantId }).catch(() => undefined);
                }}
                onGenerate={(mode) => onGenerate(mode, message, baseContent)}
              />
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
                onClick={() => { void remove.mutateAsync(message).catch(() => undefined); }}
              >Delete</button>
            </div>
          </article>
        );
      })}
      {edit.error ? <p role="alert">Unable to edit message: {errorCode(edit.error)}</p> : null}
      {remove.error ? <p role="alert">Unable to delete message: {errorCode(remove.error)}</p> : null}
      {selectVariant.error ? <p role="alert">Unable to switch variant: {errorCode(selectVariant.error)}</p> : null}
      {generationTarget === null && streamedText !== '' ? (
        <article className="message message-assistant" aria-live="polite">
          <header>Assistant</header>
          <p>{streamedText}</p>
        </article>
      ) : null}
    </section>
  );
}
