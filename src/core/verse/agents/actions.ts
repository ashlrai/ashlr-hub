/**
 * core/verse/agents/actions.ts — what the Agents API and the post-PR loop DO
 * to an agent, in one place: send its (held) first prompt, ask for / approve
 * a plan, run a workspace script, archive and restore, keep the workspace
 * count under the cap.
 *
 * THE ENGINE is `peekVerseEngine()`'s (never created from here: a board read
 * must not start the chat engine) and every turn goes through its own
 * `sendTurn` — the one chokepoint that refuses a busy chat, records the turn
 * and spawns the seat. Before any turn this module refuses it itself when the
 * agent's spend cap is reached.
 *
 * NODE-ONLY. Async I/O only.
 */
import { verseSessionRoots, type VerseEvent, type VerseSession } from '../types.js';
import { firstPendingFolder, folderAccessPendingMessage } from '../folder-io.js';
import { expandHomePrefix } from '../path-guard.js';
import type { VersePermissionMode, VerseSessionControlsUpdate } from '../workbench-types.js';
import type { ListPrice } from '../multimodel/escalation.js';
import { sessionSpend } from './board.js';
import type { ScriptLauncher } from './scripts.js';
import type { AgentStore } from './store.js';
import {
  DEFAULT_WORKSPACE_CAP,
  type AgentArchiveRecord,
  type AgentRecord,
  type ScriptKind,
  type ScriptRunRecord,
  type WorkspaceConfig,
} from './types.js';
import { readWorkspaceConfig, workspaceEnv } from './workspace-config.js';
import { archiveWorkspace, restoreWorkspace, type WorkspaceOpsOptions } from './workspace-ops.js';

/** The engine surface agents use (the real VerseEngineHandle conforms). */
export interface AgentEngine {
  getSession(id: string): VerseSession | null;
  getEvents(id: string, fromSeq?: number): VerseEvent[];
  sendTurn(id: string, text: string): { turnId: string; session: VerseSession };
  cancelTurn(id: string): boolean;
  setControls?(id: string, update: VerseSessionControlsUpdate): unknown;
  getControls?(id: string): { controls?: { permissionMode?: VersePermissionMode } } | unknown;
}

export class AgentActionError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = 'AgentActionError';
    this.status = status;
    this.code = code;
  }
}

