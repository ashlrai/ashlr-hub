import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResourceConsoleSnapshot, ResourceSupervisorJob, ResourceSupervisorJobsPage } from '../../core/resources/console-types.js';
import { readResourceTasksPage, readResourceTaskStatus, resourceJobWindow } from './resource-task-history.js';

/** One bounded page plus the selected metadata row; private transcripts stay in their existing reader. */
export function useResourceTaskHistory(snapshot: ResourceConsoleSnapshot | undefined, selectedId: string | null, active: boolean, projectId?: string) {
  const session = snapshot?.supervisor?.instanceId;
  const window = resourceJobWindow(snapshot?.supervisor);
  const [page, setPage] = useState<{ session: string; value: ResourceSupervisorJobsPage } | null>(null);
  const [detail, setDetail] = useState<{ session: string; job: ResourceSupervisorJob; sample: ResourceConsoleSnapshot | undefined; page: ResourceSupervisorJobsPage | null } | null>(null);
  const retained = useRef<{ session: string; job: ResourceSupervisorJob } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const currentPage = page && page.session === session ? page.value : null;
  const accepts = (row: ResourceSupervisorJob) => projectId === undefined || (row.projectId ?? 'default') === projectId;
  const liveSelected = snapshot?.supervisor?.jobs.find(row => row.id === selectedId);
  const selected = liveSelected ?? (detail && detail.session === session && detail.job.id === selectedId && detail.page === currentPage ? detail.job : undefined) ??
    currentPage?.items.find(row => row.id === selectedId) ??
    (window && retained.current && retained.current.session === session && retained.current.job.id === selectedId ? retained.current.job : undefined);
  if (selected && session && accepts(selected)) retained.current = { session, job: selected };
  const jobs = useMemo(() => {
    const values = new Map<string, ResourceSupervisorJob>();
    // Every current nonterminal row is in the live window. A prior page cannot
    // reintroduce stale queue/ownership claims after that row leaves the window.
    const terminal = (row: ResourceSupervisorJob) => row.state === 'settled' || row.state === 'cancelled';
    for (const row of currentPage?.items ?? []) if (terminal(row) && (projectId === undefined || (row.projectId ?? 'default') === projectId)) values.set(row.id, row);
    if (selected && terminal(selected) && (projectId === undefined || (selected.projectId ?? 'default') === projectId)) values.set(selected.id, selected);
    for (const row of snapshot?.supervisor?.jobs ?? []) values.set(row.id, row);
    return [...values.values()];
  }, [snapshot?.supervisor?.jobs, currentPage, selected, projectId]);
  const expanded = useMemo(() => snapshot && snapshot.supervisor ? { ...snapshot, supervisor: { ...snapshot.supervisor, jobs } } : snapshot, [snapshot, jobs]);
  useEffect(() => {
    pageRequest.current?.abort(); setLoading(false); setError(null); setDetailError(null);
    return () => { pageRequest.current?.abort(); };
  }, [session, active]);
  useEffect(() => {
    setDetailError(null);
    if (!active || !window || !session || !selectedId || liveSelected) return;
    const controller = new AbortController();
    void readResourceTaskStatus(selectedId, session, controller.signal).then(job => {
      if (!controller.signal.aborted) {
        if (projectId !== undefined && (job.projectId ?? 'default') !== projectId) throw new Error();
        setDetail({ session, job, sample: snapshot, page: currentPage });
      }
    }).catch(() => { if (!controller.signal.aborted) setDetailError('Selected task metadata could not be refreshed. Showing the last verified task; task-changing controls are paused.'); });
    return () => controller.abort();
  }, [snapshot, session, selectedId, active, liveSelected, window, projectId, currentPage]);
  async function load(older = false) {
    if (!session || !active || loading || older && !currentPage?.nextBefore) return;
    pageRequest.current?.abort(); const controller = new AbortController(); pageRequest.current = controller;
    setLoading(true); setError(null);
    try {
      // Skip the already-visible terminal window on the first request. Active
      // work can be much older and must never move this history boundary back.
      const oldestVisibleTerminal = window && window.omittedJobs > 0
        ? snapshot?.supervisor?.jobs.filter(row => row.state === 'settled' || row.state === 'cancelled')
          .sort((left, right) => Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]
        : undefined;
      const before = older ? currentPage?.nextBefore : oldestVisibleTerminal
        ? { enqueuedAt: oldestVisibleTerminal.enqueuedAt, id: oldestVisibleTerminal.id } : undefined;
      const value = await readResourceTasksPage({ limit: 64, ...(before ? { before } : {}) }, controller.signal);
      if (!controller.signal.aborted) setPage({ session, value });
    } catch { if (!controller.signal.aborted) setError('Task history could not be loaded. Your current selection is unchanged.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function latest() { pageRequest.current?.abort(); setLoading(false); setError(null); setPage(null); }
  return { snapshot: expanded, page: currentPage, window, loading, error, detailError, load, latest,
    selectedCurrent: !!liveSelected || !window || !!detail && detail.session === session && detail.job.id === selectedId && detail.sample === snapshot && detail.page === currentPage && !detailError };
}
