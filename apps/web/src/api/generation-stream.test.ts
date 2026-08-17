import { describe, expect, it, vi } from 'vitest';
import { readGenerationEvents } from './generation-stream.js';

function responseFrom(payloads: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('readGenerationEvents', () => {
  it('parses the seven generation event types across chunk boundaries', async () => {
    const response = responseFrom([
      'event: started\ndata: {"generationId":"generation-1"}\n\nevent: del',
      'ta\ndata: {"text":"Hi"}\n\nevent: reasoning_delta\ndata: {"text":"Think"}\n\nevent: usage\ndata: {"inputTokens":1,"outputTokens":1}\n\n',
      'event: completed\ndata: {"finishReason":"stop"}\n\nevent: aborted\ndata: {}\n\n',
      'event: failed\ndata: {"code":"connection"}\n\n',
    ]);

    const events = [];
    for await (const event of readGenerationEvents(response)) events.push(event);

    expect(events).toEqual([
      { type: 'started', generationId: 'generation-1' },
      { type: 'delta', text: 'Hi' },
      { type: 'reasoning_delta', text: 'Think' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'completed', finishReason: 'stop' },
      { type: 'aborted' },
      { type: 'failed', code: 'connection' },
    ]);
  });

  it('rejects event types outside the server contract', async () => {
    const collect = async () => {
      for await (const event of readGenerationEvents(responseFrom(['event: surprise\ndata: {}\n\n']))) void event;
    };

    await expect(collect()).rejects.toThrow('Unsupported generation event: surprise');
  });

  it('cancels the response reader once when its signal aborts', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: started\ndata: {"generationId":"generation-1"}\n\n'));
      },
      cancel,
    }));
    const controller = new AbortController();
    const iterator = readGenerationEvents(response, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'started' } });

    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
