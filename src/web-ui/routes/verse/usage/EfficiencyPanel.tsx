/**
 * routes/verse/usage/EfficiencyPanel.tsx — context efficiency per seat, across
 * every chat on this machine (V3.9, docs/VERSE-CONTEXT.md).
 *
 * The Usage section answers "which account can I use, and what will it cost".
 * Past the quota windows, the biggest lever on that cost is how each seat's
 * chats use their context: a chat that re-reads its prompt from cache pays a
 * fraction of one that re-reads it at full price, and a chat that keeps
 * compacting is carrying more than its budget holds. So each seat gets its
 * aggregate cache-hit ratio and compaction count — computed in the browser
 * from the session records the console already has. No request, no spend, no
 * new server state.
 *
 * Honesty rules (all enforced in context-model.ts, stated here once):
 *  - ratios are computed from SUMMED tokens, never averaged per chat;
 *  - "none reported" is not 0%: a provider that reported no cache activity
 *    (Ollama) has made no claim either way;
 *  - an upper-bound occupancy (codex before its rollout is read) is shown "≤";
 *  - a seat with no chats has no row — an empty table is not a seat at 0%.
 */
import type { ReactNode } from 'react';
import { TableView, chartFormat, type TableColumn } from '../../../components/charts/index.js';
import { percentText } from '../autonomy/format.js';
import { formatTokens } from '../verse-store.js';
import { ENGINE_LABEL } from '../verse-model.js';
import { formatRatio, type SeatEfficiencyRow } from './context-model.js';
import styles from './usage.module.css';

function fullestText(row: SeatEfficiencyRow): string {
  const f = row.fullest;
  if (f === null) return '—';
  const size = `${f.exact ? '' : '≤'}${formatTokens(f.tokens)}`;
  if (f.window === null) return size;
  const share = (f.tokens / f.window) * 100;
  // The one percent rule up to the window ("99%", never a rounded "100%" that
  // reads as full); past it, the real overflow ("112%") rather than a clamp.
  return `${size} / ${formatTokens(f.window)} · ${share <= 100 ? percentText(share) : chartFormat.formatPercent(share / 100)}`;
}

const COLUMNS: TableColumn<SeatEfficiencyRow>[] = [
  {
    key: 'seat',
    label: 'Seat',
    render: (r) => (
      <>
        {r.label}
        <span className={styles.limitWindow}>
          {` · ${ENGINE_LABEL[r.engine]}`}
          {r.retired ? ' · no longer connected' : ''}
        </span>
      </>
    ),
  },
  { key: 'chats', label: 'Chats', numeric: true, render: (r) => chartFormat.formatCompact(r.sessions) },
  { key: 'turns', label: 'Turns', numeric: true, render: (r) => chartFormat.formatCompact(r.turns) },
  { key: 'prompt', label: 'Prompt tokens', numeric: true, render: (r) => formatTokens(r.promptTokens) },
  {
    key: 'hit',
    label: 'Cache hit',
    numeric: true,
    render: (r) => (r.cacheHitRatio !== null ? formatRatio(r.cacheHitRatio) : r.promptTokens > 0 ? 'none reported' : '—'),
  },
  { key: 'compactions', label: 'Compactions', numeric: true, render: (r) => chartFormat.formatCompact(r.compactions) },
  {
    key: 'expansive',
    label: 'Expansive chats',
    numeric: true,
    render: (r) => chartFormat.formatCompact(r.expansiveSessions),
  },
  { key: 'fullest', label: 'Fullest context', numeric: true, render: (r) => fullestText(r) },
];

export function EfficiencyPanel({
  rows,
  unavailableReason,
}: {
  rows: readonly SeatEfficiencyRow[];
  /** Why the chat list could not be read; null when it was. */
  unavailableReason: string | null;
}): ReactNode {
  return (
    <section className={styles.panel} aria-labelledby="verse-usage-efficiency">
      <div className={styles.panelHead}>
        <h3 id="verse-usage-efficiency" className={styles.panelTitle}>
          Context efficiency
        </h3>
        <p className={styles.panelNote}>
          Per seat, across every chat on this machine. Cache hit is the share of prompt tokens served
          from the provider&apos;s cache — the higher it is, the less each turn re-reads at full price.
          Compactions are the CLI summarizing a context that outgrew its budget.
        </p>
      </div>

      {unavailableReason !== null ? (
        <p className={styles.muted}>{unavailableReason}</p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>
          No chats yet, so there is nothing to measure — this is an empty history, not a seat at 0%.
          Start a chat on any seat and its context use shows up here.
        </p>
      ) : (
        <div className={styles.tableScroll}>
          <TableView
            caption="Context efficiency per seat: chats, turns, prompt tokens, cache-hit ratio, compactions, expansive chats and the fullest context"
            columns={COLUMNS}
            rows={[...rows]}
            rowKey={(r) => r.seatId}
          />
        </div>
      )}

      <p className={styles.sourceLine}>
        Computed in this browser from each chat&apos;s recorded totals — no extra request, no spend.
        &ldquo;None reported&rdquo; means the provider reported no cache activity, not a 0% hit rate; a
        figure marked &le; is an upper bound. Compactions are counted from Verse 3.9 on; earlier ones
        were not recorded.
      </p>
    </section>
  );
}
