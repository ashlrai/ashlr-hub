/**
 * h7.doctor-probes.test.ts — Ashlr v2.1 MILESTONE H7, BUILD ITEM 2.
 *
 * INVARIANTS proven here (see docs/contracts/CONTRACT-H7.md):
 *  - The 5 NEW read-only doctor probes appear in runDoctor's report with the
 *    correct id/status: enrollment, daemon-state, kill-switch, ashlr-writeable,
 *    sandbox-health.
 *  - NO-GUARD-WEAKENED / read-only: runDoctor mutates no enrollment / KILL /
 *    daemon / sandbox / repo state (byte-identical before/after); the lone write
 *    is checkAshlrWriteable's self-cleaning sentinel (no leftover).
 *  - Status rules: valid 0 enrolled ⇒ pass (fresh install fine); degraded
 *    enrollment ⇒ fail; kill ON ⇒ warn; ~/.ashlr not writeable ⇒ fail.
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6):
 *  - ISOLATED HOME per test via makeFixture; DISPOSABLE REPOS (fx.makeRepo);
 *    DETERMINISTIC (probeEndpoint mocked/down-tolerant; no model, no network).
 *  - Every it() below has a real expect() + expect.hasAssertions().
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { runDoctor } from '../src/core/doctor.js';
import type { DoctorCheck, DoctorReport } from '../src/core/types.js';
import * as providers from '../src/core/providers.js';

let fx: H1Fixture | undefined;

afterEach(() => {
  // Best-effort: re-grant perms on the isolated ~/.ashlr in case a writeable
  // test left it chmod 0 (so cleanup's rm -rf can proceed).
  if (fx) {
    try {
      chmodSync(fx.ashlrDir, 0o700);
    } catch {
      /* ignore */
    }
  }
  fx?.cleanup();
  fx = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub probeEndpoint so suites never hit the network / a live model. */
function stubModelUp(up: boolean): void {
  vi.spyOn(providers, 'probeEndpoint').mockResolvedValue({
    id: 'lmstudio',
    url: 'http://127.0.0.1:1234/v1/models',
    up,
    models: up ? ['stub-model'] : [],
    ...(up ? {} : { error: 'stubbed down' }),
  });
}

/** Find the probe with the given id in a DoctorReport. */
function probe(report: DoctorReport, id: string): DoctorCheck | undefined {
  return report.checks.find((c) => c.id === id);
}

/**
 * A minimal config WITH a models block so getProviderRegistry (inside runDoctor)
 * routes through the MOCKED probeEndpoint instead of touching the network — the
 * 5 H7 probes under test run before that block, but this keeps the whole report
 * deterministic and offline.
 */
function cfg() {
  return makeCfg({
    models: {
      lmstudio: 'http://127.0.0.1:1234',
      ollama: 'http://127.0.0.1:11434',
      providerChain: ['lmstudio', 'ollama'],
    },
  } as Parameters<typeof makeCfg>[0]);
}

/** Pick a pid that is provably NOT alive (so a sandbox owned by it is an orphan). */
function deadPid(): number {
  for (let p = 999999; p > 100000; p -= 7919) {
    try {
      process.kill(p, 0);
      // Alive — keep searching for a dead one.
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return p; // no such process => provably dead
    }
  }
  // Fallback: an out-of-range pid is treated as not-alive by ownerAlive's guard.
  return 2147483646;
}

