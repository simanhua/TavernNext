// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/i18n.js';
import { Composer } from './Composer.js';

class FakeRecognition {
  static current: FakeRecognition;
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onresult: ((event: Event & { results: Array<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => void) | null = null;
  onerror = null;
  onend = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() { FakeRecognition.current = this; }
}

beforeEach(() => {
  window.localStorage.setItem('tavernnext.language', 'en');
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
});

it('connects platform speech input to the controlled chat draft', () => {
  const onDraftChange = vi.fn();
  render(<I18nProvider><Composer
    draft=""
    disabled={false}
    canStop={false}
    stopping={false}
    onDraftChange={onDraftChange}
    onSend={vi.fn()}
    onStop={vi.fn()}
  /></I18nProvider>);

  screen.getByRole('button', { name: 'Start voice input' }).click();
  FakeRecognition.current.onstart?.();
  FakeRecognition.current.onresult?.(Object.assign(new Event('result'), {
    results: [{ isFinal: true, 0: { transcript: 'head north' }, length: 1 }],
  }));

  expect(onDraftChange).toHaveBeenCalledWith('head north');
});
