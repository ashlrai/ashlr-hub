/**
 * M504 - auto-merge scope ceiling remains strictly bounded.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOMERGE_MAX_FILES,
  DEFAULT_AUTOMERGE_MAX_LINES,
  MAX_AUTOMERGE_POLICY_FILES,
  MAX_AUTOMERGE_POLICY_LINES,
  resolveAutoMergeScopePolicy,
} from '../src/core/foundry/automerge-scope-policy.js';

describe('M504 auto-merge scope ceiling', () => {
  it('keeps the hard ceilings at 10 files / 300 lines', () => {
    expect(MAX_AUTOMERGE_POLICY_FILES).toBe(10);
    expect(MAX_AUTOMERGE_POLICY_LINES).toBe(300);
  });

  it('left the conservative defaults unchanged', () => {
    expect(DEFAULT_AUTOMERGE_MAX_FILES).toBe(4);
    expect(DEFAULT_AUTOMERGE_MAX_LINES).toBe(150);
  });

  it('accepts the strict ceiling as explicit and valid', () => {
    const resolution = resolveAutoMergeScopePolicy({
      maxAutomergeFiles: 10,
      maxAutomergeLines: 300,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected ok resolution');
    expect(resolution.policy).toMatchObject({
      maxFiles: 10,
      maxLines: 300,
      policyMaxFiles: 10,
      policyMaxLines: 300,
      source: 'explicit',
      explicitFiles: true,
      explicitLines: true,
    });
  });

  it('fails closed one unit beyond the strict ceiling', () => {
    const overFiles = resolveAutoMergeScopePolicy({ maxAutomergeFiles: 11, maxAutomergeLines: 300 });
    expect(overFiles.ok).toBe(false);
    if (overFiles.ok) throw new Error('expected refused resolution');
    expect(overFiles.reasons).toContain('max-files-exceeds-policy');

    const overLines = resolveAutoMergeScopePolicy({ maxAutomergeFiles: 10, maxAutomergeLines: 301 });
    expect(overLines.ok).toBe(false);
    if (overLines.ok) throw new Error('expected refused resolution');
    expect(overLines.reasons).toContain('max-lines-exceeds-policy');
  });

  it('still fails closed on non-positive or non-integer values', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolution = resolveAutoMergeScopePolicy({ maxAutomergeFiles: bad, maxAutomergeLines: 100 });
      expect(resolution.ok, `maxAutomergeFiles=${bad} should be invalid`).toBe(false);
    }
  });

  it('uses the conservative defaults when the operator sets nothing', () => {
    const resolution = resolveAutoMergeScopePolicy(undefined);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected ok resolution');
    expect(resolution.policy).toMatchObject({
      maxFiles: DEFAULT_AUTOMERGE_MAX_FILES,
      maxLines: DEFAULT_AUTOMERGE_MAX_LINES,
      source: 'default',
      explicitFiles: false,
      explicitLines: false,
    });
  });
});
