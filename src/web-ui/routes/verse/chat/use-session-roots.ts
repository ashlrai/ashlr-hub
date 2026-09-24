/**
 * routes/verse/chat/use-session-roots.ts — one read of a chat's roots for
 * everything that needs them (unit C2): the header's `repo › branch`
 * breadcrumb, the Context pane's Folders list, and the roots handed to the
 * Branch bar, Terminal, Preview and Review slots.
 *
 * Before 3.10 only SessionRoots read `/sessions/:id/roots`, fetching on its
 * own. With four consumers that would be four requests per chat switch (each
 * one `git status` per root on the server), so the read goes through the
 * shared query cache under one key per chat. A branch goes stale the moment
 * a turn commits, so the read is refreshed whenever the chat's turnCount
 * moves — exactly as SessionRoots' `refreshKey` did.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { VerseSession, VerseSessionRootsResponse } from '../../../data/api-types.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { fetchVerseSessionRoots } from '../verse-queries.js';

export function sessionRootsKey(sessionId: string): string {
  return `verse-session-roots:${sessionId}`;
}

const NO_SESSION: QueryDef<VerseSessionRootsResponse | null> = {
  key: 'verse-session-roots:none',
  fetch: async () => null,
};

export interface SessionRootsView {
  data: VerseSessionRootsResponse | null;
  error: string | null;
  /** Roots in priority order: the primary first, then the pinned extras. Known before the read lands. */
  roots: readonly string[];
  /** The primary root's branch, when it is a git repo and the read landed. */
  branch: string | null;
}

/** Roots as the session RECORD states them — usable before (and without) the status read. */
export function recordRoots(session: Pick<VerseSession, 'projectPath' | 'extraRoots'> | null): string[] {
  if (!session) return [];
  return [session.projectPath, ...(session.extraRoots ?? []).filter((r) => r !== session.projectPath)];
}

export function useSessionRoots(session: Pick<VerseSession, 'id' | 'projectPath' | 'extraRoots' | 'turnCount'> | null): SessionRootsView {
  const sessionId = session?.id ?? null;
  const def = useMemo<QueryDef<VerseSessionRootsResponse | null>>(
    () => (sessionId
      ? { key: sessionRootsKey(sessionId), fetch: (signal) => fetchVerseSessionRoots(sessionId, signal) }
      : NO_SESSION),
    [sessionId],
  );
  const query = useQuery(def);
  const refetch = useRefetch(def);

  // A finished turn may have committed or switched branch: re-read. The
  // first value for a chat is the mount's own fetch, not a change.
  const turnCount = session?.turnCount ?? 0;
  const seen = useRef<{ id: string | null; turns: number }>({ id: sessionId, turns: turnCount });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { id: sessionId, turns: turnCount };
    if (prev.id === sessionId && prev.turns !== turnCount && sessionId) refetch();
  }, [sessionId, turnCount, refetch]);

  // A reply without a roots list (an older server, a stub) is treated as no
  // reading at all rather than trusted into a crash.
  const raw = query.data ?? null;
  const data = raw !== null && Array.isArray(raw.roots) ? raw : null;
  const fromRecord = useMemo(() => recordRoots(session), [session?.projectPath, session?.extraRoots]); // eslint-disable-line react-hooks/exhaustive-deps -- the two fields ARE the dependency
  const roots = useMemo(() => {
    if (!data || data.roots.length === 0) return fromRecord;
    const primary = data.roots.filter((r) => r.primary).map((r) => r.path);
    const rest = data.roots.filter((r) => !r.primary).map((r) => r.path);
    return [...primary, ...rest];
  }, [data, fromRecord]);
  const primary = data?.roots.find((r) => r.primary) ?? data?.roots[0] ?? null;
  return {
    data,
    error: query.status === 'error' ? query.error?.message ?? 'could not read this chat’s folders' : null,
    roots,
    branch: primary?.git?.branch ?? null,
  };
}
