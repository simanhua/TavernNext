import { diagnostic, type ImportDiagnostic } from '../warnings.js';

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_ST_CHAT_LIMITS: Readonly<StChatCodecLimits> = Object.freeze({
  maxTotalBytes: 64 * MEBIBYTE,
  maxLineBytes: 16 * MEBIBYTE,
  maxMessages: 2_048,
  maxVariants: 4_096,
});

export interface StChatCodecLimits {
  maxTotalBytes: number;
  maxLineBytes: number;
  maxMessages: number;
  maxVariants: number;
}

export type StChatCodecOptions = Partial<StChatCodecLimits>;
export type StChatRole = 'user' | 'assistant' | 'system';
export type StChatTimestamp = string | number;

export interface StChatHeader {
  userName: string;
  characterName: string;
  createDate?: StChatTimestamp;
  chatMetadata: Record<string, unknown>;
  /** Unrecognized top-level header data. It is data-only and is never interpreted. */
  raw: Record<string, unknown>;
}

export interface StChatVariant {
  ordinal: number;
  content: string;
  sendDate?: StChatTimestamp;
  generationStarted?: StChatTimestamp;
  generationFinished?: StChatTimestamp;
  api?: string;
  model?: string;
  tokenCount?: number;
  reasoning?: string;
  reasoningDuration?: number;
  /** The ST `extra` envelope, retained as inert JSON data. */
  extra: Record<string, unknown>;
  /** Unrecognized fields from the aligned ST `swipe_info` item. */
  swipeInfo: Record<string, unknown>;
}

export interface StChatMessage {
  role: StChatRole;
  /** Preserves ST's `is_system` distinction for narrator rows represented as the domain system role. */
  isSystem: boolean;
  name: string;
  content: string;
  activeVariantIndex: number;
  hadExplicitSwipes: boolean;
  variants: StChatVariant[];
  extra: Record<string, unknown>;
  /** Unrecognized top-level message data. It is data-only and is never interpreted. */
  raw: Record<string, unknown>;
}

export interface StChatDocument {
  header: StChatHeader;
  messages: StChatMessage[];
}

export interface StChatInspection {
  fileName: string;
  normalizedPreview: StChatDocument | null;
  blockingErrors: ImportDiagnostic[];
  warnings: ImportDiagnostic[];
}

export interface StChatExportArtifact {
  bytes: Uint8Array;
  contentType: 'application/x-ndjson; charset=utf-8';
  fileName: string;
}

export interface StChatStreamArtifact {
  chunks: Iterable<Uint8Array>;
  totalBytes: number;
  contentType: 'application/x-ndjson; charset=utf-8';
  fileName: string;
}

export class StChatCodecError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StChatCodecError';
    this.code = code;
  }
}

const HEADER_KNOWN = new Set(['user_name', 'character_name', 'create_date', 'chat_metadata']);
const MESSAGE_KNOWN = new Set([
  'name', 'is_user', 'is_system', 'send_date', 'gen_started', 'gen_finished', 'mes',
  'swipes', 'swipe_id', 'swipe_info', 'extra',
]);
const SWIPE_INFO_KNOWN = new Set(['send_date', 'gen_started', 'gen_finished', 'extra']);

function fail(code: string, message: string, cause?: unknown): never {
  throw new StChatCodecError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function inertRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? cloneRecord(value) : {};
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function without(source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => [key, structuredClone(value)]),
  );
}

function timestamp(value: unknown): StChatTimestamp | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function limits(options: StChatCodecOptions): StChatCodecLimits {
  const result = { ...DEFAULT_ST_CHAT_LIMITS, ...options };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
  }
  return result;
}

function visitDecodedLines(
  bytes: Uint8Array,
  cap: StChatCodecLimits,
  visit: (line: string, recordIndex: number) => void,
): number {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let recordIndex = 0;
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index !== bytes.byteLength && bytes[index] !== 0x0a) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 0x0d) end -= 1;
    const lineLength = end - start;
    if (lineLength > cap.maxLineBytes) {
      fail('chat_line_limit', `Chat JSONL line exceeds the ${cap.maxLineBytes}-byte line limit.`);
    }
    let line: string;
    try {
      line = decoder.decode(bytes.subarray(start, end));
    } catch (error) {
      fail('chat_invalid_utf8', 'Chat JSONL contains invalid UTF-8.', error);
    }
    if (line.trim().length > 0) {
      visit(line, recordIndex);
      recordIndex += 1;
    }
    start = index + 1;
  }
  return recordIndex;
}

