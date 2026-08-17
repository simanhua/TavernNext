import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorCode, type MessageView } from '../../api/client.js';
import type { ActiveGenerationTarget } from './useGeneration.js';
import { SwipeControls } from './SwipeControls.js';
import { useI18n } from '../../app/i18n.js';

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
  const { t, language } = useI18n();
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

  if (conversationId === null) return <div className="empty-state">{t('Choose a Character and Persona to begin.')}</div>;
  return (
    <section className="messages" aria-label={t('Messages')}>
      {messages.map((message) => {
        const baseContent = authoritativeContent(message);
        const content = generationTarget?.messageId === message.id && streamedText !== ''
          ? generationTarget.mode === 'continue' ? generationTarget.baseContent + streamedText : streamedText
          : baseContent;
        const role = language === 'en'
          ? message.role
          : t(message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'You' : 'System');
        const label = t('{{role}} message {{content}}', { role, content });
        return (
          <article className={`message message-${message.role}`} key={message.id}>
            <header>{message.role === 'assistant' ? t('Assistant') : message.role === 'user' ? t('You') : message.speakerLabel ?? t('System')}</header>
            {editingId === message.id ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                void edit.mutateAsync({ message, content: editText }).catch(() => undefined);
              }}>
                <label htmlFor={`edit-${message.id}`}>{t('Edit message')}</label>
                <textarea id={`edit-${message.id}`} value={editText} onChange={(event) => setEditText(event.target.value)} />
                <button type="submit" disabled={edit.isPending || editText.trim() === ''}>{t('Save edit')}</button>
                <button type="button" onClick={() => setEditingId(null)}>{t('Cancel edit')}</button>
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
                  aria-label={t('Edit {{label}}', { label })}
                  onClick={() => { setEditingId(message.id); setEditText(message.content); }}
                >{t('Edit')}</button>
              ) : null}
              <button
                type="button"
                disabled={controlsDisabled || remove.isPending}
                aria-label={t('Delete {{label}}', { label })}
                onClick={() => { void remove.mutateAsync(message).catch(() => undefined); }}
              >{t('Delete')}</button>
            </div>
          </article>
        );
      })}
      {edit.error ? <p role="alert">{t('Unable to edit message: {{error}}', { error: errorCode(edit.error) })}</p> : null}
      {remove.error ? <p role="alert">{t('Unable to delete message: {{error}}', { error: errorCode(remove.error) })}</p> : null}
      {selectVariant.error ? <p role="alert">{t('Unable to switch variant: {{error}}', { error: errorCode(selectVariant.error) })}</p> : null}
      {generationTarget === null && streamedText !== '' ? (
        <article className="message message-assistant" aria-live="polite">
          <header>{t('Assistant')}</header>
          <p>{streamedText}</p>
        </article>
      ) : null}
    </section>
  );
}
