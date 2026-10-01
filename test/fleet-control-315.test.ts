/**
 * 3.15 — the Fleet control surface.
 *
 *   - the pure verdict: one sentence, one blocker in the order Mason fixes
 *     things, and which of Start / Pause / Resume / Stop apply;
 *   - run-cancel: a per-run stop request any process can make and the run's
 *     lease probe reads (lowering only, TTL-bound);
 *   - operator task edits (priority, retarget, steer + requeue);
 *   - the route: GET state / queue / run log, POST actions behind the dispatch
 *     + mutation-token gate, validation, idempotency, and a state that is READ
 *     BACK after every action (fakes stand in for the daemon and authority —
 *     the real ones are covered by their own suites).
 *
 * HOME-isolated: run-cancel and the task queue write under a temporary home.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFleetControlState, fleetControlVerdict, type FleetControlInputs } from '../src/core/fleet/fleet-control-model.js';
import type { FleetControlDeps } from '../src/core/fleet/fleet-control.js';
import { projectFleetControlTickProgress } from '../src/core/fleet/fleet-control.js';
import type { DaemonLivenessV1 } from '../src/core/daemon/liveness.js';
import type { DaemonTickProgressRead } from '../src/core/daemon/tick-progress.js';
import { requestRunCancel, runCancelRequested, RUN_CANCEL_TTL_MS, sweepRunCancelRequests } from '../src/core/fleet/run-cancel.js';
import { editTaskAsOperator, enqueueTask, readTaskQueue } from '../src/core/fleet/task-source.js';
import { handleFleetControlApi, setFleetControlDepsForTest } from '../src/core/verse/fleet-control-api.js';
import type { AuthorityStatusV1 } from '../src/core/authority/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { withTempHome } from './helpers/authority-310b.js';

let restore: () => void;
beforeEach(() => {
  restore = withTempHome('fleet-control-').restore;
});
afterEach(() => {
  setFleetControlDepsForTest(null);
  restore();
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

function inputs(over: Partial<FleetControlInputs> = {}, grant: Partial<FleetControlInputs['grant']> = {}): FleetControlInputs {
  return {
    nowMs: Date.parse('2026-09-27T12:00:00.000Z'),
    grant: {
      state: 'active',
      seq: 2,
      repos: ['ashlrai/fleet-canary'],
      engines: ['local'],
      expiresAt: '2026-10-26T00:00:00.000Z',
      daysLeft: 28,
      stageId: 'shadow',
      stageIndex: 0,
      stageCount: 8,
      switch: 'autonomous',
      effectiveSwitch: 'autonomous',
      maxSwitchWithoutGrant: 'autonomous',
      reason: null,
      ...grant,
    },
    custody: { installed: true, keyInitialized: true, hubCheckout: '~/code/ashlr-hub' },
    trustRootsCompiled: true,
    kill: false,
    paused: false,
    pausedAt: null,
    liveness: { state: 'alive', pid: 42, lastTickAt: null, reason: 'the daemon is running' },
    service: 'running',
    plist: 'current',
    working: 3,
    spend: { todayUsd: 1, capUsd: 20 },
    ...over,
  };
}

describe('fleetControlVerdict', () => {
  const tickProgress = { phase: 'selection and dispatch', detail: null,
    tickStartedAt: '2026-09-27T11:59:00.000Z', phaseStartedAt: '2026-09-27T11:59:30.000Z',
    summary: 'tick in progress: selection and dispatch for 30s' };
  it('says what the fleet is doing in one sentence', () => {
    expect(fleetControlVerdict(inputs())).toMatchObject({ state: 'running', headline: 'Running · 3 agents working · stage shadow', blocker: null });
    expect(fleetControlVerdict(inputs({ working: 0 }))).toMatchObject({ state: 'idle' });
    expect(fleetControlVerdict(inputs({}, { effectiveSwitch: 'propose', switch: 'propose' }))).toMatchObject({ state: 'running', headline: expect.stringMatching(/^Proposing/) });
    expect(fleetControlVerdict(inputs({ paused: true }))).toMatchObject({ state: 'paused', headline: 'Paused · 3 agents finishing, nothing new starts' });
    expect(fleetControlVerdict(inputs({ kill: true, working: 0 }))).toMatchObject({ state: 'stopped', blocker: null });
    expect(fleetControlVerdict(inputs({}, { switch: 'off', effectiveSwitch: 'off' }))).toMatchObject({ state: 'off' });
  });

  it('names ONE blocker, in the order Mason fixes things', () => {
    // Custody before the grant before the daemon.
    const all = inputs({ custody: { installed: false, keyInitialized: null, hubCheckout: null }, service: 'absent', liveness: { state: 'stopped', pid: null, lastTickAt: null, reason: 'x' } }, { state: 'none' });
    expect(fleetControlVerdict(all).blocker?.action.kind).toBe('install-custody');
    expect(fleetControlVerdict({ ...all, custody: { installed: true, keyInitialized: true, hubCheckout: null } }).blocker?.action.kind).toBe('grant');
    expect(fleetControlVerdict({ ...all, custody: { installed: true, keyInitialized: true, hubCheckout: null }, trustRootsCompiled: false }).blocker?.action.kind).toBe('setup');
    expect(fleetControlVerdict(inputs({}, { state: 'expired' })).blocker?.action.kind).toBe('re-approve');
    expect(fleetControlVerdict(inputs({ service: 'absent', liveness: { state: 'stopped', pid: null, lastTickAt: null, reason: 'x' } })).blocker?.action).toMatchObject({ kind: 'resident-start', native: true });
    expect(fleetControlVerdict(inputs({ spend: { todayUsd: 20, capUsd: 20 } })).blocker?.action.kind).toBe('wait');
  });

  it('reports a current tick preparing work without inventing working agents', () => {
    const state = buildFleetControlState(inputs({ working: 0,
      liveness: { state: 'alive', pid: 42, lastTickAt: '2026-09-25T12:00:00.000Z', reason: 'alive', tickProgress } }));
    expect(state).toMatchObject({ state: 'running', headline: 'Running · preparing work: selection and dispatch · stage shadow',
      agents: { working: 0 }, daemon: { tickProgress } });
  });

  it.each(['stale', 'stopped', 'unknown'] as const)('ignores %s tick observations despite a service label', (state) => {
    const result = buildFleetControlState(inputs({ working: 0,
      liveness: { state, pid: 42, lastTickAt: null, reason: 'unconfirmed', tickProgress } }));
    expect(result.state).toBe('idle');
    expect(result.daemon.tickProgress).toBeUndefined();
  });

  it('keeps Stop, pause, grant, switch and budget precedence over tick preparation', () => {
    const preparing = inputs({ working: 0, liveness: { state: 'alive', pid: 42, lastTickAt: null, reason: 'alive', tickProgress } });
    expect(fleetControlVerdict({ ...preparing, kill: true }).state).toBe('stopped');
    expect(fleetControlVerdict({ ...preparing, paused: true }).state).toBe('paused');
    expect(fleetControlVerdict({ ...preparing, grant: { ...preparing.grant, state: 'paused' } }).state).toBe('blocked');
    expect(fleetControlVerdict({ ...preparing, grant: { ...preparing.grant, effectiveSwitch: 'off' } }).state).toBe('off');
    expect(fleetControlVerdict({ ...preparing, spend: { todayUsd: 20, capUsd: 20 } }).state).toBe('blocked');
  });

  it('flags a daemon running an older plist without calling the fleet blocked', () => {
    const v = fleetControlVerdict(inputs({ plist: 'drifted' }));
    expect(v.state).toBe('running');
    expect(v.blocker?.action.kind).toBe('resident-restart');
  });

  it('enables exactly the controls that apply', () => {
    const running = buildFleetControlState(inputs());
    expect(running.controls.start.enabled).toBe(false);
    expect(running.controls.pause.enabled).toBe(true);
    expect(running.controls.resume.enabled).toBe(false);
    expect(running.controls.stop.enabled).toBe(true);
    const stopped = buildFleetControlState(inputs({ kill: true, paused: true }));
    expect(stopped.controls.start).toMatchObject({ enabled: true, hint: 'Start clears Stop, then resumes dispatch.' });
    expect(stopped.controls.stop.enabled).toBe(false);
    expect(stopped.controls.pause.enabled).toBe(false);
    const noCustody = buildFleetControlState(inputs({ custody: { installed: false, keyInitialized: null, hubCheckout: null } }));
    expect(noCustody.controls.start.enabled).toBe(false);
    const noGrant = buildFleetControlState(inputs({}, { state: 'none' }));
    expect(noGrant.controls.start).toMatchObject({ enabled: true, hint: expect.stringMatching(/Touch ID/) });
  });
});

describe('current daemon tick projection', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const live: DaemonLivenessV1 = { v: 1, checkedAt: new Date(now).toISOString(), state: 'alive', alive: true, pid: 42,
    recorded: { running: true, pid: 42, startedAt: '2026-09-27T11:00:00.000Z', lastTickAt: '2026-09-25T12:00:00.000Z' },
    lock: null, activity: null, staleRecord: false, reason: 'alive' };
  const tick: DaemonTickProgressRead = { progress: { v: 1, authority: 'none', pid: 42,
    tickStartedAt: '2026-09-27T11:59:00.000Z', phaseStartedAt: '2026-09-27T11:59:30.000Z',
    phase: 'selection and dispatch', detail: null }, tickAgeMs: 60_000, phaseAgeMs: 30_000 };

  it('projects a validated current generation without changing working counts', () => {
    expect(projectFleetControlTickProgress(live, tick, now)).toMatchObject({ phase: 'selection and dispatch',
      summary: 'tick in progress: selection and dispatch for 30s' });
    expect(projectFleetControlTickProgress(live, null, now)).toBeNull();
  });

  it.each(['stale', 'stopped', 'unknown'] as const)('rejects a %s daemon observation', (state) => {
    expect(projectFleetControlTickProgress({ ...live, state }, tick, now)).toBeNull();
  });

  it('rejects mismatched, dead or unproven writers', () => {
    expect(projectFleetControlTickProgress(live, { ...tick, progress: { ...tick.progress, pid: 43 } }, now)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, alive: false }, tick, now)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, pid: null }, tick, now)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, recorded: { ...live.recorded, running: false } }, tick, now)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, recorded: { ...live.recorded, pid: 43 } }, tick, now)).toBeNull();
    expect(projectFleetControlTickProgress(live, tick, Number.NaN)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, recorded: { ...live.recorded, startedAt: null } }, tick, now)).toBeNull();
  });

  it('rejects completed ticks and records from before this daemon generation', () => {
    expect(projectFleetControlTickProgress({ ...live, recorded: { ...live.recorded, lastTickAt: tick.progress.tickStartedAt } }, tick, now)).toBeNull();
    expect(projectFleetControlTickProgress({ ...live, recorded: { ...live.recorded, startedAt: '2026-09-27T11:59:01.000Z' } }, tick, now)).toBeNull();
  });

  it('rejects invalid, future and reversed phase timestamps', () => {
    for (const patch of [{ tickStartedAt: 'bad' }, { phaseStartedAt: '2026-09-27T12:00:01.000Z' }, { phaseStartedAt: '2026-09-27T11:58:59.000Z' }]) {
      expect(projectFleetControlTickProgress(live, { ...tick, progress: { ...tick.progress, ...patch } }, now)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-run stop and operator task edits (real files in a temp HOME)
// ---------------------------------------------------------------------------

describe('run-cancel', () => {
  it('records one request per run, which the probe reads until it expires', () => {
    expect(runCancelRequested('run-abc')).toBeNull();
    const first = requestRunCancel('run-abc', 'wrong repo');
    expect(first).toMatchObject({ ok: true, already: false });
    expect(requestRunCancel('run-abc', 'again')).toMatchObject({ ok: true, already: true, request: { reason: 'wrong repo' } });
    expect(runCancelRequested('run-abc')).toMatchObject({ runId: 'run-abc', reason: 'wrong repo' });
    expect(runCancelRequested('run-other')).toBeNull();
    const later = Date.now() + RUN_CANCEL_TTL_MS + 60_000;
    expect(runCancelRequested('run-abc', { nowMs: later })).toBeNull();
    expect(sweepRunCancelRequests({ nowMs: later })).toBe(1);
  });

  it('refuses a malformed run id', () => {
    expect(requestRunCancel('../../etc', 'x')).toMatchObject({ ok: false });
    expect(runCancelRequested('a b')).toBeNull();
  });
});

describe('editTaskAsOperator', () => {
  function queued() {
    const r = enqueueTask({ repo: 'ashlrai/fleet-canary', source: 'manual', title: 'Add a test', detail: 'd', difficulty: 'low', value: 2, requestedBy: 'mason' }, { sizeBudget: { files: 4, lines: 150 } });
    if (!r.ok) throw new Error(r.reason);
    return r.task;
  }

  it('reprioritizes, retargets and steers an open task', () => {
    const task = queued();
    expect(editTaskAsOperator({ taskId: task.id, value: 5 })).toMatchObject({ ok: true, task: { value: 5 } });
    expect(editTaskAsOperator({ taskId: task.id, repo: 'ashlrai/ashlrcode' }, { sizeBudget: { files: 4, lines: 150 } })).toMatchObject({ ok: true, task: { repo: 'ashlrai/ashlrcode' } });
    const steered = editTaskAsOperator({ taskId: task.id, note: 'use the existing helper', requeue: true });
    expect(steered.ok).toBe(true);
    if (steered.ok) expect(steered.task.detail).toMatch(/Note from Mason .*: use the existing helper/);
  });

  it('refuses nonsense and finished tasks', () => {
    const task = queued();
    expect(editTaskAsOperator({ taskId: task.id })).toMatchObject({ ok: false, reason: 'Nothing to change.' });
    expect(editTaskAsOperator({ taskId: task.id, value: 9 })).toMatchObject({ ok: false });
    expect(editTaskAsOperator({ taskId: task.id, repo: 'not a repo' })).toMatchObject({ ok: false });
    expect(editTaskAsOperator({ taskId: '00000000-0000-0000-0000-000000000000', value: 3 })).toMatchObject({ ok: false });
    const read = readTaskQueue();
    expect(read.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const TOKEN = 'fleet-control-token';
const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };

function authority(over: Partial<AuthorityStatusV1> = {}, grant: Partial<AuthorityStatusV1['grant']> = {}): AuthorityStatusV1 {
  return {
    v: 1,
    checkedAt: new Date().toISOString(),
    switch: 'autonomous',
    effectiveSwitch: 'autonomous',
    maxSwitchWithoutGrant: 'autonomous',
    kill: false,
    grant: { state: 'active', reason: null, grantId: 'g', grantSeq: 2, keyId: 'k', issuedAt: null, expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), repos: [], engines: ['local'], maxMode: 'balanced', stageIds: ['shadow'], ...grant },
    rollout: null,
    policy: null,
    ledger: { state: 'ok', head: null, reason: null },
    custody: { installed: true, keyInitialized: true, githubApp: true, claudeToken: true },
    ...over,
  } as unknown as AuthorityStatusV1;
}

/** A fake fleet: the effects change its state, and reads see the change. */
function fakeFleet() {
  const s = { kill: false, paused: false, switch: 'autonomous' as 'off' | 'propose' | 'autonomous', service: 'running' as 'running' | 'absent', grant: 'active' as string, calls: [] as string[] };
  const deps: FleetControlDeps = {
    now: () => Date.now(),
    authority: async () => authority({ kill: s.kill, switch: s.switch, effectiveSwitch: s.switch }, { state: s.grant as 'active' }),
    pause: () => ({ paused: s.paused, pausedAt: s.paused ? new Date().toISOString() : null }),
    liveness: () => ({ state: s.service === 'running' ? 'alive' : 'stopped', pid: null, lastTickAt: null, reason: 'fake' }),
    service: async () => ({ service: s.service, plist: 'current' }),
    working: () => 0,
    spend: async () => ({ todayUsd: 0, capUsd: 20 }),
    hubCheckout: async () => null,
    trustRootsCompiled: () => true,
    setPause: (paused) => {
      s.calls.push(paused ? 'pause' : 'resume');
      const changed = s.paused !== paused;
      s.paused = paused;
      return { ok: true, changed, reason: changed ? 'ok' : 'already' };
    },
    stop: async () => {
      s.calls.push('stop');
      s.kill = true;
      return { armed: true, reason: 'armed', aborted: 0 };
    },
    clearStop: () => {
      s.calls.push('clear-stop');
      s.kill = false;
      return { ok: true, reason: 'cleared' };
    },
    raiseSwitch: () => {
      s.calls.push('switch');
      s.switch = 'autonomous';
      return { ok: true, code: null, reason: 'ok' };
    },
    cancelRun: (runId, reason) => {
      s.calls.push(`cancel:${runId}`);
      return { ok: true, already: false, request: { v: 1, runId, reason, requestedAt: new Date().toISOString(), by: 'mason' } };
    },
    editTask: (edit) => {
      s.calls.push(`edit:${edit.taskId}:${edit.requeue === true ? 'requeue' : ''}`);
      return { ok: true, task: {} as never };
    },
    cancelTask: (taskId) => {
      s.calls.push(`task-cancel:${taskId}`);
      return { ok: true, task: {} as never };
    },
    enqueueTask: (input) => {
      s.calls.push(`enqueue:${input.repo}`);
      return { ok: true, task: {} as never, deduped: false };
    },
    tasks: () => ({ ok: true, tasks: [] } as never),
    goals: async () => [],
    retargetGoal: async () => ({ ok: true, reason: 'retargeted' }),
    enrolledPaths: async () => ['~/code/a'],
    grantedRepos: async () => ['ashlrai/fleet-canary'],
    readRunLog: async () => ({ available: false, reason: 'off', lines: [], truncated: false }),
  };
  return { s, deps };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0;
  let payload = '';
  const fake = { headersSent: false };
  const res = Object.assign(fake, {
    writeHead(code: number) {
      status = code;
      fake.headersSent = true;
      return fake;
    },
    end(chunk?: string) {
      payload = chunk ?? '';
      return fake;
    },
  }) as unknown as ServerResponse;
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleFleetControlApi(ctx, req, res, path, method);
  if (!handled) return null;
  return { status, body: JSON.parse(payload || 'null') as Record<string, unknown> };
}

