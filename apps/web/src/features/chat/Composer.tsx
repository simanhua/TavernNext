interface ComposerProps {
  draft: string;
  disabled: boolean;
  canStop: boolean;
  stopping: boolean;
  onDraftChange(value: string): void;
  onSend(): void;
  onStop(): void;
}

import { useEffect, useRef } from 'react';
import { useI18n } from '../../app/i18n.js';
import { mountSpeechInput } from '../input/speech-input.js';

export function Composer(props: ComposerProps) {
  const { language, t } = useI18n();
  const { draft, disabled, canStop, stopping, onDraftChange, onSend, onStop } = props;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const speechButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (inputRef.current === null || speechButtonRef.current === null) return;
    return mountSpeechInput({
      input: inputRef.current,
      button: speechButtonRef.current,
      language,
      labels: {
        start: t('Start voice input'),
        stop: t('Stop voice input'),
        unsupported: t('Voice input is not supported in this browser'),
        permissionDenied: t('Microphone permission was denied'),
        unavailable: t('Voice input is unavailable'),
        noSpeech: t('No speech was detected'),
      },
    }).destroy;
  }, [language, t]);
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
        ref={inputRef}
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
        <button ref={speechButtonRef} type="button" className="composer-speech-input" />
        <button type="submit" disabled={disabled || draft.trim() === ''}>{t('Send')}</button>
        {canStop ? <button type="button" disabled={stopping} onClick={onStop}>{t('Stop')}</button> : null}
      </div>
    </form>
  );
}
