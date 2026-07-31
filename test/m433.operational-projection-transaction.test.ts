import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateStorageHarness = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; mode: string }>,
  refuseDirectory: false,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32') {
        privateStorageHarness.calls.push({ kind: args[1], mode: args[2] });
        if (privateStorageHarness.refuseDirectory && args[1] === 'directory') {
          return { ok: false, reason: 'unsafe-test-directory' };
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

import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import {
  advanceOperationalProjectionTransactionJournalOnly,
  classifyOperationalProjectionRecovery,
  operationalProjectionTransactionPath,
  prepareOperationalProjectionTransactionJournalOnly,
  readOperationalProjectionTransaction,
} from '../src/core/inbox/operational-projection-transaction.js';
import { operationalProposalProjectionDir } from '../src/core/inbox/operational-projection.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const BEFORE = { proposal: '1'.repeat(64), projection: '2'.repeat(64) };
const AFTER = { proposal: '3'.repeat(64), projection: '4'.repeat(64) };
const NOW = new Date('2026-07-16T18:00:00.000Z');

let home: string;
let lock: ProposalStoreMutationLock | null;

function restore(name: 'HOME' | 'USERPROFILE', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function acquire(): ProposalStoreMutationLock {
  lock = acquireProposalStoreMutationLock();
  expect(lock).not.toBeNull();
  return lock!;
}

function prepare() {
  return prepareOperationalProjectionTransactionJournalOnly({
    proposalId: 'proposal-433',
    before: BEFORE,
    after: AFTER,
    storeLock: acquire(),
    now: NOW,
  });
}

beforeEach(() => {
  lock = null;
  privateStorageHarness.calls.length = 0;
  privateStorageHarness.refuseDirectory = false;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m433-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(fs.readdirSync(home)).toEqual([]);
  loadOrCreateKey();
});

afterEach(() => {
  releaseProposalStoreMutationLock(lock);
  lock = null;
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
});

describe('M433 operational projection transaction journal', () => {
  it('reads a missing journal without creating storage', () => {
    fs.rmSync(path.join(home, '.ashlr'), { recursive: true, force: true });
    expect(readOperationalProjectionTransaction()).toEqual({
      state: 'missing', transaction: null,
    });
    expect(fs.existsSync(path.join(home, '.ashlr'))).toBe(false);
    expect(fs.existsSync(operationalProjectionTransactionPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses an unsafe existing projection directory', () => {
    fs.mkdirSync(operationalProposalProjectionDir(), { mode: 0o755 });
    fs.chmodSync(operationalProposalProjectionDir(), 0o755);
    expect(readOperationalProjectionTransaction()).toEqual({
      state: 'degraded',
      reason: 'transaction-directory-unsafe',
      transaction: null,
    });
    expect(prepare()).toEqual({
      state: 'degraded',
      reason: 'transaction-directory-unsafe',
      transaction: null,
    });
    expect(fs.existsSync(operationalProjectionTransactionPath())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses an unsafe private root before creating transaction storage', () => {
    const storeLock = acquire();
    const root = path.join(home, '.ashlr');
    fs.chmodSync(root, 0o755);
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433', before: BEFORE, after: AFTER, storeLock, now: NOW,
    })).toEqual({
      state: 'degraded',
      reason: 'transaction-directory-unsafe',
      transaction: null,
    });
    expect(fs.existsSync(operationalProposalProjectionDir())).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('invalidates the writer lock when the private root becomes a symlink', () => {
    const storeLock = acquire();
    const root = path.join(home, '.ashlr');
    const redirected = path.join(home, 'redirected-ashlr');
    fs.renameSync(root, redirected);
    fs.symlinkSync(redirected, root, 'dir');
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433', before: BEFORE, after: AFTER, storeLock, now: NOW,
    })).toEqual({
      state: 'degraded',
      reason: 'transaction-input-invalid',
      transaction: null,
    });
    expect(fs.existsSync(path.join(redirected, 'proposal-projection'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked projection parent', () => {
    const redirected = path.join(home, 'redirected-projection');
    fs.mkdirSync(redirected, { mode: 0o700 });
    fs.symlinkSync(redirected, operationalProposalProjectionDir(), 'dir');
    expect(prepare()).toEqual({
      state: 'degraded',
      reason: 'transaction-directory-unsafe',
      transaction: null,
    });
    expect(fs.existsSync(path.join(redirected, 'active-transaction.json'))).toBe(false);
  });

  it('creates and assures the private projection directory on first prepare', () => {
    expect(fs.existsSync(operationalProposalProjectionDir())).toBe(false);
    expect(prepare()).toMatchObject({
      state: 'healthy', transaction: { phase: 'prepared', proposalId: 'proposal-433' },
    });
    const stat = fs.lstatSync(operationalProposalProjectionDir());
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === 'win32')('refuses an existing parent that fails private ACL assurance', () => {
    fs.mkdirSync(operationalProposalProjectionDir(), { mode: 0o700 });
    privateStorageHarness.refuseDirectory = true;
    expect(prepare()).toEqual({
      state: 'degraded',
      reason: 'transaction-directory-unsafe',
      transaction: null,
    });
    expect(fs.existsSync(operationalProjectionTransactionPath())).toBe(false);
  });

  it('persists a private authenticated prepare and monotonic phases', () => {
    const prepared = prepare();
    expect(prepared).toMatchObject({
      state: 'healthy', transaction: { phase: 'prepared', proposalId: 'proposal-433' },
    });
    if (prepared.state !== 'healthy') return;
    const id = prepared.transaction.transactionId;
    for (const phase of ['proposal-installed', 'projection-installed', 'committed'] as const) {
      expect(advanceOperationalProjectionTransactionJournalOnly(id, phase, lock!, NOW)).toMatchObject({
        state: 'healthy', transaction: { transactionId: id, phase },
      });
    }
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'healthy', transaction: { transactionId: id, phase: 'committed' },
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(operationalProjectionTransactionPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses phase skips, rollback, foreign identity, and a second live transaction', () => {
    const prepared = prepare();
    expect(prepared.state).toBe('healthy');
    if (prepared.state !== 'healthy') return;
    const id = prepared.transaction.transactionId;
    expect(advanceOperationalProjectionTransactionJournalOnly(id, 'projection-installed', lock!, NOW))
      .toMatchObject({ state: 'degraded', reason: 'transaction-phase-invalid' });
    expect(advanceOperationalProjectionTransactionJournalOnly('f'.repeat(64), 'proposal-installed', lock!, NOW))
      .toMatchObject({ state: 'degraded', reason: 'transaction-identity-mismatch' });
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-other', before: BEFORE, after: AFTER, storeLock: lock!, now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-already-active' });
    expect(advanceOperationalProjectionTransactionJournalOnly(id, 'proposal-installed', lock!, NOW).state).toBe('healthy');
    expect(advanceOperationalProjectionTransactionJournalOnly(id, 'prepared', lock!, NOW))
      .toMatchObject({ state: 'degraded', reason: 'transaction-phase-invalid' });
    expect(advanceOperationalProjectionTransactionJournalOnly(
      id,
      'projection-installed',
      lock!,
      new Date('2026-07-16T17:59:59.999Z'),
    )).toMatchObject({ state: 'degraded', reason: 'transaction-phase-invalid' });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'healthy', transaction: { phase: 'proposal-installed' },
    });
    expect(advanceOperationalProjectionTransactionJournalOnly(id, 'committed', lock!, NOW))
      .toMatchObject({ state: 'degraded', reason: 'transaction-phase-invalid' });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'healthy', transaction: { phase: 'proposal-installed' },
    });
  });

  it('fails closed for record tamper and key replacement', () => {
    expect(prepare().state).toBe('healthy');
    const target = operationalProjectionTransactionPath();
    const original = fs.readFileSync(target, 'utf8');
    const record = JSON.parse(original) as Record<string, unknown>;
    record['phase'] = 'committed';
    fs.writeFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'degraded', reason: 'transaction-integrity-failed',
    });

    fs.writeFileSync(target, original, { mode: 0o600 });
    const digestTamper = JSON.parse(original) as {
      before: { proposal: string };
    };
    digestTamper.before.proposal = 'a'.repeat(64);
    fs.writeFileSync(target, `${JSON.stringify(digestTamper)}\n`, { mode: 0o600 });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'degraded', reason: 'transaction-integrity-failed',
    });

    fs.writeFileSync(target, original, { mode: 0o600 });
    fs.writeFileSync(provenanceKeyPath(), Buffer.alloc(32, 9), { mode: 0o600 });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'degraded', reason: 'transaction-key-generation-mismatch',
    });
  });

  it('classifies every crash boundary without inferring from phase or time', () => {
    const transaction = { before: BEFORE, after: AFTER };
    expect(classifyOperationalProjectionRecovery(transaction, BEFORE)).toBe('no-effect');
    expect(classifyOperationalProjectionRecovery(transaction, {
      proposal: AFTER.proposal, projection: BEFORE.projection,
    })).toBe('proposal-only');
    expect(classifyOperationalProjectionRecovery(transaction, {
      proposal: BEFORE.proposal, projection: AFTER.projection,
    })).toBe('projection-only');
    expect(classifyOperationalProjectionRecovery(transaction, AFTER)).toBe('complete');
    expect(classifyOperationalProjectionRecovery(transaction, {
      proposal: '5'.repeat(64), projection: AFTER.projection,
    })).toBe('unknown');

    const createTransaction = {
      before: { proposal: null, projection: null },
      after: AFTER,
    };
    expect(classifyOperationalProjectionRecovery(createTransaction, {
      proposal: null, projection: null,
    })).toBe('no-effect');
    expect(classifyOperationalProjectionRecovery(createTransaction, {
      proposal: AFTER.proposal, projection: null,
    })).toBe('proposal-only');
    expect(classifyOperationalProjectionRecovery(createTransaction, {
      proposal: null, projection: AFTER.projection,
    })).toBe('projection-only');
    expect(classifyOperationalProjectionRecovery(createTransaction, AFTER)).toBe('complete');
  });

  it('requires exact writer-lock ownership and meaningful digest movement', () => {
    const foreign = { token: Symbol('foreign') } as ProposalStoreMutationLock;
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433', before: BEFORE, after: AFTER, storeLock: foreign, now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-input-invalid' });
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433', before: BEFORE, after: BEFORE, storeLock: acquire(), now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-input-invalid' });
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433',
      before: BEFORE,
      after: { proposal: AFTER.proposal, projection: BEFORE.projection },
      storeLock: lock!,
      now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-input-invalid' });
    expect(classifyOperationalProjectionRecovery({
      before: BEFORE,
      after: { proposal: AFTER.proposal, projection: BEFORE.projection },
    }, AFTER)).toBe('unknown');
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433',
      before: BEFORE,
      after: { proposal: BEFORE.proposal, projection: AFTER.projection },
      storeLock: lock!,
      now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-input-invalid' });
    expect(fs.existsSync(operationalProjectionTransactionPath())).toBe(false);
  });

  it('does not publish without the existing signing key', () => {
    fs.rmSync(provenanceKeyPath(), { force: true });
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-433', before: BEFORE, after: AFTER, storeLock: acquire(), now: NOW,
    })).toMatchObject({ state: 'degraded', reason: 'transaction-key-unavailable' });
    expect(fs.existsSync(operationalProjectionTransactionPath())).toBe(false);
  });

  it('blocks corrupt active state and permits replacement only after commit', () => {
    const first = prepare();
    expect(first.state).toBe('healthy');
    if (first.state !== 'healthy') return;
    const id = first.transaction.transactionId;
    for (const phase of ['proposal-installed', 'projection-installed', 'committed'] as const) {
      expect(advanceOperationalProjectionTransactionJournalOnly(id, phase, lock!, NOW).state).toBe('healthy');
    }
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-clock-rollback',
      before: { proposal: AFTER.proposal, projection: AFTER.projection },
      after: { proposal: '9'.repeat(64), projection: 'a'.repeat(64) },
      storeLock: lock!,
      now: new Date('2026-07-16T17:59:59.999Z'),
    })).toMatchObject({ state: 'degraded', reason: 'transaction-input-invalid' });
    expect(readOperationalProjectionTransaction()).toMatchObject({
      state: 'healthy', transaction: { transactionId: id, phase: 'committed' },
    });
    const second = prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-next',
      before: { proposal: AFTER.proposal, projection: AFTER.projection },
      after: { proposal: '5'.repeat(64), projection: '6'.repeat(64) },
      storeLock: lock!,
      now: new Date('2026-07-16T18:01:00.000Z'),
    });
    expect(second).toMatchObject({
      state: 'healthy', transaction: { proposalId: 'proposal-next', phase: 'prepared' },
    });
    expect(second.state === 'healthy' && second.transaction.transactionId).not.toBe(id);

    fs.writeFileSync(operationalProjectionTransactionPath(), '{broken\n', { mode: 0o600 });
    expect(prepareOperationalProjectionTransactionJournalOnly({
      proposalId: 'proposal-third',
      before: { proposal: '5'.repeat(64), projection: '6'.repeat(64) },
      after: { proposal: '7'.repeat(64), projection: '8'.repeat(64) },
      storeLock: lock!,
      now: new Date('2026-07-16T18:02:00.000Z'),
    })).toMatchObject({ state: 'degraded', reason: 'transaction-invalid' });
  });

  it.runIf(process.platform === 'win32')('uses semantic Windows private-storage boundaries', () => {
    privateStorageHarness.calls.length = 0;
    expect(prepare().state).toBe('healthy');
    expect(readOperationalProjectionTransaction().state).toBe('healthy');
    expect(privateStorageHarness.calls).toEqual(expect.arrayContaining([
      { kind: 'directory', mode: 'secure-created' },
      { kind: 'directory', mode: 'inspect-existing' },
      { kind: 'file', mode: 'secure-created' },
      { kind: 'file', mode: 'inspect-owned' },
    ]));
  });
});
