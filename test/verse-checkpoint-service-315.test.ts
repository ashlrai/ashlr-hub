/**
 * 3.15 workbench — the checkpoint SERVICE (turn hooks, Changes diff, review,
 * three-way Undo/Redo), the ENGINE's pre-turn gate, and the
 * `/api/verse/checkpoints*` routes — on real temp repositories.
 *
 * Every flow ends by proving the operator's index, stash list, branches and
 * HEAD are exactly what they were.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCheckpointService, type CheckpointChat, type CheckpointService } from '../src/core/verse/checkpoint-service.js';
import { handleCheckpointsApi, setCheckpointsApiDepsForTest } from '../src/core/verse/checkpoints-api.js';
import { rootIdFor } from '../src/core/verse/checkpoints.js';
import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { isTransientVerseEvent, type VerseEvent, type VerseSeat } from '../src/core/verse/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function operatorState(repo: string): string {
  const index = join(repo, '.git', 'index');
  return JSON.stringify({
    index: existsSync(index) ? readFileSync(index).toString('base64') : null,
    head: readFileSync(join(repo, '.git', 'HEAD'), 'utf8'),
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes', 'refs/stash'),
    stash: git(repo, 'stash', 'list'),
  });
}

const BASE_A = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\n';

let work: string;
let repo: string;
let stateDir: string;
let service: CheckpointService;
let chat: CheckpointChat;
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const write = (p: string, s: string) => writeFileSync(join(repo, p), s);

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'verse-cks-')));
  repo = join(work, 'repo');
  stateDir = join(work, 'state');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  write('a.txt', BASE_A);
  write('b.txt', 'b one\nb two\n');
  write('c.txt', 'c\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'stash', 'list');
  service = createCheckpointService({ stateDir });
  chat = { id: 'chat-1', roots: [repo], running: false };
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** One "agent turn": pre checkpoint, edits, post checkpoint. */
async function agentTurn(turnId: string, edit: () => void): Promise<void> {
  await service.beforeTurn({ sessionId: chat.id, turnId, roots: [repo] });
  edit();
  await service.afterTurn({ sessionId: chat.id, turnId, roots: [repo], outcome: 'ok' });
}

const ROOT = () => rootIdFor(repo);

