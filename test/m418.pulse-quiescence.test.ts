import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { emitFleetEvent, runPulseSync } from '../src/core/integrations/pulse-sync.js';
import { isEnrolled, setKill } from '../src/core/sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';

const cfg = { user: { id: 'm418', name: 'M418' } } as AshlrConfig;

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  home = join(tmpdir(), `ashlr-m418-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PULSE_URL = 'http://pulse.m418.invalid';
  process.env.PULSE_FLEET_PAT = 'm418-test-pat';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PULSE_URL;
  delete process.env.PULSE_FLEET_PAT;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
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

  it('enrolls promptly with borrowed authority and keeps the outer Pulse fence held', async () => {
    const repo = join(home, 'remote-enroll');
    let outerFenceHeldDuringWriteback = false;
    const writes: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
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

    const startedAt = performance.now();
    const result = await runPulseSync(cfg, {
      tickTs: '2026-07-14T12:00:00.000Z',
      shipDeps: false,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.commands).toEqual([
      expect.objectContaining({ id: 'm418-enroll', outcome: 'done' }),
    ]);
    expect(isEnrolled(repo)).toBe(true);
    expect(writes).toEqual([
      expect.objectContaining({ status: 'claimed' }),
      expect.objectContaining({ status: 'done' }),
    ]);
    expect(outerFenceHeldDuringWriteback).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
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