/** Validates every byte before semantic parsing, without retaining decoded lines. */
function validateArtifact(bytes: Uint8Array, cap: StChatCodecLimits): void {
  if (bytes.byteLength > cap.maxTotalBytes) {
    fail('chat_total_limit', `Chat exceeds the ${cap.maxTotalBytes}-byte total limit.`);
  }
  if (bytes.byteLength === 0) fail('chat_empty', 'Chat JSONL is empty.');
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('chat_utf8_bom', 'Chat JSONL must be UTF-8 without a byte-order mark.');
  }
  const recordCount = visitDecodedLines(bytes, cap, () => undefined);
  if (recordCount === 0) fail('chat_empty', 'Chat JSONL is empty.');
  if (recordCount - 1 > cap.maxMessages) {
    fail('chat_message_limit', `Chat exceeds the ${cap.maxMessages}-message limit.`);
  }
}

function parseRecord(line: string, index: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail('chat_json_invalid', `Chat JSONL line ${index + 1} is not valid JSON.`, error);
  }
  if (!isRecord(value)) {
    fail('chat_json_invalid', `Chat JSONL line ${index + 1} must contain a JSON object.`);
  }
  return value;
}

function normalizeHeader(source: Record<string, unknown>): StChatHeader {
  const userName = stringField(source.user_name);
  const characterName = stringField(source.character_name);
  if (userName === undefined || characterName === undefined || !isRecord(source.chat_metadata)) {
    fail('chat_header_invalid', 'The first JSONL record is not a valid SillyTavern solo-chat header.');
  }
  const metadata = cloneRecord(source.chat_metadata);
  if (
    metadata.group_id !== undefined
    || metadata.groupId !== undefined
    || metadata.group_chat === true
    || hasOwn(metadata, 'cfg_groupchat_individual_chars')
  ) {
    fail('chat_group_not_supported', 'SillyTavern group chats are not supported.');
  }
  const createDate = timestamp(source.create_date);
  return {
    userName,
    characterName,
    ...(createDate === undefined ? {} : { createDate }),
    chatMetadata: metadata,
    raw: without(source, HEADER_KNOWN),
  };
}

function messageRole(source: Record<string, unknown>, extra: Record<string, unknown>): StChatRole {
  if (source.is_user === true) return 'user';
  if (extra.type === 'narrator') return 'system';
  if (source.is_system === true) return 'system';
  if (source.is_user === false || typeof source.name === 'string') return 'assistant';
  fail('chat_message_invalid', 'Chat message is missing a valid role.');
}

function makeVariant(
  ordinal: number,
  content: string,
  info: Record<string, unknown>,
): StChatVariant {
  const infoExtra = isRecord(info.extra) ? info.extra : undefined;
  const extra = cloneRecord(infoExtra ?? {});
  const sendDate = timestamp(info.send_date);
  const generationStarted = timestamp(info.gen_started);
  const generationFinished = timestamp(info.gen_finished);
  const api = stringField(extra.api);
  const model = stringField(extra.model);
  const rawTokenCount = finiteNumber(extra.token_count);
  const tokenCount = rawTokenCount !== undefined && rawTokenCount >= 0 ? rawTokenCount : undefined;
  const reasoning = stringField(extra.reasoning);
  const rawReasoningDuration = finiteNumber(extra.reasoning_duration);
  const reasoningDuration = rawReasoningDuration !== undefined && rawReasoningDuration >= 0
    ? rawReasoningDuration
    : undefined;
  const swipeInfo = without(info, SWIPE_INFO_KNOWN);
  if (sendDate === undefined && hasOwn(info, 'send_date')) swipeInfo.send_date = structuredClone(info.send_date);
  if (generationStarted === undefined && hasOwn(info, 'gen_started')) {
    swipeInfo.gen_started = structuredClone(info.gen_started);
  }
  if (generationFinished === undefined && hasOwn(info, 'gen_finished')) {
    swipeInfo.gen_finished = structuredClone(info.gen_finished);
  }
  return {
    ordinal,
    content,
    ...(sendDate === undefined ? {} : { sendDate }),
    ...(generationStarted === undefined ? {} : { generationStarted }),
    ...(generationFinished === undefined ? {} : { generationFinished }),
    ...(api === undefined ? {} : { api }),
    ...(model === undefined ? {} : { model }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoningDuration === undefined ? {} : { reasoningDuration }),
    extra,
    swipeInfo,
  };
}

