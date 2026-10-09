import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const enrollmentTiming = vi.hoisted(() => {
  const metrics = {
    fsync: { count: 0, totalMs: 0, maxMs: 0, nestedFsyncMs: 0 },
    acquire: { count: 0, totalMs: 0, maxMs: 0, nestedFsyncMs: 0 },
    release: { count: 0, totalMs: 0, maxMs: 0, nestedFsyncMs: 0 },
    enroll: { count: 0, totalMs: 0, maxMs: 0, nestedFsyncMs: 0 },
  };
  const timing = {
    active: false,
    acquisitions: 0,
    fsyncs: 0,
    phases: [] as Array<{ phase: string; atMs: number; fsyncs: number }>,
    startedAt: 0,
    metrics,
    measure<T>(kind: keyof typeof metrics, operation: () => T): T {
      if (!timing.active) return operation();
      const metric = metrics[kind];
      const nestedFsyncBefore = metrics.fsync.totalMs;
      const startedAt = globalThis.performance.now();
      metric.count += 1;
      try {
        return operation();
      } finally {
        const elapsedMs = globalThis.performance.now() - startedAt;
        metric.totalMs += elapsedMs;
        metric.maxMs = Math.max(metric.maxMs, elapsedMs);
        if (kind !== 'fsync') metric.nestedFsyncMs += metrics.fsync.totalMs - nestedFsyncBefore;
      }
    },
  };
  return timing;
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
    if (enrollmentTiming.active) enrollmentTiming.fsyncs += 1;
    return enrollmentTiming.measure('fsync', () => actual.fsyncSync(...args));
  } };
});

vi.mock('../src/core/sandbox/mutation-fence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/mutation-fence.js')>();
  return { ...actual, acquireOutwardMutationFence: (...args: Parameters<typeof actual.acquireOutwardMutationFence>) => {
    if (enrollmentTiming.active) enrollmentTiming.acquisitions += 1;
    return enrollmentTiming.measure('acquire', () => actual.acquireOutwardMutationFence(...args));
  }, releaseOutwardMutationFence: (...args: Parameters<typeof actual.releaseOutwardMutationFence>) =>
    enrollmentTiming.measure('release', () => actual.releaseOutwardMutationFence(...args)) };
});

const privateStorageHarness = vi.hoisted(() => ({ useSemanticAdapter: false }));
const enrollmentHook = vi.hoisted(() => ({ afterApply: null as (() => void) | null }));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/policy.js')>();
  return { ...actual, enroll: (...args: Parameters<typeof actual.enroll>) => {
    const result = enrollmentTiming.measure('enroll', () => actual.enroll(...args));
    enrollmentHook.afterApply?.();
    return result;
  } };
});

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      return actual.assurePrivateStoragePath(...args);
    },
  };
});

import type { AshlrConfig } from '../src/core/types.js';
import { emitFleetEvent, runPulseSync } from '../src/core/integrations/pulse-sync.js';
import { isEnrolled, setKill } from '../src/core/sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';

const cfg = { user: { id: 'm418', name: 'M418' } } as AshlrConfig;

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;

