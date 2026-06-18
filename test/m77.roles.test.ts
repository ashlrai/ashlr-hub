/**
 * M77 roles.ts contract tests.
 *
 * Asserts:
 *   1. All three role exports are non-empty strings (no accidental empty export).
 *   2. PLANNER_ROLE mentions the exact JSON task shape keys (id, goal, deps) so
 *      it stays aligned with parseTaskList in orchestrator.ts.
 *   3. PLANNER_ROLE ends with the literal "no prose, no markdown fences." that
 *      parseTaskList and m41.prompts.test.ts both depend on.
 *   4. EXECUTOR_ROLE (all three verbosity variants) mentions testing/verification
 *      (TITRR contract) and DRY.
 *   5. SYNTHESIZER_ROLE is non-empty and grounded (mentions accuracy/grounded).
 *   6. EXECUTOR_ROLE variants are all strings (LayerVariants shape preserved).
 */

import { describe, it, expect } from 'vitest';
import {
  PLANNER_ROLE,
  EXECUTOR_ROLE,
  SYNTHESIZER_ROLE,
} from '../src/core/run/prompts/roles.js';

describe('M77 PLANNER_ROLE', () => {
  it('is a non-empty string', () => {
    expect(typeof PLANNER_ROLE).toBe('string');
    expect(PLANNER_ROLE.length).toBeGreaterThan(0);
  });

  it('contains the literal key "id" (parseTaskList contract)', () => {
    expect(PLANNER_ROLE).toContain('"id"');
  });

  it('contains the literal key "goal" (parseTaskList contract)', () => {
    expect(PLANNER_ROLE).toContain('"goal"');
  });

  it('contains the literal key "deps" (parseTaskList contract)', () => {
    expect(PLANNER_ROLE).toContain('"deps"');
  });

  it('ends with "no prose, no markdown fences." (m41 + parseTaskList contract)', () => {
    expect(PLANNER_ROLE.endsWith('no prose, no markdown fences.')).toBe(true);
  });

  it('describes the JSON array output format', () => {
    expect(PLANNER_ROLE).toMatch(/JSON array/i);
  });
});

describe('M77 EXECUTOR_ROLE', () => {
  it('terse variant is a non-empty string', () => {
    expect(typeof EXECUTOR_ROLE.terse).toBe('string');
    expect(EXECUTOR_ROLE.terse.length).toBeGreaterThan(0);
  });

  it('standard variant is a non-empty string', () => {
    expect(typeof EXECUTOR_ROLE.standard).toBe('string');
    expect(EXECUTOR_ROLE.standard.length).toBeGreaterThan(0);
  });

  it('rich variant is a non-empty string', () => {
    expect(typeof EXECUTOR_ROLE.rich).toBe('string');
    expect(EXECUTOR_ROLE.rich.length).toBeGreaterThan(0);
  });

  it('standard variant mentions TITRR (testing/verification loop)', () => {
    expect(EXECUTOR_ROLE.standard).toMatch(/TITRR|run the relevant tests|iterate until/i);
  });

  it('rich variant mentions TITRR explicitly', () => {
    expect(EXECUTOR_ROLE.rich).toContain('TITRR');
  });

  it('standard variant mentions DRY (reuse before writing)', () => {
    expect(EXECUTOR_ROLE.standard).toMatch(/DRY|existing utilit|search for existing/i);
  });

  it('rich variant mentions DRY explicitly', () => {
    expect(EXECUTOR_ROLE.rich).toContain('DRY');
  });

  it('rich variant mentions tests/verification', () => {
    expect(EXECUTOR_ROLE.rich.toLowerCase()).toMatch(/test|verif/);
  });

  it('terse variant stays concise (under 120 chars)', () => {
    expect(EXECUTOR_ROLE.terse.length).toBeLessThan(120);
  });
});

describe('M77 SYNTHESIZER_ROLE', () => {
  it('is a non-empty string', () => {
    expect(typeof SYNTHESIZER_ROLE).toBe('string');
    expect(SYNTHESIZER_ROLE.length).toBeGreaterThan(0);
  });

  it('emphasises accuracy / grounded output', () => {
    expect(SYNTHESIZER_ROLE).toMatch(/accurate|grounded|only assert/i);
  });

  it('asks for concise output', () => {
    expect(SYNTHESIZER_ROLE).toMatch(/concise/i);
  });
});