function messageSwipeInfo(source: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(hasOwn(source, 'send_date') ? { send_date: structuredClone(source.send_date) } : {}),
    ...(hasOwn(source, 'gen_started') ? { gen_started: structuredClone(source.gen_started) } : {}),
    ...(hasOwn(source, 'gen_finished') ? { gen_finished: structuredClone(source.gen_finished) } : {}),
    extra: cloneRecord(extra),
  };
}

function normalizeMessage(
  source: Record<string, unknown>,
  header: StChatHeader,
  warnings: ImportDiagnostic[],
): StChatMessage {
  const messageExtra = inertRecord(source.extra);
  const role = messageRole(source, messageExtra);
  const content = stringField(source.mes);
  if (content === undefined) fail('chat_message_invalid', 'Chat message is missing string field `mes`.');
  const name = stringField(source.name) ?? (role === 'user' ? header.userName : header.characterName);

  const hadExplicitSwipes = source.swipes !== undefined;
  let contents: string[];
  let infos: Record<string, unknown>[];
  let activeVariantIndex: number;
  if (hadExplicitSwipes) {
    if (!Array.isArray(source.swipes) || source.swipes.length === 0 || !source.swipes.every((item) => typeof item === 'string')) {
      fail('chat_swipe_alignment_invalid', 'Chat message `swipes` must be a non-empty string array.');
    }
    contents = [...source.swipes] as string[];
    const explicitIndex = nonNegativeInteger(source.swipe_id);
    if (source.swipe_id !== undefined && explicitIndex === undefined) {
      fail('chat_swipe_index_invalid', 'Chat `swipe_id` must be a non-negative integer.');
    }
    activeVariantIndex = explicitIndex ?? Math.max(contents.lastIndexOf(content), 0);
    if (activeVariantIndex >= contents.length) {
      fail('chat_swipe_index_invalid', 'Chat `swipe_id` is outside the swipe array.');
    }
    const sourceInfos = Array.isArray(source.swipe_info) ? source.swipe_info : [];
    let backfilled = !Array.isArray(source.swipe_info);
    infos = contents.map((_variant, index) => {
      const info = sourceInfos[index];
      if (isRecord(info)) return cloneRecord(info);
      backfilled = true;
      return messageSwipeInfo(source, {});
    });
    if (sourceInfos.length > contents.length) {
      warnings.push(diagnostic(
        'chat_swipe_info_surplus_ignored',
        'Surplus SillyTavern swipe metadata was ignored to preserve index alignment.',
      ));
    }
    if (backfilled) {
      warnings.push(diagnostic(
        'chat_swipe_info_backfilled',
        'Missing SillyTavern swipe metadata was backfilled from the selected message.',
      ));
    }
    const activeInfo = infos[activeVariantIndex]!;
    const activeExtra = isRecord(activeInfo.extra) ? activeInfo.extra : {};
    infos[activeVariantIndex] = {
      ...activeInfo,
      ...(hasOwn(source, 'send_date') ? { send_date: structuredClone(source.send_date) } : {}),
      ...(hasOwn(source, 'gen_started') ? { gen_started: structuredClone(source.gen_started) } : {}),
      ...(hasOwn(source, 'gen_finished') ? { gen_finished: structuredClone(source.gen_finished) } : {}),
      extra: { ...cloneRecord(activeExtra), ...cloneRecord(messageExtra) },
    };
  } else {
    if (source.swipe_info !== undefined || source.swipe_id !== undefined) {
      fail('chat_swipe_alignment_invalid', 'Chat swipe metadata requires a `swipes` array.');
    }
    contents = [content];
    infos = [messageSwipeInfo(source, messageExtra)];
    activeVariantIndex = 0;
  }

  const variants = contents.map((variantContent, ordinal) => makeVariant(ordinal, variantContent, infos[ordinal]!));
  return {
    role,
    isSystem: source.is_system === true,
    name,
    content: contents[activeVariantIndex]!,
    activeVariantIndex,
    hadExplicitSwipes,
    variants,
    extra: messageExtra,
    raw: without(source, MESSAGE_KNOWN),
  };
}

