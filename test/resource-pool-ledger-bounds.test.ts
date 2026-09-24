/**
 * Regression: the pool ledger decoder must admit everything its writer admits (and refuse
 * the same things). From 2026-09-10 (10f1909c) the decoder ran the ledger through the
 * evidence-pack serializer (1 MiB, 16,384 values), so a pool that had settled a few hundred
 * receipts wrote pool-state.json fine and then could not read it back ("Invalid bounded
 * resource ledger"), failing closed until a manual repair.
 *
 * Private tmp ledger, tmp HOME and a mocked worker only: no providers, CLIs, or default stores.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../src/core/foundry/provenance.js';
import { canonicalResourceLedgerJson } from '../src/core/resources/pool-ledger-json.js';
import { decodeResourcePoolState, requireResourcePoolSettlementHeadroom, resourcePoolStatus, runResourceTask,
  type ResourcePoolState, type ResourceTask, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import { executeResourceWorker, type ResourceBinding, type ResourceWorkerResult } from '../src/core/resources/worker.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';

vi.mock('../src/core/resources/worker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/resources/worker.js')>();
  return { ...actual, executeResourceWorker: vi.fn() };
});

const MAX_BYTES = 4 * 1024 * 1024;
const workerId = 'w'.repeat(64);
const pool: ResourcePool = { schemaVersion: 1, id: 'ledger-bounds', workers: [{ id: workerId, provider: 'codex', model: 'fixture',
  maxConcurrent: 2, reservePercent: 10, maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 1, allowUnknownQuota: true }] };
const bindings: ResourceBinding[] = [{ workerId, capacityKey: 'c'.repeat(64), kind: 'native-cli', command: ['/inert/native'] }];
const poolDigest = digest(canonical({ pool, bindings }));
const result: ResourceWorkerResult = { status: 'completed', output: 'PRIVATE_RESULT', inputTokens: 2, outputTokens: 1,
  usageScope: 'codex-turn', reason: 'worker-completed',
  nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: false, outputTruncated: false } };

let scratch: string; let root: string; let cwd: string;
const file = () => join(root, 'pool-state.json');
const save = (value: unknown) => writeFileSync(file(), canonical(value) + '\n', { mode: 0o600 });
const task = (id: string): ResourceTask => ({ schemaVersion: 1, id, allowedWorkerIds: [workerId], prompt: 'PRIVATE_PROMPT',
  cwd, timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' });
const status = () => resourcePoolStatus(root, pool, bindings, []);

/** A legacy-shaped settled receipt: ~14 JSON values, well under the widest settlement envelope. */
const smallReceipt = (index: number): ResourceTaskReceipt => ({ schemaVersion: 1, id: `r${String(index).padStart(5, '0')}`,
  taskDigest: '1'.repeat(64), poolDigest, workerId, capacityKey: 'c'.repeat(64), status: 'completed',
  startedAt: '2000-01-01T00:00:00.000Z', finishedAt: '2000-01-01T00:00:01.000Z', outputDigest: '2'.repeat(64),
  inputTokens: 1, outputTokens: 1, reason: 'ok', verifiedAccepted: false });

/** The widest valid settled receipt, so byte-exact ledgers stay under the 4,096-receipt admission cap. */
const wideReceipt = (index: number): ResourceTaskReceipt => ({ ...smallReceipt(index), id: `h${String(index).padStart(63, '0')}`,
  inputTokens: Number.MAX_SAFE_INTEGER - 1, reason: 'x'.repeat(120),
  execution: { schemaVersion: 1, scope: 'worker-execution', durationMs: 1.0000000000000002e-6, usageScope: 'codex-turn' },
  nativeProcess: { schemaVersion: 1, scope: 'native-process', exitCode: 0, signal: null, stderrPresent: true, outputTruncated: false } });

