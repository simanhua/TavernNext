import { AgentActivityKindSchema, type AgentActivityKind } from '@tavernnext/domain';

export type GenerationEvent =
  | { type: 'started'; generationId: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'activity'; kind: AgentActivityKind; label: string }
  | { type: 'view_placeholder'; viewId: string; kind: string }
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
    case 'reasoning_delta':
    case 'delta':
      if (typeof data.text !== 'string') break;
      return { type, text: data.text };
    case 'activity':
      if (typeof data.label !== 'string') break;
      const kind = AgentActivityKindSchema.safeParse(data.kind);
      if (!kind.success) break;
      return { type, kind: kind.data, label: data.label };
    case 'view_placeholder':
      if (typeof data.viewId !== 'string' || typeof data.kind !== 'string') break;
      return { type, viewId: data.viewId, kind: data.kind };
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

function abortError(): DOMException {
  return new DOMException('Generation stream aborted', 'AbortError');
}

export async function* readGenerationEvents(response: Response, signal?: AbortSignal): AsyncIterable<GenerationEvent> {
  if (response.body === null) throw new Error('Generation response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = () => {
    cancelPromise ??= reader.cancel(abortError()).catch(() => undefined);
  };
  const handleAbort = () => cancelReader();
  signal?.addEventListener('abort', handleAbort, { once: true });
  if (signal?.aborted) cancelReader();
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (event !== undefined) yield event;
      }
      if (done) {
        finished = true;
        break;
      }
    }
    if (buffer.trim() !== '') {
      const event = parseFrame(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    if (!finished) cancelReader();
    await cancelPromise;
    reader.releaseLock();
  }
}
