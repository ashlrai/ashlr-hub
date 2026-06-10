/**
 * M27 quality store tests — saveReport, listReports, loadPreviousReport,
 * reportsDir, HealthReport snapshot persistence + trend ordering.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/quality/ is never
 *    touched (mirrors test/m26.store.test.ts).
 *  - The store is PURE FS under ~/.ashlr/quality ONLY — it NEVER writes
 *    CONFIG_PATH / saveConfig() / router policy, and NEVER touches a user repo.
 *  - Each test is hermetic: fresh tmp HOME per test.
 *  - Timestamps are INJECTED (fixed ISO strings) so ordering is deterministic
 *    and no nondeterminism leaks into the assertions.
 *
 * Invariants asserted:
 *  - reportsDir() resolves under HOME/.ashlr/quality/reports
 *  - saveReport round-trips: the persisted file parses back to an equal report
 *  - saveReport returns a path under reportsDir(); the file is valid JSON
 *  - listReports returns most-recent first by generatedAt
 *  - loadPreviousReport returns the newest snapshot, and honors the `before`
 *    cutoff (strictly-before) so a just-saved report isn't compared to itself
 *  - empty state: listReports() === [], loadPreviousReport() === null
 *  - malformed / tmp / wrong-shape files are ignored
 *  - the ONLY filesystem writes land under ~/.ashlr/quality (nothing else)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m27-store-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Imports (path helpers re-resolve homedir() at call time, so the relocated
// HOME above is always honored).
// ---------------------------------------------------------------------------

import {
  reportsDir,
  saveReport,
  listReports,
  loadPreviousReport,
} from '../src/core/quality/store.js';
import type { HealthReport } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixture — a minimal but structurally-valid HealthReport with an INJECTED
// timestamp (no Date.now() — keeps ordering deterministic).
// ---------------------------------------------------------------------------

function makeReport(
  generatedAt: string,
  overrides?: Partial<HealthReport>,
): HealthReport {
  return {
    generatedAt,
    repos: ['/abs/repo-a'],
    scores: [
      {
        repo: '/abs/repo-a',
        score: 82,
        grade: 'B',
        dimensions: [],
        conventions: [],
        worstOffenders: [],
        ts: generatedAt,
      },
    ],
    averageScore: 82,
    averageGrade: 'B',
    delta: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('m27 quality store — reportsDir', () => {
  it('resolves under HOME/.ashlr/quality/reports', () => {
    expect(reportsDir()).toBe(
      path.join(tmpHome, '.ashlr', 'quality', 'reports'),
    );
  });

  it('does not create the directory just by resolving the path', () => {
    reportsDir();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'quality'))).toBe(false);
  });
});

describe('m27 quality store — saveReport round-trip', () => {
  it('persists a report and reads it back equal', () => {
    const report = makeReport('2026-06-08T12:00:00.000Z');
    const dest = saveReport(report);

    expect(dest).not.toBeNull();
    expect(dest as string).toContain(
      path.join('.ashlr', 'quality', 'reports'),
    );
    expect(fs.existsSync(dest as string)).toBe(true);

    // File is valid JSON and parses back to an equal report.
    const raw = fs.readFileSync(dest as string, 'utf8');
    const parsed = JSON.parse(raw) as HealthReport;
    expect(parsed).toEqual(report);

    // And it surfaces through listReports().
    const all = listReports();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(report);
  });

  it('writes pretty-printed JSON with a trailing newline', () => {
    const dest = saveReport(makeReport('2026-06-08T12:00:00.000Z'));
    const raw = fs.readFileSync(dest as string, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  '); // indented (pretty-printed)
  });

  it('names the file by epoch-ms stem so it sorts chronologically', () => {
    const generatedAt = '2026-06-08T12:00:00.000Z';
    const dest = saveReport(makeReport(generatedAt));
    expect(path.basename(dest as string)).toBe(
      `${Date.parse(generatedAt)}.json`,
    );
  });

  it('leaves no .tmp artifact behind after an atomic write', () => {
    saveReport(makeReport('2026-06-08T12:00:00.000Z'));
    const files = fs.readdirSync(reportsDir());
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toHaveLength(1);
  });

  it('does NOT overwrite a same-ms snapshot — a collision gets a -N suffix', () => {
    // Two reports sharing an identical ms-resolution generatedAt (distinct
    // content) must BOTH survive on disk — no history loss.
    const ts = '2026-06-08T12:00:00.000Z';
    const first = makeReport(ts, { averageScore: 40 });
    const second = makeReport(ts, { averageScore: 90 });

    const dest1 = saveReport(first);
    const dest2 = saveReport(second);

    expect(dest1).not.toBeNull();
    expect(dest2).not.toBeNull();
    // The first keeps the plain epoch-ms stem; the second gets a -N fallback.
    expect(path.basename(dest1 as string)).toBe(`${Date.parse(ts)}.json`);
    expect(dest2).not.toBe(dest1);

    // Both snapshots persist (the first is NOT overwritten).
    const files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
    const scores = listReports().map((r) => r.averageScore).sort((a, b) => a - b);
    expect(scores).toEqual([40, 90]);
  });
});

describe('m27 quality store — listReports ordering', () => {
  it('returns most-recent first by generatedAt', () => {
    const older = makeReport('2026-06-01T00:00:00.000Z', { averageScore: 50 });
    const middle = makeReport('2026-06-05T00:00:00.000Z', { averageScore: 60 });
    const newer = makeReport('2026-06-09T00:00:00.000Z', { averageScore: 90 });

    // Save out of order to prove the sort is by content, not write order.
    saveReport(middle);
    saveReport(newer);
    saveReport(older);

    const all = listReports();
    expect(all.map((r) => r.generatedAt)).toEqual([
      newer.generatedAt,
      middle.generatedAt,
      older.generatedAt,
    ]);
  });

  it('ignores malformed, *.tmp, and wrong-shape files', () => {
    saveReport(makeReport('2026-06-08T12:00:00.000Z'));
    const dir = reportsDir();
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{not valid json', 'utf8');
    fs.writeFileSync(path.join(dir, 'half.json.tmp'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'wrongshape.json'),
      JSON.stringify({ hello: 'world' }),
      'utf8',
    );

    const all = listReports();
    expect(all).toHaveLength(1);
    expect(all[0]?.generatedAt).toBe('2026-06-08T12:00:00.000Z');
  });
});

describe('m27 quality store — loadPreviousReport', () => {
  it('returns the newest snapshot when no cutoff is given', () => {
    saveReport(makeReport('2026-06-01T00:00:00.000Z'));
    saveReport(makeReport('2026-06-08T00:00:00.000Z'));

    const prev = loadPreviousReport();
    expect(prev?.generatedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('honors the `before` cutoff (strictly-before) for score-trend deltas', () => {
    const prior = makeReport('2026-06-01T00:00:00.000Z', { averageScore: 50 });
    const current = makeReport('2026-06-08T00:00:00.000Z', { averageScore: 90 });
    saveReport(prior);
    saveReport(current);

    // Comparing the current report should pick the PRIOR one, never itself.
    const prev = loadPreviousReport(current.generatedAt);
    expect(prev?.generatedAt).toBe(prior.generatedAt);
    expect(prev?.averageScore).toBe(50);
  });

  it('returns null when the cutoff excludes every snapshot', () => {
    saveReport(makeReport('2026-06-08T00:00:00.000Z'));
    expect(loadPreviousReport('2026-06-08T00:00:00.000Z')).toBeNull();
    expect(loadPreviousReport('2026-05-01T00:00:00.000Z')).toBeNull();
  });
});

describe('m27 quality store — empty state', () => {
  it('listReports() returns [] with no reports dir', () => {
    expect(listReports()).toEqual([]);
  });

  it('loadPreviousReport() returns null with no reports', () => {
    expect(loadPreviousReport()).toBeNull();
    expect(loadPreviousReport('2026-06-08T00:00:00.000Z')).toBeNull();
  });
});

describe('m27 quality store — write containment (safety invariant 1)', () => {
  it('only ever writes under ~/.ashlr/quality, nothing else in HOME', () => {
    saveReport(makeReport('2026-06-08T12:00:00.000Z'));

    // The only thing created under HOME is the .ashlr tree, and under .ashlr
    // the only thing is the quality/ subtree (the store touches nothing else).
    expect(fs.readdirSync(tmpHome)).toEqual(['.ashlr']);
    expect(fs.readdirSync(path.join(tmpHome, '.ashlr'))).toEqual(['quality']);
    expect(
      fs.readdirSync(path.join(tmpHome, '.ashlr', 'quality')),
    ).toEqual(['reports']);
  });
});
