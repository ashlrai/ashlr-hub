/**
 * core/verse/agents-api.ts — `/api/verse/agents*`, "run many agents" (3.16):
 * the Agents board, one-click agent workspaces, the per-agent Checks tab,
 * Plan first and the spend cap. Mounted by verse-api.ts's workbench table as
 * the `agents` family. Model: core/verse/agents/types.ts.
 *
 *   GET  /api/verse/agents                          → AgentBoardResponse (every chat, every agent)
 *   GET  /api/verse/agents/config?root=             → WorkspaceConfigRead (the repo's workspace.json)
 *   POST /api/verse/agents/workspaces {root, title, name?, planFirst?, spendCapUsd?, autoFix?, autoMerge?}
 *                                                   → 201 AgentWorkspaceCreateResponse (worktree made; the page creates the chat next)
 *   POST /api/verse/agents/chat {sessionId, title?, planFirst?, spendCapUsd?, autoFix?, autoMerge?}
 *                                                   → 201 { agent } (an agent with no workspace of its own)
 *   POST /api/verse/agents/bulk {action, ids}       → { results } (read · stop · archive · pin · unpin)
 *   POST /api/verse/agents/:id/bind {sessionId, prompt?}   → { agent, held, setup }
 *   POST /api/verse/agents/:id/discard {}           → { ok } (a workspace whose chat never came to be)
 *   POST /api/verse/agents/:id/settings {autoFix?, autoMerge?, spendCapUsd?, pinned?, title?} → { agent }
 *   POST /api/verse/agents/:id/plan {action:'approve'|'discard', text?} → { agent }
 *   POST /api/verse/agents/:id/send-prompt {}       → { agent } (the held prompt, now — "send anyway")
 *   POST /api/verse/agents/:id/scripts {kind:'setup'|'run', index?} → { agent, run }
 *   POST /api/verse/agents/:id/scripts/:runId/stop {} → { agent }
 *   GET  /api/verse/agents/:id/scripts/:runId/log   → AgentScriptLog
 *   GET  /api/verse/agents/:id/checks               → AgentChecksDetail (also `chat:<sessionId>` — read only)
 *   POST /api/verse/agents/:id/pr {title?, body?, draft?} → { agent, pr } (commit-free: pushes and opens the PR)
 *   POST /api/verse/agents/:id/archive {}           → { agent }
 *   POST /api/verse/agents/:id/restore {}           → { agent }
 *   POST /api/verse/agents/:id/resolve {}           → { ok } (a failed turn leaves Needs you — never via bulk "read")
 *
 * POSTURE (every Verse route): GETs sit behind the read session; a POST is a
 * 404 unless dispatch is allowed, then the constant-time mutation token + a
 * JSON body (the mount checks, and this module checks again). Unknown body
 * keys and query parameters are 400s. Every response goes through sendJson →
 * sanitizePublicJson (home paths become `~`). All I/O here is async
 * (scripts/check-verse-sync-io.mjs). Agents and MCP servers hold no mutation
 * token, so an agent can never create, merge or archive another.
 *
 * `root` must be a folder Verse already knows (a chat's root or a discovered
 * project) and pass the workspace-root guard — this route is not a way to
 * run git or a repo's scripts anywhere else.
 *
 * SPEND. Creating a workspace spends nothing. A turn is sent only by `bind`
 * (the prompt the operator typed, when setup is done or absent), `plan`
 * (approving), `send-prompt`, and the post-PR loop's Auto-fix — which the
 * operator switched on for that agent — each refused at the agent's cap.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { withFolderIo } from './folder-io.js';
import { GitOpError, openPullRequest } from './git-ops.js';
import { checkWorkspaceRootPathAsync, expandHomePrefix } from './path-guard.js';
import type { VerseSession } from './types.js';
import type { VerseApiContext } from './verse-api.js';
import type { NeedsYouItem, VerseLiveStatus } from './workbench-types.js';
import {
  AgentActionError,
  archiveAgent,
  decidePlan,
  enforceWorkspaceCap,
  lastActivityLine,
  restoreAgent,
  sendFirstPrompt,
  startScript,
  type ActionDeps,
  type AgentEngine,
} from './agents/actions.js';
import { agentNeedsYouItems, buildBoard, countColumns, fmtUsd, sessionSpend } from './agents/board.js';
import { readAgentChecks, type AgentChecksRead, type ChecksDeps } from './agents/checks.js';
import { getScriptLauncher, type ScriptLauncher } from './agents/scripts.js';
import { AgentStoreUnreadableError, blankAgent, getAgentStore, isAgentId, newAgentId, type AgentStore } from './agents/store.js';
import {
  cachedChecks,
  cachedChecksSummary,
  rememberChecks,
  startSupervisor,
  supervisorRunning,
  type SupervisorDeps,
} from './agents/supervisor.js';
import {
  parseAgentWorkspaceCap,
  VERSE_AGENTS_PATH,
  type AgentBoardResponse,
  type AgentCard,
  type AgentChecksDetail,
  type AgentRecord,
  type AgentScriptLog,
} from './agents/types.js';
import { allocatePortBlock, portBlockAvailable, readWorkspaceConfig, slugifyAgentName } from './agents/workspace-config.js';
import { createAgentWorkspace, type WorkspaceOpsOptions } from './agents/workspace-ops.js';
import type { ListPrice } from './multimodel/escalation.js';

const BODY_MAX_BYTES = 96 * 1024;
const MAX_ROOT_CHARS = 4_096;
const MAX_TITLE_CHARS = 200;
const MAX_PROMPT_BYTES = 60 * 1024;
const MAX_CAP_USD = 10_000;
const SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const RUN_ID_RE = /^ag_[a-z0-9]{8,32}:(?:setup|run|archive):[a-z0-9]{1,40}$/;
const KNOWN_ROOTS_TTL_MS = 3_000;
const LAST_ACTIVITY_SESSIONS = 40;
const BULK_MAX = 200;

// ===========================================================================
// Dependencies (tests inject fakes; production reads the live singletons)
// ===========================================================================

export interface AgentsEngine extends AgentEngine {
  listSessions(): VerseSession[];
  peekLiveStatus?(sessionId: string): VerseLiveStatus | null;
}

export interface MetaLike {
  isUnread(session: { id: string; turnCount: number; updatedAt: string }): boolean;
  isArchived(sessionId: string): boolean;
  get(session: { id: string; turnCount: number; updatedAt: string }): { pinned: boolean };
  markSeen(session: { id: string; turnCount: number; updatedAt: string }, turnCount: number): unknown;
  update(session: { id: string; turnCount: number; updatedAt: string }, patch: { pinned?: boolean; archived?: boolean }): unknown;
}

export interface AgentsApiDeps {
  store: () => AgentStore;
  engine: () => AgentsEngine | null;
  launcher: () => ScriptLauncher;
  meta: () => Promise<MetaLike | null>;
  knownRoots: () => Promise<readonly string[]>;
  priceOf: (engine: string, model: string) => ListPrice | null;
  readChecks: typeof readAgentChecks;
  checksDeps?: ChecksDeps;
  ops?: WorkspaceOpsOptions;
  cap: () => number;
  now: () => number;
}

async function liveEngine(): Promise<AgentsEngine | null> {
  try {
    return ((await import('./verse-api.js')).peekVerseEngine() as unknown as AgentsEngine | null) ?? null;
  } catch {
    return null;
  }
}

let engineCache: AgentsEngine | null = null;

async function defaultMeta(): Promise<MetaLike | null> {
  try {
    return (await import('./activity-api.js')).activityMetaStore() as unknown as MetaLike;
  } catch {
    return null;
  }
}

async function defaultKnownRoots(): Promise<string[]> {
  const engine = await liveEngine();
  const sessions = engine?.listSessions() ?? [];
  const roots: string[] = [];
  for (const s of sessions) roots.push(s.projectPath, ...(s.extraRoots ?? []));
  try {
    const { discoverProjectsAsync } = await import('./projects.js');
    for (const p of await discoverProjectsAsync({ sessions })) roots.push(p.path);
  } catch {
    /* enrollment unreadable: session roots still count */
  }
  return roots;
}

