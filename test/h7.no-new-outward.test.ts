/**
 * h7.no-new-outward.test.ts — Ashlr v2.1 MILESTONE H7 — the NO-NEW-OUTWARD proof.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H7.md · §H7 INVARIANTS ·
 * NO-NEW-OUTWARD): H7 is an ORCHESTRATION + UX layer over functions that ALREADY
 * exist; it adds NO new outward capability.
 *
 * This suite proves that in TWO complementary modes:
 *
 *  [STATIC] — a source-text scan (no execution) of the THREE new H7 production
 *  files (src/cli/preflight.ts, src/cli/onboard.ts, src/core/readiness.ts) PLUS
 *  the 5 new doctor probes in src/core/doctor.ts, asserting:
 *    - NONE import an outward-capability module (inbox/apply, integrations/github,
 *      ship/*, deploy);
 *    - NONE contain an outward CALL token (applyProposal(, createPr(, git push,
 *      gitPush(, deploy(, setStatus('approved'/"approved", approveProposal();
 *    - onboard NEVER runs a live (non-dry) daemon — it imports no runDaemon, and
 *      every tick(...) call passes dryRun:true (never dryRun:false);
 *    - preflight + readiness add NO new network egress beyond the existing LOCAL
 *      probeEndpoint (no fetch(/createPr/octokit/git push).
 *  This reuses readSource / importLines / stripComments / containsToken from
 *  test/helpers/h4-static.ts — the SAME [STATIC] technique H4/H6 used to prove
 *  the daemon imports no outward primitive.
 *
 *  [BEHAVIORAL] — driven on an ISOLATED tmp HOME (H1 makeFixture) with a
 *  DISPOSABLE repo and probeEndpoint forced DOWN (deterministic, no live model):
 *    - the onboard dry-run PLAN path (renderDryRunPlan) only ever calls `tick`
 *      with { dryRun: true } — a spy proves dryRun is NEVER false;
 *    - buildReadiness (the shared model behind `ashlr preflight` AND the 5 doctor
 *      probes) MUTATES NOTHING: enrollment.json / KILL / daemon.json / sandboxes/
 *      are byte-identical before vs after, and the only transient write — the
 *      ~/.ashlr writeable sentinel — is cleaned up (no leftover artifact);
 *    - a full runDoctor() (which now runs the 5 new read-only probes) likewise
 *      leaves the isolated ~/.ashlr byte-identical;
 *    - and the H4 safety suite + `ashlr verify-safety` still pass unchanged.
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6): ISOLATED tmp HOME per test
 * (the real ~/.ashlr / real portfolio {repos:[]} is NEVER touched), DISPOSABLE
 * repos only, DETERMINISTIC (probeEndpoint mocked DOWN — no network, no model).
 * Every it() has a real expect() and beforeEach calls expect.hasAssertions().
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readSource, importLines, stripComments, containsToken } from './helpers/h4-static.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

// ===========================================================================
// The H7 production surface under test (relative to src/)
// ===========================================================================

/** The THREE genuinely-new H7 production files (scanned in full). */
const H7_NEW_FILES = [
  'cli/preflight.ts',
  'cli/onboard.ts',
  'core/readiness.ts',
] as const;

/**
 * Outward-capability MODULE specifiers no H7 file may import. Mirrors the
 * `forbiddenImports` list in src/cli/verify-safety.ts (CHECK 3) — the modules
 * that EXPORT the outward primitives (apply / GitHub PR / ship / deploy).
 */
const FORBIDDEN_IMPORT_SUBSTRINGS = [
  'inbox/apply',
  'integrations/github',
  'ship/',
  'deploy',
] as const;

/**
 * Outward CALL tokens no H7 file may contain (after comment-stripping). Mirrors
 * src/cli/verify-safety.ts's `forbiddenTokens`, EXTENDED with the H7-specific
 * approve/auto-apply tokens the contract forbids in the onboard surface.
 */
const FORBIDDEN_CALL_TOKENS = [
  'applyProposal(',
  'createPr(',
  'git push',
  'gitPush(',
  'deploy(',
  'approveProposal(',
  "setStatus('approved')",
  'setStatus("approved")',
] as const;

