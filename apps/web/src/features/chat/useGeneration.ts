import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation, MessageView } from '../../api/client.js';
import { api } from '../../api/client.js';
import { readGenerationEvents } from '../../api/generation-stream.js';

type GenerationStatus = 'idle' | 'starting' | 'streaming' | 'stopping';
type NonNormalMode = 'swipe' | 'regenerate' | 'continue';

export type GenerationStartInput =
  | { mode: 'normal'; userText: string }
  | { mode: NonNormalMode; target: MessageView; baseContent: string };

export interface ActiveGenerationTarget {
  mode: NonNormalMode;
  messageId: string;
  baseContent: string;
}

export type GenerationStartOutcome = 'accepted' | 'rejected' | 'busy';
export interface GenerationStartOptions { onAccepted?: () => void }

export function useGeneration() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<GenerationStatus>('idle');
  const [streamedText, setStreamedText] = useState('');
  const [streamedReasoning, setStreamedReasoning] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ActiveGenerationTarget | null>(null);
  const generationId = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const active = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
      active.current = false;
    };
  }, []);

  const refreshAuthoritativeState = useCallback(async (conversationId: string) => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ['conversation', conversationId] }),
      queryClient.invalidateQueries({ queryKey: ['conversations'] }),
    ]);
  }, [queryClient]);

  const start = useCallback(async (
    conversation: Conversation,
    input: GenerationStartInput,
    options: GenerationStartOptions = {},
  ): Promise<GenerationStartOutcome> => {
    if (active.current) return 'busy';
    active.current = true;
    let accepted = false;
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus('starting');
    setStreamedText('');
    setStreamedReasoning('');
    setError(null);
    setTarget(input.mode === 'normal' ? null : {
      mode: input.mode,
      messageId: input.target.id,
      baseContent: input.baseContent,
    });
    generationId.current = null;
    stopRequested.current = false;
    try {
      const response = await api.startGeneration(conversation, input.mode === 'normal'
        ? { mode: 'normal', userText: input.userText }
        : { mode: input.mode }, controller.signal);
      let terminal = false;
      for await (const event of readGenerationEvents(response, controller.signal)) {
        if (!mounted.current) return accepted ? 'accepted' : 'rejected';
        if (event.type === 'started') {
          if (!accepted) {
            accepted = true;
            options.onAccepted?.();
          }
          generationId.current = event.generationId;
          setStatus('streaming');
        } else if (event.type === 'reasoning_delta') {
          setStreamedReasoning((current) => current + event.text);
        } else if (event.type === 'delta') {
          setStreamedText((current) => current + event.text);
        } else if (event.type === 'completed' || event.type === 'aborted' || event.type === 'failed') {
          terminal = true;
          if (event.type === 'failed') setError(event.code);
          await refreshAuthoritativeState(conversation.id);
          if (!mounted.current) return accepted ? 'accepted' : 'rejected';
          setStreamedText('');
          setStreamedReasoning('');
          setTarget(null);
          setStatus('idle');
          active.current = false;
          activeRequest.current = null;
          generationId.current = null;
        }
      }
      if (!terminal) throw new Error('Generation stream ended without a terminal event');
      return accepted ? 'accepted' : 'rejected';
    } catch (generationError) {
      if (!mounted.current || controller.signal.aborted) return accepted ? 'accepted' : 'rejected';
      setError(generationError instanceof Error ? generationError.message : 'generation_failed');
      await refreshAuthoritativeState(conversation.id).catch(() => undefined);
      if (!mounted.current) return accepted ? 'accepted' : 'rejected';
      setStreamedText('');
      setStreamedReasoning('');
      setTarget(null);
      setStatus('idle');
      active.current = false;
      activeRequest.current = null;
      generationId.current = null;
      return accepted ? 'accepted' : 'rejected';
    }
  }, [refreshAuthoritativeState]);

  const stop = useCallback(async () => {
    const id = generationId.current;
    if (id === null || stopRequested.current) return;
    stopRequested.current = true;
    setStatus('stopping');
    try {
      await api.stopGeneration(id);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'stop_failed');
      stopRequested.current = false;
      setStatus('streaming');
    }
  }, []);

  return {
    status,
    streamedText,
    streamedReasoning,
    target,
    error,
    isActive: status !== 'idle',
    canStop: (status === 'streaming' || status === 'stopping') && generationId.current !== null,
    start,
    stop,
  };
}