let priceOfCache: ((engine: string, model: string) => ListPrice | null) | null = null;
async function loadPriceOf(): Promise<void> {
  if (priceOfCache) return;
  try {
    priceOfCache = (await import('./multimodel-api.js')).listPriceOf;
  } catch {
    priceOfCache = () => null;
  }
}

function envCap(): number {
  return parseAgentWorkspaceCap(process.env['ASHLR_VERSE_AGENT_CAP']);
}

const DEFAULT_DEPS: AgentsApiDeps = {
  store: getAgentStore,
  engine: () => engineCache,
  launcher: getScriptLauncher,
  meta: defaultMeta,
  knownRoots: defaultKnownRoots,
  priceOf: (engine, model) => (priceOfCache ? priceOfCache(engine, model) : null),
  readChecks: readAgentChecks,
  cap: envCap,
  now: () => Date.now(),
};

let deps: AgentsApiDeps = DEFAULT_DEPS;
let knownCache: { at: number; roots: Set<string> } | null = null;

/** Test hook: override any dependency (null restores production). */
export function setAgentsApiDepsForTest(next: Partial<AgentsApiDeps> | null): void {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
  knownCache = null;
  boardCache = null;
  activityCache.clear();
}

async function refreshLiveDeps(): Promise<void> {
  if (deps === DEFAULT_DEPS) engineCache = await liveEngine();
  await loadPriceOf();
}

function actionDeps(): ActionDeps {
  return {
    store: deps.store(),
    engine: deps.engine,
    launcher: deps.launcher(),
    priceOf: deps.priceOf,
    ...(deps.ops ? { ops: deps.ops } : {}),
    now: deps.now,
  };
}

// ===========================================================================
// The board (and the Needs-you items it feeds)
// ===========================================================================

