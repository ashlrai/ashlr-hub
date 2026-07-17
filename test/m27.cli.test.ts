/**
 * M27 health CLI tests — hermetic, tmp HOME, tmp enrolled repo. NEVER touches
 * the real ~/.ashlr or the real portfolio, NEVER makes a cloud call.
 *
 * Strategy: the deterministic SCORING layer (core/quality/health.ts) is mocked
 * so these CLI tests are fast + independent of the scanners' build state and of
 * any network/tooling. The ENROLLMENT gate (core/sandbox/policy.ts), the INBOX
 * proposal store (core/inbox/store.ts via fixes.emitFixProposals), and the
 * snapshot store (core/quality/store.ts) all run REAL under the tmp HOME so the
 * safety invariants are exercised against real persistence.
 *
 * Invariants under test (the M27 HARD safety invariants):
 *   1. ENROLLMENT-SCOPED: a non-enrolled --repo HARD-ERRORS (exit 1) at the CLI
 *      layer BEFORE any scan; an enrolled repo succeeds; the default report over
 *      zero enrolled repos prints nothing-to-score.
 *   2. PROPOSAL-ONLY: `propose` creates PENDING inbox proposals of kind 'note',
 *      origin 'manual' — never auto-applied.
 *   3. LOCAL-FIRST: the default report path makes ZERO network connections
 *      (fetch is stubbed to reject and must never be called), even with a key,
 *      and produces NO narrative on the default path.
 *   4. READ-ONLY: a default run persists ONLY under ~/.ashlr/quality/ and leaves
 *      an enrolled repo's working tree byte-identical.
 *
 * Also covers: default run prints a ranked report; --json shapes; usage errors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HealthReport, HealthScore } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock the deterministic SCORING layer (core/quality/health.ts) ONLY. The
// enrollment policy, the inbox store, and the quality snapshot store all run
// REAL under the tmp HOME. deriveSafeFixes is mocked to a deterministic fix;
// emitFixProposals stays REAL so it exercises the real createProposal path.
// ---------------------------------------------------------------------------

/** Build a deterministic HealthScore for an absolute repo path. */
function mkScore(repo: string, score: number): HealthScore {
  return {
    repo,
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
    dimensions: [
      { dimension: 'tests', score, weight: 20, findingCount: 1, summary: 'tests summary' },
      { dimension: 'docs', score, weight: 10, findingCount: 0, summary: 'docs summary' },
    ],
    conventions: [
      { key: 'license', label: 'LICENSE file', ok: false, weight: 3, detail: 'No LICENSE found.' },
      { key: 'readme', label: 'README', ok: true, weight: 2, detail: 'README present.' },
    ],
    worstOffenders: [
      {
        id: `${path.basename(repo)}:doc:abc`,
        repo,
        source: 'doc',
        title: 'Missing LICENSE file',
        detail: 'Declare a license.',
        value: 3,
        effort: 1,
        score: 3,
        tags: ['doc'],
        ts: new Date().toISOString(),
      },
    ],
    ts: new Date().toISOString(),
  };
}

// These are filled per-test before importing the CLI.
let scoreByRepo: Map<string, number>;

vi.mock('../src/core/quality/health.js', () => ({
  gradeFor: (s: number) =>
    s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F',
  computeHealth: vi.fn(async (repo: string): Promise<HealthScore> => {
    return mkScore(repo, scoreByRepo.get(repo) ?? 50);
  }),
  computeReport: vi.fn(async (): Promise<HealthReport> => {
    // Mirror the core's enrollment-scoped default: score every enrolled repo.
    const { listEnrolled } = await import('../src/core/sandbox/policy.js');
    const repos = listEnrolled();
    const scores = repos
      .map((r) => mkScore(r, scoreByRepo.get(r) ?? 50))
      .sort((a, b) => a.score - b.score); // worst-first
    const avg = scores.length
      ? Math.round(scores.reduce((acc, s) => acc + s.score, 0) / scores.length)
      : 0;
    return {
      generatedAt: new Date().toISOString(),
      repos,
      scores,
      averageScore: avg,
      averageGrade: avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F',
      delta: {},
    };
  }),
}));

vi.mock('../src/core/quality/fixes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/quality/fixes.js')>();
  return {
    // Keep the REAL emitFixProposals (exercises real createProposal -> inbox).
    emitFixProposals: actual.emitFixProposals,
    // Deterministic single advisory fix per score, so the propose path is
    // independent of the (sibling-built) deriveSafeFixes implementation.
    deriveSafeFixes: vi.fn((score: HealthScore) => [
      {
        repo: score.repo,
        dimension: 'docs' as const,
        key: 'docs.add-license',
        title: 'Add a LICENSE file',
        rationale: 'No LICENSE file was found at the repo root.',
        proposalKind: 'note' as const,
      },
    ]),
  };
});

// ---------------------------------------------------------------------------
// HOME isolation — every ~/.ashlr write is redirected to a tmp dir
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
let tmpHome: string;
let tmpRepo: string;

