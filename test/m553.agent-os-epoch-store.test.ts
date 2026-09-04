import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1,
  isAgentOsEpochStorePlatformSupportedV1,
  prepareAgentOsEpochV1,
  readAgentOsActiveEpochArtifactsV1,
  readAgentOsActiveEpochPointerV1,
  readPreparedAgentOsEpochV1,
  installAgentOsActiveEpochPointerV1,
  type AgentOsEpochStoreCrashPointV1,
  type AgentOsEpochStoreDependenciesV1,
} from '../src/core/vision/agent-os-epoch-store.js';
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
  type AgentOsObservationEpochHeadV1,
  type AgentOsObservationEpochManifestUnsignedV1,
  type AgentOsObservationEpochManifestV1,
  type AgentOsPreparedEpochEvidenceV1,
} from '../src/core/vision/agent-os-rollover-protocol.js';
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

const roots: string[] = [];
const leases: AgentOsEpochCoordinationLeaseV1[] = [];
const locks: LocalStoreLock[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const rawDigest = (character: string): string => character.repeat(64);
const SOURCE = rawDigest('c');
const WRITER = digest('a');
const OPERATION = digest('9');
const SOURCE_BYTES = Buffer.from('{"opaque":"successor-source-v2-unverified"}', 'utf8');

afterEach(() => {
  for (const lock of locks.splice(0)) releaseAgentOsObservationLockV1(lock);
  for (const lease of leases.splice(0)) releaseAgentOsEpochCoordinationLeaseV1(lease);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(): AgentOsObservationEpochManifestV1 {
  const unsigned: AgentOsObservationEpochManifestUnsignedV1 = {
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
      bundleDigest: SOURCE,
      previousBundleDigest: AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
      trustPolicyDigest: rawDigest('b'),
      policyGeneration: 1,
    },
    snapshotBase: { nextSequence: 1, previousEnvelopeDigest: AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest },
    attemptNamespaceDigest: agentOsAttemptNamespaceDigestV1({
      epoch: 1,
      previousEpochHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
      previousAttemptSetDigest: AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
      firstSourceBundleDigest: SOURCE,
    })!,
    createdAt: '2026-09-03T12:00:00.000Z',
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  return {
    ...unsigned,
    manifestDigest: agentOsObservationEpochManifestDigestV1(unsigned)!,
    localAuthenticator: '4'.repeat(64),
  };
}

function head(value: AgentOsObservationEpochManifestV1): AgentOsObservationEpochHeadV1 {
  const unsigned: AgentOsObservationEpochHeadUnsignedV1 = {
    schemaVersion: 1,
    protocol: AGENT_OS_EPOCH_HEAD_PROTOCOL_V1,
    epoch: 1,
    protocolGeneration: 1,
    previousHeadDigest: AGENT_OS_EPOCH_GENESIS_V1.headDigest,
    epochManifestDigest: value.manifestDigest,
    firstSourceBundleDigest: SOURCE,
    closedSourceTipDigest: AGENT_OS_EPOCH_GENESIS_V1.sourceTipDigest,
    closedSnapshotTipDigest: AGENT_OS_EPOCH_GENESIS_V1.snapshotTipDigest,
    closedAttemptSetDigest: AGENT_OS_EPOCH_GENESIS_V1.attemptSetDigest,
    coherentBindingDigest: AGENT_OS_EPOCH_GENESIS_V1.coherentBindingDigest,
    writerProtocolDigest: WRITER,
    advancedAt: value.createdAt,
    ...AGENT_OS_ROLLOVER_AUTHORITY_V1,
  };
  return { ...unsigned, headDigest: agentOsObservationEpochHeadDigestV1(unsigned)! };
}

function setup(overrides: Partial<AgentOsEpochStoreDependenciesV1> = {}) {
  const anchorPath = mkdtempSync(join(tmpdir(), 'ashlr-m553-'));
  roots.push(anchorPath);
  chmodSync(anchorPath, 0o700);
  const value = manifest();
  const epochHead = head(value);
  const manifestBytes = canonicalAgentOsObservationEpochManifestBytesV1(value)!;
  const headBytes = canonicalAgentOsObservationEpochHeadBytesV1(epochHead)!;
  const evidence: AgentOsPreparedEpochEvidenceV1 = {
    epoch: 1,
    previousHeadDigest: epochHead.previousHeadDigest,
    manifestDigest: value.manifestDigest,
    firstSourceBundleDigest: value.firstSourceBundle.bundleDigest,
    snapshotBasePreviousEnvelopeDigest: value.snapshotBase.previousEnvelopeDigest,
    attemptNamespaceDigest: value.attemptNamespaceDigest,
    recoveryOperationId: OPERATION,
  };
  const leaseResult = acquireAgentOsEpochCoordinationLeaseV1({
    rootPath: join(anchorPath, 'agent-os-epochs'),
    writerProtocolDigest: WRITER,
  });
  if (leaseResult.state !== 'acquired') throw new Error('fixture could not acquire coordination lease');
  leases.push(leaseResult.lease);
  const observationLock = acquireAgentOsObservationLockV1(anchorPath);
  if (!observationLock) throw new Error('fixture could not acquire observation lock');
  locks.push(observationLock);
  const dependencies: AgentOsEpochStoreDependenciesV1 = {
    anchorPath,
    rootPath: join(anchorPath, 'agent-os-epochs'),
    manifestAuthenticatorVerifier: (_bytes, candidate) => candidate.localAuthenticator === '4'.repeat(64),
    preparedEpochEvidenceVerifier: (candidate) => candidate.recoveryOperationId === OPERATION,
    firstSourceBundleVerifier: (bytes, expected) =>
      Buffer.from(bytes).equals(SOURCE_BYTES) && expected === SOURCE,
    writerProtocolDigest: WRITER,
    readAnchorHead: () => ({ state: 'present', canonicalHeadBytes: Buffer.from(headBytes) }),
    ...overrides,
  };
  return {
    anchorPath,
    dependencies,
    manifestBytes,
    headBytes,
    evidence,
    input: {
      canonicalManifestBytes: manifestBytes,
      canonicalHeadBytes: headBytes,
      canonicalFirstSourceBundleBytes: SOURCE_BYTES,
      preparedEvidence: evidence,
      coordinationLease: leaseResult.lease,
      observationLock,
    },
  };
}

function expectNoAuthority(result: Record<string, unknown>): void {
  expect(result).toMatchObject({
    authority: 'observation-only',
    anchorVerified: false,
    sourceCompatibility: 'unverified',
    writesAuthorized: false,
    pointerMutationAuthorized: false,
    rollbackProtected: false,
    planningAuthority: false,
    executionAuthority: false,
    effectAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    externalMutationAuthority: false,
  });
}

describe('M553 Agent OS durable local epoch store', () => {
  it('fails closed on Windows until directory-entry power-loss durability is implemented', () => {
    expect(isAgentOsEpochStorePlatformSupportedV1('win32')).toBe(false);
    expect(isAgentOsEpochStorePlatformSupportedV1('darwin')).toBe(true);
    expect(isAgentOsEpochStorePlatformSupportedV1('linux')).toBe(true);
    const source = readFileSync(
      new URL('../src/core/vision/agent-os-epoch-store.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('isAgentOsEpochStorePlatformSupportedV1(process.platform)');
    expect(source).not.toContain('platform?: NodeJS.Platform');
  });

  it('is missing without creating default state', () => {
    const value = setup();
    const prepared = readPreparedAgentOsEpochV1(value.dependencies, 1);
    const pointer = readAgentOsActiveEpochPointerV1(value.dependencies);
    expect(prepared).toMatchObject({ state: 'missing', phase: 'none', preparedDurable: false });
    expect(pointer).toMatchObject({ state: 'missing', phase: 'none', pointerInstalled: false });
    expect(existsSync(value.dependencies.rootPath)).toBe(false);
    expectNoAuthority(prepared as unknown as Record<string, unknown>);
    expectNoAuthority(pointer as unknown as Record<string, unknown>);
  });

  it('durably prepares, rereads, and idempotently replays exact canonical artifacts', () => {
    const value = setup();
    const written = prepareAgentOsEpochV1(value.input, value.dependencies);
    const read = readPreparedAgentOsEpochV1(value.dependencies, 1);
    const replaySteps: AgentOsEpochStoreCrashPointV1[] = [];
    const replay = prepareAgentOsEpochV1(value.input, {
      ...value.dependencies,
      afterDurableStep: (step) => replaySteps.push(step),
    });
    expect(written).toMatchObject({ state: 'accepted', reason: 'prepared', preparedDurable: true });
    expect(read).toMatchObject({ state: 'accepted', phase: 'cas-pending', operationId: OPERATION });
    expect(read.canonicalManifestBytes).toEqual(value.manifestBytes);
    expect(read.canonicalHeadBytes).toEqual(value.headBytes);
    expect(read.canonicalFirstSourceBundleBytes).toEqual(SOURCE_BYTES);
    expect(replay).toMatchObject({ state: 'accepted', reason: 'replayed' });
    expect(replaySteps).toContain('prepared-epoch-replay-durable');
    const epochPath = join(value.dependencies.rootPath, 'epochs', 'epoch-000000000001');
    expect(readdirSync(epochPath).sort()).toEqual([
      'attempts', 'first-source.json', 'head.json', 'manifest.json',
      'prepared-evidence.json', 'recovery-marker.json', 'snapshots', 'sources',
    ]);
    if (process.platform !== 'win32') {
      expect(Number(lstatSync(epochPath).mode & 0o777)).toBe(0o700);
      expect(Number(lstatSync(join(epochPath, 'manifest.json')).mode & 0o777)).toBe(0o600);
    }
    expectNoAuthority(written as unknown as Record<string, unknown>);
  });

  it('returns owned copies and frozen evidence', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const first = readPreparedAgentOsEpochV1(value.dependencies, 1);
    first.canonicalHeadBytes![0] ^= 1;
    const second = readPreparedAgentOsEpochV1(value.dependencies, 1);
    expect(second.canonicalHeadBytes).toEqual(value.headBytes);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.preparedEvidence)).toBe(true);
  });

  it('requires exact canonical inputs and all three injected verifiers', () => {
    const malformed = setup();
    expect(prepareAgentOsEpochV1({ ...malformed.input, canonicalHeadBytes: Buffer.concat([
      malformed.headBytes, Buffer.from('\n'),
    ]) }, malformed.dependencies).state).toBe('withheld');
    for (const override of [
      { manifestAuthenticatorVerifier: () => false },
      { preparedEpochEvidenceVerifier: () => false },
      { firstSourceBundleVerifier: () => false },
    ]) {
      const value = setup(override);
      expect(prepareAgentOsEpochV1(value.input, value.dependencies).state).toBe('withheld');
      expect(existsSync(value.dependencies.rootPath)).toBe(false);
    }
  });

  it('never reports an incomplete staging tree as prepared at any prepublication crash point', () => {
    const points: AgentOsEpochStoreCrashPointV1[] = [
      'root-durable', 'epochs-directory-durable', 'staging-directory-durable', 'manifest-durable',
      'head-durable', 'first-source-durable', 'sources-directory-durable', 'snapshots-directory-durable',
      'attempts-directory-durable', 'prepared-evidence-durable', 'recovery-marker-durable',
    ];
    for (const point of points) {
      const base = setup();
      const dependencies = {
        ...base.dependencies,
        afterDurableStep(step: AgentOsEpochStoreCrashPointV1) {
          if (step === point) throw new Error('simulated crash');
        },
      };
      expect(prepareAgentOsEpochV1(base.input, dependencies).state).toBe('degraded');
      expect(readPreparedAgentOsEpochV1(base.dependencies, 1).state).not.toBe('accepted');
    }
  });

  it('accepts exact durable preparation after the publication crash point', () => {
    const base = setup();
    const dependencies = {
      ...base.dependencies,
      afterDurableStep(step: AgentOsEpochStoreCrashPointV1) {
        if (step === 'prepared-epoch-published') throw new Error('simulated crash');
      },
    };
    expect(prepareAgentOsEpochV1(base.input, dependencies).state).toBe('degraded');
    expect(readPreparedAgentOsEpochV1(base.dependencies, 1)).toMatchObject({
      state: 'accepted', preparedDurable: true, phase: 'cas-pending',
    });
  });

  it('leaves partial preparation fail-closed for explicit future recovery or cleanup', () => {
    const value = setup();
    expect(prepareAgentOsEpochV1(value.input, {
      ...value.dependencies,
      afterDurableStep(step) { if (step === 'manifest-durable') throw new Error('simulated crash'); },
    }).state).toBe('degraded');
    expect(prepareAgentOsEpochV1(value.input, value.dependencies)).toMatchObject({
      state: 'degraded',
      reason: 'incomplete-preparation',
      preparedDurable: false,
    });
    expect(readPreparedAgentOsEpochV1(value.dependencies, 1)).toMatchObject({
      state: 'degraded',
      reason: 'incomplete-preparation',
      phase: 'none',
    });
  });

  it('installs the local pointer only under a verified held lock and exact in-lock anchor reread', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const installed = installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, value.dependencies);
    expect(installed).toMatchObject({
      state: 'accepted', reason: 'pointer-installed', pointerInstalled: true,
      anchorHeadMatched: true, anchorVerified: false,
    });
    const read = readAgentOsActiveEpochPointerV1(value.dependencies);
    expect(read).toMatchObject({
      state: 'accepted', phase: 'pointer-installed', manifestDigest: value.evidence.manifestDigest,
      anchorHeadMatched: false,
    });
    expect(read.canonicalHeadBytes).toEqual(value.headBytes);
    expect(JSON.parse(readFileSync(join(value.dependencies.rootPath, 'active-pointer.json'), 'utf8')))
      .toMatchObject({ protocol: AGENT_OS_ACTIVE_POINTER_PROTOCOL_V1, operationId: OPERATION });
    const replaySteps: AgentOsEpochStoreCrashPointV1[] = [];
    expect(installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, {
      ...value.dependencies,
      afterDurableStep: (step) => replaySteps.push(step),
    }).reason).toBe('pointer-replayed');
    expect(replaySteps).toContain('pointer-replay-durable');
  });

  it('keeps active core artifacts readable after the exact attempt-ledger layout is initialized', () => {
    const value = setup();
    expect(prepareAgentOsEpochV1(value.input, value.dependencies).state).toBe('accepted');
    expect(installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, value.dependencies).state).toBe('accepted');
    const epochPath = join(value.dependencies.rootPath, 'epochs', 'epoch-000000000001');
    const attemptsPath = join(epochPath, 'attempts');
    mkdirSync(join(attemptsPath, 'records'), { mode: 0o700 });
    mkdirSync(join(attemptsPath, 'staging'), { mode: 0o700 });

    expect(readPreparedAgentOsEpochV1(value.dependencies, 1)).toMatchObject({
      state: 'degraded', reason: 'unsafe-storage', phase: 'none',
    });
    expect(readAgentOsActiveEpochPointerV1(value.dependencies)).toMatchObject({
      state: 'accepted', phase: 'pointer-installed', epoch: 1,
    });
    const active = readAgentOsActiveEpochArtifactsV1(value.dependencies);
    expect(active).toMatchObject({
      state: 'accepted', phase: 'active', epoch: 1,
      manifestDigest: value.evidence.manifestDigest,
      attemptNamespaceDigest: value.evidence.attemptNamespaceDigest,
      snapshotBasePreviousEnvelopeDigest: value.evidence.snapshotBasePreviousEnvelopeDigest,
    });
    expect(active.canonicalManifestBytes).toEqual(value.manifestBytes);
    expect(active.canonicalHeadBytes).toEqual(value.headBytes);
    expect(active.canonicalFirstSourceBundleBytes).toEqual(SOURCE_BYTES);
    expectNoAuthority(active as unknown as Record<string, unknown>);

    expect(installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, value.dependencies)).toMatchObject({
      state: 'accepted', reason: 'pointer-replayed', pointerInstalled: true,
      anchorHeadMatched: true,
    });

    writeFileSync(join(attemptsPath, 'unexpected'), 'x', { mode: 0o600 });
    expect(readAgentOsActiveEpochPointerV1(value.dependencies)).toMatchObject({
      state: 'degraded', reason: 'artifact-conflict', phase: 'none',
    });
  });

  it.each([
    ['attempts', 'records'],
    ['attempts', 'staging'],
    ['snapshots', 'records'],
    ['snapshots', 'staging'],
    ['sources', 'records'],
    ['sources', 'staging'],
  ] as const)('keeps active core readable through a partial %s/%s initialization crash', (ledger, child) => {
    const value = setup();
    expect(prepareAgentOsEpochV1(value.input, value.dependencies).state).toBe('accepted');
    expect(installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, value.dependencies).state).toBe('accepted');
    const epochPath = join(value.dependencies.rootPath, 'epochs', 'epoch-000000000001');
    mkdirSync(join(epochPath, ledger, child), { mode: 0o700 });
    if (child === 'staging') {
      writeFileSync(join(epochPath, ledger, child, '.known-partial.stage'), '{}\n', { mode: 0o600 });
    }
    expect(readAgentOsActiveEpochPointerV1(value.dependencies)).toMatchObject({
      state: 'accepted', phase: 'pointer-installed', epoch: 1,
    });
    expect(readAgentOsActiveEpochArtifactsV1(value.dependencies)).toMatchObject({
      state: 'accepted', phase: 'active', epoch: 1,
    });
  });

  it('never accepts a replayed local pointer without a fresh exact anchor reread', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const pointerInput = {
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    } as const;
    expect(installAgentOsActiveEpochPointerV1(pointerInput, value.dependencies).state).toBe('accepted');

    const rereadStates = [
      { state: 'missing' as const },
      { state: 'unavailable' as const },
      { state: 'degraded' as const },
      { state: 'present' as const, canonicalHeadBytes: Buffer.from('{}') },
    ];
    for (const anchorRead of rereadStates) {
      const replay = installAgentOsActiveEpochPointerV1(pointerInput, {
        ...value.dependencies,
        readAnchorHead: () => anchorRead,
      });
      expect(replay).toMatchObject({
        state: 'degraded',
        reason: 'pointer-conflict',
        pointerInstalled: true,
        anchorHeadMatched: false,
      });
    }
  });

  it('rejects preparation and pointer installation after either required lock is released', () => {
    const value = setup();
    expect(releaseAgentOsObservationLockV1(value.input.observationLock)).toBe(true);
    expect(prepareAgentOsEpochV1(value.input, value.dependencies).state).toBe('withheld');
    const replacementLock = acquireAgentOsObservationLockV1(value.anchorPath);
    if (!replacementLock) throw new Error('fixture could not reacquire observation lock');
    locks.push(replacementLock);
    const lockedInput = { ...value.input, observationLock: replacementLock };
    expect(prepareAgentOsEpochV1(lockedInput, value.dependencies).state).toBe('accepted');
    expect(releaseAgentOsEpochCoordinationLeaseV1(value.input.coordinationLease)).toBe(true);
    expect(installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: replacementLock,
    }, value.dependencies).state).toBe('withheld');
  });

  it('rechecks both lock capabilities immediately before publishing the prepared epoch', () => {
    const value = setup();
    const result = prepareAgentOsEpochV1(value.input, {
      ...value.dependencies,
      afterDurableStep(step) {
        if (step === 'recovery-marker-durable') {
          releaseAgentOsEpochCoordinationLeaseV1(value.input.coordinationLease);
        }
      },
    });
    expect(result).toMatchObject({ state: 'degraded', reason: 'incomplete-preparation' });
    expect(readPreparedAgentOsEpochV1(value.dependencies, 1).state).not.toBe('accepted');
  });

  it.each([
    ['missing anchor', { readAnchorHead: () => ({ state: 'missing' as const }) }],
    ['unavailable anchor', { readAnchorHead: () => ({ state: 'unavailable' as const }) }],
    ['wrong anchor', { readAnchorHead: () => ({ state: 'present' as const, canonicalHeadBytes: Buffer.from('{}') }) }],
  ])('refuses pointer installation for %s', (_label, override) => {
    const value = setup(override);
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const result = installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, value.dependencies);
    expect(result.state).not.toBe('accepted');
    expect(readAgentOsActiveEpochPointerV1(value.dependencies).state).toBe('missing');
    expectNoAuthority(result as unknown as Record<string, unknown>);
  });

  it('refuses pointer installation when the lease is lost during the anchor reread', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const result = installAgentOsActiveEpochPointerV1({
      canonicalHeadBytes: value.headBytes,
      operationId: OPERATION,
      expectedPreviousHeadDigest: null,
      coordinationLease: value.input.coordinationLease,
      observationLock: value.input.observationLock,
    }, {
      ...value.dependencies,
      readAnchorHead: () => {
        releaseAgentOsEpochCoordinationLeaseV1(value.input.coordinationLease);
        return { state: 'present', canonicalHeadBytes: value.headBytes };
      },
    });
    expect(result).toMatchObject({ state: 'degraded', pointerInstalled: false, anchorHeadMatched: false });
    expect(readAgentOsActiveEpochPointerV1(value.dependencies).state).toBe('missing');
  });

  it('fails closed on pointer crash points', () => {
    for (const point of ['pointer-temporary-durable', 'pointer-renamed', 'pointer-directory-durable'] as const) {
      const base = setup();
      prepareAgentOsEpochV1(base.input, base.dependencies);
      const result = installAgentOsActiveEpochPointerV1({
        canonicalHeadBytes: base.headBytes,
        operationId: OPERATION,
        expectedPreviousHeadDigest: null,
        coordinationLease: base.input.coordinationLease,
        observationLock: base.input.observationLock,
      }, {
        ...base.dependencies,
        afterDurableStep(step) { if (step === point) throw new Error('simulated crash'); },
      });
      expect(result.state).toBe('degraded');
      expect(result.pointerInstalled).toBe(false);
      const read = readAgentOsActiveEpochPointerV1(base.dependencies);
      if (point === 'pointer-temporary-durable') expect(read.state).toBe('missing');
      else expect(read.state).toBe('accepted');
    }
  });

  it('withholds a second byte-distinct preparation for the same epoch', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const conflicted = prepareAgentOsEpochV1({
      ...value.input,
      canonicalFirstSourceBundleBytes: Buffer.from('{"opaque":"different-but-verifier-must-reject"}'),
    }, { ...value.dependencies, firstSourceBundleVerifier: () => true });
    expect(conflicted).toMatchObject({ state: 'degraded', reason: 'artifact-conflict' });
  });

  it('fails closed on corruption and unexpected epoch entries', () => {
    const value = setup();
    prepareAgentOsEpochV1(value.input, value.dependencies);
    const epochPath = join(value.dependencies.rootPath, 'epochs', 'epoch-000000000001');
    writeFileSync(join(epochPath, 'head.json'), '{}', { mode: 0o600 });
    expect(readPreparedAgentOsEpochV1(value.dependencies, 1).state).toBe('degraded');
    writeFileSync(join(epochPath, 'unexpected'), 'x', { mode: 0o600 });
    expect(readPreparedAgentOsEpochV1(value.dependencies, 1).reason).toBe('unsafe-storage');
  });

  it('rejects symlinked and hard-linked artifact aliases', () => {
    const symlinked = setup();
    mkdirSync(symlinked.dependencies.rootPath, { mode: 0o700 });
    symlinkSync(symlinked.anchorPath, join(symlinked.dependencies.rootPath, 'epochs'));
    expect(readPreparedAgentOsEpochV1(symlinked.dependencies, 1).reason).toBe('unsafe-storage');

    const linked = setup();
    prepareAgentOsEpochV1(linked.input, linked.dependencies);
    const epochPath = join(linked.dependencies.rootPath, 'epochs', 'epoch-000000000001');
    linkSync(join(epochPath, 'manifest.json'), join(linked.anchorPath, 'manifest-alias'));
    expect(readPreparedAgentOsEpochV1(linked.dependencies, 1).state).toBe('degraded');
  });

  it('rejects permissive storage and non-exact root paths', () => {
    const permissive = setup();
    mkdirSync(permissive.dependencies.rootPath, { mode: 0o755 });
    chmodSync(permissive.dependencies.rootPath, 0o755);
    expect(readPreparedAgentOsEpochV1(permissive.dependencies, 1).reason).toBe('unsafe-storage');

    const invalid = setup();
    expect(prepareAgentOsEpochV1(invalid.input, {
      ...invalid.dependencies,
      rootPath: join(invalid.anchorPath, 'different-name'),
    }).state).toBe('withheld');
  });
});
