/**
 * h5.orphan-sweep-wire.test.ts — H5 CHANGE 1 (wire the orphan sweep).
 *
 * INVARIANTS proven here:
 *  - RECLAIM-ALWAYS: a STALE orphan (createdAt back-dated > staleMs) is reclaimed;
 *    a FRESH sandbox (younger than staleMs) is SKIPPED (possibly-live owner).
 *  - WIRED-AT-START: runDaemon({once,dryRun}) sweeps a back-dated crash-leftover
 *    orphan at start (BEFORE the first tick) while leaving a FRESH one untouched —
 *    proving the sweep is actually wired into daemon startup, not dead code.
 *  - GC-REPORTS: `ashlr sandbox gc` runs the same sweep and REPORTS the ids it
 *    reclaimed (the explicit human repair surface).
 *  - CONTAINMENT-HOLDS: the wired sweep inherits removeSandbox's containment
 *    guards verbatim — a tampered-metadata orphan falls through to LOCAL dir
 *    cleanup only (the git ops are refused); the source repo's tree/branches are
 *    byte-identical.
 *
 * Isolated tmp HOME + disposable repos via the H1/H2 testkits. The
 * ASHLR_TEST_ALLOW_ANY_REPO env toggle is set so makeOrphanSandbox (which uses
 * allowAnyRepo) keeps working under the CHANGE 3 env-gate; it is restored after
 * each test. Every it() carries a real expect() + expect.hasAssertions().
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sweepOrphanSandboxes,
  sweepOrphanSandboxesDetailed,
  sandboxesDir,
  ORPHAN_STALE_MS,
  createSandbox,
} from '../src/core/sandbox/worktree.js';
import { runDaemon } from '../src/core/daemon/loop.js';
import { cmdSandbox } from '../src/cli/sandbox.js';
import {
  makeFixture,
  makeCfg,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  makeOrphanSandbox,
  listOrphanSandboxes,
  sandboxHomeExists,
} from './helpers/h2-faults.js';

let fx: H1Fixture;
let repo: DisposableRepo;

const ENV_KEY = 'ASHLR_TEST_ALLOW_ANY_REPO';
let prevEnv: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  prevEnv = undefined;
  fx?.cleanup();
});

function setup(): void {
  fx = makeFixture();
  prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = '1'; // CHANGE 3 — allow makeOrphanSandbox on a tmp repo
  repo = fx.makeRepo();
}

/** Short-name of the scratch branch a sandbox id maps to. */
function scratchBranch(id: string): string {
  return `ashlr/sandbox/${id}`;
}

