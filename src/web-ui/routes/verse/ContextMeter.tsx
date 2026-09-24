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
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
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
import { CODEX_EXPANSIVE_METERING_NOTE, windowSourceText, type SessionContextBudget } from './verse-model.js';
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
  /**
   * `inline` draws the track in flow (the Context pane) instead of pinned.
   * `ring` (3.10, the chat header) is a 16px occupancy ring plus the
   * percentage — the same figures and the same tooltip, in the room the
   * header has now that the title carries a breadcrumb.
   */
  variant?: 'header' | 'inline' | 'ring';
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
  // An upper bound past the compaction point proves nothing about the real
  // prompt (occupancy() returns tone 'unknown' for it), so no sentence below
  // may read it as "past" anything.
  const boundPast = !occ.exact && occ.untilCompaction === 0;
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
    const left = boundPast
      ? 'the upper bound is past that point, which does not mean the real prompt is'
      : occ.untilCompaction === 0
        ? 'at or past that point now'
        : `${occ.exact ? '' : 'at least '}≈${exactFigure(occ.untilCompaction ?? 0)} left`;
    lines.push(`Auto-compacts at ≈${exactFigure(occ.autoCompactAt)} tokens${modeText} — ${left}.`);
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
    lines.push(`Window: ${props.source ? windowSourceText(props.source, props.engine) : 'source not recorded (an older session)'}.`);
  }
  return {
    tone: occ.tone,
    label,
    compactLabel,
    percent,
    percentLabel: percent === null ? 'n/a' : `${bound}${percent}%`,
    tickPercent,
    fillPercent,
    title: lines.join('\n'),
  };
}

const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

