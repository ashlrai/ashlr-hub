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
  it('bounds explicit volume by the interoperable safe integer range', () => {
    expect(MAX_AUTOMERGE_POLICY_FILES).toBe(Number.MAX_SAFE_INTEGER);
    expect(MAX_AUTOMERGE_POLICY_LINES).toBe(Number.MAX_SAFE_INTEGER);
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
      policyMaxFiles: Number.MAX_SAFE_INTEGER,
      policyMaxLines: Number.MAX_SAFE_INTEGER,
      source: 'explicit',
      explicitFiles: true,
      explicitLines: true,
    });
  });

  it('accepts larger explicit volume and no-cap representation without changing defaults', () => {
    for (const n of [1000, Number.MAX_SAFE_INTEGER]) {
      const result = resolveAutoMergeScopePolicy({ maxAutomergeFiles: n, maxAutomergeLines: n });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.policy).toMatchObject({ maxFiles: n, maxLines: n });
    }
  });

  it('still fails closed on non-positive or non-integer values', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100', null]) {
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
