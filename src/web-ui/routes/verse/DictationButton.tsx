/**
 * routes/verse/DictationButton.tsx — push-to-talk for the composer via the
 * Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). Interim
 * results stream into the textarea through `onInterim`; final segments are
 * committed through `onFinal`. Escape stops listening. When the browser has
 * no recognizer (Firefox, Tauri/WKWebView today) the button is disabled and
 * a tooltip points at Wispr Flow / Superwhisper — system-level dictation
 * types straight into the textarea, so nothing is lost.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import styles from './Composer.module.css';

export const DICTATION_FALLBACK_HINT = 'Use Wispr Flow / Superwhisper — system dictation works in this box';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

/** Resolve the recognizer constructor, if this runtime ships one. */
export function getSpeechRecognition(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface DictationButtonProps {
  disabled?: boolean;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
}

export function DictationButton({ disabled = false, onInterim, onFinal, onListeningChange }: DictationButtonProps) {
  const Recognizer = getSpeechRecognition();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognizer = useRef<RecognitionLike | null>(null);
  const hintId = useId();
  const callbacks = useRef({ onInterim, onFinal, onListeningChange });
  callbacks.current = { onInterim, onFinal, onListeningChange };

  const stop = useCallback(() => {
    const active = recognizer.current;
    recognizer.current = null;
    if (active) {
      active.onresult = null;
      active.onend = null;
      active.onerror = null;
      try {
        active.stop();
      } catch {
        /* already stopped */
      }
    }
    setListening(false);
    callbacks.current.onInterim('');
    callbacks.current.onListeningChange?.(false);
  }, []);

  const start = useCallback(() => {
    if (!Recognizer || recognizer.current) return;
    let instance: RecognitionLike;
    try {
      instance = new Recognizer();
    } catch {
      setError('Dictation could not start in this browser.');
      return;
    }
    instance.lang = navigator.language || 'en-US';
    instance.continuous = true;
    instance.interimResults = true;
    instance.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (finalText) callbacks.current.onFinal(finalText.trim());
      callbacks.current.onInterim(interim);
    };
    instance.onerror = (event) => {
      const code = event.error ?? 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') setError('Microphone access was denied.');
      else if (code !== 'aborted' && code !== 'no-speech') setError(`Dictation stopped (${code}).`);
      stop();
    };
    instance.onend = () => {
      if (recognizer.current === instance) stop();
    };
    recognizer.current = instance;
    setError(null);
    try {
      instance.start();
    } catch {
      recognizer.current = null;
      setError('Dictation could not start in this browser.');
      return;
    }
    setListening(true);
    callbacks.current.onListeningChange?.(true);
  }, [Recognizer, stop]);

  // Escape stops dictation from anywhere on the page; unmount stops it too.
  useEffect(() => {
    if (!listening) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [listening, stop]);
  useEffect(() => () => {
    const active = recognizer.current;
    recognizer.current = null;
    try {
      active?.abort();
    } catch {
      /* ignore */
    }
  }, []);

  if (!Recognizer) {
    return (
      <span className={styles.dictationWrap}>
        <button type="button" className={styles.dictation} disabled aria-disabled="true" aria-describedby={hintId}
          title={DICTATION_FALLBACK_HINT}>
          <MicIcon />
          <span className="visually-hidden">Dictation unavailable</span>
        </button>
        <span role="tooltip" id={hintId} className={styles.dictationHint}>{DICTATION_FALLBACK_HINT}</span>
      </span>
    );
  }

  return (
    <span className={styles.dictationWrap}>
      <button type="button" className={`${styles.dictation} ${listening ? styles.dictationLive : ''}`}
        disabled={disabled && !listening} aria-pressed={listening}
        aria-label={listening ? 'Stop dictation (Esc)' : 'Start dictation'}
        title={listening ? 'Stop dictation (Esc)' : 'Dictate'}
        onClick={() => (listening ? stop() : start())}>
        <MicIcon />
        {listening ? <span className={styles.dictationPulse} aria-hidden="true" /> : null}
      </button>
      {error ? <span role="alert" className={styles.dictationError}>{error}</span> : null}
    </span>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
