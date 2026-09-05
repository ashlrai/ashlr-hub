import {
  createHash, createHmac, generateKeyPairSync, sign as signEd25519, verify as verifyEd25519,
} from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  beginAgentOsEpochAttemptV2,
  completeAgentOsEpochAttemptV2,
  readAgentOsEpochAttemptReceiptsV2,
} from '../src/core/vision/agent-os-epoch-attempt-store.js';
import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';
import {
  agentOsEpochAttemptIdV1,
  canonicalAgentOsEpochSourceBundleBytesV2,
  createAgentOsEpochSourceBundleV2,
} from '../src/core/vision/agent-os-epoch-records.js';
import {
  createAgentOsEpochRuntimeStoresV1,
  runAgentOsEpochObservationV1,
  type AgentOsEpochRuntimeDependenciesV1,
} from '../src/core/vision/agent-os-epoch-runtime.js';
import {
  readAgentOsEpochSnapshotsV2,
  writeAgentOsEpochSnapshotV2,
} from '../src/core/vision/agent-os-epoch-snapshot-store.js';
import type {
  AgentOsAuthenticatedActiveEpochSourceContextV1,
} from '../src/core/vision/agent-os-epoch-source-store.js';
import {
  appendAgentOsEpochSourceRenewalV1,
} from '../src/core/vision/agent-os-epoch-source-store.js';
import type { AgentOsReadModelV1 } from '../src/core/vision/agent-os-read-model.js';

