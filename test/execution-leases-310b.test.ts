/**
 * V3.10 U6 — execution leases, repo leases, verification slots, and the
 * kill / unenroll DRAIN built on them (src/core/sandbox/execution-leases.ts,
 * src/core/sandbox/policy.ts). SPEC-310B §3 "Mutation fence".
 *
 * REAL-IO: real lock files under an isolated tmp HOME, and real tsx child
 * processes for the cross-process cases (see test/helpers/throughput-310b.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { startTsxChild } from './helpers/throughput-310b.js';
import {
  abortExecutionLeases,
  acquireRepoLease,
  censusExecutionLeases,
  countLiveExecutionLeases,
  registerExecutionLease,
  VerificationCapacityError,
  waitForExecutionLeasesToDrain,
  withRepoLease,
  withVerificationSlot,
  type ExecutionLease,
  type ExecutionLeaseSpec,
} from '../src/core/sandbox/execution-leases.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import {
  enroll,
  isEnrolled,
  killSwitchOn,
  setKill,
  setKillAndDrain,
  unenroll,
  unenrollAndDrain,
} from '../src/core/sandbox/policy.js';

const REAL_IO_TIMEOUT = 60_000;
const srcUrl = (rel: string): string => pathToFileURL(join(process.cwd(), 'src', rel)).href;

let fx: H1Fixture | null = null;
const held: ExecutionLease[] = [];

function home(): H1Fixture {
  fx ??= makeFixture();
  return fx;
}

afterEach(() => {
  for (const lease of held.splice(0)) lease.release();
  if (fx) {
    try { setKill(false, { waitMs: 500 }); } catch { /* fixture cleanup handles the rest */ }
    fx.cleanup();
    fx = null;
  }
});