describe('turn hooks and the Changes list', () => {
  it('records pre/post checkpoints per turn under hidden refs, and a journal', async () => {
    const before = operatorState(repo);
    await agentTurn('t1', () => {
      write('a.txt', BASE_A.replace('beta', 'BETA'));
      write('new.txt', 'agent made this\n');
    });
    await agentTurn('t2', () => rmSync(join(repo, 'c.txt')));
    const list = await service.list(chat);
    expect(list.roots).toEqual([{ rootId: ROOT(), path: repo, name: 'repo' }]);
    expect(list.turns.map((t) => [t.index, t.turnId, t.state, t.filesChanged])).toEqual([[1, 't1', 'done', 2], [2, 't2', 'done', 1]]);
    expect(list.turns[0]!.roots[0]!.pre?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(list.redo).toBeNull();
    const refs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/ashlr').trim().split('\n');
    expect(refs).toHaveLength(4);
    expect(refs.every((r) => r.startsWith('refs/ashlr/checkpoints/chat-1/'))).toBe(true);
    expect(readdirSync(stateDir)).toEqual(['chat-1.jsonl']);
    // Beyond the edits themselves, nothing the operator owns moved.
    expect(operatorState(repo)).toBe(before);
  });

  it('diffs a turn (pre → post) and "since" (pre → disk now), flagging later edits', async () => {
    await agentTurn('t1', () => write('a.txt', BASE_A.replace('beta', 'BETA')));
    write('a.txt', BASE_A.replace('beta', 'BETA').replace('kappa', 'KAPPA (mine)'));
    write('b.txt', 'b one\nb two\nmine\n');
    const turn = await service.diff(chat, 't1', ROOT(), 'turn', 'a.txt');
    expect(turn.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(turn.actionable).toBe(false);
    expect(turn.patch?.hunks).toHaveLength(1);
    const since = await service.diff(chat, 't1', ROOT(), 'since', 'a.txt');
    expect(since.actionable).toBe(true);
    expect(since.files.map((f) => [f.path, f.editedAfterTurn])).toEqual([['a.txt', true], ['b.txt', true]]);
    expect(since.patch?.text).toContain('+KAPPA (mine)');
    expect(since.patch?.hunks.length).toBe(2);
    await expect(service.diff(chat, 't1', ROOT(), 'since', 'zzz.txt')).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_STALE' });
    await expect(service.diff(chat, 'nope', ROOT(), 'since', null)).rejects.toMatchObject({ code: 'VERSE_NOT_FOUND' });
  });
});

describe('review: accept and reject', () => {
  it('rejects one hunk (restored from the checkpoint), records accepts, and rejects a whole file', async () => {
    await agentTurn('t1', () => {
      write('a.txt', BASE_A.replace('alpha', 'ALPHA').replace('kappa', 'KAPPA'));
      write('added.txt', 'agent\n');
    });
    const before = operatorState(repo);
    const d = await service.diff(chat, 't1', ROOT(), 'since', 'a.txt');
    const [first, second] = d.patch!.hunks;
    await service.review(chat, { turnId: 't1', rootId: ROOT(), file: 'a.txt', hunk: second!.hash, decision: 'reject' });
    expect(read('a.txt')).toBe(BASE_A.replace('alpha', 'ALPHA'));
    await service.review(chat, { turnId: 't1', rootId: ROOT(), file: 'a.txt', hunk: first!.hash, decision: 'accept' });
    const after = await service.diff(chat, 't1', ROOT(), 'since', 'a.txt');
    expect(after.patch!.hunks.map((h) => h.accepted)).toEqual([true]);
    // Whole-file reject of a file the agent created removes it.
    const res = await service.review(chat, { turnId: 't1', rootId: ROOT(), file: 'added.txt', hunk: null, decision: 'reject' });
    expect(res.changed).toEqual(['added.txt']);
    expect(existsSync(join(repo, 'added.txt'))).toBe(false);
    expect(operatorState(repo)).toBe(before);
    // A stale hunk is refused, never misapplied.
    await expect(service.review(chat, { turnId: 't1', rootId: ROOT(), file: 'a.txt', hunk: second!.hash, decision: 'reject' }))
      .rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_STALE' });
  });

  it('refuses to reject while a turn runs', async () => {
    await agentTurn('t1', () => write('a.txt', 'x\n'));
    await expect(service.review({ ...chat, running: true }, { turnId: 't1', rootId: ROOT(), file: 'a.txt', hunk: null, decision: 'reject' }))
      .rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_BUSY' });
    expect(read('a.txt')).toBe('x\n');
  });
});

describe('undo and redo', () => {
  it('undoes a turn cleanly and redoes it', async () => {
    const before = operatorState(repo);
    await agentTurn('t1', () => {
      write('a.txt', BASE_A.replace('gamma', 'GAMMA'));
      write('new.txt', 'new\n');
      rmSync(join(repo, 'c.txt'));
    });
    const preview = await service.previewUndo(chat, 't1');
    expect(preview.roots[0]).toMatchObject({ rootId: ROOT(), conflicts: [], kept: [], uncaptured: [], unavailable: null });
    expect(preview.roots[0]!.apply.map((f) => [f.path, f.action]).sort()).toEqual([['a.txt', 'restore'], ['c.txt', 'restore'], ['new.txt', 'delete']]);
    const applied = await service.apply(chat, preview.previewId, {});
    expect(applied.redo).toEqual({ turnId: 't1', at: expect.any(String) });
    expect(read('a.txt')).toBe(BASE_A);
    expect(read('c.txt')).toBe('c\n');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect((await service.list(chat)).turns[0]!.state).toBe('undone');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/ashlr').split('\n').filter((r) => /\/(undo|undone)$/.test(r))).toHaveLength(2);

    const redo = await service.previewRedo(chat);
    expect(redo.roots[0]!.conflicts).toEqual([]);
    await service.apply(chat, redo.previewId, {});
    expect(read('a.txt')).toBe(BASE_A.replace('gamma', 'GAMMA'));
    expect(read('new.txt')).toBe('new\n');
    expect(existsSync(join(repo, 'c.txt'))).toBe(false);
    expect((await service.list(chat)).redo).toBeNull();
    expect(operatorState(repo)).toBe(before);
    // Everything is in the journal.
    const kinds = readFileSync(join(stateDir, 'chat-1.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds).toEqual(['turn-start', 'turn-end', 'undo', 'redo']);
  });

  it('never silently overwrites later edits: three-way preview, a decision per file, merge keeps both', async () => {
    await agentTurn('t1', () => {
      write('a.txt', BASE_A.replace('alpha', 'AGENT'));
      write('b.txt', 'b one\nb two\nagent\n');
    });
    // The operator edits after the turn: a.txt (also the agent's) and c.txt (only theirs).
    write('a.txt', BASE_A.replace('alpha', 'AGENT').replace('kappa', 'MINE'));
    write('c.txt', 'c mine\n');
    const preview = await service.previewUndo(chat, 't1');
    const plan = preview.roots[0]!;
    expect(plan.apply.map((f) => f.path)).toEqual(['b.txt']);
    expect(plan.kept).toEqual(['c.txt']);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ path: 'a.txt', kind: 'edited-after', merge: { clean: true } });
    expect(plan.conflicts[0]!.merge.text).toBe(BASE_A.replace('kappa', 'MINE'));
    expect(plan.conflicts[0]!.diff).toContain('-MINE');

    // No decision → refused, nothing written.
    await expect(service.apply(chat, preview.previewId, {})).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    expect(read('b.txt')).toBe('b one\nb two\nagent\n');

    await service.apply(chat, preview.previewId, { [ROOT()]: { 'a.txt': 'merge' } });
    expect(read('a.txt')).toBe(BASE_A.replace('kappa', 'MINE'));
    expect(read('b.txt')).toBe('b one\nb two\n');
    expect(read('c.txt')).toBe('c mine\n');
  });

  it('keep leaves the file exactly as it is; overlapping edits cannot merge', async () => {
    await agentTurn('t1', () => write('a.txt', BASE_A.replace('alpha', 'AGENT')));
    write('a.txt', BASE_A.replace('alpha', 'MINE'));
    const preview = await service.previewUndo(chat, 't1');
    expect(preview.roots[0]!.conflicts[0]!.merge.clean).toBe(false);
    await expect(service.apply(chat, preview.previewId, { [ROOT()]: { 'a.txt': 'merge' } })).rejects.toMatchObject({ code: 'VERSE_INVALID' });
    await service.apply(chat, preview.previewId, { [ROOT()]: { 'a.txt': 'keep' } });
    expect(read('a.txt')).toBe(BASE_A.replace('alpha', 'MINE'));
  });

  it('refuses a stale preview (files moved after it was shown) and writes nothing', async () => {
    await agentTurn('t1', () => write('a.txt', 'agent\n'));
    const preview = await service.previewUndo(chat, 't1');
    write('b.txt', 'changed after the preview\n');
    await expect(service.apply(chat, preview.previewId, {})).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_STALE' });
    expect(read('a.txt')).toBe('agent\n');
    expect(read('b.txt')).toBe('changed after the preview\n');
    // The preview is gone: a retry must be reviewed again.
    await expect(service.apply(chat, preview.previewId, {})).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_STALE' });
  });

  it('refuses undo while a turn is running, and rewinding an earlier turn undoes the later ones too', async () => {
    await agentTurn('t1', () => write('a.txt', 'one\n'));
    await agentTurn('t2', () => write('b.txt', 'two\n'));
    await expect(service.previewUndo({ ...chat, running: true }, 't1')).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_BUSY' });
    const preview = await service.previewUndo(chat, 't1');
    await service.apply(chat, preview.previewId, {});
    expect(read('a.txt')).toBe(BASE_A);
    expect(read('b.txt')).toBe('b one\nb two\n');
    expect((await service.list(chat)).turns.map((t) => t.state)).toEqual(['undone', 'undone']);
    // A new turn clears Redo.
    await agentTurn('t3', () => write('c.txt', 'three\n'));
    expect((await service.list(chat)).redo).toBeNull();
    await expect(service.previewRedo(chat)).rejects.toMatchObject({ code: 'VERSE_CHECKPOINT_UNAVAILABLE' });
  });

  it('forgets a deleted chat: refs and journal go', async () => {
    await agentTurn('t1', () => write('a.txt', 'x\n'));
    await service.forgetChat(chat.id, [repo]);
    expect(git(repo, 'for-each-ref', 'refs/ashlr')).toBe('');
    expect(existsSync(join(stateDir, 'chat-1.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The engine gate: the checkpoint is taken BEFORE the seat process exists
// ---------------------------------------------------------------------------

const CLAUDE_SEAT: VerseSeat = {
  id: 'claude-max',
  engine: 'claude',
  label: 'claude-max',
  accountId: 'claude-max',
  models: [{ id: 'claude-opus-5', label: 'claude-opus-5', contextWindow: null }],
  contextWindow: null,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

/** A fake `claude` that edits the repo it is started in, then reports success. */
const FAKE_AGENT = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const sid = flag('--session-id') || flag('--resume') || 'x';
fs.writeFileSync(path.join(process.cwd(), 'agent-wrote.txt'), 'from the agent\\n');
fs.appendFileSync(path.join(process.cwd(), 'a.txt'), 'agent line\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: flag('--model') });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
`;

function untilTurnDone(engine: VerseEngineHandle, id: string, timeoutMs = 15_000): Promise<VerseEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: VerseEvent[] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`turn-done not seen; saw ${seen.map((e) => e.type).join(',')}`)); }, timeoutMs);
    const off = engine.subscribe(id, 0, (event) => {
      if (isTransientVerseEvent(event)) return;
      seen.push(event);
      if (event.type === 'turn-done') {
        clearTimeout(timer);
        off();
        resolve(seen);
      }
    });
  });
}

describe('engine gate', () => {
  let engine: VerseEngineHandle | null = null;
  let launch: VerseSeatLaunch;

  beforeEach(() => {
    const launcher = join(work, 'fake-claude.cjs');
    writeFileSync(launcher, FAKE_AGENT, { mode: 0o700 });
    launch = { seat: CLAUDE_SEAT, launcher: [process.execPath, launcher], ollamaBaseUrl: 'http://127.0.0.1:11434' };
  });

  afterEach(() => {
    engine?.close();
    engine = null;
  });

  it('snapshots before the agent writes and after it finishes; Undo restores the repo', async () => {
    engine = createVerseEngine({
      root: join(work, 'verse'),
      readiness: null,
      reasoningTap: null,
      preflight: null,
      turnHooks: {
        beforeTurn: (info) => service.beforeTurn(info),
        afterTurn: (info) => service.afterTurn(info),
        onSessionDeleted: (info) => service.forgetChat(info.sessionId, info.roots),
      },
    });
    const session = engine.createSession({ projectPath: repo, seatId: 'claude-max' }, launch);
    const before = operatorState(repo);
    const done = untilTurnDone(engine, session.id);
    const { turnId } = engine.sendTurn(session.id, 'please edit');
    await done;
    // afterTurn is fired (not awaited) just after turn-done; let it queue, then drain.
    await new Promise((r) => setTimeout(r, 25));
    await service.idle(session.id);
    const c: CheckpointChat = { id: session.id, roots: [repo], running: false };
    const list = await service.list(c);
    expect(list.turns).toHaveLength(1);
    const t = list.turns[0]!;
    expect(t.turnId).toBe(turnId);
    const pre = t.roots[0]!.pre!.commit!;
    const post = t.roots[0]!.post!.commit!;
    // The pre-turn checkpoint holds NONE of the agent's writes; the post one holds all.
    expect(git(repo, 'ls-tree', '--name-only', pre)).not.toContain('agent-wrote.txt');
    expect(git(repo, 'show', `${pre}:a.txt`)).toBe(BASE_A);
    expect(git(repo, 'show', `${post}:agent-wrote.txt`)).toBe('from the agent\n');
    const d = await service.diff(c, turnId, rootIdFor(repo), 'turn', null);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'M'], ['agent-wrote.txt', 'A']]);

    const preview = await service.previewUndo(c, turnId);
    await service.apply(c, preview.previewId, {});
    expect(read('a.txt')).toBe(BASE_A);
    expect(existsSync(join(repo, 'agent-wrote.txt'))).toBe(false);
    expect(operatorState(repo)).toBe(before);

    engine.deleteSession(session.id);
    await new Promise((r) => setTimeout(r, 50));
    await service.idle(session.id);
    expect(git(repo, 'for-each-ref', 'refs/ashlr')).toBe('');
  });

  it('is busy while the checkpoint runs, and Stop then closes the turn without ever starting the agent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    engine = createVerseEngine({
      root: join(work, 'verse'),
      readiness: null,
      reasoningTap: null,
      preflight: null,
      turnHooks: { beforeTurn: () => gate },
    });
    const session = engine.createSession({ projectPath: repo, seatId: 'claude-max' }, launch);
    const done = untilTurnDone(engine, session.id);
    engine.sendTurn(session.id, 'first');
    expect(() => engine!.sendTurn(session.id, 'second')).toThrow(expect.objectContaining({ code: 'VERSE_SESSION_BUSY' }));
    expect(engine.getSession(session.id)?.status).toBe('running');
    expect(engine.cancelTurn(session.id)).toBe(true);
    release();
    const events = await done;
    expect(events.map((e) => e.type)).toEqual(['user-message', 'cancelled', 'turn-done']);
    expect(existsSync(join(repo, 'agent-wrote.txt'))).toBe(false);
    expect(engine.getSession(session.id)?.status).toBe('idle');
  });

  it('a hook that fails never blocks the turn', async () => {
    engine = createVerseEngine({
      root: join(work, 'verse'),
      readiness: null,
      reasoningTap: null,
      preflight: null,
      log: () => undefined,
      turnHooks: { beforeTurn: () => Promise.reject(new Error('boom')), afterTurn: () => { throw new Error('boom'); } },
    });
    const session = engine.createSession({ projectPath: repo, seatId: 'claude-max' }, launch);
    const done = untilTurnDone(engine, session.id);
    engine.sendTurn(session.id, 'go');
    const events = await done;
    expect(events.at(-1)).toMatchObject({ type: 'turn-done', ok: true });
    expect(read('agent-wrote.txt')).toBe('from the agent\n');
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const TOKEN = 'ck-test-token';

function ctx(over: Partial<VerseApiContext> = {}): VerseApiContext {
  return { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true, ...over };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, c = ctx()) {
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
  const handled = await handleCheckpointsApi(c, req, fake as unknown as ServerResponse, path, method);
  return { handled, ...captured };
}

describe('/api/verse/checkpoints', () => {
  let sessions: Array<{ id: string; projectPath: string; extraRoots?: string[]; status: 'idle' | 'running' | 'error' }>;

  beforeEach(() => {
    sessions = [{ id: 'chat-1', projectPath: repo, status: 'idle' }];
    setCheckpointsApiDepsForTest({ service, sessions: () => sessions });
  });

  afterEach(() => setCheckpointsApiDepsForTest(null));

  it('lists, diffs, previews and applies an undo through the routes', async () => {
    await agentTurn('t1', () => write('a.txt', 'agent\n'));
    const list = await call('GET', '/api/verse/checkpoints?chatId=chat-1');
    expect(list.status).toBe(200);
    expect((list.body['turns'] as unknown[]).length).toBe(1);
    const d = await call('GET', `/api/verse/checkpoints/diff?chatId=chat-1&turnId=t1&rootId=${ROOT()}&mode=since&file=a.txt`);
    expect(d.status).toBe(200);
    expect((d.body['patch'] as { text: string }).text).toContain('+agent');
    const p = await call('POST', '/api/verse/checkpoints/undo/preview', { chatId: 'chat-1', turnId: 't1' });
    expect(p.status).toBe(200);
    const a = await call('POST', '/api/verse/checkpoints/apply', { chatId: 'chat-1', previewId: p.body['previewId'] });
    expect(a.status).toBe(200);
    expect(read('a.txt')).toBe(BASE_A);
  });

  it('is strict: unknown params/keys 400, unknown chat 404, not our routes false', async () => {
    expect((await call('GET', '/api/verse/checkpoints?chatId=chat-1&x=1')).status).toBe(400);
    expect((await call('GET', '/api/verse/checkpoints?chatId=nope')).status).toBe(404);
    expect((await call('GET', `/api/verse/checkpoints/diff?chatId=chat-1&turnId=t1&rootId=${ROOT()}&mode=all`)).status).toBe(400);
    expect((await call('GET', `/api/verse/checkpoints/diff?chatId=chat-1&turnId=t1&rootId=${ROOT()}&file=../x`)).status).toBe(400);
    expect((await call('POST', '/api/verse/checkpoints/undo/preview', { chatId: 'chat-1', turnId: 't1', root: '/' })).status).toBe(400);
    expect((await call('POST', '/api/verse/checkpoints/apply', { chatId: 'chat-1', previewId: 'abcdef12', resolutions: { [ROOT()]: { 'a.txt': 'yolo' } } })).status).toBe(400);
    expect((await call('GET', '/api/verse/checkpointsx')).handled).toBe(false);
  });

  it('gates writes: dispatch off → 404, no token → refused, a running chat in the same repo → 409', async () => {
    await agentTurn('t1', () => write('a.txt', 'agent\n'));
    expect((await call('POST', '/api/verse/checkpoints/undo/preview', { chatId: 'chat-1', turnId: 't1' }, {}, ctx({ allowDispatch: false }))).status).toBe(404);
    const noToken = await call('POST', '/api/verse/checkpoints/undo/preview', { chatId: 'chat-1', turnId: 't1' }, { 'x-ashlr-token': 'wrong' });
    expect(noToken.status).toBeGreaterThanOrEqual(401);
    sessions.push({ id: 'chat-2', projectPath: join(repo), status: 'running' });
    const busy = await call('POST', '/api/verse/checkpoints/undo/preview', { chatId: 'chat-1', turnId: 't1' });
    expect(busy.status).toBe(409);
    expect(busy.body['code']).toBe('VERSE_CHECKPOINT_BUSY');
    expect(read('a.txt')).toBe('agent\n');
  });
});