function decodeWithWarnings(
  bytes: Uint8Array,
  options: StChatCodecOptions,
): { document: StChatDocument; warnings: ImportDiagnostic[] } {
  const cap = limits(options);
  validateArtifact(bytes, cap);
  let header: StChatHeader | undefined;
  const messages: StChatMessage[] = [];
  const warnings: ImportDiagnostic[] = [];
  let userIdentity: string | undefined;
  let assistantIdentity: string | undefined;
  let variantCount = 0;
  visitDecodedLines(bytes, cap, (line, recordIndex) => {
    const record = parseRecord(line, recordIndex);
    if (recordIndex === 0) {
      header = normalizeHeader(record);
      userIdentity = header.userName === 'unused' ? undefined : header.userName;
      assistantIdentity = header.characterName === 'unused' ? undefined : header.characterName;
      return;
    }
    if (header === undefined) fail('chat_header_invalid', 'Chat JSONL header is missing.');
    const rawVariantCount = Array.isArray(record.swipes) ? record.swipes.length : 1;
    if (variantCount + rawVariantCount > cap.maxVariants) {
      fail('chat_variant_limit', `Chat exceeds the ${cap.maxVariants}-variant limit.`);
    }
    const message = normalizeMessage(record, header, warnings);
    if (message.role === 'user' && userIdentity === undefined) userIdentity = message.name;
    if (message.role === 'assistant') {
      if (assistantIdentity === undefined) assistantIdentity = message.name;
    }
    variantCount += message.variants.length;
    if (variantCount > cap.maxVariants) {
      fail('chat_variant_limit', `Chat exceeds the ${cap.maxVariants}-variant limit.`);
    }
    messages.push(message);
  });
  if (header === undefined) fail('chat_header_invalid', 'Chat JSONL header is missing.');
  if (header.userName === 'unused' && userIdentity !== undefined) header.userName = userIdentity;
  if (header.characterName === 'unused' && assistantIdentity !== undefined) header.characterName = assistantIdentity;
  return { document: { header, messages }, warnings };
}

export function decodeStChatJsonl(bytes: Uint8Array, options: StChatCodecOptions = {}): StChatDocument {
  return decodeWithWarnings(bytes, options).document;
}

export function inspectStChatJsonl(
  bytes: Uint8Array,
  fileName = 'chat.jsonl',
  options: StChatCodecOptions = {},
): StChatInspection {
  try {
    const decoded = decodeWithWarnings(bytes, options);
    return {
      fileName,
      normalizedPreview: decoded.document,
      blockingErrors: [],
      warnings: decoded.warnings,
    };
  } catch (error) {
    if (!(error instanceof StChatCodecError)) throw error;
    return {
      fileName,
      normalizedPreview: null,
      blockingErrors: [diagnostic(error.code, error.message)],
      warnings: [],
    };
  }
}

function optionalField(name: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [name]: value };
}

function exportVariantExtra(base: Record<string, unknown>, variant: StChatVariant): Record<string, unknown> {
  return {
    ...cloneRecord(base),
    ...optionalField('api', variant.api),
    ...optionalField('model', variant.model),
    ...optionalField('token_count', variant.tokenCount),
    ...optionalField('reasoning', variant.reasoning),
    ...optionalField('reasoning_duration', variant.reasoningDuration),
  };
}

function exportSwipeInfo(variant: StChatVariant): Record<string, unknown> {
  return {
    ...cloneRecord(variant.swipeInfo),
    ...optionalField('send_date', variant.sendDate),
    ...optionalField('gen_started', variant.generationStarted),
    ...optionalField('gen_finished', variant.generationFinished),
    extra: exportVariantExtra(variant.extra, variant),
  };
}

