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

import { adapterFor, type VerseAdapter, type VerseAdapterTurnContext, type VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { createVerseEngine, VerseError, buildTurnEnv, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { createVerseSessionStore } from '../src/core/verse/session-store.js';
import { VERSE_MAX_TURN_TEXT_BYTES, type VerseEngine, type VerseEvent, type VerseModelOption, type VerseSeat, type VerseUsage } from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Fake CLI
// ---------------------------------------------------------------------------

/**
 * One script impersonates all three vendors, picking the dialect from argv:
 *   - argv[0] === 'exec'                                  → codex JSONL (prompt from stdin)
 *   - '--output-format streaming-messages-json' present   → grok / Anthropic wire NDJSON
 *   - otherwise                                           → claude stream-json
 * Prompt directives: HANG (ignore SIGINT, never exit), FAIL (exit 1 + stderr),
 * SLOW (claude dialect: wait 600ms after init before answering, so a
 * telemetry poll can observe a live turn), and a prompt of exactly `/compact`
 * (claude dialect: a headless manual compaction, no model call).
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
  if (prompt.includes('SLOW')) return setTimeout(answer, 600);
  if (prompt.trim() === '/compact') return compact(sid);
  answer();
}

// A headless manual /compact, shaped like the real 2.1.280 capture in
// test/verse-adapters.test.ts: a compact_boundary, then a result whose usage is
// all zeros (no model call) while modelUsage still names the window.
function compact(sid) {
  out({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual', pre_tokens: 1060, post_tokens: 420, duration_ms: 156052 } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 0, result: '', local_command: 'compact',
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    modelUsage: { [flag('--model')]: { inputTokens: 16316, outputTokens: 1551, cacheReadInputTokens: 14986, contextWindow: 1000000 } } });
  process.exit(0);
}

function answer() {
  const argv = process.argv.slice(2);
  const dashdash = argv.indexOf('--');
  const prompt = dashdash !== -1 ? argv.slice(dashdash + 1).join(' ') : '';
  const sid = flag('--session-id') || flag('--resume') || 'unknown';
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
    // The fixture's option predates 3.9 (flat window, no budgets), so the
    // verified per-model table supplies Opus 5's standard budget: a 1M window
    // compacting at 400k - 20k reserve - 13k buffer.
    expect(claude.usage).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 367_000, contextWindowSource: 'cli-catalog' });
    expect(claude.contextMode).toBeUndefined();

    const codex = engine.createSession({ projectPath: project, seatId: 'codex-a', title: '  my   codex  ' }, nativeLaunch(CODEX_SEAT));
    expect(codex.nativeSessionId).toBeNull();
    expect(codex.title).toBe('my codex');
    // No window anywhere → codex's own figure for a 272k model: 95% effective, compacts at 90% of raw.
    expect(codex.usage).toMatchObject({ contextWindow: 258_400, autoCompactAt: 244_800, contextWindowSource: 'fallback' });

    const local = engine.createSession({ projectPath: project, seatId: 'local:qwen3-coder' }, { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    // A stated window with no stated compaction point: the point stays unknown, never invented.
    expect(local.usage).toMatchObject({ contextWindow: 32_000, autoCompactAt: null, contextWindowSource: 'fallback' });
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
    expect(after1.usage).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheReadTokens: 1000,
      cacheCreationTokens: 50,
      contextTokens: 1060,
      contextWindow: 1_000_000,
      contextWindowSource: 'cli-catalog',
      autoCompactAt: 367_000,
    });

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

  it('dispatches to the launch record\u2019s Anthropic address when the llama-server lane is on', async () => {
    // The llama-server lane. The address is PINNED into the launch record at
    // creation time and read back off disk by sendTurn, so this also proves
    // the record survives the round trip that `isSeatLaunch` validates.
    const created = engine.createSession(
      { projectPath: project, seatId: 'local:qwen3-coder' },
      { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434', anthropicBaseUrl: 'http://127.0.0.1:8081/v1' },
    );
    const record = JSON.parse(readFileSync(join(root, 'sessions', `${created.id}.launch.json`), 'utf8')) as Record<string, unknown>;
    expect(record['anthropicBaseUrl']).toBe('http://127.0.0.1:8081/v1');
    expect(record['ollamaBaseUrl']).toBe('http://127.0.0.1:11434');

    engine.sendTurn(created.id, 'local hello');
    const events = await untilTurnDone(engine, created.id);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
    const [call] = readCalls(side);
    // The proxy ORIGIN: Claude Code appends `/v1/messages` itself.
    expect(call.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8081');
    // Ollama must not be dispatched to on this lane, in any spelling.
    expect(Object.values(call.env)).not.toContain('http://127.0.0.1:11434');
  });

  it('keeps dispatching to Ollama for a launch record written before lanes existed', () => {
    // No `anthropicBaseUrl` key at all — every record already on disk. The
    // validator must accept it and the adapter must fall back to Ollama.
    const created = engine.createSession(
      { projectPath: project, seatId: 'local:qwen3-coder' },
      { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' },
    );
    const record = JSON.parse(readFileSync(join(root, 'sessions', `${created.id}.launch.json`), 'utf8')) as Record<string, unknown>;
    expect('anthropicBaseUrl' in record).toBe(false);
    expect(() => engine.sendTurn(created.id, 'local hello')).not.toThrow();
    engine.cancelTurn(created.id);
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
    expect(engine.getSession(created.id)!.usage).toMatchObject({ inputTokens: 400, outputTokens: 7, contextTokens: 400, contextWindow: 500_000, autoCompactAt: 400_000 });
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

// ---------------------------------------------------------------------------
// V3.9 — context budgets, modes, readings, telemetry hooks
// ---------------------------------------------------------------------------

const NEEDS_280 = 'needs Claude Code 2.1.280; this seat runs 2.1.257';

/** Catalog-shaped options (what seats.ts builds from model-windows.ts in 3.9). */
const OPUS_55: VerseModelOption = {
  id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, autoCompactAt: 367_000,
  expansive: { contextWindow: 1_000_000, autoCompactAt: 967_000 }, maxOutputTokens: 128_000,
  windowSource: 'cli-catalog', minCliVersion: '2.1.280', unavailableReason: null,
};
const OPUS_5: VerseModelOption = {
  id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 1_000_000, autoCompactAt: 367_000,
  expansive: { contextWindow: 1_000_000, autoCompactAt: 967_000 }, maxOutputTokens: 64_000,
  windowSource: 'cli-catalog', minCliVersion: null, unavailableReason: null,
};
const HAIKU: VerseModelOption = {
  id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200_000, autoCompactAt: 167_000,
  maxOutputTokens: 32_000, windowSource: 'cli-catalog', minCliVersion: null, unavailableReason: null,
};
const GPT6: VerseModelOption = {
  id: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 258_400, autoCompactAt: 244_800,
  expansive: { contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 },
  windowSource: 'provider-catalog', minCliVersion: null, unavailableReason: null,
};

function catalogSeat(engine: VerseSeat['engine'], id: string, models: VerseModelOption[]): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: engine === 'local' ? 'local' : id,
    models,
    contextWindow: models[0]?.contextWindow ?? null,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };
}

