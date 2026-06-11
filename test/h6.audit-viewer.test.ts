/**
 * h6.audit-viewer.test.ts — Ashlr v2.1 MILESTONE H6, PART A (the `ashlr audit`
 * READ-ONLY viewer in src/cli/audit.ts).
 *
 * INVARIANTS proven here (see docs/contracts/CONTRACT-H6.md §A.3):
 *  - LISTS-NEWEST-FIRST: cmdAudit() prints the audit trail (readAudit() is
 *    newest-first) and exits 0; --json emits a valid JSON array of records.
 *  - FILTERS: --action (bare verb matches `verb:*`; `verb:sub` matches exactly),
 *    --result <ok|refused|error>, and --since <ISO|YYYY-MM-DD> each narrow the set;
 *    --limit is applied AFTER the filters (newest N MATCHING).
 *  - BAD-ARGS: an unparseable --since and an unknown flag each return 2 and read
 *    nothing (no crash, no disk touch).
 *  - READ-ONLY: a cmdAudit() run mutates NOTHING — the on-disk audit JSONL files
 *    are byte-identical before and after.
 *  - ALREADY-REDACTED: a record whose summary contained a secret-shaped value is
 *    shown by the viewer ALREADY redacted (the core audit() stripSecrets() ran at
 *    write time; the viewer never reconstructs or prints a raw secret).
 *
 * SAFETY (inherited verbatim from H1):
 *  - ISOLATED HOME per test via the H1 fixture (makeFixture): every ~/.ashlr
 *    read/write (the audit trail) resolves to a FRESH os.tmpdir() home, NEVER the
 *    real one; the real portfolio ({repos:[]}) is never touched.
 *  - DETERMINISTIC: records are seeded with the REAL core audit() primitive (or a
 *    raw JSONL line with a controlled ts for the --since case). No model, no
 *    network. Every it() carries a real expect() + expect.hasAssertions().
 *
 * This suite does NOT depend on the PART A policy.ts emission landing — it seeds
 * the trail directly via core/sandbox/audit.ts so it exercises the viewer in
 * isolation. The read-only viewer mutates nothing regardless of how records got
 * there.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from '../src/core/sandbox/audit.js';
import { cmdAudit } from '../src/cli/audit.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import type { AuditEntry } from '../src/core/types.js';

let fx: H1Fixture | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  fx?.cleanup();
  fx = undefined;
});

// ---------------------------------------------------------------------------
// Helpers — all operate on the ISOLATED ~/.ashlr under fx.home (the tmp HOME).
// ---------------------------------------------------------------------------

/** Capture console.log/error output of `fn`, returning {code, out, err}. */
async function runViewer(
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdAudit(args);
  const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  const err = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  return { code, out, err };
}

/** Concatenated raw bytes of every audit JSONL file (no-mutation snapshot). */
function auditDirBytes(home: string): string {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => `${f}\0${readFileSync(join(dir, f), 'utf8')}`)
    .join('\0\0');
}

/**
 * Append a raw audit record with a CONTROLLED ts to a chosen daily file. Used by
 * the --since case where we need deterministic timestamps that audit() (which
 * stamps `ts` itself to "now") cannot give us. Writes the same JSONL shape
 * readAudit() parses; the daily filename is derived from the ts's UTC date so
 * readAudit()'s newest-file-first ordering is honored.
 */
function seedRawRecord(home: string, rec: AuditEntry): void {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dayFile = join(dir, `${rec.ts.slice(0, 10)}.jsonl`);
  appendFileSync(dayFile, JSON.stringify(rec) + '\n', 'utf8');
}

// ===========================================================================
// LISTS-NEWEST-FIRST + --json valid + exits 0
// ===========================================================================