/**
 * Network-egress tokens that would betray a NEW outward call in preflight /
 * readiness. The ONLY permitted network is the existing LOCAL `probeEndpoint`
 * (which itself does the same local model GET `ashlr doctor` already performs);
 * a raw `fetch(` / octokit / PR primitive in these files would be new egress.
 */
const FORBIDDEN_EGRESS_TOKENS = [
  'fetch(',
  'createPr(',
  'octokit',
  'git push',
  'https://api.github.com',
] as const;

// ===========================================================================
// Isolated-HOME byte snapshot helpers (local to this suite)
// ===========================================================================

/**
 * Deterministic byte-snapshot of every file under `dir` (recursively), as a map
 * of dir-relative path -> sha256(bytes). Two snapshots compare equal iff the
 * exact same set of files exist with byte-identical contents. Missing dir => {}.
 */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

/** List every file path (dir-relative) under `dir`. Missing dir => []. */
function listFiles(dir: string): string[] {
  return Object.keys(snapshotDir(dir)).sort();
}

// ===========================================================================
// Suite lifecycle
// ===========================================================================

let fx: H1Fixture | undefined;

beforeEach(() => {
  // Every it() must carry at least one real assertion — guards against the
  // false-green pending stubs the H2–H6 reviews caught.
  expect.hasAssertions();
});

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ===========================================================================
// [STATIC] — source scan: the H7 surface imports/calls NO outward primitive
// ===========================================================================

describe('h7 [STATIC] — NO new outward capability', () => {
  it('preflight.ts / onboard.ts / readiness.ts import NO apply/push/PR/deploy module', () => {
    for (const rel of H7_NEW_FILES) {
      const src = readSource(rel);
      const specs = importLines(src);
      for (const spec of specs) {
        for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
          expect(
            spec.includes(bad),
            `${rel} must not import forbidden outward module '${bad}' (saw '${spec}')`,
          ).toBe(false);
        }
      }
    }
  });

  it('preflight.ts / onboard.ts / readiness.ts contain NO outward CALL token (apply/createPr/push/deploy/approve)', () => {
    for (const rel of H7_NEW_FILES) {
      const src = readSource(rel);
      for (const tok of FORBIDDEN_CALL_TOKENS) {
        expect(
          containsToken(src, tok),
          `${rel} must not contain forbidden outward call token '${tok}'`,
        ).toBe(false);
      }
    }
  });

  it('onboard.ts does NOT import applyProposal and NEVER runs a live (non-dry) daemon', () => {
    const src = readSource('cli/onboard.ts');
    const stripped = stripComments(src);

    // No apply primitive imported or called.
    expect(importLines(src).some((s) => s.includes('inbox/apply'))).toBe(false);
    expect(stripped.includes('applyProposal(')).toBe(false);

    // It does NOT run a live daemon: no runDaemon import/call at all (onboard
    // uses tick(...,{dryRun:true}) only).
    expect(importLines(src).some((s) => s.includes('runDaemon'))).toBe(false);
    expect(stripped.includes('runDaemon(')).toBe(false);

    // Every dry-run path is explicitly dryRun:true and NEVER dryRun:false.
    expect(stripped.includes('dryRun: true') || stripped.includes('dryRun:true')).toBe(true);
    expect(stripped.includes('dryRun: false')).toBe(false);
    expect(stripped.includes('dryRun:false')).toBe(false);
  });

  it('preflight.ts + readiness.ts add NO new network egress beyond the existing probeEndpoint', () => {
    for (const rel of ['cli/preflight.ts', 'core/readiness.ts'] as const) {
      const src = readSource(rel);
      const stripped = stripComments(src);
      for (const tok of FORBIDDEN_EGRESS_TOKENS) {
        expect(
          stripped.includes(tok),
          `${rel} must not add new network egress token '${tok}' (only the existing local probeEndpoint is allowed)`,
        ).toBe(false);
      }
    }
    // readiness's ONLY network is the existing local probeEndpoint import — assert
    // that IS the egress mechanism (so the negative scan above is meaningful, not
    // vacuous because the file simply does no network at all).
    const readiness = readSource('core/readiness.ts');
    expect(importLines(readiness).some((s) => s.includes('providers'))).toBe(true);
    expect(stripComments(readiness).includes('probeEndpoint(')).toBe(true);
  });

  it('the 5 new doctor probes import the SHARED read-only readiness facets and add NO outward primitive', () => {
    const src = readSource('core/doctor.ts');
    const stripped = stripComments(src);

    // The 5 probes are wired through the shared readiness module (single source
    // of truth) — assert the read-only facet imports are present...
    const specs = importLines(src);
    expect(specs.some((s) => s.includes('readiness'))).toBe(true);
    for (const facet of [
      'readEnrollmentState',
      'readKillState',
      'readDaemonHealth',
      'readSandboxHealth',
      'checkAshlrWriteable',
    ]) {
      expect(stripped.includes(facet), `doctor.ts must call the shared facet ${facet}`).toBe(true);
    }

    // ...and assert doctor still imports NO outward-capability module (the H7
    // additions did not smuggle one in).
    for (const spec of specs) {
      for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
        expect(
          spec.includes(bad),
          `doctor.ts must not import forbidden outward module '${bad}' (saw '${spec}')`,
        ).toBe(false);
      }
    }
  });
});

