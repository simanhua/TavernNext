import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyApprovedRemoteCache } from './approved-remote-cache.mjs';

const root = resolve(process.cwd());
const fixtureRoot = join(root, 'tests', 'fixtures');

function fail(message) {
  throw new Error(`Compatibility gate: ${message}`);
}

function filesBelow(directory) {
  if (!existsSync(directory)) fail(`missing fixture directory ${directory}`);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function fixtureFiles(family) {
  return filesBelow(join(fixtureRoot, family)).filter((path) => {
    const name = path.toLowerCase();
    return !name.endsWith('readme.md') && !name.endsWith('.mjs');
  });
}

function requireFiles(family, names) {
  for (const name of names) {
    const path = join(fixtureRoot, family, ...name.split('/'));
    if (!existsSync(path) || !statSync(path).isFile()) fail(`missing ${family} fixture ${name}`);
  }
}

const required = {
  characters: ['v1.json', 'v2.json', 'v3.json', 'character.yaml', 'legacy-st.yaml'],
  presets: [
    'chat/synthetic-chat.settings',
    'text/synthetic-text.json',
    'context/synthetic-context.json',
    'instruct/synthetic-instruct.json',
    'system/synthetic-system.json',
    'reasoning/synthetic-reasoning.json',
  ],
  worldbooks: ['native.json', 'character-book.json', 'novel.json', 'agnai.json', 'risu.json', 'naidata.png'],
  prompts: ['chat-golden.json', 'text-golden.json'],
  tokenizers: ['parity-corpus.json'],
};

const counts = {};
for (const [family, names] of Object.entries(required)) {
  requireFiles(family, names);
  counts[family] = fixtureFiles(family).length;
  if (counts[family] === 0) fail(`${family} has no fixtures`);
}

const parity = JSON.parse(readFileSync(join(fixtureRoot, 'tokenizers', 'parity-corpus.json'), 'utf8'));
if (!Array.isArray(parity) || parity.length === 0) fail('tokenizer parity corpus is empty');
counts.tokenizerCases = parity.length;

console.log('TavernNext compatibility fixture inventory');
for (const [family, count] of Object.entries(counts)) console.log(`  ${family}: ${count}`);

const compatibilityDocument = readFileSync(join(root, 'docs', 'compatibility.md'), 'utf8');
const capabilitySource = readFileSync(join(root, 'packages', 'extension-runtime', 'src', 'trusted-scripts.ts'), 'utf8');
const capabilityBlock = capabilitySource.match(/TAVERN_HELPER_BRIDGED_METHODS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/)?.[1];
if (capabilityBlock === undefined) fail('unable to read Tavern Helper capability inventory');
const bridgedMethods = [...capabilityBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const documentedBlock = compatibilityDocument.match(
  /<!-- tavern-helper-methods:start -->([\s\S]*?)<!-- tavern-helper-methods:end -->/,
)?.[1];
if (documentedBlock === undefined) fail('docs/compatibility.md is missing the machine-readable Tavern Helper inventory');
const documentedMethods = [...documentedBlock.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const exportedSet = new Set(bridgedMethods);
const documentedSet = new Set(documentedMethods);
if (bridgedMethods.length !== exportedSet.size) fail('TAVERN_HELPER_BRIDGED_METHODS exports a duplicate method');
for (const method of exportedSet) {
  if (!documentedSet.has(method)) fail(`docs/compatibility.md does not inventory ${method}`);
}
for (const method of documentedSet) {
  if (!exportedSet.has(method)) fail(`docs/compatibility.md inventories stale or unsupported method ${method}`);
}
if (documentedMethods.length !== documentedSet.size) {
  fail('docs/compatibility.md inventories a Tavern Helper method more than once');
}
console.log(`  documentedTavernHelperMethods: ${bridgedMethods.length}`);

const oracleInput = process.env.SILLYTAVERN_ORACLE_DIR;
if (oracleInput === undefined || oracleInput.trim() === '') {
  console.log('SillyTavern oracle: skipped (set SILLYTAVERN_ORACLE_DIR to enable read-only validation)');
  process.exit(0);
}

const oracleRoot = resolve(oracleInput);
for (const variable of [
  'TAVERNNEXT_REGEX_CARD_PATH',
  'TAVERNNEXT_REGEX_PRESET_PATH',
  'TAVERNNEXT_APPROVED_REMOTE_CACHE_MANIFEST',
]) {
  const path = process.env[variable];
  if (path === undefined || path.trim() === '' || !existsSync(resolve(path))) fail(`${variable} must name an existing reviewed oracle input`);
}
const cardPath = resolve(process.env.TAVERNNEXT_REGEX_CARD_PATH);
const presetPath = resolve(process.env.TAVERNNEXT_REGEX_PRESET_PATH);
const approvedCache = verifyApprovedRemoteCache(process.env.TAVERNNEXT_APPROVED_REMOTE_CACHE_MANIFEST, {
  characterPath: cardPath,
  presetPath,
});
console.log(`Approved remote cache: ${approvedCache.entries.length} hashed entries for the exact Character and Preset`);
const oraclePackagePath = join(oracleRoot, 'package.json');
if (!existsSync(oraclePackagePath)) fail(`oracle package.json not found at ${oracleRoot}`);
const oraclePackage = JSON.parse(readFileSync(oraclePackagePath, 'utf8'));
if (oraclePackage.name !== 'sillytavern' || oraclePackage.version !== '1.18.0') {
  fail(`expected SillyTavern 1.18.0 oracle, received ${String(oraclePackage.name)} ${String(oraclePackage.version)}`);
}

function git(args) {
  const result = spawnSync('git', ['-C', oracleRoot, ...args], { encoding: 'utf8' });
  if (result.status !== 0) fail(`unable to inspect oracle Git state: ${result.stderr.trim()}`);
  return result.stdout;
}

const beforeStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
const revision = git(['rev-parse', 'HEAD']).trim();
console.log(`SillyTavern oracle: ${oraclePackage.version} at ${revision}`);

const oracleTests = [
  'packages/st-compat/test/characters.test.ts',
  'packages/st-compat/test/presets.test.ts',
  'packages/st-compat/test/worldbooks.test.ts',
  'packages/tokenizer-engine/test/parity.test.ts',
  'packages/prompt-engine/test/oracle.test.ts',
  'packages/prompt-engine/test/worldbook/oracle.test.ts',
  'tests/oracle/st-export-acceptance.test.ts',
  'tests/oracle/regex-oracle.test.ts',
];
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const verification = spawnSync(process.execPath, [vitest, 'run', ...oracleTests], {
  cwd: root,
  env: {
    ...process.env,
    TAVERNNEXT_ST_ORACLE_ROOT: oracleRoot,
  },
  stdio: 'inherit',
});
if (verification.error !== undefined) throw verification.error;
if (verification.status !== 0) fail(`oracle tests exited with ${verification.status}`);

const afterStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
if (afterStatus !== beforeStatus) fail('oracle checkout changed during read-only validation');
const cacheAfter = verifyApprovedRemoteCache(approvedCache.manifestPath, { characterPath: cardPath, presetPath });
if (JSON.stringify(cacheAfter) !== JSON.stringify(approvedCache)) fail('approved remote cache changed during validation');
console.log('SillyTavern oracle: export validators and compatibility probes passed without modifying the checkout');
