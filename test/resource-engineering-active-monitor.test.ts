/** Deterministic monitor scheduling only; no custody, filesystem or worker effects. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEngineeringActiveMonitor } from '../src/core/resources/engineering-active-monitor.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('completion-relative engineering active monitor', () => {
  it('waits 25ms before checking and retains exactly one next check', () => {
    const check = vi.fn(); const failed = vi.fn();
    const stop = startEngineeringActiveMonitor(check, failed);
    expect(check).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(24); expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(25); expect(check).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled(); stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not catch up or reenter after a check consumes more than one interval', () => {
    const starts: number[] = []; let checking = false; let reentered = false;
    const failed = vi.fn();
    const stop = startEngineeringActiveMonitor(() => {
      if (checking) reentered = true;
      checking = true; starts.push(Date.now());
      // Advance only the fake clock during the first synchronous callback.
      // An interval would remain armed and fire again during this advance.
      if (starts.length === 1) vi.advanceTimersByTime(80);
      checking = false;
    }, failed);
    vi.advanceTimersByTime(25);
    expect(starts).toEqual([25]); expect(reentered).toBe(false);
    expect(Date.now()).toBe(105); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(24); expect(starts).toEqual([25]);
    vi.advanceTimersByTime(1); expect(starts).toEqual([25, 130]);
    expect(failed).not.toHaveBeenCalled(); stop();
  });

  it('cancels before the first check and remains idempotently stopped', () => {
    const check = vi.fn(); const failed = vi.fn();
    const stop = startEngineeringActiveMonitor(check, failed);
    stop(); stop(); vi.advanceTimersByTime(1000); stop();
    expect(check).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels after a successful check without leaving its next timer live', () => {
    const check = vi.fn(); const failed = vi.fn();
    const stop = startEngineeringActiveMonitor(check, failed);
    vi.advanceTimersByTime(25); stop(); vi.advanceTimersByTime(1000);
    expect(check).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rearm when the synchronous check stops its own monitor', () => {
    const failed = vi.fn();
    const check = vi.fn(() => { stop(); stop(); });
    const stop = startEngineeringActiveMonitor(check, failed);
    vi.advanceTimersByTime(1000);
    expect(check).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed check exactly once and cannot resume after the condition recovers', () => {
    let unhealthy = true;
    const check = vi.fn(() => { if (unhealthy) throw new Error('fixture custody unavailable'); });
    const failed = vi.fn(); const stop = startEngineeringActiveMonitor(check, failed);
    vi.advanceTimersByTime(25);
    expect(check).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    unhealthy = false; vi.advanceTimersByTime(1000); stop(); stop();
    expect(check).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  });

  it('permits cancellation from the failure callback without creating another timer', () => {
    const check = vi.fn(() => { throw new Error('fixture custody unavailable'); });
    const failed = vi.fn(() => { stop(); });
    const stop = startEngineeringActiveMonitor(check, failed);
    vi.advanceTimersByTime(1000);
    expect(check).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remains stopped even if the failure callback throws', () => {
    const check = vi.fn(() => { throw new Error('fixture custody unavailable'); });
    const failed = vi.fn(() => { throw new Error('fixture failure callback'); });
    const stop = startEngineeringActiveMonitor(check, failed);
    // Either propagation or containment is permitted; neither can rearm.
    try { vi.advanceTimersByTime(25); } catch (error) {
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('fixture failure callback');
    }
    vi.advanceTimersByTime(1000); stop();
    expect(check).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