const roots: string[] = [];
const raw = (label: string): string => createHash('sha256').update(`m562\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const WRITER = prefixed('writer');
const TICK_ONE = prefixed('tick-one');
const TICK_TWO = prefixed('tick-two');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(label = 'runtime'): AgentOsReadModelV1 {
  return {
    sourceState: 'healthy',
    livingEndState: {
      northStar: 'Turn governed engineering capacity into durable value.',
      currentBottleneck: `Authenticated ${label} observation`,
      revisionLabel: 'Current mission basis',
      evidenceState: 'complete',
    },
    capabilitySpectrum: [{
      lane: 'codex', label: 'Codex', state: 'ready', headroom: 'usable', resetUrgency: 'later',
      resetLabel: 'Reset later', allocationLabel: 'Usable capacity',
    }],
    activeValueBets: [{
      key: raw(label), title: 'Authenticated runtime', valueCase: 'Persist a bounded observation.',
      allocationLabel: 'Observe', decision: 'observing', assurance: 'targeted',
      outcome: { state: 'pending', label: 'Pending' },
      evidence: { state: 'complete', label: 'Complete' },
    }],
    nextAction: {
      kind: 'attention', title: 'Inspect evidence', reason: 'The observation is durable.',
      evidenceState: 'complete',
    },
  };
}

function observation(label = 'runtime') {
  return {
    renderedAt: '2026-09-03T12:00:04.000Z',
    observedAt: '2026-09-03T12:00:05.000Z',
    kernelCycleDigest: raw(`kernel-${label}`),
    capabilityProjectionDigest: prefixed(`capability-${label}`),
    portfolioDigest: raw(`portfolio-${label}`),
    snapshot: snapshot(label),
    snapshotDigest: prefixed(`snapshot-${label}`),
  };
}

function fixture() {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m562-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const epochPath = join(epochStoreRootPath, 'epochs', 'epoch-000000000001');
  for (const path of [epochStoreRootPath, join(epochStoreRootPath, 'epochs'), epochPath,
    join(epochPath, 'attempts'), join(epochPath, 'snapshots'), join(epochPath, 'sources')]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const attemptKey = Buffer.alloc(32, 0x62);
  const snapshotKey = Buffer.alloc(32, 0x63);
  const attemptKeyId = raw('attempt-key');
  const snapshotKeyId = raw('snapshot-key');
  const producer = prefixed('snapshot-producer');
  const sourceKeys = generateKeyPairSync('ed25519');
  const sourceKeyId = raw('source-key');
  const sourcePrincipalDigest = prefixed('source-principal');
  const sourceSigner = {
    keyId: sourceKeyId,
    principalDigest: sourcePrincipalDigest,
    sign: (bytes: Uint8Array) => Buffer.from(
      signEd25519(null, Buffer.from(bytes), sourceKeys.privateKey),
    ),
  };
  const verifySource = (request: {
    canonicalDomainSeparatedPayload: Uint8Array; signature: Uint8Array;
  }) => verifyEd25519(
    null,
    Buffer.from(request.canonicalDomainSeparatedPayload),
    sourceKeys.publicKey,
    Buffer.from(request.signature),
  );
  const createFirstSource = (epoch: number, path: string) => {
    const first = createAgentOsEpochSourceBundleV2({
      epoch,
      previousEpochHeadDigest: prefixed(`previous-head-${epoch}`),
      previousEpochSourceTipDigest: null,
      trustPolicyDigest: raw(`policy-${epoch}`),
      policyGeneration: epoch,
      sourceKeyId,
      sourcePrincipalDigest,
      evidencePrincipalDigest: prefixed(`evidence-${epoch}`),
      outcomePrincipalDigests: [prefixed(`outcome-${epoch}`)],
      issuedAt: '2026-09-03T11:59:00.000Z',
      expiresAt: '2026-09-03T12:04:00.000Z',
      sourcePayloadBytes: Buffer.from(`{"epoch":${epoch}}`, 'utf8'),
    }, sourceSigner);
    if (!first) throw new Error('expected first source');
    writeFileSync(join(path, 'first-source.json'), canonicalAgentOsEpochSourceBundleBytesV2(first)!, {
      mode: 0o600,
    });
    return first;
  };
  let firstSource = createFirstSource(1, epochPath);
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
  let terminalSignerAvailable = true;
  const snapshotSigner = {
    producerIdentityDigest: producer,
    keyId: snapshotKeyId,
    keyGeneration: 1,
    sign: (bytes: Uint8Array) => createHmac('sha256', snapshotKey).update(bytes).digest('hex'),
  };
  const snapshotVerifier = {
    producerIdentityDigest: producer,
    keyId: snapshotKeyId,
    keyGeneration: 1,
    verify: ({ canonicalDomainSeparatedEnvelope, authenticator }: {
      canonicalDomainSeparatedEnvelope: Uint8Array; authenticator: string;
    }) => createHmac('sha256', snapshotKey).update(canonicalDomainSeparatedEnvelope)
      .digest('hex') === authenticator,
  };
  let runtimeReads = 0;
  let onRuntimeRead: (() => void) | null = null;
  let clockReads = 0;
  const attemptClosure = {
    epoch: 1,
    epochHeadDigest: prefixed('head'),
    epochManifestDigest: prefixed('manifest'),
    attemptNamespaceDigest: prefixed('namespace'),
    sourceBundleDigest: firstSource.bundleDigest,
    trustPolicyDigest: firstSource.trustPolicyDigest,
    attemptAuthenticatorKeyId: attemptKeyId,
    attemptAuthenticatorGeneration: 1,
    writerProtocolDigest: WRITER,
  };
  const snapshotClosure = {
    epoch: 1,
    anchoredHeadDigest: attemptClosure.epochHeadDigest,
    epochManifestDigest: attemptClosure.epochManifestDigest,
    attemptNamespaceDigest: attemptClosure.attemptNamespaceDigest,
    sourceBundleDigest: attemptClosure.sourceBundleDigest,
    trustPolicyDigest: attemptClosure.trustPolicyDigest,
    snapshotBasePreviousEnvelopeDigest: raw('snapshot-base'),
    writerProtocolDigest: WRITER,
    expectedProducerIdentityDigest: producer,
    expectedAuthenticatorKeyId: snapshotKeyId,
    expectedAuthenticatorKeyGeneration: 1,
  };
  let sourceContext: AgentOsAuthenticatedActiveEpochSourceContextV1 = {
    epoch: 1,
    epochHeadDigest: attemptClosure.epochHeadDigest,
    epochManifestDigest: attemptClosure.epochManifestDigest,
    previousEpochHeadDigest: prefixed('previous-head-1'),
    previousEpochSourceTipDigest: null,
    attemptNamespaceDigest: attemptClosure.attemptNamespaceDigest,
    firstSourceBundleDigest: firstSource.bundleDigest,
    trustPolicyDigest: firstSource.trustPolicyDigest,
    policyGeneration: 1,
    expectedSourceKeyId: sourceKeyId,
    expectedSourcePrincipalDigest: sourcePrincipalDigest,
    epochCreatedAt: '2026-09-03T11:59:30.000Z',
    observedAt: '2026-09-03T12:00:00.000Z',
    writerProtocolDigest: WRITER,
  };
  const sourceStore = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest: WRITER,
    activeContextProvider: {
      readAuthenticatedActiveEpochSourceContext: () => ({
        state: 'authenticated' as const, context: { ...sourceContext },
      }),
    },
    firstSourceSignatureVerifier: { verify: verifySource },
    renewalSignatureVerifier: { verify: verifySource },
    renewalSigner: sourceSigner,
    attemptAuthenticatorResolver: {
      resolveAuthenticatedAttemptAuthenticator: () => ({
        state: 'authenticated' as const,
        keyId: attemptKeyId,
        generation: 1,
        verifier: attemptVerifier,
        signer: attemptSigner,
      }),
    },
  };
  const dependencies: AgentOsEpochRuntimeDependenciesV1 = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest: WRITER,
    authenticatedClosureProvider: {
      readAuthenticatedClosure() {
        runtimeReads += 1;
        onRuntimeRead?.();
        return {
          state: 'authenticated' as const,
          closure: {
            source: { ...sourceContext },
            attempt: { ...attemptClosure },
            snapshot: { ...snapshotClosure },
          },
        };
      },
    },
    sourceStore,
    attemptHistoricalSourceLineageProvider: {
      resolveAuthenticatedHistoricalSource(lineage) {
        return lineage.epoch === attemptClosure.epoch &&
          lineage.epochHeadDigest === attemptClosure.epochHeadDigest &&
          lineage.epochManifestDigest === attemptClosure.epochManifestDigest &&
          lineage.attemptNamespaceDigest === attemptClosure.attemptNamespaceDigest &&
          lineage.sourceBundleDigest === attemptClosure.sourceBundleDigest &&
          lineage.trustPolicyDigest === attemptClosure.trustPolicyDigest &&
          lineage.attemptAuthenticatorKeyId === attemptKeyId
          ? {
              state: 'authenticated' as const,
              lineage: { ...lineage, attemptAuthenticatorGeneration: 1 },
              verifier: attemptVerifier,
              signer: terminalSignerAvailable ? attemptSigner : null,
            }
          : { state: 'missing' as const };
      },
      resolveAuthenticatedHistoricalSources(request) {
        return {
          state: 'authenticated' as const,
          inputSetDigest: request.inputSetDigest,
          resolutions: request.lineages.map((lineage) => {
            const resolution = dependencies.attemptHistoricalSourceLineageProvider
              .resolveAuthenticatedHistoricalSource(lineage);
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
        };
      },
    },
    attemptSigner,
    snapshotHistoricalContextProvider: {
      readAuthenticatedHistoricalContext(query) {
        return query.epoch === snapshotClosure.epoch &&
          query.anchoredHeadDigest === snapshotClosure.anchoredHeadDigest &&
          query.epochManifestDigest === snapshotClosure.epochManifestDigest &&
          query.attemptNamespaceDigest === snapshotClosure.attemptNamespaceDigest &&
          query.sourceBundleDigest === snapshotClosure.sourceBundleDigest &&
          query.trustPolicyDigest === snapshotClosure.trustPolicyDigest &&
          query.producerIdentityDigest === producer && query.authenticatorKeyId === snapshotKeyId &&
          query.authenticatorKeyGeneration === 1
          ? {
              state: 'authenticated' as const,
              context: {
                ...query,
                snapshotBasePreviousEnvelopeDigest:
                  snapshotClosure.snapshotBasePreviousEnvelopeDigest,
              },
              verifier: snapshotVerifier,
            }
          : { state: 'missing' as const };
      },
    },
    snapshotSigner,
    snapshotVerifier,
    clock: {
      now() {
        const unixMs = Date.parse('2026-09-03T12:00:00.000Z') + clockReads++;
        return { unixMs, iso: new Date(unixMs).toISOString() };
      },
    },
  };
  return {
    dependencies,
    runtimeReads: () => runtimeReads,
    setTerminalSignerAvailable: (available: boolean) => { terminalSignerAvailable = available; },
    setRuntimeReadHook: (hook: (() => void) | null) => { onRuntimeRead = hook; },
    appendSourceRenewal() {
      const leaseRead = acquireAgentOsEpochCoordinationLeaseV1({
        rootPath: epochStoreRootPath, writerProtocolDigest: WRITER,
      });
      if (leaseRead.state !== 'acquired') throw new Error('expected lease');
      const lock = acquireAgentOsObservationLockV1(anchorPath);
      if (!lock) throw new Error('expected observation lock');
      try {
        const written = appendAgentOsEpochSourceRenewalV1({
          evidencePrincipalDigest: prefixed('renewal-evidence'),
          outcomePrincipalDigests: [prefixed('renewal-outcome')],
          issuedAt: '2026-09-03T12:00:45.000Z',
          expiresAt: '2026-09-03T12:03:45.000Z',
          sourcePayloadBytes: Buffer.from('{"attemptKey":"A"}', 'utf8'),
          coordinationLease: leaseRead.lease,
          observationLock: lock,
        }, sourceStore);
        if (!written.renewal) throw new Error(`expected renewal: ${written.reason}`);
        attemptClosure.sourceBundleDigest = written.renewal.bundleDigest;
        attemptClosure.trustPolicyDigest = written.renewal.trustPolicyDigest;
        snapshotClosure.sourceBundleDigest = written.renewal.bundleDigest;
        snapshotClosure.trustPolicyDigest = written.renewal.trustPolicyDigest;
        return written.renewal;
      } finally {
        releaseAgentOsObservationLockV1(lock);
        releaseAgentOsEpochCoordinationLeaseV1(leaseRead.lease);
      }
    },
    switchEpoch(epoch: number) {
      const nextEpochPath = join(
        epochStoreRootPath, 'epochs', `epoch-${String(epoch).padStart(12, '0')}`,
      );
      for (const path of [nextEpochPath, join(nextEpochPath, 'attempts'),
        join(nextEpochPath, 'snapshots'), join(nextEpochPath, 'sources')]) {
        mkdirSync(path, { mode: 0o700 });
        chmodSync(path, 0o700);
      }
      attemptClosure.epoch = epoch;
      attemptClosure.epochHeadDigest = prefixed(`head-${epoch}`);
      attemptClosure.epochManifestDigest = prefixed(`manifest-${epoch}`);
      attemptClosure.attemptNamespaceDigest = prefixed(`namespace-${epoch}`);
      firstSource = createFirstSource(epoch, nextEpochPath);
      attemptClosure.sourceBundleDigest = firstSource.bundleDigest;
      attemptClosure.trustPolicyDigest = firstSource.trustPolicyDigest;
      snapshotClosure.epoch = epoch;
      snapshotClosure.anchoredHeadDigest = attemptClosure.epochHeadDigest;
      snapshotClosure.epochManifestDigest = attemptClosure.epochManifestDigest;
      snapshotClosure.attemptNamespaceDigest = attemptClosure.attemptNamespaceDigest;
      snapshotClosure.sourceBundleDigest = attemptClosure.sourceBundleDigest;
      snapshotClosure.trustPolicyDigest = attemptClosure.trustPolicyDigest;
      snapshotClosure.snapshotBasePreviousEnvelopeDigest = raw(`snapshot-base-${epoch}`);
      sourceContext = {
        ...sourceContext,
        epoch,
        epochHeadDigest: attemptClosure.epochHeadDigest,
        epochManifestDigest: attemptClosure.epochManifestDigest,
        previousEpochHeadDigest: prefixed(`previous-head-${epoch}`),
        attemptNamespaceDigest: attemptClosure.attemptNamespaceDigest,
        firstSourceBundleDigest: firstSource.bundleDigest,
        trustPolicyDigest: firstSource.trustPolicyDigest,
        policyGeneration: epoch,
      };
    },
    setSnapshotSignHook: (hook: () => void) => {
      dependencies.snapshotSigner = { ...snapshotSigner, sign(bytes) { hook(); return snapshotSigner.sign(bytes); } };
      dependencies.snapshotVerifier = snapshotVerifier;
    },
  };
}

function noAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    authority: 'observation-only', writesAuthorized: false, pointerMutationAuthorized: false,
    anchorMutationAuthority: false, planningAuthority: false, executionAuthority: false,
    effectAuthority: false, externalMutationAuthority: false, publicationAuthority: false,
    credentialAuthority: false, rollbackProtected: false, sameUserTamperResistant: false,
  });
}

describe('M562 authenticated epoch observation runtime', () => {
  it('exports read-capable stores whose direct mutation paths are permanently denied', () => {
    const value = fixture();
    const stores = createAgentOsEpochRuntimeStoresV1(value.dependencies)!;
    expect(stores.attempt.signer).toBeNull();
    expect(stores.snapshot.signer).toBeNull();
    const leaseRead = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: value.dependencies.epochStoreRootPath,
      writerProtocolDigest: WRITER,
    });
    expect(leaseRead.state).toBe('acquired');
    if (leaseRead.state !== 'acquired') throw new Error('expected lease');
    const lock = acquireAgentOsObservationLockV1(value.dependencies.anchorPath);
    expect(lock).not.toBeNull();
    if (!lock) throw new Error('expected observation lock');
    try {
      expect(beginAgentOsEpochAttemptV2({
        durableTickDigest: TICK_ONE,
        startedAt: '2026-09-03T12:00:00.000Z',
        coordinationLease: leaseRead.lease,
        observationLock: lock,
      }, stores.attempt)).toMatchObject({
        disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
      });
      expect(writeAgentOsEpochSnapshotV2({
        ...observation('direct-bypass'),
        durableTickDigest: TICK_ONE,
        coordinationLease: leaseRead.lease,
        observationLock: lock,
      }, stores.snapshot)).toMatchObject({
        disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
      });
      expect(completeAgentOsEpochAttemptV2({
        durableTickDigest: TICK_ONE,
        outcome: 'failed',
        snapshotEnvelopeDigest: null,
        completedAt: '2026-09-03T12:00:01.000Z',
        coordinationLease: leaseRead.lease,
        observationLock: lock,
      }, stores.attempt)).toMatchObject({
        disposition: 'withheld', reason: 'runtime-commit-withheld', durable: false,
      });
      expect(readAgentOsEpochAttemptReceiptsV2(stores.attempt).records).toHaveLength(0);
      expect(readAgentOsEpochSnapshotsV2(stores.snapshot).records).toHaveLength(0);
      const epochPath = join(
        value.dependencies.epochStoreRootPath, 'epochs', 'epoch-000000000001',
      );
      expect(readdirSync(join(epochPath, 'attempts'))).toEqual([]);
      expect(readdirSync(join(epochPath, 'snapshots'))).toEqual([]);
    } finally {
      releaseAgentOsObservationLockV1(lock);
      releaseAgentOsEpochCoordinationLeaseV1(leaseRead.lease);
    }
  });

  it('orders authenticated start, callback, snapshot, and reciprocal success terminal', () => {
    const value = fixture();
    let calls = 0;
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: null,
      observe(context) {
        calls += 1;
        expect(Object.isFrozen(context)).toBe(true);
        expect(context).toMatchObject({
          durableTickDigest: TICK_ONE,
          authority: 'observation-only', executionAuthority: false, effectAuthority: false,
        });
        const stores = createAgentOsEpochRuntimeStoresV1(value.dependencies)!;
        expect(readAgentOsEpochAttemptReceiptsV2(stores.attempt).records).toHaveLength(1);
        expect(readAgentOsEpochSnapshotsV2(stores.snapshot).records).toHaveLength(0);
        return observation();
      },
    }, value.dependencies);
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      disposition: 'completed', reason: 'succeeded', outcome: 'succeeded', durable: true,
      startReceipt: { transitionOrdinal: 1 }, snapshotEnvelope: { epochSequence: 1 },
      terminalReceipt: { transitionOrdinal: 2, outcome: 'succeeded' },
    });
    expect(result.snapshotEnvelope?.producerStartReceiptDigest)
      .toBe(result.startReceipt?.receiptDigest);
    expect(result.terminalReceipt?.snapshotEnvelopeDigest)
      .toBe(result.snapshotEnvelope?.envelopeDigest);
    const stores = createAgentOsEpochRuntimeStoresV1(value.dependencies)!;
    for (let index = 0; index < 3; index += 1) {
      const attemptRead = readAgentOsEpochAttemptReceiptsV2(stores.attempt);
      expect(attemptRead).toMatchObject({
        sourceState: 'healthy', complete: true, openAttempts: 0,
      });
      expect(readAgentOsEpochSnapshotsV2(stores.snapshot)).toMatchObject({
        sourceState: 'healthy', complete: true,
      });
    }
    expect(value.runtimeReads()).toBeGreaterThan(2);
    noAuthority(result as unknown as Record<string, unknown>);
  });

  it('closes a durable orphan snapshot on retry without rerunning observation', () => {
    const value = fixture();
    value.setSnapshotSignHook(() => value.setTerminalSignerAvailable(false));
    const first = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
      observe: () => observation('orphan'),
    }, value.dependencies);
    expect(first).toMatchObject({
      disposition: 'open', reason: 'terminal-unavailable', snapshotEnvelope: { epochSequence: 1 },
    });
    value.setTerminalSignerAvailable(true);
    let reran = false;
    const recovered = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
      observe: () => { reran = true; return observation('must-not-run'); },
    }, value.dependencies);
    expect(reran).toBe(false);
    expect(recovered).toMatchObject({
      disposition: 'recovered', reason: 'recovered-snapshot', outcome: 'succeeded',
      terminalReceipt: { outcome: 'succeeded' },
    });
  });

  it.each(['sources', 'snapshots', 'attempts'] as const)(
    'recovers the exact crash-left %s stage before observing',
    (store) => {
      const value = fixture();
      value.appendSourceRenewal();
      expect(runAgentOsEpochObservationV1({
        durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
        observe: () => observation(`staged-one-${store}`),
      }, value.dependencies)).toMatchObject({ disposition: 'completed', reason: 'succeeded' });
      const epochPath = join(
        value.dependencies.epochStoreRootPath, 'epochs', 'epoch-000000000001',
      );
      const fileName = store === 'sources' ? '000000000002.json'
        : store === 'snapshots' ? '000000000001.json'
          : readdirSync(join(epochPath, 'attempts', 'records'))
              .find((file) => file.endsWith('.1.json'));
      if (!fileName) throw new Error('expected durable record');
      const target = join(epochPath, store, 'records', fileName);
      const record = JSON.parse(readFileSync(target, 'utf8')) as {
        authenticator?: string; bundleDigest?: string;
      };
      const id = fileName.slice(0, -'.json'.length);
      const token = (record.authenticator ?? record.bundleDigest)?.slice(0, 32);
      if (!token) throw new Error('expected stage token');
      linkSync(target, join(epochPath, store, 'staging', `.${id}.${token}.stage`));
      let observed = false;
      expect(runAgentOsEpochObservationV1({
        durableTickDigest: TICK_TWO, deadlineUnixMs: null, cancellation: null,
        observe: () => { observed = true; return observation(`staged-two-${store}`); },
      }, value.dependencies)).toMatchObject({ disposition: 'completed', reason: 'succeeded' });
      expect(observed).toBe(true);
      expect(readdirSync(join(epochPath, store, 'staging'))).toEqual([]);
    },
    20_000,
  );

  it('never calls observe when guarded stage recovery encounters hostile evidence', () => {
    const value = fixture();
    const sourceStaging = join(
      value.dependencies.epochStoreRootPath, 'epochs', 'epoch-000000000001',
      'sources', 'staging',
    );
    mkdirSync(join(sourceStaging, '..', 'records'), { mode: 0o700 });
    mkdirSync(sourceStaging, { mode: 0o700 });
    writeFileSync(join(sourceStaging, '.hostile.invalid.stage'), 'not-json\n', { mode: 0o600 });
    let observed = false;
    const recovered = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
      observe: () => { observed = true; return observation('must-not-run'); },
    }, value.dependencies);
    expect(recovered).toMatchObject({
      disposition: 'withheld', reason: 'stage-recovery-unavailable', durable: false,
      startReceipt: null, snapshotEnvelope: null, terminalReceipt: null,
    });
    expect(observed).toBe(false);
  });

  it('blocks a cancelled start and durably records callback exceptions without a snapshot', () => {
    const cancelled = fixture();
    let called = false;
    const cancelResult = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: { isCancellationRequested: () => true },
      observe: () => { called = true; return observation(); },
    }, cancelled.dependencies);
    expect(called).toBe(false);
    expect(cancelResult).toMatchObject({
      disposition: 'withheld', reason: 'cancelled', outcome: 'cancelled', durable: false,
      snapshotEnvelope: null, terminalReceipt: null,
    });

    const failed = fixture();
    const failureResult = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_TWO,
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => { throw new Error('observer failed'); },
    }, failed.dependencies);
    expect(failureResult).toMatchObject({
      disposition: 'completed', reason: 'observation-failed', outcome: 'failed',
      snapshotEnvelope: null, terminalReceipt: { outcome: 'failed' },
    });
  });

  it('marks callback reentrancy failed and never publishes a snapshot', () => {
    const value = fixture();
    const input = {
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => observation('outer'),
    };
    input.observe = () => {
      const nested = runAgentOsEpochObservationV1(input, value.dependencies);
      expect(nested).toMatchObject({ disposition: 'withheld', reason: 'reentrant-call' });
      return observation('outer');
    };
    const result = runAgentOsEpochObservationV1(input, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'failed', reason: 'reentrant-call', outcome: 'failed', snapshotEnvelope: null,
      terminalReceipt: { outcome: 'failed' },
    });
  });

  it('canonicalizes root aliases and poisons the outer runtime on alias reentrancy', () => {
    const value = fixture();
    const aliasParent = join(value.dependencies.anchorPath, 'runtime-alias-parent');
    mkdirSync(aliasParent, { mode: 0o700 });
    const aliasDependencies: AgentOsEpochRuntimeDependenciesV1 = {
      ...value.dependencies,
      epochStoreRootPath: join(aliasParent, '..', 'agent-os-epochs'),
    };
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: null,
      observe() {
        expect(runAgentOsEpochObservationV1({
          durableTickDigest: TICK_TWO,
          deadlineUnixMs: null,
          cancellation: null,
          observe: () => observation('nested-alias'),
        }, aliasDependencies)).toMatchObject({ disposition: 'withheld', reason: 'reentrant-call' });
        return observation('outer-alias');
      },
    }, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'failed', reason: 'reentrant-call', outcome: 'failed', snapshotEnvelope: null,
      terminalReceipt: { outcome: 'failed' },
    });
  });

  it('rechecks cancellation inside snapshot publication and closes non-success', () => {
    const value = fixture();
    let cancelled = false;
    value.setSnapshotSignHook(() => { cancelled = true; });
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: { isCancellationRequested: () => cancelled },
      observe: () => observation('late-cancel'),
    }, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'completed', reason: 'cancelled', outcome: 'cancelled',
      snapshotEnvelope: null, terminalReceipt: { outcome: 'cancelled' },
    });
    const stores = createAgentOsEpochRuntimeStoresV1(value.dependencies)!;
    expect(readAgentOsEpochSnapshotsV2(stores.snapshot).records).toHaveLength(0);
    expect(readAgentOsEpochAttemptReceiptsV2(stores.attempt).records).toHaveLength(2);
  });

  it('truthfully reports a durable open start when authorization expires after publication', () => {
    const value = fixture();
    const attemptId = agentOsEpochAttemptIdV1({
      epoch: 1,
      attemptNamespaceDigest: prefixed('namespace'),
      durableTickDigest: TICK_ONE,
    })!;
    const startPath = join(
      value.dependencies.epochStoreRootPath, 'epochs', 'epoch-000000000001',
      'attempts', 'records', `${attemptId.slice(7)}.1.json`,
    );
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE,
      deadlineUnixMs: null,
      cancellation: { isCancellationRequested: () => existsSync(startPath) },
      observe: () => observation('must-not-run'),
    }, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'open', reason: 'cancelled', outcome: 'cancelled', attemptId,
      startReceipt: null, snapshotEnvelope: null, terminalReceipt: null, durable: true,
    });
    expect(existsSync(startPath)).toBe(true);
  });

  it('fails closed when the fixed post-lock epoch advances during stage recovery', () => {
    const value = fixture();
    value.setRuntimeReadHook(() => {
      if (value.runtimeReads() === 2) {
        value.switchEpoch(2);
        value.setRuntimeReadHook(null);
      }
    });
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
      observe: () => observation('advanced-closure'),
    }, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'withheld', reason: 'stage-recovery-unavailable', outcome: null,
      attemptId: null, startReceipt: null, snapshotEnvelope: null, terminalReceipt: null,
    });
  });

  it('fails closed when an observation callback attempts to mutate its frozen context', () => {
    const value = fixture();
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: TICK_ONE, deadlineUnixMs: null, cancellation: null,
      observe(context) {
        (context as unknown as { attemptId: string }).attemptId = prefixed('forged-attempt');
        return observation('unreachable');
      },
    }, value.dependencies);
    expect(result).toMatchObject({
      disposition: 'completed', reason: 'observation-failed', outcome: 'failed',
      snapshotEnvelope: null, terminalReceipt: { outcome: 'failed' },
    });
  });
});