describe('/api/verse/fleet/control', () => {
  it('owns only its own paths', async () => {
    for (const path of ['/api/verse/fleet', '/api/verse/fleet/live', '/api/verse/fleet/history', '/api/verse/fleet/controlx']) {
      expect(await call('GET', path)).toBeNull();
    }
  });

  it('GET answers the state, the queue and a run log', async () => {
    setFleetControlDepsForTest(fakeFleet().deps);
    const state = await call('GET', '/api/verse/fleet/control');
    expect(state?.status).toBe(200);
    expect(state?.body).toMatchObject({ v: 1, state: 'idle', controls: { stop: { enabled: true } } });
    expect((await call('GET', '/api/verse/fleet/control?x=1'))?.status).toBe(400);
    expect((await call('GET', '/api/verse/fleet/control/queue'))?.body).toMatchObject({ v: 1, tasks: [], targets: { repos: ['ashlrai/fleet-canary'] } });
    expect((await call('GET', '/api/verse/fleet/control/runs/run-1/log'))?.body).toMatchObject({ v: 1, runId: 'run-1', available: false });
    expect((await call('GET', '/api/verse/fleet/control/runs/a%20b/log'))?.status).toBe(400);
  });

  it('POST needs the mutation token and dispatch, and refuses unknown shapes', async () => {
    setFleetControlDepsForTest(fakeFleet().deps);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'pause' }, { 'x-ashlr-token': 'nope' }))?.status).toBe(401);
    const readOnly = { ...ctx, allowDispatch: false };
    const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
    Object.assign(req, { method: 'POST', url: '/api/verse/fleet/control', headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN } });
    req.end('{"action":"pause"}');
    let status = 0;
    const res = { headersSent: false, writeHead(code: number) { status = code; return this; }, end() { return this; } } as unknown as ServerResponse;
    await handleFleetControlApi(readOnly, req, res, '/api/verse/fleet/control', 'POST');
    expect(status).toBe(404);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'launch-missiles' }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'pause', extra: 1 }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'stop-run', runId: 'task:abc' }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'interject', note: 'x' }))?.status).toBe(400);
    expect((await call('POST', '/api/verse/fleet/control', { action: 'task-edit', taskId: 'nope', value: 3 }))?.status).toBe(400);
  });

  it('Pause / Resume / Stop are idempotent and the answer is read back', async () => {
    const { s, deps } = fakeFleet();
    setFleetControlDepsForTest(deps);
    const paused = await call('POST', '/api/verse/fleet/control', { action: 'pause' });
    expect(paused?.body).toMatchObject({ ok: true, did: [expect.stringMatching(/^Paused dispatch/)], state: { state: 'paused', paused: true } });
    expect((await call('POST', '/api/verse/fleet/control', { action: 'pause' }))?.body).toMatchObject({ did: [], state: { paused: true } });
    expect((await call('POST', '/api/verse/fleet/control', { action: 'resume' }))?.body).toMatchObject({ did: ['Resumed dispatch.'], state: { paused: false } });
    expect((await call('POST', '/api/verse/fleet/control', { action: 'stop' }))?.body).toMatchObject({ state: { state: 'stopped', kill: true } });
    expect((await call('POST', '/api/verse/fleet/control', { action: 'stop' }))?.body).toMatchObject({ did: [] });
    expect(s.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('Start does what it can and names what only Mason can do', async () => {
    const { s, deps } = fakeFleet();
    setFleetControlDepsForTest(deps);
    s.kill = true;
    s.paused = true;
    s.switch = 'off';
    s.service = 'absent';
    const started = await call('POST', '/api/verse/fleet/control', { action: 'start' });
    expect(started?.body).toMatchObject({
      did: ['Switched to Autonomous.', 'Cleared Stop.', 'Resumed dispatch.'],
      needs: { kind: 'resident-start', native: true },
      state: { kill: false, paused: false, state: 'blocked' },
    });
    // An unusable grant must leave both safety clamps in place.
    for (const grant of ['none', 'revoked', 'invalid', 'expired', 'paused']) {
      s.grant = grant;
      s.kill = true;
      s.paused = true;
      s.switch = 'off';
      s.calls.length = 0;
      const result = await call('POST', '/api/verse/fleet/control', { action: 'start' });
      expect(result?.body).toMatchObject({ did: [], needs: { kind: grant === 'expired' || grant === 'paused' ? 're-approve' : 'grant' } });
      expect(s).toMatchObject({ kill: true, paused: true, switch: 'off', calls: [] });
    }
  });

  it('stop-run and interject stop the run and requeue with the note', async () => {
    const { s, deps } = fakeFleet();
    setFleetControlDepsForTest(deps);
    const taskId = '11111111-2222-3333-4444-555555555555';
    expect((await call('POST', '/api/verse/fleet/control', { action: 'stop-run', runId: 'run-7' }))?.body).toMatchObject({ did: [expect.stringMatching(/Asked the run to stop/)] });
    const steered = await call('POST', '/api/verse/fleet/control', { action: 'interject', runId: 'run-7', taskId, note: 'use the fixture helper' });
    expect(steered?.body).toMatchObject({ mode: 'stop-and-requeue' });
    expect(s.calls).toContain(`edit:${taskId}:requeue`);
    const followUp = await call('POST', '/api/verse/fleet/control', { action: 'interject', repo: 'ashlrai/fleet-canary', title: 'Fix lint', note: 'only the web folder' });
    expect(followUp?.body).toMatchObject({ mode: 'requeue', did: ['Queued a follow-up task carrying your note.'] });
    const before = s.calls.length;
    expect((await call('POST', '/api/verse/fleet/control', { action: 'interject', runId: 'run-9', repo: 'someone/else', title: 'Unsafe', note: 'no' }))?.body).toMatchObject({ code: 'repo-not-granted' });
    expect(s.calls).toHaveLength(before);
  });

  it('a task may be retargeted only to a granted repo', async () => {
    setFleetControlDepsForTest(fakeFleet().deps);
    const taskId = '11111111-2222-3333-4444-555555555555';
    expect((await call('POST', '/api/verse/fleet/control', { action: 'task-edit', taskId, repo: 'someone/else' }))?.body).toMatchObject({ code: 'repo-not-granted' });
    expect((await call('POST', '/api/verse/fleet/control', { action: 'task-edit', taskId, repo: 'ashlrai/fleet-canary', value: 5 }))?.body).toMatchObject({ did: ['Priority set to 5 of 5.', 'Retargeted to ashlrai/fleet-canary.'] });
  });
});
