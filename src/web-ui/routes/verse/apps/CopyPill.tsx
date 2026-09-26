/**
 * routes/verse/apps/CopyPill.tsx — a command you can read and copy in one
 * click (SPEC-310C §4: "a copy pill, ⧉ turns into ✓ for 1.2s").
 *
 * The command is shown IN FULL in mono on the code background — the operator
 * reads what they are about to paste. The button's accessible name says what
 * it copies; the confirmation is announced through a polite live region, not
 * only drawn, so a screen-reader user hears "Copied" too.
 *
 * Clipboard: the async API where the page is allowed it (a secure context,
 * which the desktop webview and localhost are), else a hidden-textarea copy.
 * A copy that fails says so instead of showing a check.
 */
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../../components/primitives/clipboard.js';
import { IconCheck, IconCopy } from '../../../components/primitives/icons.js';
import styles from './Apps.module.css';

// Moved to a style-free module so other surfaces can copy without Apps' CSS.
export { copyText };

/** SPEC-310C §4. */
export const COPY_CONFIRM_MS = 1_200;

export function CopyPill({ text, label, what }: { text: string; label?: string; /** "the Codex launch command" */ what: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPY_CONFIRM_MS);
  };

  return (
    <span className={styles.pillWrap}>
      <button
        type="button"
        className={styles.pill}
        data-state={state}
        onClick={() => void onCopy()}
        aria-label={`Copy ${what}: ${text}`}
        title={`Copy: ${text}`}
      >
        <code className={styles.pillText}>{label ?? text}</code>
        <span className={styles.pillIcon} aria-hidden="true">
          {state === 'copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}
        </span>
      </button>
      <span className={styles.visuallyHidden} role="status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select the command and copy it yourself' : ''}
      </span>
    </span>
  );
}
