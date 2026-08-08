import { createHash, randomUUID } from 'node:crypto';
import { gunzip as gunzipCallback } from 'node:zlib';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import type { TokenizerId } from './ids.js';

const gunzip = promisify(gunzipCallback);

export interface TokenizerModelManifestEntry {
  readonly tokenizerId: TokenizerId;
  readonly fileName: string;
  readonly format: 'sentencepiece' | 'web-tokenizer';
  readonly sha256?: string;
  readonly bundledPath?: string;
  readonly url?: string;
  readonly compression?: 'gzip';
  readonly downloadSha256?: string;
  readonly fallbackTokenizerId?: TokenizerId;
}

export interface ModelCacheLike {
  ensure(entry: TokenizerModelManifestEntry): Promise<string>;
}

export interface ModelCacheIo {
  readonly mkdir: typeof mkdir;
  readonly readFile: typeof readFile;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
}

export interface ModelCacheOptions {
  readonly dataDir: string;
  readonly download?: (url: string) => Promise<Uint8Array>;
  readonly io?: Partial<ModelCacheIo>;
}

const defaultIo: ModelCacheIo = { mkdir, readFile, writeFile, rename, rm };

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertHash(data: Uint8Array, expected: string, label: string): void {
  const actual = sha256(data);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected.toLowerCase()}, received ${actual}`);
  }
}

async function defaultDownload(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Tokenizer model download failed with HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export class ModelCache implements ModelCacheLike {
  readonly #dataDir: string;
  readonly #download: (url: string) => Promise<Uint8Array>;
  readonly #io: ModelCacheIo;
  readonly #pending = new Map<string, Promise<string>>();

  constructor(options: ModelCacheOptions) {
    this.#dataDir = options.dataDir;
    this.#download = options.download ?? defaultDownload;
    this.#io = { ...defaultIo, ...options.io };
  }

  async ensure(entry: TokenizerModelManifestEntry): Promise<string> {
    if (basename(entry.fileName) !== entry.fileName) {
      throw new Error(`Tokenizer model file name must not contain directories: ${entry.fileName}`);
    }
    if (!entry.sha256 || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
      throw new Error(`Tokenizer model ${entry.fileName} does not define a valid SHA-256`);
    }

    const target = join(this.#dataDir, 'tokenizers', entry.fileName);
    const active = this.#pending.get(target);
    if (active) return active;

    const operation = this.#ensure(entry, target).finally(() => {
      this.#pending.delete(target);
    });
    this.#pending.set(target, operation);
    return operation;
  }

  async #ensure(entry: TokenizerModelManifestEntry, target: string): Promise<string> {
    try {
      const cached = await this.#io.readFile(target);
      assertHash(cached, entry.sha256!, `Cached tokenizer model ${entry.fileName}`);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !String(error).includes('SHA-256 mismatch')) {
        throw error;
      }
    }

    await this.#io.mkdir(join(this.#dataDir, 'tokenizers'), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;

    try {
      let bytes: Uint8Array;
      if (entry.bundledPath) {
        bytes = await this.#io.readFile(entry.bundledPath);
      } else if (entry.url) {
        const downloaded = await this.#download(entry.url);
        if (entry.downloadSha256) {
          assertHash(downloaded, entry.downloadSha256, `Downloaded tokenizer model ${entry.fileName}`);
        }
        bytes = entry.compression === 'gzip' ? await gunzip(downloaded) : downloaded;
      } else {
        throw new Error(`Tokenizer model ${entry.fileName} has no bundled path or download URL`);
      }

      assertHash(bytes, entry.sha256!, `Tokenizer model ${entry.fileName}`);
      await this.#io.writeFile(temporaryPath, bytes, { flag: 'wx' });
      const written = await this.#io.readFile(temporaryPath);
      assertHash(written, entry.sha256!, `Temporary tokenizer model ${entry.fileName}`);
      await this.#io.rename(temporaryPath, target);
      return target;
    } catch (error) {
      await this.#io.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
