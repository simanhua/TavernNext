import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorCode, type Conversation } from '../../api/client.js';
import { CharacterQuickCreate } from '../characters/CharacterQuickCreate.js';
import { PersonaQuickCreate } from '../personas/PersonaQuickCreate.js';
import { ImportDialog } from '../imports/ImportDialog.js';
import { useChatUi } from './chat-store.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { PromptPreviewDialog } from './PromptPreviewDialog.js';
import { useGeneration } from './useGeneration.js';
import { useI18n } from '../../app/i18n.js';

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
  const [providerId, setProviderId] = useState('');
  const [presetId, setPresetId] = useState('');
  const [contextPresetId, setContextPresetId] = useState('');
  const [instructPresetId, setInstructPresetId] = useState('');
  const [systemPresetId, setSystemPresetId] = useState('');
  const [maxPromptTokens, setMaxPromptTokens] = useState(DEFAULT_PROMPT_TOKENS);
  const [maxResponseTokens, setMaxResponseTokens] = useState(DEFAULT_RESPONSE_TOKENS);
  const [chatImportOpen, setChatImportOpen] = useState(false);
  const [chatImportTitle, setChatImportTitle] = useState(() => t('Imported chat'));
  const [chatTransferError, setChatTransferError] = useState<string>();
  const creatingConversation = useRef<Promise<Conversation> | null>(null);
  const characters = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters });
  const personas = useQuery({ queryKey: ['personas'], queryFn: api.listPersonas });
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });
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
  const configureConversation = useMutation({
    mutationFn: ({ conversation, patch }: {
      conversation: Conversation;
      patch: Parameters<typeof api.updateConversationConfiguration>[1];
    }) => api.updateConversationConfiguration(conversation, patch),
    onSuccess: async (configured) => {
      queryClient.setQueryData(['conversation', configured.id], (current: typeof detail.data) => (
        current === undefined ? current : { ...current, conversation: configured }
      ));
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
  const exportChat = useMutation({ mutationFn: api.exportChat });

  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const requiredPrimaryKind = selectedProvider?.apiMode === 'text' ? 'text' : 'chat';
  const primaryPresetValid = presets.data?.some((preset) => preset.id === presetId && preset.kind === requiredPrimaryKind) === true;
  const textCompanionsValid = selectedProvider?.apiMode !== 'text' || (
    presets.data?.some((preset) => preset.id === contextPresetId && preset.kind === 'context') === true
    && presets.data?.some((preset) => preset.id === instructPresetId && preset.kind === 'instruct') === true
    && presets.data?.some((preset) => preset.id === systemPresetId && preset.kind === 'system') === true
  );
  const tokenBudgetsValid = Number.isInteger(maxPromptTokens)
    && maxPromptTokens >= 1
    && maxPromptTokens <= MAX_PROMPT_TOKENS
    && Number.isInteger(maxResponseTokens)
    && maxResponseTokens >= 1
    && maxResponseTokens <= MAX_RESPONSE_TOKENS;
  const configurationReady = selectedProvider !== undefined && primaryPresetValid && textCompanionsValid && tokenBudgetsValid;

  const selectedConfiguration = () => ({
    providerId,
    presetId,
    maxPromptTokens,
    maxResponseTokens,
    ...(selectedProvider?.apiMode !== 'text' ? {} : {
      contextPresetId,
      instructPresetId,
      systemPresetId,
    }),
  });

  const createSelectedConversation = (): Promise<Conversation> => {
    if (creatingConversation.current !== null) return creatingConversation.current;
    const character = characters.data?.find((candidate) => candidate.id === characterId);
    const attempt = createConversation.mutateAsync({
      characterId,
      personaId,
      title: character === undefined ? 'New chat' : `${character.name} chat`,
      ...selectedConfiguration(),
    });
    creatingConversation.current = attempt;
    void attempt.finally(() => {
      if (creatingConversation.current === attempt) creatingConversation.current = null;
    }).catch(() => undefined);
    return attempt;
  };

  const ensureConfigured = async (target: Conversation): Promise<Conversation> => {
    if (!configurationReady) throw new Error('configuration_not_ready');
    const configuration = selectedConfiguration();
    const listed = conversations.data?.find((conversation) => conversation.id === target.id) ?? target;
    const differs = listed.providerId !== configuration.providerId
      || listed.presetId !== configuration.presetId
      || listed.maxPromptTokens !== maxPromptTokens
      || listed.maxResponseTokens !== maxResponseTokens
      || (selectedProvider?.apiMode === 'text' && (
        listed.contextPresetId !== contextPresetId
        || listed.instructPresetId !== instructPresetId
        || listed.systemPresetId !== systemPresetId
      ));
    return differs
      ? configureConversation.mutateAsync({ conversation: target, patch: configuration })
      : target;
  };

  useEffect(() => {
    const active = conversations.data?.find((conversation) => conversation.id === activeConversationId);
    if (active !== undefined) {
      setCharacterId(active.characterId);
      setPersonaId(active.personaId);
      setProviderId(active.providerId ?? '');
      setPresetId(active.presetId ?? '');
      setContextPresetId(active.contextPresetId ?? '');
      setInstructPresetId(active.instructPresetId ?? '');
      setSystemPresetId(active.systemPresetId ?? '');
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
      setProviderId(selected.providerId ?? '');
      setPresetId(selected.presetId ?? '');
      setContextPresetId(selected.contextPresetId ?? '');
      setInstructPresetId(selected.instructPresetId ?? '');
      setSystemPresetId(selected.systemPresetId ?? '');
      setMaxPromptTokens(selected.maxPromptTokens);
      setMaxResponseTokens(selected.maxResponseTokens);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (text === '' || generation.isActive) return;
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
    }
  };

  const prerequisitesReady = characterId !== '' && personaId !== '' && configurationReady;
  const composerDisabled = !prerequisitesReady
    || generation.isActive
    || createConversation.isPending
    || configureConversation.isPending
    || characters.isLoading
    || personas.isLoading
    || providers.isLoading
    || presets.isLoading
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
          {t('Provider')}
          <select
            value={providerId}
            disabled={generation.isActive}
            onChange={(event) => {
              setProviderId(event.target.value);
              setPresetId('');
              setContextPresetId('');
              setInstructPresetId('');
              setSystemPresetId('');
            }}
          >
            <option value="">{t('Choose Provider')}</option>
            {(providers.data ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label>
          {t(selectedProvider?.apiMode === 'text' ? 'Text preset' : 'Chat preset')}
          <select value={presetId} disabled={providerId === '' || generation.isActive} onChange={(event) => setPresetId(event.target.value)}>
            <option value="">{t(selectedProvider?.apiMode === 'text' ? 'Choose Text preset' : 'Choose Chat preset')}</option>
            {(presets.data ?? []).filter((preset) => preset.kind === requiredPrimaryKind)
              .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        {selectedProvider?.apiMode === 'text' ? (
          <>
            <label>
              {t('Context preset')}
              <select value={contextPresetId} disabled={generation.isActive} onChange={(event) => setContextPresetId(event.target.value)}>
                <option value="">{t('Choose Context preset')}</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'context')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            <label>
              {t('Instruct preset')}
              <select value={instructPresetId} disabled={generation.isActive} onChange={(event) => setInstructPresetId(event.target.value)}>
                <option value="">{t('Choose Instruct preset')}</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'instruct')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            <label>
              {t('System preset')}
              <select value={systemPresetId} disabled={generation.isActive} onChange={(event) => setSystemPresetId(event.target.value)}>
                <option value="">{t('Choose System preset')}</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'system')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
          </>
        ) : null}
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
        <label>
          {t('Imported chat title')}
          <input value={chatImportTitle} onChange={(event) => setChatImportTitle(event.target.value)} />
        </label>
        <div className="chat-transfer-actions">
          <button
            type="button"
            disabled={characterId === '' || personaId === '' || chatImportTitle.trim() === '' || generation.isActive}
            onClick={() => { setChatTransferError(undefined); setChatImportOpen(true); }}
          >{t('Import chat')}</button>
          <button
            type="button"
            disabled={activeConversationId === null || generation.isActive || exportChat.isPending}
            onClick={() => {
              if (activeConversationId === null) return;
              setChatTransferError(undefined);
              void exportChat.mutateAsync(activeConversationId).catch((error) => setChatTransferError(errorCode(error)));
            }}
          >{t('Export chat')}</button>
        </div>
        <ImportDialog
          open={chatImportOpen}
          expectedKind="chat"
          title={t('Import solo chat JSONL')}
          onOpenChange={setChatImportOpen}
          commitImport={(inspectionToken) => api.commitChatImport(inspectionToken, {
            characterId,
            personaId,
            title: chatImportTitle.trim(),
          })}
          onCommitted={(receipt) => {
            if (receipt.entityId === undefined) {
              setChatTransferError('chat_import_missing_entity');
              return;
            }
            setActiveConversationId(receipt.entityId);
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }}
        />
        {chatTransferError === undefined && exportChat.error === null
          ? null
          : <p role="alert">{t('Chat transfer error: {{error}}', { error: chatTransferError ?? errorCode(exportChat.error) })}</p>}
      </aside>
      <section className="chat-main">
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
            <span className={`generation-status status-${generation.status}`}>{t(generation.status)}</span>
          </div>
        </header>
        {detail.error ? <p role="alert">{t('Unable to load this conversation.')}</p> : null}
        {createConversation.error ? <p role="alert">{t('Unable to create conversation: {{error}}', { error: errorCode(createConversation.error) })}</p> : null}
        {configureConversation.error ? <p role="alert">{t('Unable to configure conversation: {{error}}', { error: errorCode(configureConversation.error) })}</p> : null}
        <MessageList
          conversationId={activeConversationId}
          messages={detail.data?.messages ?? []}
          streamedText={generation.streamedText}
          streamedReasoning={generation.streamedReasoning}
          generationTarget={generation.target}
          controlsDisabled={generation.isActive || configureConversation.isPending}
          generationDisabled={generation.isActive || configureConversation.isPending || !configurationReady}
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
        {generation.error ? <p role="alert">{t('Generation error: {{error}}', { error: t(generation.error) })}</p> : null}
        {characters.isLoading || personas.isLoading || providers.isLoading || presets.isLoading ? (
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
    </main>
  );
}
