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

export function abortedError(): ProviderError {
  return new ProviderError('aborted');
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}
