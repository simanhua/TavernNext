import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd());
interface MockReply {
  chunks?: string[];
  hold?: boolean;
  toolCalls?: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
}

type MockReplyFactory = (request: MockProviderRequest) => MockReply;

export interface MockProviderRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface MockProvider {
  readonly baseUrl: string;
  readonly requests: MockProviderRequest[];
  queue(reply: MockReply | MockReplyFactory): void;
  close(): Promise<void>;
}

interface RunningServer {
  child: ChildProcess;
  logs: string[];
}

export interface E2eStack {
  readonly baseUrl: string;
  readonly provider: MockProvider;
  readonly serverLogs: readonly string[];
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

function sendSse(response: ServerResponse, reply: MockReply): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (reply.toolCalls !== undefined) {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant',
      tool_calls: reply.toolCalls.map((call, index) => ({
        index, id: call.id ?? `tool-${index + 1}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }, finish_reason: null }] })}\n\n`);
    response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    response.end('data: [DONE]\n\n');
    return;
  }
  for (const chunk of reply.chunks ?? []) {
    const choice = { delta: { content: chunk } };
    response.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
  }
  if (reply.hold === true) return;
  response.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
  response.end('data: [DONE]\n\n');
}

function isMemoryExtractionRequest(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message: unknown) => {
    if (typeof message !== 'object' || message === null) return false;
    const { role, content } = message as { role?: unknown; content?: unknown };
    return (role === 'system' || role === 'developer')
      && typeof content === 'string'
      && content.startsWith('You extract durable roleplay memory from one completed TavernNext turn.');
  });
}

async function startMockProvider(): Promise<MockProvider> {
  const replies: Array<MockReply | MockReplyFactory> = [];
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
      if (path !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      // Save Memory runs in the background and must not consume queued gameplay turns.
      // Its contract requires an episode, so an empty memories array would trigger failed-job retries.
      if (isMemoryExtractionRequest(body)) {
        sendSse(response, { chunks: [JSON.stringify({ memories: [{
          kind: 'episode', summary: 'A roleplay turn completed.', detail: '',
          entities: [], salience: 0, confidence: 1,
        }] })] });
        return;
      }
      const queued = replies.shift() ?? { chunks: [`Local reply ${requests.length}`] };
      const reply = typeof queued === 'function' ? queued(requests.at(-1)!) : queued;
      sendSse(response, reply);
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
    queue(reply) {
      replies.push(typeof reply === 'function' ? reply : {
        ...(reply.chunks === undefined ? {} : { chunks: [...reply.chunks] }),
        ...(reply.toolCalls === undefined ? {} : { toolCalls: structuredClone(reply.toolCalls) }),
        ...(reply.hold === true ? { hold: true } : {}),
      });
    },
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
  const dataDir = await mkdtemp(join(tmpdir(), 'tavernnext-e2e-'));
  directories.push(dataDir);
  let running: RunningServer;
  try {
    running = await launchServer(dataDir, apiPort);
  } catch (error) {
    await provider.close();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  }
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${apiPort}`,
    provider,
    get serverLogs() { return [...running.logs]; },
    close: async () => {
      if (closed) return;
      closed = true;
      await stopServer(running);
      await provider.close();
      await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}
