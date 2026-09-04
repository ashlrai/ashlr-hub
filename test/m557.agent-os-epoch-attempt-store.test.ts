import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_OS_EPOCH_ATTEMPT_SET_DOMAIN_V1,
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  agentOsEpochAttemptSetDigestV1,
  agentOsEpochSnapshotBindingDigestV1,
  agentOsEpochSnapshotBindingSetDigestV1,
  beginAgentOsEpochAttemptV2,
  completeAgentOsEpochAttemptV2,
  createAgentOsEpochAttemptStartReceiptProviderV1,
  readAgentOsEpochAttemptReceiptsV2,
  recoverAgentOsEpochAttemptStoreV2,
  type AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  type AgentOsEpochAttemptStoreDependenciesV1,
} from '../src/core/vision/agent-os-epoch-attempt-store.js';
import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';
import type { LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
  canonicalAgentOsEpochAttemptReceiptBytesV2,
  createAgentOsEpochAttemptReceiptV2,
} from '../src/core/vision/agent-os-epoch-records.js';

const roots: string[] = [];
const leases: AgentOsEpochCoordinationLeaseV1[] = [];
const locks: LocalStoreLock[] = [];
const key = Buffer.from('m557-attempt-authenticator-key!!', 'utf8').subarray(0, 32);
const raw = (label: string): string => createHash('sha256').update(label).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const WRITER = prefixed('writer-protocol');
const TICK_ONE = prefixed('durable-tick-one');
const TICK_TWO = prefixed('durable-tick-two');
const STARTED = '2026-09-03T12:00:00.000Z';
const COMPLETED = '2026-09-03T12:00:01.000Z';
const ATTEMPT_KEY = raw('attempt-key');

function snapshotBatchVerifier(
  verify: (input: Readonly<Parameters<typeof agentOsEpochSnapshotBindingDigestV1>[0]>) => boolean,
) {
  return {
    verifyExactBindings(request: {
      inputSetDigest: string;
      bindings: ReadonlyArray<Parameters<typeof agentOsEpochSnapshotBindingDigestV1>[0]>;
    }) {
      return {
        state: 'authenticated' as const,
        inputSetDigest: request.inputSetDigest,
        decisions: request.bindings.map((binding) => ({
          bindingDigest: agentOsEpochSnapshotBindingDigestV1(binding)!,
          verified: verify(binding),
        })),
      };
    },
  };
}

function attemptCrypto(label: string) {
  const material = createHash('sha256').update(`m557-key:${label}`).digest();
  const keyId = raw(`attempt-key-${label}`);
  return {
    signer: {
      keyId,
      authenticate: (payload: Uint8Array) =>
        createHmac('sha256', material).update(payload).digest('hex'),
    },
    verifier: {
      keyId,
      verify: (input: { canonicalDomainSeparatedReceipt: Uint8Array; authenticator: string }) =>
        createHmac('sha256', material).update(input.canonicalDomainSeparatedReceipt).digest('hex') ===
        input.authenticator,
    },
  };
}

