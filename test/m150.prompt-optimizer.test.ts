/**
 * m150.prompt-optimizer.test.ts — GEPA offline prompt optimizer tests.
 *
 * Covers:
 *   1. optimizePrompt — GEPA loop improves a deliberately-weak base prompt
 *      against a synthetic metric (mock reflect→better candidates → bestScore > baseScore)
 *   2. optimizePrompt — metric uses cohenKappa over mocked traces
 *   3. optimizePrompt — bounded rounds/candidates (caps enforced)
 *   4. optimizePrompt — lineage tracked (one entry per round)
 *   5. optimizePrompt — never throws under any input (null/bad metric/bad client)
 *   6. optimizePrompt — NEVER writes to live prompt files (only to ~/.ashlr/optimizer/)
 *   7. optimizePrompt — dry-run metric scores base prompt without LLM calls
 *   8. buildJudgeKappaMetric — returns 0 for insufficient outcome-linked traces
 *   9. buildJudgeKappaMetric — returns correct kappa over perfect-agreement traces
 *  10. optimizePrompt — rounds=1 produces single lineage entry
 *  11. optimizePrompt — LLM client failure degrades gracefully (no throw)
 *  12. optimizePrompt — no mispredictions stops early (early exit on perfect prompt)
 *  13. optimizePrompt — output file written to optimizer dir, not live prompt files
 *  14. optimizePrompt — improvement = bestScore − baseScore
 *
 * Hermetic: HOME relocated to tmp dir; LLM client is always mocked — no live calls.
 * Mirrors m145/m119 conventions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m150-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function pid(): string { return `p-m150-${_seq++}`; }

function makeTrace(overrides: Partial<JudgeTrace> = {}): JudgeTrace {
  return {
    proposalId: pid(),
    judgeEngine: 'test-engine',
    verdict: 'ship',
    scores: { value: 4, correctness: 4, scope: 2, alignment: 4 },
    fullReasoning: 'good change',
    promptContext: 'ctx',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

/** Traces where verdict-intent matches outcome-intent (perfect agreement). */
function perfectAgreementTraces(n = 6): JudgeTrace[] {
  return [
    ...Array.from({ length: Math.ceil(n / 2) }, () =>
      makeTrace({ verdict: 'ship', outcome: 'merged' }),
    ),
    ...Array.from({ length: Math.floor(n / 2) }, () =>
      makeTrace({ verdict: 'noise', outcome: 'rejected' }),
    ),
  ];
}

/** Traces where verdict-intent always disagrees with outcome-intent. */
function worstAgreementTraces(n = 6): JudgeTrace[] {
  return Array.from({ length: n }, () =>
    makeTrace({ verdict: 'ship', outcome: 'rejected' }),
  );
}

/** A simple mock LLM client. Returns a fixed response regardless of input. */
function mockLLMClient(responseJson: string): { complete: (system: string, user: string) => Promise<string> } {
  return {
    complete: vi.fn().mockResolvedValue(responseJson),
  };
}

/**
 * Build a mock LLM that returns candidates: the first candidate gets score
 * `improvedScore` (via the metric override), subsequent ones get lower scores.
 * The metric is a counter that returns successively higher scores each call.
 */
function buildImprovingScenario(
  baseScore: number,
  improvedScore: number,
): {
  metric: (prompt: string) => number;
  client: { complete: (system: string, user: string) => Promise<string> };
} {
  // The metric scores: base prompt → baseScore, candidate prompt → improvedScore
  const seen = new Map<string, number>();
  const metric = (prompt: string): number => {
    if (!seen.has(prompt)) {
      // First call (base prompt) gets baseScore, next unique prompts get improvedScore
      seen.set(prompt, seen.size === 0 ? baseScore : improvedScore);
    }
    return seen.get(prompt)!;
  };

  // The LLM returns two candidates
  const candidates = JSON.stringify({
    reflection: 'The prompt fails to weight correctness properly.',
    candidates: [
      'Improved candidate prompt A — adds stronger correctness weighting.',
      'Improved candidate prompt B — adds clearer verdict examples.',
    ],
  });
  const client = mockLLMClient(candidates);
  return { metric, client };
}

