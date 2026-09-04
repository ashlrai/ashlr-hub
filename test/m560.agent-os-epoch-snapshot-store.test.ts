import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1,
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  agentOsEpochSnapshotBindingDigestV1,
  agentOsEpochSnapshotBindingSetDigestV1,
  beginAgentOsEpochAttemptV2,
  completeAgentOsEpochAttemptV2,
  type AgentOsAuthenticatedActiveEpochAttemptClosureV1,
  type AgentOsEpochAttemptStoreDependenciesV1,
  type AgentOsEpochSnapshotBindingBatchRequestV1,
  type AgentOsEpochSnapshotV2BindingVerificationInputV1,
} from '../src/core/vision/agent-os-epoch-attempt-store.js';
import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import { agentOsEpochAttemptIdV1 } from '../src/core/vision/agent-os-epoch-records.js';
import {
  createAgentOsEpochSnapshotV2ExistenceVerifierV1,
  isAgentOsEpochSnapshotStorePlatformSupportedV1,
  readAgentOsEpochSnapshotsV2,
  recoverAgentOsEpochSnapshotStoreV2,
  writeAgentOsEpochSnapshotV2,
  type AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
  type AgentOsEpochSnapshotStoreDependenciesV1,
  type WriteAgentOsEpochSnapshotV2Input,
} from '../src/core/vision/agent-os-epoch-snapshot-store.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';
import type { AgentOsReadModelV1 } from '../src/core/vision/agent-os-read-model.js';

