/**
 * M32 — pre-flight cost estimator (src/core/observability/estimate.ts).
 *
 * Hermetic: tmp HOME with seeded ~/.ashlr/runs fixtures; estimator must be
 * read-only and never throw (zeroed low-confidence estimate on empty/corrupt
 * history).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { estimateRun, estimateSwarm, renderEstimate } from '../src/core/observability/estimate.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Seed one completed run file under the tmp HOME. */
function seedRun(id: string, goal: string, tokens: number, opts?: { steps?: number; minutes?: number }): void {
  const dir = join(fx.ashlrDir, 'runs');
  mkdirSync(dir, { recursive: true });
  const created = new Date(Date.now() - (opts?.minutes ?? 2) * 60_000).toISOString();
  const run = {
    id,
    goal,
    engine: 'builtin',
    provider: 'ollama',
    createdAt: created,
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 50_000, maxSteps: 40, allowCloud: false },
    usage: { tokensIn: Math.floor(tokens * 0.7), tokensOut: Math.ceil(tokens * 0.3), steps: opts?.steps ?? 8, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'done',
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(run));
}

describe('estimateRun', () => {
  it('returns a zeroed low-confidence estimate on empty history (never throws)', async () => {
    const est = await estimateRun('anything at all', {}, makeCfg());
    expect(est.sampleSize).toBe(0);
    expect(est.confidence).toBe('low');
    expect(est.tokens.median).toBe(0);
  });

  it('computes percentiles over completed runs', async () => {
    seedRun('r1', 'summarize commits', 10_000);
    seedRun('r2', 'summarize commits again', 20_000);
    seedRun('r3', 'summarize all commits', 30_000);
    const est = await estimateRun('summarize the recent commits', {}, makeCfg());
    expect(est.sampleSize).toBe(3);
    expect(est.confidence).toBe('medium');
    expect(est.tokens.median).toBeGreaterThanOrEqual(10_000);
    expect(est.tokens.median).toBeLessThanOrEqual(30_000);
    expect(est.tokens.p25).toBeLessThanOrEqual(est.tokens.p75);
  });

  it('clamps percentiles to the requested budget and flags it', async () => {
    seedRun('r1', 'big goal one', 40_000);
    seedRun('r2', 'big goal two', 45_000);
    seedRun('r3', 'big goal three', 48_000);
    const est = await estimateRun('big goal four', { maxTokens: 20_000 }, makeCfg());
    expect(est.budgetClamped).toBe(true);
    expect(est.tokens.p75).toBeLessThanOrEqual(20_000);
    expect(est.tokens.median).toBeLessThanOrEqual(20_000);
  });

  it('survives corrupt run files', async () => {
    const dir = join(fx.ashlrDir, 'runs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    seedRun('ok1', 'valid run', 5_000);
    const est = await estimateRun('valid run', {}, makeCfg());
    expect(est.sampleSize).toBeGreaterThanOrEqual(1);
  });

  it('high confidence at 10+ samples', async () => {
    for (let i = 0; i < 12; i++) seedRun(`r${i}`, `deploy widget number ${i}`, 8_000 + i * 100);
    const est = await estimateRun('deploy widget number thirteen', {}, makeCfg());
    expect(est.confidence).toBe('high');
  });
});

describe('estimateSwarm', () => {
  it('returns zeroed estimate with no swarm history', async () => {
    const est = await estimateSwarm('build the thing', {}, makeCfg());
    expect(est.kind).toBe('swarm');
    expect(est.sampleSize).toBe(0);
  });
});

describe('renderEstimate', () => {
  it('renders a compact human block with confidence and token figures', async () => {
    seedRun('r1', 'render test goal', 12_000);
    seedRun('r2', 'render test goal two', 14_000);
    seedRun('r3', 'render test goal three', 16_000);
    const est = await estimateRun('render test goal four', {}, makeCfg());
    const text = renderEstimate(est);
    expect(text).toContain('confidence: medium');
    expect(text).toContain('tokens');
    expect(text).toContain('would-be-cloud');
  });

  it('tells the user when there is no history', async () => {
    const est = await estimateRun('nothing yet', {}, makeCfg());
    expect(renderEstimate(est)).toContain('no history yet');
  });
});
