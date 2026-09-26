/**
 * routes/verse/autonomy/ActivityPanel.tsx — "what did it do while I was
 * asleep": recent ticks, the dispatches inside them, and the append-only audit
 * trail as a dense filterable table.
 *
 * Readability at 200 rows is a requirement, not an aspiration, so: one scroll
 * container with a sticky header rather than pagination, monospace in the
 * identifier columns so they align, wall-clock time (an audit read at 07:00 is
 * about *when*, and "14h ago" is useless for that) with the relative age as a
 * tooltip, and result carried by a glyph as well as a colour.
 *
 * The audit filters are applied deliberately, not per keystroke: the action
 * filter is server-side (`?action=`), so committing on Enter/blur keeps one
 * cache entry per real filter instead of one per character typed.
 */
import { useMemo, useState } from 'react';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { Select } from '../../../components/primitives/Select.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { verseAuditQuery, VERSE_AUDIT_DEFAULT_LIMIT } from './control-queries.js';
import type { AuditEntry, DaemonDispatchTrace, VerseControlSnapshot } from './control-types.js';
// formatStamp, not formatClock: these three tables span days (the audit trail
// defaults to 200 rows and offers 500), so a bare "03:12:44" cannot tell last
// night from last week. It prints time alone for today and prefixes the date
// otherwise.
// The relative age rides in the tooltip as a phrase ("7m ago"), not a bare "7m".
import {
  describeTickOutcome,
  formatCount,
  formatRelative,
  formatStamp,
  formatUsd,
  repoDisplayName,
  tidyProse,
  UNKNOWN,
} from './format.js';
import styles from './autonomy.module.css';

const RECENT_TICKS = 20;
const RECENT_DISPATCHES = 40;

type ResultFilter = '' | AuditEntry['result'];

interface DispatchRow extends DaemonDispatchTrace {
  tickTs: string;
}

