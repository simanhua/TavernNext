import type { AgentActivityKind, GenerationMode, MessageVariant } from '@tavernnext/domain';
import type { PromptSnapshotErrorCode } from './prompt-snapshot-service.js';

export type SaveAgentRuntimeEvent =
  | { readonly type: 'started'; readonly generationId: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'activity'; readonly kind: AgentActivityKind; readonly label: string }
  | { readonly type: 'view_placeholder'; readonly viewId: string; readonly kind: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'completed'; readonly finishReason: string }
  | { readonly type: 'aborted' }
  | { readonly type: 'failed'; readonly code: string };

export interface SaveAgentRunInput {
  readonly conversationId: string;
  readonly conversationRevision: number;
  readonly mode: GenerationMode;
  readonly userText?: string;
  readonly seed?: string | number;
  readonly messageIndex?: number;
  readonly reuseLastUser?: boolean;
}

export type StartSaveAgentRunFailure = 'generation_active' | 'scene_branch_has_descendants' | PromptSnapshotErrorCode;
export type StartSaveAgentRunResult =
  | {
    readonly ok: true;
    readonly generationId: string;
    readonly events: AsyncIterable<SaveAgentRuntimeEvent>;
  }
  | { readonly ok: false; readonly reason: StartSaveAgentRunFailure };

export interface SaveAgentRuntime {
  start(input: SaveAgentRunInput, signal?: AbortSignal): Promise<StartSaveAgentRunResult>;
  triggerLastUser(conversationId: string, signal?: AbortSignal): Promise<StartSaveAgentRunResult>;
  regenerateActionOptions(input: {
    conversationId: string;
    messageId: string;
    variantId: string;
    variantRevision: number;
  }, signal?: AbortSignal): Promise<
    | { ok: true; variant: MessageVariant }
    | { ok: false; reason: 'not_found' | 'invalid_target' | 'conflict' | 'generation_active'
      | 'provider_not_configured' | 'model_not_agent_capable' | 'action_options_generation_failed' }
  >;
  cancel(generationId: string): boolean;
  isConversationActive(conversationId: string): boolean;
}