const roots: string[] = [];
const leases: AgentOsEpochCoordinationLeaseV1[] = [];
const locks: LocalStoreLock[] = [];
const key = Buffer.alloc(32, 0x60);
const raw = (label: string): string => createHash('sha256').update(`m560\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const WRITER = prefixed('writer-protocol');
const TICK_ONE = prefixed('tick-one');
const TICK_TWO = prefixed('tick-two');

function bindingBatch(
  bindings: readonly AgentOsEpochSnapshotV2BindingVerificationInputV1[],
): AgentOsEpochSnapshotBindingBatchRequestV1 {
  const sorted = bindings.map((binding) => ({
    binding: { ...binding }, digest: agentOsEpochSnapshotBindingDigestV1(binding)!,
  })).sort((left, right) => left.digest.localeCompare(right.digest));
  return {
    protocol: AGENT_OS_EPOCH_SNAPSHOT_BINDING_BATCH_PROTOCOL_V1,
    inputSetDigest: agentOsEpochSnapshotBindingSetDigestV1(
      sorted.map(({ digest }) => digest),
    )!,
    bindings: sorted.map(({ binding }) => binding),
  };
}

function bindingFor(
  envelope: NonNullable<ReturnType<typeof writeAgentOsEpochSnapshotV2>['envelope']>,
): AgentOsEpochSnapshotV2BindingVerificationInputV1 {
  return {
    epoch: envelope.epoch,
    epochHeadDigest: envelope.anchoredHeadDigest,
    attemptNamespaceDigest: envelope.attemptNamespaceDigest,
    attemptId: envelope.producerAttemptId,
    producerStartReceiptDigest: envelope.producerStartReceiptDigest,
    sourceBundleDigest: envelope.sourceBundleDigest,
    trustPolicyDigest: envelope.trustPolicyDigest,
    snapshotEnvelopeDigest: envelope.envelopeDigest,
  };
}

afterEach(() => {
  for (const lock of locks.splice(0)) releaseAgentOsObservationLockV1(lock);
  for (const lease of leases.splice(0)) releaseAgentOsEpochCoordinationLeaseV1(lease);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(label = 'one'): AgentOsReadModelV1 {
  return {
    sourceState: 'healthy',
    livingEndState: {
      northStar: 'Convert governed engineering capacity into durable customer value.',
      currentBottleneck: `Authenticated epoch snapshot ${label}`,
      revisionLabel: 'Current mission basis',
      evidenceState: 'complete',
    },
    capabilitySpectrum: [{
      lane: 'codex', label: 'Codex', state: 'ready', headroom: 'usable', resetUrgency: 'later',
      resetLabel: 'Reset later', allocationLabel: 'Usable capacity',
    }],
    activeValueBets: [{
      key: raw(`bet-${label}`), title: `Value bet ${label}`,
      valueCase: 'Advance authenticated observations.', allocationLabel: 'Observe',
      decision: 'observing', assurance: 'targeted',
      outcome: { state: 'pending', label: 'Pending' },
      evidence: { state: 'complete', label: 'Complete' },
    }],
    nextAction: {
      kind: 'attention', title: 'Verify the epoch', reason: 'A bounded observation is due.',
      evidenceState: 'complete',
    },
  };
}

function activeClosure(epoch = 2): AgentOsAuthenticatedActiveEpochSnapshotClosureV1 {
  return {
    epoch,
    anchoredHeadDigest: prefixed(`head-${epoch}`),
    epochManifestDigest: prefixed(`manifest-${epoch}`),
    attemptNamespaceDigest: prefixed(`namespace-${epoch}`),
    sourceBundleDigest: raw(`source-${epoch}`),
    trustPolicyDigest: raw(`policy-${epoch}`),
    snapshotBasePreviousEnvelopeDigest: raw(`prior-epoch-snapshot-${epoch}`),
    writerProtocolDigest: WRITER,
    expectedProducerIdentityDigest: prefixed('snapshot-producer'),
    expectedAuthenticatorKeyId: raw('snapshot-key'),
    expectedAuthenticatorKeyGeneration: 4,
  };
}

function renewedClosure(label: string): AgentOsAuthenticatedActiveEpochSnapshotClosureV1 {
  return {
    ...activeClosure(),
    sourceBundleDigest: raw(`renewed-source-${label}`),
    trustPolicyDigest: raw(`renewed-policy-${label}`),
  };
}

function writeInput(
  overrides: Partial<WriteAgentOsEpochSnapshotV2Input> = {},
): WriteAgentOsEpochSnapshotV2Input {
  return {
    durableTickDigest: TICK_ONE,
    renderedAt: '2026-09-03T12:00:00.000Z',
    observedAt: '2026-09-03T12:00:05.000Z',
    kernelCycleDigest: raw('kernel-one'),
    capabilityProjectionDigest: prefixed('capability-one'),
    portfolioDigest: raw('portfolio-one'),
    snapshot: snapshot(),
    snapshotDigest: prefixed('snapshot-one'),
    coordinationLease: null as never,
    observationLock: null as never,
    ...overrides,
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

function fixture(overrides: Partial<AgentOsEpochSnapshotStoreDependenciesV1> = {}) {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m560-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const epochsPath = join(epochStoreRootPath, 'epochs');
  const epochPath = join(epochsPath, 'epoch-000000000002');
  const snapshotsPath = join(epochPath, 'snapshots');
  for (const path of [epochStoreRootPath, epochsPath, epochPath, snapshotsPath]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  let current = activeClosure();
  const historical = new Map<string, AgentOsAuthenticatedActiveEpochSnapshotClosureV1>();
  historical.set(current.sourceBundleDigest, current);
  const startReceipts = new Map<string, {
    epoch: number;
    anchoredHeadDigest: string;
    epochManifestDigest: string;
    attemptNamespaceDigest: string;
    durableTickDigest: string;
    startReceiptDigest: string;
    sourceBundleDigest: string;
    trustPolicyDigest: string;
  }>();
  const rememberStart = (
    tick: string,
    closure: AgentOsAuthenticatedActiveEpochSnapshotClosureV1,
    startReceiptDigest = raw(`start-${tick}-${closure.sourceBundleDigest}`),
  ) => {
      const attemptId = agentOsEpochAttemptIdV1({
        epoch: closure.epoch,
        attemptNamespaceDigest: closure.attemptNamespaceDigest,
        durableTickDigest: tick,
      })!;
      startReceipts.set(attemptId, {
        epoch: closure.epoch,
        anchoredHeadDigest: closure.anchoredHeadDigest,
        epochManifestDigest: closure.epochManifestDigest,
        attemptNamespaceDigest: closure.attemptNamespaceDigest,
        durableTickDigest: tick,
        startReceiptDigest,
        sourceBundleDigest: closure.sourceBundleDigest,
        trustPolicyDigest: closure.trustPolicyDigest,
      });
  };
  rememberStart(TICK_ONE, current);
  rememberStart(TICK_TWO, current);
  let onProviderRead: (() => void) | null = null;
  let onHistoricalRead: (() => void) | null = null;
  let onSign: (() => void) | null = null;
  const tag = (bytes: Uint8Array) => createHmac('sha256', key).update(bytes).digest('hex');
  const signer = {
    producerIdentityDigest: current.expectedProducerIdentityDigest,
    keyId: current.expectedAuthenticatorKeyId,
    keyGeneration: current.expectedAuthenticatorKeyGeneration,
    sign(bytes: Uint8Array) {
      onSign?.();
      return tag(bytes);
    },
  };
  const verifier = {
    producerIdentityDigest: signer.producerIdentityDigest,
    keyId: signer.keyId,
    keyGeneration: signer.keyGeneration,
    verify: ({ canonicalDomainSeparatedEnvelope, authenticator }: {
      canonicalDomainSeparatedEnvelope: Uint8Array; authenticator: string;
    }) => tag(canonicalDomainSeparatedEnvelope) === authenticator,
  };
  const dependencies: AgentOsEpochSnapshotStoreDependenciesV1 = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest: WRITER,
    activeClosureProvider: {
      readAuthenticatedClosure() {
        onProviderRead?.();
        return { state: 'authenticated' as const, closure: { ...current } };
      },
    },
    historicalContextProvider: {
      readAuthenticatedHistoricalContext(query) {
        onHistoricalRead?.();
        const found = historical.get(query.sourceBundleDigest);
        if (!found || found.epoch !== query.epoch ||
          found.anchoredHeadDigest !== query.anchoredHeadDigest ||
          found.epochManifestDigest !== query.epochManifestDigest ||
          found.attemptNamespaceDigest !== query.attemptNamespaceDigest ||
          found.trustPolicyDigest !== query.trustPolicyDigest ||
          found.expectedProducerIdentityDigest !== query.producerIdentityDigest ||
          found.expectedAuthenticatorKeyId !== query.authenticatorKeyId ||
          found.expectedAuthenticatorKeyGeneration !== query.authenticatorKeyGeneration) {
          return { state: 'missing' as const };
        }
        return {
          state: 'authenticated' as const,
          context: {
            ...query,
            snapshotBasePreviousEnvelopeDigest: found.snapshotBasePreviousEnvelopeDigest,
          },
          verifier,
        };
      },
    },
    startReceiptProvider: {
      readAuthenticatedStartReceipt(query) {
        const found = startReceipts.get(query.producerAttemptId);
        return found && found.epoch === query.epoch &&
          found.anchoredHeadDigest === query.anchoredHeadDigest &&
          found.epochManifestDigest === query.epochManifestDigest &&
          found.attemptNamespaceDigest === query.attemptNamespaceDigest &&
          found.durableTickDigest === query.durableTickDigest
          ? {
              state: 'authenticated' as const,
              startReceiptDigest: found.startReceiptDigest,
              sourceBundleDigest: found.sourceBundleDigest,
              trustPolicyDigest: found.trustPolicyDigest,
            }
          : { state: 'missing' as const };
      },
    },
    signer,
    verifier,
    ...overrides,
  };
  const lease = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: epochStoreRootPath,
    writerProtocolDigest: WRITER,
  });
  if (lease.state !== 'acquired') throw new Error('could not acquire coordination lease');
  leases.push(lease.lease);
  const observationLock = acquireAgentOsObservationLockV1(anchorPath);
  if (!observationLock) throw new Error('could not acquire observation lock');
  locks.push(observationLock);
  const write = (input: Partial<WriteAgentOsEpochSnapshotV2Input> = {}) =>
    writeAgentOsEpochSnapshotV2(writeInput({
      coordinationLease: lease.lease,
      observationLock,
      ...input,
    }), dependencies);
  return {
    anchorPath,
    epochStoreRootPath,
    snapshotsPath,
    dependencies,
    lease: lease.lease,
    observationLock,
    write,
    setClosure(value: AgentOsAuthenticatedActiveEpochSnapshotClosureV1) {
      current = value;
      historical.set(value.sourceBundleDigest, value);
    },
    setStart(tick: string, closure = current, startReceiptDigest?: string) {
      rememberStart(tick, closure, startReceiptDigest);
    },
    forgetHistoricalSource(sourceBundleDigest: string) { historical.delete(sourceBundleDigest); },
    removeStart(tick: string) {
      const attemptId = agentOsEpochAttemptIdV1({
        epoch: current.epoch,
        attemptNamespaceDigest: current.attemptNamespaceDigest,
        durableTickDigest: tick,
      });
      if (attemptId) startReceipts.delete(attemptId);
    },
    onProvider(callback: (() => void) | null) { onProviderRead = callback; },
    onHistorical(callback: (() => void) | null) { onHistoricalRead = callback; },
    onSigner(callback: (() => void) | null) { onSign = callback; },
  };
}

describe('M560 durable epoch Snapshot V2 store', () => {
  it('treats the exact empty M553 snapshots directory as a complete authenticated ledger', () => {
    const value = fixture();
    const read = readAgentOsEpochSnapshotsV2(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'healthy', sourcePresent: true, complete: true, records: [], current: null,
      epoch: 2, closureAuthenticated: true,
    });
    expect(existsSync(join(value.snapshotsPath, 'records'))).toBe(false);
    expectNoAuthority(read as unknown as Record<string, unknown>);
  });

  it('persists sequence one from the manifest base under the exact private store layout', () => {
    const value = fixture();
    const result = value.write();
    expect(result).toMatchObject({
      disposition: 'recorded', reason: 'recorded', durable: true, closureAuthenticated: true,
      envelope: {
        epoch: 2, epochSequence: 1,
        previousEnvelopeDigest: activeClosure().snapshotBasePreviousEnvelopeDigest,
        anchoredHeadDigest: activeClosure().anchoredHeadDigest,
        epochManifestDigest: activeClosure().epochManifestDigest,
      },
    });
    expect(readdirSync(value.snapshotsPath).sort()).toEqual(['records', 'staging']);
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual(['000000000001.json']);
    expect(readdirSync(join(value.snapshotsPath, 'staging'))).toEqual([]);
    expect(readFileSync(
      join(value.snapshotsPath, 'records', '000000000001.json'), 'utf8',
    ).endsWith('\n')).toBe(true);
    expectNoAuthority(result as unknown as Record<string, unknown>);
  });

  it('guardedly completes a partial records/staging layout before publication', () => {
    const value = fixture();
    mkdirSync(join(value.snapshotsPath, 'records'), { mode: 0o700 });
    chmodSync(join(value.snapshotsPath, 'records'), 0o700);
    expect(value.write()).toMatchObject({ disposition: 'recorded', durable: true });
    expect(readdirSync(value.snapshotsPath).sort()).toEqual(['records', 'staging']);
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual(['000000000001.json']);
  });

  it('derives contiguous slots and predecessors, replays exact input, and conflicts on reuse', () => {
    const value = fixture();
    const first = value.write();
    expect(value.write()).toMatchObject({
      disposition: 'replayed', reason: 'snapshot-replay',
      envelope: { envelopeDigest: first.envelope?.envelopeDigest },
    });
    expect(value.write({ observedAt: '2026-09-03T12:00:06.000Z' })).toMatchObject({
      disposition: 'conflicted', reason: 'publication-conflict', envelope: null,
    });
    const second = value.write({
      durableTickDigest: TICK_TWO,
      renderedAt: '2026-09-03T12:01:00.000Z',
      observedAt: '2026-09-03T12:01:05.000Z',
      kernelCycleDigest: raw('kernel-two'),
      capabilityProjectionDigest: prefixed('capability-two'),
      portfolioDigest: raw('portfolio-two'),
      snapshot: snapshot('two'),
      snapshotDigest: prefixed('snapshot-two'),
    });
    expect(second).toMatchObject({
      disposition: 'recorded',
      envelope: { epochSequence: 2, previousEnvelopeDigest: first.envelope?.envelopeDigest },
    });
    expect(readAgentOsEpochSnapshotsV2(value.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true, records: { length: 2 },
      current: { envelopeDigest: second.envelope?.envelopeDigest },
    });
  });

  it('derives M555 attempt identity and rejects caller-authored context or accessor input', () => {
    const value = fixture();
    const result = value.write();
    expect(result.envelope?.producerAttemptId).toBe(agentOsEpochAttemptIdV1({
      epoch: activeClosure().epoch,
      attemptNamespaceDigest: activeClosure().attemptNamespaceDigest,
      durableTickDigest: TICK_ONE,
    }));
    expect(writeAgentOsEpochSnapshotV2({
      ...writeInput({ coordinationLease: value.lease, observationLock: value.observationLock }),
      epoch: 99,
    } as never, value.dependencies)).toMatchObject({
      disposition: 'withheld', reason: 'invalid-input',
    });
    const accessor = {
      ...writeInput({ coordinationLease: value.lease, observationLock: value.observationLock }),
      get observedAt() { throw new Error('must not run'); },
    };
    expect(writeAgentOsEpochSnapshotV2(accessor, value.dependencies)).toMatchObject({
      disposition: 'withheld', reason: 'invalid-input',
    });
  });

  it('requires both the exact M556 lease and observation transaction lock', () => {
    const missingLock = fixture();
    expect(releaseAgentOsObservationLockV1(missingLock.observationLock)).toBe(true);
    expect(missingLock.write()).toMatchObject({
      disposition: 'withheld', reason: 'observation-lock-missing',
    });
    const missingLease = fixture();
    expect(releaseAgentOsEpochCoordinationLeaseV1(missingLease.lease)).toBe(true);
    expect(missingLease.write()).toMatchObject({
      disposition: 'withheld', reason: 'coordination-lease-missing',
    });
  });

  it('fails before publication when signer callback changes authenticated context', () => {
    const value = fixture();
    value.onSigner(() => value.setClosure({
      ...activeClosure(), anchoredHeadDigest: prefixed('drifted-fixed-head'),
    }));
    expect(value.write()).toMatchObject({
      disposition: 'withheld', reason: 'closure-changed', durable: false,
    });
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual([]);
  });

  it('marks callback reentrancy and fails both nested and outer writes closed', () => {
    const value = fixture();
    let nested: ReturnType<typeof value.write> | null = null;
    value.onSigner(() => {
      value.onSigner(null);
      nested = value.write();
    });
    const outer = value.write();
    expect(nested).toMatchObject({ disposition: 'withheld', reason: 'reentrant-operation' });
    expect(outer).toMatchObject({ disposition: 'withheld', reason: 'reentrant-operation' });
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual([]);
  });

  it('rechecks context after durable persistence and never reports stale success', () => {
    const value = fixture();
    const target = join(value.snapshotsPath, 'records', '000000000001.json');
    value.onProvider(() => {
      if (existsSync(target)) value.setClosure(activeClosure(3));
    });
    const result = value.write();
    expect(result).toMatchObject({
      disposition: 'failed', reason: 'closure-changed', durable: true,
      closureAuthenticated: false, envelope: null,
    });
    expect(existsSync(target)).toBe(true);
  });

  it('accepts provider-observed ledger advancement when fixed authenticated identity is unchanged', () => {
    const value = fixture();
    const target = join(value.snapshotsPath, 'records', '000000000001.json');
    let providerObservedTip: string | null = null;
    value.onProvider(() => {
      if (existsSync(target)) {
        providerObservedTip = (JSON.parse(readFileSync(target, 'utf8')) as { envelopeDigest: string })
          .envelopeDigest;
      }
    });
    const recorded = value.write();
    expect(recorded).toMatchObject({ disposition: 'recorded', durable: true });
    expect(providerObservedTip).toBe(recorded.envelope?.envelopeDigest);
    expect(value.write()).toMatchObject({
      disposition: 'replayed', reason: 'snapshot-replay',
      envelope: { envelopeDigest: recorded.envelope?.envelopeDigest },
    });
  });

  it('fails complete reads closed on tampering, unexpected entries, and bounds', () => {
    const tampered = fixture();
    tampered.write();
    const path = join(tampered.snapshotsPath, 'records', '000000000001.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    parsed['observedAt'] = '2026-09-03T12:00:06.000Z';
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expect(readAgentOsEpochSnapshotsV2(tampered.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], current: null,
    });

    const unexpected = fixture();
    unexpected.write();
    writeFileSync(join(unexpected.snapshotsPath, 'unexpected'), 'x', { mode: 0o600 });
    expect(readAgentOsEpochSnapshotsV2(unexpected.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, records: [],
    });

    const bounded = fixture();
    bounded.write();
    bounded.write({
      durableTickDigest: TICK_TWO,
      renderedAt: '2026-09-03T12:01:00.000Z',
      observedAt: '2026-09-03T12:01:05.000Z',
      snapshot: snapshot('two'),
      snapshotDigest: prefixed('snapshot-two'),
    });
    expect(readAgentOsEpochSnapshotsV2(bounded.dependencies, { maxFiles: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], limitExceeded: true,
    });
  });

  it('reads historical A after renewal, appends B, and degrades when A proof disappears', () => {
    const value = fixture();
    const sourceA = activeClosure().sourceBundleDigest;
    const sourceB = renewedClosure('b');
    value.setClosure(sourceB);
    const first = value.write();
    expect(first).toMatchObject({
      disposition: 'recorded',
      envelope: { sourceBundleDigest: sourceA, trustPolicyDigest: activeClosure().trustPolicyDigest },
    });
    expect(readAgentOsEpochSnapshotsV2(value.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true, records: { length: 1 },
      current: { envelopeDigest: first.envelope?.envelopeDigest, sourceBundleDigest: sourceA },
    });
    expect(value.write()).toMatchObject({
      disposition: 'replayed', reason: 'snapshot-replay',
      envelope: { envelopeDigest: first.envelope?.envelopeDigest, sourceBundleDigest: sourceA },
    });
    const m557Verifier = createAgentOsEpochSnapshotV2ExistenceVerifierV1(value.dependencies);
    const request = bindingBatch([bindingFor(first.envelope!)]);
    expect(m557Verifier.verifyExactBindings(request)).toEqual({
      state: 'authenticated',
      inputSetDigest: request.inputSetDigest,
      decisions: [{
        bindingDigest: agentOsEpochSnapshotBindingDigestV1(request.bindings[0]!)!,
        verified: true,
      }],
    });
    expect(value.write({ observedAt: '2026-09-03T12:00:06.000Z' })).toMatchObject({
      disposition: 'conflicted', reason: 'publication-conflict', envelope: null,
    });
    value.setStart(TICK_TWO, sourceB);
    const second = value.write({
      durableTickDigest: TICK_TWO,
      renderedAt: '2026-09-03T12:01:00.000Z',
      observedAt: '2026-09-03T12:01:05.000Z',
      snapshot: snapshot('renewed'),
      snapshotDigest: prefixed('snapshot-renewed'),
    });
    expect(second).toMatchObject({
      disposition: 'recorded',
      envelope: {
        epochSequence: 2,
        previousEnvelopeDigest: first.envelope?.envelopeDigest,
        sourceBundleDigest: sourceB.sourceBundleDigest,
      },
    });
    value.forgetHistoricalSource(sourceA);
    expect(readAgentOsEpochSnapshotsV2(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], current: null,
    });
  });

  it('withholds without an exact same-source M557 start receipt', () => {
    const value = fixture();
    value.setClosure(renewedClosure('b'));
    value.removeStart(TICK_ONE);
    expect(value.write()).toMatchObject({
      disposition: 'withheld', reason: 'start-receipt-unavailable', envelope: null,
    });
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual([]);
  });

  it('withholds when historical A authentication is missing after renewal to B', () => {
    const value = fixture();
    const sourceA = activeClosure();
    value.setClosure(renewedClosure('missing-a'));
    value.forgetHistoricalSource(sourceA.sourceBundleDigest);
    expect(value.write()).toMatchObject({
      disposition: 'withheld', reason: 'chain-unavailable', envelope: null,
    });
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual([]);
  });

  it('fails closed when the start provider substitutes lineage between fences', () => {
    const value = fixture();
    const original = value.dependencies.startReceiptProvider;
    let reads = 0;
    value.dependencies.startReceiptProvider = {
      readAuthenticatedStartReceipt(query) {
        reads += 1;
        const result = original.readAuthenticatedStartReceipt(query);
        return reads > 1 && result.state === 'authenticated'
          ? { ...result, sourceBundleDigest: raw('substituted-source') }
          : result;
      },
    };
    expect(value.write()).toMatchObject({
      disposition: 'withheld', reason: 'start-receipt-unavailable', envelope: null,
    });
    expect(readdirSync(join(value.snapshotsPath, 'records'))).toEqual([]);
  });

  it('leaves no target when historical A is revoked at the final prepublish fence', () => {
    const value = fixture();
    const sourceA = activeClosure().sourceBundleDigest;
    value.setClosure(renewedClosure('prepublish-revocation'));
    const stagingPath = join(value.snapshotsPath, 'staging');
    const target = join(value.snapshotsPath, 'records', '000000000001.json');
    let revoked = false;
    value.onHistorical(() => {
      if (!revoked && existsSync(stagingPath) && readdirSync(stagingPath).length > 0 &&
        !existsSync(target)) {
        revoked = true;
        value.forgetHistoricalSource(sourceA);
      }
    });
    expect(value.write()).toMatchObject({
      disposition: 'withheld', reason: 'closure-changed', durable: false, envelope: null,
    });
    expect(revoked).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(stagingPath)).toEqual([]);
  });

  it('rejects epoch-local snapshot signer rotation across source renewal', () => {
    const value = fixture();
    expect(value.write()).toMatchObject({ disposition: 'recorded', durable: true });
    value.setClosure({
      ...renewedClosure('rotated-signer'),
      expectedProducerIdentityDigest: prefixed('rotated-snapshot-producer'),
      expectedAuthenticatorKeyId: raw('rotated-snapshot-key'),
      expectedAuthenticatorKeyGeneration: 5,
    });
    expect(readAgentOsEpochSnapshotsV2(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, records: [], current: null,
      stopReasons: expect.arrayContaining(['signer-identity-drift']),
    });
  });

  it('lets M557 complete A successfully under active B using the exact persisted A snapshot', () => {
    const value = fixture();
    const attemptsPath = join(
      value.epochStoreRootPath, 'epochs', 'epoch-000000000002', 'attempts',
    );
    mkdirSync(attemptsPath, { mode: 0o700 });
    chmodSync(attemptsPath, 0o700);
    const attemptKey = Buffer.alloc(32, 0x57);
    const attemptKeyId = raw('m557-integration-key');
    const attemptSigner = {
      keyId: attemptKeyId,
      authenticate: (bytes: Uint8Array) =>
        createHmac('sha256', attemptKey).update(bytes).digest('hex'),
    };
    const attemptVerifier = {
      keyId: attemptKeyId,
      verify: ({ canonicalDomainSeparatedReceipt, authenticator }: {
        canonicalDomainSeparatedReceipt: Uint8Array; authenticator: string;
      }) => createHmac('sha256', attemptKey).update(canonicalDomainSeparatedReceipt)
        .digest('hex') === authenticator,
    };
    const sourceA = activeClosure();
    let attemptActive: AgentOsAuthenticatedActiveEpochAttemptClosureV1 = {
      epoch: sourceA.epoch,
      epochHeadDigest: sourceA.anchoredHeadDigest,
      epochManifestDigest: sourceA.epochManifestDigest,
      attemptNamespaceDigest: sourceA.attemptNamespaceDigest,
      sourceBundleDigest: sourceA.sourceBundleDigest,
      trustPolicyDigest: sourceA.trustPolicyDigest,
      attemptAuthenticatorKeyId: attemptKeyId,
      attemptAuthenticatorGeneration: 1,
      writerProtocolDigest: WRITER,
    };
    const historicalAttempts = new Map([
      [`${sourceA.sourceBundleDigest}:${sourceA.trustPolicyDigest}`, true],
    ]);
    const attemptDependencies: AgentOsEpochAttemptStoreDependenciesV1 = {
      anchorPath: value.anchorPath,
      epochStoreRootPath: value.epochStoreRootPath,
      writerProtocolDigest: WRITER,
      activeClosureProvider: {
        readAuthenticatedClosure: () => ({
          state: 'authenticated', closure: { ...attemptActive },
        }),
      },
      historicalSourceLineageProvider: {
        resolveAuthenticatedHistoricalSource(lineage) {
          return historicalAttempts.has(`${lineage.sourceBundleDigest}:${lineage.trustPolicyDigest}`)
            ? {
                state: 'authenticated' as const,
                lineage: { ...lineage, attemptAuthenticatorGeneration: 1 },
                verifier: attemptVerifier,
                signer: attemptSigner,
              }
            : { state: 'missing' as const };
        },
        resolveAuthenticatedHistoricalSources(request) {
          return {
            state: 'authenticated' as const,
            inputSetDigest: request.inputSetDigest,
            resolutions: request.lineages.map((lineage) => ({
              lineageDigest: agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!,
              resolution: historicalAttempts.has(
                `${lineage.sourceBundleDigest}:${lineage.trustPolicyDigest}`,
              ) ? {
                  state: 'authenticated' as const,
                  lineage: { ...lineage, attemptAuthenticatorGeneration: 1 },
                  verifier: attemptVerifier,
                } : { state: 'missing' as const },
            })),
          };
        },
      },
      signer: attemptSigner,
    };
    const started = beginAgentOsEpochAttemptV2({
      durableTickDigest: TICK_ONE,
      startedAt: '2026-09-03T11:59:59.000Z',
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    }, attemptDependencies);
    expect(started).toMatchObject({ disposition: 'recorded', receipt: { transitionOrdinal: 1 } });
    value.setStart(TICK_ONE, sourceA, started.receipt!.receiptDigest);

    const sourceB = renewedClosure('m557-integration-b');
    value.setClosure(sourceB);
    historicalAttempts.set(`${sourceB.sourceBundleDigest}:${sourceB.trustPolicyDigest}`, true);
    attemptActive = {
      ...attemptActive,
      sourceBundleDigest: sourceB.sourceBundleDigest,
      trustPolicyDigest: sourceB.trustPolicyDigest,
    };
    const persisted = value.write();
    expect(persisted).toMatchObject({
      disposition: 'recorded',
      envelope: {
        sourceBundleDigest: sourceA.sourceBundleDigest,
        producerStartReceiptDigest: started.receipt?.receiptDigest,
      },
    });
    attemptDependencies.snapshotV2ExistenceVerifier =
      createAgentOsEpochSnapshotV2ExistenceVerifierV1(value.dependencies);
    expect(completeAgentOsEpochAttemptV2({
      durableTickDigest: TICK_ONE,
      outcome: 'succeeded',
      snapshotEnvelopeDigest: persisted.envelope!.envelopeDigest,
      completedAt: '2026-09-03T12:00:06.000Z',
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    }, attemptDependencies)).toMatchObject({
      disposition: 'recorded',
      receipt: {
        outcome: 'succeeded',
        sourceBundleDigest: sourceA.sourceBundleDigest,
        previousReceiptDigest: started.receipt?.receiptDigest,
      },
    });
  });

  it('batch-verifies 1000 mixed bindings with one authenticated ledger scan', () => {
    const value = fixture();
    const persisted = value.write();
    const valid = bindingFor(persisted.envelope!);
    let startReceiptReads = 0;
    const originalStartProvider = value.dependencies.startReceiptProvider;
    value.dependencies.startReceiptProvider = {
      readAuthenticatedStartReceipt(query) {
        startReceiptReads += 1;
        return originalStartProvider.readAuthenticatedStartReceipt(query);
      },
    };
    const bindings = [valid, ...Array.from({ length: 999 }, (_, index) => ({
      ...valid,
      attemptId: prefixed(`batch-missing-attempt-${index}`),
      snapshotEnvelopeDigest: raw(`batch-missing-snapshot-${index}`),
    }))];
    const request = bindingBatch(bindings);
    const result = createAgentOsEpochSnapshotV2ExistenceVerifierV1(value.dependencies)
      .verifyExactBindings(request);
    expect(result.state).toBe('authenticated');
    if (result.state !== 'authenticated') throw new Error('expected authenticated batch');
    expect(result.inputSetDigest).toBe(request.inputSetDigest);
    expect(result.decisions).toHaveLength(1_000);
    expect(result.decisions.filter(({ verified }) => verified)).toHaveLength(1);
    expect(startReceiptReads).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(result.decisions.every(Object.isFrozen)).toBe(true);
  });

  it('rejects reordered, duplicate, substituted, and callback-mutated batch requests', () => {
    const value = fixture();
    const persisted = value.write();
    const valid = bindingFor(persisted.envelope!);
    const missing = {
      ...valid,
      attemptId: prefixed('batch-missing-attempt'),
      snapshotEnvelopeDigest: raw('batch-missing-snapshot'),
    };
    const verifier = createAgentOsEpochSnapshotV2ExistenceVerifierV1(value.dependencies);
    const canonical = bindingBatch([valid, missing]);
    expect(verifier.verifyExactBindings(canonical)).toMatchObject({
      state: 'authenticated',
      decisions: expect.arrayContaining([
        expect.objectContaining({ verified: true }),
        expect.objectContaining({ verified: false }),
      ]),
    });

    expect(verifier.verifyExactBindings({
      ...canonical, bindings: [...canonical.bindings].reverse(),
    })).toEqual({ state: 'degraded' });
    expect(verifier.verifyExactBindings({
      ...canonical, inputSetDigest: prefixed('substituted-input-set'),
    })).toEqual({ state: 'degraded' });
    expect(verifier.verifyExactBindings({
      ...canonical,
      inputSetDigest: prefixed('duplicate-input-set'),
      bindings: [canonical.bindings[0]!, canonical.bindings[0]!],
    })).toEqual({ state: 'degraded' });

    const mutable = bindingBatch([valid, missing]);
    let mutated = false;
    value.onProvider(() => {
      if (!mutated) {
        mutated = true;
        (mutable.bindings as AgentOsEpochSnapshotV2BindingVerificationInputV1[]).reverse();
      }
    });
    expect(verifier.verifyExactBindings(mutable)).toEqual({ state: 'degraded' });
  });

  it('withholds all snapshot mutation when the runtime commit guard is false or expires', () => {
    let authorized = false;
    const initiallyWithheld = fixture({
      runtimeCommitGuard: { isCommitAuthorized: () => authorized },
    });
    expect(initiallyWithheld.write()).toMatchObject({
      disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
    });
    expect(readdirSync(initiallyWithheld.snapshotsPath)).toEqual([]);

    authorized = true;
    const beforePublish = fixture({
      runtimeCommitGuard: { isCommitAuthorized: () => authorized },
    });
    beforePublish.onSigner(() => { authorized = false; });
    expect(beforePublish.write()).toMatchObject({
      disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
    });
    expect(readdirSync(join(beforePublish.snapshotsPath, 'records'))).toEqual([]);
    expect(readdirSync(join(beforePublish.snapshotsPath, 'staging'))).toEqual([]);

    authorized = true;
    const afterPublish = fixture({
      runtimeCommitGuard: { isCommitAuthorized: () => authorized },
    });
    const target = join(afterPublish.snapshotsPath, 'records', '000000000001.json');
    afterPublish.onProvider(() => {
      if (existsSync(target)) authorized = false;
    });
    expect(afterPublish.write()).toMatchObject({
      disposition: 'failed', reason: 'runtime-commit-withheld', durable: true,
      closureAuthenticated: false, envelope: null,
    });
    expect(existsSync(target)).toBe(true);
  });

  it('enforces bounded capacity without overwriting immutable snapshots', () => {
    const value = fixture({ maxRecords: 1 });
    const first = value.write();
    expect(value.write({ durableTickDigest: TICK_TWO })).toMatchObject({
      disposition: 'withheld', reason: 'capacity-exhausted',
    });
    const read = readAgentOsEpochSnapshotsV2(value.dependencies);
    expect(read).toMatchObject({ records: { length: 1 }, capacityExhausted: true });
    expect(read.current?.envelopeDigest).toBe(first.envelope?.envelopeDigest);
  });

  it('conservatively reports a pristine store clean without creating writer state', () => {
    const value = fixture();
    expect(recoverAgentOsEpochSnapshotStoreV2({
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    }, value.dependencies)).toBe('clean');
    expect(readdirSync(value.snapshotsPath)).toEqual([]);
  });

  it('fails closed on Windows and contains no config, daemon, key, or anchor implementation', () => {
    expect(isAgentOsEpochSnapshotStorePlatformSupportedV1('win32')).toBe(false);
    expect(isAgentOsEpochSnapshotStorePlatformSupportedV1('darwin')).toBe(true);
    expect(isAgentOsEpochSnapshotStorePlatformSupportedV1('linux')).toBe(true);
    expect(Object.keys(writeInput()).sort()).toEqual([
      'capabilityProjectionDigest', 'coordinationLease', 'durableTickDigest',
      'kernelCycleDigest', 'observationLock', 'observedAt', 'portfolioDigest',
      'renderedAt', 'snapshot', 'snapshotDigest',
    ]);
    const source = readFileSync(new URL(
      '../src/core/vision/agent-os-epoch-snapshot-store.ts', import.meta.url,
    ), 'utf8');
    expect(source).toContain("const STORE_LOCK = '.agent-os-epoch-snapshot-v2.lock'");
    expect(source).toContain('initializeImmutablePrivateRecordStoreLayout');
    expect(source).not.toMatch(/from ['"].*(?:config|daemon).*['"]/u);
    expect(source).not.toMatch(/(?:createHmac|generateKey|readPrivateKey|loadKey)\s*\(/u);
    expect(source).not.toMatch(/acquireAgentOs(?:EpochCoordinationLease|ObservationLock)V1/u);
  });
});
