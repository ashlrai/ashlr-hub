/**
 * routes/verse/chat/sidebar-model.ts — the chat list, as data (SPEC-310C §2
 * "Sidebar", unit C2).
 *
 *   [ All ] [ Running 2 ] [ Needs you 1 ] [ Pinned 3 ]
 *   PINNED            ▸ rows
 *   <project> …       ▸ rows, most recently touched project first
 *   ARCHIVED (12)     ▸ collapsed
 *
 * Each row states ONE status, the most urgent that applies:
 *
 *   running  a pulse and the elapsed time — plus a muted second line from
 *            activity.live ("npm test", or the tail of the live reasoning);
 *   failed   the last turn errored;
 *   unread   a turn finished since the operator last looked;
 *   time     otherwise, how long ago it was touched.
 *
 * The inputs are three sources of different reliability, and the model is
 * explicit about what each is allowed to claim:
 *   - the session list (always present): status, turnCount, updatedAt;
 *   - activity (C1's route; null until it lands): who is running and what
 *     they are doing, and the Needs-you items;
 *   - session meta (C1's route; null until it lands): pinned, archived, and
 *     how far the operator has read. With no meta, NOTHING is unread — an
 *     unknown read state is not an unread one (honesty rule: null = unknown).
 *
 * Pure: no React, no fetch.
 */
import type { VerseProject, VerseSession } from '../../../data/api-types.js';
import type {
  NeedsYouItem,
  VerseActivityLive,
  VerseActivityResponse,
  VerseSessionMeta,
  VerseSessionMetaResponse,
} from '../../../../core/verse/workbench-types.js';
import { groupSessions } from '../verse-model.js';

export const SIDEBAR_FILTERS = ['all', 'running', 'needs-you', 'pinned'] as const;
export type SidebarFilter = (typeof SIDEBAR_FILTERS)[number];

export const SIDEBAR_FILTER_LABEL: Readonly<Record<SidebarFilter, string>> = {
  all: 'All',
  running: 'Running',
  'needs-you': 'Needs you',
  pinned: 'Pinned',
};

export type RowStatus =
  | { kind: 'running'; startedAt: string | null }
  | { kind: 'failed' }
  | { kind: 'unread'; newTurns: number }
  | { kind: 'time'; at: string };

export interface SidebarRow {
  session: VerseSession;
  status: RowStatus;
  /** The running chat's muted second line; null when it is not running or nothing is known. */
  live: { text: string; startedAt: string | null } | null;
  pinned: boolean;
  archived: boolean;
  needsYou: boolean;
}

export type SidebarGroupKind = 'pinned' | 'project' | 'archived';

export interface SidebarGroup {
  id: string;
  kind: SidebarGroupKind;
  label: string;
  /** The project's path (tooltip) for a project group. */
  projectPath: string | null;
  enrolled: boolean;
  rows: SidebarRow[];
}

export interface SidebarModel {
  groups: SidebarGroup[];
  counts: Record<SidebarFilter, number>;
  /** Meta is known (C1's route answered) — pin/archive controls can work. */
  metaAvailable: boolean;
}

export interface SidebarInput {
  sessions: readonly VerseSession[];
  projects: readonly VerseProject[];
  query: string;
  filter: SidebarFilter;
  activity: VerseActivityResponse | null;
  meta: VerseSessionMetaResponse | null;
  /** turnCount this tab has seen per chat (opened here) — clears a dot before the server confirms. */
  localSeen: ReadonlyMap<string, number>;
  /** The open chat is never unread. */
  selectedId: string | null;
}

/** Ids of chats a Needs-you item points at (as its subject or its target). */
export function needsYouSessionIds(items: readonly NeedsYouItem[]): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (item.subject.sessionId) out.add(item.subject.sessionId);
    if (item.target.kind === 'session') out.add(item.target.sessionId);
  }
  return out;
}

const THINKING_TAIL_CHARS = 72;

/** "npm test" / "…the tail of what it is thinking" / "Writing" — never a guess. */
export function liveLine(live: VerseActivityLive | null): string | null {
  if (!live) return null;
  if (live.phase === 'tool' && live.tool) return live.tool;
  if (live.thinkingTail && live.thinkingTail.trim()) {
    const tail = live.thinkingTail.replace(/\s+/g, ' ').trim();
    return tail.length > THINKING_TAIL_CHARS ? `…${tail.slice(tail.length - THINKING_TAIL_CHARS + 1).trimStart()}` : tail;
  }
  switch (live.phase) {
    case 'thinking': return 'Thinking';
    case 'writing': return 'Writing';
    case 'waiting': return 'Waiting for the model';
    case 'tool': return 'Running a tool';
    default: return null;
  }
}

