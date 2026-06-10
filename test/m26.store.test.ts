/**
 * M26 learn store tests — saveReport, listReports, loadPreviousReport,
 * reportsDir, snapshot persistence + week-over-week ordering.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/learn/ is never
 *    touched (mirrors test/m23.store.test.ts).
 *  - The store is PURE FS under ~/.ashlr/learn ONLY — it NEVER writes
 *    CONFIG_PATH / saveConfig() / router policy, and NEVER touches a user repo.
 *  - Each test is hermetic: fresh tmp HOME per test.
 *  - Timestamps are INJECTED (fixed ISO strings) so ordering is deterministic
 *    and no nondeterminism leaks into the assertions.
 *
 * Invariants asserted:
 *  - reportsDir() resolves under HOME/.ashlr/learn/reports
 *  - saveReport round-trips: the persisted file parses back to an equal report
 *  - saveReport returns a path under reportsDir(); the file is valid JSON
 *  - listReports returns most-recent first by generatedAt
 *  - loadPreviousReport returns the newest snapshot, and honors the `before`
 *    cutoff (strictly-before) so a just-saved report isn't compared to itself
 *  - empty state: listReports() === [], loadPreviousReport() === null
 *  - malformed / tmp files are ignored
 *  - the ONLY filesystem writes land under ~/.ashlr/learn (nothing else created)
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m26-store-home-'));
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
} from '../src/core/learn/store.js';
import type { ReflectionReport } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixture — a minimal but structurally-valid ReflectionReport with an INJECTED
// timestamp (no Date.now() — keeps ordering deterministic).
// ---------------------------------------------------------------------------

function makeReport(
  generatedAt: string,
  overrides?: Partial<ReflectionReport>,
): ReflectionReport {
  return {
    generatedAt,
    since: '2026-06-01T00:00:00.000Z',
    window: '7d',
    swarmsAnalyzed: 4,
    swarmsDone: 3,
    swarmsFailed: 1,
    successRate: 0.75,
    avgCostUsd: 0.12,
    avgTokens: 1800,
    totalCostUsd: 0.48,
    localShare: 0.9,
    topFailures: [],
    goalCategories: [],
    delta: {
      previousAt: null,
      effectivenessPct: null,
      costPct: null,
      localSharePct: null,
      headline: 'no prior snapshot',
    },
    genome: {
      totalEntries: 0,
      projects: 0,
      hubEntries: 0,
      sizeBytes: 0,
      lastLearnedAt: null,
      embeddingsAvailable: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('m26 learn store — reportsDir', () => {
  it('resolves under HOME/.ashlr/learn/reports', () => {
    expect(reportsDir()).toBe(
      path.join(tmpHome, '.ashlr', 'learn', 'reports'),
    );
  });

  it('does not create the directory just by resolving the path', () => {
    reportsDir();
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'learn'))).toBe(false);
  });
});

describe('m26 learn store — saveReport round-trip', () => {
  it('persists a report and reads it back equal', () => {
    const report = makeReport('2026-06-08T12:00:00.000Z');
    const dest = saveReport(report);

    expect(dest).not.toBeNull();
    expect(dest as string).toContain(path.join('.ashlr', 'learn', 'reports'));
    expect(fs.existsSync(dest as string)).toBe(true);

    // File is valid JSON and parses back to an equal report.
    const raw = fs.readFileSync(dest as string, 'utf8');
    const parsed = JSON.parse(raw) as ReflectionReport;
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
});

describe('m26 learn store — listReports ordering', () => {
  it('returns most-recent first by generatedAt', () => {
    const older = makeReport('2026-06-01T00:00:00.000Z', { successRate: 0.5 });
    const middle = makeReport('2026-06-05T00:00:00.000Z', { successRate: 0.6 });
    const newer = makeReport('2026-06-09T00:00:00.000Z', { successRate: 0.9 });

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

  it('ignores malformed and *.tmp files', () => {
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

describe('m26 learn store — loadPreviousReport', () => {
  it('returns the newest snapshot when no cutoff is given', () => {
    saveReport(makeReport('2026-06-01T00:00:00.000Z'));
    saveReport(makeReport('2026-06-08T00:00:00.000Z'));

    const prev = loadPreviousReport();
    expect(prev?.generatedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('honors the `before` cutoff (strictly-before) for week-over-week deltas', () => {
    const prior = makeReport('2026-06-01T00:00:00.000Z', { successRate: 0.5 });
    const current = makeReport('2026-06-08T00:00:00.000Z', { successRate: 0.9 });
    saveReport(prior);
    saveReport(current);

    // Comparing the current report should pick the PRIOR one, never itself.
    const prev = loadPreviousReport(current.generatedAt);
    expect(prev?.generatedAt).toBe(prior.generatedAt);
    expect(prev?.successRate).toBe(0.5);
  });

  it('returns null when the cutoff excludes every snapshot', () => {
    saveReport(makeReport('2026-06-08T00:00:00.000Z'));
    expect(loadPreviousReport('2026-06-08T00:00:00.000Z')).toBeNull();
    expect(loadPreviousReport('2026-05-01T00:00:00.000Z')).toBeNull();
  });
});

describe('m26 learn store — empty state', () => {
  it('listReports() returns [] with no reports dir', () => {
    expect(listReports()).toEqual([]);
  });

  it('loadPreviousReport() returns null with no reports', () => {
    expect(loadPreviousReport()).toBeNull();
    expect(loadPreviousReport('2026-06-08T00:00:00.000Z')).toBeNull();
  });
});

describe('m26 learn store — write containment (safety invariant 1)', () => {
  it('only ever writes under ~/.ashlr/learn, nothing else in HOME', () => {
    saveReport(makeReport('2026-06-08T12:00:00.000Z'));

    // The only thing created under HOME is the .ashlr tree, and under .ashlr
    // the only thing is the learn/ subtree (the store touches nothing else).
    expect(fs.readdirSync(tmpHome)).toEqual(['.ashlr']);
    expect(fs.readdirSync(path.join(tmpHome, '.ashlr'))).toEqual(['learn']);
    expect(
      fs.readdirSync(path.join(tmpHome, '.ashlr', 'learn')),
    ).toEqual(['reports']);
  });
});
