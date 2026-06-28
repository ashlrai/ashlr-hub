/**
 * test/m166.model-racing.test.ts — M166: Model Racing + Distillation Dataset.
 *
 * Test groups:
 *
 *   1. EXPORT — raceTask + racingStats exported from src/core/fleet/model-racing.ts
 *
 *   2. RACE FLOW — raceTask runs local + frontier, scores both, picks winner + delta
 *
 *   3. DISTILLATION PERSIST — race record written to ~/.ashlr/racing/<date>.jsonl
 *      with secret-scrubbed diffs
 *
 *   4. RACING STATS — racingStats aggregates frontierWinRate + avgScoreDelta +
 *      localWins from persisted records
 *
 *   5. FLAG OFF — raceTask is a no-op (returns zeroed result) when
 *      cfg.foundry.modelRacing is absent or enabled:false
 *
 *   6. NEVER THROWS — raceTask + racingStats never throw, even when a side fails
 *      or fs is unavailable
 *
 * Mock conventions: vi.doMock + vi.resetModules() + cache-busting UUID query
 * strings on dynamic imports — mirrors m142.best-of-n.test.ts.
 *
 * No live model calls: all sandbox + judge paths are mocked.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_REPO = '/tmp/fake-repo-m166';

function makeItem(overrides: Partial<{
  id: string; repo: string; title: string; detail: string;
}> = {}) {
  return {
    id: overrides.id ?? 'm166-item-1',
    repo: overrides.repo ?? MOCK_REPO,
    source: 'issue' as const,
    title: overrides.title ?? 'Improve error handling',
    detail: overrides.detail ?? 'Add try/catch around parse calls',
    value: 3,
    effort: 2,
    score: 4,
    tags: [],
    ts: new Date().toISOString(),
  };
}

/** Build a config with modelRacing enabled (default ON for test convenience). */
function makeConfig(racing?: {
  enabled?: boolean;
  localEngine?: string;
  frontierEngine?: string;
}): import('../src/core/types.js').AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    foundry: {
      allowedBackends: ['local-coder', 'claude'] as any,
      modelRacing: racing === undefined
        ? { enabled: true }
        : racing as any,
    },
  } as unknown as import('../src/core/types.js').AshlrConfig;
}

/** Build a mock runApiModelSandboxed. */
function makeSandboxMock(opts: {
  localDiff?: string;
  frontierDiff?: string;
  /** Throw on engine ids matching these strings. */
  throwFor?: string[];
}) {
  return vi.fn(async (engine: string, _goal: string, _cfg: unknown, runOpts: Record<string, unknown>) => {
    if (opts.throwFor?.some(e => engine.includes(e))) {
      throw new Error(`sandbox error for ${engine}`);
    }
    const isLocal = !engine.includes('claude') && !engine.includes('codex');
    const diff = isLocal ? (opts.localDiff ?? 'local diff content') : (opts.frontierDiff ?? 'frontier diff content');
    const runId = (runOpts['runId'] as string) ?? `run-${engine}`;
    return {
      state: {
        id: runId,
        goal: 'test goal',
        engine,
        provider: 'mock',
        status: 'complete',
        tasks: [{ id: 'task-1', result: diff, status: 'done' }],
        steps: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        budget: { maxTokens: 4096, maxSteps: 20, maxCostUsd: 1.0 },
        usage: { inputTokens: 100, outputTokens: 50, steps: 5, costUsd: 0.01 },
      },
      proposalId: `proposal-${engine}-${randomUUID()}`,
    };
  });
}

