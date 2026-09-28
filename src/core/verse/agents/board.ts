/**
 * core/verse/agents/board.ts — where every chat / agent sits on the Agents
 * board, and why. PURE: the API hands it sessions, agent records, read state
 * and the last Checks reading; it returns cards and Needs-you items.
 *
 * COLUMNS (Devin's in progress / blocked / ready for review; Superset's
 * working / blocked / awaiting review):
 *
 *   Working           a turn or setup is running; a plan is being written;
 *                     CI is running on a PR Verse is driving (Auto-merge on),
 *                     or failed with Auto-fix about to answer it.
 *   Needs you         BLOCKED ON THE OPERATOR: a failed turn not yet resolved,
 *                     a plan waiting for approval, the spend cap reached,
 *                     setup failed, CI red with no auto-fix left, a PR that
 *                     cannot merge (conflicts).
 *   Ready for review  something to look at: an unread finished turn, an open
 *                     PR, work in the workspace not yet in a PR.
 *   Done              merged, archived, or read with nothing left to do.
 *
 * "MARK READ" NEVER CLEARS NEEDS YOU (Nimbalyst's rule). Read state only ever
 * moves a card between Ready for review and Done. A Needs-you card leaves
 * that column when its cause is gone — the plan approved, the cap raised, a
 * new turn sent — or when the operator RESOLVES it (a failed turn), which is
 * its own explicit action, never part of a bulk mark-read.
 *
 * SPEND is the list-price equivalent of the tokens used (subscriptions are
 * not billed per token) — the same number the per-chat meter shows.
 */
import { basename } from 'node:path';

import type { VerseSession } from '../types.js';
import { NEEDS_YOU_DETAIL_MAX, NEEDS_YOU_TITLE_MAX, type NeedsYouAction, type NeedsYouItem, type VerseLiveStatus } from '../workbench-types.js';
import { listCostUsd, type ListPrice } from '../multimodel/escalation.js';
import {
  AGENT_COLUMNS,
  MAX_AUTO_FIX_ATTEMPTS,
  SPEND_WARN_FRACTION,
  VERSE_AGENTS_PATH,
  type AgentCard,
  type AgentChecksSummary,
  type AgentColumn,
  type AgentReasonCode,
  type AgentRecord,
  type AgentSpend,
  type ScriptRunRecord,
} from './types.js';

export interface BoardInput {
  sessions: readonly VerseSession[];
  agents: readonly AgentRecord[];
  /** Read state per session id (session-meta). */
  unread: (session: VerseSession) => boolean;
  archivedChat: (sessionId: string) => boolean;
  pinnedChat: (sessionId: string) => boolean;
  /** Board-level "resolved" turn for a chat with no agent record. */
  resolvedTurn: (sessionId: string) => number | null;
  /** The last Checks reading per agent id (the supervisor's cache). */
  checks: (agentId: string) => AgentChecksSummary | null;
  live: (sessionId: string) => VerseLiveStatus | null;
  lastActivity: (sessionId: string) => string | null;
  priceOf: (engine: string, model: string) => ListPrice | null;
  now: number;
}

