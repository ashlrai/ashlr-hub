import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEngineeringAutomaticAdmission, readEngineeringAutomaticAdmission } from './engineering-automatic-admission.js';
import { apiGet, apiPost } from './client.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../core/resources/console-engineering-supervisor-types.js';
vi.mock('./client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), ApiError: class extends Error {} }));
vi.mock('./auth-store.js', () => ({ clearMutationToken: vi.fn(), getMutationToken: vi.fn(), touchMutationHold: vi.fn() }));
const message = 'Automatic admission status could not be verified. Refresh supervision.';
const supervision = (): Snapshot => ({ schemaVersion: 1, configId: 'queue', configDigest: 'a'.repeat(64),
  deadlineAt: '2026-09-12T12:00:00.000Z', sourceState: 'healthy', state: 'paused', paused: true, revision: 2,
  entries: [], admission: { autoAdmitPrepared: true, maxEnrollments: 4, remainingEnrollments: 4 } });
const fixture = () => ({ schemaVersion: 1, supervisionId: 'queue', configDigest: 'a'.repeat(64),
  deadlineAt: '2026-09-12T12:00:00.000Z', sampledAt: null as string | null, state: 'idle', reason: null as string | null,
  pending: [{ enrollmentId: 'plan', enrollmentDigest: 'b'.repeat(64), reason: 'verification-pending' }] });
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => {
  expect(apiPost).not.toHaveBeenCalled(); expect(clearMutationToken).not.toHaveBeenCalled();
  expect(getMutationToken).not.toHaveBeenCalled(); expect(touchMutationHold).not.toHaveBeenCalled();
  vi.useRealTimers();
});
describe('read-only automatic admission metadata', () => {
  it.each(['idle', 'reconciling', 'ready', 'held', 'closed'])('preserves %s without inferring freshness or execution', state => {
    const value = { ...fixture(), state, sampledAt: '2020-01-01T00:00:00.000Z', reason: 'capacity' };
    const decoded = decodeEngineeringAutomaticAdmission(value, supervision());
    expect(decoded).toEqual(value); expect(decoded).not.toBe(value); expect(decoded.pending[0]).not.toBe(value.pending[0]);
  });
  it.each(['binding-changed', 'evidence-unavailable', 'verification-pending', 'capacity', 'admission-unavailable'])('accepts the bounded row reason %s', reason => {
    const value = fixture(); value.pending[0]!.reason = reason;
    expect(decodeEngineeringAutomaticAdmission(value, supervision()).pending[0]!.reason).toBe(reason);
  });
  it.each([{ extra: 'private' }, { schemaVersion: 2 }, { supervisionId: 'other' }, { configDigest: 'c'.repeat(64) },
    { deadlineAt: '2027-01-01T00:00:00.000Z' }, { deadlineAt: '2026-09-12T12:00:00Z' }, { sampledAt: 'tomorrow' },
    { sampledAt: '2020-01-01T00:00:00Z' }, { state: 'running' }, { reason: ['capacity'] }, { reason: 'private cause' },
    { pending: null }])('redacts invalid or mismatched evidence %j', patch => {
    expect(() => decodeEngineeringAutomaticAdmission({ ...fixture(), ...patch }, supervision())).toThrow(message);
  });
  it.each([{ enrollmentId: '../private' }, { enrollmentDigest: 'bad' }, { reason: null }, { reason: 'running' }, { extra: true }])('rejects invalid pending row %j', patch => {
    const value = fixture();
    expect(() => decodeEngineeringAutomaticAdmission({ ...value, pending: [{ ...value.pending[0], ...patch }] }, supervision())).toThrow(message);
  });
  it('rejects duplicate, oversized, sparse and accessor-backed arrays', () => {
    const value = fixture(), item = value.pending[0]!;
    const getter = vi.fn(() => item), accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { get: getter, enumerable: true });
    for (const pending of [[item, item], Array.from({ length: 33 }, (_, i) => ({ ...item, enrollmentId: `plan-${i}` })), new Array(1), accessor]) {
      expect(() => decodeEngineeringAutomaticAdmission({ ...value, pending }, supervision())).toThrow(message);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects unknown symbols, inherited, nonenumerable and getter-backed fields without invoking getters', () => {
    const value = fixture(), getter = vi.fn(() => value.state);
    const hidden = { ...value }; Object.defineProperty(hidden, 'state', { value: 'held', enumerable: false });
    for (const input of [{ ...value, [Symbol('extra')]: true }, Object.create(value), hidden,
      { ...value, get state() { return getter(); } }]) {
      expect(() => decodeEngineeringAutomaticAdmission(input, supervision())).toThrow(message);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('requires an explicitly automatic valid supervision snapshot', async () => {
    const value = supervision(); value.admission!.autoAdmitPrepared = false;
    await expect(readEngineeringAutomaticAdmission(value)).rejects.toThrow(message);
    expect(apiGet).not.toHaveBeenCalled();
  });
  it('reads once without mutation authority and cleans up its timeout and abort listener', async () => {
    const outer = new AbortController(), remove = vi.spyOn(outer.signal, 'removeEventListener');
    vi.mocked(apiGet).mockResolvedValue(fixture());
    await expect(readEngineeringAutomaticAdmission(supervision(), outer.signal)).resolves.toEqual(fixture());
    expect(apiGet).toHaveBeenCalledExactlyOnceWith('/api/resources/engineering/automatic-admission', expect.any(AbortSignal));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
  it('captures queue identity before awaiting the response', async () => {
    const value = supervision();
    vi.mocked(apiGet).mockImplementation(async () => { value.configId = 'changed'; return fixture(); });
    await expect(readEngineeringAutomaticAdmission(value)).resolves.toEqual(fixture());
  });
  it('redacts failures without retries or lingering timers', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('/private/token'));
    await expect(readEngineeringAutomaticAdmission(supervision())).rejects.toThrow(message);
    expect(apiGet).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses pre-aborted calls without requesting data', async () => {
    const outer = new AbortController(); outer.abort();
    await expect(readEngineeringAutomaticAdmission(supervision(), outer.signal)).rejects.toThrow(message);
    expect(apiGet).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds an unresponsive request at five seconds and safely observes late rejection', async () => {
    let reject!: (reason: Error) => void;
    vi.mocked(apiGet).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const request = readEngineeringAutomaticAdmission(supervision()); const refused = expect(request).rejects.toThrow(message);
    const inner = vi.mocked(apiGet).mock.calls[0]![1]!;
    await vi.advanceTimersByTimeAsync(5000); await refused;
    expect(inner.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    reject(new Error('late private rejection')); await Promise.resolve(); expect(apiGet).toHaveBeenCalledOnce();
  });
  it('forwards caller abort, refuses ignored cancellation and removes its listener', async () => {
    const outer = new AbortController(), remove = vi.spyOn(outer.signal, 'removeEventListener');
    vi.mocked(apiGet).mockImplementation(() => new Promise(() => {}));
    const request = readEngineeringAutomaticAdmission(supervision(), outer.signal); const refused = expect(request).rejects.toThrow(message);
    outer.abort(); await refused;
    expect(vi.mocked(apiGet).mock.calls[0]![1]!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(vi.getTimerCount()).toBe(0);
  });
});
