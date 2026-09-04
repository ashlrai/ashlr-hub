import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, readFileSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import { beginAgentOsEpochAttemptV2 } from '../src/core/vision/agent-os-epoch-attempt-store.js';
import {
  canonicalAgentOsEpochSourceBundleBytesV2,
  createAgentOsEpochSourceBundleV2,
} from '../src/core/vision/agent-os-epoch-records.js';
import {
  installAgentOsActiveEpochPointerV1,
  prepareAgentOsEpochV1,
  type AgentOsEpochStoreDependenciesV1,
} from '../src/core/vision/agent-os-epoch-store.js';
import {
  createAgentOsEpochTrustCompositionV1,
  type AgentOsCommissionedEpochTrustReadV1,
  type AgentOsEpochTrustCompositionV1,
  type AgentOsFreshAnchorHeadReadV1,
} from '../src/core/vision/agent-os-epoch-trust-composition.js';
import { appendAgentOsEpochSourceRenewalV1 } from '../src/core/vision/agent-os-epoch-source-store.js';
import { writeAgentOsEpochSnapshotV2 } from '../src/core/vision/agent-os-epoch-snapshot-store.js';
import {
  runAgentOsEpochObservationV1,
  type AgentOsEpochRuntimeDependenciesV1,
} from '../src/core/vision/agent-os-epoch-runtime.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';
import {
  AGENT_OS_EPOCH_GENESIS_V1,
  AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
  AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1,
  AGENT_OS_ROLLOVER_AUTHORITY_V1,
  agentOsAttemptNamespaceDigestV1,
  agentOsObservationEpochHeadDigestV1,
  agentOsObservationEpochManifestDigestV1,
  canonicalAgentOsObservationEpochHeadBytesV1,
  canonicalAgentOsObservationEpochManifestBytesV1,
  type AgentOsObservationEpochHeadUnsignedV1,
  type AgentOsObservationEpochManifestUnsignedV1,
  type AgentOsPreparedEpochEvidenceV1,
} from '../src/core/vision/agent-os-rollover-protocol.js';
import type { AgentOsReadModelV1 } from '../src/core/vision/agent-os-read-model.js';

