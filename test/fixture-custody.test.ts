import { describe, expect, it, vi } from 'vitest';
import { createFixtureCustody } from './helpers/fixture-custody.js';

describe('native acceptance fixture cleanup custody (pure state tests)', () => {
  it('allows cleanup before any invocation, then withholds it before dispatch starts', () => {
    const custody = createFixtureCustody(); expect(custody.canCleanup()).toBe(true);
    const ticket = custody.reserve(); expect(custody.canCleanup()).toBe(false);
    ticket.confirmSettled(() => true); expect(custody.canCleanup()).toBe(true);
  });

  it('retains evidence after a throwing dispatch and a later successful case', async () => {
    const custody = createFixtureCustody(); custody.reserve();
    await expect(Promise.reject(new Error('Lost final invocation fact'))).rejects.toThrow();
    custody.reserve().confirmSettled(() => true);
    expect(custody.canCleanup()).toBe(false);
  });

  it('retains an unresolved invocation while another invocation completes', async () => {
    const custody = createFixtureCustody(); const first = custody.reserve();
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    custody.reserve().confirmSettled(() => true); expect(custody.canCleanup()).toBe(false);
    resolve(); await pending;
    // Promise settlement is not process-group settlement evidence.
    expect(custody.canCleanup()).toBe(false);
    first.confirmSettled(() => true); expect(custody.canCleanup()).toBe(true);
  });

  it.each(['activity read', 'activity parse', 'aggregate settlement', 'group absence'])('permanently retains after failed %s proof', stage => {
    const custody = createFixtureCustody(); const ticket = custody.reserve();
    expect(() => ticket.confirmSettled(() => { throw new Error(stage); })).toThrow(stage);
    expect(custody.canCleanup()).toBe(false);
    custody.reserve().confirmSettled(() => true); expect(custody.canCleanup()).toBe(false);
    const laterProof = vi.fn(() => true as const);
    expect(() => ticket.confirmSettled(laterProof)).toThrow('previously failed');
    expect(laterProof).not.toHaveBeenCalled(); expect(custody.canCleanup()).toBe(false);
  });

  it('idempotent confirmation cannot discharge another ticket or rerun proof', () => {
    const custody = createFixtureCustody(); const first = custody.reserve(); const second = custody.reserve();
    const proof = vi.fn(() => true as const); first.confirmSettled(proof); first.confirmSettled(proof);
    expect(proof).toHaveBeenCalledOnce(); expect(custody.canCleanup()).toBe(false);
    second.confirmSettled(() => true); expect(custody.canCleanup()).toBe(true);
  });

  it.each([{ value: false }, { value: undefined }, { value: Promise.resolve(true) }])('refuses non-synchronous/positive proof %#', ({ value }) => {
    const custody = createFixtureCustody(); const ticket = custody.reserve();
    expect(() => ticket.confirmSettled((() => value) as () => true)).toThrow('not confirmed');
    expect(custody.canCleanup()).toBe(false);
  });
});
