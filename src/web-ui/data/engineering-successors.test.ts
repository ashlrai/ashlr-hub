import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot } from '../../core/resources/engineering-successor-coordinator-types.js';
import { apiGet, apiPost } from './client.js';
import { decodeEngineeringSuccessors, engineeringSuccessorReasons, readEngineeringSuccessors } from './engineering-successors.js';

vi.mock('./client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
const fixture = (): Snapshot => ({ schemaVersion: 1, supervisionId: 'fleet', profileId: 'fixed', configDigest: 'a'.repeat(64),
  deadlineAt: '2026-09-11T00:00:00.000Z', state: 'running', maxSuccessors: 2,
  entries: [{ sourceEnrollmentId: 'source', proposalTaskId: `proposal-${'b'.repeat(48)}`, successorId: `successor-${'b'.repeat(48)}`,
    state: 'proposing', reason: null }] });
beforeEach(() => vi.resetAllMocks());

describe('successor metadata read boundary', () => {
  it.each(['idle', 'running', 'closed', 'timed-out', 'unavailable'] as const)('accepts bounded %s status without inventing freshness or completion', state => {
    const value = { ...fixture(), state }; expect(decodeEngineeringSuccessors(value)).toEqual(value);
    expect(decodeEngineeringSuccessors({ ...value, entries: [] }).entries).toEqual([]);
  });
  it.each(['proposing', 'waiting-for-capacity', 'preparing', 'admitting', 'held', 'proposed', 'prepared', 'admitted', 'stopped'] as const)('accepts %s and retained fixed-code explanations', state => {
    const value = fixture(); value.entries[0]!.state = state;
    for (const reason of [null, ...Object.keys(engineeringSuccessorReasons)]) {
      value.entries[0]!.reason = reason; expect(decodeEngineeringSuccessors(value)).toEqual(value);
    }
  });
  it.each([null, [], {}, { schemaVersion: 2 }, { supervisionId: '../private' }, { profileId: 'UPPER' }, { configDigest: 'a'.repeat(63) },
    { deadlineAt: '2026-09-11' }, { deadlineAt: 'not-a-date' }, { state: 'completed' }, { maxSuccessors: 0 }, { maxSuccessors: 33 },
    { maxSuccessors: 1.5 }, { maxSuccessors: NaN }, { entries: null }, { prompt: 'private' }, { context: 'private' }, { path: '/private' }])('rejects malformed or extra top-level evidence %j', patch => {
    const value = patch === null || Array.isArray(patch) || Object.keys(patch).length === 0 ? patch : { ...fixture(), ...patch };
    expect(() => decodeEngineeringSuccessors(value)).toThrow('could not be verified');
  });
  it.each([{ sourceEnrollmentId: 'x'.repeat(65) }, { sourceEnrollmentId: '../source' }, { proposalTaskId: 'proposal-short' },
    { successorId: `successor-${'c'.repeat(48)}` }, { state: 'verified-delivered' }, { reason: '/private/credential-error' },
    { reason: undefined }, { output: 'private proposal' }, { workerId: 'private-worker' }, { enrollmentDigest: 'd'.repeat(64) }])('rejects malformed or private row evidence %j', patch => {
    const value = fixture(); Object.assign(value.entries[0]!, patch);
    expect(() => decodeEngineeringSuccessors(value)).toThrow('could not be verified');
  });
  it.each(['source', 'task', 'cap'])('rejects duplicate or over-cap %s rows', kind => {
    const value = fixture(); const row = { ...value.entries[0]!, sourceEnrollmentId: 'other', proposalTaskId: `proposal-${'c'.repeat(48)}`, successorId: `successor-${'c'.repeat(48)}` };
    if (kind === 'source') row.sourceEnrollmentId = 'source';
    if (kind === 'task') { row.proposalTaskId = value.entries[0]!.proposalTaskId; row.successorId = value.entries[0]!.successorId; }
    if (kind === 'cap') value.maxSuccessors = 1;
    value.entries.push(row); expect(() => decodeEngineeringSuccessors(value)).toThrow('could not be verified');
  });
  it('accepts the full lifetime bound without mutating the response', () => {
    const value = fixture(); value.maxSuccessors = 32;
    value.entries = Array.from({ length: 32 }, (_, n) => ({ ...value.entries[0]!, sourceEnrollmentId: `source-${n}`,
      proposalTaskId: `proposal-${n.toString(16).padStart(48, '0')}`, successorId: `successor-${n.toString(16).padStart(48, '0')}` }));
    const before = JSON.stringify(value); value.entries.forEach(Object.freeze); Object.freeze(value.entries); Object.freeze(value);
    expect(decodeEngineeringSuccessors(value)).toEqual(value); expect(JSON.stringify(value)).toBe(before);
  });
  it('makes exactly one authenticated metadata GET with the supplied cancellation signal', async () => {
    const value = fixture(), abort = new AbortController(); vi.mocked(apiGet).mockResolvedValue(value);
    await expect(readEngineeringSuccessors(abort.signal)).resolves.toEqual(value);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith('/api/resources/engineering-successors', abort.signal); expect(apiPost).not.toHaveBeenCalled();
  });
  it('does not start an already-cancelled read', async () => {
    const abort = new AbortController(); abort.abort(); await expect(readEngineeringSuccessors(abort.signal)).rejects.toThrow('could not be verified');
    expect(apiGet).not.toHaveBeenCalled(); expect(apiPost).not.toHaveBeenCalled();
  });
  it('discards a late response after cancellation', async () => {
    const abort = new AbortController(); let finish!: (value: unknown) => void;
    vi.mocked(apiGet).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = readEngineeringSuccessors(abort.signal); abort.abort(); finish(fixture());
    await expect(pending).rejects.toThrow('could not be verified'); expect(apiGet).toHaveBeenCalledOnce();
  });
  it('redacts raw transport and decoder errors without retries or mutation requests', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('/private/credentials: token-secret'));
    await expect(readEngineeringSuccessors()).rejects.toThrow('Successor status could not be verified. Refresh status before relying on it.');
    expect(apiGet).toHaveBeenCalledOnce(); expect(apiPost).not.toHaveBeenCalled();
    vi.mocked(apiGet).mockResolvedValue({ ...fixture(), output: 'secret output' });
    await expect(readEngineeringSuccessors()).rejects.toThrow('Successor status could not be verified. Refresh status before relying on it.');
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