export interface ActionDeps {
  store: AgentStore;
  engine: () => AgentEngine | null;
  launcher: ScriptLauncher;
  priceOf: (engine: string, model: string) => ListPrice | null;
  ops?: WorkspaceOpsOptions;
  now?: () => number;
  /** Test seam: the first of these folders whose macOS privacy prompt is unanswered. */
  pendingFolder?: (dirs: readonly string[]) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Plan first: the seat plans and changes nothing until the plan is approved. */
export function planRequestPrompt(task: string): string {
  return [
    task.trim(),
    '',
    '---',
    'PLAN FIRST. Do not edit, create or delete any file and do not run anything that changes state yet.',
    'Read what you need, then reply with a concrete, numbered plan: the files you will change and how, the tests you will add or run, and anything you are unsure about.',
    'Stop after the plan. The operator will review and edit it; you will be told when to carry it out.',
  ].join('\n');
}

export function planApprovedPrompt(plan: string): string {
  return [
    'The plan is approved. Carry it out now, in this workspace — as written below (the operator may have edited it; where it differs from yours, follow this version).',
    'Run the relevant tests. Commit your work on this branch when it is done.',
    '',
    '--- Approved plan ---',
    plan.trim(),
  ].join('\n');
}

/**
 * The plan a finished plan turn produced: Claude's ExitPlanMode tool input
 * when present (plan mode hands the plan over that way), else the turn's
 * last assistant message. Null when the turn wrote nothing.
 */
export function extractPlan(events: readonly VerseEvent[], sinceTurnIndex: number): string | null {
  let turns = 0;
  let plan: string | null = null;
  let lastText: string | null = null;
  for (const e of events) {
    if (e.type === 'user-message') {
      turns += 1;
      continue;
    }
    if (turns <= sinceTurnIndex) continue;
    if (e.type === 'tool-use' && /exitplanmode/i.test(e.name)) {
      const input = e.input as { plan?: unknown } | null;
      if (input && typeof input.plan === 'string' && input.plan.trim()) plan = input.plan.trim();
    } else if (e.type === 'assistant-message' && e.text.trim()) {
      lastText = e.text.trim();
    }
  }
  const text = plan ?? lastText;
  return text ? text.slice(0, 20_000) : null;
}

/** The last assistant line / tool, one line — the board's "last activity". */
export function lastActivityLine(events: readonly VerseEvent[]): string | null {
  for (let i = events.length - 1; i >= 0 && i >= events.length - 200; i -= 1) {
    const e = events[i]!;
    if (e.type === 'assistant-message' && e.text.trim()) {
      const line = e.text.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
      return line.replace(/[#*`>_]/g, '').slice(0, 160) || null;
    }
    if (e.type === 'tool-use') return `Used ${e.name}`.slice(0, 160);
    if (e.type === 'error') return `Error: ${e.message}`.replace(/\s+/g, ' ').slice(0, 160);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function capRefusal(agent: AgentRecord, session: VerseSession, priceOf: ActionDeps['priceOf']): string | null {
  if (agent.spendCapUsd === null) return null;
  const spend = sessionSpend(session, agent.spendCapUsd, priceOf);
  if (spend.fraction !== null && spend.fraction >= 1) {
    return `This agent has reached its spend cap ($${agent.spendCapUsd.toFixed(2)} at API list price). Raise the cap to continue.`;
  }
  return null;
}

/**
 * Send `text` to the agent's chat now. Refuses (409) while a turn runs or
 * the cap is reached; the engine's own refusals come back as they are.
 */
export async function sendAgentTurn(
  deps: ActionDeps,
  agent: AgentRecord,
  text: string,
  prepare?: (engine: AgentEngine, sessionId: string) => void,
): Promise<{ turnId: string; session: VerseSession }> {
  const engine = deps.engine();
  if (!engine || !agent.sessionId) throw new AgentActionError(409, 'AGENT_NO_CHAT', 'This agent has no chat to send to yet.');
  const session = engine.getSession(agent.sessionId);
  if (!session) throw new AgentActionError(404, 'AGENT_NO_CHAT', 'This agent’s chat was deleted.');
  if (session.status === 'running') throw new AgentActionError(409, 'AGENT_BUSY', 'A turn is already running in this agent.');
  const refusal = capRefusal(agent, session, deps.priceOf);
  if (refusal) throw new AgentActionError(409, 'AGENT_SPEND_CAP', refusal);
  // The same rule as the chat turn route: the CLI is spawned IN the chat's
  // folders, and a folder whose macOS privacy prompt is still unanswered
  // would park the server's thread in that spawn (folder-io.ts).
  const pending = await (deps.pendingFolder ?? defaultPendingFolder)(verseSessionRoots(session).map((r) => expandHomePrefix(r)));
  if (pending) throw new AgentActionError(409, 'VERSE_FOLDER_ACCESS_PENDING', folderAccessPendingMessage(pending));
  prepare?.(engine, agent.sessionId);
  return engine.sendTurn(agent.sessionId, text);
}

async function defaultPendingFolder(dirs: readonly string[]): Promise<string | null> {
  return firstPendingFolder(dirs.filter((d) => d.length > 0 && !d.includes('\0')));
}

function setPermission(engine: AgentEngine, sessionId: string, mode: VersePermissionMode): boolean {
  try {
    engine.setControls?.(sessionId, { permissionMode: mode });
    return true;
  } catch {
    // The seat has no such mode (e.g. no plan mode): the prompt itself still says "plan only".
    return false;
  }
}

/**
 * Send the first prompt: as a plan request (plan permission mode + "plan
 * first" instructions) when Plan first is on, else as written. Returns the
 * updated record (pendingPrompt cleared, plan state advanced).
 */
export async function sendFirstPrompt(deps: ActionDeps, agent: AgentRecord, prompt: string): Promise<AgentRecord> {
  const engine = deps.engine();
  if (!engine || !agent.sessionId) throw new AgentActionError(409, 'AGENT_NO_CHAT', 'This agent has no chat to send to yet.');
  const session = engine.getSession(agent.sessionId);
  if (!session) throw new AgentActionError(404, 'AGENT_NO_CHAT', 'This agent’s chat was deleted.');
  const planning = agent.plan.enabled && agent.plan.state === 'none';
  const turnsBefore = session.turnCount;
  await sendAgentTurn(deps, agent, planning ? planRequestPrompt(prompt) : prompt, (e, id) => {
    if (planning) setPermission(e, id, 'plan');
  });
  const next = await deps.store.update(agent.id, (a) => ({
    ...a,
    pendingPrompt: null,
    loopNote: null,
    plan: planning ? { ...a.plan, state: 'drafting', turn: turnsBefore, text: null } : a.plan,
  }));
  return next ?? agent;
}

/** Approve (with the operator's edits) or discard the plan. */
export async function decidePlan(deps: ActionDeps, agent: AgentRecord, action: 'approve' | 'discard', editedText?: string): Promise<AgentRecord> {
  if (!agent.plan.enabled || agent.plan.state !== 'awaiting-approval') {
    throw new AgentActionError(409, 'AGENT_NO_PLAN', 'There is no plan waiting for approval on this agent.');
  }
  const engine = deps.engine();
  if (action === 'discard') {
    if (engine && agent.sessionId) setPermission(engine, agent.sessionId, 'accept-edits');
    return (await deps.store.update(agent.id, (a) => ({ ...a, plan: { ...a.plan, state: 'none', text: null, turn: null } }))) ?? agent;
  }
  const text = (editedText ?? agent.plan.text ?? '').trim();
  if (!text) throw new AgentActionError(400, 'VERSE_INVALID', 'The plan is empty.');
  if (text.length > 20_000) throw new AgentActionError(400, 'VERSE_INVALID', 'The plan is longer than 20,000 characters.');
  if (!engine || !agent.sessionId) throw new AgentActionError(409, 'AGENT_NO_CHAT', 'This agent has no chat to send to yet.');
  await sendAgentTurn(deps, agent, planApprovedPrompt(text), (e, id) => { setPermission(e, id, 'accept-edits'); });
  return (await deps.store.update(agent.id, (a) => ({ ...a, plan: { ...a.plan, state: 'approved', text } }))) ?? agent;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

let runSeq = 0;

/** Start one of the workspace's scripts; records the run on the agent. */
export async function startScript(
  deps: ActionDeps,
  agent: AgentRecord,
  kind: ScriptKind,
  name: string,
  command: string,
): Promise<{ agent: AgentRecord; run: ScriptRunRecord }> {
  const ws = agent.workspace;
  if (!ws || agent.archived) throw new AgentActionError(409, 'AGENT_NO_WORKSPACE', 'This agent has no workspace to run it in.');
  runSeq += 1;
  const runId = `${agent.id}:${kind}:${Date.now().toString(36)}${runSeq}`;
  const started = await deps.launcher.start({
    runId,
    kind,
    name,
    sessionId: agent.sessionId,
    cwd: ws.path,
    command,
    env: workspaceEnv({ path: ws.path, name: ws.name, rootPath: ws.rootPath, portBase: ws.portBase, portCount: ws.portCount }),
  });
  const run: ScriptRunRecord = {
    id: runId,
    kind,
    name,
    via: started.via,
    tabId: started.tabId,
    state: 'running',
    exitCode: null,
    startedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    endedAt: null,
  };
  const next = await deps.store.update(agent.id, (a) => ({ ...a, scripts: [...a.scripts, run].slice(-20) }));
  return { agent: next ?? agent, run };
}

/** Fold the launcher's view of running scripts into the record. Returns the record and the runs that just ended. */
export async function refreshScripts(deps: ActionDeps, agent: AgentRecord): Promise<{ agent: AgentRecord; ended: ScriptRunRecord[] }> {
  const ended: ScriptRunRecord[] = [];
  const updates = new Map<string, ScriptRunRecord>();
  for (const run of agent.scripts) {
    if (run.state !== 'running') continue;
    const status = deps.launcher.status(run.id);
    // Unknown to this process (a restart): it cannot be watched any more.
    const next = status ?? { state: 'failed' as const, exitCode: null };
    if (next.state === 'running') continue;
    const done: ScriptRunRecord = { ...run, state: next.state, exitCode: next.exitCode, endedAt: new Date((deps.now ?? Date.now)()).toISOString() };
    updates.set(run.id, done);
    ended.push(done);
  }
  if (updates.size === 0) return { agent, ended };
  const next = await deps.store.update(agent.id, (a) => ({ ...a, scripts: a.scripts.map((r) => updates.get(r.id) ?? r) }));
  return { agent: next ?? agent, ended };
}

/** Wait (bounded) for a script run to end — archive scripts run before the worktree goes. */
export async function waitForScript(deps: ActionDeps, runId: string, timeoutMs = 120_000, pollMs = 500): Promise<'ok' | 'failed' | 'timeout'> {
  const deadline = (deps.now ?? Date.now)() + timeoutMs;
  for (;;) {
    const s = deps.launcher.status(runId);
    if (!s || s.state !== 'running') return s?.state === 'ok' ? 'ok' : 'failed';
    if ((deps.now ?? Date.now)() >= deadline) {
      deps.launcher.stop(runId);
      return 'timeout';
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Archive / restore / cap
// ---------------------------------------------------------------------------

/**
 * Archive: stop what runs there, run the repo's archive script (bounded),
 * snapshot, remove the worktree (and the branch after a merge). The chat and
 * its transcript stay; Restore brings the workspace back.
 */
export async function archiveAgent(
  deps: ActionDeps,
  agent: AgentRecord,
  reason: AgentArchiveRecord['reason'],
  config: WorkspaceConfig | null,
): Promise<AgentRecord> {
  if (agent.archived) return agent;
  const engine = deps.engine();
  if (engine && agent.sessionId && engine.getSession(agent.sessionId)?.status === 'running') {
    if (reason === 'cap') throw new AgentActionError(409, 'AGENT_BUSY', 'A turn is running in this agent.');
    engine.cancelTurn(agent.sessionId);
  }
  for (const run of agent.scripts) if (run.state === 'running') deps.launcher.stop(run.id);
  let current = agent;
  if (current.workspace && config?.archive) {
    const started = await startScript(deps, current, 'archive', 'archive', config.archive);
    current = started.agent;
    await waitForScript(deps, started.run.id);
    current = (await refreshScripts(deps, current)).agent;
  }
  const archived: AgentArchiveRecord = current.workspace
    ? await archiveWorkspace(current.workspace, reason, { ...deps.ops, deleteBranch: reason === 'merged', ...(deps.now ? { now: deps.now } : {}) })
    : { at: new Date((deps.now ?? Date.now)()).toISOString(), ref: null, sha: null, headSha: null, reason, branchDeleted: false };
  return (await deps.store.update(agent.id, (a) => ({ ...a, archived, pendingPrompt: null }))) ?? { ...current, archived };
}

export async function restoreAgent(deps: ActionDeps, agent: AgentRecord): Promise<AgentRecord> {
  if (!agent.archived) throw new AgentActionError(409, 'AGENT_NOT_ARCHIVED', 'This agent is not archived.');
  if (agent.workspace) await restoreWorkspace(agent.workspace, agent.archived, deps.ops);
  return (await deps.store.update(agent.id, (a) => ({ ...a, archived: null, loopNote: 'Restored from its archive snapshot.' }))) ?? agent;
}

/**
 * Keep live workspaces ≤ cap − 1 before a new one is made: archive the
 * oldest that are unpinned and idle (no running turn, no running script).
 * Returns the ids archived. Never archives the one being created.
 */
export async function enforceWorkspaceCap(deps: ActionDeps, cap = DEFAULT_WORKSPACE_CAP, keepId?: string): Promise<string[]> {
  const engine = deps.engine();
  const live = (await deps.store.list()).filter((a) => a.workspace && !a.archived && a.id !== keepId);
  const excess = live.length - (cap - 1);
  if (excess <= 0) return [];
  const idle = live
    .filter((a) => !a.pinned)
    .filter((a) => !a.scripts.some((r) => r.state === 'running'))
    .filter((a) => !(engine && a.sessionId && engine.getSession(a.sessionId)?.status === 'running'))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const out: string[] = [];
  for (const agent of idle.slice(0, excess)) {
    try {
      const config = agent.workspace ? (await readWorkspaceConfig(agent.workspace.rootPath)).config : null;
      await archiveAgent(deps, agent, 'cap', config);
      out.push(agent.id);
    } catch {
      /* one that cannot be archived now is skipped; the next create tries again */
    }
  }
  return out;
}
