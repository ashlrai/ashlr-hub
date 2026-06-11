/**
 * test/h6.audit-policy.test.ts — Ashlr v2.1 MILESTONE H6, PART A (BUILD task).
 *
 * Proves the audit-completeness fix landed in src/core/sandbox/policy.ts: the
 * three state-changing safety actions — enroll add, enroll remove, kill-switch
 * toggle — now each emit EXACTLY ONE append-only audit record, on EVERY path:
 *
 *   - PROGRAMMATIC: a direct policy.enroll/unenroll/setKill call (the fixture /
 *     daemon / onboard path) is audited — the emit is at the POLICY PRIMITIVE,
 *     not just the CLI command.
 *   - CLI: cmdEnroll(['add'|'remove'|'kill', …]) is audited too, with NO
 *     DOUBLE-COUNT (the CLI delegates to the same policy.* primitive, so exactly
 *     one record per action — not two).
 *
 * Each record carries the right action verb, the right repo (resolved abs path,
 * or null for kill), result 'ok', and NO secret-shaped token (metadata only).
 * The records live under the ISOLATED ~/.ashlr/audit/ (tmp HOME), never the real
 * one.
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5):
 *  - ISOLATED HOME per test via the H1 fixture (makeFixture): every ~/.ashlr
 *    read/write (enrollment, KILL, audit) resolves to a FRESH os.tmpdir() home,
 *    NEVER the real one; the real portfolio ({repos:[]}) is never touched.
 *  - DISPOSABLE REPOS only (fx.makeRepo); DETERMINISTIC (no model, no network).
 *  - Every it() has a real expect() + expect.hasAssertions().
 */

import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { auditDir } from '../src/core/sandbox/audit.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

let fx: H1Fixture | undefined;

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function setup(): { fx: H1Fixture; repo: DisposableRepo } {
  fx = makeFixture();
  const repo = fx.makeRepo();
  return { fx, repo };
}

// ---------------------------------------------------------------------------
// Audit-trail reader over the ISOLATED ~/.ashlr/audit/ tree. `home` is fx.home
// (tmp); this never touches the real home.
// ---------------------------------------------------------------------------

interface RawAudit {
  ts?: string;
  action?: string;
  repo?: string | null;
  sandboxId?: string | null;
  summary?: string;
  result?: string;
}

function auditDirFor(home: string): string {
  return join(home, '.ashlr', 'audit');
}

function readAuditRecords(home: string): RawAudit[] {
  const dir = auditDirFor(home);
  if (!existsSync(dir)) return [];
  const out: RawAudit[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as RawAudit);
      } catch {
        /* tolerate a partial trailing line — never throw in a reader */
      }
    }
  }
  return out;
}

/** Records whose action exactly matches `action`. */
function withAction(home: string, action: string): RawAudit[] {
  return readAuditRecords(home).filter((r) => r.action === action);
}

// Well-known-SHAPED secrets — used to prove NONE leaks into a record.
const SECRET_SHAPES = [
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36',
  'sk_live_abcdefghijklmnop0123456789',
  'ghp_0123456789abcdefghijABCDEFGHIJ012345',
];

// ===========================================================================
// 1 — enroll add → exactly one enroll:add ok record (programmatic primitive)
// ===========================================================================

describe('H6 · PART A · enroll add is audited (programmatic)', () => {
  it('enroll(repo) writes EXACTLY ONE enroll:add ok record, repo=abs, no secret', () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    expect(readAuditRecords(fx.home)).toHaveLength(0); // clean before

    enroll(repo.dir);

    const adds = withAction(fx.home, 'enroll:add');
    expect(adds).toHaveLength(1);
    const rec = adds[0]!;
    expect(rec.result).toBe('ok');
    expect(rec.repo).toBe(resolve(repo.dir));
    expect(rec.sandboxId).toBeNull();
    expect(typeof rec.ts).toBe('string');

    // Metadata only: no secret-shaped token survives into the serialized line.
    const line = JSON.stringify(rec);
    for (const s of SECRET_SHAPES) expect(line).not.toContain(s);
  });

  it('idempotent re-enroll STILL emits a second enroll:add ok (intent audited)', () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    enroll(repo.dir);
    enroll(repo.dir); // no-op on disk, but the requested intent is still audited

    expect(withAction(fx.home, 'enroll:add')).toHaveLength(2);
  });
});

// ===========================================================================
// 2 — unenroll → exactly one enroll:remove ok record
// ===========================================================================

