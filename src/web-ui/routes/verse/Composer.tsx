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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { VerseSeat } from '../../data/api-types.js';
import { costHint, loadDraft, loadHistory, pushHistory, saveDraft, type CostHint } from './chat/composer-state.js';
import { DictationButton } from './DictationButton.js';
import type { SeatChoice } from './SeatSelector.js';
import { firstRunnableModel, seatCapacity, SEAT_CAPACITY_WORD, seatPillLabel } from './verse-model.js';
import { formatTokens } from './verse-store.js';
import styles from './Composer.module.css';

export interface ComposerProps {
  /** Which chat this box belongs to — drafts and ↑ history are per session. */
  sessionId?: string | null;
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
  /**
   * Live context occupancy, for the pre-send cost hint — the SAME budget the
   * header meter draws (verse-model `sessionContextBudget`), so the two can
   * never disagree about when things are tight.
   */
  contextTokens?: number | null;
  contextWindow?: number | null;
  /** Where the CLI auto-compacts; the hint's tone is measured against it. */
  autoCompactAt?: number | null;
  /** False when `contextTokens` is an upper bound (codex before its rollout is read). */
  contextExact?: boolean;
  /**
   * The box was pre-filled with a handoff note (V3.9) that has not been sent
   * yet: the help row says so, because the first send IS the first spend.
   */
  handoffDraft?: boolean;
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  onSeatChange: (choice: SeatChoice) => void;
  autoFocus?: boolean;
}

const MAX_TEXT_BYTES = 64 * 1024;

/**
 * How long typing must pause before the draft is written to `localStorage`.
 *
 * `saveDraft` re-parses the whole drafts map, mutates it, re-serialises it and
 * writes it back synchronously — up to 40 sessions of 64 KB. On every keystroke
 * that lands on the main thread inside the composer's own render commit, which
 * is the one place in the app where the operator feels a stall directly. The
 * draft is a crash-recovery convenience, so 400ms of exposure costs nothing;
 * every path that actually loses the component flushes it immediately.
 */
const DRAFT_WRITE_DEBOUNCE_MS = 400;
/** DESIGN §5: the box grows to 40% of the viewport, then scrolls. */
const MAX_HEIGHT_RATIO = 0.4;
const MAX_HEIGHT_FALLBACK_PX = 320;

