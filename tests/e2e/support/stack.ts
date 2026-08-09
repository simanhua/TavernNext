import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd());
interface MockReply {
  chunks: string[];
  hold?: boolean;
}

export interface MockProviderRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface MockProvider {
  readonly baseUrl: string;
  readonly requests: MockProviderRequest[];
  queue(reply: MockReply): void;
  close(): Promise<void>;
}

interface RunningServer {
  child: ChildProcess;
  logs: string[];
}

export interface ExportedArtifact {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface E2eStack {
  readonly baseUrl: string;
  readonly provider: MockProvider;
  readonly dataDir: string;
  readonly serverLogs: readonly string[];
  restartServer(): Promise<void>;
  restartWithFreshData(): Promise<void>;
  close(): Promise<void>;
}

export interface E2eStackOptions {
  apiPort?: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  return body === '' ? undefined : JSON.parse(body);
}

function sendSse(response: ServerResponse, reply: MockReply, textMode: boolean): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of reply.chunks) {
    const choice = textMode ? { text: chunk } : { delta: { content: chunk } };
    response.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
  }
  if (reply.hold === true) return;
  response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
  response.end('data: [DONE]\n\n');
}

async function startMockProvider(): Promise<MockProvider> {
  const replies: MockReply[] = [];
  const requests: MockProviderRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const body = await readJson(request);
      requests.push({ path, headers: request.headers, body });
      if (path === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'mock-model', owned_by: 'local' }] }));
        return;
      }
      if (path !== '/v1/chat/completions' && path !== '/v1/completions') {
        response.writeHead(404).end();
        return;
      }
      const queued = replies.shift() ?? { chunks: [`Local reply ${requests.length}`] };
      sendSse(response, queued, path === '/v1/completions');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'mock provider failure');
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Mock provider did not bind to TCP.');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    queue(reply) { replies.push({ chunks: [...reply.chunks], ...(reply.hold === true ? { hold: true } : {}) }); },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
    },
  };
}

async function assertPortAvailable(port: number): Promise<void> {
  const reservation = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      reservation.once('error', reject);
      reservation.listen(port, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'EADDRINUSE') throw new Error(`E2E API port ${port} is already in use; refusing to target another local server.`);
    throw error;
  } finally {
    if (reservation.listening) await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
  }
}

async function waitForServer(child: ChildProcess, logs: string[], apiPort: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  const ownershipMarker = `Server listening at http://127.0.0.1:${apiPort}`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`TavernNext server exited with ${child.exitCode}.\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (response.ok && logs.join('').includes(ownershipMarker)) return;
    } catch {
      // The server has not bound yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for TavernNext server.\n${logs.join('')}`);
}

async function launchServer(dataDir: string, apiPort: number): Promise<RunningServer> {
  await assertPortAvailable(apiPort);
  const logs: string[] = [];
  const child = spawn(process.execPath, [
    join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--tsconfig', join(repositoryRoot, 'apps', 'server', 'tsconfig.json'),
    join(repositoryRoot, 'apps', 'server', 'src', 'main.ts'),
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TAVERNNEXT_DATA_DIR: dataDir,
      TAVERNNEXT_HOST: '127.0.0.1',
      TAVERNNEXT_PORT: String(apiPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  await waitForServer(child, logs, apiPort);
  return { child, logs };
}

async function stopServer(running: RunningServer | undefined): Promise<void> {
  if (running === undefined || running.child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => running.child.once('exit', () => resolveExit()));
  running.child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
  if (!graceful && running.child.exitCode === null) {
    running.child.kill('SIGKILL');
    await exited;
  }
}

export async function startE2eStack(options: E2eStackOptions = {}): Promise<E2eStack> {
  const directories: string[] = [];
  const apiPort = options.apiPort ?? Number(process.env.TAVERNNEXT_E2E_API_PORT);
  if (!Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65_535) {
    throw new Error('TAVERNNEXT_E2E_API_PORT must name an unprivileged TCP port.');
  }
  const provider = await startMockProvider();
  let currentDataDir = await mkdtemp(join(tmpdir(), 'tavernnext-e2e-'));
  directories.push(currentDataDir);
  let running: RunningServer;
  try {
    running = await launchServer(currentDataDir, apiPort);
  } catch (error) {
    await provider.close();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  }
  const allLogs: string[] = [...running.logs];
  let closed = false;

  const replaceServer = async (fresh: boolean) => {
    await stopServer(running);
    allLogs.push(...running.logs);
    if (fresh) {
      currentDataDir = await mkdtemp(join(tmpdir(), 'tavernnext-e2e-fresh-'));
      directories.push(currentDataDir);
    }
    running = await launchServer(currentDataDir, apiPort);
  };

  return {
    baseUrl: `http://127.0.0.1:${apiPort}`,
    provider,
    get dataDir() { return currentDataDir; },
    get serverLogs() { return [...allLogs, ...running.logs]; },
    restartServer: () => replaceServer(false),
    restartWithFreshData: () => replaceServer(true),
    close: async () => {
      if (closed) return;
      closed = true;
      await stopServer(running);
      await provider.close();
      await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}

export function fixturePath(relativePath: string): string {
  return join(repositoryRoot, 'tests', 'fixtures', ...relativePath.split('/'));
}

function contentType(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jsonl': return 'application/x-ndjson';
    case '.yaml':
    case '.yml': return 'application/yaml';
    default: return 'application/json';
  }
}

async function checkedResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  throw new Error(`${response.status} ${response.url}: ${await response.text()}`);
}

export async function apiJson<T = unknown>(baseUrl: string, path: string, init: {
  method?: string;
  body?: unknown;
} = {}): Promise<T> {
  const response = await checkedResponse(await fetch(new URL(path, baseUrl), {
    method: init.method,
    ...(init.body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.body),
    }),
  }));
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function dispositionFileName(value: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value ?? '')?.[1];
  if (encoded !== undefined) return decodeURIComponent(encoded);
  return /filename="([^"]+)"/i.exec(value ?? '')?.[1] ?? 'artifact';
}