/** Seed a sandbox metadata dir under the isolated ~/.ashlr/sandboxes/<id>/. */
function seedSandbox(handle: H1Fixture, id: string, ownerPid: number, sourceRepo: string): void {
  const home = join(handle.ashlrDir, 'sandboxes', id);
  mkdirSync(home, { recursive: true });
  const meta = {
    id,
    sourceRepo,
    worktreePath: join(home, 'worktree'),
    branch: `ashlr/sandbox/${id}`,
    baseHead: '0'.repeat(40),
    createdAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(), // > ORPHAN_STALE_MS old
    ownerPid,
  };
  writeFileSync(join(home, 'sandbox.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** Write a daemon.json into the isolated ~/.ashlr with the given fields. */
function seedDaemonState(handle: H1Fixture, state: Record<string, unknown>): void {
  if (!existsSync(handle.ashlrDir)) mkdirSync(handle.ashlrDir, { recursive: true });
  const full = {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    ...state,
  };
  writeFileSync(join(handle.ashlrDir, 'daemon.json'), JSON.stringify(full, null, 2) + '\n', 'utf8');
}

/** Deterministic content hash of a directory tree. */
function hashDir(dir: string): string {
  const h = createHash('sha256');
  function walk(d: string): void {
    if (!existsSync(d)) {
      h.update('<absent>\0');
      return;
    }
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const full = join(d, e.name);
      h.update(e.name);
      h.update('\0');
      if (e.isDirectory()) {
        h.update('D');
        walk(full);
      } else if (e.isFile()) {
        h.update('F');
        h.update(readFileSync(full));
        h.update('\0');
      }
    }
  }
  walk(dir);
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DOCTOR_PROBE_TIMEOUT_MS = 15_000;

describe('h7 doctor probes — 5 NEW read-only checks', () => {
  it("runDoctor includes an 'enrollment' probe; 0 enrolled ⇒ pass (fresh install is fine)", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    // Fresh, empty enrollment.
    const empty = await runDoctor(cfg());
    const emptyProbe = probe(empty, 'enrollment');
    expect(emptyProbe).toBeDefined();
    expect(emptyProbe?.status).toBe('pass');
    expect(emptyProbe?.detail).toMatch(/no repos enrolled/i);

    // Now enroll one disposable repo — still a pass, but reports the count.
    const repo = fx.makeRepo();
    repo.enroll();
    const oneEnrolled = await runDoctor(cfg());
    const enrolledProbe = probe(oneEnrolled, 'enrollment');
    expect(enrolledProbe?.status).toBe('pass');
    expect(enrolledProbe?.detail).toMatch(/1 repo enrolled/i);
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("runDoctor's enrollment probe fails exactly when the registry is degraded", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    mkdirSync(fx.ashlrDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fx.ashlrDir, 'enrollment.json'), '{"repos":"invalid"}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });

    const report = await runDoctor(cfg());
    expect(probe(report, 'enrollment')).toEqual({
      id: 'enrollment',
      label: 'Enrollment registry',
      status: 'fail',
      detail: 'Enrollment registry degraded: malformed-registry',
      fix: 'Repair ~/.ashlr/enrollment.json before running autonomy.',
    });
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("runDoctor includes a 'daemon-state' probe; stopped/healthy ⇒ pass; self-healed dead-pid ⇒ pass", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    // No daemon.json at all ⇒ fresh stopped state ⇒ pass.
    const stopped = await runDoctor(cfg());
    const stoppedProbe = probe(stopped, 'daemon-state');
    expect(stoppedProbe).toBeDefined();
    expect(stoppedProbe?.status).toBe('pass');
    expect(stoppedProbe?.detail).toMatch(/stopped/i);

    // Persist a stuck running:true with a DEAD pid. loadDaemonState's H5
    // reconcile self-heals it to running:false at load, so the probe truthfully
    // reports "stopped" (a pass) rather than a phantom-live daemon — proving the
    // self-heal flows through the read path.
    seedDaemonState(fx, { running: true, pid: deadPid() });
    const healed = await runDoctor(cfg());
    const healedProbe = probe(healed, 'daemon-state');
    expect(healedProbe?.status).toBe('pass');
    expect(healedProbe?.detail).toMatch(/stopped/i);

    // Live-daemon arm: running:true with THIS test process's pid (provably
    // alive) survives the H5 self-heal and reports a PASS with a "running"
    // detail — covering checkDaemonState's `running && pidAlive` branch so a
    // future change to it is caught.
    seedDaemonState(fx, { running: true, pid: process.pid });
    const live = await runDoctor(cfg());
    const liveProbe = probe(live, 'daemon-state');
    expect(liveProbe?.status).toBe('pass');
    expect(liveProbe?.detail).toMatch(/running/i);
    expect(liveProbe?.detail).toContain(String(process.pid));
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("runDoctor includes a 'kill-switch' probe; OFF ⇒ pass, ON ⇒ warn", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    // OFF ⇒ pass.
    const off = await runDoctor(cfg());
    const offProbe = probe(off, 'kill-switch');
    expect(offProbe).toBeDefined();
    expect(offProbe?.status).toBe('pass');
    expect(offProbe?.detail).toMatch(/off/i);

    // ON ⇒ warn (autonomy paused).
    fx.setKill(true);
    const on = await runDoctor(cfg());
    const onProbe = probe(on, 'kill-switch');
    expect(onProbe?.status).toBe('warn');
    expect(onProbe?.detail).toMatch(/on/i);
    expect(onProbe?.fix).toBeDefined();
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("runDoctor includes an 'ashlr-writeable' probe; writeable ⇒ pass", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    const report = await runDoctor(cfg());
    const wp = probe(report, 'ashlr-writeable');
    expect(wp).toBeDefined();
    expect(wp?.status).toBe('pass');
    expect(wp?.detail).toMatch(/writeable/i);
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("'ashlr-writeable' probe ⇒ fail when ~/.ashlr is not writeable", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    // Create ~/.ashlr then strip all permissions so the sentinel write fails.
    if (!existsSync(fx.ashlrDir)) mkdirSync(fx.ashlrDir, { recursive: true });
    chmodSync(fx.ashlrDir, 0o000);

    // If chmod is a no-op (root / some CI filesystems), the write would still
    // succeed; detect that and assert the truthful PASS rather than false-green.
    let enforced = true;
    try {
      writeFileSync(join(fx.ashlrDir, '.perm-probe'), 'x', 'utf8');
      enforced = false; // write succeeded => perms not enforced here
    } catch {
      enforced = true;
    }

    if (!enforced) {
      chmodSync(fx.ashlrDir, 0o700);
      const report = await runDoctor(cfg());
      expect(probe(report, 'ashlr-writeable')?.status).toBe('pass');
      return;
    }

    const report = await runDoctor(cfg());
    const wp = probe(report, 'ashlr-writeable');
    expect(wp).toBeDefined();
    expect(wp?.status).toBe('fail');
    expect(wp?.fix).toBeDefined();

    // Restore so afterEach cleanup can rm -rf the dir.
    chmodSync(fx.ashlrDir, 0o700);
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it("runDoctor includes a 'sandbox-health' probe; zero/low ⇒ pass, high orphan count ⇒ warn", async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);

    // No sandboxes ⇒ pass.
    const none = await runDoctor(cfg());
    const noneProbe = probe(none, 'sandbox-health');
    expect(noneProbe).toBeDefined();
    expect(noneProbe?.status).toBe('pass');

    // Seed 4 orphan sandboxes (owner pid provably dead, > stale age) — at/above
    // the warn threshold (3) ⇒ warn with a `sandbox gc` fix hint.
    const dp = deadPid();
    const repo = fx.makeRepo();
    for (let i = 0; i < 4; i++) {
      seedSandbox(fx, `orphan${i}`, dp, repo.dir);
    }
    const many = await runDoctor(cfg());
    const manyProbe = probe(many, 'sandbox-health');
    expect(manyProbe?.status).toBe('warn');
    expect(manyProbe?.detail).toMatch(/orphan/i);
    expect(manyProbe?.fix).toMatch(/gc/i);
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it('reports remote CAS configuration without probing, activating, or exposing endpoint credentials', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    stubModelUp(false);
    const before = hashDir(fx.ashlrDir);

    expect(probe(await runDoctor(cfg()), 'remote-cas-authority')).toEqual({
      id: 'remote-cas-authority',
      label: 'Remote CAS authority',
      status: 'pass',
      detail: 'disabled (default; recovery executor remains disabled)',
    });

    const observational = cfg();
    observational.fleet = {
      remoteCasAuthority: {
        mode: 'probe',
        provider: 'ashlr-authority',
        endpoint: 'https://authority.ashlr.ai/',
        audience: 'ashlr-operational-projection',
        authorityId: 'authority-prod-1',
      },
    };
    expect(probe(await runDoctor(observational), 'remote-cas-authority')).toMatchObject({
      status: 'warn',
      detail: 'configured for observation only; recovery executor remains disabled',
    });

    const invalid = cfg();
    invalid.fleet = {
      remoteCasAuthority: {
        mode: 'probe',
        provider: 'ashlr-authority',
        endpoint: 'https://user:secret@authority.ashlr.ai/',
        audience: 'ashlr-operational-projection',
        authorityId: 'authority-prod-1',
      },
    };
    const invalidProbe = probe(await runDoctor(invalid), 'remote-cas-authority');
    expect(invalidProbe).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^configuration invalid \(endpoint-invalid\)/) });
    expect(invalidProbe?.detail).not.toContain('secret');
    expect(hashDir(fx.ashlrDir)).toBe(before);
  }, DOCTOR_PROBE_TIMEOUT_MS);

  it(
    'NO-GUARD-WEAKENED: runDoctor mutates no enrollment / KILL / daemon / sandbox state ' +
      '(byte-identical before vs after), leaving no writeable-sentinel behind',
    async () => {
      expect.hasAssertions();
      fx = makeFixture();
      stubModelUp(true);

      // Seed a representative, non-trivial state to snapshot.
      const repo = fx.makeRepo();
      repo.enroll();
      fx.setKill(true);
      seedDaemonState(fx, { running: true, pid: 4242, todaySpentUsd: 0.5, itemsProcessed: 7 });
      seedSandbox(fx, 'sb-keep', deadPid(), repo.dir);

      const enrollmentPath = join(fx.ashlrDir, 'enrollment.json');
      const killPath = join(fx.ashlrDir, 'KILL');
      const daemonPath = join(fx.ashlrDir, 'daemon.json');
      const sandboxesDir = join(fx.ashlrDir, 'sandboxes');

      const before = {
        enrollment: readFileSync(enrollmentPath, 'utf8'),
        kill: readFileSync(killPath, 'utf8'),
        daemon: readFileSync(daemonPath, 'utf8'),
        sandboxes: hashDir(sandboxesDir),
      };

      const report = await runDoctor(cfg());
      // Sanity: all 5 probes are present.
      for (const id of ['enrollment', 'daemon-state', 'kill-switch', 'ashlr-writeable', 'sandbox-health']) {
        expect(probe(report, id)).toBeDefined();
      }

      const after = {
        enrollment: readFileSync(enrollmentPath, 'utf8'),
        kill: readFileSync(killPath, 'utf8'),
        daemon: readFileSync(daemonPath, 'utf8'),
        sandboxes: hashDir(sandboxesDir),
      };

      // Byte-identical: doctor mutated nothing.
      expect(after.enrollment).toBe(before.enrollment);
      expect(after.kill).toBe(before.kill);
      expect(after.daemon).toBe(before.daemon);
      expect(after.sandboxes).toBe(before.sandboxes);

      // No leftover writeable-sentinel under ~/.ashlr (it self-cleans). The
      // sentinel is a private dotfile; assert NONE remain regardless of the
      // exact name readiness.ts chose.
      const leftovers = readdirSync(fx.ashlrDir).filter(
        (n) =>
          n.includes('writecheck') ||
          n.includes('preflight') ||
          (n.startsWith('.') && n.endsWith('.tmp')),
      );
      expect(leftovers).toEqual([]);
    },
    DOCTOR_PROBE_TIMEOUT_MS,
  );
});
