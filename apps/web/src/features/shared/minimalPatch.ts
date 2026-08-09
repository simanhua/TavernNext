function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]));
}

function cloneAllowedValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneAllowedValue) as T;
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAllowedValue(item)])) as T;
}

export function minimalPatch<T extends object, K extends keyof T>(
  baseline: T,
  next: T,
  allowlist: readonly K[],
): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const key of allowlist) {
    if (!structurallyEqual(baseline[key], next[key])) patch[key] = cloneAllowedValue(next[key]);
  }
  return patch;
}

export function hasPatchFields(value: object): boolean {
  return Object.keys(value).length > 0;
}

export function minimalRecordPatch(
  baseline: Record<string, unknown>,
  next: Record<string, unknown>,
  allowlist: readonly string[],
): { values: Record<string, unknown>; deletedKeys: string[] } {
  const values: Record<string, unknown> = {};
  const deletedKeys: string[] = [];
  for (const key of allowlist) {
    if (structurallyEqual(baseline[key], next[key])) continue;
    if (Object.hasOwn(next, key)) values[key] = cloneAllowedValue(next[key]);
    else deletedKeys.push(key);
  }
  return { values, deletedKeys };
}
