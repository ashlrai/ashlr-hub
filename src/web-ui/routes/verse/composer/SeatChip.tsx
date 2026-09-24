/**
 * routes/verse/composer/SeatChip.tsx — the seat this chat runs on, in the
 * composer footer (SPEC-310C §2 "Seat chip"; unit C3).
 *
 *   [C] Claude Max ◔          [L] Local
 *
 * - The chip names the SEAT (the account: "Claude Max", or "Local" for a
 *   local model, whose seat label is the model's own name); the model sits
 *   beside it in the Model picker, so the footer never says the model twice.
 * - The monogram tile (C/X/G/L, never a vendor logo) carries the engine's
 *   identity tick; the ring is the SHORT window's use (5-hour where the
 *   provider reports one, else the binding window), drawn in the quantity
 *   ramp — never the accent — and switched to the status colours only past
 *   the tight / limit points, always with words in the tooltip. A seat with
 *   no reading (and every local seat: no limits) draws NO ring — an empty
 *   circle said nothing and read as a stuck spinner.
 * - Hover or focus shows plan, every window with its reset, health, and what
 *   autonomy may take from this seat ("autonomy may use 60% · 40% reserved"),
 *   read from the Budget route (A9) only while the tooltip is open.
 * - Click opens the menu: "Continue on ‹seat›" (a prefilled handoff when the
 *   owner wires it; a new chat otherwise), a new chat on this seat, and
 *   Budget mode ▸ (A9's BudgetControl, loaded on demand).
 *
 * A chat is bound to its seat; nothing here mutates the chat's seat.
 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { useQuery } from '../../../data/hooks.js';
import type { VerseSeat } from '../../../data/api-types.js';
import type { VerseSeatWindow } from '../../../../core/verse/types.js';
import { ENGINE_MONOGRAM } from '../../../../core/verse/workbench-types.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { useSeatHealth } from '../health/useSeatHealth.js';
import { capacityRowFor, windowSentence } from '../usage/capacity-strip-model.js';
import type { SeatChoice } from '../SeatSelector.js';
import { firstRunnableModel, seatCapacity, SEAT_CAPACITY_WORD, seatWindowLabel } from '../verse-model.js';
import styles from './composer.module.css';

const BudgetControl = lazy(async () => ({ default: (await import('../budget/BudgetControl.js')).BudgetControl }));

export interface SeatChipProps {
  seats: readonly VerseSeat[];
  seat: SeatChoice;
  engine: VerseSeat['engine'];
  /** The chat's full seat label ("Claude Max · Opus 5.5") — the tooltip and menu heading. */
  label: string;
  /** What the chip itself says ("Claude Max", "Local"). Default: `label`. */
  name?: string;
  disabled?: boolean;
  /** Collapse to monogram + ring (the 375 footer). */
  compact?: boolean;
  /** "Continue on ‹seat›": a handoff prefilled for that seat. Falls back to onNewChat. */
  onContinueOn?: (choice: SeatChoice) => void;
  onNewChat: (choice: SeatChoice) => void;
}

/**
 * Every window the seat reported: the capacity record's when the server built
 * one, else the older `health.windows` (same ids and honesty rules, fewer
 * fields). Never invented: a seat with neither has no windows.
 */
export function seatWindows(seat: VerseSeat | undefined): VerseSeatWindow[] {
  const fromCapacity = seat?.capacity?.windows ?? [];
  if (fromCapacity.length > 0) return fromCapacity;
  return (seat?.health.windows ?? []).map((w) => ({
    id: w.id,
    usedPercent: typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null,
    resetsAt: w.resetsAt,
    resetDescription: null,
    limitReached: false,
    measured: typeof w.usedPercent === 'number',
  }));
}

/** The window the ring draws: the 5-hour one when reported, else the fullest one. */
export function ringWindow(seat: VerseSeat | undefined): VerseSeatWindow | null {
  const windows = seatWindows(seat).filter((w) => w.usedPercent !== null || w.limitReached);
  const short = windows.find((w) => w.id === 'five_hour');
  if (short) return short;
  if (seat?.capacity?.binding) return seat.capacity.binding;
  return windows.reduce<VerseSeatWindow | null>((top, w) => (top === null || (w.usedPercent ?? 100) > (top.usedPercent ?? 100) ? w : top), null);
}

function ringTone(reading: VerseSeatWindow | null): 'unknown' | 'ok' | 'tight' | 'limit' {
  if (reading?.limitReached) return 'limit';
  if (!reading || reading.usedPercent === null) return 'unknown';
  if (reading.usedPercent >= 100) return 'limit';
  if (reading.usedPercent >= 85) return 'tight';
  return 'ok';
}

