import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { api, errorCode, type Conversation, type PromptPreviewView, type PromptTimedEntryView } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { runTrustedPromptHooks } from '../extensions/TrustedPromptHooks.js';

function revisionSummary(preview: PromptPreviewView, t: (key: string, variables?: Record<string, string | number>) => string): string {
  const revisions = preview.entityRevisions;
  return `${t('Conversation')} r${revisions.conversation.revision} · ${t('Character')} r${revisions.character.revision} · ${t('Persona')} r${revisions.persona.revision} · ${t('Provider')} r${revisions.provider.revision}`;
}

function presetRevisionSummary(preview: PromptPreviewView, t: (key: string, variables?: Record<string, string | number>) => string): string {
  const presets = preview.entityRevisions.presets;
  return presets.length === 0 ? t('Presets: none') : t('Presets: {{presets}}', { presets: presets.map((preset) => `${t(preset.kind)} r${preset.revision}`).join(', ') });
}

function TimedEntryList({ label, entries }: { label: string; entries: PromptTimedEntryView[] }) {
  const { t } = useI18n();
  const translatedLabel = t(label);
  return (
    <>
      <h4>{translatedLabel}</h4>
      <ul aria-label={t('{{label}} entries', { label: translatedLabel })}>
        {entries.length === 0 ? <li>{t('None')}</li> : entries.map((entry) => (
          <li key={entry.entryKey}>
            <strong>{entry.entryKey}</strong> · {t('start {{start}} · end {{end}} · protected {{protected}}', { start: entry.start, end: entry.end, protected: t(entry.protected ? 'yes' : 'no') })}
          </li>
        ))}
      </ul>
    </>
  );
}

