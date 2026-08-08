import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../api/client.js';
import { api } from '../../api/client.js';
import { readGenerationEvents } from '../../api/generation-stream.js';

type GenerationStatus = 'idle' | 'starting' | 'streaming' | 'stopping';

export function useGeneration() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<GenerationStatus>('idle');
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
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

  const start = useCallback(async (conversation: Conversation, userText: string) => {
    if (active.current) return;
    active.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus('starting');
    setStreamedText('');
    setError(null);
    generationId.current = null;
    stopRequested.current = false;
    try {
      const response = await api.startGeneration(conversation, userText, controller.signal);
      let terminal = false;
      for await (const event of readGenerationEvents(response, controller.signal)) {
        if (!mounted.current) return;
        if (event.type === 'started') {
          generationId.current = event.generationId;
          setStatus('streaming');
        } else if (event.type === 'delta') {
          setStreamedText((current) => current + event.text);
        } else if (event.type === 'completed' || event.type === 'aborted' || event.type === 'failed') {
          terminal = true;
          if (event.type === 'failed') setError(event.code);
          await refreshAuthoritativeState(conversation.id);
          if (!mounted.current) return;
          setStreamedText('');
          setStatus('idle');
          active.current = false;
          activeRequest.current = null;
          generationId.current = null;
        }
      }
      if (!terminal) throw new Error('Generation stream ended without a terminal event');
    } catch (generationError) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(generationError instanceof Error ? generationError.message : 'generation_failed');
      await refreshAuthoritativeState(conversation.id).catch(() => undefined);
      if (!mounted.current) return;
      setStreamedText('');
      setStatus('idle');
      active.current = false;
      activeRequest.current = null;
      generationId.current = null;
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
    error,
    isActive: status !== 'idle',
    canStop: (status === 'streaming' || status === 'stopping') && generationId.current !== null,
    start,
    stop,
  };
}
