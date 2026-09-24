/**
 * V3.10 composer engine behaviour (SPEC-310C §7 C3), against the REAL session
 * engine with an injected fake child process — nothing is ever launched:
 *
 *   - controls apply from the NEXT turn, even while one runs; bypass needs
 *     confirmation; a model switch re-derives the budget;
 *   - the queue drains ONLY after a successful turn, holds after a failure
 *     or a Stop, and "send now" stops the turn and sends next;
 *   - attachments: a message naming one grants exactly its directory;
 *     grok refuses uploads; deleting the chat deletes them;
 *   - peekLiveStatus / turnEndsSince (the engine signatures C1 reads).
 *
 * The engine root and HOME are tmp dirs; the readiness gate, reasoning tap,
 * preflight and process registry are off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseEvent, VerseSeat } from '../src/core/verse/types.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  // No pid: the engine then signals the child itself (never a process group).
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly argv: string[]) {
    super();
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  unref(): void {}
  /** Print claude stream-json lines, then exit. */
  finish(code: number, lines: unknown[] = []): Promise<void> {
    return new Promise((resolve) => {
      for (const line of lines) this.stdout.write(`${JSON.stringify(line)}\n`);
      setImmediate(() => {
        this.exitCode = code;
        this.emit('close', code);
        setImmediate(resolve);
      });
    });
  }
}

interface Harness {
  engine: VerseEngineHandle;
  children: FakeChild[];
  root: string;
}

const HEALTH = { state: 'unknown' as const, summary: null, windows: [], observedAt: null };

const SEATS: Record<'claude' | 'grok' | 'codex', VerseSeat> = {
  claude: {
    id: 'claude-a', engine: 'claude', label: 'Claude', accountId: 'claude-a', contextWindow: 200_000, health: HEALTH, cliVersion: '2.1.280',
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1_000_000, autoCompactAt: 400_000, expansive: { contextWindow: 1_000_000, autoCompactAt: 967_000 }, windowSource: 'cli-catalog' },
      { id: 'claude-haiku-5', label: 'Haiku 5', contextWindow: 200_000, autoCompactAt: 167_000, windowSource: 'cli-catalog' },
      { id: 'claude-next', label: 'Next', contextWindow: 200_000, unavailableReason: 'needs Claude Code 2.1.300' },
    ],
  },
  grok: {
    id: 'grok-a', engine: 'grok', label: 'Grok', accountId: 'grok-a', contextWindow: 500_000, health: HEALTH,
    models: [{ id: 'grok-4.6', label: 'Grok 4.6', contextWindow: 500_000 }],
  },
  codex: {
    id: 'codex-a', engine: 'codex', label: 'Codex', accountId: 'codex-a', contextWindow: 272_000, health: HEALTH,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }],
  },
};

let tmp: string;
let project: string;
let prevHome: string | undefined;
let h: Harness;

