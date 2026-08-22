import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message) {
  throw new Error(`Approved remote cache: ${message}`);
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

export function verifyApprovedRemoteCache(manifestInput, artifacts) {
  const manifestPath = resolve(manifestInput);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) fail(`manifest not found at ${manifestPath}`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { fail('manifest must be valid JSON'); }
  const object = record(manifest);
  const approvedArtifacts = record(object?.artifacts);
  if (object?.version !== 1 || approvedArtifacts === undefined || !Array.isArray(object.entries) || object.entries.length === 0) {
    fail('manifest must contain version 1, artifact hashes, and at least one approved entry');
  }
  const characterSha256 = approvedArtifacts.characterSha256;
  const presetSha256 = approvedArtifacts.presetSha256;
  if (![characterSha256, presetSha256].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    fail('artifact hashes must be lowercase SHA-256 values');
  }
  if (sha256(artifacts.characterPath) !== characterSha256 || sha256(artifacts.presetPath) !== presetSha256) {
    fail('manifest is not approved for the configured Character and Preset bytes');
  }

  const urls = new Set();
  const entries = object.entries.map((candidate, index) => {
    const entry = record(candidate);
    const url = entry?.url;
    const expected = entry?.sha256;
    const pathValue = entry?.path;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || typeof expected !== 'string'
      || !/^[a-f0-9]{64}$/.test(expected) || typeof pathValue !== 'string' || pathValue.trim() === '') {
      fail(`entry ${index} must contain an HTTP(S) URL, lowercase SHA-256, and file path`);
    }
    if (urls.has(url)) fail(`duplicate approved URL ${url}`);
    urls.add(url);
    const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(dirname(manifestPath), pathValue);
    if (!existsSync(path) || !statSync(path).isFile()) fail(`cached file not found for ${url}`);
    if (sha256(path) !== expected) fail(`cached bytes do not match approved hash for ${url}`);
    return { url, sha256: expected, path };
  });
  return {
    manifestPath,
    manifestSha256: sha256(manifestPath),
    characterSha256,
    presetSha256,
    entries,
  };
}
