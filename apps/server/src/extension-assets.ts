export const MAX_EXTENSION_ASSETS_PER_OWNER = 2048;

export class ExtensionAssetLimitError extends Error {
  readonly code = 'extension_asset_relation_limit' as const;

  constructor() {
    super('Attached Extension Resource owner limit exceeded');
    this.name = 'ExtensionAssetLimitError';
  }
}

export function assertExtensionAssetLimit(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EXTENSION_ASSETS_PER_OWNER) {
    throw new ExtensionAssetLimitError();
  }
}
