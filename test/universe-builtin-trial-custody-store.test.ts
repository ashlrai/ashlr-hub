import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImmutablePrivateRecordCodec, ImmutablePrivateRecordStoreConfig } from '../src/core/util/immutable-private-record-store.js';
import type { BuiltinTrialCustodyRecord, BuiltinTrialIntent } from '../src/core/universe/builtin-trial-custody.js';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../src/core/util/immutable-private-record-store.js', () => ({
  readImmutablePrivateRecords: mocks.read, writeImmutablePrivateRecord: mocks.write,
}));
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { assertBuiltinTrialEvaluatorsSettled, readBuiltinTrialCustody, writeBuiltinTrialCustody } from '../src/core/universe/builtin-trial-custody.js';

const directory = '/private/custody/universes/example';
function intent(): BuiltinTrialIntent {
  const runId = '11111111-1111-4111-8111-111111111111', trialId = '22222222-2222-4222-8222-222222222222';
  return { schemaVersion: 1, universeId: 'example', runId, trialId, startedAt: '2026-09-12T12:00:00.000Z',
    manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64), evaluatorId: 'preparation-measurement-v1',
    evaluatorDigest: 'c'.repeat(64), artifactPath: `${directory}/artifacts/${runId}/${trialId}`,
    artifactDigest: 'd'.repeat(64), scratchPath: `${directory}/scratch/${runId}/${trialId}` };
}
function row(settled = false): BuiltinTrialCustodyRecord {
  const parent = intent(), kind = settled ? 'settlement' : 'intent';
  return { id: `${parent.trialId}.${kind}`, kind, intent: parent, settlement: !settled ? null : {
    intentDigest: digest(canonical(parent)), finishedAt: parent.startedAt, state: 'group-exit-confirmed' } };
}
let codec: ImmutablePrivateRecordCodec<BuiltinTrialCustodyRecord>;
let rows: BuiltinTrialCustodyRecord[];
beforeEach(() => {
  vi.clearAllMocks(); rows = [];
  mocks.read.mockImplementation((config: ImmutablePrivateRecordStoreConfig<BuiltinTrialCustodyRecord>) => {
    codec = config.codecForRead()!;
    return { sourceState: 'healthy', complete: true, sourcePresent: true, records: rows };
  });
  mocks.write.mockImplementation((_config: unknown, value: BuiltinTrialCustodyRecord, options: { prepublish: () => boolean }) => {
    if (!codec.parse(value)) return 'invalid-record';
    options.prepublish(); rows.push(structuredClone(value)); return 'recorded';
  });
  readBuiltinTrialCustody(directory);
});
describe('closed builtin trial custody codec', () => {
  it('round-trips intent and exact paired confirmed settlement', () => {
    expect(codec.parse(JSON.parse(codec.serialize(row())))).toEqual(row());
    expect(codec.parse(row(true))).toEqual(row(true));
  });
  it.each(['unconfirmed', 'unknown', ['group-exit-confirmed'], null])('rejects unsupported settlement %j', state => {
    const input = row(true);
    expect(codec.parse({ ...input, settlement: { ...input.settlement, state } })).toBeNull();
  });
  it.each([{ evaluatorId: 'arbitrary' }, { evaluatorDigest: '' }, { universeId: 'other' }, { runId: '../escape' },
    { artifactPath: '/private/unrelated' }, { scratchPath: `${directory}/scratch/../other` },
    { artifactDigest: ['d'.repeat(64)] }, { startedAt: '2026-09-12' }])('rejects invalid binding %j', patch => {
    const input = row(); expect(codec.parse({ ...input, intent: { ...input.intent, ...patch } })).toBeNull();
  });
  it('rejects getters without invoking them and proxies without traps', () => {
    const getter = vi.fn(), trap = vi.fn();
    const input = row(); Object.defineProperty(input.intent, 'runId', { enumerable: true, get: getter });
    expect(codec.parse(input)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    expect(codec.parse(new Proxy(row(), { ownKeys: trap }))).toBeNull(); expect(trap).not.toHaveBeenCalled();
  });
  it('rejects custom prototypes, symbols and enum coercion', () => {
    expect(codec.parse(Object.assign(Object.create({}), row()))).toBeNull();
    expect(codec.parse({ ...row(), [Symbol('extra')]: 1 })).toBeNull();
    expect(codec.parse({ ...row(), kind: ['intent'] })).toBeNull();
  });
  it('rejects mismatched intent digest and backwards settlement timestamp', () => {
    const input = row(true);
    expect(codec.parse({ ...input, settlement: { ...input.settlement, intentDigest: 'f'.repeat(64) } })).toBeNull();
    expect(codec.parse({ ...input, settlement: { ...input.settlement, finishedAt: '2026-09-12T11:59:59.999Z' } })).toBeNull();
  });
});
describe('durable builtin trial custody admission', () => {
  it('missing old journal is allowed without writes', () => {
    mocks.read.mockReturnValue({ sourceState: 'missing', sourcePresent: false, complete: false, records: [] });
    expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).not.toThrow(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(['unsafe', 'incomplete', 'corrupt'])('refuses %s evidence', sourceState => {
    mocks.read.mockReturnValue({ sourceState, sourcePresent: true, complete: false, records: [] });
    expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).toThrow('custody unavailable');
  });
  it('holds durable intent until exact settlement; no score facts are required', () => {
    const guard = vi.fn(); writeBuiltinTrialCustody(directory, row(), guard);
    expect(guard).toHaveBeenCalledOnce(); expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).toThrow('unresolved');
    writeBuiltinTrialCustody(directory, row(true), guard);
    expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).not.toThrow(); expect(rows[1]).not.toHaveProperty('score');
  });
  it('not-started is a valid settlement and preserves the original intent', () => {
    rows = [row(), { ...row(true), settlement: { ...row(true).settlement!, state: 'not-started' } }];
    expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).not.toThrow();
  });
  it('rejects orphaned or differently bound settlement', () => {
    rows = [row(true)]; expect(() => readBuiltinTrialCustody(directory)).toThrow();
    rows = [row(), { ...row(true), intent: { ...intent(), evaluatorDigest: 'f'.repeat(64) } }];
    expect(() => readBuiltinTrialCustody(directory)).toThrow();
  });
  it('refuses replay intent and settlement writes without invoking publication', () => {
    rows = [row()]; expect(() => writeBuiltinTrialCustody(directory, row(), vi.fn())).toThrow();
    rows.push(row(true)); expect(() => writeBuiltinTrialCustody(directory, row(true), vi.fn())).toThrow();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('retains pending evidence when publication refuses or ownership is lost', () => {
    rows = [row()]; mocks.write.mockReturnValue('failed');
    expect(() => writeBuiltinTrialCustody(directory, row(true), vi.fn())).toThrow();
    expect(() => assertBuiltinTrialEvaluatorsSettled(directory)).toThrow('unresolved');
  });
  it('does not dispatch a publication whose ownership guard throws', () => {
    expect(() => writeBuiltinTrialCustody(directory, row(), () => { throw new Error('lost'); })).toThrow('lost');
    expect(rows).toEqual([]);
  });
  it('validates caller-owned record data before property access or publication', () => {
    const getter = vi.fn(); const input = row(); Object.defineProperty(input, 'kind', { enumerable: true, get: getter });
    expect(() => writeBuiltinTrialCustody(directory, input, vi.fn())).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('reserves bytes for the larger settlement before writing an intent', () => {
    const oversized = `/private/${'a'.repeat(3600)}/universes/example`, input = row();
    input.intent.artifactPath = `${oversized}/artifacts/${input.intent.runId}/${input.intent.trialId}`;
    input.intent.scratchPath = `${oversized}/scratch/${input.intent.runId}/${input.intent.trialId}`;
    // Choose the exact edge where intent fits but the paired settlement does not.
    while (Buffer.byteLength(canonical({ ...input, kind: 'settlement', id: `${input.intent.trialId}.settlement`,
      settlement: { intentDigest: digest(canonical(input.intent)), finishedAt: input.intent.startedAt, state: 'group-exit-confirmed' } })) < 8192) {
      input.intent.artifactPath = input.intent.artifactPath.replace('/universes/', 'a/universes/');
      input.intent.scratchPath = input.intent.scratchPath.replace('/universes/', 'a/universes/');
    }
    const target = input.intent.artifactPath.split('/artifacts/')[0]!;
    expect(Buffer.byteLength(canonical(input))).toBeLessThan(8192);
    expect(() => writeBuiltinTrialCustody(target, input, vi.fn())).toThrow(); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('reserves settlement capacity for every outstanding intent', () => {
    // Transport is mocked: exercise the hard boundary without thousands of files.
    rows = Array.from({ length: 2048 }, () => ({ ...row(), intent: { ...intent(), trialId: '33333333-3333-4333-8333-333333333333' } }));
    expect(() => writeBuiltinTrialCustody(directory, row(), vi.fn())).toThrow(); expect(mocks.write).not.toHaveBeenCalled();
  });
});
