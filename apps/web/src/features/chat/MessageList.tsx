import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorCode, type MessageView } from '../../api/client.js';
import type { ActiveGenerationTarget } from './useGeneration.js';
import { SwipeControls } from './SwipeControls.js';
import { useI18n } from '../../app/i18n.js';
import { RegexProjectedMarkdownContent } from './RegexProjectedMarkdownContent.js';
import { useActiveRegexScripts } from './useActiveRegexScripts.js';

interface MessageListProps {
  conversationId: string | null;
  messages: MessageView[];
  optimisticUserText: string | null;
  streamedText: string;
  streamedReasoning: string;
  generationTarget: ActiveGenerationTarget | null;
  controlsDisabled: boolean;
  generationDisabled: boolean;
  onGenerate(mode: 'swipe' | 'regenerate' | 'continue', message: MessageView, baseContent: string): void;
  macroValues?: Readonly<Record<string, string>>;
}

function authoritativeContent(message: MessageView): string {
  if (message.role !== 'assistant') return message.content;
  const active = message.variants.find((variant) => variant.id === message.activeVariantId);
  return (active ?? message.variants[0])?.content ?? message.content;
}

export function MessageList({
  conversationId,
  messages,
  optimisticUserText,
  streamedText,
  streamedReasoning,
  generationTarget,
  controlsDisabled,
  generationDisabled,
  onGenerate,
  macroValues,
}: MessageListProps) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const messagesRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const previousConversationId = useRef<string | null>(conversationId);
  const previousOptimisticText = useRef<string | null>(null);
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
  const { scripts: regexScripts, ready: regexScriptsReady } = useActiveRegexScripts(conversationId);
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : undefined;

  useEffect(() => {
    const element = messagesRef.current;
    const conversationChanged = previousConversationId.current !== conversationId;
    const optimisticMessageAdded = optimisticUserText !== null && previousOptimisticText.current !== optimisticUserText;
    previousConversationId.current = conversationId;
    previousOptimisticText.current = optimisticUserText;
    if (element === null || (!stickToBottom.current && !conversationChanged && !optimisticMessageAdded)) return;
    element.scrollTop = element.scrollHeight;
    stickToBottom.current = true;
  }, [conversationId, messages.length, optimisticUserText, streamedText, streamedReasoning]);

  if (conversationId === null && optimisticUserText === null) {
    return <div className="empty-state">{t('Choose a Character and Persona to begin.')}</div>;
  }
  return (
    <section
      className="messages"
      id="chat"
      aria-label={t('Messages')}
      ref={messagesRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      {messages.map((message, messageIndex) => {
        const activeVariant = message.role === 'assistant'
          ? message.variants.find((variant) => variant.id === message.activeVariantId) ?? message.variants[0]
          : undefined;
        const baseContent = authoritativeContent(message);
        const content = generationTarget?.messageId === message.id && streamedText !== ''
          ? generationTarget.mode === 'continue' ? generationTarget.baseContent + streamedText : streamedText
          : baseContent;
        const reasoning = generationTarget?.messageId === message.id && streamedReasoning !== ''
          ? streamedReasoning
          : activeVariant?.reasoning ?? '';
        const role = language === 'en'
          ? message.role
          : t(message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'You' : 'System');
        const label = t('{{role}} message {{content}}', { role, content });
        return (
          <article
            className={`message mes message-${message.role}`}
            key={message.id}
            data-swipe-id={activeVariant?.ordinal ?? 0}
            {...{ mesid: messageIndex }}
          >
            <header>{message.role === 'assistant' ? t('Assistant') : message.role === 'user' ? t('You') : message.speakerLabel ?? t('System')}</header>
            {editingId === message.id ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                void edit.mutateAsync({ message, content: editText }).catch(() => undefined);
              }}>
                <label htmlFor={`edit-${message.id}`}>{t('Edit message')}</label>
                <textarea id={`edit-${message.id}`} value={editText} onChange={(event) => setEditText(event.target.value)} />
                <RegexProjectedMarkdownContent
                  content={editText}
                  role={message.role}
                  depth={messages.length - messageIndex - 1}
                  scripts={regexScripts}
                  macroValues={macroValues}
                  isEdit
                />
                <button type="submit" disabled={edit.isPending || editText.trim() === ''}>{t('Save edit')}</button>
                <button type="button" onClick={() => setEditingId(null)}>{t('Cancel edit')}</button>
              </form>
            ) : (
              <>
                {reasoning === '' ? null : (
                  <details className="message-reasoning mes_reasoning_details" data-state="done" open={content === ''}>
                    <summary className="mes_reasoning_summary">
                      <span className="mes_reasoning_header_block">
                        <span className="mes_reasoning_header"><span className="mes_reasoning_header_title">{t('Reasoning')}</span></span>
                      </span>
                    </summary>
                    <p className="mes_reasoning">{reasoning}</p>
                  </details>
                )}
                {content === '' ? (
                  <p>{activeVariant?.status === 'streaming'
                    ? t('Waiting for final response…')
                    : t('No final response was generated.')}</p>
                ) : <div className="mes_text"><RegexProjectedMarkdownContent
                  content={content}
                  role={message.role}
                  depth={messages.length - messageIndex - 1}
                  scripts={regexScripts}
                  macroValues={macroValues}
                  interactive={regexScriptsReady && message.role === 'assistant'
                    && activeVariant?.status === 'completed'
                    && generationTarget?.messageId !== message.id
                    ? {
                        conversationId: conversationId!,
                        messageId: messageIndex,
                        variantId: activeVariant.id,
                        hasReasoning: reasoning !== '',
                      }
                    : undefined}
                /></div>}
              </>
            )}
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
      {optimisticUserText === null ? null : (
        <article className="message message-user message-pending" aria-live="polite">
          <header>{t('You')}</header>
          <RegexProjectedMarkdownContent content={optimisticUserText} role="user" depth={0} scripts={regexScripts} macroValues={macroValues} />
          <span className="message-pending-indicator">{t('Waiting for response…')}</span>
        </article>
      )}
      {edit.error ? <p role="alert">{t('Unable to edit message: {{error}}', { error: errorCode(edit.error) })}</p> : null}
      {remove.error ? <p role="alert">{t('Unable to delete message: {{error}}', { error: errorCode(remove.error) })}</p> : null}
      {selectVariant.error ? <p role="alert">{t('Unable to switch variant: {{error}}', { error: errorCode(selectVariant.error) })}</p> : null}
      {generationTarget === null && streamedText !== '' ? (
        <article className="message message-assistant" aria-live="polite">
          <header>{t('Assistant')}</header>
          <RegexProjectedMarkdownContent content={streamedText} role="assistant" depth={0} scripts={regexScripts} macroValues={macroValues} />
        </article>
      ) : null}
      {generationTarget === null && streamedText === '' && streamedReasoning !== '' ? (
        <article className="message message-assistant" aria-live="polite">
          <header>{t('Assistant')}</header>
          <details className="message-reasoning" open>
            <summary>{t('Reasoning')}</summary>
            <p>{streamedReasoning}</p>
          </details>
          <p>{t('Waiting for final response…')}</p>
        </article>
      ) : null}
    </section>
  );
}
