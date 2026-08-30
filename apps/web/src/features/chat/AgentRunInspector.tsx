import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { RuntimePanelCloseButton } from '../shared/RuntimePanelCloseButton.js';
import { RuntimePanelIcon } from '../shared/RuntimePanelIcon.js';

export function AgentRunInspector({ conversationId }: { conversationId: string | null }) {
  const { t } = useI18n();
  const runs = useQuery({
    queryKey: ['agent-runs', conversationId],
    queryFn: () => api.listAgentRuns(conversationId!),
    enabled: import.meta.env.DEV && conversationId !== null,
  });
  if (!import.meta.env.DEV || conversationId === null) return null;
  return (
    <details className="agent-run-inspector">
      <summary><RuntimePanelIcon kind="inspector" /><span className="runtime-panel-title">{t('Agent Run inspector')}</span></summary>
      <RuntimePanelCloseButton label={t('Close Agent Run inspector')} text={t('Close')} />
      <button type="button" onClick={() => { void runs.refetch(); }} disabled={runs.isFetching}>
        {runs.isFetching ? t('Refreshing Agent Runs…') : t('Refresh Agent Runs')}
      </button>
      {runs.isLoading ? <p>{t('Loading Agent Runs…')}</p> : null}
      {runs.error ? <p role="alert">{t('Unable to load Agent Runs.')}</p> : null}
      {(runs.data ?? []).length === 0 && !runs.isLoading ? <p>{t('No Agent Runs yet.')}</p> : null}
      {(runs.data ?? []).map((run) => (
        <article key={run.id} data-agent-run-id={run.id}>
          <header><strong>{run.status}</strong><code>{run.generationId}</code></header>
          <dl>
            <div><dt>{t('Model turns')}</dt><dd>{run.counts.modelTurns} / {run.limits.maxModelTurns}</dd></div>
            <div><dt>{t('Tool calls')}</dt><dd>{run.counts.toolCalls} / {run.limits.maxToolCalls}</dd></div>
            <div><dt>{t('Tokens')}</dt><dd>{run.usage.inputTokens} {t('in')} · {run.usage.outputTokens} {t('out')}</dd></div>
            <div><dt>{t('Prompt')}</dt><dd>{run.promptPlan.promptTokens} · {run.promptPlan.hash.slice(0, 12)}</dd></div>
          </dl>
          {run.activities.length === 0 ? null : (
            <ol>{run.activities.map((activity) => (
              <li key={activity.sequence}>{activity.label} · {activity.status}</li>
            ))}</ol>
          )}
          {run.diagnostics.length === 0 && run.failureCode === undefined ? null : (
            <p>{[...run.diagnostics, ...(run.failureCode === undefined ? [] : [run.failureCode])].join(' · ')}</p>
          )}
          <details>
            <summary>{t('Detailed request and tool trace ({{count}})', { count: run.trace.length })}</summary>
            {run.trace.length === 0 ? <p>{t('No detailed trace was captured for this run.')}</p> : (
              <ol>{run.trace.map((entry) => (
                <li key={entry.sequence}>
                  <strong>{t('Turn {{turn}}', { turn: entry.turn })} · {t(entry.type)}{entry.name === undefined ? '' : ` · ${entry.name}`}</strong>
                  <time dateTime={entry.at}>{entry.at}</time>
                  <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
                </li>
              ))}</ol>
            )}
          </details>
        </article>
      ))}
    </details>
  );
}
