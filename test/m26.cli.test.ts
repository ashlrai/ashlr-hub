/**
 * M26 reflect CLI tests — hermetic, tmp HOME, seeded swarms. NEVER touches the
 * real ~/.ashlr or real portfolio, NEVER makes a cloud call.
 *
 * Invariants under test (the five HARD M26 safety invariants):
 *   1. READ-ONLY history: a default `ashlr reflect` writes ONLY under
 *      ~/.ashlr/learn/ — the seeded swarm files are byte-identical afterward.
 *   2. PROPOSAL-ONLY tuning: `reflect propose` creates PENDING inbox proposals
 *      of kind 'note', and config.json is byte-identical before/after.
 *   3. LOCAL-FIRST: the default report path makes ZERO network connections
 *      (fetch is stubbed to reject everything and must never be called).
 *   4. BOUNDED: only the most-recent maxRuns swarms are analyzed.
 *   5. NO OUTWARD ACTION: every created proposal stays 'pending'.
 *
 * Also covers: default run prints a report from seeded swarms; week-over-week
 * deltas across two snapshots; --json shape; --allow-cloud off => no cloud call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — every ~/.ashlr write is redirected to a tmp dir
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
const origAshlrHome = process.env['ASHLR_HOME'];
let tmpHome: string;

function ashlrDir(...p: string[]): string {
  return path.join(tmpHome, '.ashlr', ...p);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Seed one swarm JSON file into ~/.ashlr/swarms/. */
function seedSwarm(s: {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
  estCostUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  failedError?: string;
  failedPhase?: string;
}): void {
  const dir = ashlrDir('swarms');
  fs.mkdirSync(dir, { recursive: true });
  const tasks =
    s.failedError !== undefined
      ? [{ id: `${s.id}-t1`, phase: s.failedPhase ?? 'build', status: 'failed', error: s.failedError }]
      : [{ id: `${s.id}-t1`, phase: 'build', status: 'done', result: 'ok' }];
  const swarm = {
    id: s.id,
    goal: s.goal,
    specId: null,
    project: null,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
    budget: { maxSteps: 50, maxTokens: 100000, maxUsd: 5, maxWallClockMs: 600000 },
    usage: {
      tokensIn: s.tokensIn ?? 1000,
      tokensOut: s.tokensOut ?? 500,
      steps: 3,
      estCostUsd: s.estCostUsd ?? 0,
    },
    parallel: 1,
    status: s.status,
    plan: { specId: null, goal: s.goal, tasks: [{ id: `${s.id}-t1`, phase: 'build' }] },
    tasks,
  };
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(swarm, null, 2), 'utf8');
}

/** Capture everything written to stdout during `fn`. */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  // Silence stderr noise (warnings) without asserting on it here.
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await fn();
    return { code, out };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

let cmdReflect: (args: string[]) => Promise<number>;

