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
  const characters = useQuery({ queryKey: ['characters'], queryFn: api.listCharacters });
  const personas = useQuery({ queryKey: ['personas'], queryFn: api.listPersonas });
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

  useEffect(() => {
    const active = conversations.data?.find((conversation) => conversation.id === activeConversationId);
    if (active !== undefined) {
      setCharacterId(active.characterId);
      setPersonaId(active.personaId);
    }
  }, [activeConversationId, conversations.data]);

  const selectConversation = (id: string) => {
    setActiveConversationId(id === '' ? null : id);
    if (id === '') return;
    const selected = conversations.data?.find((conversation) => conversation.id === id);
    if (selected !== undefined) {
      setCharacterId(selected.characterId);
      setPersonaId(selected.personaId);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (text === '' || generation.isActive) return;
    let target: Conversation | undefined = detail.data?.conversation;
    try {
      if (target === undefined) {
        const character = characters.data?.find((candidate) => candidate.id === characterId);
        target = await createConversation.mutateAsync({
          characterId,
          personaId,
          title: character === undefined ? 'New chat' : `${character.name} chat`,
        });
      }
      setDraft('');
      await generation.start(target, text);
    } catch {
      // Mutation state owns accessible feedback; keep the draft for retry.
    }
  };

  const prerequisitesReady = activeConversationId !== null || (characterId !== '' && personaId !== '');
  const composerDisabled = !prerequisitesReady
    || generation.isActive
    || createConversation.isPending
    || characters.isLoading
    || personas.isLoading;

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
        <MessageList
          conversationId={activeConversationId}
          messages={detail.data?.messages ?? []}
          streamedText={generation.streamedText}
          controlsDisabled={generation.isActive}
        />
        {generation.error ? <p role="alert">Generation error: {generation.error}</p> : null}
        <Composer
          draft={draft}
          disabled={composerDisabled}
          canStop={generation.canStop}
          stopping={generation.status === 'stopping'}
          onDraftChange={setDraft}
          onSend={() => { void send(); }}
          onStop={() => { void generation.stop(); }}
        />
      </section>
    </main>
  );
}