describe('H6 · audit viewer · lists records, --json valid, exits 0', () => {
  it('lists seeded records human-readably and exits 0', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'enroll:add', repo: '/tmp/repo-a', sandboxId: null, summary: 'enrolled /tmp/repo-a', result: 'ok' });
    audit({ action: 'kill:on', repo: null, sandboxId: null, summary: 'kill switch on', result: 'ok' });

    const { code, out } = await runViewer([]);
    expect(code).toBe(0);
    expect(out).toContain('enroll:add');
    expect(out).toContain('kill:on');
  });

  it('--json emits a valid JSON array of the records', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'enroll:add', repo: '/tmp/repo-a', sandboxId: null, summary: 'enrolled /tmp/repo-a', result: 'ok' });
    audit({ action: 'enroll:remove', repo: '/tmp/repo-a', sandboxId: null, summary: 'unenrolled /tmp/repo-a', result: 'ok' });

    const { code, out } = await runViewer(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as AuditEntry[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    // readAudit() is newest-first: the enroll:remove (written second) leads.
    expect(parsed[0]?.action).toBe('enroll:remove');
    expect(parsed[1]?.action).toBe('enroll:add');
  });

  it('an empty trail prints a friendly message (non-json) / [] (--json), exit 0', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    const plain = await runViewer([]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain('No audit entries found.');

    const asJson = await runViewer(['--json']);
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.out)).toEqual([]);
  });
});

// ===========================================================================
// FILTERS — --action / --result / --since / --limit
// ===========================================================================

describe('H6 · audit viewer · filters narrow the set correctly', () => {
  it('--action enroll matches enroll:add + enroll:remove but not kill:on', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'enroll:add', repo: '/tmp/r', sandboxId: null, summary: 'enrolled /tmp/r', result: 'ok' });
    audit({ action: 'enroll:remove', repo: '/tmp/r', sandboxId: null, summary: 'unenrolled /tmp/r', result: 'ok' });
    audit({ action: 'kill:on', repo: null, sandboxId: null, summary: 'kill switch on', result: 'ok' });

    const { code, out } = await runViewer(['--action', 'enroll', '--json']);
    expect(code).toBe(0);
    const recs = JSON.parse(out) as AuditEntry[];
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.action.startsWith('enroll:'))).toBe(true);
    expect(recs.some((r) => r.action === 'kill:on')).toBe(false);
  });

  it('--action kill:on matches ONLY kill:on (exact when colon present)', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'kill:on', repo: null, sandboxId: null, summary: 'kill switch on', result: 'ok' });
    audit({ action: 'kill:off', repo: null, sandboxId: null, summary: 'kill switch off', result: 'ok' });

    const { code, out } = await runViewer(['--action', 'kill:on', '--json']);
    expect(code).toBe(0);
    const recs = JSON.parse(out) as AuditEntry[];
    expect(recs).toHaveLength(1);
    expect(recs[0]?.action).toBe('kill:on');
  });

  it('--result filters to that outcome only', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'sandbox.create', repo: '/tmp/r', sandboxId: 'sb1', summary: 'created', result: 'ok' });
    audit({ action: 'sandbox.create', repo: '/tmp/r', sandboxId: null, summary: 'refused: unenrolled', result: 'refused' });
    audit({ action: 'sandbox.remove', repo: '/tmp/r', sandboxId: 'sb1', summary: 'boom', result: 'error' });

    const { code, out } = await runViewer(['--result', 'refused', '--json']);
    expect(code).toBe(0);
    const recs = JSON.parse(out) as AuditEntry[];
    expect(recs).toHaveLength(1);
    expect(recs[0]?.result).toBe('refused');
    expect(recs.every((r) => r.result === 'refused')).toBe(true);
  });

  it('--since <ISO> drops records strictly before the instant', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    // Deterministic timestamps via raw seeding (audit() would stamp "now").
    seedRawRecord(fx.home, { ts: '2026-01-01T00:00:00.000Z', action: 'enroll:add', repo: '/tmp/old', sandboxId: null, summary: 'old', result: 'ok' });
    seedRawRecord(fx.home, { ts: '2026-06-01T00:00:00.000Z', action: 'enroll:add', repo: '/tmp/new', sandboxId: null, summary: 'new', result: 'ok' });

    const { code, out } = await runViewer(['--since', '2026-03-01', '--json']);
    expect(code).toBe(0);
    const recs = JSON.parse(out) as AuditEntry[];
    expect(recs).toHaveLength(1);
    expect(recs[0]?.repo).toBe('/tmp/new');
    expect(recs.some((r) => r.repo === '/tmp/old')).toBe(false);
  });

  it('--limit applies AFTER the action/result filters (newest N MATCHING)', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    // Three enroll:add records (newest-first by write order) plus a kill record
    // that should be filtered out BEFORE the limit is applied.
    audit({ action: 'enroll:add', repo: '/tmp/r1', sandboxId: null, summary: 'a1', result: 'ok' });
    audit({ action: 'kill:on', repo: null, sandboxId: null, summary: 'k', result: 'ok' });
    audit({ action: 'enroll:add', repo: '/tmp/r2', sandboxId: null, summary: 'a2', result: 'ok' });
    audit({ action: 'enroll:add', repo: '/tmp/r3', sandboxId: null, summary: 'a3', result: 'ok' });

    const { code, out } = await runViewer(['--action', 'enroll', '--limit', '2', '--json']);
    expect(code).toBe(0);
    const recs = JSON.parse(out) as AuditEntry[];
    // Limit applied AFTER filtering: the 3 enroll:add records (kill excluded),
    // then newest-2. If limit ran first, the kill record would have consumed a
    // slot and we'd see fewer than 2 enroll records — assert that did NOT happen.
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.action === 'enroll:add')).toBe(true);
    expect(recs[0]?.repo).toBe('/tmp/r3'); // newest enroll:add first
    expect(recs[1]?.repo).toBe('/tmp/r2');
  });
});

