import type { PromptCompilationFailure, PromptWarning, TokenBreakdownEntry } from './types.js';

export function stableStops(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function appendWarnings(target: PromptWarning[], additions: readonly PromptWarning[], source?: string): void {
  for (const warning of additions) {
    const next = source === undefined ? warning : { ...warning, source };
    if (target.some((item) => item.code === next.code && item.macro === next.macro && item.source === next.source)) continue;
    target.push(next);
  }
}

export function compilationFailure<TTarget extends 'chat' | 'text'>(input: {
  target: TTarget;
  code: PromptCompilationFailure['code'];
  message: string;
  warnings?: PromptWarning[];
  tokenBreakdown?: TokenBreakdownEntry[];
  totalTokens?: number;
  stop?: string[];
}): PromptCompilationFailure<TTarget> {
  return {
    kind: 'error',
    target: input.target,
    code: input.code,
    message: input.message,
    warnings: input.warnings ?? [],
    tokenBreakdown: input.tokenBreakdown ?? [],
    totalTokens: input.totalTokens ?? 0,
    stop: input.stop ?? [],
  };
}
