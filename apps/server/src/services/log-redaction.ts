export const REDACTED_LOG_VALUE = '[REDACTED]';
const CIRCULAR_LOG_VALUE = '[Circular]';
const TRUNCATED_LOG_VALUE = '[Truncated]';

export interface LogRedactionOptions {
  sensitiveHeaders?: readonly string[];
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
}

interface RedactionLimits {
  sensitiveKeys: ReadonlySet<string>;
  maxDepth: number;
  maxEntries: number;
  maxStringLength: number;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function limitsFrom(options: LogRedactionOptions): RedactionLimits {
  const sensitiveKeys = new Set(['authorization', 'proxyauthorization', 'apikey', 'xapikey']);
  for (const header of options.sensitiveHeaders ?? []) sensitiveKeys.add(normalizedKey(header));
  return {
    sensitiveKeys,
    maxDepth: Math.max(1, Math.min(options.maxDepth ?? 12, 32)),
    maxEntries: Math.max(1, Math.min(options.maxEntries ?? 2_048, 100_000)),
    maxStringLength: Math.max(64, Math.min(options.maxStringLength ?? 16_384, 1_048_576)),
  };
}

function isSensitiveKey(key: string, limits: RedactionLimits): boolean {
  return limits.sensitiveKeys.has(normalizedKey(key));
}

function isSensitiveEntry(key: string, parentKey: string | undefined, limits: RedactionLimits): boolean {
  return isSensitiveKey(key, limits)
    || (normalizedKey(parentKey ?? '') === 'credential' && normalizedKey(key) === 'key');
}

function enumerableDataEntries(value: object): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) entries.push([key, descriptor.value]);
  }
  if (value instanceof Error) {
    for (const key of ['name', 'message', 'stack', 'cause']) {
      if (entries.some(([present]) => present === key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) entries.push([key, descriptor.value]);
    }
  }
  return entries;
}

function collectStrings(value: unknown, destination: Set<string>, depth: number, budget: { remaining: number }): void {
  if (budget.remaining <= 0 || depth < 0) return;
  if (typeof value === 'string') {
    if (value !== '') destination.add(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [, child] of enumerableDataEntries(value)) {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    collectStrings(child, destination, depth - 1, budget);
  }
}

function collectSensitiveValues(value: unknown, limits: RedactionLimits): Set<string> {
  const found = new Set<string>();
  const visited = new WeakSet<object>();
  const budget = { remaining: limits.maxEntries };
  const visit = (candidate: unknown, depth: number, parentKey?: string): void => {
    if (budget.remaining <= 0 || depth > limits.maxDepth || typeof candidate !== 'object' || candidate === null) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    for (const [key, child] of enumerableDataEntries(candidate)) {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
      if (isSensitiveEntry(key, parentKey, limits)) {
        collectStrings(child, found, limits.maxDepth - depth, budget);
      } else {
        visit(child, depth + 1, key);
      }
    }
  };
  visit(value, 0);
  return found;
}

function scrubString(value: string, sensitiveValues: readonly string[], maxLength: number): string {
  let redacted = value;
  for (const secret of sensitiveValues) {
    if (secret !== '' && redacted.includes(secret)) redacted = redacted.split(secret).join(REDACTED_LOG_VALUE);
  }
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}${TRUNCATED_LOG_VALUE}`;
}

/**
 * Produces a bounded, cycle-safe data-only clone for logging. Accessors are never
 * invoked, credential values are scrubbed from sibling error messages, and the
 * input graph is never changed.
 */
export function redactLogValue(value: unknown, options: LogRedactionOptions = {}): unknown {
  const limits = limitsFrom(options);
  const sensitiveValues = [...collectSensitiveValues(value, limits)].sort((left, right) => right.length - left.length);
  const seen = new WeakSet<object>();
  const budget = { remaining: limits.maxEntries };

  const clone = (candidate: unknown, depth: number, parentKey?: string): unknown => {
    if (typeof candidate === 'string') return scrubString(candidate, sensitiveValues, limits.maxStringLength);
    if (candidate === null || typeof candidate === 'number' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'bigint') return candidate.toString();
    if (typeof candidate === 'undefined') return undefined;
    if (typeof candidate === 'symbol') return String(candidate);
    if (typeof candidate === 'function') return '[Function]';
    if (depth > limits.maxDepth || budget.remaining <= 0) return TRUNCATED_LOG_VALUE;
    if (candidate instanceof Uint8Array) return `[Binary ${candidate.byteLength} bytes]`;
    if (candidate instanceof Date) return Number.isNaN(candidate.getTime()) ? 'Invalid Date' : candidate.toISOString();
    if (seen.has(candidate)) return CIRCULAR_LOG_VALUE;
    seen.add(candidate);

    const result: unknown[] | Record<string, unknown> = Array.isArray(candidate) ? [] : {};
    for (const [key, child] of enumerableDataEntries(candidate)) {
      if (budget.remaining <= 0) {
        if (Array.isArray(result)) result.push(TRUNCATED_LOG_VALUE);
        else result.truncated = TRUNCATED_LOG_VALUE;
        break;
      }
      budget.remaining -= 1;
      const projected = isSensitiveEntry(key, parentKey, limits)
        ? REDACTED_LOG_VALUE
        : clone(child, depth + 1, key);
      if (Array.isArray(result)) result.push(projected);
      else result[key] = projected;
    }
    return result;
  };

  return clone(value, 0);
}
