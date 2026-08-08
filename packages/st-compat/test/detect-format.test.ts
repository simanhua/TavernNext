import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INSPECTION_LIMITS,
  DEFAULT_INSPECTION_WORKSPACE_ROOT,
  inspectArtifact,
  recoverInspectionWorkspaces,
  type InspectionLimits,
} from '../src/index.js';

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const type = encoder.encode(name);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(type, 4);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function metadataPng(keyword = 'ccv3', payload: unknown = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Aster' } }): Uint8Array {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const text = encoder.encode(`${keyword}\0${Buffer.from(JSON.stringify(payload)).toString('base64')}`);
  return concat(signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', text), pngChunk('IEND', new Uint8Array()));
}

interface ZipEntry {
  name: string;
  data?: Uint8Array;
  unixMode?: number;
}

function zip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data ?? new Uint8Array();
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x0314, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, ((entry.unixMode ?? 0o100644) << 16) >>> 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  return concat(...localParts, ...centralParts, eocd);
}

function limited(overrides: Partial<InspectionLimits>): InspectionLimits {
  return { ...DEFAULT_INSPECTION_LIMITS, ...overrides };
}

function makeWindowsDirectoryShared(path: string): void {
  const result = spawnSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', '*S-1-1-0:(OI)(CI)F'],
    { encoding: 'utf8', shell: false, timeout: 5_000, windowsHide: true },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Could not create shared Windows ACL fixture: ${result.error?.message ?? result.stderr}`);
  }
}

describe('artifact format detection', () => {
  it('detects JSON, JSONL, PNG metadata, CharX, BYAF, and YAML without losing source identity', async () => {
    const cases = [
      {
        name: 'aster.json', mediaType: 'application/json',
        bytes: encoder.encode(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Aster' } })),
        expected: { container: 'json', kind: 'character', version: '3.0' },
      },
      {
        name: 'chat.jsonl', mediaType: 'application/x-ndjson',
        bytes: encoder.encode('{"name":"Aster","is_user":false}\n{"name":"Traveler","is_user":true}\n'),
        expected: { container: 'jsonl', kind: 'chat', version: '1' },
      },
      {
        name: 'aster.png', mediaType: 'image/png', bytes: metadataPng(),
        expected: { container: 'png', kind: 'character', version: '3.0' },
      },
      {
        name: 'aster.charx', mediaType: 'application/zip',
        bytes: zip([{ name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"Aster"}}') }]),
        expected: { container: 'charx', kind: 'character', version: '3.0' },
      },
      {
        name: 'aster.byaf', mediaType: 'application/zip',
        bytes: zip([
          { name: 'manifest.json', data: encoder.encode('{"version":"1","characters":[{"path":"characters/aster/character.json"}]}') },
          { name: 'characters/aster/character.json', data: encoder.encode('{"name":"Aster"}') },
        ]),
        expected: { container: 'byaf', kind: 'character', version: '1' },
      },
      {
        name: 'aster.yaml', mediaType: 'application/yaml',
        bytes: encoder.encode('name: Aster\ndescription: A careful archivist.\nfirst_mes: Hello.\n'),
        expected: { container: 'yaml', kind: 'character', version: '1' },
      },
    ] as const;

    for (const fixture of cases) {
      const preview = await inspectArtifact({ fileName: fixture.name, mediaType: fixture.mediaType, bytes: fixture.bytes });
      expect(preview.detected, fixture.name).toMatchObject(fixture.expected);
      expect(preview.blockingErrors, fixture.name).toEqual([]);
      expect(preview.source).toMatchObject({ fileName: fixture.name, mediaType: fixture.mediaType, size: fixture.bytes.length });
      expect(preview.source.sha256).toBe(createHash('sha256').update(fixture.bytes).digest('hex'));
    }
  });

  it('reports invalid JSON, corrupt PNG, corrupt ZIP, and ambiguous JSON deterministically', async () => {
    const invalidJson = await inspectArtifact({ fileName: 'broken.json', mediaType: 'application/json', bytes: encoder.encode('{"name":') });
    expect(invalidJson.blockingErrors).toContainEqual(expect.objectContaining({ code: 'invalid_json' }));
    expect(invalidJson.inspectionToken).toBeUndefined();

    const corruptPng = await inspectArtifact({ fileName: 'broken.png', mediaType: 'image/png', bytes: Uint8Array.from([137, 80, 78, 71, 1]) });
    expect(corruptPng.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_png' }));

    const corruptZip = await inspectArtifact({ fileName: 'broken.charx', mediaType: 'application/zip', bytes: Uint8Array.from([80, 75, 3, 4, 1]) });
    expect(corruptZip.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_archive' }));

    const badChecksum = zip([{ name: 'card.json', data: encoder.encode('{}') }]);
    const centralOffset = badChecksum.findIndex((byte, index) => byte === 0x50 && badChecksum[index + 1] === 0x4b && badChecksum[index + 2] === 0x01 && badChecksum[index + 3] === 0x02);
    badChecksum[centralOffset + 16] ^= 0xff;
    const checksumPreview = await inspectArtifact({ fileName: 'checksum.charx', mediaType: 'application/zip', bytes: badChecksum });
    expect(checksumPreview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_archive' }));

    const ambiguous = await inspectArtifact({
      fileName: 'ambiguous.json', mediaType: 'application/json',
      bytes: encoder.encode(JSON.stringify({
        spec: 'chara_card_v3', data: { name: 'Aster' }, prompts: [], prompt_order: [], entries: {},
      })),
    });
    expect(ambiguous.detected).toMatchObject({ container: 'json', kind: 'unknown', candidates: ['character', 'preset', 'worldbook'] });
    expect(ambiguous.warnings).toContainEqual(expect.objectContaining({ code: 'ambiguous_json' }));
    expect(ambiguous.blockingErrors).toEqual([]);
  });

  it('validates CRC-32 for IEND and data-bearing PNG chunks', async () => {
    const forgedIend = metadataPng();
    forgedIend[forgedIend.length - 1] ^= 0xff;
    const iendPreview = await inspectArtifact({ fileName: 'forged-iend.png', bytes: forgedIend });
    expect(iendPreview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_png' }));

    const forgedText = metadataPng();
    const textTypeOffset = forgedText.findIndex((byte, index) => (
      byte === 0x74 && forgedText[index + 1] === 0x45 && forgedText[index + 2] === 0x58 && forgedText[index + 3] === 0x74
    ));
    const textLength = new DataView(forgedText.buffer, forgedText.byteOffset + textTypeOffset - 4, 4).getUint32(0);
    forgedText[textTypeOffset + 4 + textLength + 3] ^= 0xff;
    const textPreview = await inspectArtifact({ fileName: 'forged-text.png', bytes: forgedText });
    expect(textPreview.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_png' }));
  });

  it.each([
    ['path traversal', '../escape.json', undefined, 'archive_path_traversal'],
    ['absolute path', '/etc/passwd', undefined, 'archive_absolute_path'],
    ['drive path', 'C:\\escape.json', undefined, 'archive_absolute_path'],
    ['symbolic link', 'assets/avatar.png', 0o120777, 'archive_link'],
  ])('rejects archive %s entries', async (_label, name, unixMode, errorCode) => {
    const preview = await inspectArtifact({
      fileName: 'unsafe.charx', mediaType: 'application/zip',
      bytes: zip([{ name, data: encoder.encode('{}'), ...(unixMode === undefined ? {} : { unixMode }) }]),
    });
    expect(preview.blockingErrors).toContainEqual(expect.objectContaining({ code: errorCode, path: name }));
  });

  it('enforces decompressed bytes, entry count, nesting, upload, and text-line limits', async () => {
    const bomb = await inspectArtifact(
      { fileName: 'bomb.charx', bytes: zip([{ name: 'card.json', data: encoder.encode('x'.repeat(65)) }]) },
      limited({ maxDecompressedBytes: 64 }),
    );
    expect(bomb.blockingErrors).toContainEqual(expect.objectContaining({ code: 'archive_decompressed_limit' }));

    const tooMany = await inspectArtifact(
      { fileName: 'many.charx', bytes: zip([{ name: 'one' }, { name: 'two' }]) },
      limited({ maxArchiveEntries: 1 }),
    );
    expect(tooMany.blockingErrors).toContainEqual(expect.objectContaining({ code: 'archive_entry_limit' }));

    let nested = zip([{ name: 'card.json', data: encoder.encode('{}') }]);
    for (let level = 0; level < 4; level += 1) nested = zip([{ name: `nested-${level}.zip`, data: nested }]);
    const tooDeep = await inspectArtifact(
      { fileName: 'nested.charx', bytes: nested },
      limited({ maxArchiveNesting: 4, maxDecompressedBytes: 1024 * 1024 }),
    );
    expect(tooDeep.blockingErrors).toContainEqual(expect.objectContaining({ code: 'archive_nesting_limit' }));

    const oversizedUpload = await inspectArtifact(
      { fileName: 'large.json', bytes: encoder.encode('{"x":"0123456789"}') },
      limited({ maxUploadBytes: 8 }),
    );
    expect(oversizedUpload.blockingErrors).toContainEqual(expect.objectContaining({ code: 'upload_too_large' }));

    const longLine = await inspectArtifact(
      { fileName: 'chat.jsonl', bytes: encoder.encode('{"text":"0123456789"}\n') },
      limited({ maxTextLineBytes: 8 }),
    );
    expect(longLine.blockingErrors).toContainEqual(expect.objectContaining({ code: 'text_line_limit' }));

    const archiveLongLine = await inspectArtifact(
      { fileName: 'long-line.charx', bytes: zip([{ name: 'card.json', data: encoder.encode('{"data":"0123456789"}') }]) },
      limited({ maxTextLineBytes: 8, maxDecompressedBytes: 1024 }),
    );
    expect(archiveLongLine.blockingErrors).toContainEqual(expect.objectContaining({ code: 'text_line_limit', path: 'card.json' }));
  });

  it('streams large non-manifest entries while applying a separate bounded manifest-memory cap', async () => {
    const largeIrrelevantEntry = new Uint8Array(128 * 1024).fill(0x61);
    const streamed = await inspectArtifact(
      {
        fileName: 'streamed.charx',
        bytes: zip([
          { name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Streamed"}}') },
          { name: 'assets/large.bin', data: largeIrrelevantEntry },
        ]),
      },
      limited({ maxDecompressedBytes: 256 * 1024, maxInMemoryEntryBytes: 1024 }),
    );
    expect(streamed.blockingErrors).toEqual([]);
    expect(streamed.detected).toMatchObject({ container: 'charx', kind: 'character' });

    const oversizedManifest = await inspectArtifact(
      {
        fileName: 'oversized-manifest.charx',
        bytes: zip([{ name: 'card.json', data: encoder.encode(`{"spec":"chara_card_v3","padding":"${'x'.repeat(2048)}"}`) }]),
      },
      limited({ maxDecompressedBytes: 16 * 1024, maxInMemoryEntryBytes: 1024 }),
    );
    expect(oversizedManifest.blockingErrors).toContainEqual(expect.objectContaining({ code: 'archive_entry_memory_limit', path: 'card.json' }));
  });

  it('owns and cleans each UUID workspace under an injected standalone workspace root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-workspace-'));
    const workspaceRoot = join(directory, 'managed-workspaces');
    try {
      const valid = await inspectArtifact(
        {
          fileName: 'managed.charx',
          bytes: zip([{ name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Managed"}}') }]),
        },
        DEFAULT_INSPECTION_LIMITS,
        { workspaceRoot },
      );
      expect(valid.blockingErrors).toEqual([]);
      await expect(readdir(workspaceRoot)).resolves.toEqual([]);

      const corrupt = zip([{ name: 'card.json', data: encoder.encode('{}') }]);
      const centralOffset = corrupt.findIndex((byte, index) => (
        byte === 0x50 && corrupt[index + 1] === 0x4b && corrupt[index + 2] === 0x01 && corrupt[index + 3] === 0x02
      ));
      corrupt[centralOffset + 16] ^= 0xff;
      const failed = await inspectArtifact(
        { fileName: 'managed-corrupt.charx', bytes: corrupt },
        DEFAULT_INSPECTION_LIMITS,
        { workspaceRoot: `${workspaceRoot}${sep}` },
      );
      expect(failed.blockingErrors).toContainEqual(expect.objectContaining({ code: 'corrupt_archive' }));
      await expect(readdir(workspaceRoot)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'blocks a pre-created real default root inherited from a shared Windows temp parent without deleting its sentinel',
    async () => {
      const sharedTemp = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-shared-temp-'));
      const priorTemp = process.env.TEMP;
      const priorTmp = process.env.TMP;
      makeWindowsDirectoryShared(sharedTemp);
      process.env.TEMP = sharedTemp;
      process.env.TMP = sharedTemp;
      vi.resetModules();
      try {
        const isolated = await import('../src/index.js');
        const workspaceRoot = isolated.DEFAULT_INSPECTION_WORKSPACE_ROOT;
        const staleUuid = randomUUID();
        const sentinel = join(workspaceRoot, staleUuid, 'preserve.txt');
        expect(dirname(workspaceRoot)).toBe(sharedTemp);
        await mkdir(join(workspaceRoot, staleUuid), { recursive: true });
        await writeFile(sentinel, 'preserve');
        const staleTime = new Date(Date.now() - (15 * 60 * 1000) - 10_000);
        await utimes(join(workspaceRoot, staleUuid), staleTime, staleTime);

        const preview = await isolated.inspectArtifact({
          fileName: 'attacker-root.charx',
          bytes: zip([{ name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Blocked"}}') }]),
        });
        const sentinelContents = await readFile(sentinel, 'utf8').catch(() => undefined);

        expect(preview.blockingErrors).toContainEqual(expect.objectContaining({
          code: 'inspection_workspace_root_untrusted',
        }));
        expect(sentinelContents).toBe('preserve');
      } finally {
        if (priorTemp === undefined) delete process.env.TEMP;
        else process.env.TEMP = priorTemp;
        if (priorTmp === undefined) delete process.env.TMP;
        else process.env.TMP = priorTmp;
        vi.resetModules();
        await rm(sharedTemp, { recursive: true, force: true });
      }
    },
  );

  it('blocks a linked workspace root without traversing or deleting its target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-root-link-'));
    const targetRoot = join(directory, 'link-target');
    const workspaceRoot = join(directory, 'workspace-root');
    const staleUuid = randomUUID();
    const sentinel = join(targetRoot, staleUuid, 'preserve.txt');
    try {
      await mkdir(join(targetRoot, staleUuid), { recursive: true });
      await writeFile(sentinel, 'preserve');
      const staleTime = new Date(Date.now() - (15 * 60 * 1000) - 10_000);
      await utimes(join(targetRoot, staleUuid), staleTime, staleTime);
      await symlink(targetRoot, workspaceRoot, process.platform === 'win32' ? 'junction' : 'dir');

      expect(() => recoverInspectionWorkspaces(`${workspaceRoot}${sep}`)).toThrow('trusted real directory');

      const preview = await inspectArtifact(
        {
          fileName: 'linked-root.charx',
          bytes: zip([{ name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Blocked"}}') }]),
        },
        DEFAULT_INSPECTION_LIMITS,
        { workspaceRoot: `${workspaceRoot}${sep}` },
      );

      expect(preview.blockingErrors).toContainEqual(expect.objectContaining({
        code: 'inspection_workspace_root_untrusted',
        message: expect.stringContaining('trusted real directory'),
      }));
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never removes a UUID-named child link or its target during recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-child-link-'));
    const workspaceRoot = join(directory, 'managed-workspaces');
    const linkTarget = join(directory, 'link-target');
    const linkedUuid = randomUUID();
    const linkedWorkspace = join(workspaceRoot, linkedUuid);
    const sentinel = join(linkTarget, 'preserve.txt');
    try {
      await Promise.all([mkdir(workspaceRoot), mkdir(linkTarget)]);
      await writeFile(sentinel, 'preserve');
      await symlink(linkTarget, linkedWorkspace, process.platform === 'win32' ? 'junction' : 'dir');

      expect(() => recoverInspectionWorkspaces(workspaceRoot, Date.now(), 0)).not.toThrow();

      expect((await lstat(linkedWorkspace)).isSymbolicLink()).toBe(true);
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('preserve');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || typeof process.getuid !== 'function')(
    'repairs an owned permissive POSIX recovery root to owner-only permissions',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-root-mode-'));
      const workspaceRoot = join(directory, 'managed-workspaces');
      try {
        await mkdir(workspaceRoot);
        await chmod(workspaceRoot, 0o777);

        expect(() => recoverInspectionWorkspaces(workspaceRoot)).not.toThrow();

        const details = await stat(workspaceRoot);
        expect(details.uid).toBe(process.getuid!());
        expect(details.mode & 0o777).toBe(0o700);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('recovers only stale UUID children from the stable default workspace root before inspection', async () => {
    const workspaceRoot = DEFAULT_INSPECTION_WORKSPACE_ROOT;
    const staleUuid = randomUUID();
    const freshUuid = randomUUID();
    const unrelatedDirectory = `unrelated-${randomUUID()}`;
    const unrelatedFile = `unrelated-${randomUUID()}.txt`;
    const ownedPaths = [staleUuid, freshUuid, unrelatedDirectory, unrelatedFile].map((name) => join(workspaceRoot, name));
    await mkdir(workspaceRoot, { recursive: true });
    await Promise.all([
      mkdir(join(workspaceRoot, staleUuid)),
      mkdir(join(workspaceRoot, freshUuid)),
      mkdir(join(workspaceRoot, unrelatedDirectory)),
      writeFile(join(workspaceRoot, unrelatedFile), 'preserve'),
    ]);
    const staleTime = new Date(Date.now() - (15 * 60 * 1000) - 10_000);
    await utimes(join(workspaceRoot, staleUuid), staleTime, staleTime);
    try {
      const preview = await inspectArtifact({
        fileName: 'default-root.charx',
        bytes: zip([{ name: 'card.json', data: encoder.encode('{"spec":"chara_card_v3","data":{"name":"Recovered"}}') }]),
      });

      expect(preview.blockingErrors).toEqual([]);
      await expect(access(join(workspaceRoot, staleUuid))).rejects.toThrow();
      await expect(access(join(workspaceRoot, freshUuid))).resolves.toBeUndefined();
      await expect(access(join(workspaceRoot, unrelatedDirectory))).resolves.toBeUndefined();
      await expect(access(join(workspaceRoot, unrelatedFile))).resolves.toBeUndefined();
    } finally {
      await Promise.all(ownedPaths.map((path) => rm(path, { recursive: true, force: true })));
    }
  });

  it('exports idempotent recovery for caller-managed roots and preserves fresh UUIDs and unrelated entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavernnext-st-compat-recovery-'));
    const staleUuid = randomUUID();
    const freshUuid = randomUUID();
    const uuidFile = randomUUID();
    const unrelatedDirectory = 'another-package';
    const now = Date.parse('2026-08-08T12:00:00.000Z');
    const ttl = 1_000;
    try {
      await Promise.all([
        mkdir(join(directory, staleUuid)),
        mkdir(join(directory, freshUuid)),
        mkdir(join(directory, unrelatedDirectory)),
        writeFile(join(directory, uuidFile), 'not a directory'),
      ]);
      await utimes(join(directory, staleUuid), new Date(now - ttl - 1), new Date(now - ttl - 1));
      await utimes(join(directory, freshUuid), new Date(now), new Date(now));
      expect(() => recoverInspectionWorkspaces(directory, now, ttl)).not.toThrow();
      expect(() => recoverInspectionWorkspaces(directory, now, ttl)).not.toThrow();

      await expect(access(join(directory, staleUuid))).rejects.toThrow();
      await expect(access(join(directory, freshUuid))).resolves.toBeUndefined();
      await expect(access(join(directory, unrelatedDirectory))).resolves.toBeUndefined();
      await expect(access(join(directory, uuidFile))).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
