import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceAdmissionPreflight } from '../src/core/universe/resource-admission-preflight.js';

const hooks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../src/core/universe/resource-runtime-check.js', () => ({ checkResourceGenerationRuntime: hooks.check }));
beforeEach(() => hooks.check.mockReset());

describe('invocation-local resource admission preflight', () => {
  it('is lazy and caches a valid result without gating on capacity or warnings', () => {
    hooks.check.mockReturnValue({ status: 'valid', counts: { eligibleWorkers: 0 },
      warnings: ['quota-refresh-not-configured'], workers: [{ eligibility: 'excluded' }] });
    const check = resourceAdmissionPreflight('/private/runtime.json');
    expect(hooks.check).not.toHaveBeenCalled();
    expect(check()).toBeNull(); expect(check()).toBeNull();
    expect(hooks.check).toHaveBeenCalledExactlyOnceWith({ resourceRuntime: '/private/runtime.json' });
  });

  it.each(['runtime', 'boundaries', 'workspace', 'pool', 'bindings', 'observations', 'quota-refresh', 'local-model-refresh', 'ledger'])(
    'reports only the fixed failing %s stage and caches the failure', (code) => {
      hooks.check.mockReturnValue({ status: 'invalid', checks: [{ code, status: 'failed' }], privatePath: '/private/secret' });
      const check = resourceAdmissionPreflight('/private/runtime.json');
      expect(check()).toBe(`resource-runtime-invalid:${code}`); expect(check()).toBe(`resource-runtime-invalid:${code}`);
      expect(hooks.check).toHaveBeenCalledOnce();
    });

  it.each([undefined, { status: 'invalid', checks: [] }, { status: 'invalid', checks: [{ code: '/private/secret', status: 'failed' }] }])(
    'uses a fixed fallback for unexpected reports (%j)', (report) => {
      hooks.check.mockReturnValue(report);
      expect(resourceAdmissionPreflight('/private/runtime.json')()).toBe('resource-runtime-check-failed');
    });

  it('redacts thrown errors and rechecks only in a new invocation', () => {
    hooks.check.mockImplementationOnce(() => { throw new Error('/private/secret'); }).mockReturnValue({ status: 'valid' });
    const first = resourceAdmissionPreflight('/private/runtime.json');
    expect(first()).toBe('resource-runtime-check-failed'); expect(first()).toBe('resource-runtime-check-failed');
    expect(resourceAdmissionPreflight('/private/runtime.json')()).toBeNull();
    expect(hooks.check).toHaveBeenCalledTimes(2);
  });
});
