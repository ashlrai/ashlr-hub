/**
 * routes/verse/mobile/MicButton.tsx — the phone's big dictation button.
 *
 * Web Speech API (`SpeechRecognition` / Safari's `webkitSpeechRecognition`)
 * where the browser has one: tap to talk, interim words stream into the box,
 * tap again (or finish speaking) to stop. Where it has none — or refuses the
 * microphone — the button says so and points at the keyboard's own dictation
 * key, which types straight into the same box, so nothing is lost.
 *
 * Deliberately self-contained (a few lines of recognizer handling) rather than
 * importing the workbench's DictationButton, whose tooltip and composer
 * stylesheet would ride into every phone screen. The shared VoiceInput being
 * built for the workbench can replace this in one place.
 *
 * NOTE for the server: `Permissions-Policy: microphone=()` (core/web/server.ts)
 * blocks recognition in browsers that enforce it; the phone then shows the
 * keyboard-dictation hint. Loosening it to `microphone=(self)` is a separate,
 * deliberate decision (see the PR notes).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MicGlyph } from './mobile-icons.js';
import styles from './parts.module.css';
import core from './ui.module.css';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResultLike> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export function speechRecognition(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const KEYBOARD_DICTATION_HINT = 'Tap the microphone on your keyboard to dictate into this box.';

export interface MicButtonProps {
  /** Words still being heard (replace, don't append). '' when none. */
  onInterim: (text: string) => void;
  /** A finished phrase: append it. */
  onFinal: (text: string) => void;
  disabled?: boolean;
  /** 'large' for New agent's prompt, 'inline' beside a composer. */
  size?: 'large' | 'inline';
}

export function MicButton({ onInterim, onFinal, disabled = false, size = 'inline' }: MicButtonProps) {
  const Ctor = speechRecognition();
  const [listening, setListening] = useState(false);
  const [note, setNote] = useState<string | null>(Ctor ? null : KEYBOARD_DICTATION_HINT);
  const active = useRef<RecognitionLike | null>(null);
  const cb = useRef({ onInterim, onFinal });
  cb.current = { onInterim, onFinal };

  const stop = useCallback(() => {
    const r = active.current;
    active.current = null;
    if (r) {
      r.onresult = null;
      r.onend = null;
      r.onerror = null;
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    }
    setListening(false);
    cb.current.onInterim('');
  }, []);

  const start = useCallback(() => {
    if (!Ctor || active.current) return;
    let r: RecognitionLike;
    try {
      r = new Ctor();
    } catch {
      setNote(KEYBOARD_DICTATION_HINT);
      return;
    }
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (!res) continue;
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (final.trim()) cb.current.onFinal(final.trim());
      cb.current.onInterim(interim);
    };
    r.onerror = (event) => {
      const code = event.error ?? '';
      if (code === 'not-allowed' || code === 'service-not-allowed') setNote(`Microphone access is off for this page. ${KEYBOARD_DICTATION_HINT}`);
      else if (code && code !== 'aborted' && code !== 'no-speech') setNote(`Dictation stopped (${code}).`);
      stop();
    };
    r.onend = () => {
      if (active.current === r) stop();
    };
    active.current = r;
    setNote(null);
    try {
      r.start();
      setListening(true);
    } catch {
      active.current = null;
      setNote(KEYBOARD_DICTATION_HINT);
    }
  }, [Ctor, stop]);

  useEffect(() => () => {
    const r = active.current;
    active.current = null;
    try {
      r?.abort();
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <span className={styles.micWrap} data-size={size}>
      <button
        type="button"
        className={`${core.btn} ${styles.mic}`}
        data-size={size}
        data-live={listening ? '' : undefined}
        disabled={!Ctor || (disabled && !listening)}
        aria-pressed={Ctor ? listening : undefined}
        aria-label={!Ctor ? 'Dictation unavailable in this browser' : listening ? 'Stop dictation' : 'Dictate'}
        onClick={() => (listening ? stop() : start())}
      >
        <MicGlyph size={size === 'large' ? 30 : 20} />
        {size === 'large' ? <span>{listening ? 'Listening… tap to stop' : 'Tap to talk'}</span> : null}
      </button>
      {note && size === 'large' ? <span className={styles.micNote} role="status">{note}</span> : null}
    </span>
  );
}
