interface ComposerProps {
  draft: string;
  disabled: boolean;
  canStop: boolean;
  stopping: boolean;
  onDraftChange(value: string): void;
  onSend(): void;
  onStop(): void;
}

import { useI18n } from '../../app/i18n.js';

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const { draft, disabled, canStop, stopping, onDraftChange, onSend, onStop } = props;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && draft.trim() !== '') onSend();
      }}
    >
      <label htmlFor="chat-draft">{t('Message')}</label>
      <textarea
        id="chat-draft"
        value={draft}
        disabled={disabled}
        rows={4}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-actions">
        <button type="submit" disabled={disabled || draft.trim() === ''}>{t('Send')}</button>
        {canStop ? <button type="button" disabled={stopping} onClick={onStop}>{t('Stop')}</button> : null}
      </div>
    </form>
  );
}
