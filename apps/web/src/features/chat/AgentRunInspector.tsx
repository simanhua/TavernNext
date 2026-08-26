import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';

export function AgentRunInspector({ conversationId }: { conversationId: string | null }) {
  const runs = useQuery({
    queryKey: ['agent-runs', conversationId],
    queryFn: () => api.listAgentRuns(conversationId!),
    enabled: import.meta.env.DEV && conversationId !== null,
  });
  if (!import.meta.env.DEV || conversationId === null) return null;
  return (
    <details className="agent-run-inspector">
      <summary>Agent Run inspector</summary>
      {runs.isLoading ? <p>Loading Agent Runs…</p> : null}
      {runs.error ? <p role="alert">Unable to load Agent Runs.</p> : null}
      {(runs.data ?? []).length === 0 && !runs.isLoading ? <p>No Agent Runs yet.</p> : null}
      {(runs.data ?? []).map((run) => (
        <article key={run.id} data-agent-run-id={run.id}>
          <header><strong>{run.status}</strong><code>{run.generationId}</code></header>
          <dl>
            <div><dt>Model turns</dt><dd>{run.counts.modelTurns} / {run.limits.maxModelTurns}</dd></div>
            <div><dt>Tool calls</dt><dd>{run.counts.toolCalls} / {run.limits.maxToolCalls}</dd></div>
            <div><dt>Tokens</dt><dd>{run.usage.inputTokens} in · {run.usage.outputTokens} out</dd></div>
            <div><dt>Prompt</dt><dd>{run.promptPlan.promptTokens} · {run.promptPlan.hash.slice(0, 12)}</dd></div>
          </dl>
          {run.activities.length === 0 ? null : (
            <ol>{run.activities.map((activity) => (
              <li key={activity.sequence}>{activity.label} · {activity.status}</li>
            ))}</ol>
          )}
          {run.diagnostics.length === 0 && run.failureCode === undefined ? null : (
            <p>{[...run.diagnostics, ...(run.failureCode === undefined ? [] : [run.failureCode])].join(' · ')}</p>
          )}
        </article>
      ))}
    </details>
  );
}