async function importCmd(): Promise<void> {
  // Fresh import each suite run so the lazy module cache inside reflect.ts
  // re-resolves under the current tmp HOME.
  const mod = await import('../src/cli/reflect.js');
  cmdReflect = mod.cmdReflect;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m26-cli-home-'));
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = ashlrDir();
  fs.mkdirSync(ashlrDir(), { recursive: true });
  await importCmd();
  // Default: block EVERY network connection. The default report path must never
  // invoke fetch at all.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch blocked in m26 test')));
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (origAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = origAshlrHome;
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default report
// ---------------------------------------------------------------------------

describe('reflect — default report', () => {
  it('prints a report from seeded swarms (exit 0)', async () => {
    seedSwarm({ id: 's1', goal: 'add user login feature', status: 'done', createdAt: daysAgoIso(2), estCostUsd: 0 });
    seedSwarm({ id: 's2', goal: 'fix crash on startup', status: 'failed', createdAt: daysAgoIso(1), failedError: 'TypeError: cannot read x' });

    const { code, out } = await captureStdout(() => cmdReflect([]));

    expect(code).toBe(0);
    expect(out).toContain('Reflection');
    expect(out).toContain('Success rate');
    // 1 done / 2 analyzed => 50%
    expect(out).toContain('50%');
    expect(out).toContain('Top failure modes');
  });

  it('--json emits a ReflectionReport with the documented shape', async () => {
    seedSwarm({ id: 's1', goal: 'implement export feature', status: 'done', createdAt: daysAgoIso(1) });

    const { code, out } = await captureStdout(() => cmdReflect(['--json']));
    expect(code).toBe(0);

    const report = JSON.parse(out.trim());
    expect(typeof report.generatedAt).toBe('string');
    expect(typeof report.successRate).toBe('number');
    expect(report.swarmsAnalyzed).toBe(1);
    expect(report.swarmsDone).toBe(1);
    expect(Array.isArray(report.topFailures)).toBe(true);
    expect(Array.isArray(report.goalCategories)).toBe(true);
    expect(report.delta).toBeDefined();
  });

  it('persists a snapshot under ~/.ashlr/learn/reports on each full run', async () => {
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });

    await captureStdout(() => cmdReflect([]));

    const reportsDir = ashlrDir('learn', 'reports');
    expect(fs.existsSync(reportsDir)).toBe(true);
    const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 3: LOCAL-FIRST — default path makes ZERO network connections
// ---------------------------------------------------------------------------

describe('reflect — LOCAL-FIRST (no cloud on default path)', () => {
  it('default run never calls fetch (even with an API key present)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-FAKEKEY000000000000000000000000000000000000000';
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });

    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network on default path'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await captureStdout(() => cmdReflect([]));

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('--allow-cloud OFF (default): propose makes no cloud call', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-FAKEOPENAIKEY00000000000000000000000000000000';
    seedSwarm({ id: 's1', goal: 'fix bug', status: 'failed', createdAt: '2026-06-01T00:00:00.000Z', failedError: 'boom' });
    seedSwarm({ id: 's2', goal: 'fix other bug', status: 'failed', createdAt: '2026-06-02T00:00:00.000Z', failedError: 'boom' });

    const fetchSpy = vi.fn().mockRejectedValue(new Error('no network'));
    vi.stubGlobal('fetch', fetchSpy);

    const { code } = await captureStdout(() => cmdReflect(['propose']));

    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 1: READ-ONLY history — seeded swarm files untouched
// ---------------------------------------------------------------------------

describe('reflect — READ-ONLY over history', () => {
  it('default run leaves seeded swarm files byte-identical', async () => {
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });
    const swarmPath = ashlrDir('swarms', 's1.json');
    const before = fs.readFileSync(swarmPath, 'utf8');

    await captureStdout(() => cmdReflect([]));

    const after = fs.readFileSync(swarmPath, 'utf8');
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 2 + 5: PROPOSAL-ONLY tuning + NO OUTWARD ACTION
// ---------------------------------------------------------------------------

describe('reflect propose — proposals are pending notes, config untouched', () => {
  it('creates PENDING inbox proposals of kind note', async () => {
    // Seed conditions that trigger tuning suggestions: a recurring failure +
    // a fully-local category.
    // M84 (CI-green): RELATIVE dates — absolute June timestamps fell out of
    // reflect's 30-day usage-lookback window once real time crossed July,
    // silently producing 0 tuning proposals (a fixture time bomb).
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: daysAgoIso(5) });
    seedSwarm({ id: 's2', goal: 'add another feature', status: 'done', createdAt: daysAgoIso(4) });
    seedSwarm({ id: 's3', goal: 'add a third feature', status: 'done', createdAt: daysAgoIso(3) });
    seedSwarm({ id: 's4', goal: 'fix login bug', status: 'failed', createdAt: daysAgoIso(2), failedError: 'auth failure' });
    seedSwarm({ id: 's5', goal: 'fix login bug again', status: 'failed', createdAt: daysAgoIso(1), failedError: 'auth failure' });

    const { code, out } = await captureStdout(() => cmdReflect(['propose']));
    expect(code).toBe(0);
    expect(out).toContain('ashlr inbox');

    // Verify proposals landed in the inbox as pending notes.
    const inboxDir = ashlrDir('inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const f of files) {
      const p = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8'));
      expect(p.status).toBe('pending'); // NO OUTWARD ACTION
      expect(p.kind).toBe('note'); // applying mutates nothing
      expect(p.repo).toBeNull();
    }
  });

  it('does NOT mutate ~/.ashlr/config.json (byte-identical before/after)', async () => {
    // Materialize a config.json by loading config once under tmp HOME.
    const { loadConfig } = await import('../src/core/config.js');
    loadConfig();
    const configPath = ashlrDir('config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const before = fs.readFileSync(configPath, 'utf8');

    seedSwarm({ id: 's1', goal: 'fix bug', status: 'failed', createdAt: daysAgoIso(2), failedError: 'boom' });
    seedSwarm({ id: 's2', goal: 'fix bug 2', status: 'failed', createdAt: daysAgoIso(1), failedError: 'boom' });

    await captureStdout(() => cmdReflect(['propose']));

    const after = fs.readFileSync(configPath, 'utf8');
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT 4: BOUNDED — only the most-recent maxRuns analyzed
// ---------------------------------------------------------------------------

describe('reflect — BOUNDED reads', () => {
  it('analyzes at most DEFAULT_MAX_RUNS (100) recent swarms', async () => {
    // Seed 120 swarms; listSwarms caps at 200 but buildReflection slices to 100.
    for (let i = 0; i < 120; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      seedSwarm({
        id: `s${String(i).padStart(3, '0')}`,
        goal: 'add feature',
        status: 'done',
        createdAt: `2026-05-${day}T00:00:00.000Z`,
      });
    }

    const { out } = await captureStdout(() => cmdReflect(['--json']));
    const report = JSON.parse(out.trim());
    expect(report.swarmsAnalyzed).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Week-over-week deltas across two snapshots
// ---------------------------------------------------------------------------

describe('reflect — week-over-week deltas', () => {
  it('first run has no prior; second run computes a delta vs the first', async () => {
    // First run: 50% success.
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: daysAgoIso(2) });
    seedSwarm({ id: 's2', goal: 'fix bug', status: 'failed', createdAt: daysAgoIso(1), failedError: 'boom' });

    const first = await captureStdout(() => cmdReflect(['--json']));
    const r1 = JSON.parse(first.out.trim());
    expect(r1.delta.previousAt).toBeNull();
    expect(r1.delta.effectivenessPct).toBeNull();

    // Ensure a distinct generatedAt timestamp for the second snapshot.
    await new Promise((res) => setTimeout(res, 5));

    // Second run: now 100% success (mark s2 done).
    seedSwarm({ id: 's2', goal: 'fix bug', status: 'done', createdAt: daysAgoIso(1) });

    const second = await captureStdout(() => cmdReflect(['--json']));
    const r2 = JSON.parse(second.out.trim());
    expect(r2.delta.previousAt).toBe(r1.generatedAt);
    // 100% vs 50% => +50 percentage points more effective.
    expect(r2.delta.effectivenessPct).toBe(50);
    expect(r2.delta.headline).toContain('more effective');
  });
});

describe('reflect playbooks — report-only default + --persist gate', () => {
  function hubPath(): string {
    return ashlrDir('genome', 'hub.jsonl');
  }

  it('DEFAULT (no --persist): distills but does NOT write the genome hub', async () => {
    seedSwarm({ id: 'p1', goal: 'implement dashboard feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });
    seedSwarm({ id: 'p2', goal: 'implement billing feature', status: 'done', createdAt: '2026-06-02T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['playbooks']));
    expect(code).toBe(0);
    expect(out).toContain('report-only');
    expect(fs.existsSync(hubPath())).toBe(false);
  });

  it('--persist: writes the distilled playbook to the genome hub', async () => {
    seedSwarm({ id: 'p1', goal: 'implement dashboard feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });
    seedSwarm({ id: 'p2', goal: 'implement billing feature', status: 'done', createdAt: '2026-06-02T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['playbooks', '--persist']));
    expect(code).toBe(0);
    expect(out).toContain('auto-injects into future agents');
    expect(fs.existsSync(hubPath())).toBe(true);
    const lines = fs.readFileSync(hubPath(), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('--persist --json reports didPersist=true', async () => {
    seedSwarm({ id: 'p1', goal: 'implement dashboard feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });
    seedSwarm({ id: 'p2', goal: 'implement billing feature', status: 'done', createdAt: '2026-06-02T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['playbooks', '--persist', '--json']));
    expect(code).toBe(0);
    const res = JSON.parse(out.trim());
    expect(res.didPersist).toBe(true);
    expect(res.persisted.length).toBeGreaterThanOrEqual(1);
  });

  it('default --json reports didPersist=false and an empty persisted list', async () => {
    seedSwarm({ id: 'p1', goal: 'implement dashboard feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });
    seedSwarm({ id: 'p2', goal: 'implement billing feature', status: 'done', createdAt: '2026-06-02T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['playbooks', '--json']));
    expect(code).toBe(0);
    const res = JSON.parse(out.trim());
    expect(res.didPersist).toBe(false);
    expect(res.persisted).toEqual([]);
    expect(fs.existsSync(hubPath())).toBe(false);
  });
});

describe('reflect — --since all sentinel rendering', () => {
  it("human report renders 'all history' rather than a 1970 epoch", async () => {
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['--since', 'all']));
    expect(code).toBe(0);
    expect(out).toContain('all history');
    expect(out).not.toContain('1970');
  });

  it("--since all --json records since='all'", async () => {
    seedSwarm({ id: 's1', goal: 'add feature', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' });

    const { code, out } = await captureStdout(() => cmdReflect(['--since', 'all', '--json']));
    expect(code).toBe(0);
    const report = JSON.parse(out.trim());
    expect(report.since).toBe('all');
    expect(report.window).toBe('all');
  });
});

describe('reflect — usage errors', () => {
  it('returns 2 on an invalid --since window', async () => {
    const { code } = await captureStdout(() => cmdReflect(['--since', 'banana']));
    expect(code).toBe(2);
  });

  it('returns 2 on an unknown subcommand', async () => {
    const { code } = await captureStdout(() => cmdReflect(['frobnicate']));
    expect(code).toBe(2);
  });

  it('--help prints usage and returns 0', async () => {
    const { code, out } = await captureStdout(() => cmdReflect(['--help']));
    expect(code).toBe(0);
    expect(out).toContain('ashlr reflect');
  });
});
