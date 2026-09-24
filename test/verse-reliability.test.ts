/**
 * test/verse-reliability.test.ts — V3.10 engine & store reliability (unit A5).
 *
 * The engine is driven with FAKE child processes (an EventEmitter with
 * PassThrough stdio, handed back by an injected spawn) and a JSON-lines test
 * adapter, so every path — transient fan-out, recovery, watchdog, live
 * local-only, preflight, storage failure, crash interruption, the orphan
 * registry and the reasoning tap — runs deterministically with no real
 * process. Fake pids sit above every platform's pid_max, so the engine's
 * process-group signals can only ever answer ESRCH.
 *
 * Also covered, as pure units: process-registry (identity-verified reaping,
 * with injected `ps`/`kill`), verse-log (scrubbing, rotation, 0600, crash
 * handlers) and verse-stream (no `id:` on transient frames, the `?after=`
 * cursor, back-pressure).
 *
 * Real subprocesses (a real orphan reaped, a real preflight) are exercised
 * in test/verse-session-engine.test.ts, which is in the real-io lane.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { VerseAdapter, VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { __resetLocalOnlyLatchForTests } from '../src/core/policy/local-only.js';
import {
  argvMarkers,
  createProcessRegistry,
  parsePsRows,
  type ProcessRow,
  type VerseRunningEntry,
} from '../src/core/verse/process-registry.js';
import {
  classifyVerseFailure,
  createVerseEngine,
  preflightLocalEndpoint,
  seatNotReadyResponse,
  VerseError,
  type VerseEngineHandle,
  type VerseEngineOptions,
  type VersePreflightResult,
  type VerseSeatLaunch,
} from '../src/core/verse/session-engine.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { SeatReadiness } from '../src/core/verse/health-types.js';
import { isTransientVerseEvent, type VerseEvent, type VerseSeat, type VerseSession } from '../src/core/verse/types.js';
import {
  appendVerseLog,
  formatVerseLogLine,
  installVerseCrashHandlers,
  verseLogPath,
  type CrashHandlerHost,
} from '../src/core/verse/verse-log.js';
import { formatVerseSseFrame, handleVerseEventsSse, resumeCursor } from '../src/core/verse/verse-stream.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Above macOS (99 999) and Linux (4 194 304) pid_max: signals to it can only ESRCH. */
let nextFakePid = 4_194_400;

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.pid = nextFakePid++;
  }

  kill(): boolean { return true; }
  unref(): void { /* nothing to unref */ }

  line(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  exit(code: number, stderr = ''): void {
    if (stderr) this.stderr.write(stderr);
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

interface LaunchCall { session: VerseSession; text: string }

/**
 * A JSON-lines adapter: every stdout line IS a parsed event (turnId filled
 * in). The engine's own behaviour is what is under test, not a vendor dialect.
 */
function jsonAdapter(calls: LaunchCall[]): VerseAdapter {
  return {
    buildLaunch(session, text) {
      calls.push({ session: JSON.parse(JSON.stringify(session)) as VerseSession, text });
      return { argv: ['/opt/fake/bin/fake-cli', '/opt/fake/launcher-marker.mjs'], cwd: session.projectPath, env: {}, stdin: null };
    },
    createParser(turnId) {
      return {
        push(line: string): VerseParsedEvent[] {
          try { return [{ turnId, ...(JSON.parse(line) as object) } as VerseParsedEvent]; } catch { return []; }
        },
        finish(): VerseParsedEvent[] { return []; },
        nativeSessionId(): string | null { return null; },
      };
    },
  };
}

function cfgWith(foundry: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['anthropic', 'ollama'], ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234', routing: [] },
    foundry,
  } as unknown as AshlrConfig;
}
const ALL_BACKENDS = ['builtin', 'local-coder', 'claude', 'codex', 'nim', 'kimi', 'grok'];
const OPEN_CFG = cfgWith({ allowedBackends: ALL_BACKENDS, claude5: { enabled: false } });
const LOCKED_CFG = cfgWith({ localOnly: true, allowedBackends: ALL_BACKENDS, claude5: { enabled: false } });

function seat(engine: VerseSeat['engine'], id: string): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: engine === 'local' ? 'local' : id,
    models: [{ id: engine === 'local' ? 'qwen3-coder' : 'claude-opus-5', label: 'm', contextWindow: 32_000 }],
    contextWindow: null,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };
}

const CLAUDE = seat('claude', 'claude-a');
const LOCAL = seat('local', 'local:qwen3-coder');

