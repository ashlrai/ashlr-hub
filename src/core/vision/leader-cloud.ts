/**
 * Leader → cloud backlog (3.11 cloud lane, unit C5).
 *
 * A Leader memo may carry code-change actions (`work.dispatch`: a task for a
 * repo, with a title and a detail). Each one is also a good brief for a
 * Claude Code cloud session, so the memo's code-change actions are copied
 * into the cloud lane's self-improvement backlog as `CloudBacklogItem`s.
 *
 * That is the ONLY integration: nothing here launches a session. The cloud
 * scheduler / Improve button picks backlog items and launches them under the
 * cloud budget (per-day caps, self-improve toggle, credit reserve), which is
 * the consent gate for spending credits — not the Leader's standing grant.
 * WHY dry-run memos are converted too: a backlog item is a suggestion, not an
 * action, and with no grant every memo is a dry run, so gating on the grant
 * would make the cloud lane blind to the Leader exactly when the fleet can't
 * act on its proposals.
 *
 * Excluded, on purpose:
 *   - class C (escalated) actions — they stay Needs-you items for Mason;
 *   - actions Mason already vetoed;
 *   - goals / escalations / every other kind — not a single code change;
 *   - repos that are not a GitHub `owner/name` (the cloud lane clones origin).
 *
 * All text is untrusted model output (already scrubbed by leader-memo.ts); it
 * is scrubbed again here and framed as a brief to verify, never replayed as
 * instructions to Verse itself.
 */
import type { CloudBacklogItem } from '../cloud/types.js';
import { cleanModelText } from './leader-memo.js';
import type { LeaderAction, LeaderActionClass, LeaderActionOf, LeaderMemo } from './leader-types.js';

/** Same shape the cloud service accepts (service.ts validates launches against it). */
const GITHUB_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Backlog area for Leader-suggested items (the backlog view groups by area). */
export const LEADER_CLOUD_AREA = 'leader';

/**
 * Class → backlog priority. Class A is inside the grant and applies at once,
 * so it ranks with the highest built-in items; class B waited out a veto
 * window, one step lower. Class C never reaches the backlog.
 */
const PRIORITY_BY_CLASS: Readonly<Record<Exclude<LeaderActionClass, 'C'>, 1 | 2>> = Object.freeze({ A: 1, B: 2 });

const TITLE_MAX = 80;
const DETAIL_MAX = 4_000;
const LINE_MAX = 400;
const EVIDENCE_MAX_ITEMS = 6;
/**
 * Well under CLOUD_PROMPT_MAX_CHARS: the delivery contract is appended to the
 * prompt at launch, and the service truncates anything longer — a cut brief
 * would lose the memo context at its end.
 */
export const LEADER_CLOUD_PROMPT_MAX = 8_000;

/** `leader-<memoId>-<n>`, n = the action's index in `memo.actions` (stable across re-reads). */
export function leaderBacklogItemId(memoId: string, index: number): string {
  return `leader-${memoId}-${index}`;
}

function normalisedTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

type DispatchAction = LeaderActionOf<'work.dispatch'>;

/** A `work.dispatch` for a GitHub repo, in class A/B, that Mason has not vetoed. */
function isCloudWorthy(action: LeaderAction): action is DispatchAction {
  if (action.kind !== 'work.dispatch') return false;
  if (action.class === 'C' || action.status === 'escalated' || action.status === 'vetoed') return false;
  const repo = action.params?.task?.repo;
  return typeof repo === 'string' && GITHUB_REPO_RE.test(repo);
}

function memoContext(memo: Pick<LeaderMemo, 'id' | 'bottleneck' | 'move'>): string[] {
  const lines: string[] = [];
  const b = memo.bottleneck;
  const statement = cleanModelText(b?.statement, LINE_MAX);
  if (statement) {
    lines.push(`Bottleneck: ${statement}`);
    const metric = cleanModelText(b?.metric, 80);
    if (metric) lines.push(`Metric: ${metric}`);
    const evidence = (b?.evidence ?? [])
      .slice(0, EVIDENCE_MAX_ITEMS)
      .map((e) => cleanModelText(e, LINE_MAX))
      .filter((e): e is string => e !== null);
    if (evidence.length > 0) lines.push('Evidence:', ...evidence.map((e) => `- ${e}`));
  }
  const move = cleanModelText(memo.move?.statement, LINE_MAX);
  if (move) lines.push(`The Leader's move against it: ${move}`);
  if (lines.length === 0) return [];
  return [`Context from the Leader's memo ${memo.id}:`, ...lines];
}