/** A valid ledger whose on-disk form (canonical JSON + newline, exactly what writeState emits) is `target` bytes. */
function ledgerOfBytes(target: number): ResourcePoolState {
  const value: ResourcePoolState = { schemaVersion: 1, poolDigest, observations: [], attempts: [] };
  const base = Buffer.byteLength(canonical(value) + '\n'); const perRow = Buffer.byteLength(canonical(wideReceipt(0))) + 1;
  value.attempts = Array.from({ length: Math.ceil((target - base + 1) / perRow) }, (_, index) => wideReceipt(index));
  let excess = Buffer.byteLength(canonical(value) + '\n') - target;
  for (let index = value.attempts.length - 1; excess > 0; index--) {
    const reduction = Math.min(119, excess); value.attempts[index]!.reason = 'x'.repeat(120 - reduction); excess -= reduction;
  }
  expect(Buffer.byteLength(canonical(value) + '\n')).toBe(target);
  expect(value.attempts.length).toBeLessThanOrEqual(4_096);
  return value;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-ledger-bounds-')));
  vi.stubEnv('HOME', scratch);
  root = join(scratch, 'ledger'); cwd = join(scratch, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  vi.mocked(executeResourceWorker).mockReset().mockResolvedValue(result);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(scratch, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('pool ledger decoder matches its writer bounds', () => {
  it('round-trips ~3,800 small receipts, past the evidence-pack 16,384-value cap', async () => {
    const seeded: ResourcePoolState = { schemaVersion: 1, poolDigest, observations: [],
      attempts: Array.from({ length: 3_800 }, (_, index) => smallReceipt(index)) };
    // Precondition: this is exactly the ledger the old decoder refused.
    expect(canonicalEvidencePackJsonV3(seeded)).toBeNull();
    expect(Buffer.byteLength(canonical(seeded) + '\n')).toBeLessThan(MAX_BYTES);
    save(seeded);

    expect(decodeResourcePoolState(JSON.parse(readFileSync(file(), 'utf8')), pool, bindings).attempts).toEqual(seeded.attempts);
    expect(status().attempts).toHaveLength(3_800);

    // Writer -> decoder: a real admission and settlement rewrite the ledger, and it still reads back.
    const settled = await runResourceTask({ root, pool, bindings, observations: [], task: task('fresh') });
    expect(settled.receipt?.status).toBe('completed');
    expect(executeResourceWorker).toHaveBeenCalledTimes(1);
    const after = status().attempts;
    expect(after).toHaveLength(3_801); expect(after.at(-1)).toEqual(settled.receipt);
    expect(after.slice(0, 3_800)).toEqual(seeded.attempts);
    expect(readFileSync(file(), 'utf8')).not.toMatch(/PRIVATE_PROMPT|PRIVATE_RESULT/);
  });

  it('accepts a ledger of exactly 4 MiB on disk and refuses one byte more, in the decoder and the file reader', () => {
    const atCap = ledgerOfBytes(MAX_BYTES);
    expect(() => decodeResourcePoolState(atCap, pool, bindings)).not.toThrow();
    save(atCap); expect(status().attempts).toHaveLength(atCap.attempts.length);

    const overCap = ledgerOfBytes(MAX_BYTES + 1);
    expect(() => decodeResourcePoolState(overCap, pool, bindings)).toThrow('Invalid bounded resource ledger');
    save(overCap); expect(() => status()).toThrow(/oversized/);
  });

  it('refuses an over-4 MiB ledger in the writer gate and the decoder alike, without contacting a worker', async () => {
    const overCap = ledgerOfBytes(MAX_BYTES + 1);
    // requireResourcePoolSettlementHeadroom is the byte gate every writer transaction runs before writeState.
    expect(() => requireResourcePoolSettlementHeadroom(overCap, pool)).toThrow('settlement capacity reached');
    expect(() => decodeResourcePoolState(overCap, pool, bindings)).toThrow('Invalid bounded resource ledger');

    // A ledger the writer would push past the cap by admitting one more reservation is refused
    // before contact and left byte-identical, and it still decodes afterwards.
    save(ledgerOfBytes(MAX_BYTES - 600)); const before = readFileSync(file(), 'utf8');
    await expect(runResourceTask({ root, pool, bindings, observations: [], task: task('overflow') })).rejects.toThrow('settlement capacity');
    expect(executeResourceWorker).not.toHaveBeenCalled();
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(() => status()).not.toThrow();
  });
});

describe('canonicalResourceLedgerJson strictness', () => {
  const bounds = { maxBytes: 1024, maxContainerEntries: 4 };
  it('emits deterministic code-unit key order and normalizes -0', () => {
    expect(canonicalResourceLedgerJson({ b: -0, a: [1, 'x', null, true], B: {} }, bounds)).toBe('{"B":{},"a":[1,"x",null,true],"b":0}');
  });
  it('refuses non-JSON data the evidence-pack serializer also refuses', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const withExtra = Object.assign([1], { extra: 1 });
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, 'x', { enumerable: false, value: 1 });
    // eslint-disable-next-line no-sparse-arrays -- the sparse array is the input under test.
    for (const bad of [cyclic, [1, , 3], withExtra, getter, hidden, { [Symbol('s')]: 1 }, new Date(0), { n: Number.NaN },
      { n: Infinity }, { u: undefined }, () => 1, 1n]) {
      expect(canonicalResourceLedgerJson(bad, bounds)).toBeNull();
    }
  });
  it('enforces the byte, container and depth bounds it is given', () => {
    expect(canonicalResourceLedgerJson([1, 2, 3, 4], bounds)).toBe('[1,2,3,4]');
    expect(canonicalResourceLedgerJson([1, 2, 3, 4, 5], bounds)).toBeNull();
    expect(canonicalResourceLedgerJson('x'.repeat(1022), bounds)).toHaveLength(1024);
    expect(canonicalResourceLedgerJson('x'.repeat(1023), bounds)).toBeNull();
    let deep: unknown = 0; for (let depth = 0; depth < 33; depth++) deep = [deep];
    expect(canonicalResourceLedgerJson(deep, { ...bounds, maxBytes: 4096 })).toBeNull();
    expect(canonicalResourceLedgerJson({}, { ...bounds, maxBytes: 0 })).toBeNull();
  });
});
