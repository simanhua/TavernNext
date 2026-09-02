// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSpeechInput } from './speech-input.js';

interface FakeResult {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onresult: ((event: Event & { results: FakeResult[] }) => void) | null = null;
  onerror: ((event: Event & { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() { FakeRecognition.instances.push(this); }
}

function result(transcript: string, isFinal: boolean): FakeResult {
  return { 0: { transcript }, isFinal, length: 1 };
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.lang = 'zh-CN';
  FakeRecognition.instances = [];
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeRecognition });
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
});

describe('platform speech input', () => {
  it('writes final and interim speech at the current selection without sending', () => {
    const input = document.createElement('textarea');
    const button = document.createElement('button');
    input.value = '我选择。';
    input.setSelectionRange(3, 3);
    document.body.append(input, button);
    const changed = vi.fn();
    input.addEventListener('input', changed);
    const controller = mountSpeechInput({ input, button, language: 'zh-CN' });

    button.click();
    const recognition = FakeRecognition.instances[0]!;
    expect(recognition.start).toHaveBeenCalledOnce();
    recognition.onstart?.();
    recognition.onresult?.(Object.assign(new Event('result'), {
      results: [result('向北', true), result('前进', false)],
    }));

    expect(input.value).toBe('我选择向北前进。');
    expect(changed).toHaveBeenCalledOnce();
    expect(button.dataset.speechInputState).toBe('listening');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click();
    expect(recognition.stop).toHaveBeenCalledOnce();
    controller.destroy();
    expect(recognition.abort).toHaveBeenCalledOnce();
  });

  it('uses the webkit adapter and reports microphone permission errors', () => {
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition });
    const input = document.createElement('textarea');
    const button = document.createElement('button');
    document.body.append(input, button);
    mountSpeechInput({
      input,
      button,
      labels: { permissionDenied: '请允许麦克风权限' },
    });

    button.click();
    const recognition = FakeRecognition.instances[0]!;
    recognition.onerror?.(Object.assign(new Event('error'), { error: 'not-allowed' }));
    expect(button.title).toBe('请允许麦克风权限');
    expect(button.dataset.speechInputState).toBe('idle');
  });

  it('degrades to an accessible disabled control when recognition is unsupported', () => {
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    const input = document.createElement('textarea');
    const button = document.createElement('button');
    document.body.append(input, button);

    mountSpeechInput({ input, button });

    expect(button.disabled).toBe(true);
    expect(button.dataset.speechInputState).toBe('unsupported');
    expect(button.title).toBe('Voice input is not supported in this browser');
  });
});
