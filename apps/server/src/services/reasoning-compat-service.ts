import type { Repositories } from '../db/repositories.js';
import type { PromptSnapshotPayload } from './prompt-snapshot-service.js';
import { EXTENSION_TRUST_RISK_VERSION, extensionExecutableDigest } from './extension-trust-service.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function createReasoningCompatibilityService(repositories: Repositories) {
  const enabled = (snapshot: PromptSnapshotPayload) => {
    const presetRef = snapshot.entityRevisions.presets[0];
    const preset = presetRef === undefined ? undefined : repositories.presets.get(presetRef.id);
    if (preset === undefined || preset.revision !== presetRef?.revision) return false;
    const grant = repositories.extensionTrustGrants.getByOwner('preset', preset.id);
    if (grant?.riskVersion !== EXTENSION_TRUST_RISK_VERSION
      || grant.bundleDigest !== extensionExecutableDigest(repositories, 'preset', preset.id)) return false;
    return repositories.extensionAssets.listByOwner('preset', preset.id).some((asset) => {
      const payload = record(asset.payload);
      return asset.kind === 'tavern_helper' && asset.enabled && payload?.enabled !== false
        && /思维链|ReasoningRegexStyler|reasoning_regex_styler/i.test(`${payload?.name ?? ''}\n${payload?.content ?? ''}`);
    });
  };
  return {
    resolve(snapshot: PromptSnapshotPayload): boolean { return enabled(snapshot); },
    extract(isEnabled: boolean, content: string, reasoning: string): { content: string; reasoning: string } {
      if (reasoning !== '' || !isEnabled) return { content, reasoning };
      const complete = /^\s*<(think|thinking)>\s*([\s\S]*?)\s*<\/\1>\s*/i.exec(content);
      if (complete === null) return { content, reasoning };
      return { reasoning: complete[2]!.trim(), content: content.slice(complete[0].length) };
    },
  };
}
