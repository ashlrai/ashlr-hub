import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { digestResourceEnvelopeV1, type ResourceEnvelopeV1 } from '../src/core/vision/value-portfolio.js';
import { createValueAllocationReceipt } from '../src/core/universe/value-allocation.js';
import { recordValueAllocation, readValueAllocations, type StoredValueAllocationV1 } from '../src/core/universe/value-allocation-store.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import * as records from '../src/core/util/immutable-private-record-store.js';

const hooks = vi.hoisted(() => ({ readKey: vi.fn(), createKey: vi.fn() }));
vi.mock('../src/core/foundry/provenance.js', () => ({ loadExistingProvenanceKeyReadOnly: hooks.readKey, loadOrCreateKey: hooks.createKey }));
const keyOptions = { testKey: Buffer.alloc(32, 7) };
const roots: string[] = [];
beforeEach(() => { hooks.readKey.mockReset().mockReturnValue(null); hooks.createKey.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(policyEpoch = 1) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'value-allocation-store-'))); roots.push(parent);
  const root = join(parent, 'store'); mkdirSync(root, { mode: 0o700 });
  const resourceEnvelope: ResourceEnvelopeV1 = { schemaVersion: 1, sourceComplete: true, sourceDigest: 'a'.repeat(64), reserveFraction: 0.1, capacity: [] };
  const result = createValueAllocationReceipt({ schemaVersion: 1, asOf: '2026-09-03T12:00:00.000Z', constitutionVersion: 'v1', policyEpoch,
    visionSpec: { content: 'fictional vision', expectedDigest: digest('fictional vision') },
    missionGraph: { content: 'fictional graph', expectedDigest: digest('fictional graph') }, resourceEnvelope,
    expectedResourceEnvelopeDigest: digestResourceEnvelopeV1(resourceEnvelope), hypotheses: [], expectedHypothesesDigest: digest(canonical([])) }, keyOptions);
  if (!result.ok) throw new Error('Invalid fixture');
  const input = { root, allocationId: 'allocation-a', receipt: result.receipt, trace: result.trace };
  const path = (id = 'allocation-a') => join(root, 'value-allocations', 'records', `${id}.json`);
  const query = () => readValueAllocations({ root }, keyOptions);
  return { root, parent, input, path, query };
}
function sibling(record: StoredValueAllocationV1, allocationId: string): StoredValueAllocationV1 {
  const { provenanceSig: _old, ...base } = record; const payload = { ...base, allocationId };
  return { ...payload, provenanceSig: createHmac('sha256', keyOptions.testKey).update('ashlr:universe:value-allocation-store:v1\n').update(canonical(payload)).digest('hex') };
}

