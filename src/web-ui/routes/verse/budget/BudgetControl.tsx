/**
 * routes/verse/budget/BudgetControl.tsx — budget modes, per-seat reserves and
 * live headroom, in one panel.
 *
 *   ┌ Budget ─────────────────────────── 3 of 7 seats can take autonomous work
 *   │ [ Reserve | Balanced | All-in ]   Autonomy stops at each seat's reserve…
 *   │ Next medium task → Grok · why
 *   │ ● Claude Code        Eligible                          Autonomy [on]
 *   │   Weekly  ███████▒▒▒▒▒▒▒▒░░░░░░░░░  20% used · stops at 60%
 *   │   5-hour  ███▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░  15% used · stops at 70%
 *   │   Kept for you ──●──── 40%     5-hour ceiling ─────●── 70%
 *   │   40% of the weekly window is left for autonomy (40% kept for you).
 *
 * Each bar reads left to right: what is USED (solid), what autonomy may
 * still use (tinted), and the band KEPT FOR MASON (hatched) past the ceiling
 * tick. An unread window is a dashed track and the words "no reading" —
 * never an empty bar (which would claim headroom) or a full one.
 *
 * `BudgetControlView` is pure (props in, callbacks out) and is what the tests
 * render; `BudgetControl` wires it to the API, the mutation-token gate and a
 * 60 s refresh while the document is visible.
 *
 * Mount point: a Track B surface (Command home / Autonomy) owns placement —
 * this file only exports the panel.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { BudgetMode, SeatDecision } from '../../../../core/routing/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { Slider } from '../../../components/primitives/Slider.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { EngineMarker } from '../../../components/primitives/Tag.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import {
  BUDGET_MODE_OPTIONS,
  buildBudgetRows,
  budgetSummary,
  clampPercent,
  readingAge,
  STATUS_WORDS,
  type BudgetBar,
  type BudgetSeatRow,
} from './budget-model.js';
import { budgetPreviewQuery, budgetQuery, updateBudget, type BudgetSeatPatchWire } from './budget-queries.js';
import styles from './BudgetControl.module.css';

/** Headroom moves with the collector (30 s cycle); a minute is plenty for a settings panel. */
export const BUDGET_POLL_MS = 60_000;
/** Slider changes are committed this long after the last movement. */
export const BUDGET_COMMIT_DELAY_MS = 450;

// ---------------------------------------------------------------------------
// Headroom bar
// ---------------------------------------------------------------------------

