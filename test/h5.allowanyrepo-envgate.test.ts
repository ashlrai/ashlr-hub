/**
 * h5.allowanyrepo-envgate.test.ts — H5 CHANGE 3 (env-gate allowAnyRepo).
 *
 * INVARIANTS proven here:
 *  - ENV-GATE-ENFORCED: allowAnyRepo:true is effective ONLY when
 *    ASHLR_TEST_ALLOW_ANY_REPO==='1'; otherwise an unenrolled repo is REFUSED by
 *    assertMayMutate AND createSandbox (audited result:'refused', no worktree
 *    created, source tree byte-identical). Mirrors the advance.ts precedent.
 *  - KILL-SWITCH precedence holds in BOTH env states: kill ON + allowAnyRepo:true
 *    STILL throws the kill error (env=1 OR unset) because the kill check precedes
 *    the enrollment/allowAnyRepo gate (verify-safety CHECK 2).
 *  - NO-PROD-BEHAVIOR-REGRESSION: production callers pass no allowAnyRepo
 *    (runner.ts) or already env-gate (advance.ts); the ASHLR_TEST_ALLOW_ANY_REPO
 *    env-var set across src/ is exactly the gate/doc sites.
 *
 * SAFETY (inherited verbatim from H1/H2/H4):
 *  - ISOLATED HOME per test via the H1 fixture (makeFixture): every ~/.ashlr
 *    read/write (enrollment, KILL, sandboxes, audit) resolves to a FRESH
 *    os.tmpdir() home, NEVER the real one; the real portfolio ({repos:[]}) is
 *    never touched. The fixture asserts homedir()===tmpHome and refuses otherwise.
 *  - DISPOSABLE REPOS only (fx.makeRepo); DETERMINISTIC (no model, no network).
 *  - This test OWNS the ASHLR_TEST_ALLOW_ANY_REPO toggle (snapshot + restore in
 *    afterEach) — the integration phase sets it fixture-wide for the rest of the
 *    suite, but THIS file flips it per-case to exercise both sides of the gate.
 *  - Every it() has a real expect() + expect.hasAssertions().
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertMayMutate } from '../src/core/sandbox/policy.js';
import {
  createSandbox,
  removeSandbox,
  sandboxesDir,
} from '../src/core/sandbox/worktree.js';
import type { Sandbox } from '../src/core/types.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

let fx: H1Fixture | undefined;
let repo: DisposableRepo;

const ENV_KEY = 'ASHLR_TEST_ALLOW_ANY_REPO';
let prevEnv: string | undefined;
let prevEnvSnapshotted = false;

/** Snapshot the env toggle once per case so afterEach can restore it exactly. */
function snapshotEnv(): void {
  prevEnv = process.env[ENV_KEY];
  prevEnvSnapshotted = true;
}

afterEach(() => {
  // Restore the env toggle regardless of what each case set.
  if (prevEnvSnapshotted) {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
    prevEnv = undefined;
    prevEnvSnapshotted = false;
  }
  fx?.cleanup();
  fx = undefined;
});

function setupRepo(): void {
  fx = makeFixture();
  repo = fx.makeRepo();
}

/** Audit entries written under the (isolated) ~/.ashlr/audit/ tree. */
interface AuditEntry {
  action?: string;
  result?: string;
  summary?: string;
}
function readAuditRecords(home: string): AuditEntry[] {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return [];
  const out: AuditEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as AuditEntry);
      } catch {
        /* tolerate a partial trailing line */
      }
    }
  }
  return out;
}

/** Sandbox ids currently present under the isolated sandboxesDir(). */
function sandboxDirEntries(): string[] {
  const root = sandboxesDir();
  return existsSync(root) ? readdirSync(root) : [];
}

// ===========================================================================
// ENV SET (=1) — the hatch is honored, exactly as before this change.
// ===========================================================================

describe('H5 · allowAnyRepo env-gate · ENV SET (=1) honors the hatch', () => {
  it('assertMayMutate(repo,{allowAnyRepo:true}) passes for an UNENROLLED repo when env=1', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    process.env[ENV_KEY] = '1';
    expect(repo.isEnrolled()).toBe(false);
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).not.toThrow();
  });

  it('createSandbox(repo,{allowAnyRepo:true}) builds a sandbox for an UNENROLLED repo when env=1', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    process.env[ENV_KEY] = '1';
    expect(repo.isEnrolled()).toBe(false);
    let sb: Sandbox | undefined;
    try {
      sb = createSandbox(repo.dir, { allowAnyRepo: true });
      expect(sb.id).toMatch(/^[0-9a-f]+$/);
      expect(sb.branch.startsWith('ashlr/sandbox/')).toBe(true);
      expect(existsSync(sb.worktreePath)).toBe(true);
      // The hatch never enrolls the repo.
      expect(repo.isEnrolled()).toBe(false);
    } finally {
      if (sb) removeSandbox(sb);
    }
  });
});

// ===========================================================================
// ENV UNSET — the hatch is REFUSED (the strengthening this milestone installs).
// ===========================================================================

