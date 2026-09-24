/**
 * routes/verse/usage/CapacityStrip.tsx — THE capacity view (SPEC-310C §4:
 * "Resources, NewChatDialog and onboarding drop their own capacity views and
 * import usage/CapacityStrip instead"). Apps & Accounts and Usage render it
 * too, so every surface answers "how much of each seat is left" the same way.
 *
 *   [C] Claude Max · max            ● connected                 [actions]
 *       usable · 62% of 5-hour window used
 *       5-hour window  ▇▇▇▇▇▇▇░░░░│▨▨▨  62%   resets 7pm
 *       weekly window  ▇▇▇░░░░░░░░│▨▨▨  40%   resets Thu
 *       Reserved for you 40% · Autonomy: Eligible
 *
 * Each bar reads left to right: used (solid), what autonomy may still use
 * (track), and the band KEPT FOR YOU (hatched) past a tick at 100 − reserve —
 * so "Reserved for you 40%" is something you can see, not just read. The
 * reserve applies to the binding window; the other windows carry no tick.
 *
 * Honesty (docs/VERSE-TELEMETRY-V2.md), enforced by the model and kept here:
 *   - no reading → a dashed track and the words "no reading", never a 0% bar;
 *   - a flagged limit → "limit reached", never "100%";
 *   - reset prose is printed verbatim, never turned into a countdown;
 *   - every state is a WORD first; colour only reinforces it.
 *
 * Three entry points:
 *   <CapacityStrip seats health? budget? …/>   pure: props in, markup out;
 *   <LiveCapacityStrip …/>                      reads the shared caches itself
 *                                               (bootstrap seats, /health,
 *                                               /budget) — drop-in for C1/C2;
 *   useCapacityRows()                           the rows, for a custom layout
 *                                               (the rail ring, the seat chip).
 */
import { useId, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import type { VerseBootstrap, VerseSeat } from '../../../data/api-types.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { useSeatHealth } from '../health/useSeatHealth.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { useSeatsRefresh } from '../useSeatsRefresh.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import {
  buildCapacityRows,
  capacityHeadline,
  capacityTone,
  windowSentence,
  type CapacityInputs,
  type CapacityRow,
  type CapacityWindowRow,
} from './capacity-strip-model.js';
import styles from './CapacityStrip.module.css';

/** Above this share of a window the bar turns amber (the word "tight" rides with it). */
const TIGHT_AT = 90;

export interface CapacityStripProps {
  seats: readonly VerseSeat[];
  health?: readonly SeatHealthReport[] | null;
  budget?: BudgetView | null;
  local?: CapacityInputs['local'];
  seatIds?: readonly string[];
  /** full: every window with resets and the reserve; compact: one line per seat (pickers, side panels). */
  density?: 'full' | 'compact';
  /** Show the one-sentence summary above the rows. Default true for full, false for compact. */
  headline?: boolean;
  /** Heading for assistive tech (visually hidden). */
  title?: string;
  /**
   * The id of a heading that already names this strip (Apps' "Accounts"
   * group). The strip then labels itself by it instead of adding a second,
   * hidden heading — two regions with one name is noise to a screen reader.
   */
  labelledBy?: string;
  /** Per-seat trailing controls (Apps passes Reconnect / Fix / Edit budget). */
  renderActions?: (row: CapacityRow) => ReactNode;
  /** Makes each seat name a toggle (Usage opens the account's detail). */
  onSelectSeat?: (seatId: string) => void;
  selectedSeatId?: string | null;
  /** Shown instead of rows when the roster is empty. */
  emptyText?: string;
}