export function CapacityRing({ window: reading, size = 14 }: { window: VerseSeatWindow | null; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  // A spent window is a full ring even when the provider gave no percentage.
  const pct = reading?.limitReached ? 100 : reading?.usedPercent ?? null;
  const shown = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <svg className={styles.ring} data-tone={ringTone(reading)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className={styles.ringTrack} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2" />
      {pct === null ? null : (
        <circle className={styles.ringFill} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2"
          strokeDasharray={`${(shown / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="round" />
      )}
    </svg>
  );
}

function windowLine(reading: VerseSeatWindow): string {
  const label = seatWindowLabel(reading.id);
  const used = reading.limitReached ? 'limit reached' : reading.usedPercent === null ? 'no reading' : `${Math.round(reading.usedPercent)}% used`;
  const reset = reading.resetDescription ?? (reading.resetsAt ? `resets ${new Date(reading.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : null);
  return `${label}: ${used}${reset ? ` · ${reset}` : ''}`;
}

/** "Autonomy may use 60% · 40% reserved for you", from the budget route's effective policy. */
function budgetSentence(budget: BudgetView | null, seatId: string, status: string): { text: string; muted: boolean } {
  const policy = budget?.effective?.[seatId];
  if (!policy) return { text: status === 'error' ? 'Budget: no reading' : 'Budget: loading…', muted: true };
  if (!policy.enabled) return { text: 'Autonomy never uses this seat — it is all yours.', muted: false };
  const reserve = Math.max(0, Math.min(100, Math.round(policy.reservePercent)));
  return { text: `Autonomy may use ${100 - reserve}% · ${reserve}% reserved for you`, muted: false };
}

/**
 * The detail bubble. Its facts come from THE shared capacity row
 * (usage/capacity-strip-model `capacityRowFor`, C6) — the same projection
 * Apps & Accounts, Usage and the new-chat dialog draw — so the chip can never
 * describe a seat differently from them. Health (A2) and budget (A9) are the
 * app-wide cached reads, fetched only while this bubble is open.
 */
function SeatTooltip({ seats, seat, label }: { seats: readonly VerseSeat[]; seat: VerseSeat | undefined; label: string }) {
  const budget = useQuery(budgetQuery);
  const health = useSeatHealth();
  const row = seat ? capacityRowFor(seats, seat.id, { health: health.data?.seats ?? null, budget: budget.data ?? null }) : null;
  // The shared row's windows (label, %, verbatim reset, the reserve on the
  // binding one); before the roster has a row, the seat record's own.
  const windows: Array<{ id: string; line: string }> = row
    ? row.windows.map((w) => ({ id: w.id, line: windowSentence({ label: '' }, w, w.binding ? row.reserve?.percent ?? null : null).trimStart() }))
    : seatWindows(seat).map((w) => ({ id: w.id, line: windowLine(w) }));
  const budgetLine = seat && seat.engine !== 'local' ? budgetSentence(budget.data ?? null, seat.id, budget.status) : null;
  return (
    <span className={styles.tip}>
      <strong>{label}</strong>
      {row?.plan ?? seat?.capacity?.planType ? <span>Plan: {row?.plan ?? seat?.capacity?.planType}</span> : null}
      {windows.length > 0
        ? windows.map((w) => <span key={w.id}>{w.line}</span>)
        : <span className={styles.tipMuted}>No capacity reading yet</span>}
      {row ? (
        <span>
          Health: {row.word}
          {row.connection && row.connection.connection !== 'connected' && row.connection.connection !== 'unknown' ? ` · ${row.connection.word}` : ''}
          {row.summary ? ` — ${row.summary}` : ''}
        </span>
      ) : null}
      {budgetLine ? <span className={budgetLine.muted ? styles.tipMuted : undefined}>{budgetLine.text}</span> : null}
      {seat && seat.engine === 'local' ? <span>Local — no usage limits</span> : null}
    </span>
  );
}

export function SeatChip({ seats, seat, engine, label, name = label, disabled = false, compact = false, onContinueOn, onNewChat }: SeatChipProps) {
  const [open, setOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  // The detail bubble is this component's own (not the Tooltip primitive):
  // it must hide while the menu is open, and toggling the primitive's
  // `disabled` swaps its wrapper and remounts the button under the pointer.
  const [tipOpen, setTipOpen] = useState(false);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const budgetTitleId = useId();
  const current = seats.find((s) => s.id === seat.seatId);
  const ring = engine === 'local' ? null : ringWindow(current);
  const others = seats.filter((s) => s.id !== seat.seatId && s.health.state !== 'unavailable' && firstRunnableModel(s) !== null);
  const ringText = ring && (ring.usedPercent !== null || ring.limitReached)
    ? `${seatWindowLabel(ring.id)} ${ring.limitReached ? 'limit reached' : `${Math.round(ring.usedPercent ?? 0)}% used`}`
    : engine === 'local' ? 'no usage limits' : 'no capacity reading';

  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current); }, []);

  function showTip(delayed: boolean) {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    if (!delayed) {
      setTipOpen(true);
      return;
    }
    tipTimer.current = setTimeout(() => setTipOpen(true), 200);
  }

  function hideTip() {
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTipOpen(false);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      items[(next + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  function pick(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div ref={wrap} className={`${styles.seatChipWrap} ${styles[`engine-${engine}`] ?? ''}`}>
      <button ref={button} type="button" className={`${styles.seatChip} ${compact ? styles.seatChipCompact : ''}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
        aria-label={`Seat: ${name}, ${ringText}`}
        aria-describedby={tipOpen && !open ? tipId : undefined}
        onMouseEnter={() => showTip(true)} onMouseLeave={hideTip}
        onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showTip(false); }} onBlur={hideTip}
        onKeyDown={(event) => { if (event.key === 'Escape' && tipOpen && !open) { event.stopPropagation(); hideTip(); } }}
        onClick={() => { hideTip(); setOpen((v) => !v); }}>
        <span className={styles.monogram} aria-hidden="true">{ENGINE_MONOGRAM[engine]}</span>
        {compact ? null : <span className={styles.seatChipText}>{name}</span>}
        {ringTone(ring) === 'unknown' ? null : <CapacityRing window={ring} />}
      </button>
      {tipOpen && !open ? (
        <span id={tipId} role="tooltip" className={styles.seatTip}>
          <SeatTooltip seats={seats} seat={current} label={label} />
        </span>
      ) : null}
      {open ? (
        <div id={menuId} role="menu" aria-label="Seat" className={`${styles.menu} ${styles.menuWide}`} onKeyDown={onMenuKey}>
          <p className={styles.menuHeading}><span>This chat runs on <strong>{label}</strong></span></p>
          {others.map((s) => {
            const model = firstRunnableModel(s)!;
            const cap = seatCapacity(s);
            return (
              <button key={s.id} type="button" role="menuitem" className={`${styles.menuItem} ${styles[`engine-${s.engine}`] ?? ''}`}
                data-capacity={cap.cls}
                onClick={() => pick(() => (onContinueOn ?? onNewChat)({ seatId: s.id, model: model.id }))}>
                <span className={styles.monogram} aria-hidden="true">{ENGINE_MONOGRAM[s.engine]}</span>
                <span className={styles.menuText}>
                  <span className={styles.menuLabel}>{onContinueOn ? 'Continue on' : 'New chat on'} {s.label}</span>
                  <span className={styles.menuDesc}>{model.label}{cap.cls === 'unread' ? '' : ` · ${SEAT_CAPACITY_WORD[cap.cls]}, ${cap.text}`}</span>
                </span>
              </button>
            );
          })}
          {others.length === 0 ? <p className={styles.menuNote}>No other seat can take this chat right now.</p> : null}
          <div className={styles.menuSeparator} role="separator" />
          <button type="button" role="menuitem" className={styles.menuItem}
            onClick={() => pick(() => onNewChat({ seatId: seat.seatId, model: seat.model }))}>
            <span className={styles.menuCheck} aria-hidden="true" />
            <span className={styles.menuText}><span className={styles.menuLabel}>New chat on this seat</span></span>
          </button>
          {engine !== 'local' ? (
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => pick(() => setBudgetOpen(true))}>
              <span className={styles.menuCheck} aria-hidden="true" />
              <span className={styles.menuText}>
                <span className={styles.menuLabel}>Budget mode…</span>
                <span className={styles.menuDesc}>How much of this seat autonomy may use</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      <Dialog open={budgetOpen} onClose={() => setBudgetOpen(false)} titleId={budgetTitleId} title="Budget mode" widthClassName={styles.budgetDialog}
        description="What autonomy may spend on each seat, and what stays reserved for your own chats.">
        {budgetOpen ? (
          <Suspense fallback={<p className={styles.menuNote}>Loading budget…</p>}>
            <BudgetControl />
          </Suspense>
        ) : null}
      </Dialog>
    </div>
  );
}
