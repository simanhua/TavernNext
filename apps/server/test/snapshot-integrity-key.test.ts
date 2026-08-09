import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  linkSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSnapshotIntegrityKey,
  SNAPSHOT_INTEGRITY_KEY_FILE,
} from '../src/snapshot-integrity-key.js';

const directories: string[] = [];
const emptyEnvironment: NodeJS.ProcessEnv = {};
const keyFixture = Buffer.alloc(32, 0x5a);

function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new Error('SystemRoot is required for Windows ACL tests.');
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runWindowsAclScript(path: string, script: string, allowedStatus?: number): string {
  const result = spawnSync(
    windowsPowerShell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      env: { ...process.env, TAVERNNEXT_TEST_ACL_PATH: path },
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.signal !== null
    || (result.status !== 0 && result.status !== allowedStatus)) {
    throw new Error(`Windows ACL test helper failed with status ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function windowsAclSnapshot(path: string): string {
  return runWindowsAclScript(path, String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TAVERNNEXT_TEST_ACL_PATH', 'Process')
$acl = [IO.File]::GetAccessControl($path, 'Owner,Access')
[Console]::Out.Write([Convert]::ToBase64String($acl.GetSecurityDescriptorBinaryForm()))
`);
}

function addWindowsReadablePrincipal(path: string): void {
  runWindowsAclScript(path, String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TAVERNNEXT_TEST_ACL_PATH', 'Process')
$acl = [IO.File]::GetAccessControl($path, 'Owner,Access')
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $everyone,
  [Security.AccessControl.FileSystemRights]::Read,
  [Security.AccessControl.InheritanceFlags]::None,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($path, $acl)
`);
}

function unprotectWindowsDacl(path: string): void {
  runWindowsAclScript(path, String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TAVERNNEXT_TEST_ACL_PATH', 'Process')
$acl = [IO.File]::GetAccessControl($path, 'Owner,Access')
$acl.SetAccessRuleProtection($false, $true)
[IO.File]::SetAccessControl($path, $acl)
`);
}

function trySetWrongWindowsOwner(path: string): boolean {
  const result = runWindowsAclScript(path, String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TAVERNNEXT_TEST_ACL_PATH', 'Process')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
foreach ($candidate in $identity.Groups) {
  try {
    $acl = [IO.File]::GetAccessControl($path, 'Owner,Access')
    $acl.SetOwner($candidate)
    [IO.File]::SetAccessControl($path, $acl)
    $actual = [IO.File]::GetAccessControl($path, 'Owner').GetOwner([Security.Principal.SecurityIdentifier])
    if ($actual.Value -ne $identity.User.Value) {
      [Console]::Out.Write('changed')
      exit 0
    }
  } catch {
    # Standard-user tokens generally cannot assign a different owner.
  }
}
[Console]::Out.Write('unavailable')
exit 90
`, 90);
  return result === 'changed';
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tavernnext-key-publication-'));
  directories.push(directory);
  return directory;
}

function temporaryKeyNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => (
    name.startsWith(`.${SNAPSHOT_INTEGRITY_KEY_FILE}.`) && name.endsWith('.tmp')
  ));
}

function temporaryKeyName(pid: number, entropy: string): string {
  return `.${SNAPSHOT_INTEGRITY_KEY_FILE}.${pid}-${entropy.padEnd(32, '0')}.tmp`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('snapshot integrity key atomic publication', () => {
  it('lets a concurrent creator publish while the first creator is paused without exposing or overwriting a partial key', async () => {
    const directory = await temporaryDirectory();
    let concurrentWinner: Uint8Array | undefined;
    let pausedPublishCalls = 0;

    const resumedCreator = loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      publish(temporaryPath, publishedPath) {
        pausedPublishCalls += 1;
        concurrentWinner = loadSnapshotIntegrityKey(directory, emptyEnvironment);
        linkSync(temporaryPath, publishedPath);
      },
    });

    expect(pausedPublishCalls).toBe(1);
    expect(concurrentWinner).toBeDefined();
    expect(resumedCreator).toEqual(concurrentWinner);
    expect(await readFile(join(directory, SNAPSHOT_INTEGRITY_KEY_FILE))).toEqual(Buffer.from(concurrentWinner!));
    expect(temporaryKeyNames(directory)).toEqual([]);
  });

  it('recovers after a creator crashes before publication and removes abandoned task temporaries after publishing', async () => {
    const directory = await temporaryDirectory();
    const abandonedName = temporaryKeyName(2_147_483_647, 'dead');
    const abandonedPath = join(directory, abandonedName);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      publish(temporaryPath) {
        copyFileSync(temporaryPath, abandonedPath);
        throw new Error('simulated creator crash before publication');
      },
    })).toThrow('Snapshot integrity key could not be created.');
    expect(temporaryKeyNames(directory)).toEqual([abandonedName]);

    const recovered = loadSnapshotIntegrityKey(directory, emptyEnvironment);

    expect(recovered).toHaveLength(32);
    expect(temporaryKeyNames(directory)).toEqual([]);
    expect(loadSnapshotIntegrityKey(directory, emptyEnvironment)).toEqual(recovered);
  });

  it('does not remove another live creator temporary while reclaiming a crashed creator temporary', async () => {
    const directory = await temporaryDirectory();
    loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const liveName = temporaryKeyName(process.pid, '1a');
    const crashedName = temporaryKeyName(2_147_483_647, 'dead');
    writeFileSync(join(directory, liveName), Buffer.alloc(1));
    writeFileSync(join(directory, crashedName), Buffer.alloc(1));

    loadSnapshotIntegrityKey(directory, emptyEnvironment);

    expect(temporaryKeyNames(directory)).toEqual([liveName]);
  });

  it('strictly refuses a malformed published key instead of replacing it with a task temporary', async () => {
    const directory = await temporaryDirectory();
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    const malformed = Buffer.alloc(31, 0x5a);
    writeFileSync(publishedPath, malformed);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');
    expect(await readFile(publishedPath)).toEqual(malformed);
    expect(temporaryKeyNames(directory)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('refuses a byte-valid 0644 POSIX key without repairing its mode', async () => {
    const directory = await temporaryDirectory();
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    writeFileSync(publishedPath, keyFixture);
    chmodSync(publishedPath, 0o644);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');

    expect(await readFile(publishedPath)).toEqual(keyFixture);
    expect(statSync(publishedPath).mode & 0o777).toBe(0o644);
  });

  it.skipIf(process.platform === 'win32')('refuses a POSIX key owned by another uid without changing its owner or mode', async ({ skip }) => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      skip('Changing a file to another uid requires a privileged POSIX test process.');
    }
    const directory = await temporaryDirectory();
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    writeFileSync(publishedPath, keyFixture, { mode: 0o600 });
    chownSync(publishedPath, 1, 1);
    const before = statSync(publishedPath);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');

    const after = statSync(publishedPath);
    expect(await readFile(publishedPath)).toEqual(keyFixture);
    expect({ uid: after.uid, mode: after.mode & 0o777 }).toEqual({ uid: before.uid, mode: before.mode & 0o777 });
  });

  it.runIf(process.platform === 'win32')('refuses an extra readable Windows principal without rewriting the published ACL', async () => {
    const directory = await temporaryDirectory();
    loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    addWindowsReadablePrincipal(publishedPath);
    const bytesBefore = await readFile(publishedPath);
    const before = windowsAclSnapshot(publishedPath);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');

    expect(await readFile(publishedPath)).toEqual(bytesBefore);
    expect(windowsAclSnapshot(publishedPath)).toBe(before);
  });

  it.runIf(process.platform === 'win32')('refuses an unprotected Windows DACL without protecting or rewriting it', async () => {
    const directory = await temporaryDirectory();
    loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    unprotectWindowsDacl(publishedPath);
    const before = windowsAclSnapshot(publishedPath);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');

    expect(windowsAclSnapshot(publishedPath)).toBe(before);
  });

  it.runIf(process.platform === 'win32')('refuses a Windows key owned by another principal without taking ownership', async ({ skip }) => {
    const directory = await temporaryDirectory();
    loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    if (!trySetWrongWindowsOwner(publishedPath)) {
      skip('The current Windows token cannot assign a different owner.');
    }
    const before = windowsAclSnapshot(publishedPath);

    expect(() => loadSnapshotIntegrityKey(directory, emptyEnvironment)).toThrow('Snapshot integrity key is untrusted.');

    expect(windowsAclSnapshot(publishedPath)).toBe(before);
  });

  it('accepts a safe existing key without changing its bytes or security metadata', async () => {
    const directory = await temporaryDirectory();
    const created = loadSnapshotIntegrityKey(directory, emptyEnvironment);
    const publishedPath = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
    const before = process.platform === 'win32'
      ? windowsAclSnapshot(publishedPath)
      : `${statSync(publishedPath).uid}:${statSync(publishedPath).mode & 0o777}`;

    const reopened = loadSnapshotIntegrityKey(directory, emptyEnvironment);

    const after = process.platform === 'win32'
      ? windowsAclSnapshot(publishedPath)
      : `${statSync(publishedPath).uid}:${statSync(publishedPath).mode & 0o777}`;
    expect(reopened).toEqual(created);
    expect(await readFile(publishedPath)).toEqual(Buffer.from(created));
    expect(after).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('fsyncs the POSIX parent directory after publication and temporary cleanup', async () => {
    const directory = await temporaryDirectory();
    const syncedDirectories: string[] = [];

    loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      syncDirectory(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([resolve(directory), resolve(directory)]);
    syncedDirectories.length = 0;

    loadSnapshotIntegrityKey(directory, emptyEnvironment, {
      syncDirectory(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([resolve(directory)]);
  });
});
