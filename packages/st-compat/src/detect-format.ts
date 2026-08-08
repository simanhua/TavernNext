import { Unzip, UnzipInflate } from 'fflate';
import { parse as parseYaml } from 'yaml';
import extractPngChunks from 'png-chunks-extract';
import { decode as decodePngText } from 'png-chunk-text';
import {
  DEFAULT_INSPECTION_LIMITS,
  emptyPreview,
  type ArtifactKind,
  type ImportPreview,
  type InspectionLimits,
  type SourceArtifact,
} from './artifact.js';
import { diagnostic, type ImportDiagnostic } from './warnings.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const zipSignature = Uint8Array.from([0x50, 0x4b]);
const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class InspectionFailure extends Error {
  constructor(readonly issue: ImportDiagnostic) {
    super(issue.message);
  }
}

interface CentralEntry {
  name: string;
  originalSize: number;
  crc32: number;
}

interface ArchiveState {
  entries: number;
  decompressedBytes: number;
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function strictText(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new InspectionFailure(diagnostic('invalid_text_encoding', 'Text artifacts must contain valid UTF-8.'));
  }
}

function checkTextLines(bytes: Uint8Array, limit: number, path?: string): void {
  let lineStart = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index !== bytes.length && bytes[index] !== 0x0a) continue;
    if (index - lineStart > limit) {
      throw new InspectionFailure(diagnostic('text_line_limit', `A text line exceeds the ${limit}-byte limit.`, path));
    }
    lineStart = index + 1;
  }
}

function safeArchivePath(name: string): void {
  if (name.includes('\0')) throw new InspectionFailure(diagnostic('archive_path_invalid', 'Archive paths cannot contain NUL bytes.', name));
  const portable = name.replaceAll('\\', '/');
  if (portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:/.test(portable)) {
    throw new InspectionFailure(diagnostic('archive_absolute_path', 'Archive entries must use relative paths.', name));
  }
  if (portable.split('/').includes('..')) {
    throw new InspectionFailure(diagnostic('archive_path_traversal', 'Archive entries cannot traverse outside their root.', name));
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const lowerBound = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= lowerBound; offset -= 1) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x05 || bytes[offset + 3] !== 0x06) continue;
    const commentLength = new DataView(bytes.buffer, bytes.byteOffset + offset + 20, 2).getUint16(0, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return -1;
}

function parseCentralDirectory(bytes: Uint8Array, limits: InspectionLimits, state: ArchiveState): CentralEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP end-of-central-directory record is missing.'));
  const eocd = new DataView(bytes.buffer, bytes.byteOffset + eocdOffset, bytes.byteLength - eocdOffset);
  const disk = eocd.getUint16(4, true);
  const centralDisk = eocd.getUint16(6, true);
  const diskEntries = eocd.getUint16(8, true);
  const totalEntries = eocd.getUint16(10, true);
  const centralSize = eocd.getUint32(12, true);
  const centralOffset = eocd.getUint32(16, true);
  const commentLength = eocd.getUint16(20, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new InspectionFailure(diagnostic('archive_unsupported', 'Multi-disk and ZIP64 archives are not supported.'));
  }
  if (eocdOffset + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocdOffset) {
    throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP central-directory bounds are invalid.'));
  }
  state.entries += totalEntries;
  if (state.entries > limits.maxArchiveEntries) {
    throw new InspectionFailure(diagnostic('archive_entry_limit', `Archive contains more than ${limits.maxArchiveEntries} entries.`));
  }

  const entries: CentralEntry[] = [];
  let declaredBytes = 0;
  let offset = centralOffset;
  const end = centralOffset + centralSize;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > end) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP central directory is truncated.'));
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, end - offset);
    if (view.getUint32(0, true) !== 0x02014b50) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP central-directory entry is invalid.'));
    const flags = view.getUint16(8, true);
    const checksum = view.getUint32(16, true);
    const originalSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const entryCommentLength = view.getUint16(32, true);
    const externalAttributes = view.getUint32(38, true);
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > end) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entry metadata is truncated.'));
    if ((flags & 0x1) !== 0) throw new InspectionFailure(diagnostic('archive_encrypted', 'Encrypted archive entries are not supported.'));
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      throw new InspectionFailure(diagnostic('archive_path_invalid', 'Archive paths must contain valid UTF-8.'));
    }
    safeArchivePath(name);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
      throw new InspectionFailure(diagnostic('archive_link', 'Archive links and special files are not allowed.', name));
    }
    declaredBytes += originalSize;
    if (declaredBytes > limits.maxDecompressedBytes - state.decompressedBytes) {
      throw new InspectionFailure(diagnostic('archive_decompressed_limit', `Archive expands beyond ${limits.maxDecompressedBytes} bytes.`));
    }
    entries.push({ name, originalSize, crc32: checksum });
    offset = entryEnd;
  }
  if (offset !== end) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP central-directory size does not match its entries.'));
  return entries;
}