/** Build a mock judgeProposal that returns a fixed score. */
function makeJudgeMock(scores: { local: number; frontier: number }) {
  // scores here are in the 1-5 per-dimension range (same as m142 convention)
  let callCount = 0;
  return vi.fn(async (_proposal: unknown, _cfg: unknown, _client: unknown) => {
    const idx = callCount++;
    // first call = local, second call = frontier
    const perDim = idx === 0 ? scores.local : scores.frontier;
    return {
      proposalId: `verdict-${idx}`,
      verdict: 'ship' as const,
      value: perDim,
      correctness: perDim,
      scope: 6 - perDim,   // higher score → lower scope (inverted)
      alignment: perDim,
      rationale: `Mock rationale for candidate ${idx}`,
      wouldMerge: perDim >= 4,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. EXPORT
// ---------------------------------------------------------------------------

describe('M166 — EXPORT', () => {
  it('raceTask is exported from src/core/fleet/model-racing.ts', async () => {
    const mod = await import('../src/core/fleet/model-racing.js?export=' + randomUUID());
    expect(typeof mod.raceTask).toBe('function');
  });

  it('racingStats is exported from src/core/fleet/model-racing.ts', async () => {
    const mod = await import('../src/core/fleet/model-racing.js?export2=' + randomUUID());
    expect(typeof mod.racingStats).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. RACE FLOW — local + frontier run, both scored, winner + delta computed
// ---------------------------------------------------------------------------

describe('M166 — race flow', () => {
  afterEach(() => { vi.resetModules(); });

  it('runs local + frontier in sequence, scores both, picks frontier winner', async () => {
    // local scores 2 per dim → total = 2+2+(6-2)+2 = 10
    // frontier scores 4 per dim → total = 4+4+(6-4)+4 = 14
    const sandboxMock = makeSandboxMock({ localDiff: 'local diff', frontierDiff: 'frontier diff' });
    const judgeMock = makeJudgeMock({ local: 2, frontier: 4 });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?flow=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    // Both sides ran
    expect(sandboxMock).toHaveBeenCalledTimes(2);
    // Judge called twice (once per side that produced a proposalId)
    expect(judgeMock).toHaveBeenCalledTimes(2);
    // Frontier wins
    expect(result.winner).toBe('frontier');
    expect(result.frontierScore).toBeGreaterThan(result.localScore);
    expect(result.scoreDelta).toBe(result.frontierScore - result.localScore);
  });

  it('picks local winner when local scores higher', async () => {
    // local scores 4, frontier scores 2
    const sandboxMock = makeSandboxMock({});
    const judgeMock = makeJudgeMock({ local: 4, frontier: 2 });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?local-win=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.winner).toBe('local');
    expect(result.localScore).toBeGreaterThan(result.frontierScore);
    expect(result.scoreDelta).toBeLessThan(0);
  });

  it('produces tie when scores are equal', async () => {
    const sandboxMock = makeSandboxMock({});
    const judgeMock = makeJudgeMock({ local: 3, frontier: 3 });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: judgeMock,
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?tie=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.winner).toBe('tie');
    expect(result.scoreDelta).toBe(0);
  });

  it('uses localEngine + frontierEngine from cfg', async () => {
    const sandboxMock = makeSandboxMock({});

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock({ local: 3, frontier: 3 }),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?engines=' + randomUUID());
    const cfg = makeConfig({ enabled: true, localEngine: 'my-local', frontierEngine: 'claude' });
    const result = await raceTask(makeItem(), cfg, {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.localEngine).toBe('my-local');
    expect(result.frontierEngine).toBe('claude');
    // Sandbox called with the configured engine ids
    const calls = sandboxMock.mock.calls.map(c => c[0] as string);
    expect(calls).toContain('my-local');
    expect(calls).toContain('claude');
  });
});

// ---------------------------------------------------------------------------
// 3. DISTILLATION PERSIST — race record written to JSONL with scrubbed diffs
// ---------------------------------------------------------------------------

describe('M166 — distillation persist', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m166-home-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = origHome;
    vi.resetModules();
  });

  it('persists a race record to ~/.ashlr/racing/<date>.jsonl', async () => {
    const sandboxMock = makeSandboxMock({ localDiff: 'local patch', frontierDiff: 'frontier patch' });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock({ local: 2, frontier: 4 }),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t.replace(/secret/gi, '[REDACTED]'),
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?persist=' + randomUUID());
    const item = makeItem({ id: 'test-persist', title: 'Test persist task' });
    await raceTask(item, makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    // Check file was written
    const racingDir = path.join(tmpHome, '.ashlr', 'racing');
    expect(fs.existsSync(racingDir)).toBe(true);
    const files = fs.readdirSync(racingDir).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    // Check record content
    const line = fs.readFileSync(path.join(racingDir, files[0]!), 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.taskId).toBe('test-persist');
    expect(record.taskTitle).toBe('Test persist task');
    expect(typeof record.localDiff).toBe('string');
    expect(typeof record.frontierDiff).toBe('string');
    expect(typeof record.localScore).toBe('number');
    expect(typeof record.frontierScore).toBe('number');
    expect(['local', 'frontier', 'tie']).toContain(record.winner);
    expect(typeof record.ts).toBe('string');
  });

  it('scrubs secrets from diffs before persisting', async () => {
    const secretDiff = 'diff with sk-ant-api03-supersecretkey here';
    const sandboxMock = makeSandboxMock({
      localDiff: secretDiff,
      frontierDiff: secretDiff,
    });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock({ local: 3, frontier: 3 }),
    }));
    // Use the real scrubSecrets (or a tight mock that redacts sk- keys)
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t.replace(/sk-[A-Za-z0-9\-_]+/g, '[REDACTED]'),
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?scrub=' + randomUUID());
    await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    const racingDir = path.join(tmpHome, '.ashlr', 'racing');
    const files = fs.readdirSync(racingDir).filter(f => f.endsWith('.jsonl'));
    const line = fs.readFileSync(path.join(racingDir, files[0]!), 'utf8').trim();
    const record = JSON.parse(line);

    // Secret must not appear in persisted diffs
    expect(record.localDiff).not.toContain('sk-ant-api03-supersecretkey');
    expect(record.frontierDiff).not.toContain('sk-ant-api03-supersecretkey');
    expect(record.localDiff).toContain('[REDACTED]');
  });

  it('appends multiple records to the same day file', async () => {
    const sandboxMock = makeSandboxMock({});

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock({ local: 3, frontier: 4 }),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?append=' + randomUUID());
    await raceTask(makeItem({ id: 'item-a' }), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });
    await raceTask(makeItem({ id: 'item-b' }), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    const racingDir = path.join(tmpHome, '.ashlr', 'racing');
    const files = fs.readdirSync(racingDir).filter(f => f.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(racingDir, files[0]!), 'utf8')
      .split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. RACING STATS — aggregates frontierWinRate + avgScoreDelta + localWins
// ---------------------------------------------------------------------------

describe('M166 — racingStats', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m166-stats-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = origHome;
    vi.resetModules();
  });

  /** Write synthetic race records directly to the dataset. */
  function writeRaceRecords(records: Array<{
    winner: 'local' | 'frontier' | 'tie';
    localScore: number;
    frontierScore: number;
  }>): void {
    const dir = path.join(tmpHome, '.ashlr', 'racing');
    fs.mkdirSync(dir, { recursive: true });
    const lines = records.map((r, i) => JSON.stringify({
      taskId: `task-${i}`,
      taskTitle: `Task ${i}`,
      localDiff: '',
      frontierDiff: '',
      localScore: r.localScore,
      frontierScore: r.frontierScore,
      winner: r.winner,
      ts: new Date().toISOString(),
    } satisfies import('../src/core/fleet/model-racing.js').RaceRecord));
    fs.writeFileSync(path.join(dir, '2026-06-28.jsonl'), lines.join('\n') + '\n', 'utf8');
  }

  it('returns zeroed stats when no races exist', async () => {
    const { racingStats } = await import('../src/core/fleet/model-racing.js?stats-empty=' + randomUUID());
    const stats = racingStats();
    expect(stats.races).toBe(0);
    expect(stats.frontierWinRate).toBe(0);
    expect(stats.avgScoreDelta).toBe(0);
    expect(stats.localWins).toBe(0);
  });

  it('computes frontierWinRate from persisted records', async () => {
    writeRaceRecords([
      { winner: 'frontier', localScore: 8, frontierScore: 14 },
      { winner: 'frontier', localScore: 6, frontierScore: 12 },
      { winner: 'local',    localScore: 14, frontierScore: 8 },
      { winner: 'tie',      localScore: 10, frontierScore: 10 },
    ]);

    const { racingStats } = await import('../src/core/fleet/model-racing.js?stats-rate=' + randomUUID());
    const stats = racingStats();

    expect(stats.races).toBe(4);
    expect(stats.frontierWinRate).toBeCloseTo(2 / 4, 5); // 0.5
    expect(stats.localWins).toBe(1);
  });

  it('computes avgScoreDelta correctly', async () => {
    // deltas: 14-8=6, 12-6=6, 8-14=-6 → avg = (6+6-6)/3 = 2
    writeRaceRecords([
      { winner: 'frontier', localScore: 8,  frontierScore: 14 },
      { winner: 'frontier', localScore: 6,  frontierScore: 12 },
      { winner: 'local',    localScore: 14, frontierScore: 8  },
    ]);

    const { racingStats } = await import('../src/core/fleet/model-racing.js?stats-delta=' + randomUUID());
    const stats = racingStats();

    expect(stats.races).toBe(3);
    expect(stats.avgScoreDelta).toBeCloseTo(2, 5);
  });

  it('reads across multiple JSONL files', async () => {
    const dir = path.join(tmpHome, '.ashlr', 'racing');
    fs.mkdirSync(dir, { recursive: true });

    const makeLine = (winner: 'local' | 'frontier', ls: number, fs_: number) =>
      JSON.stringify({
        taskId: 'x', taskTitle: 'x',
        localDiff: '', frontierDiff: '',
        localScore: ls, frontierScore: fs_,
        winner, ts: new Date().toISOString(),
      });

    fs.writeFileSync(path.join(dir, '2026-06-26.jsonl'), makeLine('frontier', 8, 14) + '\n');
    fs.writeFileSync(path.join(dir, '2026-06-27.jsonl'), makeLine('local', 14, 8) + '\n');

    const { racingStats } = await import('../src/core/fleet/model-racing.js?stats-multi=' + randomUUID());
    const stats = racingStats();

    expect(stats.races).toBe(2);
    expect(stats.frontierWinRate).toBeCloseTo(0.5, 5);
    expect(stats.localWins).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. FLAG OFF — no-op when modelRacing is absent or enabled:false
// ---------------------------------------------------------------------------

describe('M166 — flag off → no-op', () => {
  afterEach(() => { vi.resetModules(); });

  it('returns zeroed result when modelRacing is absent from cfg', async () => {
    const sandboxMock = vi.fn();

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: vi.fn(),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    // Config with no modelRacing block
    const cfgNoRacing = {
      version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
      telemetry: {}, tools: {},
      foundry: { allowedBackends: ['local-coder', 'claude'] },
    } as unknown as import('../src/core/types.js').AshlrConfig;

    const { raceTask } = await import('../src/core/fleet/model-racing.js?flag-absent=' + randomUUID());
    const result = await raceTask(makeItem(), cfgNoRacing);

    // No sandbox runs
    expect(sandboxMock).not.toHaveBeenCalled();
    // Zeroed result
    expect(result.localScore).toBe(0);
    expect(result.frontierScore).toBe(0);
    expect(result.winner).toBe('tie');
    expect(result.scoreDelta).toBe(0);
  });

  it('returns zeroed result when modelRacing.enabled is false', async () => {
    const sandboxMock = vi.fn();

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: vi.fn(),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?flag-off=' + randomUUID());
    // enabled: false
    const result = await raceTask(makeItem(), makeConfig({ enabled: false }));

    expect(sandboxMock).not.toHaveBeenCalled();
    expect(result.localScore).toBe(0);
    expect(result.frontierScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. NEVER THROWS — tolerates failures on either side
// ---------------------------------------------------------------------------

describe('M166 — never throws', () => {
  afterEach(() => { vi.resetModules(); });

  it('does not throw when local sandbox fails', async () => {
    const sandboxMock = makeSandboxMock({ throwFor: ['local-coder'] });

    // Local throws → judge is called only once (for frontier). Return a positive
    // score on the first (and only) judge call so frontier scores > 0.
    const frontierJudge = vi.fn().mockResolvedValue({
      proposalId: 'v-frontier',
      verdict: 'ship' as const,
      value: 4, correctness: 4, scope: 2, alignment: 4,
      rationale: 'frontier ok', wouldMerge: true,
    });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: frontierJudge,
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?throw-local=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    // Should not throw; local scores 0
    expect(result.localScore).toBe(0);
    // Frontier still ran and scored
    expect(result.frontierScore).toBeGreaterThan(0);
    expect(result.winner).toBe('frontier');
  });

  it('does not throw when frontier sandbox fails', async () => {
    const sandboxMock = makeSandboxMock({ throwFor: ['claude'] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: makeJudgeMock({ local: 4, frontier: 0 }),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?throw-frontier=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.frontierScore).toBe(0);
    expect(result.localScore).toBeGreaterThan(0);
    expect(result.winner).toBe('local');
  });

  it('does not throw when both sides fail', async () => {
    const sandboxMock = makeSandboxMock({ throwFor: ['local-coder', 'claude'] });

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: vi.fn(),
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?throw-both=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.localScore).toBe(0);
    expect(result.frontierScore).toBe(0);
    expect(result.winner).toBe('tie');
  });

  it('does not throw when judge throws on both sides', async () => {
    const sandboxMock = makeSandboxMock({});
    const failingJudge = vi.fn().mockRejectedValue(new Error('judge unavailable'));

    vi.doMock('../src/core/run/sandboxed-engine.js', () => ({
      runApiModelSandboxed: sandboxMock,
    }));
    vi.doMock('../src/core/fleet/manager.js', () => ({
      judgeProposal: failingJudge,
    }));
    vi.doMock('../src/core/util/scrub.js', () => ({
      scrubSecrets: (t: string) => t,
    }));

    const { raceTask } = await import('../src/core/fleet/model-racing.js?judge-fail=' + randomUUID());
    const result = await raceTask(makeItem(), makeConfig(), {
      sourceRepo: MOCK_REPO,
      judgeClient: { complete: vi.fn().mockResolvedValue('') },
    });

    expect(result.localScore).toBe(0);
    expect(result.frontierScore).toBe(0);
  });

  it('racingStats never throws even when racing dir is absent', async () => {
    const { racingStats } = await import('../src/core/fleet/model-racing.js?stats-nothrow=' + randomUUID());
    // HOME has no .ashlr/racing dir
    let threw = false;
    try {
      racingStats();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
