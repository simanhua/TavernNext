import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
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

  const refreshAuthoritativeState = useCallback(async (conversationId: string) => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ['conversation', conversationId] }),
      queryClient.invalidateQueries({ queryKey: ['conversations'] }),
    ]);
  }, [queryClient]);

  const start = useCallback(async (conversation: Conversation, userText: string) => {
    if (status !== 'idle') return;
    setStatus('starting');
    setStreamedText('');
    setError(null);
    generationId.current = null;
    stopRequested.current = false;
    try {
      const response = await api.startGeneration(conversation, userText);
      let terminal = false;
      for await (const event of readGenerationEvents(response)) {
        if (event.type === 'started') {
          generationId.current = event.generationId;
          setStatus('streaming');
        } else if (event.type === 'delta') {
          setStreamedText((current) => current + event.text);
        } else if (event.type === 'completed' || event.type === 'aborted' || event.type === 'failed') {
          terminal = true;
          if (event.type === 'failed') setError(event.code);
          await refreshAuthoritativeState(conversation.id);
          setStreamedText('');
          setStatus('idle');
          generationId.current = null;
        }
      }
      if (!terminal) throw new Error('Generation stream ended without a terminal event');
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'generation_failed');
      await refreshAuthoritativeState(conversation.id).catch(() => undefined);
      setStreamedText('');
      setStatus('idle');
      generationId.current = null;
    }
  }, [refreshAuthoritativeState, status]);

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
