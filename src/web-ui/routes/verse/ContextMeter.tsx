/**
 * routes/verse/ContextMeter.tsx — live context occupancy, the session's
 * context mode, and the two pieces of advice that follow from them.
 *
 * DESIGN §4: not a labelled progress bar. The track is a 2px full-width line
 * pinned to the bottom edge of the header strip (the component's own root
 * stays unpositioned so the header is its containing block); the numbers ride
 * alongside in the display font, the tooltip and `aria-valuetext` carry the
 * long form.
 *
 * WHAT CHANGED IN 3.9, and why (docs/VERSE-CONTEXT.md):
 *
 *  - The track is the FULL window and carries a tick where the CLI will
 *    auto-compact. A 1M Claude model in standard mode compacts near 367k; a
 *    bar that only showed "37% of 1M" hid the one number that decides when
 *    the agent starts forgetting.
 *  - Tone comes from context-math `occupancy()`, measured against the
 *    COMPACTION point (warn from 80%, danger from 95%) — before the CLI
 *    compacts, not after. The old fixed 70/90% of the window turned red only
 *    once codex (90%) and grok (80%) had already compacted.
 *  - Nothing is clamped: a reading past the window is information, drawn as
 *    an `over` state rather than pinned at 100%.
 *  - An upper-bound reading (codex before its rollout is read) is prefixed
 *    `≤`, never shown as a measurement.
 *
 * Every figure here is computed by context-math, the same module the server
 * uses, so "compacts ≈367k" cannot mean two different numbers in two places.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { VerseContextMode, VerseEngine, VerseModelOption, VerseSession, VerseWindowSource } from '../../data/api-types.js';
import {
  budgetFor,
  CACHE_IDLE_TTL_MS,
  expansiveAdvice,
  handoffAdvice,
  hasExpansiveMode,
  occupancy,
  OCCUPANCY_DANGER,
  OCCUPANCY_WARN,
  type VerseHandoffAdvice,
  type VerseOccupancyTone,
} from '../../../core/verse/context-math.js';
import { WINDOW_SOURCE_TEXT, type SessionContextBudget } from './verse-model.js';
import { dismissVerseAdvice, isVerseAdviceDismissed } from './verse-ui-store.js';
import { formatTokens } from './verse-store.js';
import styles from './Workspace.module.css';

/** Percent-of-compaction thresholds, re-exported so copy can quote them. */
export const CONTEXT_WARN_PERCENT = Math.round(OCCUPANCY_WARN * 100);
export const CONTEXT_DANGER_PERCENT = Math.round(OCCUPANCY_DANGER * 100);

export const CONTEXT_MODE_LABEL: Record<VerseContextMode, string> = {
  standard: 'Standard',
  expansive: 'Expansive',
};

/** Who does the compacting, in words the operator recognises. */
const COMPACTOR: Record<VerseEngine, string> = {
  claude: 'Claude Code',
  local: 'Claude Code (driving the local model)',
  codex: 'Codex',
  grok: 'Grok',
};

