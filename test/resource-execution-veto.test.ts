import { describe, expect, it, vi } from 'vitest';
import { captureResourceExecutionVeto } from '../src/core/resources/execution-veto.js';

describe('host-only execution veto', () => {
  it('preserves the unconfigured path and requires synchronous false', () => {
    expect(captureResourceExecutionVeto({})()).toBe(false);
    expect(captureResourceExecutionVeto({ isExecutionStopped: () => false })()).toBe(false);
  });
  it.each([true, undefined, null, 0, '', {}, []])('withholds non-permitting result %j', result => {
    expect(captureResourceExecutionVeto({ isExecutionStopped: () => result })()).toBe(true);
  });
  it('captures the function but samples its current decision', () => {
    let stop = false; const host = { isExecutionStopped: () => stop };
    const veto = captureResourceExecutionVeto(host); host.isExecutionStopped = () => false;
    expect(veto()).toBe(false); stop = true; expect(veto()).toBe(true);
  });
  it('refuses accessors and inherited methods without invoking them', () => {
    const getter = vi.fn(() => () => false);
    expect(() => captureResourceExecutionVeto(Object.defineProperty({}, 'isExecutionStopped', { get: getter }))).toThrow();
    expect(() => captureResourceExecutionVeto(Object.create({ isExecutionStopped: () => false }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('contains throwing and asynchronous callbacks', async () => {
    expect(captureResourceExecutionVeto({ isExecutionStopped: () => { throw Error('private'); } })()).toBe(true);
    expect(captureResourceExecutionVeto({ isExecutionStopped: async () => false })()).toBe(true);
    expect(captureResourceExecutionVeto({ isExecutionStopped: async () => { throw Error('private'); } })()).toBe(true);
    await Promise.resolve();
  });
});
