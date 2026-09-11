import type { ProviderErrorCode } from './types.js';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, options: { status?: number; retryAfterMs?: number } = {}) {
    super(`OpenAI-compatible provider error: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
