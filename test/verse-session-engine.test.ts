/**
 * test/verse-session-engine.test.ts — Verse session engine + durable store,
 * driven end-to-end against FAKE vendor CLIs: small node scripts in a tmp dir
 * (mode 0700) that print canned stream output for the engine they impersonate
 * and echo their argv/env/stdin to a side file so the test can assert what was
 * actually launched. Real detached subprocesses are spawned; real-io lane.
 *
 * HOME is relocated by test/setup/home.ts; the engine is additionally given an
 * explicit tmp root so nothing here can reach the real ~/.ashlr.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVerseEngine, VerseError, buildTurnEnv, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { createVerseSessionStore } from '../src/core/verse/session-store.js';
import { VERSE_MAX_TURN_TEXT_BYTES, type VerseEvent, type VerseSeat } from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Fake CLI
// ---------------------------------------------------------------------------

/**
 * One script impersonates all three vendors, picking the dialect from argv:
 *   - argv[0] === 'exec'                                  → codex JSONL (prompt from stdin)
 *   - '--output-format streaming-messages-json' present   → grok / Anthropic wire NDJSON
 *   - otherwise                                           → claude stream-json
 * Prompt directives: HANG (ignore SIGINT, never exit), FAIL (exit 1 + stderr).
 */
function fakeCliSource(sideDir: string): string {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SIDE = ${JSON.stringify(sideDir)};
const argv = process.argv.slice(2);
const n = fs.readdirSync(SIDE).filter((f) => f.startsWith('call-')).length + 1;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };

function record(extra) {
  fs.writeFileSync(path.join(SIDE, 'call-' + n + '.json'), JSON.stringify({ argv, env: process.env, cwd: process.cwd(), ...extra }));
}

function hang() {
  process.on('SIGINT', () => { /* deliberately ignored: forces SIGKILL escalation */ });
  setInterval(() => {}, 1000);
}

function fail() {
  // A real launcher.mjs stack trace prints its own path; the engine must scrub it.
  fs.writeSync(2, 'boom: simulated vendor failure\\n    at ' + __filename + ':1:1\\n');
  process.exit(1);
}