/** Full-precision figure for the tooltip, where `367k` would hide the digits. */
function exactFigure(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface ContextMeterProps {
  contextTokens: number | null | undefined;
  contextWindow: number | null | undefined;
  /** Where the CLI auto-compacts in the session's current mode; null/absent = unknown. */
  autoCompactAt?: number | null;
  /** False when `contextTokens` is an upper bound, drawn with a `≤`. Absent = exact. */
  exact?: boolean;
  source?: VerseWindowSource | null;
  mode?: VerseContextMode | null;
  engine?: VerseEngine | null;
  compactionCount?: number;
  /** `inline` draws the track in flow (resources panel) instead of pinned. */
  variant?: 'header' | 'inline';
}

/** The meter's words, separated from its markup so the tooltip and the tests read one source. */
export function describeContext(props: Omit<ContextMeterProps, 'variant'>): {
  tone: VerseOccupancyTone;
  /** "≤142k / 1M" */
  label: string;
  /** "compacts ≈367k", or null when the point is unknown. */
  compactLabel: string | null;
  /** Percent of the WINDOW, unclamped; null when the window is unknown. */
  percent: number | null;
  percentLabel: string;
  /** Where the compaction tick sits on the track (0–100), or null when not drawable. */
  tickPercent: number | null;
  /** Fill width on the track (0–100). */
  fillPercent: number;
  title: string;
} {
  const occ = occupancy({
    contextTokens: typeof props.contextTokens === 'number' && Number.isFinite(props.contextTokens) ? props.contextTokens : 0,
    contextWindow: props.contextWindow ?? null,
    autoCompactAt: props.autoCompactAt ?? null,
    contextTokensExact: props.exact,
  });
  const bound = occ.exact ? '' : '≤';
  const label = `${bound}${formatTokens(occ.tokens)} / ${occ.window !== null ? formatTokens(occ.window) : 'n/a'}`;
  const compactLabel = occ.autoCompactAt !== null ? `compacts ≈${formatTokens(occ.autoCompactAt)}` : null;
  const percent = occ.ofWindow !== null ? Math.round(occ.ofWindow * 100) : null;
  const tickPercent = occ.window !== null && occ.autoCompactAt !== null && occ.autoCompactAt < occ.window
    ? (occ.autoCompactAt / occ.window) * 100
    : null;
  const fillPercent = occ.ofWindow !== null ? Math.min(100, Math.max(0, occ.ofWindow * 100)) : 0;

  const lines: string[] = [];
  lines.push(occ.window !== null
    ? `Context: ${bound}${exactFigure(occ.tokens)} of ${exactFigure(occ.window)} tokens (${percent}%).`
    : `Context: ${bound}${exactFigure(occ.tokens)} tokens — the window is unknown, so no percentage is shown.`);
  if (!occ.exact) {
    lines.push('Upper bound: this CLI reported only the turn total so far; the exact last-call size replaces it once its session log is read.');
  }
  if (occ.tone === 'over') {
    lines.push('Past the window: the next turn will fail or force the CLI to compact first. Continue in a fresh chat.');
  }
  const modeText = props.mode ? ` (${CONTEXT_MODE_LABEL[props.mode]} mode)` : '';
  if (occ.autoCompactAt !== null) {
    lines.push(`Auto-compacts at ≈${exactFigure(occ.autoCompactAt)} tokens${modeText} — ${occ.untilCompaction === 0 ? 'at or past that point now' : `≈${exactFigure(occ.untilCompaction ?? 0)} left`}.`);
    const who = props.engine ? COMPACTOR[props.engine] : 'The CLI';
    lines.push(`When it compacts, ${who} replaces the earlier conversation with a summary and carries on; early detail then survives only as that summary.`);
  } else if (occ.window !== null) {
    lines.push(`The compaction point is unknown${modeText}; the colour is measured against the whole window.`);
  }
  if ((props.compactionCount ?? 0) > 0) {
    const n = props.compactionCount ?? 0;
    lines.push(`Compacted ${n} time${n === 1 ? '' : 's'} so far.`);
  }
  if (occ.window !== null) {
    lines.push(`Window: ${props.source ? WINDOW_SOURCE_TEXT[props.source] : 'source not recorded (an older session)'}.`);
  }
  return {
    tone: occ.tone,
    label,
    compactLabel,
    percent,
    percentLabel: percent === null ? 'n/a' : `${percent}%`,
    tickPercent,
    fillPercent,
    title: lines.join('\n'),
  };
}

export function ContextMeter({ variant = 'header', ...props }: ContextMeterProps) {
  const d = describeContext(props);
  // aria-valuenow is bounded by aria-valuemax; the over state is carried by
  // the text and data-tone instead of an out-of-range value.
  const valueNow = d.percent === null ? undefined : Math.min(100, d.percent);
  const valueText = `${d.label} (${d.percentLabel})${d.compactLabel ? `, ${d.compactLabel.replace('≈', 'at about ')}` : ''}${d.tone === 'over' ? ', past the window' : ''}`;
  return (
    <div
      className={`${styles.meter} ${styles[`meter-${d.tone}`] ?? ''} ${variant === 'inline' ? styles.meterInline : ''}`}
      role="meter" aria-label="Context window" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={valueNow} aria-valuetext={valueText}
      title={d.title} data-tone={d.tone} data-exact={props.exact === false ? 'false' : undefined}
    >
      <div className={styles.meterTrack} aria-hidden="true">
        <div className={styles.meterFill} style={{ width: `${d.fillPercent}%` }} />
        {d.tickPercent !== null ? (
          <div className={styles.meterTick} data-testid="compaction-tick" style={{ left: `${d.tickPercent}%` }} />
        ) : null}
      </div>
      <span className={styles.meterText}>
        <span className={styles.meterTokens}>{d.label}</span>
        {d.compactLabel ? <span className={styles.meterCompact}>· {d.compactLabel}</span> : null}
        <span className={styles.meterPercent}>{d.percentLabel}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context mode — Standard / Expansive
// ---------------------------------------------------------------------------

/**
 * "Late turns cost up to ≈2.6× the usage": every turn re-sends the whole
 * context, so the most a turn can carry grows with the compaction point. The
 * ratio is of the two compaction points (the largest prompt each mode lets a
 * turn reach), rounded to one decimal — an honest ceiling, not a forecast.
 */
export function expansiveCostRatio(option: VerseModelOption | null | undefined): number | null {
  const standard = budgetFor(option, 'standard');
  const expansive = budgetFor(option, 'expansive');
  if (!standard || !expansive) return null;
  const s = standard.autoCompactAt ?? standard.contextWindow;
  const e = expansive.autoCompactAt ?? expansive.contextWindow;
  if (s <= 0 || e <= s) return null;
  return Math.round((e / s) * 10) / 10;
}

function modeDetail(option: VerseModelOption | null | undefined, mode: VerseContextMode): string {
  const b = budgetFor(option, mode);
  if (!b) return 'not available for this model';
  const point = b.autoCompactAt ?? b.contextWindow;
  return `compacts ≈${formatTokens(point)} of ${formatTokens(b.contextWindow)}`;
}

/** The cost sentence both the mode menu and the suggestion chip say, word for word. */
export function expansiveCostCopy(option: VerseModelOption | null | undefined): string {
  const ratio = expansiveCostRatio(option);
  const standard = budgetFor(option, 'standard');
  const point = standard ? formatTokens(standard.autoCompactAt ?? standard.contextWindow) : null;
  return ratio !== null && point !== null
    ? `Every turn re-sends the whole context, so once it grows past ≈${point} each turn costs more usage — up to ≈${ratio}× near the expansive limit — and recall of early detail weakens with length.`
    : 'Every turn re-sends the whole context, so a larger budget means more usage per turn as it grows.';
}

export interface ContextModeControlProps {
  mode: VerseContextMode;
  option: VerseModelOption | null;
  disabled?: boolean;
  /** Why the control is disabled, for the tooltip. */
  disabledReason?: string | null;
  busy?: boolean;
  error?: string | null;
  onChange: (mode: VerseContextMode) => void;
  /**
   * Opens the "Compact now" panel. Passed only for sessions whose engine can
   * compact on request (`canCompactNow`); absent → no menu item.
   */
  onCompact?: () => void;
}

/**
 * The mode chip beside the meter and its menu. Rendered by the Workspace only
 * for a model with a real expansive budget (or a session already in
 * expansive, so it can always be switched back). Changing mode is an explicit
 * click — Verse never switches it on its own — and applies from the NEXT turn:
 * it changes CLI flags only, never prompt content, so the prompt cache holds.
 */
export function ContextModeControl({ mode, option, disabled = false, disabledReason = null, busy = false, error = null, onChange, onCompact }: ContextModeControlProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const expansiveAvailable = hasExpansiveMode(option);

  // An error keeps the menu open so the operator sees why nothing changed.
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  // A turn starting while the menu is open disables the chip (the engine
  // answers 409 to a mode change mid-turn); a menu left open under a disabled
  // chip would offer choices that can only fail.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

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
    if (open) wrap.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const choose = (next: VerseContextMode) => {
    if (next === mode || busy) return;
    // Close on the choice; the chip shows "Switching…" while the write is in
    // flight, and a failure re-opens the menu with the reason (effect above).
    setOpen(false);
    button.current?.focus();
    onChange(next);
  };

  return (
    <div ref={wrap} className={styles.modeWrap}>
      <button ref={button} type="button" className={styles.modeChip} data-mode={mode}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`Context mode: ${CONTEXT_MODE_LABEL[mode]}`} disabled={disabled}
        title={disabled && disabledReason ? disabledReason : `Context mode: ${CONTEXT_MODE_LABEL[mode]} — ${modeDetail(option, mode)}`}
        onClick={() => setOpen((v) => !v)}>
        {busy ? 'Switching…' : CONTEXT_MODE_LABEL[mode]}
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label="Context mode" className={styles.modeMenu} onKeyDown={onMenuKey}>
          <p className={styles.modeMenuHeading}>How much context this chat may hold before the CLI compacts</p>
          {(['standard', 'expansive'] as const).map((m) => {
            const unavailable = m === 'expansive' && !expansiveAvailable;
            return (
              <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} className={styles.modeItem}
                disabled={unavailable || busy} onClick={() => choose(m)}>
                <span className={styles.modeItemPrimary}>{CONTEXT_MODE_LABEL[m]}{mode === m ? ' · current' : ''}</span>
                <span className={styles.modeItemSecondary}>
                  {m === 'standard'
                    ? `${modeDetail(option, 'standard')} · lower usage per turn, sharper recall`
                    : unavailable ? 'not available for this model on this seat' : `${modeDetail(option, 'expansive')} · the full native window`}
                </span>
              </button>
            );
          })}
          <p className={styles.modeMenuNote}>{expansiveCostCopy(option)}</p>
          <p className={styles.modeMenuNote}>
            Applies from the next turn. Only the CLI&apos;s compaction flag changes — the conversation and its prompt cache are kept.
          </p>
          {onCompact ? (
            <button type="button" role="menuitem" className={`${styles.modeItem} ${styles.modeItemAction}`} disabled={busy}
              onClick={() => { setOpen(false); onCompact(); }}>
              <span className={styles.modeItemPrimary}>Compact now…</span>
              <span className={styles.modeItemSecondary}>summarize the conversation so far instead of waiting for the CLI to</span>
            </button>
          ) : null}
          {error ? <p role="alert" className={styles.modeMenuError}>{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advice — "continue in a fresh chat" and "expansive may help"
// ---------------------------------------------------------------------------

/**
 * Re-evaluated on a clock because one reason ("idle past the cache lifetime")
 * becomes true with no event at all. A minute is well inside the 1h TTL.
 */
const ADVICE_TICK_MS = 60_000;

function useNow(intervalMs: number, injected?: number): number {
  const [now, setNow] = useState(() => injected ?? Date.now());
  useEffect(() => {
    if (injected !== undefined) {
      setNow(injected);
      return undefined;
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, injected]);
  return now;
}

/** The handoff verdict for a session, from the SAME budget the meter draws. */
export function sessionHandoffAdvice(
  session: Pick<VerseSession, 'usage' | 'compactionCount' | 'updatedAt' | 'status'>,
  budget: SessionContextBudget,
  now: number,
): VerseHandoffAdvice {
  return handoffAdvice({
    usage: {
      ...session.usage,
      contextTokens: budget.contextTokens,
      contextWindow: budget.contextWindow,
      autoCompactAt: budget.autoCompactAt,
      contextTokensExact: budget.exact,
    },
    compactionCount: session.compactionCount ?? 0,
    // A running turn is activity: the cache is being refreshed right now.
    lastActivityAt: session.status === 'running' ? null : session.updatedAt,
    now,
  });
}

export interface ContextAdviceProps {
  session: VerseSession;
  budget: SessionContextBudget;
  /** Whether the mode control exists for this session (the chip only offers what it can do). */
  modesAvailable: boolean;
  dispatchEnabled: boolean;
  modeBusy?: boolean;
  onHandoff: () => void;
  onSwitchExpansive: () => void;
  /** Opens the "Compact now" panel; passed only when `canCompactNow(engine)`. */
  onCompact?: () => void;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * The banner row under the header. Two independent, dismissible notes:
 *
 *  - HANDOFF (handoffAdvice ≥ suggest) — reasons listed in plain sentences,
 *    and one action that opens the handoff dialog. Building the note is free;
 *    nothing is spent until the operator presses Send in the new chat.
 *  - EXPANSIVE (expansiveAdvice) — a suggestion chip with the cost stated.
 *    Never an automatic switch.
 *
 * "Not now" is remembered per session for the page's lifetime (verse-ui-store,
 * not persisted: advice is evidence, and stale evidence must not outlive a
 * reload), and a note comes back when its evidence escalates.
 */
export function ContextAdvice({ session, budget, modesAvailable, dispatchEnabled, modeBusy = false, onHandoff, onSwitchExpansive, onCompact, now: injectedNow }: ContextAdviceProps) {
  const now = useNow(ADVICE_TICK_MS, injectedNow);
  const [, bump] = useState(0);
  const handoff = sessionHandoffAdvice(session, budget, now);
  const expansive = modesAvailable
    ? expansiveAdvice({ session, option: budget.option })
    : { suggest: false, reason: null };
  const compactions = session.compactionCount ?? 0;
  const handoffKey = `handoff:${handoff.level}:${compactions}`;
  const expansiveKey = `expansive:${compactions}`;
  const showHandoff = handoff.level !== 'none' && !isVerseAdviceDismissed(session.id, handoffKey);
  const showExpansive = expansive.suggest && !isVerseAdviceDismissed(session.id, expansiveKey);
  if (!showHandoff && !showExpansive) return null;

  const running = session.status === 'running';
  const dismiss = (key: string) => {
    dismissVerseAdvice(session.id, key);
    bump((n) => n + 1);
  };
  const idleExpired = session.updatedAt ? now - Date.parse(session.updatedAt) >= CACHE_IDLE_TTL_MS : false;

  return (
    <div className={styles.advice}>
      {showHandoff ? (
        <section className={styles.adviceNote} data-level={handoff.level} aria-label="Context advice">
          <div className={styles.adviceBody}>
            <p className={styles.adviceTitle}>
              {handoff.level === 'urge' ? 'Time to continue in a fresh chat' : 'Consider continuing in a fresh chat'}
            </p>
            <ul className={styles.adviceReasons}>
              {handoff.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
            <p className={styles.adviceFine}>
              Verse drafts a handoff note from this chat&apos;s log — free. Nothing is sent until you press Send in the new chat.
              {idleExpired ? ' Continuing here instead re-reads the whole context at full cost.' : ''}
            </p>
          </div>
          <div className={styles.adviceActions}>
            <button type="button" className={styles.adviceAction} onClick={onHandoff} disabled={!dispatchEnabled || running}
              title={running ? 'Available when the current turn finishes' : !dispatchEnabled ? 'Sending is disabled on this server' : undefined}>
              Continue in a fresh chat…
            </button>
            {onCompact ? (
              // The in-place alternative: keep this chat, trade its early
              // detail for a summary now. Same guards as the handoff.
              <button type="button" className={styles.ghost} onClick={onCompact} disabled={!dispatchEnabled || running || session.turnCount === 0}
                title={running ? 'Available when the current turn finishes' : !dispatchEnabled ? 'Sending is disabled on this server' : 'Summarize this chat in place instead'}>
                Compact now…
              </button>
            ) : null}
            <button type="button" className={styles.ghost} onClick={() => dismiss(handoffKey)}>Not now</button>
          </div>
        </section>
      ) : null}
      {showExpansive ? (
        <section className={styles.adviceNote} data-level="suggest" data-kind="expansive" aria-label="Expansive mode suggestion">
          <div className={styles.adviceBody}>
            <p className={styles.adviceTitle}>Expansive mode could help</p>
            <p className={styles.adviceFine}>{expansive.reason} {expansiveCostCopy(budget.option)}</p>
          </div>
          <div className={styles.adviceActions}>
            {/* Disabled mid-turn: the engine answers 409 to a mode change while a turn runs. */}
            <button type="button" className={styles.adviceAction} onClick={onSwitchExpansive} disabled={!dispatchEnabled || modeBusy || running}
              title={running ? 'Available when the current turn finishes' : undefined}>
              {modeBusy ? 'Switching…' : 'Switch to expansive'}
            </button>
            <button type="button" className={styles.ghost} onClick={() => dismiss(expansiveKey)}>Not now</button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact now — the CLI's own /compact, sent as an ordinary turn
// ---------------------------------------------------------------------------

/**
 * Engines whose CLI compacts on request. Claude Code (which also drives the
 * local seats) accepts `/compact` as the text of a headless turn on a resumed
 * session and answers with a `compact_boundary` (trigger "manual") that the
 * adapter already turns into a compaction event — verified for real on a
 * local seat (build-U2 §2). Codex `exec` has no compact verb, and Grok's
 * headless `/compact` is unverified, so neither is offered: a button that
 * sends a literal "/compact" to a model that treats it as prose would spend a
 * turn and compact nothing.
 */
export function canCompactNow(engine: VerseEngine | null | undefined): boolean {
  return engine === 'claude' || engine === 'local';
}

/** Longest focus line accepted — a steer for the summary, not a second prompt. */
export const COMPACT_FOCUS_MAX = 500;

/**
 * The turn text. The focus is folded to one line: the CLI reads a slash
 * command's arguments from the rest of its line, so a newline would silently
 * drop everything after it.
 */
export function compactCommand(focus: string): string {
  const line = focus.replace(/\s+/g, ' ').trim().slice(0, COMPACT_FOCUS_MAX).trim();
  return line ? `/compact ${line}` : '/compact';
}

/** The cost sentence, per engine — the part of this panel that must not be vague. */
export function compactCostCopy(engine: VerseEngine, tokensLabel: string): string {
  return engine === 'local'
    ? `Free — it runs on the local model — but summarizing ${tokensLabel} tokens runs at that model's speed and can take minutes; the chat is busy until it finishes.`
    : `Spends usage on this seat: one summarization call that reads the whole current context (${tokensLabel} tokens) and writes the summary.`;
}

export interface CompactPanelProps {
  engine: VerseEngine;
  budget: Pick<SessionContextBudget, 'contextTokens' | 'autoCompactAt' | 'exact'>;
  running: boolean;
  dispatchEnabled: boolean;
  /** No turn has run yet, so there is no resumable conversation to compact. */
  empty: boolean;
  /** Sends the text through the chat's normal send path; true when it was accepted. */
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}

/**
 * The confirm step for a manual compaction, under the header strip beside the
 * advice notes. It exists because the action is not free on a paid seat and
 * not quick on a local one, and a one-click menu item would hide both.
 *
 * It sends through the SAME path as the composer (Workspace `onSend` →
 * ChatSection `send` → POST …/turns): the token gate, the running state, the
 * transcript entry and the engine's local-only chokepoint all apply exactly
 * as for a typed message. Nothing here is a new way to reach a model.
 */
export function CompactPanel({ engine, budget, running, dispatchEnabled, empty, onSend, onClose }: CompactPanelProps) {
  const [focus, setFocus] = useState('');
  const [sending, setSending] = useState(false);
  const focusId = useId();
  const who = COMPACTOR[engine];
  const tokensLabel = `${budget.exact ? '≈' : '≤'}${formatTokens(budget.contextTokens)}`;
  const blocked = running ? 'Available when the current turn finishes.'
    : !dispatchEnabled ? 'Sending is disabled: this server was started without dispatch.'
    : empty ? 'Nothing to compact yet — this chat has no turns.'
    : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || sending) return;
    setSending(true);
    try {
      if (await onSend(compactCommand(focus))) onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.adviceNote} data-level="suggest" data-kind="compact" aria-label="Compact this chat">
      <form className={styles.compactForm} onSubmit={(event) => { void submit(event); }}>
        <div className={styles.adviceBody}>
          <p className={styles.adviceTitle}>Compact this chat now</p>
          <p className={styles.adviceFine}>
            {who} replaces the conversation so far with a summary it writes, then carries on from it — what it does on its own
            {budget.autoCompactAt !== null ? ` at ≈${formatTokens(budget.autoCompactAt)}` : ' at its compaction point'}, done now instead.
            Early detail then survives only as that summary.
          </p>
          <p className={styles.adviceFine}>{compactCostCopy(engine, tokensLabel)}</p>
          <label className={styles.compactLabel} htmlFor={focusId}>Keep in focus (optional)</label>
          <input id={focusId} className={styles.compactInput} value={focus} maxLength={COMPACT_FOCUS_MAX}
            placeholder="e.g. the login fix and its open TODOs" onChange={(event) => setFocus(event.target.value)} />
          <p className={styles.adviceFine}>
            Sent as the message <code>{compactCommand(focus)}</code>, so it shows in the transcript like any turn.
          </p>
          {blocked ? <p className={styles.adviceFine} role="status">{blocked}</p> : null}
        </div>
        <div className={styles.adviceActions}>
          <button type="submit" className={styles.adviceAction} disabled={blocked !== null || sending}>
            {sending ? 'Sending…' : 'Compact now'}
          </button>
          <button type="button" className={styles.ghost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
