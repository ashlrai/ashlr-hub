#!/usr/bin/env node
/** Real private-storage benchmark using synthetic receipts; never executes workers. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { URL } from 'node:url';
import { createResourcePoolReceiptArchive, emptyResourcePoolReceiptArchiveRoot } from '../dist/core/resources/pool-receipt-archive.js';
import { resourcePoolConfigSnapshot } from '../dist/core/resources/pool-evolution-policy.js';

const args = process.argv.slice(2);
if (args.length > 1 || args[0] !== undefined &&
    (!/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(args[0]) || String(Number(args[0])) !== args[0])) {
  throw new Error('Usage: node scripts/benchmark-resource-receipt-archive.mjs [receipt-count:1..32]');
}
const count = Number(args[0] ?? 3);
const identity = JSON.parse(readFileSync(new URL('../dist/build-identity.json', import.meta.url), 'utf8'));
const anchorPath = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-archive-benchmark-')));
const metrics = { stage: [], coldGet: [], getMany: [], accountWindow: [], page: [], replay: [] };
let report;
function measure(name, operation) {
  const start = performance.now();
  const value = operation();
  metrics[name].push(performance.now() - start);
  return value;
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = value => Math.round(value * 1000) / 1000;
  return { samples: sorted.length, minMs: round(sorted[0]),
    p50Ms: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: round(sorted.at(-1)) };
}
try {
  chmodSync(anchorPath, 0o700);
  const root = join(anchorPath, 'archive'); mkdirSync(root, { mode: 0o700 });
  const pool = { schemaVersion: 1, id: 'benchmark', workers: [{ id: 'local', provider: 'local', model: 'inert',
    priority: 1, maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 64, taskWindowMs: 60_000 }] };
  const bindings = [{ workerId: 'local', capacityKey: 'account', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
  const epoch = resourcePoolConfigSnapshot(pool, bindings);
  const config = { root, anchorPath, configurationHistory: [epoch] };
  const store = createResourcePoolReceiptArchive(config);
  const empty = emptyResourcePoolReceiptArchiveRoot();
  let commitment = empty;
  const now = Date.parse('2026-01-01T00:00:30.000Z');
  const receipts = Array.from({ length: count }, (_, index) => ({ schemaVersion: 1, id: `receipt-${index}`,
    taskDigest: '1'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'local', capacityKey: 'account',
    status: index % 2 ? 'failed' : 'completed', startedAt: new Date(now - count + index).toISOString(),
    finishedAt: new Date(now + index).toISOString(), outputDigest: '2'.repeat(64), inputTokens: 1, outputTokens: 1,
    reason: index % 2 ? 'worker-failed' : 'worker-completed', verifiedAccepted: false }));
  for (const receipt of receipts) {
    const staged = measure('stage', () => store.stage(commitment, receipt, { guard() {} }));
    assert.equal(staged.replayed, false); commitment = staged.root;
  }
  assert.equal(store.get(empty, receipts[0].id).status, 'proven-absent');
  for (const receipt of receipts) {
    // Reconstruct the store for every point lookup; no long-lived handle warmth.
    const found = measure('coldGet', () => createResourcePoolReceiptArchive(config).get(commitment, receipt.id));
    assert.equal(found.status, 'found'); assert.deepEqual(found.receipt, receipt);
  }
  const ids = receipts.map(row => row.id);
  const joined = measure('getMany', () => store.getMany(commitment, [...ids, ids[0], 'missing']));
  assert.deepEqual(joined.map(row => row.status), [...ids.map(() => 'found'), 'found', 'proven-absent']);
  assert.deepEqual(joined.map(row => row.id), [...ids, ids[0], 'missing']);
  assert.deepEqual(joined.slice(0, -1).map(row => row.receipt), [...receipts, receipts[0]]);
  const window = measure('accountWindow', () => store.accountWindow(commitment, 'account', 60_000, now));
  assert.equal(window.recentReservationCount, count); assert.equal(window.inFlightCount, 0);
  assert.equal(window.earliestRecentStartedAtMs, now - count);
  assert.equal(window.latestCooldownFailureFinishedAtMs, count < 2 ? null : now + (count % 2 ? count - 2 : count - 1));
  const page = measure('page', () => store.page(commitment, { limit: 32 }));
  assert.equal(page.items.length, count); assert.equal(page.totalReceipts, count); assert.equal(page.nextAfterId, null);
  assert.deepEqual(page.items, [...receipts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const replay = measure('replay', () => store.stage(commitment, receipts[0], { guard() {} }));
  assert.equal(replay.replayed, true); assert.deepEqual(replay.root, commitment);
  report = { schemaVersion: 1, benchmark: 'terminal-receipt-archive',
    buildIdentity: identity, platform: process.platform, node: process.version, syntheticReceipts: count,
    workerExecutions: 0, ledgerRootActivated: false, percentileMethod: 'nearest-rank; small samples are descriptive only',
    measurementScope: 'stage samples grow the archive from 1 to N; coldGet reopens the handle, not the OS cache; no index splits',
    operations: Object.fromEntries(Object.entries(metrics).map(([name, samples]) => [name, summary(samples)])) };
} finally {
  // This exact directory was freshly created above; never accepts a user path.
  rmSync(anchorPath, { recursive: true, force: true });
}
// Emit success only after the exact fixture directory has been removed.
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