const roots: string[] = [];
const raw = (label: string): string => createHash('sha256').update(`m564\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const CREATED = '2026-09-03T12:00:00.000Z';
const OBSERVED = '2026-09-03T12:00:30.000Z';
const WRITER = prefixed('writer');
const OPERATION = prefixed('operation');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hmacPair(label: string) {
  const key = Buffer.from(raw(`secret:${label}`), 'hex');
  const keyId = raw(`key:${label}`);
  const authenticate = (bytes: Uint8Array) => createHmac('sha256', key).update(bytes).digest('hex');
  return {
    signer: { keyId, authenticate },
    verifier: {
      keyId,
      verify: (request: Readonly<{
        keyId: string;
        canonicalDomainSeparatedReceipt: Uint8Array;
        authenticator: string;
      }>) => request.keyId === keyId &&
        request.authenticator === authenticate(request.canonicalDomainSeparatedReceipt),
    },
  };
}

function snapshotModel(): AgentOsReadModelV1 {
  return {
    sourceState: 'healthy',
    livingEndState: {
      northStar: 'Turn governed capacity into durable value.',
      currentBottleneck: 'Authenticated composition',
      revisionLabel: 'Current mission basis',
      evidenceState: 'complete',
    },
    capabilitySpectrum: [{
      lane: 'codex', label: 'Codex', state: 'ready', headroom: 'usable',
      resetUrgency: 'later', resetLabel: 'Reset later', allocationLabel: 'Usable capacity',
    }],
    activeValueBets: [{
      key: raw('bet'), title: 'Trust composition', valueCase: 'Verify exact runtime closure.',
      allocationLabel: 'Observe', decision: 'observing', assurance: 'targeted',
      outcome: { state: 'pending', label: 'Pending' },
      evidence: { state: 'complete', label: 'Complete' },
    }],
    nextAction: {
      kind: 'attention', title: 'Inspect evidence', reason: 'The evidence is authenticated.',
      evidenceState: 'complete',
    },
  };
}

function fixture() {
  const counts = { trust: 0, anchor: 0, manifest: 0, source: 0, attempt: 0, snapshot: 0 };
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m564-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const sourceKeys = generateKeyPairSync('ed25519');
  const sourceKeyId = raw('source-key');
  const sourcePrincipalDigest = prefixed('source-principal');
  const sourceSigner = {
    keyId: sourceKeyId,
    principalDigest: sourcePrincipalDigest,
    sign: (bytes: Uint8Array) => Buffer.from(signEd25519(null, Buffer.from(bytes), sourceKeys.privateKey)),
  };
  const sourceVerifier = {
    verify: (request: Readonly<{
      canonicalDomainSeparatedPayload: Uint8Array;
      signature: Uint8Array;
    }>) => {
      counts.source += 1;
      return verifyEd25519(
        null,
        Buffer.from(request.canonicalDomainSeparatedPayload),
        sourceKeys.publicKey,
        Buffer.from(request.signature),
      );
    },
  };
  const first = createAgentOsEpochSourceBundleV2({
    epoch: 1,
    previousEpochHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
    previousEpochSourceTipDigest: null,
    trustPolicyDigest: raw('policy-a'),
    policyGeneration: 1,
    sourceKeyId,
    sourcePrincipalDigest,
    evidencePrincipalDigest: prefixed('evidence'),
    outcomePrincipalDigests: [prefixed('outcome')],
    issuedAt: CREATED,
    expiresAt: '2026-09-03T12:04:00.000Z',
    sourcePayloadBytes: Buffer.from('{"attempt":"A"}', 'utf8'),
  }, sourceSigner)!;
  const firstBytes = canonicalAgentOsEpochSourceBundleBytesV2(first)!;
  const manifestUnsigned: AgentOsObservationEpochManifestUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_MANIFEST_PROTOCOL_V1,
    recordType: 'agent-os-observation-epoch',
    epoch: 1,
    protocolGeneration: 1,
    previousEpochHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
    previousEpochManifestDigest: AGENT_OS_EPOCH_GENESIS_V1.manifestDigest,
    previousSourceTip: null,
    previousSnapshotTip: null,
    previousAttemptSetDigest: AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
    previousCoherentBindingDigest: null,
    firstSourceBundle: {
      epochSequence: 1,
      bundleDigest: first.bundleDigest,
      previousBundleDigest: first.previousBundleDigest,
      trustPolicyDigest: first.trustPolicyDigest,
      policyGeneration: first.policyGeneration,
    },
    snapshotBase: {
      nextSequence: 1,
      previousEnvelopeDigest: AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    },
    attemptNamespaceDigest: agentOsAttemptNamespaceDigestV1({
      epoch: 1,
      previousEpochHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
      previousAttemptSetDigest: AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
      firstSourceBundleDigest: first.bundleDigest,
    })!,
    createdAt: CREATED,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  const manifest = {
    ...manifestUnsigned,
    manifestDigest: agentOsObservationEpochManifestDigestV1(manifestUnsigned)!,
    localAuthenticator: raw('manifest-mac'),
  };
  const headUnsigned: AgentOsObservationEpochHeadUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
    epoch: 1,
    protocolGeneration: 1,
    previousHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
    epochManifestDigest: manifest.manifestDigest,
    firstSourceBundleDigest: first.bundleDigest,
    closedSourceTipDigest: AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
    closedSnapshotTipDigest: AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    closedAttemptSetDigest: AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
    coherentBindingDigest: AGENT_OS_EPOCH_GENESIS_V1.coherentBindingDigest,
    writerProtocolDigest: WRITER,
    advancedAt: CREATED,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  const head = { ...headUnsigned, headDigest: agentOsObservationEpochHeadDigestV1(headUnsigned)! };
  const manifestBytes = canonicalAgentOsObservationEpochManifestBytesV1(manifest)!;
  const headBytes = canonicalAgentOsObservationEpochHeadBytesV1(head)!;
  const evidence: AgentOsPreparedEpochEvidenceV1 = {
    epoch: 1,
    previousHeadDigest: head.previousHeadDigest,
    manifestDigest: manifest.manifestDigest,
    firstSourceBundleDigest: first.bundleDigest,
    snapshotBasePreviousEnvelopeDigest: manifest.snapshotBase.previousEnvelopeDigest,
    attemptNamespaceDigest: manifest.attemptNamespaceDigest,
    recoveryOperationId: OPERATION,
  };
  let anchor: AgentOsFreshAnchorHeadReadV1 = {
    state: 'present', canonicalHeadBytes: Buffer.from(headBytes),
  };
  const storeDependencies: AgentOsEpochStoreDependenciesV1 = {
    anchorPath,
    rootPath: epochStoreRootPath,
    writerProtocolDigest: WRITER,
    manifestAuthenticatorVerifier: () => true,
    preparedEpochEvidenceVerifier: () => true,
    firstSourceBundleVerifier: (bytes, digest) =>
      digest === first.bundleDigest && Buffer.from(bytes).equals(firstBytes),
    readAnchorHead: () => anchor,
  };
  const lease = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: epochStoreRootPath, writerProtocolDigest: WRITER,
  });
  if (lease.state !== 'acquired') throw new Error('lease unavailable');
  const lock = acquireAgentOsObservationLockV1(anchorPath);
  if (!lock) throw new Error('observation lock unavailable');
  expect(prepareAgentOsEpochV1({
    canonicalManifestBytes: manifestBytes,
    canonicalHeadBytes: headBytes,
    canonicalFirstSourceBundleBytes: firstBytes,
    preparedEvidence: evidence,
    coordinationLease: lease.lease,
    observationLock: lock,
  }, storeDependencies).state).toBe('accepted');
  expect(installAgentOsActiveEpochPointerV1({
    canonicalHeadBytes: headBytes,
    operationId: OPERATION,
    expectedPreviousHeadDigest: null,
    coordinationLease: lease.lease,
    observationLock: lock,
  }, storeDependencies).state).toBe('accepted');
  releaseAgentOsObservationLockV1(lock);
  releaseAgentOsEpochCoordinationLeaseV1(lease.lease);

  const attemptABase = hmacPair('attempt-a');
  let onAttemptAuthenticate: ((bytes: Uint8Array) => void) | null = null;
  const attemptA = {
    ...attemptABase,
    signer: {
      keyId: attemptABase.signer.keyId,
      authenticate(bytes: Uint8Array) {
        onAttemptAuthenticate?.(bytes);
        return attemptABase.signer.authenticate(bytes);
      },
    },
  };
  const attemptB = hmacPair('attempt-b');
  const attemptKeys = new Map<string, ReturnType<typeof hmacPair>>([
    ['A', attemptA], ['B', attemptB],
  ]);
  const snapshotKey = Buffer.from(raw('snapshot-secret'), 'hex');
  const snapshotIdentity = prefixed('snapshot-producer');
  const snapshotKeyId = raw('snapshot-key');
  const snapshotAuth = (bytes: Uint8Array) =>
    createHmac('sha256', snapshotKey).update(bytes).digest('hex');
  let commissioningDigest = prefixed('commissioning-one');
  let commissioned = true;
  let clockIso = OBSERVED;
  let signerMismatch = false;
  const trustRead = (): AgentOsCommissionedEpochTrustReadV1 => {
    counts.trust += 1;
    return commissioned ? {
    state: 'commissioned',
    trust: {
      commissioningDigest,
      manifestAuthenticatorVerifier: (_bytes, candidate) => {
        counts.manifest += 1;
        return candidate.localAuthenticator === manifest.localAuthenticator;
      },
      preparedEpochEvidenceVerifier: (candidate) => candidate.recoveryOperationId === OPERATION,
      firstSourceSignatureVerifier: sourceVerifier,
      renewalSignatureVerifier: sourceVerifier,
      renewalSigner: sourceSigner,
      attemptAuthenticatorResolver: {
        resolveAuthenticatedAttemptAuthenticator(source) {
          counts.attempt += 1;
          const label = Buffer.from(source.sourcePayload, 'base64url').toString('utf8').includes('"B"')
            ? 'B' : 'A';
          const selected = attemptKeys.get(label);
          return selected ? {
            state: 'authenticated' as const,
            keyId: selected.signer.keyId,
            generation: label === 'A' ? 1 : 2,
            signer: selected.signer,
            verifier: selected.verifier,
          } : { state: 'missing' as const };
        },
      },
      snapshotAuthenticatorResolver: {
        resolveManifestFixedSnapshotAuthenticator(request) {
          counts.snapshot += 1;
          const signer = {
            producerIdentityDigest: snapshotIdentity,
            keyId: snapshotKeyId,
            keyGeneration: 1,
            sign: (bytes: Uint8Array) => snapshotAuth(bytes),
          };
          const verifier = {
            producerIdentityDigest: snapshotIdentity,
            keyId: signerMismatch ? raw('wrong-snapshot-key') : snapshotKeyId,
            keyGeneration: 1,
            verify: (input: Readonly<{
              canonicalDomainSeparatedEnvelope: Uint8Array;
              authenticator: string;
            }>) => input.authenticator === snapshotAuth(input.canonicalDomainSeparatedEnvelope),
          };
          return request.epochManifestDigest === manifest.manifestDigest
            ? { state: 'authenticated' as const, epochManifestDigest: manifest.manifestDigest, signer, verifier }
            : { state: 'missing' as const };
        },
      },
    },
    } : { state: 'uncommissioned' };
  };
  const createComposition = (): AgentOsEpochTrustCompositionV1 => {
    const created = createAgentOsEpochTrustCompositionV1({
      anchorPath,
      epochStoreRootPath,
      writerProtocolDigest: WRITER,
      freshAnchorHeadProvider: { readFreshAnchorHead: () => { counts.anchor += 1; return anchor; } },
      commissionedTrustProvider: { readCommissionedEpochTrust: trustRead },
      clock: { now: () => ({ unixMs: Date.parse(clockIso), iso: clockIso }) },
    });
    if (!created) throw new Error('composition invalid');
    return created;
  };
  const composition = createComposition();
  return {
    anchorPath, epochStoreRootPath, headBytes, head, manifest, first, sourceSigner, counts,
    attemptA, attemptB, composition, createComposition,
    setAnchor(value: AgentOsFreshAnchorHeadReadV1) { anchor = value; },
    setCommissioned(value: boolean) { commissioned = value; },
    setSignerMismatch(value: boolean) { signerMismatch = value; },
    setCommissioningDigest(value: string) { commissioningDigest = value; },
    setClock(value: string) { clockIso = value; },
    setOnAttemptAuthenticate(value: ((bytes: Uint8Array) => void) | null) {
      onAttemptAuthenticate = value;
    },
    retireAttempt(label: string) { attemptKeys.delete(label); },
  };
}

function runObserved(composition: AgentOsEpochTrustCompositionV1, label: string) {
  return runAgentOsEpochObservationV1({
    durableTickDigest: prefixed(`runtime:${label}`),
    deadlineUnixMs: null,
    cancellation: null,
    observe: () => ({
      renderedAt: '2026-09-03T12:00:31.000Z',
      observedAt: '2026-09-03T12:00:32.000Z',
      kernelCycleDigest: raw(`kernel:${label}`),
      capabilityProjectionDigest: prefixed(`capability:${label}`),
      portfolioDigest: raw(`portfolio:${label}`),
      snapshot: snapshotModel(),
      snapshotDigest: prefixed(`snapshot:${label}`),
    }),
  }, composition.runtimeDependencies);
}

describe('M564 commissioned epoch trust composition', () => {
  it('constructs an authenticated identity-only closure and runs the real M562 transaction', () => {
    const value = fixture();
    const closure = value.composition.authenticatedClosureProvider.readAuthenticatedClosure();
    expect(closure).toMatchObject({
      state: 'authenticated',
      closure: {
        source: { epoch: 1, epochHeadDigest: value.head.headDigest },
        attempt: { sourceBundleDigest: value.first.bundleDigest, attemptAuthenticatorGeneration: 1 },
        snapshot: { epochManifestDigest: value.manifest.manifestDigest },
      },
    });
    expect(JSON.stringify(closure)).not.toContain('sign');
    expect(value.composition).toMatchObject({
      authority: 'observation-only', writesAuthorized: false, pointerMutationAuthorized: false,
      anchorMutationAuthority: false, executionAuthority: false, effectAuthority: false,
      externalMutationAuthority: false,
    });
    const runtimeInput = {
      durableTickDigest: prefixed('tick'),
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => ({
        renderedAt: '2026-09-03T12:00:31.000Z',
        observedAt: '2026-09-03T12:00:32.000Z',
        kernelCycleDigest: raw('kernel'),
        capabilityProjectionDigest: prefixed('capability'),
        portfolioDigest: raw('portfolio'),
        snapshot: snapshotModel(),
        snapshotDigest: prefixed('snapshot'),
      }),
    };
    const result = runAgentOsEpochObservationV1(runtimeInput, value.composition.runtimeDependencies);
    expect(result).toMatchObject({
      disposition: 'completed', reason: 'succeeded', outcome: 'succeeded', durable: true,
      authority: 'observation-only', executionAuthority: false, effectAuthority: false,
    });
    expect(value.counts).toMatchObject({ manifest: 2, source: 3, attempt: 1 });
    expect(value.counts.snapshot).toBeLessThanOrEqual(10);
    // Every read remains freshly fenced; these ceilings catch accidental
    // return to recursive full-lineage scans while allowing filesystem jitter.
    expect(value.counts.anchor).toBeLessThanOrEqual(730);
    expect(value.counts.trust).toBeLessThanOrEqual(750);
    value.setAnchor({ state: 'missing' });
    expect(runAgentOsEpochObservationV1(runtimeInput, value.composition.runtimeDependencies))
      .toMatchObject({ disposition: 'withheld', reason: 'closure-unavailable', durable: false });
    value.setAnchor({ state: 'present', canonicalHeadBytes: value.headBytes });
    value.setClock('2026-09-03T12:04:00.000Z');
    expect(runAgentOsEpochObservationV1(runtimeInput, value.composition.runtimeDependencies))
      .toMatchObject({ disposition: 'withheld', reason: 'closure-unavailable', durable: false });
  }, 15_000);

  it('fails closed when commissioning is absent', () => {
    const value = fixture();
    value.setCommissioned(false);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
  });

  it('rejects stale, rollback, missing, and malformed fresh anchor reads', () => {
    const value = fixture();
    for (const anchor of [
      { state: 'missing' as const },
      { state: 'present' as const, canonicalHeadBytes: Buffer.from('{}') },
      { state: 'present' as const, canonicalHeadBytes: Buffer.from(value.headBytes).fill(0, 0, 1) },
    ]) {
      value.setAnchor(anchor);
      expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
        .toEqual({ state: 'degraded' });
    }
  });

  it('rejects public session activation and revalidates every independent facade read', () => {
    const value = fixture();
    const session = value.composition.runtimeDependencies.trustReadSession!;
    expect(session.begin({} as never)).toBe(false);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure().state)
      .toBe('authenticated');
    value.setAnchor({ state: 'missing' });
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
    value.setAnchor({ state: 'present', canonicalHeadBytes: value.headBytes });
    value.setCommissioned(false);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
    value.setCommissioned(true);
    const manifestPath = join(
      value.epochStoreRootPath, 'epochs', 'epoch-000000000001', 'manifest.json',
    );
    const bytes = readFileSync(manifestPath);
    bytes[0] ^= 1;
    writeFileSync(manifestPath, bytes, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
  });

  it('denies reconstructed M557 and M560 writes outside the exact runtime session', () => {
    const value = fixture();
    const read = value.composition.authenticatedClosureProvider.readAuthenticatedClosure();
    expect(read.state).toBe('authenticated');
    if (read.state !== 'authenticated') return;
    expect(value.composition.runtimeDependencies.attemptSigner?.authenticate(Buffer.from('probe')))
      .toBeNull();
    expect(value.composition.runtimeDependencies.snapshotSigner?.sign(Buffer.from('probe')))
      .toBeNull();
    const lease = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: value.epochStoreRootPath, writerProtocolDigest: WRITER,
    });
    const lock = acquireAgentOsObservationLockV1(value.anchorPath);
    expect(lease.state).toBe('acquired');
    expect(lock).not.toBeNull();
    if (lease.state !== 'acquired' || !lock) return;
    try {
      const attempt = beginAgentOsEpochAttemptV2({
        durableTickDigest: prefixed('reconstructed-attempt'),
        startedAt: '2026-09-03T12:00:31.000Z',
        coordinationLease: lease.lease,
        observationLock: lock,
      }, {
        anchorPath: value.anchorPath,
        epochStoreRootPath: value.epochStoreRootPath,
        writerProtocolDigest: WRITER,
        activeClosureProvider: {
          readAuthenticatedClosure: () => ({ state: 'authenticated', closure: read.closure.attempt }),
        },
        historicalSourceLineageProvider:
          value.composition.runtimeDependencies.attemptHistoricalSourceLineageProvider,
        signer: value.composition.runtimeDependencies.attemptSigner,
      });
      expect(attempt.durable).toBe(false);
      expect(attempt.disposition).not.toBe('recorded');

      const snapshot = writeAgentOsEpochSnapshotV2({
        durableTickDigest: prefixed('reconstructed-snapshot'),
        renderedAt: '2026-09-03T12:00:31.000Z',
        observedAt: '2026-09-03T12:00:32.000Z',
        kernelCycleDigest: raw('reconstructed-kernel'),
        capabilityProjectionDigest: prefixed('reconstructed-capability'),
        portfolioDigest: raw('reconstructed-portfolio'),
        snapshot: snapshotModel(),
        snapshotDigest: prefixed('reconstructed-snapshot-model'),
        coordinationLease: lease.lease,
        observationLock: lock,
      }, {
        anchorPath: value.anchorPath,
        epochStoreRootPath: value.epochStoreRootPath,
        writerProtocolDigest: WRITER,
        activeClosureProvider: {
          readAuthenticatedClosure: () => ({ state: 'authenticated', closure: read.closure.snapshot }),
        },
        historicalContextProvider:
          value.composition.runtimeDependencies.snapshotHistoricalContextProvider,
        startReceiptProvider: {
          readAuthenticatedStartReceipt: () => ({
            state: 'authenticated',
            startReceiptDigest: raw('reconstructed-start-receipt'),
            sourceBundleDigest: read.closure.snapshot.sourceBundleDigest,
            trustPolicyDigest: read.closure.snapshot.trustPolicyDigest,
          }),
        },
        signer: value.composition.runtimeDependencies.snapshotSigner,
        verifier: value.composition.runtimeDependencies.snapshotVerifier,
      });
      expect(snapshot.durable).toBe(false);
      expect(snapshot.disposition).not.toBe('recorded');
    } finally {
      releaseAgentOsObservationLockV1(lock);
      releaseAgentOsEpochCoordinationLeaseV1(lease.lease);
    }
  });

  it('revalidates current-source expiry before and during a runtime transaction', () => {
    const expired = fixture();
    expired.setClock('2026-09-03T12:04:00.000Z');
    expect(expired.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });

    const advancing = fixture();
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: prefixed('tick-expiring-during-observation'),
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => {
        advancing.setClock('2026-09-03T12:04:00.000Z');
        return {
          renderedAt: '2026-09-03T12:00:31.000Z',
          observedAt: '2026-09-03T12:00:32.000Z',
          kernelCycleDigest: raw('kernel-expiring'),
          capabilityProjectionDigest: prefixed('capability-expiring'),
          portfolioDigest: raw('portfolio-expiring'),
          snapshot: snapshotModel(),
          snapshotDigest: prefixed('snapshot-expiring'),
        };
      },
    }, advancing.composition.runtimeDependencies);
    expect(result).toMatchObject({ disposition: 'open', reason: 'snapshot-unavailable', durable: true });
  }, 15_000);

  it('rejects manifest-fixed signer/verifier mismatches', () => {
    const value = fixture();
    value.setSignerMismatch(true);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
  });

  it('fails closed on commissioned trust drift inside a signer callback', () => {
    const value = fixture();
    let invoked = false;
    value.setOnAttemptAuthenticate(() => {
      invoked = true;
      value.setCommissioningDigest(prefixed('commissioning-two'));
    });
    expect(runObserved(value.composition, 'commissioning-drift')).toMatchObject({
      disposition: 'withheld', reason: 'attempt-start-unavailable', durable: false,
    });
    expect(invoked).toBe(true);
  });

  it('marks cross-instance root reentry and withholds the outer signer callback', () => {
    const value = fixture();
    const second = value.createComposition();
    let invoked = false;
    value.setOnAttemptAuthenticate(() => {
      invoked = true;
      expect(second.authenticatedClosureProvider.readAuthenticatedClosure())
        .toEqual({ state: 'degraded' });
    });
    expect(runObserved(value.composition, 'cross-instance-reentry')).toMatchObject({
      disposition: 'withheld', reason: 'attempt-start-unavailable', durable: false,
    });
    expect(invoked).toBe(true);
  });

  it('atomically rejects laundering a runtime token into another composition session', () => {
    const value = fixture();
    const second = value.createComposition();
    let laundered = true;
    const dependencies: AgentOsEpochRuntimeDependenciesV1 = {
      ...value.composition.runtimeDependencies,
      trustReadSession: {
        begin(token) {
          laundered = second.runtimeDependencies.trustReadSession!.begin(token);
          return false;
        },
        end() {},
      },
    };
    const result = runAgentOsEpochObservationV1({
      durableTickDigest: prefixed('laundered-token'),
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => { throw new Error('must not observe'); },
    }, dependencies);
    expect(laundered).toBe(false);
    expect(result).toMatchObject({
      disposition: 'withheld', reason: 'closure-unavailable', durable: false,
    });
    expect(second.authenticatedClosureProvider.readAuthenticatedClosure().state)
      .toBe('authenticated');
  });

  it('detects callback byte mutation and immutable-core tampering', () => {
    const value = fixture();
    let invoked = false;
    value.setOnAttemptAuthenticate((bytes) => {
      invoked = true;
      bytes[0] ^= 1;
    });
    expect(runObserved(value.composition, 'byte-mutation')).toMatchObject({
      disposition: 'withheld', reason: 'attempt-start-unavailable', durable: false,
    });
    expect(invoked).toBe(true);
    const manifestPath = join(
      value.epochStoreRootPath, 'epochs', 'epoch-000000000001', 'manifest.json',
    );
    const bytes = readFileSync(manifestPath);
    bytes[0] ^= 1;
    writeFileSync(manifestPath, bytes, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
  });

  it('invalidates a pinned composition on source rotation and key-retirement generation change', () => {
    const value = fixture();
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure().state)
      .toBe('authenticated');
    const lease = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: value.epochStoreRootPath, writerProtocolDigest: WRITER,
    });
    const lock = acquireAgentOsObservationLockV1(value.anchorPath);
    expect(lease.state).toBe('acquired');
    expect(lock).not.toBeNull();
    if (lease.state !== 'acquired' || !lock) return;
    const renewal = appendAgentOsEpochSourceRenewalV1({
      evidencePrincipalDigest: prefixed('renewal-evidence'),
      outcomePrincipalDigests: [prefixed('renewal-outcome')],
      issuedAt: '2026-09-03T12:00:45.000Z',
      expiresAt: '2026-09-03T12:04:45.000Z',
      sourcePayloadBytes: Buffer.from('{"attempt":"B"}', 'utf8'),
      coordinationLease: lease.lease,
      observationLock: lock,
    }, value.composition.runtimeDependencies.sourceStore);
    releaseAgentOsObservationLockV1(lock);
    releaseAgentOsEpochCoordinationLeaseV1(lease.lease);
    expect(renewal).toMatchObject({ disposition: 'recorded', durable: true });
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
    value.retireAttempt('A');
    value.setCommissioningDigest(prefixed('commissioning-after-retirement'));
    expect(value.composition.authenticatedClosureProvider.readAuthenticatedClosure())
      .toEqual({ state: 'degraded' });
  });

  it('continues a composed runtime after conservative linked-source cleanup', () => {
    const value = fixture();
    const lease = acquireAgentOsEpochCoordinationLeaseV1({
      rootPath: value.epochStoreRootPath, writerProtocolDigest: WRITER,
    });
    const lock = acquireAgentOsObservationLockV1(value.anchorPath);
    expect(lease.state).toBe('acquired');
    expect(lock).not.toBeNull();
    if (lease.state !== 'acquired' || !lock) return;
    const renewal = appendAgentOsEpochSourceRenewalV1({
      evidencePrincipalDigest: prefixed('linked-recovery-evidence'),
      outcomePrincipalDigests: [prefixed('linked-recovery-outcome')],
      issuedAt: '2026-09-03T12:00:20.000Z',
      expiresAt: '2026-09-03T12:04:20.000Z',
      sourcePayloadBytes: Buffer.from('{"attempt":"B"}', 'utf8'),
      coordinationLease: lease.lease,
      observationLock: lock,
    }, value.composition.runtimeDependencies.sourceStore);
    releaseAgentOsObservationLockV1(lock);
    releaseAgentOsEpochCoordinationLeaseV1(lease.lease);
    expect(renewal).toMatchObject({ disposition: 'recorded', durable: true });
    expect(renewal.renewal).not.toBeNull();
    if (!renewal.renewal) return;

    const id = String(renewal.renewal.epochSequence).padStart(12, '0');
    const sourceRoot = join(
      value.epochStoreRootPath, 'epochs', 'epoch-000000000001', 'sources',
    );
    const target = join(sourceRoot, 'records', `${id}.json`);
    const stage = join(
      sourceRoot, 'staging', `.${id}.${renewal.renewal.bundleDigest.slice(0, 32)}.stage`,
    );
    linkSync(target, stage);
    expect(existsSync(stage)).toBe(true);
    const recoveredComposition = value.createComposition();

    const result = runAgentOsEpochObservationV1({
      durableTickDigest: prefixed('linked-recovery-tick'),
      deadlineUnixMs: null,
      cancellation: null,
      observe: () => ({
        renderedAt: '2026-09-03T12:00:31.000Z',
        observedAt: '2026-09-03T12:00:32.000Z',
        kernelCycleDigest: raw('linked-recovery-kernel'),
        capabilityProjectionDigest: prefixed('linked-recovery-capability'),
        portfolioDigest: raw('linked-recovery-portfolio'),
        snapshot: snapshotModel(),
        snapshotDigest: prefixed('linked-recovery-snapshot'),
      }),
    }, recoveredComposition.runtimeDependencies);
    expect(result).toMatchObject({
      disposition: 'completed', reason: 'succeeded', durable: true,
    });
    expect(existsSync(stage)).toBe(false);
  }, 15_000);
});