function HeadroomBar({ bar }: { bar: BudgetBar }) {
  const used = bar.usedPercent;
  const ceiling = clampPercent(bar.ceilingPercent);
  if (used === null) {
    return (
      <div className={styles.bar} data-binding={bar.binding || undefined}>
        <span className={styles.barLabel}>{bar.label}</span>
        <div className={styles.trackUnknown} role="img" aria-label={bar.description} />
        <span className={`${styles.barValue} ${styles.unknown}`}>no reading</span>
      </div>
    );
  }
  const usedPct = clampPercent(used);
  const over = usedPct >= ceiling;
  return (
    <div className={styles.bar} data-binding={bar.binding || undefined}>
      <span className={styles.barLabel}>
        {bar.label}
        {bar.binding ? <span className={styles.bindingMark} title="This window limits autonomy right now">binding</span> : null}
      </span>
      <div className={styles.track} role="img" aria-label={bar.description}>
        {ceiling < 100 ? (
          <div className={styles.reserveBand} style={{ left: `${ceiling}%`, width: `${100 - ceiling}%` }} />
        ) : null}
        {!over ? (
          <div className={styles.room} style={{ left: `${usedPct}%`, width: `${ceiling - usedPct}%` }} />
        ) : null}
        <div className={styles.used} data-over={over || undefined} style={{ width: `${usedPct}%` }} />
        {ceiling < 100 ? <div className={styles.ceiling} style={{ left: `${ceiling}%` }} /> : null}
      </div>
      <span className={styles.barValue}>
        {usedPct}% used{ceiling < 100 ? ` · stops at ${ceiling}%` : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft slider — commits after the hand leaves it
// ---------------------------------------------------------------------------

function useCommittedDraft(serverValue: number, commit: (value: number) => void): [number, (v: number) => void] {
  const [draft, setDraft] = useState(serverValue);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // A new server value wins unless the operator is mid-drag.
  useEffect(() => {
    if (!dirty.current) setDraft(serverValue);
  }, [serverValue]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const change = useCallback((value: number) => {
    setDraft(value);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      dirty.current = false;
      timer.current = null;
      commitRef.current(value);
    }, BUDGET_COMMIT_DELAY_MS);
  }, []);

  return [draft, change];
}

// ---------------------------------------------------------------------------
// One seat
// ---------------------------------------------------------------------------

interface SeatRowProps {
  row: BudgetSeatRow;
  saving: boolean;
  readOnly: boolean;
  onSeat: (seatId: string, patch: BudgetSeatPatchWire) => void;
}

function SeatRow({ row, saving, readOnly, onSeat }: SeatRowProps) {
  const headingId = useId();
  const reserveServer = row.policy.reservePercent;
  const sessionServer = row.policy.maxSessionWindowPercent ?? 100;
  const [reserve, setReserve] = useCommittedDraft(reserveServer, (v) => {
    if (v !== reserveServer) onSeat(row.seatId, { reservePercent: v });
  });
  const [session, setSession] = useCommittedDraft(sessionServer, (v) => {
    if (v !== sessionServer) onSeat(row.seatId, { maxSessionWindowPercent: v >= 100 ? null : v });
  });
  const disabled = readOnly || saving;

  return (
    <li className={styles.seat} aria-labelledby={headingId} data-status={row.status} aria-busy={saving || undefined}>
      <div className={styles.seatHead}>
        <EngineMarker engine={row.engine} className={styles.marker} />
        <span id={headingId} className={styles.seatName}>{row.label}</span>
        <span className={styles.status} data-status={row.status}>{STATUS_WORDS[row.status]}</span>
        {row.free ? <span className={styles.free}>free</span> : null}
        <Switch
          className={styles.toggle}
          checked={row.policy.enabled}
          disabled={disabled}
          aria-label={`Autonomy on ${row.label}`}
          label="Autonomy"
          onChange={(next) => onSeat(row.seatId, { enabled: next })}
        />
      </div>

      {row.bars.length > 0 ? (
        <div className={styles.bars}>
          {row.bars.map((bar) => <HeadroomBar key={bar.kind} bar={bar} />)}
        </div>
      ) : row.free ? (
        <p className={styles.freeLine}>No usage window — local models cost nothing and are never held back for you.</p>
      ) : null}

      {!row.free && row.policy.enabled ? (
        <div className={styles.controls}>
          <Slider
            label="Kept for you"
            min={0}
            max={100}
            step={5}
            value={reserve}
            disabled={disabled}
            valueLabel={`${reserve}%`}
            valueText={`${reserve} percent of the ${row.engine === 'grok' ? 'billing period' : 'weekly window'} kept for you`}
            onChange={(e) => setReserve(clampPercent(Number(e.currentTarget.value)))}
          />
          {row.hasSessionCeiling ? (
            <Slider
              label="5-hour ceiling"
              min={10}
              max={100}
              step={5}
              value={session}
              disabled={disabled}
              valueLabel={session >= 100 ? 'none' : `${session}%`}
              valueText={session >= 100 ? 'no 5-hour ceiling' : `autonomy stops at ${session} percent of the 5-hour window`}
              onChange={(e) => setSession(clampPercent(Number(e.currentTarget.value), 10, 100))}
            />
          ) : null}
        </div>
      ) : null}

      <p className={styles.why}>{row.why}</p>
      {row.more.length > 0 ? (
        <details className={styles.more}>
          <summary>{row.more.length === 1 ? '1 more note' : `${row.more.length} more notes`}</summary>
          <ul>
            {row.more.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Pure view
// ---------------------------------------------------------------------------

export interface BudgetControlViewProps {
  view: BudgetView;
  preview: SeatDecision | null;
  nowMs: number;
  /** `'mode'` or a seat id while its change is in flight. */
  pending: string | null;
  error: string | null;
  readOnly?: boolean;
  onMode: (mode: BudgetMode) => void;
  onSeat: (seatId: string, patch: BudgetSeatPatchWire) => void;
}

export function BudgetControlView({ view, preview, nowMs, pending, error, readOnly = false, onMode, onSeat }: BudgetControlViewProps) {
  const titleId = useId();
  const rows = buildBudgetRows(view);
  const summary = budgetSummary(rows);
  const mode = BUDGET_MODE_OPTIONS.find((o) => o.value === view.mode) ?? BUDGET_MODE_OPTIONS[1]!;
  const chosen = preview?.seatId ? rows.find((r) => r.seatId === preview.seatId) : null;

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>Budget</h2>
        <p className={styles.summary}>{summary.sentence}</p>
        <span className={styles.age}>Readings {readingAge(view.sampledAt, nowMs)}</span>
      </header>

      <div className={styles.mode}>
        <Segmented
          aria-label="Budget mode"
          options={BUDGET_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, disabled: readOnly || pending !== null }))}
          value={view.mode}
          onChange={(next) => { if (next !== view.mode) onMode(next); }}
        />
        <p className={styles.modeText}>{mode.description}</p>
      </div>

      {preview ? (
        <p className={styles.preview} aria-live="polite">
          <span className={styles.previewLead}>Next medium task →</span>{' '}
          <strong>{chosen?.label ?? (preview.seatId ?? 'nowhere right now')}</strong>
          <span className={styles.previewWhy}>{preview.why}</span>
        </p>
      ) : null}

      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {rows.length === 0 ? (
        <p className={styles.empty}>No seats yet — connect an account or start Ollama, and they appear here.</p>
      ) : (
        <ul className={styles.seats}>
          {rows.map((row) => (
            <SeatRow key={row.seatId} row={row} saving={pending === row.seatId || pending === 'mode'} readOnly={readOnly} onSeat={onSeat} />
          ))}
        </ul>
      )}

      <p className={styles.footnote}>
        Reserves apply to autonomous work only — your own chats can always use a seat. Unknown usage is never treated as
        headroom: a seat with no reading, or one older than {Math.round(view.readingMaxAgeMs / 60_000)} minutes, is held back.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connected panel
// ---------------------------------------------------------------------------

export function BudgetControl() {
  const budget = useQuery(budgetQuery, { freshMs: 0 });
  const preview = useQuery(budgetPreviewQuery, { freshMs: 0 });
  const refetchBudget = useRefetch(budgetQuery);
  const refetchPreview = useRefetch(budgetPreviewQuery);
  const gate = useTokenGate();
  const [latest, setLatest] = useState<BudgetView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Poll while visible; read immediately on return (useSeatsRefresh's pattern).
  useEffect(() => {
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refetchBudget();
      refetchPreview();
      setNowMs(Date.now());
    };
    const timer = window.setInterval(tick, BUDGET_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refetchBudget, refetchPreview]);

  // The POST response is newer than the cached read until the refetch lands.
  const cached = budget.data;
  const view = latest && (!cached || Date.parse(latest.sampledAt) >= Date.parse(cached.sampledAt)) ? latest : cached;

  const apply = useCallback(async (key: string, reason: string, update: Parameters<typeof updateBudget>[0]) => {
    setPending(key);
    setError(null);
    try {
      const next = await gate.run(reason, () => updateBudget(update));
      if (next) setLatest(next);
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setPending(null);
      setNowMs(Date.now());
    }
  }, [gate]);

  if (!view) {
    return (
      <section className={styles.panel} aria-label="Budget">
        {budget.status === 'error' ? (
          <p className={styles.error} role="alert">Budget unavailable: {budget.error?.message ?? 'the request failed.'}</p>
        ) : (
          <p className={styles.loading}>Reading seat usage…</p>
        )}
      </section>
    );
  }

  return (
    <>
      <BudgetControlView
        view={view}
        preview={preview.data ?? null}
        nowMs={nowMs}
        pending={pending}
        error={error}
        onMode={(mode) => void apply('mode', `Switch the budget to ${mode}`, { mode })}
        onSeat={(seatId, patch) => void apply(seatId, `Change the budget for ${seatId}`, { seatId, policy: patch })}
      />
      <MutationTokenDialog open={gate.dialog.open} reason={gate.dialog.reason} tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed" onClose={gate.dialog.onClose} onUnlocked={gate.dialog.onUnlocked} />
    </>
  );
}
