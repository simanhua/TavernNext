import { describe, expect, it } from 'vitest';
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
  it('parses the six generation event types across chunk boundaries', async () => {
    const response = responseFrom([
      'event: started\ndata: {"generationId":"generation-1"}\n\nevent: del',
      'ta\ndata: {"text":"Hi"}\n\nevent: usage\ndata: {"inputTokens":1,"outputTokens":1}\n\n',
      'event: completed\ndata: {"finishReason":"stop"}\n\nevent: aborted\ndata: {}\n\n',
      'event: failed\ndata: {"code":"connection"}\n\n',
    ]);

    const events = [];
    for await (const event of readGenerationEvents(response)) events.push(event);

    expect(events).toEqual([
      { type: 'started', generationId: 'generation-1' },
      { type: 'delta', text: 'Hi' },
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
});