let boardCache: { at: number; cards: AgentCard[] } | null = null;
const activityCache = new Map<string, { updatedAt: string; line: string | null }>();

/**
 * `readEvents` false (the background tick): "last activity" comes only from
 * the memo — the engine may have to read a chat's log from disk, and that
 * is paid when someone is actually looking at the board, never on a timer.
 */
async function buildCards(readEvents = true): Promise<AgentCard[]> {
  await refreshLiveDeps();
  const engine = deps.engine();
  const sessions = engine?.listSessions() ?? [];
  const agents = await deps.store().list();
  const meta = await deps.meta();
  const store = deps.store();
  const resolved = new Map<string, number | null>();
  for (const s of sessions) resolved.set(s.id, await store.resolvedTurn(s.id));
  // "Last activity" reads events: only for the most recently active chats, memoized by updatedAt.
  const recent = new Set([...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, LAST_ACTIVITY_SESSIONS).map((s) => s.id));
  const byId = new Map(sessions.map((s) => [s.id, s] as const));
  const cards = buildBoard({
    sessions,
    agents,
    unread: (s) => (meta ? meta.isUnread(s) : false),
    archivedChat: (id) => (meta ? meta.isArchived(id) : false),
    pinnedChat: (id) => {
      const s = byId.get(id);
      return meta && s ? meta.get(s).pinned : false;
    },
    resolvedTurn: (id) => resolved.get(id) ?? null,
    checks: (agentId) => cachedChecksSummary(agentId),
    live: (id) => engine?.peekLiveStatus?.(id) ?? null,
    lastActivity: (id) => {
      const s = byId.get(id);
      if (!s || !engine || !recent.has(id)) return null;
      if (!readEvents) return activityCache.get(id)?.line ?? null;
      const hit = activityCache.get(id);
      if (hit && hit.updatedAt === s.updatedAt) return hit.line;
      let line: string | null = null;
      try { line = lastActivityLine(engine.getEvents(id)); } catch { line = null; }
      activityCache.set(id, { updatedAt: s.updatedAt, line });
      if (activityCache.size > 500) activityCache.delete(activityCache.keys().next().value as string);
      return line;
    },
    priceOf: deps.priceOf,
    now: deps.now(),
  });
  boardCache = { at: deps.now(), cards };
  return cards;
}

/**
 * The drawer's agent items (activity-api folds them into the `chats`
 * source). PURE and served from the last board build — the activity poll
 * calls this every few seconds and it must never do I/O on that stack.
 */
export function needsYouItems(): NeedsYouItem[] {
  if (!boardCache) return [];
  return agentNeedsYouItems(boardCache.cards, new Date(deps.now()).toISOString());
}

/**
 * The chat turn route asks this before every turn: an agent at its spend cap
 * takes no more turns (by hand or by the loop) until the cap is raised.
 * Null = go ahead (no agent, no cap, no price, or under it).
 */
export async function agentSpendCapRefusal(sessionId: string): Promise<string | null> {
  const agent = await deps.store().bySession(sessionId);
  if (!agent || agent.spendCapUsd === null) return null;
  await refreshLiveDeps();
  const session = deps.engine()?.getSession(sessionId);
  if (!session) return null;
  const spend = sessionSpend(session, agent.spendCapUsd, deps.priceOf);
  if (spend.fraction === null || spend.fraction < 1) return null;
  return `This agent reached its spend cap (${fmtUsd(spend.usd!)} of ${fmtUsd(agent.spendCapUsd)} at API list price). Raise the cap on the Agents board to continue.`;
}

// ===========================================================================
// Validation
// ===========================================================================

class InvalidRequest extends Error {}

function invalid(message: string): never {
  throw new InvalidRequest(message);
}

async function physical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolvePath(path);
  }
}

async function knownRootSet(): Promise<Set<string>> {
  const now = deps.now();
  if (knownCache && now - knownCache.at < KNOWN_ROOTS_TTL_MS) return knownCache.roots;
  const roots = new Set<string>();
  for (const r of await deps.knownRoots()) {
    if (typeof r !== 'string' || r.length === 0) continue;
    const expanded = expandHomePrefix(r);
    if (!isAbsolute(expanded)) continue;
    roots.add(resolvePath(expanded));
    roots.add(await physical(expanded));
  }
  knownCache = { at: now, roots };
  return roots;
}

async function checkedRoot(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_ROOT_CHARS) invalid('root must be a folder path.');
  const expanded = expandHomePrefix(raw.trim());
  if (!isAbsolute(expanded)) invalid('root must be an absolute path.');
  const guard = await withFolderIo(() => checkWorkspaceRootPathAsync(expanded));
  if (!guard.ok) throw new AgentActionError(409, 'VERSE_GIT_REFUSED', 'Verse does not make workspaces from that folder.');
  const known = await knownRootSet();
  if (!known.has(resolvePath(expanded)) && !known.has(guard.path)) {
    throw new AgentActionError(409, 'VERSE_GIT_REFUSED', 'That folder is not part of any chat or project in Verse.');
  }
  return resolvePath(expanded);
}

