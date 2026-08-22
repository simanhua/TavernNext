import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAsset, ExtensionOwnerKind } from '@tavernnext/domain';
import type { Repositories } from '../db/repositories.js';

export const EXTENSION_TRUST_RISK_VERSION = 1;
const MAX_REMOTE_BYTES = 8 * 1024 * 1024;

export interface ExtensionRemoteFetcher {
  (url: string): Promise<{ bytes: Uint8Array; mediaType: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function canonicalizeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  const object = asRecord(value);
  return object === undefined ? value : Object.fromEntries(Object.entries(object)
    .sort(([a], [b]) => compare(a, b))
    .map(([key, nested]) => [key, canonicalizeForDigest(nested)]));
}
function scriptChildren(object: Record<string, unknown>): unknown[] | undefined {
  for (const key of ['children', 'scripts', 'value']) {
    if (Array.isArray(object[key])) return object[key];
  }
  return undefined;
}
function executableNode(value: unknown): unknown {
  const object = asRecord(value);
  if (object === undefined) return value;
  const children = scriptChildren(object);
  return {
    type: object.type,
    id: object.id,
    enabled: object.enabled !== false,
    ...(object.type === 'script' ? { content: typeof object.content === 'string' ? object.content : '' } : {}),
    ...(children === undefined ? {} : { children: children.map(executableNode) }),
  };
}
function executableSources(asset: ExtensionAsset): string[] {
  const payload = asRecord(asset.payload);
  if (payload === undefined) return [];
  if (asset.kind === 'regex') {
    return typeof payload.replaceString === 'string' ? [payload.replaceString] : [];
  }
  const sources: string[] = [];
  const visit = (value: unknown) => {
    const node = asRecord(value);
    if (node === undefined) return;
    if (node.type === 'script' && typeof node.content === 'string') sources.push(node.content);
    scriptChildren(node)?.forEach(visit);
  };
  visit(asset.payload);
  return sources;
}
function scriptReviewRows(asset: ExtensionAsset): Array<{
  sourceKey: string; ordinal: number; order: number[]; enabled: boolean; name: string;
}> {
  const rows: Array<{ sourceKey: string; ordinal: number; order: number[]; enabled: boolean; name: string }> = [];
  const visit = (value: unknown, order: number[], ownerEnabled: boolean) => {
    const node = asRecord(value);
    if (node === undefined) return;
    const enabled = ownerEnabled && node.enabled !== false;
    if (node.type === 'script') {
      const sourceKey = typeof node.id === 'string' && node.id !== '' ? node.id : `${asset.sourceKey}:${order.join('.')}`;
      rows.push({
        sourceKey,
        ordinal: asset.ordinal,
        order,
        enabled,
        name: typeof node.name === 'string' && node.name !== '' ? node.name : sourceKey,
      });
    }
    scriptChildren(node)?.forEach((child, childOrdinal) => visit(child, [...order, childOrdinal], enabled));
  };
  visit(asset.payload, [asset.ordinal], asset.enabled);
  return rows;
}
function urlsIn(text: string): string[] {
  const pattern = /https?:\/\/[^\s"'`<>)]+/g;
  const matches: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 120), match.index).toLowerCase();
    if (!/(?:\bimport\s*(?:\(|[^;]*?from\s*)?|\bfetch\s*\(|\.load\s*\(|\bsrc\s*=\s*)["'`]?\s*$/.test(prefix)) continue;
    try { matches.push(new URL(match[0]).toString()); } catch { /* invalid static entry */ }
  }
  return matches;
}

export function extensionExecutableDigest(
  repositories: Repositories,
  ownerKind: ExtensionOwnerKind,
  ownerId: string,
): string {
  const rows = repositories.extensionAssets.listByOwner(ownerKind, ownerId);
  const remote = new Map(repositories.extensionRemoteResources.listByOwner(ownerKind, ownerId).map((item) => [item.url, item.sha256]));
  const projection = rows.filter((asset) => asset.kind === 'tavern_helper').sort((a, b) => a.ordinal - b.ordinal).map((asset) => ({
    sourceKey: asset.sourceKey, ordinal: asset.ordinal, enabled: asset.enabled, node: executableNode(asset.payload),
  }));
  const entries = [...new Set(rows.flatMap((asset) => executableSources(asset).flatMap(urlsIn)))].sort(compare)
    .map((url) => ({ url, sha256: remote.get(url) ?? null }));
  return createHash('sha256').update(JSON.stringify(canonicalizeForDigest({ projection, entries }))).digest('hex');
}

export function createExtensionTrustService(repositories: Repositories, fetchRemote: ExtensionRemoteFetcher) {
  const assets = (ownerKind: ExtensionOwnerKind, ownerId: string) => repositories.extensionAssets.listByOwner(ownerKind, ownerId);
  const discoveredUrls = (rows: ExtensionAsset[]) => [...new Set(rows.flatMap((asset) => executableSources(asset).flatMap(urlsIn)))].sort(compare);
  const digest = (ownerKind: ExtensionOwnerKind, ownerId: string) => extensionExecutableDigest(repositories, ownerKind, ownerId);
  const audit = (ownerKind: ExtensionOwnerKind, ownerId: string, event: Parameters<Repositories['extensionAuditEvents']['create']>[0]['event'], detail: Record<string, unknown> = {}) => {
    repositories.extensionAuditEvents.create({ id: randomUUID(), ownerKind, ownerId, event, detail });
  };
  const latestRemoteAudit = (ownerKind: ExtensionOwnerKind, ownerId: string) => repositories.extensionAuditEvents
    .listByOwner(ownerKind, ownerId)
    .filter((event) => event.event === 'remote_refresh' || event.event === 'remote_fetch_failed')
    .at(-1);
  const review = (ownerKind: ExtensionOwnerKind, ownerId: string) => {
    const rows = assets(ownerKind, ownerId);
    const remotes = repositories.extensionRemoteResources.listByOwner(ownerKind, ownerId);
    const byUrl = new Map(remotes.map((item) => [item.url, item]));
    const bundleDigest = digest(ownerKind, ownerId);
    let grant = repositories.extensionTrustGrants.getByOwner(ownerKind, ownerId);
    if (grant !== undefined && (grant.bundleDigest !== bundleDigest || grant.riskVersion !== EXTENSION_TRUST_RISK_VERSION)) {
      repositories.extensionTrustGrants.deleteByOwner(ownerKind, ownerId);
      audit(ownerKind, ownerId, 'trust_invalidated', {
        priorBundleDigest: grant.bundleDigest,
        currentBundleDigest: bundleDigest,
      });
      grant = undefined;
    }
    const auditEvents = repositories.extensionAuditEvents.listByOwner(ownerKind, ownerId);
    const remoteAudit = latestRemoteAudit(ownerKind, ownerId);
    return {
      owner: { kind: ownerKind, id: ownerId },
      scripts: rows.filter((asset) => asset.kind === 'tavern_helper').flatMap(scriptReviewRows),
      remotes: discoveredUrls(rows).map((url) => {
        const cached = byUrl.get(url);
        const failed = remoteAudit?.event === 'remote_fetch_failed' && remoteAudit.detail.url === url;
        return {
          url,
          fetched: cached !== undefined && !failed,
          fetchStatus: failed ? 'failed' as const : cached === undefined ? 'not_fetched' as const : 'fetched' as const,
          sha256: cached?.sha256 ?? null,
          mediaType: cached?.mediaType ?? null,
        };
      }),
      bundleDigest,
      trusted: grant?.bundleDigest === bundleDigest && grant.riskVersion === EXTENSION_TRUST_RISK_VERSION,
      sameOriginRisk: true,
      dynamicNetworkDisclaimer: 'Trusted same-origin scripts may dynamically contact origins not listed in this static audit snapshot.',
      auditEvents: auditEvents.map((event) => ({
        event: event.event, createdAt: event.createdAt, detail: event.detail,
      })),
    };
  };
  return {
    review,
    async refresh(ownerKind: ExtensionOwnerKind, ownerId: string) {
      const fetchedResources: Array<{ url: string; bytes: Uint8Array; mediaType: string; sha256: string }> = [];
      for (const url of discoveredUrls(assets(ownerKind, ownerId))) {
        try {
          const fetched = await fetchRemote(url);
          if (fetched.bytes.byteLength > MAX_REMOTE_BYTES || fetched.mediaType.trim() === '') throw new Error('remote_invalid');
          const sha256 = createHash('sha256').update(fetched.bytes).digest('hex');
          fetchedResources.push({ url, bytes: fetched.bytes, mediaType: fetched.mediaType, sha256 });
        } catch {
          repositories.extensionTrustGrants.deleteByOwner(ownerKind, ownerId);
          audit(ownerKind, ownerId, 'remote_fetch_failed', { url });
          return { ok: false as const, error: 'remote_fetch_failed' as const, review: review(ownerKind, ownerId) };
        }
      }
      repositories.extensionRemoteResources.deleteByOwner(ownerKind, ownerId);
      for (const fetched of fetchedResources) {
        repositories.extensionRemoteResources.create({
          id: randomUUID(), ownerKind, ownerId, url: fetched.url, sha256: fetched.sha256,
          contentBase64: Buffer.from(fetched.bytes).toString('base64'), mediaType: fetched.mediaType,
          fetchedAt: new Date().toISOString(),
        });
      }
      audit(ownerKind, ownerId, 'remote_refresh');
      return { ok: true as const, review: review(ownerKind, ownerId) };
    },
    grant(ownerKind: ExtensionOwnerKind, ownerId: string) {
      const current = review(ownerKind, ownerId);
      if (current.remotes.some((remote) => !remote.fetched)) return { ok: false as const, error: 'remote_entries_unfetched' as const };
      if (current.remotes.length > 0 && latestRemoteAudit(ownerKind, ownerId)?.event !== 'remote_refresh') {
        return { ok: false as const, error: 'remote_entries_unfetched' as const };
      }
      const prior = repositories.extensionTrustGrants.getByOwner(ownerKind, ownerId);
      if (prior !== undefined) repositories.extensionTrustGrants.deleteByOwner(ownerKind, ownerId);
      repositories.extensionTrustGrants.create({
        id: randomUUID(), ownerKind, ownerId, bundleDigest: current.bundleDigest,
        riskVersion: EXTENSION_TRUST_RISK_VERSION, grantedAt: new Date().toISOString(),
      });
      audit(ownerKind, ownerId, 'trust_granted', { bundleDigest: current.bundleDigest });
      return { ok: true as const, review: review(ownerKind, ownerId) };
    },
    revoke(ownerKind: ExtensionOwnerKind, ownerId: string) {
      repositories.extensionTrustGrants.deleteByOwner(ownerKind, ownerId);
      audit(ownerKind, ownerId, 'trust_revoked');
      return review(ownerKind, ownerId);
    },
    manifest(ownerKind: ExtensionOwnerKind, ownerId: string) {
      const status = review(ownerKind, ownerId);
      return { bundleDigest: status.bundleDigest, scripts: status.trusted ? assets(ownerKind, ownerId).filter((asset) => asset.kind === 'tavern_helper' && asset.enabled) : [] };
    },
    cached(ownerKind: ExtensionOwnerKind, ownerId: string, sha256: string) {
      return repositories.extensionRemoteResources.listByOwner(ownerKind, ownerId).find((item) => item.sha256 === sha256);
    },
  };
}