function extractArchive(bytes: Uint8Array, limits: InspectionLimits, state: ArchiveState, depth: number): Map<string, Uint8Array> {
  if (depth > limits.maxArchiveNesting) {
    throw new InspectionFailure(diagnostic('archive_nesting_limit', `Archive nesting exceeds ${limits.maxArchiveNesting} levels.`));
  }
  const centralEntries = parseCentralDirectory(bytes, limits, state);
  const expected = new Map(centralEntries.map((entry) => [entry.name, entry]));
  const files = new Map<string, Uint8Array>();
  try {
    const unzip = new Unzip((file) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      file.ondata = (error, chunk, final) => {
        if (error !== null) throw error;
        if (chunk !== null && chunk.length > 0) {
          state.decompressedBytes += chunk.length;
          length += chunk.length;
          if (state.decompressedBytes > limits.maxDecompressedBytes) {
            file.terminate();
            throw new InspectionFailure(diagnostic('archive_decompressed_limit', `Archive expands beyond ${limits.maxDecompressedBytes} bytes.`));
          }
          chunks.push(chunk.slice());
        }
        if (final) {
          const expectedEntry = expected.get(file.name);
          if (expectedEntry === undefined || expectedEntry.originalSize !== length) {
            throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entry size does not match the central directory.', file.name));
          }
          const data = new Uint8Array(length);
          let offset = 0;
          for (const part of chunks) {
            data.set(part, offset);
            offset += part.length;
          }
          if (crc32(data) !== expectedEntry.crc32) {
            throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entry checksum does not match the central directory.', file.name));
          }
          files.set(file.name, data);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const streamChunkSize = 8 * 1024;
    for (let offset = 0; offset < bytes.length; offset += streamChunkSize) {
      const end = Math.min(bytes.length, offset + streamChunkSize);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
    }
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP data could not be decompressed.'));
  }
  if (files.size !== centralEntries.length) {
    throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entries are missing or duplicated.'));
  }
  for (const [name, data] of files) {
    const lowerName = name.toLowerCase();
    if (/\.(?:jsonl?|ya?ml|txt)$/.test(lowerName)) checkTextLines(data, limits.maxTextLineBytes, name);
    if (startsWith(data, zipSignature) || lowerName.endsWith('.zip') || lowerName.endsWith('.charx') || lowerName.endsWith('.byaf')) {
      extractArchive(data, limits, state, depth + 1);
    }
  }
  return files;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonCandidates(value: unknown): ArtifactKind[] {
  const object = objectRecord(value);
  if (object === undefined) return Array.isArray(value) ? ['chat'] : [];
  const data = objectRecord(object.data);
  const candidates: ArtifactKind[] = [];
  if (
    (typeof object.spec === 'string' && object.spec.toLowerCase().includes('chara_card'))
    || (data !== undefined && typeof data.name === 'string')
    || (typeof object.name === 'string' && ['description', 'personality', 'first_mes', 'firstMessage'].some((key) => key in object))
  ) candidates.push('character');
  if (['prompts', 'prompt_order', 'story_string', 'input_sequence', 'output_sequence', 'reasoning'].some((key) => key in object)) candidates.push('preset');
  if ('entries' in object || 'loreItems' in object) candidates.push('worldbook');
  return candidates;
}

function characterVersion(value: unknown): string {
  const object = objectRecord(value);
  if (typeof object?.spec_version === 'string') return object.spec_version;
  if (typeof object?.spec === 'string') {
    const match = /(?:v|_)(\d+(?:\.\d+)?)/i.exec(object.spec);
    if (match?.[1] !== undefined) return match[1].includes('.') ? match[1] : `${match[1]}.0`;
  }
  return '1';
}

function applyJsonDetection(preview: ImportPreview, value: unknown, container: 'json' | 'yaml'): void {
  const candidates = jsonCandidates(value);
  const kind = candidates.length === 1 ? candidates[0] : 'unknown';
  preview.detected = {
    container,
    kind,
    ...(kind === 'character' ? { version: characterVersion(value) } : kind === 'unknown' ? {} : { version: '1' }),
    candidates,
  };
  const object = objectRecord(value);
  const data = objectRecord(object?.data);
  preview.normalizedPreview = {
    candidates,
    keys: object === undefined ? [] : Object.keys(object).slice(0, 64),
    ...((typeof data?.name === 'string' || typeof object?.name === 'string') ? { name: String(data?.name ?? object?.name) } : {}),
  };
  if (candidates.length > 1) preview.warnings.push(diagnostic('ambiguous_json', 'The document matches multiple import families; a specific codec must resolve it.'));
  if (candidates.length === 0) preview.warnings.push(diagnostic('unrecognized_document', 'The document is valid but does not match a known import family.'));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strictText(bytes));
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure(diagnostic('invalid_json', 'The JSON document is malformed.'));
  }
}

function inspectJson(preview: ImportPreview, input: SourceArtifact, limits: InspectionLimits): void {
  checkTextLines(input.bytes, limits.maxTextLineBytes);
  applyJsonDetection(preview, parseJson(input.bytes), 'json');
}

function inspectJsonLines(preview: ImportPreview, input: SourceArtifact, limits: InspectionLimits): void {
  checkTextLines(input.bytes, limits.maxTextLineBytes);
  const lines = strictText(input.bytes).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new InspectionFailure(diagnostic('invalid_jsonl', 'The JSONL document contains no records.'));
  try {
    for (const line of lines) JSON.parse(line);
  } catch {
    throw new InspectionFailure(diagnostic('invalid_jsonl', 'Every non-empty JSONL line must be valid JSON.'));
  }
  preview.detected = { container: 'jsonl', kind: 'chat', version: '1', candidates: ['chat'] };
  preview.normalizedPreview = { lineCount: lines.length };
}

function strictBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new InspectionFailure(diagnostic('corrupt_png_metadata', 'PNG character metadata is not valid base64.'));
  }
  return Buffer.from(trimmed, 'base64');
}

