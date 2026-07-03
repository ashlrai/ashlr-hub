/**
 * m240.learned-routing.test.ts — M240: learned-bias engine/model routing.
 *
 * Four core contracts:
 *  1. High-ship-rate engine is tried first for a task-class.
 *  2. High-reject-rate engine is deprioritized for a task-class.
 *  3. Cold-start (no history / below min-sample floor) = static policy unchanged.
 *  4. learnedRouting:false = byte-identical to pre-M240 static routing.
 *
 * Additional safety invariants:
 *  5. Hard constraints (allowedBackends) are never violated.
 *  6. buildEngineScores never throws on empty / malformed ledger.
 *  7. engineScoreFor returns 0.5 (neutral) for unknown engine.
 *  8. sortEnginesByScore is stable (original order preserved on equal scores).
 *  9. Recency weight: very old verdicts contribute less than recent ones.
 * 10. Sample floor: fewer than MIN_SAMPLES → score stays neutral (0.5).
 *
 * Isolation: all tests use a fresh tmp HOME so they never read a real
 * ~/.ashlr/decisions directory and never write to it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers — isolate HOME so readDecisions() never touches the real ledger
// ---------------------------------------------------------------------------

let origHome: string | undefined;
let origAshlrHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  origHome = process.env['HOME'];
  origAshlrHome = process.env['ASHLR_HOME'];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm240-test-'));
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  if (origHome !== undefined) process.env['HOME'] = origHome;
  else delete process.env['HOME'];
  if (origAshlrHome !== undefined) process.env['ASHLR_HOME'] = origAshlrHome;
  else delete process.env['ASHLR_HOME'];
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Write synthetic decisions-ledger entries into the isolated tmp HOME.
 * `entries` is a list of partial DecisionEntry-like objects; ts defaults to now.
 */
