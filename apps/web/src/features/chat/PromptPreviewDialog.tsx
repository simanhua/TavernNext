import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { api, errorCode, type Conversation, type PromptPreviewView, type PromptTimedEntryView } from '../../api/client.js';

function revisionSummary(preview: PromptPreviewView): string {
  const revisions = preview.entityRevisions;
  return `Conversation r${revisions.conversation.revision} · Character r${revisions.character.revision} · Persona r${revisions.persona.revision} · Provider r${revisions.provider.revision}`;
}

function presetRevisionSummary(preview: PromptPreviewView): string {
  const presets = preview.entityRevisions.presets;
  return presets.length === 0 ? 'Presets: none' : `Presets: ${presets.map((preset) => `${preset.kind} r${preset.revision}`).join(', ')}`;
}

function TimedEntryList({ label, entries }: { label: string; entries: PromptTimedEntryView[] }) {
  return (
    <>
      <h4>{label}</h4>
      <ul aria-label={`${label} entries`}>
        {entries.length === 0 ? <li>None</li> : entries.map((entry) => (
          <li key={entry.entryKey}>
            <strong>{entry.entryKey}</strong> · start {entry.start} · end {entry.end} · protected {entry.protected ? 'yes' : 'no'}
          </li>
        ))}
      </ul>
    </>
  );
}

export function PromptPreviewDialog({ conversation, userText }: { conversation: Conversation; userText: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<PromptPreviewView>();
  const [error, setError] = useState<string>();
  const show = async () => {
    setOpen(true);
    setPending(true);
    setPreview(undefined);
    setError(undefined);
    try {
      setPreview(await api.previewPrompt(conversation, userText));
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setPreview(undefined); setError(undefined); } }}>
      <button type="button" onClick={() => void show()} disabled={pending}>Preview prompt</button>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content prompt-preview-dialog" aria-describedby={undefined}>
          <Dialog.Title>Prompt Preview</Dialog.Title>
          {pending ? <p role="status">Compiling read-only preview…</p> : null}
          {error === undefined ? null : <p role="alert">Unable to preview prompt: {error}</p>}
          {preview === undefined ? null : (
            <div className="prompt-preview-content">
              <section>
                <h3>{preview.kind === 'chat' ? 'Chat prompt' : 'Text prompt'}</h3>
                {preview.kind === 'chat' ? (
                  <ol className="prompt-messages">
                    {(preview.messages ?? []).map((message, index) => <li key={`${index}:${message.role}`}><strong>{message.role}</strong><pre>{message.content}</pre></li>)}
                  </ol>
                ) : <pre aria-label="Compiled text prompt">{preview.text}</pre>}
              </section>
              <section>
                <h3>Stop strings</h3>
                {preview.stop.length === 0 ? <p>None</p> : (
                  <ul aria-label="Exact stop strings">
                    {preview.stop.map((stop, index) => <li key={`${index}:${stop}`}><pre><code>{JSON.stringify(stop)}</code></pre></li>)}
                  </ul>
                )}
              </section>
              <section>
                <h3>Tokenizer</h3>
                <p>{preview.tokenizerDecision.tokenizerName} · ID {preview.tokenizerDecision.tokenizerId}</p>
                {preview.tokenizerDecision.requestedId === undefined ? null : <p>Requested tokenizer ID {preview.tokenizerDecision.requestedId}</p>}
                {preview.tokenizerDecision.fallbackFrom === undefined || preview.tokenizerDecision.fallbackTokenizerId === undefined
                  ? null
                  : <p>Fallback decision: ID {preview.tokenizerDecision.fallbackFrom} → ID {preview.tokenizerDecision.fallbackTokenizerId}</p>}
                {preview.tokenizerDecision.model === undefined ? null : <p>Model {preview.tokenizerDecision.model}</p>}
                {preview.tokenizerDecision.warning === undefined ? null : <p>{preview.tokenizerDecision.warning}</p>}
              </section>
              <section>
                <h3>Token ledger</h3>
                <p>{preview.totalTokens} total tokens</p>
                <ul>{preview.tokenBreakdown.map((entry, index) => <li key={`${index}:${entry.source}`}>{entry.source}: {entry.includedTokens} included / {entry.omittedTokens} omitted{entry.reason === undefined ? '' : ` · ${entry.reason}`}</li>)}</ul>
              </section>
              <section>
                <h3>Worldbook decisions</h3>
                <p>Budget {preview.worldbook.tokenUsage.used}/{preview.worldbook.tokenUsage.budget}{preview.worldbook.tokenUsage.overflowed ? ' · overflowed' : ''}</p>
                <h4>Activated</h4>
                <ul>{preview.worldbook.activated.map((entry) => <li key={entry.entryKey}><strong>{entry.bookName ?? entry.entryKey}{entry.sourceUid === undefined ? '' : ` · UID ${entry.sourceUid}`}</strong>{entry.content === undefined ? null : <pre>{entry.content}</pre>}</li>)}</ul>
                <h4>Excluded</h4>
                <ul>{preview.worldbook.excluded.map((entry) => <li key={entry.entryKey}>{entry.entryKey} · {entry.reason}</li>)}</ul>
                {preview.previousTimedState === undefined ? null : (
                  <>
                    <p>Previous timed state · message {preview.previousTimedState.messageIndex ?? 'none'}</p>
                    <p>Previous: {preview.previousTimedState.stickyCount} sticky · {preview.previousTimedState.cooldownCount} cooldown</p>
                    <TimedEntryList label="Previous sticky" entries={preview.previousTimedState.sticky} />
                    <TimedEntryList label="Previous cooldown" entries={preview.previousTimedState.cooldown} />
                  </>
                )}
                <p>Next timed state · message {preview.worldbook.timedState.messageIndex ?? 'none'}</p>
                <p>Next: {preview.worldbook.timedState.stickyCount} sticky · {preview.worldbook.timedState.cooldownCount} cooldown</p>
                <TimedEntryList label="Next sticky" entries={preview.worldbook.timedState.sticky} />
                <TimedEntryList label="Next cooldown" entries={preview.worldbook.timedState.cooldown} />
              </section>
              <section>
                <h3>Warnings</h3>
                {[...preview.warnings, ...preview.worldbook.warnings].length === 0 ? <p>None</p> : (
                  <ul>{[...preview.warnings, ...preview.worldbook.warnings].map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}</ul>
                )}
              </section>
              <section>
                <h3>Revisions</h3>
                <p>{revisionSummary(preview)}</p>
                <p>{presetRevisionSummary(preview)}</p>
                <p>{preview.entityRevisions.globalWorldbookCount} global Worldbooks · {preview.entityRevisions.worldbookCount} linked Worldbooks · {preview.entityRevisions.messageCount} messages</p>
              </section>
            </div>
          )}
          <Dialog.Close asChild><button type="button">Close Prompt Preview</button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
