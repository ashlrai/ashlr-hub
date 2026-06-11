/**
 * h6.audit-completeness.test.ts — Ashlr v2.1 MILESTONE H6, PART A.
 *
 * INVARIANTS proven here (see docs/contracts/CONTRACT-H6.md §A):
 *  - AUDIT-COMPLETE: enroll add / enroll remove / kill-switch toggle each emit
 *    an append-only audit record on EVERY path (programmatic policy.* call OR the
 *    CLI cmdEnroll) — captured at the policy.ts primitive, not just the command.
 *  - METADATA-ONLY: records carry an action verb + a repo ABS PATH (a path is not
 *    a secret) + result 'ok'; NO secret-shaped token survives into the line.
 *  - INTENT-AUDITED: an idempotent no-op enroll/unenroll STILL emits (intent).
 *  - NO-IMPORT-CYCLE: audit.ts does NOT import policy.ts (policy.ts imports
 *    audit.ts) — [STATIC] guard.
 *  - VIEWER-READ-ONLY: `ashlr audit` filters (--action/--result/--since/--limit)
 *    over readAudit() output and MUTATES NOTHING (audit files byte-identical).
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5):
 *  - ISOLATED HOME per test via the H1 fixture (makeFixture): every ~/.ashlr
 *    read/write (enrollment, KILL, audit) resolves to a FRESH os.tmpdir() home,
 *    NEVER the real one; the real portfolio ({repos:[]}) is never touched.
 *  - DISPOSABLE REPOS only (fx.makeRepo); DETERMINISTIC (no model, no network).
 *  - Every it() has a real expect() + expect.hasAssertions() — no pending stubs.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  enroll,
  unenroll,
  setKill,
} from '../src/core/sandbox/policy.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { readSource, stripComments } from './helpers/h4-static.js';
import { cmdAudit } from '../src/cli/audit.js';

let fx: H1Fixture | undefined;
let repo: DisposableRepo;

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function setupRepo(): void {
  fx = makeFixture();
  repo = fx.makeRepo();
}

// ---------------------------------------------------------------------------
// Audit-trail reader over the ISOLATED ~/.ashlr/audit/ tree (test-local; mirrors
// the h5 helper). Never touches the real home — `home` is fx.home (tmp).
// ---------------------------------------------------------------------------

interface RawAudit {
  ts?: string;
  action?: string;
  repo?: string | null;
  sandboxId?: string | null;
  summary?: string;
  result?: string;
}

function readAuditRecords(home: string): RawAudit[] {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return [];
  const out: RawAudit[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as RawAudit);
      } catch {
        /* tolerate a partial trailing line */
      }
    }
  }
  return out;
}

/** Concatenated raw bytes of every audit JSONL file (for the no-mutation snapshot). */
function auditDirBytes(home: string): string {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => `${f}\0${readFileSync(join(dir, f), 'utf8')}`)
    .join('\0\0');
}

// A handful of well-known-SHAPED secrets — used to prove NONE leaks into a record.
const SECRET_SHAPES = [
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36',
  'sk_live_abcdefghijklmnop0123456789',
];

// ===========================================================================
// A.1 — enroll add is audited (programmatic primitive path)
// ===========================================================================

describe('H6 · PART A · enroll add → audit enroll:add ok', () => {
  it('enroll(repo) emits an enroll:add ok record with repo=abs and NO secret', () => {
    expect.hasAssertions();
    setupRepo();
    // The H6 fix emits audit() INSIDE policy.enroll, so EVERY path (CLI or
    // programmatic) is captured. A fresh enroll:add ok record exists, repo is the
    // resolved abs path, and the serialized line carries NONE of SECRET_SHAPES.
    enroll(repo.dir);
    const recs = readAuditRecords(fx!.home);
    const rec = recs.find((r) => r.action === 'enroll:add' && r.result === 'ok');
    expect(rec).toBeDefined();
    expect(rec?.repo).toBe(repo.dir);
    expect(rec?.sandboxId).toBeNull();
    const line = JSON.stringify(rec);
    for (const s of SECRET_SHAPES) expect(line).not.toContain(s);
  });

  it('idempotent re-enroll STILL emits a second enroll:add ok (intent audited)', () => {
    expect.hasAssertions();
    setupRepo();
    enroll(repo.dir);
    enroll(repo.dir); // no-op write, but the INTENT is still audited
    const adds = readAuditRecords(fx!.home).filter(
      (r) => r.action === 'enroll:add' && r.result === 'ok' && r.repo === repo.dir,
    );
    expect(adds.length).toBe(2);
  });
});