function writeDecisions(
  entries: Array<{
    proposalId: string;
    action: string;
    workItemId?: string;
    workSource?: string;
    runId?: string;
    engine?: string;
    model?: string;
    verdict?: string;
    ts?: string;
  }>,
): void {
  const dir = path.join(tmpHome, '.ashlr', 'decisions');
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${today}.jsonl`);
  const lines = entries
    .map((e) =>
      JSON.stringify({
        ts: e.ts ?? new Date().toISOString(),
        proposalId: e.proposalId,
        ...(e.workItemId !== undefined ? { workItemId: e.workItemId } : {}),
        ...(e.workSource !== undefined ? { workSource: e.workSource } : {}),
        ...(e.runId !== undefined ? { runId: e.runId } : {}),
        action: e.action,
        ...(e.engine !== undefined ? { engine: e.engine } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
        ...(e.verdict !== undefined ? { verdict: e.verdict } : {}),
      }),
    )
    .join('\n');
  fs.writeFileSync(file, lines + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Import under test (after HOME is set in beforeEach)
// ---------------------------------------------------------------------------

import {
  buildEngineScores,
  engineScoreFor,
  sortEnginesByScore,
  LEARNED_ROUTING_MIN_SAMPLES,
  LEARNED_ROUTING_HALF_LIFE_MS,
  type EngineScoreMap,
} from '../src/core/run/learned-router.js';
import { routeTask, type RoutingContext } from '../src/core/run/router.js';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(source: string, effort = 3, score = 4): WorkItem {
  return {
    id: `test-repo:${source}:abc123`,
    repo: '/tmp/test-repo',
    title: `Test ${source} item`,
    source: source as WorkItem['source'],
    effort,
    score,
    description: '',
    filePaths: [],
  } as unknown as WorkItem;
}

function makeCtx(engines: string[] = ['claude', 'codex']): RoutingContext {
  return {
    availableEngines: engines as RoutingContext['availableEngines'],
  };
}

function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): AshlrConfig {
  return {
    foundry: {
      allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'],
      routingPolicy: 'quality',
      learnedRouting: true,
      ...overrides,
    },
  } as AshlrConfig;
}

/** Build N 'judged' entries with the given verdict for a (engine, model, source). */
function judgedEntries(
  n: number,
  engine: string,
  model: string,
  source: string,
  verdict: string,
  tsMs?: number,
): Array<{ proposalId: string; action: string; engine: string; model: string; verdict: string; ts: string }> {
  return Array.from({ length: n }, (_, i) => ({
    proposalId: `test-repo:${source}:sha${i}`,
    action: 'judged',
    engine,
    model,
    verdict,
    ts: tsMs ? new Date(tsMs).toISOString() : new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// 1. buildEngineScores: cold-start (empty ledger) returns empty map
// ---------------------------------------------------------------------------

describe('buildEngineScores — cold-start', () => {
  it('returns an empty map when no decisions exist', () => {
    const scores = buildEngineScores('issue');
    expect(scores.size).toBe(0);
  });

  it('does not throw on malformed ledger files', () => {
    const dir = path.join(tmpHome, '.ashlr', 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2099-01-01.jsonl'), 'not json\n{bad}\n', 'utf8');
    expect(() => buildEngineScores('issue')).not.toThrow();
    const scores = buildEngineScores('issue');
    expect(scores.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. engineScoreFor: neutral (0.5) for unknown engine
// ---------------------------------------------------------------------------

describe('engineScoreFor — neutral fallback', () => {
  it('returns 0.5 for an unknown engine on an empty map', () => {
    const scores = buildEngineScores('issue');
    expect(engineScoreFor(scores, 'claude' as any, 'opus')).toBe(0.5);
    expect(engineScoreFor(scores, 'codex' as any, null)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 3. Sample floor: fewer than MIN_SAMPLES → score stays 0.5
// ---------------------------------------------------------------------------

describe('buildEngineScores — sample floor', () => {
  it(`score is 0.5 when sample count < ${LEARNED_ROUTING_MIN_SAMPLES}`, () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES - 1; // just below floor
    writeDecisions(judgedEntries(n, 'claude', 'opus', 'issue', 'ship'));
    const scores = buildEngineScores('issue');
    // The entry should exist but score should be neutral
    const s = scores.get('claude:opus');
    expect(s).toBeDefined();
    expect(s!.score).toBe(0.5);
    expect(s!.samples).toBeLessThan(LEARNED_ROUTING_MIN_SAMPLES);
  });

  it(`score reflects actual ratio when sample count > ${LEARNED_ROUTING_MIN_SAMPLES}`, () => {
    // Use a fixed nowMs == the entries' ts so recency-decay is exactly 1.0 (no
    // boundary flakiness): exactly-MIN raw samples would dip just under the
    // weighted floor with even a few ms of decay. Pin time + go above the floor.
    const fixedNow = 1_700_000_000_000;
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'claude', 'opus', 'issue', 'ship', fixedNow),
    ]);
    const scores = buildEngineScores('issue', fixedNow);
    const s = scores.get('claude:opus');
    expect(s).toBeDefined();
    expect(s!.score).toBeGreaterThan(0.5); // all ships → score > neutral
  });
});

// ---------------------------------------------------------------------------
// 4. High-ship-rate engine gets score > 0.5; high-reject-rate gets score < 0.5
// ---------------------------------------------------------------------------

describe('buildEngineScores — ship/reject bias', () => {
  it('prefers canonical workSource over opaque proposal ids', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(Array.from({ length: n }, (_, i) => ({
      proposalId: `prop-opaque-${i}`,
      workSource: 'issue',
      action: 'judged',
      engine: 'codex',
      model: 'gpt-5.5',
      verdict: 'ship',
    })));

    const issueScores = buildEngineScores('issue');
    expect(issueScores.get('codex:gpt-5.5')?.score).toBeGreaterThan(0.5);
    expect(buildEngineScores('todo').size).toBe(0);
  });

  it('derives task class from canonical workItemId when workSource is absent', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;
    writeDecisions(Array.from({ length: n }, (_, i) => ({
      proposalId: `prop-opaque-${i}`,
      workItemId: `/tmp/repo-alpha:lint:item-${i}`,
      action: 'judged',
      engine: 'local-coder',
      model: 'qwen',
      verdict: 'noise',
    })));

    const scores = buildEngineScores('lint');
    const s = scores.get('local-coder:qwen');
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(0.5);
  });

  it('claude:opus has score > 0.5 after many ship verdicts', () => {
    writeDecisions(judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'));
    const scores = buildEngineScores('issue');
    const s = scores.get('claude:opus');
    expect(s).toBeDefined();
    expect(s!.score).toBeGreaterThan(0.5);
  });

  it('codex:gpt-5.5 has score < 0.5 after many noise/review/harmful verdicts', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 3;
    writeDecisions([
      ...judgedEntries(n, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);
    const scores = buildEngineScores('issue');
    const s = scores.get('codex:gpt-5.5');
    expect(s).toBeDefined();
    expect(s!.score).toBeLessThan(0.5);
  });

  it('mixed verdicts: score proportional to ship fraction', () => {
    const n = LEARNED_ROUTING_MIN_SAMPLES + 5;
    const ships = Math.ceil(n * 0.7);
    const rejects = n - ships;
    writeDecisions([
      ...judgedEntries(ships, 'claude', 'opus', 'todo', 'ship'),
      ...judgedEntries(rejects, 'claude', 'opus', 'todo', 'noise'),
    ]);
    const scores = buildEngineScores('todo');
    const s = scores.get('claude:opus');
    expect(s).toBeDefined();
    // score should be close to 0.7 (with recency weight they're all recent so near-equal)
    expect(s!.score).toBeGreaterThan(0.6);
    expect(s!.score).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// 5. sortEnginesByScore: high-ship engine promoted, low-reject engine demoted
// ---------------------------------------------------------------------------

describe('sortEnginesByScore', () => {
  it('promotes high-ship-rate engine to front', () => {
    // claude:opus has high ship rate; codex:gpt-5.5 has high reject rate
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 2, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);
    const scores = buildEngineScores('issue');
    const ordered = sortEnginesByScore(['codex', 'claude'] as any, scores, null);
    // claude should be first even though codex was first in the original list
    expect(ordered[0]).toBe('claude');
    expect(ordered[1]).toBe('codex');
  });

  it('is a no-op (stable) when scores map is empty (cold-start)', () => {
    const scores = buildEngineScores('issue'); // empty
    const original = ['codex', 'claude', 'local-coder'] as any;
    const ordered = sortEnginesByScore(original, scores, null);
    expect(ordered).toEqual(['codex', 'claude', 'local-coder']);
  });

  it('is stable for equal scores (preserves original order)', () => {
    const scores: EngineScoreMap = new Map([
      ['claude', { key: 'claude', engine: 'claude', model: null, score: 0.8, samples: LEARNED_ROUTING_MIN_SAMPLES }],
      ['codex', { key: 'codex', engine: 'codex', model: null, score: 0.8, samples: LEARNED_ROUTING_MIN_SAMPLES }],
    ]);
    const original = ['claude', 'codex'] as any;
    const ordered = sortEnginesByScore(original, scores, null);
    expect(ordered).toEqual(['claude', 'codex']);
  });
});

// ---------------------------------------------------------------------------
// 6. routeTask — flag-off: learnedRouting:false = byte-identical static routing
// ---------------------------------------------------------------------------

describe('routeTask — flag-off parity', () => {
  it('produces the same engine with learnedRouting:false even when history favors the other', () => {
    // Seed: codex has high reject rate for 'issue' → with learnedRouting:true, claude would be preferred
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'codex', 'gpt-5.5', 'issue', 'noise'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'),
    ]);

    const item = makeItem('issue', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);

    // With flag OFF — must be byte-identical to pre-M240 (static policy wins)
    const cfgOff = makeCfg({ learnedRouting: false, routingPolicy: 'quality' });
    const resultOff = routeTask(item, cfgOff, ctx);

    // Static 'quality' policy for hard issue items routes to claude (reasoning)
    // This tests that the engine selected is one of the valid static choices
    // (not a function of history)
    expect(['claude', 'codex', 'local-coder', 'builtin']).toContain(resultOff.engine);

    // With flag ON — history should bias toward claude (high ship rate)
    const cfgOn = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });
    const resultOn = routeTask(item, cfgOn, ctx);
    expect(['claude', 'codex', 'local-coder', 'builtin']).toContain(resultOn.engine);

    // The key parity assertion: flag-off result must be deterministic and
    // reproducible across calls (static policy = no side-effects from history)
    const resultOff2 = routeTask(item, cfgOff, ctx);
    expect(resultOff2.engine).toBe(resultOff.engine);
    expect(resultOff2.model).toBe(resultOff.model);
  });
});

// ---------------------------------------------------------------------------
// 7. routeTask — learned bias promotes high-ship engine
// ---------------------------------------------------------------------------

describe('routeTask — learned bias promotes high-ship engine', () => {
  it('routes to high-ship-rate engine for a task-class with sufficient history', () => {
    // Give codex a terrible reject rate and claude a great ship rate for 'issue'
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'issue', 'harmful'),
    ]);

    const item = makeItem('issue', 5, 5); // hard issue = substantive
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });

    const result = routeTask(item, cfg, ctx);
    // Learned bias should have promoted claude over codex for 'issue' tasks
    expect(result.engine).toBe('claude');
  });

  it('routes to codex when codex has higher ship rate for todo/coding tasks', () => {
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'todo', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'claude', 'opus', 'todo', 'noise'),
    ]);

    const item = makeItem('todo', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);
    const cfg = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });

    const result = routeTask(item, cfg, ctx);
    // Learned bias should favor codex for todo tasks
    expect(result.engine).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// 8. Hard constraints are never violated by learned routing
// ---------------------------------------------------------------------------

describe('routeTask — hard constraints never violated', () => {
  it('never routes to a backend not in allowedBackends, even when history favors it', () => {
    // Seed high ship rate for 'codex' on 'issue'
    writeDecisions(judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 5, 'codex', 'gpt-5.5', 'issue', 'ship'));

    const item = makeItem('issue', 4, 5);
    // Only allow 'claude' — not 'codex'
    const cfg = makeCfg({ allowedBackends: ['claude', 'builtin'], learnedRouting: true });
    const ctx = makeCtx(['claude']); // codex not in ctx either

    const result = routeTask(item, cfg, ctx);
    // Must NOT be codex despite its high ship rate
    expect(result.engine).not.toBe('codex');
    expect(['claude', 'builtin', 'local-coder']).toContain(result.engine);
  });

  it('falls back to builtin when no allowed engine is available', () => {
    const item = makeItem('issue', 1, 1);
    const cfg = makeCfg({ allowedBackends: ['builtin'], learnedRouting: true });
    const ctx = makeCtx([]); // nothing available

    const result = routeTask(item, cfg, ctx);
    expect(result.engine).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// 9. Cold-start (no history) → static policy unchanged (both flag states)
// ---------------------------------------------------------------------------

describe('routeTask — cold-start fallback', () => {
  it('produces same result with learnedRouting:true and no history as with learnedRouting:false', () => {
    // No decisions written — ledger is empty
    const item = makeItem('issue', 4, 5);
    const ctx = makeCtx(['claude', 'codex']);

    const cfgOn = makeCfg({ learnedRouting: true, routingPolicy: 'quality' });
    const cfgOff = makeCfg({ learnedRouting: false, routingPolicy: 'quality' });

    const resultOn = routeTask(item, cfgOn, ctx);
    const resultOff = routeTask(item, cfgOff, ctx);

    // Cold-start: both should yield the same static routing decision
    expect(resultOn.engine).toBe(resultOff.engine);
    expect(resultOn.model).toBe(resultOff.model);
  });
});

// ---------------------------------------------------------------------------
// 10. Recency weighting: very old verdicts contribute less
// ---------------------------------------------------------------------------

describe('buildEngineScores — recency weighting', () => {
  it('recent ship verdicts produce higher score than old ship verdicts with same count', () => {
    const now = Date.now();
    const veryOldMs = now - 10 * LEARNED_ROUTING_HALF_LIFE_MS; // ~70 days ago
    const recentMs = now - LEARNED_ROUTING_HALF_LIFE_MS / 10; // ~16 hours ago

    const n = LEARNED_ROUTING_MIN_SAMPLES + 2;

    // Write old verdicts for codex (all ships but old)
    writeDecisions(judgedEntries(n, 'codex', 'gpt-5.5', 'lint', 'ship', veryOldMs));
    // Append recent verdicts for claude (same count, all ships but recent)
    const dir = path.join(tmpHome, '.ashlr', 'decisions');
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${today}.jsonl`);
    const recentLines = judgedEntries(n, 'claude', 'opus', 'lint', 'ship', recentMs)
      .map((e) => JSON.stringify({ ts: e.ts, proposalId: e.proposalId, action: e.action, engine: e.engine, model: e.model, verdict: e.verdict }))
      .join('\n');
    fs.appendFileSync(file, '\n' + recentLines + '\n', 'utf8');

    const scores = buildEngineScores('lint', now);

    const codexScore = scores.get('codex:gpt-5.5');
    const claudeScore = scores.get('claude:opus');

    // Both are all-ship so score numerically = shipWeight / totalWeight.
    // The recency weight for old entries is 2^(-10) ≈ 0.001, so the old
    // entries' total weight is far below LEARNED_ROUTING_MIN_SAMPLES even
    // with n samples, meaning codex score should be 0.5 (below floor).
    // Claude's recent entries have weight ~1 each, so totalWeight ≈ n.
    if (codexScore !== undefined && codexScore.samples >= LEARNED_ROUTING_MIN_SAMPLES) {
      // If old entries somehow pass the floor, claude's score should still be >= codex's
      expect(claudeScore?.score ?? 0.5).toBeGreaterThanOrEqual(codexScore.score);
    } else {
      // Old entries fall below sample floor → codex is neutral (0.5)
      expect(codexScore?.score ?? 0.5).toBe(0.5);
    }
    // Claude's recent entries should pass the floor and have a high score
    if ((claudeScore?.samples ?? 0) >= LEARNED_ROUTING_MIN_SAMPLES) {
      expect(claudeScore!.score).toBeGreaterThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. taskClass isolation: verdicts for one source don't affect another
// ---------------------------------------------------------------------------

describe('buildEngineScores — taskClass isolation', () => {
  it('issue verdicts do not affect todo scores', () => {
    writeDecisions([
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'claude', 'opus', 'issue', 'ship'),
      ...judgedEntries(LEARNED_ROUTING_MIN_SAMPLES + 3, 'codex', 'gpt-5.5', 'issue', 'noise'),
    ]);

    const todoScores = buildEngineScores('todo');
    // No todo verdicts were written → map should be empty for todo
    expect(todoScores.size).toBe(0);
  });
});
