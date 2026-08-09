import { createHmac, timingSafeEqual } from 'node:crypto';

export const SNAPSHOT_INTEGRITY_KEY_BYTES = 32;

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalJsonValue(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Snapshot integrity input must contain finite JSON numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== 'object') throw new Error('Snapshot integrity input must be JSON.');

  const result: Record<string, CanonicalJson> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    result[key] = canonicalJsonValue(item);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function validatedKey(key: Uint8Array): Buffer {
  if (key.byteLength !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
    throw new Error(`Snapshot integrity key must be exactly ${SNAPSHOT_INTEGRITY_KEY_BYTES} bytes.`);
  }
  return Buffer.from(key);
}

export function createSnapshotIntegrityTag(key: Uint8Array, envelope: unknown): string {
  return createHmac('sha256', validatedKey(key)).update(canonicalJson(envelope)).digest('hex');
}

export function verifySnapshotIntegrityTag(key: Uint8Array, envelope: unknown, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !/^[0-9a-f]{64}$/.test(candidate)) return false;
  const expected = Buffer.from(createSnapshotIntegrityTag(key, envelope), 'hex');
  const actual = Buffer.from(candidate, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
