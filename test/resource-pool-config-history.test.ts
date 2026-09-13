/** Private offline evolution plus pure history bounds; no workers/providers are invoked. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../src/core/foundry/provenance.js';
import { captureResourcePoolConfigHistoryJson } from '../src/core/resources/pool-state-capture.js';
import { resourcePoolConfigSnapshot, validateResourcePoolConfigHistory } from '../src/core/resources/pool-evolution-policy.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import { readResourcePoolHistory, resourcePoolStatus, type ResourceTaskReceipt } from '../src/core/resources/pool-runtime.js';
import type { ResourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-types.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import * as writes from '../src/core/util/private-file-write.js';

function history(padding = 0, firstExtra = 0, lastExtra = 0): ResourcePoolConfigSnapshot[] {
  return Array.from({ length: 16 }, (_, epoch) => {
    const pool: ResourcePool = { schemaVersion: 1, id: 'history', workers: Array.from({ length: epoch + 17 }, (_, index) => ({
      id: 'worker-' + index, provider: 'codex', model: 'fixture', maxConcurrent: 1, reservePercent: 25,
      maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 })) };
    const bindings: ResourceBinding[] = pool.workers.map((worker, index) => {
      const command = ['/inert/' + worker.id, ...Array.from({ length: 31 }, (_, arg) => 'argument-' + arg + '-' + 'x'.repeat(padding))];
      if (index === 0) command[1] += 'x'.repeat(firstExtra);
      if (index === 31) {
        let remaining = lastExtra;
        for (let arg = 1; remaining > 0; arg++) {
          const added = Math.min(remaining, 4096 - command[arg]!.length);
          command[arg] += 'x'.repeat(added); remaining -= added;
        }
      }
      return { workerId: worker.id, capacityKey: worker.id, kind: 'native-cli', command };
    });
    return resourcePoolConfigSnapshot(pool, bindings);
  });
}
function exactHistoryBytes(target: number) {
  const starting = 100;
  const baseBytes = Buffer.byteLength(captureResourcePoolConfigHistoryJson(history(starting)));
  // Each extra padding byte appears in31args across sum(17..32)=392bindings.
  const padding = starting + Math.floor((target - baseBytes) / (31 * 392));
  const gap = target - Buffer.byteLength(captureResourcePoolConfigHistoryJson(history(padding)));
  const firstExtra = Math.max(0, Math.ceil((gap - 7000) / 16));
  return history(padding, firstExtra, gap - firstExtra * 16);
}
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-history-large-'))); roots.push(base);
  const root = join(base, 'ledger'); const workspace = join(base, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const epochs = exactHistoryBytes(2 * 1024 * 1024); const from = epochs[14]!; const to = epochs[15]!; const first = epochs[0]!;
  const at = '2026-01-01T00:00:00.000Z';
  const receipt: ResourceTaskReceipt = { schemaVersion: 1, id: 'historical-task', taskDigest: 'a'.repeat(64),
    poolDigest: first.poolDigest, workerId: 'worker-0', capacityKey: 'worker-0', status: 'completed',
    startedAt: at, finishedAt: at, outputDigest: 'b'.repeat(64), inputTokens: null, outputTokens: null,
    reason: 'worker-completed', verifiedAccepted: false };
  const state = { schemaVersion: 2, poolDigest: from.poolDigest, configurationHistory: epochs.slice(0, 15), observations: [],
    attempts: [receipt], allocation: { ceilingPercent: 75, revision: 4, updatedAt: at },
    workerAccess: { pausedWorkerIds: ['worker-0'], revision: 2, updatedAt: at } };
  const file = join(root, 'pool-state.json'); writeFileSync(file, canonical(state) + '\n', { mode: 0o600 });
  const options = { root, workspace, pool: from.pool, bindings: from.bindings, nextPool: to.pool, nextBindings: to.bindings };
  return { base, root, file, state, receipt, epochs, from, to, options };
}
function fileHashes(root: string): unknown {
  return Object.fromEntries(readdirSync(root).sort().map(name => { const file = join(root, name);
    return [name, statSync(file).isDirectory() ? fileHashes(file) : digest(readFileSync(file))]; }));
}

describe('bounded configuration history', () => {
  it('accepts sixteen additive epochs above both old evidence-pack history limits', () => {
    const rows = history(100); const json = captureResourcePoolConfigHistoryJson(rows);
    expect(Buffer.byteLength(json)).toBeGreaterThan(1024 * 1024);
    expect(canonicalEvidencePackJsonV3(rows)).toBeNull();
    expect(validateResourcePoolConfigHistory(rows)).toEqual(rows);
    expect(captureResourcePoolConfigHistoryJson(rows.slice(0, 1))).toBe(canonicalEvidencePackJsonV3(rows.slice(0, 1)));
    expect(() => validateResourcePoolConfigHistory([...rows, rows.at(-1)])).toThrow('Invalid resource configuration history');
  });
  it('accepts exact2MiB valid history and refuses one extra byte without changing snapshot bounds', () => {
    const target = 2 * 1024 * 1024; const exact = exactHistoryBytes(target);
    expect(Buffer.byteLength(captureResourcePoolConfigHistoryJson(exact))).toBe(target);
    expect(validateResourcePoolConfigHistory(exact)).toEqual(exact);
    const overflow = exactHistoryBytes(target + 1);
    expect(() => validateResourcePoolConfigHistory(overflow)).toThrow('Invalid resource configuration history');
    for (const row of exact) expect(Buffer.byteLength(canonicalEvidencePackJsonV3({ pool: row.pool, bindings: row.bindings })!)).toBeLessThanOrEqual(256 * 1024);
  });
  it.each(['digest', 'duplicate', 'reordered', 'policy', 'binding'] as const)('retains %s refusal after larger capture', change => {
    const rows = history();
    if (change === 'digest') rows[0]!.poolDigest = 'f'.repeat(64);
    if (change === 'duplicate') rows[1] = rows[0]!;
    if (change === 'reordered') [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    if (change === 'policy') {
      const row = rows.at(-1)!; const pool = structuredClone(row.pool); pool.workers[0]!.reservePercent = 0;
      rows[15] = resourcePoolConfigSnapshot(pool, row.bindings);
    }
    if (change === 'binding') {
      const row = rows.at(-1)!; const bindings = structuredClone(row.bindings); bindings[0]!.capacityKey = 'changed';
      rows[15] = resourcePoolConfigSnapshot(row.pool, bindings);
    }
    expect(() => validateResourcePoolConfigHistory(rows)).toThrow();
  });
  it('rejects hostile history before getters or proxy traps are invoked', () => {
    const getter = vi.fn(() => history()[0]); const rows = history();
    const indexed = [...rows]; Object.defineProperty(indexed, '0', { enumerable: true, get: getter });
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    for (const value of [indexed, new Proxy(rows, { get: getter }), Array(16), cyclic,
      Object.assign([...rows], { [Symbol('private')]: true })]) expect(() => validateResourcePoolConfigHistory(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('large-history actual offline migration', () => {
  it.each([false, true])('checks, publishes and exactly replays15→16epochs (interrupted=%s)', interrupted => {
    const f = fixture(); const before = fileHashes(f.base);
    expect(Buffer.byteLength(captureResourcePoolConfigHistoryJson(f.epochs))).toBe(2 * 1024 * 1024);
    const plan = checkResourcePoolEvolution(f.options); expect(plan.historyCount).toBe(16);
    expect(fileHashes(f.base)).toEqual(before);
    if (interrupted) {
      const original = writes.writePrivateFileAtomically; let injected = false;
      const spy = vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
        original(temporary, target, bytes, options);
        if (!injected && target === f.file && String(bytes).includes('pendingEvolution')) {
          injected = true; throw new Error('fixture after durable barrier');
        }
      });
      expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow('fixture after durable barrier');
      spy.mockRestore(); expect(injected).toBe(true);
      expect(() => resourcePoolStatus(f.root, f.to.pool, f.to.bindings, [])).toThrow(/pending/);
      expect(checkResourcePoolEvolution(f.options).planDigest).toBe(plan.planDigest);
    }
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toMatchObject({
      status: 'applied', disposition: interrupted ? 'resumed' : 'created', historyCount: 16, preservedReceiptCount: 1 });
    const status = resourcePoolStatus(f.root, f.to.pool, f.to.bindings, []);
    expect(readFileSync(f.file).byteLength).toBeLessThan(4 * 1024 * 1024);
    expect(status.attempts).toEqual([f.receipt]); expect(status.allocation).toEqual(f.state.allocation);
    expect(status.workerAccess).toEqual(f.state.workerAccess); expect(readResourcePoolHistory(f.root, f.to.pool, f.to.bindings)).toEqual(f.epochs);
    const after = fileHashes(f.base);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    expect(fileHashes(f.base)).toEqual(after);
  }, 30_000);
});