function readQuery(req: IncomingMessage, allowed: readonly string[]): URLSearchParams {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    invalid('invalid query string');
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) invalid(`unknown query parameter: ${key}`);
    if (params.getAll(key).length > 1) invalid(`${key} was given more than once`);
  }
  return params;
}

async function readJsonBody(req: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBody(req, BODY_MAX_BYTES);
  } catch {
    invalid('request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    invalid('body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('body must be a JSON object');
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`unknown body key: ${key}`);
  return body;
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') invalid(`${key} must be true or false`);
  return v;
}

function optCap(body: Record<string, unknown>): number | null | undefined {
  const v = body['spendCapUsd'];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_CAP_USD) invalid(`spendCapUsd must be a number of dollars above 0 and at most ${MAX_CAP_USD}, or null`);
  return Math.round(v * 100) / 100;
}

function optTitle(body: Record<string, unknown>, required: boolean): string | undefined {
  const v = body['title'];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim().length === 0) invalid('title must be a non-empty string');
  if (v.length > MAX_TITLE_CHARS) invalid(`title is longer than ${MAX_TITLE_CHARS} characters`);
  // eslint-disable-next-line no-control-regex
  return v.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function sessionIdOf(body: Record<string, unknown>): string {
  const v = body['sessionId'];
  if (typeof v !== 'string' || !SESSION_ID_RE.test(v)) invalid('sessionId must be a chat id');
  return v;
}

function promptOf(body: Record<string, unknown>): string | undefined {
  const v = body['prompt'];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') invalid('prompt must be a string');
  if (v.includes('\0')) invalid('prompt must not contain NUL bytes');
  if (Buffer.byteLength(v, 'utf8') > MAX_PROMPT_BYTES) invalid('prompt is too long');
  return v.trim().length > 0 ? v : undefined;
}

async function agentOr404(id: string): Promise<AgentRecord> {
  if (!isAgentId(id)) throw new AgentActionError(404, 'AGENT_NOT_FOUND', 'No such agent.');
  const agent = await deps.store().get(id);
  if (!agent) throw new AgentActionError(404, 'AGENT_NOT_FOUND', 'No such agent.');
  return agent;
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof InvalidRequest) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: err.message });
    return;
  }
  if (err instanceof AgentActionError) {
    sendJson(res, err.status, { code: err.code, error: err.message });
    return;
  }
  if (err instanceof GitOpError) {
    sendJson(res, err.status, { code: err.code, error: err.message });
    return;
  }
  if (err instanceof AgentStoreUnreadableError) {
    sendJson(res, 503, { code: 'AGENTS_STORE_UNREADABLE', error: err.message });
    return;
  }
  // The engine's own refusals (busy chat, model unavailable) carry a status and a plain message.
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500 && typeof e.message === 'string') {
    sendJson(res, e.status, { code: typeof e.code === 'string' ? e.code : 'VERSE_INVALID', error: e.message });
    return;
  }
  sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'The agents action failed unexpectedly.' });
}

// ===========================================================================
// Handlers
// ===========================================================================

async function boardResponse(): Promise<AgentBoardResponse> {
  const cards = await buildCards();
  const agents = await deps.store().list();
  // Run-script names ride on the card, so its buttons render without another read.
  const configs = new Map<string, string[]>();
  for (const card of cards) {
    const agent = card.agentId ? agents.find((a) => a.id === card.agentId) : null;
    if (!agent?.workspace || agent.archived) continue;
    const root = agent.workspace.rootPath;
    if (!configs.has(root)) configs.set(root, (await readWorkspaceConfig(root)).config.run.map((r) => r.name));
    card.runScripts = configs.get(root)!;
  }
  return {
    generatedAt: new Date(deps.now()).toISOString(),
    cards,
    counts: countColumns(cards),
    cap: deps.cap(),
    liveWorkspaces: agents.filter((a) => a.workspace && !a.archived).length,
    supervisor: supervisorRunning(),
  };
}

// Port reservations span repositories. Like withRepoLock, refuse concurrent
// mutations rather than queueing requests; hold through the durable store update.
// This guards the owning Hub process, not independent Hub processes.
let workspacePortsBusy = false;
async function withWorkspacePorts<T>(fn: () => Promise<T>): Promise<T> {
  if (workspacePortsBusy) throw new AgentActionError(409, 'AGENT_WORKSPACE_BUSY', 'Another workspace is being created or restored. Try again when it finishes.');
  workspacePortsBusy = true;
  try {
    return await fn();
  } finally {
    workspacePortsBusy = false;
  }
}

