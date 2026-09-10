import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEngineeringSupervision, pauseEngineeringSupervision, readEngineeringSupervision } from './engineering-supervision.js';
import { apiGet, apiPost, ApiError } from './client.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import type { ResourceConsoleEngineeringSupervisionSnapshot as Snapshot } from '../../core/resources/console-engineering-supervisor-types.js';
vi.mock('./client.js', async original => ({ ...await original<object>(), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('./auth-store.js', () => ({ clearMutationToken: vi.fn(), getMutationToken: vi.fn(), touchMutationHold: vi.fn() }));
const fixture = (): Snapshot => ({ schemaVersion: 1, configId: 'fleet', configDigest: 'a'.repeat(64), sourceState: 'healthy',
  state: 'idle', deadlineAt: '2026-09-11T00:00:00.000Z', paused: false, revision: 0,
  entries: [{ enrollmentId: 'hub', enrollmentDigest: 'b'.repeat(64), state: 'waiting', reasons: ['waiting-for-readiness'], attempts: 0 }] });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getMutationToken).mockReturnValue('control'); });
describe('engineering supervision public boundary', () => {
  it('reads closed metadata without control authority or side effects', async () => {
    const value = fixture(); vi.mocked(apiGet).mockResolvedValue(value);
    await expect(readEngineeringSupervision()).resolves.toEqual(value);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith('/api/resources/engineering-supervision', undefined);
    expect(apiPost).not.toHaveBeenCalled(); expect(getMutationToken).not.toHaveBeenCalled();
  });
  it.each([{ configId: '../path' }, { configDigest: 'wrong' }, { extra: '/private' }, { state: 'active-forever' },
    { sourceState: 'degraded' }, { sourceState: ['healthy'] }, { state: ['running'] }, { revision: -1 }, { paused: 'true' }, { deadlineAt: 'tomorrow' }, { entries: [] }, { state: 'completed' }])('rejects invalid top-level claims %j', patch => {
    expect(() => decodeEngineeringSupervision({ ...fixture(), ...patch })).toThrow('verified');
  });
  it.each([{ enrollmentId: '../path' }, { enrollmentDigest: 'invalid' }, { extra: 'secret' }, { state: 'accepted' },
    { state: ['running'] }, { attempts: 17 }, { attempts: -1 }, { attempts: 1.5 }, { reasons: ['private-failure'] }, { reasons: ['running', 'running'] }])('rejects invalid entry claims %j', patch => {
    const value = fixture(); value.entries = [{ ...value.entries[0]!, ...patch } as Snapshot['entries'][number]];
    expect(() => decodeEngineeringSupervision(value)).toThrow('verified');
  });
  it('refuses duplicate entries and contradictory paused state', () => {
    const value = fixture(); value.entries.push(value.entries[0]!);
    expect(() => decodeEngineeringSupervision(value)).toThrow('verified');
    expect(() => decodeEngineeringSupervision({ ...fixture(), state: 'paused' })).toThrow('verified');
  });
  it('pins pause changes to the displayed revision and unchanged supervisor identity', async () => {
    const value = fixture(); const result = { ...value, state: 'paused', paused: true, revision: 1 };
    vi.mocked(apiPost).mockResolvedValue(result);
    await expect(pauseEngineeringSupervision(value, true)).resolves.toEqual(result);
    expect(apiPost).toHaveBeenCalledExactlyOnceWith('/api/resources/engineering-supervision', { paused: true, expectedRevision: 0 }, 'control', undefined);
    expect(touchMutationHold).toHaveBeenCalledOnce();
  });
  it.each([{ configId: 'other' }, { configDigest: 'c'.repeat(64) }, { deadlineAt: '2026-09-12T00:00:00.000Z' }, { revision: 0 }, { revision: 3 }, { paused: false }])('rejects switched, renewed or mismatched control responses %j', async patch => {
    vi.mocked(apiPost).mockResolvedValue({ ...fixture(), paused: true, revision: 1, ...patch });
    await expect(pauseEngineeringSupervision(fixture(), true)).rejects.toThrow('verified');
    expect(touchMutationHold).not.toHaveBeenCalled();
  });
  it('does not retry a lost response or refresh a replaced token', async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error('lost response'));
    await expect(pauseEngineeringSupervision(fixture(), true)).rejects.toThrow('lost response'); expect(apiPost).toHaveBeenCalledOnce();
    vi.mocked(apiPost).mockImplementation(async () => { vi.mocked(getMutationToken).mockReturnValue('other'); return { ...fixture(), paused: true, revision: 1 }; });
    await expect(pauseEngineeringSupervision(fixture(), true)).rejects.toThrow('interrupted'); expect(touchMutationHold).not.toHaveBeenCalled();
  });
  it('clears rejected control and refuses missing authority or an aborted read', async () => {
    vi.mocked(apiPost).mockRejectedValue(new ApiError('denied', 401, '/supervision'));
    await expect(pauseEngineeringSupervision(fixture(), true)).rejects.toThrow('denied'); expect(clearMutationToken).toHaveBeenCalledOnce();
    vi.mocked(getMutationToken).mockReturnValue(null);
    await expect(pauseEngineeringSupervision(fixture(), true)).rejects.toThrow('Unlock');
    const abort = new AbortController(); abort.abort(); vi.mocked(apiGet).mockResolvedValue(fixture());
    await expect(readEngineeringSupervision(abort.signal)).rejects.toThrow('cancelled');
  });
});