export function Composer({ sessionId = null, seats, seat, engine, running, disabled, disabledReason, locked,
  hintSeen = false, contextTokens = null, contextWindow = null, autoCompactAt = null, contextExact = true, handoffDraft = false,
  onSend, onStop, onSeatChange, autoFocus = false }: ComposerProps) {
  // A draft survives ⌘K, a reload and a crash; it is restored on mount and
  // written back on every keystroke (Composer is keyed by session id, so a
  // mount is exactly one chat).
  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  const [interim, setInterim] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [sentHere, setSentHere] = useState(false);
  /** -1 = editing a fresh draft; 0..n-1 = walking back through sent messages. */
  const [historyAt, setHistoryAt] = useState(-1);
  // `useRef` takes a VALUE, not a lazy initializer: written as
  // `useRef(loadHistory(sessionId))` this re-read and re-parsed the whole sent
  // map from localStorage on every render — every keystroke and every streamed
  // token — and threw the result away each time. `useState`'s initializer is
  // the lazy one, and it runs exactly once, which is what the ref wanted.
  const [initialHistory] = useState(() => loadHistory(sessionId));
  const history = useRef<string[]>(initialHistory);
  const stashed = useRef('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const helpId = useId();
  const text = interim ? `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}${interim}` : draft;
  const tooLong = useMemo(() => new TextEncoder().encode(text).length > MAX_TEXT_BYTES, [text]);
  const canSend = !disabled && !running && !sending && text.trim().length > 0 && !tooLong;
  const showHint = !hintSeen && !sentHere;
  const showHandoffHelp = handoffDraft && !sentHere && text.trim().length > 0;
  const cost = useMemo(
    () => costHint(text, { contextTokens, contextWindow, autoCompactAt, exact: contextExact }),
    [text, contextTokens, contextWindow, autoCompactAt, contextExact],
  );

  // Persist the draft as it is typed, but not ON every keystroke — see
  // DRAFT_WRITE_DEBOUNCE_MS. Dictation interim text is deliberately NOT
  // persisted: it is not committed until the recognizer finalizes it.
  //
  // `persistedDraft` is what storage already holds, seeded with the value
  // `loadDraft` returned, so mounting does not write back what it just read.
  const persistedDraft = useRef(draft);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  const flushDraft = useCallback(() => {
    if (persistedDraft.current === latestDraft.current) return;
    persistedDraft.current = latestDraft.current;
    saveDraft(sessionId, latestDraft.current);
  }, [sessionId]);

  useEffect(() => {
    if (persistedDraft.current === draft) return undefined;
    const id = setTimeout(flushDraft, DRAFT_WRITE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft, flushDraft]);

  // A tab closing, and the component going away (⌘K to another chat), are the
  // two ways the debounce window could otherwise swallow the last few
  // characters. Both flush synchronously.
  useEffect(() => {
    window.addEventListener('beforeunload', flushDraft);
    return () => {
      window.removeEventListener('beforeunload', flushDraft);
      flushDraft();
    };
  }, [flushDraft]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  // ⌘. stops the running turn from anywhere in the app, the way ⌘. has meant
  // "cancel" on this platform for forty years. Only armed while a turn is
  // actually running, so it can never fire on an idle chat.
  useEffect(() => {
    if (!running) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '.' || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, onStop]);

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

  const submit = useCallback(async () => {
    if (!canSend) return;
    const value = text.trim();
    setSending(true);
    try {
      const ok = await onSend(value);
      if (ok) {
        const last = history.current[history.current.length - 1];
        if (last !== value) history.current = [...history.current, value];
        pushHistory(sessionId, value);
        setHistoryAt(-1);
        stashed.current = '';
        setDraft('');
        // Clear the stored draft now: the message is sent, and leaving it in
        // storage for the debounce window risks restoring a sent prompt.
        persistedDraft.current = '';
        latestDraft.current = '';
        saveDraft(sessionId, '');
        setInterim('');
        setSentHere(true);
      }
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }, [canSend, text, onSend, sessionId]);

  /**
   * Shell-style recall. ↑ from the top of an untouched box walks back through
   * what was already sent here; ↓ walks forward and finally restores whatever
   * was being written. Only fires at the very start/end of the text, so
   * multi-line editing keeps both arrow keys.
   */
  function recall(delta: -1 | 1): boolean {
    const list = history.current;
    if (list.length === 0) return false;
    if (historyAt === -1) {
      if (delta > 0) return false;
      stashed.current = draft;
      const next = list.length - 1;
      setHistoryAt(next);
      setDraft(list[next]!);
      setInterim('');
      return true;
    }
    const next = historyAt + delta;
    if (next < 0) return true;
    if (next >= list.length) {
      setHistoryAt(-1);
      setDraft(stashed.current);
      return true;
    }
    setHistoryAt(next);
    setDraft(list[next]!);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const node = event.currentTarget;
    const collapsed = node.selectionStart === node.selectionEnd;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
      return;
    }
    // ⌘/Ctrl+Enter also sends, so a hand already on the modifier for a
    // multi-line draft does not have to reach for plain Enter.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
      return;
    }
    // ⌘. is NOT handled here: the document-level listener above owns it, and
    // handling it in both places called onStop twice whenever the box had
    // focus — which is nearly always.
    //
    // History walking. ↑ enters history only from the very start of an
    // untouched box, so multi-line editing keeps the arrow keys; once IN
    // history both arrows walk it, because a recalled message leaves the
    // caret at its end and a second ↑ must still step back, the way a shell
    // does. Typing anything leaves history (see the textarea's onChange).
    if (event.key === 'ArrowUp' && collapsed && (historyAt !== -1 || (node.selectionStart === 0 && !interim))) {
      if (recall(-1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' && collapsed && historyAt !== -1) {
      if (recall(1)) event.preventDefault();
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
          onChange={(event) => { setInterim(''); setHistoryAt(-1); setDraft(event.target.value); }} onKeyDown={onKeyDown} />
        <div className={styles.row}>
          <SeatPill seats={seats} seat={seat} engine={engine} disabled={disabled} onNewChat={onSeatChange} />
          <div className={styles.spacer} />
          <DictationButton disabled={disabled}
            onInterim={setInterim}
            onFinal={(chunk) => setDraft((current) => (current && !current.endsWith(' ') ? `${current} ${chunk}` : `${current}${chunk}`))}
            onListeningChange={setListening} />
          {running ? (
            <button key="stop" type="button" className={styles.stop} onClick={onStop}
              title="Stop the running turn (⌘.)" aria-label="Stop the running turn">
              <span className={styles.stopIcon} aria-hidden="true" />Stop
            </button>
          ) : (
            <button key="send" type="submit" className={styles.send} disabled={!canSend} aria-label={locked ? 'Send (unlocks first)' : 'Send message'}>
              {sending ? 'Sending…' : locked ? 'Unlock & send' : 'Send'}
            </button>
          )}
        </div>
      </div>
      {cost ? (
        <p className={styles.cost} data-tone={cost.tone} role="status">
          <span className={styles.costFigure}>≈{formatTokens(cost.draftTokens)}</span> tokens for this message —
          sending would reach <span className={styles.costFigure}>{cost.projectedPercent}%</span> of the context window.
          {costConsequence(cost)}
          <span className="visually-hidden"> This is an estimate; the provider counts the real total.</span>
        </p>
      ) : null}
      <p id={helpId} className={`${styles.help} ${showHint || tooLong || listening || running || disabled || historyAt !== -1 || showHandoffHelp ? '' : styles.helpQuiet}`}>
        {tooLong ? <span role="alert" className={styles.helpError}>Message is over 64 KB — trim it before sending.</span>
          : listening ? 'Listening… Esc stops dictation.'
            : disabled && disabledReason ? disabledReason
              : running ? <>Reply in progress — your draft stays here · <kbd>⌘.</kbd> or Stop interrupts the turn</>
                : showHandoffHelp
                  ? <>Handoff note drafted from the previous chat — review or edit it; nothing is spent until you press Send.</>
                : historyAt !== -1 ? <>Recalled message {historyAt + 1} of {history.current.length} · <kbd>↓</kbd> returns to your draft</>
                  : showHint
                    ? <><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>↑</kbd> recalls · <kbd>⌘N</kbd> new chat · <kbd>⌘K</kbd> switch</>
                    : null}
      </p>
    </form>
  );
}

/**
 * The sentence after the percentage: what actually happens if this is sent.
 * Worded from the compaction point when it is known, because that — not the
 * window — is where the agent starts losing detail.
 */
export function costConsequence(cost: CostHint): string {
  const bound = cost.exact ? '' : ' (The current size is an upper bound, so this may overstate it.)';
  if (cost.tone === 'over') return ` That is past the whole window — the CLI must compact first, or the turn fails. Continue in a fresh chat.${bound}`;
  if (cost.pastCompaction) return ` That reaches the auto-compaction point, so the CLI will summarise earlier turns during this reply. Continue in a fresh chat to keep full detail.${bound}`;
  if (cost.autoCompactAt !== null) {
    const left = Math.max(0, cost.autoCompactAt - cost.projectedTokens);
    return ` About ${formatTokens(left)} left before the CLI auto-compacts.${cost.tone === 'danger' ? ' Start a new chat to keep the agent sharp.' : ''}${bound}`;
  }
  return `${cost.tone === 'danger' ? ' Start a new chat to keep the agent sharp.' : ''}${bound}`;
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
  // A seat whose every model is listed as unavailable (e.g. needs a newer
  // CLI) cannot start a chat, so it is not offered as one.
  const options = seats.filter((s) => s.health.state !== 'unavailable' && firstRunnableModel(s) !== null);

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
          {options.map((s) => {
            // The capacity belongs HERE, at the point of choice. This menu
            // filtered only on `health.state !== 'unavailable'`, and Claude's
            // health is `unknown` by construction, so a seat with a 100%-used
            // weekly window looked exactly like a fresh one.
            const capacity = seatCapacity(s);
            const model = firstRunnableModel(s)!;
            return (
              <button key={s.id} type="button" role="menuitem" className={`${styles.seatMenuItem} ${styles[`engine-${s.engine}`] ?? ''}`}
                data-capacity={capacity.cls}
                onClick={() => { setOpen(false); onNewChat({ seatId: s.id, model: model.id }); }}>
                <span className={styles.engineDot} aria-hidden="true" />
                <span className={styles.seatMenuText}>
                  <span className={styles.seatMenuPrimary}>New chat on {s.label}</span>
                  <span className={styles.seatMenuSecondary}>{model.label}{s.id === seat.seatId ? ' · same seat' : ''}</span>
                  {capacity.cls === 'unread' ? null : (
                    <span className={styles.seatMenuCapacity}>
                      {SEAT_CAPACITY_WORD[capacity.cls]} · {capacity.text}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function seatById(seats: readonly VerseSeat[], id: string): VerseSeat | undefined {
  return seats.find((s) => s.id === id);
}