async function createWorkspace(body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  return withWorkspacePorts(async () => {
    const root = await checkedRoot(body['root']);
    const title = optTitle(body, true)!;
    const rawName = body['name'];
    if (rawName !== undefined && (typeof rawName !== 'string' || rawName.length > 63)) invalid('name must be a short slug');
    const desired = typeof rawName === 'string' && rawName.trim() ? slugifyAgentName(rawName) : slugifyAgentName(title, new Date(deps.now()));
    const planFirst = optBool(body, 'planFirst') ?? false;
    const cap = optCap(body);
    const autoFix = optBool(body, 'autoFix') ?? false;
    const autoMerge = optBool(body, 'autoMerge') ?? false;

    const store = deps.store();
    const ad = actionDeps();
    const id = newAgentId();
    const config = await readWorkspaceConfig(root);
    const taken = (await store.list()).filter((a) => a.workspace && !a.archived).map((a) => ({ base: a.workspace!.portBase, count: a.workspace!.portCount }));
    // Refuse exhaustion before automatic archival or any workspace side effects.
    const portBase = allocatePortBlock(config.config.ports, taken);
    const archivedForCap = await enforceWorkspaceCap(ad, deps.cap(), id);
    const created = await createAgentWorkspace(root, desired, config.config.copy, deps.ops);
    const at = new Date(deps.now()).toISOString();
    const agent = await store.put({
      ...blankAgent({ id, title, at }),
      workspace: { ...created.workspace, portBase, portCount: config.config.ports },
      plan: { enabled: planFirst, state: 'none', text: null, turn: null },
      spendCapUsd: cap ?? null,
      autoFix,
      autoMerge,
      loopNote: created.copied.length > 0 ? `Copied ${created.copied.join(', ')} from the main checkout.` : null,
    });
    return { status: 201, payload: { agent, config, archivedForCap } };
  });
}

async function restoreWorkspaceAgent(id: string): Promise<AgentRecord> {
  return withWorkspacePorts(async () => {
    // The route's earlier read may precede another mutation; check current state.
    const agent = await agentOr404(id);
    if (!agent.archived) throw new AgentActionError(409, 'AGENT_NOT_ARCHIVED', 'This agent is not archived.');
    if (agent.workspace) {
      const taken = (await deps.store().list()).filter((a) => a.id !== id && a.workspace && !a.archived)
        .map((a) => ({ base: a.workspace!.portBase, count: a.workspace!.portCount }));
      if (!portBlockAvailable(agent.workspace.portBase, agent.workspace.portCount, taken)) {
        throw new AgentActionError(409, 'AGENT_PORTS_OCCUPIED', 'This archived workspace’s port range is in use or unavailable. Archive the conflicting workspace before restoring.');
      }
    }
    return restoreAgent(actionDeps(), agent);
  });
}

async function adoptChat(body: Record<string, unknown>): Promise<{ status: number; payload: unknown }> {
  const sessionId = sessionIdOf(body);
  await refreshLiveDeps();
  const session = deps.engine()?.getSession(sessionId);
  if (!session) throw new AgentActionError(404, 'VERSE_SESSION_NOT_FOUND', 'No such chat.');
  const store = deps.store();
  const existing = await store.bySession(sessionId);
  if (existing) return { status: 200, payload: { agent: existing } };
  const at = new Date(deps.now()).toISOString();
  const agent = await store.put({
    ...blankAgent({ id: newAgentId(), title: optTitle(body, false) ?? session.title ?? 'Agent', at }),
    sessionId,
    plan: { enabled: optBool(body, 'planFirst') ?? false, state: 'none', text: null, turn: null },
    spendCapUsd: optCap(body) ?? null,
    autoFix: optBool(body, 'autoFix') ?? false,
    autoMerge: optBool(body, 'autoMerge') ?? false,
  });
  return { status: 201, payload: { agent } };
}

async function bind(agent: AgentRecord, body: Record<string, unknown>): Promise<unknown> {
  const sessionId = sessionIdOf(body);
  const prompt = promptOf(body);
  await refreshLiveDeps();
  const session = deps.engine()?.getSession(sessionId);
  if (!session) throw new AgentActionError(404, 'VERSE_SESSION_NOT_FOUND', 'No such chat.');
  if (agent.sessionId && agent.sessionId !== sessionId) throw new AgentActionError(409, 'AGENT_BOUND', 'This agent already has a chat.');
  const other = await deps.store().bySession(sessionId);
  if (other && other.id !== agent.id) throw new AgentActionError(409, 'AGENT_BOUND', 'That chat already belongs to another agent.');
  if (agent.workspace && (await physical(expandHomePrefix(session.projectPath))) !== (await physical(agent.workspace.path))) {
    throw new AgentActionError(409, 'VERSE_INVALID', 'That chat does not run in this agent’s workspace.');
  }
  const ad = actionDeps();
  let current = (await deps.store().update(agent.id, (a) => ({ ...a, sessionId, pendingPrompt: prompt ?? null }))) ?? agent;
  let setup = null;
  if (current.workspace) {
    const config = (await readWorkspaceConfig(current.workspace.rootPath)).config;
    if (config.setup) {
      const started = await startScript(ad, current, 'setup', 'setup', config.setup);
      current = started.agent;
      setup = started.run;
    }
  }
  // No setup to wait for: the prompt goes now (the post-PR loop would send it on its next tick anyway).
  if (!setup && prompt) current = await sendFirstPrompt(ad, current, prompt);
  return { agent: current, held: setup !== null && prompt !== undefined, setup };
}