function exportVariantField(
  variant: StChatVariant,
  envelopeName: 'send_date' | 'gen_started' | 'gen_finished',
  normalized: StChatTimestamp | undefined,
): unknown {
  if (normalized !== undefined) return normalized;
  return hasOwn(variant.swipeInfo, envelopeName)
    ? structuredClone(variant.swipeInfo[envelopeName])
    : undefined;
}

function validateExportMessage(message: StChatMessage): StChatVariant {
  if (message.variants.length === 0) {
    fail('chat_export_invalid', 'A chat message must contain at least one variant.');
  }
  if (!Number.isInteger(message.activeVariantIndex)
    || message.activeVariantIndex < 0
    || message.activeVariantIndex >= message.variants.length) {
    fail('chat_export_invalid', 'A chat message has an invalid active variant index.');
  }
  return message.variants[message.activeVariantIndex]!;
}

function exportMessage(message: StChatMessage, header: StChatHeader): Record<string, unknown> {
  const active = validateExportMessage(message);
  const useSwipes = message.hadExplicitSwipes || message.variants.length > 1;
  const exportedName = message.role === 'user'
    ? header.userName
    : message.role === 'assistant'
      ? message.name
      : message.name;
  const base: Record<string, unknown> = {
    ...cloneRecord(message.raw),
    name: exportedName,
    is_user: message.role === 'user',
    is_system: message.role === 'system' ? message.isSystem : false,
    ...optionalField('send_date', exportVariantField(active, 'send_date', active.sendDate)),
    ...optionalField('gen_started', exportVariantField(active, 'gen_started', active.generationStarted)),
    ...optionalField('gen_finished', exportVariantField(active, 'gen_finished', active.generationFinished)),
    mes: active.content,
    extra: exportVariantExtra(active.extra, active),
  };
  if (!useSwipes) return base;
  return {
    ...base,
    swipes: message.variants.map((variant) => variant.content),
    swipe_id: message.activeVariantIndex,
    swipe_info: message.variants.map(exportSwipeInfo),
  };
}

function safeFileName(fileName: string): string {
  const sanitized = fileName.replace(/[\r\n]/g, '_');
  return sanitized.length > 0 ? sanitized : 'chat.jsonl';
}

function validateExportShape(chat: StChatDocument, cap: StChatCodecLimits): void {
  if (chat.messages.length > cap.maxMessages) {
    fail('chat_message_limit', `Chat exceeds the ${cap.maxMessages}-message limit.`);
  }
  let variantCount = 0;
  for (const message of chat.messages) {
    variantCount += message.variants.length;
    if (variantCount > cap.maxVariants) {
      fail('chat_variant_limit', `Chat exceeds the ${cap.maxVariants}-variant limit.`);
    }
  }
}

function exportHeader(header: StChatHeader): Record<string, unknown> {
  return {
    ...cloneRecord(header.raw),
    user_name: header.userName,
    character_name: header.characterName,
    ...optionalField('create_date', header.createDate),
    chat_metadata: cloneRecord(header.chatMetadata),
  };
}

function* exportRecords(chat: StChatDocument): Generator<Record<string, unknown>> {
  yield exportHeader(chat.header);
  for (const message of chat.messages) yield exportMessage(message, chat.header);
}

const JSON_SIZE_LIMIT = Symbol('json-size-limit');

