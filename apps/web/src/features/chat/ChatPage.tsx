import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorCode, type Conversation } from '../../api/client.js';
import { CharacterQuickCreate } from '../characters/CharacterQuickCreate.js';
import { PersonaQuickCreate } from '../personas/PersonaQuickCreate.js';
import { DeleteConfirmation } from '../shared/DeleteConfirmation.js';
import { useChatUi } from './chat-store.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { AgentRunInspector } from './AgentRunInspector.js';
import { PromptPreviewDialog } from './PromptPreviewDialog.js';
import { useGeneration } from './useGeneration.js';
import { useI18n } from '../../app/i18n.js';
import { ChatFormatSettings, chatFormatStyle, useChatFormat } from './ChatFormatSettings.js';
import { useGlobalGenerationConfiguration } from './useGlobalGenerationConfiguration.js';
import { TrustedScriptRuntimeHost } from '../extensions/TrustedScriptRuntimeHost.js';

const MAX_PROMPT_TOKENS = 1_000_000;
const MAX_RESPONSE_TOKENS = 384_000;
const DEFAULT_PROMPT_TOKENS = 128_000;
const DEFAULT_RESPONSE_TOKENS = 32_768;

export function ChatPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const activeConversationId = useChatUi((state) => state.activeConversationId);
  const setActiveConversationId = useChatUi((state) => state.setActiveConversationId);
  const draft = useChatUi((state) => state.draft);
  const setDraft = useChatUi((state) => state.setDraft);
  const [characterId, setCharacterId] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [maxPromptTokens, setMaxPromptTokens] = useState(DEFAULT_PROMPT_TOKENS);
  const [maxResponseTokens, setMaxResponseTokens] = useState(DEFAULT_RESPONSE_TOKENS);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [optimisticUserText, setOptimisticUserText] = useState<string | null>(null);
  const creatingConversation = useRef<Promise<Conversation> | null>(null);
  const sendingMessage = useRef(false);
  const chatFormat = useChatFormat();
  const characters = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters });
  const personas = useQuery({ queryKey: ['personas'], queryFn: api.listPersonas });
  const globalGeneration = useGlobalGenerationConfiguration();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: api.listConversations });
  const detail = useQuery({
    queryKey: ['conversation', activeConversationId],
    queryFn: () => api.getConversationMessages(activeConversationId!),
    enabled: activeConversationId !== null,
  });
  const generation = useGeneration();
  const createConversation = useMutation({
    mutationFn: api.createConversation,
    onSuccess: async (created) => {
      setActiveConversationId(created.id);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const updateConversationSettings = useMutation({
    mutationFn: ({ conversation, patch }: {
      conversation: Conversation;
      patch: Parameters<typeof api.updateConversationSettings>[1];
    }) => api.updateConversationSettings(conversation, patch),
    onSuccess: async (configured) => {
      queryClient.setQueryData(['conversation', configured.id], (current: typeof detail.data) => (
        current === undefined ? current : { ...current, conversation: configured }
      ));
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const deleteConversation = useMutation({
    mutationFn: api.deleteConversation,
    onSuccess: async (_, deleted) => {
      setDeleteOpen(false);
      queryClient.removeQueries({ queryKey: ['conversation', deleted.id], exact: true });
      if (activeConversationId === deleted.id) setActiveConversationId(null);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: () => setDeleteOpen(false),
  });

  const tokenBudgetsValid = Number.isInteger(maxPromptTokens)
    && maxPromptTokens >= 1
    && maxPromptTokens <= MAX_PROMPT_TOKENS
    && Number.isInteger(maxResponseTokens)
    && maxResponseTokens >= 1
    && maxResponseTokens <= MAX_RESPONSE_TOKENS;
  const configurationReady = globalGeneration.ready && tokenBudgetsValid;

  const selectedBudgetSettings = () => ({
    maxPromptTokens,
    maxResponseTokens,
  });

  const createSelectedConversation = (): Promise<Conversation> => {
    if (creatingConversation.current !== null) return creatingConversation.current;
    const character = characters.data?.find((candidate) => candidate.id === characterId);
    const attempt = createConversation.mutateAsync({
      characterId,
      personaId,
      title: character === undefined ? 'New chat' : `${character.name} chat`,
      ...selectedBudgetSettings(),
    });
    creatingConversation.current = attempt;
    void attempt.finally(() => {
      if (creatingConversation.current === attempt) creatingConversation.current = null;
    }).catch(() => undefined);
    return attempt;
  };

  const ensureConfigured = async (target: Conversation): Promise<Conversation> => {
    if (!configurationReady) throw new Error('configuration_not_ready');
    const budgetSettings = selectedBudgetSettings();
    const listed = conversations.data?.find((conversation) => conversation.id === target.id) ?? target;
    const differs = listed.maxPromptTokens !== maxPromptTokens
      || listed.maxResponseTokens !== maxResponseTokens;
    return differs
      ? updateConversationSettings.mutateAsync({ conversation: target, patch: budgetSettings })
      : target;
  };

  useEffect(() => {
    const active = conversations.data?.find((conversation) => conversation.id === activeConversationId);
    if (active !== undefined) {
      setCharacterId(active.characterId);
      setPersonaId(active.personaId);
      setMaxPromptTokens(active.maxPromptTokens);
      setMaxResponseTokens(active.maxResponseTokens);
    }
  }, [activeConversationId, conversations.data]);

  useEffect(() => {
    if (activeConversationId !== null || personaId !== '') return;
    const defaultPersona = personas.data?.find((persona) => persona.isDefault);
    if (defaultPersona !== undefined) setPersonaId(defaultPersona.id);
  }, [activeConversationId, personaId, personas.data]);

  const selectConversation = (id: string) => {
    setActiveConversationId(id === '' ? null : id);
    if (id === '') return;
    const selected = conversations.data?.find((conversation) => conversation.id === id);
    if (selected !== undefined) {
      setCharacterId(selected.characterId);
      setPersonaId(selected.personaId);
      setMaxPromptTokens(selected.maxPromptTokens);
      setMaxResponseTokens(selected.maxResponseTokens);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (text === '' || generation.isActive || sendingMessage.current) return;
    sendingMessage.current = true;
    setOptimisticUserText(text);
    let target: Conversation | undefined = detail.data?.conversation;
    try {
      if (target === undefined) {
        if (activeConversationId !== null) return;
        target = await createSelectedConversation();
      } else {
        target = await ensureConfigured(target);
      }
      await generation.start(target, { mode: 'normal', userText: text }, { onAccepted: () => setDraft('') });
    } catch {
      // Mutation state owns accessible feedback; keep the draft for retry.
    } finally {
      sendingMessage.current = false;
      setOptimisticUserText(null);
    }
  };

  const prerequisitesReady = characterId !== '' && personaId !== '' && configurationReady;
  const composerDisabled = !prerequisitesReady
    || generation.isActive
    || createConversation.isPending
    || updateConversationSettings.isPending
    || characters.isLoading
    || personas.isLoading
    || globalGeneration.isLoading
    || (activeConversationId !== null && detail.data === undefined);

  return (
    <main className="chat-page">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-brand">
          <span className="chat-sidebar-sigil" aria-hidden="true">T</span>
          <div>
            <h1>TavernNext</h1>
            <span>{t('Session setup')}</span>
          </div>
        </div>
        <label>
          {t('Conversation')}
          <select
            value={activeConversationId ?? ''}
            disabled={generation.isActive}
            onChange={(event) => selectConversation(event.target.value)}
          >
            <option value="">{t('New conversation')}</option>
            {(conversations.data ?? []).map((conversation) => (
              <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
            ))}
          </select>
        </label>
        <label>
          {t('Character')}
          <select
            value={characterId}
            disabled={activeConversationId !== null || generation.isActive}
            onChange={(event) => setCharacterId(event.target.value)}
          >
            <option value="">{t('Choose Character')}</option>
            {(characters.data ?? []).map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select>
        </label>
        <label>
          {t('Persona')}
          <select
            value={personaId}
            disabled={activeConversationId !== null || generation.isActive}
            onChange={(event) => setPersonaId(event.target.value)}
          >
            <option value="">{t('Choose Persona')}</option>
            {(personas.data ?? []).map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
          </select>
        </label>
        <label>
          {t('Maximum prompt tokens')}
          <input
            type="number"
            min={1}
            max={MAX_PROMPT_TOKENS}
            step={1024}
            value={maxPromptTokens}
            disabled={generation.isActive}
            onChange={(event) => setMaxPromptTokens(Number(event.target.value))}
          />
        </label>
        <label>
          {t('Maximum response tokens')}
          <input
            type="number"
            min={1}
            max={MAX_RESPONSE_TOKENS}
            step={1024}
            value={maxResponseTokens}
            disabled={generation.isActive}
            onChange={(event) => setMaxResponseTokens(Number(event.target.value))}
          />
        </label>
        <details><summary>{t('Add Character')}</summary><CharacterQuickCreate /></details>
        <details><summary>{t('Add Persona')}</summary><PersonaQuickCreate /></details>
        <ChatFormatSettings values={chatFormat.values} onChange={chatFormat.setValue} onReset={chatFormat.reset} />
      </aside>
      <section className="chat-main" style={chatFormatStyle(chatFormat.values)}>
        <header className="chat-header">
          <h2>{detail.data?.conversation.title ?? t('New conversation')}</h2>
          <div className="chat-header-actions">
            {activeConversationId === null ? (
              <button
                type="button"
                disabled={!prerequisitesReady || createConversation.isPending}
                onClick={() => { void createSelectedConversation().catch(() => undefined); }}
              >{t('Start chat')}</button>
            ) : null}
            {detail.data?.conversation === undefined ? null : <PromptPreviewDialog conversation={detail.data.conversation} userText={draft} />}
            {detail.data?.conversation === undefined ? null : (
              <button
                type="button"
                disabled={generation.isActive || deleteConversation.isPending}
                onClick={() => { deleteConversation.reset(); setDeleteOpen(true); }}
              >{t('Delete Conversation')}</button>
            )}
            <span className={`generation-status status-${generation.status}`}>{t(generation.status)}</span>
          </div>
        </header>
        {detail.error ? <p role="alert">{t('Unable to load this conversation.')}</p> : null}
        {createConversation.error ? <p role="alert">{t('Unable to create conversation: {{error}}', { error: errorCode(createConversation.error) })}</p> : null}
        {updateConversationSettings.error ? <p role="alert">{t('Unable to configure conversation: {{error}}', { error: errorCode(updateConversationSettings.error) })}</p> : null}
        {globalGeneration.error ? <p role="alert">{t('Unable to load global generation configuration.')}</p> : null}
        {deleteConversation.error ? <p role="alert">{t('Unable to delete conversation: {{error}}', { error: errorCode(deleteConversation.error) })}</p> : null}
        <MessageList
          conversationId={activeConversationId}
          messages={detail.data?.messages ?? []}
          optimisticUserText={optimisticUserText}
          streamedText={generation.streamedText}
          streamedReasoning={generation.streamedReasoning}
          activities={generation.activities}
          viewPlaceholders={generation.viewPlaceholders}
          generationTarget={generation.target}
          controlsDisabled={generation.isActive || updateConversationSettings.isPending}
          generationDisabled={generation.isActive || updateConversationSettings.isPending || !configurationReady}
          macroValues={{
            char: characters.data?.find((candidate) => candidate.id === detail.data?.conversation.characterId)?.name ?? '',
            user: personas.data?.find((candidate) => candidate.id === detail.data?.conversation.personaId)?.name ?? '',
          }}
          onGenerate={(mode, message, baseContent) => {
            const target = detail.data?.conversation;
            if (target === undefined || generation.isActive) return;
            void (async () => {
              try {
                const configured = await ensureConfigured(target);
                await generation.start(configured, { mode, target: message, baseContent });
              } catch {
                // Mutation state owns accessible configuration feedback.
              }
            })();
          }}
        />
        <TrustedScriptRuntimeHost conversationId={activeConversationId} />
        <AgentRunInspector conversationId={activeConversationId} />
        {generation.error ? <p role="alert">{t('Generation error: {{error}}', { error: t(generation.error) })}</p> : null}
        {characters.isLoading || personas.isLoading || globalGeneration.isLoading ? (
          <p>{t('Loading chat configuration…')}</p>
        ) : (
          <Composer
            draft={draft}
            disabled={composerDisabled}
            canStop={generation.canStop}
            stopping={generation.status === 'stopping'}
            onDraftChange={setDraft}
            onSend={() => { void send(); }}
            onStop={() => { void generation.stop(); }}
          />
        )}
      </section>
      <DeleteConfirmation
        noun="Conversation"
        open={deleteOpen}
        pending={deleteConversation.isPending}
        onOpenChange={setDeleteOpen}
        onConfirm={() => {
          if (detail.data?.conversation !== undefined) deleteConversation.mutate(detail.data.conversation);
        }}
      />
    </main>
  );
}
