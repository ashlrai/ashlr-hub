/** Fake sessions only; importing the harness does not build or launch anything. */
import { describe, expect, it, vi } from 'vitest';
import { createPreparationHarnessCustody, type PreparationCandidateSession } from './helpers/preparation-candidate-harness.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function session(close: () => Promise<void> = async () => undefined): PreparationCandidateSession {
  return { close,
    call: vi.fn(async () => ({ value: { unchanged: true }, measurement: { processes: 0, blobProcesses: 0 } })),
    measurementLedger: vi.fn(() => ({ processes: 0, blobProcesses: 0, requests: [] })),
  };
}
const unsettled = 'PREPARATION_HARNESS_CUSTODY_UNSETTLED';

describe('preparation harness session custody', () => {
  it('starts settled without opening or closing a session', () => {
    const custody = createPreparationHarnessCustody();
    expect(() => custody.assertSettled()).not.toThrow();
    expect(() => custody.assertSettled()).not.toThrow();
  });

  it('retains custody before an asynchronous open resolves and until confirmed close', async () => {
    const custody = createPreparationHarnessCustody(); const opening = deferred<PreparationCandidateSession>();
    const tracked = custody.track(() => opening.promise);
    expect(() => custody.assertSettled()).toThrow(unsettled);
    opening.resolve(session()); const child = await tracked;
    expect(() => custody.assertSettled()).toThrow(unsettled);
    await child.close(); expect(() => custody.assertSettled()).not.toThrow();
  });

  it('increments custody before invoking the opener', async () => {
    const custody = createPreparationHarnessCustody();
    const child = await custody.track(async () => {
      expect(() => custody.assertSettled()).toThrow(unsettled); return session();
    });
    await child.close(); custody.assertSettled();
  });

  it.each(['synchronous', 'asynchronous'] as const)('retains %s open failure permanently', async kind => {
    const custody = createPreparationHarnessCustody(); const cause = new Error('open uncertain');
    const open = kind === 'synchronous' ? () => { throw cause; } : async () => { throw cause; };
    await expect(custody.track(open)).rejects.toBe(cause);
    expect(() => custody.assertSettled()).toThrow(unsettled);
    const later = await custody.track(async () => session()); await later.close();
    expect(() => custody.assertSettled()).toThrow(unsettled);
  });

  it('preserves non-close methods and only releases after successful close', async () => {
    const custody = createPreparationHarnessCustody(); const original = session();
    const child = await custody.track(async () => original);
    expect(child.call).toBe(original.call); expect(child.measurementLedger).toBe(original.measurementLedger);
    await child.call('metadata', null); child.measurementLedger();
    expect(() => custody.assertSettled()).toThrow(unsettled);
    await child.close(); custody.assertSettled();
  });

  it('retains custody throughout a pending close and shares its exact promise', async () => {
    const custody = createPreparationHarnessCustody(); const closing = deferred<void>();
    const close = vi.fn(() => closing.promise); const child = await custody.track(async () => session(close));
    const first = child.close(); const second = child.close(); expect(second).toBe(first);
    await Promise.resolve(); expect(close).toHaveBeenCalledTimes(1);
    expect(() => custody.assertSettled()).toThrow(unsettled);
    closing.resolve(undefined); await first;
    expect(child.close()).toBe(first); await child.close(); expect(close).toHaveBeenCalledTimes(1);
    custody.assertSettled();
  });

  it.each(['synchronous', 'asynchronous'] as const)('retains %s close failure and never retries it', async kind => {
    const custody = createPreparationHarnessCustody(); const cause = new Error('close unconfirmed');
    const close = vi.fn(kind === 'synchronous' ? () => { throw cause; } : async () => { throw cause; });
    const child = await custody.track(async () => session(close)); const first = child.close();
    await expect(first).rejects.toBe(cause); expect(() => custody.assertSettled()).toThrow(unsettled);
    expect(child.close()).toBe(first); await expect(child.close()).rejects.toBe(cause);
    expect(close).toHaveBeenCalledTimes(1); expect(() => custody.assertSettled()).toThrow(unsettled);
  });

  it('requires every session to settle and repeated close cannot decrement another session', async () => {
    const custody = createPreparationHarnessCustody();
    const first = await custody.track(async () => session()); const second = await custody.track(async () => session());
    await first.close(); await first.close(); expect(() => custody.assertSettled()).toThrow(unsettled);
    await second.close(); custody.assertSettled();
  });

  it('keeps a failed session unresolved even after all other sessions confirm closure', async () => {
    const custody = createPreparationHarnessCustody();
    const failed = await custody.track(async () => session(async () => { throw new Error('uncertain'); }));
    const clean = await custody.track(async () => session());
    await expect(failed.close()).rejects.toThrow('uncertain'); await clean.close();
    expect(() => custody.assertSettled()).toThrow(unsettled);
  });
});
