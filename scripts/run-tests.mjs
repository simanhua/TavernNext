import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const vitest = resolve('node_modules/vitest/vitest.mjs');
const common = ['run', '--no-file-parallelism', '--maxWorkers', '1'];

function run(arguments_) {
  const result = spawnSync(process.execPath, [vitest, ...common, ...arguments_], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const requested = process.argv.slice(2);
if (requested.length > 0) {
  run(requested);
  process.exit(0);
}

const isolated = [
  {
    file: 'apps/server/test/scene-director-generation.test.ts',
    name: 'commits no assistant response for empty, failed, cancelled, or exhausted runs',
  },
  {
    file: 'apps/server/test/db/repositories.test.ts',
    name: 'persists a separately revisioned Worldbook timed state and exposes snapshots as immutable',
  },
  {
    file: 'apps/server/test/db/repositories.test.ts',
    name: 'upgrades the b87d7f7 legacy schema while preserving library payloads and resetting chats',
  },
  {
    file: 'apps/server/test/db/repositories.test.ts',
    name: 'cascades deleted conversations to messages and variants without deleting their character or persona',
  },
];
const excludedNames = isolated.map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
run(['--testNamePattern', `^(?!.*(?:${excludedNames})).*$`]);
for (const test of isolated) run([test.file, '--testNamePattern', test.name]);