function makeHarness(): Harness {
  const children: FakeChild[] = [];
  const root = join(tmp, 'verse');
  const engine = createVerseEngine({
    root,
    readiness: null,
    reasoningTap: null,
    preflight: null,
    processRegistry: false,
    loadConfig: () => undefined,
    log: () => {},
    // The engine only ever calls this with (bin, args, options).
    spawn: ((bin: string, args: string[]) => {
      const child = new FakeChild([bin, ...args]);
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { engine, children, root };
}

function launchFor(engine: 'claude' | 'grok' | 'codex'): VerseSeatLaunch {
  return {
    seat: SEATS[engine],
    launcher: ['/usr/local/bin/node', `/nowhere/native-profiles/${engine}-a/launcher.mjs`],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    thinkingDisplay: false,
  } as VerseSeatLaunch;
}

function create(engine: 'claude' | 'grok' | 'codex' = 'claude'): string {
  return h.engine.createSession({ seatId: SEATS[engine].id, projectPath: project }, launchFor(engine)).id;
}

const OK_LINES = [
  { type: 'system', subtype: 'init', session_id: 'x' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } },
];

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-composer-engine-'));
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  project = join(tmp, 'project');
  mkdirSync(project);
  h = makeHarness();
});

afterEach(() => {
  h.engine.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

describe('session controls', () => {
  it('reports effective values and the seat’s options', () => {
    const id = create();
    const view = h.engine.getControls!(id);
    expect(view.controls).toEqual({ model: 'claude-opus-5-5', effort: null, permissionMode: 'accept-edits' });
    expect(view.appliesNextTurn).toBe(false);
    expect(view.options.efforts.filter((o) => o.available).map((o) => o.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(view.options.models.find((m) => m.id === 'claude-next')).toMatchObject({ available: false, reason: 'needs Claude Code 2.1.300' });
  });

  it('a change made mid-turn applies from the NEXT turn; the running argv is untouched', async () => {
    const id = create();
    h.engine.sendTurn(id, 'first');
    const first = h.children[0]!;
    expect(flagValue(first.argv, '--permission-mode')).toBe('acceptEdits');

    const view = h.engine.setControls!(id, { effort: 'high', permissionMode: 'plan' });
    expect(view.appliesNextTurn).toBe(true);
    expect(view.controls).toMatchObject({ effort: 'high', permissionMode: 'plan' });
    expect(flagValue(first.argv, '--permission-mode')).toBe('acceptEdits');

    await first.finish(0, OK_LINES);
    h.engine.sendTurn(id, 'second');
    const second = h.children[1]!;
    expect(flagValue(second.argv, '--permission-mode')).toBe('plan');
    expect(flagValue(second.argv, '--effort')).toBe('high');
    // Persisted on the record, and reset to the default by `null` / accept-edits.
    expect(h.engine.getSession(id)!.controls).toEqual({ effort: 'high', permissionMode: 'plan' });
    await second.finish(0, OK_LINES);
    h.engine.setControls!(id, { effort: null, permissionMode: 'accept-edits' });
    expect(h.engine.getSession(id)!.controls).toBeUndefined();
  });

  it('bypass needs confirmation, and an option the seat refuses is a 400 with the reason', () => {
    const id = create();
    expect(() => h.engine.setControls!(id, { permissionMode: 'bypass' })).toThrow(/confirm/);
    expect(h.engine.setControls!(id, { permissionMode: 'bypass', confirmBypass: true }).controls.permissionMode).toBe('bypass');
    expect(() => h.engine.setControls!(id, { effort: 'minimal' })).toThrow(/Low/);
    expect(() => h.engine.setControls!(id, { model: 'claude-next' })).toThrow(/2\.1\.300/);
    expect(() => h.engine.setControls!(id, { model: 'gpt-9' })).toThrow(/not available/);
  });

  it('a model switch takes effect next turn and re-derives the context budget', async () => {
    const id = create();
    h.engine.setContextMode(id, 'expansive');
    expect(h.engine.getSession(id)!.usage.autoCompactAt).toBe(967_000);
    // Idle: re-derived at once; Haiku has no expansive budget → standard.
    h.engine.setControls!(id, { model: 'claude-haiku-5' });
    const after = h.engine.getSession(id)!;
    expect(after.model).toBe('claude-haiku-5');
    expect(after.contextMode).toBe('standard');
    expect(after.usage.contextWindow).toBe(200_000);
    // Running: the record says the new model; the budget follows at settle.
    h.engine.sendTurn(id, 'go');
    h.engine.setControls!(id, { model: 'claude-opus-5-5' });
    expect(h.engine.getSession(id)!.model).toBe('claude-opus-5-5');
    await h.children[0]!.finish(0, OK_LINES);
    expect(h.engine.getSession(id)!.usage.autoCompactAt).toBe(400_000);
    h.engine.sendTurn(id, 'next');
    expect(flagValue(h.children[1]!.argv, '--model')).toBe('claude-opus-5-5');
  });

  it('new chats start from the saved defaults, never from bypass', () => {
    expect(() => h.engine.setControlDefaults!({ permissionMode: 'bypass' as 'plan' })).toThrow(/per chat/);
    h.engine.setControlDefaults!({ permissionMode: 'plan' });
    h.engine.setControlDefaults!({ seatId: 'claude-a', effort: 'max' });
    const id = create();
    expect(h.engine.getSession(id)!.controls).toEqual({ effort: 'max', permissionMode: 'plan' });
    expect(statSync(join(h.root, 'control-defaults.json')).mode & 0o777).toBe(0o600);
    // Grok takes plan but not "max".
    const grok = create('grok');
    expect(h.engine.getSession(grok)!.controls).toEqual({ permissionMode: 'plan' });
  });
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe('queued follow-ups', () => {
  it('drain ONLY after a successful turn, one at a time, in order', async () => {
    const id = create();
    h.engine.sendTurn(id, 'first');
    expect(h.engine.enqueueTurn!(id, 'second').sentTurnId).toBeNull();
    h.engine.enqueueTurn!(id, 'third');
    expect(h.engine.getQueue!(id).items.map((i) => i.text)).toEqual(['second', 'third']);

    await h.children[0]!.finish(0, OK_LINES);
    await tick();
    expect(h.children).toHaveLength(2);
    expect(h.children[1]!.argv.at(-1)).toBe('second');
    expect(h.engine.getQueue!(id).items.map((i) => i.text)).toEqual(['third']);

    await h.children[1]!.finish(0, OK_LINES);
    await tick();
    expect(h.children[2]!.argv.at(-1)).toBe('third');
    expect(h.engine.getQueue!(id).items).toEqual([]);
  });

  it('HOLD after a failed turn, and after a Stop — nothing is sent blind', async () => {
    const id = create();
    h.engine.sendTurn(id, 'first');
    h.engine.enqueueTurn!(id, 'follow-up');
    await h.children[0]!.finish(1, [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] }]);
    await tick();
    expect(h.children).toHaveLength(1);
    expect(h.engine.getQueue!(id)).toMatchObject({ held: true, heldReason: expect.stringContaining('failed') });
    expect(h.engine.queueNeedsYou!()).toEqual([expect.objectContaining({
      id: `chats:queue-held:${id}`, kind: 'queue-held', source: 'chats',
      target: { kind: 'session', sessionId: id },
      actions: [expect.objectContaining({ label: 'Send next', request: expect.objectContaining({ path: expect.stringMatching(new RegExp(`^/api/verse/queue/${id}/[0-9a-f]{12}/send$`)) }) })],
    })]);

    // It is a well-formed R1 item the drawer can act on.
    expect(h.engine.queueNeedsYou!().every(isNeedsYouItem)).toBe(true);

    // The operator sends it: the queue releases and the turn starts.
    const qid = h.engine.getQueue!(id).items[0]!.id;
    expect(h.engine.sendQueuedTurn!(id, qid).sentTurnId).toEqual(expect.any(String));
    expect(h.children[1]!.argv.at(-1)).toBe('follow-up');
    expect(h.engine.queueNeedsYou!()).toEqual([]);

    // Stop holds too.
    h.engine.enqueueTurn!(id, 'after stop');
    h.engine.cancelTurn(id);
    await tick(6);
    expect(h.children).toHaveLength(2);
    expect(h.engine.getQueue!(id)).toMatchObject({ held: true, heldReason: expect.stringContaining('stopped') });
  });

  it('a HELD queue stays held through a turn the operator sends directly', async () => {
    const id = create();
    h.engine.sendTurn(id, 'first');
    h.engine.enqueueTurn!(id, 'waiting');
    await h.children[0]!.finish(1, []);
    expect(h.engine.getQueue!(id).held).toBe(true);
    h.engine.sendTurn(id, 'a direct message');
    await h.children[1]!.finish(0, OK_LINES);
    await tick();
    expect(h.children).toHaveLength(2);
    expect(h.engine.getQueue!(id)).toMatchObject({ held: true, items: [expect.objectContaining({ text: 'waiting' })] });
  });

  it('stop-and-send (sendNow) stops the running turn and sends that message next', async () => {
    const id = create();
    h.engine.sendTurn(id, 'long task');
    h.engine.enqueueTurn!(id, 'queued earlier');
    const result = h.engine.enqueueTurn!(id, 'change of plan', { sendNow: true });
    expect(result.items.map((i) => i.text)).toEqual(['change of plan', 'queued earlier']);
    expect(h.children[0]!.signalCode).toBe('SIGINT');
    await tick(6);
    expect(h.children[1]!.argv.at(-1)).toBe('change of plan');
    expect(h.engine.getQueue!(id)).toMatchObject({ held: false, items: [expect.objectContaining({ text: 'queued earlier' })] });
  });

  it('with nothing running and nothing waiting, a queued message is simply sent', () => {
    const id = create();
    const result = h.engine.enqueueTurn!(id, 'hello');
    expect(result.sentTurnId).toEqual(expect.any(String));
    expect(h.children[0]!.argv.at(-1)).toBe('hello');
  });

  it('caps the queue at 3 and lets an item be removed', () => {
    const id = create();
    h.engine.sendTurn(id, 'running');
    for (const text of ['a', 'b', 'c']) h.engine.enqueueTurn!(id, text);
    expect(() => h.engine.enqueueTurn!(id, 'd')).toThrow(/up to 3/);
    const qid = h.engine.getQueue!(id).items[1]!.id;
    expect(h.engine.removeQueuedTurn!(id, qid).items.map((i) => i.text)).toEqual(['a', 'c']);
    expect(() => h.engine.removeQueuedTurn!(id, qid)).toThrow(/no longer queued/);
  });

  it('a queue left waiting across a restart is held, not silently parked', () => {
    const id = create();
    h.engine.sendTurn(id, 'running');
    h.engine.enqueueTurn!(id, 'later');
    // A crash: running turns are settled as interrupted → the queue holds.
    h.engine.interruptAll!('test crash');
    const next = makeHarness();
    try {
      expect(next.engine.getQueue!(id)).toMatchObject({ held: true, items: [expect.objectContaining({ text: 'later' })] });
    } finally {
      next.engine.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe('attachments', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('a message naming an attachment grants EXACTLY that chat folder; one without grants nothing', async () => {
    const id = create();
    const item = h.engine.saveAttachment!(id, { name: 'spec.md', mime: 'text/markdown', dataBase64: b64('# spec') });
    const dir = join(h.root, 'attachments', id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(item.ref.slice(1)).mode & 0o777).toBe(0o600);

    h.engine.sendTurn(id, 'no files here');
    expect(h.children[0]!.argv).not.toContain('--add-dir');
    await h.children[0]!.finish(0, OK_LINES);

    // The composer shows the token `~`-relative (API output is sanitised).
    const tilde = item.ref.replace(`@${process.env.HOME}`, '@~');
    h.engine.sendTurn(id, `summarise ${tilde}`);
    const argv = h.children[1]!.argv;
    expect(argv.filter((a) => a === '--add-dir')).toEqual(['--add-dir']);
    expect(flagValue(argv, '--add-dir')).toBe(dir);
    expect(argv.at(-1)).toBe(`summarise ${item.ref}`);
    // The transcript keeps what the operator typed.
    const user = h.engine.getEvents(id).filter((e): e is Extract<VerseEvent, { type: 'user-message' }> => e.type === 'user-message');
    expect(user.at(-1)!.text).toBe(`summarise ${tilde}`);
  });

  it('grok refuses uploads with the reason; delete removes a chat’s files and queue', () => {
    const grok = create('grok');
    expect(() => h.engine.saveAttachment!(grok, { name: 'a.txt', mime: 'text/plain', dataBase64: b64('x') })).toThrow(/Grok can only open files inside the project/);
    const id = create();
    h.engine.saveAttachment!(id, { name: 'a.txt', mime: 'text/plain', dataBase64: b64('x') });
    h.engine.sendTurn(id, 'running');
    h.engine.enqueueTurn!(id, 'later');
    h.engine.deleteSession(id);
    expect(existsSync(join(h.root, 'attachments', id))).toBe(false);
    expect(existsSync(join(h.root, 'queues', `${id}.json`))).toBe(false);
  });

  it('codex receives attached images as --image', () => {
    const id = create('codex');
    const shot = h.engine.saveAttachment!(id, { name: 'shot.png', mime: 'image/png', dataBase64: b64('png') });
    h.engine.sendTurn(id, `look at ${shot.ref}`);
    expect(h.children[0]!.argv).toContain(`--image=${shot.ref.slice(1)}`);
  });
});

// ---------------------------------------------------------------------------
// Engine signatures for activity (C1)
// ---------------------------------------------------------------------------

describe('peekLiveStatus / turnEndsSince', () => {
  it('folds progress and reasoning into a live status, and records each turn end once', async () => {
    const id = create();
    expect(h.engine.peekLiveStatus!(id)).toBeNull();
    h.engine.sendTurn(id, 'go');
    const child = h.children[0]!;
    // Anthropic wire events: a thinking block, then a Bash tool use.
    for (const line of [
      { type: 'system', subtype: 'init', session_id: 'x' },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the tests before editing. ' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } },
    ]) child.stdout.write(`${JSON.stringify(line)}\n`);
    await tick();
    const status = h.engine.peekLiveStatus!(id)!;
    expect(status).toMatchObject({ sessionId: id, phase: 'tool' });
    expect(status.thinkingTail).toContain('Checking the tests');
    expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(status.startedAt)).not.toBeNaN();

    const before = h.engine.turnEndsSince!(0);
    expect(before.ends).toEqual([]);
    await child.finish(0, [{ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }]);
    expect(h.engine.peekLiveStatus!(id)).toBeNull();
    const after = h.engine.turnEndsSince!(before.cursor);
    expect(after.ends).toEqual([expect.objectContaining({ sessionId: id, outcome: 'ok', turnCount: 1 })]);
    expect(h.engine.turnEndsSince!(after.cursor).ends).toEqual([]);

    h.engine.sendTurn(id, 'again');
    h.engine.cancelTurn(id);
    await tick(6);
    expect(h.engine.turnEndsSince!(after.cursor).ends).toEqual([expect.objectContaining({ outcome: 'cancelled' })]);
  });

  it('keeps no thinking tail longer than 160 characters', async () => {
    const id = create();
    h.engine.sendTurn(id, 'go');
    const child = h.children[0]!;
    child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(2_000) } } })}\n`);
    await tick();
    expect(h.engine.peekLiveStatus!(id)!.thinkingTail!.length).toBeLessThanOrEqual(160);
  });
});
