import { describe, expect, it } from 'vitest';

import { nextOperationalProjectionRecoveryAction } from '../src/core/inbox/operational-projection-recovery-inspection.js';

describe('M437 operational projection phase-bound recovery planning', () => {
  const present = { proposal: { present: true }, projection: { present: true } };

  it('distinguishes writes from deletion and refuses phase rollback shapes', () => {
    expect(nextOperationalProjectionRecoveryAction('prepared', 'no-effect', present))
      .toBe('would-write-proposal');
    expect(nextOperationalProjectionRecoveryAction('prepared', 'no-effect', {
      proposal: { present: false }, projection: { present: true },
    })).toBe('would-delete-proposal');
    expect(nextOperationalProjectionRecoveryAction('prepared', 'proposal-only', present))
      .toBe('would-attest-proposal-installed');
    expect(nextOperationalProjectionRecoveryAction('prepared', 'complete', present)).toBeNull();

    expect(nextOperationalProjectionRecoveryAction('proposal-installed', 'no-effect', present)).toBeNull();
    expect(nextOperationalProjectionRecoveryAction('proposal-installed', 'proposal-only', present))
      .toBe('would-write-projection');
    expect(nextOperationalProjectionRecoveryAction('proposal-installed', 'proposal-only', {
      proposal: { present: true }, projection: { present: false },
    })).toBe('would-delete-projection');
    expect(nextOperationalProjectionRecoveryAction('proposal-installed', 'complete', present))
      .toBe('would-attest-projection-installed');

    expect(nextOperationalProjectionRecoveryAction('projection-installed', 'proposal-only', present)).toBeNull();
    expect(nextOperationalProjectionRecoveryAction('projection-installed', 'complete', present))
      .toBe('would-attest-committed');
    expect(nextOperationalProjectionRecoveryAction('committed', 'complete', present)).toBeNull();
  });
});
