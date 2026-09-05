import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as signEd25519,
  verify as verifyEd25519,
} from 'node:crypto';
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

import type { LocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  acquireAgentOsEpochCoordinationLeaseV1,
  releaseAgentOsEpochCoordinationLeaseV1,
  type AgentOsEpochCoordinationLeaseV1,
} from '../src/core/vision/agent-os-epoch-coordination.js';
import {
  AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
  agentOsEpochAttemptHistoricalSourceLineageDigestV1,
  agentOsEpochAttemptHistoricalSourceSetDigestV1,
  type AgentOsEpochAttemptHistoricalSourceLineageV1,
} from '../src/core/vision/agent-os-epoch-attempt-store.js';
import {
  canonicalAgentOsEpochSourceBundleBytesV2,
  createAgentOsEpochSourceBundleV2,
  type AgentOsEpochAttemptSignerV2,
  type AgentOsEpochAttemptVerifierV2,
} from '../src/core/vision/agent-os-epoch-records.js';
import {
  canonicalAgentOsEpochSourceRenewalBytesV1,
  createAgentOsEpochSourceRenewalV1,
} from '../src/core/vision/agent-os-epoch-source-ledger.js';
import {
  appendAgentOsEpochSourceRenewalV1,
  createAgentOsEpochSourceHistoricalLineageProviderV1,
  readAgentOsEpochSourceStoreV1,
  recoverAgentOsEpochSourceStoreV1,
  type AgentOsAuthenticatedActiveEpochSourceContextV1,
  type AgentOsEpochSourceStoreDependenciesV1,
} from '../src/core/vision/agent-os-epoch-source-store.js';
import {
  acquireAgentOsObservationLockV1,
  releaseAgentOsObservationLockV1,
} from '../src/core/vision/agent-os-observation-lock.js';