if (argv[0] === 'exec') {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => {
    record({ stdin });
    const resume = argv[1] === 'resume';
    const thread = resume ? argv[2] : 'thr_fake_' + n;
    out({ type: 'thread.started', thread_id: thread });
    if (stdin.includes('HANG')) return hang();
    if (stdin.includes('FAIL')) return fail();
    out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex says: ' + stdin.trim() } });
    out({ type: 'turn.completed', usage: { input_tokens: 300 * n, cached_input_tokens: 100, output_tokens: 20 } });
    process.exit(0);
  });
} else {
  // claude: positional prompt after the end-of-options marker; grok: --single=<text>.
  const dashdash = argv.indexOf('--');
  const single = argv.find((a) => a.startsWith('--single='));
  const prompt = dashdash !== -1 ? argv.slice(dashdash + 1).join(' ') : single ? single.slice('--single='.length) : '';
  const sid = flag('--session-id') || flag('--resume') || 'unknown';
  record({});
  const grok = flag('--output-format') === 'streaming-messages-json';
  if (grok) {
    out({ type: 'message_start', message: { id: 'm', role: 'assistant', usage: { input_tokens: 400 * n, output_tokens: 0 } } });
    out({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    if (prompt.includes('HANG')) return hang();
    if (prompt.includes('FAIL')) return fail();
    out({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'grok says: ' + prompt } });
    out({ type: 'content_block_stop', index: 0 });
    out({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
    out({ type: 'message_stop' });
    process.exit(0);
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: flag('--model') });
  if (prompt.includes('HANG')) return hang();
  if (prompt.includes('FAIL')) return fail();
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude says: ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: prompt } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude says: ' + prompt }], usage: { input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50, output_tokens: 8 } } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 1, usage: { input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50, output_tokens: 8 } });
  process.exit(0);
}
`;
}

interface Call { argv: string[]; env: Record<string, string>; cwd: string; stdin?: string }

function readCalls(sideDir: string): Call[] {
  return readdirSync(sideDir)
    .filter((f) => f.startsWith('call-'))
    .sort((a, b) => Number(a.slice(5, -5)) - Number(b.slice(5, -5)))
    .map((f) => JSON.parse(readFileSync(join(sideDir, f), 'utf8')) as Call);
}

function seat(engine: VerseSeat['engine'], id: string, models: string[]): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: engine === 'local' ? 'local' : id,
    models: models.map((m) => ({ id: m, label: m, contextWindow: engine === 'local' ? 32_000 : null })),
    contextWindow: null,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };
}

function untilTurnDone(engine: VerseEngineHandle, id: string, fromSeq = 0, timeoutMs = 15_000): Promise<VerseEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: VerseEvent[] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`turn-done not seen within ${timeoutMs}ms; saw ${seen.map((e) => e.type).join(',')}`)); }, timeoutMs);
    const off = engine.subscribe(id, fromSeq, (event) => {
      seen.push(event);
      if (event.type === 'turn-done') {
        clearTimeout(timer);
        off();
        resolve(seen);
      }
    });
  });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------

let work: string;
let root: string;
let side: string;
let binDir: string;
let launcherPath: string;
let project: string;
let engine: VerseEngineHandle;
const originalPath = process.env.PATH;
const CLAUDE_SEAT = seat('claude', 'claude-max', ['claude-opus-5', 'claude-sonnet-5']);
const LOCAL_SEAT = seat('local', 'local:qwen3-coder', ['qwen3-coder']);
const CODEX_SEAT = seat('codex', 'codex-a', ['gpt-5.5']);
const GROK_SEAT = seat('grok', 'grok', ['grok-4']);
let nativeLaunch: (s: VerseSeat) => VerseSeatLaunch;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-engine-'));
  root = join(work, 'verse-root');
  side = join(work, 'side');
  binDir = join(work, 'bin');
  project = join(work, 'project');
  mkdirSync(side, { mode: 0o700 });
  mkdirSync(binDir, { mode: 0o700 });
  mkdirSync(project, { mode: 0o700 });
  // createSession realpaths the project dir (macOS: /var -> /private/var); compare against the same form.
  project = realpathSync(project);
  // The plain `claude` binary used by engine=local resolves through PATH.
  const claudeOnPath = join(binDir, 'claude');
  writeFileSync(claudeOnPath, fakeCliSource(side), { mode: 0o700 });
  chmodSync(claudeOnPath, 0o700);
  // Native-profile launcher: node + script, exactly like ~/.ashlr/native-profiles/*/launcher.mjs.
  launcherPath = join(work, 'launcher.cjs');
  writeFileSync(launcherPath, fakeCliSource(side), { mode: 0o700 });
  nativeLaunch = (s) => ({ seat: s, launcher: [process.execPath, launcherPath], ollamaBaseUrl: 'http://127.0.0.1:11434' });
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  // Credential-shaped vars that must NEVER reach a vendor CLI.
  process.env.GITHUB_TOKEN = 'ghp_fake_not_real';
  process.env.SOME_VENDOR_API_KEY = 'sk_fake_not_real';
  process.env.DB_PASSWORD = 'nope';
  engine = createVerseEngine({ root, killGraceMs: 200 });
});

afterEach(() => {
  engine.close();
  process.env.PATH = originalPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.SOME_VENDOR_API_KEY;
  delete process.env.DB_PASSWORD;
  rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('validates project, seat, model and mints native ids per engine', () => {
    expect(() => engine.createSession({ projectPath: join(work, 'missing'), seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(expect.objectContaining({ code: 'VERSE_INVALID', status: 400 }));
    expect(() => engine.createSession({ projectPath: 'relative/path', seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(VerseError);
    expect(() => engine.createSession({ projectPath: project, seatId: 'other-seat' }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(expect.objectContaining({ code: 'VERSE_INVALID' }));
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max', model: 'gpt-5.5' }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(/not available on seat/);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max' }, { ...nativeLaunch(CLAUDE_SEAT), launcher: null }))
      .toThrow(/no launcher/);

    const claude = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    expect(claude.model).toBe('claude-opus-5');
    expect(claude.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claude.title).toBe('New chat');
    expect(claude.status).toBe('idle');
    expect(claude.usage.contextWindow).toBe(200_000);

    const codex = engine.createSession({ projectPath: project, seatId: 'codex-a', title: '  my   codex  ' }, nativeLaunch(CODEX_SEAT));
    expect(codex.nativeSessionId).toBeNull();
    expect(codex.title).toBe('my codex');
    expect(codex.usage.contextWindow).toBe(272_000);

    const local = engine.createSession({ projectPath: project, seatId: 'local:qwen3-coder' }, { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(local.usage.contextWindow).toBe(32_000);
    expect(local.accountId).toBe('local');

    expect(engine.listSessions().map((s) => s.id).sort()).toEqual([claude.id, codex.id, local.id].sort());
  });

  it('persists the launch privately (0600) and never inside the public session record', () => {
    const s = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    const sessionsDir = join(root, 'sessions');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
    const launchFile = join(sessionsDir, `${s.id}.launch.json`);
    expect(statSync(launchFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(sessionsDir, `${s.id}.json`)).mode & 0o777).toBe(0o600);
    const publicRecord = readFileSync(join(sessionsDir, `${s.id}.json`), 'utf8');
    expect(publicRecord).not.toContain(launcherPath);
    expect(publicRecord).not.toContain('launcher');
    expect(JSON.stringify(engine.getSession(s.id))).not.toContain(launcherPath);
    expect(JSON.stringify(engine.listSessions())).not.toContain(launcherPath);
  });
});

describe('sendTurn — claude via account launcher', () => {
  it('turn 1 uses --session-id, turn 2 --resume with the same id; usage and title accumulate', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max', model: 'claude-sonnet-5' }, nativeLaunch(CLAUDE_SEAT));
    const longPrompt = 'Please refactor the session store so that it never blocks the event loop while writing';
    const { turnId, session } = engine.sendTurn(created.id, longPrompt);
    expect(session.status).toBe('running');
    expect(session.title).toBe(`${longPrompt.slice(0, 60).trimEnd()}…`);

    const events = await untilTurnDone(engine, created.id);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('user-message');
    expect(types[1]).toBe('turn-started');
    expect(types).toContain('text-delta');
    expect(types).toContain('assistant-message');
    expect(types).toContain('usage');
    expect(types[types.length - 1]).toBe('turn-done');
    expect(events.every((e) => 'turnId' in e && e.turnId === turnId)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'turn-done', ok: true, nativeSessionId: created.nativeSessionId });

    const after1 = engine.getSession(created.id)!;
    expect(after1.status).toBe('idle');
    expect(after1.turnCount).toBe(1);
    expect(after1.lastError).toBeNull();
    expect(after1.usage).toEqual({ inputTokens: 10, outputTokens: 8, cacheReadTokens: 1000, cacheCreationTokens: 50, contextTokens: 1060, contextWindow: 200_000 });

    const [call1] = readCalls(side);
    expect(call1.argv).toContain('--session-id');
    expect(call1.argv[call1.argv.indexOf('--session-id') + 1]).toBe(created.nativeSessionId);
    expect(call1.argv).not.toContain('--resume');
    expect(call1.argv[call1.argv.indexOf('--model') + 1]).toBe('claude-sonnet-5');
    // The prompt is positional, after `--`, never the value of boolean `-p`.
    expect(call1.argv).toContain('-p');
    expect(call1.argv.slice(-2)).toEqual(['--', longPrompt]);
    expect(call1.cwd).toBe(project);

    const second = engine.sendTurn(created.id, 'and again');
    expect(second.session.title).toBe(after1.title);
    const events2 = await untilTurnDone(engine, created.id, after1 ? events[events.length - 1].seq : 0);
    expect(events2[events2.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
    expect(events2[0].seq).toBe(events[events.length - 1].seq + 1);

    const [, call2] = readCalls(side);
    expect(call2.argv).toContain('--resume');
    expect(call2.argv[call2.argv.indexOf('--resume') + 1]).toBe(created.nativeSessionId);
    expect(call2.argv).not.toContain('--session-id');

    const after2 = engine.getSession(created.id)!;
    expect(after2.turnCount).toBe(2);
    expect(after2.usage.inputTokens).toBe(10 + 20);
    expect(after2.usage.cacheReadTokens).toBe(1000 + 2000);
    expect(after2.usage.contextTokens).toBe(20 + 2000 + 50);
  });

  it('strips credential-shaped env and forwards only the base allowlist + adapter env', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    engine.sendTurn(created.id, 'env check');
    await untilTurnDone(engine, created.id);
    const [call] = readCalls(side);
    const deny = /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;
    expect(Object.keys(call.env).filter((k) => deny.test(k))).toEqual([]);
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
    expect(call.env.SOME_VENDOR_API_KEY).toBeUndefined();
    expect(call.env.DB_PASSWORD).toBeUndefined();
    expect(call.env.HOME).toBe(process.env.HOME);
    expect(call.env.PATH).toBe(process.env.PATH);
    // __CF_USER_TEXT_ENCODING is injected by macOS into every child, not forwarded by us.
    const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']);
    expect(Object.keys(call.env).filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('buildTurnEnv keeps the engine subscription tokens the vendor CLIs need', () => {
    const env = buildTurnEnv({ ANTHROPIC_AUTH_TOKEN: 'ollama', MY_SECRET: 'x' }, { PATH: '/bin', HOME: '/h', AWS_SECRET_ACCESS_KEY: 'k', GITHUB_PAT: 'p' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ANTHROPIC_AUTH_TOKEN: 'ollama' });
  });
});

describe('sendTurn — local via plain claude on PATH', () => {
  it('spawns `claude` with the Ollama env and no launcher', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'local:qwen3-coder' }, { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434/v1' });
    engine.sendTurn(created.id, 'local hello');
    const events = await untilTurnDone(engine, created.id);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
    const [call] = readCalls(side);
    expect(call.argv[call.argv.indexOf('--model') + 1]).toBe('qwen3-coder');
    expect(call.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(call.env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(call.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
    expect(engine.getSession(created.id)!.usage.contextWindow).toBe(32_000);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { contextWindow: 32_000 } });
  });
});

describe('sendTurn — codex', () => {
  it('captures thread_id on turn 1 and resumes it on turn 2 with the prompt on stdin', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'codex-a' }, nativeLaunch(CODEX_SEAT));
    expect(created.nativeSessionId).toBeNull();
    engine.sendTurn(created.id, 'first codex prompt');
    const events = await untilTurnDone(engine, created.id);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true, nativeSessionId: 'thr_fake_1' });
    expect(events.find((e) => e.type === 'assistant-message')).toMatchObject({ text: 'codex says: first codex prompt' });
    const after1 = engine.getSession(created.id)!;
    expect(after1.nativeSessionId).toBe('thr_fake_1');
    // codex input_tokens (300) includes cached (100): totals count each token once; context = turn total.
    expect(after1.usage).toMatchObject({ inputTokens: 200, cacheReadTokens: 100, outputTokens: 20, contextTokens: 300 });

    engine.sendTurn(created.id, 'second codex prompt');
    await untilTurnDone(engine, created.id, events[events.length - 1].seq);
    const [call1, call2] = readCalls(side);
    expect(call1.argv.slice(0, 2)).toEqual(['exec', '--json']);
    expect(call1.argv).toEqual(expect.arrayContaining(['--model', 'gpt-5.5', '--cd', project, '--sandbox', 'workspace-write', '-']));
    expect(call1.stdin).toBe('first codex prompt');
    expect(call2.argv.slice(0, 5)).toEqual(['exec', 'resume', 'thr_fake_1', '--json', '-']);
    expect(call2.stdin).toBe('second codex prompt');
    expect(engine.getSession(created.id)!.turnCount).toBe(2);
  });
});

describe('sendTurn — grok', () => {
  it('runs the wire-format dialect through the launcher', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'grok' }, nativeLaunch(GROK_SEAT));
    engine.sendTurn(created.id, 'grok hello');
    const events = await untilTurnDone(engine, created.id);
    expect(events.find((e) => e.type === 'assistant-message')).toMatchObject({ text: 'grok says: grok hello' });
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true, nativeSessionId: created.nativeSessionId });
    const [call] = readCalls(side);
    expect(call.argv).toEqual(expect.arrayContaining(['--output-format', 'streaming-messages-json', '--cwd', project, '--session-id', created.nativeSessionId]));
    expect(engine.getSession(created.id)!.usage).toMatchObject({ inputTokens: 400, outputTokens: 7, contextTokens: 400, contextWindow: 256_000 });
  });
});

describe('failures, busy, cancel, timeout', () => {
  it('rejects a second turn while one runs (409), then cancel kills the process group', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    engine.sendTurn(created.id, 'please HANG forever');
    await waitFor(() => engine.getEvents(created.id).some((e) => e.type === 'turn-started'));
    const started = engine.getEvents(created.id).find((e) => e.type === 'turn-started') as { pid: number | null };
    expect(typeof started.pid).toBe('number');
    expect(pidAlive(started.pid!)).toBe(true);

    let busy: unknown;
    try { engine.sendTurn(created.id, 'again'); } catch (err) { busy = err; }
    expect(busy).toBeInstanceOf(VerseError);
    expect(busy).toMatchObject({ code: 'VERSE_SESSION_BUSY', status: 409 });

    const donePromise = untilTurnDone(engine, created.id);
    expect(engine.cancelTurn(created.id)).toBe(true);
    const events = await donePromise;
    const types = events.map((e) => e.type);
    expect(types).toContain('cancelled');
    expect(types.indexOf('cancelled')).toBeLessThan(types.indexOf('turn-done'));
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: false });
    expect(types.filter((t) => t === 'error')).toEqual([]);
    await waitFor(() => !pidAlive(started.pid!));
    // Stop is a normal action: the session is idle, not failed.
    const after = engine.getSession(created.id)!;
    expect(after.status).toBe('idle');
    expect(after.lastError).toBeNull();
    expect(engine.cancelTurn(created.id)).toBe(false);
    // The session is usable again.
    engine.sendTurn(created.id, 'recovered');
    const next = await untilTurnDone(engine, created.id, events[events.length - 1].seq);
    expect(next[next.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
  });

  it('times out a stuck turn: error + turn-done ok:false', async () => {
    const quick = createVerseEngine({ root: join(work, 'verse-timeout'), killGraceMs: 150, turnTimeoutMs: 300 });
    try {
      const created = quick.createSession({ projectPath: project, seatId: 'grok' }, nativeLaunch(GROK_SEAT));
      quick.sendTurn(created.id, 'HANG');
      const events = await untilTurnDone(quick, created.id);
      const error = events.find((e) => e.type === 'error') as { message: string } | undefined;
      expect(error?.message).toMatch(/timed out after 300ms/);
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: false });
      expect(events.map((e) => e.type)).not.toContain('cancelled');
      expect(quick.getSession(created.id)!.status).toBe('error');
    } finally {
      quick.close();
    }
  });

  it('surfaces a vendor failure (non-zero exit) with stderr tail and marks the session error', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    engine.sendTurn(created.id, 'FAIL now');
    const events = await untilTurnDone(engine, created.id);
    const error = events.find((e) => e.type === 'error') as { message: string };
    expect(error.message).toContain('exited with code 1');
    expect(error.message).toContain('boom: simulated vendor failure');
    // The launcher path the fake printed in its stack trace is scrubbed before the event is durable.
    expect(error.message).not.toContain(launcherPath);
    expect(error.message).toContain('[launcher]');
    expect(JSON.stringify(events)).not.toContain(launcherPath);
    expect(readFileSync(join(root, 'sessions', `${created.id}.events.jsonl`), 'utf8')).not.toContain(launcherPath);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: false });
    expect(engine.getSession(created.id)!.status).toBe('error');
  });

  it('scrubs the native-profile DIRECTORY from a stderr tail, not just the launcher file', async () => {
    // A vendor CLI naming its own CODEX_HOME/CLAUDE_CONFIG_DIR tree prints the
    // profile DIRECTORY, which is not a substring of `<profile>/launcher.mjs`
    // and so used to survive redaction, reach the error event and the 0600
    // session record, and — because sanitizePublicJson only rewrites the home
    // prefix to `~` — show up on the API as `~/.ashlr/native-profiles/<x>/…`,
    // i.e. the account identity.
    const profile = join(work, '.ashlr', 'native-profiles', 'codex-personal');
    mkdirSync(profile, { mode: 0o700, recursive: true });
    const stateFile = join(profile, 'native-state', 'sessions', 'rollout-1.jsonl');
    const pinned = join(profile, 'launcher.cjs');
    writeFileSync(pinned, `#!/usr/bin/env node
'use strict';
require('node:fs').writeSync(2, 'ENOENT: no such file or directory, open ' + ${JSON.stringify(stateFile)} + '\\n');
process.exit(1);
`, { mode: 0o700 });

    const created = engine.createSession({ projectPath: project, seatId: 'codex-a' },
      { ...nativeLaunch(CODEX_SEAT), launcher: [process.execPath, pinned] });
    engine.sendTurn(created.id, 'go');
    const events = await untilTurnDone(engine, created.id);
    const error = events.find((e) => e.type === 'error') as { message: string };

    expect(error.message).toContain('exited with code 1');
    expect(error.message).not.toContain(profile);
    expect(error.message).not.toContain('native-profiles');
    expect(error.message).toContain('[launcher]');
    expect(JSON.stringify(events)).not.toContain('native-profiles');
    // The DURABLE record gets the same treatment, not only the event stream.
    expect(readFileSync(join(root, 'sessions', `${created.id}.events.jsonl`), 'utf8')).not.toContain('native-profiles');
    expect(JSON.stringify(engine.getSession(created.id))).not.toContain('native-profiles');
  });

  it('reports a missing launcher binary without hanging — and without naming it', async () => {
    const missing = join(work, 'private-launchers', 'does-not-exist');
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, { ...nativeLaunch(CLAUDE_SEAT), launcher: [missing] });
    engine.sendTurn(created.id, 'hi');
    const events = await untilTurnDone(engine, created.id);
    const error = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(error?.message).toMatch(/ENOENT \(launcher not found\)/);
    // Node's own text is `spawn <path> ENOENT`; neither the log nor the API may carry the path.
    expect(JSON.stringify(events)).not.toContain(missing);
    expect(JSON.stringify(events)).not.toContain('private-launchers');
    expect(engine.getSession(created.id)!.lastError ?? '').not.toContain(missing);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: false });
  });

  it('reconciles a session left `running` by a dead server: settles the dangling turn and accepts the next one', async () => {
    // Simulate a crash mid-turn: a `running` record whose log ends in turn-started.
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    const crashedStore = createVerseSessionStore(root);
    const record = crashedStore.get(created.id)!;
    record.status = 'running';
    crashedStore.save(record);
    crashedStore.appendEvent(created.id, { type: 'user-message', turnId: 'orphan-turn', text: 'never finished' }, new Date().toISOString());
    crashedStore.appendEvent(created.id, { type: 'turn-started', turnId: 'orphan-turn', pid: 999_999 }, new Date().toISOString());

    const restarted = createVerseEngine({ root, killGraceMs: 200 });
    try {
      const events = restarted.getEvents(created.id);
      const types = events.map((e) => e.type);
      expect(types.slice(-2)).toEqual(['error', 'turn-done']);
      expect(events[events.length - 2]).toMatchObject({ type: 'error', turnId: 'orphan-turn', message: 'turn interrupted: server restarted' });
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', turnId: 'orphan-turn', ok: false });
      const after = restarted.getSession(created.id)!;
      expect(after.status).toBe('error');
      expect(after.lastError).toBe('interrupted by server restart');
      // Not busy any more: the next turn runs.
      restarted.sendTurn(created.id, 'recovered');
      const next = await untilTurnDone(restarted, created.id, events[events.length - 1].seq);
      expect(next[next.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
      expect(restarted.getSession(created.id)!.status).toBe('idle');
    } finally {
      restarted.close();
    }
  });

  it('validates turn text: empty → 400, oversized → 413, unknown session → 404', () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    expect(() => engine.sendTurn(created.id, '   ')).toThrow(expect.objectContaining({ code: 'VERSE_INVALID', status: 400 }));
    expect(() => engine.sendTurn(created.id, 'x'.repeat(VERSE_MAX_TURN_TEXT_BYTES + 1))).toThrow(expect.objectContaining({ code: 'VERSE_TOO_LARGE', status: 413 }));
    expect(() => engine.sendTurn('nope', 'hi')).toThrow(expect.objectContaining({ code: 'VERSE_SESSION_NOT_FOUND', status: 404 }));
    expect(() => engine.getEvents('../../etc/passwd')).toThrow(VerseError);
    expect(engine.getSession('nope')).toBeNull();
    expect(engine.getEvents(created.id)).toEqual([]);
  });
});

describe('subscribe, rename, delete, persistence', () => {
  it('replays from seq then streams live, and unsubscribe stops delivery', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    engine.sendTurn(created.id, 'one');
    const first = await untilTurnDone(engine, created.id);
    const lastSeq = first[first.length - 1].seq;

    const replayed: VerseEvent[] = [];
    const off = engine.subscribe(created.id, 2, (e) => replayed.push(e));
    expect(replayed.map((e) => e.seq)).toEqual(first.filter((e) => e.seq > 2).map((e) => e.seq));

    engine.sendTurn(created.id, 'two');
    await untilTurnDone(engine, created.id, lastSeq);
    const liveSeqs = replayed.filter((e) => e.seq > lastSeq).map((e) => e.seq);
    expect(liveSeqs.length).toBeGreaterThan(0);
    expect(liveSeqs).toEqual([...liveSeqs].sort((a, b) => a - b));
    expect(replayed.map((e) => e.seq)).toEqual([...new Set(replayed.map((e) => e.seq))]);

    off();
    const countAfterOff = replayed.length;
    engine.sendTurn(created.id, 'three');
    await untilTurnDone(engine, created.id, replayed[replayed.length - 1].seq);
    expect(replayed.length).toBe(countAfterOff);
  });

  it('renames, deletes (removing all files, including the private launch), and reloads from disk', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    expect(engine.renameSession(created.id, '  Renamed  chat ').title).toBe('Renamed chat');
    expect(() => engine.renameSession(created.id, '   ')).toThrow(expect.objectContaining({ code: 'VERSE_INVALID' }));
    engine.sendTurn(created.id, 'persist me');
    await untilTurnDone(engine, created.id);

    const reopened = createVerseEngine({ root });
    try {
      const again = reopened.getSession(created.id)!;
      expect(again.title).toBe('Renamed chat');
      expect(again.turnCount).toBe(1);
      expect(reopened.getEvents(created.id).length).toBeGreaterThan(3);
      expect(reopened.listSessions().map((s) => s.id)).toContain(created.id);
      // A resumed engine can run the next turn from the private launch record.
      reopened.sendTurn(created.id, 'after restart');
      const events = await untilTurnDone(reopened, created.id, reopened.getEvents(created.id).at(-1)!.seq);
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
      const [, call2] = readCalls(side);
      expect(call2.argv).toContain('--resume');
    } finally {
      reopened.close();
    }

    const sessionsDir = join(root, 'sessions');
    engine.deleteSession(created.id);
    expect(engine.getSession(created.id)).toBeNull();
    expect(existsSync(join(sessionsDir, `${created.id}.json`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${created.id}.events.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${created.id}.launch.json`))).toBe(false);
    expect(() => engine.deleteSession(created.id)).toThrow(expect.objectContaining({ code: 'VERSE_SESSION_NOT_FOUND' }));
  });

  it('store: ignores corrupt records, garbage event lines, and refuses a world-readable launch file', () => {
    const store = createVerseSessionStore(join(work, 'store-only'));
    const sessionsDir = store.sessionsDir;
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(sessionsDir, 'corrupt.json'), '{not json', { mode: 0o600 });
    writeFileSync(join(sessionsDir, 'bad-shape.json'), JSON.stringify({ id: 'bad-shape', title: 1 }), { mode: 0o600 });
    expect(store.list()).toEqual([]);
    expect(store.get('corrupt')).toBeNull();

    const ev = store.appendEvent('abc', { type: 'user-message', turnId: 't', text: 'hi' }, '2026-09-19T00:00:00.000Z');
    expect(ev.seq).toBe(1);
    writeFileSync(join(sessionsDir, 'abc.events.jsonl'), `${readFileSync(join(sessionsDir, 'abc.events.jsonl'), 'utf8')}garbage line\n{"seq":"x"}\n`);
    expect(store.appendEvent('abc', { type: 'cancelled', turnId: 't' }, '2026-09-19T00:00:01.000Z').seq).toBe(2);
    expect(store.readEvents('abc').map((e) => e.seq)).toEqual([1, 2]);
    expect(store.readEvents('abc', 1).map((e) => e.seq)).toEqual([2]);
    expect(store.readEvents('../escape')).toEqual([]);
    expect(() => store.appendEvent('../escape', { type: 'cancelled', turnId: 't' }, 'now')).toThrow(/invalid verse session id/);

    store.saveLaunch('abc', { secret: 'no' });
    expect(store.loadLaunch('abc')).toEqual({ secret: 'no' });
    chmodSync(join(sessionsDir, 'abc.launch.json'), 0o644);
    expect(store.loadLaunch('abc')).toBeNull();
  });
});
