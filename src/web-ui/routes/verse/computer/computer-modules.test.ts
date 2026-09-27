/**
 * Computer use, the Verse window's pure half: the native bridge's feature
 * test and request/answer channel, and the relay runner (forwarding native
 * ops, access / confirm answers, the never-post-twice and stop invariants).
 * Fakes only: no network, no shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  NativeComputerOp,
  VerseComputerCommand,
  VerseComputerCommandResult,
  VerseComputerCommandsResponse,
} from '../../../../core/verse/computer-types.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import type { ComputerApi } from './computer-queries.js';
import { BACKOFF_MAX_MS, BACKOFF_START_MS, clampApproved, startComputerRunner, type ComputerPrompt, type ComputerRunner } from './computer-runner.js';
import {
  hasNativeComputer,
  localRequestId,
  NATIVE_COMPUTER_EVENT,
  nativeComputer,
  parseNativeComputerEvent,
  parsePermissions,
  type NativeComputer,
  type NativeComputerResult,
} from './native-computer.js';

// ---------------------------------------------------------------------------
// native-computer
// ---------------------------------------------------------------------------

function fakeWindow(computer: unknown) {
  const target = new EventTarget();
  return Object.assign(target, { __ASHLR_DESKTOP__: computer === undefined ? undefined : { computer } });
}

function emitOn(win: EventTarget, detail: unknown) {
  win.dispatchEvent(new CustomEvent(NATIVE_COMPUTER_EVENT, { detail }));
}

describe('nativeComputer feature detection', () => {
  const send = () => true;
  it('is null without a desktop bridge, on old or unsupported shells', () => {
    expect(nativeComputer(fakeWindow(undefined))).toBeNull();
    expect(nativeComputer(fakeWindow({ version: 0, capabilities: { supported: true }, send }))).toBeNull();
    expect(nativeComputer(fakeWindow({ version: 1, capabilities: { supported: false }, send }))).toBeNull();
    expect(nativeComputer(fakeWindow({ version: 1, capabilities: {}, send }))).toBeNull();
    expect(nativeComputer(fakeWindow({ version: 1, capabilities: { supported: true }, send: 'nope' }))).toBeNull();
    expect(hasNativeComputer(null)).toBe(false);
  });

  it('is the bridge on a supporting shell', () => {
    const win = fakeWindow({ version: 1, capabilities: { supported: true }, send });
    expect(hasNativeComputer(win)).toBe(true);
    expect(nativeComputer(win)?.version).toBe(1);
  });

  it('send reports a refusal or a throwing bridge as false', () => {
    const sent: unknown[] = [];
    const ok = nativeComputer(fakeWindow({ version: 1, capabilities: { supported: true }, send: (m: unknown) => (sent.push(m), true) }))!;
    expect(ok.send({ op: 'kill' })).toBe(true);
    expect(sent).toEqual([{ op: 'kill' }]);
    const throwing = nativeComputer(fakeWindow({ version: 1, capabilities: { supported: true }, send: () => { throw new Error('x'); } }))!;
    expect(throwing.send({ op: 'kill' })).toBe(false);
  });
});

describe('native request / answer', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves with the result whose req matches, ignoring others', async () => {
    const win = fakeWindow({ version: 1, capabilities: { supported: true }, send: () => true });
    const bridge = nativeComputer(win)!;
    const pending = bridge.request({ op: 'list-apps', req: 'cc_AAAAAAAAAAAA' });
    emitOn(win, { kind: 'result', req: 'cc_BBBBBBBBBBBB', ok: true, data: 'other' });
    emitOn(win, { kind: 'result', req: 'cc_AAAAAAAAAAAA', ok: true, data: { apps: [] } });
    await expect(pending).resolves.toEqual({ kind: 'result', req: 'cc_AAAAAAAAAAAA', ok: true, data: { apps: [] } });
  });

  it('answers a synthetic timeout when native stays silent', async () => {
    vi.useFakeTimers();
    const win = fakeWindow({ version: 1, capabilities: { supported: true }, send: () => true });
    const pending = nativeComputer(win)!.request({ op: 'permissions', req: 'cc_AAAAAAAAAAAA' }, 500);
    vi.advanceTimersByTime(501);
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'timeout', req: 'cc_AAAAAAAAAAAA' });
  });

  it('fails at once when the shell refuses the message', async () => {
    const win = fakeWindow({ version: 1, capabilities: { supported: true }, send: () => false });
    await expect(nativeComputer(win)!.request({ op: 'permissions', req: 'cc_AAAAAAAAAAAA' })).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('parses events strictly', () => {
    expect(parseNativeComputerEvent(null)).toBeNull();
    expect(parseNativeComputerEvent({ kind: 'result', ok: true })).toBeNull();
    expect(parseNativeComputerEvent({ kind: 'result', req: 'r', ok: false, code: 'made-up', error: 'x'.repeat(2000) })).toEqual({
      kind: 'result', req: 'r', ok: false, code: 'failed', error: 'x'.repeat(500),
    });
    expect(parseNativeComputerEvent({ kind: 'result', req: 'r', ok: false, code: 'no-permission' })).toMatchObject({ code: 'no-permission' });
    expect(parseNativeComputerEvent({ kind: 'state', state: 'bogus' })).toBeNull();
    expect(parseNativeComputerEvent({ kind: 'state', state: 'killed', reason: 'escape', app: 'Mail' })).toEqual({ kind: 'state', state: 'killed', reason: 'escape', app: 'Mail' });
    expect(parseNativeComputerEvent({ kind: 'state', state: 'active', reason: 'nope' })).toEqual({ kind: 'state', state: 'active' });
  });

  it('delivers state events to onState only', () => {
    const win = fakeWindow({ version: 1, capabilities: { supported: true }, send: () => true });
    const seen: unknown[] = [];
    const off = nativeComputer(win)!.onState((e) => seen.push(e));
    emitOn(win, { kind: 'result', req: 'r', ok: true, data: 1 });
    emitOn(win, { kind: 'state', state: 'paused', reason: 'operator-input' });
    off();
    emitOn(win, { kind: 'state', state: 'idle' });
    expect(seen).toEqual([{ kind: 'state', state: 'paused', reason: 'operator-input' }]);
  });

  it('makes request ids in the relay shape', () => {
    expect(localRequestId()).toMatch(/^cc_[A-Za-z0-9_-]{12}$/);
  });

  it('reads the permissions answer leniently, never guessing "granted"', () => {
    expect(parsePermissions({ screen: true, accessibility: false })).toEqual({ screen: 'granted', accessibility: 'missing' });
    expect(parsePermissions({ permissions: { screen: 'granted', accessibility: 'not-determined' } })).toEqual({ screen: 'granted', accessibility: 'missing' });
    expect(parsePermissions({ screen: { granted: true }, accessibility: { status: 'denied' } })).toEqual({ screen: 'granted', accessibility: 'missing' });
    expect(parsePermissions('garbage')).toEqual({ screen: 'unknown', accessibility: 'unknown' });
    expect(parsePermissions({ screen: 'maybe' })).toEqual({ screen: 'unknown', accessibility: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------

const ID1 = 'cc_AAAAAAAAAAA1';
const ID2 = 'cc_AAAAAAAAAAA2';
const ID3 = 'cc_AAAAAAAAAAA3';
const AT = '2026-09-27T10:00:00Z';

function nativeCmd(id: string, op: NativeComputerOp): VerseComputerCommand {
  return { id, sessionId: 's-1', kind: 'native', op, createdAt: AT };
}

function accessCmd(id: string): VerseComputerCommand {
  return {
    id,
    sessionId: 's-1',
    kind: 'access',
    reason: 'Check the build in Xcode',
    createdAt: AT,
    apps: [
      { bundleId: 'com.apple.dt.Xcode', name: 'Xcode', tier: 'click', category: 'terminal-ide', reason: 'Click only', running: true },
      { bundleId: 'com.apple.mail', name: 'Mail', tier: 'full', category: 'other', reason: 'Full', running: false },
      { bundleId: 'com.1password.1password', name: '1Password', tier: null, category: 'denied', reason: 'Never', running: true },
    ],
  };
}

function confirmCmd(id: string): VerseComputerCommand {
  return {
    id,
    sessionId: 's-1',
    kind: 'confirm',
    createdAt: AT,
    confirm: { action: 'click', app: 'Mail', label: 'Send', reason: 'sensitive-label', summary: 'click "Send" in Mail' },
  };
}

interface Harness {
  api: ComputerApi & { results: VerseComputerCommandResult[] };
  native: NativeComputer & { sent: NativeComputerOp[] };
  prompts: ComputerPrompt[];
  needs: unknown[];
  sleeps: number[];
  push(...commands: unknown[]): void;
  runner: ComputerRunner;
}

function harness(opts: {
  answer?: (op: Extract<NativeComputerOp, { req: string }>) => NativeComputerResult;
  canWrite?: () => boolean;
  commandsError?: () => unknown;
} = {}): Harness {
  let queue: unknown[] = [];
  let wake: (() => void) | null = null;
  const results: VerseComputerCommandResult[] = [];
  const api = {
    results,
    commands: vi.fn(async (signal?: AbortSignal): Promise<VerseComputerCommandsResponse> => {
      const err = opts.commandsError?.();
      if (err) throw err;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener('abort', () => resolve());
        });
      }
      const out = queue;
      queue = [];
      return { commands: out as VerseComputerCommand[] };
    }),
    result: vi.fn(async (r: VerseComputerCommandResult) => {
      results.push(r);
    }),
    state: vi.fn(async () => ({ windowPresent: true, chats: [] })),
    revoke: vi.fn(async () => ({ windowPresent: true, chats: [] })),
    kill: vi.fn(async () => ({ windowPresent: true, chats: [] })),
    canWrite: vi.fn(opts.canWrite ?? (() => true)),
  };
  const sent: NativeComputerOp[] = [];
  const native = {
    version: 1,
    sent,
    send: vi.fn((op: NativeComputerOp) => (sent.push(op), true)),
    request: vi.fn(async (op: Extract<NativeComputerOp, { req: string }>) => {
      sent.push(op);
      return opts.answer ? opts.answer(op) : ({ kind: 'result', req: op.req, ok: true, data: { done: op.op } } as NativeComputerResult);
    }),
    onState: vi.fn(() => () => undefined),
  };
  const prompts: ComputerPrompt[] = [];
  const needs: unknown[] = [];
  const sleeps: number[] = [];
  const runner = startComputerRunner({
    api,
    native,
    onPrompt: (p) => prompts.push(p),
    onNeedsPermissions: (p) => needs.push(p),
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
      });
    },
  });
  return {
    api,
    native,
    prompts,
    needs,
    sleeps,
    runner,
    push(...commands) {
      queue.push(...commands);
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

let live: Harness[] = [];
function make(opts?: Parameters<typeof harness>[0]): Harness {
  const h = harness(opts);
  live.push(h);
  return h;
}
afterEach(() => {
  for (const h of live) h.runner.stop();
  live = [];
});

describe('the runner: native commands', () => {
  it('forwards the op to native and posts its answer', async () => {
    const h = make();
    h.push(nativeCmd(ID1, { op: 'list-apps', req: ID1 }));
    await vi.waitFor(() => expect(h.api.results).toHaveLength(1));
    expect(h.native.request).toHaveBeenCalledWith({ op: 'list-apps', req: ID1 }, 60_000);
    expect(h.api.results[0]).toEqual({ id: ID1, ok: true, data: { done: 'list-apps' } });
  });

  it('posts a native failure with its code, and opens onboarding on no-permission', async () => {
    const h = make({ answer: (op) => ({ kind: 'result', req: op.req, ok: false, code: 'no-permission', error: 'Screen Recording is off.' }) });
    h.push(nativeCmd(ID1, { op: 'screenshot', req: ID1, grants: [{ bundleId: 'com.apple.mail', tier: 'full' }] }));
    await vi.waitFor(() => expect(h.api.results).toHaveLength(1));
    expect(h.api.results[0]).toEqual({ id: ID1, ok: false, code: 'no-permission', error: 'Screen Recording is off.' });
    expect(h.needs).toEqual([null]);
  });

  it('refuses operator-only ops (arm, resume, settings) from the relay', async () => {
    const h = make();
    h.push(
      nativeCmd(ID1, { op: 'arm' }),
      nativeCmd(ID2, { op: 'resume' }),
      nativeCmd(ID3, { op: 'request-permission', req: ID3, kind: 'screen' }),
    );
    await vi.waitFor(() => expect(h.api.results).toHaveLength(3));
    expect(h.api.results.every((r) => r.ok === false && r.code === 'invalid')).toBe(true);
    expect(h.native.sent).toEqual([]);
  });

  it('drops commands without a valid id and never handles a re-delivered one twice', async () => {
    const h = make();
    h.push({ id: 'bad', kind: 'native', op: { op: 'list-apps', req: 'bad' } }, nativeCmd(ID1, { op: 'list-apps', req: ID1 }));
    await vi.waitFor(() => expect(h.api.results).toHaveLength(1));
    h.push(nativeCmd(ID1, { op: 'list-apps', req: ID1 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.native.request).toHaveBeenCalledTimes(1);
    expect(h.api.results).toHaveLength(1);
  });
});

describe('the runner: access and confirm', () => {
  it('queues an access prompt and posts only the ticked, grantable apps, clamped', async () => {
    const h = make({
      answer: (op) =>
        op.op === 'permissions'
          ? { kind: 'result', req: op.req, ok: true, data: { screen: true, accessibility: false } }
          : { kind: 'result', req: op.req, ok: true, data: null },
    });
    h.push(accessCmd(ID1));
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.prompts[0]).toMatchObject({ kind: 'access', id: ID1, sessionId: 's-1', reason: 'Check the build in Xcode' });
    await h.runner.answerAccess(ID1, [
      { bundleId: 'com.apple.dt.Xcode', tier: 'full' }, // asks above the offered tier
      { bundleId: 'com.1password.1password', tier: 'read' }, // denied
      { bundleId: 'com.evil.unoffered', tier: 'full' }, // never offered
    ]);
    expect(h.api.results).toEqual([{ id: ID1, ok: true, data: { approved: [{ bundleId: 'com.apple.dt.Xcode', tier: 'click' }] } }]);
    // Arm after a grant, then check permissions — Accessibility missing opens onboarding.
    expect(h.native.sent[0]).toEqual({ op: 'arm' });
    expect(h.native.sent[1]).toMatchObject({ op: 'permissions' });
    expect(h.needs).toEqual([{ screen: 'granted', accessibility: 'missing' }]);
  });

  it('a decline (or nothing grantable) posts ok:false and does not arm', async () => {
    const h = make();
    h.push(accessCmd(ID1), accessCmd(ID2));
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    await h.runner.answerAccess(ID1, null);
    await h.runner.answerAccess(ID2, [{ bundleId: 'com.1password.1password', tier: 'read' }]);
    expect(h.api.results).toEqual([
      { id: ID1, ok: false, error: 'The operator declined.' },
      { id: ID2, ok: false, error: 'The operator declined.' },
    ]);
    expect(h.native.send).not.toHaveBeenCalled();
  });

  it('posts the confirm decision, once', async () => {
    const h = make();
    h.push(confirmCmd(ID1), confirmCmd(ID2));
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    await h.runner.answerConfirm(ID1, 'chat');
    await h.runner.answerConfirm(ID1, 'once');
    await h.runner.answerConfirm(ID2, 'deny');
    expect(h.api.results).toEqual([
      { id: ID1, ok: true, data: { decision: 'chat' } },
      { id: ID2, ok: true, data: { decision: 'deny' } },
    ]);
  });

  it('never answers a kind that does not match, and forgets prompts after KILL without posting', async () => {
    const h = make();
    h.push(confirmCmd(ID1), accessCmd(ID2));
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    await h.runner.answerAccess(ID1, [{ bundleId: 'com.apple.mail', tier: 'full' }]);
    expect(h.api.results).toEqual([]);
    expect(h.runner.forgetPrompts().sort()).toEqual([ID1, ID2]);
    await h.runner.answerConfirm(ID1, 'once');
    await h.runner.answerAccess(ID2, [{ bundleId: 'com.apple.mail', tier: 'full' }]);
    expect(h.api.results).toEqual([]);
  });

  it('clampApproved keeps each offered app once, at most at its tier', () => {
    const apps = (accessCmd(ID1) as Extract<VerseComputerCommand, { kind: 'access' }>).apps;
    expect(clampApproved(apps, [
      { bundleId: 'com.apple.mail', tier: 'read' },
      { bundleId: 'com.apple.mail', tier: 'full' },
    ])).toEqual([{ bundleId: 'com.apple.mail', tier: 'read' }]);
  });
});

describe('the runner: the loop', () => {
  it('stops polling once stopped', async () => {
    const h = make();
    await vi.waitFor(() => expect(h.api.commands).toHaveBeenCalledTimes(1));
    h.runner.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.api.commands).toHaveBeenCalledTimes(1);
  });

  it('does not poll without a mutation token', async () => {
    const h = make({ canWrite: () => false });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.api.commands).not.toHaveBeenCalled();
    expect(h.sleeps.length).toBeGreaterThan(0);
  });

  it('backs off 2 s, doubling to 30 s, on errors; a locked token just waits', async () => {
    const h = make({ commandsError: () => new Error('offline') });
    await vi.waitFor(() => expect(h.sleeps.length).toBeGreaterThanOrEqual(6));
    h.runner.stop();
    expect(h.sleeps.slice(0, 6)).toEqual([BACKOFF_START_MS, 4_000, 8_000, 16_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    const locked = make({ commandsError: () => new VerseMutationLockedError() });
    await vi.waitFor(() => expect(locked.sleeps.length).toBeGreaterThanOrEqual(2));
    expect(new Set(locked.sleeps)).toEqual(new Set([3_000]));
  });
});