export function ContextMeter({ variant = 'header', ...props }: ContextMeterProps) {
  const d = describeContext(props);
  // aria-valuenow is bounded by aria-valuemax; the over state is carried by
  // the text and data-tone instead of an out-of-range value.
  const valueNow = d.percent === null ? undefined : Math.min(100, d.percent);
  const valueText = `${d.label} (${d.percentLabel})${d.compactLabel ? `, ${d.compactLabel.replace('≈', 'at about ')}` : ''}${d.tone === 'over' ? ', past the window' : ''}`;
  if (variant === 'ring') {
    // The compaction point is a tick on the ring, like on the line.
    const tickAngle = d.tickPercent === null ? null : (d.tickPercent / 100) * 360 - 90;
    return (
      <div className={`${styles.ring} ${styles[`meter-${d.tone}`] ?? ''}`} role="meter" aria-label="Context window"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={valueNow} aria-valuetext={valueText}
        title={d.title} data-tone={d.tone} data-exact={props.exact === false ? 'false' : undefined}>
        <svg className={styles.ringSvg} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle className={styles.ringTrack} cx="8" cy="8" r={RING_R} />
          <circle className={styles.ringFill} cx="8" cy="8" r={RING_R}
            strokeDasharray={`${(d.fillPercent / 100) * RING_C} ${RING_C}`} transform="rotate(-90 8 8)" />
          {tickAngle !== null ? (
            <line className={styles.ringTick} data-testid="compaction-tick"
              x1={8 + Math.cos((tickAngle * Math.PI) / 180) * (RING_R - 2.5)} y1={8 + Math.sin((tickAngle * Math.PI) / 180) * (RING_R - 2.5)}
              x2={8 + Math.cos((tickAngle * Math.PI) / 180) * (RING_R + 1.5)} y2={8 + Math.sin((tickAngle * Math.PI) / 180) * (RING_R + 1.5)} />
          ) : null}
        </svg>
        <span className={styles.ringText}>{d.percentLabel}</span>
      </div>
    );
  }
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

/**
 * The cost sentence both the mode menu and the suggestion chip say, word for
 * word. The ratio is SIZE alone. On codex the provider reportedly also meters
 * requests above its standard window at about 2× against plan limits, so the
 * size ratio is not the ceiling there: the copy says so, in the same
 * sentence the new-chat dialog uses (verse-model CODEX_EXPANSIVE_METERING_NOTE),
 * so the three places that price Expansive cannot disagree.
 */
export function expansiveCostCopy(option: VerseModelOption | null | undefined, engine?: VerseEngine | null): string {
  const ratio = expansiveCostRatio(option);
  const standard = budgetFor(option, 'standard');
  const point = standard ? formatTokens(standard.autoCompactAt ?? standard.contextWindow) : null;
  const codex = engine === 'codex';
  const base = ratio !== null && point !== null
    ? `Every turn re-sends the whole context, so once it grows past ≈${point} each turn costs more usage — up to ≈${ratio}×${codex ? ' by size alone' : ''} near the expansive limit — and recall of early detail weakens with length.`
    : 'Every turn re-sends the whole context, so a larger budget means more usage per turn as it grows.';
  return codex ? `${base} ${CODEX_EXPANSIVE_METERING_NOTE}` : base;
}

/**
 * Switching DOWN to Standard while the chat already holds more than
 * Standard's compaction point is not the free flag flip the rest of the menu
 * describes: the CLI compacts on the very next turn (Claude Code checks its
 * threshold before calling the model; codex falls back to its 244.8k limit),
 * which rewrites the conversation, starts the prompt cache over and — on a
 * paid seat — spends a summarization call. Null when switching is free.
 * `definite` is false for an upper-bound reading: the real prompt MAY be under.
 */
export function standardSwitchCompacts(
  option: VerseModelOption | null | undefined,
  mode: VerseContextMode,
  reading: Pick<SessionContextBudget, 'contextTokens' | 'exact'> | null | undefined,
): { point: number; tokens: number; definite: boolean } | null {
  if (mode !== 'expansive' || !reading) return null;
  const standard = budgetFor(option, 'standard');
  if (!standard) return null;
  const point = standard.autoCompactAt ?? standard.contextWindow;
  if (reading.contextTokens < point) return null;
  return { point, tokens: reading.contextTokens, definite: reading.exact };
}

/**
 * Where the open menu goes, in VIEWPORT coordinates (position: fixed).
 *
 * WHY FIXED, and computed: the chip sits in the right-pinned action cluster,
 * ~119px from the pane's edge, and the menu is up to 380px wide — anchored
 * `right: 0` it started at x = −95 on a 375px screen, and in the app the
 * section's `overflow: hidden` cut it at the rail (x = 56), clipping every
 * label ("rrent", "…of 1M"). Fixed placement escapes that clip; the three
 * cases keep it inside the viewport with a gutter:
 *
 *  1. right-aligned to the chip (the desktop look) when there is room to its left;
 *  2. left-aligned to the chip when there is room to its right instead;
 *  3. otherwise the full width between the gutters (phone widths).
 *
 * Null when there is no layout to measure (a zero-size anchor — jsdom, a
 * hidden header): the stylesheet's absolute placement stands.
 */
export const MODE_MENU_GUTTER = 12;
export const MODE_MENU_MIN_WIDTH = 280;
export const MODE_MENU_MAX_WIDTH = 380;
const MODE_MENU_OFFSET = 8;

export function modeMenuPlacement(
  anchor: Pick<DOMRect, 'left' | 'right' | 'bottom'>,
  viewport: { width: number; height: number },
): CSSProperties | null {
  if (!(viewport.width > 0) || !(anchor.right > anchor.left)) return null;
  const top = Math.round(anchor.bottom + MODE_MENU_OFFSET);
  const common: CSSProperties = {
    position: 'fixed',
    top,
    maxHeight: Math.max(160, Math.round(viewport.height - top - MODE_MENU_GUTTER)),
    overflowY: 'auto',
  };
  const roomLeft = anchor.right - MODE_MENU_GUTTER;
  if (roomLeft >= MODE_MENU_MIN_WIDTH) {
    return { ...common, left: 'auto', right: Math.round(viewport.width - anchor.right), maxWidth: Math.min(MODE_MENU_MAX_WIDTH, Math.floor(roomLeft)) };
  }
  const roomRight = viewport.width - MODE_MENU_GUTTER - anchor.left;
  if (roomRight >= MODE_MENU_MIN_WIDTH) {
    return { ...common, left: Math.round(anchor.left), right: 'auto', maxWidth: Math.min(MODE_MENU_MAX_WIDTH, Math.floor(roomRight)) };
  }
  return { ...common, left: MODE_MENU_GUTTER, right: MODE_MENU_GUTTER, width: 'auto', minWidth: 0, maxWidth: 'none' };
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
  /** Why "Compact now…" cannot run yet (no turns), shown on the disabled item. */
  compactUnavailableReason?: string | null;
  /**
   * False → this model has ONE budget (a 200k Claude model, a local seat): the
   * chip reads "Context" and its menu carries only "Compact now…", so a manual
   * compaction is reachable on demand on every engine that can do one, not
   * only from the handoff banner once it appears. Default true.
   */
  modesAvailable?: boolean;
  engine?: VerseEngine | null;
  /** The session's current reading and budget — the downgrade warning and the one-budget summary read it. */
  budget?: Pick<SessionContextBudget, 'contextTokens' | 'exact' | 'contextWindow' | 'autoCompactAt'> | null;
}

/**
 * The context chip beside the meter and its menu. With a real expansive
 * budget (or a session already in expansive, so it can always switch back)
 * it is the Standard / Expansive control; for a claude/local chat without
 * one it is a "Context" menu holding "Compact now…". Changing mode is an
 * explicit click — Verse never switches it on its own — and applies from the
 * NEXT turn: it changes CLI flags only, never prompt content, so the prompt
 * cache holds — EXCEPT a switch down to Standard while the chat is already
 * past Standard's compaction point, which compacts on the next turn and is
 * said so in the menu (standardSwitchCompacts).
 */
export function ContextModeControl({ mode, option, disabled = false, disabledReason = null, busy = false, error = null, onChange, onCompact,
  compactUnavailableReason = null, modesAvailable = true, engine = null, budget = null }: ContextModeControlProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const expansiveAvailable = hasExpansiveMode(option);
  const downgrade = modesAvailable ? standardSwitchCompacts(option, mode, budget) : null;
  const who = engine ? COMPACTOR[engine] : 'The CLI';

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

  // Placed before paint (no flash at the clipped spot) and again on resize.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      setPlacement(rect ? modeMenuPlacement(rect, { width: window.innerWidth, height: window.innerHeight }) : null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The current mode first; a one-budget menu has no radios, so its first
    // enabled item; and when even that is disabled, the menu itself, so
    // focus never falls to <body>.
    const target = wrap.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
      ?? wrap.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]:not(:disabled)')
      ?? menu.current;
    target?.focus();
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

  const compact = () => {
    setOpen(false);
    // Focus goes back to the chip BEFORE the panel opens: the panel takes it
    // into its own field and, on close, hands it back to whatever held it —
    // the chip — instead of both ending on <body> with the unmounted item.
    button.current?.focus();
    onCompact?.();
  };

  // What changes on a mode switch, per CLI: Claude Code takes one flag
  // (--autocompact); codex takes a window AND a compaction limit.
  const flagChange = engine === 'codex'
    ? "The CLI's window and compaction settings change"
    : "Only the CLI's compaction flag changes";
  const oneBudgetPoint = budget?.autoCompactAt ?? null;
  const chipLabel = modesAvailable ? CONTEXT_MODE_LABEL[mode] : 'Context';
  const ariaLabel = modesAvailable ? `Context mode: ${CONTEXT_MODE_LABEL[mode]}` : 'Context actions';
  const chipTitle = disabled && disabledReason
    ? disabledReason
    : modesAvailable
      ? `Context mode: ${CONTEXT_MODE_LABEL[mode]} — ${modeDetail(option, mode)}`
      : 'Context: this model has one budget — open to compact the chat now';

  return (
    <div ref={wrap} className={styles.modeWrap}>
      <button ref={button} type="button" className={styles.modeChip} data-mode={modesAvailable ? mode : undefined}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel} disabled={disabled} title={chipTitle}
        onClick={() => setOpen((v) => !v)}>
        {busy ? 'Switching…' : chipLabel}
      </button>
      {open ? (
        <div ref={menu} id={menuId} role="menu" aria-label={modesAvailable ? 'Context mode' : 'Context'} className={styles.modeMenu}
          style={placement ?? undefined} data-placement={placement ? 'fixed' : undefined} tabIndex={-1} onKeyDown={onMenuKey}>
          {modesAvailable ? (
            <>
              <p className={styles.modeMenuHeading}>How much context this chat may hold before the CLI compacts</p>
              {(['standard', 'expansive'] as const).map((m) => {
                const unavailable = m === 'expansive' && !expansiveAvailable;
                const compactsNext = m === 'standard' && downgrade !== null
                  ? ` · ${downgrade.definite ? 'compacts' : 'may compact'} on the next turn`
                  : '';
                return (
                  <button key={m} type="button" role="menuitemradio" aria-checked={mode === m} className={styles.modeItem}
                    disabled={unavailable || busy} onClick={() => choose(m)}>
                    <span className={styles.modeItemPrimary}>{CONTEXT_MODE_LABEL[m]}{mode === m ? ' · current' : ''}</span>
                    <span className={styles.modeItemSecondary}>
                      {m === 'standard'
                        ? `${modeDetail(option, 'standard')} · lower usage per turn, sharper recall${compactsNext}`
                        : unavailable ? 'not available for this model on this seat' : `${modeDetail(option, 'expansive')} · the full native window`}
                    </span>
                  </button>
                );
              })}
              <p className={styles.modeMenuNote}>{expansiveCostCopy(option, engine)}</p>
              {downgrade ? (
                <>
                  <p className={styles.modeMenuNote}>Applies from the next turn.</p>
                  <p className={styles.modeMenuWarn} data-testid="standard-compacts">
                    {downgrade.definite
                      ? `This chat holds ≈${formatTokens(downgrade.tokens)} — past Standard's ≈${formatTokens(downgrade.point)} compaction point, so switching to Standard makes ${who} compact on the next turn`
                      : `This chat holds up to ≈${formatTokens(downgrade.tokens)}. If the real prompt is past Standard's ≈${formatTokens(downgrade.point)} compaction point, switching to Standard makes ${who} compact on the next turn`}
                    {engine === 'local' ? '' : ': one summarization call that spends usage on this seat'}. The conversation is replaced by a summary and its prompt cache starts over.
                  </p>
                </>
              ) : (
                <p className={styles.modeMenuNote}>
                  Applies from the next turn. {flagChange} — the conversation and its prompt cache are kept.
                </p>
              )}
            </>
          ) : (
            <p className={styles.modeMenuHeading}>
              {oneBudgetPoint !== null
                ? `${who} compacts this chat on its own at ≈${formatTokens(oneBudgetPoint)}${budget?.contextWindow ? ` of ${formatTokens(budget.contextWindow)}` : ''}. This model has one context budget.`
                : 'This model has one context budget; the CLI compacts at its own point.'}
            </p>
          )}
          {onCompact ? (
            <button type="button" role="menuitem" className={`${styles.modeItem} ${modesAvailable ? styles.modeItemAction : ''}`}
              disabled={busy || compactUnavailableReason !== null} onClick={compact}>
              <span className={styles.modeItemPrimary}>Compact now…</span>
              <span className={styles.modeItemSecondary}>
                {compactUnavailableReason ?? 'summarize the conversation so far instead of waiting for the CLI to'}
              </span>
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

/**
 * The handoff verdict for a session, from the SAME budget the meter draws.
 *
 * `lastTurnAt` is the last time the chat talked to its provider (verse-store
 * `lastTurnActivityAt`), NOT `session.updatedAt`: a rename or a mode switch
 * bumps `updatedAt` without warming the provider's cache, and measuring idle
 * time from it silenced "the prompt cache has likely expired" for another
 * hour while the next turn still re-read everything uncached.
 */
export function sessionHandoffAdvice(
  session: Pick<VerseSession, 'usage' | 'compactionCount' | 'status'>,
  budget: SessionContextBudget,
  now: number,
  lastTurnAt: string | null = null,
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
    lastActivityAt: session.status === 'running' ? null : lastTurnAt,
    now,
  });
}

/**
 * Whether ContextAdvice would show anything — the SAME rules, without
 * rendering. The notice slot (chat/NoticeSlot) needs to know before it picks
 * which one notice to show.
 */
export function contextAdviceVisible(
  session: VerseSession,
  budget: SessionContextBudget,
  modesAvailable: boolean,
  now: number,
  lastTurnAt: string | null = null,
): boolean {
  const handoff = sessionHandoffAdvice(session, budget, now, lastTurnAt);
  const compactions = session.compactionCount ?? 0;
  if (handoff.level !== 'none' && !isVerseAdviceDismissed(session.id, `handoff:${handoff.level}:${compactions}`)) return true;
  if (!modesAvailable) return false;
  return expansiveAdvice({ session, option: budget.option }).suggest && !isVerseAdviceDismissed(session.id, `expansive:${compactions}`);
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
  /**
   * When the chat last talked to its provider (verse-store
   * `lastTurnActivityAt`); null/absent → no idle-cache reason.
   */
  lastTurnAt?: string | null;
  /** Injectable clock for tests. */
  now?: number;
  /** 3.10: rendered inside the notice slot, which owns the column and spacing. */
  embedded?: boolean;
  /** Called after "Not now" hides a note, so a parent that decides visibility re-checks. */
  onDismiss?: () => void;
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
export function ContextAdvice({ session, budget, modesAvailable, dispatchEnabled, modeBusy = false, onHandoff, onSwitchExpansive, onCompact,
  lastTurnAt = null, now: injectedNow, embedded = false, onDismiss }: ContextAdviceProps) {
  const now = useNow(ADVICE_TICK_MS, injectedNow);
  const [, bump] = useState(0);
  const handoff = sessionHandoffAdvice(session, budget, now, lastTurnAt);
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
    onDismiss?.();
  };
  const idleExpired = lastTurnAt && !running ? now - Date.parse(lastTurnAt) >= CACHE_IDLE_TTL_MS : false;

  return (
    <div className={embedded ? styles.adviceStack : styles.advice}>
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
            <p className={styles.adviceFine}>{expansive.reason} {expansiveCostCopy(budget.option, session.engine)}</p>
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
  /**
   * Take keyboard focus into the focus field on mount (default true: the
   * panel only ever opens on a click or a menu choice). On unmount focus goes
   * back to whatever held it before — the chip or the banner button — when
   * nothing else has claimed it.
   */
  autoFocus?: boolean;
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
export function CompactPanel({ engine, budget, running, dispatchEnabled, empty, onSend, onClose, autoFocus = true }: CompactPanelProps) {
  const [focus, setFocus] = useState('');
  const [sending, setSending] = useState(false);
  const focusId = useId();
  const input = useRef<HTMLInputElement>(null);

  // Opened from the mode menu, the focused menu item unmounts with the menu;
  // without this, keyboard focus fell to <body> and a screen reader heard
  // nothing about the panel that appeared.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    input.current?.focus();
    return () => {
      const active = document.activeElement;
      const stranded = active === null || active === document.body || !active.isConnected;
      if (stranded && previous?.isConnected) previous.focus();
    };
  }, [autoFocus]);
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
          <input ref={input} id={focusId} className={styles.compactInput} value={focus} maxLength={COMPACT_FOCUS_MAX}
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