/** Back-date a sandbox's persisted createdAt so it reads as stale. */
function backdateCreatedAt(id: string, ageMs: number): void {
  const metaFile = join(sandboxesDir(), id, 'sandbox.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { createdAt: string };
  meta.createdAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

// The wired threshold is the SHARED, exported constant — the sweep wiring, the
// disk cap, and `sandbox gc` all use it, so the test can never drift from prod.
const STALE_MS = ORPHAN_STALE_MS;

describe('H5 · orphan sweep wiring · RECLAIM-ALWAYS (stale reclaimed, fresh skipped)', () => {
  it('exports a conservative ORPHAN_STALE_MS GREATER than the max swarm wall-clock', () => {
    expect.hasAssertions();
    // The contract pins a 30-minute floor: a LIVE in-flight worktree younger than
    // this is NEVER reclaimed. Assert the shared constant is at least that large.
    expect(typeof ORPHAN_STALE_MS).toBe('number');
    expect(ORPHAN_STALE_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('reclaims a STALE orphan but SKIPS a FRESH sandbox under the same staleMs', () => {
    expect.hasAssertions();
    setup();
    const stale = makeOrphanSandbox(repo.dir);
    const fresh = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(stale.id, STALE_MS * 2);

    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });

    expect(swept).toContain(stale.id);
    expect(swept).not.toContain(fresh.id);
    expect(sandboxHomeExists(stale.id)).toBe(false);
    expect(sandboxHomeExists(fresh.id)).toBe(true);
    // The stale orphan's scratch branch is reclaimed from the source repo; the
    // fresh one's survives (it has a possibly-live owner).
    expect(repo.branches()).not.toContain(scratchBranch(stale.id));
    expect(repo.branches()).toContain(scratchBranch(fresh.id));
  });

  it('a FRESH (live) sandbox younger than staleMs is NEVER force-removed', () => {
    expect.hasAssertions();
    setup();
    const fresh = makeOrphanSandbox(repo.dir);
    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });
    expect(swept).toEqual([]);
    expect(listOrphanSandboxes().some((s) => s.id === fresh.id)).toBe(true);
    expect(sandboxHomeExists(fresh.id)).toBe(true);
  });
});

describe('H5 · orphan sweep wiring · LIVE-OWNER-NEVER-RECLAIMED (the HIGH-finding fix)', () => {
  it('a LIVE sandbox (owner pid alive) aged PAST staleMs is NEVER swept (age is not the sole liveness proxy)', () => {
    expect.hasAssertions();
    setup();
    // Create a REAL sandbox the normal way: createSandbox stamps ownerPid =
    // this (alive) process. This models a genuinely-live, long-running swarm
    // worktree owned by a separate process whose createdAt has aged past the
    // staleMs threshold (there is NO wall-clock cap on a swarm, so this is a
    // realistic state). Back-date ONLY createdAt — keep the live owner pid.
    const live = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(live.ownerPid).toBe(process.pid);
    backdateCreatedAt(live.id, STALE_MS * 4); // far older than staleMs

    // The age-based staleMs guard alone WOULD have force-removed it — but the
    // positive ownerPid liveness guard protects it regardless of age.
    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });

    expect(swept).not.toContain(live.id);
    expect(sandboxHomeExists(live.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(live.id));
  });

  it('the same live-but-old sandbox IS reclaimed once its owner is gone (dead pid -> age guard governs)', () => {
    expect.hasAssertions();
    setup();
    const sb = createSandbox(repo.dir, { allowAnyRepo: true });
    backdateCreatedAt(sb.id, STALE_MS * 4);
    // Simulate the owner crashing: strip the ownerPid from persisted metadata.
    const metaFile = join(sandboxesDir(), sb.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    delete meta['ownerPid'];
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // Now the (dead-owner) stale leftover is reclaimable by the age guard.
    const swept = sweepOrphanSandboxes({ staleMs: STALE_MS });
    expect(swept).toContain(sb.id);
    expect(sandboxHomeExists(sb.id)).toBe(false);
  });
});

describe('H5 · orphan sweep wiring · WIRED-AT-START (runDaemon reclaims crash leftovers)', () => {
  it('runDaemon({once}) reclaims a back-dated orphan at start, fresh one survives', async () => {
    expect.hasAssertions();
    setup();
    // A genuine crash leftover (back-dated past staleMs) + a fresh in-flight one.
    const stale = makeOrphanSandbox(repo.dir);
    const fresh = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(stale.id, STALE_MS * 2);
    expect(sandboxHomeExists(stale.id)).toBe(true);
    expect(sandboxHomeExists(fresh.id)).toBe(true);

    // H5: the start-time orphan sweep performs REAL on-disk reclaim, so it runs
    // only on a NON-dry start (dry-run is side-effect-free — see the dry-run
    // case below). No repo is enrolled, so the first (and only) tick has an empty
    // backlog and is a no-op — but the start-time sweep (wired BEFORE the tick)
    // still runs and reclaims the crash leftover.
    const state = await runDaemon(makeCfg(), { once: true, dryRun: false });
    expect(state).toBeDefined();

    // The crash leftover was reclaimed at daemon start...
    expect(sandboxHomeExists(stale.id)).toBe(false);
    expect(repo.branches()).not.toContain(scratchBranch(stale.id));
    // ...and the FRESH (possibly-live) sandbox was left untouched.
    expect(sandboxHomeExists(fresh.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(fresh.id));
  });

  it('runDaemon start sweep with NO stale orphans removes nothing (no false reclaim)', async () => {
    expect.hasAssertions();
    setup();
    const fresh = makeOrphanSandbox(repo.dir);
    await runDaemon(makeCfg(), { once: true, dryRun: false });
    // A fresh sandbox is never force-removed by the start-time sweep.
    expect(sandboxHomeExists(fresh.id)).toBe(true);
    expect(listOrphanSandboxes().some((s) => s.id === fresh.id)).toBe(true);
  });

  it('runDaemon({dryRun:true}) start does NOT sweep (dry-run is side-effect-free)', async () => {
    expect.hasAssertions();
    setup();
    // A genuine crash leftover (back-dated past staleMs, dead owner). A non-dry
    // start WOULD reclaim it; a dry-run start must leave disk byte-identical.
    const stale = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(stale.id, STALE_MS * 2);
    expect(sandboxHomeExists(stale.id)).toBe(true);

    await runDaemon(makeCfg(), { once: true, dryRun: true });

    // dry-run mutates NOTHING — the stale orphan is still on disk + its scratch
    // branch survives; an operator previewing the daemon got zero disk changes.
    expect(sandboxHomeExists(stale.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(stale.id));
  });
});

describe('H5 · orphan sweep wiring · GC-REPORTS (ashlr sandbox gc)', () => {
  it('`sandbox gc` reclaims stale orphans and reports the swept ids', async () => {
    expect.hasAssertions();
    setup();
    const stale = makeOrphanSandbox(repo.dir);
    const fresh = makeOrphanSandbox(repo.dir);
    backdateCreatedAt(stale.id, STALE_MS * 2);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdSandbox(['gc']);
    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

    // Clean exit + the report names the reclaimed orphan, NOT the fresh one.
    expect(code).toBe(0);
    expect(out).toContain('Reclaimed');
    expect(out).toContain(stale.id);
    expect(out).not.toContain(fresh.id);

    // And the report matches reality: the stale orphan is gone, fresh survives.
    expect(sandboxHomeExists(stale.id)).toBe(false);
    expect(sandboxHomeExists(fresh.id)).toBe(true);
  });

  it('`sandbox gc` with no stale orphans reports nothing reclaimed and exits 0', async () => {
    expect.hasAssertions();
    setup();
    const fresh = makeOrphanSandbox(repo.dir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdSandbox(['gc']);
    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

    expect(code).toBe(0);
    expect(out).toContain('No stale orphan sandboxes');
    // The fresh sandbox was never named/reclaimed.
    expect(out).not.toContain(fresh.id);
    expect(sandboxHomeExists(fresh.id)).toBe(true);
  });

  it('`sandbox gc` fails closed when malformed homes cannot be classified', async () => {
    expect.hasAssertions();
    setup();
    const malformed = join(sandboxesDir(), 'malformed-recovery-home');
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, 'sandbox.json'), '{not-json', 'utf8');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdSandbox(['gc'])).toBe(1);
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('No stale orphan sandboxes');
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('operator inspection');
  });
});

describe('H5 · orphan sweep wiring · CONTAINMENT-HOLDS (inherits removeSandbox guards)', () => {
  it('a tampered-metadata orphan is refused and remains visible for recovery', async () => {
    expect.hasAssertions();
    setup();
    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const headBefore = repo.currentBranch();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    const orphan = makeOrphanSandbox(repo.dir);
    // Tamper: point the branch OUT of the ashlr/sandbox/ namespace (at a real
    // user branch) so the containment guard REFUSES the destructive git ops and
    // falls through to local-dir cleanup only. Back-date so it is sweep-eligible.
    const metaFile = join(sandboxesDir(), orphan.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    meta['branch'] = headBefore; // a NON-namespaced (user) branch
    meta['createdAt'] = new Date(Date.now() - STALE_MS * 2).toISOString();
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // Refusal is not reclamation: preserve the only recovery handle.
    const sweep = sweepOrphanSandboxesDetailed({ staleMs: STALE_MS });
    expect(sweep.completed).not.toContain(orphan.id);
    expect(sweep.refused).toContain(orphan.id);
    expect(sandboxHomeExists(orphan.id)).toBe(true);
    const retained = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    expect(retained['cleanup']).toBeUndefined();
    expect(retained['branch']).toBe(headBefore);
    expect(await cmdSandbox(['gc'])).toBe(1);

    // ...but the containment guard prevented any git op against the user branch:
    // the source repo's working tree, status, HEAD, and user-branch set are all
    // byte-identical — the sweep could NEVER `branch -D` the user's branch.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
    expect(repo.currentBranch()).toBe(headBefore);
    expect(repo.branches()).toContain(headBefore);
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);

    // Restore canonical metadata so suite cleanup can safely reclaim the fixture.
    meta['branch'] = orphan.branch;
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  });
});