/**
 * Wrap a real adapter: its argv and parsing stay real, `map` rewrites what the
 * parser emits (a runtime window, a compaction), and hooks can be attached.
 *
 * The base adapter's own hooks ARE inherited (and pass through `map`) unless
 * a test supplies its own. They have to be: codex emits its turn `usage` from
 * `afterTurn`, not the parser (`exec resume` prints a thread-cumulative total
 * that only the rollout can turn into a per-turn delta), so a codex wrapper
 * that dropped the hook would drop the turn's usage entirely. A hook given in
 * `opts` replaces the base one, which is how the hook tests pin the ENGINE's
 * behaviour rather than a vendor adapter's.
 */
function patched(
  base: VerseAdapter,
  opts: {
    map?: (event: VerseParsedEvent) => VerseParsedEvent[];
    finishExtra?: (turnId: string) => VerseParsedEvent[];
    pollTelemetry?: VerseAdapter['pollTelemetry'];
    afterTurn?: VerseAdapter['afterTurn'];
    onFinish?: () => void;
  },
): VerseAdapter {
  const map = opts.map ?? ((event: VerseParsedEvent) => [event]);
  return {
    buildLaunch: (session, text, launch) => base.buildLaunch(session, text, launch),
    createParser(turnId) {
      const parser = base.createParser(turnId);
      return {
        push: (line) => parser.push(line).flatMap(map),
        finish: (code) => {
          const out = [...parser.finish(code).flatMap(map), ...(opts.finishExtra?.(turnId) ?? [])];
          opts.onFinish?.();
          return out;
        },
        nativeSessionId: () => parser.nativeSessionId(),
      };
    },
    ...(opts.pollTelemetry ? { pollTelemetry: opts.pollTelemetry } : base.pollTelemetry ? { pollTelemetry: (ctx: VerseAdapterTurnContext) => base.pollTelemetry!(ctx).flatMap(map) } : {}),
    ...(opts.afterTurn ? { afterTurn: opts.afterTurn } : base.afterTurn ? { afterTurn: (ctx: VerseAdapterTurnContext) => base.afterTurn!(ctx).flatMap(map) } : {}),
  };
}

function withAdapters(patches: Partial<Record<VerseEngine, VerseAdapter>>): (engine: VerseEngine) => VerseAdapter {
  return (e) => patches[e] ?? adapterFor(e);
}

/** Rewrite every usage event's reported window / occupancy / exactness. */
function reportUsage(patch: { contextWindow?: number | null; contextTokens?: number; contextTokensExact?: boolean }) {
  return (event: VerseParsedEvent): VerseParsedEvent[] =>
    event.type === 'usage' ? [{ ...event, usage: { ...event.usage, ...patch } }] : [event];
}

