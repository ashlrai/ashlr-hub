import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
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
  type OperationalProjectionCasConsumptionRecordV1,
} from '../src/core/inbox/operational-projection-cas-recovery-coordinator.js';
import {
  buildOperationalProjectionAnchorRequest,
  operationalProjectionAnchorReceiptDigest,
  operationalProjectionAnchorReceiptSigningBytes,
  operationalProjectionAnchorRequestDigest,
  type OperationalProjectionAnchorStateV1,
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
import { fsyncDirectory } from '../src/core/util/durability.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const PREPARED_AT = new Date('2026-07-29T16:00:00.000Z');
const COMMITTED_AT = new Date('2026-07-29T16:01:00.000Z');
const APPLIED_AT = new Date('2026-07-29T16:05:00.000Z');
const LEGACY_CONSUMPTION_DOMAIN =
  'ashlr.operational-projection-cas-consumption.identity.v1';
const KEY_DOMAIN = 'ashlr.operational-projection-cas-consumption.key.v1';
const RECORD_DOMAIN = 'ashlr.operational-projection-cas-consumption.record.v1';
const ATTESTATION_DOMAIN = 'ashlr.operational-projection-cas-consumption.attestation.v1';

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

function signedReceipt(
  casRequest: ApplyOperationalProjectionCasRecoveryInputV1['casRequest'],
  casDecision: 'accepted' | 'conflict',
  privateKey: KeyObject,
  conflictObserved?: OperationalProjectionAnchorStateV1,
): OperationalProjectionAnchorReceiptV1 {
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
      : conflictObserved ?? {
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
  return {
    ...receiptCore,
    receiptDigest,
    signature: sign(
      null,
      operationalProjectionAnchorReceiptSigningBytes(receiptDigest),
      privateKey,
    ).toString('base64url'),
  };
}

function signedFixture(
  casDecision: 'accepted' | 'conflict',
): { input: ApplyOperationalProjectionCasRecoveryInputV1; privateKey: KeyObject } {
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
  const receipt = signedReceipt(casRequest, casDecision, keyPair.privateKey);
  return {
    input: {
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
    },
    privateKey: keyPair.privateKey,
  };
}

function fixture(
  casDecision: 'accepted' | 'conflict',
): ApplyOperationalProjectionCasRecoveryInputV1 {
  return signedFixture(casDecision).input;
}

function restorePreparedPublicationWitness(
  boundary: 'temporary' | 'stage' | 'target-link' | 'records-directory-fsync',
  input = fixture('accepted'),
): ApplyOperationalProjectionCasRecoveryInputV1 {
  const first = applyOperationalProjectionCasRecovery(input);
  expect(first.state).toBe('applied');
  const prepared = first.prepared!;
  const root = operationalProjectionCasConsumptionStorePath();
  const persisted = fs.readFileSync(
    path.join(root, 'records', `${prepared.decisionId}.prepared.json`),
  );
  fs.rmSync(root, { recursive: true, force: true });
  const records = path.join(root, 'records');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(records, 0o700);
    fs.chmodSync(staging, 0o700);
  }
  const stage = path.join(
    staging,
    `.${prepared.decisionId}.prepared.${prepared.recordDigest}.stage`,
  );
  const temporary = `${stage}.tmp`;
  const target = path.join(records, `${prepared.decisionId}.prepared.json`);
  if (boundary === 'temporary') {
    fs.writeFileSync(temporary, persisted, { mode: 0o600 });
  } else {
    fs.writeFileSync(stage, persisted, { mode: 0o600 });
    fsyncDirectory(staging);
    if (boundary === 'target-link' || boundary === 'records-directory-fsync') {
      fs.linkSync(stage, target);
      if (boundary === 'records-directory-fsync') fsyncDirectory(records);
    }
  }
  return { ...input, untrustedCasReceipt: null };
}

function sha(domain: string, value: string): string {
  return createHash('sha256')
    .update(`${domain}\n`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function legacyConsumptionDigest(
  request: ApplyOperationalProjectionCasRecoveryInputV1['casRequest'],
): string {
  return sha(LEGACY_CONSUMPTION_DOMAIN, JSON.stringify({
    anchorId: request.anchorId,
    namespace: request.namespace,
    source: {
      projectionDigest: request.source.projectionDigest,
      proposalDigest: request.source.proposalDigest,
      proposalId: request.source.proposalId,
      transactionId: request.source.transactionId,
    },
  }));
}

function consumptionPayload(record: OperationalProjectionCasConsumptionRecordV1): string {
  return JSON.stringify({
    casReceipt: record.casReceipt,
    casRequest: record.casRequest,
    consumptionDigest: record.consumptionDigest,
    decision: record.decision,
    decisionId: record.decisionId,
    historicalAuthority: record.historicalAuthority,
    operationalAuthority: record.operationalAuthority,
    phase: record.phase,
    receiptDigest: record.receiptDigest,
    recordType: record.recordType,
    recordedAt: record.recordedAt,
    requestDigest: record.requestDigest,
    resultingShadowPhase: record.resultingShadowPhase,
    rollbackAuthority: record.rollbackAuthority,
    rollbackProtected: record.rollbackProtected,
    schemaVersion: record.schemaVersion,
  });
}

function rewriteConsumptionRecordsAsLegacy(): void {
  const provenanceKey = loadOrCreateKey();
  const localKey = createHmac('sha256', provenanceKey)
    .update(`${KEY_DOMAIN}\n`, 'utf8')
    .digest();
  const recordsPath = path.join(operationalProjectionCasConsumptionStorePath(), 'records');
  for (const fileName of fs.readdirSync(recordsPath)) {
    const recordPath = path.join(recordsPath, fileName);
    const record = JSON.parse(
      fs.readFileSync(recordPath, 'utf8'),
    ) as OperationalProjectionCasConsumptionRecordV1;
    record.consumptionDigest = legacyConsumptionDigest(record.casRequest);
    record.recordDigest = sha(RECORD_DOMAIN, consumptionPayload(record));
    record.attestation = createHmac('sha256', localKey)
      .update(`${ATTESTATION_DOMAIN}\n`, 'utf8')
      .update(record.recordDigest, 'utf8')
      .digest('hex');
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
  const stagingPath = path.join(operationalProjectionCasConsumptionStorePath(), 'staging');
  for (const fileName of fs.readdirSync(stagingPath)) {
    if (!fileName.endsWith('.stage')) continue;
    const stagePath = path.join(stagingPath, fileName);
    const record = JSON.parse(
      fs.readFileSync(stagePath, 'utf8'),
    ) as OperationalProjectionCasConsumptionRecordV1;
    const expectedName = `.${record.decisionId}.${record.phase}.${record.recordDigest}.stage`;
    if (fileName !== expectedName) fs.renameSync(stagePath, path.join(stagingPath, expectedName));
  }
}

function rewritePreparedAsPreFixRollback(
  prepared: OperationalProjectionCasConsumptionRecordV1,
  coordinateBound: boolean,
): void {
  const root = operationalProjectionCasConsumptionStorePath();
  const recordsPath = path.join(root, 'records');
  const preparedPath = path.join(recordsPath, `${prepared.decisionId}.prepared.json`);
  const completionPath = path.join(recordsPath, `${prepared.decisionId}.applied.json`);
  const record = JSON.parse(
    fs.readFileSync(preparedPath, 'utf8'),
  ) as OperationalProjectionCasConsumptionRecordV1;
  record.decision = 'rollback';
  if (coordinateBound) record.consumptionDigest = legacyConsumptionDigest(record.casRequest);
  record.recordDigest = sha(RECORD_DOMAIN, consumptionPayload(record));
  const localKey = createHmac('sha256', loadOrCreateKey())
    .update(`${KEY_DOMAIN}\n`, 'utf8')
    .digest();
  record.attestation = createHmac('sha256', localKey)
    .update(`${ATTESTATION_DOMAIN}\n`, 'utf8')
    .update(record.recordDigest, 'utf8')
    .digest('hex');
  fs.writeFileSync(preparedPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.rmSync(completionPath);
  fsyncDirectory(recordsPath);
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

  it('treats an authenticated retry conflict observing the exact proposal as accepted', () => {
    const fixture = signedFixture('conflict');
    const lostResponseReceipt = signedReceipt(
      fixture.input.casRequest,
      'conflict',
      fixture.privateKey,
      {
        sequence: fixture.input.casRequest.proposed.sequence,
        valueDigest: fixture.input.casRequest.proposed.valueDigest,
        receiptDigest: 'e'.repeat(64),
      },
    );

    expect(applyOperationalProjectionCasRecovery({
      ...fixture.input,
      untrustedCasReceipt: lostResponseReceipt,
    })).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
      authenticated: true,
      localMutationApplied: false,
      completion: { resultingShadowPhase: 'committed' },
      shadow: { actual: 'complete', transaction: { phase: 'committed' } },
    });
  });

  it.each(['sequence', 'value digest'] as const)(
    'keeps a near-match on %s as a true conflict',
    (field) => {
      const fixture = signedFixture('conflict');
      const observed: OperationalProjectionAnchorStateV1 = {
        sequence: fixture.input.casRequest.proposed.sequence,
        valueDigest: fixture.input.casRequest.proposed.valueDigest,
        receiptDigest: 'e'.repeat(64),
      };
      if (field === 'sequence') {
        observed.sequence = (BigInt(observed.sequence) + 1n).toString();
      } else {
        observed.valueDigest = observed.valueDigest === 'b'.repeat(64)
          ? 'c'.repeat(64)
          : 'b'.repeat(64);
      }
      const receipt = signedReceipt(
        fixture.input.casRequest,
        'conflict',
        fixture.privateKey,
        observed,
      );

      expect(applyOperationalProjectionCasRecovery({
        ...fixture.input,
        untrustedCasReceipt: receipt,
      })).toMatchObject({
        state: 'applied',
        decision: 'rollback',
        authenticated: true,
        localMutationApplied: true,
        shadow: { actual: 'no-effect', transaction: { phase: 'rolled-back' } },
      });
    },
  );

  it('refuses an exact-proposal conflict for a different transaction', () => {
    const fixture = signedFixture('conflict');
    const differentRequest = buildOperationalProjectionAnchorRequest({
      anchorId: fixture.input.casRequest.anchorId,
      namespace: fixture.input.casRequest.namespace,
      requestNonce: '9'.repeat(64),
      expected: fixture.input.casRequest.expected,
      source: {
        ...fixture.input.casRequest.source,
        transactionId: 'f'.repeat(64),
        proposalId: 'proposal-438-different',
      },
    });
    const receipt = signedReceipt(
      differentRequest,
      'conflict',
      fixture.privateKey,
      {
        sequence: differentRequest.proposed.sequence,
        valueDigest: differentRequest.proposed.valueDigest,
        receiptDigest: 'e'.repeat(64),
      },
    );

    expect(applyOperationalProjectionCasRecovery({
      ...fixture.input,
      casRequest: differentRequest,
      untrustedCasReceipt: receipt,
    })).toMatchObject({
      state: 'refused',
      reason: 'shadow-decision-binding-mismatch',
      authenticated: false,
      localMutationApplied: false,
    });
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      actual: 'complete',
      transaction: { phase: 'committed' },
    });
  });

  it('rejects an unauthenticated exact-proposal conflict', () => {
    const fixture = signedFixture('conflict');
    const attacker = generateKeyPairSync('ed25519');
    const receipt = signedReceipt(
      fixture.input.casRequest,
      'conflict',
      attacker.privateKey,
      {
        sequence: fixture.input.casRequest.proposed.sequence,
        valueDigest: fixture.input.casRequest.proposed.valueDigest,
        receiptDigest: 'e'.repeat(64),
      },
    );

    expect(applyOperationalProjectionCasRecovery({
      ...fixture.input,
      untrustedCasReceipt: receipt,
    })).toMatchObject({
      state: 'refused',
      reason: 'invalid-cas-receipt-signature-invalid',
      authenticated: false,
      localMutationApplied: false,
    });
  });

  it('replays an exact-proposal conflict without a second local mutation', () => {
    const fixture = signedFixture('conflict');
    const input = {
      ...fixture.input,
      untrustedCasReceipt: signedReceipt(
        fixture.input.casRequest,
        'conflict',
        fixture.privateKey,
        {
          sequence: fixture.input.casRequest.proposed.sequence,
          valueDigest: fixture.input.casRequest.proposed.valueDigest,
          receiptDigest: 'e'.repeat(64),
        },
      ),
    };
    expect(applyOperationalProjectionCasRecovery(input)).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
    });
    expect(applyOperationalProjectionCasRecovery({
      ...input,
      untrustedCasReceipt: null,
    })).toMatchObject({
      state: 'applied',
      reason: 'signed-cas-decision-already-applied',
      decision: 'roll-forward',
      localMutationApplied: false,
    });
  });

  it('resumes an exact-proposal conflict from its immutable prepared record', () => {
    const fixture = signedFixture('conflict');
    const input = {
      ...fixture.input,
      untrustedCasReceipt: signedReceipt(
        fixture.input.casRequest,
        'conflict',
        fixture.privateKey,
        {
          sequence: fixture.input.casRequest.proposed.sequence,
          valueDigest: fixture.input.casRequest.proposed.valueDigest,
          receiptDigest: 'e'.repeat(64),
        },
      ),
    };
    const resumed = applyOperationalProjectionCasRecovery({
      ...restorePreparedPublicationWitness('records-directory-fsync', input),
      untrustedCasReceipt: null,
      now: new Date('2036-07-29T16:05:00.000Z'),
    });

    expect(resumed).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
      authenticated: true,
      localMutationApplied: false,
      prepared: { phase: 'prepared', decision: 'roll-forward' },
      completion: { phase: 'applied', resultingShadowPhase: 'committed' },
      shadow: { actual: 'complete', transaction: { phase: 'committed' } },
    });
  });

  it.each([
    ['stable v2', false],
    ['coordinate-bound v1', true],
  ] as const)(
    'resumes a locally attested pre-fix %s rollback decision without degrading',
    (_identity, coordinateBound) => {
      const fixture = signedFixture('conflict');
      const input = {
        ...fixture.input,
        untrustedCasReceipt: signedReceipt(
          fixture.input.casRequest,
          'conflict',
          fixture.privateKey,
          {
            sequence: fixture.input.casRequest.proposed.sequence,
            valueDigest: fixture.input.casRequest.proposed.valueDigest,
            receiptDigest: 'e'.repeat(64),
          },
        ),
      };
      const first = applyOperationalProjectionCasRecovery(input);
      expect(first).toMatchObject({ state: 'applied', decision: 'roll-forward' });
      rewritePreparedAsPreFixRollback(first.prepared!, coordinateBound);
      expect(readOperationalProjectionCasConsumptionRecords()).toMatchObject({
        sourceState: 'healthy',
        complete: true,
        records: [{ phase: 'prepared', decision: 'rollback' }],
      });

      expect(applyOperationalProjectionCasRecovery({
        ...input,
        untrustedCasReceipt: null,
        now: new Date('2036-07-29T16:05:00.000Z'),
      })).toMatchObject({
        state: 'applied',
        decision: 'rollback',
        authenticated: true,
        localMutationApplied: true,
        prepared: { phase: 'prepared', decision: 'rollback' },
        completion: { phase: 'applied', decision: 'rollback', resultingShadowPhase: 'rolled-back' },
        shadow: { actual: 'no-effect', transaction: { phase: 'rolled-back' } },
      });
    },
  );

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

  it('refuses a new-nonce conflict after the stable transaction value was accepted', () => {
    const fixture = signedFixture('accepted');
    expect(applyOperationalProjectionCasRecovery(fixture.input).state).toBe('applied');
    const nonceRetry = structuredClone(fixture.input.casRequest);
    nonceRetry.requestNonce = '8'.repeat(64);
    const advancedExpectedRetry = buildOperationalProjectionAnchorRequest({
      anchorId: fixture.input.casRequest.anchorId,
      namespace: fixture.input.casRequest.namespace,
      requestNonce: '9'.repeat(64),
      expected: {
        sequence: '8',
        valueDigest: fixture.input.casRequest.proposed.valueDigest,
        receiptDigest: 'd'.repeat(64),
      },
      source: fixture.input.casRequest.source,
    });

    for (const retryRequest of [nonceRetry, advancedExpectedRetry]) {
      const retryReceipt = signedReceipt(retryRequest, 'conflict', fixture.privateKey);
      expect(applyOperationalProjectionCasRecovery({
        ...fixture.input,
        casRequest: retryRequest,
        untrustedCasReceipt: retryReceipt,
      })).toMatchObject({
        state: 'refused',
        reason: 'cas-consumption-identity-already-decided',
        authenticated: false,
        localMutationApplied: false,
        historicalAuthority: false,
        operationalAuthority: false,
        rollbackAuthority: false,
        rollbackProtected: false,
      });
    }
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'healthy',
      actual: 'complete',
      transaction: { phase: 'committed' },
    });
    expect(readOperationalProjectionCasConsumptionRecords().records).toHaveLength(2);
  });

  it('refuses a conflicting decision under alternate CAS coordinates after acceptance', () => {
    const fixture = signedFixture('accepted');
    expect(applyOperationalProjectionCasRecovery(fixture.input)).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
    });
    const alternateRequest = buildOperationalProjectionAnchorRequest({
      anchorId: 'ashlr-anchor-secondary',
      namespace: 'ashlr/projections/alternate',
      requestNonce: '8'.repeat(64),
      expected: fixture.input.casRequest.expected,
      source: fixture.input.casRequest.source,
    });
    const conflictingReceipt = signedReceipt(
      alternateRequest,
      'conflict',
      fixture.privateKey,
    );

    expect(applyOperationalProjectionCasRecovery({
      ...fixture.input,
      casRequest: alternateRequest,
      untrustedCasReceipt: conflictingReceipt,
      casTrust: {
        ...fixture.input.casTrust,
        anchorId: alternateRequest.anchorId,
      },
    })).toMatchObject({
      state: 'refused',
      reason: 'cas-consumption-identity-already-decided',
      authenticated: false,
      localMutationApplied: false,
      historicalAuthority: false,
      operationalAuthority: false,
      rollbackAuthority: false,
      rollbackProtected: false,
    });
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'healthy',
      actual: 'complete',
      transaction: { phase: 'committed' },
    });
    expect(readOperationalProjectionCasConsumptionRecords().records).toHaveLength(2);
  });

  it('normalizes legacy coordinate-bound records before refusing an alternate conflict', () => {
    const fixture = signedFixture('accepted');
    expect(applyOperationalProjectionCasRecovery(fixture.input).state).toBe('applied');
    rewriteConsumptionRecordsAsLegacy();
    const legacyRecords = readOperationalProjectionCasConsumptionRecords();
    expect(legacyRecords).toMatchObject({
      sourceState: 'healthy',
      complete: true,
    });
    expect(legacyRecords.records.map((record) => record.phase).sort()).toEqual([
      'applied',
      'prepared',
    ]);
    const alternateRequest = buildOperationalProjectionAnchorRequest({
      anchorId: 'ashlr-anchor-secondary',
      namespace: 'ashlr/projections/alternate',
      requestNonce: '8'.repeat(64),
      expected: fixture.input.casRequest.expected,
      source: fixture.input.casRequest.source,
    });

    expect(applyOperationalProjectionCasRecovery({
      ...fixture.input,
      casRequest: alternateRequest,
      untrustedCasReceipt: signedReceipt(
        alternateRequest,
        'conflict',
        fixture.privateKey,
      ),
      casTrust: {
        ...fixture.input.casTrust,
        anchorId: alternateRequest.anchorId,
      },
    })).toMatchObject({
      state: 'refused',
      reason: 'cas-consumption-identity-already-decided',
      authenticated: false,
      localMutationApplied: false,
    });
    expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
      state: 'healthy',
      actual: 'complete',
      transaction: { phase: 'committed' },
    });
    expect(readOperationalProjectionCasConsumptionRecords().records).toHaveLength(2);
  });

  it('resumes a legacy coordinate-bound prepared decision after restart', () => {
    const input = restorePreparedPublicationWitness('records-directory-fsync');
    rewriteConsumptionRecordsAsLegacy();

    expect(applyOperationalProjectionCasRecovery(input)).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
      authenticated: true,
      localMutationApplied: false,
      prepared: { phase: 'prepared' },
      completion: { phase: 'applied', resultingShadowPhase: 'committed' },
      shadow: { actual: 'complete', transaction: { phase: 'committed' } },
    });
    expect(readOperationalProjectionCasConsumptionRecords()).toMatchObject({
      sourceState: 'healthy',
      complete: true,
    });
    expect(readOperationalProjectionCasConsumptionRecords().records).toHaveLength(2);
  });

  it.each(['accepted', 'conflict'] as const)(
    'refuses a signed %s receipt whose request forges the committed attestation',
    (decision) => {
      const fixture = signedFixture(decision);
      const forgedRequest = buildOperationalProjectionAnchorRequest({
        anchorId: fixture.input.casRequest.anchorId,
        namespace: fixture.input.casRequest.namespace,
        requestNonce: fixture.input.casRequest.requestNonce,
        expected: fixture.input.casRequest.expected,
        source: {
          ...fixture.input.casRequest.source,
          transactionAttestation: 'f'.repeat(64),
        },
      });
      const forgedReceipt = signedReceipt(forgedRequest, decision, fixture.privateKey);

      expect(applyOperationalProjectionCasRecovery({
        ...fixture.input,
        casRequest: forgedRequest,
        untrustedCasReceipt: forgedReceipt,
      })).toMatchObject({
        state: 'refused',
        reason: 'shadow-decision-binding-mismatch',
        authenticated: false,
        localMutationApplied: false,
        historicalAuthority: false,
        operationalAuthority: false,
        rollbackAuthority: false,
        rollbackProtected: false,
      });
      expect(fs.existsSync(operationalProjectionCasConsumptionStorePath())).toBe(false);
      expect(inspectOperationalProjectionShadowWrite()).toMatchObject({
        state: 'healthy',
        actual: 'complete',
        transaction: { phase: 'committed' },
      });
    },
  );

  it.each([
    'temporary',
    'stage',
    'target-link',
    'records-directory-fsync',
  ] as const)(
    'recovers an authenticated prepared record after the %s publication boundary',
    (boundary) => {
      const resumed = applyOperationalProjectionCasRecovery(
        restorePreparedPublicationWitness(boundary),
      );
      expect(resumed).toMatchObject({
        state: 'applied',
        decision: 'roll-forward',
        authenticated: true,
        localMutationApplied: false,
        prepared: { phase: 'prepared' },
        completion: { phase: 'applied', resultingShadowPhase: 'committed' },
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
      expect(records.records.map((record) => record.phase).sort()).toEqual([
        'applied',
        'prepared',
      ]);
      expect(fs.readdirSync(path.join(
        operationalProjectionCasConsumptionStorePath(),
        'staging',
      ))).toEqual([]);
    },
  );

  it('reclaims a provably dead writer lock before recovering staged publication', () => {
    const input = restorePreparedPublicationWitness('stage');
    const lockPath = path.join(
      operationalProjectionCasConsumptionStorePath(),
      '.cas-consumption.lock',
    );
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 2_147_483_647,
      token: 'stale-m438',
    })}\n`, { mode: 0o600 });

    expect(applyOperationalProjectionCasRecovery(input)).toMatchObject({
      state: 'applied',
      decision: 'roll-forward',
      authenticated: true,
      localMutationApplied: false,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(path.join(
      operationalProjectionCasConsumptionStorePath(),
      'staging',
    ))).toEqual([]);
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