async function updateSettings(agent: AgentRecord, body: Record<string, unknown>): Promise<AgentRecord> {
  const autoFix = optBool(body, 'autoFix');
  const autoMerge = optBool(body, 'autoMerge');
  const pinned = optBool(body, 'pinned');
  const cap = optCap(body);
  const title = optTitle(body, false);
  const next = await deps.store().update(agent.id, (a) => ({
    ...a,
    ...(autoFix !== undefined ? { autoFix, ...(autoFix && !a.autoFix ? { autoFixAttempts: 0 } : {}) } : {}),
    ...(autoMerge !== undefined ? { autoMerge } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(title !== undefined ? { title } : {}),
    // A new cap re-arms its warning and its stop.
    ...(cap !== undefined ? { spendCapUsd: cap, spendWarnedAt: null, spendStoppedAt: null } : {}),
  }));
  return next ?? agent;
}

async function runScript(agent: AgentRecord, body: Record<string, unknown>): Promise<unknown> {
  const kind = body['kind'];
  if (kind !== 'setup' && kind !== 'run') invalid('kind must be setup or run');
  if (!agent.workspace || agent.archived) throw new AgentActionError(409, 'AGENT_NO_WORKSPACE', 'This agent has no workspace to run it in.');
  // Always the MAIN checkout's workspace.json: an agent editing its own copy cannot change what these buttons run.
  const config = (await readWorkspaceConfig(agent.workspace.rootPath)).config;
  if (kind === 'setup') {
    if (!config.setup) throw new AgentActionError(409, 'AGENT_NO_SCRIPT', 'This repo’s workspace.json has no setup script.');
    if (agent.scripts.some((r) => r.kind === 'setup' && r.state === 'running')) throw new AgentActionError(409, 'AGENT_BUSY', 'Setup is already running.');
    return startScript(actionDeps(), agent, 'setup', 'setup', config.setup);
  }
  const index = body['index'] ?? 0;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) invalid('index must be a run script number');
  const script = config.run[index];
  if (!script) throw new AgentActionError(404, 'AGENT_NO_SCRIPT', 'No such run script in this repo’s workspace.json.');
  return startScript(actionDeps(), agent, 'run', script.name, script.command);
}

async function checksFor(id: string, fresh: boolean): Promise<AgentChecksDetail> {
  let root: string;
  let input: { agentId: string | null; sessionId: string | null; autoFix: boolean; autoMerge: boolean; loopNote: string | null };
  if (id.startsWith('chat:')) {
    const sessionId = id.slice(5);
    if (!SESSION_ID_RE.test(sessionId)) invalid('not a chat id');
    await refreshLiveDeps();
    const session = deps.engine()?.getSession(sessionId);
    if (!session) throw new AgentActionError(404, 'VERSE_SESSION_NOT_FOUND', 'No such chat.');
    root = session.projectPath;
    input = { agentId: null, sessionId, autoFix: false, autoMerge: false, loopNote: null };
  } else {
    const agent = await agentOr404(id);
    if (!agent.workspace && !agent.sessionId) throw new AgentActionError(409, 'AGENT_NO_WORKSPACE', 'This agent has nothing to check yet.');
    if (agent.archived) throw new AgentActionError(409, 'AGENT_ARCHIVED', 'This agent is archived. Restore it to see its checks.');
    let sessionRoot: string | null = null;
    if (!agent.workspace && agent.sessionId) {
      await refreshLiveDeps();
      sessionRoot = deps.engine()?.getSession(agent.sessionId)?.projectPath ?? null;
    }
    root = agent.workspace?.path ?? sessionRoot ?? invalid('no folder to check');
    input = { agentId: agent.id, sessionId: agent.sessionId, autoFix: agent.autoFix, autoMerge: agent.autoMerge, loopNote: agent.loopNote };
    const cached = cachedChecks(agent.id);
    if (!fresh && cached) return { ...cached.detail, autoFix: agent.autoFix, autoMerge: agent.autoMerge, loopNote: agent.loopNote };
  }
  const read: AgentChecksRead = await deps.readChecks(root, input, { ...deps.checksDeps, ...deps.ops });
  if (input.agentId) rememberChecks(input.agentId, read, deps.now());
  return read.detail;
}

type BulkAction = 'read' | 'stop' | 'archive' | 'pin' | 'unpin';
const BULK_ACTIONS: readonly BulkAction[] = ['read', 'stop', 'archive', 'pin', 'unpin'];

/**
 * Bulk actions over card ids (`ag_…` or `chat:<sessionId>`). "read" marks
 * a card seen — and SKIPS every card in Needs you: marking read never clears
 * something that is blocked on the operator.
 */
