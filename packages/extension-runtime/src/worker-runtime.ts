import {
  regexSkipReason,
  type OwnedRegexRunResult,
  type OwnedRegexTraceEntry,
  type RegexRunContext,
  type RegexRunResult,
  type RegexTraceEntry,
  type TavernRegex,
} from './regex.js';

export interface RegexWorkerRequest { raw: string; script: TavernRegex; context: RegexRunContext }
export interface RegexWorkerReply { ok: boolean; result?: RegexRunResult; error?: string }
export interface RegexWorker { result: Promise<RegexRunResult>; terminate(): void | Promise<void> }
export type RegexWorkerFactory = (request: RegexWorkerRequest) => RegexWorker;
export interface RegexWorkerLimits { perRuleMs: number; aggregateMs: number; aggregateDeadline?: number }

export const DEFAULT_REGEX_WORKER_LIMITS: RegexWorkerLimits = Object.freeze({ perRuleMs: 100, aggregateMs: 1_000 });

export function regexWorkerLimitsForProjection(
  limits: RegexWorkerLimits = DEFAULT_REGEX_WORKER_LIMITS,
): RegexWorkerLimits {
  return { ...limits, aggregateDeadline: Date.now() + Math.max(0, limits.aggregateMs) };
}

function timeoutAfter(ms: number, kind: 'timeout' | 'aggregate_timeout') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(kind)), Math.max(0, ms)); }),
    cancel: () => { if (timer !== undefined) clearTimeout(timer); },
  };
}

/** Executes every applicable regular expression behind a caller-supplied, terminable Worker boundary. */
export async function runOwnedRegexProjectionInWorker(
  raw: string,
  scripts: { preset: readonly TavernRegex[]; character: readonly TavernRegex[] },
  context: RegexRunContext,
  createWorker: RegexWorkerFactory,
  limits: RegexWorkerLimits,
): Promise<OwnedRegexRunResult> {
  let value = raw;
  const trace: OwnedRegexTraceEntry[] = [];
  const queued = (['preset', 'character'] as const).flatMap((owner) => scripts[owner].map((script) => ({ owner, script })));
  const aggregateDeadline = limits.aggregateDeadline ?? Date.now() + Math.max(0, limits.aggregateMs);
  for (let index = 0; index < queued.length; index += 1) {
    const current = queued[index]!;
    const aggregateRemaining = aggregateDeadline - Date.now();
    if (aggregateRemaining <= 0) {
      for (const pending of queued.slice(index)) trace.push({
        owner: pending.owner, scriptId: pending.script.id, scriptName: pending.script.scriptName,
        applied: false, reason: 'aggregate_timeout', before: value, after: value,
      });
      break;
    }
    const before = value;
    const reason = regexSkipReason(current.script, before, context);
    if (reason !== undefined) {
      trace.push({ owner: current.owner, scriptId: current.script.id, scriptName: current.script.scriptName, applied: false, reason, before, after: before });
      continue;
    }
    let worker: RegexWorker | undefined;
    const perRule = timeoutAfter(limits.perRuleMs, 'timeout');
    const aggregate = timeoutAfter(aggregateRemaining, 'aggregate_timeout');
    try {
      worker = createWorker({ raw: before, script: current.script, context });
      const result = await Promise.race([worker.result, perRule.promise, aggregate.promise]);
      value = result.value;
      trace.push(...result.trace.map((entry) => ({ ...entry, owner: current.owner })));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      const failure: RegexTraceEntry['reason'] = message === 'aggregate_timeout' ? 'aggregate_timeout' : message === 'timeout' ? 'timeout' : 'error';
      trace.push({ owner: current.owner, scriptId: current.script.id, scriptName: current.script.scriptName, applied: false, reason: failure, before, after: before });
      if (failure === 'aggregate_timeout') {
        for (const pending of queued.slice(index + 1)) trace.push({
          owner: pending.owner, scriptId: pending.script.id, scriptName: pending.script.scriptName,
          applied: false, reason: failure, before: value, after: value,
        });
        break;
      }
    } finally {
      perRule.cancel(); aggregate.cancel(); await worker?.terminate();
    }
  }
  return { value, trace };
}

export async function runOwnedRegexModeProjectionInWorker(
  raw: string,
  scripts: { preset: readonly TavernRegex[]; character: readonly TavernRegex[] },
  context: Omit<RegexRunContext, 'isMarkdown' | 'isPrompt'>,
  mode: 'prompt' | 'display',
  createWorker: RegexWorkerFactory,
  limits: RegexWorkerLimits = DEFAULT_REGEX_WORKER_LIMITS,
): Promise<OwnedRegexRunResult> {
  const common = await runOwnedRegexProjectionInWorker(raw, scripts, { ...context, isMarkdown: false, isPrompt: false }, createWorker, limits);
  const projected = await runOwnedRegexProjectionInWorker(common.value, scripts, {
    ...context, isMarkdown: mode === 'display', isPrompt: mode === 'prompt',
  }, createWorker, limits);
  return { value: projected.value, trace: [...common.trace, ...projected.trace] };
}