function validatePngBounds(bytes: Uint8Array): void {
  if (!startsWith(bytes, pngSignature)) throw new Error('Invalid PNG signature');
  let offset = pngSignature.length;
  let first = true;
  let ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (length > bytes.length - offset - 12) throw new Error('Invalid PNG chunk bounds');
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (first && name !== 'IHDR') throw new Error('PNG must begin with IHDR');
    if (name === 'IEND') {
      if (length !== 0 || offset + 12 !== bytes.length) throw new Error('Invalid PNG end');
      ended = true;
    }
    offset += length + 12;
    first = false;
  }
  if (!ended) throw new Error('PNG is missing IEND');
}

function inspectPng(preview: ImportPreview, input: SourceArtifact): void {
  try {
    validatePngBounds(input.bytes);
    const chunks = extractPngChunks(input.bytes);
    const metadata = new Map<string, unknown>();
    for (const chunk of chunks) {
      if (chunk.name !== 'tEXt') continue;
      const text = decodePngText(chunk);
      if (text.keyword !== 'chara' && text.keyword !== 'ccv3') continue;
      metadata.set(text.keyword, parseJson(strictBase64(text.text)));
    }
    const selected = metadata.get('ccv3') ?? metadata.get('chara');
    if (selected === undefined) {
      preview.detected = { container: 'png', kind: 'unknown', candidates: [] };
      preview.normalizedPreview = { metadataKeys: [] };
      preview.warnings.push(diagnostic('png_metadata_missing', 'PNG is valid but contains no supported character metadata.'));
      return;
    }
    preview.detected = { container: 'png', kind: 'character', version: characterVersion(selected), candidates: ['character'] };
    preview.normalizedPreview = { metadataKeys: [...metadata.keys()], selectedMetadata: metadata.has('ccv3') ? 'ccv3' : 'chara' };
    if (metadata.size > 1) preview.warnings.push(diagnostic('png_multiple_character_chunks', 'Both legacy and V3 metadata are preserved; V3 is selected.'));
  } catch (error) {
    if (error instanceof InspectionFailure && error.issue.code === 'corrupt_png_metadata') throw error;
    throw new InspectionFailure(diagnostic('corrupt_png', 'PNG chunks or metadata are corrupt.'));
  }
}

