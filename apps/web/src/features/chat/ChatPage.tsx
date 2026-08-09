import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorCode, type Conversation } from '../../api/client.js';
import { CharacterQuickCreate } from '../characters/CharacterQuickCreate.js';
import { PersonaQuickCreate } from '../personas/PersonaQuickCreate.js';
import { useChatUi } from './chat-store.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { useGeneration } from './useGeneration.js';

export function ChatPage() {
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

  const selectedProvider = providers.data?.find((provider) => provider.id === providerId);
  const requiredPrimaryKind = selectedProvider?.apiMode === 'text' ? 'text' : 'chat';
  const primaryPresetValid = presets.data?.some((preset) => preset.id === presetId && preset.kind === requiredPrimaryKind) === true;
  const textCompanionsValid = selectedProvider?.apiMode !== 'text' || (
    presets.data?.some((preset) => preset.id === contextPresetId && preset.kind === 'context') === true
    && presets.data?.some((preset) => preset.id === instructPresetId && preset.kind === 'instruct') === true
    && presets.data?.some((preset) => preset.id === systemPresetId && preset.kind === 'system') === true
  );
  const configurationReady = selectedProvider !== undefined && primaryPresetValid && textCompanionsValid;

  const selectedConfiguration = () => ({
    providerId,
    presetId,
    ...(selectedProvider?.apiMode !== 'text' ? {} : {
      contextPresetId,
      instructPresetId,
      systemPresetId,
    }),
  });

  const ensureConfigured = async (target: Conversation): Promise<Conversation> => {
    if (!configurationReady) throw new Error('configuration_not_ready');
    const configuration = selectedConfiguration();
    const listed = conversations.data?.find((conversation) => conversation.id === target.id) ?? target;
    const differs = listed.providerId !== configuration.providerId
      || listed.presetId !== configuration.presetId
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
    }
  }, [activeConversationId, conversations.data]);

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
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (text === '' || generation.isActive) return;
    let target: Conversation | undefined = detail.data?.conversation;
    try {
      const configuration = selectedConfiguration();
      if (target === undefined) {
        const character = characters.data?.find((candidate) => candidate.id === characterId);
        target = await createConversation.mutateAsync({
          characterId,
          personaId,
          title: character === undefined ? 'New chat' : `${character.name} chat`,
          ...configuration,
        });
      } else {
        target = await ensureConfigured(target);
      }
      setDraft('');
      await generation.start(target, { mode: 'normal', userText: text });
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
    || presets.isLoading;

  return (
    <main className="chat-page">
      <aside className="chat-sidebar">
        <h1>TavernNext</h1>
        <label>
          Conversation
          <select
            value={activeConversationId ?? ''}
            disabled={generation.isActive}
            onChange={(event) => selectConversation(event.target.value)}
          >
            <option value="">New conversation</option>
            {(conversations.data ?? []).map((conversation) => (
              <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
            ))}
          </select>
        </label>
        <label>
          Character
          <select
            value={characterId}
            disabled={activeConversationId !== null || generation.isActive}
            onChange={(event) => setCharacterId(event.target.value)}
          >
            <option value="">Choose Character</option>
            {(characters.data ?? []).map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select>
        </label>
        <label>
          Persona
          <select
            value={personaId}
            disabled={activeConversationId !== null || generation.isActive}
            onChange={(event) => setPersonaId(event.target.value)}
          >
            <option value="">Choose Persona</option>
            {(personas.data ?? []).map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
          </select>
        </label>
        <label>
          Provider
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
            <option value="">Choose Provider</option>
            {(providers.data ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label>
          {selectedProvider?.apiMode === 'text' ? 'Text preset' : 'Chat preset'}
          <select value={presetId} disabled={providerId === '' || generation.isActive} onChange={(event) => setPresetId(event.target.value)}>
            <option value="">Choose {selectedProvider?.apiMode === 'text' ? 'Text' : 'Chat'} preset</option>
            {(presets.data ?? []).filter((preset) => preset.kind === requiredPrimaryKind)
              .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        {selectedProvider?.apiMode === 'text' ? (
          <>
            <label>
              Context preset
              <select value={contextPresetId} disabled={generation.isActive} onChange={(event) => setContextPresetId(event.target.value)}>
                <option value="">Choose Context preset</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'context')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            <label>
              Instruct preset
              <select value={instructPresetId} disabled={generation.isActive} onChange={(event) => setInstructPresetId(event.target.value)}>
                <option value="">Choose Instruct preset</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'instruct')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
            <label>
              System preset
              <select value={systemPresetId} disabled={generation.isActive} onChange={(event) => setSystemPresetId(event.target.value)}>
                <option value="">Choose System preset</option>
                {(presets.data ?? []).filter((preset) => preset.kind === 'system')
                  .map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
          </>
        ) : null}
        <details><summary>Add Character</summary><CharacterQuickCreate /></details>
        <details><summary>Add Persona</summary><PersonaQuickCreate /></details>
      </aside>
      <section className="chat-main">
        <header className="chat-header">
          <h2>{detail.data?.conversation.title ?? 'New conversation'}</h2>
          <span className={`generation-status status-${generation.status}`}>{generation.status}</span>
        </header>
        {detail.error ? <p role="alert">Unable to load this conversation.</p> : null}
        {createConversation.error ? <p role="alert">Unable to create conversation: {errorCode(createConversation.error)}</p> : null}
        {configureConversation.error ? <p role="alert">Unable to configure conversation: {errorCode(configureConversation.error)}</p> : null}
        <MessageList
          conversationId={activeConversationId}
          messages={detail.data?.messages ?? []}
          streamedText={generation.streamedText}
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
        {generation.error ? <p role="alert">Generation error: {generation.error}</p> : null}
        {characters.isLoading || personas.isLoading || providers.isLoading || presets.isLoading ? (
          <p>Loading chat configuration…</p>
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
