/**
 * routes/verse/leader/LeaderComposer.tsx — the Leader conversation's input:
 * a growing text box and one Send button. Deliberately NOT the chat
 * composer (no seats, models, attachments or slash commands — the Leader
 * reads words).
 *
 *   Enter sends · Shift+Enter is a new line · an IME composition is never
 *   sent mid-word · an empty or whitespace box never sends.
 *
 * Also the inline answer box under a Leader question (`variant="answer"`):
 * the same keys, one line to start.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import { IconSend, IconX } from '../../../components/primitives/icons.js';
import { LEADER_MESSAGE_MAX } from './thread-model.js';
import styles from './leader.module.css';

export interface LeaderComposerHandle {
  focus: () => void;
}

export interface LeaderComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text; the owner clears `value` when the send starts. */
  onSend: (text: string) => void;
  label: string;
  placeholder: string;
  /** Why sending is off right now (read-only session, route absent); null = on. */
  disabledReason?: string | null;
  variant?: 'thread' | 'answer';
  /** A line above the box ("Answering: …") with a way to drop it. */
  context?: { label: string; onClear: () => void } | null;
  autoFocus?: boolean;
  /** Grow up to this many lines before scrolling. */
  maxLines?: number;
}

/** Grow the box to its content, up to `maxLines`. */
function fit(el: HTMLTextAreaElement, maxLines: number): void {
  el.style.height = 'auto';
  const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
  const pad = el.offsetHeight - el.clientHeight;
  const max = line * maxLines + pad + 16;
  el.style.height = `${Math.min(el.scrollHeight + pad, max)}px`;
  el.style.overflowY = el.scrollHeight + pad > max ? 'auto' : 'hidden';
}

export const LeaderComposer = forwardRef<LeaderComposerHandle, LeaderComposerProps>(function LeaderComposer(
  { value, onChange, onSend, label, placeholder, disabledReason = null, variant = 'thread', context = null, autoFocus = false, maxLines = 8 },
  ref,
) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => boxRef.current?.focus({ preventScroll: false }) }), []);

  useEffect(() => {
    if (boxRef.current) fit(boxRef.current, maxLines);
  }, [value, maxLines]);

  const trimmed = value.trim();
  const over = value.length > LEADER_MESSAGE_MAX;
  const canSend = trimmed.length > 0 && !over && disabledReason === null;

  const send = useCallback(() => {
    if (!canSend) return;
    onSend(trimmed);
  }, [canSend, onSend, trimmed]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    // Mid-composition (Japanese, Chinese, …) Enter picks a candidate, not "send".
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    // Keep the key from reaching a shell or drawer shortcut.
    event.stopPropagation();
    send();
  }

  const near = value.length > LEADER_MESSAGE_MAX * 0.9;
  return (
    <div className={styles.composer} data-variant={variant} data-disabled={disabledReason !== null ? 'true' : undefined}>
      {context ? (
        <div className={styles.composerContext}>
          <span className={styles.composerContextText} title={context.label}>{context.label}</span>
          <button type="button" className={styles.iconButton} aria-label="Stop answering this question" onClick={context.onClear}>
            <IconX />
          </button>
        </div>
      ) : null}
      <div className={styles.composerRow}>
        <textarea
          ref={boxRef}
          className={styles.composerBox}
          aria-label={label}
          placeholder={disabledReason ?? placeholder}
          value={value}
          rows={1}
          disabled={disabledReason !== null}
          // Only when the operator asked for this box (a Needs-you "Answer").
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-invalid={over || undefined}
        />
        <button type="button" className={styles.send} aria-label={variant === 'answer' ? 'Send answer' : 'Send to the Leader'} disabled={!canSend} onClick={send}>
          <IconSend />
        </button>
      </div>
      {variant === 'thread' ? (
        <p className={styles.composerHint}>
          {near ? (
            <span className={styles.counter} data-over={over ? 'true' : undefined}>
              {value.length.toLocaleString('en-US')} / {LEADER_MESSAGE_MAX.toLocaleString('en-US')}
            </span>
          ) : null}
          <span>
            <kbd className={styles.key}>↵</kbd> send · <kbd className={styles.key}>Shift</kbd> <kbd className={styles.key}>↵</kbd> new line
          </span>
        </p>
      ) : null}
    </div>
  );
});
