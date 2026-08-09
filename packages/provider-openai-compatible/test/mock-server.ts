import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MockRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export type MockHandler = (request: MockRequest, response: ServerResponse) => void | Promise<void>;

export interface MockServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const content = Buffer.concat(chunks).toString('utf8');
  return content === '' ? undefined : JSON.parse(content);
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const server: Server = createServer(async (request, response) => {
    try {
      await handler({
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://localhost').pathname,
        headers: request.headers,
        body: await readJson(request),
      }, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'mock handler failed');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

export function beginSse(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}