function launchFor(s: VerseSeat, ollamaBaseUrl = 'http://127.0.0.1:11434'): VerseSeatLaunch {
  return { seat: s, launcher: s.engine === 'local' ? null : ['/opt/fake/node', '/opt/fake/launcher-marker.mjs'], ollamaBaseUrl };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let work: string;
let root: string;
let project: string;
let children: FakeChild[];
let calls: LaunchCall[];
let cfg: AshlrConfig;
let engines: VerseEngineHandle[];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-rel-'));
  root = join(work, 'root');
  project = join(work, 'project');
  mkdirSync(project, { mode: 0o700 });
  project = realpathSync(project);
  children = [];
  calls = [];
  cfg = OPEN_CFG;
  engines = [];
  __resetLocalOnlyLatchForTests();
});

afterEach(() => {
  for (const engine of engines) {
    try { engine.close(); } catch { /* closed */ }
  }
  try { chmodSync(join(root, 'sessions'), 0o700); } catch { /* not created */ }
  rmSync(work, { recursive: true, force: true });
  __resetLocalOnlyLatchForTests();
});

function makeEngine(opts: VerseEngineOptions = {}): VerseEngineHandle {
  const engine = createVerseEngine({
    root,
    killGraceMs: 30,
    loadConfig: () => cfg,
    adapterFor: () => jsonAdapter(calls),
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as VerseEngineOptions['spawn'],
    readiness: null,
    reasoningTap: null,
    preflight: null,
    ...opts,
  });
  engines.push(engine);
  return engine;
}

function collect(engine: VerseEngineHandle, id: string): VerseEvent[] {
  const seen: VerseEvent[] = [];
  engine.subscribe(id, Number.MAX_SAFE_INTEGER, (event) => seen.push(event));
  return seen;
}

function turnDone(seen: VerseEvent[]): boolean {
  return seen.some((e) => e.type === 'turn-done');
}

// ---------------------------------------------------------------------------

describe('transient events and compaction', () => {
  it('fans transient events out live with the last persisted seq, never stores them, and folds deltas at turn end', async () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    const child = children[0]!;
    child.line({ type: 'progress', phase: 'thinking', elapsedMs: 10 });
    child.line({ type: 'thinking-delta', text: 'pondering' });
    child.line({ type: 'text-delta', text: 'hel' });
    child.line({ type: 'status', kind: 'retry', message: 'retry 1/10' });
    child.line({ type: 'text-delta', text: 'lo' });
    child.line({ type: 'assistant-message', text: 'hello' });
    child.exit(0);
    await waitFor(() => turnDone(seen));

    const transient = seen.filter((e) => isTransientVerseEvent(e));
    expect(transient.map((e) => e.type)).toEqual(['progress', 'thinking-delta', 'status']);
    // Each carries the seq of the last PERSISTED event delivered before it.
    for (const t of transient) {
      const before = seen.slice(0, seen.indexOf(t)).filter((e) => !isTransientVerseEvent(e)).at(-1)!;
      expect(t.seq).toBe(before.seq);
      expect(formatVerseSseFrame(t)).not.toMatch(/^id:/m);
    }
    expect(formatVerseSseFrame(seen[0]!)).toMatch(/^id: 1\n/);

    const stored = engine.getEvents(s.id);
    expect(stored.some((e) => isTransientVerseEvent(e))).toBe(false);
    // Folded at turn end: the two streamed deltas are superseded by the message.
    expect(stored.map((e) => e.type)).toEqual(['user-message', 'turn-started', 'assistant-message', 'turn-done']);
    expect(engine.getSession(s.id)!.status).toBe('idle');
  });
});