function buildPrompt(action: DispatchAction, context: readonly string[]): string {
  const task = action.params.task;
  const title = cleanModelText(task.title, TITLE_MAX * 2) ?? 'Leader-proposed change';
  const detail = cleanModelText(task.detail, DETAIL_MAX);
  const why = cleanModelText(action.why, LINE_MAX);
  const parts = [
    `Task for ${task.repo}: ${title}`,
    detail,
    why ? `Why the Leader proposed it: ${why}` : null,
    context.length > 0 ? context.join('\n') : null,
    // The brief is model-written: ask the session to check it against the
    // code rather than trust it, and to deliver a no-change report when the
    // premise is wrong instead of forcing a diff.
    'This task was proposed by Ashlr Verse\'s Leader from its own digests. Verify each claim against the code before acting; '
      + 'if the premise is wrong or the work is already done, report no-change instead of forcing a diff. '
      + 'Keep the change focused, add a regression test for every behaviour change, and keep tests HOME-isolated with no paid model calls.',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const prompt = parts.join('\n\n');
  return prompt.length > LEADER_CLOUD_PROMPT_MAX ? `${prompt.slice(0, LEADER_CLOUD_PROMPT_MAX - 1)}…` : prompt;
}

/**
 * Convert a memo's code-change actions into cloud backlog items (pure).
 * Deduped within the memo by id and by normalised title — the backlog
 * dedupes again across memos. Empty for a memo that did not complete.
 */
export function leaderMemoToCloudBacklog(memo: Pick<LeaderMemo, 'id' | 'status' | 'bottleneck' | 'move' | 'actions'>): CloudBacklogItem[] {
  if (memo.status !== 'ok') return [];
  const context = memoContext(memo);
  const items: CloudBacklogItem[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  memo.actions.forEach((action, index) => {
    if (!isCloudWorthy(action)) return;
    const title = cleanModelText(action.params.task.title, TITLE_MAX);
    if (!title) return;
    const id = leaderBacklogItemId(memo.id, index);
    const key = normalisedTitle(title);
    if (seenIds.has(id) || seenTitles.has(key)) return;
    seenIds.add(id);
    seenTitles.add(key);
    items.push({
      id,
      title,
      prompt: buildPrompt(action, context),
      area: LEADER_CLOUD_AREA,
      priority: PRIORITY_BY_CLASS[action.class as Exclude<LeaderActionClass, 'C'>],
      repo: action.params.task.repo,
    });
  });
  return items;
}

/** The backlog's entry point (cloud/backlog.ts appendUserBacklogItems), injected so tests stay hermetic. */
export interface LeaderCloudBacklogDeps {
  append(items: readonly CloudBacklogItem[]): number;
}

export interface LeaderCloudSuggestResult {
  /** Items the memo produced. */
  proposed: number;
  /** Items the backlog accepted as new (the rest were duplicates). */
  added: number;
  /** Plain sentence when the backlog write failed; null otherwise. */
  error: string | null;
}

/**
 * Hand a memo's code-change actions to the cloud backlog. Never throws: the
 * backlog is a side channel, and a failure here must not fail the memo. No
 * write at all when the memo has no code-change actions.
 */
export function suggestLeaderCloudBacklog(deps: LeaderCloudBacklogDeps, memo: Pick<LeaderMemo, 'id' | 'status' | 'bottleneck' | 'move' | 'actions'>): LeaderCloudSuggestResult {
  const items = leaderMemoToCloudBacklog(memo);
  if (items.length === 0) return { proposed: 0, added: 0, error: null };
  try {
    const added = deps.append(items);
    return { proposed: items.length, added: Number.isFinite(added) ? Math.max(0, Math.trunc(added)) : 0, error: null };
  } catch (err) {
    const reason = cleanModelText(err instanceof Error ? err.message : String(err), 200) ?? 'error';
    return { proposed: items.length, added: 0, error: `The cloud backlog did not accept the Leader's tasks: ${reason}` };
  }
}
