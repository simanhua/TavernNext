export const TEST_SNAPSHOT_INTEGRITY_KEY = Uint8Array.from(
  { length: 32 },
  (_value, index) => index + 1,
);

export const TEST_REPOSITORY_OPTIONS = {
  snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY,
} as const;
