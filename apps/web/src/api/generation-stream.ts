export type GenerationEvent =
  | { type: 'started'; generationId: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'completed'; finishReason: string }
  | { type: 'aborted' }
  | { type: 'failed'; code: string };

function parseFrame(frame: string): GenerationEvent | undefined {
  const lines = frame.split(/\r?\n/);
  const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  if (type === undefined || type === '') return undefined;
  const dataText = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  const data = (dataText === '' ? {} : JSON.parse(dataText)) as Record<string, unknown>;

  switch (type) {
    case 'started':
      if (typeof data.generationId !== 'string') break;
      return { type, generationId: data.generationId };
    case 'delta':
      if (typeof data.text !== 'string') break;
      return { type, text: data.text };
    case 'usage':
      if (typeof data.inputTokens !== 'number' || typeof data.outputTokens !== 'number') break;
      return { type, inputTokens: data.inputTokens, outputTokens: data.outputTokens };
    case 'completed':
      if (typeof data.finishReason !== 'string') break;
      return { type, finishReason: data.finishReason };
    case 'aborted':
      return { type };
    case 'failed':
      if (typeof data.code !== 'string') break;
      return { type, code: data.code };
    default:
      throw new Error(`Unsupported generation event: ${type}`);
  }
  throw new Error(`Invalid data for generation event: ${type}`);
}

export async function* readGenerationEvents(response: Response): AsyncIterable<GenerationEvent> {
  if (response.body === null) throw new Error('Generation response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event !== undefined) yield event;
      }
      if (done) break;
    }
    if (buffer.trim() !== '') {
      const event = parseFrame(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}
