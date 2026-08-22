import { z } from 'zod';

export const REGEX_PLACEMENT = Object.freeze({
  MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6,
} as const);
export type RegexPlacement = typeof REGEX_PLACEMENT[keyof typeof REGEX_PLACEMENT];

export const TavernRegexSchema = z.object({
  id: z.string().min(1), scriptName: z.string().default(''), findRegex: z.string(), replaceString: z.string().default(''),
  trimStrings: z.array(z.string()).default([]), placement: z.array(z.number().int()).default([]),
  disabled: z.boolean().default(false), markdownOnly: z.boolean().default(false), promptOnly: z.boolean().default(false),
  runOnEdit: z.boolean().default(false), substituteRegex: z.number().int().min(0).max(2).default(0),
  minDepth: z.number().int().nullable().optional(), maxDepth: z.number().int().nullable().optional(),
}).passthrough();
export type TavernRegex = z.infer<typeof TavernRegexSchema>;

export interface RegexMacroContext {
  values?: Readonly<Record<string, string>>;
  characterName?: string;
}
export interface RegexRunContext extends RegexMacroContext {
  placement: RegexPlacement;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
  depth?: number;
}
export interface RegexTraceEntry {
  scriptId: string;
  scriptName: string;
  applied: boolean;
  reason?: 'disabled' | 'mode' | 'edit' | 'depth' | 'placement' | 'invalid' | 'empty'
    | 'timeout' | 'aggregate_timeout' | 'error';
  before: string;
  after: string;
}
export interface RegexRunResult { value: string; trace: RegexTraceEntry[] }
export interface OwnedRegexTraceEntry extends RegexTraceEntry { owner: 'preset' | 'character' }
export interface OwnedRegexRunResult { value: string; trace: OwnedRegexTraceEntry[] }
export interface RegexViews {
  raw: string;
  prompt: OwnedRegexRunResult;
  display: OwnedRegexRunResult;
}

const regexCache = new Map<string, RegExp>();

function regexLiteral(input: string): { source: string; flags: string } | undefined {
  if (!input.startsWith('/')) return undefined;
  for (let index = input.length - 1; index > 0; index -= 1) {
    if (input[index] !== '/') continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && input[cursor] === '\\'; cursor -= 1) escapes += 1;
    if (escapes % 2 !== 0) continue;
    const flags = input.slice(index + 1);
    if (!/^(?!.*?(.).*?\1)[dgimsuvy]*$/.test(flags)) return undefined;
    return { source: input.slice(1, index), flags };
  }
  return undefined;
}

function regexFromString(input: string): RegExp | undefined {
  const cached = regexCache.get(input);
  if (cached !== undefined) {
    regexCache.delete(input); regexCache.set(input, cached); cached.lastIndex = 0; return cached;
  }
  try {
    const literal = regexLiteral(input);
    const regex = literal === undefined ? new RegExp(input) : new RegExp(literal.source, literal.flags);
    if (regexCache.size >= 1_000) regexCache.delete(regexCache.keys().next().value!);
    regexCache.set(input, regex);
    return regex;
  } catch { return undefined; }
}

function sanitizeMacroValue(value: string): string {
  return value.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (character) => {
    const named: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
    return named[character] ?? `\\${character}`;
  });
}

function substitute(value: string, context: RegexMacroContext, escape: boolean): string {
  return value.replace(/\{\{([^{}]+)\}\}/g, (whole, key: string) => {
    const replacement = context.values?.[key.trim()]
      ?? (key.trim() === 'char' ? context.characterName : undefined);
    if (replacement === undefined) return whole;
    return escape ? sanitizeMacroValue(replacement) : replacement;
  });
}

function matchesMode(script: TavernRegex, context: RegexRunContext): boolean {
  return (script.markdownOnly && context.isMarkdown === true)
    || (script.promptOnly && context.isPrompt === true)
    || (!script.markdownOnly && !script.promptOnly && context.isMarkdown !== true && context.isPrompt !== true);
}

function depthAllowed(script: TavernRegex, depth: number | undefined): boolean {
  if (depth === undefined) return true;
  if (script.minDepth !== undefined && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) return false;
  if (script.maxDepth !== undefined && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) return false;
  return true;
}