describe('H5 · allowAnyRepo env-gate · ENV UNSET refuses the hatch (the strengthening)', () => {
  it('assertMayMutate(repo,{allowAnyRepo:true}) THROWS not-enrolled when env is UNSET', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    delete process.env[ENV_KEY];
    expect(repo.isEnrolled()).toBe(false);
    // The hatch is INERT without the env var → enrollment is still enforced.
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).toThrow(
      /repo not enrolled for autonomous work/i,
    );
  });

  it('createSandbox(repo,{allowAnyRepo:true}) is REFUSED + audited + creates no worktree when env is UNSET', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    delete process.env[ENV_KEY];
    expect(repo.isEnrolled()).toBe(false);
    const before = repo.shasumTree();

    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /repo not enrolled for autonomous work/i,
    );

    // No worktree was created under the isolated sandboxesDir().
    expect(sandboxDirEntries()).toEqual([]);

    // Refusal is audited (result:'refused', policy gate) — same path as a
    // no-opts unenrolled refusal: the env-gate makes allowAnyRepo INERT, so the
    // gate sees an unenrolled repo and refuses.
    const audits = readAuditRecords(fx!.home);
    const refusal = audits.find(
      (a) => a.action === 'sandbox:create' && a.result === 'refused',
    );
    expect(refusal).toBeDefined();
    expect(refusal?.summary).toMatch(/refused by policy gate/i);

    // Source repo tree is byte-identical — nothing mutated by the refusal.
    expect(repo.shasumTree()).toBe(before);
  });

  it('ENROLLED repo still mutates without the hatch when env is UNSET (the gate ONLY scopes the hatch, not enrollment)', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    delete process.env[ENV_KEY];
    repo.enroll();
    expect(repo.isEnrolled()).toBe(true);
    // Enrollment — not the hatch — authorizes this; the env-gate is irrelevant.
    expect(() => assertMayMutate(repo.dir)).not.toThrow();
  });
});

// ===========================================================================
// KILL SWITCH precedence — wins over allowAnyRepo in BOTH env states.
// ===========================================================================

describe('H5 · kill switch overrides allowAnyRepo+env in BOTH cases', () => {
  it('kill ON + allowAnyRepo:true + env=1 STILL throws the kill error (kill precedes the gate)', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    process.env[ENV_KEY] = '1';
    fx!.setKill(true);
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).toThrow(
      /kill switch is ON/i,
    );
    // createSandbox refuses too (it calls assertMayMutate first) — no worktree.
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /kill switch is ON/i,
    );
    expect(sandboxDirEntries()).toEqual([]);
  });

  it('kill ON + allowAnyRepo:true + env UNSET STILL throws the kill error (not the enrollment error)', () => {
    expect.hasAssertions();
    setupRepo();
    snapshotEnv();
    delete process.env[ENV_KEY];
    fx!.setKill(true);
    // Kill wins even though the hatch is also inert — the kill check is first.
    expect(() => assertMayMutate(repo.dir, { allowAnyRepo: true })).toThrow(
      /kill switch is ON/i,
    );
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /kill switch is ON/i,
    );
    expect(sandboxDirEntries()).toEqual([]);
  });
});

// ===========================================================================
// NO-PROD-BEHAVIOR-REGRESSION — static source assertions.
// ===========================================================================

describe('H5 · NO-PROD-BEHAVIOR-REGRESSION · production callers never bypass enrollment', () => {
  function readSrc(rel: string): string {
    return readFileSync(join(process.cwd(), 'src', rel), 'utf8');
  }

  it('runner.ts calls createSandbox via _createSandbox(project) with NO opts (no allowAnyRepo)', () => {
    expect.hasAssertions();
    const src = readSrc('core/swarm/runner.ts');
    expect(src).toMatch(/_createSandbox\(project\)/);
    expect(src).not.toMatch(/_createSandbox\([^)]*allowAnyRepo/);
  });

  it('advance.ts already env-gates allowAnyRepo before assertMayMutate', () => {
    expect.hasAssertions();
    const src = readSrc('core/goals/advance.ts');
    expect(src).toMatch(/process\.env\.ASHLR_TEST_ALLOW_ANY_REPO === '1'/);
  });

  it('policy.ts assertMayMutate now env-gates allowAnyRepo (single source of truth) with kill first', () => {
    expect.hasAssertions();
    const src = readSrc('core/sandbox/policy.ts');
    // The gate expression mirrors advance.ts EXACTLY.
    expect(src).toMatch(
      /opts\?\.allowAnyRepo === true &&[\s\S]*process\.env\.ASHLR_TEST_ALLOW_ANY_REPO === '1'/,
    );
    // The kill switch check still precedes the enrollment/allowAnyRepo gate.
    const killIdx = src.indexOf('killSwitchOn(');
    const enrollIdx = src.indexOf('isEnrolled(');
    expect(killIdx).toBeGreaterThan(-1);
    expect(enrollIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeLessThan(enrollIdx);
  });
});
