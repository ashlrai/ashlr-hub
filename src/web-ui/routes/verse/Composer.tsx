/**
 * routes/verse/Composer.tsx — the message box. Enter sends, Shift+Enter
 * inserts a newline; one control row beneath it carries the seat pill
 * (engine-tinted dot + name), the mic, and send/stop. No inner card: a
 * hairline that takes the accent on focus is the whole chrome (DESIGN §5).
 *
 * While a turn is running the box stays EDITABLE so the next message (typed
 * or dictated) can be drafted during the reply — only Send is withheld and
 * Stop takes its place. This deliberately relaxes the V1 contract line
 * "Composer disabled while running except stop": a disabled textarea loses
 * focus on every send and turns the loop (type · Enter · read · type) into a
 * click-into-the-box ritual, and system dictation lands nowhere.
 *
 * Sessions are seat-bound, so the seat pill is read-only: its menu says what
 * this chat runs on and offers "New chat on …" per seat, which asks the
 * parent to start a new chat rather than mutating this one.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { VerseSeat } from '../../data/api-types.js';
import { DictationButton } from './DictationButton.js';
import type { SeatChoice } from './SeatSelector.js';
import { seatPillLabel } from './verse-model.js';
import styles from './Composer.module.css';

export interface ComposerProps {
  seats: readonly VerseSeat[];
  seat: SeatChoice;
  /** Engine of the current chat; only used for the pill's identity dot. */
  engine?: VerseSeat['engine'];
  running: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  locked: boolean;
  /** True when this session already has turns — the hint row has done its job. */
  hintSeen?: boolean;
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  onSeatChange: (choice: SeatChoice) => void;
  autoFocus?: boolean;
}

const MAX_TEXT_BYTES = 64 * 1024;
/** DESIGN §5: the box grows to 40% of the viewport, then scrolls. */
const MAX_HEIGHT_RATIO = 0.4;
const MAX_HEIGHT_FALLBACK_PX = 320;

