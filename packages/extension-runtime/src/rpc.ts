import { ExtensionOwnerKindSchema } from '@tavernnext/domain';
import { z } from 'zod';
import { TAVERN_HELPER_BRIDGED_METHODS } from './trusted-scripts.js';

export const TavernHelperBridgedMethodSchema = z.enum(TAVERN_HELPER_BRIDGED_METHODS);
const RuntimeIdentityShape = {
  ownerKind: ExtensionOwnerKindSchema,
  ownerId: z.string().uuid(),
  ownerRevision: z.number().int().nonnegative(),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scriptId: z.string().min(1).max(1024),
  args: z.array(z.unknown()).max(64).default([]),
  currentMessageId: z.number().int().nonnegative().optional(),
};
export const ExtensionRuntimeRpcRequestSchema = z.object({
  ...RuntimeIdentityShape,
  method: TavernHelperBridgedMethodSchema,
}).strict();
export const ExtensionRuntimeRpcEnvelopeSchema = z.object({
  ...RuntimeIdentityShape,
  method: z.string().min(1).max(200),
}).strict();
export type ExtensionRuntimeRpcEnvelope = z.infer<typeof ExtensionRuntimeRpcEnvelopeSchema>;
export type ExtensionRuntimeRpcRequest = z.infer<typeof ExtensionRuntimeRpcRequestSchema>;

export const MUTATING_TAVERN_HELPER_METHODS = new Set<string>([
  'setChatMessages', 'createChatMessages', 'deleteChatMessages',
  'replaceVariables', 'updateVariablesWith', 'insertVariables', 'deleteVariable',
  'replaceTavernRegexes', 'updateLorebookEntriesWith', 'injectPrompts', 'uninjectPrompts',
  'generate', 'generateRaw', 'triggerSlash',
]);
export const GENERATION_BLOCKED_TAVERN_HELPER_METHODS = new Set<string>([
  'setChatMessages', 'createChatMessages', 'deleteChatMessages',
]);
