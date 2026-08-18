/**
 * M504 - auto-merge scope ceiling raise.
 *
 * Mason's live config sets cfg.foundry.autoMerge.maxAutomergeFiles=40 and
 * maxAutomergeLines=3000 — previously OUTSIDE the hard, non-overridable
 * ceilings (10/300), so a real feature-sized diff failed closed instead of
 * being reachable. The ceilings were raised to 40/3000 so the operator's
 * configured values actually take effect, while values beyond the new
 * ceiling still fail closed exactly as before.
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
  it('raised the hard ceilings to accommodate a 40 files / 3000 lines operator config', () => {
    expect(MAX_AUTOMERGE_POLICY_FILES).toBe(40);
    expect(MAX_AUTOMERGE_POLICY_LINES).toBe(3000);
  });

  it('left the conservative defaults unchanged', () => {
    expect(DEFAULT_AUTOMERGE_MAX_FILES).toBe(4);
    expect(DEFAULT_AUTOMERGE_MAX_LINES).toBe(150);
  });

  it('accepts Mason\'s live config value (40 files / 3000 lines) as explicit and valid', () => {
    const resolution = resolveAutoMergeScopePolicy({
      maxAutomergeFiles: 40,
      maxAutomergeLines: 3000,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected ok resolution');
    expect(resolution.policy).toMatchObject({
      maxFiles: 40,
      maxLines: 3000,
      policyMaxFiles: 40,
      policyMaxLines: 3000,
      source: 'explicit',
      explicitFiles: true,
      explicitLines: true,
    });
  });

  it('still fails closed one unit beyond the new ceiling', () => {
    const overFiles = resolveAutoMergeScopePolicy({ maxAutomergeFiles: 41, maxAutomergeLines: 3000 });
    expect(overFiles.ok).toBe(false);
    if (overFiles.ok) throw new Error('expected refused resolution');
    expect(overFiles.reasons).toContain('max-files-exceeds-policy');

    const overLines = resolveAutoMergeScopePolicy({ maxAutomergeFiles: 40, maxAutomergeLines: 3001 });
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