export function regexSkipReason(
  script: TavernRegex,
  value: string,
  context: RegexRunContext,
): RegexTraceEntry['reason'] | undefined {
  if (script.disabled) return 'disabled';
  if (value === '' || script.findRegex === '') return 'empty';
  if (!matchesMode(script, context)) return 'mode';
  if (context.isEdit === true && !script.runOnEdit) return 'edit';
  if (!depthAllowed(script, context.depth)) return 'depth';
  if (!script.placement.includes(context.placement)) return 'placement';
  return undefined;
}

function execute(script: TavernRegex, raw: string, context: RegexRunContext): string | undefined {
  const literal = regexLiteral(script.findRegex);
  const substituted = (escape: boolean) => literal === undefined
    ? substitute(script.findRegex, context, escape)
    : `/${substitute(literal.source, context, escape)}/${literal.flags}`;
  const findSource = script.substituteRegex === 1 ? substituted(false)
    : script.substituteRegex === 2 ? substituted(true) : script.findRegex;
  const regex = regexFromString(findSource);
  if (regex === undefined) return undefined;
  return raw.replace(regex, (...args: unknown[]) => {
    const groups = typeof args.at(-1) === 'object' && args.at(-1) !== null ? args.at(-1) as Record<string, unknown> : undefined;
    const replacement = script.replaceString.replace(/\{\{match\}\}/gi, '$0').replace(
      /\$(\d+)|\$<([^>]+)>/g,
      (_whole, number: string | undefined, name: string | undefined) => {
        const candidate = number !== undefined ? args[Number(number)] : name === undefined ? '' : groups?.[name];
        if (candidate === undefined || candidate === null || candidate === '') return '';
        return script.trimStrings.reduce((current, trim) => current.replaceAll(substitute(trim, context, false), ''), String(candidate));
      },
    );
    return substitute(replacement, context, false);
  });
}

export function runRegexScripts(raw: string, scripts: readonly TavernRegex[], context: RegexRunContext): RegexRunResult {
  let value = typeof raw === 'string' ? raw : '';
  const trace: RegexTraceEntry[] = [];
  for (const script of scripts) {
    const before = value;
    const reason = regexSkipReason(script, value, context);
    if (reason !== undefined) {
      trace.push({ scriptId: script.id, scriptName: script.scriptName, applied: false, reason, before, after: before });
      continue;
    }
    const next = execute(script, value, context);
    if (next === undefined) {
      trace.push({ scriptId: script.id, scriptName: script.scriptName, applied: false, reason: 'invalid', before, after: before });
      continue;
    }
    value = next;
    trace.push({ scriptId: script.id, scriptName: script.scriptName, applied: true, before, after: value });
  }
  return { value, trace };
}

export function runOwnedRegexProjection(
  raw: string,
  scripts: { preset: readonly TavernRegex[]; character: readonly TavernRegex[] },
  context: RegexRunContext,
): OwnedRegexRunResult {
  let value = raw;
  const trace: OwnedRegexTraceEntry[] = [];
  for (const owner of ['preset', 'character'] as const) {
    const projected = runRegexScripts(value, scripts[owner], context);
    value = projected.value;
    trace.push(...projected.trace.map((entry) => ({ ...entry, owner })));
  }
  return { value, trace };
}

export function projectRegexViews(
  raw: string,
  scripts: { preset: readonly TavernRegex[]; character: readonly TavernRegex[] },
  context: Omit<RegexRunContext, 'isMarkdown' | 'isPrompt'>,
): RegexViews {
  const common = runOwnedRegexProjection(raw, scripts, { ...context, isMarkdown: false, isPrompt: false });
  const projectMode = (mode: { isMarkdown: boolean; isPrompt: boolean }): OwnedRegexRunResult => {
    const modeProjection = runOwnedRegexProjection(common.value, scripts, { ...context, ...mode });
    return { value: modeProjection.value, trace: [...common.trace, ...modeProjection.trace] };
  };
  return {
    raw,
    prompt: projectMode({ isMarkdown: false, isPrompt: true }),
    display: projectMode({ isMarkdown: true, isPrompt: false }),
  };
}

export function clearRegexCache(): void { regexCache.clear(); }
