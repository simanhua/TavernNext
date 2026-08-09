import { ProviderError } from './errors.js';

function eventData(lines: string[]): string | undefined {
  const values: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    values.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return values.length === 0 ? undefined : values.join('\n');
}

/** Parses SSE data fields, accepting both LF and CRLF line endings. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines: string[] = [];

  const flush = (): string | undefined => {
    const value = eventData(lines);
    lines = [];
    return value;
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const value = flush();
          if (value !== undefined) yield value;
        } else {
          lines.push(line);
        }
        newline = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer !== '') {
      lines.push(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    }
    const value = flush();
    if (value !== undefined) yield value;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('connection');
  } finally {
    reader.releaseLock();
  }
}
