import type { ExtensionAssetKind } from '@tavernnext/domain';

export interface TrustedScriptAssetInput {
  kind: ExtensionAssetKind;
  sourceKey: string;
  ordinal: number;
  enabled: boolean;
  payload: unknown;
}

export interface ExtensionRuntimeOwnerRef { kind: 'preset' | 'character'; id: string }

export interface TrustedScriptOwnerInput {
  owner: ExtensionRuntimeOwnerRef;
  revision: number;
  bundleDigest: string;
  trusted: boolean;
  assets: TrustedScriptAssetInput[];
  remoteEntries?: Array<{ url: string; sha256: string }>;
}

export interface TrustedRuntimeScript {
  owner: ExtensionRuntimeOwnerRef;
  ownerRevision: number;
  bundleDigest: string;
  id: string;
  sourceId: string;
  name: string;
  content: string;
  order: number[];
}

export const TAVERN_HELPER_BRIDGED_METHODS = Object.freeze([
  'getChatMessages', 'setChatMessages', 'createChatMessages', 'deleteChatMessages', 'getLastMessageId', 'getMessageId',
  'getVariables', 'getAllVariables', 'replaceVariables', 'updateVariablesWith', 'insertVariables', 'deleteVariable',
  'getTavernRegexes', 'replaceTavernRegexes',
  'getWorldbookNames', 'getWorldbook', 'getLorebookEntries', 'updateLorebookEntriesWith',
  'substitudeMacros', 'injectPrompts', 'uninjectPrompts',
  'generate', 'generateRaw', 'triggerSlash',
] as const);
export type TavernHelperBridgedMethod = typeof TAVERN_HELPER_BRIDGED_METHODS[number];

export interface TrustedRuntimeButton {
  owner: ExtensionRuntimeOwnerRef;
  scriptId: string;
  name: string;
}

export function trustedRuntimeScriptId(owner: ExtensionRuntimeOwnerRef, sourceId: string): string {
  return `${owner.kind}:${owner.id}:${sourceId}`;
}

export interface TrustedScriptManifest {
  conversationId: string;
  runtimeKey: string;
  scripts: TrustedRuntimeScript[];
  buttons: TrustedRuntimeButton[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function children(value: Record<string, unknown>): unknown[] {
  for (const key of ['children', 'scripts', 'value']) if (Array.isArray(value[key])) return value[key];
  return [];
}

function visibleButtons(value: Record<string, unknown>): string[] {
  const button = record(value.button);
  if (button?.enabled === false || !Array.isArray(button?.buttons)) return [];
  return button.buttons.flatMap((candidate) => {
    const item = record(candidate);
    return item?.visible !== false && typeof item?.name === 'string' && item.name !== '' ? [item.name] : [];
  });
}

function ownerScripts(owner: TrustedScriptOwnerInput): { scripts: TrustedRuntimeScript[]; buttons: TrustedRuntimeButton[] } {
  if (!owner.trusted) return { scripts: [], buttons: [] };
  const scripts: TrustedRuntimeScript[] = [];
  const buttons: TrustedRuntimeButton[] = [];
  const visit = (value: unknown, asset: TrustedScriptAssetInput, order: number[], inheritedEnabled: boolean) => {
    const node = record(value);
    if (node === undefined) return;
    const enabled = inheritedEnabled && node.enabled !== false;
    if (node.type === 'script' && enabled) {
      const sourceId = typeof node.id === 'string' && node.id !== '' ? node.id : `${asset.sourceKey}:${order.join('.')}`;
      const id = trustedRuntimeScriptId(owner.owner, sourceId);
      const content = (typeof node.content === 'string' ? node.content : '');
      const pinnedContent = (owner.remoteEntries ?? []).reduce((current, remote) => current.replaceAll(
        remote.url,
        `/api/extension-trust/${owner.owner.kind}/${encodeURIComponent(owner.owner.id)}/cache/${remote.sha256}`,
      ), content);
      scripts.push({
        owner: owner.owner,
        ownerRevision: owner.revision,
        bundleDigest: owner.bundleDigest,
        id,
        sourceId,
        name: typeof node.name === 'string' && node.name !== '' ? node.name : id,
        content: pinnedContent,
        order,
      });
      buttons.push(...visibleButtons(node).map((name) => ({
        owner: owner.owner, scriptId: id, name,
      })));
    }
    children(node).forEach((child, index) => visit(child, asset, [...order, index], enabled));
  };
  owner.assets.filter((asset) => asset.kind === 'tavern_helper' && asset.enabled)
    .sort((left, right) => left.ordinal - right.ordinal || left.sourceKey.localeCompare(right.sourceKey))
    .forEach((asset) => visit(asset.payload, asset, [asset.ordinal], true));
  return { scripts, buttons };
}

export function buildTrustedScriptManifest(
  conversationId: string,
  owners: { preset?: TrustedScriptOwnerInput | null; character?: TrustedScriptOwnerInput | null },
): TrustedScriptManifest {
  const activeOwners = [owners.preset, owners.character].filter((owner): owner is TrustedScriptOwnerInput => owner != null);
  const projections = activeOwners.map(ownerScripts);
  return {
    conversationId,
    runtimeKey: [conversationId, ...activeOwners.map((owner) => (
      `${owner.owner.kind}:${owner.owner.id}:${owner.revision}:${owner.bundleDigest}:${owner.trusted}`
    ))].join('|'),
    scripts: projections.flatMap((projection) => projection.scripts),
    buttons: projections.flatMap((projection) => projection.buttons),
  };
}