beforeEach(() => {
  enrollmentHook.afterApply = null;
  privateStorageHarness.useSemanticAdapter = false;
  home = join(tmpdir(), `ashlr-m418-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  process.env.PULSE_URL = 'http://pulse.m418.invalid';
  process.env.PULSE_FLEET_PAT = 'm418-test-pat';

  const fence = acquireOutwardMutationFence();
  try {
    if (!ownsOutwardMutationFence(fence)) {
      throw new Error('M418 fixture failed to establish private authority roots');
    }
  } finally {
    releaseOutwardMutationFence(fence);
  }
  privateStorageHarness.useSemanticAdapter = true;
});

afterEach(() => {
  enrollmentHook.afterApply = null;
  enrollmentTiming.active = false;
  privateStorageHarness.useSemanticAdapter = false;
  vi.unstubAllGlobals();
  delete process.env.PULSE_URL;
  delete process.env.PULSE_FLEET_PAT;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M418 Pulse outward-mutation quiescence', () => {
  it('fails closed without HTTP when KILL is already armed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });

    const result = await runPulseSync(cfg, {
      tickTs: '2026-07-14T11:59:00.000Z',
      shipDeps: false,
    });

    expect(result.detail).toMatch(/blocked by global KILL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 15_000);

  it('does not report KILL quiescence while a remote Pulse effect is in flight', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const exporting = emitFleetEvent(cfg, {
      event: 'proposal',
      refId: 'm418-in-flight',
      outcome: 'pending',
    });
    await started.promise;

    const waitStartedAt = performance.now();
    const whileInFlight = setKill(true, { waitMs: 60 });
    const waitedMs = performance.now() - waitStartedAt;

    expect(whileInFlight).toMatchObject({ ok: false, quiesced: false });
    expect(whileInFlight.reason).toMatch(/has not quiesced/i);
    expect(waitedMs).toBeGreaterThanOrEqual(40);

    response.resolve(new Response('{}', { status: 200 }));
    await expect(exporting).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('holds initial tick authority until KILL drains it and starts no command poll', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const running = runPulseSync(cfg, { tickTs: '2026-07-14T12:00:00.000Z', shipDeps: false });
    await started.promise;
    expect(setKill(true, { waitMs: 60 })).toMatchObject({ ok: false, quiesced: false });
    response.resolve(new Response('{}', { status: 200 }));
    const result = await running;
    expect(result.tickEmitted).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.detail).toMatch(/blocked by global KILL/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('enrolls promptly with borrowed authority and keeps the outer Pulse fence held', async () => {
    const repo = join(home, 'remote-enroll');
    let outerFenceHeldDuringWriteback = false;
    const writes: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (enrollmentTiming.active) {
        const endpoint = new URL(url);
        const phase = endpoint.pathname.endsWith('/traces') ? 'tick'
          : endpoint.searchParams.get('status') ?? JSON.parse(String(init?.body))['status'];
        enrollmentTiming.phases.push({ phase, atMs: performance.now() - enrollmentTiming.startedAt, fsyncs: enrollmentTiming.fsyncs });
      }
      if (url.endsWith('/api/otlp/v1/traces')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (url.includes('/api/fleet/commands?')) {
        return Promise.resolve(Response.json({ commands: [{
          id: 'm418-enroll',
          kind: 'enroll_repo',
          target: null,
          payload: { path: repo },
          status: 'pending',
        }] }));
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      if (body['status'] === 'done') {
        const competingFence = acquireOutwardMutationFence(25);
        outerFenceHeldDuringWriteback = competingFence === null;
        releaseOutwardMutationFence(competingFence);
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    enrollmentTiming.acquisitions = 0;
    enrollmentTiming.fsyncs = 0;
    for (const metric of Object.values(enrollmentTiming.metrics)) {
      metric.count = metric.totalMs = metric.maxMs = metric.nestedFsyncMs = 0;
    }
    enrollmentTiming.phases = [];
    enrollmentTiming.active = true;
    const startedAt = performance.now();
    enrollmentTiming.startedAt = startedAt;
    const result = await runPulseSync(cfg, {
      tickTs: '2026-07-14T12:00:00.000Z',
      shipDeps: false,
    });
    const elapsedMs = performance.now() - startedAt;
    enrollmentTiming.active = false;
    const limitMs = process.platform === 'win32' ? 2_000 : 1_000;
    const roundedMs = (value: number) => Math.round(value * 1_000) / 1_000;
    // Inclusive acquire/release/enroll totals contain their nested fsync time;
    // these diagnostic totals must not be added together as an operation budget.
    console.info('[M418 enrollment timing]', JSON.stringify({
      platform: process.platform, elapsedMs: roundedMs(elapsedMs), limitMs,
      acquisitions: enrollmentTiming.acquisitions, fsyncs: enrollmentTiming.fsyncs,
      inclusiveTotals: true,
      operations: Object.fromEntries(Object.entries(enrollmentTiming.metrics).map(([kind, metric]) => [kind, {
        count: metric.count, totalMs: roundedMs(metric.totalMs), maxMs: roundedMs(metric.maxMs),
        nestedFsyncMs: roundedMs(metric.nestedFsyncMs),
      }])),
      phaseCount: enrollmentTiming.phases.length,
      phases: enrollmentTiming.phases.slice(0, 8).map(({ phase, atMs, fsyncs }) => ({
        phase, atMs: roundedMs(atMs), fsyncs,
      })),
    }));

    expect(result.commands).toEqual([
      expect.objectContaining({ id: 'm418-enroll', outcome: 'done' }),
    ]);
    expect(isEnrolled(repo)).toBe(true);
    expect(writes).toEqual([
      expect.objectContaining({ status: 'claimed' }),
      expect.objectContaining({ status: 'done' }),
    ]);
    expect(outerFenceHeldDuringWriteback).toBe(true);
    // Four successful acquisitions plus the deliberate losing contender:
    // tick, recovery poll, pending poll and one borrowed command authority.
    expect(enrollmentTiming.acquisitions).toBe(5);
    expect(elapsedMs).toBeLessThan(limitMs);
  });

  it.each(['kill', 'abort'] as const)('does not enroll or write back after %s wins during a successful claim', async (stopKind) => {
    const repo = join(home, 'stopped-during-claim');
    const claimed = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const writes: string[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const endpoint = new URL(String(input));
      if (endpoint.pathname.endsWith('/traces')) return Promise.resolve(Response.json({}));
      if (init?.method === 'GET') {
        return Promise.resolve(Response.json({ commands: endpoint.searchParams.get('status') === 'pending'
          ? [{ id: 'stop-claim', kind: 'enroll_repo', target: null, payload: { path: repo }, status: 'pending' }]
          : [] }));
      }
      const body = JSON.parse(String(init?.body)) as { status: string };
      writes.push(body.status);
      claimed.resolve();
      return response.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const running = runPulseSync(cfg, { shipDeps: false, signal: controller.signal });
    await claimed.promise;
    if (stopKind === 'kill') {
      expect(setKill(true, { waitMs: 0 })).toMatchObject({ ok: false, quiesced: false });
    } else {
      controller.abort(new Error('stop during claim'));
    }
    response.resolve(Response.json({}));
    const result = await running;
    expect(result.commands).toEqual([expect.objectContaining({
      id: 'stop-claim', outcome: 'skipped', detail: expect.stringContaining('retryable'),
    })]);
    expect(isEnrolled(repo)).toBe(false);
    expect(writes).toEqual(['claimed']);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('preserves local enrollment but suppresses terminal writeback when KILL arrives after application', async () => {
    const repo = join(home, 'stopped-after-application');
    const writes: string[] = [];
    let stoppedWhileHeld = false;
    enrollmentHook.afterApply = () => {
      expect(isEnrolled(repo)).toBe(true);
      const stop = setKill(true, { waitMs: 0 });
      stoppedWhileHeld = !stop.ok && !stop.quiesced;
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const endpoint = new URL(String(input));
      if (endpoint.pathname.endsWith('/traces')) return Promise.resolve(Response.json({}));
      if (init?.method === 'GET') {
        return Promise.resolve(Response.json({ commands: endpoint.searchParams.get('status') === 'pending'
          ? [{ id: 'stop-after-apply', kind: 'enroll_repo', target: null, payload: { path: repo }, status: 'pending' }]
          : [] }));
      }
      writes.push(JSON.parse(String(init?.body)).status);
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await runPulseSync(cfg, { shipDeps: false });
    expect(stoppedWhileHeld).toBe(true);
    expect(result.commands).toEqual([expect.objectContaining({ id: 'stop-after-apply', outcome: 'done' })]);
    expect(isEnrolled(repo)).toBe(true);
    expect(writes).toEqual(['claimed']);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('aborts the active HTTP effect and starts no later sync write', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    let observedAbortReason: unknown;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/otlp/v1/traces')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (url.includes('/api/fleet/commands?')) {
        return Promise.resolve(Response.json({ commands: [{
          id: 'm418-command',
          kind: 'assign_goal',
          target: 'must-not-run-after-abort',
          payload: {},
          status: 'pending',
        }] }));
      }

      const signal = init?.signal;
      if (!signal) throw new Error('Pulse fetch did not receive an abort signal');
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        const rejectAborted = (): void => {
          observedAbortReason = signal.reason;
          reject(signal.reason);
        };
        if (signal.aborted) rejectAborted();
        else signal.addEventListener('abort', rejectAborted, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const running = runPulseSync(cfg, {
      tickTs: '2026-07-14T12:00:00.000Z',
      shipDeps: false,
      signal: controller.signal,
    });
    const combinedSignal = await started.promise;
    const reason = new Error('daemon shutdown requested');
    controller.abort(reason);

    const result = await running;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.detail).toMatch(/aborted during command sync/i);
    expect(combinedSignal.aborted).toBe(true);
    expect(combinedSignal.reason).toBe(reason);
    expect(observedAbortReason).toBe(reason);
    // Tick export + bounded claimed recovery poll + pending poll + claim PATCH.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({ status: 'claimed' });
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });
});
