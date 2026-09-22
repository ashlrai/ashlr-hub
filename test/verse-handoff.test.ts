/**
 * Pins the planner-to-worker handoff rules.
 *
 * Each rule here exists because the opposite behaviour was measured going wrong
 * on this project, so the tests assert the REASON as much as the mechanism.
 */
import { describe, expect, it } from 'vitest';
import {
  validateHandoff,
  renderHandoff,
  appendFinding,
  isAppendOnly,
  estimateHandoffTokens,
  HANDOFF_MAX_CHARS,
  type WorkerHandoff,
} from '../src/core/verse/handoff.js';

const good: WorkerHandoff = {
  id: 'w1',
  task: 'applyDiscount treats pct as a flat amount. Make it a percentage.',
  files: [{ path: 'src/cart.js', lines: { from: 6, to: 8 }, why: 'the function' }],
  constraints: [{ rule: 'Keep the signature', reason: 'two callers outside this repo use it' }],
  check: 'applyDiscount(100, 10) returns 90',
};

describe('validateHandoff', () => {
  it('accepts a complete handoff', () => {
    expect(validateHandoff(good)).toEqual([]);
  });

  it('requires a task, a check and at least one file', () => {
    const fields = validateHandoff({ ...good, task: '  ', check: '', files: [] }).map((p) => p.field);
    expect(fields).toContain('task');
    expect(fields).toContain('check');
    expect(fields).toContain('files');
  });

  it('rejects a path that is actually pasted file contents', () => {
    // Rule 2. A worker has a filesystem; a pasted copy is a snapshot that can
    // already be stale, and costs thousands of tokens instead of ten.
    const pasted = 'export function applyDiscount(total, pct) {\n  return total - pct;\n}';
    const problems = validateHandoff({ ...good, files: [{ path: pasted }] });
    expect(problems.some((p) => p.field === 'files[0].path' && /contents/i.test(p.detail))).toBe(true);
  });

  it('accepts ordinary paths, including awkward but legitimate ones', () => {
    const paths = ['a.js', 'src/deep/nested/file.ts', './rel/path.tsx', 'with space/file.md'];
    for (const path of paths) {
      expect(validateHandoff({ ...good, files: [{ path }] })).toEqual([]);
    }
  });

  it('requires a reason on every constraint', () => {
    // Rule 3. A bare rule invites the worker to decide it looks obsolete.
    const problems = validateHandoff({
      ...good,
      constraints: [{ rule: 'Do not change the signature', reason: '' }],
    });
    expect(problems.some((p) => p.field === 'constraints[0].reason' && /reasoned away/.test(p.detail)))
      .toBe(true);
  });

  it('rejects an oversized handoff as a planning failure, not a compression problem', () => {
    // Rule 4. Forwarding the planner's reading instead of deciding what matters.
    const bloated: WorkerHandoff = {
      ...good,
      files: Array.from({ length: 400 }, (_, i) => ({ path: `src/module-${i}/index.ts`, why: 'maybe relevant' })),
    };
    const problems = validateHandoff(bloated);
    expect(problems.some((p) => p.field === 'handoff' && /plan is not finished/.test(p.detail))).toBe(true);
  });

  it('validates line ranges', () => {
    expect(validateHandoff({ ...good, files: [{ path: 'a.js', lines: { from: 0, to: 4 } }] }).length).toBe(1);
    expect(validateHandoff({ ...good, files: [{ path: 'a.js', lines: { from: 9, to: 4 } }] }).length).toBe(1);
    expect(validateHandoff({ ...good, files: [{ path: 'a.js', lines: { from: 4, to: 4 } }] })).toEqual([]);
  });
});

describe('renderHandoff', () => {
  it('emits the sections a worker needs, with the reason attached to each rule', () => {
    const out = renderHandoff(good);
    expect(out).toContain('## Task');
    expect(out).toContain('src/cart.js:6-8');
    expect(out).toContain('Why: two callers outside this repo use it');
    expect(out).toContain('## Done when');
  });

  it('puts findings last, so everything above stays byte-identical', () => {
    // Rule 1, the expensive one. Content added anywhere but the end changes the
    // prompt prefix and invalidates the whole cache.
    const withFinding = appendFinding(good, 'the helper is also called from checkout()');
    const rendered = renderHandoff(withFinding);
    expect(rendered.indexOf('## Found along the way')).toBeGreaterThan(rendered.indexOf('## Done when'));
  });

  it('omits empty sections rather than emitting bare headings', () => {
    const bare = renderHandoff({ ...good, constraints: [], findings: [] });
    expect(bare).not.toContain('## Constraints');
    expect(bare).not.toContain('## Found along the way');
  });
});

describe('appendFinding and isAppendOnly', () => {
  it('grows the rendered prompt by appending only', () => {
    const a = appendFinding(good, 'first');
    const b = appendFinding(a, 'second');
    expect(isAppendOnly(good, a)).toBe(true);
    expect(isAppendOnly(a, b)).toBe(true);
    expect(renderHandoff(b).startsWith(renderHandoff(good))).toBe(true);
  });

  it('catches a mutation that is NOT append-only', () => {
    // Editing the task rewrites the very top of the prompt. This is the shape
    // of change that cost 23,301 reprocessed tokens per turn.
    const edited = { ...good, task: 'Something else entirely' };
    expect(isAppendOnly(good, edited)).toBe(false);
  });

  it('ignores a blank finding instead of appending an empty bullet', () => {
    expect(appendFinding(good, '   ')).toBe(good);
  });
});

describe('estimateHandoffTokens', () => {
  it('stays a rounding error against a 65,536-token worker slot', () => {
    const tokens = estimateHandoffTokens(good);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(HANDOFF_MAX_CHARS / 4);
    expect(tokens / 65_536).toBeLessThan(0.02);
  });
});
