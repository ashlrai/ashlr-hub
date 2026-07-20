import { describe, expect, it } from 'vitest';
import { resolveSelectionCanary } from '../src/core/fabric/selection-canary.js';

const ready = { gateway: true, concurrentDispatch: true };

describe('selection canary config resolver', () => {
  it('is inert by default and rejects malformed or broadened config', () => {
    expect(resolveSelectionCanary(undefined, ready)).toMatchObject({
      requested: false, eligible: false, disabledReason: 'not-requested',
    });
    for (const raw of [null, [], { enabled: 'true' }, { enabled: true, probability: 1 }]) {
      expect(resolveSelectionCanary(raw, ready)).toMatchObject({ eligible: false, disabledReason: 'invalid-config' });
    }
  });

  it('accepts only the fixed binary-uniform protocol and enabled prerequisites', () => {
    expect(resolveSelectionCanary({ enabled: true, protocol: 'other-v1' }, ready)).toMatchObject({
      requested: true, eligible: false, disabledReason: 'unsupported-protocol',
    });
    expect(resolveSelectionCanary({ enabled: true }, { gateway: false, concurrentDispatch: true })).toMatchObject({
      eligible: false, disabledReason: 'gateway-disabled',
    });
    expect(resolveSelectionCanary({ enabled: true }, { gateway: true, concurrentDispatch: false })).toMatchObject({
      eligible: false, disabledReason: 'concurrent-dispatch-disabled',
    });
    expect(resolveSelectionCanary({ enabled: true }, ready)).toEqual({
      requested: true,
      protocol: 'binary-uniform-v1',
      eligible: true,
      disabledReason: null,
    });
  });
});
