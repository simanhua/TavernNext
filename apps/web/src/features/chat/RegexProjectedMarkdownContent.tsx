import { useEffect, useMemo, useState } from 'react';
import {
  REGEX_PLACEMENT,
  runOwnedRegexModeProjectionInWorker,
  type RegexWorkerLimits,
  type RegexWorkerFactory,
} from '@tavernnext/extension-runtime';
import { createBrowserRegexWorker } from '@tavernnext/extension-runtime/browser';
import { MarkdownContent } from './MarkdownContent.js';
import type { ActiveRegexScripts } from './useActiveRegexScripts.js';

export function RegexProjectedMarkdownContent({
  content,
  role,
  depth,
  scripts,
  createWorker = createBrowserRegexWorker,
  limits,
  macroValues,
  isEdit = false,
}: {
  content: string;
  role: 'user' | 'assistant' | 'system';
  depth: number;
  scripts: ActiveRegexScripts;
  createWorker?: RegexWorkerFactory;
  limits?: RegexWorkerLimits;
  macroValues?: Readonly<Record<string, string>>;
  isEdit?: boolean;
}) {
  const scriptsKey = useMemo(() => JSON.stringify(scripts), [scripts]);
  const macroKey = useMemo(() => JSON.stringify(macroValues ?? {}), [macroValues]);
  const projectionKey = `${role}:${depth}:${isEdit}:${content}:${scriptsKey}:${macroKey}`;
  const passthrough = role === 'system' || (scripts.preset.length === 0 && scripts.character.length === 0);
  const [projection, setProjection] = useState({ key: '', value: '' });
  const [failures, setFailures] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    if (passthrough) {
      setProjection({ key: projectionKey, value: content });
      setFailures([]);
      return () => { active = false; };
    }
    const context = {
      placement: role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
      depth,
      values: macroValues,
      isEdit,
    } as const;
    void (async () => {
      const display = await runOwnedRegexModeProjectionInWorker(
        content, scripts, context, 'display', createWorker, limits,
      );
      if (active) {
        setProjection({ key: projectionKey, value: display.value });
        setFailures(display.trace.filter((entry) => (
          entry.reason === 'timeout' || entry.reason === 'aggregate_timeout' || entry.reason === 'error'
        )).map((entry) => `${entry.owner}:${entry.scriptName || entry.scriptId} — ${entry.reason}`));
      }
    })().catch(() => { if (active) { setProjection({ key: projectionKey, value: content }); setFailures(['display projection — error']); } });
    return () => { active = false; };
  }, [content, createWorker, depth, isEdit, limits, macroKey, passthrough, projectionKey, role, scriptsKey]);

  const projected = passthrough ? content : projection.key === projectionKey ? projection.value : '';

  return <>
    <MarkdownContent content={projected} />
    {failures.length === 0 ? null : (
      <details className="message-regex-trace">
        <summary>Regex projection trace</summary>
        <ul>{failures.map((failure, index) => <li key={`${index}:${failure}`}>{failure}</li>)}</ul>
      </details>
    )}
  </>;
}
