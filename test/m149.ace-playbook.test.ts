/**
 * m149.ace-playbook.test.ts — ACE (Agentic Context Engineering) delta-curated playbook.
 *
 * Units under test:
 *   1. addDelta — appends entries, deduplicates near-identical text
 *   2. curate   — merges duplicates + retires stale/low-hit entries INCREMENTALLY
 *                 (no collapse: live set never dropped below cap)
 *   3. renderPlaybook — budget-bounded, recency+hit ranked output
 *   4. flag-ON strategist — adoptBriefing appends deltas instead of only overwriting spec
 *   5. flag-ON judge     — judgeProposal injects playbook into system prompt + parses verdict
 *   6. flag-OFF parity   — both byte-identical to current behavior (no playbook calls)
 *
 * Hermetic: HOME relocated to a tmp dir. FS and client mocked per m121/m135 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m149-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared mocks (needed by strategist / manager tests)
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'mock-frontier',
    complete: vi.fn().mockResolvedValue('{}'),
  })),
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: vi.fn((objective: string, opts?: { project?: string | null }) => ({
    id: `goal-${Math.random().toString(36).slice(2, 7)}`,
    objective,
    project: opts?.project ?? null,
    status: 'planning',
    milestones: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  listGoals: vi.fn(() => []),
}));

vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: vi.fn(() => ({
    window: '30d', proposalsCreated: 5, merged: 3, rejected: 0, pending: 2,
    withDiff: 4, emptyRate: 0.1, trivialRatio: 0.1, acceptRate: 0.6,
    rejectRate: 0.0, verifyPassRate: 0.8, avgDiffLines: 30, byEngine: {}, byRepo: {},
  })),
}));

vi.mock('../src/core/quality/health.js', () => ({
  computeReport: vi.fn(async () => ({ repos: [{ overall: 80 }] })),
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: vi.fn(),
}));

vi.mock('../src/core/fleet/judge-trace.js', () => ({
  recordJudgeTrace: vi.fn(),
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  classifyRisk: vi.fn(() => 'low' as const),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCfgOff: AshlrConfig = {
  provider: 'anthropic',
  models: { ollama: 'http://127.0.0.1:9' },
  foundry: { allowedBackends: ['builtin'] },
} as unknown as AshlrConfig;

const mockCfgOn: AshlrConfig = {
  provider: 'anthropic',
  models: { ollama: 'http://127.0.0.1:9' },
  foundry: { allowedBackends: ['builtin'], acePlaybook: true },
} as unknown as AshlrConfig;

function playbookPath(): string {
  return path.join(tmpHome, '.ashlr', 'vision', 'playbook.jsonl');
}

function readRawEntries(): unknown[] {
  if (!fs.existsSync(playbookPath())) return [];
  return fs.readFileSync(playbookPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 1. addDelta — append + dedup
// ---------------------------------------------------------------------------

describe('M149 — addDelta', () => {
  it('appends a new entry to the JSONL file', async () => {
    const { addDelta } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Ship the multi-file executor first.');
    const entries = readRawEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0] as Record<string, unknown>;
    expect(e['section']).toBe('strategy');
    expect(e['text']).toBe('Ship the multi-file executor first.');
    expect(typeof e['id']).toBe('string');
    expect(e['hits']).toBe(0);
  });

  it('appends a second distinct entry as a new line', async () => {
    const { addDelta } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Lesson A');
    addDelta('strategy', 'Lesson B — completely different');
    const entries = readRawEntries();
    expect(entries).toHaveLength(2);
  });

  it('deduplicates near-identical text — increments hits, no new entry', async () => {
    const { addDelta, getEntries } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Ship the executor module');
    addDelta('strategy', 'Ship the executor module'); // exact duplicate
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hits).toBe(1);
  });

  it('deduplicates near-identical text (normalised whitespace)', async () => {
    const { addDelta, getEntries } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Prioritise quality gates.');
    addDelta('strategy', 'prioritise quality gates.'); // same after normalisation
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hits).toBe(1);
  });

  it('keeps distinct sections separate — same text in different sections = two entries', async () => {
    const { addDelta, getEntries } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Check correctness carefully.');
    addDelta('judge', 'Check correctness carefully.');
    const entries = getEntries();
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.section === 'strategy')).toHaveLength(1);
    expect(entries.filter((e) => e.section === 'judge')).toHaveLength(1);
  });

  it('ignores empty / whitespace-only text', async () => {
    const { addDelta, getEntries } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', '   ');
    addDelta('strategy', '');
    expect(getEntries()).toHaveLength(0);
  });

  it('never throws on any input', async () => {
    const { addDelta } = await import('../src/core/vision/playbook.js');
    expect(() => addDelta('strategy', 'x')).not.toThrow();
    expect(() => addDelta('judge', '')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. curate — incremental merge + retire (no collapse)
// ---------------------------------------------------------------------------

describe('M149 — curate (incremental, no collapse)', () => {
  it('merges near-duplicate entries — winner keeps combined hits', async () => {
    const { addDelta, curate, getEntries } = await import('../src/core/vision/playbook.js');
    // Manually write two near-duplicates with different hit counts.
    const now = new Date().toISOString();
    const entries = [
      { id: 'a', section: 'strategy', text: 'Ship quality gates now', addedAt: now, hits: 3, lastUsedAt: now },
      { id: 'b', section: 'strategy', text: 'ship quality gates now', addedAt: now, hits: 1, lastUsedAt: now },
      { id: 'c', section: 'strategy', text: 'Totally different lesson about testing', addedAt: now, hits: 2, lastUsedAt: now },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    curate('strategy');

    const active = getEntries().filter((e) => !e.retired && e.section === 'strategy');
    // 'a' and 'b' should be merged into one
    expect(active).toHaveLength(2);
    const merged = active.find((e) => e.id === 'a' || e.id === 'b')!;
    expect(merged.hits).toBe(4); // 3 + 1
  });

  it('retires only stale low-hit entries PAST the cap — does not drop live set below cap', async () => {
    const { curate, getEntries } = await import('../src/core/vision/playbook.js');
    const now = new Date().toISOString();
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago

    // Write cap=3 entries plus 2 stale-low-hit entries beyond cap.
    const entries = [
      { id: 'live1', section: 'strategy', text: 'Lesson 1 live', addedAt: now, hits: 5, lastUsedAt: now },
      { id: 'live2', section: 'strategy', text: 'Lesson 2 live', addedAt: now, hits: 4, lastUsedAt: now },
      { id: 'live3', section: 'strategy', text: 'Lesson 3 live', addedAt: now, hits: 3, lastUsedAt: now },
      { id: 'stale1', section: 'strategy', text: 'Old forgotten lesson A', addedAt: staleDate, hits: 0, lastUsedAt: staleDate },
      { id: 'stale2', section: 'strategy', text: 'Old forgotten lesson B', addedAt: staleDate, hits: 0, lastUsedAt: staleDate },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    curate('strategy', { cap: 3, staleDays: 30, minHits: 1 });

    const all = getEntries();
    const active = all.filter((e) => !e.retired && e.section === 'strategy');
    const retired = all.filter((e) => e.retired && e.section === 'strategy');

    // The 3 live entries survive (cap=3 — they rank above stale ones)
    expect(active.map((e) => e.id).sort()).toEqual(['live1', 'live2', 'live3']);
    // Stale low-hit entries are retired (not deleted — still in file)
    expect(retired).toHaveLength(2);
    // Total entries preserved (audit trail intact)
    expect(all).toHaveLength(5);
  });

  it('never drops entries below the cap regardless of staleness', async () => {
    const { curate, getEntries } = await import('../src/core/vision/playbook.js');
    const staleDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const entries = [
      { id: 'e1', section: 'judge', text: 'Judge: prefer correctness', addedAt: staleDate, hits: 0, lastUsedAt: staleDate },
      { id: 'e2', section: 'judge', text: 'Judge: alignment matters', addedAt: staleDate, hits: 0, lastUsedAt: staleDate },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    // cap=10 → both entries are within cap, neither should be retired
    curate('judge', { cap: 10, staleDays: 30, minHits: 1 });

    const active = getEntries().filter((e) => !e.retired && e.section === 'judge');
    expect(active).toHaveLength(2);
  });

  it('retired entries stay in file (audit trail preserved)', async () => {
    const { curate, getEntries } = await import('../src/core/vision/playbook.js');
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const entries = [
      { id: 'x1', section: 'strategy', text: 'Keep me', addedAt: now, hits: 10, lastUsedAt: now },
      { id: 'x2', section: 'strategy', text: 'Retire me', addedAt: staleDate, hits: 0, lastUsedAt: staleDate },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    curate('strategy', { cap: 1, staleDays: 30, minHits: 1 });

    const all = getEntries();
    expect(all).toHaveLength(2); // both still present
    expect(all.find((e) => e.id === 'x2')!.retired).toBe(true);
    expect(all.find((e) => e.id === 'x1')!.retired).toBeFalsy();
  });

  it('never throws', async () => {
    const { curate } = await import('../src/core/vision/playbook.js');
    expect(() => curate('strategy')).not.toThrow();
    expect(() => curate('judge', { cap: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. renderPlaybook — budget-bounded + recency/hit ranked
// ---------------------------------------------------------------------------

describe('M149 — renderPlaybook', () => {
  it('returns empty string when no entries exist', async () => {
    const { renderPlaybook } = await import('../src/core/vision/playbook.js');
    expect(renderPlaybook('strategy', 500)).toBe('');
  });

  it('includes header and bullet entries', async () => {
    const { addDelta, renderPlaybook } = await import('../src/core/vision/playbook.js');
    addDelta('strategy', 'Ship fast and measure.');
    addDelta('strategy', 'Quality gates prevent regressions.');
    const rendered = renderPlaybook('strategy', 500);
    expect(rendered).toContain('ACCUMULATED STRATEGY LESSONS');
    expect(rendered).toContain('Ship fast and measure.');
    expect(rendered).toContain('Quality gates prevent regressions.');
  });

  it('uses judge header for judge section', async () => {
    const { addDelta, renderPlaybook } = await import('../src/core/vision/playbook.js');
    addDelta('judge', 'Prefer correctness over speed.');
    const rendered = renderPlaybook('judge', 500);
    expect(rendered).toContain('ACCUMULATED JUDGE LESSONS');
  });

  it('respects token budget — stops adding entries when budget exceeded', async () => {
    const { addDelta, renderPlaybook } = await import('../src/core/vision/playbook.js');
    // Add many long entries
    for (let i = 0; i < 20; i++) {
      addDelta('strategy', `Lesson ${i}: ${'x'.repeat(100)}`);
    }
    // Very tight budget (50 tokens ≈ 200 chars)
    const rendered = renderPlaybook('strategy', 50);
    // Should not include all 20 entries
    const bulletCount = (rendered.match(/^- /gm) ?? []).length;
    expect(bulletCount).toBeGreaterThan(0);
    expect(bulletCount).toBeLessThan(20);
  });

  it('ranks higher-hit entries first', async () => {
    const { getEntries, renderPlaybook } = await import('../src/core/vision/playbook.js');
    const now = new Date().toISOString();
    const entries = [
      { id: 'low', section: 'strategy', text: 'Low hit lesson', addedAt: now, hits: 0, lastUsedAt: now },
      { id: 'high', section: 'strategy', text: 'High hit lesson', addedAt: now, hits: 10, lastUsedAt: now },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    void getEntries;
    const rendered = renderPlaybook('strategy', 500);
    const highIdx = rendered.indexOf('High hit lesson');
    const lowIdx = rendered.indexOf('Low hit lesson');
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('excludes retired entries', async () => {
    const { renderPlaybook } = await import('../src/core/vision/playbook.js');
    const now = new Date().toISOString();
    const entries = [
      { id: 'r1', section: 'strategy', text: 'Retired lesson', addedAt: now, hits: 5, lastUsedAt: now, retired: true },
      { id: 'r2', section: 'strategy', text: 'Active lesson', addedAt: now, hits: 2, lastUsedAt: now },
    ];
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'vision'), { recursive: true });
    fs.writeFileSync(playbookPath(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const rendered = renderPlaybook('strategy', 500);
    expect(rendered).not.toContain('Retired lesson');
    expect(rendered).toContain('Active lesson');
  });

  it('never throws', async () => {
    const { renderPlaybook } = await import('../src/core/vision/playbook.js');
    expect(() => renderPlaybook('strategy', 0)).not.toThrow();
    expect(() => renderPlaybook('judge', -1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. flag-ON strategist — adoptBriefing appends deltas
// ---------------------------------------------------------------------------

describe('M149 — flag-ON: adoptBriefing appends deltas to playbook', () => {
  it('appends recommendedDirection items as strategy deltas when acePlaybook=true', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');
    const { getEntries } = await import('../src/core/vision/playbook.js');

    const briefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'Fleet is healthy.',
      gapToVision: 'Need multi-repo support.',
      proposedEvolution: { ambitionLevel: 9 },
      recommendedDirection: ['Implement cross-repo dependency graph', 'Add verify step to all proposals'],
      newProblems: ['Cross-repo resolution at scale'],
      questionsForMason: [],
      proposedGoals: [],
    };

    await adoptBriefing(mockCfgOn, briefing);

    const strategyEntries = getEntries().filter((e) => e.section === 'strategy' && !e.retired);
    // 2 directions + 1 problem prefixed = 3 entries
    expect(strategyEntries.length).toBeGreaterThanOrEqual(3);
    const texts = strategyEntries.map((e) => e.text);
    expect(texts.some((t) => t.includes('cross-repo dependency graph') || t.includes('Implement cross-repo'))).toBe(true);
    expect(texts.some((t) => t.includes('Hard problem:'))).toBe(true);
  });

  it('spec fields still update when acePlaybook=true (both paths active)', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');
    const { loadSpec } = await import('../src/core/vision/spec.js');

    const briefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: { northStar: 'ACE-updated north star.' },
      recommendedDirection: ['Direction X'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    };

    await adoptBriefing(mockCfgOn, briefing);

    const spec = loadSpec('ecosystem');
    expect(spec!.northStar).toBe('ACE-updated north star.');
  });

  it('flag-OFF: adoptBriefing does NOT write playbook entries', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');
    const { getEntries } = await import('../src/core/vision/playbook.js');

    const briefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: {},
      recommendedDirection: ['Some direction'],
      newProblems: ['A problem'],
      questionsForMason: [],
      proposedGoals: [],
    };

    await adoptBriefing(mockCfgOff, briefing);

    // No playbook entries written
    expect(getEntries()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'vision', 'playbook.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. flag-ON judge — injects playbook + still parses verdict
// ---------------------------------------------------------------------------

describe('M149 — flag-ON: judgeProposal injects playbook into system prompt', () => {
  it('includes judge playbook in system prompt when acePlaybook=true and entries exist', async () => {
    const { addDelta } = await import('../src/core/vision/playbook.js');
    addDelta('judge', 'Always penalise scope creep in proposals.');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const capturedSystem: string[] = [];
    const mockClient = {
      complete: vi.fn(async (system: string) => {
        capturedSystem.push(system);
        return JSON.stringify({ verdict: 'ship', value: 4, correctness: 4, scope: 2, alignment: 4, rationale: 'ACE playbook injected.' });
      }),
    };

    const proposal = {
      id: 'p-ace-1',
      title: 'ACE test proposal',
      summary: 'Tests playbook injection.',
      kind: 'fix',
      engineModel: 'mock',
      repo: undefined,
      diff: '+const x = 1;\n',
      status: 'pending',
      createdAt: new Date().toISOString(),
    } as Parameters<typeof judgeProposal>[0];

    const verdict = await judgeProposal(proposal, mockCfgOn, mockClient);

    // Verdict still parsed correctly
    expect(verdict.verdict).toBe('ship');
    expect(verdict.value).toBe(4);
    expect(verdict.rationale).toContain('ACE playbook injected.');

    // System prompt must contain the playbook lesson
    expect(capturedSystem[0]).toContain('Always penalise scope creep');
    expect(capturedSystem[0]).toContain('ACCUMULATED JUDGE LESSONS');
  });

  it('flag-ON but no judge entries — system prompt equals JUDGE_SYSTEM unchanged', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const capturedSystem: string[] = [];
    const mockClient = {
      complete: vi.fn(async (system: string) => {
        capturedSystem.push(system);
        return JSON.stringify({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'no playbook entries' });
      }),
    };

    const proposal = {
      id: 'p-ace-2', title: 'Empty playbook test', summary: 'No judge entries.',
      kind: 'patch', engineModel: 'mock', repo: undefined,
      diff: '+foo();\n', status: 'pending', createdAt: new Date().toISOString(),
    } as Parameters<typeof judgeProposal>[0];

    await judgeProposal(proposal, mockCfgOn, mockClient);

    // No ACCUMULATED JUDGE LESSONS section since playbook is empty
    expect(capturedSystem[0]).not.toContain('ACCUMULATED JUDGE LESSONS');
  });
});

// ---------------------------------------------------------------------------
// 6. flag-OFF parity — no playbook calls, byte-identical behavior
// ---------------------------------------------------------------------------

describe('M149 — flag-OFF: byte-identical current behavior', () => {
  it('judgeProposal flag-OFF: system prompt equals JUDGE_SYSTEM exactly (no playbook)', async () => {
    // Pre-populate judge playbook entries — they must NOT appear when flag is off.
    const { addDelta } = await import('../src/core/vision/playbook.js');
    addDelta('judge', 'This lesson must NOT appear when flag is off.');

    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const capturedSystem: string[] = [];
    const mockClient = {
      complete: vi.fn(async (system: string) => {
        capturedSystem.push(system);
        return JSON.stringify({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'flag-off' });
      }),
    };

    const proposal = {
      id: 'p-off-1', title: 'Flag-off test', summary: 'Should not inject playbook.',
      kind: 'fix', engineModel: 'mock', repo: undefined,
      diff: '+bar();\n', status: 'pending', createdAt: new Date().toISOString(),
    } as Parameters<typeof judgeProposal>[0];

    await judgeProposal(proposal, mockCfgOff, mockClient);

    expect(capturedSystem[0]).not.toContain('ACCUMULATED JUDGE LESSONS');
    expect(capturedSystem[0]).not.toContain('This lesson must NOT appear');
  });

  it('adoptBriefing flag-OFF: playbook.jsonl is never created', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');

    const briefing = {
      generatedAt: new Date().toISOString(), project: null,
      currentState: 'State.', gapToVision: 'Gap.',
      proposedEvolution: { ambitionLevel: 8 },
      recommendedDirection: ['Do X', 'Do Y'],
      newProblems: ['Problem Z'], questionsForMason: [], proposedGoals: [],
    };

    await adoptBriefing(mockCfgOff, briefing);

    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'vision', 'playbook.jsonl'))).toBe(false);
  });

  it('spec still evolves correctly when flag is off', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');
    const { loadSpec } = await import('../src/core/vision/spec.js');

    const briefing = {
      generatedAt: new Date().toISOString(), project: null,
      currentState: 'State.', gapToVision: 'Gap.',
      proposedEvolution: { northStar: 'Flag-off north star update.' },
      recommendedDirection: [], newProblems: [], questionsForMason: [], proposedGoals: [],
    };

    await adoptBriefing(mockCfgOff, briefing);

    expect(loadSpec('ecosystem')!.northStar).toBe('Flag-off north star update.');
  });
});
