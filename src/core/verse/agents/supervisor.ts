/**
 * core/verse/agents/supervisor.ts — the loop that carries an agent from
 * "setup done" to "merged and archived" while the operator does something
 * else. One tick every TICK_MS, only while the Verse server runs; each step
 * is something the operator switched on for THAT agent:
 *
 *   setup finished    → send the prompt they typed (as a plan request when
 *                       Plan first is on). Setup failed → Needs you; nothing sent.
 *   plan turn done    → the plan is lifted out of the transcript and waits for
 *                       approval (Needs you); nothing runs until they approve.
 *   spend             → 80% of the cap: a warning (Needs you + notification);
 *                       100%: the running turn is stopped and no loop turn is
 *                       sent until the cap is raised.
 *   CI red            → Auto-fix on: the failing checks and their log tails go
 *                       to the same seat, ONCE per PR head, at most
 *                       MAX_AUTO_FIX_ATTEMPTS per agent. Off: Needs you.
 *   CI green          → Auto-merge on and the verdict allows it (checks.ts):
 *                       squash-merge, then archive (worktree + branch).
 *
 * GitHub is asked at most every CHECKS_ACTIVE_MS per agent with a PR in play
 * and every CHECKS_IDLE_MS otherwise, never for archived agents, never while
 * the agent's own turn is running (the branch is moving).
 *
 * A step that fails leaves a one-sentence `loopNote` on the agent (shown on
 * its card and in Checks) and is retried on a later tick — never in a burst.
 */
import { GitOpError, mergePullRequest, type GitOpsOptions, type MergeInput } from '../git-ops.js';
import type { ListPrice } from '../multimodel/escalation.js';
import {
  archiveAgent,
  extractPlan,
  refreshScripts,
  sendAgentTurn,
  sendFirstPrompt,
  type ActionDeps,
  type AgentEngine,
} from './actions.js';
import { sessionSpend } from './board.js';
import { failingCiReport, readAgentChecks, requiredAutoMergeChecks, type AgentChecksRead, type ChecksDeps } from './checks.js';
import type { ScriptLauncher } from './scripts.js';
import type { AgentStore } from './store.js';
import { MAX_AUTO_FIX_ATTEMPTS, SPEND_WARN_FRACTION, type AgentChecksSummary, type AgentRecord } from './types.js';
import { readWorkspaceConfig } from './workspace-config.js';

export const TICK_MS = 4_000;
export const CHECKS_ACTIVE_MS = 30_000;
export const CHECKS_IDLE_MS = 120_000;

export interface SupervisorDeps {
  store: () => AgentStore;
  engine: () => AgentEngine | null;
  launcher: () => ScriptLauncher;
  priceOf: (engine: string, model: string) => ListPrice | null;
  readChecks?: typeof readAgentChecks;
  failingReport?: typeof failingCiReport;
  merge?: (root: string, input: MergeInput) => Promise<unknown>;
  checksDeps?: ChecksDeps;
  /** Runs after each timed pass (the API rebuilds its board cache here). */
  afterTick?: () => Promise<void>;
  ops?: GitOpsOptions;
  now?: () => number;
}

interface ChecksEntry {
  at: number;
  read: AgentChecksRead;
}

/** The last Checks reading per agent (the board reads summaries from here). */
const checksCache = new Map<string, ChecksEntry>();
/** Heads a merge was already attempted on (a refusal is not retried on the same head). */
const mergeTried = new Map<string, string>();

export function cachedChecksSummary(agentId: string): AgentChecksSummary | null {
  return checksCache.get(agentId)?.read.summary ?? null;
}

export function cachedChecks(agentId: string): AgentChecksRead | null {
  return checksCache.get(agentId)?.read ?? null;
}

export function rememberChecks(agentId: string, read: AgentChecksRead, at = Date.now()): void {
  checksCache.set(agentId, { at, read });
  if (checksCache.size > 1_000) checksCache.delete(checksCache.keys().next().value as string);
}

export function resetSupervisorCachesForTest(): void {
  checksCache.clear();
  mergeTried.clear();
}

