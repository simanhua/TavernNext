import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { SNAPSHOT_INTEGRITY_KEY_BYTES } from './db/snapshot-integrity.js';

export const SNAPSHOT_INTEGRITY_KEY_FILE = 'snapshot-integrity.key';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const windowsAclScript = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('TAVERNNEXT_WINDOWS_ACL_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('TAVERNNEXT_WINDOWS_ACL_KIND', 'Process')
if ([String]::IsNullOrWhiteSpace($path)) { exit 40 }
$item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 41 }
if (($kind -eq 'directory') -ne [bool]$item.PSIsContainer) { exit 42 }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($kind -eq 'directory') {
  $security = New-Object Security.AccessControl.DirectorySecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  $security = New-Object Security.AccessControl.FileSecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$security.SetOwner($currentSid)
$security.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $currentSid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$security.AddAccessRule($rule)
if ($kind -eq 'directory') {
  [IO.Directory]::SetAccessControl($path, $security)
  $acl = [IO.Directory]::GetAccessControl($path, 'Owner,Access')
} else {
  [IO.File]::SetAccessControl($path, $security)
  $acl = [IO.File]::GetAccessControl($path, 'Owner,Access')
}
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $currentSid.Value -or -not $acl.AreAccessRulesProtected) { exit 43 }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { exit 44 }
$verified = $rules[0]
if ($verified.IsInherited -or $verified.IdentityReference.Value -ne $currentSid.Value) { exit 45 }
if ($verified.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { exit 46 }
if ($verified.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { exit 47 }
if ($verified.InheritanceFlags -ne $inheritance -or $verified.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { exit 48 }
exit 0
`, 'utf16le').toString('base64');

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(Reflect.get(error, 'code'))
    : undefined;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureWindowsPath(path: string, kind: 'directory' | 'file'): void {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) throw new Error('Snapshot integrity storage is unavailable.');
  const result = spawnSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', windowsAclScript],
    {
      env: {
        ...process.env,
        TAVERNNEXT_WINDOWS_ACL_PATH: path,
        TAVERNNEXT_WINDOWS_ACL_KIND: kind,
      },
      shell: false,
      stdio: 'ignore',
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error('Snapshot integrity storage is unavailable.');
  }
}

function ensureSecureDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('Snapshot integrity storage is unavailable.');
  }
  if (process.platform === 'win32') {
    secureWindowsPath(path, 'directory');
  } else {
    if (typeof process.getuid !== 'function' || before.uid !== process.getuid()) {
      throw new Error('Snapshot integrity storage is unavailable.');
    }
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    const after = lstatSync(path);
    if (!sameFile(before, after) || (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new Error('Snapshot integrity storage is unavailable.');
    }
  }
}

function writeNewKey(path: string): boolean {
  const key = randomBytes(SNAPSHOT_INTEGRITY_KEY_BYTES);
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', PRIVATE_FILE_MODE);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw new Error('Snapshot integrity key could not be created.');
  }
  try {
    let offset = 0;
    while (offset < key.length) {
      const written = writeSync(descriptor, key, offset, key.length - offset);
      if (written <= 0) throw new Error('Snapshot integrity key could not be created.');
      offset += written;
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, PRIVATE_FILE_MODE);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (process.platform === 'win32') secureWindowsPath(path, 'file');
  return true;
}

function readExistingKey(path: string): Uint8Array {
  if (process.platform === 'win32') secureWindowsPath(path, 'file');
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Snapshot integrity key is untrusted.');
  if (process.platform !== 'win32'
    && (typeof process.getuid !== 'function' || before.uid !== process.getuid())) {
    throw new Error('Snapshot integrity key is untrusted.');
  }

  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    throw new Error('Snapshot integrity key is untrusted.');
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Snapshot integrity key is untrusted.');
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      const secured = fstatSync(descriptor);
      if (secured.uid !== process.getuid!() || (secured.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw new Error('Snapshot integrity key is untrusted.');
      }
    }
    const bytes = Buffer.alloc(SNAPSHOT_INTEGRITY_KEY_BYTES + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(descriptor, bytes, read, bytes.length - read, null);
      if (count === 0) break;
      read += count;
    }
    const after = lstatSync(path);
    if (!sameFile(opened, after) || read !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
      throw new Error('Snapshot integrity key is untrusted.');
    }
    return Uint8Array.from(bytes.subarray(0, SNAPSHOT_INTEGRITY_KEY_BYTES));
  } finally {
    closeSync(descriptor);
  }
}

function configuredKey(environment: NodeJS.ProcessEnv): Uint8Array | undefined {
  const encoded = environment.TAVERNNEXT_SNAPSHOT_INTEGRITY_KEY;
  if (encoded === undefined || encoded === '') return undefined;
  const bytes = Buffer.from(encoded, 'base64');
  const normalized = encoded.replace(/=+$/, '');
  if (bytes.length !== SNAPSHOT_INTEGRITY_KEY_BYTES
    || bytes.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new Error('Invalid TAVERNNEXT_SNAPSHOT_INTEGRITY_KEY.');
  }
  return Uint8Array.from(bytes);
}

export function loadSnapshotIntegrityKey(
  dataDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Uint8Array {
  const fromEnvironment = configuredKey(environment);
  if (fromEnvironment !== undefined) return fromEnvironment;

  const directory = resolve(dataDir);
  ensureSecureDataDirectory(directory);
  const path = join(directory, SNAPSHOT_INTEGRITY_KEY_FILE);
  writeNewKey(path);
  return readExistingKey(path);
}

export function injectedSnapshotIntegrityKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== SNAPSHOT_INTEGRITY_KEY_BYTES) {
    throw new Error(`Snapshot integrity key must be exactly ${SNAPSHOT_INTEGRITY_KEY_BYTES} bytes.`);
  }
  return Uint8Array.from(key);
}
