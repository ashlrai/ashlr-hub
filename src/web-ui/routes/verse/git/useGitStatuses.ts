/**
 * routes/verse/git/useGitStatuses.ts — one git status per chat root, kept
 * fresh while the chat is on screen (unit C5).
 *
 * Freshness without waste:
 *   - one read per root on mount and whenever the root list changes;
 *   - a poll every GIT_POLL_MS through `usePollWhileVisible`, so a hidden
 *     surface or a minimised window costs nothing and a returning one
 *     re-reads on sight (the server caches 5 s, so a poll is cheap);
 *   - ONE extra read GIT_PR_RECHECK_MS after a status that says GitHub has
 *     not answered yet (`prLookup: 'pending'`), so "Checking GitHub…" turns
 *     into the real button in about two seconds instead of one poll later;
 *   - `replace` after an action — the POST already answered with the fresh
 *     status, so there is no second round trip.
 *
 * A root that is not a repository (or not one Verse knows) is dropped for the
 * life of the root list: it can never have a bar, and re-asking every poll
 * would be noise in the server log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import type { GitStatusView } from './git-model.js';
import { fetchGitStatus, isRootUnavailable } from './git-queries.js';

export const GIT_POLL_MS = 10_000;
export const GIT_PR_RECHECK_MS = 2_500;

export interface GitStatusesState {
  /** Statuses in the chat's root order, for roots that are repositories. */
  statuses: GitStatusView[];
  /** True until every root has answered once. */
  loading: boolean;
  /** A read failure other than "not a repository" (the newest one), or null. */
  error: string | null;
  refresh: () => void;
  /** Swap in the status a git action answered with, keyed by the root that was asked. */
  replace: (root: string, status: GitStatusView) => void;
}

export interface GitStatusesOptions {
  /** Test seam. */
  fetchStatus?: (root: string, signal?: AbortSignal) => Promise<GitStatusView>;
  enabled?: boolean;
}

export function useGitStatuses(roots: readonly string[], options: GitStatusesOptions = {}): GitStatusesState {
  const fetchStatus = options.fetchStatus ?? fetchGitStatus;
  const enabled = options.enabled ?? true;
  const visible = useSectionVisible();
  const key = roots.join('\0');
  // Stable across renders that pass an equal-but-new array.
  const stableRoots = useMemo(() => (key === '' ? [] : key.split('\0')), [key]);

  const [byRoot, setByRoot] = useState<Record<string, GitStatusView>>({});
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const unavailable = useRef(new Set<string>());
  const inFlight = useRef<AbortController | null>(null);
  const recheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const readAll = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const targets = stableRoots.filter((r) => !unavailable.current.has(r));
    if (targets.length === 0) {
      setAnswered(new Set(stableRoots));
      return;
    }
    void Promise.all(
      targets.map(async (root) => {
        try {
          const status = await fetchStatus(root, controller.signal);
          return { root, status, err: null as unknown };
        } catch (err) {
          return { root, status: null, err };
        }
      }),
    ).then((results) => {
      if (!alive.current || controller.signal.aborted) return;
      // Decided from the results, not inside the state updater: React may run
      // an updater later (or twice), so nothing read after it may be set in it.
      let failure: string | null = null;
      let pending = false;
      const fresh: Record<string, GitStatusView> = {};
      const dropped: string[] = [];
      for (const r of results) {
        if (r.status) {
          fresh[r.root] = r.status;
          if (r.status.prLookup === 'pending') pending = true;
        } else if (isRootUnavailable(r.err)) {
          unavailable.current.add(r.root);
          dropped.push(r.root);
        } else {
          // The console, not the page, gets the details (DESIGN §13.8).
          console.warn('[verse] git status failed', r.err);
          failure = 'Could not read git status.';
        }
      }
      setByRoot((prev) => {
        const next = { ...prev, ...fresh };
        for (const root of dropped) delete next[root];
        return next;
      });
      setAnswered(new Set(stableRoots));
      setError(failure);
      if (pending && recheck.current === null) {
        recheck.current = setTimeout(() => {
          recheck.current = null;
          // The newest readAll: the root list may have changed meanwhile.
          if (alive.current) latestRead.current();
        }, GIT_PR_RECHECK_MS);
      }
    });
  }, [stableRoots, fetchStatus]);
  const latestRead = useRef(readAll);
  latestRead.current = readAll;

  // A new root list starts clean: rows for roots the chat no longer has go.
  useEffect(() => {
    unavailable.current = new Set();
    setByRoot({});
    setAnswered(new Set());
    setError(null);
  }, [key]);

  // First read on mount and on a new root list. Coming back into view is the
  // poll's job (refreshOnShow), so visibility is read, not depended on.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (!enabled || !visibleRef.current) return;
    readAll();
  }, [readAll, enabled]);

  usePollWhileVisible(readAll, GIT_POLL_MS, { enabled });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      inFlight.current?.abort();
      if (recheck.current !== null) clearTimeout(recheck.current);
    };
  }, []);

  const replace = useCallback((root: string, status: GitStatusView) => {
    setByRoot((prev) => ({ ...prev, [root]: { ...status, root } }));
  }, []);

  const statuses = useMemo(
    () => stableRoots.map((r) => byRoot[r]).filter((s): s is GitStatusView => s !== undefined),
    [stableRoots, byRoot],
  );
  const loading = stableRoots.some((r) => !answered.has(r));

  return { statuses, loading, error, refresh: readAll, replace };
}