describe('V3.9 createSession — budgets, modes, availability, provenance', () => {
  it('rejects unavailable models (with the reason) and never picks one as the default', () => {
    const pinned = catalogSeat('claude', 'claude-a', [{ ...OPUS_55, unavailableReason: NEEDS_280 }, OPUS_5, HAIKU]);
    const launch = nativeLaunch(pinned);

    const byDefault = engine.createSession({ projectPath: project, seatId: 'claude-a' }, launch);
    expect(byDefault.model).toBe('claude-opus-5');

    for (const model of ['claude-opus-5-5', 'claude-opus-5.5']) {
      let err: unknown;
      try { engine.createSession({ projectPath: project, seatId: 'claude-a', model }, launch); } catch (e) { err = e; }
      expect(err).toMatchObject({ code: 'VERSE_INVALID', status: 400 });
      expect((err as Error).message).toContain(NEEDS_280);
    }

    const allBlocked = catalogSeat('claude', 'claude-b', [{ ...OPUS_55, unavailableReason: NEEDS_280 }]);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-b' }, nativeLaunch(allBlocked)))
      .toThrow(/no runnable models/);
  });

  it('accepts the retired dotted alias and records the id the seat lists', () => {
    const current = catalogSeat('claude', 'claude-new', [OPUS_55, OPUS_5]);
    const created = engine.createSession({ projectPath: project, seatId: 'claude-new', model: 'claude-opus-5.5' }, nativeLaunch(current));
    expect(created.model).toBe('claude-opus-5-5');
    expect(created.usage).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 367_000, contextWindowSource: 'cli-catalog' });
  });

  it('validates contextMode: unknown modes and modes a model lacks are refused; expansive records its budget', () => {
    const seatA = catalogSeat('claude', 'claude-a', [OPUS_5, HAIKU]);
    const launch = nativeLaunch(seatA);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-a', contextMode: 'huge' as never }, launch))
      .toThrow(expect.objectContaining({ code: 'VERSE_INVALID' }));
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-a', model: HAIKU.id, contextMode: 'expansive' }, launch))
      .toThrow(/no expansive context mode/);

    const expansive = engine.createSession({ projectPath: project, seatId: 'claude-a', contextMode: 'expansive' }, launch);
    expect(expansive.contextMode).toBe('expansive');
    expect(expansive.usage).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 967_000, contextWindowSource: 'cli-catalog' });

    const standard = engine.createSession({ projectPath: project, seatId: 'claude-a', contextMode: 'standard' }, launch);
    expect(standard.contextMode).toBe('standard');
    expect(standard.usage.autoCompactAt).toBe(367_000);

    // A standard mode always exists, even when nothing is known about the model.
    const unknown = engine.createSession({ projectPath: project, seatId: 'claude-max', model: 'claude-sonnet-5', contextMode: 'standard' }, nativeLaunch(CLAUDE_SEAT));
    expect(unknown.contextMode).toBe('standard');

    // Codex: expansive is the catalog maximum.
    const codexSeat = catalogSeat('codex', 'codex-b', [GPT6]);
    const codex = engine.createSession({ projectPath: project, seatId: 'codex-b', contextMode: 'expansive' }, nativeLaunch(codexSeat));
    expect(codex.usage).toMatchObject({ contextWindow: 828_400, autoCompactAt: 784_800, contextWindowSource: 'provider-catalog' });
  });

  it('an unknown claude id falls back to the CLI default window, marked as a fallback', () => {
    const odd = seat('claude', 'claude-odd', ['claude-mystery-9']);
    const created = engine.createSession({ projectPath: project, seatId: 'claude-odd' }, nativeLaunch(odd));
    expect(created.usage).toMatchObject({ contextWindow: 200_000, autoCompactAt: 167_000, contextWindowSource: 'fallback' });
  });

  it('a pre-3.9 caller gets no new session keys and no memory in the launch record', () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
    const record = JSON.parse(readFileSync(join(root, 'sessions', `${created.id}.json`), 'utf8')) as Record<string, unknown>;
    for (const key of ['contextMode', 'compactionCount', 'handoffFrom', 'memoryEnabled']) expect(key in record).toBe(false);
    const launch = JSON.parse(readFileSync(join(root, 'sessions', `${created.id}.launch.json`), 'utf8')) as Record<string, unknown>;
    expect('memory' in launch).toBe(false);
  });

  it('pins the memory snapshot privately, records the decision, and rejects a malformed one', async () => {
    const memory = { dir: join(work, 'memory', 'project-abc123'), block: '## Shared project memory\nRead MEMORY.md first.', writable: true };
    const on = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT), { memory });
    expect(on.memoryEnabled).toBe(true);
    const launchFile = join(root, 'sessions', `${on.id}.launch.json`);
    expect(statSync(launchFile).mode & 0o777).toBe(0o600);
    expect((JSON.parse(readFileSync(launchFile, 'utf8')) as { memory: unknown }).memory).toEqual(memory);
    // The public record carries only the boolean, never the directory or the block.
    const publicRecord = readFileSync(join(root, 'sessions', `${on.id}.json`), 'utf8');
    expect(publicRecord).not.toContain(memory.dir);
    expect(publicRecord).not.toContain('Read MEMORY.md first');

    // The snapshot survives the round trip that sendTurn validates.
    engine.sendTurn(on.id, 'with memory');
    const events = await untilTurnDone(engine, on.id);
    expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });

    const off = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT), { memory: null });
    expect(off.memoryEnabled).toBe(false);
    expect('memory' in (JSON.parse(readFileSync(join(root, 'sessions', `${off.id}.launch.json`), 'utf8')) as object)).toBe(false);

    for (const bad of [
      { ...memory, dir: 'relative/memory' },
      { ...memory, writable: 'yes' },
      { ...memory, block: 'x'.repeat(17 * 1024) },
      { dir: memory.dir },
    ]) {
      expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT), { memory: bad as never }))
        .toThrow(/memory snapshot is malformed/);
    }
  });

  it('a launch record whose memory was corrupted on disk is refused, not half-used', () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT),
      { memory: { dir: join(work, 'mem'), block: 'b', writable: false } });
    const store = createVerseSessionStore(root);
    const launch = store.loadLaunch(created.id) as Record<string, unknown>;
    store.saveLaunch(created.id, { ...launch, memory: { dir: 'relative', block: 'b', writable: false } });
    expect(() => engine.sendTurn(created.id, 'hi')).toThrow(/launch record is missing or unreadable/);
  });

  it('resolves handoff provenance from the source RECORD, never from the caller’s title', () => {
    const source = engine.createSession({ projectPath: project, seatId: 'claude-max', title: 'Source chat' }, nativeLaunch(CLAUDE_SEAT));
    const viaOpts = engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT),
      { handoffFrom: { sessionId: source.id, title: 'spoofed title' } });
    expect(viaOpts.handoffFrom).toEqual({ sessionId: source.id, title: 'Source chat' });

    const viaReq = engine.createSession({ projectPath: project, seatId: 'claude-max', handoffFromSessionId: source.id }, nativeLaunch(CLAUDE_SEAT));
    expect(viaReq.handoffFrom).toEqual({ sessionId: source.id, title: 'Source chat' });

    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max', handoffFromSessionId: 'missing-session' }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(/handoff source session not found/);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max', handoffFromSessionId: viaReq.id }, nativeLaunch(CLAUDE_SEAT),
      { handoffFrom: { sessionId: source.id, title: 'x' } })).toThrow(/does not match/);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT),
      { handoffFrom: { sessionId: 7 } as never })).toThrow(/handoff source is malformed/);
    expect(() => engine.createSession({ projectPath: project, seatId: 'claude-max', handoffFromSessionId: 7 as never }, nativeLaunch(CLAUDE_SEAT)))
      .toThrow(/must be a string/);

    // Deep copy: mutating a returned session never reaches the stored record.
    const copy = engine.getSession(viaOpts.id)!;
    copy.handoffFrom!.title = 'mutated';
    expect(engine.getSession(viaOpts.id)!.handoffFrom!.title).toBe('Source chat');
  });
});

