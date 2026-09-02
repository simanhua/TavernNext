import type {
  SceneSpeechInputController,
  SceneSpeechInputLabels,
  SceneSpeechInputMountOptions,
} from '@tavernnext/domain';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type SpeechInputState = 'idle' | 'starting' | 'listening' | 'stopping' | 'unsupported';

const defaultLabels: SceneSpeechInputLabels = {
  start: 'Start voice input',
  stop: 'Stop voice input',
  unsupported: 'Voice input is not supported in this browser',
  permissionDenied: 'Microphone permission was denied',
  unavailable: 'Voice input is unavailable',
  noSpeech: 'No speech was detected',
};

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const target = window as SpeechRecognitionWindow;
  return target.SpeechRecognition ?? target.webkitSpeechRecognition;
}

function joinedTranscript(parts: string[], language: string): string {
  return parts.join(/^(zh|ja|ko)(-|$)/i.test(language) ? '' : ' ').trim();
}

function composeValue(prefix: string, transcript: string, suffix: string, language: string): string {
  if (transcript === '') return `${prefix}${suffix}`;
  const usesSpaces = !/^(zh|ja|ko)(-|$)/i.test(language);
  const leading = usesSpaces && prefix !== '' && !/\s$/.test(prefix) ? ' ' : '';
  const trailing = usesSpaces && suffix !== '' && !/^\s/.test(suffix) ? ' ' : '';
  return `${prefix}${leading}${transcript}${trailing}${suffix}`;
}

function setInputValue(input: HTMLTextAreaElement, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter === undefined) input.value = value;
  else setter.call(input, value);
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function errorLabel(error: string, labels: SceneSpeechInputLabels): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') return labels.permissionDenied;
  if (error === 'no-speech') return labels.noSpeech;
  return labels.unavailable;
}

export function mountSpeechInput(options: SceneSpeechInputMountOptions): SceneSpeechInputController {
  const { input, button } = options;
  const labels = { ...defaultLabels, ...options.labels };
  const language = options.language ?? document.documentElement.lang ?? navigator.language ?? 'en';
  const Recognition = recognitionConstructor();
  const original = {
    ariaLabel: button.getAttribute('aria-label'),
    ariaPressed: button.getAttribute('aria-pressed'),
    disabled: button.disabled,
    text: button.textContent,
    title: button.getAttribute('title'),
    type: button.getAttribute('type'),
  };
  let state: SpeechInputState = Recognition === undefined ? 'unsupported' : 'idle';
  let recognition: SpeechRecognitionLike | undefined;
  let prefix = '';
  let suffix = '';
  let transcript = '';
  let applyingTranscript = false;
  let lastError: string | undefined;
  let destroyed = false;

  button.type = 'button';
  button.classList.add('tn-speech-input-button');

  const render = () => {
    const active = state === 'starting' || state === 'listening' || state === 'stopping';
    button.dataset.speechInputState = state;
    button.classList.toggle('is-listening', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', state === 'unsupported' ? labels.unsupported : active ? labels.stop : labels.start);
    button.textContent = active ? '■' : '🎙';
    button.title = state === 'unsupported' ? labels.unsupported : lastError ?? (active ? labels.stop : labels.start);
    button.disabled = state === 'unsupported' || input.disabled || input.readOnly;
  };

  const finish = () => {
    if (destroyed || state === 'unsupported') return;
    state = 'idle';
    render();
  };

  if (Recognition !== undefined) {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    recognition.onstart = () => {
      if (destroyed) return;
      state = 'listening';
      render();
    };
    recognition.onresult = (event) => {
      if (destroyed) return;
      const finalParts: string[] = [];
      const interimParts: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const value = result?.[0]?.transcript?.trim();
        if (value === undefined || value === '') continue;
        (result.isFinal ? finalParts : interimParts).push(value);
      }
      transcript = joinedTranscript([...finalParts, ...interimParts], language);
      const next = composeValue(prefix, transcript, suffix, language);
      const caret = next.length - suffix.length;
      applyingTranscript = true;
      setInputValue(input, next, caret);
      applyingTranscript = false;
    };
    recognition.onerror = (event) => {
      if (destroyed) return;
      lastError = errorLabel(event.error, labels);
      finish();
    };
    recognition.onend = finish;
  }

  const click = () => {
    if (recognition === undefined || destroyed || input.disabled || input.readOnly) return;
    if (state === 'starting' || state === 'listening') {
      state = 'stopping';
      render();
      recognition.stop();
      return;
    }
    if (state !== 'idle') return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    prefix = input.value.slice(0, start);
    suffix = input.value.slice(end);
    transcript = '';
    lastError = undefined;
    state = 'starting';
    render();
    try { recognition.start(); }
    catch {
      lastError = labels.unavailable;
      finish();
    }
  };

  const inputChanged = () => {
    if (applyingTranscript || recognition === undefined) return;
    if (state === 'starting' || state === 'listening') {
      state = 'stopping';
      render();
      recognition.stop();
    }
  };

  const syncDisabled = () => {
    if ((input.disabled || input.readOnly) && recognition !== undefined
      && (state === 'starting' || state === 'listening' || state === 'stopping')) {
      recognition.abort();
      finish();
    } else render();
  };

  const observer = new MutationObserver(syncDisabled);
  observer.observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly'] });
  button.addEventListener('click', click);
  input.addEventListener('input', inputChanged);
  render();

  return {
    stop() {
      if (recognition !== undefined && (state === 'starting' || state === 'listening')) {
        state = 'stopping';
        render();
        recognition.stop();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      button.removeEventListener('click', click);
      input.removeEventListener('input', inputChanged);
      recognition?.abort();
      if (recognition !== undefined) {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
      }
      button.classList.remove('tn-speech-input-button', 'is-listening');
      delete button.dataset.speechInputState;
      button.disabled = original.disabled;
      button.textContent = original.text;
      for (const [name, value] of [
        ['aria-label', original.ariaLabel],
        ['aria-pressed', original.ariaPressed],
        ['title', original.title],
        ['type', original.type],
      ] as const) {
        if (value === null) button.removeAttribute(name);
        else button.setAttribute(name, value);
      }
    },
  };
}