/** Spend for a session at its model's list price. */
export function sessionSpend(session: Pick<VerseSession, 'engine' | 'model' | 'usage'> | null, capUsd: number | null, priceOf: BoardInput['priceOf']): AgentSpend {
  if (!session) return { usd: null, capUsd, fraction: null, tokens: 0 };
  const u = session.usage;
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const price = priceOf(session.engine, session.model);
  const usd = price ? listCostUsd({ input: u.inputTokens + u.cacheCreationTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens }, price) : null;
  const fraction = usd !== null && capUsd !== null && capUsd > 0 ? usd / capUsd : null;
  return { usd, capUsd, fraction, tokens };
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`;
}

function latestScript(agent: AgentRecord | null, kind: ScriptRunRecord['kind']): ScriptRunRecord | null {
  if (!agent) return null;
  for (let i = agent.scripts.length - 1; i >= 0; i -= 1) if (agent.scripts[i]!.kind === kind) return agent.scripts[i]!;
  return null;
}

interface Placement {
  column: AgentColumn;
  reason: AgentReasonCode;
  text: string;
}

/** The one rule table (ordered: first match wins). Exported for the tests. */
export function placeCard(input: {
  session: VerseSession | null;
  agent: AgentRecord | null;
  unread: boolean;
  archived: boolean;
  resolvedTurn: number | null;
  checks: AgentChecksSummary | null;
  spend: AgentSpend;
}): Placement {
  const { session, agent, checks, spend } = input;
  if (input.archived) return { column: 'done', reason: 'archived', text: agent?.archived?.reason === 'merged' ? 'Merged and archived' : 'Archived' };
  const setup = latestScript(agent, 'setup');
  if (setup?.state === 'running') return { column: 'working', reason: 'setup-running', text: 'Running setup' };
  if (session?.status === 'running') {
    if (agent?.plan.enabled && agent.plan.state === 'drafting') return { column: 'working', reason: 'plan-drafting', text: 'Writing a plan' };
    return { column: 'working', reason: 'running', text: 'Working' };
  }
  if (setup?.state === 'failed' && (agent?.pendingPrompt || (session?.turnCount ?? 0) === 0)) {
    return { column: 'needs-you', reason: 'setup-failed', text: `Setup failed${setup.exitCode !== null ? ` (exit ${setup.exitCode})` : ''}` };
  }
  if (!session) return { column: 'needs-you', reason: 'setup-failed', text: 'No chat is attached to this workspace' };
  if (spend.fraction !== null && spend.fraction >= 1) {
    return { column: 'needs-you', reason: 'spend-cap', text: `Spend cap reached (${fmtUsd(spend.usd!)} of ${fmtUsd(spend.capUsd!)})` };
  }
  if (agent?.plan.enabled && agent.plan.state === 'awaiting-approval') return { column: 'needs-you', reason: 'plan-ready', text: 'Plan ready for your approval' };
  const resolved = agent ? agent.resolvedFailureTurn : input.resolvedTurn;
  if (session.status === 'error' && resolved !== session.turnCount) return { column: 'needs-you', reason: 'failed', text: 'The last turn failed' };
  if (checks?.pr?.state === 'merged') return { column: 'done', reason: 'merged', text: `PR #${checks.pr.number} merged` };
  const prOpen = checks?.pr && (checks.pr.state === 'open' || checks.pr.state === 'draft');
  if (prOpen && checks.ci === 'failing') {
    if (agent?.autoFix && agent.autoFixAttempts < MAX_AUTO_FIX_ATTEMPTS) return { column: 'working', reason: 'ci-running', text: 'CI failed — Auto-fix is on it' };
    return {
      column: 'needs-you',
      reason: 'ci-failed',
      text: agent?.autoFix ? `CI still failing after ${agent.autoFixAttempts} auto-fix attempts` : `CI failing on PR #${checks.pr!.number}`,
    };
  }
  if (prOpen && agent?.loopNote && /conflict/i.test(agent.loopNote)) return { column: 'needs-you', reason: 'merge-blocked', text: agent.loopNote };
  if (prOpen && checks.ci === 'pending' && agent?.autoMerge) return { column: 'working', reason: 'ci-running', text: 'CI running — merges when green' };
  if (prOpen) return { column: 'review', reason: 'pr-open', text: `PR #${checks.pr!.number} ${checks.ci === 'passing' ? 'green' : checks.ci === 'pending' ? 'checks running' : 'open'}` };
  if (input.unread) return { column: 'review', reason: 'unread', text: session.status === 'error' ? 'Failed (resolved) — unread' : 'Finished — unread' };
  if (checks && (checks.dirty > 0 || checks.ahead > 0)) {
    return { column: 'review', reason: 'changes', text: checks.dirty > 0 ? `${checks.dirty} uncommitted change${checks.dirty === 1 ? '' : 's'}` : `${checks.ahead} commit${checks.ahead === 1 ? '' : 's'} not in a PR` };
  }
  return { column: 'done', reason: 'idle', text: 'Idle' };
}

function repoName(path: string | null | undefined): string | null {
  if (!path) return null;
  return basename(path) || null;
}

