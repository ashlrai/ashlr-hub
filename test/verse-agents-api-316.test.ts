/**
 * 3.16 `/api/verse/agents*` (core/verse/agents-api.ts) and the post-PR loop
 * (agents/supervisor.ts), driven with in-memory request/response objects, a
 * fake chat engine and a fake script launcher — and a REAL git repository
 * under a relocated HOME for the workspace itself (real-io lane).
 *
 * Covers the route posture every Verse family has (dispatch + mutation
 * token, strict bodies, roots Verse already knows), the one-action spawn
 * (workspace → bind → setup → the held prompt), Plan first, the spend cap
 * (loop and turn route), "mark read never clears Needs you", Auto-fix once
 * per head, Auto-merge only on an allowed verdict, and archive / restore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  agentSpendCapRefusal,
  handleAgentsApi,
  needsYouItems,
  setAgentsApiDepsForTest,
  type AgentsEngine,
  type MetaLike,
} from '../src/core/verse/agents-api.js';
import type { AgentChecksRead } from '../src/core/verse/agents/checks.js';
import type { ScriptLauncher, ScriptStatus } from '../src/core/verse/agents/scripts.js';
import { createAgentStore, type AgentStore } from '../src/core/verse/agents/store.js';
import { resetSupervisorCachesForTest, superviseAgent, type SupervisorDeps } from '../src/core/verse/agents/supervisor.js';
import type { AgentChecksDetail, AgentRecord } from '../src/core/verse/agents/types.js';
import { invalidateGitCaches } from '../src/core/verse/git-ops.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = 'agents-test-token';
const PRICE = { inPerM: 3, outPerM: 15 };

let home: string;
let savedHome: string | undefined;
let repo: string;
let store: AgentStore;
let engine: FakeEngine;
let launcher: FakeLauncher;
let meta: FakeMeta;
let checksRead: AgentChecksRead | null;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

function blankSession(id: string, projectPath: string): VerseSession {
  return {
    id,
    title: 'New chat',
    projectPath,
    engine: 'claude',
    accountId: 'a',
    seatId: 'claude',
    model: 'claude-sonnet-5',
    nativeSessionId: null,
    createdAt: '2026-09-27T10:00:00Z',
    updatedAt: '2026-09-27T10:00:00Z',
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: null,
  };
}

class FakeEngine implements AgentsEngine {
  sessions = new Map<string, VerseSession>();
  events = new Map<string, VerseEvent[]>();
  sent: Array<{ id: string; text: string }> = [];
  controls: Array<{ id: string; mode: string | undefined }> = [];
  cancelled: string[] = [];
  listSessions() { return [...this.sessions.values()]; }
  getSession(id: string) { return this.sessions.get(id) ?? null; }
  getEvents(id: string) { return this.events.get(id) ?? []; }
  sendTurn(id: string, text: string) {
    const s = this.sessions.get(id)!;
    if (s.status === 'running') throw Object.assign(new Error('busy'), { status: 409, code: 'VERSE_SESSION_BUSY' });
    this.sent.push({ id, text });
    const next = { ...s, status: 'running' as const, turnCount: s.turnCount + 1 };
    this.sessions.set(id, next);
    const list = this.events.get(id) ?? [];
    list.push({ seq: list.length + 1, at: '', type: 'user-message', turnId: `t${next.turnCount}`, text });
    this.events.set(id, list);
    return { turnId: `t${next.turnCount}`, session: next };
  }
  finish(id: string, reply: string, patch: Partial<VerseSession> = {}) {
    const s = this.sessions.get(id)!;
    const list = this.events.get(id) ?? [];
    list.push({ seq: list.length + 1, at: '', type: 'assistant-message', turnId: `t${s.turnCount}`, text: reply });
    this.sessions.set(id, { ...s, status: 'idle', updatedAt: new Date().toISOString(), ...patch });
  }
  cancelTurn(id: string) { this.cancelled.push(id); const s = this.sessions.get(id); if (s) this.sessions.set(id, { ...s, status: 'idle' }); return true; }
  setControls(id: string, update: { permissionMode?: string }) { this.controls.push({ id, mode: update.permissionMode }); return {}; }
  peekLiveStatus() { return null; }
}

class FakeLauncher implements ScriptLauncher {
  runs = new Map<string, { command: string; status: ScriptStatus; cwd: string; env: Record<string, string> }>();
  async start(input: Parameters<ScriptLauncher['start']>[0]) {
    this.runs.set(input.runId, { command: input.command, cwd: input.cwd, env: { ...input.env }, status: { state: 'running', exitCode: null } });
    return { via: 'process' as const, tabId: null };
  }
  status(runId: string) { return this.runs.get(runId)?.status ?? null; }
  log(runId: string) { return this.runs.has(runId) ? { text: 'installing…\n', truncated: false } : null; }
  stop(runId: string) { const r = this.runs.get(runId); if (r) r.status = { state: 'failed', exitCode: null }; }
  finishAll(state: 'ok' | 'failed') { for (const r of this.runs.values()) if (r.status.state === 'running') r.status = { state, exitCode: state === 'ok' ? 0 : 1 }; }
}

class FakeMeta implements MetaLike {
  seen = new Map<string, number>();
  archived = new Set<string>();
  isUnread(s: { id: string; turnCount: number }) { return (this.seen.get(s.id) ?? 0) < s.turnCount; }
  isArchived(id: string) { return this.archived.has(id); }
  get() { return { pinned: false }; }
  markSeen(s: { id: string }, turnCount: number) { this.seen.set(s.id, turnCount); }
  update(s: { id: string }, patch: { archived?: boolean }) { if (patch.archived) this.archived.add(s.id); }
}

function ctx(over: Partial<VerseApiContext> = {}): VerseApiContext {
  return { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true, ...over };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, c = ctx()): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json', 'x-ashlr-token': TOKEN } : {}), ...headers },
  });
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const fake = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) { captured.status = status; fake.headersSent = true; return fake; },
    setHeader() {},
    end(chunk?: string) { fake.writableEnded = true; if (chunk) captured.body = JSON.parse(chunk) as Record<string, unknown>; },
  };
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleAgentsApi(c, req, fake as unknown as ServerResponse, path, method);
  return { handled, status: captured.status, body: captured.body };
}

function detail(over: Partial<AgentChecksDetail> = {}): AgentChecksDetail {
  return {
    agentId: null,
    sessionId: null,
    root: null,
    branch: 'verse/x',
    base: 'main',
    dirty: 0,
    ahead: 1,
    behind: 0,
    diffstat: null,
    pr: { number: 9, url: 'https://github.com/o/r/pull/9', state: 'open', title: 't', mergeable: true, headSha: 'a'.repeat(40) },
    ci: 'failing',
    checks: [{ name: 'test', state: 'failing', url: null }],
    comments: [],
    mergeVerdict: { allowed: false, reason: 'Checks are failing on this PR.' },
    autoFix: false,
    autoMerge: false,
    loopNote: null,
    checkedAt: '2026-09-27T12:00:00Z',
    unavailable: null,
    ...over,
  };
}

function readOf(d: AgentChecksDetail): AgentChecksRead {
  return { detail: d, files: ['src/a.ts'], summary: { pr: d.pr ? { number: d.pr.number, url: d.pr.url, state: d.pr.state, title: d.pr.title } : null, ci: d.ci, dirty: d.dirty, ahead: d.ahead, comments: 0, checkedAt: d.checkedAt } };
}

beforeEach(() => {
  savedHome = process.env['HOME'];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'verse-agents-api-')));
  process.env['HOME'] = home;
  repo = join(home, 'code', 'repo');
  mkdirSync(join(repo, '.ashlr', 'verse'), { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, '.ashlr', 'verse', 'workspace.json'), JSON.stringify({ setup: 'npm ci', run: [{ name: 'Dev', command: 'npm run dev' }], copy: ['.env'] }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, '.env'), 'K=V\n');
  invalidateGitCaches();
  resetSupervisorCachesForTest();
  store = createAgentStore();
  engine = new FakeEngine();
  launcher = new FakeLauncher();
  meta = new FakeMeta();
  checksRead = null;
  setAgentsApiDepsForTest({
    store: () => store,
    engine: () => engine,
    launcher: () => launcher,
    meta: async () => meta,
    knownRoots: async () => [repo],
    priceOf: () => PRICE,
    readChecks: async (_root, input) => {
      if (!checksRead) throw new Error('no checks in this test');
      return { ...checksRead, detail: { ...checksRead.detail, agentId: input.agentId, sessionId: input.sessionId, autoFix: input.autoFix, autoMerge: input.autoMerge } };
    },
  });
});

afterEach(() => {
  setAgentsApiDepsForTest(null);
  invalidateGitCaches();
  process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function supervisorDeps(extra: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    store: () => store,
    engine: () => engine,
    launcher: () => launcher,
    priceOf: () => PRICE,
    readChecks: async (_root, input) => ({ ...checksRead!, detail: { ...checksRead!.detail, autoFix: input.autoFix, autoMerge: input.autoMerge } }),
    failingReport: async () => 'CI is failing on PR #9. Failed log: boom',
    ...extra,
  };
}

/** Workspace → chat → bind, the way the page's spawnAgent does it. */
async function spawn(body: Record<string, unknown> = {}, prompt = 'Fix the login redirect') {
  const made = await call('POST', '/api/verse/agents/workspaces', { root: repo, title: 'Fix login', ...body });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const agent = made.body['agent'] as AgentRecord;
  const path = agent.workspace!.path.replace(/^~/, home);
  const session = blankSession('vs_1', path);
  engine.sessions.set(session.id, session);
  const bound = await call('POST', `/api/verse/agents/${agent.id}/bind`, { sessionId: 'vs_1', prompt });
  expect(bound.status, JSON.stringify(bound.body)).toBe(200);
  return { agent: (await store.get(agent.id))!, made: made.body, bound: bound.body };
}