/** Register a lease exactly as a producer does: under the fence, then drop the fence. */
function lease(spec: Partial<ExecutionLeaseSpec> & { repoKey: string }): ExecutionLease {
  const fence = acquireOutwardMutationFence(2_000);
  expect(ownsOutwardMutationFence(fence)).toBe(true);
  try {
    const registration = registerExecutionLease(fence, {
      runId: spec.runId ?? `run-${held.length}`,
      engine: spec.engine ?? 'test-engine',
      ...spec,
    });
    if (!registration.ok) throw new Error(registration.reason);
    held.push(registration.lease);
    return registration.lease;
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('execution leases (shared, in-process)', () => {
  it('refuses registration without the outward fence', () => {
    home();
    const result = registerExecutionLease(null, { runId: 'r', repoKey: '/repo/a', engine: 'e' });
    expect(result).toEqual({ ok: false, reason: 'execution lease requires the outward mutation fence' });
    expect(countLiveExecutionLeases()).toBe(0);
  });

  it('any number of agents hold one at once; release is idempotent', () => {
    home();
    const leases = [0, 1, 2, 3].map((i) => lease({ repoKey: i < 2 ? '/repo/a' : '/repo/b', runId: `run.${i}/x` }));
    expect(countLiveExecutionLeases()).toBe(4);
    expect(countLiveExecutionLeases({ repoKeys: ['/repo/a'] })).toBe(2);
    expect(censusExecutionLeases().leases.every((row) => row.owner === 'this-process')).toBe(true);
    leases[0]!.release();
    leases[0]!.release();
    expect(leases[0]!.isHeld()).toBe(false);
    expect(countLiveExecutionLeases()).toBe(3);
  });

  it('abort is scoped by repo and records the reason', () => {
    home();
    const a = lease({ repoKey: '/repo/a' });
    const b = lease({ repoKey: '/repo/b' });
    expect(abortExecutionLeases({ repoKeys: ['/repo/a'] }, 'repo unenrolled')).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(a.abortReason()).toBe('repo unenrolled');
    expect(b.signal.aborted).toBe(false);
    // Aborting does not release: the run still owns its lease until it has stopped.
    expect(countLiveExecutionLeases()).toBe(2);
  });

  it('the parent signal and the stop probe both abort the lease', async () => {
    home();
    const parent = new AbortController();
    const fromParent = lease({ repoKey: '/repo/a', parentSignal: parent.signal });
    parent.abort();
    expect(fromParent.signal.aborted).toBe(true);
    expect(fromParent.abortReason()).toBe('cancelled');

    let stop: string | null = null;
    let calls = 0;
    const probed = lease({
      repoKey: '/repo/b',
      pollMs: 15,
      shouldAbort: () => {
        calls += 1;
        if (calls === 1) throw new Error('probe errors read as "no stop"');
        return stop;
      },
    });
    await sleep(60);
    expect(probed.signal.aborted).toBe(false);
    stop = 'kill switch armed';
    await sleep(60);
    expect(probed.signal.aborted).toBe(true);
    expect(probed.abortReason()).toBe('kill switch armed');
  });

  it('drain waits for release and times out honestly', async () => {
    home();
    const quick = lease({ repoKey: '/repo/a' });
    setTimeout(() => quick.release(), 80);
    const drained = await waitForExecutionLeasesToDrain(null, { timeoutMs: 2_000, pollMs: 20 });
    expect(drained).toMatchObject({ drained: true, live: 0 });

    lease({ repoKey: '/repo/b' });
    const stuck = await waitForExecutionLeasesToDrain(null, { timeoutMs: 120, pollMs: 20 });
    expect(stuck).toMatchObject({ drained: false, live: 1 });
  });
});

describe('execution leases (cross-process)', () => {
  const CHILD = String.raw`
    import { acquireOutwardMutationFence, releaseOutwardMutationFence } from ${JSON.stringify(srcUrl('core/sandbox/mutation-fence.ts'))};
    import { registerExecutionLease } from ${JSON.stringify(srcUrl('core/sandbox/execution-leases.ts'))};
    const fence = acquireOutwardMutationFence(5000);
    const reg = registerExecutionLease(fence, { runId: 'child-run', repoKey: '/repo/child', engine: 'child' });
    releaseOutwardMutationFence(fence);
    if (!reg.ok) { console.error(reg.reason); process.exit(3); }
    console.log('LEASE-READY');
    setInterval(() => {}, 1000);
  `;

  it('a live foreign lease counts; a dead one is reaped instead of blocking kill forever', async () => {
    const f = home();
    const child = await startTsxChild(CHILD, f.home, 'LEASE-READY');
    try {
      const census = censusExecutionLeases({ repoKeys: ['/repo/child'] });
      expect(census.leases).toEqual([
        { runId: null, repoHash: expect.stringMatching(/^[0-9a-f]{16}$/), engine: null, owner: 'other-process' },
      ]);
      expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: false, quiesced: false });
    } finally {
      await child.kill();
    }
    const after = censusExecutionLeases();
    expect(after.leases).toEqual([]);
    expect(after.reaped).toBe(1);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  }, REAL_IO_TIMEOUT);

  it('a repo lease held by another process blocks until that process dies', async () => {
    const f = home();
    const child = await startTsxChild(String.raw`
      import { acquireRepoLease } from ${JSON.stringify(srcUrl('core/sandbox/execution-leases.ts'))};
      const got = await acquireRepoLease('/repo/shared', { waitMs: 5000 });
      if (!got.ok) { console.error(got.reason); process.exit(3); }
      console.log('REPO-LEASE-READY');
      setInterval(() => {}, 1000);
    `, f.home, 'REPO-LEASE-READY');
    try {
      const busy = await acquireRepoLease('/repo/shared', { waitMs: 250 });
      expect(busy).toEqual({ ok: false, reason: 'repo lease busy after 250ms' });
      const other = await acquireRepoLease('/repo/other', { waitMs: 250 });
      expect(other.ok).toBe(true);
      if (other.ok) other.lease.release();
    } finally {
      await child.kill();
    }
    const freed = await acquireRepoLease('/repo/shared', { waitMs: 5_000 });
    expect(freed.ok).toBe(true);
    if (freed.ok) freed.lease.release();
  }, REAL_IO_TIMEOUT);
});