afterEach(() => {
  for (const lock of locks.splice(0)) releaseAgentOsObservationLockV1(lock);
  for (const lease of leases.splice(0)) releaseAgentOsEpochCoordinationLeaseV1(lease);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function closure(
  epoch = 1,
  attemptAuthenticatorKeyId = ATTEMPT_KEY,
  attemptAuthenticatorGeneration = 1,
): AgentOsAuthenticatedActiveEpochAttemptClosureV1 {
  return {
    epoch,
    epochHeadDigest: prefixed(`epoch-head-${epoch}`),
    epochManifestDigest: prefixed(`epoch-manifest-${epoch}`),
    attemptNamespaceDigest: prefixed(`attempt-namespace-${epoch}`),
    sourceBundleDigest: raw(`source-bundle-${epoch}`),
    trustPolicyDigest: raw(`trust-policy-${epoch}`),
    attemptAuthenticatorKeyId,
    attemptAuthenticatorGeneration,
    writerProtocolDigest: WRITER,
  };
}

function fixture(overrides: Partial<AgentOsEpochAttemptStoreDependenciesV1> = {}) {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m557-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const epochsPath = join(epochStoreRootPath, 'epochs');
  const epochPath = join(epochsPath, 'epoch-000000000001');
  const attemptsPath = join(epochPath, 'attempts');
  for (const path of [epochStoreRootPath, epochsPath, epochPath, attemptsPath]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  let active = closure();
  let providerReads = 0;
  const signer = {
    keyId: ATTEMPT_KEY,
    authenticate: (payload: Uint8Array) => createHmac('sha256', key).update(payload).digest('hex'),
  };
  const verifier = {
    keyId: signer.keyId,
    verify: (input: { canonicalDomainSeparatedReceipt: Uint8Array; authenticator: string }) =>
      createHmac('sha256', key).update(input.canonicalDomainSeparatedReceipt).digest('hex') ===
      input.authenticator,
  };
  const historicalSources = new Map<string, {
    generation: number;
    signer: typeof signer | null;
    verifier: typeof verifier;
  }>([[`${active.sourceBundleDigest}:${active.trustPolicyDigest}`, {
    generation: active.attemptAuthenticatorGeneration, signer, verifier,
  }]]);
  const resolveHistoricalSource = (
    lineage: Parameters<AgentOsEpochAttemptStoreDependenciesV1[
      'historicalSourceLineageProvider']['resolveAuthenticatedHistoricalSource']>[0],
  ) => {
    const selected = historicalSources.get(`${lineage.sourceBundleDigest}:${lineage.trustPolicyDigest}`);
    return lineage.epoch === active.epoch && lineage.epochHeadDigest === active.epochHeadDigest &&
      lineage.epochManifestDigest === active.epochManifestDigest &&
      lineage.attemptNamespaceDigest === active.attemptNamespaceDigest && selected &&
      selected.verifier.keyId === lineage.attemptAuthenticatorKeyId
      ? {
          state: 'authenticated' as const,
          lineage: { ...lineage, attemptAuthenticatorGeneration: selected.generation },
          verifier: selected.verifier,
          signer: selected.signer,
        }
      : { state: 'missing' as const };
  };
  const dependencies: AgentOsEpochAttemptStoreDependenciesV1 = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest: WRITER,
    activeClosureProvider: {
      readAuthenticatedClosure: () => {
        providerReads += 1;
        return { state: 'authenticated' as const, closure: { ...active } };
      },
    },
    historicalSourceLineageProvider: {
      resolveAuthenticatedHistoricalSource: resolveHistoricalSource,
      resolveAuthenticatedHistoricalSources: (request) => ({
        state: 'authenticated' as const,
        inputSetDigest: request.inputSetDigest,
        resolutions: request.lineages.map((lineage) => {
          const resolution = resolveHistoricalSource(lineage);
          return {
            lineageDigest: agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!,
            resolution: resolution.state === 'authenticated'
              ? {
                  state: 'authenticated' as const,
                  lineage: resolution.lineage,
                  verifier: resolution.verifier,
                }
              : resolution,
          };
        }),
      }),
    },
    signer,
    ...overrides,
  };
  const lease = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: epochStoreRootPath,
    writerProtocolDigest: WRITER,
  });
  if (lease.state !== 'acquired') throw new Error('could not acquire epoch coordination lease');
  leases.push(lease.lease);
  const observationLock = acquireAgentOsObservationLockV1(anchorPath);
  if (!observationLock) throw new Error('could not acquire observation lock');
  locks.push(observationLock);
  return {
    anchorPath,
    epochStoreRootPath,
    epochPath,
    attemptsPath,
    dependencies,
    lease: lease.lease,
    observationLock,
    setClosure(value: AgentOsAuthenticatedActiveEpochAttemptClosureV1, authenticators = { signer, verifier }) {
      active = value;
      historicalSources.set(`${value.sourceBundleDigest}:${value.trustPolicyDigest}`, {
        generation: value.attemptAuthenticatorGeneration,
        signer: authenticators.signer,
        verifier: authenticators.verifier,
      });
      dependencies.signer = authenticators.signer;
    },
    removeHistoricalSource(sourceBundleDigest: string, trustPolicyDigest: string) {
      historicalSources.delete(`${sourceBundleDigest}:${trustPolicyDigest}`);
    },
    providerReads: () => providerReads,
    begin(tick = TICK_ONE, startedAt = STARTED) {
      return beginAgentOsEpochAttemptV2({
        durableTickDigest: tick,
        startedAt,
        coordinationLease: lease.lease,
        observationLock,
      }, dependencies);
    },
    complete(
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'deadline-exceeded' = 'failed',
      snapshotEnvelopeDigest: string | null = null,
      completedAt = COMPLETED,
      tick = TICK_ONE,
    ) {
      return completeAgentOsEpochAttemptV2({
        durableTickDigest: tick,
        outcome,
        snapshotEnvelopeDigest,
        completedAt,
        coordinationLease: lease.lease,
        observationLock,
      }, dependencies);
    },
  };
}

function expectNoAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    authority: 'observation-only',
    writesAuthorized: false,
    pointerMutationAuthorized: false,
    anchorMutationAuthority: false,
    planningAuthority: false,
    executionAuthority: false,
    effectAuthority: false,
    proposalAuthority: false,
    learningAuthority: false,
    promotionAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    budgetAuthority: false,
    credentialAuthority: false,
    externalMutationAuthority: false,
    rollbackProtected: false,
    sameUserTamperResistant: false,
  });
}