// ===========================================================================
// [BEHAVIORAL] — the onboard dry-run path only ever ticks with dryRun:true
// ===========================================================================

describe('h7 [BEHAVIORAL] — onboard dry-run ticks ONLY with dryRun:true', () => {
  it('renderDryRunPlan calls tick exclusively with { dryRun: true } — never a live run', async () => {
    fx = makeFixture();
    const repo = fx.makeRepo({ files: { 'README.md': '# r\n', 'src/a.ts': '// TODO: x\nexport const a = 1;\n' } });
    repo.enroll();

    // Spy on the REAL tick so we observe exactly how onboard invokes it. We do
    // NOT replace its behavior beyond recording — but we force a no-op return so
    // the test stays deterministic with NO live model and NO real swarm.
    const loop = await import('../src/core/daemon/loop.js');
    const tickSpy = vi
      .spyOn(loop, 'tick')
      .mockResolvedValue({
        ts: new Date().toISOString(),
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'dry-run',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    const onboard = await import('../src/cli/onboard.js');
    const plan = await onboard.renderDryRunPlan(makeCfg());

    // The plan IS produced (read-only) ...
    expect(typeof plan).toBe('string');
    expect(plan.toLowerCase()).toContain('plan');

    // ... and tick was invoked, but ONLY ever with dryRun:true.
    expect(tickSpy).toHaveBeenCalled();
    for (const call of tickSpy.mock.calls) {
      const opts = call[1] as { dryRun?: boolean } | undefined;
      expect(opts?.dryRun).toBe(true);
    }
    // Assert the negative explicitly: no call ever passed dryRun:false.
    const everLive = tickSpy.mock.calls.some((c) => (c[1] as { dryRun?: boolean })?.dryRun === false);
    expect(everLive).toBe(false);
  });
});

// ===========================================================================
// [BEHAVIORAL] — the REAL dry-run tick creates ZERO proposals and spends $0
// (stubs ONLY probeEndpoint — NOT tick — so the no-proposal/$0 invariant is
// proven by observed behavior of tick's actual dryRun branch, not mock-args)
// ===========================================================================

describe('h7 [BEHAVIORAL] — the REAL dry-run tick creates no proposal and spends $0', () => {
  it('renderDryRunPlan over a REAL dryRun:true tick leaves pending proposals unchanged + $0', async () => {
    fx = makeFixture();

    // Stub ONLY the model probe down (deterministic, no network). tick is NOT
    // mocked here — the dryRun:true branch runs for real over a seeded backlog.
    const providers = await import('../src/core/providers.js');
    vi.spyOn(providers, 'probeEndpoint').mockResolvedValue({
      id: 'lmstudio',
      url: 'http://127.0.0.1:1234/v1/models',
      up: false,
      models: [],
      error: 'stubbed-down',
    });

    // A disposable, enrolled repo with a seeded backlog so the dry-run has
    // candidate items to "consider".
    const { seedBacklog } = await import('./helpers/h1-fixture.js');
    const repo = fx.makeRepo();
    repo.enroll();
    seedBacklog(fx.home, repo.dir, [{ title: 'Real dry-run item A' }, { title: 'Real dry-run item B' }]);

    const inboxStore = await import('../src/core/inbox/store.js');
    const { loadDaemonState } = await import('../src/core/daemon/state.js');

    const pendingBefore = inboxStore.listProposals({ status: 'pending' }).length;
    const spentBefore = loadDaemonState().todaySpentUsd ?? 0;

    const onboard = await import('../src/cli/onboard.js');
    const plan = await onboard.renderDryRunPlan(makeCfg());

    // The plan IS produced (so this is a real run, not a no-op) and reports
    // that work WOULD run — proving the real dryRun branch actually selected
    // items over the enrolled repo (the daemon rebuilds the backlog from a fresh
    // scan inside tick, so we assert the count line, not a seeded title).
    expect(typeof plan).toBe('string');
    expect(plan.toLowerCase()).toContain('plan');
    expect(plan).toMatch(/item\(s\) would run/);

    // BEHAVIORAL invariant: a REAL dryRun:true tick created NO proposal ...
    const pendingAfter = inboxStore.listProposals({ status: 'pending' }).length;
    expect(pendingAfter).toBe(pendingBefore);
    expect(inboxStore.listProposals({ status: 'applied' })).toEqual([]);
    // ... and spent $0 (the dry-run branch returns spentUsd:0 and never bills).
    const spentAfter = loadDaemonState().todaySpentUsd ?? 0;
    expect(spentAfter).toBe(spentBefore);
    expect(spentAfter).toBe(0);
  });
});

// ===========================================================================
// [BEHAVIORAL] — preflight/readiness + the 5 doctor probes MUTATE NOTHING
// ===========================================================================

describe('h7 [BEHAVIORAL] — readiness + doctor probes mutate the isolated ~/.ashlr NOTHING', () => {
  /** Force every model probe DOWN so the run is deterministic + network-free. */
  async function stubProbesDown(): Promise<void> {
    const providers = await import('../src/core/providers.js');
    vi.spyOn(providers, 'probeEndpoint').mockImplementation(async (id: string, url: string) => ({
      id,
      url,
      up: false,
      models: [],
      error: 'stubbed-down',
    }));
  }

  it('buildReadiness leaves enrollment.json / KILL / daemon.json / sandboxes/ byte-identical and leaves NO sentinel', async () => {
    fx = makeFixture();
    await stubProbesDown();

    // Seed some real state so a snapshot has something to be unchanged ABOUT:
    // an enrolled repo (writes enrollment.json) under the isolated HOME.
    const repo = fx.makeRepo();
    repo.enroll();
    expect(repo.isEnrolled()).toBe(true);

    const ashlrDir = fx.ashlrDir;
    expect(existsSync(join(ashlrDir, 'enrollment.json'))).toBe(true);

    const before = snapshotDir(ashlrDir);
    const filesBefore = listFiles(ashlrDir);

    const { buildReadiness } = await import('../src/core/readiness.js');
    const report = await buildReadiness(makeCfg());

    // The report was actually produced (so the no-mutation claim is about a REAL
    // run, not a no-op) and is well-formed.
    expect(report).toBeTruthy();
    expect(typeof report.ready).toBe('boolean');
    expect(Array.isArray(report.blockers)).toBe(true);

    const after = snapshotDir(ashlrDir);
    const filesAfter = listFiles(ashlrDir);

    // Byte-identical: no enrollment/kill/daemon/sandbox mutation.
    expect(after).toEqual(before);
    // And NO new persistent artifact — in particular no leftover writeable
    // sentinel (.ashlr-preflight-*.tmp) from checkAshlrWriteable.
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.some((f) => f.includes('preflight') && f.endsWith('.tmp'))).toBe(false);
  });

  it('buildReadiness does not toggle the kill switch (KILL absent stays absent; never created)', async () => {
    fx = makeFixture();
    await stubProbesDown();
    const killPath = join(fx.ashlrDir, 'KILL');

    expect(existsSync(killPath)).toBe(false);
    const { buildReadiness } = await import('../src/core/readiness.js');
    const report = await buildReadiness(makeCfg());
    expect(report.ready === true || report.ready === false).toBe(true);
    // readiness only READS the kill switch — it never writes it.
    expect(existsSync(killPath)).toBe(false);
  });

  it('a full runDoctor (incl. the 5 new H7 probes) leaves the isolated ~/.ashlr byte-identical', async () => {
    fx = makeFixture();
    await stubProbesDown();

    // Pre-create ~/.ashlr with seeded state so the snapshot is meaningful.
    const repo = fx.makeRepo();
    repo.enroll();
    const ashlrDir = fx.ashlrDir;
    mkdirSync(ashlrDir, { recursive: true });

    const before = snapshotDir(ashlrDir);
    const filesBefore = listFiles(ashlrDir);

    const { runDoctor } = await import('../src/core/doctor.js');
    const report = await runDoctor(makeCfg());

    // The doctor actually ran AND included the 5 new H7 read-only probes.
    expect(Array.isArray(report.checks)).toBe(true);
    const ids = new Set(report.checks.map((c) => c.id));
    for (const probeId of ['enrollment', 'daemon-state', 'kill-switch', 'ashlr-writeable', 'sandbox-health']) {
      expect(ids.has(probeId), `doctor must include the new H7 probe '${probeId}'`).toBe(true);
    }
    // None of the new probes FAILED in a way that mutated state; in a healthy
    // isolated writeable HOME, ashlr-writeable must pass (proving the sentinel
    // write+unlink round-tripped without leaving an artifact).
    const writeable = report.checks.find((c) => c.id === 'ashlr-writeable');
    expect(writeable?.status).toBe('pass');

    const after = snapshotDir(ashlrDir);
    const filesAfter = listFiles(ashlrDir);

    // Byte-identical: no probe mutated enrollment/kill/daemon/sandbox state, and
    // the transient writeable sentinel was cleaned up.
    expect(after).toEqual(before);
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.some((f) => f.includes('preflight') && f.endsWith('.tmp'))).toBe(false);
  });

  it('checkAshlrWriteable round-trips its sentinel: returns true on a writeable HOME and leaves no .tmp behind', async () => {
    fx = makeFixture();
    const ashlrDir = fx.ashlrDir;
    mkdirSync(ashlrDir, { recursive: true });

    const before = listFiles(ashlrDir);
    const { checkAshlrWriteable } = await import('../src/core/readiness.js');
    const ok = checkAshlrWriteable();

    expect(ok).toBe(true);
    const after = listFiles(ashlrDir);
    // No sentinel artifact persists — the write+unlink fully round-tripped.
    expect(after).toEqual(before);
    expect(after.some((f) => f.includes('preflight') && f.endsWith('.tmp'))).toBe(false);
  });
});