export function PromptPreviewDialog({ conversation, userText }: { conversation: Conversation; userText: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewView>();
  const [error, setError] = useState<string>();
  const show = async () => {
    setOpen(true);
    setPending(true);
    setPreview(undefined);
    setError(undefined);
    let candidateId: string | undefined;
    try {
      const candidate = await api.createGenerationCandidate(conversation, { mode: 'normal', userText });
      candidateId = candidate.candidateId;
      const patch = await runTrustedPromptHooks({
        kind: candidate.kind, messages: candidate.messages, text: candidate.text, stop: candidate.stop,
        spreset: candidate.spreset,
      }, true, { timeoutMs: 10_000 });
      setPreview({
        ...candidate.preview,
        ...(candidate.kind === 'chat' ? { messages: patch.messages } : { text: patch.text }),
        stop: patch.stop ?? candidate.stop,
      });
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      if (candidateId !== undefined) void api.discardGenerationCandidate(candidateId).catch(() => undefined);
      setPending(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setPreview(undefined); setError(undefined); } }}>
      <button type="button" onClick={() => void show()} disabled={pending}>{t('Preview prompt')}</button>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content prompt-preview-dialog" aria-describedby={undefined}>
          <Dialog.Title>{t('Prompt Preview')}</Dialog.Title>
          {pending ? <p role="status">{t('Compiling read-only preview…')}</p> : null}
          {error === undefined ? null : <p role="alert">{t('Unable to preview prompt: {{error}}', { error })}</p>}
          {preview === undefined ? null : (
            <div className="prompt-preview-content">
              <section>
                <h3>{t(preview.kind === 'chat' ? 'Chat prompt' : 'Text prompt')}</h3>
                {preview.kind === 'chat' ? (
                  <ol className="prompt-messages">
                    {(preview.messages ?? []).map((message, index) => <li key={`${index}:${message.role}`}><strong>{message.role}</strong><pre>{message.content}</pre></li>)}
                  </ol>
                ) : <pre aria-label={t('Compiled text prompt')}>{preview.text}</pre>}
              </section>
              <section>
                <h3>{t('Stop strings')}</h3>
                {preview.stop.length === 0 ? <p>{t('None')}</p> : (
                  <ul aria-label={t('Exact stop strings')}>
                    {preview.stop.map((stop, index) => <li key={`${index}:${stop}`}><pre><code>{JSON.stringify(stop)}</code></pre></li>)}
                  </ul>
                )}
              </section>
              <section>
                <h3>{t('Tokenizer')}</h3>
                <p>{preview.tokenizerDecision.tokenizerName} · ID {preview.tokenizerDecision.tokenizerId}</p>
                {preview.tokenizerDecision.requestedId === undefined ? null : <p>{t('Requested tokenizer ID {{id}}', { id: preview.tokenizerDecision.requestedId })}</p>}
                {preview.tokenizerDecision.fallbackFrom === undefined || preview.tokenizerDecision.fallbackTokenizerId === undefined
                  ? null
                  : <p>{t('Fallback decision: ID {{from}} → ID {{to}}', { from: preview.tokenizerDecision.fallbackFrom, to: preview.tokenizerDecision.fallbackTokenizerId })}</p>}
                {preview.tokenizerDecision.model === undefined ? null : <p>{t('Model {{model}}', { model: preview.tokenizerDecision.model })}</p>}
                {preview.tokenizerDecision.warning === undefined ? null : <p>{preview.tokenizerDecision.warning}</p>}
              </section>
              <section>
                <h3>{t('Token ledger')}</h3>
                <p>{t('{{total}} total tokens', { total: preview.totalTokens })}</p>
                <ul>{preview.tokenBreakdown.map((entry, index) => <li key={`${index}:${entry.source}`}>{t('{{source}}: {{included}} included / {{omitted}} omitted', { source: entry.source, included: entry.includedTokens, omitted: entry.omittedTokens })}{entry.reason === undefined ? '' : ` · ${entry.reason}`}</li>)}</ul>
              </section>
              <section>
                <h3>{t('Worldbook decisions')}</h3>
                <p>{t('Budget {{used}}/{{budget}}', { used: preview.worldbook.tokenUsage.used, budget: preview.worldbook.tokenUsage.budget })}{preview.worldbook.tokenUsage.overflowed ? ` · ${t('overflowed')}` : ''}</p>
                <h4>{t('Activated')}</h4>
                <ul>{preview.worldbook.activated.map((entry) => <li key={entry.entryKey}><strong>{entry.bookName ?? entry.entryKey}{entry.sourceUid === undefined ? '' : ` · UID ${entry.sourceUid}`}</strong>{entry.content === undefined ? null : <pre>{entry.content}</pre>}</li>)}</ul>
                <h4>{t('Excluded')}</h4>
                <ul>{preview.worldbook.excluded.map((entry) => <li key={entry.entryKey}>{entry.entryKey} · {entry.reason}</li>)}</ul>
                {preview.previousTimedState === undefined ? null : (
                  <>
                    <p>{t('Previous timed state · message {{message}}', { message: preview.previousTimedState.messageIndex ?? t('none') })}</p>
                    <p>{t('Previous: {{sticky}} sticky · {{cooldown}} cooldown', { sticky: preview.previousTimedState.stickyCount, cooldown: preview.previousTimedState.cooldownCount })}</p>
                    <TimedEntryList label="Previous sticky" entries={preview.previousTimedState.sticky} />
                    <TimedEntryList label="Previous cooldown" entries={preview.previousTimedState.cooldown} />
                  </>
                )}
                <p>{t('Next timed state · message {{message}}', { message: preview.worldbook.timedState.messageIndex ?? t('none') })}</p>
                <p>{t('Next: {{sticky}} sticky · {{cooldown}} cooldown', { sticky: preview.worldbook.timedState.stickyCount, cooldown: preview.worldbook.timedState.cooldownCount })}</p>
                <TimedEntryList label="Next sticky" entries={preview.worldbook.timedState.sticky} />
                <TimedEntryList label="Next cooldown" entries={preview.worldbook.timedState.cooldown} />
              </section>
              <section>
                <h3>{t('Warnings')}</h3>
                {[...preview.warnings, ...preview.worldbook.warnings].length === 0 ? <p>{t('None')}</p> : (
                  <ul>{[...preview.warnings, ...preview.worldbook.warnings].map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}</ul>
                )}
              </section>
              <section>
                <h3>{t('Revisions')}</h3>
                <p>{revisionSummary(preview, t)}</p>
                <p>{presetRevisionSummary(preview, t)}</p>
                <p>{preview.entityRevisions.globalWorldbookCount} global Worldbooks · {preview.entityRevisions.worldbookCount} linked Worldbooks · {preview.entityRevisions.messageCount} messages</p>
              </section>
            </div>
          )}
          <Dialog.Close asChild><button type="button">{t('Close Prompt Preview')}</button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
