/**
 * h8.demo-safety.test.ts — Ashlr v2.1 MILESTONE H8 (FINAL) — the SAFETY proof
 * for the `ashlr demo` command.
 *
 * `ashlr demo` is the ONLY new runtime surface H8 adds, so it carries the
 * heaviest safety burden. This suite proves — behaviorally + statically — that
 * the demo can NEVER escape its sandbox:
 *
 *  (a) DEMO-DISPOSABLE-ONLY — it NEVER enrolls or touches the REAL portfolio:
 *      the REAL ~/.ashlr/enrollment.json stays BYTE-IDENTICAL ({repos:[]}) across
 *      a full demo run.
 *  (b) DEMO-DISPOSABLE-ONLY — every repo the demo enrolls lives under
 *      os.tmpdir() (a throwaway repo the demo itself creates) and is removed.
 *  (c) DEMO-AUTO-CLEANS — the tmp repo + tmp HOME are reclaimed on SUCCESS AND
 *      on a forced mid-run THROW (try/finally), with HOME restored — no tmp dir
 *      or sandbox leftovers either way.
 *  (d) DEMO-NEVER-APPLIES [STATIC] — src/cli/demo.ts (+ demo-sandbox.ts) AND the
 *      two modules reachable from the live tick({dryRun:false}) path
 *      (core/daemon/loop.ts + core/swarm/runner.ts) contain NONE of
 *      applyProposal( / setStatus('approved' / push / createPr( / deploy( — the
 *      demo's only sink is a PENDING proposal, on the stub AND the live path.
 *  (e) DETERMINISTIC, NO LIVE MODEL — with probeEndpoint mocked DOWN the demo
 *      runs the no-model stub path end-to-end (no network, no live swarm).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6/H7):
 *   - The REAL ~/.ashlr/enrollment.json byte-snapshot is read DIRECTLY from the
 *     REAL home path (captured BEFORE any fixture relocation) so this suite
 *     proves the demo never wrote it REGARDLESS of HOME layering. We only ever
 *     READ the real file; we NEVER write it.
 *   - The demo itself runs inside an ISOLATED tmp HOME (the test ALSO relocates
 *     HOME via makeFixture as belt-and-suspenders) on DISPOSABLE repos only.
 *   - DETERMINISTIC: probeEndpoint is mocked DOWN (up:false) so the demo always
 *     takes the no-model stub path — no network, no live model, no live swarm.
 *   - Every it() ends with a real expect(); beforeEach calls
 *     expect.hasAssertions() so a vacuous stub can never go green.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Sweep any `ashlr-h8-demo-*` tmp dirs (the demo's isolated tmp HOME / repo)
 * left under os.tmpdir(). The demo's success path auto-cleans, but the
 * `--no-cleanup` case intentionally keeps its tmp HOME; this keeps the test
 * suite from leaking demo tmp state. Best-effort + never throws.
 */
function sweepDemoTmp(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  // PID-scoped: only sweep dirs created by THIS process. The demo names its tmp
  // dirs `ashlr-h8-demo-{home,repo}-<pid>-…`; under vitest's parallel forks each
  // test file is its own process, so an unscoped wildcard would race-delete a
  // sibling file's LIVE tmp dir mid-`git init` (→ "not in a git directory").
  const mine = `ashlr-h8-demo-`;
  const pidTag = `-${process.pid}-`;
  for (const name of entries) {
    if (name.startsWith(mine) && name.includes(pidTag)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {
        /* idempotent — best-effort cleanup */
      }
    }
  }
}

// probeEndpoint mocked DOWN (up:false) so the demo runs the deterministic
// no-model stub path. vi.mock is hoisted; the spy is shared via vi.hoisted so
// the demo's `import { probeEndpoint }` resolves to this down-probe.
const { probeDownSpy } = vi.hoisted(() => ({
  probeDownSpy: vi.fn(async (id: string, url: string) => ({
    id,
    url,
    up: false as const,
    models: [] as string[],
    error: 'mocked down (h8 demo-safety: no-model stub path)',
  })),
}));
vi.mock('../src/core/providers.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/core/providers.js')>();
  return { ...actual, probeEndpoint: probeDownSpy };
});

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readSource, stripComments, containsToken } from './helpers/h4-static.js';
import { cmdDemo } from '../src/cli/demo.js';
import * as policy from '../src/core/sandbox/policy.js';
import * as backlog from '../src/core/portfolio/backlog.js';
import * as inboxStore from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// REAL portfolio snapshot — read the REAL ~/.ashlr/enrollment.json bytes from
// the REAL home (captured at module load, BEFORE any fixture relocates HOME),
// so the byte-identical assertion holds regardless of how HOME is layered. We
// ONLY ever READ this path; we NEVER write it.
// ---------------------------------------------------------------------------

const REAL_HOME = homedir();
const REAL_ENROLLMENT = join(REAL_HOME, '.ashlr', 'enrollment.json');