// ===========================================================================
// [BEHAVIORAL] — the H4 safety suite + verify-safety still pass unchanged
// ===========================================================================

describe('h7 [BEHAVIORAL] — H4 safety regression: verify-safety still GREEN after H7', () => {
  /** Run `fn` capturing stdout/stderr so verify-safety's report does not leak. */
  async function silently<T>(fn: () => Promise<T>): Promise<T> {
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (): boolean => true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (): boolean => true;
    try {
      return await fn();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  }

  it('runSafetyChecks reports ok=true — H7 weakened no guard the H4 self-check enforces', async () => {
    fx = makeFixture();
    const before = snapshotDir(fx.ashlrDir);

    const { runSafetyChecks } = await import('../src/cli/verify-safety.js');
    const report = await runSafetyChecks();

    // The H4 self-check still passes in full after the H7 additions.
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => c.pass)).toBe(true);

    // verify-safety remains side-effect-free under the isolated HOME.
    expect(snapshotDir(fx.ashlrDir)).toEqual(before);
  });

  it('cmdVerifySafety exits 0 on the real build (the CI safety gate stays green)', async () => {
    fx = makeFixture();
    const { cmdVerifySafety } = await import('../src/cli/verify-safety.js');
    const code = await silently(() => cmdVerifySafety([]));
    expect(code).toBe(0);
  });
});
