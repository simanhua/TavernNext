import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const defaultInspectionWorkspaceRoot = join(tmpdir(), 'tavernnext-st-compat-inspections');
const inspectionWorkspaceTtlMs = 15 * 60 * 1000;
const uuidDirectory = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

interface ArchiveSource {
  size: number;
  read(offset: number, length: number): Uint8Array;
}

interface ExtractedArchive {
  entries: string[];
  files: Map<string, { path: string; size: number }>;
}

export interface InspectionOptions {
  /** Parent for UUID-owned disk workspaces. Inspection recovers stale children and removes its own child. */
  workspaceRoot?: string;
}

export function recoverInspectionWorkspaces(
  root: string,
  now: number = Date.now(),
  ttl: number = inspectionWorkspaceTtlMs,
): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!uuidDirectory.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      const details = lstatSync(path);
      if (details.isDirectory() && !details.isSymbolicLink() && details.mtimeMs + ttl <= now) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Recovery is opportunistic; another process may have removed or replaced the same child.
    }
  }
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function updateCrc32(state: number, bytes: Uint8Array): number {
  let next = state;
  for (const byte of bytes) next = (next >>> 8) ^ crc32Table[(next ^ byte) & 0xff]!;
  return next >>> 0;
}

function crc32(bytes: Uint8Array): number {
  return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
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

function bytesSource(bytes: Uint8Array): ArchiveSource {
  return {
    size: bytes.byteLength,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new Error('Archive read is out of bounds');
      return bytes.subarray(offset, offset + length);
    },
  };
}

function fileSource(path: string): { source: ArchiveSource; close(): void } {
  const descriptor = openSync(path, 'r');
  const size = fstatSync(descriptor).size;
  return {
    source: {
      size,
      read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > size) throw new Error('Archive read is out of bounds');
        const bytes = new Uint8Array(length);
        let read = 0;
        while (read < length) {
          const count = readSync(descriptor, bytes, read, length - read, offset + read);
          if (count === 0) throw new Error('Archive file ended unexpectedly');
          read += count;
        }
        return bytes;
      },
    },
    close() {
      closeSync(descriptor);
    },
  };
}

function findEndOfCentralDirectory(source: ArchiveSource): number {
  const tailOffset = Math.max(0, source.size - 65_557);
  const tail = source.read(tailOffset, source.size - tailOffset);
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail[offset] !== 0x50 || tail[offset + 1] !== 0x4b || tail[offset + 2] !== 0x05 || tail[offset + 3] !== 0x06) continue;
    const commentLength = new DataView(tail.buffer, tail.byteOffset + offset + 20, 2).getUint16(0, true);
    if (tailOffset + offset + 22 + commentLength === source.size) return tailOffset + offset;
  }
  return -1;
}