describe('posture', () => {
  it('needs dispatch, the mutation token, strict bodies and a folder Verse knows', async () => {
    expect((await call('POST', '/api/verse/agents/workspaces', { root: repo, title: 'x' }, {}, ctx({ allowDispatch: false }))).status).toBe(404);
    expect((await call('POST', '/api/verse/agents/workspaces', { root: repo, title: 'x' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await call('POST', '/api/verse/agents/workspaces', { root: repo, title: 'x', surprise: 1 })).status).toBe(400);
    const elsewhere = join(home, 'code', 'other');
    mkdirSync(elsewhere, { recursive: true });
    const refused = await call('POST', '/api/verse/agents/workspaces', { root: elsewhere, title: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body['error']).toMatch(/not part of any chat or project/);
    expect((await call('GET', '/api/verse/agents?x=1')).status).toBe(400);
    expect((await call('POST', '/api/verse/agents/ag_0000000000000000/settings', { autoFix: true })).status).toBe(404);
  });
});

describe('one-action spawn', () => {
  it('makes the worktree, runs setup with the workspace env, holds the prompt, and sends it when setup is done', async () => {
    const { agent, made, bound } = await spawn();
    expect(agent.workspace!.branch).toBe('verse/fix-login');
    expect(existsSync(join(home, '.ashlr-worktrees', 'repo', 'fix-login', '.env'))).toBe(true);
    expect(made['config']).toMatchObject({ source: 'file', config: { setup: 'npm ci' } });
    expect(bound['held']).toBe(true);
    const [run] = [...launcher.runs.values()];
    expect(run!.command).toBe('npm ci');
    expect(run!.env['ASHLR_PORT']).toBe(String(agent.workspace!.portBase));
    expect(run!.env['ASHLR_WORKSPACE_NAME']).toBe('fix-login');
    expect(engine.sent).toEqual([]);

    // Board: the card is Working (setup), and its run buttons are known.
    const board = await call('GET', '/api/verse/agents');
    const card = (board.body['cards'] as Array<Record<string, unknown>>).find((c) => c['agentId'] === agent.id)!;
    expect(card).toMatchObject({ column: 'working', reason: 'setup-running', runScripts: ['Dev'], heldPrompt: true });

    launcher.finishAll('ok');
    await superviseAgent(supervisorDeps(), (await store.get(agent.id))!);
    expect(engine.sent).toEqual([{ id: 'vs_1', text: 'Fix the login redirect' }]);
    expect((await store.get(agent.id))!.pendingPrompt).toBeNull();
  });

  it('keeps the prompt held when setup fails, and "send anyway" releases it', async () => {
    const { agent } = await spawn();
    launcher.finishAll('failed');
    const after = await superviseAgent(supervisorDeps(), agent);
    expect(engine.sent).toEqual([]);
    expect(after.loopNote).toMatch(/Setup failed \(exit 1\)/);
    const res = await call('POST', `/api/verse/agents/${agent.id}/send-prompt`, {});
    expect(res.status).toBe(200);
    expect(engine.sent.map((s) => s.text)).toEqual(['Fix the login redirect']);
  });

  it('Plan first: plan mode + a plan request; the plan waits for approval; the edited plan is what runs', async () => {
    const { agent } = await spawn({ planFirst: true });
    launcher.finishAll('ok');
    await superviseAgent(supervisorDeps(), agent);
    expect(engine.controls).toEqual([{ id: 'vs_1', mode: 'plan' }]);
    expect(engine.sent[0]!.text).toMatch(/PLAN FIRST/);
    engine.finish('vs_1', '1. Edit login.ts\n2. Add a test');
    const planned = await superviseAgent(supervisorDeps(), (await store.get(agent.id))!);
    expect(planned.plan).toMatchObject({ state: 'awaiting-approval', text: '1. Edit login.ts\n2. Add a test' });
    // It is in Needs you, with an Approve item the drawer can act on.
    await call('GET', '/api/verse/agents');
    const item = needsYouItems().find((i) => i.kind === 'agent-plan')!;
    expect(item.actions[0]!.request!.path).toBe(`/api/verse/agents/${agent.id}/plan`);

    const approved = await call('POST', `/api/verse/agents/${agent.id}/plan`, { action: 'approve', text: '1. Edit login.ts only' });
    expect(approved.status).toBe(200);
    expect(engine.controls.at(-1)).toEqual({ id: 'vs_1', mode: 'accept-edits' });
    expect(engine.sent.at(-1)!.text).toContain('1. Edit login.ts only');
    expect((await store.get(agent.id))!.plan.state).toBe('approved');
    expect((await call('POST', `/api/verse/agents/${agent.id}/plan`, { action: 'approve' })).status).toBe(409);
  });
});

describe('spend cap', () => {
  it('warns at 80%, stops the running turn at the cap, and refuses the next turn until it is raised', async () => {
    const { agent } = await spawn({ spendCapUsd: 5 });
    launcher.finishAll('ok');
    await superviseAgent(supervisorDeps(), agent);
    // $4.50 at list price: 90% of $5.
    const s = engine.sessions.get('vs_1')!;
    engine.sessions.set('vs_1', { ...s, usage: { ...s.usage, inputTokens: 1_000_000, outputTokens: 100_000 } });
    let rec = await superviseAgent(supervisorDeps(), (await store.get(agent.id))!);
    expect(rec.spendWarnedAt).toBe(5);
    expect(engine.cancelled).toEqual([]);
    expect(await agentSpendCapRefusal('vs_1')).toBeNull();

    engine.sessions.set('vs_1', { ...engine.sessions.get('vs_1')!, usage: { ...s.usage, inputTokens: 2_000_000, outputTokens: 100_000 } });
    rec = await superviseAgent(supervisorDeps(), rec);
    expect(engine.cancelled).toEqual(['vs_1']);
    expect(rec.loopNote).toMatch(/spend cap/);
    expect(await agentSpendCapRefusal('vs_1')).toMatch(/reached its spend cap/);

    expect((await call('POST', `/api/verse/agents/${agent.id}/settings`, { spendCapUsd: 50 })).status).toBe(200);
    expect(await agentSpendCapRefusal('vs_1')).toBeNull();
    expect((await call('POST', `/api/verse/agents/${agent.id}/settings`, { spendCapUsd: -1 })).status).toBe(400);
  });
});

describe('mark read never clears Needs you', () => {
  it('bulk "read" marks Ready-for-review chats seen and skips every Needs-you card', async () => {
    engine.sessions.set('vs_ok', { ...blankSession('vs_ok', repo), turnCount: 2 });
    engine.sessions.set('vs_bad', { ...blankSession('vs_bad', repo), turnCount: 2, status: 'error' });
    const res = await call('POST', '/api/verse/agents/bulk', { action: 'read', ids: ['chat:vs_ok', 'chat:vs_bad'] });
    expect(res.status).toBe(200);
    expect(res.body['results']).toEqual([
      { id: 'chat:vs_ok', ok: true },
      { id: 'chat:vs_bad', ok: false, skipped: 'Needs you: resolve it, marking read does not.' },
    ]);
    expect(meta.seen.get('vs_ok')).toBe(2);
    expect(meta.seen.has('vs_bad')).toBe(false);
    // Resolving is the explicit way out.
    expect((await call('POST', '/api/verse/agents/chat:vs_bad/resolve', {})).status).toBe(200);
    const board = await call('GET', '/api/verse/agents');
    const card = (board.body['cards'] as Array<Record<string, unknown>>).find((c) => c['id'] === 'chat:vs_bad')!;
    expect(card['column']).not.toBe('needs-you');
  });
});

describe('the post-PR loop', () => {
  async function readyAgent(settings: Record<string, unknown>) {
    const { agent } = await spawn();
    launcher.finishAll('ok');
    await superviseAgent(supervisorDeps(), agent);
    engine.finish('vs_1', 'Done, PR opened.');
    await call('POST', `/api/verse/agents/${agent.id}/settings`, settings);
    return (await store.get(agent.id))!;
  }

  it('Auto-fix sends the failing CI log to the same seat once per head, then gives up after three', async () => {
    let agent = await readyAgent({ autoFix: true });
    checksRead = readOf(detail());
    agent = await superviseAgent(supervisorDeps(), agent);
    expect(engine.sent.at(-1)!.text).toMatch(/CI is failing on PR #9/);
    expect(agent.autoFixAttempts).toBe(1);
    const sentBefore = engine.sent.length;
    engine.finish('vs_1', 'pushed a fix');
    resetSupervisorCachesForTest();
    agent = await superviseAgent(supervisorDeps(), agent);
    expect(engine.sent.length).toBe(sentBefore); // same head: not again

    for (const head of ['b', 'c']) {
      engine.finish('vs_1', 'another fix');
      checksRead = readOf(detail({ pr: { ...detail().pr!, headSha: head.repeat(40) } }));
      resetSupervisorCachesForTest();
      agent = await superviseAgent(supervisorDeps(), agent);
    }
    expect(agent.autoFixAttempts).toBe(3);
    engine.finish('vs_1', 'still red');
    checksRead = readOf(detail({ pr: { ...detail().pr!, headSha: 'd'.repeat(40) } }));
    resetSupervisorCachesForTest();
    agent = await superviseAgent(supervisorDeps(), agent);
    expect(agent.loopNote).toMatch(/gave up after 3/);
    const board = await call('GET', '/api/verse/agents');
    expect((board.body['cards'] as Array<Record<string, unknown>>).find((c) => c['agentId'] === agent.id)!['reason']).toBe('ci-failed');
  });

  it('Auto-merge merges only on an allowed verdict, then archives the workspace (worktree and branch)', async () => {
    let agent = await readyAgent({ autoMerge: true });
    const merges: Array<{ number: number; headSha: string; requiredChecks?: readonly string[] }> = [];
    const merge = async (_root: string, input: { number: number; headSha: string; requiredChecks?: readonly string[] }) => { merges.push(input); };
    checksRead = readOf(detail({ ci: 'passing', mergeVerdict: { allowed: false, reason: 'It touches .github/workflows/ci.yml — CI config. That merge is yours, never automatic.' } }));
    agent = await superviseAgent(supervisorDeps({ merge }), agent);
    expect(merges).toEqual([]);
    expect(agent.loopNote).toMatch(/Auto-merge is holding: It touches \.github/);

    resetSupervisorCachesForTest();
    checksRead = readOf(detail({ ci: 'passing', mergeVerdict: { allowed: true, reason: 'ok' } }));
    agent = await superviseAgent(supervisorDeps({ merge, checksDeps: { requiredAutoMergeChecks: () => ['CI'] } }), agent);
    expect(merges).toEqual([{ number: 9, headSha: 'a'.repeat(40), requiredChecks: ['CI'] }]);
    expect(agent.archived).toMatchObject({ reason: 'merged', branchDeleted: true });
    expect(existsSync(join(home, '.ashlr-worktrees', 'repo', 'fix-login'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'verse/fix-login')).toBe('');
    expect(agent.loopNote).toMatch(/Merged PR #9 and archived/);
  });
});

describe('archive and restore over the API', () => {
  it('archives with a snapshot and restores the workspace where it was', async () => {
    const { agent } = await spawn();
    launcher.finishAll('ok');
    const path = join(home, '.ashlr-worktrees', 'repo', 'fix-login');
    writeFileSync(join(path, 'wip.txt'), 'not committed\n');
    const archived = await call('POST', `/api/verse/agents/${agent.id}/archive`, {});
    expect(archived.status).toBe(200);
    expect(existsSync(path)).toBe(false);
    const board = await call('GET', '/api/verse/agents');
    const card = (board.body['cards'] as Array<Record<string, unknown>>).find((c) => c['agentId'] === agent.id)!;
    expect(card).toMatchObject({ column: 'done', reason: 'archived', restorable: true });
    const restored = await call('POST', `/api/verse/agents/${agent.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
  });
});

describe('agents without a workspace, discards and read-only checks', () => {
  it('adopts a plain chat as an agent and sends its prompt at once (no setup to wait for)', async () => {
    engine.sessions.set('vs_plain', blankSession('vs_plain', repo));
    const adopted = await call('POST', '/api/verse/agents/chat', { sessionId: 'vs_plain', spendCapUsd: 3 });
    expect(adopted.status).toBe(201);
    const agent = adopted.body['agent'] as AgentRecord;
    expect(agent.workspace).toBeNull();
    expect(agent.spendCapUsd).toBe(3);
    const bound = await call('POST', `/api/verse/agents/${agent.id}/bind`, { sessionId: 'vs_plain', prompt: 'Explain the router' });
    expect(bound.status).toBe(200);
    expect(bound.body['held']).toBe(false);
    expect(engine.sent).toEqual([{ id: 'vs_plain', text: 'Explain the router' }]);
    // Adopting the same chat again answers the same agent.
    expect(((await call('POST', '/api/verse/agents/chat', { sessionId: 'vs_plain' })).body['agent'] as AgentRecord).id).toBe(agent.id);
  });

  it('discards a workspace whose chat never came to be, and refuses a bind to a chat elsewhere', async () => {
    const made = await call('POST', '/api/verse/agents/workspaces', { root: repo, title: 'Orphan' });
    const agent = made.body['agent'] as AgentRecord;
    engine.sessions.set('vs_wrong', blankSession('vs_wrong', repo));
    const wrong = await call('POST', `/api/verse/agents/${agent.id}/bind`, { sessionId: 'vs_wrong' });
    expect(wrong.status).toBe(409);
    expect(wrong.body['error']).toMatch(/does not run in this agent’s workspace/);
    const gone = await call('POST', `/api/verse/agents/${agent.id}/discard`, {});
    expect(gone.status).toBe(200);
    expect(existsSync(join(home, '.ashlr-worktrees', 'repo', 'orphan'))).toBe(false);
    expect(await store.get(agent.id)).toBeNull();
  });

  it('reads Checks for any chat (read-only) from its own folder', async () => {
    engine.sessions.set('vs_c', blankSession('vs_c', repo));
    const roots: string[] = [];
    setAgentsApiDepsForTest({
      store: () => store,
      engine: () => engine,
      launcher: () => launcher,
      meta: async () => meta,
      knownRoots: async () => [repo],
      priceOf: () => PRICE,
      readChecks: async (root, input) => {
        roots.push(root);
        return readOf(detail({ agentId: input.agentId, sessionId: input.sessionId, ci: 'passing' }));
      },
    });
    const res = await call('GET', '/api/verse/agents/chat:vs_c/checks');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: null, sessionId: 'vs_c', ci: 'passing' });
    expect(roots).toEqual([repo]);
    expect((await call('GET', '/api/verse/agents/chat:vs_c/checks?fresh=1&x=2')).status).toBe(400);
  });
});