function pct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function WindowBar({
  row,
  w,
  reservePercent,
  compact,
}: {
  row: CapacityRow;
  w: CapacityWindowRow;
  reservePercent: number | null;
  compact: boolean;
}) {
  const sentence = windowSentence(row, w, w.binding ? reservePercent : null);
  const ceiling = w.binding && reservePercent !== null && reservePercent > 0 ? 100 - pct(reservePercent) : null;
  let track: ReactNode;
  let value: ReactNode;
  if (w.limitReached) {
    track = (
      <span className={styles.track} role="img" aria-label={sentence}>
        <span className={styles.used} data-level="limit" style={{ width: '100%' }} />
      </span>
    );
    value = <span className={styles.value} data-level="limit">limit reached</span>;
  } else if (w.usedPercent === null) {
    // Absence drawn as absence. Never a 0% bar.
    track = <span className={styles.trackUnknown} role="img" aria-label={sentence} />;
    value = <span className={styles.value} data-level="unknown">no reading</span>;
  } else {
    const used = pct(w.usedPercent);
    const level = used >= TIGHT_AT ? 'tight' : 'ok';
    track = (
      <span className={styles.track} role="img" aria-label={sentence}>
        {ceiling !== null ? (
          <span className={styles.reserve} style={{ left: `${ceiling}%`, width: `${100 - ceiling}%` } as CSSProperties} />
        ) : null}
        <span className={styles.used} data-level={level} style={{ width: `${used}%` }} />
        {ceiling !== null ? <span className={styles.ceiling} style={{ left: `${ceiling}%` }} /> : null}
      </span>
    );
    value = <span className={styles.value} data-level={level}>{used}%</span>;
  }
  return (
    <div className={styles.bar} data-binding={w.binding || undefined} data-compact={compact || undefined}>
      <span className={styles.barLabel}>{w.label.replace(/ window$/, '')}</span>
      {track}
      {value}
      {!compact && w.resetText !== null ? <span className={styles.reset}>{w.resetText}</span> : null}
    </div>
  );
}

function SeatName({ row, onSelect, selected }: { row: CapacityRow; onSelect: ((id: string) => void) | undefined; selected: boolean }) {
  const text = (
    <>
      <span className={styles.name}>{row.label}</span>
      {row.plan !== null ? <span className={styles.plan}>{row.plan}</span> : null}
    </>
  );
  // A control only when there is something for it to open.
  if (!onSelect) return <span className={styles.nameWrap}>{text}</span>;
  return (
    <button type="button" className={styles.nameButton} aria-pressed={selected} onClick={() => onSelect(row.seatId)}>
      {text}
    </button>
  );
}