describe('H6 · PART A · enroll remove is audited (programmatic)', () => {
  it('unenroll(repo) writes EXACTLY ONE enroll:remove ok record, repo=abs', () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    enroll(repo.dir);
    unenroll(repo.dir);

    const removes = withAction(fx.home, 'enroll:remove');
    expect(removes).toHaveLength(1);
    const rec = removes[0]!;
    expect(rec.result).toBe('ok');
    expect(rec.repo).toBe(resolve(repo.dir));
    expect(rec.sandboxId).toBeNull();
  });

  it('no-op unenroll of an absent repo STILL emits enroll:remove ok (intent)', () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    unenroll(repo.dir); // never enrolled — no disk change, but intent audited

    expect(withAction(fx.home, 'enroll:remove')).toHaveLength(1);
  });
});

// ===========================================================================
// 3 — kill toggle → kill:on / kill:off ok records, repo=null
// ===========================================================================

describe('H6 · PART A · kill-switch toggle is audited (both directions)', () => {
  it('setKill(true) emits kill:on ok (repo=null); setKill(false) emits kill:off ok', () => {
    expect.hasAssertions();
    const { fx } = setup();

    setKill(true);
    let on = withAction(fx.home, 'kill:on');
    expect(on).toHaveLength(1);
    expect(on[0]!.result).toBe('ok');
    expect(on[0]!.repo).toBeNull();
    expect(on[0]!.sandboxId).toBeNull();

    setKill(false);
    const off = withAction(fx.home, 'kill:off');
    expect(off).toHaveLength(1);
    expect(off[0]!.result).toBe('ok');
    expect(off[0]!.repo).toBeNull();

    // Re-read kill:on count — setKill(false) must NOT have emitted another on.
    on = withAction(fx.home, 'kill:on');
    expect(on).toHaveLength(1);
  });

  it('idempotent setKill(true) twice emits two kill:on records (intent audited)', () => {
    expect.hasAssertions();
    const { fx } = setup();

    setKill(true);
    setKill(true); // no-op on disk; the requested intent is still audited

    expect(withAction(fx.home, 'kill:on')).toHaveLength(2);
  });
});

// ===========================================================================
// 4 — the CLI path (cmdEnroll) is audited too, with NO DOUBLE-COUNT
// ===========================================================================

describe('H6 · PART A · CLI cmdEnroll audits via the same primitive (no double-count)', () => {
  it('cmdEnroll add/remove/kill each produce EXACTLY ONE record (not two)', async () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    // The CLI delegates to the same policy.* primitive that now emits audit(),
    // so each command must yield exactly one record — never two.
    const { cmdEnroll } = await import('../src/cli/sandbox.js');

    expect(await cmdEnroll(['add', repo.dir])).toBe(0);
    expect(withAction(fx.home, 'enroll:add')).toHaveLength(1);

    expect(await cmdEnroll(['kill', 'on'])).toBe(0);
    expect(withAction(fx.home, 'kill:on')).toHaveLength(1);

    expect(await cmdEnroll(['kill', 'off'])).toBe(0);
    expect(withAction(fx.home, 'kill:off')).toHaveLength(1);

    expect(await cmdEnroll(['remove', repo.dir])).toBe(0);
    const removes = withAction(fx.home, 'enroll:remove');
    expect(removes).toHaveLength(1);
    expect(removes[0]!.repo).toBe(resolve(repo.dir));
  });
});

// ===========================================================================
// 5 — records land under the ISOLATED ~/.ashlr/audit (tmp HOME), never real
// ===========================================================================

describe('H6 · PART A · audit records land under the isolated ~/.ashlr/audit', () => {
  it('auditDir() resolves under the tmp HOME and holds the emitted JSONL', () => {
    expect.hasAssertions();
    const { fx, repo } = setup();

    enroll(repo.dir);

    // The audit dir auditDir() resolves to is the tmp-HOME one, NOT the real one.
    const expectedDir = join(fx.home, '.ashlr', 'audit');
    expect(resolve(auditDir())).toBe(resolve(expectedDir));
    expect(resolve(homedir())).toBe(resolve(fx.home)); // isolation sanity
    expect(existsSync(expectedDir)).toBe(true);

    // At least one JSONL file exists and carries the enroll:add record.
    const files = readdirSync(expectedDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(withAction(fx.home, 'enroll:add')).toHaveLength(1);
  });
});

// ===========================================================================
// 6 — emission never throws out of the three primitives
// ===========================================================================

describe('H6 · PART A · audit emission never disrupts the caller', () => {
  it('enroll/unenroll/setKill return normally (audit swallows its own errors)', () => {
    expect.hasAssertions();
    const { repo } = setup();

    expect(() => enroll(repo.dir)).not.toThrow();
    expect(() => unenroll(repo.dir)).not.toThrow();
    expect(() => setKill(true)).not.toThrow();
    expect(() => setKill(false)).not.toThrow();
  });
});
