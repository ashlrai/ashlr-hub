/**
 * routes/verse/mobile/MobileComposer.tsx — the bottom bar a phone screen
 * types into (an agent's chat, the Leader): a growing text box, the mic, and
 * one send button — plus optional quick replies above it.
 *
 * Return inserts a newline (a phone keyboard's Return is not "send"); the
 * button sends. What is typed survives a failed send: the caller clears it
 * only when the send resolved.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { MicButton } from './MicButton.js';
import styles from './parts.module.css';
import { Button } from './ui.js';

export interface MobileComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Resolve when sent (the caller clears the box); reject to keep the words. */
  onSubmit: (text: string) => Promise<unknown> | void;
  placeholder: string;
  submitLabel?: string;
  disabled?: boolean;
  /** One line under the box: why it is disabled, what Send will do. */
  hint?: ReactNode;
  /** Quick replies / secondary actions above the box. */
  above?: ReactNode;
  /** Accessible name for the text box. */
  label: string;
}

export function MobileComposer({ value, onChange, onSubmit, placeholder, submitLabel = 'Send', disabled = false, hint, above, label }: MobileComposerProps) {
  const id = useId();
  const [interim, setInterim] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const text = interim ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${interim}` : value;
  const canSend = !disabled && !busy && value.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      await onSubmit(value.trim());
    } catch {
      /* the caller reported it; the words stay */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.composer}>
      {above}
      <div className={styles.composerRow}>
        <label htmlFor={id} className="visually-hidden">{label}</label>
        <textarea
          id={id}
          ref={box}
          className={styles.composerInput}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => {
            setInterim('');
            onChange(e.target.value);
            // Grow with the text, up to the CSS max-height.
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
        />
        <MicButton
          disabled={disabled}
          onInterim={setInterim}
          onFinal={(phrase) => onChange(`${value}${value && !value.endsWith(' ') ? ' ' : ''}${phrase}`)}
        />
        <Button variant="primary" disabled={!canSend} onClick={() => void submit()} aria-busy={busy || undefined}>
          {busy ? '…' : submitLabel}
        </Button>
      </div>
      {hint ? <p id={`${id}-hint`} className={styles.composerHint}>{hint}</p> : null}
    </div>
  );
}
