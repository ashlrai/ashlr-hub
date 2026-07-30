import { generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => process.platform === 'win32'
      ? {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        }
      : actual.assurePrivateStoragePath(...args),
  };
});

import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  applyOperationalProjectionCasRecovery,
  operationalProjectionCasConsumptionStorePath,
  readOperationalProjectionCasConsumptionRecords,
  type ApplyOperationalProjectionCasRecoveryInputV1,
} from '../src/core/inbox/operational-projection-cas-recovery-coordinator.js';
import {
  buildOperationalProjectionAnchorRequest,
  operationalProjectionAnchorReceiptDigest,
  operationalProjectionAnchorReceiptSigningBytes,
  operationalProjectionAnchorRequestDigest,
  type OperationalProjectionAnchorReceiptCoreV1,
  type OperationalProjectionAnchorReceiptV1,
} from '../src/core/inbox/operational-projection-monotonic-anchor.js';
import {
  _setOperationalProjectionShadowWriterHookForTest,
  commitOperationalProjectionShadowWrite,
  inspectOperationalProjectionShadowWrite,
  prepareOperationalProjectionShadowWrite,
} from '../src/core/inbox/operational-projection-shadow-writer.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
  type ProposalStoreMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const PREPARED_AT = new Date('2026-07-29T16:00:00.000Z');
const COMMITTED_AT = new Date('2026-07-29T16:01:00.000Z');
const APPLIED_AT = new Date('2026-07-29T16:05:00.000Z');

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

function proposal(id: string): Buffer {
  return Buffer.from(JSON.stringify({ id, status: 'pending', secret: 'not-recorded' }), 'utf8');
}

function projection(): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, generation: 438, members: [] }), 'utf8');
}

function fixture(
  casDecision: 'accepted' | 'conflict',
): ApplyOperationalProjectionCasRecoveryInputV1 {
  const storeLock = lock ?? acquire();
  const proposalId = `proposal-438-${casDecision}`;
  const prepared = prepareOperationalProjectionShadowWrite({
    proposalId,
    proposalBytes: proposal(proposalId),
    projectionBytes: projection(),
    storeLock,
    now: PREPARED_AT,
  });
  const committed = commitOperationalProjectionShadowWrite(
    prepared.transaction!.transactionId,
    storeLock,
    COMMITTED_AT,
  );
  expect(committed).toMatchObject({
    state: 'healthy',
    actual: 'complete',
    transaction: { phase: 'committed', localRollForwardRequired: false },
  });
  const transaction = committed.transaction!;
  const keyPair = generateKeyPairSync('ed25519');
  const casRequest = buildOperationalProjectionAnchorRequest({
    anchorId: 'ashlr-anchor-primary',
    namespace: 'ashlr/projections/operational',
    requestNonce: '7'.repeat(64),
    expected: {
      sequence: '7',
      valueDigest: '0'.repeat(64),
      receiptDigest: '1'.repeat(64),
    },
    source: {
      shadowSchemaVersion: 2,
      transactionId: transaction.transactionId,
      transactionAttestation: transaction.attestation,
      transactionPhase: 'committed',
      localRollForwardRequired: false,
      proposalId,
      proposalDigest: transaction.after.proposal.digest!,
      projectionDigest: transaction.after.projection.digest!,
    },
  });
  const receiptCore: OperationalProjectionAnchorReceiptCoreV1 = {
    schemaVersion: 1,
    protocol: 'ashlr.operational-projection-monotonic-anchor.v1',
    anchorId: casRequest.anchorId,
    namespace: casRequest.namespace,
    keyId: 'projection-anchor-key',
    keyEpoch: '4',
    decision: casDecision,
    reason: casDecision === 'accepted' ? 'accepted' : 'compare-mismatch',
    requestDigest: operationalProjectionAnchorRequestDigest(casRequest),
    observed: casDecision === 'accepted'
      ? casRequest.expected
      : {
          sequence: '8',
          valueDigest: 'b'.repeat(64),
          receiptDigest: 'c'.repeat(64),
        },
    accepted: casDecision === 'accepted' ? casRequest.proposed : null,
    historicalAuthority: false,
    rollbackProtected: false,
    operationalAuthority: false,
  };
  const receiptDigest = operationalProjectionAnchorReceiptDigest(receiptCore);
  const receipt: OperationalProjectionAnchorReceiptV1 = {
    ...receiptCore,
    receiptDigest,
    signature: sign(
      null,
      operationalProjectionAnchorReceiptSigningBytes(receiptDigest),
      keyPair.privateKey,
    ).toString('base64url'),
  };
  return {
    casRequest,
    untrustedCasReceipt: receipt,
    casTrust: {
      anchorId: casRequest.anchorId,
      keyId: receipt.keyId,
      keyEpoch: receipt.keyEpoch,
      publicKey: keyPair.publicKey,
    },
    storeLock,
    now: APPLIED_AT,
  };
}