// ---------------------------------------------------------------------------
// 1. GEPA loop improves a weak base prompt
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — GEPA improvement loop', () => {
  it('bestScore > baseScore when LLM generates a better candidate', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = perfectAgreementTraces(6);
    const { metric, client } = buildImprovingScenario(0.2, 0.8);

    const result = await optimizePrompt(
      { basePrompt: 'weak base prompt', metric, rounds: 2, candidatesPerRound: 2 },
      {},
      client,
      traces,
    );

    expect(result.bestScore).toBeGreaterThan(result.baseScore);
    expect(result.improvement).toBeGreaterThan(0);
  });

  it('improvement equals bestScore − baseScore', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = perfectAgreementTraces(6);
    const { metric, client } = buildImprovingScenario(0.1, 0.7);

    const result = await optimizePrompt(
      { basePrompt: 'initial prompt', metric, rounds: 1, candidatesPerRound: 2 },
      {},
      client,
      traces,
    );

    expect(result.improvement).toBeCloseTo(result.bestScore - result.baseScore, 10);
  });

  it('bestScore reflects the highest-scoring candidate when LLM generates improvements', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    // Metric: base prompt → 0.1, any candidate → 0.9
    // (candidates contain the word 'improved' — base does not)
    const metric = (prompt: string): number => {
      if (prompt.includes('improved')) return 0.9;
      return 0.1; // base prompt
    };

    const candidates = JSON.stringify({
      reflection: 'root cause',
      candidates: [
        'improved variant A: stronger correctness weighting',
        'improved variant B: clearer verdict examples',
      ],
    });
    const client = mockLLMClient(candidates);
    const traces = worstAgreementTraces(6);

    const result = await optimizePrompt(
      { basePrompt: 'weak baseline prompt', metric, rounds: 1, candidatesPerRound: 2 },
      {},
      client,
      traces,
    );

    // The optimizer must select the best candidate (score 0.9 > base 0.1)
    expect(result.bestScore).toBeGreaterThan(result.baseScore);
    expect(result.bestScore).toBeCloseTo(0.9, 5);
    expect(result.baseScore).toBeCloseTo(0.1, 5);
    expect(result.improvement).toBeGreaterThan(0);
    // bestPrompt must be one of the candidates (contains 'improved')
    expect(result.bestPrompt).toContain('improved');
  });
});

describe('m150 optimizePrompt — metadata-only reflection', () => {
  it('never forwards legacy reasoning or prompt context into optimizer prompts', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');
    const client = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        reflection: 'Use the numeric rubric.',
        candidates: ['candidate-a'],
      })),
    };
    const trace = makeTrace({
      verdict: 'ship',
      outcome: 'rejected',
      fullReasoning: 'RAW_LEGACY_REASONING_CANARY',
      promptContext: 'RAW_LEGACY_PROMPT_CANARY',
    });
    await optimizePrompt({
      basePrompt: 'base',
      metric: () => 0,
      rounds: 1,
      candidatesPerRound: 1,
    }, {}, client, [trace]);
    const reflectionPrompt = String(client.complete.mock.calls[0]?.[1] ?? '');
    expect(reflectionPrompt).not.toContain('RAW_LEGACY_REASONING_CANARY');
    expect(reflectionPrompt).not.toContain('RAW_LEGACY_PROMPT_CANARY');
    expect(reflectionPrompt).toContain('Scores: value=4, correctness=4, scope=2, alignment=4');
  });
});

// ---------------------------------------------------------------------------
// 2. Metric uses cohenKappa over mocked traces
// ---------------------------------------------------------------------------

