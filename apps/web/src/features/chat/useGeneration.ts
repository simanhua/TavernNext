import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  GenerationSessionController,
  type ActiveGenerationTarget,
  type GenerationStartInput,
  type GenerationStartOptions,
  type GenerationStartOutcome,
} from './generation-session.js';

export type {
  ActiveGenerationTarget,
  GenerationStartInput,
  GenerationStartOptions,
  GenerationStartOutcome,
};

export function useGeneration() {
  const queryClient = useQueryClient();
  const [controller] = useState(() => new GenerationSessionController({
    refreshAuthoritativeState: async (conversationId) => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['conversation', conversationId] }),
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-runs', conversationId] }),
      ]);
    },
  }));
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);

  useEffect(() => {
    controller.activate();
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return {
    ...snapshot,
    isActive: snapshot.status !== 'idle',
    canStop: controller.canStop,
    start: controller.start,
    stop: controller.stop,
    getSnapshot: controller.getSnapshot,
    subscribeEvents: controller.subscribeEvents,
  };
}