function parseCentralDirectory(source: ArchiveSource, limits: InspectionLimits, state: ArchiveState): CentralEntry[] {
  const eocdOffset = findEndOfCentralDirectory(source);
  if (eocdOffset < 0) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP end-of-central-directory record is missing.'));
  const eocdBytes = source.read(eocdOffset, source.size - eocdOffset);
  const eocd = new DataView(eocdBytes.buffer, eocdBytes.byteOffset, eocdBytes.byteLength);
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
  if (eocdOffset + 22 + commentLength !== source.size || centralOffset + centralSize > eocdOffset) {
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
    const header = source.read(offset, 46);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
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
    const nameBytes = source.read(offset + 46, nameLength);
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

function extractArchive(
  source: ArchiveSource,
  limits: InspectionLimits,
  state: ArchiveState,
  depth: number,
  workspace: string,
): ExtractedArchive {
  if (depth > limits.maxArchiveNesting) {
    throw new InspectionFailure(diagnostic('archive_nesting_limit', `Archive nesting exceeds ${limits.maxArchiveNesting} levels.`));
  }
  const centralEntries = parseCentralDirectory(source, limits, state);
  const expected = new Map(centralEntries.map((entry) => [entry.name, entry]));
  if (expected.size !== centralEntries.length) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entries are duplicated.'));
  const files = new Map<string, { path: string; size: number }>();
  const startedFiles = new Set<string>();
  const openDescriptors = new Set<number>();
  try {
    const unzip = new Unzip((file) => {
      if (startedFiles.has(file.name)) throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entries are duplicated.', file.name));
      startedFiles.add(file.name);
      const outputPath = join(workspace, `${randomUUID()}.entry`);
      const descriptor = openSync(outputPath, 'wx', 0o600);
      openDescriptors.add(descriptor);
      let length = 0;
      let checksum = 0xffffffff;
      let lineBytes = 0;
      const isText = /\.(?:jsonl?|ya?ml|txt)$/i.test(file.name);
      file.ondata = (error, chunk, final) => {
        if (error !== null) throw error;
        if (chunk !== null && chunk.length > 0) {
          state.decompressedBytes += chunk.length;
          length += chunk.length;
          if (state.decompressedBytes > limits.maxDecompressedBytes) {
            file.terminate();
            throw new InspectionFailure(diagnostic('archive_decompressed_limit', `Archive expands beyond ${limits.maxDecompressedBytes} bytes.`));
          }
          checksum = updateCrc32(checksum, chunk);
          if (isText) {
            for (const byte of chunk) {
              if (byte === 0x0a) lineBytes = 0;
              else {
                lineBytes += 1;
                if (lineBytes > limits.maxTextLineBytes) {
                  throw new InspectionFailure(diagnostic('text_line_limit', `A text line exceeds the ${limits.maxTextLineBytes}-byte limit.`, file.name));
                }
              }
            }
          }
          let written = 0;
          while (written < chunk.length) written += writeSync(descriptor, chunk, written, chunk.length - written);
        }
        if (final) {
          const expectedEntry = expected.get(file.name);
          if (expectedEntry === undefined || expectedEntry.originalSize !== length) {
            throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entry size does not match the central directory.', file.name));
          }
          if (((checksum ^ 0xffffffff) >>> 0) !== expectedEntry.crc32) {
            throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entry checksum does not match the central directory.', file.name));
          }
          closeSync(descriptor);
          openDescriptors.delete(descriptor);
          files.set(file.name, { path: outputPath, size: length });
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    const streamChunkSize = 8 * 1024;
    for (let offset = 0; offset < source.size; offset += streamChunkSize) {
      const end = Math.min(source.size, offset + streamChunkSize);
      unzip.push(source.read(offset, end - offset), end === source.size);
    }
  } catch (error) {
    if (error instanceof InspectionFailure) throw error;
    throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP data could not be decompressed.'));
  } finally {
    for (const descriptor of openDescriptors) closeSync(descriptor);
  }
  if (files.size !== centralEntries.length) {
    throw new InspectionFailure(diagnostic('corrupt_archive', 'ZIP entries are missing or duplicated.'));
  }
  for (const [name, file] of files) {
    const lowerName = name.toLowerCase();
    const nestedByName = lowerName.endsWith('.zip') || lowerName.endsWith('.charx') || lowerName.endsWith('.byaf');
    if (nestedByName || file.size >= zipSignature.length) {
      const nested = fileSource(file.path);
      try {
        const nestedBySignature = file.size >= zipSignature.length
          && startsWith(nested.source.read(0, zipSignature.length), zipSignature);
        if (!nestedByName && !nestedBySignature) continue;
        extractArchive(nested.source, limits, state, depth + 1, workspace);
      } finally {
        nested.close();
      }
    }
  }
  return { entries: centralEntries.map((entry) => entry.name), files };
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
    const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).getUint32(0);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) throw new Error('PNG chunk checksum mismatch');
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

function parseArchiveJson(archive: ExtractedArchive, name: string, limits: InspectionLimits): unknown {
  const file = archive.files.get(name);
  if (file === undefined) return undefined;
  if (file.size > limits.maxInMemoryEntryBytes) {
    throw new InspectionFailure(diagnostic(
      'archive_entry_memory_limit',
      `${name} exceeds the ${limits.maxInMemoryEntryBytes}-byte manifest memory limit.`,
      name,
    ));
  }
  try {
    return parseJson(readFileSync(file.path));
  } catch {
    throw new InspectionFailure(diagnostic('corrupt_archive_manifest', `${name} is not valid JSON.`, name));
  }
}

function inspectZip(preview: ImportPreview, input: SourceArtifact, limits: InspectionLimits, options: InspectionOptions): void {
  const workspaceRoot = options.workspaceRoot ?? defaultInspectionWorkspaceRoot;
  mkdirSync(workspaceRoot, { recursive: true });
  recoverInspectionWorkspaces(workspaceRoot);
  const workspace = join(workspaceRoot, randomUUID());
  mkdirSync(workspace, { mode: 0o700 });
  try {
    const archive = extractArchive(bytesSource(input.bytes), limits, { entries: 0, decompressedBytes: 0 }, 1, workspace);
    const previewEntries = archive.entries.slice(0, 256);
    const entryPreview = { entries: previewEntries, entryCount: archive.entries.length };
    const hasCharx = archive.files.has('card.json');
    const hasByaf = archive.files.has('manifest.json') && archive.entries.some((name) => /^characters\/[^/]+\/character\.json$/i.test(name));
    if (hasCharx && hasByaf) {
      preview.detected = { container: 'zip', kind: 'unknown', candidates: ['character'] };
      preview.normalizedPreview = entryPreview;
      preview.warnings.push(diagnostic('ambiguous_archive', 'Archive contains both CharX and BYAF roots.'));
      return;
    }
    if (hasCharx) {
      const card = parseArchiveJson(archive, 'card.json', limits);
      preview.detected = { container: 'charx', kind: 'character', version: characterVersion(card), candidates: ['character'] };
      preview.normalizedPreview = { ...entryPreview, card: { candidates: jsonCandidates(card) } };
      return;
    }
    if (hasByaf) {
      const manifest = objectRecord(parseArchiveJson(archive, 'manifest.json', limits));
      const version = typeof manifest?.version === 'string' || typeof manifest?.version === 'number' ? String(manifest.version) : '1';
      preview.detected = { container: 'byaf', kind: 'character', version, candidates: ['character'] };
      preview.normalizedPreview = entryPreview;
      return;
    }
    preview.detected = { container: 'zip', kind: 'unknown', candidates: [] };
    preview.normalizedPreview = entryPreview;
    preview.warnings.push(diagnostic('unrecognized_archive', 'ZIP is safe and valid but is not a recognized CharX or BYAF archive.'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
  options: InspectionOptions = {},
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
      inspectZip(preview, input, limits, options);
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
