import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface OracleRegex {
  runRegexScript(rule: Record<string, unknown>, raw: string): string;
  provenance: {
    packageName: string;
    version: string;
    revision: string;
    source: string;
    declarations: string[];
  };
}

function declaration(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`SillyTavern regex oracle declaration missing: ${start}`);
  return source.slice(from, to).replace(/^export /, '');
}

export function loadSillyTavernRegexOracle(root: string): OracleRegex {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (packageJson.name !== 'sillytavern' || packageJson.version !== '1.18.0') {
    throw new Error(`Expected SillyTavern 1.18.0, received ${String(packageJson.name)} ${String(packageJson.version)}`);
  }
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const enginePath = join(root, 'public', 'scripts', 'extensions', 'regex', 'engine.js');
  const utilsPath = join(root, 'public', 'scripts', 'utils.js');
  const engine = readFileSync(enginePath, 'utf8').replace(/\r\n/g, '\n');
  const utils = readFileSync(utilsPath, 'utf8').replace(/\r\n/g, '\n');
  const regexFromString = declaration(utils, 'export function regexFromString', '\nexport class Stopwatch');
  const substituteFind = declaration(engine, 'export const substitute_find_regex', '\n\nfunction sanitizeRegexMacro');
  const sanitize = declaration(engine, 'function sanitizeRegexMacro', '\n\n/**\n * Parent function');
  const provider = declaration(engine, 'export class RegexProvider', '\n\n/**\n * Retrieves the list');
  const run = declaration(engine, 'export function runRegexScript', '\n\n/**\n * Filters anything');
  const filter = engine.slice(engine.indexOf('function filterString'));
  const substitute = (value: string) => value.replace(/\{\{([^{}]+)\}\}/g, (whole, key: string) => ({
    user: 'Traveler', char: 'Aster',
  })[key.trim() as 'user' | 'char'] ?? whole);
  const build = new Function('substituteParams', 'substituteParamsExtended', `
    ${regexFromString}
    ${substituteFind}
    ${sanitize}
    ${provider}
    ${run}
    ${filter}
    return runRegexScript;
  `) as (substituteParams: typeof substitute, substituteParamsExtended: typeof substitute) => OracleRegex['runRegexScript'];
  return {
    runRegexScript: build(substitute, substitute),
    provenance: {
      packageName: packageJson.name,
      version: packageJson.version,
      revision,
      source: 'public/scripts/extensions/regex/engine.js',
      declarations: ['RegexProvider', 'sanitizeRegexMacro', 'runRegexScript', 'filterString', 'regexFromString'],
    },
  };
}
