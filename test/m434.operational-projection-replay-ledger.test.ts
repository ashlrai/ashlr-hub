import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateStorageHarness = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; kind: string; mode: string }>,
  rejectInspectFor: new Set<string>(),
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32') {
        privateStorageHarness.calls.push({ path: args[0], kind: args[1], mode: args[2] });
        if (args[2] === 'inspect-existing' && privateStorageHarness.rejectInspectFor.delete(args[0])) {
          return { ok: false, reason: 'dacl-not-protected' };
        }
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      return actual.assurePrivateStoragePath(...args);
    },
  };
});

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  operationalProjectionReplayLedgerPath,
  operationalProjectionReplayLedgerDir,
  readOperationalProjectionReplayLedger,
  recordOperationalProjectionReplay,
  verifyOperationalProjectionReplay,
} from '../src/core/inbox/operational-projection-replay-ledger.js';
import {
  advanceOperationalProjectionTransactionJournalOnly,
  operationalProjectionTransactionPath,
  prepareOperationalProjectionTransactionJournalOnly,
  type OperationalProjectionTransactionV1,
} from '../src/core/inbox/operational-projection-transaction.js';
import {
  advanceOperationalProjectionTransaction,
  prepareOperationalProjectionTransaction,
} from '../src/core/inbox/operational-projection-transaction-coordinator.js';
import { operationalProposalProjectionDir } from '../src/core/inbox/operational-projection.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const NOW = new Date('2026-07-16T19:00:00.000Z');
let home: string;
let lock: ProposalStoreMutationLock | null;

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function acquire(): ProposalStoreMutationLock {
  lock = acquireProposalStoreMutationLock();
  expect(lock).not.toBeNull();
  return lock!;
}

function prepare(): OperationalProjectionTransactionV1 {
  const result = prepareOperationalProjectionTransactionJournalOnly({
    proposalId: 'proposal-434',
    before: { proposal: '1'.repeat(64), projection: '2'.repeat(64) },
    after: { proposal: '3'.repeat(64), projection: '4'.repeat(64) },
    storeLock: acquire(),
    now: NOW,
  });
  expect(result.state).toBe('healthy');
  return result.state === 'healthy' ? result.transaction : (null as never);
}

