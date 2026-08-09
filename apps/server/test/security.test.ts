import {
  chmodSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { REDACTED_LOG_VALUE, redactLogValue } from '../src/services/log-redaction.js';
import {
  SECRET_STORE_FILE,
  createSecretStore,
  type StoredProviderSecret,
} from '../src/services/secret-store.js';
import { TEST_SNAPSHOT_INTEGRITY_KEY } from './test-integrity-key.js';

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const providerId = '018f0000-0000-7000-8000-000000001601';
const providerSecret = (value: string): StoredProviderSecret => ({
  providerId,
  baseUrl: 'http://127.0.0.1:8080/v1',
  value,
});

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

describe('operational security', () => {
  it('defaults to loopback and parses bounded custom sensitive header names', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1' });
    expect(loadConfig({ TAVERNNEXT_SENSITIVE_HEADERS: 'X-Tenant-Secret, x-provider-token' }).sensitiveHeaders)
      .toEqual(['x-tenant-secret', 'x-provider-token']);
    expect(() => loadConfig({ TAVERNNEXT_SENSITIVE_HEADERS: 'valid, bad\r\nheader' })).toThrow(
      'Invalid TAVERNNEXT_SENSITIVE_HEADERS',
    );
  });

  it('redacts case-insensitive credentials, nested provider payloads, and cycles without mutating the source', () => {
    const apiKey = 'task-16-redaction-api-key';
    const customSecret = 'task-16-custom-header-value';
    const providerError = new Error(`provider echoed ${apiKey}`) as Error & { response?: unknown };
    providerError.response = {
      data: {
        API_KEY: apiKey,
        nested: { Authorization: `Bearer ${apiKey}` },
      },
    };
    const source: Record<string, unknown> = {
      headers: {
        AUTHORIZATION: `Bearer ${apiKey}`,
        'X-Tenant-Secret': customSecret,
        Accept: 'application/json',
      },
      body: { profile: { apiKey }, harmless: 'retained' },
      providerError,
      echoed: `upstream included ${customSecret}`,
    };
    source.self = source;

    const redacted = redactLogValue(source, {
      sensitiveHeaders: ['x-tenant-secret'],
      maxDepth: 8,
      maxEntries: 128,
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(customSecret);
    expect(serialized).toContain(REDACTED_LOG_VALUE);
    expect(serialized).toContain('retained');
    expect(serialized).toContain('[Circular]');
    expect((source.headers as Record<string, string>).AUTHORIZATION).toBe(`Bearer ${apiKey}`);
    expect((providerError.response as { data: { API_KEY: string } }).data.API_KEY).toBe(apiKey);
    expect(source.self).toBe(source);

    const wide = Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field${index}`, index]));
    expect(() => redactLogValue(wide, { maxEntries: 12, maxDepth: 2 })).not.toThrow();
    expect(JSON.stringify(redactLogValue(wide, { maxEntries: 12, maxDepth: 2 }))).toContain('[Truncated]');
  });

  it('atomically persists owner-only secrets and merges stale instances without losing stable references', async () => {
    const directory = await temporaryDirectory('tavernnext-secret-store-');
    const first = createSecretStore(directory);
    const staleSecond = createSecretStore(directory);
    first.set('provider:stable', providerSecret('first-value'));
    expect(staleSecond.get('provider:stable')).toEqual(providerSecret('first-value'));
    staleSecond.set('provider:second', providerSecret('second-value'));

    const reloaded = createSecretStore(directory);
    expect(reloaded.get('provider:stable')).toEqual(providerSecret('first-value'));
    expect(reloaded.get('provider:second')).toEqual(providerSecret('second-value'));
    expect(reloaded.has('provider:stable')).toBe(true);
    const beforeDelete = createSecretStore(directory);
    expect(reloaded.delete('provider:second')).toBe(true);
    expect(reloaded.has('provider:second')).toBe(false);
    expect(beforeDelete.has('provider:second')).toBe(false);

    const failedValue = 'must-not-replace-the-old-secret';
    const crashing = createSecretStore(directory, {
      beforePublish() {
        throw new Error('injected publication crash');
      },
    });
    expect(() => crashing.set('provider:stable', providerSecret(failedValue))).toThrow('Secret storage is unavailable');
    expect(createSecretStore(directory).get('provider:stable')).toEqual(providerSecret('first-value'));
    expect(readdirSync(directory).filter((name) => name.includes(`${SECRET_STORE_FILE}.`) || name.endsWith('.lock')))
      .toEqual([]);

    const stats = lstatSync(join(directory, SECRET_STORE_FILE));
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.nlink).toBe(1);
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600);
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(join(directory, SECRET_STORE_FILE), 'utf8')).not.toContain(failedValue);
  });

  it('refuses linked secret files and linked data directories without following them', async () => {
    const directory = await temporaryDirectory('tavernnext-secret-links-');
    const target = join(directory, 'attacker-owned.json');
    writeFileSync(target, '{"version":1,"entries":{}}', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    linkSync(target, join(directory, SECRET_STORE_FILE));
    expect(() => createSecretStore(directory)).toThrow('Secret storage is untrusted');

    const realDirectory = await temporaryDirectory('tavernnext-secret-real-');
    const linkedDirectory = join(directory, 'linked-data');
    let linked = false;
    try {
      symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch {
      // Windows hosts without link privileges still exercise the hard-link/no-follow file boundary above.
    }
    if (linked) expect(() => createSecretStore(linkedDirectory)).toThrow('Secret storage is unavailable');
  });

  it('never returns or logs submitted secrets and persists only stable secret references in SQLite', async () => {
    const directory = await temporaryDirectory('tavernnext-security-api-');
    const databasePath = join(directory, 'tavernnext.sqlite');
    const config = {
      host: '127.0.0.1',
      port: 0,
      dataDir: directory,
      databasePath,
      sensitiveHeaders: ['x-tenant-secret'],
    };
    const logs = new CaptureStream();
    const app = createApp({ config, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY, loggerStream: logs });
    apps.push(app);
    await app.ready();

    const apiKey = 'task-16-http-success-api-key';
    const failedApiKey = 'task-16-http-failure-api-key';
    const storageFailureApiKey = 'task-16-storage-failure-api-key';
    const authorization = 'Bearer task-16-request-authorization';
    const customHeader = 'task-16-request-custom-secret';
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { authorization, 'x-tenant-secret': customHeader },
      payload: {
        id: providerId,
        name: 'Secure provider',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'mock',
        apiMode: 'chat',
        apiKey,
      },
    });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { authorization, 'x-tenant-secret': customHeader },
      payload: {
        id: '018f0000-0000-7000-8000-000000001602',
        name: 'Invalid provider',
        baseUrl: 'not-a-url',
        model: 'mock',
        apiMode: 'chat',
        apiKey: failedApiKey,
      },
    });
    const secretHardLink = join(directory, 'attacker-secret-hard-link.json');
    linkSync(join(directory, SECRET_STORE_FILE), secretHardLink);
    const storageFailed = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        id: '018f0000-0000-7000-8000-000000001603',
        name: 'Must roll back',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'mock',
        apiMode: 'chat',
        apiKey: storageFailureApiKey,
      },
    });
    unlinkSync(secretHardLink);
    const listed = await app.inject({ method: 'GET', url: '/api/providers' });
    const fetched = await app.inject({ method: 'GET', url: `/api/providers/${providerId}` });
    const rolledBack = await app.inject({ method: 'GET', url: '/api/providers/018f0000-0000-7000-8000-000000001603' });

    expect(created.statusCode).toBe(201);
    expect(failed.statusCode).toBe(400);
    expect(storageFailed.statusCode).toBe(400);
    expect(rolledBack.statusCode).toBe(404);
    expect(created.json()).toMatchObject({ id: providerId, hasApiKey: true });
    expect(listed.json()).toEqual([expect.objectContaining({ id: providerId, hasApiKey: true })]);
    expect(fetched.json()).toMatchObject({ id: providerId, hasApiKey: true });
    for (const response of [created, failed, storageFailed, listed, fetched, rolledBack]) {
      expect(response.payload).not.toContain(apiKey);
      expect(response.payload).not.toContain(failedApiKey);
      expect(response.payload).not.toContain(storageFailureApiKey);
      expect(response.payload).not.toContain('secretRef');
      expect(response.payload).not.toContain('headerSecretRefs');
    }
    const capturedLogs = logs.text();
    for (const secret of [apiKey, failedApiKey, storageFailureApiKey, authorization, customHeader]) {
      expect(capturedLogs).not.toContain(secret);
    }
    expect(capturedLogs).toContain(REDACTED_LOG_VALUE);
    expect(readFileSync(databasePath).includes(Buffer.from(apiKey))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(failedApiKey))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(storageFailureApiKey))).toBe(false);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = createApp({ config, snapshotIntegrityKey: TEST_SNAPSHOT_INTEGRITY_KEY });
    apps.push(restarted);
    await restarted.ready();
    expect((await restarted.inject({ method: 'GET', url: `/api/providers/${providerId}` })).json())
      .toMatchObject({ id: providerId, hasApiKey: true });
    await restarted.close();
    apps.splice(apps.indexOf(restarted), 1);

    const database = createDatabase(databasePath);
    try {
      const row = database.sqlite.prepare('SELECT payload FROM provider_profiles WHERE id = ?').get(providerId);
      const stored = JSON.parse(String(row?.payload)) as Record<string, unknown>;
      expect(stored.secretRef).toBe(`browser:${providerId}`);
      expect(JSON.stringify(stored)).not.toContain(apiKey);
    } finally {
      database.close();
    }
  });
});
