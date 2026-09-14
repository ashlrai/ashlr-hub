/** Explicit fixture keys and synthetic receipts only; no live authority enrollment. */
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolReceiptArchiveCertifier, type ResourcePoolReceiptArchiveCertificate } from '../src/core/resources/pool-receipt-archive-certificate.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import type { ResourceTaskReceipt } from '../src/core/resources/pool-receipt-codec.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const pool: ResourcePool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'worker', provider: 'codex', model: 'fixture',
  maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
const bindings: ResourceBinding[] = [{ workerId: 'worker', capacityKey: 'account', kind: 'native-cli', command: ['/inert/worker'] }];
const epoch = resourcePoolConfigSnapshot(pool, bindings);
const nextPool = { ...pool, workers: [...pool.workers, { ...pool.workers[0]!, id: 'second' }] };
const nextBindings: ResourceBinding[] = [...bindings, { workerId: 'second', capacityKey: 'second-account', kind: 'native-cli', command: ['/inert/second'] }];
const nextEpoch = resourcePoolConfigSnapshot(nextPool, nextBindings);
const row = (patch: Partial<ResourceTaskReceipt> = {}): ResourceTaskReceipt => ({ schemaVersion: 1, id: 'task',
  taskDigest: 'a'.repeat(64), poolDigest: epoch.poolDigest, workerId: 'worker', capacityKey: 'account', status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', outputDigest: 'b'.repeat(64),
  inputTokens: null, outputTokens: null, reason: 'worker-completed', verifiedAccepted: false, ...patch });