beforeEach(() => {
  lock = null;
  privateStorageHarness.calls.length = 0;
  privateStorageHarness.rejectInspectFor.clear();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m434-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  loadOrCreateKey();
  fs.mkdirSync(operationalProposalProjectionDir(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(operationalProposalProjectionDir(), 0o700);
});

afterEach(() => {
  releaseProposalStoreMutationLock(lock);
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
});

describe('M434 operational projection host-local replay ledger', () => {
  it('is read-only when missing', () => {
    expect(readOperationalProjectionReplayLedger()).toEqual({ state: 'missing', latest: null, root: null });
    expect(fs.existsSync(operationalProjectionReplayLedgerPath())).toBe(false);
  });

  it('records every exact phase and rejects replay of an older valid transaction record', () => {
    let transaction = prepare();
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW)).toMatchObject({
      state: 'healthy',
      latest: { phase: 'prepared', sequence: 1 },
      root: { rollbackProtected: false, historicalAuthority: false },
    });
    const preparedSnapshot = transaction;
    for (const phase of ['proposal-installed', 'projection-installed', 'committed'] as const) {
      const advanced = advanceOperationalProjectionTransactionJournalOnly(transaction.transactionId, phase, lock!, NOW);
      expect(advanced.state).toBe('healthy');
      if (advanced.state !== 'healthy') return;
      transaction = advanced.transaction;
      expect(recordOperationalProjectionReplay(transaction, lock!, NOW)).toMatchObject({
        state: 'healthy', latest: { phase },
      });
    }
    expect(verifyOperationalProjectionReplay()).toEqual({
      verdict: 'consistent-with-local-ledger',
      rollbackProtected: false,
      historicalAuthority: false,
    });
    fs.writeFileSync(
      operationalProjectionTransactionPath(),
      `${JSON.stringify(preparedSnapshot)}\n`,
    );
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'transaction-replayed',
      rollbackProtected: false,
      historicalAuthority: false,
    });
  });

  it('repairs a one-phase crash gap before permitting the next coordinated advance', () => {
    const prepared = prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-coordinated',
      before: { proposal: '1'.repeat(64), projection: '2'.repeat(64) },
      after: { proposal: '3'.repeat(64), projection: '4'.repeat(64) },
      storeLock: acquire(),
      now: NOW,
    });
    expect(prepared.state).toBe('healthy');
    if (prepared.state !== 'healthy') return;
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'consistent-with-local-ledger',
    });

    const journalOnly = advanceOperationalProjectionTransactionJournalOnly(
      prepared.transaction.transactionId,
      'proposal-installed',
      lock!,
      NOW,
    );
    expect(journalOnly.state).toBe('healthy');
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'transaction-ahead-of-ledger',
    });

    const coordinated = advanceOperationalProjectionTransaction(
      prepared.transaction.transactionId,
      'projection-installed',
      lock!,
      NOW,
    );
    expect(coordinated).toMatchObject({
      state: 'healthy', transaction: { phase: 'projection-installed' },
    });
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'consistent-with-local-ledger',
    });
  });

  it('does not treat changed V2 staged metadata as the same prepared intent', () => {
    const before = { proposal: '1'.repeat(64), projection: '2'.repeat(64) };
    const after = { proposal: '3'.repeat(64), projection: '4'.repeat(64) };
    const first = prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-v2', before, after,
      staged: {
        proposal: { present: true, digest: after.proposal, bytes: 1 },
        projection: { present: true, digest: after.projection, bytes: 1 },
      },
      storeLock: acquire(), now: NOW,
    });
    expect(first).toMatchObject({ state: 'healthy', transaction: { schemaVersion: 2 } });
    expect(prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-v2', before, after,
      staged: {
        proposal: { present: true, digest: after.proposal, bytes: 2 },
        projection: { present: true, digest: after.projection, bytes: 1 },
      },
      storeLock: lock!, now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-already-active' });
  });

  it('repairs a committed predecessor before preparing its successor', () => {
    const first = prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-first',
      before: { proposal: '1'.repeat(64), projection: '2'.repeat(64) },
      after: { proposal: '3'.repeat(64), projection: '4'.repeat(64) },
      storeLock: acquire(),
      now: NOW,
    });
    expect(first.state).toBe('healthy');
    if (first.state !== 'healthy') return;
    for (const phase of ['proposal-installed', 'projection-installed'] as const) {
      expect(advanceOperationalProjectionTransaction(
        first.transaction.transactionId, phase, lock!, NOW,
      ).state).toBe('healthy');
    }
    expect(advanceOperationalProjectionTransactionJournalOnly(
      first.transaction.transactionId, 'committed', lock!, NOW,
    ).state).toBe('healthy');
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'transaction-ahead-of-ledger',
    });

    const second = prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-second',
      before: { proposal: '5'.repeat(64), projection: '6'.repeat(64) },
      after: { proposal: '7'.repeat(64), projection: '8'.repeat(64) },
      storeLock: lock!,
      now: NOW,
    });
    expect(second).toMatchObject({ state: 'healthy', transaction: { phase: 'prepared' } });
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'consistent-with-local-ledger',
    });
  });

  it('repairs a new prepared identity before its first coordinated advance', () => {
    const first = prepareOperationalProjectionTransaction({
      proposalId: 'proposal-434-prior',
      before: { proposal: '1'.repeat(64), projection: '2'.repeat(64) },
      after: { proposal: '3'.repeat(64), projection: '4'.repeat(64) },
      storeLock: acquire(),
      now: NOW,
    });
    expect(first.state).toBe('healthy');
    if (first.state !== 'healthy') return;
    for (const phase of ['proposal-installed', 'projection-installed', 'committed'] as const) {
      expect(advanceOperationalProjectionTransaction(
        first.transaction.transactionId, phase, lock!, NOW,
      ).state).toBe('healthy');
    }
    const second = prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-434-new-gap',
      before: { proposal: '5'.repeat(64), projection: '6'.repeat(64) },
      after: { proposal: '7'.repeat(64), projection: '8'.repeat(64) },
      storeLock: lock!,
      now: NOW,
    });
    expect(second.state).toBe('healthy');
    if (second.state !== 'healthy') return;
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'transaction-identity-mismatch',
    });

    expect(advanceOperationalProjectionTransaction(
      second.transaction.transactionId, 'proposal-installed', lock!, NOW,
    )).toMatchObject({ state: 'healthy', transaction: { phase: 'proposal-installed' } });
    expect(verifyOperationalProjectionReplay()).toMatchObject({
      verdict: 'consistent-with-local-ledger',
    });
  });

  it('fails closed for phase skips, new lineage before commit, and foreign locks', () => {
    const transaction = prepare();
    const foreign = { token: Symbol('foreign') } as ProposalStoreMutationLock;
    expect(recordOperationalProjectionReplay(transaction, foreign, NOW)).toMatchObject({ state: 'degraded' });
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW).state).toBe('healthy');
    const skipped = { ...transaction, phase: 'projection-installed' as const, attestation: '5'.repeat(64) };
    expect(recordOperationalProjectionReplay(skipped, lock!, NOW)).toMatchObject({
      state: 'degraded', reason: 'replay-ledger-transaction-mismatch',
    });
    const other = { ...transaction, transactionId: '6'.repeat(64), attestation: '7'.repeat(64) };
    expect(recordOperationalProjectionReplay(other, lock!, NOW)).toMatchObject({
      state: 'degraded', reason: 'replay-ledger-transaction-mismatch',
    });
  });

  it('will not create replay storage for a fabricated or stale caller record', () => {
    const transaction = prepare();
    const fabricated = {
      ...transaction,
      before: { ...transaction.before, proposal: '8'.repeat(64) },
    };
    expect(recordOperationalProjectionReplay(fabricated, lock!, NOW)).toEqual({
      state: 'degraded', reason: 'replay-ledger-transaction-mismatch', latest: null, root: null,
    });
    expect(fs.existsSync(operationalProjectionReplayLedgerPath())).toBe(false);
    expect(() => recordOperationalProjectionReplay(
      { ...transaction, before: null } as unknown as OperationalProjectionTransactionV1,
      lock!,
      NOW,
    )).not.toThrow();
  });

  it('rejects transaction and replay-ledger clock rollback', () => {
    let transaction = prepare();
    const future = new Date(NOW.getTime() + 2_000);
    expect(recordOperationalProjectionReplay(transaction, lock!, future).state).toBe('healthy');
    const advanced = advanceOperationalProjectionTransactionJournalOnly(
      transaction.transactionId,
      'proposal-installed',
      lock!,
      new Date(NOW.getTime() + 1_000),
    );
    expect(advanced.state).toBe('healthy');
    if (advanced.state !== 'healthy') return;
    transaction = advanced.transaction;
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW)).toEqual({
      state: 'degraded', reason: 'replay-ledger-clock-invalid', latest: null, root: null,
    });
  });

  it('detects state truncation, root tamper, and trailing garbage', () => {
    let transaction = prepare();
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW).state).toBe('healthy');
    const advanced = advanceOperationalProjectionTransactionJournalOnly(
      transaction.transactionId, 'proposal-installed', lock!, NOW,
    );
    expect(advanced.state).toBe('healthy');
    if (advanced.state !== 'healthy') return;
    transaction = advanced.transaction;
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW).state).toBe('healthy');
    const stateBytes = fs.readFileSync(operationalProjectionReplayLedgerPath());

    fs.appendFileSync(operationalProjectionReplayLedgerPath(), '{}\n');
    expect(readOperationalProjectionReplayLedger()).toMatchObject({ state: 'degraded' });
    fs.writeFileSync(operationalProjectionReplayLedgerPath(), stateBytes);

    const tampered = JSON.parse(stateBytes.toString('utf8')) as {
      rows: unknown[];
      root: Record<string, unknown>;
    };
    tampered.root['rowCount'] = Number(tampered.root['rowCount']) - 1;
    fs.writeFileSync(operationalProjectionReplayLedgerPath(), `${JSON.stringify(tampered)}\n`);
    expect(readOperationalProjectionReplayLedger()).toMatchObject({ state: 'degraded' });

    const truncated = JSON.parse(stateBytes.toString('utf8')) as {
      rows: unknown[];
      root: Record<string, unknown>;
    };
    truncated.rows = truncated.rows.slice(0, 1);
    fs.writeFileSync(operationalProjectionReplayLedgerPath(), `${JSON.stringify(truncated)}\n`);
    expect(readOperationalProjectionReplayLedger()).toMatchObject({ state: 'degraded' });
  });

  it('makes coherent whole-state rollback explicit instead of claiming external authority', () => {
    let transaction = prepare();
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW).state).toBe('healthy');
    const oldLedger = fs.readFileSync(operationalProjectionReplayLedgerPath());
    const oldTransaction = fs.readFileSync(operationalProjectionTransactionPath());
    const advanced = advanceOperationalProjectionTransactionJournalOnly(
      transaction.transactionId, 'proposal-installed', lock!, NOW,
    );
    expect(advanced.state).toBe('healthy');
    if (advanced.state !== 'healthy') return;
    transaction = advanced.transaction;
    expect(recordOperationalProjectionReplay(transaction, lock!, NOW).state).toBe('healthy');

    fs.writeFileSync(operationalProjectionReplayLedgerPath(), oldLedger);
    fs.writeFileSync(operationalProjectionTransactionPath(), oldTransaction);
    expect(readOperationalProjectionReplayLedger()).toMatchObject({
      state: 'healthy',
      root: { rollbackProtected: false, historicalAuthority: false },
    });
    expect(verifyOperationalProjectionReplay()).toEqual({
      verdict: 'consistent-with-local-ledger',
      rollbackProtected: false,
      historicalAuthority: false,
    });
  });

  it.runIf(process.platform !== 'win32')('writes an exact private state file', () => {
    expect(recordOperationalProjectionReplay(prepare(), lock!, NOW).state).toBe('healthy');
    expect(fs.statSync(operationalProjectionReplayLedgerPath()).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('exact-assures the created replay state DACL', () => {
    expect(recordOperationalProjectionReplay(prepare(), lock!, NOW).state).toBe('healthy');
    expect(privateStorageHarness.calls).toContainEqual({
      path: path.dirname(operationalProjectionReplayLedgerPath()),
      kind: 'directory',
      mode: 'secure-created',
    });
    expect(privateStorageHarness.calls).toContainEqual({
      path: operationalProjectionReplayLedgerPath(), kind: 'file', mode: 'secure-created',
    });
  });

  it.runIf(process.platform === 'win32')('recovers an empty directory left before ACL hardening', () => {
    fs.mkdirSync(operationalProjectionReplayLedgerDir(), { recursive: true });
    privateStorageHarness.rejectInspectFor.add(operationalProjectionReplayLedgerDir());
    expect(recordOperationalProjectionReplay(prepare(), lock!, NOW).state).toBe('healthy');
    expect(privateStorageHarness.calls).toContainEqual({
      path: operationalProjectionReplayLedgerDir(), kind: 'directory', mode: 'secure-created',
    });
  });
});