describe('readiness gate', () => {
  const refusal: SeatReadiness = {
    seatId: 'claude-a',
    ready: false,
    reason: 'claude-a is signed out (token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)',
    alternatives: ['grok-a', 'local:qwen3-coder'],
  };

  it('refuses a not-ready seat with 409 + ranked alternatives, before anything is recorded or spawned', () => {
    const engine = makeEngine({ readiness: () => refusal });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    let thrown: unknown;
    try { engine.sendTurn(s.id, 'hello'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(VerseError);
    expect(thrown).toMatchObject({ code: 'VERSE_SEAT_NOT_READY', status: 409 });
    const response = seatNotReadyResponse(thrown)!;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('seat-not-ready');
    expect(response.body.readiness).toMatchObject({ seatId: 'claude-a', ready: false, alternatives: ['grok-a', 'local:qwen3-coder'] });
    // Scrubbed: a reason is text from a status command.
    expect(JSON.stringify(response.body)).not.toContain('sk-ant-api03');
    expect(engine.getEvents(s.id)).toEqual([]);
    expect(children).toHaveLength(0);
    expect(engine.getSession(s.id)!.status).toBe('idle');
    expect(seatNotReadyResponse(new VerseError('VERSE_INVALID', 'x'))).toBeNull();
  });

  it('admits on ready, on unknown, on a throwing check and on an async answer', async () => {
    const answers: unknown[] = [
      { seatId: 'claude-a', ready: true, reason: null, alternatives: [] },
      null,
      Promise.resolve(refusal),
      'garbage',
    ];
    for (const answer of answers) {
      const engine = makeEngine({ readiness: () => answer as SeatReadiness });
      const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
      expect(() => engine.sendTurn(s.id, 'hi')).not.toThrow();
    }
    const throwing = makeEngine({ readiness: () => { throw new Error('probe broke'); } });
    const s = throwing.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    expect(() => throwing.sendTurn(s.id, 'hi')).not.toThrow();
    expect(children).toHaveLength(5);
  });
});

describe('native-thread recovery', () => {
  it('a vanished native conversation is retried ONCE on a new native session seeded with the handoff note', async () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    // Turn 1 succeeds, so the chat has history to hand off.
    engine.sendTurn(s.id, 'build the parser');
    children[0]!.line({ type: 'assistant-message', text: 'parser built in src/parse.ts' });
    children[0]!.exit(0);
    await waitFor(() => engine.getSession(s.id)!.status === 'idle');
    const originalNative = engine.getSession(s.id)!.nativeSessionId;

    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'now add tests');
    children[1]!.line({ type: 'error', message: 'claude: error_during_execution: No conversation found with session ID: abc' });
    children[1]!.exit(1);
    await waitFor(() => children.length === 3);
    children[2]!.line({ type: 'assistant-message', text: 'tests added' });
    children[2]!.exit(0);
    await waitFor(() => turnDone(seen));

    const persisted = seen.filter((e) => !isTransientVerseEvent(e));
    expect(persisted.map((e) => e.type)).toEqual([
      'user-message', 'turn-started', 'error', 'recovered', 'turn-started', 'assistant-message', 'turn-done',
    ]);
    expect(persisted[2]).toMatchObject({ type: 'error', code: 'native-thread-missing' });
    expect(persisted[3]).toMatchObject({ type: 'recovered', how: 'handoff' });
    expect(persisted.at(-1)).toMatchObject({ type: 'turn-done', ok: true });
    // One turn: every event carries the same turnId.
    expect(new Set(persisted.map((e) => (e as { turnId: string }).turnId)).size).toBe(1);

    const retry = calls[2]!;
    expect(retry.session.turnCount).toBe(0);
    expect(retry.session.nativeSessionId).not.toBe(originalNative);
    expect(retry.text).toContain('# Continuing from an earlier Verse session');
    expect(retry.text).toContain('build the parser');
    expect(retry.text.endsWith('now add tests')).toBe(true);
    const after = engine.getSession(s.id)!;
    expect(after.nativeSessionId).toBe(retry.session.nativeSessionId);
    expect(after.turnCount).toBe(2);
    expect(after.status).toBe('idle');
  });

  it('recognises a stderr-only "already in use" on turn 1 (bare new session), and never retries a retry', async () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'first');
    children[0]!.exit(1, 'Error: Session ID 1b2c3d4e-0000-4000-8000-000000000000 is already in use.\n');
    await waitFor(() => children.length === 2);
    children[1]!.exit(1, 'Error: Session ID 9f9f9f9f-0000-4000-8000-000000000000 is already in use.\n');
    await waitFor(() => turnDone(seen));
    const persisted = seen.filter((e) => !isTransientVerseEvent(e));
    expect(persisted.find((e) => e.type === 'recovered')).toMatchObject({ how: 'new-native-session' });
    expect(calls[1]!.text).toBe('first');
    // The retry failed too: reported, with its code, and no third process.
    expect(children).toHaveLength(2);
    expect(persisted.filter((e) => e.type === 'error').at(-1)).toMatchObject({ code: 'session-in-use' });
    expect(persisted.at(-1)).toMatchObject({ type: 'turn-done', ok: false });
    expect(engine.getSession(s.id)!.status).toBe('error');
  });

  it('recoverNativeThreads:false reports the coded error instead of retrying', async () => {
    const engine = makeEngine({ recoverNativeThreads: false });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'x');
    children[0]!.exit(1, 'thread/resume failed: no rollout found for thread id thr_1\n');
    await waitFor(() => turnDone(seen));
    expect(children).toHaveLength(1);
    expect(seen.find((e) => e.type === 'error')).toMatchObject({ code: 'native-thread-missing' });
  });

  it('classifyVerseFailure knows the CLIs’ own phrases and nothing else', () => {
    expect(classifyVerseFailure('No conversation found with session ID: 123')).toBe('native-thread-missing');
    expect(classifyVerseFailure('thread/resume failed: no rollout found for thread id x')).toBe('native-thread-missing');
    expect(classifyVerseFailure('Error: Session ID abc is already in use.')).toBe('session-in-use');
    expect(classifyVerseFailure('rate limited, try again')).toBeNull();
  });
});

