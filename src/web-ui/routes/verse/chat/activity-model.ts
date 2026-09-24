/**
 * routes/verse/chat/activity-model.ts — what a folded run of tool calls DID,
 * in one sentence (SPEC-310C §2 "Activity groups", unit C2).
 *
 * The 3.9 group line counted tool NAMES ("6 tools · Read ×4, Edit ×2"). A
 * name is the vendor's vocabulary, not the operator's: `Bash`, `exec_command`
 * and `run_shell` are all "ran a command", and nobody scanning a long session
 * wants to learn which CLI spells it how. So the group now speaks in actions,
 * using the same classification the file-activity summary uses
 * (tool-semantics `readToolFacts`). Drawn, the clauses are separated by a
 * middle dot; spoken, by commas:
 *
 *   Ran 12 commands · read 8 files · edited 3 files     (the row)
 *   Ran 12 commands, read 8 files, edited 3 files; 1 failed, 1 running   (its name)
 *
 * 3.10.1: every clause carries its noun. "read 1" after "Ran 1 command"
 * left the reader to work out what was read.
 *
 * and decides which member rows deserve to be on screen without a click: a
 * failed call is the one thing in a group the operator must see, and a
 * running call is the thing they are waiting on. Everything else stays folded
 * behind "Show N more".
 *
 * Pure — no React, no DOM — so the sentence and the auto-expand rule are
 * tested directly against transcript items.
 */
import type { ToolGroupItem, ToolGroupMember } from '../verse-store.js';
import { formatDuration } from '../verse-model.js';
import { actionForName, type ToolAction, type ToolFacts } from './tool-semantics.js';

/** Per-action counts for one group. Thinking members are not counted: they are not work. */
export type ActionCounts = Record<ToolAction, number>;

export interface ActivitySummary {
  counts: ActionCounts;
  /** Tool calls only. */
  toolCount: number;
  failed: number;
  running: number;
  /** Wall time first→last member, when both are stamped; null = unknown (never 0). */
  spanMs: number | null;
  /** "Ran 12 commands · read 8 files · edited 3 files" — the WHAT, as drawn. */
  work: string;
  /** "1 failed, 1 running" — the STATE; empty when neither. */
  state: string;
  /** The whole line as a screen reader should hear it. */
  sentence: string;
}

/** Display order and wording; every clause names its noun. */
const CLAUSES: ReadonlyArray<{ action: ToolAction; verb: string; noun: string; plural: string }> = [
  { action: 'command', verb: 'ran', noun: 'command', plural: 'commands' },
  { action: 'read', verb: 'read', noun: 'file', plural: 'files' },
  { action: 'edit', verb: 'edited', noun: 'file', plural: 'files' },
  { action: 'create', verb: 'created', noun: 'file', plural: 'files' },
  { action: 'delete', verb: 'deleted', noun: 'file', plural: 'files' },
  { action: 'search', verb: 'searched', noun: 'time', plural: 'times' },
  { action: 'web', verb: 'fetched', noun: 'page', plural: 'pages' },
  { action: 'task', verb: 'ran', noun: 'subagent', plural: 'subagents' },
  { action: 'other', verb: 'used', noun: 'other tool', plural: 'other tools' },
];

/** The row's clause separator; the accessible sentence uses commas. */
export const WORK_SEPARATOR = ' · ';

function emptyCounts(): ActionCounts {
  return { read: 0, edit: 0, create: 0, delete: 0, command: 0, search: 0, task: 0, web: 0, other: 0 };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The action a member performed: from its derived facts when present, else from its name. */
function memberAction(member: Extract<ToolGroupMember, { kind: 'tool' }>, facts: ReadonlyMap<string, ToolFacts> | null): ToolAction {
  return facts?.get(member.toolUseId)?.action ?? actionForName(member.name);
}

/** A member failed: the tool said so, or its facts read a non-zero exit. */
export function memberFailed(member: ToolGroupMember, facts: ReadonlyMap<string, ToolFacts> | null = null): boolean {
  if (member.kind !== 'tool' || member.result === null) return false;
  return member.result.isError || facts?.get(member.toolUseId)?.failed === true;
}

export function memberRunning(member: ToolGroupMember): boolean {
  return member.kind === 'tool' && member.result === null;
}

/** "Ran 12 commands · read 8 files" from counts (`separator` between clauses); "" when there is nothing. */
export function describeWork(counts: ActionCounts, separator: string = WORK_SEPARATOR): string {
  const parts: string[] = [];
  for (const clause of CLAUSES) {
    const n = counts[clause.action];
    if (n <= 0) continue;
    parts.push(`${clause.verb} ${n} ${n === 1 ? clause.noun : clause.plural}`);
  }
  return capitalize(parts.join(separator));
}

export function summarizeActivity(group: Pick<ToolGroupItem, 'items' | 'spanMs'>, facts: ReadonlyMap<string, ToolFacts> | null = null): ActivitySummary {
  const counts = emptyCounts();
  let failed = 0;
  let running = 0;
  let toolCount = 0;
  for (const member of group.items) {
    if (member.kind !== 'tool') continue;
    toolCount += 1;
    counts[memberAction(member, facts)] += 1;
    if (memberRunning(member)) running += 1;
    else if (memberFailed(member, facts)) failed += 1;
  }
  const work = describeWork(counts);
  const stateParts: string[] = [];
  if (failed > 0) stateParts.push(`${failed} failed`);
  if (running > 0) stateParts.push(`${running} running`);
  const state = stateParts.join(', ');
  const spanMs = group.spanMs !== null && group.spanMs > 0 ? group.spanMs : null;
  const sentence = [describeWork(counts, ', '), state, spanMs !== null && running === 0 ? formatDuration(spanMs) : '']
    .filter((part) => part.length > 0)
    .join('; ');
  return { counts, toolCount, failed, running, spanMs, work, state, sentence };
}

export type ActivityView = 'collapsed' | 'focus' | 'all';

/**
 * How a group opens when the operator has not chosen: on its FOCUS rows
 * (failed or running members) when it has any, folded otherwise. A group
 * that finishes clean folds itself again — the operator's own toggle, once
 * made, wins over both (the component tracks that).
 */
export function defaultActivityView(summary: Pick<ActivitySummary, 'failed' | 'running'>): ActivityView {
  return summary.failed > 0 || summary.running > 0 ? 'focus' : 'collapsed';
}

/** Members shown in `focus` view, in order, and how many that leaves behind "Show N more". */
export function focusMembers(
  group: Pick<ToolGroupItem, 'items'>,
  facts: ReadonlyMap<string, ToolFacts> | null = null,
): { shown: ToolGroupMember[]; hidden: number } {
  const shown = group.items.filter((m) => memberRunning(m) || memberFailed(m, facts));
  return { shown, hidden: group.items.length - shown.length };
}
