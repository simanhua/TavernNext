import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  StChatCodecError,
  decodeStChatJsonl,
  exportStChatJsonl,
  inspectStChatJsonl,
  streamStChatJsonl,
} from '../src/index.js';

const fixture = (name: string) => readFile(join(process.cwd(), 'tests', 'fixtures', 'chats', name));
const encoder = new TextEncoder();

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof StChatCodecError) return error.code;
    throw error;
  }
  throw new Error('Expected chat decoding to fail.');
}

describe('SillyTavern solo-chat JSONL', () => {
  it('normalizes the header and ordered user/assistant messages', async () => {
    const chat = decodeStChatJsonl(await fixture('basic.jsonl'));

    expect(chat.header).toMatchObject({
      userName: 'Traveler',
      characterName: 'Aster',
      createDate: '2026-08-09T00:00:00.000Z',
      chatMetadata: { integrity: 'synthetic-basic', persona: 'Traveler' },
    });
    expect(chat.messages.map(({ role, name, content }) => ({ role, name, content }))).toEqual([
      { role: 'user', name: 'Traveler', content: 'Hello Aster' },
      { role: 'assistant', name: 'Aster', content: 'Welcome, Traveler.' },
    ]);
    expect(chat.messages[1]).toMatchObject({ activeVariantIndex: 0, hadExplicitSwipes: true });
  });

  it('accepts the pinned ST 1.18 unused header sentinel and derives solo identities from messages', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      JSON.stringify({ name: 'Traveler', is_user: true, is_system: false, mes: 'Hello', extra: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'Welcome.', extra: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'Still here.', extra: {} }),
    ].join('\n'));

    const chat = decodeStChatJsonl(bytes);
    expect(chat.header).toMatchObject({ userName: 'Traveler', characterName: 'Aster' });
    expect(chat.messages.map(({ role, name }) => ({ role, name }))).toEqual([
      { role: 'user', name: 'Traveler' },
      { role: 'assistant', name: 'Aster' },
      { role: 'assistant', name: 'Aster' },
    ]);
  });

  it('keeps aligned swipe metadata, reasoning, timing, token, model, and API fields', async () => {
    const chat = decodeStChatJsonl(await fixture('swipes.jsonl'));
    const assistant = chat.messages[1]!;

    expect(assistant.activeVariantIndex).toBe(1);
    expect(assistant.content).toBe('The second door opens.');
    expect(assistant.variants.map((variant) => variant.content)).toEqual([
      'The first door opens.',
      'The second door opens.',
      'The third door opens.',
    ]);
    expect(assistant.variants[1]).toMatchObject({
      ordinal: 1,
      sendDate: '2026-08-09T01:00:04.000Z',
      generationStarted: '2026-08-09T01:00:03.000Z',
      generationFinished: '2026-08-09T01:00:04.000Z',
      api: 'openai',
      model: 'model-b',
      tokenCount: 7,
      reasoning: 'second thought',
      reasoningDuration: 12,
    });
  });

  it('round-trips unknown header, message, extra, and swipe-info fields while current edits win', async () => {
    const decoded = decodeStChatJsonl(await fixture('unknown-extra.jsonl'));
    decoded.header.characterName = 'Aster Edited';
    decoded.messages[1]!.variants[1]!.content = 'Edited active future';
    decoded.messages[1]!.content = 'Edited active future';

    const exported = exportStChatJsonl(decoded, 'unsafe\r\n聊.jsonl');
    const reparsed = decodeStChatJsonl(exported.bytes);

    expect(exported.contentType).toBe('application/x-ndjson; charset=utf-8');
    expect(exported.fileName).toBe('unsafe__聊.jsonl');
    expect(reparsed.header.characterName).toBe('Aster Edited');
    expect(reparsed.header.raw.future_header).toEqual({ retain: 'header' });
    expect(reparsed.header.chatMetadata.future_metadata).toEqual({ nested: true });
    expect(reparsed.messages[0]!.raw.future_message).toEqual({ retain: 'user' });
    expect(reparsed.messages[0]!.extra.future_extra).toEqual({ scope: 'user' });
    expect(reparsed.messages[1]!.raw.future_message).toEqual({ retain: 'assistant' });
    expect(reparsed.messages[1]!.variants[0]!.swipeInfo.future_swipe_info).toBe('zero');
    expect(reparsed.messages[1]!.variants[1]!.swipeInfo.future_swipe_info).toBe('one');
    expect(reparsed.messages[1]!.variants[1]!.extra.future_variant).toEqual({ slot: 1 });
    expect(reparsed.messages[1]!.variants[1]!.content).toBe('Edited active future');
  });

  it('exports exactly one header and ordered message lines with deterministic keys', async () => {
    const chat = decodeStChatJsonl(await fixture('swipes.jsonl'));
    const first = exportStChatJsonl(chat).bytes;
    const second = exportStChatJsonl(chat).bytes;
    const text = new TextDecoder().decode(first);

    expect(first).toEqual(second);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    const lines = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines[2]).toMatchObject({
      mes: 'The second door opens.',
      swipe_id: 1,
      swipes: ['The first door opens.', 'The second door opens.', 'The third door opens.'],
    });
    expect(lines[2].swipe_info).toHaveLength(3);
  });

  it('offers a preflight-bounded re-iterable JSONL chunk stream for HTTP export', async () => {
    const chat = decodeStChatJsonl(await fixture('swipes.jsonl'));
    const streamed = streamStChatJsonl(chat, 'chat.jsonl');
    const first = Buffer.concat([...streamed.chunks].map((chunk) => Buffer.from(chunk)));
    const second = Buffer.concat([...streamed.chunks].map((chunk) => Buffer.from(chunk)));

    expect(first.byteLength).toBe(streamed.totalBytes);
    expect(first).toEqual(second);
    expect(first).toEqual(Buffer.from(exportStChatJsonl(chat).bytes));
    expect(new TextDecoder().decode(first).trimEnd().split('\n')).toHaveLength(3);
  });

  it('supports solo system and pinned narrator records without treating them as group chat', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'Traveler', character_name: 'Aster', chat_metadata: {} }),
      JSON.stringify({ name: 'System', is_user: false, is_system: true, mes: 'System notice', extra: {} }),
      JSON.stringify({
        name: 'Narrator', is_user: false, is_system: false, mes: 'Rain falls.',
        extra: { type: 'narrator', gen_id: 42, api: 'manual', model: 'slash command' },
      }),
    ].join('\n'));
    const chat = decodeStChatJsonl(bytes);
    expect(chat.messages.map((message) => message.role)).toEqual(['system', 'system']);
    const exported = new TextDecoder().decode(exportStChatJsonl(chat).bytes).trim().split('\n').map((line) => JSON.parse(line));
    expect(exported[2]).toMatchObject({
      name: 'Narrator', is_user: false, is_system: false,
      extra: { type: 'narrator', gen_id: 42, api: 'manual', model: 'slash command' },
    });
  });

  it('returns a typed inspection preview without mutating or hiding blockers', async () => {
    const preview = inspectStChatJsonl(await fixture('swipes.jsonl'), 'swipes.jsonl');
    expect(preview.blockingErrors).toEqual([]);
    expect(preview.normalizedPreview).toMatchObject({
      header: { characterName: 'Aster' },
      messages: [{ role: 'user' }, { role: 'assistant', activeVariantIndex: 1 }],
    });
    const blocked = inspectStChatJsonl(encoder.encode('{"not":"a header"}\n'), 'bad.jsonl');
    expect(blocked.blockingErrors).toEqual([expect.objectContaining({ code: 'chat_header_invalid' })]);
  });

  it.each([
    ['empty input', new Uint8Array(), 'chat_empty'],
    ['UTF-8 BOM', Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'chat_utf8_bom'],
    ['invalid UTF-8', Uint8Array.from([0x7b, 0x7d, 0x0a, 0xc3, 0x28]), 'chat_invalid_utf8'],
    ['malformed header JSON', encoder.encode('{bad}\n'), 'chat_json_invalid'],
    ['missing header metadata', encoder.encode('{"future":true}\n'), 'chat_header_invalid'],
    ['truncated message JSON', encoder.encode('{"user_name":"U","character_name":"C","chat_metadata":{}}\n{"mes":"x"'), 'chat_json_invalid'],
  ])('rejects %s with a stable code', (_label, bytes, code) => {
    expect(errorCode(() => decodeStChatJsonl(bytes as Uint8Array))).toBe(code);
  });

  it('rejects mixed-character/group chat without partially returning messages', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'Traveler', character_name: 'Aster', chat_metadata: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'A', extra: {} }),
      JSON.stringify({ name: 'Borin', is_user: false, is_system: false, mes: 'B', extra: { gen_id: 2 } }),
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(bytes))).toBe('chat_group_not_supported');
  });

  it('still rejects mixed assistant identities when the pinned header uses unused sentinels', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'A', extra: {} }),
      JSON.stringify({ name: 'Borin', is_user: false, is_system: false, mes: 'B', extra: {} }),
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(bytes))).toBe('chat_group_not_supported');
  });

  it('rejects a one-member pinned ST group marked by assistant gen_id metadata', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'unused', character_name: 'unused', chat_metadata: {} }),
      JSON.stringify({ name: 'Aster', is_user: false, is_system: false, mes: 'Group greeting', extra: { gen_id: 42 } }),
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(bytes))).toBe('chat_group_not_supported');
  });

  it('backfills legacy swipe_info like ST while keeping active metadata index-local', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({
        name: 'C', is_user: false, mes: 'B', send_date: 'sent', gen_started: 'started', gen_finished: 'finished',
        swipes: ['A', 'B', 'C'], swipe_id: 1,
        extra: { api: 'openai', model: 'active-model', reasoning: 'active thought', attachment: { id: 'active-only' } },
      }),
    ].join('\n'));

    const inspection = inspectStChatJsonl(bytes);
    expect(inspection.blockingErrors).toEqual([]);
    expect(inspection.warnings).toEqual([expect.objectContaining({ code: 'chat_swipe_info_backfilled' })]);
    const message = inspection.normalizedPreview!.messages[0]!;
    expect(message.variants.map((variant) => ({
      content: variant.content,
      api: variant.api,
      model: variant.model,
      extra: variant.extra,
      sendDate: variant.sendDate,
    }))).toEqual([
      { content: 'A', api: undefined, model: undefined, extra: {}, sendDate: 'sent' },
      {
        content: 'B', api: 'openai', model: 'active-model',
        extra: { api: 'openai', model: 'active-model', reasoning: 'active thought', attachment: { id: 'active-only' } },
        sendDate: 'sent',
      },
      { content: 'C', api: undefined, model: undefined, extra: {}, sendDate: 'sent' },
    ]);

    message.variants.push({ ordinal: 3, content: 'Fresh sibling', extra: { attachment: { id: 'fresh-only' } }, swipeInfo: {} });
    message.activeVariantIndex = 3;
    message.content = 'Fresh sibling';
    const line = JSON.parse(new TextDecoder().decode(exportStChatJsonl(inspection.normalizedPreview!).bytes).trim().split('\n')[1]!);
    expect(line.extra).toEqual({ attachment: { id: 'fresh-only' } });
    expect(line.extra).not.toHaveProperty('api');
    expect(line.extra).not.toHaveProperty('model');
    expect(line.extra).not.toHaveProperty('reasoning');
    expect(line.swipe_info).toHaveLength(4);
    expect(line.swipe_info[0].extra).toEqual({});
    expect(line.swipe_info[1].extra).toMatchObject({ api: 'openai', model: 'active-model' });
    expect(line.swipe_info[3].extra).toEqual({ attachment: { id: 'fresh-only' } });
  });

  it('tolerates missing, invalid, and surplus legacy swipe_info entries but exports aligned data', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({
        name: 'C', is_user: false, mes: 'B', swipes: ['A', 'B', 'C'], swipe_id: 1, extra: { model: 'active' },
        swipe_info: [{ extra: { model: 'first' } }, null, { extra: { model: 'third' } }, { future_surplus: true }],
      }),
    ].join('\n'));
    const chat = decodeStChatJsonl(bytes);
    expect(chat.messages[0]!.variants.map((variant) => variant.model)).toEqual(['first', 'active', 'third']);
    const line = JSON.parse(new TextDecoder().decode(exportStChatJsonl(chat).bytes).trim().split('\n')[1]!);
    expect(line.swipe_info).toHaveLength(3);
  });

  it('preserves native null and out-of-domain known metadata index-locally', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({
        name: 'C', is_user: false, is_system: false, mes: 'Answer',
        extra: { token_count: -1, reasoning_duration: null, future: 'kept' },
      }),
      JSON.stringify({
        name: 'C', is_user: false, is_system: false, mes: 'Negative duration',
        extra: { reasoning_duration: -2, future: 'also-kept' },
      }),
    ].join('\n'));
    const chat = decodeStChatJsonl(bytes);
    const variant = chat.messages[0]!.variants[0]!;
    expect(variant).not.toHaveProperty('tokenCount');
    expect(variant).not.toHaveProperty('reasoningDuration');
    expect(variant.extra).toEqual({ token_count: -1, reasoning_duration: null, future: 'kept' });
    const negativeDuration = chat.messages[1]!.variants[0]!;
    expect(negativeDuration).not.toHaveProperty('reasoningDuration');
    expect(negativeDuration.extra).toEqual({ reasoning_duration: -2, future: 'also-kept' });
    const lines = new TextDecoder().decode(exportStChatJsonl(chat).bytes).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[1].extra).toEqual({ token_count: -1, reasoning_duration: null, future: 'kept' });
    expect(lines[2].extra).toEqual({ reasoning_duration: -2, future: 'also-kept' });
  });

  it('rejects active indexes outside the swipe array', () => {
    const badIndex = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({ name: 'C', is_user: false, mes: 'B', swipes: ['A', 'B'], swipe_id: 2, swipe_info: [{}, {}] }),
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(badIndex))).toBe('chat_swipe_index_invalid');
  });

  it('enforces total, line, message, and aggregate variant caps before returning a chat', () => {
    const header = JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} });
    const user = JSON.stringify({ name: 'U', is_user: true, mes: 'hello' });
    const assistant = JSON.stringify({ name: 'C', is_user: false, mes: 'b', swipes: ['a', 'b'], swipe_id: 1, swipe_info: [{}, {}] });
    const bytes = encoder.encode([header, user, assistant].join('\n'));

    expect(errorCode(() => decodeStChatJsonl(bytes, { maxTotalBytes: bytes.byteLength - 1 }))).toBe('chat_total_limit');
    expect(errorCode(() => decodeStChatJsonl(bytes, { maxLineBytes: 8 }))).toBe('chat_line_limit');
    expect(errorCode(() => decodeStChatJsonl(bytes, { maxMessages: 1 }))).toBe('chat_message_limit');
    expect(errorCode(() => decodeStChatJsonl(bytes, { maxVariants: 1 }))).toBe('chat_variant_limit');
  });

  it('stops semantic parsing as soon as the aggregate variant cap is crossed', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({ name: 'C', is_user: false, mes: 'B', swipes: ['A', 'B'], swipe_id: 1, swipe_info: [{}, {}] }),
      '{ malformed trailing record',
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(bytes, { maxVariants: 1 }))).toBe('chat_variant_limit');
  });

  it('checks raw swipe cardinality before normalizing an oversized message', () => {
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} }),
      JSON.stringify({ name: 'C', is_user: false, mes: 'B', swipes: ['A', 'B'], swipe_id: 999 }),
    ].join('\n'));
    expect(errorCode(() => decodeStChatJsonl(bytes, { maxVariants: 1 }))).toBe('chat_variant_limit');
  });

  it('enforces total, line, message, and aggregate variant caps while exporting', async () => {
    const basic = decodeStChatJsonl(await fixture('basic.jsonl'));
    const swipes = decodeStChatJsonl(await fixture('swipes.jsonl'));
    const artifact = exportStChatJsonl(basic);

    expect(errorCode(() => exportStChatJsonl(basic, 'chat.jsonl', {
      maxTotalBytes: artifact.bytes.byteLength - 1,
    }))).toBe('chat_total_limit');
    expect(errorCode(() => exportStChatJsonl(basic, 'chat.jsonl', { maxLineBytes: 8 }))).toBe('chat_line_limit');
    expect(errorCode(() => exportStChatJsonl(basic, 'chat.jsonl', { maxMessages: 1 }))).toBe('chat_message_limit');
    expect(errorCode(() => exportStChatJsonl(swipes, 'chat.jsonl', { maxVariants: 1 }))).toBe('chat_variant_limit');
  });

  it('never interprets provider secrets or attachment metadata as executable fields', () => {
    const secret = 'sk-synthetic-never-execute';
    const bytes = encoder.encode([
      JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: { api_key: secret } }),
      JSON.stringify({ name: 'C', is_user: false, mes: 'Safe', extra: { api_key: secret, files: [{ path: '../../escape' }] } }),
    ].join('\n'));
    const chat = decodeStChatJsonl(bytes);
    expect(chat.header.chatMetadata.api_key).toBe(secret);
    expect(chat.messages[0]!.extra).toMatchObject({ api_key: secret, files: [{ path: '../../escape' }] });
    expect(chat.messages[0]!.variants[0]).not.toHaveProperty('apiKey');
  });
});