describe('repo leases (exclusive per repo)', () => {
  it('serializes holders of one repo and never serializes different repos', async () => {
    home();
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    let peakAll = 0;
    let all = 0;
    const hold = (key: string) => withRepoLease(key, async () => {
      active.set(key, (active.get(key) ?? 0) + 1);
      all += 1;
      peak.set(key, Math.max(peak.get(key) ?? 0, active.get(key)!));
      peakAll = Math.max(peakAll, all);
      await sleep(40);
      active.set(key, active.get(key)! - 1);
      all -= 1;
      return key;
    }, { waitMs: 10_000, pollMs: 10 });
    const results = await Promise.all([
      hold('/repo/a'), hold('/repo/a'), hold('/repo/a'),
      hold('/repo/b'), hold('/repo/b'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak.get('/repo/a')).toBe(1);
    expect(peak.get('/repo/b')).toBe(1);
    expect(peakAll).toBe(2);
  }, REAL_IO_TIMEOUT);

  it('a cancelled wait says so and keeps the queue intact', async () => {
    home();
    const first = await acquireRepoLease('/repo/a');
    expect(first.ok).toBe(true);
    const controller = new AbortController();
    const waiting = acquireRepoLease('/repo/a', { signal: controller.signal, pollMs: 10 });
    const third = acquireRepoLease('/repo/a', { waitMs: 5_000, pollMs: 10 });
    controller.abort();
    expect(await waiting).toEqual({ ok: false, reason: 'repo lease wait cancelled' });
    if (first.ok) first.lease.release();
    const next = await third;
    expect(next.ok).toBe(true);
    if (next.ok) next.lease.release();
  }, REAL_IO_TIMEOUT);
});

describe('verification slots', () => {
  it('runs at most 2 machine-wide and 1 per repo', async () => {
    home();
    let machine = 0;
    let machinePeak = 0;
    const perRepo = new Map<string, number>();
    const perRepoPeak = new Map<string, number>();
    const verify = (repo: string) => withVerificationSlot(repo, async () => {
      machine += 1;
      perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
      machinePeak = Math.max(machinePeak, machine);
      perRepoPeak.set(repo, Math.max(perRepoPeak.get(repo) ?? 0, perRepo.get(repo)!));
      await sleep(40);
      machine -= 1;
      perRepo.set(repo, perRepo.get(repo)! - 1);
    }, { pollMs: 10, waitMs: 20_000 });
    await Promise.all([
      verify('/repo/a'), verify('/repo/a'),
      verify('/repo/b'), verify('/repo/b'),
      verify('/repo/c'), verify('/repo/c'),
    ]);
    expect(machinePeak).toBe(2);
    expect([...perRepoPeak.values()]).toEqual([1, 1, 1]);
  }, REAL_IO_TIMEOUT);

  it('fails closed with a typed error when no slot comes free', async () => {
    home();
    let release!: () => void;
    const blocker = withVerificationSlot('/repo/a', () => new Promise<void>((resolve) => { release = resolve; }));
    await sleep(30);
    const refused = withVerificationSlot('/repo/a', async () => 'ran', { waitMs: 100, pollMs: 10 });
    await expect(refused).rejects.toBeInstanceOf(VerificationCapacityError);
    await expect(refused).rejects.toMatchObject({ kind: 'timeout' });
    release();
    await blocker;
    await expect(withVerificationSlot('/repo/a', async () => 'ran')).resolves.toBe('ran');
  }, REAL_IO_TIMEOUT);
});

describe('kill and unenroll drain (policy.ts)', () => {
  it('sync setKill aborts running agents and does not claim quiescence until they are gone', () => {
    home();
    const running = lease({ repoKey: '/repo/a' });
    expect(setKill(true, { waitMs: 500 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
    expect(running.signal.aborted).toBe(true);
    running.release();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('setKillAndDrain waits for agents that stop, and reports the ones that do not', async () => {
    home();
    const obedient = lease({ repoKey: '/repo/a' });
    obedient.signal.addEventListener('abort', () => { setTimeout(() => obedient.release(), 50); });
    const stopped = await setKillAndDrain({ drainMs: 5_000, pollMs: 20 });
    expect(stopped).toMatchObject({ ok: true, quiesced: true, liveExecutionLeases: 0 });
    expect(setKill(false, { waitMs: 500 })).toMatchObject({ ok: true });

    lease({ repoKey: '/repo/b' }); // never releases
    const stuck = await setKillAndDrain({ drainMs: 150, pollMs: 20 });
    expect(stuck).toMatchObject({
      ok: false,
      quiesced: false,
      liveExecutionLeases: 1,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
  }, REAL_IO_TIMEOUT);

  it('unenroll drains only the unenrolled repo', async () => {
    const f = home();
    const a = f.makeRepo();
    const b = f.makeRepo();
    expect(enroll(a.dir)).toMatchObject({ ok: true });
    expect(enroll(b.dir)).toMatchObject({ ok: true });
    const onA = lease({ repoKey: a.dir });
    const onB = lease({ repoKey: b.dir });
    expect(unenroll(a.dir)).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'unenrolled; an autonomous run on this repo has not drained',
    });
    expect(isEnrolled(a.dir)).toBe(false);
    expect(onA.signal.aborted).toBe(true);
    expect(onB.signal.aborted).toBe(false);
    setTimeout(() => onA.release(), 50);
    const drained = await unenrollAndDrain(a.dir, { drainMs: 5_000, pollMs: 20 });
    expect(drained).toMatchObject({ ok: true, quiesced: true, reason: 'already-unenrolled', liveExecutionLeases: 0 });
    expect(onB.signal.aborted).toBe(false);
    expect(isEnrolled(b.dir)).toBe(true);
  }, REAL_IO_TIMEOUT);

  it('unenrollAndDrain on a running repo returns quiesced once the run stops', async () => {
    const f = home();
    const repo = f.makeRepo();
    enroll(repo.dir);
    const run = lease({ repoKey: repo.dir });
    run.signal.addEventListener('abort', () => { setTimeout(() => run.release(), 50); });
    const result = await unenrollAndDrain(repo.dir, { drainMs: 5_000, pollMs: 20 });
    expect(result).toMatchObject({ ok: true, changed: true, quiesced: true, reason: 'unenrolled', liveExecutionLeases: 0 });
  }, REAL_IO_TIMEOUT);
});
