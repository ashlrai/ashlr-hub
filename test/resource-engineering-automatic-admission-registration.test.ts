/** Real registration codec with a mocked record reader; no filesystem/process effects. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({ readImmutablePrivateRecords: store.read, writeImmutablePrivateRecord: store.write }));
import { readResourceEngineeringPreparationRegistrations, validateResourceEngineeringAutomaticAdmission } from '../src/core/resources/engineering-preparation-registry.js';

const binding = { schemaVersion: 1, supervisionId: 'original', configDigest: 'a'.repeat(64), deadlineAt: '2026-09-12T12:01:00.000Z' };
const base = { schemaVersion: 1, configDigest: 'b'.repeat(64), request: { id: 'first', profileId: 'fixed', name: 'First', objective: 'Improve' },
  planDigest: 'c'.repeat(64), bundlePlanDigest: 'd'.repeat(64), enrollmentDigest: 'e'.repeat(64) };
let codec: { parse(input: unknown): unknown; serialize(value: unknown): string };
beforeEach(() => {
  store.read.mockReturnValue({ sourceState: 'missing', records: [] });
  readResourceEngineeringPreparationRegistrations('/private/fixture');
  codec = store.read.mock.lastCall![0].codecForRead();
});
describe('atomic ordinary automatic admission marker', () => {
  it('accepts legacy registration without introducing automation metadata', () => {
    expect(codec.parse(base)).toEqual(base); expect(codec.serialize(base)).not.toContain('automaticAdmission');
  });
  it('binds the marker in the same serialized registration as exact plan and enrollment digests', () => {
    const value = { ...base, automaticAdmission: binding };
    expect(codec.parse(value)).toEqual(value); expect(JSON.parse(codec.serialize(value))).toEqual(value);
  });
  it.each([null, false, {}, { ...binding, deadlineAt: 'tomorrow' }, { ...binding, deadlineAt: '2026-09-12T12:01:00Z' },
    { ...binding, configDigest: 'bad' }, { ...binding, supervisionId: '../other' }, { ...binding, schemaVersion: 2 }, { ...binding, extra: true }])(
    'rejects a present invalid marker %j', marker => { expect(codec.parse({ ...base, automaticAdmission: marker })).toBeNull(); });
  it('never accepts a successor source together with an ordinary automatic marker', () => {
    const source = { root: '/private/source', campaignId: 'source', expectedDefinitionDigest: 'a'.repeat(64), expectedManifestDigest: 'b'.repeat(64),
      expectedComparatorDigest: 'c'.repeat(64), expectedDeliveryDigest: 'd'.repeat(64), delivery: { branch: 'codex/source', baseCommit: 'a'.repeat(40) } };
    expect(codec.parse({ ...base, source })).not.toBeNull();
    expect(codec.parse({ ...base, automaticAdmission: binding, source })).toBeNull();
  });
  it('captures bindings without invoking getters or accepting inherited fields', () => {
    const getter = vi.fn(() => binding.supervisionId);
    expect(() => validateResourceEngineeringAutomaticAdmission({ ...binding, get supervisionId() { return getter(); } })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => validateResourceEngineeringAutomaticAdmission(Object.create(binding))).toThrow();
    const original = { ...binding }; const copied = validateResourceEngineeringAutomaticAdmission(original);
    original.deadlineAt = '2027-01-01T00:00:00.000Z'; expect(copied).toEqual(binding);
  });
});