async function bulk(body: Record<string, unknown>): Promise<unknown> {
  const action = body['action'];
  if (!BULK_ACTIONS.includes(action as BulkAction)) invalid(`action must be one of: ${BULK_ACTIONS.join(', ')}`);
  const ids = body['ids'];
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX || ids.some((i) => typeof i !== 'string' || i.length > 220)) {
    invalid(`ids must be 1–${BULK_MAX} card ids`);
  }
  const cards = await buildCards();
  const byId = new Map(cards.map((c) => [c.id, c] as const));
  const engine = deps.engine();
  const meta = await deps.meta();
  const ad = actionDeps();
  const results: Array<{ id: string; ok: boolean; skipped?: string; error?: string }> = [];
  for (const id of ids as string[]) {
    const card = byId.get(id);
    if (!card) {
      results.push({ id, ok: false, error: 'No such card.' });
      continue;
    }
    try {
      const session = card.sessionId ? engine?.getSession(card.sessionId) ?? null : null;
      switch (action as BulkAction) {
        case 'read':
          if (card.column === 'needs-you') {
            results.push({ id, ok: false, skipped: 'Needs you: resolve it, marking read does not.' });
            continue;
          }
          if (session && meta) meta.markSeen(session, session.turnCount);
          break;
        case 'stop':
          if (session?.status === 'running') engine!.cancelTurn(session.id);
          if (card.agentId) {
            const agent = await deps.store().get(card.agentId);
            for (const run of agent?.scripts ?? []) if (run.state === 'running' && run.kind !== 'run') ad.launcher.stop(run.id);
          }
          break;
        case 'archive':
          if (card.agentId) {
            const agent = await agentOr404(card.agentId);
            const config = agent.workspace ? (await readWorkspaceConfig(agent.workspace.rootPath)).config : null;
            await archiveAgent(ad, agent, 'manual', config);
          } else if (session && meta) {
            meta.update(session, { archived: true });
          }
          break;
        case 'pin':
        case 'unpin': {
          const pinned = action === 'pin';
          if (card.agentId) await deps.store().update(card.agentId, (a) => ({ ...a, pinned }));
          else if (session && meta) meta.update(session, { pinned });
          break;
        }
      }
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error && err.message.length < 300 ? err.message : 'Failed.' });
    }
  }
  boardCache = null;
  return { results };
}

// ===========================================================================
// The module
// ===========================================================================

const P = VERSE_AGENTS_PATH;

function segments(path: string): string[] {
  return path.slice(P.length).split('/').filter(Boolean).map((s) => decodeURIComponent(s));
}