describe('V3.9 setContextMode', () => {
  it('switches the budget, emits one context event, and is a no-op for the current mode', () => {
    const seatA = catalogSeat('claude', 'claude-a', [OPUS_5, HAIKU]);
    const created = engine.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(seatA));
    expect(created.usage.autoCompactAt).toBe(367_000);

    const expansive = engine.setContextMode(created.id, 'expansive');
    expect(expansive.contextMode).toBe('expansive');
    expect(expansive.usage).toMatchObject({ contextWindow: 1_000_000, autoCompactAt: 967_000 });
    const events = engine.getEvents(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'context', turnId: null, contextTokens: 0, contextWindow: 1_000_000, exact: true, autoCompactAt: 967_000 });

    expect(engine.setContextMode(created.id, 'expansive').contextMode).toBe('expansive');
    expect(engine.getEvents(created.id)).toHaveLength(1);

    expect(engine.setContextMode(created.id, 'standard').usage.autoCompactAt).toBe(367_000);
    // Persisted, not just returned.
    expect(createVerseEngine({ root }).getSession(created.id)!.contextMode).toBe('standard');
  });

  it('refuses unknown modes, modes the model lacks, unknown sessions, and a running turn', async () => {
    const seatA = catalogSeat('claude', 'claude-a', [OPUS_5, HAIKU]);
    const haiku = engine.createSession({ projectPath: project, seatId: 'claude-a', model: HAIKU.id }, nativeLaunch(seatA));
    expect(() => engine.setContextMode(haiku.id, 'expansive')).toThrow(/no expansive context mode/);
    expect(() => engine.setContextMode(haiku.id, 'turbo' as never)).toThrow(expect.objectContaining({ code: 'VERSE_INVALID' }));
    expect(() => engine.setContextMode('nope', 'standard')).toThrow(expect.objectContaining({ code: 'VERSE_SESSION_NOT_FOUND' }));

    const busy = engine.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(seatA));
    engine.sendTurn(busy.id, 'HANG here');
    await waitFor(() => engine.getEvents(busy.id).some((e) => e.type === 'turn-started'));
    expect(() => engine.setContextMode(busy.id, 'expansive')).toThrow(expect.objectContaining({ code: 'VERSE_SESSION_BUSY', status: 409 }));
    const done = untilTurnDone(engine, busy.id);
    engine.cancelTurn(busy.id);
    await done;
    expect(engine.setContextMode(busy.id, 'expansive').contextMode).toBe('expansive');
  });

  it('claude keeps a measured runtime window across a switch; codex shows the new mode’s budget', async () => {
    const custom = createVerseEngine({
      root: join(work, 'verse-modes'),
      killGraceMs: 200,
      adapterFor: withAdapters({
        claude: patched(adapterFor('claude'), { map: reportUsage({ contextWindow: 1_000_000 }) }),
        codex: patched(adapterFor('codex'), { map: reportUsage({ contextWindow: 258_400 }) }),
      }),
    });
    try {
      const claude = custom.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
      custom.sendTurn(claude.id, 'measure me');
      await untilTurnDone(custom, claude.id);
      expect(custom.getSession(claude.id)!.usage).toMatchObject({ contextWindow: 1_000_000, contextWindowSource: 'runtime', autoCompactAt: 367_000 });
      expect(custom.setContextMode(claude.id, 'expansive').usage)
        .toMatchObject({ contextWindow: 1_000_000, contextWindowSource: 'runtime', autoCompactAt: 967_000 });

      const codex = custom.createSession({ projectPath: project, seatId: 'codex-b' }, nativeLaunch(catalogSeat('codex', 'codex-b', [GPT6])));
      custom.sendTurn(codex.id, 'measure me');
      await untilTurnDone(custom, codex.id);
      expect(custom.getSession(codex.id)!.usage).toMatchObject({ contextWindow: 258_400, contextWindowSource: 'runtime', autoCompactAt: 244_800 });
      expect(custom.setContextMode(codex.id, 'expansive').usage)
        .toMatchObject({ contextWindow: 828_400, contextWindowSource: 'provider-catalog', autoCompactAt: 784_800 });
    } finally {
      custom.close();
    }
  });
});