// ===========================================================================
// A.2 — enroll remove is audited
// ===========================================================================

describe('H6 · PART A · enroll remove → audit enroll:remove ok', () => {
  it('unenroll(repo) emits an enroll:remove ok record with repo=abs', () => {
    expect.hasAssertions();
    setupRepo();
    enroll(repo.dir);
    unenroll(repo.dir);
    const rec = readAuditRecords(fx!.home).find(
      (r) => r.action === 'enroll:remove' && r.result === 'ok',
    );
    expect(rec).toBeDefined();
    expect(rec?.repo).toBe(repo.dir);
    expect(rec?.sandboxId).toBeNull();
    const line = JSON.stringify(rec);
    for (const s of SECRET_SHAPES) expect(line).not.toContain(s);
  });

  it('no-op unenroll of an absent repo STILL emits enroll:remove ok (intent)', () => {
    expect.hasAssertions();
    setupRepo();
    // repo was never enrolled — the write is a no-op, but the intent is audited.
    unenroll(repo.dir);
    const removes = readAuditRecords(fx!.home).filter(
      (r) => r.action === 'enroll:remove' && r.result === 'ok' && r.repo === repo.dir,
    );
    expect(removes.length).toBe(1);
  });
});

// ===========================================================================
// A.3 — kill-switch toggle is audited (both directions), repo=null
// ===========================================================================

describe('H6 · PART A · kill toggle → audit kill:on / kill:off ok', () => {
  it('setKill(true) emits kill:on ok with repo=null; setKill(false) emits kill:off ok', () => {
    expect.hasAssertions();
    setupRepo();
    setKill(true);
    setKill(false);
    const recs = readAuditRecords(fx!.home);
    const on = recs.find((r) => r.action === 'kill:on' && r.result === 'ok');
    const off = recs.find((r) => r.action === 'kill:off' && r.result === 'ok');
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    // Kill toggles are NOT repo-scoped — repo is null on both.
    expect(on?.repo).toBeNull();
    expect(off?.repo).toBeNull();
    const line = JSON.stringify(recs);
    for (const s of SECRET_SHAPES) expect(line).not.toContain(s);
  });
});

// ===========================================================================
// A.4 — NO import cycle: audit.ts must not import policy.ts ([STATIC])
// ===========================================================================

