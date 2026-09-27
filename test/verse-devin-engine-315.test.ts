/**
 * 3.15 — a Devin chat through the REAL session engine: the engine spawns a
 * turn process (here a fake that prints the Devin turn protocol and records
 * its stdin), the real Devin parser maps its lines, and the engine persists
 * them — native id adopted from the first turn, `remote-status` folded into
 * `session.remote` (the header meter), `remote-pr` stored for the transcript
 * card, a lost session retried once on a fresh one seeded with the handoff
 * note, and the Devin budget refusing a new session through the readiness
 * gate with the session in hand. Real subprocesses: real-io lane.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn } from 'node:child_process';

import { devinChatTurnArgv } from '../src/core/devin/chat-turn-invocation.js';
import { createDevinParser, devinAdapter } from '../src/core/verse/adapters/devin.js';
import type { VerseAdapter } from '../src/core/verse/adapters/index.js';
import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { isTransientVerseEvent, type VerseEvent, type VerseSeat } from '../src/core/verse/types.js';

/**
 * The fake turn process. It reads the JSON request on stdin, records it, and
 * answers by the text: NEW → a first turn that names its task; GONE → the
 * session is lost (native-thread-missing); anything else → a normal reply.
 */
function fakeTurnSource(sideDir: string): string {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  const n = fs.readdirSync(${JSON.stringify(sideDir)}).length + 1;
  fs.writeFileSync(path.join(${JSON.stringify(sideDir)}, 'call-' + n + '.json'), JSON.stringify({ req, argv: process.argv.slice(2) }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (req.text.includes('GONE') && req.nativeId) {
    out({ type: 'native-session', id: req.nativeId });
    out({ type: 'error', message: 'This Devin session has ended.', code: 'native-thread-missing' });
    process.exit(1);
  }
  const id = req.nativeId || 'dv_20260927T0500_' + String(n).padStart(6, '0');
  out({ type: 'native-session', id });
  out({ type: 'remote-status', state: 'working', message: 'Devin is working…', url: 'https://app.devin.ai/sessions/devin-abc', acusConsumed: 0.5, acuCap: 10 });
  out({ type: 'progress', phase: 'tool', tool: 'Devin', elapsedMs: 10 });
  out({ type: 'assistant-message', text: 'devin says: ' + req.text.split('\\n').pop() });
  out({ type: 'remote-pr', url: 'https://github.com/ashlrai/devin-canary/pull/9', state: 'open' });
  out({ type: 'remote-status', state: 'waiting', message: 'Devin is waiting for you.', url: 'https://app.devin.ai/sessions/devin-abc', acusConsumed: 1.25, acuCap: 10 });
  process.exit(0);
});
`;
}

function untilTurnDone(engine: VerseEngineHandle, id: string, fromSeq = 0, timeoutMs = 15_000): Promise<VerseEvent[]> {
  return new Promise((resolve, reject) => {
    const seen: VerseEvent[] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`turn-done not seen; saw ${seen.map((e) => e.type).join(',')}`)); }, timeoutMs);
    const off = engine.subscribe(id, fromSeq, (event) => {
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

const DEVIN_SEAT: VerseSeat = {
  id: 'devin',
  engine: 'devin',
  label: 'Devin (cloud)',
  accountId: 'devin',
  models: [{ id: 'devin', label: 'Devin', contextWindow: null }],
  contextWindow: null,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

let work: string;
let side: string;
let project: string;
let script: string;
let engine: VerseEngineHandle;
let readinessCalls: Array<{ seatId: string; native: string | null | undefined }>;
let refuseNew = false;

/** The real Devin adapter's request + parser, with argv pointed at the fake turn process. */
function testAdapter(): VerseAdapter {
  return {
    buildLaunch: (session, text, launch) => ({ ...devinAdapter.buildLaunch(session, text, launch), argv: [process.execPath, script] }),
    createParser: createDevinParser,
  };
}

const launch: VerseSeatLaunch = { seat: DEVIN_SEAT, launcher: null, ollamaBaseUrl: '', devin: { lane: 'cloud' } };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-devin-'));
  side = join(work, 'side');
  project = join(work, 'project');
  mkdirSync(side, { mode: 0o700 });
  mkdirSync(project, { mode: 0o700 });
  project = realpathSync(project);
  script = join(work, 'turn.cjs');
  writeFileSync(script, fakeTurnSource(side), { mode: 0o700 });
  readinessCalls = [];
  refuseNew = false;
  engine = createVerseEngine({
    root: join(work, 'root'),
    reasoningTap: null,
    preflight: null,
    killGraceMs: 200,
    adapterFor: (e) => {
      if (e !== 'devin') throw new Error(`unexpected engine ${e}`);
      return testAdapter();
    },
    readiness: (seatId, session) => {
      readinessCalls.push({ seatId, native: session?.nativeSessionId });
      if (refuseNew && !session?.nativeSessionId) {
        return { seatId, ready: false, reason: 'Devin budget: Another session could take today past the 30 ACUs daily cap.', alternatives: [] };
      }
      return { seatId, ready: true, reason: null, alternatives: [] };
    },
  });
});

afterEach(() => {
  engine.close();
  rmSync(work, { recursive: true, force: true });
});

function calls(): Array<{ req: Record<string, unknown>; argv: string[] }> {
  return readdirSync(side).sort().map((f) => JSON.parse(readFileSync(join(side, f), 'utf8')));
}

describe('a Devin chat in the session engine', () => {
  it('first turn names the session; status, PR and ACUs land in the log and the header', async () => {
    const session = engine.createSession({ projectPath: project, seatId: 'devin' }, launch);
    // Devin names the conversation (like codex): nothing is pre-minted.
    expect(session.nativeSessionId).toBeNull();
    expect(session.usage.contextWindow).toBeNull();

    const done = untilTurnDone(engine, session.id);
    engine.sendTurn(session.id, 'NEW add a health check');
    const events = await done;
    expect(events.map((e) => e.type)).toEqual([
      'user-message', 'turn-started', 'remote-status', 'assistant-message', 'remote-pr', 'remote-status', 'turn-done',
    ]);
    const after = engine.getSession(session.id)!;
    expect(after.nativeSessionId).toBe('dv_20260927T0500_000001');
    expect(after.status).toBe('idle');
    expect(after.remote).toEqual({ provider: 'devin', lane: 'cloud', url: 'https://app.devin.ai/sessions/devin-abc', state: 'waiting', acusConsumed: 1.25, acuCap: 10 });
    const pr = events.find((e) => e.type === 'remote-pr');
    expect(pr).toMatchObject({ provider: 'devin', url: 'https://github.com/ashlrai/devin-canary/pull/9', state: 'open' });

    // The request travelled on stdin; argv carried nothing of it.
    const [first] = calls();
    expect(first!.req).toMatchObject({ v: 1, lane: 'cloud', verseSessionId: session.id, nativeId: null, text: 'NEW add a health check' });
    expect(first!.argv).toEqual([]);

    // Second turn resumes the same task; the readiness gate saw the session.
    const done2 = untilTurnDone(engine, session.id, events.at(-1)!.seq);
    engine.sendTurn(session.id, 'and a test');
    await done2;
    expect(calls()[1]!.req).toMatchObject({ nativeId: 'dv_20260927T0500_000001', text: 'and a test' });
    expect(readinessCalls).toEqual([
      { seatId: 'devin', native: null },
      { seatId: 'devin', native: 'dv_20260927T0500_000001' },
    ]);

    // Persisted (two turns × two statuses + one PR card), and valid on re-read.
    const replay = engine.getEvents(session.id).filter((e) => e.type === 'remote-status' || e.type === 'remote-pr');
    expect(replay.length).toBe(6);
    const reopened = createVerseEngine({ root: join(work, 'root'), readiness: null, reasoningTap: null, preflight: null });
    try {
      expect(reopened.getSession(session.id)!.remote).toMatchObject({ state: 'waiting', acusConsumed: 1.25 });
      expect(reopened.getEvents(session.id).filter((e) => e.type === 'remote-status' || e.type === 'remote-pr')).toHaveLength(6);
    } finally {
      reopened.close();
    }
  });

  it('a lost Devin session is retried once on a fresh one, seeded with the handoff note', async () => {
    const session = engine.createSession({ projectPath: project, seatId: 'devin' }, launch);
    const d1 = untilTurnDone(engine, session.id);
    engine.sendTurn(session.id, 'NEW start');
    const first = await d1;
    const d2 = untilTurnDone(engine, session.id, first.at(-1)!.seq);
    engine.sendTurn(session.id, 'GONE are you there?');
    const events = await d2;
    expect(events.map((e) => e.type)).toContain('recovered');
    expect(events.at(-1)).toMatchObject({ type: 'turn-done', ok: true });
    const retry = calls()[2]!.req as { nativeId: string | null; text: string };
    expect(retry.nativeId).toBeNull();
    expect(retry.text).toMatch(/# Continuing from an earlier Verse session/);
    expect(retry.text).toMatch(/GONE are you there\?$/);
  });

  it('the Devin budget refuses a NEW session with its reason (409), before anything is recorded', () => {
    refuseNew = true;
    const session = engine.createSession({ projectPath: project, seatId: 'devin' }, launch);
    expect(() => engine.sendTurn(session.id, 'NEW hi')).toThrow(expect.objectContaining({
      code: 'VERSE_SEAT_NOT_READY',
      status: 409,
      message: expect.stringMatching(/^Devin budget: /),
    }));
    expect(engine.getEvents(session.id)).toEqual([]);
    expect(calls()).toEqual([]);
  });

  it('recordRemoteStatus (terminate) folds into the header outside any turn', () => {
    const session = engine.createSession({ projectPath: project, seatId: 'devin' }, launch);
    const next = engine.recordRemoteStatus!(session.id, { state: 'terminated', message: 'You terminated the Devin session.', url: 'https://app.devin.ai/sessions/devin-abc', acusConsumed: 2, acuCap: 10 });
    expect(next.remote).toMatchObject({ state: 'terminated', acusConsumed: 2 });
    expect(engine.getEvents(session.id).at(-1)).toMatchObject({ type: 'remote-status', turnId: null, state: 'terminated' });
  });
});

describe('the real turn process entry point', () => {
  function run(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const [bin, ...args] = devinChatTurnArgv();
    return new Promise((resolve) => {
      const child = spawn(bin!, args, { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it('argv is operand-free; a bad request does nothing and says so on stdout only (exit 2)', async () => {
    expect(devinChatTurnArgv().some((a) => a.includes('cog_'))).toBe(false);
    const out = await run('{"v":1,"lane":"nope"}');
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout.trim())).toEqual({ type: 'error', message: 'The Devin turn was started without a valid request.' });
    expect(out.stderr).toBe('');
  }, 30_000);

  it('a CLI-lane request whose binary is missing fails cleanly, without touching the network', async () => {
    const payload = { v: 1, lane: 'cli', verseSessionId: 'abc-123', nativeId: null, projectPath: work, text: 'hi', permissionMode: 'accept-edits', cliPath: join(work, 'no-such-devin'), model: null };
    const out = await run(JSON.stringify(payload));
    expect(out.code).toBe(1);
    const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; message?: string });
    expect(lines.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/could not be started/) });
  }, 30_000);
});