export function ActivityPanel({ snapshot }: { snapshot: VerseControlSnapshot }) {
  const ticks = snapshot.daemon?.ticks ?? null;

  const recentTicks = useMemo(() => (ticks ? [...ticks].slice(-RECENT_TICKS).reverse() : []), [ticks]);

  const dispatches = useMemo<DispatchRow[]>(() => {
    if (!ticks) return [];
    const rows: DispatchRow[] = [];
    for (let i = ticks.length - 1; i >= 0 && rows.length < RECENT_DISPATCHES; i -= 1) {
      const tick = ticks[i];
      if (!tick?.dispatches) continue;
      for (let j = tick.dispatches.length - 1; j >= 0 && rows.length < RECENT_DISPATCHES; j -= 1) {
        rows.push({ ...tick.dispatches[j]!, tickTs: tick.ts });
      }
    }
    return rows;
  }, [ticks]);

  return (
    <section className={styles.panel} aria-label="Activity">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Recent ticks</h3>
        <p className={styles.panelNote}>Newest first · last {RECENT_TICKS}</p>
      </div>
      {ticks === null ? (
        <p className={styles.empty}>The daemon ledger is not readable right now, so tick history is unknown.</p>
      ) : recentTicks.length === 0 ? (
        <p className={styles.empty}>No ticks have been recorded yet. Start the loop, or run one tick, to produce the first.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Outcome</th>
                <th scope="col">Items</th>
                <th scope="col">Proposals</th>
                <th scope="col">Dispatched</th>
                <th scope="col">Spend</th>
                <th scope="col">Direction</th>
              </tr>
            </thead>
            <tbody>
              {recentTicks.map((tick) => {
                const outcome = describeTickOutcome(tick.reason);
                return (
                  <tr key={`${tick.ts}-${tick.reason}`}>
                    <td className={styles.cellTime} title={formatRelative(tick.ts)}>
                      {formatStamp(tick.ts)}
                    </td>
                    <td className={styles.cellSummary} data-tone={outcome.tone}>
                      {outcome.label}
                      {tick.dryRun ? ' (dry run)' : ''}
                    </td>
                    <td className={styles.cellTime}>{formatCount(tick.itemsConsidered)}</td>
                    <td className={styles.cellTime}>{formatCount(tick.proposalsCreated)}</td>
                    <td className={styles.cellTime}>{tick.dispatches ? tick.dispatches.length : UNKNOWN}</td>
                    <td className={styles.cellTime}>{formatUsd(tick.spentUsd)}</td>
                    <td className={styles.cellSummary}>{tick.directionMode ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className={`${styles.panelHead} ${styles.panelHeadSpaced}`}>
        <h3 className={styles.panelTitle}>Recent dispatches</h3>
        <p className={styles.panelNote}>Newest first · last {RECENT_DISPATCHES}</p>
      </div>
      {dispatches.length === 0 ? (
        <p className={styles.empty}>
          No dispatches in the recorded ticks. Run one tick from Controls to see what it would pick up.
        </p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Item</th>
                <th scope="col">Repo</th>
                <th scope="col">Engine</th>
                <th scope="col">Outcome</th>
                <th scope="col">Spend</th>
              </tr>
            </thead>
            <tbody>
              {dispatches.map((row, i) => (
                <tr key={`${row.tickTs}-${row.itemId}-${i}`}>
                  <td className={styles.cellTime} title={formatRelative(row.tickTs)}>
                    {formatStamp(row.tickTs)}
                  </td>
                  <td className={styles.cellSummary} title={row.title}>
                    {row.title}
                  </td>
                  <td className={styles.cellRepo} title={row.repo}>
                    {row.repo ? repoDisplayName(row.repo) : UNKNOWN}
                  </td>
                  <td className={styles.cellAction}>{row.backend ?? 'not routed'}</td>
                  <td className={styles.cellSummary}>
                    {row.dispatched ? 'dispatched' : `skipped — ${tidyProse(row.reason)}`}
                  </td>
                  <td className={styles.cellTime}>{formatUsd(row.spentUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AuditTrail />
    </section>
  );
}

export function AuditTrail() {
  const [actionDraft, setActionDraft] = useState('');
  const [action, setAction] = useState('');
  const [result, setResult] = useState<ResultFilter>('');
  const [limit, setLimit] = useState(VERSE_AUDIT_DEFAULT_LIMIT);

  const def = useMemo(
    () => verseAuditQuery({ limit, action: action || undefined, result: result || undefined }),
    [limit, action, result],
  );
  const query = useQuery(def);
  const refetch = useRefresh(def);

  const entries = query.data?.entries ?? [];

  return (
    <>
      <div className={`${styles.panelHead} ${styles.panelHeadSpaced}`}>
        <h3 className={styles.panelTitle}>Audit trail</h3>
        <div className={styles.panelActions}>
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          <button type="button" className={styles.button} onClick={refetch}>
            Refresh
          </button>
        </div>
      </div>

      <div className={styles.filters}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Action</span>
          <input
            type="search"
            value={actionDraft}
            placeholder="e.g. enroll.add"
            onChange={(e) => setActionDraft(e.target.value)}
            onBlur={() => setAction(actionDraft.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setAction(actionDraft.trim());
              }
            }}
          />
        </label>
        {/* The Select primitive, not a raw <select>: it carries the
            appearance: none reset, our own chevron, the --density-row height
            and the disabled styling. DESIGN-V2 §7 — "Nothing is a default
            browser control" — and an unreset <select> loses its border-radius
            to the native bezel on macOS Safari and grows a second OS chevron
            on Chrome/Windows. */}
        <Select
          className={styles.filterSelect}
          label="Result"
          value={result}
          onChange={(e) => setResult(e.target.value as ResultFilter)}
        >
          <option value="">Any result</option>
          <option value="ok">ok</option>
          <option value="refused">refused</option>
          <option value="error">error</option>
        </Select>
        <Select
          className={styles.filterSelect}
          label="Rows"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          <option value={50}>50</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
        </Select>
      </div>

      {query.status === 'loading' ? (
        <div className={styles.skeletons}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : query.status === 'error' ? (
        <p className={styles.error} role="alert">
          {query.error?.message ?? 'Could not read the audit trail.'}
        </p>
      ) : entries.length === 0 ? (
        <p className={styles.empty}>
          {action || result
            ? 'No audit entries match this filter. Clear the Action or Result filter to see every entry.'
            : 'No audit entries recorded yet. Every autonomous or sandbox action appends one here, and none are ever deleted.'}
        </p>
      ) : (
        <>
          <p className={styles.panelNote} aria-live="polite">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · newest first
            {query.data?.truncated ? ' · capped by the server, narrow the filter to see more' : ''}
          </p>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Result</th>
                  <th scope="col">Repo</th>
                  <th scope="col">Summary</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={`${entry.ts}-${entry.action}-${i}`}>
                    <td className={styles.cellTime} title={formatRelative(entry.ts)}>
                      {formatStamp(entry.ts)}
                    </td>
                    <td className={styles.cellAction}>{entry.action}</td>
                    <td>
                      <span className={styles.resultTag} data-result={entry.result}>
                        {entry.result}
                      </span>
                    </td>
                    <td className={styles.cellRepo} title={entry.repo ?? undefined}>
                      {entry.repo ? repoDisplayName(entry.repo) : UNKNOWN}
                    </td>
                    <td className={styles.cellSummary}>{tidyProse(entry.summary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