function CapacityRowView({
  row,
  compact,
  renderActions,
  onSelectSeat,
  selected,
}: {
  row: CapacityRow;
  compact: boolean;
  renderActions: CapacityStripProps['renderActions'];
  onSelectSeat: CapacityStripProps['onSelectSeat'];
  selected: boolean;
}) {
  const tone = capacityTone(row.cls);
  const binding = row.windows.find((w) => w.binding) ?? null;
  const windows = compact ? (binding ? [binding] : []) : row.windows;
  const actions = renderActions ? renderActions(row) : null;
  const reserve = row.reserve;
  return (
    <li className={styles.row} data-capacity={row.cls} data-compact={compact || undefined}>
      <MonogramTile monogram={row.monogram} engine={row.engine} size="sm" />
      <div className={styles.main}>
        <div className={styles.head}>
          <SeatName row={row} onSelect={onSelectSeat} selected={selected} />
          <span className={styles.word} data-tone={tone}>
            <span className={styles.dot} aria-hidden="true" />
            {row.word}
          </span>
          {row.connection !== null && row.connection.connection !== 'connected' && row.connection.connection !== 'unknown' ? (
            <span className={styles.word} data-tone={row.connection.tone}>
              <span className={styles.dot} aria-hidden="true" />
              {row.connection.word}
            </span>
          ) : null}
        </div>
        {!compact || windows.length === 0 ? <p className={styles.summary}>{row.summary}</p> : null}
        {windows.length > 0 ? (
          <div className={styles.bars}>
            {windows.map((w) => (
              <WindowBar key={w.id} row={row} w={w} reservePercent={reserve?.percent ?? null} compact={compact} />
            ))}
          </div>
        ) : null}
        {!compact && (reserve !== null || row.credits !== null) ? (
          <p className={styles.meta}>
            {reserve !== null ? (
              <span title={reserve.why}>
                {reserve.label}
                {/* "Autonomy off — all yours" already says it; no second "Off". */}
                {reserve.autonomy === 'off' ? null : (
                  <> · Autonomy: <span className={styles.autonomy} data-status={reserve.autonomy}>{reserve.autonomyWord}</span></>
                )}
              </span>
            ) : null}
            {reserve !== null && row.credits !== null ? ' · ' : null}
            {row.credits !== null ? <span>{row.credits}</span> : null}
          </p>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </li>
  );
}

export function CapacityStrip({
  seats,
  health,
  budget,
  local,
  seatIds,
  density = 'full',
  headline,
  title = 'Seat capacity',
  labelledBy,
  renderActions,
  onSelectSeat,
  selectedSeatId = null,
  emptyText = 'No seats yet. Connect an account or start Ollama — an empty roster, not seats at zero.',
}: CapacityStripProps) {
  const headingId = useId();
  const rows = useMemo(
    () => buildCapacityRows(seats, {
      health: health ?? null,
      budget: budget ?? null,
      ...(local ? { local } : {}),
      ...(seatIds ? { seatIds } : {}),
    }),
    [seats, health, budget, local, seatIds],
  );
  const compact = density === 'compact';
  const showHeadline = headline ?? !compact;
  // Named by the caller's heading: a plain block inside the caller's region,
  // not a second region with the same name.
  const Wrapper = labelledBy ? 'div' : 'section';
  return (
    <Wrapper className={styles.strip} aria-labelledby={labelledBy ? undefined : headingId} data-density={density}>
      {labelledBy ? null : <h3 id={headingId} className={styles.visuallyHidden}>{title}</h3>}
      {showHeadline && rows.length > 0 ? <p className={styles.headline}>{capacityHeadline(rows)}</p> : null}
      {rows.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <ul className={styles.rows} aria-label={labelledBy ? undefined : title} aria-labelledby={labelledBy}>
          {rows.map((row) => (
            <CapacityRowView
              key={row.seatId}
              row={row}
              compact={compact}
              renderActions={renderActions}
              onSelectSeat={onSelectSeat}
              selected={selectedSeatId === row.seatId}
            />
          ))}
        </ul>
      )}
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Live data
// ---------------------------------------------------------------------------

/** Budget moves with the collector (30 s); a minute is plenty for a strip. */
export const CAPACITY_BUDGET_POLL_MS = 60_000;

export interface CapacityData {
  seats: readonly VerseSeat[];
  health: readonly SeatHealthReport[] | null;
  budget: BudgetView | null;
  /** True until the seat roster has been read once. */
  loading: boolean;
}

/**
 * The three shared reads behind the strip, kept live while the surface is on
 * screen: seats (the /seats poll merged into bootstrap), A2's health (30 s)
 * and A9's budget (60 s). Each is the app-wide cache entry — mounting this
 * twice costs no extra request.
 */
export function useCapacityData(opts: { withBudget?: boolean; withHealth?: boolean } = {}): CapacityData {
  const visible = useSectionVisible();
  const withBudget = opts.withBudget ?? true;
  const withHealth = opts.withHealth ?? true;
  const bootstrap = useQuery(verseBootstrapQuery);
  useSeatsRefresh(visible);
  const health = useSeatHealth(visible && withHealth);
  const budget = useQuery(budgetQuery);
  const refetchBudget = useRefetch(budgetQuery);
  usePollWhileVisible(refetchBudget, CAPACITY_BUDGET_POLL_MS, { enabled: withBudget });
  const data = bootstrap.data as VerseBootstrap | undefined;
  return {
    seats: data?.seats ?? [],
    health: withHealth ? (health.data?.seats ?? null) : null,
    budget: withBudget ? (budget.data ?? null) : null,
    loading: data === undefined && (bootstrap.status === 'loading' || bootstrap.status === 'idle'),
  };
}

/** The rows for a custom layout (the rail's capacity ring, the composer's seat chip). */
export function useCapacityRows(inputs: Omit<CapacityInputs, 'health' | 'budget'> = {}): CapacityRow[] {
  const data = useCapacityData();
  return useMemo(
    () => buildCapacityRows(data.seats, { health: data.health, budget: data.budget, ...inputs }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inputs is a small literal; its fields are the identity.
    [data.seats, data.health, data.budget, inputs.local, inputs.seatIds],
  );
}

export interface LiveCapacityStripProps extends Omit<CapacityStripProps, 'seats' | 'health' | 'budget'> {
  /**
   * The roster, when the caller already holds it (the new-chat dialog, whose
   * seat list IS this roster and whose pre-fill works from its own props).
   * The strip then adds only health and budget, and never shows "Reading
   * seats…" over a roster that is already on screen.
   */
  seats?: readonly VerseSeat[];
}

/** Drop-in strip that reads its own data — what NewChatDialog and onboarding mount. */
export function LiveCapacityStrip({ seats: given, ...props }: LiveCapacityStripProps) {
  const data = useCapacityData();
  if (given === undefined && data.loading) {
    return <p className={styles.empty} aria-busy="true">Reading seats…</p>;
  }
  return <CapacityStrip {...props} seats={given ?? data.seats} health={data.health} budget={data.budget} />;
}
