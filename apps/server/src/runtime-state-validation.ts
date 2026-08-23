export const MAX_RUNTIME_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_STATE_ENTRIES = 50_000;
export const MAX_RUNTIME_STATE_DEPTH = 128;

export class RuntimeStateLimitError extends Error {
  readonly code = 'runtime_state_limit' as const;

  constructor() {
    super('Runtime State exceeds its structural limit');
    this.name = 'RuntimeStateLimitError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertRuntimeStateValue(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value)) throw new RuntimeStateLimitError();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let entries = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > MAX_RUNTIME_STATE_DEPTH) throw new RuntimeStateLimitError();
    if (Array.isArray(item.value)) {
      entries += item.value.length;
      for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 });
    } else if (record(item.value)) {
      const children = Object.values(item.value);
      entries += children.length;
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
    if (entries > MAX_RUNTIME_STATE_ENTRIES) throw new RuntimeStateLimitError();
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new RuntimeStateLimitError(); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RUNTIME_STATE_BYTES) throw new RuntimeStateLimitError();
}

export function scriptStateScopeId(
  ownerKind: 'character' | 'preset',
  ownerId: string,
  scriptKey: string,
): string {
  return `${ownerKind}:${ownerId}:${scriptKey}`;
}

export function parseScriptStateScopeId(value: string): {
  ownerKind: 'character' | 'preset'; ownerId: string; scriptKey: string;
} | undefined {
  const match = /^(character|preset):([0-9a-f-]{36}):(.+)$/i.exec(value);
  if (match === null || match[3]!.length > 512) return undefined;
  return { ownerKind: match[1]!.toLowerCase() as 'character' | 'preset', ownerId: match[2]!, scriptKey: match[3]! };
}

export function attachedScriptKeys(value: unknown): string[] {
  const keys: string[] = [];
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!record(item)) continue;
    if (typeof item.id === 'string') keys.push(item.id);
    else if (typeof item.name === 'string') keys.push(item.name);
    const children = Array.isArray(item.children) ? item.children
      : Array.isArray(item.scripts) ? item.scripts
        : [];
    stack.push(...children);
  }
  return keys;
}
