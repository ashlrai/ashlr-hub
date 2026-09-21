/**
 * shared-scoring-formulas.test.ts — behavior pins for the three formulas that
 * used to exist as two independently-maintained copies each:
 *
 *   1. scoreVerdict  (src/core/fleet/verdict-score.ts)
 *      was duplicated in run/best-of-n.ts and fleet/model-racing.ts.
 *   2. cohenKappa    (src/core/fleet/agreement.ts)
 *      was duplicated in fleet/judge-calibration.ts and fleet/counterfactual.ts.
 *   3. scoreItem / sourceTierMultiplier (src/core/portfolio/scoring.ts)
 *      was duplicated in portfolio/backlog.ts and portfolio/scanners.ts.
 *
 * Each pair had drifted. These tests pin the agreed-correct behavior of the
 * single source, cover the boundary cases that made the drift easy to miss
 * (the `6 - scope` inversion; kappa's zero-denominator paths), and assert that
 * every surviving export really is the same function object — so a future
 * re-inlining is a failing test, not a comment nobody reads.
 *
 * Pure unit tests: no process spawn, no port bind, no real filesystem work,
 * so this file deliberately stays out of test/config/realio-lane-membership.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  scoreVerdict,
  MIN_VERDICT_SCORE,
  MAX_VERDICT_SCORE,
} from '../src/core/fleet/verdict-score.js';
import { cohenKappa, MIN_KAPPA_PAIRS } from '../src/core/fleet/agreement.js';
import { scoreItem, sourceTierMultiplier } from '../src/core/portfolio/scoring.js';

/** Read a repo-relative source file, resolved from this test file, not cwd. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string =>
  readFileSync(join(repoRoot, relative), 'utf8');

// ---------------------------------------------------------------------------
// 1. scoreVerdict — the 6 - scope inversion
// ---------------------------------------------------------------------------

describe('scoreVerdict — ManagerVerdict collapsed to one number', () => {
  const v = (value: number, correctness: number, scope: number, alignment: number) =>
    ({ value, correctness, scope, alignment });

  it('sums value + correctness + (6 - scope) + alignment', () => {
    expect(scoreVerdict(v(4, 5, 1, 4))).toBe(4 + 5 + 5 + 4); // 18
    expect(scoreVerdict(v(3, 3, 3, 3))).toBe(3 + 3 + 3 + 3); // 12
    expect(scoreVerdict(v(2, 4, 4, 1))).toBe(2 + 4 + 2 + 1); // 9
  });

  it('hits exactly 20 at the best possible verdict', () => {
    expect(scoreVerdict(v(5, 5, 1, 5))).toBe(20);
    expect(scoreVerdict(v(5, 5, 1, 5))).toBe(MAX_VERDICT_SCORE);
  });

  it('hits exactly 4 at the worst possible verdict', () => {
    expect(scoreVerdict(v(1, 1, 5, 1))).toBe(4);
    expect(scoreVerdict(v(1, 1, 5, 1))).toBe(MIN_VERDICT_SCORE);
  });

  it('inverts scope: lower blast radius scores higher, all else equal', () => {
    const tiny = scoreVerdict(v(4, 4, 1, 4));
    const mid = scoreVerdict(v(4, 4, 3, 4));
    const huge = scoreVerdict(v(4, 4, 5, 4));
    expect(tiny).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(huge);
    // The inversion is exactly one point per scope step — not two, not zero.
    expect(tiny - mid).toBe(2);
    expect(mid - huge).toBe(2);
  });

  it('does NOT reward a more invasive candidate (the backwards-inversion trap)', () => {
    // If the inversion were written `scope - 1` or omitted, the scope=5
    // candidate would win. It must lose.
    const conservative = scoreVerdict(v(3, 3, 1, 3));
    const invasive = scoreVerdict(v(3, 3, 5, 3));
    expect(conservative).toBeGreaterThan(invasive);
  });

  it('scores every real verdict inside 4..20, leaving 0 free as the unjudged sentinel', () => {
    for (let value = 1; value <= 5; value += 1) {
      for (let correctness = 1; correctness <= 5; correctness += 1) {
        for (let scope = 1; scope <= 5; scope += 1) {
          for (let alignment = 1; alignment <= 5; alignment += 1) {
            const score = scoreVerdict(v(value, correctness, scope, alignment));
            expect(score).toBeGreaterThanOrEqual(MIN_VERDICT_SCORE);
            expect(score).toBeLessThanOrEqual(MAX_VERDICT_SCORE);
            expect(score).not.toBe(0);
          }
        }
      }
    }
  });

  it('returns 0 for a null/undefined verdict', () => {
    expect(scoreVerdict(null)).toBe(0);
    expect(scoreVerdict(undefined)).toBe(0);
  });

  it('falls back to the rubric defaults for missing dimensions', () => {
    // value/correctness/alignment default to 1, scope defaults to 3.
    expect(scoreVerdict({})).toBe(1 + 1 + (6 - 3) + 1); // 6
    expect(scoreVerdict({ value: 5 })).toBe(5 + 1 + (6 - 3) + 1); // 10
  });

  it('clamps an out-of-range scope into 1..5 instead of producing a wild score', () => {
    expect(scoreVerdict(v(3, 3, 99, 3))).toBe(scoreVerdict(v(3, 3, 5, 3)));
    expect(scoreVerdict(v(3, 3, -7, 3))).toBe(scoreVerdict(v(3, 3, 1, 3)));
  });

  it('is pure and deterministic', () => {
    const verdict = v(4, 2, 3, 5);
    expect(scoreVerdict(verdict)).toBe(scoreVerdict(verdict));
  });
});

describe('scoreVerdict — both former copies now resolve to the one function', () => {
  it('model-racing no longer defines its own copy', () => {
    const src = readSource('src/core/fleet/model-racing.ts');
    expect(src).toContain("from './verdict-score.js'");
    expect(src).not.toMatch(/function scoreVerdict\s*\(/);
  });

  it('best-of-n no longer defines its own copy', () => {
    const src = readSource('src/core/run/best-of-n.ts');
    expect(src).toContain("from '../fleet/verdict-score.js'");
    expect(src).not.toMatch(/function scoreVerdict\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 2. cohenKappa — including every zero-denominator path
// ---------------------------------------------------------------------------

describe('cohenKappa — agreement beyond chance', () => {
  it('returns 1.0 for perfect agreement across several categories', () => {
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'reject', b: 'reject' },
      { a: 'review', b: 'review' },
      { a: 'merge', b: 'merge' },
    ]);
    expect(k).not.toBeNull();
    expect(k!).toBeCloseTo(1.0, 10);
  });

  it('returns a known value for a hand-computed confusion matrix', () => {
    // 3 agreements (2x merge, 1x reject), 1 disagreement (merge/reject).
    // p_o = 3/4 = 0.75
    // marginals: A merge 3/4, A reject 1/4; B merge 2/4, B reject 2/4
    // p_e = (0.75 * 0.5) + (0.25 * 0.5) = 0.5
    // kappa = (0.75 - 0.5) / (1 - 0.5) = 0.5
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'merge', b: 'merge' },
      { a: 'reject', b: 'reject' },
      { a: 'merge', b: 'reject' },
    ]);
    expect(k).toBeCloseTo(0.5, 10);
  });

  it('returns ~0 at chance-level agreement', () => {
    // A and B each split merge/reject evenly with agreement on half.
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'merge', b: 'reject' },
      { a: 'reject', b: 'merge' },
      { a: 'reject', b: 'reject' },
    ]);
    expect(k).toBeCloseTo(0, 10);
  });

  it('returns negative kappa for systematic disagreement', () => {
    const k = cohenKappa([
      { a: 'merge', b: 'reject' },
      { a: 'reject', b: 'merge' },
      { a: 'merge', b: 'reject' },
      { a: 'reject', b: 'merge' },
    ]);
    expect(k).not.toBeNull();
    expect(k!).toBeLessThan(0);
  });

  it('returns null below MIN_KAPPA_PAIRS observations', () => {
    expect(MIN_KAPPA_PAIRS).toBe(2);
    expect(cohenKappa([])).toBeNull();
    expect(cohenKappa([{ a: 'merge', b: 'merge' }])).toBeNull();
    expect(cohenKappa([{ a: 'merge', b: 'reject' }])).toBeNull();
  });

  it('returns 1.0 — never NaN — when every observation is one category', () => {
    // p_e is exactly 1 here, so the (1 - p_e) denominator is exactly 0.
    // The guard must fire before the division.
    const k = cohenKappa([
      { a: 'merge', b: 'merge' },
      { a: 'merge', b: 'merge' },
      { a: 'merge', b: 'merge' },
    ]);
    expect(k).toBe(1);
    expect(Number.isNaN(k as number)).toBe(false);
  });

  it('never returns NaN or Infinity for any small categorical input', () => {
    const labels = ['merge', 'review', 'reject'];
    for (const a1 of labels) {
      for (const b1 of labels) {
        for (const a2 of labels) {
          for (const b2 of labels) {
            const k = cohenKappa([{ a: a1, b: b1 }, { a: a2, b: b2 }]);
            expect(k).not.toBeNull();
            expect(Number.isFinite(k as number)).toBe(true);
          }
        }
      }
    }
  });

  it('never throws on malformed input', () => {
    expect(() => cohenKappa(undefined)).not.toThrow();
    expect(cohenKappa(undefined)).toBeNull();
    expect(() => cohenKappa(null)).not.toThrow();
    expect(cohenKappa(null)).toBeNull();
    expect(() => cohenKappa({ length: 3 } as never)).not.toThrow();
    expect(cohenKappa({ length: 3 } as never)).toBeNull();
  });

  it('is symmetric in the two raters', () => {
    const pairs = [
      { a: 'merge', b: 'reject' },
      { a: 'merge', b: 'merge' },
      { a: 'reject', b: 'reject' },
      { a: 'review', b: 'merge' },
    ];
    const swapped = pairs.map((p) => ({ a: p.b, b: p.a }));
    expect(cohenKappa(pairs)).toBeCloseTo(cohenKappa(swapped)!, 10);
  });
});

describe('cohenKappa — both former copies now resolve to the one function', () => {
  it('counterfactual.ts re-exports the shared implementation', async () => {
    const shared = await import('../src/core/fleet/agreement.js');
    const counterfactual = await import('../src/core/fleet/counterfactual.js');
    expect(counterfactual.cohenKappa).toBe(shared.cohenKappa);
  });

  it('judge-calibration.ts adapts the shared implementation and agrees with it', async () => {
    const { cohenKappa: calibrationKappa } =
      await import('../src/core/fleet/judge-calibration.js');
    const cases: Array<Array<{ a: string; b: string }>> = [
      [{ a: 'merge', b: 'merge' }, { a: 'reject', b: 'reject' }],
      [{ a: 'merge', b: 'merge' }, { a: 'merge', b: 'reject' }, { a: 'reject', b: 'reject' }],
      [{ a: 'merge', b: 'reject' }, { a: 'reject', b: 'merge' }],
      [{ a: 'merge', b: 'merge' }, { a: 'merge', b: 'merge' }],
    ];
    for (const pairs of cases) {
      const viaCalibration = calibrationKappa(
        pairs.map((p) => ({ raterA: p.a, raterB: p.b })),
      );
      expect(viaCalibration).toBe(cohenKappa(pairs));
    }
  });

  it('judge-calibration.ts agrees with counterfactual.ts on the single-pair boundary', async () => {
    const { cohenKappa: calibrationKappa } =
      await import('../src/core/fleet/judge-calibration.js');
    const { cohenKappa: counterfactualKappa } =
      await import('../src/core/fleet/counterfactual.js');
    // This is exactly where the two copies had drifted: judge-calibration used
    // to return 1.0 here (its guard was `length === 0`) while counterfactual
    // returned null (`n < 2`). Both must now say null.
    expect(calibrationKappa([{ raterA: 'merge', raterB: 'merge' }])).toBeNull();
    expect(counterfactualKappa([{ a: 'merge', b: 'merge' }])).toBeNull();
    expect(calibrationKappa([{ raterA: 'merge', raterB: 'reject' }])).toBeNull();
    expect(counterfactualKappa([{ a: 'merge', b: 'reject' }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. scoreItem / sourceTierMultiplier
// ---------------------------------------------------------------------------

describe('scoreItem — value/effort priority heuristic', () => {
  it('is value divided by effort', () => {
    expect(scoreItem(4, 2)).toBe(2);
    expect(scoreItem(5, 1)).toBe(5);
    expect(scoreItem(3, 3)).toBe(1);
  });

  it('is NOT rounded — full precision survives', () => {
    // The scanners copy rounded to two decimals; the backlog copy did not.
    // Full precision is what the ranking sort sees, so it is what is kept.
    expect(scoreItem(1, 3)).toBe(1 / 3);
    expect(scoreItem(1, 3)).not.toBe(0.33);
    expect(scoreItem(2, 3)).toBe(2 / 3);
  });

  it('rises with value and falls with effort', () => {
    expect(scoreItem(5, 2)).toBeGreaterThan(scoreItem(2, 2));
    expect(scoreItem(3, 1)).toBeGreaterThan(scoreItem(3, 4));
  });

  it('clamps both inputs into 1..5', () => {
    expect(scoreItem(99, 1)).toBe(scoreItem(5, 1));
    expect(scoreItem(0, 1)).toBe(scoreItem(1, 1));
    expect(scoreItem(3, 99)).toBe(scoreItem(3, 5));
    expect(scoreItem(3, 0)).toBe(scoreItem(3, 1));
    expect(scoreItem(3, -4)).toBe(scoreItem(3, 1));
  });

  it('never divides by zero and is always finite and positive', () => {
    for (const value of [-5, 0, 1, 2.5, 5, 50, Number.MAX_SAFE_INTEGER]) {
      for (const effort of [-5, 0, 1, 2.5, 5, 50]) {
        const s = scoreItem(value, effort);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThan(0);
      }
    }
  });

  it('does NOT round its inputs — fractional value/effort pass through', () => {
    // The scanners copy rounded value/effort to integers first
    // (clamp() there was Math.round-based); this one divides as given.
    expect(scoreItem(3.5, 2)).toBe(1.75);
    expect(scoreItem(3.5, 2)).not.toBe(2);
  });

  it('is pure and deterministic', () => {
    for (let v = 1; v <= 5; v += 1) {
      for (let e = 1; e <= 5; e += 1) {
        expect(scoreItem(v, e)).toBe(scoreItem(v, e));
      }
    }
  });
});

describe('sourceTierMultiplier — source weighting', () => {
  it('tiers substantive sources above maintenance chores', () => {
    expect(sourceTierMultiplier('goal')).toBe(1.8);
    expect(sourceTierMultiplier('issue')).toBe(1.8);
    expect(sourceTierMultiplier('security')).toBe(1.4);
    expect(sourceTierMultiplier('test')).toBe(1.4);
    expect(sourceTierMultiplier('self')).toBe(1.0);
    expect(sourceTierMultiplier('plugin')).toBe(1.0);
    expect(sourceTierMultiplier('doc')).toBe(1.0);
    expect(sourceTierMultiplier('dep')).toBe(0.6);
    expect(sourceTierMultiplier('lint')).toBe(0.6);
    expect(sourceTierMultiplier('hygiene')).toBe(0.6);
    expect(sourceTierMultiplier('todo')).toBe(0.6);
  });

  it('defaults unknown sources to 1.0', () => {
    expect(sourceTierMultiplier('unknown-future-source')).toBe(1.0);
    expect(sourceTierMultiplier('')).toBe(1.0);
  });

  it('keeps the documented invariant: a tier-3 value=2 item outranks a tier-0 value=5 item', () => {
    const goal = scoreItem(2, 1) * sourceTierMultiplier('goal');
    const dep = scoreItem(5, 5) * sourceTierMultiplier('dep');
    expect(goal).toBeGreaterThan(dep);
  });
});

describe('portfolio scoring — both former copies now resolve to the one function', () => {
  it('backlog.ts re-exports the shared implementations', async () => {
    const shared = await import('../src/core/portfolio/scoring.js');
    const backlog = await import('../src/core/portfolio/backlog.js');
    expect(backlog.scoreItem).toBe(shared.scoreItem);
    expect(backlog.sourceTierMultiplier).toBe(shared.sourceTierMultiplier);
  });

  it('scanners.ts no longer re-inlines the formula', () => {
    const src = readSource('src/core/portfolio/scanners.ts');
    expect(src).toContain("from './scoring.js'");
    expect(src).not.toContain('must match backlog.ts#scoreItem');
    expect(src).not.toMatch(/function score\s*\(value: number, effort: number\)/);
  });
});