describe('watchdog, live local-only, preflight', () => {
  it('posts ONE watchdog status per silence and keeps the turn running', async () => {
    const engine = makeEngine({ watchdogMs: 60, watchdogPollMs: 15 });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'long task');
    await waitFor(() => seen.some((e) => e.type === 'status'));
    await new Promise((r) => setTimeout(r, 90));
    expect(seen.filter((e) => e.type === 'status')).toHaveLength(1);
    expect(seen.find((e) => e.type === 'status')).toMatchObject({ kind: 'watchdog', message: expect.stringContaining('still running') });
    expect(engine.getSession(s.id)!.status).toBe('running');
    // Output re-arms it.
    children[0]!.line({ type: 'text-delta', text: 'working' });
    await waitFor(() => seen.filter((e) => e.type === 'status').length === 2);
    children[0]!.exit(0);
    await waitFor(() => turnDone(seen));
    expect(engine.getEvents(s.id).some((e) => e.type === 'status')).toBe(false);
  });

  it('stops a vendor turn when Local-only is switched on mid-turn, with the policy’s own sentence', async () => {
    const engine = makeEngine({ watchdogPollMs: 15 });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'spend money');
    cfg = LOCKED_CFG;
    await waitFor(() => turnDone(seen), 4_000);
    const error = seen.find((e) => e.type === 'error') as { message: string };
    expect(error.message).toContain('local-only');
    expect(engine.getSession(s.id)).toMatchObject({ status: 'error' });
  });

  it('local seats: a refused endpoint stops the turn at once; a slow one posts a notice; vendor seats are never probed', async () => {
    const probes: string[] = [];
    let answer: VersePreflightResult = { ok: false, ms: 1, reason: 'nothing is listening at 127.0.0.1:11434 (ECONNREFUSED)' };
    const engine = makeEngine({ preflight: async (url) => { probes.push(url); return answer; } });
    const local = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    const seen = collect(engine, local.id);
    engine.sendTurn(local.id, 'hi');
    await waitFor(() => turnDone(seen), 4_000);
    expect(probes).toEqual(['http://127.0.0.1:11434']);
    expect(seen.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('local model server unreachable') });
    expect(engine.getSession(local.id)!.lastError).toContain('ollama serve');

    answer = { ok: 'slow', ms: 1500 };
    const seen2 = collect(engine, local.id);
    engine.sendTurn(local.id, 'again');
    await waitFor(() => seen2.some((e) => e.type === 'status'));
    expect(seen2.find((e) => e.type === 'status')).toMatchObject({ kind: 'preflight' });
    children[1]!.exit(0);
    await waitFor(() => turnDone(seen2));

    const claude = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    engine.sendTurn(claude.id, 'vendor');
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toHaveLength(2);
  });

  it('never probes an endpoint the local-only gate refused', () => {
    cfg = LOCKED_CFG;
    const probes: string[] = [];
    const engine = makeEngine({ preflight: async (url) => { probes.push(url); return { ok: true, ms: 0 }; } });
    const remote = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL, 'https://gpu.example.com'));
    engine.sendTurn(remote.id, 'hi');
    expect(children).toHaveLength(0);
    expect(probes).toEqual([]);
  });

  it('preflightLocalEndpoint: a closed port is a definite refusal, fast; a bad URL is refused', async () => {
    const start = Date.now();
    const result = await preflightLocalEndpoint('http://127.0.0.1:1');
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
    expect(await preflightLocalEndpoint('not a url')).toMatchObject({ ok: false });
  });
});

