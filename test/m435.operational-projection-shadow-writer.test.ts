import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateStorageHarness = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; kind: string; mode: string }>,
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
  _setOperationalProjectionShadowWriterHookForTest,
  commitOperationalProjectionShadowWrite,
  inspectOperationalProjectionShadowWrite,
  markOperationalProjectionShadowRollForwardRequired,
  operationalProjectionShadowCurrentPath,
  operationalProjectionShadowJournalPath,
  operationalProjectionShadowStagedPath,
  operationalProjectionShadowStagingRoot,
  operationalProjectionShadowWriterRoot,
  prepareOperationalProjectionShadowWrite,
  recoverOperationalProjectionShadowWrite,
  type OperationalProjectionShadowInspection,
} from '../src/core/inbox/operational-projection-shadow-writer.js';
import { operationalProposalProjectionDir } from '../src/core/inbox/operational-projection.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const NOW = new Date('2026-07-28T20:00:00.000Z');

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

function proposal(id: string, revision = 1): Buffer {
  return Buffer.from(JSON.stringify({ id, status: 'pending', revision }), 'utf8');
}

function projection(generation = 1): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, generation, members: [] }), 'utf8');
}

function prepare(
  proposalId = 'proposal-435',
  proposalRevision = 1,
  projectionGeneration = 1,
): OperationalProjectionShadowInspection {
  return prepareOperationalProjectionShadowWrite({
    proposalId,
    proposalBytes: proposal(proposalId, proposalRevision),
    projectionBytes: projection(projectionGeneration),
    storeLock: lock ?? acquire(),
    now: NOW,
  });
}

function preparedTransactionId(): string {
  const result = prepare();
  expect(result).toMatchObject({
    state: 'healthy',
    actual: 'no-effect',
    requiredAction: 'rollback',
    transaction: {
      schemaVersion: 2,
      phase: 'prepared',
      localRollForwardRequired: false,
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    },
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
  });
  return result.transaction!.transactionId;
}

function assertNoAuthority(result: OperationalProjectionShadowInspection): void {
  expect(result).toMatchObject({
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
  });
  if (result.transaction) {
    expect(result.transaction).toMatchObject({
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });
  }
}

