import type {
  Conversation,
  ConversationSceneState,
  InstalledScene,
  Message,
  MessageVariant,
  Persona,
} from './entities.js';

export type SceneRuntimeMode = 'setup' | 'workspace';
export type SceneGenerationStatus = 'idle' | 'starting' | 'streaming' | 'stopping';

export interface SceneMessageView extends Message {
  variants: MessageVariant[];
  speakerLabel?: string;
}

export interface SceneConversationDetail {
  conversation: Conversation;
  messages: SceneMessageView[];
}

export interface SceneGenerationSnapshot {
  status: SceneGenerationStatus;
  streamedText: string;
  streamedReasoning: string;
  error: string | null;
}

export type SceneGenerationEvent =
  | { type: 'snapshot'; value: SceneGenerationSnapshot }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string };

export interface SceneThemeSnapshot {
  scheme: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface SceneSdkErrorShape {
  code: string;
  status?: number;
  latest?: unknown;
}

export interface SceneSdkV2 {
  readonly version: 2;
  readonly mode: SceneRuntimeMode;
  readonly sceneId: string;
  readonly conversationId?: string;
  context: {
    get(): Promise<{
      mode: SceneRuntimeMode;
      scene: InstalledScene['manifest'];
      conversation?: Conversation;
      playerProfile: { name: string; description: string };
    }>;
  };
  setup: {
    listPersonas(): Promise<Persona[]>;
    createConversation(input: {
      title: string;
      personaTemplateId?: string;
      playerProfile: { name: string; description: string };
      setup: Record<string, unknown>;
      maxPromptTokens?: number;
      maxResponseTokens?: number;
    }): Promise<Conversation>;
  };
  messages: {
    list(): Promise<SceneConversationDetail>;
    send(text: string): Promise<unknown>;
    stop(): Promise<void>;
    edit(messageId: string, content: string): Promise<Message>;
    delete(messageId: string): Promise<void>;
    switchVariant(messageId: string, variantId: string): Promise<Message>;
    continue(messageId: string): Promise<unknown>;
    regenerate(messageId: string): Promise<unknown>;
    swipe(messageId: string): Promise<unknown>;
  };
  state: {
    get(): Promise<ConversationSceneState>;
    patch(operations: unknown[]): Promise<ConversationSceneState>;
  };
  scene: {
    action(action: unknown): Promise<{ state: ConversationSceneState; result: unknown }>;
    assetUrl(path: string): string;
  };
  generation: {
    getSnapshot(): SceneGenerationSnapshot;
    subscribe(listener: (event: SceneGenerationEvent) => void): () => void;
    stop(): Promise<void>;
  };
  theme: {
    getSnapshot(): SceneThemeSnapshot;
    subscribe(listener: (snapshot: SceneThemeSnapshot) => void): () => void;
  };
}

export interface SceneFrontendMountInput {
  root: HTMLElement;
  mode: SceneRuntimeMode;
  sdk: SceneSdkV2;
}

export type SceneFrontendCleanup = () => void | Promise<void>;

export interface SceneFrontendModule {
  mount(input: SceneFrontendMountInput):
    | void
    | SceneFrontendCleanup
    | Promise<void | SceneFrontendCleanup>;
}