export async function exportArtifact(baseUrl: string, path: string): Promise<ExportedArtifact> {
  const response = await checkedResponse(await fetch(new URL(path, baseUrl)));
  return {
    fileName: dispositionFileName(response.headers.get('content-disposition')),
    mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

export async function importArtifact(
  baseUrl: string,
  source: string | ExportedArtifact,
  chatOptions?: { characterId: string; personaId: string; title: string },
): Promise<string> {
  const artifact = typeof source === 'string'
    ? {
        fileName: basename(source),
        mimeType: contentType(source),
        bytes: new Uint8Array(await readFile(fixturePath(source))),
      }
    : source;
  const form = new FormData();
  form.append('file', new Blob([artifact.bytes], { type: artifact.mimeType }), artifact.fileName);
  const inspected = await checkedResponse(await fetch(new URL('/api/imports/inspect', baseUrl), { method: 'POST', body: form }));
  const preview = await inspected.json() as { inspectionToken?: string; detected: { kind: string } };
  if (preview.inspectionToken === undefined) throw new Error(`No inspection token for ${artifact.fileName}.`);
  const chat = preview.detected.kind === 'chat';
  if (chat && chatOptions === undefined) throw new Error('Chat import requires Character, Persona, and title options.');
  const receipt = await apiJson<{ entityId?: string }>(baseUrl, chat ? '/api/chats/imports/commit' : '/api/imports/commit', {
    method: 'POST',
    body: { inspectionToken: preview.inspectionToken, ...(chatOptions ?? {}) },
  });
  if (receipt.entityId === undefined) throw new Error(`Import did not create an entity for ${artifact.fileName}.`);
  return receipt.entityId;
}

export function normalizeCharacter(value: any): unknown {
  const {
    id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
    avatarUrl: _avatarUrl, worldbookId: _worldbookId, ...semantic
  } = value;
  return semantic;
}

export function normalizePreset(value: any): unknown {
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...semantic } = value;
  return semantic;
}

export function normalizeWorldbook(value: any): unknown {
  const {
    id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, entries, ...semantic
  } = value;
  return {
    ...semantic,
    entries: entries.map((entry: any) => {
      const {
        id: _id,
        revision: _revision,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        worldbookId: _worldbookId,
        compatibilitySummary: _compatibilitySummary,
        ...stable
      } = entry;
      return stable;
    }),
  };
}

export function normalizeChat(value: any): unknown {
  return value.messages.map((message: any) => {
    const variants = [...message.variants].sort((left, right) => left.ordinal - right.ordinal);
    const {
      id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt,
      conversationId: _conversationId, activeVariantId: _activeVariantId,
      variants: _variants, ...semanticMessage
    } = message;
    return {
      ...semanticMessage,
      activeVariantIndex: variants.findIndex((variant) => variant.id === message.activeVariantId),
      variants: variants.map((variant) => {
        const {
          id: _variantId, revision: _variantRevision, createdAt: _variantCreatedAt, updatedAt: _variantUpdatedAt,
          messageId: _messageId, ...semanticVariant
        } = variant;
        return {
          ...semanticVariant,
          content: message.role === 'assistant' ? variant.content : message.content,
        };
      }),
    };
  });
}