beforeEach(() => {
  lock = null;
  _setOperationalProjectionShadowWriterHookForTest(undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m438-'));
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

describe('M438 operational projection CAS recovery composition', () => {
  it('immutably consumes one signed acceptance without changing committed bytes', () => {
    const result = applyOperationalProjectionCasRecovery(fixture('accepted'));
    expect(result).toMatchObject({
      state: 'applied',
      reason: 'signed-cas-decision-applied',
      decision: 'roll-forward',
      authenticated: true,
      localMutationApplied: false,
      prepared: { phase: 'prepared', resultingShadowPhase: null },
      completion: { phase: 'applied', resultingShadowPhase: 'committed' },
      shadow: { state: 'healthy', actual: 'complete', transaction: { phase: 'committed' } },
      historicalAuthority: false,
      operationalAuthority: false,
      rollbackAuthority: false,
      rollbackProtected: false,
    });
    const records = readOperationalProjectionCasConsumptionRecords();
    expect(records).toMatchObject({
      sourceState: 'healthy',
      complete: true,
    });
    expect(records.records).toHaveLength(2);
    const persisted = records.records.map((record) => JSON.stringify(record)).join('\n');
    expect(persisted).not.toContain('not-recorded');
  });

  it('rolls back a committed candidate only after an exact signed CAS conflict', () => {
    const result = applyOperationalProjectionCasRecovery(fixture('conflict'));
    expect(result).toMatchObject({
      state: 'applied',
      decision: 'rollback',
      authenticated: true,
      localMutationApplied: true,
      completion: { resultingShadowPhase: 'rolled-back' },
      shadow: { state: 'healthy', actual: 'no-effect', transaction: { phase: 'rolled-back' } },
      operationalAuthority: false,
      rollbackAuthority: false,
      rollbackProtected: false,
    });
  });

  it('recovers indefinitely from the immutable prepared receipt after a crash', () => {
    const input = fixture('conflict');
    _setOperationalProjectionShadowWriterHookForTest((point) =>
      point === 'after-rollback-projection' ? 'crash' : undefined);
    expect(() => applyOperationalProjectionCasRecovery(input)).toThrow();
    expect(readOperationalProjectionCasConsumptionRecords().records).toMatchObject([
      { phase: 'prepared', decision: 'rollback' },
    ]);

    _setOperationalProjectionShadowWriterHookForTest(undefined);
    const resumed = applyOperationalProjectionCasRecovery({
      ...input,
      untrustedCasReceipt: null,
      now: new Date('2036-07-29T16:05:00.000Z'),
    });
    expect(resumed).toMatchObject({
      state: 'applied',
      decision: 'rollback',
      completion: { resultingShadowPhase: 'rolled-back' },
      shadow: { actual: 'no-effect', transaction: { phase: 'rolled-back' } },
    });
  });

  it('replays the same immutable completion without a second local mutation', () => {
    const input = fixture('accepted');
    expect(applyOperationalProjectionCasRecovery(input).state).toBe('applied');
    expect(applyOperationalProjectionCasRecovery({
      ...input,
      untrustedCasReceipt: null,
    })).toMatchObject({
      state: 'applied',
      reason: 'signed-cas-decision-already-applied',
      localMutationApplied: false,
    });
    expect(readOperationalProjectionCasConsumptionRecords().records).toHaveLength(2);
  });

  it('refuses unavailable or invalid CAS decisions without creating authority', () => {
    const input = fixture('accepted');
    const result = applyOperationalProjectionCasRecovery({
      ...input,
      untrustedCasReceipt: null,
    });
    expect(result).toMatchObject({
      state: 'refused',
      reason: 'cas-receipt-unavailable',
      authenticated: false,
      localMutationApplied: false,
      historicalAuthority: false,
      operationalAuthority: false,
      rollbackAuthority: false,
      rollbackProtected: false,
    });
    expect(fs.existsSync(operationalProjectionCasConsumptionStorePath())).toBe(false);
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      actual: 'complete',
      transaction: { phase: 'committed' },
    });
  });

  it('fails closed when an immutable prepared record is altered', () => {
    const input = fixture('accepted');
    const first = applyOperationalProjectionCasRecovery(input);
    expect(first.state).toBe('applied');
    const preparedPath = path.join(
      operationalProjectionCasConsumptionStorePath(),
      'records',
      `${first.decisionId}.prepared.json`,
    );
    const row = JSON.parse(fs.readFileSync(preparedPath, 'utf8')) as Record<string, unknown>;
    row['decision'] = 'rollback';
    fs.writeFileSync(preparedPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    expect(readOperationalProjectionCasConsumptionRecords()).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      records: [],
    });
    expect(applyOperationalProjectionCasRecovery(input)).toMatchObject({
      state: 'degraded',
      authenticated: false,
      localMutationApplied: false,
    });
  });
});