const roots: string[] = [];
const leases: AgentOsEpochCoordinationLeaseV1[] = [];
const locks: LocalStoreLock[] = [];
const raw = (label: string): string => createHash('sha256').update(`m561:${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const WRITER = prefixed('writer');
const CREATED = '2026-09-03T12:00:00.000Z';
const OBSERVED = '2026-09-03T12:00:30.000Z';

afterEach(() => {
  for (const lock of locks.splice(0)) releaseAgentOsObservationLockV1(lock);
  for (const lease of leases.splice(0)) releaseAgentOsEpochCoordinationLeaseV1(lease);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function attemptCrypto(label: string): {
  signer: AgentOsEpochAttemptSignerV2;
  verifier: AgentOsEpochAttemptVerifierV2;
} {
  const key = createHash('sha256').update(`attempt:${label}`).digest();
  const keyId = raw(`attempt-key:${label}`);
  const authenticate = (bytes: Uint8Array) => createHmac('sha256', key).update(bytes).digest('hex');
  return {
    signer: { keyId, authenticate },
    verifier: {
      keyId,
      verify: (request) => request.keyId === keyId &&
        request.authenticator === authenticate(request.canonicalDomainSeparatedReceipt),
    },
  };
}

function fixture(options: { createSources?: boolean; maxSources?: number } = {}) {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m561-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const epochStoreRootPath = join(anchorPath, 'agent-os-epochs');
  const epochPath = join(epochStoreRootPath, 'epochs', 'epoch-000000000001');
  const sourcesPath = join(epochPath, 'sources');
  for (const path of [epochStoreRootPath, join(epochStoreRootPath, 'epochs'), epochPath]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  if (options.createSources !== false) {
    mkdirSync(sourcesPath, { mode: 0o700 });
    chmodSync(sourcesPath, 0o700);
  }

  const sourceKeys = generateKeyPairSync('ed25519');
  const sourceKeyId = raw('source-key');
  const sourcePrincipalDigest = prefixed('source-principal');
  const sourceSigner = {
    keyId: sourceKeyId,
    principalDigest: sourcePrincipalDigest,
    sign: (bytes: Uint8Array) => Buffer.from(signEd25519(null, Buffer.from(bytes), sourceKeys.privateKey)),
  };
  let firstSourceVerifierReads = 0;
  let renewalVerifierReads = 0;
  const verifySource = (request: { canonicalDomainSeparatedPayload: Uint8Array; signature: Uint8Array }) =>
    verifyEd25519(
        null,
        Buffer.from(request.canonicalDomainSeparatedPayload),
        sourceKeys.publicKey,
        Buffer.from(request.signature),
      );
  const sourceVerifier = {
    verify: (request: { canonicalDomainSeparatedPayload: Uint8Array; signature: Uint8Array }) => {
      firstSourceVerifierReads += 1;
      return verifySource(request);
    },
  };
  const renewalVerifier = {
    verify: (request: { canonicalDomainSeparatedPayload: Uint8Array; signature: Uint8Array }) => {
      renewalVerifierReads += 1;
      return verifySource(request);
    },
  };
  const first = createAgentOsEpochSourceBundleV2({
    epoch: 1,
    previousEpochHeadDigest: prefixed('genesis-head'),
    previousEpochSourceTipDigest: null,
    trustPolicyDigest: raw('policy'),
    policyGeneration: 1,
    sourceKeyId,
    sourcePrincipalDigest,
    evidencePrincipalDigest: prefixed('first-evidence'),
    outcomePrincipalDigests: [prefixed('first-outcome')],
    issuedAt: CREATED,
    expiresAt: '2026-09-03T12:04:00.000Z',
    sourcePayloadBytes: Buffer.from('{"attemptKey":"A"}', 'utf8'),
  }, sourceSigner);
  if (!first) throw new Error('could not create first source');
  writeFileSync(
    join(epochPath, 'first-source.json'),
    canonicalAgentOsEpochSourceBundleBytesV2(first)!,
    { mode: 0o600 },
  );
  chmodSync(join(epochPath, 'first-source.json'), 0o600);

  const attemptA = attemptCrypto('A');
  const attemptB = attemptCrypto('B');
  const authenticators = new Map<number, {
    generation: number;
    signer: AgentOsEpochAttemptSignerV2;
    verifier: AgentOsEpochAttemptVerifierV2;
  }>([
    [1, { generation: 1, ...attemptA }],
    [2, { generation: 2, ...attemptB }],
  ]);
  let active: AgentOsAuthenticatedActiveEpochSourceContextV1 = {
    epoch: 1,
    epochHeadDigest: prefixed('epoch-head'),
    epochManifestDigest: prefixed('epoch-manifest'),
    previousEpochHeadDigest: prefixed('genesis-head'),
    previousEpochSourceTipDigest: null,
    attemptNamespaceDigest: prefixed('attempt-namespace'),
    firstSourceBundleDigest: first.bundleDigest,
    trustPolicyDigest: first.trustPolicyDigest,
    policyGeneration: first.policyGeneration,
    expectedSourceKeyId: first.sourceKeyId,
    expectedSourcePrincipalDigest: first.sourcePrincipalDigest,
    epochCreatedAt: OBSERVED,
    observedAt: OBSERVED,
    writerProtocolDigest: WRITER,
  };
  let providerReads = 0;
  let authenticatorResolverReads = 0;
  const dependencies: AgentOsEpochSourceStoreDependenciesV1 = {
    anchorPath,
    epochStoreRootPath,
    writerProtocolDigest: WRITER,
    activeContextProvider: {
      readAuthenticatedActiveEpochSourceContext: () => {
        providerReads += 1;
        return { state: 'authenticated' as const, context: { ...active } };
      },
    },
    firstSourceSignatureVerifier: sourceVerifier,
    renewalSignatureVerifier: renewalVerifier,
    renewalSigner: sourceSigner,
    attemptAuthenticatorResolver: {
      resolveAuthenticatedAttemptAuthenticator(source) {
        authenticatorResolverReads += 1;
        const selected = authenticators.get(source.epochSequence) ??
          (source.epochSequence > 1 ? authenticators.get(2) : undefined);
        return selected
          ? { state: 'authenticated' as const, keyId: selected.signer.keyId, ...selected }
          : { state: 'missing' as const };
      },
    },
    maxSources: options.maxSources,
  };
  const lease = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: epochStoreRootPath,
    writerProtocolDigest: WRITER,
  });
  if (lease.state !== 'acquired') throw new Error('could not acquire lease');
  leases.push(lease.lease);
  const observationLock = acquireAgentOsObservationLockV1(anchorPath);
  if (!observationLock) throw new Error('could not acquire observation lock');
  locks.push(observationLock);
  return {
    anchorPath,
    epochPath,
    sourcesPath,
    dependencies,
    first,
    attemptA,
    attemptB,
    sourceSigner,
    lease: lease.lease,
    observationLock,
    providerReads: () => providerReads,
    authenticatorResolverReads: () => authenticatorResolverReads,
    firstSourceVerifierReads: () => firstSourceVerifierReads,
    renewalVerifierReads: () => renewalVerifierReads,
    getContext: () => ({ ...active }),
    setContext(value: AgentOsAuthenticatedActiveEpochSourceContextV1) { active = value; },
    append(
      issuedAt = '2026-09-03T12:00:45.000Z',
      payload = Buffer.from('{"attemptKey":"B"}', 'utf8'),
    ) {
      return appendAgentOsEpochSourceRenewalV1({
        evidencePrincipalDigest: prefixed(`evidence:${issuedAt}`),
        outcomePrincipalDigests: [prefixed(`outcome:${issuedAt}`)],
        issuedAt,
        expiresAt: '2026-09-03T12:04:45.000Z',
        sourcePayloadBytes: payload,
        coordinationLease: lease.lease,
        observationLock,
      }, dependencies);
    },
  };
}

function expectNoAuthority(value: Record<string, unknown>): void {
  expect(value).toMatchObject({
    authority: 'observation-only', writesAuthorized: false, pointerMutationAuthorized: false,
    anchorMutationAuthority: false, planningAuthority: false, executionAuthority: false,
    effectAuthority: false, proposalAuthority: false, learningAuthority: false,
    promotionAuthority: false, mergeAuthority: false, releaseAuthority: false,
    deployAuthority: false, publicationAuthority: false, budgetAuthority: false,
    credentialAuthority: false, externalMutationAuthority: false,
    rollbackProtected: false, sameUserTamperResistant: false,
  });
}

describe('M561 durable active-epoch source ledger', () => {
  it('reads M555 first-source as sequence one without duplicating it', () => {
    const value = fixture();
    const read = readAgentOsEpochSourceStoreV1(value.dependencies);
    expect(read).toMatchObject({
      sourceState: 'healthy', complete: true, currentness: 'current',
      current: { epochSequence: 1, bundleDigest: value.first.bundleDigest, kind: 'first-source' },
      renewals: [], filesRead: 0, closureAuthenticated: true,
    });
    expect(existsSync(join(value.sourcesPath, 'records'))).toBe(false);
    expectNoAuthority(read as unknown as Record<string, unknown>);
  });

  it('derives sequence and predecessor from the complete ledger and immediately advances with a fixed provider', () => {
    const value = fixture();
    const first = value.append();
    expect(first).toMatchObject({
      disposition: 'recorded', reason: 'recorded', durable: true,
      renewal: {
        epochSequence: 2,
        previousBundleDigest: value.first.bundleDigest,
        epochHeadDigest: prefixed('epoch-head'),
        epochManifestDigest: prefixed('epoch-manifest'),
      },
    });
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({
      complete: true,
      current: { epochSequence: 2, bundleDigest: first.renewal?.bundleDigest, kind: 'renewal' },
    });
    expect(value.append()).toMatchObject({
      disposition: 'replayed', reason: 'source-replay',
      renewal: { bundleDigest: first.renewal?.bundleDigest },
    });
    expect(existsSync(join(value.sourcesPath, 'records', '000000000002.json'))).toBe(true);
  });

  it('persists a complete multi-renewal chain and distinguishes expiry from integrity', () => {
    const value = fixture();
    const second = value.append();
    const third = value.append('2026-09-03T12:00:50.000Z', Buffer.from('{"attemptKey":"C"}'));
    expect(third).toMatchObject({
      disposition: 'recorded', renewal: {
        epochSequence: 3, previousBundleDigest: second.renewal?.bundleDigest,
      },
    });
    value.setContext({ ...value.getContext(), observedAt: '2026-09-03T12:10:00.000Z' });
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true, currentness: 'expired',
      current: { epochSequence: 3 }, renewals: { length: 2 },
    });
  });

  it('replays an exact durable renewal after expiry under a still-authenticated fixed epoch', () => {
    const value = fixture();
    const recorded = value.append();
    value.setContext({ ...value.getContext(), observedAt: '2026-09-03T12:10:00.000Z' });
    expect(value.append()).toMatchObject({
      disposition: 'replayed', reason: 'source-replay', durable: true,
      renewal: { bundleDigest: recorded.renewal?.bundleDigest },
    });
  });

  it.each([
    ['equal predecessor issue time', CREATED],
    ['far future', '2026-09-03T12:02:00.000Z'],
    ['after predecessor expiry', '2026-09-03T12:04:01.000Z'],
  ])('rejects %s without changing the healthy ledger', (_label, issuedAt) => {
    const value = fixture();
    expect(value.append(issuedAt)).toMatchObject({
      disposition: 'withheld', reason: 'invalid-input', durable: false,
    });
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({
      sourceState: 'healthy', complete: true, current: { epochSequence: 1 }, renewals: [],
    });
    expect(existsSync(join(value.sourcesPath, 'records', '000000000002.json'))).toBe(false);
  });

  it('guardedly heals a records-only layout and exposes conservative recovery', () => {
    const value = fixture();
    mkdirSync(join(value.sourcesPath, 'records'), { mode: 0o700 });
    expect(value.append()).toMatchObject({ disposition: 'recorded', durable: true });
    expect(existsSync(join(value.sourcesPath, 'staging'))).toBe(true);
    expect(recoverAgentOsEpochSourceStoreV1({
      coordinationLease: value.lease,
      observationLock: value.observationLock,
    }, value.dependencies)).toBe('clean');
  });

  it('fails nested same-root provider calls and the affected outer write without publication', () => {
    const value = fixture();
    const original = value.dependencies.activeContextProvider;
    let nested: ReturnType<typeof readAgentOsEpochSourceStoreV1> | null = null;
    let attempted = false;
    value.dependencies.activeContextProvider = {
      readAuthenticatedActiveEpochSourceContext() {
        if (!attempted) {
          attempted = true;
          nested = readAgentOsEpochSourceStoreV1(value.dependencies);
        }
        return original.readAuthenticatedActiveEpochSourceContext();
      },
    };
    expect(value.append()).toMatchObject({
      disposition: 'withheld', reason: 'reentrant-call', durable: false,
    });
    expect(nested).toMatchObject({ sourceState: 'degraded', stopReasons: ['reentrant-call'] });
    expect(existsSync(join(value.sourcesPath, 'records', '000000000002.json'))).toBe(false);
  });

  it('accepts alternating property insertion order but rejects one fixed identity mutation', () => {
    const value = fixture();
    const baseRead = value.dependencies.activeContextProvider.readAuthenticatedActiveEpochSourceContext();
    if (baseRead.state !== 'authenticated') throw new Error('missing context');
    const base = baseRead.context;
    let reads = 0;
    value.dependencies.activeContextProvider = {
      readAuthenticatedActiveEpochSourceContext: () => {
        reads += 1;
        const entries = Object.entries(base);
        if (reads % 2 === 0) entries.reverse();
        return { state: 'authenticated', context: Object.fromEntries(entries) as unknown as typeof base };
      },
    };
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({ complete: true });

    let mutationReads = 0;
    value.dependencies.activeContextProvider = {
      readAuthenticatedActiveEpochSourceContext: () => {
        mutationReads += 1;
        return {
          state: 'authenticated',
          context: mutationReads === 1
            ? { ...base }
            : { ...base, epochManifestDigest: prefixed('mutated-manifest') },
        };
      },
    };
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false,
    });
  });

  it('fails a write closed when fixed authenticated identity drifts at the publication fence', () => {
    const value = fixture();
    const original = value.dependencies.activeContextProvider;
    value.dependencies.activeContextProvider = {
      readAuthenticatedActiveEpochSourceContext() {
        const read = original.readAuthenticatedActiveEpochSourceContext();
        if (read.state !== 'authenticated' || value.providerReads() < 5) return read;
        return {
          state: 'authenticated',
          context: { ...read.context, epochManifestDigest: prefixed('drifted-manifest') },
        };
      },
    };
    expect(value.append()).toMatchObject({
      disposition: 'withheld', reason: 'active-context-changed', durable: false,
    });
    expect(existsSync(join(value.sourcesPath, 'records', '000000000002.json'))).toBe(false);
  });

  it('degrades on a tampered renewal and never falls back to a shorter authoritative prefix', () => {
    const value = fixture();
    value.append();
    const path = join(value.sourcesPath, 'records', '000000000002.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    parsed['issuedAt'] = '2026-09-03T12:00:46.000Z';
    writeFileSync(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expect(readAgentOsEpochSourceStoreV1(value.dependencies)).toMatchObject({
      sourceState: 'degraded', complete: false, current: null, renewals: [], invalidFiles: 1,
    });
  });

  it('requires both outer capabilities and enforces bounded capacity', () => {
    const missingLock = fixture();
    releaseAgentOsObservationLockV1(missingLock.observationLock);
    expect(missingLock.append()).toMatchObject({
      disposition: 'withheld', reason: 'observation-lock-missing',
    });
    const missingLease = fixture();
    releaseAgentOsEpochCoordinationLeaseV1(missingLease.lease);
    expect(missingLease.append()).toMatchObject({
      disposition: 'withheld', reason: 'coordination-lease-missing',
    });
    const bounded = fixture({ maxSources: 2 });
    bounded.append();
    expect(bounded.append('2026-09-03T12:00:50.000Z')).toMatchObject({
      disposition: 'withheld', reason: 'capacity-exhausted',
    });
  });

  it('rejects a signed renewal issued after its predecessor expired', () => {
    const value = fixture();
    mkdirSync(join(value.sourcesPath, 'records'), { mode: 0o700 });
    mkdirSync(join(value.sourcesPath, 'staging'), { mode: 0o700 });
    const poison = createAgentOsEpochSourceRenewalV1({
      epoch: 1,
      epochSequence: 2,
      epochHeadDigest: value.getContext().epochHeadDigest,
      epochManifestDigest: value.getContext().epochManifestDigest,
      attemptNamespaceDigest: value.getContext().attemptNamespaceDigest,
      previousBundleDigest: value.first.bundleDigest,
      trustPolicyDigest: value.first.trustPolicyDigest,
      policyGeneration: value.first.policyGeneration,
      sourceKeyId: value.first.sourceKeyId,
      sourcePrincipalDigest: value.first.sourcePrincipalDigest,
      evidencePrincipalDigest: prefixed('late-evidence'),
      outcomePrincipalDigests: [prefixed('late-outcome')],
      issuedAt: '2026-09-03T12:04:00.001Z',
      expiresAt: '2026-09-03T12:08:00.000Z',
      sourcePayloadBytes: Buffer.from('{"attemptKey":"B"}', 'utf8'),
    }, value.sourceSigner);
    if (!poison) throw new Error('could not create signed continuity poison');
    writeFileSync(
      join(value.sourcesPath, 'records', '000000000002.json'),
      Buffer.concat([Buffer.from(canonicalAgentOsEpochSourceRenewalBytesV1(poison)!), Buffer.from('\n')]),
      { mode: 0o600 },
    );
    const read = readAgentOsEpochSourceStoreV1(value.dependencies);
    expect(read).toMatchObject({ sourceState: 'degraded', complete: false, current: null });
    expect(read.stopReasons).toContain('source-continuity-gap');
  });

  it('resolves M557 historical key generation only from a complete authenticated source lineage', () => {
    const value = fixture();
    const renewal = value.append();
    const provider = createAgentOsEpochSourceHistoricalLineageProviderV1(value.dependencies);
    const resolved = provider.resolveAuthenticatedHistoricalSource({
      epoch: 1,
      epochHeadDigest: prefixed('epoch-head'),
      epochManifestDigest: prefixed('epoch-manifest'),
      attemptNamespaceDigest: prefixed('attempt-namespace'),
      sourceBundleDigest: renewal.renewal!.bundleDigest,
      trustPolicyDigest: renewal.renewal!.trustPolicyDigest,
      attemptAuthenticatorKeyId: value.attemptB.signer.keyId,
    });
    expect(resolved).toMatchObject({
      state: 'authenticated',
      lineage: { attemptAuthenticatorGeneration: 2 },
      verifier: { keyId: value.attemptB.verifier.keyId },
    });
    expect(Object.isFrozen(value.attemptB.signer)).toBe(false);
    expect(Object.isFrozen(value.attemptB.verifier)).toBe(false);
    expect(provider.resolveAuthenticatedHistoricalSource({
      epoch: 1,
      epochHeadDigest: prefixed('epoch-head'),
      epochManifestDigest: prefixed('epoch-manifest'),
      attemptNamespaceDigest: prefixed('attempt-namespace'),
      sourceBundleDigest: renewal.renewal!.bundleDigest,
      trustPolicyDigest: renewal.renewal!.trustPolicyDigest,
      attemptAuthenticatorKeyId: raw('attacker-selected-key'),
    })).toEqual({ state: 'degraded' });
  });

  it('resolves a sorted unique historical batch with one lineage scan and verifier-only owned results', () => {
    const value = fixture();
    const renewal = value.append().renewal!;
    const provider = createAgentOsEpochSourceHistoricalLineageProviderV1(value.dependencies);
    const lineages: AgentOsEpochAttemptHistoricalSourceLineageV1[] = [
      {
        epoch: 1,
        epochHeadDigest: prefixed('epoch-head'),
        epochManifestDigest: prefixed('epoch-manifest'),
        attemptNamespaceDigest: prefixed('attempt-namespace'),
        sourceBundleDigest: value.first.bundleDigest,
        trustPolicyDigest: value.first.trustPolicyDigest,
        attemptAuthenticatorKeyId: value.attemptA.signer.keyId,
      },
      {
        epoch: 1,
        epochHeadDigest: prefixed('epoch-head'),
        epochManifestDigest: prefixed('epoch-manifest'),
        attemptNamespaceDigest: prefixed('attempt-namespace'),
        sourceBundleDigest: renewal.bundleDigest,
        trustPolicyDigest: renewal.trustPolicyDigest,
        attemptAuthenticatorKeyId: value.attemptB.signer.keyId,
      },
    ].sort((left, right) => agentOsEpochAttemptHistoricalSourceLineageDigestV1(left)!
      .localeCompare(agentOsEpochAttemptHistoricalSourceLineageDigestV1(right)!));
    const lineageDigests = lineages.map((lineage) =>
      agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!);
    const inputSetDigest = agentOsEpochAttemptHistoricalSourceSetDigestV1(lineageDigests)!;
    const readsBefore = value.providerReads();
    const resolverReadsBefore = value.authenticatorResolverReads();
    const result = provider.resolveAuthenticatedHistoricalSources({
      protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
      inputSetDigest,
      lineages,
    });
    expect(result).toMatchObject({
      state: 'authenticated', inputSetDigest, resolutions: { length: 2 },
    });
    expect(value.providerReads() - readsBefore).toBe(2);
    expect(value.authenticatorResolverReads() - resolverReadsBefore).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.state !== 'authenticated') throw new Error('batch unexpectedly degraded');
    expect(Object.isFrozen(result.resolutions)).toBe(true);
    for (const decision of result.resolutions) {
      expect(decision.lineageDigest).toBe(lineageDigests[result.resolutions.indexOf(decision)]);
      expect(Object.isFrozen(decision)).toBe(true);
      expect('signer' in decision.resolution).toBe(false);
      expect(decision.resolution.state).toBe('authenticated');
    }

    const extra = Object.assign([...lineages], { extra: true });
    expect(provider.resolveAuthenticatedHistoricalSources({
      protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
      inputSetDigest,
      lineages: extra,
    })).toEqual({ state: 'degraded' });
    const accessor = [...lineages] as AgentOsEpochAttemptHistoricalSourceLineageV1[];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => {
      throw new Error('must not invoke accessor');
    } });
    expect(provider.resolveAuthenticatedHistoricalSources({
      protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
      inputSetDigest,
      lineages: accessor,
    })).toEqual({ state: 'degraded' });
    const proxy = new Proxy([...lineages], {
      getOwnPropertyDescriptor() { throw new Error('hostile proxy'); },
    });
    expect(provider.resolveAuthenticatedHistoricalSources({
      protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
      inputSetDigest,
      lineages: proxy,
    })).toEqual({ state: 'degraded' });
  });

  it('indexes a 512-source authenticated lineage once for one ordered batch', () => {
    const value = fixture({ maxSources: 512 });
    const recordsPath = join(value.sourcesPath, 'records');
    mkdirSync(recordsPath, { mode: 0o700 });
    mkdirSync(join(value.sourcesPath, 'staging'), { mode: 0o700 });
    const sources = [value.first];
    let previousBundleDigest = value.first.bundleDigest;
    const issuedBase = Date.parse('2026-09-03T12:00:30.000Z');
    for (let epochSequence = 2; epochSequence <= 512; epochSequence += 1) {
      const renewal = createAgentOsEpochSourceRenewalV1({
        epoch: 1,
        epochSequence,
        epochHeadDigest: value.getContext().epochHeadDigest,
        epochManifestDigest: value.getContext().epochManifestDigest,
        attemptNamespaceDigest: value.getContext().attemptNamespaceDigest,
        previousBundleDigest,
        trustPolicyDigest: value.first.trustPolicyDigest,
        policyGeneration: value.first.policyGeneration,
        sourceKeyId: value.first.sourceKeyId,
        sourcePrincipalDigest: value.first.sourcePrincipalDigest,
        evidencePrincipalDigest: prefixed(`scale-evidence-${epochSequence}`),
        outcomePrincipalDigests: [prefixed(`scale-outcome-${epochSequence}`)],
        issuedAt: new Date(issuedBase + epochSequence).toISOString(),
        expiresAt: '2026-09-03T12:04:00.000Z',
        sourcePayloadBytes: Buffer.from(`{"attemptKey":"B","sequence":${epochSequence}}`, 'utf8'),
      }, value.sourceSigner);
      if (!renewal) throw new Error(`could not create source ${epochSequence}`);
      sources.push(renewal);
      previousBundleDigest = renewal.bundleDigest;
      writeFileSync(
        join(recordsPath, `${String(epochSequence).padStart(12, '0')}.json`),
        Buffer.concat([Buffer.from(canonicalAgentOsEpochSourceRenewalBytesV1(renewal)!), Buffer.from('\n')]),
        { mode: 0o600 },
      );
    }
    const lineages = sources.map((source) => ({
      epoch: 1,
      epochHeadDigest: value.getContext().epochHeadDigest,
      epochManifestDigest: value.getContext().epochManifestDigest,
      attemptNamespaceDigest: value.getContext().attemptNamespaceDigest,
      sourceBundleDigest: source.bundleDigest,
      trustPolicyDigest: source.trustPolicyDigest,
      attemptAuthenticatorKeyId: source.epochSequence === 1
        ? value.attemptA.signer.keyId
        : value.attemptB.signer.keyId,
    })).sort((left, right) => agentOsEpochAttemptHistoricalSourceLineageDigestV1(left)!
      .localeCompare(agentOsEpochAttemptHistoricalSourceLineageDigestV1(right)!));
    const digests = lineages.map((lineage) =>
      agentOsEpochAttemptHistoricalSourceLineageDigestV1(lineage)!);
    const provider = createAgentOsEpochSourceHistoricalLineageProviderV1(value.dependencies);
    const readsBefore = value.providerReads();
    const firstVerificationsBefore = value.firstSourceVerifierReads();
    const renewalVerificationsBefore = value.renewalVerifierReads();
    const resolverReadsBefore = value.authenticatorResolverReads();
    const result = provider.resolveAuthenticatedHistoricalSources({
      protocol: AGENT_OS_EPOCH_HISTORICAL_SOURCE_BATCH_PROTOCOL_V1,
      inputSetDigest: agentOsEpochAttemptHistoricalSourceSetDigestV1(digests)!,
      lineages,
    });
    expect(result).toMatchObject({ state: 'authenticated', resolutions: { length: 512 } });
    expect(value.providerReads() - readsBefore).toBe(2);
    expect(value.firstSourceVerifierReads() - firstVerificationsBefore).toBe(1);
    expect(value.renewalVerifierReads() - renewalVerificationsBefore).toBe(511);
    expect(value.authenticatorResolverReads() - resolverReadsBefore).toBe(512);
    if (result.state !== 'authenticated') throw new Error('large lineage batch degraded');
    expect(result.resolutions.map((decision) => decision.lineageDigest)).toEqual(digests);
    expect(result.resolutions.every((decision) => !('signer' in decision.resolution))).toBe(true);
  }, 30_000);
});