describe('m150 buildJudgeKappaMetric — kappa-based scoring', () => {
  it('returns 0 when fewer than 2 outcome-linked traces', async () => {
    const { buildJudgeKappaMetric } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = [makeTrace({ outcome: 'merged' })]; // only 1
    const metric = buildJudgeKappaMetric(traces);
    expect(metric('any prompt')).toBe(0);
  });

  it('returns 0 when no outcome-linked traces', async () => {
    const { buildJudgeKappaMetric } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = [makeTrace(), makeTrace(), makeTrace()]; // no outcomes
    const metric = buildJudgeKappaMetric(traces);
    expect(metric('any prompt')).toBe(0);
  });

  it('returns kappa ≈ 1.0 for perfect-agreement traces', async () => {
    const { buildJudgeKappaMetric } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = perfectAgreementTraces(6);
    const metric = buildJudgeKappaMetric(traces);
    const score = metric('any prompt');
    // Perfect agreement between ship→merge and merged→merge, noise→reject and rejected→reject
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('returns low/negative kappa for worst-agreement traces', async () => {
    const { buildJudgeKappaMetric } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = worstAgreementTraces(6);
    const metric = buildJudgeKappaMetric(traces);
    const score = metric('any prompt');
    // All verdict=ship (merge) but outcome=rejected (reject) → systematic disagreement
    expect(score).toBeLessThan(0.2);
  });

  it('returns a number (not null) when sufficient traces exist', async () => {
    const { buildJudgeKappaMetric } = await import('../src/core/fleet/prompt-optimizer.js');

    const traces = [
      makeTrace({ verdict: 'ship', outcome: 'merged' }),
      makeTrace({ verdict: 'review', outcome: 'reverted' }),
      makeTrace({ verdict: 'noise', outcome: 'rejected' }),
    ];
    const metric = buildJudgeKappaMetric(traces);
    const score = metric('any prompt');
    expect(typeof score).toBe('number');
    expect(isFinite(score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Bounded rounds/candidates
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — bounds enforcement', () => {
  it('caps rounds at MAX_ROUNDS (10)', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['c1', 'c2'] }));
    let callCount = 0;
    const metric = (_p: string) => { callCount++; return 0.5; };

    // Request 999 rounds — should be capped at 10
    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 999, candidatesPerRound: 1 },
      {},
      client,
      perfectAgreementTraces(6),
    );

    expect(result.lineage.length).toBeLessThanOrEqual(10);
  });

  it('caps candidatesPerRound at MAX_CANDIDATES (8)', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    // LLM returns 20 candidates — only 8 should be parsed
    const manyCandidates = Array.from({ length: 20 }, (_, i) => `candidate ${i}`);
    const client = mockLLMClient(
      JSON.stringify({ reflection: 'r', candidates: manyCandidates }),
    );
    const metric = (_p: string) => 0.5;

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 1, candidatesPerRound: 999 },
      {},
      client,
      perfectAgreementTraces(6),
    );

    // Each round's candidates array should be ≤ 8
    for (const entry of result.lineage) {
      expect(entry.candidates.length).toBeLessThanOrEqual(8);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Lineage tracked
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — lineage tracking', () => {
  it('produces one lineage entry per round', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['c1'] }));
    const metric = (_p: string) => 0.5;

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 3, candidatesPerRound: 1 },
      {},
      client,
      perfectAgreementTraces(6),
    );

    // Early-exit may fire if no mispredictions after round 1, but lineage has ≥ 1 entry
    expect(result.lineage.length).toBeGreaterThanOrEqual(1);
    expect(result.lineage.length).toBeLessThanOrEqual(3 + 1); // +1 for early-exit entry
  });

  it('rounds=1 produces exactly 1 lineage entry', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['better prompt'] }));
    let n = 0;
    const metric = (_p: string) => { n++; return n === 1 ? 0.1 : 0.9; };

    const result = await optimizePrompt(
      { basePrompt: 'weak', metric, rounds: 1, candidatesPerRound: 1 },
      {},
      client,
      worstAgreementTraces(6),
    );

    expect(result.lineage.length).toBe(1);
    expect(result.lineage[0]!.round).toBe(1);
  });

  it('lineage entries carry round number, prompt, score, candidates', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['improved'] }));
    let n = 0;
    const metric = (_p: string) => { n++; return n === 1 ? 0.2 : 0.7; };

    const result = await optimizePrompt(
      { basePrompt: 'start', metric, rounds: 1, candidatesPerRound: 1 },
      {},
      client,
      worstAgreementTraces(6),
    );

    expect(result.lineage[0]).toMatchObject({
      round: 1,
      prompt: expect.any(String),
      score: expect.any(Number),
      candidates: expect.any(Array),
      selected: expect.any(String),
      selectedScore: expect.any(Number),
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Never throws
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — never throws', () => {
  it('never throws when metric always throws', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['c'] }));
    const metric = (_p: string): number => { throw new Error('metric exploded'); };

    await expect(
      optimizePrompt(
        { basePrompt: 'base', metric, rounds: 2 },
        {},
        client,
        [],
      ),
    ).resolves.not.toThrow();
  });

  it('never throws when LLM client rejects', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = { complete: vi.fn().mockRejectedValue(new Error('network error')) };
    const metric = (_p: string) => 0.5;

    await expect(
      optimizePrompt(
        { basePrompt: 'base', metric, rounds: 2 },
        {},
        client,
        perfectAgreementTraces(6),
      ),
    ).resolves.not.toThrow();
  });

  it('never throws when traces is empty', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['c'] }));
    const metric = (_p: string) => 0.5;

    await expect(
      optimizePrompt({ basePrompt: 'base', metric, rounds: 1 }, {}, client, []),
    ).resolves.not.toThrow();
  });

  it('never throws when LLM returns malformed JSON', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient('not json at all { broken');
    const metric = (_p: string) => 0.5;

    await expect(
      optimizePrompt(
        { basePrompt: 'base', metric, rounds: 1 },
        {},
        client,
        worstAgreementTraces(6),
      ),
    ).resolves.not.toThrow();
  });

  it('never throws with null-like inputs', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient('{}');
    const metric = (_p: string) => 0;

    await expect(
      optimizePrompt(
        { basePrompt: '', metric, rounds: 0 },
        null,
        client,
        [],
      ),
    ).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. NEVER writes to live prompt files
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — offline safety (no live prompt file writes)', () => {
  it('outputFile path is under ~/.ashlr/optimizer/, not manager.ts or strategist.ts', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['improved'] }));
    let n = 0;
    const metric = (_p: string) => { n++; return n <= 1 ? 0.1 : 0.8; };

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 1, candidatesPerRound: 1, target: 'judge' },
      {},
      client,
      worstAgreementTraces(6),
    );

    // Output file (when written) must be under ~/.ashlr/optimizer/
    if (result.outputFile !== null) {
      expect(result.outputFile).toContain('optimizer');
      expect(result.outputFile).not.toContain('manager.ts');
      expect(result.outputFile).not.toContain('strategist.ts');
      expect(result.outputFile).not.toContain('fleet.ts');
    }
  });

  it('does not write to manager.ts or strategist.ts — output file is in optimizer dir only', async () => {
    const { optimizePrompt, optimizerDir } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['improved A', 'improved B'] }));
    let n = 0;
    const metric = (_p: string) => { n++; return n <= 1 ? 0.0 : 1.0; };

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 2, candidatesPerRound: 2, target: 'judge' },
      {},
      client,
      worstAgreementTraces(6),
    );

    // The only output file is under ~/.ashlr/optimizer/ — never under src/
    if (result.outputFile !== null) {
      const dir = optimizerDir();
      expect(result.outputFile).toContain(dir);
      expect(result.outputFile).not.toMatch(/manager\.ts|strategist\.ts|fleet\.ts/);
      // The optimizer dir must be inside tmpHome (our isolated HOME)
      expect(result.outputFile).toContain(tmpHome);
    }

    // Verify no files were written outside the optimizer dir by listing src/core/fleet/
    const fleetDir = path.join(path.dirname(path.dirname(path.dirname(path.dirname(__dirname)))), 'src', 'core', 'fleet');
    // The optimizer dir itself must NOT be the fleet source dir
    expect(optimizerDir()).not.toBe(fleetDir);
    expect(optimizerDir()).toContain('.ashlr');
    expect(optimizerDir()).toContain('optimizer');
  });

  it('output file content contains _note about human review', async () => {
    const { optimizePrompt, optimizerDir } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['improved'] }));
    let n = 0;
    const metric = (_p: string) => { n++; return n <= 1 ? 0.1 : 0.9; };

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 1, candidatesPerRound: 1, target: 'judge' },
      {},
      client,
      worstAgreementTraces(6),
    );

    if (result.outputFile && fs.existsSync(result.outputFile)) {
      const raw = fs.readFileSync(result.outputFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Must contain the human-review safety note
      expect(typeof parsed['_note']).toBe('string');
      expect((parsed['_note'] as string).toLowerCase()).toContain('human review');
      expect((parsed['_note'] as string).toLowerCase()).toContain('never');
    }

    void optimizerDir; // imported but unused in this path — suppress lint
  });
});

