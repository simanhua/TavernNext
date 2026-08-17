import { useEffect, useState, type CSSProperties } from 'react';
import { useI18n } from '../../app/i18n.js';

export const CHAT_FORMAT_STORAGE_KEY = 'tavernnext.chat-format.v1';

export interface ChatFormatValues {
  fontSize: number;
  lineHeight: number;
  pageMargin: number;
  messageGap: number;
}

export const DEFAULT_CHAT_FORMAT: ChatFormatValues = {
  fontSize: 16,
  lineHeight: 1.72,
  pageMargin: 20,
  messageGap: 16,
};

const bounds: Record<keyof ChatFormatValues, { min: number; max: number }> = {
  fontSize: { min: 14, max: 22 },
  lineHeight: { min: 1.35, max: 2.2 },
  pageMargin: { min: 8, max: 72 },
  messageGap: { min: 8, max: 32 },
};

function boundedNumber(value: unknown, key: keyof ChatFormatValues): number {
  const fallback = DEFAULT_CHAT_FORMAT[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(bounds[key].max, Math.max(bounds[key].min, value));
}

function loadChatFormat(): ChatFormatValues {
  if (typeof window === 'undefined') return DEFAULT_CHAT_FORMAT;
  try {
    const stored = window.localStorage.getItem(CHAT_FORMAT_STORAGE_KEY);
    if (stored === null) return DEFAULT_CHAT_FORMAT;
    const parsed = JSON.parse(stored) as Partial<ChatFormatValues>;
    return {
      fontSize: boundedNumber(parsed.fontSize, 'fontSize'),
      lineHeight: boundedNumber(parsed.lineHeight, 'lineHeight'),
      pageMargin: boundedNumber(parsed.pageMargin, 'pageMargin'),
      messageGap: boundedNumber(parsed.messageGap, 'messageGap'),
    };
  } catch {
    return DEFAULT_CHAT_FORMAT;
  }
}

export function useChatFormat() {
  const [values, setValues] = useState<ChatFormatValues>(loadChatFormat);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_FORMAT_STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Formatting still works for this session when browser storage is unavailable.
    }
  }, [values]);

  return {
    values,
    setValue: (key: keyof ChatFormatValues, value: number) => {
      setValues((current) => ({ ...current, [key]: boundedNumber(value, key) }));
    },
    reset: () => setValues(DEFAULT_CHAT_FORMAT),
  };
}

export function chatFormatStyle(values: ChatFormatValues): CSSProperties {
  return {
    '--chat-font-size': `${values.fontSize}px`,
    '--chat-line-height': String(values.lineHeight),
    '--chat-page-margin': `${values.pageMargin}px`,
    '--chat-message-gap': `${values.messageGap}px`,
  } as CSSProperties;
}

interface ChatFormatSettingsProps {
  values: ChatFormatValues;
  onChange(key: keyof ChatFormatValues, value: number): void;
  onReset(): void;
}

export function ChatFormatSettings({ values, onChange, onReset }: ChatFormatSettingsProps) {
  const { t } = useI18n();
  const controls: Array<{
    key: keyof ChatFormatValues;
    label: string;
    min: number;
    max: number;
    step: number;
    display(value: number): string;
  }> = [
    { key: 'fontSize', label: t('Text size'), min: 14, max: 22, step: 1, display: (value) => `${value}px` },
    { key: 'lineHeight', label: t('Line spacing'), min: 1.35, max: 2.2, step: .01, display: (value) => value.toFixed(2) },
    { key: 'pageMargin', label: t('Page margins'), min: 8, max: 72, step: 4, display: (value) => `${value}px` },
    { key: 'messageGap', label: t('Message spacing'), min: 8, max: 32, step: 2, display: (value) => `${value}px` },
  ];

  return (
    <details className="chat-format-settings">
      <summary>{t('Format settings')}</summary>
      <div className="chat-format-controls">
        {controls.map((control) => (
          <label key={control.key} htmlFor={`chat-format-${control.key}`}>
            <span>
              <span>{control.label}</span>
              <output>{control.display(values[control.key])}</output>
            </span>
            <input
              id={`chat-format-${control.key}`}
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={values[control.key]}
              onChange={(event) => onChange(control.key, Number(event.target.value))}
            />
          </label>
        ))}
        <button type="button" onClick={onReset}>{t('Reset formatting')}</button>
      </div>
    </details>
  );
}
