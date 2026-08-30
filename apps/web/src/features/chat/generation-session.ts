import type { SceneGenerationEvent, SceneGenerationSnapshot } from '@tavernnext/domain';
import type { Conversation, MessageView } from '../../api/client.js';
import { api } from '../../api/client.js';
import { readGenerationEvents } from '../../api/generation-stream.js';

type NonNormalMode = 'swipe' | 'regenerate';

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

export interface GenerationSessionSnapshot extends SceneGenerationSnapshot {
  target: ActiveGenerationTarget | null;
}

export interface GenerationSessionDependencies {
  refreshAuthoritativeState(conversationId: string): Promise<void>;
}

const EMPTY_SNAPSHOT: GenerationSessionSnapshot = {
  status: 'idle',
  streamedText: '',
  streamedReasoning: '',
  error: null,
  activities: [],
  viewPlaceholders: [],
  target: null,
};

export class GenerationSessionController {
  private snapshot: GenerationSessionSnapshot = { ...EMPTY_SNAPSHOT };
  private readonly stateListeners = new Set<(snapshot: GenerationSessionSnapshot) => void>();
  private readonly eventListeners = new Set<(event: SceneGenerationEvent) => void>();
  private generationId: string | null = null;
  private stopRequested = false;
  private activeRequest: AbortController | null = null;
  private active = false;
  private mounted = true;

  constructor(private readonly dependencies: GenerationSessionDependencies) {}

  getSnapshot = (): GenerationSessionSnapshot => this.snapshot;

  subscribe = (listener: (snapshot: GenerationSessionSnapshot) => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  subscribeEvents = (listener: (event: SceneGenerationEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  };

  activate(): void {
    this.mounted = true;
  }

  dispose(): void {
    this.mounted = false;
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.active = false;
    this.generationId = null;
    this.stopRequested = false;
    this.replace({ ...EMPTY_SNAPSHOT });
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) listener(this.snapshot);
  }

  private notifyEvent(event: SceneGenerationEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private replace(snapshot: GenerationSessionSnapshot, publishEvent = true): void {
    this.snapshot = snapshot;
    this.notifyState();
    if (publishEvent) this.notifyEvent({ type: 'snapshot', value: snapshot });
  }

  private patch(patch: Partial<GenerationSessionSnapshot>, publishEvent = true): void {
    this.replace({ ...this.snapshot, ...patch }, publishEvent);
  }

  start = async (
    conversation: Conversation,
    input: GenerationStartInput,
    options: GenerationStartOptions = {},
  ): Promise<GenerationStartOutcome> => {
    if (this.active) return 'busy';
    this.active = true;
    let accepted = false;
    const controller = new AbortController();
    this.activeRequest = controller;
    this.generationId = null;
    this.stopRequested = false;
    this.replace({
      status: 'starting',
      streamedText: '',
      streamedReasoning: '',
      error: null,
      activities: [],
      viewPlaceholders: [],
      target: input.mode === 'normal' ? null : {
        mode: input.mode,
        messageId: input.target.id,
        baseContent: input.baseContent,
      },
    });
    try {
      const requestInput: { mode: 'normal' | NonNormalMode; userText?: string } = input.mode === 'normal'
        ? { mode: 'normal', userText: input.userText }
        : { mode: input.mode };
      const response = await api.startGeneration(conversation, requestInput, controller.signal);
      let terminal = false;
      for await (const event of readGenerationEvents(response, controller.signal)) {
        if (!this.mounted) return accepted ? 'accepted' : 'rejected';
        if (event.type === 'started') {
          if (!accepted) {
            accepted = true;
            options.onAccepted?.();
          }
          this.generationId = event.generationId;
          this.patch({ status: 'streaming' });
        } else if (event.type === 'reasoning_delta') {
          this.patch({ streamedReasoning: this.snapshot.streamedReasoning + event.text }, false);
          this.notifyEvent({ type: 'reasoning-delta', text: event.text });
        } else if (event.type === 'delta') {
          this.patch({ streamedText: this.snapshot.streamedText + event.text }, false);
          this.notifyEvent({ type: 'text-delta', text: event.text });
        } else if (event.type === 'activity') {
          const activity = { kind: event.kind, label: event.label };
          this.patch({ activities: [...this.snapshot.activities, activity].slice(-32) }, false);
          this.notifyEvent({ type: 'activity', ...activity });
        } else if (event.type === 'view_placeholder') {
          if (this.snapshot.viewPlaceholders.some((placeholder) => placeholder.viewId === event.viewId)) continue;
          const placeholder = {
            viewId: event.viewId,
            kind: event.kind,
            offset: this.snapshot.streamedText.length,
          };
          this.patch({ viewPlaceholders: [...this.snapshot.viewPlaceholders, placeholder].slice(-16) }, false);
          this.notifyEvent({ type: 'view-placeholder', ...placeholder });
        } else if (event.type === 'completed' || event.type === 'aborted' || event.type === 'failed') {
          terminal = true;
          if (event.type === 'failed') this.patch({ error: event.code });
          await this.dependencies.refreshAuthoritativeState(conversation.id);
          if (!this.mounted) return accepted ? 'accepted' : 'rejected';
          this.replace({ ...EMPTY_SNAPSHOT, error: event.type === 'failed' ? event.code : null });
          this.active = false;
          this.activeRequest = null;
          this.generationId = null;
        }
      }
      if (!terminal) throw new Error('Generation stream ended without a terminal event');
      return accepted ? 'accepted' : 'rejected';
    } catch (generationError) {
      if (!this.mounted || controller.signal.aborted) return accepted ? 'accepted' : 'rejected';
      const error = generationError instanceof Error ? generationError.message : 'generation_failed';
      await this.dependencies.refreshAuthoritativeState(conversation.id).catch(() => undefined);
      if (!this.mounted) return accepted ? 'accepted' : 'rejected';
      this.replace({ ...EMPTY_SNAPSHOT, error });
      this.active = false;
      this.activeRequest = null;
      this.generationId = null;
      return accepted ? 'accepted' : 'rejected';
    }
  };

  stop = async (): Promise<void> => {
    const id = this.generationId;
    if (id === null || this.stopRequested) return;
    this.stopRequested = true;
    this.patch({ status: 'stopping' });
    try {
      await api.stopGeneration(id);
    } catch (stopError) {
      this.stopRequested = false;
      this.patch({
        status: 'streaming',
        error: stopError instanceof Error ? stopError.message : 'stop_failed',
      });
    }
  };

  get canStop(): boolean {
    return (this.snapshot.status === 'streaming' || this.snapshot.status === 'stopping')
      && this.generationId !== null;
  }
}
