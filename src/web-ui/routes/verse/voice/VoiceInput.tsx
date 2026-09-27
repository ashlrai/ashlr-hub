/**
 * routes/verse/voice/VoiceInput.tsx — the mic button every dictation-enabled
 * Verse input carries (chat composer, Leader composer, ⌘K, terminal).
 *
 * It registers its input as a dictation TARGET (voice-store.ts): a click
 * dictates into it, and the ⌃⌥V hotkey dictates into it when it is focused
 * (or was last). The live state — waveform, "Listening · local Parakeet",
 * dimmed partials, errors with one-click fixes — is the floating VoiceHud,
 * one for the whole app, so every surface looks and behaves the same.
 *
 * Lazy: surfaces import this with `lazy(() => import('./voice/VoiceInput.js'))`
 * so none of the voice code is in the first-paint bundle.
 */
import { useEffect, useId, useRef, type RefObject } from 'react';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import { registerVoiceTarget, toggleVoice, useVoiceSnapshot, type VoiceSurface } from './voice-store.js';
import styles from './VoiceInput.module.css';

export interface VoiceInputProps {
  surface: VoiceSurface;
  /** `verbatim` (terminal): inserted exactly as heard, no cleanup. */
  mode?: 'prose' | 'verbatim';
  /** The input (or its wrapper): focus inside it routes ⌃⌥V here. */
  targetRef: RefObject<HTMLElement | null>;
  /** Insert a FINAL transcript (partials never reach the input). */
  onInsert: (text: string) => void;
  /** The chat's repo, for project lexicon terms. */
  cwd?: () => string | null;
  /** The chat's file names, for turning "browser pane dot rs" into `browser_pane.rs`. */
  lookupIdentifiers?: (queries: string[]) => Promise<readonly string[]>;
  onListeningChange?: (listening: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function VoiceInput({
  surface,
  mode = 'prose',
  targetRef,
  onInsert,
  cwd,
  lookupIdentifiers,
  onListeningChange,
  disabled = false,
  className,
}: VoiceInputProps) {
  const id = `${surface}-${useId()}`;
  const voice = useVoiceSnapshot();
  const latest = useRef({ onInsert, cwd, lookupIdentifiers, onListeningChange });
  latest.current = { onInsert, cwd, lookupIdentifiers, onListeningChange };

  useEffect(
    () =>
      registerVoiceTarget({
        id,
        surface,
        mode,
        element: () => targetRef.current,
        cwd: () => latest.current.cwd?.() ?? null,
        insert: (text) => latest.current.onInsert(text),
        ...(lookupIdentifiers ? { lookupIdentifiers: (q: string[]) => latest.current.lookupIdentifiers?.(q) ?? Promise.resolve([]) } : {}),
        onListening: (on) => latest.current.onListeningChange?.(on),
      }),
    // `lookupIdentifiers` presence (not identity) decides whether biasing is offered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, surface, mode, targetRef, Boolean(lookupIdentifiers)],
  );

  const session = voice.session;
  const mine = session?.targetId === id;
  const live = mine && session?.phase !== 'finalizing';
  const busy = mine && session?.phase === 'finalizing';
  const errored = voice.error?.targetId === id;
  const hotkey = voice.backend === 'native' ? voice.native?.hotkey : null;

  if (voice.backend === 'none') {
    return (
      <Tooltip label="Dictation needs the Ashlr desktop app, or a browser with speech recognition" placement="top">
        <button type="button" className={`${styles.mic} ${className ?? ''}`} disabled aria-disabled="true" data-surface={surface}>
          <MicIcon />
          <span className="visually-hidden">Dictation unavailable</span>
        </button>
      </Tooltip>
    );
  }

  const label = live ? 'Stop and insert' : busy ? 'Transcribing…' : 'Dictate';
  const shortcut = live ? 'Esc cancels' : hotkey?.registered ? hotkey.accelerator : undefined;
  return (
    <Tooltip label={label} shortcut={shortcut} placement="top">
      <button
        type="button"
        className={`${styles.mic} ${live ? styles.micLive : ''} ${className ?? ''}`}
        data-surface={surface}
        data-error={errored ? 'true' : undefined}
        disabled={(disabled && !mine) || (!!session && !mine)}
        aria-pressed={live}
        aria-busy={busy || undefined}
        aria-label={live ? 'Stop dictation and insert' : 'Start dictation'}
        // Keep focus (and the caret) in the input: the text lands where it was.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => toggleVoice(id)}
      >
        <MicIcon />
        {live ? <span className={styles.micPulse} aria-hidden="true" /> : null}
      </button>
    </Tooltip>
  );
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default VoiceInput;
