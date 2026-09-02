import type {
  AgentActivityKind,
  Conversation,
  ConversationSceneState,
  InstalledScene,
  Message,
  MessageVariant,
  Persona,
  PlayerOperation,
} from './entities.js';
import type { ScenePatchFailure, ScenePatchOperation } from './scene-state.js';
import type { RoleplaySceneViewBlock } from './roleplay-document.js';

export type SceneRuntimeMode = 'setup' | 'workspace';
export const SCENE_ACTION_ENVELOPE_PROTOCOL = 'tavernnext-player-operation-v1' as const;
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
  activities: Array<{ kind: AgentActivityKind; label: string }>;
  viewPlaceholders: Array<{ viewId: string; kind: string; offset: number }>;
}

export type SceneGenerationEvent =
  | { type: 'snapshot'; value: SceneGenerationSnapshot }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'activity'; kind: AgentActivityKind; label: string }
  | { type: 'view-placeholder'; viewId: string; kind: string; offset: number };

export interface SceneThemeSnapshot {
  scheme: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface SceneStatusRailField {
  label: string;
  value: string;
}

export interface SceneStatusRailAction {
  id: string;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export type SceneStatusRailSection =
  | {
    kind: 'identity';
    title: string;
    overline?: string;
    subtitle?: string;
    badge?: { label?: string; value: string };
  }
  | { kind: 'fields'; title?: string; fields: SceneStatusRailField[] }
  | {
    kind: 'meters';
    meters: Array<{ label: string; value: number; maximum: number; displayValue?: string; tone?: string }>;
  }
  | {
    kind: 'stats';
    title?: string;
    aside?: string;
    stats: Array<{ label: string; value: string; action?: SceneStatusRailAction }>;
  }
  | {
    kind: 'cards';
    title?: string;
    cards: Array<{ title: string; fields: SceneStatusRailField[] }>;
    emptyText: string;
  };

export interface SceneStatusRailTab {
  id: string;
  label: string;
  sections: SceneStatusRailSection[];
}

export interface SceneStatusRailModel {
  title: string;
  overline?: string;
  ariaLabel?: string;
  closeLabel?: string;
  tabs: SceneStatusRailTab[];
}

export interface SceneStatusRailController {
  update(model: SceneStatusRailModel, activeTab?: string): void;
  setOpen(open: boolean, restoreFocus?: boolean): void;
  destroy(): void;
}

export interface SceneStatusRailMountOptions {
  container: HTMLElement;
  trigger?: HTMLElement;
  model: SceneStatusRailModel;
  activeTab?: string;
  open?: boolean;
  onTabChange?(tabId: string): void;
  onOpenChange?(open: boolean): void;
  onAction?(actionId: string): void | Promise<void>;
}

export interface SceneSpeechInputLabels {
  start: string;
  stop: string;
  unsupported: string;
  permissionDenied: string;
  unavailable: string;
  noSpeech: string;
}

export interface SceneSpeechInputMountOptions {
  input: HTMLTextAreaElement;
  button: HTMLButtonElement;
  language?: string;
  labels?: Partial<SceneSpeechInputLabels>;
}

export interface SceneSpeechInputController {
  stop(): void;
  destroy(): void;
}

export type SceneReferenceKind = 'preset' | 'worldbook';

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
    switchVariant(variantId: string): Promise<Message>;
    regenerate(): Promise<unknown>;
    swipe(): Promise<unknown>;
    regenerateActionOptions(): Promise<MessageVariant>;
  };
  state: {
    get(): Promise<ConversationSceneState>;
    patch(operations: ScenePatchOperation[]): Promise<{
      state: ConversationSceneState;
      failures: ScenePatchFailure[];
    }>;
  };
  scene: {
    action(action: unknown, options?: { operation?: PlayerOperation }): Promise<{
      state: ConversationSceneState;
      result: unknown;
      operation?: PlayerOperation & { messageId: string };
    }>;
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
  ui: {
    statusRail: {
      mount(options: SceneStatusRailMountOptions): SceneStatusRailController;
    };
    speechInput: {
      mount(options: SceneSpeechInputMountOptions): SceneSpeechInputController;
    };
    referenceViewer: {
      open(kind: SceneReferenceKind): void;
    };
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
  renderSceneView?(input: { root: HTMLElement; block: RoleplaySceneViewBlock }):
    | void
    | SceneFrontendCleanup
    | Promise<void | SceneFrontendCleanup>;
}
