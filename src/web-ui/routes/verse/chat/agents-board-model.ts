/**
 * routes/verse/chat/agents-board-model.ts — every chat on a four-column
 * board: Working / Needs you / Ready for review / Done. Pure.
 *
 * Built ON the chat list's own row model (sidebar-model.ts buildSidebar), so
 * "running", "needs you", "unread" and "failed" mean exactly what the chat
 * list's dots mean — one definition, however many surfaces draw it (the
 * phone's Agents tab today; the workbench's Agents board can read the same
 * function):
 *
 *   Working           the chat is running a turn (engine status or activity)
 *   Needs you         a Needs-you item points at it, or its last turn failed
 *   Ready for review  finished turns the operator has not opened yet
 *   Done              everything else that is not archived
 *
 * A chat sits in exactly ONE column, checked in that order: a running chat
 * that also has a question for you is Working (it is still moving); its
 * question is in Needs you's own list regardless. Archived chats are left
 * out. Each column is newest first.
 */
import type { VerseProject, VerseSession } from '../../../data/api-types.js';
import type { VerseActivityResponse, VerseSessionMetaResponse } from '../../../../core/verse/workbench-types.js';
import { buildSidebar, type SidebarRow } from './sidebar-model.js';

export type AgentColumnId = 'working' | 'needs-you' | 'review' | 'done';

export const AGENT_COLUMNS: ReadonlyArray<{ id: AgentColumnId; label: string; empty: string }> = [
  { id: 'working', label: 'Working', empty: 'No agent is running right now.' },
  { id: 'needs-you', label: 'Needs you', empty: 'No agent is waiting on you.' },
  { id: 'review', label: 'Ready for review', empty: 'Nothing new to review.' },
  { id: 'done', label: 'Done', empty: 'No finished agents yet.' },
];

export interface AgentColumn {
  id: AgentColumnId;
  label: string;
  empty: string;
  rows: SidebarRow[];
}

export interface AgentsBoardInput {
  sessions: readonly VerseSession[];
  projects: readonly VerseProject[];
  activity: VerseActivityResponse | null;
  meta: VerseSessionMetaResponse | null;
  localSeen: ReadonlyMap<string, number>;
}

export function columnOf(row: SidebarRow): AgentColumnId {
  if (row.status.kind === 'running') return 'working';
  if (row.needsYou || row.status.kind === 'failed') return 'needs-you';
  if (row.status.kind === 'unread') return 'review';
  return 'done';
}

export function buildAgentsBoard(input: AgentsBoardInput): AgentColumn[] {
  const model = buildSidebar({
    sessions: input.sessions,
    projects: input.projects,
    query: '',
    filter: 'all',
    activity: input.activity,
    meta: input.meta,
    localSeen: input.localSeen,
    selectedId: null,
  });
  const byColumn = new Map<AgentColumnId, SidebarRow[]>(AGENT_COLUMNS.map((c) => [c.id, []]));
  for (const group of model.groups) {
    for (const row of group.rows) {
      if (row.archived) continue;
      byColumn.get(columnOf(row))!.push(row);
    }
  }
  const newest = (a: SidebarRow, b: SidebarRow) => b.session.updatedAt.localeCompare(a.session.updatedAt);
  return AGENT_COLUMNS.map((c) => ({ ...c, rows: byColumn.get(c.id)!.sort(newest) }));
}

/** Column counts, for a tab badge or a summary line. */
export function boardCounts(columns: readonly AgentColumn[]): Record<AgentColumnId, number> {
  const out: Record<AgentColumnId, number> = { working: 0, 'needs-you': 0, review: 0, done: 0 };
  for (const c of columns) out[c.id] = c.rows.length;
  return out;
}