/** Build every card, newest activity first within each column (pinned first). */
export function buildBoard(input: BoardInput): AgentCard[] {
  const byId = new Map(input.sessions.map((s) => [s.id, s] as const));
  const agentBySession = new Map<string, AgentRecord>();
  for (const a of input.agents) if (a.sessionId) agentBySession.set(a.sessionId, a);
  const cards: AgentCard[] = [];

  const push = (session: VerseSession | null, agent: AgentRecord | null): void => {
    const sessionId = session?.id ?? agent?.sessionId ?? null;
    const archived = agent ? agent.archived !== null : sessionId !== null && input.archivedChat(sessionId);
    const unread = session ? input.unread(session) : false;
    const checks = agent ? input.checks(agent.id) : null;
    const spend = sessionSpend(session, agent?.spendCapUsd ?? null, input.priceOf);
    const placed = placeCard({
      session,
      agent,
      unread,
      archived,
      resolvedTurn: sessionId ? input.resolvedTurn(sessionId) : null,
      checks,
      spend,
    });
    const live = session && session.status === 'running' ? input.live(session.id) : null;
    const setupRunning = latestScript(agent, 'setup')?.state === 'running';
    cards.push({
      id: agent?.id ?? `chat:${sessionId}`,
      agentId: agent?.id ?? null,
      sessionId,
      title: (agent?.title && (!session || session.title === '' || session.title === 'New chat') ? agent.title : session?.title || agent?.title || 'Untitled').slice(0, 200),
      column: placed.column,
      reason: placed.reason,
      reasonText: placed.text,
      seatId: session?.seatId ?? null,
      engine: session?.engine ?? null,
      model: session?.model ?? null,
      repo: repoName(agent?.workspace?.rootPath ?? session?.projectPath),
      branch: agent?.workspace?.branch ?? null,
      workspacePath: agent?.workspace && !agent.archived ? agent.workspace.path : null,
      status: archived ? 'archived' : setupRunning || !session ? 'setup' : session.status,
      unread,
      pinned: agent?.pinned ?? (sessionId ? input.pinnedChat(sessionId) : false),
      createdAt: agent?.createdAt ?? session?.createdAt ?? new Date(input.now).toISOString(),
      updatedAt: session && agent ? (session.updatedAt > agent.updatedAt ? session.updatedAt : agent.updatedAt) : session?.updatedAt ?? agent!.updatedAt,
      startedAt: live ? live.startedAt : null,
      lastActivity: live?.tool ? `Running ${live.tool}`.slice(0, 160) : sessionId ? input.lastActivity(sessionId) : null,
      turnCount: session?.turnCount ?? 0,
      spend,
      checks,
      autoFix: agent?.autoFix ?? false,
      autoMerge: agent?.autoMerge ?? false,
      plan: agent?.plan.enabled ? agent.plan : null,
      ports: agent?.workspace ? { base: agent.workspace.portBase, count: agent.workspace.portCount } : null,
      runScripts: [],
      scripts: agent?.scripts ?? [],
      loopNote: agent?.loopNote ?? null,
      heldPrompt: Boolean(agent?.pendingPrompt),
      archived,
      restorable: Boolean(agent?.archived?.sha && agent.workspace),
    });
  };

  for (const session of input.sessions) push(session, agentBySession.get(session.id) ?? null);
  // Agents whose chat is gone (deleted) or not bound yet still show — their workspace is real.
  for (const agent of input.agents) if (!agent.sessionId || !byId.has(agent.sessionId)) push(null, agent);

  const colIndex = (c: AgentColumn) => AGENT_COLUMNS.indexOf(c);
  cards.sort((a, b) => colIndex(a.column) - colIndex(b.column) || Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return cards;
}

export function countColumns(cards: readonly AgentCard[]): Record<AgentColumn, number> {
  const counts: Record<AgentColumn, number> = { working: 0, 'needs-you': 0, review: 0, done: 0 };
  for (const c of cards) counts[c.column] += 1;
  return counts;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const ITEM_ENGINES = new Set(['claude', 'codex', 'grok', 'local']);

/**
 * The drawer's (and the desktop's "Needs you") items for agents. A failed
 * turn is NOT here: C1's `chat-failed` item already covers every chat.
 * Spend warns at 80% (a pre-stop warning) and again, higher, at the cap.
 */
export function agentNeedsYouItems(cards: readonly AgentCard[], nowIso: string): NeedsYouItem[] {
  const out: NeedsYouItem[] = [];
  for (const card of cards) {
    if (!card.agentId || card.archived) continue;
    const at = (verb: string) => `${VERSE_AGENTS_PATH}/${encodeURIComponent(card.agentId!)}/${verb}`;
    const base = {
      source: 'chats' as const,
      detail: null as string | null,
      since: card.updatedAt || nowIso,
      expiresAt: null,
      subject: {
        repo: card.repo,
        pr: card.checks?.pr?.number ?? null,
        seatId: card.seatId,
        sessionId: card.sessionId,
        engine: card.engine && ITEM_ENGINES.has(card.engine) ? (card.engine as 'claude') : null,
      },
      target: card.sessionId ? ({ kind: 'session', sessionId: card.sessionId } as const) : ({ kind: 'section', section: 'agents', anchor: `agent:${card.agentId}` } as const),
    };
    const title = clip(card.title, 70);
    if (card.reason === 'plan-ready') {
      const approve: NeedsYouAction = {
        kind: 'approve',
        label: 'Approve plan',
        request: { method: 'POST', path: at('plan'), body: { action: 'approve' } },
        confirm: { title: `Approve the plan for ${title}?`, body: 'The seat starts making the changes it planned, in its own workspace.', confirmLabel: 'Approve plan' },
        destructive: false,
      };
      const reject: NeedsYouAction = {
        kind: 'reject',
        label: 'Discard plan',
        request: { method: 'POST', path: at('plan'), body: { action: 'discard' } },
        confirm: { title: `Discard the plan for ${title}?`, body: 'Nothing is changed. You can ask for a new plan in the chat.', confirmLabel: 'Discard' },
        destructive: true,
      };
      out.push({
        ...base,
        id: clip(`chats:agent-plan:${card.agentId}@${card.plan?.turn ?? 0}`, 200),
        kind: 'agent-plan',
        severity: 'warn',
        title: clip(`Plan ready: ${title}`, NEEDS_YOU_TITLE_MAX),
        detail: card.plan?.text ? clip(card.plan.text.replace(/\s+/g, ' ').trim(), NEEDS_YOU_DETAIL_MAX) : null,
        actions: [approve, reject],
      });
      continue;
    }
    if (card.spend.fraction !== null && card.spend.fraction >= SPEND_WARN_FRACTION) {
      const reached = card.spend.fraction >= 1;
      out.push({
        ...base,
        id: clip(`chats:agent-spend:${card.agentId}@${reached ? 'cap' : 'warn'}:${card.spend.capUsd}`, 200),
        kind: 'agent-spend',
        severity: reached ? 'high' : 'warn',
        title: clip(
          reached
            ? `Spend cap reached: ${title} (${fmtUsd(card.spend.usd!)})`
            : `${title} has used ${Math.round(card.spend.fraction * 100)}% of its ${fmtUsd(card.spend.capUsd!)} cap`,
          NEEDS_YOU_TITLE_MAX,
        ),
        detail: 'At API list price — an equivalent, not a bill. Raise the cap on the Agents board to continue.',
        target: { kind: 'section', section: 'agents', anchor: `agent:${card.agentId}` },
        actions: [{ kind: 'fix', label: 'Raise cap', request: null, confirm: null, destructive: false }],
      });
      if (reached) continue;
    }
    if (card.reason === 'setup-failed') {
      out.push({
        ...base,
        id: clip(`chats:agent-setup:${card.agentId}`, 200),
        kind: 'agent-setup',
        severity: 'warn',
        title: clip(`Setup failed: ${title}`, NEEDS_YOU_TITLE_MAX),
        detail: card.reasonText,
        target: { kind: 'section', section: 'agents', anchor: `agent:${card.agentId}` },
        actions: [{ kind: 'fix', label: 'Show setup', request: null, confirm: null, destructive: false }],
      });
    } else if (card.reason === 'ci-failed' || card.reason === 'merge-blocked') {
      out.push({
        ...base,
        id: clip(`chats:agent-ci:${card.agentId}@${card.checks?.pr?.number ?? 0}:${card.reason}`, 200),
        kind: 'agent-ci',
        severity: 'warn',
        title: clip(`${card.reason === 'ci-failed' ? 'CI failing' : 'Cannot merge'}: ${title}`, NEEDS_YOU_TITLE_MAX),
        detail: clip(card.reasonText, NEEDS_YOU_DETAIL_MAX),
        actions: card.checks?.pr?.url ? [{ kind: 'fix', label: 'Open Checks', request: null, confirm: null, destructive: false }] : [],
      });
    }
  }
  return out;
}