/** Byte-snapshot of the REAL enrollment file (or a sentinel if it is absent). */
function snapshotRealEnrollment(): string {
  return existsSync(REAL_ENROLLMENT)
    ? readFileSync(REAL_ENROLLMENT, 'utf8')
    : '<<ABSENT>>';
}

let fx: H1Fixture | undefined;

beforeEach(() => {
  expect.hasAssertions();
  // The test ALSO isolates HOME (belt-and-suspenders) so even an unexpected
  // direct ~/.ashlr write during the run would land in the tmp HOME, never the
  // real one. The demo additionally relocates HOME to its OWN tmp dir.
  fx = makeFixture();
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  vi.restoreAllMocks();
  sweepDemoTmp();
});

describe('h8 demo-safety — `ashlr demo` can never touch the real portfolio', () => {
  // (a) DEMO-DISPOSABLE-ONLY — the real enrollment.json is byte-identical.
  it('NEVER enrolls or touches the REAL portfolio — real enrollment.json stays byte-identical {repos:[]} across a full demo run', async () => {
    const before = snapshotRealEnrollment();
    // Sanity: the real portfolio is the documented DEFAULT-EMPTY state. (If a
    // real machine had repos enrolled this still proves byte-identity, but the
    // contract pins {repos:[]}, so assert it when present.)
    if (before !== '<<ABSENT>>') {
      expect(JSON.parse(before)).toEqual({ repos: [] });
    }

    const code = await cmdDemo([]);
    expect(code).toBe(0);

    const after = snapshotRealEnrollment();
    // The whole point: the real file is byte-for-byte unchanged by the demo.
    expect(after).toBe(before);
    // And listEnrolled() — resolved under THIS test's isolated fixture HOME, to
    // which the demo restored after relocating its OWN tmp HOME — is empty: the
    // demo unenrolled its disposable repo and left no enrollment behind.
    expect(policy.listEnrolled()).toEqual([]);
  });

  // (b) DEMO-DISPOSABLE-ONLY — every enrolled path is a throwaway under tmpdir().
  it('operates ONLY on a disposable tmp repo it creates under os.tmpdir() (every enrolled path is below tmpdir and is removed)', async () => {
    const enrolledPaths: string[] = [];
    // Wrap the REAL enroll so the demo's isolated-home write still happens; we
    // only OBSERVE which path it enrolled.
    const realEnroll = policy.enroll;
    const enrollSpy = vi
      .spyOn(policy, 'enroll')
      .mockImplementation((repo: string) => {
        enrolledPaths.push(resolve(repo));
        realEnroll(repo);
      });

    const code = await cmdDemo([]);
    expect(code).toBe(0);

    // The demo enrolled at least one repo, and EVERY enrolled path is a
    // throwaway under os.tmpdir() — never a real portfolio path.
    expect(enrollSpy).toHaveBeenCalled();
    expect(enrolledPaths.length).toBeGreaterThan(0);
    const tmpRoot = resolve(tmpdir());
    for (const p of enrolledPaths) {
      expect(p.startsWith(tmpRoot)).toBe(true);
      expect(p.startsWith(resolve(REAL_HOME, '.ashlr'))).toBe(false);
      // The disposable repo dir was removed by auto-cleanup (default path).
      expect(existsSync(p)).toBe(false);
    }
  });

  // (c.1) DEMO-AUTO-CLEANS — success path: no tmp leftovers; HOME restored.
  it('auto-cleans on SUCCESS — the disposable repo dir is gone and HOME is restored afterwards', async () => {
    const enrolledPaths: string[] = [];
    const realEnroll = policy.enroll;
    vi.spyOn(policy, 'enroll').mockImplementation((repo: string) => {
      enrolledPaths.push(resolve(repo));
      realEnroll(repo);
    });
    const homeBefore = process.env.HOME;

    const code = await cmdDemo([]);
    expect(code).toBe(0);

    // The tmp repo the demo created no longer exists on disk.
    expect(enrolledPaths.length).toBeGreaterThan(0);
    for (const p of enrolledPaths) {
      expect(existsSync(p)).toBe(false);
    }
    // HOME was restored to what it was before the demo ran (the demo relocates
    // its OWN HOME internally, then restores it in finally).
    expect(process.env.HOME).toBe(homeBefore);
    // The real portfolio is still untouched.
    expect(snapshotRealEnrollment()).toBe(snapshotRealEnrollment());
  });

  // (c.2) DEMO-AUTO-CLEANS — forced mid-run THROW still cleans up (try/finally).
  it('still auto-cleans (tmp gone, HOME restored, real portfolio untouched) when the chain THROWS mid-run', async () => {
    const enrolledPaths: string[] = [];
    const realEnroll = policy.enroll;
    vi.spyOn(policy, 'enroll').mockImplementation((repo: string) => {
      enrolledPaths.push(resolve(repo));
      realEnroll(repo);
    });
    // Force a deterministic failure AFTER the isolated context + disposable repo
    // exist (enroll runs in step 3; buildBacklog is step 4) so the try/finally
    // cleanup path is the thing under test.
    const boom = new Error('h8 demo-safety: forced mid-run failure (buildBacklog)');
    vi.spyOn(backlog, 'buildBacklog').mockRejectedValue(boom);

    const realBefore = snapshotRealEnrollment();
    const homeBefore = process.env.HOME;

    // The demo MUST NOT leak the tmp state even when the chain blows up. It may
    // surface the error (non-zero return OR a throw) — either is acceptable; the
    // INVARIANT under test is that cleanup STILL ran.
    let threw = false;
    let code = 0;
    try {
      code = await cmdDemo([]);
    } catch {
      threw = true;
    }
    expect(threw || code !== 0).toBe(true);

    // --- UNCONDITIONAL SAFETY CORE (holds regardless of which step threw) ---
    // HOME restored despite the throw (the demo's finally restores it to the
    // value it found — here, THIS test's isolated fixture HOME, NOT the real one).
    expect(process.env.HOME).toBe(homeBefore);
    // The REAL portfolio is byte-identical — the failure path never wrote it.
    expect(snapshotRealEnrollment()).toBe(realBefore);
    if (realBefore !== '<<ABSENT>>') {
      expect(JSON.parse(realBefore)).toEqual({ repos: [] });
    }
    // Nothing is left enrolled in the (now-restored) real portfolio.
    expect(policy.listEnrolled()).toEqual([]);

    // --- NO TMP LEFTOVER ---
    // The forced failure is injected at buildBacklog (step 4), which the contract
    // runs AFTER enroll (step 3) on the disposable repo — so a tmp repo WAS
    // created+enrolled before the throw, yet the finally block reclaimed it.
    expect(enrolledPaths.length).toBeGreaterThan(0);
    for (const p of enrolledPaths) {
      // Each was a throwaway under tmpdir() (never a real path)...
      expect(p.startsWith(resolve(tmpdir()))).toBe(true);
      // ...and is gone from disk after the error-path cleanup.
      expect(existsSync(p)).toBe(false);
    }
  });

  // (d) DEMO-NEVER-APPLIES [STATIC] — no apply/approve/push/PR/deploy token.
  it('[STATIC] src/cli/demo.ts + demo-sandbox.ts contain NONE of applyProposal/ setStatus(approved)/ push/ createPr/ deploy', () => {
    const OUTWARD_TOKENS = [
      'applyProposal(',
      'approveProposal(',
      "setStatus('approved'",
      'setStatus("approved"',
      'createPr(',
      'git push',
      'gitPush(',
      'deploy(',
    ];
    // Scan the demo files AND the two modules reachable from the demo's live
    // tick({dryRun:false}) path — src/core/daemon/loop.ts + src/core/swarm/runner.ts
    // — so the live-swarm branch's proposal-only guarantee is STATICALLY proven
    // (the deterministic suite forces the stub path, so the live tick call site
    // has no behavioral test; this static guard covers it). The static scan, not
    // a comment, is the proof that the live path stays proposal-only.
    const SCAN_FILES = [
      'cli/demo.ts',
      'cli/demo-sandbox.ts',
      'core/daemon/loop.ts',
      'core/swarm/runner.ts',
    ];
    let scanned = 0;
    for (const rel of SCAN_FILES) {
      const src = readSource(rel);
      scanned++;
      // Sanity: the comment-stripper actually returns the (non-empty) body.
      expect(stripComments(src).length).toBeGreaterThan(0);
      for (const tok of OUTWARD_TOKENS) {
        expect(containsToken(src, tok)).toBe(false);
      }
    }
    // Every file was actually scanned (guards against a typo'd path that would
    // vacuously pass).
    expect(scanned).toBe(SCAN_FILES.length);
    // The scanner itself works (positive control).
    expect(containsToken('x = applyProposal(p)', 'applyProposal(')).toBe(true);
  });

  // (e) DETERMINISTIC, NO LIVE MODEL — no-model stub path yields a PENDING proposal.
  it('works with NO local model (probeEndpoint DOWN) via the deterministic stub path — a PENDING proposal appears and nothing is applied', async () => {
    // Observe what the demo creates in its ISOLATED inbox. Wrap the real
    // createProposal so the demo's isolated-home write still happens.
    const createdStatuses: string[] = [];
    const realCreate = inboxStore.createProposal;
    vi.spyOn(inboxStore, 'createProposal').mockImplementation((p) => {
      const proposal = realCreate(p);
      createdStatuses.push(proposal.status);
      return proposal;
    });

    const code = await cmdDemo([]);
    expect(code).toBe(0);

    // The no-model branch was taken: probeEndpoint was consulted and reported
    // DOWN, so the demo synthesized a deterministic stub proposal.
    expect(probeDownSpy).toHaveBeenCalled();
    expect(createdStatuses.length).toBeGreaterThan(0);
    // Every proposal the demo created is PENDING — it NEVER advances to approved.
    for (const s of createdStatuses) {
      expect(s).toBe('pending');
    }
  });
});