describe('M557 durable epoch Attempt Receipt V2 store', () => {
  it('treats the exact empty M553 attempts directory as a healthy bounded ledger', () => {
    const value = fixture();
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      records: [],
      openAttempts: 0,
      epoch: 1,
      closureAuthenticated: true,
    });
    expect(read.attemptSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(existsSync(join(value.attemptsPath, 'records'))).toBe(false);
    expectNoAuthority(read as unknown as Record<string, unknown>);
  });

  it('persists one deterministic immutable start slot and replays exact input', () => {
    const value = fixture();
    const first = value.begin();
    const replay = value.begin();
    expect(first).toMatchObject({
      disposition: 'recorded', reason: 'recorded', durable: true, closureAuthenticated: true,
      receipt: { epoch: 1, transitionOrdinal: 1, durableTickDigest: TICK_ONE },
    });
    expect(replay).toMatchObject({
      disposition: 'replayed', reason: 'receipt-replay', durable: true,
      receipt: { receiptDigest: first.receipt?.receiptDigest },
    });
    const rawAttemptId = first.receipt!.attemptId.slice(7);
    const recordPath = join(value.attemptsPath, 'records', `${rawAttemptId}.1.json`);
    expect(existsSync(recordPath)).toBe(true);
    expect(readFileSync(recordPath, 'utf8').endsWith('\n')).toBe(true);
    expectNoAuthority(first as unknown as Record<string, unknown>);
  });

  it('persists and verifies an exact failed start-to-terminal chain and attempt-set digest', () => {
    const value = fixture();
    const start = value.begin();
    const terminal = value.complete('failed');
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(terminal).toMatchObject({
      disposition: 'recorded', durable: true,
      receipt: {
        transitionOrdinal: 2,
        outcome: 'failed',
        previousReceiptDigest: start.receipt?.receiptDigest,
      },
    });
    expect(read).toMatchObject({
      sourceState: 'healthy', complete: true, openAttempts: 0, records: { length: 2 },
    });
    expect(read.attemptSetDigest).toBe(agentOsEpochAttemptSetDigestV1({
      epoch: 1,
      attemptNamespaceDigest: closure().attemptNamespaceDigest,
      receipts: [...read.records].reverse().map((receipt) => ({
        attemptId: receipt.attemptId,
        transitionOrdinal: receipt.transitionOrdinal,
        receiptDigest: receipt.receiptDigest,
      })),
    }));
  });

  it('makes the attempt-set digest epoch-, namespace-, slot-, and order-stable', () => {
    const receipt = {
      attemptId: prefixed('attempt'),
      transitionOrdinal: 1 as const,
      receiptDigest: raw('receipt'),
    };
    const input = { epoch: 1, attemptNamespaceDigest: prefixed('namespace'), receipts: [receipt] };
    const digest = agentOsEpochAttemptSetDigestV1(input)!;
    expect(digest).toBe(`sha256:${createHash('sha256')
      .update(AGENT_OS_EPOCH_ATTEMPT_SET_DOMAIN_V1, 'utf8')
      .update(JSON.stringify({
        attemptNamespaceDigest: input.attemptNamespaceDigest,
        epoch: input.epoch,
        receipts: input.receipts,
      }))
      .digest('hex')}`);
    expect(agentOsEpochAttemptSetDigestV1({ ...input, epoch: 2 })).not.toBe(digest);
    expect(agentOsEpochAttemptSetDigestV1({
      ...input, attemptNamespaceDigest: prefixed('other-namespace'),
    })).not.toBe(digest);
    expect(agentOsEpochAttemptSetDigestV1({ ...input, receipts: [receipt, receipt] })).toBeNull();
  });

  it('withholds successful terminals unless Snapshot V2 confirms reciprocal exact binding', () => {
    const absent = fixture();
    absent.begin();
    expect(absent.complete('succeeded', raw('snapshot'))).toMatchObject({
      disposition: 'withheld', reason: 'snapshot-v2-unverified', receipt: null,
    });
    expect(readAgentOsEpochAttemptReceiptsV2(absent.dependencies).records).toHaveLength(1);

    const observed: Array<Record<string, unknown>> = [];
    const accepted = fixture({
      snapshotV2ExistenceVerifier: snapshotBatchVerifier((input) => {
          observed.push(input as unknown as Record<string, unknown>);
          return input.snapshotEnvelopeDigest === raw('snapshot') &&
            input.sourceBundleDigest === closure().sourceBundleDigest;
        }),
    });
    accepted.begin();
    const terminal = accepted.complete('succeeded', raw('snapshot'));
    expect(terminal).toMatchObject({
      disposition: 'recorded', receipt: { outcome: 'succeeded', snapshotEnvelopeDigest: raw('snapshot') },
    });
    expect(observed.length).toBeGreaterThanOrEqual(4);
    expect(observed.every(Object.isFrozen)).toBe(true);
  });

  it('degrades a persisted success if its reciprocal Snapshot V2 binding disappears', () => {
    let snapshotPresent = true;
    const value = fixture({
      snapshotV2ExistenceVerifier: snapshotBatchVerifier(() => snapshotPresent),
    });
    value.begin();
    expect(value.complete('succeeded', raw('snapshot'))).toMatchObject({ disposition: 'recorded' });
    snapshotPresent = false;
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], attemptSetDigest: null,
    });
    expect(read.stopReasons).toContain('snapshot-v2-unverified');
  });

  it('validates all successful snapshot bindings in one sorted frozen batch per full read', () => {
    let calls = 0;
    let lastRequest: { bindings: ReadonlyArray<Record<string, unknown>> } | null = null;
    const value = fixture({
      snapshotV2ExistenceVerifier: {
        verifyExactBindings(request) {
          calls += 1;
          lastRequest = request as unknown as typeof lastRequest;
          return {
            state: 'authenticated',
            inputSetDigest: request.inputSetDigest,
            decisions: request.bindings.map((binding) => ({
              bindingDigest: agentOsEpochSnapshotBindingDigestV1(binding)!, verified: true,
            })),
          };
        },
      },
    });
    value.begin(TICK_ONE);
    value.complete('succeeded', raw('snapshot-one'), COMPLETED, TICK_ONE);
    value.begin(TICK_TWO, '2026-09-03T12:00:02.000Z');
    value.complete('succeeded', raw('snapshot-two'), '2026-09-03T12:00:03.000Z', TICK_TWO);
    calls = 0;
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true, records: { length: 4 } });
    expect(calls).toBe(1);
    expect(lastRequest).not.toBeNull();
    expect(Object.isFrozen(lastRequest)).toBe(true);
    expect(Object.isFrozen(lastRequest!.bindings)).toBe(true);
    const digests = lastRequest!.bindings.map((binding) =>
      agentOsEpochSnapshotBindingDigestV1(binding as never)!);
    expect(digests).toEqual([...digests].sort());
  });

  it('fails a substituted or reordered batch decision set closed', () => {
    const value = fixture({ snapshotV2ExistenceVerifier: snapshotBatchVerifier(() => true) });
    value.begin();
    value.complete('succeeded', raw('snapshot'));
    value.dependencies.snapshotV2ExistenceVerifier = {
      verifyExactBindings: (request) => ({
        state: 'authenticated',
        inputSetDigest: request.inputSetDigest,
        decisions: [{ bindingDigest: prefixed('substituted-binding'), verified: true }],
      }),
    };
    expect(readAgentOsEpochAttemptReceiptsV2(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['snapshot-v2-unverified'],
    });

    const duplicate = prefixed('duplicate-binding');
    expect(agentOsEpochSnapshotBindingSetDigestV1([duplicate, duplicate])).toBeNull();
    expect(agentOsEpochSnapshotBindingSetDigestV1(
      [prefixed('z-binding'), prefixed('a-binding')].sort().reverse(),
    )).toBeNull();

    const reordered = fixture({ snapshotV2ExistenceVerifier: snapshotBatchVerifier(() => true) });
    reordered.begin(TICK_ONE);
    reordered.complete('succeeded', raw('reordered-one'), COMPLETED, TICK_ONE);
    reordered.begin(TICK_TWO, '2026-09-03T12:00:02.000Z');
    reordered.complete('succeeded', raw('reordered-two'), '2026-09-03T12:00:03.000Z', TICK_TWO);
    reordered.dependencies.snapshotV2ExistenceVerifier = {
      verifyExactBindings: (request) => ({
        state: 'authenticated',
        inputSetDigest: request.inputSetDigest,
        decisions: request.bindings.map((binding) => ({
          bindingDigest: agentOsEpochSnapshotBindingDigestV1(binding)!, verified: true,
        })).reverse(),
      }),
    };
    expect(readAgentOsEpochAttemptReceiptsV2(reordered.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false,
    });
  });

  it('rejects non-success snapshot bindings and terminal-without-start', () => {
    const value = fixture();
    expect(value.complete('failed')).toMatchObject({
      disposition: 'withheld', reason: 'invalid-transition',
    });
    value.begin();
    expect(value.complete('failed', raw('illegal-snapshot'))).toMatchObject({
      disposition: 'withheld', reason: 'invalid-input',
    });
  });

  it('returns exact replay and conflicts a byte-distinct immutable transition slot', () => {
    const value = fixture();
    value.begin();
    const terminal = value.complete('cancelled');
    expect(value.complete('cancelled')).toMatchObject({
      disposition: 'replayed', receipt: { receiptDigest: terminal.receipt?.receiptDigest },
    });
    expect(value.complete('deadline-exceeded')).toMatchObject({
      disposition: 'conflicted', reason: 'publication-conflict', receipt: null,
    });
    expect(value.begin(TICK_ONE, '2026-09-03T12:00:00.001Z')).toMatchObject({
      disposition: 'conflicted', reason: 'publication-conflict', receipt: null,
    });
  });

  it('requires both exact write capabilities and the commissioned signer/verifier pair', () => {
    const missingLock = fixture();
    expect(releaseAgentOsObservationLockV1(missingLock.observationLock)).toBe(true);
    expect(missingLock.begin()).toMatchObject({
      disposition: 'withheld', reason: 'observation-lock-missing',
    });

    const missingLease = fixture();
    expect(releaseAgentOsEpochCoordinationLeaseV1(missingLease.lease)).toBe(true);
    expect(missingLease.begin()).toMatchObject({
      disposition: 'withheld', reason: 'coordination-lease-missing',
    });

    const signer = fixture({ signer: null });
    expect(signer.begin()).toMatchObject({ disposition: 'unavailable', reason: 'signer-unavailable' });
    const verifier = fixture({
      historicalSourceLineageProvider: {
        resolveAuthenticatedHistoricalSource: () => ({ state: 'unavailable' }),
        resolveAuthenticatedHistoricalSources: () => ({ state: 'unavailable' }),
      },
    });
    expect(verifier.begin()).toMatchObject({ disposition: 'unavailable', reason: 'verifier-unavailable' });
  });

  it('checks an injected runtime commit guard at live fences and fails closed without publication', () => {
    let checks = 0;
    const value = fixture({
      runtimeCommitGuard: {
        isCommitAuthorized() { checks += 1; return false; },
      },
    });
    expect(value.begin()).toMatchObject({
      disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
    });
    expect(checks).toBeGreaterThan(0);
    expect(existsSync(join(value.attemptsPath, 'records'))).toBe(false);
  });

  it('rechecks the trusted active closure immediately before link publication', () => {
    const value = fixture();
    const originalProvider = value.dependencies.activeClosureProvider;
    value.dependencies.activeClosureProvider = {
      readAuthenticatedClosure() {
        const read = originalProvider.readAuthenticatedClosure();
        if (value.providerReads() >= 4) value.setClosure(closure(2));
        return value.providerReads() >= 4
          ? { state: 'authenticated', closure: closure(2) }
          : read;
      },
    };
    const result = value.begin();
    expect(result).toMatchObject({ disposition: 'withheld', reason: 'closure-changed', durable: false });
    expect(existsSync(join(value.attemptsPath, 'records')) &&
      (readAgentOsEpochAttemptReceiptsV2({
        ...value.dependencies,
        activeClosureProvider: { readAuthenticatedClosure: () => ({ state: 'authenticated', closure: closure() }) },
      }).records.length > 0)).toBe(false);
  });

  it('rechecks capability ownership after the trusted closure provider returns', () => {
    const value = fixture();
    const originalProvider = value.dependencies.activeClosureProvider;
    value.dependencies.activeClosureProvider = {
      readAuthenticatedClosure() {
        const read = originalProvider.readAuthenticatedClosure();
        if (value.providerReads() === 2) releaseAgentOsEpochCoordinationLeaseV1(value.lease);
        return read;
      },
    };
    expect(value.begin()).toMatchObject({
      disposition: 'withheld', reason: 'closure-changed', durable: false,
    });
    expect(existsSync(join(value.attemptsPath, 'records')) &&
      readAgentOsEpochAttemptReceiptsV2({
        ...value.dependencies,
        activeClosureProvider: { readAuthenticatedClosure: () => ({ state: 'authenticated', closure: closure() }) },
      }).records.length > 0).toBe(false);
  });

  it('fails nested same-root writes and poisons the affected outer write without publication', () => {
    const value = fixture();
    const original = value.dependencies.activeClosureProvider;
    let nested: ReturnType<typeof beginAgentOsEpochAttemptV2> | null = null;
    let attempted = false;
    value.dependencies.activeClosureProvider = {
      readAuthenticatedClosure() {
        if (!attempted) {
          attempted = true;
          nested = value.begin(TICK_TWO, '2026-09-03T12:00:02.000Z');
        }
        return original.readAuthenticatedClosure();
      },
    };
    expect(value.begin()).toMatchObject({
      disposition: 'withheld', reason: 'reentrant-call', durable: false,
    });
    expect(nested).toMatchObject({ disposition: 'withheld', reason: 'reentrant-call' });
    expect(existsSync(join(value.attemptsPath, 'records'))).toBe(false);
  });

  it('guardedly heals a records-only attempt layout before a complete write read', () => {
    const value = fixture();
    mkdirSync(join(value.attemptsPath, 'records'), { mode: 0o700 });
    expect(value.begin()).toMatchObject({ disposition: 'recorded', durable: true });
    expect(existsSync(join(value.attemptsPath, 'staging'))).toBe(true);
  });

  it('withholds replay when the active closure changes after the record was persisted', () => {
    const value = fixture();
    value.begin();
    value.setClosure(closure(2));
    expect(value.begin()).toMatchObject({
      disposition: 'unavailable', reason: 'chain-unavailable', durable: false,
    });
  });

  it('rejects same-epoch cross-namespace and cross-source replay', () => {
    const value = fixture();
    value.begin();
    value.setClosure({
      ...closure(),
      attemptNamespaceDigest: prefixed('different-namespace'),
      sourceBundleDigest: raw('different-source'),
    });
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], attemptSetDigest: null,
    });
    expect(read.stopReasons).toContain('invalid-file');
    expect(value.begin()).toMatchObject({ disposition: 'unavailable', reason: 'chain-unavailable' });
  });

  it('preserves historical A receipts, closes an in-flight A attempt after renewal to B, and admits new starts on B', () => {
    const value = fixture();
    const sourceA = closure();
    const startedA = value.begin(TICK_ONE);
    const sourceB = {
      ...sourceA,
      sourceBundleDigest: raw('source-bundle-B'),
      trustPolicyDigest: raw('trust-policy-B'),
    };
    value.setClosure(sourceB);

    const afterRenewal = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(afterRenewal).toMatchObject({ sourceState: 'healthy', complete: true, openAttempts: 1 });
    expect(afterRenewal.records[0]).toMatchObject({
      receiptDigest: startedA.receipt?.receiptDigest,
      sourceBundleDigest: sourceA.sourceBundleDigest,
      trustPolicyDigest: sourceA.trustPolicyDigest,
    });

    const terminalA = value.complete('failed', null, COMPLETED, TICK_ONE);
    expect(terminalA).toMatchObject({
      disposition: 'recorded',
      receipt: {
        sourceBundleDigest: sourceA.sourceBundleDigest,
        trustPolicyDigest: sourceA.trustPolicyDigest,
        previousReceiptDigest: startedA.receipt?.receiptDigest,
      },
    });
    const startedB = value.begin(TICK_TWO, '2026-09-03T12:00:02.000Z');
    expect(startedB).toMatchObject({
      disposition: 'recorded',
      receipt: {
        sourceBundleDigest: sourceB.sourceBundleDigest,
        trustPolicyDigest: sourceB.trustPolicyDigest,
      },
    });
    expect(readAgentOsEpochAttemptReceiptsV2(value.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true, openAttempts: 1, records: { length: 3 },
    });
  });

  it('uses authenticated source A key lineage and exact start receipt for success after A-to-B rotation', () => {
    let expectedStartDigest = raw('initially-wrong-start');
    const observed: Array<Record<string, unknown>> = [];
    const receiptStates: string[] = [];
    let startProvider: ReturnType<typeof createAgentOsEpochAttemptStartReceiptProviderV1> | null = null;
    const value = fixture({
      snapshotV2ExistenceVerifier: snapshotBatchVerifier((input) => {
          observed.push(input as unknown as Record<string, unknown>);
          if (!startProvider || input.producerStartReceiptDigest !== expectedStartDigest ||
            input.sourceBundleDigest !== closure().sourceBundleDigest) return false;
          const receipt = startProvider.readAuthenticatedStartReceipt({
            epoch: input.epoch,
            anchoredHeadDigest: input.epochHeadDigest,
            epochManifestDigest: closure().epochManifestDigest,
            attemptNamespaceDigest: input.attemptNamespaceDigest,
            producerAttemptId: input.attemptId,
            durableTickDigest: TICK_ONE,
          });
          receiptStates.push(receipt.state);
          return receipt.state === 'authenticated' &&
            receipt.startReceiptDigest === input.producerStartReceiptDigest;
        }),
    });
    startProvider = createAgentOsEpochAttemptStartReceiptProviderV1(value.dependencies);
    const sourceA = closure();
    const startedA = value.begin();
    const cryptoB = attemptCrypto('B');
    value.setClosure({
      ...sourceA,
      sourceBundleDigest: raw('source-bundle-B-key-rotation'),
      trustPolicyDigest: raw('trust-policy-B-key-rotation'),
      attemptAuthenticatorKeyId: cryptoB.signer.keyId,
      attemptAuthenticatorGeneration: 2,
    }, cryptoB);

    expect(startProvider.readAuthenticatedStartReceipt({
      epoch: 1,
      anchoredHeadDigest: sourceA.epochHeadDigest,
      epochManifestDigest: sourceA.epochManifestDigest,
      attemptNamespaceDigest: sourceA.attemptNamespaceDigest,
      producerAttemptId: startedA.receipt!.attemptId,
      durableTickDigest: TICK_ONE,
    })).toMatchObject({
      state: 'authenticated',
      startReceiptDigest: startedA.receipt!.receiptDigest,
      sourceBundleDigest: sourceA.sourceBundleDigest,
      trustPolicyDigest: sourceA.trustPolicyDigest,
    });

    expect(value.complete('succeeded', raw('snapshot-after-renewal'))).toMatchObject({
      disposition: 'withheld', reason: 'snapshot-v2-unverified',
    });
    expectedStartDigest = startedA.receipt!.receiptDigest;
    const completed = value.complete('succeeded', raw('snapshot-after-renewal'));
    expect(receiptStates.every((state) => state === 'authenticated')).toBe(true);
    expect(completed).toMatchObject({
      disposition: 'recorded',
      receipt: {
        authenticatorKeyId: sourceA.attemptAuthenticatorKeyId,
        sourceBundleDigest: sourceA.sourceBundleDigest,
        previousReceiptDigest: startedA.receipt?.receiptDigest,
      },
    });
    expect(observed.at(-1)).toMatchObject({
      sourceBundleDigest: sourceA.sourceBundleDigest,
      trustPolicyDigest: sourceA.trustPolicyDigest,
      producerStartReceiptDigest: startedA.receipt?.receiptDigest,
    });
  });

  it('degrades historical reads and blocks terminal closure when A lineage is missing after renewal to B', () => {
    const value = fixture();
    const sourceA = closure();
    value.begin();
    value.setClosure({
      ...sourceA,
      sourceBundleDigest: raw('source-bundle-B'),
      trustPolicyDigest: raw('trust-policy-B'),
    });
    value.removeHistoricalSource(sourceA.sourceBundleDigest, sourceA.trustPolicyDigest);

    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], attemptSetDigest: null,
    });
    expect(read.stopReasons).toContain('invalid-file');
    expect(value.complete('failed')).toMatchObject({
      disposition: 'unavailable', reason: 'chain-unavailable', receipt: null,
    });
  });

  it('authenticates 1000 receipts across a large lineage set with one bounded batch callback', () => {
    const value = fixture({ maxRecords: 1_200 });
    const recordsPath = join(value.attemptsPath, 'records');
    mkdirSync(recordsPath, { mode: 0o700 });
    mkdirSync(join(value.attemptsPath, 'staging'), { mode: 0o700 });
    const sourceCount = 250;
    for (let index = 0; index < 500; index += 1) {
      const sourceIndex = index % sourceCount;
      const context = {
        epoch: 1,
        attemptNamespaceDigest: closure().attemptNamespaceDigest,
        sourceBundleDigest: raw(`scale-source-${sourceIndex}`),
        trustPolicyDigest: raw(`scale-policy-${sourceIndex}`),
      };
      const startedAt = new Date(Date.parse(STARTED) + index * 2).toISOString();
      const completedAt = new Date(Date.parse(STARTED) + index * 2 + 1).toISOString();
      const start = createAgentOsEpochAttemptReceiptV2({
        ...context,
        durableTickDigest: prefixed(`scale-tick-${index}`),
        transitionOrdinal: 1,
        previousReceiptDigest: AGENT_OS_EPOCH_ATTEMPT_RAW_GENESIS_DIGEST_V2,
        outcome: null,
        snapshotEnvelopeDigest: null,
        startedAt,
        completedAt: null,
      }, value.dependencies.signer!);
      if (!start) throw new Error('scale start receipt creation failed');
      const terminal = createAgentOsEpochAttemptReceiptV2({
        ...context,
        durableTickDigest: start.durableTickDigest,
        transitionOrdinal: 2,
        previousReceiptDigest: start.receiptDigest,
        outcome: 'failed',
        snapshotEnvelopeDigest: null,
        startedAt,
        completedAt,
      }, value.dependencies.signer!);
      if (!terminal) throw new Error('scale terminal receipt creation failed');
      for (const receipt of [start, terminal]) {
        const bytes = canonicalAgentOsEpochAttemptReceiptBytesV2(receipt)!;
        writeFileSync(
          join(recordsPath, `${receipt.attemptId.slice(7)}.${receipt.transitionOrdinal}.json`),
          Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]),
          { mode: 0o600 },
        );
      }
    }
    let pointCallbacks = 0;
    let batchCallbacks = 0;
    let simulatedSourceRowsScanned = 0;
    value.dependencies.historicalSourceLineageProvider = {
      resolveAuthenticatedHistoricalSource: () => {
        pointCallbacks += 1;
        return { state: 'unavailable' };
      },
      resolveAuthenticatedHistoricalSources: (request) => {
        batchCallbacks += 1;
        simulatedSourceRowsScanned += sourceCount;
        return {
          state: 'authenticated',
          inputSetDigest: request.inputSetDigest,
          resolutions: request.lineages.map((lineage) => ({
            lineageDigest: agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!,
            resolution: {
              state: 'authenticated',
              lineage: { ...lineage, attemptAuthenticatorGeneration: 1 },
              verifier: {
                keyId: value.dependencies.signer!.keyId,
                verify: (input) => createHmac('sha256', key)
                  .update(input.canonicalDomainSeparatedReceipt).digest('hex') === input.authenticator,
              },
            },
          })),
        };
      },
    };
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true, records: { length: 1_000 } });
    expect(batchCallbacks).toBe(1);
    expect(pointCallbacks).toBe(0);
    expect(simulatedSourceRowsScanned).toBe(sourceCount);
  }, 30_000);

  it('fails lineage batches closed on mutation, signer injection, reorder, and reentrancy', () => {
    const mutation = fixture();
    mutation.begin();
    mutation.dependencies.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSources = (request) => {
      (request.lineages as unknown[]).reverse();
      return { state: 'degraded' };
    };
    expect(readAgentOsEpochAttemptReceiptsV2(mutation.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['verifier-unavailable'],
    });

    const injected = fixture();
    injected.begin();
    const injectedPoint = injected.dependencies.historicalSourceLineageProvider
      .resolveAuthenticatedHistoricalSource.bind(injected.dependencies.historicalSourceLineageProvider);
    injected.dependencies.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSources = (request) => ({
      state: 'authenticated',
      inputSetDigest: request.inputSetDigest,
      resolutions: request.lineages.map((lineage) => {
        const resolution = injectedPoint(lineage);
        return {
          lineageDigest: agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!,
          resolution,
        };
      }),
    }) as never;
    expect(readAgentOsEpochAttemptReceiptsV2(injected.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['verifier-unavailable'],
    });

    const reordered = fixture();
    reordered.begin();
    reordered.setClosure({
      ...closure(),
      sourceBundleDigest: raw('lineage-batch-source-B'),
      trustPolicyDigest: raw('lineage-batch-policy-B'),
    });
    reordered.begin(TICK_TWO, '2026-09-03T12:00:02.000Z');
    const validBatch = reordered.dependencies.historicalSourceLineageProvider
      .resolveAuthenticatedHistoricalSources.bind(reordered.dependencies.historicalSourceLineageProvider);
    reordered.dependencies.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSources = (request) => {
      const result = validBatch(request);
      return result.state === 'authenticated'
        ? { ...result, resolutions: [...result.resolutions].reverse() }
        : result;
    };
    expect(readAgentOsEpochAttemptReceiptsV2(reordered.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['verifier-unavailable'],
    });

    const reentrant = fixture();
    reentrant.begin();
    reentrant.dependencies.historicalSourceLineageProvider.resolveAuthenticatedHistoricalSources = () => {
      readAgentOsEpochAttemptReceiptsV2(reentrant.dependencies);
      return { state: 'degraded' };
    };
    expect(readAgentOsEpochAttemptReceiptsV2(reentrant.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['reentrant-call'],
    });
  });

  it('fails complete reads closed after canonical bytes are tampered', () => {
    const value = fixture();
    const start = value.begin();
    const path = join(
      value.attemptsPath,
      'records',
      `${start.receipt!.attemptId.slice(7)}.1.json`,
    );
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    parsed['startedAt'] = '2026-09-03T12:00:00.001Z';
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    const withheld = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(withheld).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], attemptSetDigest: null,
    });
    expect(withheld.stopReasons).toContain('invalid-file');
  });

  it('fails closed on unexpected files and accessor-shaped API input', () => {
    const value = fixture();
    value.begin();
    writeFileSync(join(value.attemptsPath, 'unexpected'), 'x', { mode: 0o600 });
    expect(readAgentOsEpochAttemptReceiptsV2(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, records: [],
    });
    const malicious = {
      get durableTickDigest() { throw new Error('accessor must not run'); },
      startedAt: STARTED,
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    };
    expect(beginAgentOsEpochAttemptV2(
      malicious as never,
      value.dependencies,
    )).toMatchObject({ disposition: 'withheld', reason: 'invalid-input' });
  });

  it('enforces bounded capacity without overwriting durable receipts', () => {
    const value = fixture({ maxRecords: 2 });
    value.begin();
    value.complete('failed');
    expect(value.begin(TICK_TWO, '2026-09-03T12:00:02.000Z')).toMatchObject({
      disposition: 'withheld', reason: 'capacity-exhausted',
    });
    const read = readAgentOsEpochAttemptReceiptsV2(value.dependencies);
    expect(read).toMatchObject({ records: { length: 2 }, capacityExhausted: true });
  });

  it('conservatively reports a pristine store clean after guarded exact-layout initialization', () => {
    const value = fixture();
    expect(recoverAgentOsEpochAttemptStoreV2({
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    }, value.dependencies)).toBe('clean');
    expect(existsSync(join(value.attemptsPath, 'records'))).toBe(true);
    expect(existsSync(join(value.attemptsPath, 'staging'))).toBe(true);
  });
});
