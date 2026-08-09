import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startE2eStack, type E2eStack } from './e2e/support/stack.js';

describe('release gate harness ownership', () => {
  let stack: E2eStack | undefined;
  let occupied: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await stack?.close();
    if (occupied !== undefined) {
      occupied.closeAllConnections();
      await new Promise<void>((resolveClose) => occupied!.close(() => resolveClose()));
    }
  });

  it('refuses an occupied API port instead of accepting another healthy server', async () => {
    occupied = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
    });
    await new Promise<void>((resolveListen, reject) => {
      occupied!.once('error', reject);
      occupied!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = occupied.address();
    if (address === null || typeof address === 'string') throw new Error('Dummy server did not bind.');

    let error: unknown;
    try {
      stack = await startE2eStack({ apiPort: address.port });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('already in use');
  });
});
