/**
 * routes/verse/approvals/ApprovalsList.tsx — the triage queue.
 *
 * Reads the existing `GET /api/inbox?status=&limit=` through the shared
 * `inboxListQuery` (server-side status filter, client-side repo/text narrowing
 * over the returned page) and orders it pending-first via approvals-model.ts,
 * so a history filter still surfaces anything still awaiting a decision at the
 * top instead of burying it by date.
 *
 * Risk is carried by a 2px left rule AND by the word, never by colour alone.
 * Rows are buttons, not links: the Verse console has no router, selection is
 * section-local state.
 */
import { useMemo, useRef, useState } from 'react';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { Select } from '../../../components/primitives/Select.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import type { Proposal } from '../../../data/api-types.js';
import { useQuery } from '../../../data/hooks.js';
import { inboxListQuery, type InboxHistoryStatus } from '../../../data/queries.js';
import { formatAge } from '../autonomy/format.js';
import { engineOf, filterProposals, orderProposals } from './approvals-model.js';
import styles from './approvals.module.css';

const STATUS_OPTIONS: { value: InboxHistoryStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'all', label: 'All statuses' },
  { value: 'approved', label: 'Approved' },
  { value: 'applied', label: 'Applied' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'failed', label: 'Failed' },
  { value: 'awaiting-host-merge', label: 'Awaiting host merge' },
];

export interface ApprovalsListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ApprovalsList({ selectedId, onSelect }: ApprovalsListProps) {
  const [status, setStatus] = useState<InboxHistoryStatus>('pending');
  const [search, setSearch] = useState('');
  const [repo, setRepo] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const query = useQuery(inboxListQuery({ status, limit: 500 }));

  const rows = useMemo<Proposal[]>(
    () => orderProposals(filterProposals(query.data?.proposals ?? [], search, repo)),
    [query.data, search, repo],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(focusedIndex + 1, rows.length - 1) : Math.max(focusedIndex - 1, 0);
      setFocusedIndex(next);
      rowRefs.current.get(rows[next]!.id)?.focus();
    }
  }

  return (
    <div className={styles.listPane}>
      <div className={styles.filters}>
        {/* Select primitive — see the note in ActivityPanel: an unreset
            <select> is a default browser control, which §7 forbids. */}
        <Select
          className={styles.filterSelect}
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as InboxHistoryStatus)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Repo</span>
          <input type="text" value={repo} placeholder="filter by repo" onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Search</span>
          <input type="search" value={search} placeholder="title or summary" onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      <div className={styles.count} aria-live="polite">
        {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        {query.data ? (
          <span>
            {rows.length} shown · {query.data.pending} pending
            {query.data.truncated ? ' · capped, narrow the filter' : ''}
          </span>
        ) : (
          <span>Loading proposals…</span>
        )}
      </div>

      {query.status === 'loading' ? (
        <div className={styles.skeletons}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : query.status === 'error' ? (
        <p className={styles.error} role="alert">
          {query.error?.message ?? 'Could not read the approvals queue.'}
        </p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          {status === 'pending' && !search && !repo ? (
            <>
              <span className={styles.emptyStrong}>Nothing is waiting on you.</span> The loop only produces proposals
              for enrolled repositories — if you expected something here, check the scope list in Autonomy.
            </>
          ) : (
            'No proposals match this filter.'
          )}
        </p>
      ) : (
        <div className={styles.rows} role="list" onKeyDown={onKeyDown}>
          {rows.map((p, i) => {
            const engine = engineOf(p);
            return (
              <div role="listitem" key={p.id}>
              <button
                type="button"
                ref={(el) => {
                  if (el) rowRefs.current.set(p.id, el);
                  else rowRefs.current.delete(p.id);
                }}
                tabIndex={i === focusedIndex ? 0 : -1}
                className={`${styles.row} ${p.id === selectedId ? styles.rowActive : ''}`}
                aria-current={p.id === selectedId ? 'true' : undefined}
                onFocus={() => setFocusedIndex(i)}
                onClick={() => onSelect(p.id)}
              >
                <span className={styles.riskRule} data-risk={p.riskClass ?? 'unstated'} aria-hidden="true" />
                <span className={styles.rowTitle} title={p.title}>
                  {p.title}
                </span>
                <span className={styles.rowMeta}>
                  <span className={styles.riskWord} data-risk={p.riskClass ?? 'unstated'}>
                    {p.riskClass ? `${p.riskClass} risk` : 'risk unstated'}
                  </span>
                  <span className={styles.rowMetaMono} title={p.repo ?? undefined}>
                    {p.repo ? p.repo.split('/').pop() : 'no repo'}
                  </span>
                  <span className={styles.rowMetaMono} title={engine ?? undefined}>
                    {engine ?? 'engine unknown'}
                  </span>
                  <span className={styles.rowAge}>{formatAge(p.createdAt)}</span>
                  {p.status === 'pending' ? null : <StatusBadge status={p.status} />}
                </span>
              </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