function parseArchiveJson(files: Map<string, Uint8Array>, name: string): unknown {
  const bytes = files.get(name);
  if (bytes === undefined) return undefined;
  try {
    return parseJson(bytes);
  } catch {
    throw new InspectionFailure(diagnostic('corrupt_archive_manifest', `${name} is not valid JSON.`, name));
  }
}

function inspectZip(preview: ImportPreview, input: SourceArtifact, limits: InspectionLimits): void {
  const files = extractArchive(input.bytes, limits, { entries: 0, decompressedBytes: 0 }, 1);
  const hasCharx = files.has('card.json');
  const hasByaf = files.has('manifest.json') && [...files.keys()].some((name) => /^characters\/[^/]+\/character\.json$/i.test(name));
  if (hasCharx && hasByaf) {
    preview.detected = { container: 'zip', kind: 'unknown', candidates: ['character'] };
    preview.normalizedPreview = { entries: [...files.keys()] };
    preview.warnings.push(diagnostic('ambiguous_archive', 'Archive contains both CharX and BYAF roots.'));
    return;
  }
  if (hasCharx) {
    const card = parseArchiveJson(files, 'card.json');
    preview.detected = { container: 'charx', kind: 'character', version: characterVersion(card), candidates: ['character'] };
    preview.normalizedPreview = { entries: [...files.keys()], card: { candidates: jsonCandidates(card) } };
    return;
  }
  if (hasByaf) {
    const manifest = objectRecord(parseArchiveJson(files, 'manifest.json'));
    const version = typeof manifest?.version === 'string' || typeof manifest?.version === 'number' ? String(manifest.version) : '1';
    preview.detected = { container: 'byaf', kind: 'character', version, candidates: ['character'] };
    preview.normalizedPreview = { entries: [...files.keys()] };
    return;
  }
  preview.detected = { container: 'zip', kind: 'unknown', candidates: [] };
  preview.normalizedPreview = { entries: [...files.keys()] };
  preview.warnings.push(diagnostic('unrecognized_archive', 'ZIP is safe and valid but is not a recognized CharX or BYAF archive.'));
}

function inspectYaml(preview: ImportPreview, input: SourceArtifact, limits: InspectionLimits): void {
  checkTextLines(input.bytes, limits.maxTextLineBytes);
  let value: unknown;
  try {
    value = parseYaml(strictText(input.bytes), { maxAliasCount: 0 });
  } catch {
    throw new InspectionFailure(diagnostic('invalid_yaml', 'The YAML document is malformed or uses aliases.'));
  }
  applyJsonDetection(preview, value, 'yaml');
}

function isExtension(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

export async function inspectArtifact(
  input: SourceArtifact,
  limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
): Promise<ImportPreview> {
  const preview = emptyPreview(input);
  if (input.bytes.byteLength > limits.maxUploadBytes) {
    preview.blockingErrors.push(diagnostic('upload_too_large', `Upload exceeds ${limits.maxUploadBytes} bytes.`));
    return preview;
  }
  try {
    if (startsWith(input.bytes, pngSignature) || isExtension(input.fileName, ['.png'])) {
      inspectPng(preview, input);
    } else if (startsWith(input.bytes, zipSignature) || isExtension(input.fileName, ['.zip', '.charx', '.byaf'])) {
      inspectZip(preview, input, limits);
    } else if (isExtension(input.fileName, ['.jsonl', '.ndjson']) || input.mediaType === 'application/x-ndjson') {
      inspectJsonLines(preview, input, limits);
    } else if (isExtension(input.fileName, ['.yaml', '.yml']) || input.mediaType === 'application/yaml' || input.mediaType === 'text/yaml') {
      inspectYaml(preview, input, limits);
    } else {
      inspectJson(preview, input, limits);
    }
  } catch (error) {
    preview.blockingErrors.push(error instanceof InspectionFailure
      ? error.issue
      : diagnostic('inspection_failed', 'Artifact inspection failed safely.'));
  }
  return preview;
}