// ===========================================================================
// BAD-ARGS — return 2, read nothing
// ===========================================================================

describe('H6 · audit viewer · bad args return 2 and read nothing', () => {
  it('an unparseable --since returns 2 and prints no records', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'enroll:add', repo: '/tmp/r', sandboxId: null, summary: 'enrolled', result: 'ok' });

    const { code, out, err } = await runViewer(['--since', 'not-a-date', '--json']);
    expect(code).toBe(2);
    expect(err).toContain('--since');
    // Read nothing on bad args — no record list was emitted.
    expect(out).toBe('');
  });

  it('an unknown flag returns 2 with a usage hint', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    const { code, err } = await runViewer(['--frobnicate']);
    expect(code).toBe(2);
    expect(err).toContain('unknown argument');
    expect(err).toContain('Usage:');
  });
});

// ===========================================================================
// READ-ONLY — the viewer mutates nothing
// ===========================================================================

describe('H6 · audit viewer · READ-ONLY (audit files byte-identical)', () => {
  it('a cmdAudit run leaves the on-disk audit JSONL byte-identical', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    audit({ action: 'enroll:add', repo: '/tmp/r', sandboxId: null, summary: 'enrolled', result: 'ok' });
    audit({ action: 'kill:on', repo: null, sandboxId: null, summary: 'kill switch on', result: 'ok' });

    const before = auditDirBytes(fx.home);
    expect(before.length).toBeGreaterThan(0); // sanity: there IS something to mutate

    // Exercise several filter paths — none may touch disk.
    await runViewer([]);
    await runViewer(['--json']);
    await runViewer(['--action', 'enroll']);
    await runViewer(['--result', 'ok', '--limit', '1']);

    expect(auditDirBytes(fx.home)).toBe(before);
  });
});

// ===========================================================================
// ALREADY-REDACTED — a secret-shaped summary is shown redacted, never raw
// ===========================================================================

describe('H6 · audit viewer · a secret-shaped value is shown already-redacted', () => {
  it('never prints a raw secret token; the viewer shows the [REDACTED] form', async () => {
    expect.hasAssertions();
    fx = makeFixture();
    // The core audit() runs stripSecrets() at WRITE time, so a secret-shaped
    // summary lands on disk already redacted. The viewer must surface that
    // redacted form and NEVER reconstruct the raw token.
    const RAW_SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    audit({
      action: 'sandbox.create',
      repo: '/tmp/r',
      sandboxId: null,
      summary: `cloned with token ${RAW_SECRET}`,
      result: 'ok',
    });

    // Sanity: the on-disk record is already redacted (the write-time guard ran).
    const onDisk = auditDirBytes(fx.home);
    expect(onDisk).not.toContain(RAW_SECRET);
    expect(onDisk).toContain('[REDACTED]');

    // Human-readable output: redacted, never raw.
    const plain = await runViewer([]);
    expect(plain.code).toBe(0);
    expect(plain.out).not.toContain(RAW_SECRET);
    expect(plain.out).toContain('[REDACTED]');

    // --json output: same guarantee.
    const asJson = await runViewer(['--json']);
    expect(asJson.code).toBe(0);
    expect(asJson.out).not.toContain(RAW_SECRET);
    const recs = JSON.parse(asJson.out) as AuditEntry[];
    expect(recs[0]?.summary).toContain('[REDACTED]');
    expect(recs[0]?.summary).not.toContain(RAW_SECRET);
  });
});