describe('V3.9 readings — runtime windows, unclamped occupancy, context and compaction events', () => {
  it('a runtime window wins over the catalog, moves the compaction point, and occupancy is stored unclamped', async () => {
    const custom = createVerseEngine({
      root: join(work, 'verse-runtime'),
      killGraceMs: 200,
      adapterFor: withAdapters({
        // Claude Code clamped this 1M model to 200k (long-context credit ran out)
        // and the prompt is already past it.
        claude: patched(adapterFor('claude'), { map: reportUsage({ contextWindow: 200_000, contextTokens: 250_000 }) }),
      }),
    });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
      custom.sendTurn(created.id, 'big');
      const events = await untilTurnDone(custom, created.id);
      const after = custom.getSession(created.id)!;
      // 200k window, compacting at min(200k, --autocompact 400k) - 20k - 13k.
      expect(after.usage).toMatchObject({ contextTokens: 250_000, contextWindow: 200_000, contextWindowSource: 'runtime', autoCompactAt: 167_000 });
      expect(after.usage.contextTokensExact).toBeUndefined();
      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toMatchObject({ usage: { contextTokens: 250_000, contextWindow: 200_000, contextWindowSource: 'runtime', autoCompactAt: 167_000 } });
    } finally {
      custom.close();
    }
  });

  it('local seats ignore a runtime window: Verse told that CLI its window', async () => {
    const custom = createVerseEngine({
      root: join(work, 'verse-local'),
      killGraceMs: 200,
      adapterFor: withAdapters({ local: patched(adapterFor('local'), { map: reportUsage({ contextWindow: 200_000 }) }) }),
    });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'local:qwen3-coder' }, { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' });
      custom.sendTurn(created.id, 'local');
      const events = await untilTurnDone(custom, created.id);
      expect(custom.getSession(created.id)!.usage).toMatchObject({ contextWindow: 32_000, contextWindowSource: 'fallback' });
      expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { contextWindow: 32_000 } });
    } finally {
      custom.close();
    }
  });

  it('an upper-bound reading is flagged inexact until an exact context reading replaces it', async () => {
    const custom = createVerseEngine({
      root: join(work, 'verse-exact'),
      killGraceMs: 200,
      adapterFor: withAdapters({
        codex: patched(adapterFor('codex'), {
          // The codex usage comes from its afterTurn (no rollout here, so the
          // printed upper-bound figure); an exact rollout reading follows it.
          afterTurn: (ctx) => [
            ...adapterFor('codex').afterTurn!(ctx).flatMap(reportUsage({ contextTokensExact: false })),
            { type: 'context', turnId: ctx.turnId, contextTokens: 136_000, contextWindow: 258_400, exact: true },
          ],
        }),
      }),
    });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'codex-b' }, nativeLaunch(catalogSeat('codex', 'codex-b', [GPT6])));
      custom.sendTurn(created.id, 'go');
      const events = await untilTurnDone(custom, created.id);
      const usage = events.find((e) => e.type === 'usage');
      // The frame carries what the engine resolved, so the client can draw
      // "≤" against the right budget without refetching the session.
      expect(usage).toMatchObject({ usage: { contextTokens: 300, contextTokensExact: false, contextWindowSource: 'provider-catalog', autoCompactAt: 244_800 } });
      const context = events.find((e) => e.type === 'context');
      expect(context).toMatchObject({ contextTokens: 136_000, contextWindow: 258_400, exact: true, autoCompactAt: 244_800 });
      const after = custom.getSession(created.id)!;
      expect(after.usage.contextTokens).toBe(136_000);
      expect('contextTokensExact' in after.usage).toBe(false);
      expect(after.usage.contextWindowSource).toBe('runtime');
    } finally {
      custom.close();
    }
  });

  it('context and compaction events update the session, are normalised, and survive a restart', async () => {
    const custom = createVerseEngine({
      root: join(work, 'verse-compact'),
      killGraceMs: 200,
      adapterFor: withAdapters({
        claude: patched(adapterFor('claude'), {
          finishExtra: (turnId) => [
            { type: 'compaction', turnId, trigger: 'auto', preTokens: 967_391, postTokens: 41_000, durationMs: 118_000 },
            { type: 'compaction', turnId, trigger: 'sideways' as never, preTokens: 'many' as never, postTokens: -4, durationMs: null },
            { type: 'context', turnId, contextTokens: 42_000, contextWindow: null, exact: true },
            { type: 'context', turnId, contextTokens: Number.NaN, contextWindow: null, exact: true },
          ],
        }),
      }),
    });
    const customRoot = join(work, 'verse-compact');
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
      custom.sendTurn(created.id, 'compact');
      const events = await untilTurnDone(custom, created.id);
      const compactions = events.filter((e) => e.type === 'compaction');
      expect(compactions).toHaveLength(2);
      expect(compactions[0]).toMatchObject({ trigger: 'auto', preTokens: 967_391, postTokens: 41_000, durationMs: 118_000 });
      expect(compactions[1]).toMatchObject({ trigger: 'auto', preTokens: null, postTokens: null, durationMs: null });
      const contexts = events.filter((e) => e.type === 'context');
      // The NaN reading is dropped, never logged.
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ contextTokens: 42_000, contextWindow: 1_000_000, exact: true, autoCompactAt: 367_000 });
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });

      const after = custom.getSession(created.id)!;
      expect(after.compactionCount).toBe(2);
      expect(after.usage.contextTokens).toBe(42_000);

      const reopened = createVerseEngine({ root: customRoot });
      try {
        expect(reopened.getSession(created.id)!.compactionCount).toBe(2);
        const replayed = reopened.getEvents(created.id);
        expect(replayed.filter((e) => e.type === 'compaction')).toHaveLength(2);
        expect(replayed.filter((e) => e.type === 'context')).toHaveLength(1);
        expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i + 1));
      } finally {
        reopened.close();
      }
    } finally {
      custom.close();
    }
  });

  it('a manual /compact turn (all-zero counts) replaces occupancy with the post-compaction size', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
    engine.sendTurn(created.id, 'hello');
    await untilTurnDone(engine, created.id);
    const totals = { inputTokens: 10, outputTokens: 8, cacheReadTokens: 1000, cacheCreationTokens: 50 };
    expect(engine.getSession(created.id)!.usage).toMatchObject({ ...totals, contextTokens: 1060 });

    const fromSeq = engine.getEvents(created.id).at(-1)!.seq;
    engine.sendTurn(created.id, '/compact');
    const events = await untilTurnDone(engine, created.id, fromSeq);
    const types = events.map((e) => e.type);
    expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('usage'));
    expect(events.find((e) => e.type === 'compaction')).toMatchObject({ trigger: 'manual', preTokens: 1060, postTokens: 420, durationMs: 156052 });
    // Zero counts are still a reading: the frame's occupancy is the CLI's
    // post-compaction figure, and it carries the window/budget in force.
    const usage = events.find((e) => e.type === 'usage') as Extract<VerseEvent, { type: 'usage' }>;
    expect(usage.usage).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextTokens: 420, contextWindow: 1_000_000, contextWindowSource: 'runtime', autoCompactAt: 367_000,
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn-done', ok: true });

    const after = engine.getSession(created.id)!;
    // Totals untouched (the CLI reported no spend for the turn); occupancy REPLACED, not kept at 1060.
    expect(after.usage).toMatchObject({ ...totals, contextTokens: 420, contextWindowSource: 'runtime' });
    expect('contextTokensExact' in after.usage).toBe(false);
    expect(after).toMatchObject({ compactionCount: 1, turnCount: 2, status: 'idle' });
  });

  it('usage frames carry the resolved window source and compaction point; an old record’s frames stay pre-3.9 shaped', async () => {
    const created = engine.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
    engine.sendTurn(created.id, 'hello');
    const events = await untilTurnDone(engine, created.id);
    const usage = events.find((e) => e.type === 'usage') as Extract<VerseEvent, { type: 'usage' }>;
    // No runtime window on this turn: the creation-time budget is what the frame carries.
    expect(usage.usage).toMatchObject({ contextWindow: 1_000_000, contextWindowSource: 'cli-catalog', autoCompactAt: 367_000 });
    // Exact is spelled by absence, on the frame as on the record.
    expect('contextTokensExact' in usage.usage).toBe(false);

    // A record written before 3.9 has none of the fields; its frames must not invent them.
    const recordPath = join(root, 'sessions', `${created.id}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { usage: Record<string, unknown> };
    delete record.usage['contextWindowSource'];
    delete record.usage['autoCompactAt'];
    writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
    engine.close();
    engine = createVerseEngine({ root, killGraceMs: 200 });
    const fromSeq = engine.getEvents(created.id).at(-1)!.seq;
    engine.sendTurn(created.id, 'again');
    const later = await untilTurnDone(engine, created.id, fromSeq);
    const oldUsage = later.find((e) => e.type === 'usage') as Extract<VerseEvent, { type: 'usage' }>;
    for (const key of ['contextWindowSource', 'autoCompactAt', 'contextTokensExact']) expect(key in oldUsage.usage).toBe(false);
    expect(oldUsage.usage.contextTokens).toBe(2070);
  });

  it('a usage frame with NO occupancy reading keeps the previous one (zero would be an invented reading)', async () => {
    let dropReading = false;
    const custom = createVerseEngine({
      root: join(work, 'verse-no-reading'),
      killGraceMs: 200,
      adapterFor: withAdapters({
        claude: patched(adapterFor('claude'), {
          map: (event) => {
            if (event.type !== 'usage' || !dropReading) return [event];
            const usage: Partial<VerseUsage> = { ...event.usage, contextTokensExact: false };
            delete usage.contextTokens;
            return [{ ...event, usage: usage as VerseUsage }];
          },
        }),
      }),
    });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-a' }, nativeLaunch(catalogSeat('claude', 'claude-a', [OPUS_5])));
      custom.sendTurn(created.id, 'one');
      await untilTurnDone(custom, created.id);
      expect(custom.getSession(created.id)!.usage.contextTokens).toBe(1060);

      dropReading = true;
      const fromSeq = custom.getEvents(created.id).at(-1)!.seq;
      custom.sendTurn(created.id, 'two');
      const events = await untilTurnDone(custom, created.id, fromSeq);
      const after = custom.getSession(created.id)!;
      expect(after.usage.contextTokens).toBe(1060);
      // Exactness describes a reading; none arrived, so the previous (exact) one stands.
      expect('contextTokensExact' in after.usage).toBe(false);
      // Counters are still summed (turn 2 of the fake reports 20 input).
      expect(after.usage.inputTokens).toBe(30);
      expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 20, contextTokens: 1060 } });
    } finally {
      custom.close();
    }
  });
});

describe('V3.9 telemetry hooks', () => {
  it('polls while the turn runs, keeps hook state, calls afterTurn once after the parser flushed, and stops polling', async () => {
    const polls: Array<{ turnId: string; native: string | null; n: unknown; seatId: string; startedAt: number }> = [];
    const order: string[] = [];
    let afterCalls = 0;
    const adapter = patched(adapterFor('claude'), {
      onFinish: () => order.push('finish'),
      pollTelemetry: (ctx: VerseAdapterTurnContext) => {
        ctx.state['n'] = ((ctx.state['n'] as number | undefined) ?? 0) + 1;
        polls.push({ turnId: ctx.turnId, native: ctx.nativeSessionId, n: ctx.state['n'], seatId: ctx.launch.seat.id, startedAt: ctx.startedAt });
        return ctx.state['n'] === 1
          ? [
            { type: 'context', turnId: ctx.turnId, contextTokens: 5_000, contextWindow: null, exact: true },
            // Not telemetry: must never reach the log or fail the turn.
            { type: 'error', turnId: ctx.turnId, message: 'hook says no' },
            { type: 'turn-done', turnId: ctx.turnId, ok: false, nativeSessionId: null, durationMs: 0 },
          ]
          : [];
      },
      afterTurn: (ctx: VerseAdapterTurnContext) => {
        afterCalls += 1;
        order.push('afterTurn');
        expect(ctx.state['n']).toBeGreaterThanOrEqual(1);
        return [
          { type: 'context', turnId: ctx.turnId, contextTokens: 7_777, contextWindow: null, exact: true },
          { type: 'compaction', turnId: ctx.turnId, trigger: 'auto', preTokens: null, postTokens: null, durationMs: null },
        ];
      },
    });
    const custom = createVerseEngine({ root: join(work, 'verse-hooks'), killGraceMs: 200, telemetryPollMs: 40, adapterFor: withAdapters({ claude: adapter }) });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
      const { turnId } = custom.sendTurn(created.id, 'SLOW please');
      const events = await untilTurnDone(custom, created.id);

      expect(polls.length).toBeGreaterThanOrEqual(2);
      expect(polls.map((p) => p.n)).toEqual(polls.map((_, i) => i + 1));
      expect(polls.every((p) => p.turnId === turnId && p.seatId === 'claude-max' && p.native === created.nativeSessionId && p.startedAt > 0)).toBe(true);
      expect(afterCalls).toBe(1);
      expect(order).toEqual(['finish', 'afterTurn']);

      const types = events.map((e) => e.type);
      expect(types).not.toContain('error');
      expect(types.filter((t) => t === 'turn-done')).toHaveLength(1);
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
      // The live reading lands before the CLI's own usage; the final file reading after it, before turn-done.
      const firstContext = types.indexOf('context');
      const usage = types.indexOf('usage');
      const lastContext = types.lastIndexOf('context');
      expect(firstContext).toBeLessThan(usage);
      expect(lastContext).toBeGreaterThan(usage);
      expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('turn-done'));
      expect(events[lastContext]).toMatchObject({ contextTokens: 7_777 });

      const after = custom.getSession(created.id)!;
      expect(after.usage.contextTokens).toBe(7_777);
      expect(after.compactionCount).toBe(1);
      expect(after.status).toBe('idle');

      // The poll timer died with the turn.
      const settled = polls.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(polls.length).toBe(settled);
    } finally {
      custom.close();
    }
  });

  it('a hook that throws or returns garbage never breaks, fails or extends a turn', async () => {
    const adapter = patched(adapterFor('claude'), {
      pollTelemetry: () => { throw new Error('rollout vanished'); },
      afterTurn: () => 'not an array' as never,
    });
    const throwingAfter = patched(adapterFor('codex'), {
      afterTurn: () => { throw new Error('boom'); },
    });
    const custom = createVerseEngine({ root: join(work, 'verse-hooks-bad'), killGraceMs: 200, telemetryPollMs: 30, adapterFor: withAdapters({ claude: adapter, codex: throwingAfter }) });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
      custom.sendTurn(created.id, 'SLOW');
      const events = await untilTurnDone(custom, created.id);
      expect(events[events.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
      expect(events.map((e) => e.type)).not.toContain('error');

      const codex = custom.createSession({ projectPath: project, seatId: 'codex-a' }, nativeLaunch(CODEX_SEAT));
      custom.sendTurn(codex.id, 'go');
      const codexEvents = await untilTurnDone(custom, codex.id);
      expect(codexEvents[codexEvents.length - 1]).toMatchObject({ type: 'turn-done', ok: true });
      expect(custom.getSession(codex.id)!.status).toBe('idle');
    } finally {
      custom.close();
    }
  });

  it('afterTurn still runs for a stopped turn (a cancelled turn can have compacted)', async () => {
    let afterCalls = 0;
    const adapter = patched(adapterFor('claude'), {
      afterTurn: (ctx) => {
        afterCalls += 1;
        return [{ type: 'compaction', turnId: ctx.turnId, trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }];
      },
    });
    const custom = createVerseEngine({ root: join(work, 'verse-hooks-cancel'), killGraceMs: 150, adapterFor: withAdapters({ claude: adapter }) });
    try {
      const created = custom.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
      custom.sendTurn(created.id, 'HANG');
      await waitFor(() => custom.getEvents(created.id).some((e) => e.type === 'turn-started'));
      const done = untilTurnDone(custom, created.id);
      custom.cancelTurn(created.id);
      const events = await done;
      const types = events.map((e) => e.type);
      expect(afterCalls).toBe(1);
      expect(types.indexOf('compaction')).toBeLessThan(types.indexOf('cancelled'));
      expect(custom.getSession(created.id)!.compactionCount).toBe(1);
    } finally {
      custom.close();
    }
  });

  it('the poll dies on every way a turn can end, and afterTurn runs once — never for a process that never started', async () => {
    const endings = ['exit', 'cancel', 'timeout', 'close', 'delete', 'spawn-failure'] as const;
    for (const ending of endings) {
      let polls = 0;
      let afters = 0;
      const adapter = patched(adapterFor('claude'), {
        pollTelemetry: () => { polls += 1; return []; },
        afterTurn: () => { afters += 1; return []; },
      });
      const custom = createVerseEngine({
        root: join(work, `verse-leak-${ending}`),
        killGraceMs: 100,
        telemetryPollMs: 20,
        turnTimeoutMs: ending === 'timeout' ? 250 : 15_000,
        adapterFor: withAdapters({ claude: adapter }),
      });
      try {
        const launch = ending === 'spawn-failure'
          ? { ...nativeLaunch(CLAUDE_SEAT), launcher: [join(work, 'no-such-launcher')] }
          : nativeLaunch(CLAUDE_SEAT);
        const created = custom.createSession({ projectPath: project, seatId: 'claude-max' }, launch);
        const done = untilTurnDone(custom, created.id);
        custom.sendTurn(created.id, ending === 'exit' ? 'SLOW' : 'HANG');
        if (ending !== 'spawn-failure') await waitFor(() => polls >= 2);
        if (ending === 'cancel') custom.cancelTurn(created.id);
        if (ending === 'close') custom.close();
        if (ending === 'delete') custom.deleteSession(created.id);
        await done;
        const settled = polls;
        await new Promise((r) => setTimeout(r, 150));
        expect(polls, `${ending}: polled after settle`).toBe(settled);
        expect(afters, `${ending}: afterTurn calls`).toBe(ending === 'spawn-failure' ? 0 : 1);
      } finally {
        custom.close();
      }
    }
  });

  it('a subscriber that stops the engine or deletes the chat mid-poll: the rest of that poll never lands after turn-done', async () => {
    for (const action of ['close', 'delete'] as const) {
      let polls = 0;
      const adapter = patched(adapterFor('claude'), {
        pollTelemetry: (ctx) => {
          polls += 1;
          return [
            { type: 'context', turnId: ctx.turnId, contextTokens: 5_000, contextWindow: null, exact: true },
            { type: 'context', turnId: ctx.turnId, contextTokens: 6_000, contextWindow: null, exact: true },
          ];
        },
      });
      const customRoot = join(work, `verse-reentrant-${action}`);
      const custom = createVerseEngine({ root: customRoot, killGraceMs: 100, telemetryPollMs: 20, adapterFor: withAdapters({ claude: adapter }) });
      try {
        const created = custom.createSession({ projectPath: project, seatId: 'claude-max' }, nativeLaunch(CLAUDE_SEAT));
        const seen: VerseEvent[] = [];
        custom.subscribe(created.id, 0, (event) => {
          seen.push(event);
          if (event.type !== 'context') return;
          if (action === 'close') custom.close();
          else custom.deleteSession(created.id);
        });
        custom.sendTurn(created.id, 'HANG');
        await waitFor(() => seen.some((e) => e.type === 'turn-done'));
        await new Promise((r) => setTimeout(r, 150));
        expect(polls, action).toBe(1);

        if (action === 'delete') {
          // Nothing re-created: no record, no log, no launch file.
          expect(custom.getSession(created.id)).toBeNull();
          expect(readdirSync(join(customRoot, 'sessions')).filter((f) => f.startsWith(created.id))).toEqual([]);
          expect(seen.map((e) => e.type).filter((t) => t === 'context')).toHaveLength(1);
          expect(seen.at(-1)!.type).toBe('turn-done');
        } else {
          // close() drops subscribers, so read the durable log itself.
          const reopened = createVerseEngine({ root: customRoot });
          try {
            const types = reopened.getEvents(created.id).map((e) => e.type);
            expect(types.filter((t) => t === 'context')).toHaveLength(1);
            expect(types.at(-1)).toBe('turn-done');
            expect(reopened.getSession(created.id)!.status).toBe('idle');
          } finally {
            reopened.close();
          }
        }
      } finally {
        custom.close();
      }
    }
  });
});

describe('V3.9 store validation', () => {
  function baseRecord(id: string): Record<string, unknown> {
    return {
      id, title: 't', projectPath: '/p', engine: 'claude', accountId: 'a', seatId: 's', model: 'claude-opus-5.5',
      nativeSessionId: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'idle', turnCount: 3,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, contextTokens: 5, contextWindow: 200_000 },
      lastError: null,
    };
  }

  it('loads old and new records, keeps an alias model as stored, and skips malformed V3.9 fields', () => {
    const store = createVerseSessionStore(join(work, 'store-v39'));
    mkdirSync(store.sessionsDir, { recursive: true, mode: 0o700 });
    const write = (id: string, record: Record<string, unknown>): void =>
      writeFileSync(join(store.sessionsDir, `${id}.json`), JSON.stringify(record), { mode: 0o600 });

    write('old', baseRecord('old'));
    const full = baseRecord('full');
    full['usage'] = { ...(full['usage'] as object), contextWindowSource: 'runtime', autoCompactAt: 167_000, contextTokensExact: false };
    Object.assign(full, { contextMode: 'expansive', compactionCount: 2, handoffFrom: { sessionId: 'old', title: 'Old' }, memoryEnabled: true });
    write('full', full);
    const nullCompact = baseRecord('nullcompact');
    nullCompact['usage'] = { ...(nullCompact['usage'] as object), autoCompactAt: null };
    write('nullcompact', nullCompact);

    const bad: Array<[string, (r: Record<string, unknown>) => void]> = [
      ['bad-mode', (r) => { r['contextMode'] = 'huge'; }],
      ['bad-count', (r) => { r['compactionCount'] = -1; }],
      ['bad-count-frac', (r) => { r['compactionCount'] = 1.5; }],
      ['bad-handoff', (r) => { r['handoffFrom'] = { sessionId: 'x' }; }],
      ['bad-handoff-empty', (r) => { r['handoffFrom'] = { sessionId: '', title: 't' }; }],
      ['bad-memory', (r) => { r['memoryEnabled'] = 'yes'; }],
      ['bad-source', (r) => { r['usage'] = { ...(r['usage'] as object), contextWindowSource: 'guess' }; }],
      ['bad-compact-at', (r) => { r['usage'] = { ...(r['usage'] as object), autoCompactAt: '167000' }; }],
      ['bad-exact', (r) => { r['usage'] = { ...(r['usage'] as object), contextTokensExact: 'no' }; }],
    ];
    for (const [id, mutate] of bad) {
      const record = baseRecord(id);
      mutate(record);
      write(id, record);
    }

    expect(store.list().map((s) => s.id).sort()).toEqual(['full', 'nullcompact', 'old']);
    // History is not rewritten: the alias the record was created with stays.
    expect(store.get('old')!.model).toBe('claude-opus-5.5');
    expect(store.get('full')).toMatchObject({ contextMode: 'expansive', compactionCount: 2, memoryEnabled: true, usage: { contextWindowSource: 'runtime', contextTokensExact: false } });
  });

  it('keeps valid context/compaction lines and drops malformed ones; older event types stay lenient', () => {
    const store = createVerseSessionStore(join(work, 'store-events'));
    mkdirSync(store.sessionsDir, { recursive: true, mode: 0o700 });
    const at = '2026-09-23T00:00:00.000Z';
    const lines = [
      { seq: 1, at, type: 'compaction', turnId: 't', trigger: 'auto', preTokens: 967_391, postTokens: 41_000, durationMs: 118_000 },
      { seq: 2, at, type: 'compaction', turnId: null, trigger: 'manual', preTokens: null, postTokens: null, durationMs: null },
      { seq: 3, at, type: 'compaction', turnId: 't', trigger: 'sideways', preTokens: null, postTokens: null, durationMs: null },
      { seq: 4, at, type: 'compaction', turnId: 't', trigger: 'auto', preTokens: '1', postTokens: null, durationMs: null },
      { seq: 5, at, type: 'context', turnId: 't', contextTokens: 42_000, contextWindow: 258_400, exact: true, autoCompactAt: 244_800 },
      { seq: 6, at, type: 'context', turnId: null, contextTokens: 10, contextWindow: null, exact: false },
      { seq: 7, at, type: 'context', turnId: 't', contextTokens: -1, contextWindow: null, exact: true },
      { seq: 8, at, type: 'context', turnId: 't', contextTokens: 5, contextWindow: null, exact: 'yes' },
      { seq: 9, at, type: 'context', turnId: 't', contextTokens: 5, contextWindow: 'big', exact: true },
      { seq: 10, at, type: 'text-delta', turnId: 't', text: 'still here' },
      { seq: 11, at, type: 'some-future-type' },
    ];
    writeFileSync(join(store.sessionsDir, 'ev.events.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
    expect(store.readEvents('ev').map((e) => e.seq)).toEqual([1, 2, 5, 6, 10, 11]);
  });
});