describe('H6 · PART A · no import cycle (audit.ts does not import policy.ts)', () => {
  it('audit.ts imports neither policy nor cli; policy.ts imports ./audit.js', () => {
    expect.hasAssertions();
    const auditSrc = stripComments(readSource('core/sandbox/audit.ts'));
    // audit.ts must NOT import policy (that would create a cycle once policy.ts
    // imports audit.ts in the H6 fix).
    expect(auditSrc).not.toMatch(/from ['"][^'"]*policy(\.js)?['"]/);
    expect(auditSrc).not.toMatch(/from ['"][^'"]*\/cli\//);
    // The H6 fix wires the dependency in the SAFE direction: policy.ts imports
    // ./audit.js (not the reverse), so the static import creates NO cycle.
    const polSrc = stripComments(readSource('core/sandbox/policy.ts'));
    expect(polSrc).toMatch(/import \{ audit \} from ['"]\.\/audit\.js['"]/);
  });
});

// ===========================================================================
// A.5 — audit() never throws out of enroll/unenroll/setKill
// ===========================================================================

describe('H6 · PART A · audit emission never disrupts the caller', () => {
  it('enroll/unenroll/setKill return normally (audit swallows its own errors)', () => {
    expect.hasAssertions();
    setupRepo();
    // audit() already swallows all internal errors; the H6 fix preserves the
    // "never throws (except the intentional assert)" contract of these three.
    expect(() => enroll(repo.dir)).not.toThrow();
    expect(() => unenroll(repo.dir)).not.toThrow();
    expect(() => setKill(true)).not.toThrow();
    expect(() => setKill(false)).not.toThrow();
  });
});

// ===========================================================================
// A.6 — the `ashlr audit` viewer: filters + read-only
// ===========================================================================

describe('H6 · PART A · ashlr audit viewer (read-only)', () => {
  it('cmdAudit reads ONLY — audit files are byte-identical before/after a run', async () => {
    expect.hasAssertions();
    setupRepo();
    // Seed a few records via the real primitives (each now audits, post-H6).
    enroll(repo.dir);
    setKill(true);
    setKill(false);

    // Capture the audit dir bytes + an mtime fingerprint BEFORE the viewer runs.
    const before = auditDirBytes(fx!.home);
    const auditDir = join(fx!.home, '.ashlr', 'audit');
    const mtimesBefore = readdirSync(auditDir)
      .map((f) => `${f}:${statSync(join(auditDir, f)).mtimeMs}`)
      .sort()
      .join('|');

    // Run the REAL viewer across a couple of invocations (human + json + filtered).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdAudit([])).toBe(0);
      expect(await cmdAudit(['--json'])).toBe(0);
      expect(await cmdAudit(['--action', 'enroll', '--result', 'ok'])).toBe(0);
    } finally {
      logSpy.mockRestore();
    }

    // The viewer mutated NOTHING — bytes AND mtimes are unchanged.
    expect(auditDirBytes(fx!.home)).toBe(before);
    const mtimesAfter = readdirSync(auditDir)
      .map((f) => `${f}:${statSync(join(auditDir, f)).mtimeMs}`)
      .sort()
      .join('|');
    expect(mtimesAfter).toBe(mtimesBefore);
  });
});

// ===========================================================================
// A.7 — DISPATCHER WIRING (H6 review finding): the direct-cmdAudit tests above
// validate the command's BEHAVIOR but never traverse the dispatcher path
// (src/cli/index.ts: `case 'audit'` -> loadAuditCmd -> ./audit.js). A future
// edit that unwires 'audit' from the switch would leave those tests GREEN while
// `ashlr audit` became unreachable. This pins the wiring at the SOURCE level —
// the same proven pattern as m26.dispatch.test.ts (no subprocess, deterministic,
// no live tooling) — plus a runtime module-contract import so the loader's
// target export is real.
// ===========================================================================

describe('H6 · PART A · audit — dispatcher wiring (src/cli/index.ts)', () => {
  const indexSrc = readFileSync(
    join(__dirname, '..', 'src', 'cli', 'index.ts'),
    'utf8',
  );

  it('defines a loadAuditCmd lazyCmd loader importing ./audit.js', () => {
    expect.hasAssertions();
    expect(indexSrc).toMatch(/const\s+loadAuditCmd\s*=\s*lazyCmd\s*\(/);
    expect(indexSrc).toMatch(/import\(\s*['"]\.\/audit\.js['"]\s*\)/);
    expect(indexSrc).toMatch(/cmdAudit\s+as\s+Cmd/);
  });

  it("has a `case 'audit':` in the dispatch switch that invokes the loader", () => {
    expect.hasAssertions();
    expect(indexSrc).toMatch(/case\s+['"]audit['"]\s*:/);
    const caseIdx = indexSrc.indexOf("case 'audit'");
    expect(caseIdx).toBeGreaterThan(-1);
    const caseBody = indexSrc.slice(caseIdx, caseIdx + 400);
    expect(caseBody).toMatch(/loadAuditCmd\s*\(/);
  });

  it('the audit command module exposes the cmdAudit export the loader expects', async () => {
    expect.hasAssertions();
    const mod = await import('../src/cli/audit.js');
    expect(typeof mod.cmdAudit).toBe('function');
  });
});