function metaFor(meta: VerseSessionMetaResponse | null, id: string): VerseSessionMeta | null {
  return meta?.sessions[id] ?? null;
}

export function buildSidebar(input: SidebarInput): SidebarModel {
  const { sessions, projects, query, filter, activity, meta, localSeen, selectedId } = input;
  const running = new Map((activity?.running ?? []).map((r) => [r.sessionId, r]));
  const needs = needsYouSessionIds(activity?.needsYou ?? []);
  const metaAvailable = meta !== null;

  const rows = new Map<string, SidebarRow>();
  for (const session of sessions) {
    const m = metaFor(meta, session.id);
    const activityRow = running.get(session.id);
    const isRunning = session.status === 'running' || activityRow !== undefined;
    const serverSeen = m?.seenTurnCount ?? null;
    const seen = Math.max(serverSeen ?? -1, localSeen.get(session.id) ?? -1);
    // Unread needs a KNOWN read state: meta answered (this chat's entry or,
    // absent one, its default of "never opened" = 0) or this tab opened it.
    const knownSeen = metaAvailable ? Math.max(seen, 0) : seen;
    const unread = session.id !== selectedId && knownSeen >= 0 && session.turnCount > knownSeen ? session.turnCount - knownSeen : 0;
    // Without activity, a failed chat is the one "needs you" signal the list itself carries.
    const needsYou = activity ? needs.has(session.id) : session.status === 'error';
    const status: RowStatus = isRunning
      ? { kind: 'running', startedAt: activityRow?.startedAt ?? null }
      : session.status === 'error'
        ? { kind: 'failed' }
        : unread > 0
          ? { kind: 'unread', newTurns: unread }
          : { kind: 'time', at: session.updatedAt };
    const text = isRunning ? liveLine(activityRow?.live ?? null) : null;
    rows.set(session.id, {
      session,
      status,
      live: text === null ? null : { text, startedAt: activityRow?.startedAt ?? null },
      pinned: m?.pinned === true,
      archived: m?.archived === true,
      needsYou,
    });
  }

  const all = [...rows.values()];
  const counts: Record<SidebarFilter, number> = {
    all: all.filter((r) => !r.archived).length,
    running: all.filter((r) => r.status.kind === 'running').length,
    'needs-you': all.filter((r) => r.needsYou).length,
    pinned: all.filter((r) => r.pinned && !r.archived).length,
  };

  const pass = (row: SidebarRow): boolean => {
    switch (filter) {
      case 'running': return row.status.kind === 'running';
      case 'needs-you': return row.needsYou;
      case 'pinned': return row.pinned;
      default: return true;
    }
  };

  // Title/project search reuses the 3.9 grouping (same matching, same order).
  const matched = groupSessions(all.filter(pass).map((r) => r.session), projects, query);
  const groups: SidebarGroup[] = [];
  const pinnedRows: SidebarRow[] = [];
  const archivedRows: SidebarRow[] = [];
  const projectGroups: SidebarGroup[] = [];
  for (const group of matched) {
    const projectRows: SidebarRow[] = [];
    for (const session of group.sessions) {
      const row = rows.get(session.id)!;
      if (row.archived) archivedRows.push(row);
      else if (row.pinned) pinnedRows.push(row);
      else projectRows.push(row);
    }
    if (projectRows.length > 0) {
      projectGroups.push({
        id: `project:${group.projectPath}`,
        kind: 'project',
        label: group.name,
        projectPath: group.projectPath,
        enrolled: group.enrolled,
        rows: projectRows,
      });
    }
  }
  const newest = (a: SidebarRow, b: SidebarRow) => b.session.updatedAt.localeCompare(a.session.updatedAt);
  if (pinnedRows.length > 0) groups.push({ id: 'pinned', kind: 'pinned', label: 'Pinned', projectPath: null, enrolled: false, rows: pinnedRows.sort(newest) });
  groups.push(...projectGroups);
  if (archivedRows.length > 0) groups.push({ id: 'archived', kind: 'archived', label: 'Archived', projectPath: null, enrolled: false, rows: archivedRows.sort(newest) });
  return { groups, counts, metaAvailable };
}