export const handleAgentsApi: ApiModule = async (ctx: VerseApiContext, req, res, path, method) => {
  if (path !== P && !path.startsWith(`${P}/`)) return false;
  let parts: string[];
  try {
    parts = segments(path);
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'malformed path' });
    return true;
  }
  try {
    if (method === 'GET') {
      if (parts.length === 0) {
        readQuery(req, []);
        sendJson(res, 200, await boardResponse());
        return true;
      }
      if (parts.length === 1 && parts[0] === 'config') {
        const q = readQuery(req, ['root']);
        const root = await checkedRoot(q.get('root'));
        sendJson(res, 200, await readWorkspaceConfig(root));
        return true;
      }
      if (parts.length === 2 && parts[1] === 'checks') {
        const q = readQuery(req, ['fresh']);
        sendJson(res, 200, await checksFor(parts[0]!, q.get('fresh') === '1'));
        return true;
      }
      if (parts.length === 4 && parts[1] === 'scripts' && parts[3] === 'log') {
        readQuery(req, []);
        const agent = await agentOr404(parts[0]!);
        const run = agent.scripts.find((r) => r.id === parts[2]);
        if (!run || !RUN_ID_RE.test(run.id)) throw new AgentActionError(404, 'AGENT_NO_SCRIPT', 'No such run.');
        const log = deps.launcher().log(run.id);
        const body: AgentScriptLog = { run, text: log?.text ?? '', truncated: log?.truncated ?? false };
        sendJson(res, 200, body);
        return true;
      }
      return false;
    }

    if (method !== 'POST') return false;
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    await refreshLiveDeps();

    if (parts.length === 1 && parts[0] === 'workspaces') {
      const body = await readJsonBody(req, ['root', 'title', 'name', 'planFirst', 'spendCapUsd', 'autoFix', 'autoMerge']);
      const out = await createWorkspace(body);
      boardCache = null;
      sendJson(res, out.status, out.payload);
      return true;
    }
    if (parts.length === 1 && parts[0] === 'chat') {
      const body = await readJsonBody(req, ['sessionId', 'title', 'planFirst', 'spendCapUsd', 'autoFix', 'autoMerge']);
      const out = await adoptChat(body);
      sendJson(res, out.status, out.payload);
      return true;
    }
    if (parts.length === 1 && parts[0] === 'bulk') {
      const body = await readJsonBody(req, ['action', 'ids']);
      sendJson(res, 200, await bulk(body));
      return true;
    }

    // Per-card actions. `chat:<id>` cards (no agent record) only resolve.
    const id = parts[0];
    const verb = parts[1];
    if (!id || !verb) return false;
    if (id.startsWith('chat:') && verb === 'resolve' && parts.length === 2) {
      await readJsonBody(req, []);
      const sessionId = id.slice(5);
      const session = SESSION_ID_RE.test(sessionId) ? deps.engine()?.getSession(sessionId) : null;
      if (!session) throw new AgentActionError(404, 'VERSE_SESSION_NOT_FOUND', 'No such chat.');
      await deps.store().setResolved(sessionId, session.turnCount);
      boardCache = null;
      sendJson(res, 200, { ok: true });
      return true;
    }
    const agent = await agentOr404(id);
    const ad = actionDeps();
    let payload: unknown;
    if (parts.length === 2) {
      switch (verb) {
        case 'bind':
          payload = await bind(agent, await readJsonBody(req, ['sessionId', 'prompt']));
          break;
        case 'discard': {
          await readJsonBody(req, []);
          if (agent.sessionId) throw new AgentActionError(409, 'AGENT_BOUND', 'This agent has a chat: archive it instead.');
          if (agent.workspace && !agent.archived) await archiveAgent(ad, agent, 'manual', null);
          await deps.store().remove(agent.id);
          payload = { ok: true };
          break;
        }
        case 'settings':
          payload = { agent: await updateSettings(agent, await readJsonBody(req, ['autoFix', 'autoMerge', 'spendCapUsd', 'pinned', 'title'])) };
          break;
        case 'plan': {
          const body = await readJsonBody(req, ['action', 'text']);
          const action = body['action'];
          if (action !== 'approve' && action !== 'discard') invalid('action must be approve or discard');
          const text = body['text'];
          if (text !== undefined && typeof text !== 'string') invalid('text must be a string');
          payload = { agent: await decidePlan(ad, agent, action, text as string | undefined) };
          break;
        }
        case 'send-prompt': {
          await readJsonBody(req, []);
          if (!agent.pendingPrompt) throw new AgentActionError(409, 'AGENT_NO_PROMPT', 'There is no held prompt to send.');
          payload = { agent: await sendFirstPrompt(ad, agent, agent.pendingPrompt) };
          break;
        }
        case 'scripts':
          payload = await runScript(agent, await readJsonBody(req, ['kind', 'index']));
          break;
        case 'pr': {
          const body = await readJsonBody(req, ['title', 'body', 'draft']);
          if (!agent.workspace || agent.archived) throw new AgentActionError(409, 'AGENT_NO_WORKSPACE', 'This agent has no workspace to open a PR from.');
          const title = optTitle(body, false) ?? agent.title;
          const prBody = body['body'];
          if (prBody !== undefined && (typeof prBody !== 'string' || prBody.length > 60_000)) invalid('body must be a string of at most 60,000 characters');
          const draft = optBool(body, 'draft');
          const result = await openPullRequest(agent.workspace.path, {
            title,
            body: typeof prBody === 'string' && prBody.trim() ? prBody : `Opened from the Phantom agent “${agent.title}”.`,
            ...(draft ? { draft: true } : {}),
          }, deps.ops ?? {});
          payload = { agent, pr: result.pr };
          break;
        }
        case 'archive': {
          await readJsonBody(req, []);
          const config = agent.workspace ? (await readWorkspaceConfig(agent.workspace.rootPath)).config : null;
          payload = { agent: await archiveAgent(ad, agent, 'manual', config) };
          break;
        }
        case 'restore':
          await readJsonBody(req, []);
          payload = { agent: await restoreWorkspaceAgent(agent.id) };
          break;
        case 'resolve': {
          await readJsonBody(req, []);
          const session = agent.sessionId ? deps.engine()?.getSession(agent.sessionId) : null;
          payload = {
            agent: await deps.store().update(agent.id, (a) => ({ ...a, resolvedFailureTurn: session?.turnCount ?? a.resolvedFailureTurn })),
          };
          break;
        }
        default:
          return false;
      }
    } else if (parts.length === 4 && verb === 'scripts' && parts[3] === 'stop') {
      await readJsonBody(req, []);
      const run = agent.scripts.find((r) => r.id === parts[2]);
      if (!run) throw new AgentActionError(404, 'AGENT_NO_SCRIPT', 'No such run.');
      ad.launcher.stop(run.id);
      payload = { agent };
    } else {
      return false;
    }
    boardCache = null;
    sendJson(res, 200, payload);
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
};

// ===========================================================================
// The post-PR loop: started with this module (never under a test runner)
// ===========================================================================

const SUPERVISOR_DEPS: SupervisorDeps = {
  store: () => deps.store(),
  engine: () => deps.engine(),
  launcher: () => deps.launcher(),
  priceOf: (engine, model) => deps.priceOf(engine, model),
  readChecks: (root, input, cd) => deps.readChecks(root, input, cd),
  afterTick: async () => {
    await refreshLiveDeps();
    await buildCards(false);
  },
};

/** Exported for the server's startup path and for tests that want the real wiring. */
export function ensureAgentsSupervisor(): boolean {
  return startSupervisor(SUPERVISOR_DEPS);
}

ensureAgentsSupervisor();