describe('private signed allocation receipt store', () => {
  it('stores the original signed receipt and trace in private canonical bytes', () => {
    const f = fixture(); const before = canonical(f.input); const result = recordValueAllocation(f.input, keyOptions);
    expect(result.disposition).toBe('recorded'); expect(canonical(f.input)).toBe(before);
    expect(result.record.receipt).toEqual(f.input.receipt); expect(result.record.trace).toEqual(f.input.trace);
    const bytes = `${canonical(result.record)}\n`; expect(readFileSync(f.path(), 'utf8')).toBe(bytes);
    expect(lstatSync(f.path()).mode & 0o777).toBe(0o600);
    for (const directory of ['value-allocations', 'value-allocations/records', 'value-allocations/staging']) expect(lstatSync(join(f.root, directory)).mode & 0o777).toBe(0o700);
    expect(f.query()).toMatchObject({ sourceState: 'healthy', complete: true, bytesRead: Buffer.byteLength(bytes), records: [result.record] });
    f.input.receipt.policyEpoch++; expect(f.query().records[0]!.receipt.policyEpoch).toBe(1);
    expect(hooks.createKey).not.toHaveBeenCalled();
  });

  it('replays only identical content and rejects changed signed content at the same ID', () => {
    const f = fixture(); const original = recordValueAllocation(f.input, keyOptions); const before = readFileSync(f.path());
    expect(recordValueAllocation(f.input, keyOptions)).toEqual({ disposition: 'replayed', record: original.record });
    const alternate = fixture(2);
    expect(() => recordValueAllocation({ ...f.input, receipt: alternate.input.receipt, trace: alternate.input.trace }, keyOptions)).toThrow(/conflicted/);
    alternate.input.receipt.basis.asOf = '2026-09-04T12:00:00.000Z';
    expect(() => recordValueAllocation({ ...f.input, receipt: alternate.input.receipt }, keyOptions)).toThrow(/verification/);
    const alternateRecord = sibling(original.record, 'allocation-b');
    writeFileSync(f.path('allocation-b'), `${canonical(alternateRecord)}\n`, { mode: 0o600 });
    // Valid wrappers can retain the same receipt under distinct explicit IDs;
    // this is not a second capacity reservation or an exactly-once work claim.
    expect(f.query().records).toHaveLength(2); expect(readFileSync(f.path())).toEqual(before);
    const wrapper = JSON.parse(before.toString()); wrapper.trace.provenanceSig = '0'.repeat(64);
    expect(() => recordValueAllocation({ ...f.input, trace: wrapper.trace }, keyOptions)).toThrow(/verification/);
  });

  it.each(['id', 'filename', 'receipt', 'trace', 'wrapper-signature'])('refuses persisted %s forgery without partial results or repair', (mode) => {
    const f = fixture(); recordValueAllocation(f.input, keyOptions); const row = JSON.parse(readFileSync(f.path(), 'utf8'));
    if (mode === 'id') row.allocationId = 'renamed';
    if (mode === 'receipt') row.receipt.policyEpoch++;
    if (mode === 'trace') row.trace.verifier.independent = true;
    if (mode === 'wrapper-signature') row.provenanceSig = '0'.repeat(64);
    if (mode === 'filename') renameSync(f.path(), f.path('renamed'));
    else writeFileSync(f.path(), `${canonical(row)}\n`);
    expect(f.query()).toMatchObject({ sourceState: 'degraded', complete: false, records: [] });
    const before = readdirSync(join(f.root, 'value-allocations', 'records')).sort();
    expect(() => recordValueAllocation({ ...f.input, allocationId: 'new' }, keyOptions)).toThrow(/unavailable/);
    expect(readdirSync(join(f.root, 'value-allocations', 'records')).sort()).toEqual(before);
  });

  it('rejects relabeled wrapper bytes even after moving the file to its new ID', () => {
    const f = fixture(); const { record } = recordValueAllocation(f.input, keyOptions); record.allocationId = 'relabeled';
    rmSync(f.path()); writeFileSync(f.path('relabeled'), `${canonical(record)}\n`, { mode: 0o600 });
    expect(f.query()).toMatchObject({ sourceState: 'degraded', records: [] });
  });

  it('keeps missing storage absent and requires an existing private explicit root', () => {
    const f = fixture(); expect(f.query()).toMatchObject({ sourceState: 'missing', complete: false, records: [] });
    expect(readdirSync(f.root)).toEqual([]); const missing = join(f.parent, 'missing');
    expect(readValueAllocations({ root: missing }, keyOptions).sourceState).toBe('missing'); expect(existsSync(missing)).toBe(false);
    expect(() => recordValueAllocation({ ...f.input, root: missing }, keyOptions)).toThrow(); expect(existsSync(missing)).toBe(false);
    chmodSync(f.root, 0o755); expect(f.query().sourceState).toBe('degraded');
    expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(); expect(readdirSync(f.root)).toEqual([]);
  });

  it('requires the existing key, does not initialize it and rejects wrong or changed keys', () => {
    const f = fixture(); expect(() => recordValueAllocation(f.input)).toThrow(/key unavailable/);
    expect(readdirSync(f.root)).toEqual([]); hooks.readKey.mockReturnValue(keyOptions.testKey);
    recordValueAllocation(f.input); expect(readValueAllocations({ root: f.root }).sourceState).toBe('healthy');
    hooks.readKey.mockReturnValue(null); expect(readValueAllocations({ root: f.root }).sourceState).toBe('degraded');
    expect(readValueAllocations({ root: f.root }, { testKey: Buffer.alloc(32, 8) }).sourceState).toBe('degraded');
    hooks.readKey.mockImplementation(() => { throw new Error('private key location'); });
    expect(() => recordValueAllocation(f.input)).toThrow('Allocation key unavailable'); expect(hooks.createKey).not.toHaveBeenCalled();
  });

  it('refuses held ownership without mutation, including a conservative read while busy', () => {
    const f = fixture(); const acquired = acquireLocalStoreLockWithOutcome(join(f.root, '.value-allocations.lock'), 0, { anchorPath: f.root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') throw new Error('Expected fixture lock');
    try {
      expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(/ownership unavailable/);
      expect(f.query()).toMatchObject({ sourceState: 'degraded', records: [] }); expect(existsSync(join(f.root, 'value-allocations'))).toBe(false);
    } finally { releaseLocalStoreLock(acquired.lock); }
    expect(recordValueAllocation(f.input, keyOptions).disposition).toBe('recorded');
  });

  it('does not heal incomplete directories or staging evidence', () => {
    const f = fixture(); mkdirSync(join(f.root, 'value-allocations'), { mode: 0o700 });
    expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(/unavailable/);
    expect(readdirSync(join(f.root, 'value-allocations'))).toEqual([]);
    rmSync(join(f.root, 'value-allocations'), { recursive: true }); recordValueAllocation(f.input, keyOptions);
    const stage = join(f.root, 'value-allocations/staging/incomplete.stage'); writeFileSync(stage, 'unfinished', { mode: 0o600 });
    expect(f.query().sourceState).toBe('degraded'); expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(/unavailable/);
    expect(readFileSync(stage, 'utf8')).toBe('unfinished');
  });

  it('refuses symlinked roots, store directories and record bytes', () => {
    const f = fixture(); const alias = join(f.parent, 'alias'); symlinkSync(f.root, alias);
    expect(readValueAllocations({ root: alias }, keyOptions).sourceState).toBe('degraded');
    expect(() => recordValueAllocation({ ...f.input, root: alias }, keyOptions)).toThrow();
    const store = join(f.root, 'value-allocations'); symlinkSync(join(f.parent, 'missing'), store);
    expect(f.query().sourceState).toBe('degraded'); expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(/unavailable/);
    rmSync(store); recordValueAllocation(f.input, keyOptions);
    const saved = join(f.parent, 'saved'); renameSync(f.path(), saved); symlinkSync(saved, f.path());
    expect(f.query().sourceState).toBe('degraded');
  });

  it('rechecks outer ownership at the immutable publication boundary', () => {
    const f = fixture(); const original = records.writeImmutablePrivateRecord;
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((configuration, record, options) => {
      rmSync(join(f.root, '.value-allocations.lock'));
      return original(configuration, record, options);
    });
    expect(() => recordValueAllocation(f.input, keyOptions)).toThrow(/unavailable/);
    expect(existsSync(f.path())).toBe(false);
  });

  it('refuses key identity drift at publication without writing a record', () => {
    const f = fixture(); hooks.readKey.mockReturnValue(keyOptions.testKey);
    const original = records.writeImmutablePrivateRecord;
    vi.spyOn(records, 'writeImmutablePrivateRecord').mockImplementation((configuration, record, options) => {
      hooks.readKey.mockReturnValue(Buffer.alloc(32, 8));
      return original(configuration, record, options);
    });
    expect(() => recordValueAllocation(f.input)).toThrow(/unavailable/); expect(existsSync(f.path())).toBe(false);
  });

  it('rejects path escapes, unexpected fields and nested getters without invoking them', () => {
    const f = fixture(); const getter = vi.fn(() => f.input.receipt);
    for (const allocationId of ['../outside', '/absolute', 'UPPER', 'a/b', '']) {
      expect(() => recordValueAllocation({ ...f.input, allocationId }, keyOptions)).toThrow(/Invalid/);
    }
    expect(() => recordValueAllocation(Object.assign({ extra: true }, f.input), keyOptions)).toThrow(/Invalid/);
    const unsafe = Object.defineProperty({ ...f.input }, 'receipt', { get: getter });
    expect(() => recordValueAllocation(unsafe, keyOptions)).toThrow(/Invalid/);
    const nested = { ...f.input, receipt: Object.defineProperty({ ...f.input.receipt }, 'portfolio', { get: getter }) };
    expect(() => recordValueAllocation(nested, keyOptions)).toThrow(/invalid/);
    expect(getter).not.toHaveBeenCalled(); expect(readdirSync(f.root)).toEqual([]);
  });

  it('counts full serialized bytes before write under the owned transaction (synthetic reader unit seam)', () => {
    const f = fixture(); const { record } = recordValueAllocation(f.input, keyOptions);
    const read = vi.spyOn(records, 'readImmutablePrivateRecords');
    const oversized = Array.from({ length: 20 }, (_, index) => ({ ...sibling(record, `synthetic-${index}`), syntheticPadding: 'x'.repeat(900_000) }));
    // This intentionally bypasses codec admission only to exercise aggregate
    // arithmetic independently of today's smaller P06 output shape.
    read.mockReturnValue({ records: oversized, sourceState: 'healthy', sourcePresent: true, complete: true,
      stopReasons: [], filesRead: 20, bytesRead: 18_000_000, invalidFiles: 0, limitExceeded: false });
    const writer = vi.spyOn(records, 'writeImmutablePrivateRecord');
    expect(() => recordValueAllocation({ ...f.input, allocationId: 'overflow' }, keyOptions)).toThrow(/capacity/);
    expect(writer).not.toHaveBeenCalled(); expect(existsSync(f.path('overflow'))).toBe(false);
  });

  it('serializes independent processes contending for the final record slot', async () => {
    const f = fixture(); const { record } = recordValueAllocation(f.input, keyOptions);
    for (let index = 1; index < 255; index++) {
      const row = sibling(record, `filled-${index}`); writeFileSync(f.path(row.allocationId), `${canonical(row)}\n`, { mode: 0o600 });
    }
    const script = `import { recordValueAllocation } from ${JSON.stringify(new URL('../src/core/universe/value-allocation-store.ts', import.meta.url).href)};
      try { console.log(recordValueAllocation(JSON.parse(process.argv[1]), { testKey: Buffer.alloc(32, 7) }).disposition); }
      catch (error) { console.log(error.message); }`;
    const run = promisify(execFile);
    const output = await Promise.all(['contender-a', 'contender-b'].map((allocationId) => run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify({ ...f.input, allocationId })], { timeout: 15_000, maxBuffer: 4096 })));
    expect(output.filter((row) => row.stdout.trim() === 'recorded')).toHaveLength(1);
    expect(output.filter((row) => /ownership unavailable|capacity reached/.test(row.stdout))).toHaveLength(1);
    expect(f.query()).toMatchObject({ sourceState: 'healthy', complete: true }); expect(f.query().records).toHaveLength(256);
    expect(recordValueAllocation(f.input, keyOptions).disposition).toBe('replayed');
    expect(() => recordValueAllocation({ ...f.input, allocationId: 'after-full' }, keyOptions)).toThrow(/capacity/);
  }, 30_000);
});
