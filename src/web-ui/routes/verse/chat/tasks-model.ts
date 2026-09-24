/**
 * routes/verse/chat/tasks-model.ts — what is running right now, for the
 * "◌ 3 running tasks" chip and the dock's Tasks pane (SPEC-310C §2–§3, C2).
 *
 * Two kinds of task, because the operator is waiting on both:
 *   - THIS TURN: the open chat's tool calls and subagents since its last ask
 *     (a running `Task` is a subagent; everything else is a tool);
 *   - OTHER CHATS: every other chat with a turn in flight, from activity
 *     (C1) when it answers, else from the session list's `status`.
 *
 * Pure over transcript items and the session / activity lists.
 */
import type { VerseEngine, VerseSession } from '../../../data/api-types.js';
import type { VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import type { TranscriptItem } from '../verse-store.js';
import { summarizeToolInput } from '../verse-model.js';
import { liveLine } from './sidebar-model.js';
import { actionForName } from './tool-semantics.js';

export type TurnTaskStatus = 'running' | 'done' | 'failed';

export interface TurnTask {
  toolUseId: string;
  kind: 'subagent' | 'tool';
  /** Tool name as the CLI spelled it. */
  name: string;
  /** What it is doing: the command, the path, the subagent's description. */
  detail: string;
  /** ISO time the call started. */
  startedAt: string;
  status: TurnTaskStatus;
  durationMs: number | null;
}

export interface ChatTask {
  sessionId: string;
  title: string;
  engine: VerseEngine;
  /** ISO start of the running turn when activity knows it; null = unknown. */
  startedAt: string | null;
  /** The muted "what it is doing" line; null when unknown. */
  live: string | null;
}

/** The last turn's tool calls, running first (in start order), then finished (newest first). */
export function currentTurnTasks(items: readonly TranscriptItem[]): TurnTask[] {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.kind === 'user') {
      start = i;
      break;
    }
  }
  const running: TurnTask[] = [];
  const finished: TurnTask[] = [];
  for (let i = start; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== 'tool') continue;
    const task: TurnTask = {
      toolUseId: item.toolUseId,
      kind: actionForName(item.name) === 'task' ? 'subagent' : 'tool',
      name: item.name,
      detail: summarizeToolInput(item.input) || item.name,
      startedAt: item.at,
      status: item.result === null ? 'running' : item.result.isError ? 'failed' : 'done',
      durationMs: item.durationMs,
    };
    (task.status === 'running' ? running : finished).push(task);
  }
  return [...running, ...finished.reverse()];
}

export function otherRunningChats(
  sessions: readonly VerseSession[],
  activity: VerseActivityResponse | null,
  currentId: string | null,
): ChatTask[] {
  const out = new Map<string, ChatTask>();
  for (const row of activity?.running ?? []) {
    if (row.sessionId === currentId) continue;
    out.set(row.sessionId, {
      sessionId: row.sessionId,
      title: row.title,
      engine: row.engine,
      startedAt: row.startedAt,
      live: liveLine(row.live),
    });
  }
  // The session list can know about a run activity has not reported (a
  // server without C1's route, or the few seconds between polls).
  for (const session of sessions) {
    if (session.id === currentId || session.status !== 'running' || out.has(session.id)) continue;
    out.set(session.id, { sessionId: session.id, title: session.title, engine: session.engine, startedAt: null, live: null });
  }
  return [...out.values()];
}

export interface TaskCounts {
  /** Running calls in this turn. */
  turn: number;
  /** Of which subagents. */
  subagents: number;
  /** Other chats running. */
  chats: number;
  total: number;
}

export function countTasks(turn: readonly TurnTask[], chats: readonly ChatTask[]): TaskCounts {
  const running = turn.filter((t) => t.status === 'running');
  return {
    turn: running.length,
    subagents: running.filter((t) => t.kind === 'subagent').length,
    chats: chats.length,
    total: running.length + chats.length,
  };
}

/** "3 running tasks" — and what they are, for the chip's accessible name. */
export function describeTaskCounts(counts: TaskCounts): string {
  const head = `${counts.total} running task${counts.total === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (counts.turn > 0) parts.push(`${counts.turn} in this chat`);
  if (counts.chats > 0) parts.push(`${counts.chats} other chat${counts.chats === 1 ? '' : 's'}`);
  return parts.length > 0 ? `${head}: ${parts.join(', ')}` : head;
}