function ashlrDir(...p: string[]): string {
  return path.join(tmpHome, '.ashlr', ...p);
}

/** Write the enrollment registry directly (avoids importing enroll()). */
function enroll(repo: string): void {
  fs.mkdirSync(ashlrDir(), { recursive: true });
  const p = ashlrDir('enrollment.json');
  let repos: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { repos?: string[] };
    if (Array.isArray(parsed.repos)) repos = parsed.repos;
  } catch {
    /* fresh */
  }
  const physical = fs.realpathSync.native(repo);
  if (!repos.includes(physical)) repos.push(physical);
  fs.writeFileSync(p, JSON.stringify({ repos }, null, 2) + '\n', 'utf8');
}

/** Capture stdout during `fn`; silence stderr. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await fn();
    return { code, out };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

let cmdHealth: (args: string[]) => Promise<number>;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m27-cli-home-'));
  process.env['HOME'] = tmpHome;
  fs.mkdirSync(ashlrDir(), { recursive: true });

  // A tmp "repo" working tree we can enroll + assert is left untouched.
  tmpRepo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m27-repo-')));
  fs.writeFileSync(path.join(tmpRepo, 'package.json'), '{"name":"tmp","version":"1.0.0"}\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# tmp\n'.repeat(60), 'utf8');

  scoreByRepo = new Map();

  vi.resetModules();
  // Re-import the CLI after resetModules so its lazy core cache re-resolves
  // under the current tmp HOME (and picks up the mocks).
  const mod = await import('../src/cli/health.js');
  cmdHealth = mod.cmdHealth;

  // Default: block EVERY network connection. The default path must never fetch.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch blocked in m27 test')));
});

afterEach(() => {
  process.env['HOME'] = origHome;
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default ranked report
// ---------------------------------------------------------------------------

describe('health — default ranked report', () => {
  it('prints a ranked report over enrolled repos (exit 0)', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 64);

    const { code, out } = await capture(() => cmdHealth([]));

    expect(code).toBe(0);
    expect(out).toContain('Health');
    expect(out).toContain('64/100');
    expect(out).toContain('Portfolio average');
    expect(out).toContain(path.basename(tmpRepo));
  });

  it('with NOTHING enrolled, reports nothing to score (DEFAULT EMPTY)', async () => {
    const { code, out } = await capture(() => cmdHealth([]));
    expect(code).toBe(0);
    expect(out).toContain('No enrolled repos to score');
  });

  it('--json emits a HealthReport with the documented shape + no narrative', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 72);

    const { code, out } = await capture(() => cmdHealth(['--json']));
    expect(code).toBe(0);

    const report = JSON.parse(out.trim()) as HealthReport;
    expect(typeof report.generatedAt).toBe('string');
    expect(Array.isArray(report.scores)).toBe(true);
    expect(report.scores).toHaveLength(1);
    expect(report.scores[0]?.score).toBe(72);
    expect(report.scores[0]?.grade).toBe('C');
    expect(typeof report.averageScore).toBe('number');
    expect(report.delta).toBeDefined();
    // LOCAL-FIRST: the default path produces no narrative.
    expect(report.narrative).toBeUndefined();
  });

  it('persists a snapshot under ~/.ashlr/quality/reports on each full run', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 80);

    await capture(() => cmdHealth([]));

    const dir = ashlrDir('quality', 'reports');
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('computes a per-repo delta vs the previous snapshot on the second run', async () => {
    enroll(tmpRepo);
    const abs = tmpRepo;

    // First run: score 60.
    scoreByRepo.set(abs, 60);
    await capture(() => cmdHealth(['--json']));

    // Distinct generatedAt for the second snapshot.
    await new Promise((res) => setTimeout(res, 5));

    // Second run: score 75 => delta +15 vs prior.
    scoreByRepo.set(abs, 75);
    const { out } = await capture(() => cmdHealth(['--json']));
    const r2 = JSON.parse(out.trim()) as HealthReport;
    expect(r2.delta[abs]).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Single-repo detail
// ---------------------------------------------------------------------------

describe('health <repo> — single-repo detail', () => {
  it('prints the per-dimension breakdown for an ENROLLED repo (exit 0)', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 55);

    const { code, out } = await capture(() => cmdHealth([tmpRepo]));
    expect(code).toBe(0);
    expect(out).toContain('Dimensions');
    expect(out).toContain('tests');
    expect(out).toContain('55/100');
    expect(out).toContain('Convention gaps');
    expect(out).toContain('LICENSE');
  });

  it('--json emits a HealthScore for an enrolled repo', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 88);

    const { code, out } = await capture(() => cmdHealth([tmpRepo, '--json']));
    expect(code).toBe(0);
    const score = JSON.parse(out.trim()) as HealthScore;
    expect(score.repo).toBe(tmpRepo);
    expect(score.score).toBe(88);
    expect(score.grade).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 2: ENROLLMENT-SCOPED — a non-enrolled --repo HARD-ERRORS
// ---------------------------------------------------------------------------

describe('health — ENROLLMENT-SCOPED (non-enrolled repo hard-errors)', () => {
  it('a non-enrolled positional repo returns exit 1 and never scans', async () => {
    // tmpRepo is NOT enrolled here.
    const health = await import('../src/core/quality/health.js');
    const computeHealthSpy = health.computeHealth as ReturnType<typeof vi.fn>;
    computeHealthSpy.mockClear();

    const { code } = await capture(() => cmdHealth([tmpRepo]));
    expect(code).toBe(1);
    // HARD-ERROR happens BEFORE any scan — computeHealth is never called.
    expect(computeHealthSpy).not.toHaveBeenCalled();
  });

  it('the same repo, once enrolled, succeeds (exit 0)', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 70);
    const { code } = await capture(() => cmdHealth([tmpRepo]));
    expect(code).toBe(0);
  });

  it('a non-enrolled repo on `propose` also returns exit 1', async () => {
    const { code } = await capture(() => cmdHealth(['propose', tmpRepo]));
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 3: PROPOSAL-ONLY — propose creates PENDING note proposals
// ---------------------------------------------------------------------------

describe('health propose — proposals are PENDING notes', () => {
  it('creates PENDING inbox proposals of kind note, origin manual', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 40);

    const { code, out } = await capture(() => cmdHealth(['propose']));
    expect(code).toBe(0);
    expect(out).toContain('ashlr inbox');

    const inboxDir = ashlrDir('inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const f of files) {
      const p = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8'));
      expect(p.status).toBe('pending'); // NEVER auto-applied
      expect(p.kind).toBe('note'); // advisory, mutates nothing
      expect(p.origin).toBe('manual');
      expect(p.repo).toBe(tmpRepo);
    }
  });

  it('propose --json reports the created proposals (all pending notes)', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 40);

    const { code, out } = await capture(() => cmdHealth(['propose', '--json']));
    expect(code).toBe(0);
    const res = JSON.parse(out.trim()) as { fixes: unknown[]; proposals: { status: string; kind: string }[] };
    expect(res.proposals.length).toBeGreaterThanOrEqual(1);
    for (const p of res.proposals) {
      expect(p.status).toBe('pending');
      expect(p.kind).toBe('note');
    }
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 4: LOCAL-FIRST — default path makes ZERO network connections
// ---------------------------------------------------------------------------

describe('health — LOCAL-FIRST (no cloud on default path)', () => {
  it('default run never calls fetch, even with an API key present', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-FAKEKEY0000000000000000000000000000000000';
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 70);

    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network on default path'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await capture(() => cmdHealth([]));
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--allow-cloud OFF (default): propose makes no cloud call', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-FAKEOPENAIKEY0000000000000000000000000000000';
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 40);

    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await capture(() => cmdHealth(['propose']));
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 1: READ-ONLY — enrolled repo working tree untouched
// ---------------------------------------------------------------------------

describe('health — READ-ONLY over the enrolled repo', () => {
  it('a default run leaves the enrolled repo working tree byte-identical', async () => {
    enroll(tmpRepo);
    scoreByRepo.set(tmpRepo, 70);

    const pkgPath = path.join(tmpRepo, 'package.json');
    const readmePath = path.join(tmpRepo, 'README.md');
    const pkgBefore = fs.readFileSync(pkgPath, 'utf8');
    const readmeBefore = fs.readFileSync(readmePath, 'utf8');
    const entriesBefore = fs.readdirSync(tmpRepo).sort();

    await capture(() => cmdHealth([]));

    expect(fs.readFileSync(pkgPath, 'utf8')).toBe(pkgBefore);
    expect(fs.readFileSync(readmePath, 'utf8')).toBe(readmeBefore);
    expect(fs.readdirSync(tmpRepo).sort()).toEqual(entriesBefore);
  });
});

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

describe('health — usage', () => {
  it('returns 2 on an unknown flag', async () => {
    const { code } = await capture(() => cmdHealth(['--frobnicate']));
    expect(code).toBe(2);
  });

  it('returns 2 on an unexpected extra positional argument', async () => {
    const { code } = await capture(() => cmdHealth(['a', 'b']));
    expect(code).toBe(2);
  });

  it('--help prints usage and returns 0', async () => {
    const { code, out } = await capture(() => cmdHealth(['--help']));
    expect(code).toBe(0);
    expect(out).toContain('ashlr health');
  });

  it('rejects the removed --allow-cloud flag (M27 ships no LLM narrative path)', async () => {
    // The dead --allow-cloud flag was removed (it warned about egress it never
    // performed). It must now be an UNKNOWN flag (exit 2), and help must not
    // advertise it.
    const { code } = await capture(() => cmdHealth(['--allow-cloud']));
    expect(code).toBe(2);

    const { out } = await capture(() => cmdHealth(['--help']));
    expect(out).not.toContain('--allow-cloud');
  });
});