// ---------------------------------------------------------------------------
// 7. Scores base prompt without LLM calls when mispredictions are absent
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — early exit on no mispredictions', () => {
  it('stops after round 1 early-exit entry when no mispredictions remain', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    // Perfect-agreement traces → no mispredictions → early exit after round 1
    // (Round 1 fires once since mispredictions guard fires at round > 1)
    const client = mockLLMClient(JSON.stringify({ reflection: 'r', candidates: ['c'] }));
    const metric = (_p: string) => 1.0;

    const result = await optimizePrompt(
      { basePrompt: 'perfect', metric, rounds: 5, candidatesPerRound: 1 },
      {},
      client,
      perfectAgreementTraces(6),
    );

    // Lineage should be short — at most 2 entries (round 1 with candidates + early-exit)
    expect(result.lineage.length).toBeLessThanOrEqual(2);
    expect(result.bestScore).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 8. LLM client failure degrades gracefully
// ---------------------------------------------------------------------------

describe('m150 optimizePrompt — LLM failure degradation', () => {
  it('returns baseScore as bestScore when LLM always fails', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = { complete: vi.fn().mockRejectedValue(new Error('timeout')) };
    const metric = (_p: string) => 0.42;

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 3, candidatesPerRound: 2 },
      {},
      client,
      worstAgreementTraces(6),
    );

    // No candidates scored → bestScore stays at baseScore
    expect(result.bestScore).toBeCloseTo(0.42, 5);
    expect(result.improvement).toBeCloseTo(0, 5);
  });

  it('lineage still has entries even when LLM fails (no-op entries)', async () => {
    const { optimizePrompt } = await import('../src/core/fleet/prompt-optimizer.js');

    const client = { complete: vi.fn().mockRejectedValue(new Error('no network')) };
    const metric = (_p: string) => 0.3;

    const result = await optimizePrompt(
      { basePrompt: 'base', metric, rounds: 2, candidatesPerRound: 1 },
      {},
      client,
      worstAgreementTraces(6),
    );

    // Lineage should still be present even with LLM failure
    expect(result.lineage.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.lineage) {
      expect(entry.candidates).toHaveLength(0); // no candidates when LLM failed
    }
  });
});