const sourceStateDigest = 'c'.repeat(64); const noGuard = { guard() {} };
const roots: string[] = [];
function fixture() {
  const anchorPath = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-certificate-'))); roots.push(anchorPath); chmodSync(anchorPath, 0o700);
  const root = join(anchorPath, 'archive'); mkdirSync(root, { mode: 0o700 }); const keyFile = join(anchorPath, 'archive.key');
  writeFileSync(keyFile, '11'.repeat(32) + '\n', { mode: 0o600 });
  const config = { root, anchorPath, keyFile, poolId: pool.id, configurationHistory: [epoch] };
  return { ...config, config, open: () => createResourcePoolReceiptArchiveCertifier(config) };
}
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(row => row.isDirectory() ? files(join(path, row.name)) : [join(path, row.name)]);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('explicit-key receipt archive derivation certificates', () => {
  it('certifies empty genesis without creating archive nodes or selecting a ledger root', () => {
    const f = fixture(); const certifier = f.open(); const certificate = certifier.derive({ previous: null, sourceStateDigest, receipts: [] }, noGuard);
    expect(certificate).toMatchObject({ sequence: 0, priorCertificateDigest: null, receiptDigests: [], archiveRoot: { byId: { count: 0 } } });
    expect(f.open().verify(certificate)).toEqual(certificate); expect(readdirSync(f.root)).toEqual([]);
    expect(readdirSync(f.anchorPath).sort()).toEqual(['archive', 'archive.key']);
    expect(() => certifier.derive({ previous: certificate, sourceStateDigest, receipts: [] }, noGuard)).toThrow('certificate unavailable');
    expect(() => certifier.verify({ ...certificate, provenanceSig: certificate.provenanceSig + '\n' })).toThrow('certificate unavailable');
    expect(() => certifier.derive({ previous: null, sourceStateDigest: sourceStateDigest + '\n', receipts: [] }, noGuard)).toThrow('certificate unavailable');
  });
  it('derives real terminal storage and refuses omitted failures, cross-index/root/source/history tampering', () => {
    const f = fixture(); const certifier = f.open();
    const certificate = certifier.derive({ previous: null, sourceStateDigest, receipts: [row({ status: 'failed', outputDigest: null })] }, noGuard);
    expect(certificate.archiveRoot.latestFailures).toHaveLength(1);
    expect(f.open().verify(certificate)).toEqual(certificate);
    const changes: Array<(value: ResourcePoolReceiptArchiveCertificate) => void> = [
      value => { value.archiveRoot.latestFailures = []; }, value => { value.archiveRoot.byStart = { schemaVersion: 1, nodeDigest: null, count: 0, height: 0 }; },
      value => { value.sourceStateDigest = 'd'.repeat(64); }, value => { value.configurationHistoryDigest = 'e'.repeat(64); },
      value => { value.receiptDigests[0]!.payloadDigest = 'e'.repeat(64); }, value => { value.keyId = 'f'.repeat(64); },
      value => { value.sequence = 1; value.priorCertificateDigest = 'f'.repeat(64); },
    ];
    for (const change of changes) { const mutated = structuredClone(certificate); change(mutated); expect(() => certifier.verify(mutated)).toThrow('certificate unavailable'); }
    expect(Object.keys(certifier).sort()).toEqual(['derive', 'verify']);
  });
  it('preserves prior certificates across additive epochs, exact replay and detached caller mutation', () => {
    const f = fixture(); const first = f.open().derive({ previous: null, sourceStateDigest, receipts: [row()] }, noGuard);
    const later = createResourcePoolReceiptArchiveCertifier({ ...f.config, configurationHistory: [epoch, nextEpoch] });
    expect(later.verify(first)).toEqual(first);
    const request = { previous: first, sourceStateDigest, receipts: [row({ id: 'second', poolDigest: nextEpoch.poolDigest, workerId: 'second', capacityKey: 'second-account' })] };
    const second = later.derive(request, { guard() { request.receipts[0]!.id = 'mutated'; } });
    expect(second).toMatchObject({ sequence: 1, configurationCount: 2, archiveRoot: { byId: { count: 2 } }, receiptDigests: [{ id: 'second' }] });
    expect(() => f.open().verify(second)).toThrow('certificate unavailable');
    const replay = later.derive({ previous: second, sourceStateDigest, receipts: [row()] }, noGuard);
    expect(replay.archiveRoot).toEqual(second.archiveRoot); expect(replay.sequence).toBe(2);
    expect(later.verify(first)).toEqual(first); // Certificate validity is not antirollback/root selection.
    expect(() => later.derive({ previous: second, sourceStateDigest, receipts: [row({ taskDigest: 'f'.repeat(64) })] }, noGuard)).toThrow();
  });
  it.each(['missing', 'hardlink', 'symlink', 'mode', 'parent-mode', 'malformed'] as const)('refuses %s key custody without repairing it', mode => {
    const f = fixture();
    if (mode === 'missing') unlinkSync(f.keyFile);
    if (mode === 'hardlink') linkSync(f.keyFile, f.keyFile + '-alias');
    if (mode === 'symlink') { renameSync(f.keyFile, f.keyFile + '-original'); symlinkSync(f.keyFile + '-original', f.keyFile); }
    if (mode === 'mode') chmodSync(f.keyFile, 0o644);
    if (mode === 'parent-mode') chmodSync(f.anchorPath, 0o755);
    if (mode === 'malformed') writeFileSync(f.keyFile, 'x'.repeat(64) + '\n');
    const names = readdirSync(f.anchorPath); expect(() => f.open()).toThrow('certificate unavailable');
    expect(readdirSync(f.anchorPath)).toEqual(names); expect(readdirSync(f.root)).toEqual([]);
  });
  it('rejects unrelated keys and cross-ledger replay even with identical key bytes', () => {
    const f = fixture(); const certificate = f.open().derive({ previous: null, sourceStateDigest, receipts: [] }, noGuard);
    const other = fixture(); expect(() => other.open().verify(certificate)).toThrow('certificate unavailable');
    writeFileSync(f.keyFile, '22'.repeat(32) + '\n'); expect(() => f.open().verify(certificate)).toThrow('certificate unavailable');
  });
  it.each(['replace', 'rewrite', 'delete'] as const)('refuses key %s during a guard and leaves no certificate/root activation', mode => {
    const f = fixture(); const certifier = f.open();
    expect(() => certifier.derive({ previous: null, sourceStateDigest, receipts: [] }, { guard() {
      if (mode === 'replace') { renameSync(f.keyFile, f.keyFile + '-old'); writeFileSync(f.keyFile, '11'.repeat(32) + '\n', { mode: 0o600 }); }
      if (mode === 'rewrite') writeFileSync(f.keyFile, '22'.repeat(32) + '\n');
      if (mode === 'delete') unlinkSync(f.keyFile);
    } })).toThrow('certificate unavailable');
    expect(readdirSync(f.root)).toEqual([]);
  });
  it('refuses active/duplicate/oversized/accessor batches before host callbacks', () => {
    const f = fixture(); const certifier = f.open(); const guard = vi.fn(); const getter = vi.fn();
    for (const receipts of [[row({ status: 'reserved', finishedAt: null, outputDigest: null })], [row({ status: 'uncertain', outputDigest: null })],
      [row(), row()], Array.from({ length: 9 }, (_, index) => row({ id: 'task-' + index })),
      [Object.defineProperty(row(), 'id', { enumerable: true, get: getter })]]) {
      expect(() => certifier.derive({ previous: null, sourceStateDigest, receipts }, { guard })).toThrow('certificate unavailable');
    }
    expect(guard).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(readdirSync(f.root)).toEqual([]);
  });
  it('rechecks selected payloads after the final source guard before signing', () => {
    const f = fixture(); const certifier = f.open(); const first = certifier.derive({ previous: null, sourceStateDigest, receipts: [row()] }, noGuard);
    let count = 0; certifier.derive({ previous: first, sourceStateDigest, receipts: [row()] }, { guard() { count++; } });
    let calls = 0;
    expect(() => certifier.derive({ previous: first, sourceStateDigest, receipts: [row()] }, { guard() {
      if (++calls === count) unlinkSync(files(f.root).find(file => file.includes('/records/'))!);
    } })).toThrow('certificate unavailable');
    expect(calls).toBe(count); expect(() => certifier.verify(first)).toThrow('certificate unavailable');
  });
});