/** Computes compact JSON UTF-8 size while stopping before an oversized line is materialized. */
function boundedJsonByteLength(value: unknown, limit: number): number {
  let total = 0;
  const ancestors = new Set<object>();
  const add = (amount: number) => {
    total += amount;
    if (total > limit) throw JSON_SIZE_LIMIT;
  };
  const addString = (text: string) => {
    add(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
        || code === 0x0a || code === 0x0c || code === 0x0d) {
        add(2);
      } else if (code <= 0x1f) {
        add(6);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index += 1;
        } else {
          add(6);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        add(6);
      } else if (code <= 0x7f) {
        add(1);
      } else if (code <= 0x7ff) {
        add(2);
      } else {
        add(3);
      }
    }
  };
  const omitted = (item: unknown) => item === undefined || typeof item === 'function' || typeof item === 'symbol';
  const visit = (item: unknown, arraySlot = false): void => {
    if (omitted(item)) {
      if (arraySlot) add(4);
      return;
    }
    if (item === null) {
      add(4);
      return;
    }
    if (typeof item === 'string') {
      addString(item);
      return;
    }
    if (typeof item === 'number') {
      add(Number.isFinite(item) ? JSON.stringify(item).length : 4);
      return;
    }
    if (typeof item === 'boolean') {
      add(item ? 4 : 5);
      return;
    }
    if (typeof item === 'bigint') throw new TypeError('BigInt cannot be serialized as JSON.');
    if (typeof item !== 'object') throw new TypeError('Unsupported JSON value.');
    if (ancestors.has(item)) throw new TypeError('Circular JSON value.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        add(1);
        item.forEach((entry, index) => {
          if (index > 0) add(1);
          visit(entry, true);
        });
        add(1);
        return;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported JSON object prototype.');
      add(1);
      let emitted = 0;
      for (const key of Object.keys(item)) {
        const entry = Reflect.get(item, key);
        if (omitted(entry)) continue;
        if (emitted > 0) add(1);
        addString(key);
        add(1);
        visit(entry);
        emitted += 1;
      }
      add(1);
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    visit(value);
    return total;
  } catch (error) {
    if (error === JSON_SIZE_LIMIT) return limit + 1;
    throw error;
  }
}

function preflightExport(chat: StChatDocument, cap: StChatCodecLimits): number {
  let totalBytes = 0;
  try {
    for (const record of exportRecords(chat)) {
      const lineBytes = boundedJsonByteLength(record, cap.maxLineBytes);
      if (lineBytes > cap.maxLineBytes) {
        fail('chat_line_limit', `Chat JSONL line exceeds the ${cap.maxLineBytes}-byte line limit.`);
      }
      totalBytes += lineBytes + 1;
      if (totalBytes > cap.maxTotalBytes) {
        fail('chat_total_limit', `Chat exceeds the ${cap.maxTotalBytes}-byte total limit.`);
      }
    }
  } catch (error) {
    if (error instanceof StChatCodecError) throw error;
    fail('chat_export_invalid', 'Chat contains data that cannot be serialized as JSON.', error);
  }
  return totalBytes;
}

function* encodeExport(chat: StChatDocument, cap: StChatCodecLimits): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const record of exportRecords(chat)) {
    let encoded: Uint8Array;
    try {
      const json = JSON.stringify(record);
      if (json === undefined) throw new TypeError('JSON record is undefined.');
      encoded = encoder.encode(json);
    } catch (error) {
      fail('chat_export_invalid', 'Chat contains data that cannot be serialized as JSON.', error);
    }
    if (encoded.byteLength > cap.maxLineBytes) {
      fail('chat_line_limit', `Chat JSONL line exceeds the ${cap.maxLineBytes}-byte line limit.`);
    }
    totalBytes += encoded.byteLength + 1;
    if (totalBytes > cap.maxTotalBytes) {
      fail('chat_total_limit', `Chat exceeds the ${cap.maxTotalBytes}-byte total limit.`);
    }
    const line = new Uint8Array(encoded.byteLength + 1);
    line.set(encoded);
    line[line.byteLength - 1] = 0x0a;
    yield line;
  }
}

export function streamStChatJsonl(
  chat: StChatDocument,
  fileName = 'chat.jsonl',
  options: StChatCodecOptions = {},
): StChatStreamArtifact {
  const cap = limits(options);
  validateExportShape(chat, cap);
  const totalBytes = preflightExport(chat, cap);
  return {
    chunks: { *[Symbol.iterator]() { yield* encodeExport(chat, cap); } },
    totalBytes,
    contentType: 'application/x-ndjson; charset=utf-8',
    fileName: safeFileName(fileName),
  };
}

export function exportStChatJsonl(
  chat: StChatDocument,
  fileName = 'chat.jsonl',
  options: StChatCodecOptions = {},
): StChatExportArtifact {
  const streamed = streamStChatJsonl(chat, fileName, options);
  const bytes = new Uint8Array(streamed.totalBytes);
  let offset = 0;
  for (const chunk of streamed.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: streamed.contentType,
    fileName: streamed.fileName,
  };
}
