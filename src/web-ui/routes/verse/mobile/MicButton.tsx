/**
 * routes/verse/mobile/MicButton.tsx — the phone's big dictation button.
 *
 * Web Speech API (`SpeechRecognition` / Safari's `webkitSpeechRecognition`)
 * where the browser has one: tap to talk, interim words stream into the box,
 * tap again (or finish speaking) to stop. Where it has none — or refuses the
 * microphone — the button says so and points at the keyboard's own dictation
 * key, which types straight into the same box, so nothing is lost.
 *
 * Use the workbench's Web Speech engine: it keeps the final result until the
 * recognizer ends, including when a tap to stop produces the last phrase.
 * The phone's small status bubble is its VoiceHud; the desktop VoiceHud is
 * tied to native capture and workbench targets and is not mounted here.
 */
import { useEffect, useRef, useState } from 'react';
import { getSpeechRecognition, startWebSpeech, type WebSpeechSession } from '../voice/web-speech.js';
import { MicGlyph } from './mobile-icons.js';
import styles from './parts.module.css';
import core from './ui.module.css';

export const KEYBOARD_DICTATION_HINT = 'Tap the microphone on your keyboard to dictate into this box.';
export const BROWSER_SPEECH_DISCLOSURE = 'Browser dictation may send audio to your browser’s speech service. Tap again to start.';

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
  const available = getSpeechRecognition() !== null;
  const [listening, setListening] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState<string | null>(available ? null : KEYBOARD_DICTATION_HINT);
  const active = useRef<WebSpeechSession | null>(null);
  const cb = useRef({ onInterim, onFinal });
  cb.current = { onInterim, onFinal };

  const start = () => {
    if (!available || active.current) return;
    const session = startWebSpeech({
      onPartial: (text) => cb.current.onInterim(text),
      onFinal: (text) => cb.current.onFinal(text),
      onError: (code, message) => {
        if (code !== 'no-speech') setNote(`${message} ${KEYBOARD_DICTATION_HINT}`);
      },
      onEnd: () => {
        active.current = null;
        setListening(false);
        setStopping(false);
        cb.current.onInterim('');
      },
    });
    if (!session) return;
    active.current = session;
    setNote(null);
    setListening(true);
  };

  const stop = () => {
    if (!active.current || stopping) return;
    setStopping(true);
    // Keep callbacks attached: some browsers deliver the last final only
    // between stop() and onend.
    active.current.stop();
  };

  const toggle = () => {
    if (listening) return stop();
    // The Web Speech API's audio processing is browser-dependent. Show the
    // disclosure before the first capture, while the mic is still off.
    if (!acknowledged) {
      setAcknowledged(true);
      setNote(BROWSER_SPEECH_DISCLOSURE);
      return;
    }
    start();
  };

  useEffect(() => () => {
    const session = active.current;
    active.current = null;
    session?.cancel();
  }, []);

  return (
    <span className={styles.micWrap} data-size={size}>
      <button
        type="button"
        className={`${core.btn} ${styles.mic}`}
        data-size={size}
        data-live={listening ? '' : undefined}
        disabled={!available || stopping || (disabled && !listening)}
        aria-pressed={available ? listening : undefined}
        aria-label={!available ? 'Dictation unavailable in this browser' : listening ? 'Stop dictation' : acknowledged ? 'Dictate' : 'Review browser dictation'}
        onClick={toggle}
      >
        <MicGlyph size={size === 'large' ? 30 : 20} />
        {size === 'large' ? <span>{stopping ? 'Finishing…' : listening ? 'Listening… tap to stop' : acknowledged ? 'Tap to talk' : 'Browser dictation'}</span> : null}
      </button>
      {listening && size === 'inline' ? <span className={styles.micNote} data-size={size} role="status">{stopping ? 'Finishing…' : 'Listening… tap to stop'}</span> : null}
      {!listening && note ? <span className={styles.micNote} data-size={size} role="status">{note}</span> : null}
    </span>
  );
}
