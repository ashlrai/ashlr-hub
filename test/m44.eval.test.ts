/**
 * M44 — local-agent eval harness tests.
 *
 * Hermetic: never hits a real model. We assert the fixture set is well-formed
 * and unit-test the pure formatter/aggregator helpers. cmdEval is NOT run
 * end-to-end (no local model in CI).
 */

import { describe, it, expect } from 'vitest';
import { EVAL_FIXTURES } from '../src/cli/eval-fixtures.js';
import {
  summarize,
  formatEvalTable,
  type EvalRow,
} from '../src/cli/eval.js';

describe('EVAL_FIXTURES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(EVAL_FIXTURES)).toBe(true);
    expect(EVAL_FIXTURES.length).toBeGreaterThan(0);
  });

  it('every fixture has a non-empty id and goal', () => {
    for (const f of EVAL_FIXTURES) {
      expect(typeof f.id).toBe('string');
      expect(f.id.trim().length).toBeGreaterThan(0);
      expect(typeof f.goal).toBe('string');
      expect(f.goal.trim().length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = EVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only exposes { id, goal } shape', () => {
    for (const f of EVAL_FIXTURES) {
      expect(Object.keys(f).sort()).toEqual(['goal', 'id']);
    }
  });
});

function row(over: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'fixture',
    goal: 'do a thing',
    stepsOff: 0,
    stepsOn: 0,
    doneOff: false,
    doneOn: false,
    tokensOff: 0,
    tokensOn: 0,
    ...over,
  };
}

describe('summarize', () => {
  it('aggregates steps, done counts, and tokens across rows', () => {
    const rows: EvalRow[] = [
      row({ id: 'a', stepsOff: 3, stepsOn: 2, doneOff: true, doneOn: true, tokensOff: 100, tokensOn: 80 }),
      row({ id: 'b', stepsOff: 5, stepsOn: 4, doneOff: false, doneOn: true, tokensOff: 200, tokensOn: 150 }),
    ];
    const s = summarize(rows);
    expect(s.fixtures).toBe(2);
    expect(s.totalStepsOff).toBe(8);
    expect(s.totalStepsOn).toBe(6);
    expect(s.doneOff).toBe(1);
    expect(s.doneOn).toBe(2);
    expect(s.totalTokensOff).toBe(300);
    expect(s.totalTokensOn).toBe(230);
    expect(s.errors).toBe(0);
  });

  it('counts errored rows', () => {
    const rows: EvalRow[] = [row({ id: 'a', error: 'boom' }), row({ id: 'b' })];
    const s = summarize(rows);
    expect(s.errors).toBe(1);
    expect(s.fixtures).toBe(2);
  });

  it('handles an empty row set', () => {
    const s = summarize([]);
    expect(s).toEqual({
      fixtures: 0,
      totalStepsOff: 0,
      totalStepsOn: 0,
      doneOff: 0,
      doneOn: 0,
      totalTokensOff: 0,
      totalTokensOn: 0,
      errors: 0,
    });
  });
});

describe('formatEvalTable', () => {
  it('renders rows and a TOTAL summary line', () => {
    const rows: EvalRow[] = [
      row({ id: 'palindrome', stepsOff: 4, stepsOn: 2, doneOff: true, doneOn: true, tokensOff: 500, tokensOn: 300 }),
    ];
    const out = formatEvalTable(rows);
    expect(out).toContain('palindrome');
    expect(out).toContain('done');
    expect(out).toContain('TOTAL');
    expect(out).toContain('fixtures=1');
    expect(out).toContain('steps OFF=4 ON=2');
    expect(out).toContain('tokens OFF=500 ON=300');
  });

  it('marks not-done rows as fail', () => {
    const rows: EvalRow[] = [row({ id: 'x', doneOff: false, doneOn: true })];
    const out = formatEvalTable(rows);
    expect(out).toContain('fail');
    expect(out).toContain('done');
  });

  it('renders an ERROR line for failed fixtures and reports the error count', () => {
    const rows: EvalRow[] = [row({ id: 'bad', error: 'provider exploded' })];
    const out = formatEvalTable(rows);
    expect(out).toContain('ERROR: provider exploded');
    expect(out).toContain('errors=1');
  });
});