export function Composer({ seats, seat, engine, running, disabled, disabledReason, locked, hintSeen = false,
  onSend, onStop, onSeatChange, autoFocus = false }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [interim, setInterim] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [sentHere, setSentHere] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const helpId = useId();
  const text = interim ? `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}${interim}` : draft;
  const tooLong = new TextEncoder().encode(text).length > MAX_TEXT_BYTES;
  const canSend = !disabled && !running && !sending && text.trim().length > 0 && !tooLong;
  const showHint = !hintSeen && !sentHere;

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  // When the reply finishes, hand focus back to the box unless the operator
  // moved it somewhere deliberate outside the composer. Focus on <body>, on a
  // node that just unmounted (the Stop button), or on one of the composer's
  // own controls all count as "nowhere useful".
  useEffect(() => {
    if (running || !autoFocus) return;
    const active = document.activeElement;
    const ours = active !== null && active !== textarea.current && form.current?.contains(active) === true;
    if (active === null || active === document.body || !active.isConnected || ours) textarea.current?.focus();
  }, [running, autoFocus]);

  // Grow with content up to 40% of the viewport; shrink back when cleared.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    const viewport = typeof window === 'undefined' ? 0 : window.innerHeight;
    const max = viewport > 0 ? Math.round(viewport * MAX_HEIGHT_RATIO) : MAX_HEIGHT_FALLBACK_PX;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
  }, [text]);

  async function submit() {
    if (!canSend) return;
    const value = text.trim();
    setSending(true);
    try {
      const ok = await onSend(value);
      if (ok) {
        setDraft('');
        setInterim('');
        setSentHere(true);
      }
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  const placeholder = disabled
    ? disabledReason ?? 'Sending is disabled'
    : running
      ? 'Draft your next message…'
      : 'Message the agent…';

  return (
    <form ref={form} className={styles.composer} onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-describedby={helpId}>
      <div className={`${styles.box} ${listening ? styles.boxListening : ''}`}>
        <textarea ref={textarea} className={styles.textarea} value={text} rows={1} placeholder={placeholder}
          aria-label="Message" disabled={disabled}
          onChange={(event) => { setInterim(''); setDraft(event.target.value); }} onKeyDown={onKeyDown} />
        <div className={styles.row}>
          <SeatPill seats={seats} seat={seat} engine={engine} disabled={disabled} onNewChat={onSeatChange} />
          <div className={styles.spacer} />
          <DictationButton disabled={disabled}
            onInterim={setInterim}
            onFinal={(chunk) => setDraft((current) => (current && !current.endsWith(' ') ? `${current} ${chunk}` : `${current}${chunk}`))}
            onListeningChange={setListening} />
          {running ? (
            <button key="stop" type="button" className={styles.stop} onClick={onStop} aria-label="Stop the running turn">
              <span className={styles.stopIcon} aria-hidden="true" />Stop
            </button>
          ) : (
            <button key="send" type="submit" className={styles.send} disabled={!canSend} aria-label={locked ? 'Send (unlocks first)' : 'Send message'}>
              {sending ? 'Sending…' : locked ? 'Unlock & send' : 'Send'}
            </button>
          )}
        </div>
      </div>
      <p id={helpId} className={`${styles.help} ${showHint || tooLong || listening || running || disabled ? '' : styles.helpQuiet}`}>
        {tooLong ? <span role="alert" className={styles.helpError}>Message is over 64 KB — trim it before sending.</span>
          : listening ? 'Listening… Esc stops dictation.'
            : disabled && disabledReason ? disabledReason
              : running ? 'Reply in progress — your draft stays here · Stop interrupts the turn'
                : showHint
                  ? <><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>⌘N</kbd> new chat · <kbd>⌘K</kbd> switch</>
                  : null}
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Seat pill + menu
// ---------------------------------------------------------------------------

interface SeatPillProps {
  seats: readonly VerseSeat[];
  seat: SeatChoice;
  engine?: VerseSeat['engine'];
  disabled: boolean;
  onNewChat: (choice: SeatChoice) => void;
}

function SeatPill({ seats, seat, engine, disabled, onNewChat }: SeatPillProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = seatById(seats, seat.seatId);
  const tint = engine ?? current?.engine;
  const label = seatPillLabel(seats, { seatId: seat.seatId, engine: tint ?? 'claude', model: seat.model });
  const options = seats.filter((s) => s.health.state !== 'unavailable' && s.models.length > 0);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div ref={wrap} className={`${styles.seatPillWrap} ${tint ? styles[`engine-${tint}`] ?? '' : ''}`}>
      <button ref={button} type="button" className={styles.seatPill} data-engine={tint}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
        title="This chat is bound to one seat — open to start a new chat on another"
        onClick={() => setOpen((v) => !v)}>
        <span className={styles.engineDot} aria-hidden="true" />
        <span className={styles.seatPillText}>{label}</span>
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label="Seat" className={styles.seatMenu} onKeyDown={onMenuKey}>
          <p className={styles.seatMenuHeading}>This chat runs on <strong>{label}</strong></p>
          {options.length === 0 ? <p className={styles.seatMenuEmpty}>No other seats are available right now.</p> : null}
          {options.map((s) => (
            <button key={s.id} type="button" role="menuitem" className={`${styles.seatMenuItem} ${styles[`engine-${s.engine}`] ?? ''}`}
              onClick={() => { setOpen(false); onNewChat({ seatId: s.id, model: s.models[0]!.id }); }}>
              <span className={styles.engineDot} aria-hidden="true" />
              <span className={styles.seatMenuText}>
                <span className={styles.seatMenuPrimary}>New chat on {s.label}</span>
                <span className={styles.seatMenuSecondary}>{s.models[0]!.label}{s.id === seat.seatId ? ' · same seat' : ''}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function seatById(seats: readonly VerseSeat[], id: string): VerseSeat | undefined {
  return seats.find((s) => s.id === id);
}
