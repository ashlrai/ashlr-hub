/**
 * parseMilestoneResult tests (see docs/MILESTONE-CONTRACT.md).
 *
 * The parser is tolerant and NEVER throws: it accepts a bare JSON object, the
 * `claude --output-format json` envelope ({ result: "<text>" }), and an object
 * embedded in prose; anything malformed / mismatched becomes a safe `blocked`.
 */

import { describe, it, expect } from 'vitest';
import { parseMilestoneResult } from '../src/core/goal-loop/result.js';

const good = {
  milestone: 'M0',
  status: 'done',
  gate_passed: true,
  steps_completed: ['M0.1', 'M0.2'],
  blocked_on: null,
  summary: 'all done',
};

describe('parseMilestoneResult', () => {
  it('parses a bare JSON object', () => {
    const r = parseMilestoneResult(JSON.stringify(good), 'M0');
    expect(r.status).toBe('done');
    expect(r.gate_passed).toBe(true);
    expect(r.steps_completed).toEqual(['M0.1', 'M0.2']);
  });

  it('unwraps the claude --output-format json envelope (result as text)', () => {
    const envelope = JSON.stringify({ result: JSON.stringify(good), cost_usd: 0.01 });
    const r = parseMilestoneResult(envelope, 'M0');
    expect(r.status).toBe('done');
    expect(r.milestone).toBe('M0');
  });

  it('extracts an object embedded in prose / code fences', () => {
    const raw = 'Here is my result:\n```json\n' + JSON.stringify(good) + '\n```\nDone.';
    const r = parseMilestoneResult(raw, 'M0');
    expect(r.status).toBe('done');
  });

  it('blocks on a milestone mismatch (never trusts a wrong-milestone report)', () => {
    const r = parseMilestoneResult(JSON.stringify({ ...good, milestone: 'M9' }), 'M0');
    expect(r.status).toBe('blocked');
    expect(r.milestone).toBe('M0');
    expect(r.blocked_on).toContain('does not match');
  });

  it('blocks on missing/invalid status', () => {
    const r = parseMilestoneResult(JSON.stringify({ milestone: 'M0', summary: 'x' }), 'M0');
    expect(r.status).toBe('blocked');
  });

  it('blocks (never throws) on non-JSON garbage', () => {
    const r = parseMilestoneResult('total nonsense, no braces here', 'M0');
    expect(r.status).toBe('blocked');
    expect(r.blocked_on).toContain('no JSON object');
  });

  it('blocks on empty output', () => {
    expect(parseMilestoneResult('', 'M0').status).toBe('blocked');
  });

  it('coerces a missing milestone field to the expected id', () => {
    const r = parseMilestoneResult(JSON.stringify({ status: 'in_progress' }), 'M2');
    expect(r.milestone).toBe('M2');
    expect(r.status).toBe('in_progress');
    expect(r.gate_passed).toBe(false);
    expect(r.steps_completed).toEqual([]);
  });
});
