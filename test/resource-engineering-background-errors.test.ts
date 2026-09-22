import { describe, expect, it, vi } from 'vitest';
import { createEngineeringBackgroundHostCalls } from '../src/core/resources/engineering-background-errors.js';
import { EngineeringWorkerRpcError } from '../src/core/resources/engineering-worker-rpc.js';

function fixture(error?: unknown) {
  const invoke = vi.fn((_method: string, _input: unknown): unknown => { if (error !== undefined) throw error; return { value: 1 }; });
  const onFault = vi.fn(); const isClosed = vi.fn(() => false);
  const call = createEngineeringBackgroundHostCalls({ call: invoke, isClosed, onFault });
  return { call, invoke, onFault, isClosed };
}

describe('effectful engineering worker host failure policy', () => {
  it.each(['owner.register', 'supervision.admit'])('halts immediately after uncertain %s and refuses fresh-CAS retries', method => {
    const error = new EngineeringWorkerRpcError('HANDLER_FAILED', true); const f = fixture(error);
    f.onFault.mockImplementation(() => {
      // The latch precedes notification, including reentrant subordinate work.
      expect(() => f.call(method, [{ expectedRevision: 2 }])).toThrow('BACKGROUND_FAULTED');
    });
    expect(() => f.call(method, [{ expectedRevision: 1 }])).toThrow(error);
    expect(f.onFault).toHaveBeenCalledTimes(1);
    expect(() => f.call(method, [{ expectedRevision: 2 }])).toThrow('BACKGROUND_FAULTED');
    expect(() => f.call('owner.snapshot', ['id'])).toThrow('BACKGROUND_FAULTED');
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['owner.snapshot', 'owner.checkRegistration', 'supervision.snapshot', 'readAdmissionEvidence'])(
    'keeps ordinary %s validation refusal as a hold rather than an isolate fault', method => {
      const error = new EngineeringWorkerRpcError('HANDLER_FAILED', true); const f = fixture(error);
      expect(() => f.call(method, [])).toThrow(error); expect(f.onFault).not.toHaveBeenCalled();
      f.invoke.mockReturnValueOnce({ healthy: true });
      expect(f.call(method, [])).toEqual({ healthy: true }); expect(f.invoke).toHaveBeenCalledTimes(2);
    });
  it.each(['TIMEOUT_CANCELLED', 'TIMEOUT_UNCERTAIN', 'TRANSPORT_FAILED', 'INVALID_RESPONSE', 'INVALID_METHOD', 'ID_EXHAUSTED'])(
    'fails closed on %s even for a read', code => {
      const error = new EngineeringWorkerRpcError(code, code === 'TIMEOUT_UNCERTAIN'); const f = fixture(error);
      expect(() => f.call('owner.snapshot', [])).toThrow(error); expect(f.onFault).toHaveBeenCalledTimes(1);
      expect(() => f.call('owner.snapshot', [])).toThrow('BACKGROUND_FAULTED'); expect(f.invoke).toHaveBeenCalledTimes(1);
    });
  it.each([false, true])('does not poison expected read CLOSED during drain (uncertain=%s)', uncertain => {
    const error = new EngineeringWorkerRpcError('CLOSED', uncertain); const f = fixture(error);
    expect(() => f.call('owner.snapshot', [])).toThrow(error); expect(f.onFault).not.toHaveBeenCalled();
    f.isClosed.mockReturnValue(true);
    expect(() => f.call('supervision.snapshot', [])).toThrow('CLOSED'); expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.onFault).not.toHaveBeenCalled();
  });
  it.each(['owner.register', 'supervision.admit'])('retains ambiguity for %s CLOSED after host execution', method => {
    const error = new EngineeringWorkerRpcError('CLOSED', true); const f = fixture(error);
    expect(() => f.call(method, [])).toThrow(error); expect(f.onFault).toHaveBeenCalledTimes(1);
    expect(() => f.call(method, [])).toThrow('BACKGROUND_FAULTED'); expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('refuses new calls without fault or transport when closure already guarantees no effect', () => {
    const f = fixture(); f.isClosed.mockReturnValue(true);
    expect(() => f.call('owner.register', [])).toThrow('CLOSED'); expect(f.invoke).not.toHaveBeenCalled(); expect(f.onFault).not.toHaveBeenCalled();
  });
  it('latches unexpected errors even if failure notification throws', () => {
    const error = Error('internal'); const f = fixture(error); f.onFault.mockImplementation(() => { throw Error('notification failed'); });
    expect(() => f.call('owner.snapshot', [])).toThrow(error);
    expect(() => f.call('owner.snapshot', [])).toThrow('BACKGROUND_FAULTED'); expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown method paths without invoking a handler', () => {
    const f = fixture(); expect(() => f.call('owner.constructor', [])).toThrow('INVALID_METHOD');
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.onFault).toHaveBeenCalledTimes(1);
  });
  it('captures functions and rejects option accessors without invoking them', () => {
    const options = { call: vi.fn(() => 'original'), isClosed: () => false, onFault() {} };
    const call = createEngineeringBackgroundHostCalls(options); options.call = vi.fn(() => 'changed');
    expect(call('owner.catalog', [])).toBe('original');
    const getter = vi.fn(); Object.defineProperty(options, 'call', { get: getter });
    expect(() => createEngineeringBackgroundHostCalls(options)).toThrow('INVALID_OPTIONS'); expect(getter).not.toHaveBeenCalled();
  });
});
