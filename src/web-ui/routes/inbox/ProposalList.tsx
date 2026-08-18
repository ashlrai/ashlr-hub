/**
 * routes/inbox/ProposalList.tsx — proposal triage list (operator-console
 * brief item 1). Pending by default; real server-side status/since
 * filtering (src/core/web/api.ts's new `?status=&since=&limit=`) makes the
 * 672 rejected/approved/etc. actually browsable for the first time, plus
 * client-side repo/text search over whatever page is loaded. Full keyboard
 * list traversal + open + batch-select (the old UI had 3 key handlers in
 * 7,901 lines; run detail was entirely unreachable by keyboard).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Proposal, ProposalStatus } from '../../data/api-types.js';
import { inboxListQuery, type InboxHistoryStatus } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { hasMutationHold } from '../../data/auth-store.js';
import { approveProposal, rejectProposal } from '../../data/mutations.js';
import { DispatchDisabledError } from '../../data/client.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../components/primitives/Skeleton.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import styles from './ProposalList.module.css';

const STATUS_OPTIONS: { value: InboxHistoryStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'approved', label: 'Approved' },
  { value: 'applied', label: 'Applied' },
  { value: 'failed', label: 'Failed' },
  { value: 'awaiting-host-merge', label: 'Awaiting host merge' },
  { value: 'all', label: 'All statuses' },
];

function formatAge(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type BatchAction = 'approve' | 'reject' | null;

export function ProposalList({ selectedId, onDispatchDisabled }: { selectedId: string | null; onDispatchDisabled: () => void }) {
  const [status, setStatus] = useState<InboxHistoryStatus>('pending');
  const [since, setSince] = useState('');
  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);

  const [batchAction, setBatchAction] = useState<BatchAction>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const navigate = useNavigate();

  const query = useQuery(inboxListQuery({ status, since: since || undefined, limit: 500 }));

  const rows: Proposal[] = useMemo(() => {
    const all = query.data?.proposals ?? [];
    const s = search.trim().toLowerCase();
    const r = repoFilter.trim().toLowerCase();
    return all.filter((p) => {
      if (s && !p.title.toLowerCase().includes(s) && !(p.summary ?? '').toLowerCase().includes(s)) return false;
      if (r && !(p.repo ?? '').toLowerCase().includes(r)) return false;
      return true;
    });
  }, [query.data, search, repoFilter]);

  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  function toggleSelected(id: string, proposalStatus: ProposalStatus) {
    if (proposalStatus !== 'pending') return; // only pending proposals can be approved/rejected
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(focusedIndex + 1, rows.length - 1);
      setFocusedIndex(next);
      rowRefs.current.get(rows[next]!.id)?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(focusedIndex - 1, 0);
      setFocusedIndex(next);
      rowRefs.current.get(rows[next]!.id)?.focus();
    } else if (e.key === 'Enter') {
      const row = rows[focusedIndex];
      if (row) navigate(`/inbox/${encodeURIComponent(row.id)}`);
    } else if (e.key === ' ') {
      const row = rows[focusedIndex];
      if (row) {
        e.preventDefault();
        toggleSelected(row.id, row.status);
      }
    } else if (e.key === '/') {
      e.preventDefault();
      searchInputRef.current?.focus();
    }
  }

  function requestBatchAction(action: 'approve' | 'reject') {
    if (selectedIds.size === 0) return;
    setBatchError(null);
    setBatchAction(action);
    if (hasMutationHold()) setBatchConfirmOpen(true);
    else setTokenDialogOpen(true);
  }

  function onTokenDialogClose() {
    setTokenDialogOpen(false);
    if (hasMutationHold()) setBatchConfirmOpen(true);
    else setBatchAction(null);
  }

  async function confirmBatchAction() {
    if (!batchAction) return;
    setBatchBusy(true);
    setBatchError(null);
    const ids = Array.from(selectedIds);
    const failures: string[] = [];
    for (const id of ids) {
      try {
        if (batchAction === 'approve') await approveProposal(id);
        else await rejectProposal(id);
      } catch (err) {
        if (err instanceof DispatchDisabledError) {
          setBatchBusy(false);
          setBatchConfirmOpen(false);
          setBatchAction(null);
          onDispatchDisabled();
          return;
        }
        failures.push(id);
      }
    }
    setBatchBusy(false);
    if (failures.length > 0) {
      setBatchError(`${failures.length} of ${ids.length} failed (already decided, or a transient error). Selection kept for retry.`);
      setSelectedIds(new Set(failures));
    } else {
      setBatchConfirmOpen(false);
      setBatchAction(null);
      setSelectedIds(new Set());
    }
  }

  const selectedPendingCount = selectedIds.size;

  return (
    <div className={styles.list}>
      <div className={styles.filters}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as InboxHistoryStatus)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Since</span>
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Repo</span>
          <input type="text" placeholder="filter by repo" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Search</span>
          <input
            ref={searchInputRef}
            type="search"
            placeholder="title or summary — press / to focus"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      <div className={styles.summary} aria-live="polite">
        {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        {query.data ? (
          <span>
            {rows.length} shown of {query.data.total} total
            {query.data.truncated ? ' · narrow filters to see more' : ''}
          </span>
        ) : null}
      </div>

      {selectedPendingCount > 0 ? (
        <div className={styles.batchBar}>
          <span>{selectedPendingCount} selected</span>
          <button type="button" onClick={() => setSelectedIds(new Set())}>
            Clear
          </button>
          <button type="button" className={styles.batchReject} onClick={() => requestBatchAction('reject')}>
            Reject {selectedPendingCount}
          </button>
          <button type="button" className={styles.batchApprove} onClick={() => requestBatchAction('approve')}>
            Approve {selectedPendingCount}
          </button>
        </div>
      ) : null}

      {query.status === 'loading' ? (
        <div className={styles.skeletons}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : query.status === 'error' ? (
        <div className={styles.error} role="alert">
          {query.error?.message ?? 'Failed to load proposals.'}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          No {status === 'all' ? '' : status + ' '}proposals match{search || repoFilter ? ' this filter' : ''}.
        </p>
      ) : (
        <table className={styles.table} role="grid" aria-label="Proposals" onKeyDown={onListKeyDown}>
          <thead>
            <tr>
              <th scope="col" className={styles.checkboxCol} />
              <th scope="col">Title</th>
              <th scope="col" className={styles.repoCol}>
                Repo
              </th>
              <th scope="col" className={styles.kindCol}>
                Kind
              </th>
              <th scope="col" className={styles.ageCol}>
                Age
              </th>
              <th scope="col" className={styles.statusCol}>
                Status
              </th>
              <th scope="col" className={styles.whyCol}>
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr
                key={p.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(p.id, el);
                  else rowRefs.current.delete(p.id);
                }}
                data-focus-key={`proposal-${p.id}`}
                tabIndex={i === focusedIndex ? 0 : -1}
                className={`${styles.row} ${p.id === selectedId ? styles.rowActive : ''}`}
                onFocus={() => setFocusedIndex(i)}
                aria-selected={p.id === selectedId}
              >
                <td className={styles.checkboxCol}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    disabled={p.status !== 'pending'}
                    title={p.status !== 'pending' ? 'Only pending proposals can be approved/rejected' : undefined}
                    onChange={() => toggleSelected(p.id, p.status)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td>
                  <Link to={`/inbox/${encodeURIComponent(p.id)}`} className={styles.titleLink} title={p.title}>
                    {p.title}
                  </Link>
                </td>
                <td className={styles.repoCell} title={p.repo ?? undefined}>
                  {p.repo ? p.repo.split('/').pop() : '—'}
                </td>
                <td>{p.kind}</td>
                <td className={styles.age}>{formatAge(p.createdAt)}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td className={styles.why} title={p.decisionReason ?? undefined}>
                  {p.decisionReason ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <MutationTokenDialog
        open={tokenDialogOpen}
        onClose={onTokenDialogClose}
        reason={`${batchAction === 'approve' ? 'Approving' : 'Rejecting'} ${selectedPendingCount} proposals requires the dispatch token.`}
      />

      <ConfirmDialog
        open={batchConfirmOpen}
        onClose={() => {
          setBatchConfirmOpen(false);
          setBatchAction(null);
          setBatchError(null);
        }}
        title={batchAction === 'approve' ? `Approve ${selectedPendingCount} proposals?` : `Reject ${selectedPendingCount} proposals?`}
        body={
          batchAction === 'approve' ? (
            <>
              This applies all {selectedPendingCount} selected proposals to their repos now, one at a time. This
              cannot be undone from this dialog.
            </>
          ) : (
            <>This rejects all {selectedPendingCount} selected proposals. They stay visible in history as rejected.</>
          )
        }
        confirmLabel={batchAction === 'approve' ? `Approve ${selectedPendingCount}` : `Reject ${selectedPendingCount}`}
        destructive={batchAction === 'reject'}
        busy={batchBusy}
        error={batchError}
        onConfirm={() => void confirmBatchAction()}
      />
    </div>
  );
}