beforeEach(() => {
  lock = null;
  privateStorageHarness.calls.length = 0;
  _setOperationalProjectionShadowWriterHookForTest(undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m435-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  loadOrCreateKey();
});

afterEach(() => {
  _setOperationalProjectionShadowWriterHookForTest(undefined);
  releaseProposalStoreMutationLock(lock);
  lock = null;
  fs.rmSync(home, { recursive: true, force: true });
  restore('HOME', originalHome);
  restore('USERPROFILE', originalUserProfile);
});

describe('M435 operational projection shadow writer', () => {
  it('observes a missing writer without creating storage or authority', () => {
    const result = inspectOperationalProjectionShadowWrite();
    expect(result).toEqual({
      state: 'missing',
      transaction: null,
      actual: 'unavailable',
      requiredAction: 'none',
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });
    expect(fs.existsSync(operationalProjectionShadowWriterRoot())).toBe(false);
  });

  it('stages exact bounded bytes and authenticates metadata-only V2 journal state', () => {
    const id = preparedTransactionId();
    const result = inspectOperationalProjectionShadowWrite();
    expect(result.transaction?.transactionId).toBe(id);
    const slot = result.transaction!.stagingSlot;
    expect(fs.readFileSync(
      operationalProjectionShadowStagedPath(slot, 'proposal', 'after'),
    )).toEqual(proposal('proposal-435'));
    expect(fs.readFileSync(
      operationalProjectionShadowStagedPath(slot, 'projection', 'after'),
    )).toEqual(projection());
    expect(fs.existsSync(
      operationalProjectionShadowStagedPath(slot, 'proposal', 'before'),
    )).toBe(false);
    const journal = fs.readFileSync(operationalProjectionShadowJournalPath(), 'utf8');
    expect(journal).not.toContain('"status":"pending"');
    expect(journal).not.toContain('"members":[]');
    const record = JSON.parse(journal) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 2,
      phase: 'prepared',
      localRollForwardRequired: false,
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });
    expect(Object.keys(record).sort()).toEqual([
      'after',
      'attestation',
      'before',
      'createdAt',
      'historicalAuthority',
      'localRollForwardRequired',
      'operationalAuthority',
      'phase',
      'proposalId',
      'rollbackProtected',
      'schemaVersion',
      'signingKeyId',
      'stagingSlot',
      'transactionId',
      'updatedAt',
    ]);
    expect(Object.keys(record).filter((key) =>
      /anchor|accepted|receipt|signature/i.test(key))).toEqual([]);
    expect(Object.keys(record).filter((key) =>
      /authority|rollbackProtected/i.test(key)).sort()).toEqual([
      'historicalAuthority',
      'operationalAuthority',
      'rollbackProtected',
    ]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(operationalProjectionShadowJournalPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(operationalProjectionShadowWriterRoot()).mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    ['after-prepared', 'rolled-back', 'no-effect'],
    ['after-proposal-publish', 'rolled-back', 'no-effect'],
    ['after-proposal-installed', 'rolled-back', 'no-effect'],
    ['after-projection-publish', 'rolled-back', 'no-effect'],
    ['after-projection-installed', 'rolled-back', 'no-effect'],
    ['after-committed', 'committed', 'complete'],
  ] as const)(
    'recovers deterministically after a crash at %s',
    (crashPoint, expectedPhase, expectedActual) => {
      let transactionId: string;
      if (crashPoint === 'after-prepared') {
        _setOperationalProjectionShadowWriterHookForTest((point) =>
          point === crashPoint ? 'crash' : undefined);
        expect(() => prepare()).toThrow(crashPoint);
        transactionId = inspectOperationalProjectionShadowWrite().transaction!.transactionId;
      } else {
        transactionId = preparedTransactionId();
        _setOperationalProjectionShadowWriterHookForTest((point) =>
          point === crashPoint ? 'crash' : undefined);
        expect(() => commitOperationalProjectionShadowWrite(transactionId, lock!, NOW))
          .toThrow(crashPoint);
      }
      _setOperationalProjectionShadowWriterHookForTest(undefined);
      const recovered = recoverOperationalProjectionShadowWrite(lock!, NOW);
      expect(recovered).toMatchObject({
        state: 'healthy',
        actual: expectedActual,
        requiredAction: 'none',
        transaction: { transactionId, phase: expectedPhase },
      });
      assertNoAuthority(recovered);
      const repeated = recoverOperationalProjectionShadowWrite(lock!, NOW);
      expect(repeated).toEqual(recovered);
    },
  );

  it('uses a local recovery directive to require roll-forward without granting authority', () => {
    const transactionId = preparedTransactionId();
    _setOperationalProjectionShadowWriterHookForTest((point) =>
      point === 'after-proposal-installed' ? 'crash' : undefined);
    expect(() => commitOperationalProjectionShadowWrite(transactionId, lock!, NOW))
      .toThrow('after-proposal-installed');
    _setOperationalProjectionShadowWriterHookForTest(undefined);

    const marked = markOperationalProjectionShadowRollForwardRequired(
      transactionId,
      lock!,
      NOW,
    );
    expect(marked).toMatchObject({
      state: 'healthy',
      actual: 'proposal-only',
      requiredAction: 'roll-forward',
      transaction: { localRollForwardRequired: true, phase: 'proposal-installed' },
    });
    assertNoAuthority(marked);

    const recovered = recoverOperationalProjectionShadowWrite(lock!, NOW);
    expect(recovered).toMatchObject({
      state: 'healthy',
      actual: 'complete',
      requiredAction: 'none',
      transaction: { localRollForwardRequired: true, phase: 'committed' },
    });
    assertNoAuthority(recovered);
    expect(recoverOperationalProjectionShadowWrite(lock!, NOW)).toEqual(recovered);
  });

  it.each([
    ['after-rollback-projection', 'proposal-only', 'projection-installed'],
    ['after-rollback-proposal', 'no-effect', 'projection-installed'],
    ['after-rolled-back', 'no-effect', 'rolled-back'],
  ] as const)(
    'resumes an interrupted rollback after %s',
    (crashPoint, crashActual, crashPhase) => {
      const transactionId = preparedTransactionId();
      _setOperationalProjectionShadowWriterHookForTest((point) =>
        point === 'after-projection-installed' ? 'crash' : undefined);
      expect(() => commitOperationalProjectionShadowWrite(transactionId, lock!, NOW))
        .toThrow('after-projection-installed');
      _setOperationalProjectionShadowWriterHookForTest((point) =>
        point === crashPoint ? 'crash' : undefined);
      expect(() => recoverOperationalProjectionShadowWrite(lock!, NOW)).toThrow(crashPoint);
      const interrupted = inspectOperationalProjectionShadowWrite();
      expect(interrupted).toMatchObject({
        state: 'healthy',
        actual: crashActual,
        transaction: { phase: crashPhase },
      });
      assertNoAuthority(interrupted);

      _setOperationalProjectionShadowWriterHookForTest(undefined);
      const recovered = recoverOperationalProjectionShadowWrite(lock!, NOW);
      expect(recovered).toMatchObject({
        state: 'healthy',
        actual: 'no-effect',
        requiredAction: 'none',
        transaction: { phase: 'rolled-back' },
      });
      expect(recoverOperationalProjectionShadowWrite(lock!, NOW)).toEqual(recovered);
    },
  );

  it('refuses corrupted staging and leaves the observed partial target untouched', () => {
    const transactionId = preparedTransactionId();
    _setOperationalProjectionShadowWriterHookForTest((point) =>
      point === 'after-proposal-publish' ? 'crash' : undefined);
    expect(() => commitOperationalProjectionShadowWrite(transactionId, lock!, NOW))
      .toThrow('after-proposal-publish');
    _setOperationalProjectionShadowWriterHookForTest(undefined);
    const transaction = inspectOperationalProjectionShadowWrite().transaction!;
    const stagedBefore = operationalProjectionShadowStagedPath(
      transaction.stagingSlot,
      'projection',
      'after',
    );
    fs.writeFileSync(stagedBefore, '{"corrupted":true}', { mode: 0o600 });

    const beforeRecovery = fs.readFileSync(operationalProjectionShadowCurrentPath('proposal'));
    const result = recoverOperationalProjectionShadowWrite(lock!, NOW);
    expect(result).toMatchObject({
      state: 'degraded',
      reason: 'shadow-staging-integrity-failed',
      actual: 'proposal-only',
      requiredAction: 'refuse',
    });
    expect(fs.readFileSync(operationalProjectionShadowCurrentPath('proposal')))
      .toEqual(beforeRecovery);
    expect(fs.existsSync(operationalProjectionShadowCurrentPath('projection'))).toBe(false);
    assertNoAuthority(result);
  });

  it('rejects authenticated journal tampering, corruption, and authority upgrades', () => {
    preparedTransactionId();
    const original = fs.readFileSync(operationalProjectionShadowJournalPath(), 'utf8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    parsed['proposalId'] = 'proposal-tampered';
    fs.writeFileSync(
      operationalProjectionShadowJournalPath(),
      `${JSON.stringify(parsed)}\n`,
      { mode: 0o600 },
    );
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'degraded',
      reason: 'shadow-journal-integrity-failed',
      transaction: null,
    });

    const authorityUpgrade = JSON.parse(original) as Record<string, unknown>;
    authorityUpgrade['historicalAuthority'] = true;
    fs.writeFileSync(
      operationalProjectionShadowJournalPath(),
      `${JSON.stringify(authorityUpgrade)}\n`,
      { mode: 0o600 },
    );
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'degraded',
      reason: 'shadow-journal-invalid',
      transaction: null,
      historicalAuthority: false,
      rollbackProtected: false,
      operationalAuthority: false,
    });

    fs.writeFileSync(operationalProjectionShadowJournalPath(), '{', { mode: 0o600 });
    expect(recoverOperationalProjectionShadowWrite(lock!, NOW)).toMatchObject({
      state: 'degraded',
      reason: 'shadow-journal-invalid',
      transaction: null,
    });
  });

  it('detects a replacement race and never overwrites the replacement', () => {
    const transactionId = preparedTransactionId();
    const replacement = Buffer.from('{"foreign":true}', 'utf8');
    _setOperationalProjectionShadowWriterHookForTest((point) => {
      if (point === 'before-projection-publish') {
        fs.writeFileSync(
          operationalProjectionShadowCurrentPath('projection'),
          replacement,
          { mode: 0o600 },
        );
      }
    });
    const result = commitOperationalProjectionShadowWrite(transactionId, lock!, NOW);
    _setOperationalProjectionShadowWriterHookForTest(undefined);
    expect(result).toMatchObject({
      state: 'degraded',
      reason: 'shadow-replacement-race',
    });
    expect(fs.readFileSync(operationalProjectionShadowCurrentPath('projection')))
      .toEqual(replacement);
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'healthy',
      actual: 'unknown',
      requiredAction: 'refuse',
    });
  });

  it('does not absorb a replaced terminal target into the next transaction', () => {
    const transactionId = preparedTransactionId();
    expect(commitOperationalProjectionShadowWrite(transactionId, lock!, NOW))
      .toMatchObject({ state: 'healthy', transaction: { phase: 'committed' } });
    const replacement = Buffer.from('{"foreign":"terminal"}', 'utf8');
    fs.writeFileSync(
      operationalProjectionShadowCurrentPath('proposal'),
      replacement,
      { mode: 0o600 },
    );

    const result = prepare('proposal-436', 2, 2);
    expect(result).toMatchObject({
      state: 'degraded',
      reason: 'shadow-terminal-state-inconsistent',
      actual: 'unknown',
      requiredAction: 'refuse',
    });
    expect(fs.readFileSync(operationalProjectionShadowCurrentPath('proposal')))
      .toEqual(replacement);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a symlinked shadow namespace and bounded path escapes',
    () => {
      fs.mkdirSync(operationalProposalProjectionDir(), { recursive: true, mode: 0o700 });
      fs.chmodSync(operationalProposalProjectionDir(), 0o700);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m435-outside-'));
      fs.chmodSync(outside, 0o700);
      fs.symlinkSync(outside, operationalProjectionShadowWriterRoot());
      const result = prepare();
      expect(result).toMatchObject({
        state: 'degraded',
        reason: 'shadow-directory-unsafe',
      });
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.unlinkSync(operationalProjectionShadowWriterRoot());
      fs.rmSync(outside, { recursive: true, force: true });

      expect(() => operationalProjectionShadowStagedPath(
        '../escape' as 'a',
        'proposal',
        'after',
      )).toThrow('invalid shadow staging path');
      expect(() => operationalProjectionShadowStagedPath(
        'a',
        '../proposal' as 'proposal',
        'after',
      )).toThrow('invalid shadow staging path');
    },
  );

  it('rejects oversized, malformed, mismatched, and traversal-bearing inputs', () => {
    const storeLock = acquire();
    for (const input of [
      {
        proposalId: '../escape',
        proposalBytes: proposal('../escape'),
        projectionBytes: projection(),
      },
      {
        proposalId: 'proposal-435',
        proposalBytes: proposal('different-id'),
        projectionBytes: projection(),
      },
      {
        proposalId: 'proposal-435',
        proposalBytes: Buffer.from('{'),
        projectionBytes: projection(),
      },
      {
        proposalId: 'proposal-435',
        proposalBytes: proposal('proposal-435'),
        projectionBytes: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20),
      },
    ]) {
      expect(prepareOperationalProjectionShadowWrite({
        ...input,
        storeLock,
        now: NOW,
      })).toMatchObject({
        state: 'degraded',
        reason: 'shadow-input-invalid',
        historicalAuthority: false,
        rollbackProtected: false,
        operationalAuthority: false,
      });
    }
    expect(fs.existsSync(operationalProjectionShadowWriterRoot())).toBe(false);
  });

  it('uses alternate staging slots so an interrupted next prepare preserves the terminal journal', () => {
    const firstId = preparedTransactionId();
    const committed = commitOperationalProjectionShadowWrite(firstId, lock!, NOW);
    expect(committed).toMatchObject({
      state: 'healthy',
      transaction: { phase: 'committed', stagingSlot: 'a' },
    });
    const firstJournal = fs.readFileSync(operationalProjectionShadowJournalPath());
    const firstStage = fs.readFileSync(
      operationalProjectionShadowStagedPath('a', 'proposal', 'after'),
    );

    _setOperationalProjectionShadowWriterHookForTest((point) =>
      point === 'after-staged' ? 'crash' : undefined);
    expect(() => prepare('proposal-436', 2, 2)).toThrow('after-staged');
    _setOperationalProjectionShadowWriterHookForTest(undefined);

    expect(fs.readFileSync(operationalProjectionShadowJournalPath())).toEqual(firstJournal);
    expect(fs.readFileSync(
      operationalProjectionShadowStagedPath('a', 'proposal', 'after'),
    )).toEqual(firstStage);
    expect(fs.readFileSync(
      operationalProjectionShadowStagedPath('b', 'proposal', 'after'),
    )).toEqual(proposal('proposal-436', 2));
    expect(inspectOperationalProjectionShadowWrite()).toEqual(committed);
    expect(path.relative(
      operationalProjectionShadowWriterRoot(),
      operationalProjectionShadowStagingRoot(),
    )).toBe('staged');
  });
});