function actionDeps(deps: SupervisorDeps): ActionDeps {
  return {
    store: deps.store(),
    engine: deps.engine,
    launcher: deps.launcher(),
    priceOf: deps.priceOf,
    ...(deps.ops ? { ops: deps.ops } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

function describe(err: unknown): string {
  if (err instanceof GitOpError) return err.message;
  if (err instanceof Error && err.message && err.message.length < 300 && !/\/Users\/|\/home\//.test(err.message)) return err.message;
  return 'It failed for a reason Verse could not describe.';
}

async function note(store: AgentStore, id: string, loopNote: string, patch: Partial<AgentRecord> = {}): Promise<AgentRecord | null> {
  return store.update(id, (a) => ({ ...a, ...patch, loopNote }));
}

/** One agent, one tick. Exported for the tests (they drive it without timers). */
export async function superviseAgent(deps: SupervisorDeps, initial: AgentRecord): Promise<AgentRecord> {
  const now = (deps.now ?? Date.now)();
  const ad = actionDeps(deps);
  const store = ad.store;
  let agent = initial;
  if (agent.archived) return agent;

  // 1. Scripts: fold in ended runs; a finished setup releases the held prompt.
  const scripts = await refreshScripts(ad, agent);
  agent = scripts.agent;
  const setupEnded = scripts.ended.find((r) => r.kind === 'setup');
  const setupRunning = agent.scripts.some((r) => r.kind === 'setup' && r.state === 'running');
  if (agent.pendingPrompt && agent.sessionId && !setupRunning) {
    const setupFailed = setupEnded?.state === 'failed' || (!setupEnded && [...agent.scripts].reverse().find((r) => r.kind === 'setup')?.state === 'failed');
    if (setupFailed) {
      if (setupEnded) agent = (await note(store, agent.id, `Setup failed${setupEnded.exitCode !== null ? ` (exit ${setupEnded.exitCode})` : ''}: the prompt is held. Fix setup and rerun it, or send the prompt anyway.`)) ?? agent;
    } else {
      try {
        agent = await sendFirstPrompt(ad, agent, agent.pendingPrompt);
      } catch (err) {
        if (agent.loopNote === null || !agent.loopNote.startsWith('The first prompt')) {
          agent = (await note(store, agent.id, `The first prompt was not sent: ${describe(err)}`)) ?? agent;
        }
      }
    }
  }

  const engine = deps.engine();
  const session = engine && agent.sessionId ? engine.getSession(agent.sessionId) : null;
  if (!session) return agent;

  // 2. A plan turn that finished: lift the plan out; it waits for approval.
  if (agent.plan.enabled && agent.plan.state === 'drafting' && session.status !== 'running' && session.turnCount > (agent.plan.turn ?? 0)) {
    if (session.status === 'idle') {
      const plan = extractPlan(engine!.getEvents(session.id), agent.plan.turn ?? 0);
      agent = (await store.update(agent.id, (a) => ({ ...a, plan: { ...a.plan, state: plan ? 'awaiting-approval' : 'none', text: plan } }))) ?? agent;
    }
  }

  // 3. Spend: warn at 80%, stop at the cap (once per cap value).
  if (agent.spendCapUsd !== null) {
    const spend = sessionSpend(session, agent.spendCapUsd, deps.priceOf);
    if (spend.fraction !== null && spend.fraction >= 1) {
      if (session.status === 'running') engine!.cancelTurn(session.id);
      if (agent.spendStoppedAt !== agent.spendCapUsd) {
        agent = (await note(store, agent.id, `Stopped at the spend cap ($${agent.spendCapUsd.toFixed(2)} at API list price).`, { spendStoppedAt: agent.spendCapUsd, spendWarnedAt: agent.spendCapUsd })) ?? agent;
      }
      return agent;
    }
    if (spend.fraction !== null && spend.fraction >= SPEND_WARN_FRACTION && agent.spendWarnedAt !== agent.spendCapUsd) {
      agent = (await store.update(agent.id, (a) => ({ ...a, spendWarnedAt: a.spendCapUsd }))) ?? agent;
    }
  }

  // 4. The post-PR loop — only for a workspace, only while this agent is not mid-turn.
  if (!agent.workspace || session.status === 'running' || setupRunning) return agent;
  const cached = checksCache.get(agent.id);
  const prInPlay = cached?.read.summary.pr && (cached.read.summary.pr.state === 'open' || cached.read.summary.pr.state === 'draft');
  const every = prInPlay || agent.autoFix || agent.autoMerge ? CHECKS_ACTIVE_MS : CHECKS_IDLE_MS;
  if (cached && now - cached.at < every) return agent;
  let read: AgentChecksRead;
  try {
    read = await (deps.readChecks ?? readAgentChecks)(agent.workspace.path, {
      agentId: agent.id,
      sessionId: agent.sessionId,
      autoFix: agent.autoFix,
      autoMerge: agent.autoMerge,
      loopNote: agent.loopNote,
    }, { ...deps.checksDeps, ...deps.ops });
  } catch {
    // The worktree may be mid-removal or git busy: try again next interval.
    if (cached) checksCache.set(agent.id, { ...cached, at: now });
    return agent;
  }
  rememberChecks(agent.id, read, now);
  const pr = read.detail.pr;
  if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) return agent;

  // 4a. Auto-fix: failing CI goes back to the seat that wrote it, once per head.
  if (read.detail.ci === 'failing' && agent.autoFix) {
    const head = pr.headSha ?? `pr${pr.number}`;
    if (agent.autoFixSentFor.includes(head)) return agent;
    if (agent.autoFixAttempts >= MAX_AUTO_FIX_ATTEMPTS) {
      if (!agent.loopNote?.startsWith('Auto-fix gave up')) {
        agent = (await note(store, agent.id, `Auto-fix gave up after ${agent.autoFixAttempts} attempts: CI is still red. It is yours now.`)) ?? agent;
      }
      return agent;
    }
    try {
      const report = await (deps.failingReport ?? failingCiReport)(agent.workspace.path, { number: pr.number, url: pr.url }, read.detail.checks, deps.ops);
      await sendAgentTurn(ad, agent, report);
      agent = (await store.update(agent.id, (a) => ({
        ...a,
        autoFixSentFor: [...a.autoFixSentFor, head].slice(-20),
        autoFixAttempts: a.autoFixAttempts + 1,
        loopNote: `Auto-fix: sent the failing CI log to the seat (attempt ${a.autoFixAttempts + 1} of ${MAX_AUTO_FIX_ATTEMPTS}).`,
      }))) ?? agent;
      // The branch will move: read GitHub again soon rather than on the idle cadence.
      checksCache.delete(agent.id);
    } catch (err) {
      agent = (await note(store, agent.id, `Auto-fix could not send the CI log: ${describe(err)}`)) ?? agent;
    }
    return agent;
  }

  // 4b. Auto-merge: only what the verdict allows, once per head.
  if (agent.autoMerge && read.detail.mergeVerdict.allowed && pr.headSha) {
    if (mergeTried.get(agent.id) === pr.headSha) return agent;
    mergeTried.set(agent.id, pr.headSha);
    try {
      const requiredChecks = (deps.checksDeps?.requiredAutoMergeChecks ?? (() => requiredAutoMergeChecks(process.env['ASHLR_VERSE_AUTOMERGE_CHECKS'])))();
      await (deps.merge ?? ((root, input) => mergePullRequest(root, input, deps.ops)))(agent.workspace.path, { number: pr.number, headSha: pr.headSha, requiredChecks });
    } catch (err) {
      agent = (await note(store, agent.id, `Auto-merge was refused: ${describe(err)}`)) ?? agent;
      return agent;
    }
    agent = (await note(store, agent.id, `Merged PR #${pr.number}. Archiving the workspace.`)) ?? agent;
    try {
      const config = agent.workspace ? (await readWorkspaceConfig(agent.workspace.rootPath)).config : null;
      agent = await archiveAgent(ad, agent, 'merged', config);
      agent = (await note(store, agent.id, `Merged PR #${pr.number} and archived the workspace (worktree and branch removed; a snapshot is kept).`)) ?? agent;
    } catch (err) {
      agent = (await note(store, agent.id, `Merged PR #${pr.number}, but archiving failed: ${describe(err)}`)) ?? agent;
    }
    checksCache.delete(agent.id);
    return agent;
  }
  if (agent.autoMerge && !read.detail.mergeVerdict.allowed && read.detail.ci === 'passing') {
    const reason = `Auto-merge is holding: ${read.detail.mergeVerdict.reason}`;
    if (agent.loopNote !== reason) agent = (await note(store, agent.id, reason)) ?? agent;
  }
  return agent;
}

/** One pass over every live agent. Serial: GitHub and git are shared resources. */
export async function superviseOnce(deps: SupervisorDeps): Promise<void> {
  const agents = await deps.store().list();
  for (const agent of agents) {
    if (agent.archived) continue;
    try {
      await superviseAgent(deps, agent);
    } catch {
      /* one agent's failure never stops the others */
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Start the loop (idempotent). Never under a test runner — tests call superviseOnce. */
export function startSupervisor(deps: SupervisorDeps, env: NodeJS.ProcessEnv = process.env): boolean {
  if (timer) return true;
  if (env['VITEST'] || env['NODE_ENV'] === 'test' || env['ASHLR_VERSE_AGENTS_LOOP'] === '0') return false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void superviseOnce(deps)
      .then(() => deps.afterTick?.())
      .catch(() => undefined)
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return true;
}

export function supervisorRunning(): boolean {
  return timer !== null;
}

export function stopSupervisor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