describe('storage failures, crash interruption, registry, reasoning tap', () => {
  it('a log that cannot be written stops the turn with a live storage error instead of throwing', async () => {
    const logged: string[] = [];
    const engine = makeEngine({ log: (_level, message) => { logged.push(message); } });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'x');
    // Pull the log out from under the running turn and make it impossible to recreate.
    const sessions = join(root, 'sessions');
    rmSync(join(sessions, `${s.id}.events.jsonl`));
    chmodSync(sessions, 0o500);
    try {
      children[0]!.line({ type: 'text-delta', text: 'lost' });
      await waitFor(() => seen.some((e) => e.type === 'error' && (e as { code?: string }).code === 'storage'));
      expect(engine.getSession(s.id)).toMatchObject({ status: 'error', lastError: expect.stringContaining('storage error') });
      expect(logged.some((m) => m.includes('event log write failed'))).toBe(true);
      // One notice per turn, however many writes fail after it.
      children[0]!.line({ type: 'text-delta', text: 'also lost' });
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.filter((e) => e.type === 'error')).toHaveLength(1);
    } finally {
      chmodSync(sessions, 0o700);
    }
  });

  it('interruptAll settles running turns synchronously as failed and clears the registry', () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    engine.sendTurn(s.id, 'x');
    const registryFile = join(root, 'running.json');
    const entries = (JSON.parse(readFileSync(registryFile, 'utf8')) as { entries: VerseRunningEntry[] }).entries;
    expect(entries).toEqual([expect.objectContaining({
      sessionId: s.id,
      pid: children[0]!.pid,
      pgid: children[0]!.pid,
      serverPid: process.pid,
      markers: ['fake-cli', 'launcher-marker.mjs', 'claude'],
    })]);
    expect(statSync(registryFile).mode & 0o777).toBe(0o600);

    expect(engine.interruptAll?.('server crashed')).toBe(1);
    const events = engine.getEvents(s.id);
    expect(events.at(-2)).toMatchObject({ type: 'error', message: 'turn interrupted: server crashed' });
    expect(events.at(-1)).toMatchObject({ type: 'turn-done', ok: false });
    expect(engine.getSession(s.id)).toMatchObject({ status: 'error', lastError: 'turn interrupted: server crashed' });
    expect((JSON.parse(readFileSync(registryFile, 'utf8')) as { entries: unknown[] }).entries).toEqual([]);
    expect(engine.interruptAll?.('again')).toBe(0);
  });

  it('the crash handler drives interruptAll, logs to verse.log, then exits non-zero', () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    engine.sendTurn(s.id, 'x');
    const host = new EventEmitter() as EventEmitter & CrashHandlerHost & { exits: number[] };
    host.exits = [];
    host.exit = ((code?: number) => { host.exits.push(code ?? 0); }) as CrashHandlerHost['exit'];
    const uninstall = installVerseCrashHandlers({ root, host, onFatal: (reason) => { engine.interruptAll?.(reason); } });
    host.emit('uncaughtException', new Error('kaboom in a timer'));
    expect(host.exits).toEqual([1]);
    expect(engine.getSession(s.id)!.lastError).toBe('turn interrupted: server crashed');
    const logText = readFileSync(verseLogPath(root), 'utf8');
    expect(logText).toMatch(/FATAL .*uncaught exception — shutting down: Error: kaboom in a timer/);
    expect(logText).toMatch(/ERROR .*1 running turn\(s\) interrupted: server crashed/);
    uninstall();
  });

  it('taps every PERSISTED event for the reasoning store — deferred, in order, never a transient one, and a throwing tap is contained', async () => {
    const tapped: { type: string; sessionId: string }[] = [];
    let throwNext = true;
    const engine = makeEngine({
      reasoningTap: (event, session) => {
        if (throwNext) { throwNext = false; throw new Error('store down'); }
        tapped.push({ type: event.type, sessionId: session.id });
      },
    });
    const s = engine.createSession({ projectPath: project, seatId: CLAUDE.id }, launchFor(CLAUDE));
    engine.sendTurn(s.id, 'x');
    children[0]!.line({ type: 'thinking', text: 'first thought' });
    children[0]!.line({ type: 'thinking-delta', text: 'transient, never tapped' });
    children[0]!.line({ type: 'thinking', text: 'second thought' });
    children[0]!.line({ type: 'tool-use', toolUseId: 'u1', name: 'Bash', input: { command: 'npm test' } });
    children[0]!.exit(0);
    await waitFor(() => tapped.some((t) => t.type === 'turn-done'));
    // The first call (user-message) threw and was contained; the rest arrive in order.
    expect(tapped.map((t) => t.type)).toEqual(['turn-started', 'thinking', 'thinking', 'tool-use', 'turn-done']);
    expect(tapped.every((t) => t.sessionId === s.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// process-registry (pure, injected ps / kill)
// ---------------------------------------------------------------------------

describe('process registry: identity-verified orphan reaping', () => {
  const DEAD_SERVER = 4_194_390;
  const SPAWNED_AT = Date.parse('2026-09-23T10:00:00.000Z');

  function entry(over: Partial<VerseRunningEntry> = {}): VerseRunningEntry {
    return {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      pid: 5001,
      pgid: 5001,
      markers: ['launcher.mjs', 'claude'],
      spawnedAt: SPAWNED_AT,
      serverPid: DEAD_SERVER,
      serverStartedAt: SPAWNED_AT - 60_000,
      ...over,
    };
  }

  function seed(entries: VerseRunningEntry[]): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'running.json'), JSON.stringify({ v: 1, entries }), { mode: 0o600 });
  }

  function harness(rows: ProcessRow[] | null, alive: Set<number>) {
    const kills: [number, string][] = [];
    const logs: string[] = [];
    const registry = createProcessRegistry(root, {
      listProcesses: () => rows,
      exists: (p) => alive.has(p),
      kill: (p, sig) => { kills.push([p, sig]); if (sig === 'SIGKILL') alive.delete(p); },
      termGraceMs: 10,
      log: (_l, m) => logs.push(m),
      serverPid: process.pid,
      serverStartedAt: Date.now(),
    });
    return { registry, kills, logs };
  }

  it('kills (TERM, then KILL if still alive) a verified group left by a dead server, and prunes the file', async () => {
    seed([entry()]);
    const alive = new Set([-5001, 5001]);
    const rows: ProcessRow[] = [
      { pid: 5001, pgid: 5001, startedAt: SPAWNED_AT + 400, command: 'node /Users/x/.ashlr/native-profiles/p/launcher.mjs -p --output-format stream-json' },
      { pid: 5002, pgid: 5001, startedAt: SPAWNED_AT + 900, command: 'bash -c npm test' },
    ];
    const { registry, kills } = harness(rows, alive);
    const report = registry.reapOrphans();
    expect(report.reaped).toEqual([{ sessionId: 'sess-1', turnId: 'turn-1', pgid: 5001, pids: [5001, 5002] }]);
    expect(kills).toEqual([[-5001, 'SIGTERM']]);
    await waitFor(() => kills.length === 2);
    expect(kills[1]).toEqual([-5001, 'SIGKILL']);
    expect(registry.entries()).toEqual([]);
  });

  it('never kills a reused pid (start time off) or a stranger (command lacks every marker)', () => {
    seed([entry(), entry({ sessionId: 'sess-2', pid: 6001, pgid: 6001 })]);
    const alive = new Set([-5001, -6001]);
    const rows: ProcessRow[] = [
      { pid: 5001, pgid: 5001, startedAt: SPAWNED_AT + 3_600_000, command: 'node launcher.mjs' },
      { pid: 6001, pgid: 6001, startedAt: SPAWNED_AT + 200, command: '/Applications/Safari.app/Contents/MacOS/Safari' },
    ];
    const { registry, kills, logs } = harness(rows, alive);
    const report = registry.reapOrphans();
    expect(kills).toEqual([]);
    expect(report.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('reused'),
      expect.stringContaining('does not match'),
    ]);
    expect(logs).toHaveLength(2);
    expect(registry.entries()).toEqual([]); // not ours any more: forgotten, not killed
  });

  it('a leaderless group is reaped only when every member is younger than the turn', () => {
    seed([entry(), entry({ sessionId: 'sess-2', pid: 7001, pgid: 7001 })]);
    const alive = new Set([-5001, -7001]);
    const rows: ProcessRow[] = [
      { pid: 5010, pgid: 5001, startedAt: SPAWNED_AT + 5_000, command: 'node test-runner' },
      { pid: 7010, pgid: 7001, startedAt: SPAWNED_AT - 86_400_000, command: 'sshd' },
    ];
    const { registry, kills } = harness(rows, alive);
    const report = registry.reapOrphans();
    expect(report.reaped.map((r) => r.pgid)).toEqual([5001]);
    expect(kills).toEqual([[-5001, 'SIGTERM']]);
    expect(report.skipped[0]!.reason).toContain('older than the turn');
  });

  it('leaves a LIVE server’s turns alone, skips (logs) when ps is unavailable, and drops dead groups without listing', () => {
    const liveServer = 4_194_380;
    seed([
      entry({ serverPid: liveServer, serverStartedAt: null }),
      entry({ sessionId: 'sess-2', pid: 8001, pgid: 8001 }),
      entry({ sessionId: 'sess-3', pid: 9001, pgid: 9001 }),
    ]);
    const alive = new Set([liveServer, -5001, -8001]);
    const { registry, kills } = harness(null, alive);
    const report = registry.reapOrphans();
    expect(kills).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ sessionId: 'sess-2', reason: expect.stringContaining('cannot verify') })]);
    expect(registry.entries().map((e) => e.sessionId)).toEqual(['sess-1']);
  });

  it('add/remove only touch this server’s entries; the file is 0600 JSON; markers are basenames', () => {
    seed([entry({ serverPid: 4_194_370, serverStartedAt: null })]);
    const { registry } = harness([], new Set([4_194_370]));
    registry.add({ sessionId: 'mine', turnId: 't', pid: 42, pgid: 42, markers: ['m'], spawnedAt: 1 });
    expect(registry.entries().map((e) => e.sessionId)).toEqual(['sess-1', 'mine']);
    registry.remove('mine', 't');
    registry.remove('sess-1', 'turn-1'); // another server's: untouched
    expect(registry.entries().map((e) => e.sessionId)).toEqual(['sess-1']);
    expect(statSync(registry.path).mode & 0o777).toBe(0o600);
    expect(argvMarkers(['/usr/local/bin/node', '/Users/me/.ashlr/native-profiles/claude-a/launcher.mjs'], 'claude'))
      .toEqual(['launcher.mjs', 'claude']);
  });

  it('parses real `ps -o pid=,pgid=,lstart=,command=` rows', () => {
    const rows = parsePsRows([
      '  501   501 Wed Sep 23 21:27:03 2026     /usr/local/bin/node /x/launcher.mjs -p --output-format stream-json',
      '12345 501 Thu Sep  3 09:05:59 2026 bash -c npm test',
      'garbage',
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 501, pgid: 501, command: '/usr/local/bin/node /x/launcher.mjs -p --output-format stream-json' });
    expect(new Date(rows[1]!.startedAt).getDate()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// verse-log
// ---------------------------------------------------------------------------

describe('verse.log', () => {
  it('scrubs secrets and the home path, flattens to one line, writes 0600, and rotates at the cap', () => {
    const home = process.env['HOME'] ?? '';
    const line = formatVerseLogLine('error', `boom at ${home}/.ashlr/native-profiles/x token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n  at frame`);
    expect(line).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    if (home.length > 1) expect(line).not.toContain(home);
    expect(line.trimEnd().split('\n')).toHaveLength(1);

    expect(appendVerseLog('info', 'first', { root, maxBytes: 200 })).toBe(true);
    expect(statSync(verseLogPath(root)).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 5; i += 1) appendVerseLog('info', `line ${i} ${'x'.repeat(60)}`, { root, maxBytes: 200 });
    expect(existsSync(`${verseLogPath(root)}.1`)).toBe(true);
    expect(statSync(verseLogPath(root)).size).toBeLessThan(400);
  });

  it('never throws, even when it cannot write', () => {
    writeFileSync(join(work, 'not-a-dir'), 'x');
    expect(appendVerseLog('error', 'x', { root: join(work, 'not-a-dir', 'verse') })).toBe(false);
  });

  it('unhandled rejections are logged and survived; a second fatal during cleanup exits at once', () => {
    const host = new EventEmitter() as EventEmitter & CrashHandlerHost & { exits: number[] };
    host.exits = [];
    host.exit = ((code?: number) => { host.exits.push(code ?? 0); }) as CrashHandlerHost['exit'];
    let cleanups = 0;
    const uninstall = installVerseCrashHandlers({
      root,
      host,
      onFatal: () => { cleanups += 1; host.emit('uncaughtException', new Error('during cleanup')); },
    });
    host.emit('unhandledRejection', new Error('stray probe'));
    expect(host.exits).toEqual([]);
    host.emit('uncaughtException', new Error('first'));
    expect(cleanups).toBe(1);
    expect(host.exits).toEqual([1, 1]);
    const text = readFileSync(verseLogPath(root), 'utf8');
    expect(text).toContain('unhandled promise rejection (survived): Error: stray probe');
    uninstall();
    expect(host.listenerCount('uncaughtException')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verse-stream
// ---------------------------------------------------------------------------

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  headersSent = false;
  status = 0;
  accept = true;
  writableLength = 0;
  writeHead(status: number): this { this.status = status; this.headersSent = true; return this; }
  setHeader(): void { /* sendJson path */ }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (!this.accept) this.writableLength += chunk.length;
    return this.accept;
  }
  end(): void { this.ended = true; }
  get text(): string { return this.chunks.join(''); }
}

function fakeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & { url: string; headers: Record<string, string> };
  req.url = url;
  req.headers = headers;
  return req as unknown as IncomingMessage;
}

describe('verse-stream', () => {
  const persisted = (seq: number): VerseEvent => ({ seq, at: 'x', type: 'user-message', turnId: 't', text: `m${seq}` });

  function fakeEngine(stored: VerseEvent[]) {
    let live: ((e: VerseEvent) => void) | null = null;
    let from = -2;
    const engine = {
      getSession: () => ({ id: 's' }),
      subscribe: (_id: string, fromSeq: number, listener: (e: VerseEvent) => void) => {
        from = fromSeq;
        for (const e of stored) if (e.seq > fromSeq) listener(e);
        live = listener;
        return () => { live = null; };
      },
    };
    return { engine: engine as unknown as VerseEngineHandle, push: (e: VerseEvent) => live?.(e), fromSeq: () => from, subscribed: () => live !== null };
  }

  it('resumes after the LATER of Last-Event-ID and ?after=, rejecting junk', () => {
    expect(resumeCursor(fakeReq('/api/verse/sessions/s/events?client=p&after=40'))).toBe(40);
    expect(resumeCursor(fakeReq('/x?after=40', { 'last-event-id': '55' }))).toBe(55);
    expect(resumeCursor(fakeReq('/x?after=70', { 'last-event-id': '55' }))).toBe(70);
    expect(resumeCursor(fakeReq('/x?after=-1'))).toBe(-1);
    expect(resumeCursor(fakeReq('/x?after=1e3'))).toBe(-1);
    expect(resumeCursor(fakeReq('/x?after=1&after=2'))).toBe(-1);
    expect(resumeCursor(fakeReq('/x'))).toBe(-1);
  });

  it('replays only after the cursor and writes transient frames without an id', () => {
    const { engine, push, fromSeq } = fakeEngine([persisted(1), persisted(2), persisted(3)]);
    const res = new FakeRes();
    const req = fakeReq('/api/verse/sessions/s/events?after=2');
    handleVerseEventsSse(req, res as unknown as ServerResponse, engine, 's', { id: 'rs', expiresAt: Date.now() + 60_000 });
    expect(fromSeq()).toBe(2);
    push({ seq: 3, at: 'x', type: 'progress', turnId: 't', phase: 'tool', tool: 'Bash', elapsedMs: 1 });
    expect(res.text).toContain('id: 3\nevent: user-message\n');
    expect(res.text).not.toContain('id: 1\n');
    expect(res.text).toMatch(/\n\nevent: progress\ndata: /);
    req.emit('close');
    expect(res.ended).toBe(true);
  });

  it('back-pressure: drops transient frames while congested, and closes a stream buffering past the cap', () => {
    const { engine, push, subscribed } = fakeEngine([]);
    const res = new FakeRes();
    handleVerseEventsSse(fakeReq('/e'), res as unknown as ServerResponse, engine, 's', { id: 'rs', expiresAt: Date.now() + 60_000 }, { maxBufferedBytes: 400 });
    res.accept = false;
    push(persisted(1)); // write returns false → congested
    const before = res.chunks.length;
    push({ seq: 1, at: 'x', type: 'thinking-delta', turnId: 't', text: 'dropped' });
    expect(res.chunks.length).toBe(before);
    res.emit('drain');
    push({ seq: 1, at: 'x', type: 'thinking-delta', turnId: 't', text: 'after drain' });
    expect(res.chunks.length).toBe(before + 1);
    for (let seq = 2; seq < 12 && !res.ended; seq += 1) push(persisted(seq));
    expect(res.ended).toBe(true);
    expect(subscribed()).toBe(false);
  });
});
