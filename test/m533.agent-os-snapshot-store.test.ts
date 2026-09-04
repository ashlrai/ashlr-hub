import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCapabilitySpectrumShadowV1,
  digestCapabilityClassV1,
} from '../src/core/fabric/capability-spectrum.js';
import type { ExecutionIdentityShadowStatusV1 } from '../src/core/fabric/execution-identity.js';
import {
  buildAgentNativeKernelShadowV1,
  type AgentNativeKernelEvidenceVerifierV1,
} from '../src/core/vision/agent-native-kernel.js';
import {
  appendAgentOsSnapshotV1,
  inspectAgentOsSnapshotEnvelopeV1,
  readAgentOsSnapshotsV1,
  type AgentOsSnapshotAppendInputV1,
  type AgentOsSnapshotEnvelopeV1,
  type AgentOsSnapshotSignerV1,
  type AgentOsSnapshotStoreDependenciesV1,
  type AgentOsSnapshotVerifierV1,
} from '../src/core/vision/agent-os-snapshot-store.js';
import {
  buildAgentOsReadModelV1,
  type AgentOsReadModelInputV1,
  type AgentOsReadModelV1,
  type AgentOsReadModelVerifierV1,
} from '../src/core/vision/agent-os-read-model.js';
import {
  acceptanceContractDigestV1,
  buildPortfolioShadowV1,
  createValueHypothesisV1,
  digestResourceEnvelopeV1,
  type PortfolioShadowV1,
  type ResourceEnvelopeV1,
  type ValueHypothesisV1,
} from '../src/core/vision/value-portfolio.js';

function digest(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function checkpointTipText(
  envelope: AgentOsSnapshotEnvelopeV1,
  signer: AgentOsSnapshotSignerV1,
): string {
  const unsigned = {
    schemaVersion: 1,
    protocol: 'agent-os-snapshot-tip-v1',
    sequence: envelope.sequence,
    envelopeDigest: envelope.envelopeDigest,
    producerIdentityDigest: envelope.producerIdentityDigest,
    keyId: envelope.keyId,
  };
  const checkpointDigest = createHash('sha256')
    .update('ashlr:agent-os-snapshot:tip:v1', 'utf8')
    .update('\0')
    .update(canonicalJson(unsigned), 'utf8')
    .digest('hex');
  const authenticator = signer.sign(checkpointDigest);
  if (!authenticator) throw new Error('test signer unavailable');
  return `${JSON.stringify({ ...unsigned, checkpointDigest, authenticator })}\n`;
}

function authenticator(secret = 'agent-os-snapshot-test-key'): {
  signer: AgentOsSnapshotSignerV1;
  verifier: AgentOsSnapshotVerifierV1;
} {
  const producerIdentityDigest = digest(`${secret}:producer`);
  const keyId = digest(`${secret}:key`);
  const sign = (value: string): string => createHmac('sha256', secret).update(value).digest('hex');
  return {
    signer: { producerIdentityDigest, keyId, sign },
    verifier: {
      verify: (input) => input.producerIdentityDigest === producerIdentityDigest &&
        input.keyId === keyId && input.authenticator === sign(input.envelopeDigest),
    },
  };
}

const receiptDigest = (label: string): `sha256:${string}` => `sha256:${digest(label)}`;
const AS_OF = '2026-09-03T12:00:00.000Z';
const SPEC = receiptDigest('spec');
const MISSION = receiptDigest('mission');
const IDENTITY = receiptDigest('identity');
const EVIDENCE_INDEX_DIGEST = receiptDigest('evidence');

const EVIDENCE_INDEX_VERIFIER: AgentNativeKernelEvidenceVerifierV1 = {
  verifyEvidenceIndex: (evidence) => ({
    authenticated: evidence.evidenceDigest === EVIDENCE_INDEX_DIGEST,
  }),
};

const READ_MODEL_VERIFIER: AgentOsReadModelVerifierV1 = {
  outcomeEvidenceVerifier: {
    verifyOutcomeEvidence: ({ evidence, producerDigest }) => ({
      authenticated: evidence.receiptDigest.startsWith('sha256:'),
      independentObserver: evidence.observerDigest !== producerDigest,
    }),
  },
  verifySourceBundle: (source) => ({
    sourceBundleAuthenticated: source.hypothesisDigests.length === 1 &&
      source.outcomeReceiptDigests.length === 0,
    evidenceIndexAuthenticated: source.evidenceIndexDigest === EVIDENCE_INDEX_DIGEST,
  }),
};

function hypothesis(node: string): ValueHypothesisV1 {
  const baselineDigest = receiptDigest(`baseline-${node}`);
  const acceptance = {
    baselineDigest,
    metric: 'retained-builder-value',
    unit: 'index-points',
    direction: 'increase' as const,
    effectiveThreshold: 20,
    refutationThreshold: 5,
    windowStart: '2026-09-01T12:00:00.000Z',
    windowEnd: '2026-09-05T12:00:00.000Z',
    minimumCausalGrade: 'quasi-experimental' as const,
  };
  const acceptanceContractDigest = acceptanceContractDigestV1(acceptance)!;
  return createValueHypothesisV1({
    schemaVersion: 1,
    provenanceDigest: receiptDigest(`provenance-${node}`),
    specDigest: SPEC,
    missionDigest: MISSION,
    missionNodeKey: node,
    producerDigest: receiptDigest(`producer-${node}`),
    claim: `Improve retained builder value through ${node}.`,
    constraints: {
      dependenciesSatisfied: true,
      humanGateRequired: false,
      reversible: true,
      allowedProviders: ['codex'],
      shardable: false,
      shardPlanDigest: null,
    },
    frozenOutcome: { acceptanceContractDigest, ...acceptance },
    budget: {
      maxTokens: 100_000,
      maxMinutes: 240,
      maxAttempts: 4,
      maxInconclusiveWindows: 2,
      spentTokens: 0,
      spentMinutes: 0,
      attempts: 0,
      inconclusiveWindows: 0,
      deadline: '2026-09-10T12:00:00.000Z',
      minimumMarginalValue: 0.05,
    },
    factors: {
      productImpact: 0.9,
      informationGain: 0.8,
      strategicLeverage: 0.9,
      ipLeverage: 0.8,
      dependencyUnlock: 0.7,
      probability: 0.8,
      risk: 0.2,
      uncertainty: 0.3,
      estimatedTokens: 10_000,
      estimatedMinutes: 20,
      factorSourceDigest: receiptDigest(`factors-${node}`),
    },
    outcomeSource: { complete: true, sourceDigest: receiptDigest(`outcome-${node}`), evidence: null },
  })!;
}

function resourceEnvelope(): ResourceEnvelopeV1 {
  return {
    schemaVersion: 1,
    sourceComplete: true,
    sourceDigest: receiptDigest('resource-source'),
    reserveFraction: 0.1,
    capacity: [{
      executionIdentityDigest: IDENTITY,
      provider: 'codex',
      state: 'open',
      trustedTokens: 500_000,
      trustedMinutes: 500,
      resetAt: '2026-09-03T14:00:00.000Z',
    }],
  };
}

function identity(): ExecutionIdentityShadowStatusV1 {
  return {
    schemaVersion: 1,
    authority: 'shadow-only',
    enabled: true,
    shadowOnly: true,
    sourceState: 'healthy',
    stopReasons: [],
    configuredIdentityCount: 1,
    identities: [{
      executionIdentityDigest: IDENTITY,
      engine: 'codex',
      state: 'open',
      trustedSlots: 2,
      maxConcurrent: 2,
      usedPercent: 20,
      observedAt: AS_OF,
      reason: 'observed-open',
    }],
    assignments: [],
    unassigned: [],
    executionAuthority: false,
    proposalAuthority: false,
    routingMutation: false,
  };
}

function readModelInput(label = 'one'): AgentOsReadModelInputV1 {
  const hypotheses = [hypothesis(`bet-${label}`)];
  const portfolioResult = buildPortfolioShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    resourceEnvelope: resourceEnvelope(),
    hypotheses,
  });
  if (!portfolioResult.ok) throw new Error(portfolioResult.issues.join(','));
  const portfolio: PortfolioShadowV1 = portfolioResult.portfolio;
  const kernelResult = buildAgentNativeKernelShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    specDigest: SPEC,
    missionDigest: MISSION,
    executionIdentity: identity(),
    resourceEnvelope: resourceEnvelope(),
    portfolio,
    evidence: {
      format: 'evidence-index-v1',
      sourceComplete: true,
      evidenceDigest: EVIDENCE_INDEX_DIGEST,
      resourceDigest: portfolio.basis.resourceEnvelopeDigest,
      portfolioDigest: portfolio.portfolioDigest,
      observedAt: AS_OF,
    },
    checkpoint: { sequence: 0, previousCycle: null, nextWakeAt: '2026-09-03T12:05:00.000Z' },
  }, EVIDENCE_INDEX_VERIFIER);
  if (!kernelResult.ok) throw new Error(kernelResult.issues.join(','));
  const envelopeDigest = digestResourceEnvelopeV1(resourceEnvelope())!;
  const spectrumResult = buildCapabilitySpectrumShadowV1({
    schemaVersion: 1,
    asOf: AS_OF,
    sourceDigest: receiptDigest('capability-source'),
    resourceEnvelopeDigest: envelopeDigest,
    executionIdentitySourceState: 'healthy',
    executionIdentityResources: [{ resource: identity().identities[0]! }],
    resetWindows: [{ executionIdentityDigest: IDENTITY, resetAt: '2026-09-03T14:00:00.000Z' }],
    localResources: [],
    lanes: [{
      laneDigest: receiptDigest('lane'),
      queueRank: 1,
      sourceComplete: true,
      requirements: [{ kind: 'model', classDigest: digestCapabilityClassV1('model', 'codex')!, units: 1 }],
    }],
  });
  if (!spectrumResult.ok) throw new Error(spectrumResult.issues.join(','));
  const kernel = kernelResult.kernel;
  const spectrum = spectrumResult.spectrum;
  return {
    schemaVersion: 1,
    renderedAt: '2026-09-03T12:01:00.000Z',
    kernel,
    capabilitySpectrum: spectrum,
    portfolio,
    hypotheses,
  };
}

function input(label = 'one'): AgentOsSnapshotAppendInputV1 {
  return {
    readModelInput: readModelInput(label),
    producerAttemptId: `00000000-0000-4000-8000-${digest(`attempt:${label}`).slice(0, 12)}`,
  };
}

describe('M533 authenticated Agent OS snapshot store', () => {
  let temporary = '';
  let anchorPath = '';
  let rootPath = '';
  let now = new Date('2026-09-03T12:00:00.000Z');
  let dependencies: AgentOsSnapshotStoreDependenciesV1;

  beforeEach(() => {
    now = new Date('2026-09-03T12:00:00.000Z');
    temporary = mkdtempSync(join(tmpdir(), 'ashlr-agent-os-snapshot-'));
    anchorPath = join(temporary, 'private-anchor');
    rootPath = join(anchorPath, 'agent-os-snapshots-v1');
    mkdirSync(anchorPath, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(anchorPath, 0o700);
    const auth = authenticator();
    dependencies = {
      anchorPath,
      rootPath,
      signer: auth.signer,
      verifier: auth.verifier,
      readModelVerifier: { bundleDigest: digest('authenticated-source-bundle'), verifier: READ_MODEL_VERIFIER },
      clock: () => now,
    };
  });

  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  it('appends canonical authenticated envelopes and preserves a strict chain', () => {
    const firstInput = input('one');
    const built = buildAgentOsReadModelV1(firstInput.readModelInput, READ_MODEL_VERIFIER);
    if (!built.ok) throw new Error(built.issues.join(','));
    const first = appendAgentOsSnapshotV1(firstInput, dependencies);
    expect(first).toMatchObject({
      disposition: 'recorded',
      reason: 'recorded',
      authority: 'observation-only',
      rollbackProtected: false,
      historicalAuthority: false,
      executionAuthority: false,
      deployAuthority: false,
      externalMutationAuthority: false,
    });
    expect(first.envelope).toMatchObject({
      sequence: 1,
      previousEnvelopeDigest: '0'.repeat(64),
      payload: { snapshotDigest: built.snapshotDigest, snapshot: built.snapshot },
      sourceDigest: digest('authenticated-source-bundle'),
      producerAttemptId: firstInput.producerAttemptId,
      kernelCycleDigest: firstInput.readModelInput.kernel.cycleDigest,
      capabilityProjectionDigest: firstInput.readModelInput.capabilitySpectrum.projectionDigest,
      portfolioDigest: firstInput.readModelInput.portfolio.portfolioDigest,
      rollbackProtected: false,
      historicalAuthority: false,
    });

    now = new Date('2026-09-03T12:00:01.000Z');
    const second = appendAgentOsSnapshotV1(input('two'), dependencies);
    expect(second.disposition).toBe('recorded');
    expect(second.envelope?.sequence).toBe(2);
    expect(second.envelope?.previousEnvelopeDigest).toBe(first.envelope?.envelopeDigest);

    const read = readAgentOsSnapshotsV1(dependencies);
    expect(read).toMatchObject({
      sourceState: 'healthy',
      availability: 'available',
      complete: true,
      rollbackProtected: false,
      historicalAuthority: false,
      executionAuthority: false,
    });
    expect(read.envelopes.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(read.current?.envelopeDigest).toBe(second.envelope?.envelopeDigest);
  });

  it.skipIf(process.platform === 'win32')('uses owner-private directories and files', () => {
    expect(appendAgentOsSnapshotV1(input(), dependencies).disposition).toBe('recorded');
    expect(statSync(rootPath).mode & 0o777).toBe(0o700);
    expect(statSync(join(rootPath, 'records', '000000000001.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(anchorPath, '.agent-os-snapshot-tip-v1.json')).mode & 0o777).toBe(0o600);
  });

  it('distinguishes public integrity from verifier-backed authenticity', () => {
    const result = appendAgentOsSnapshotV1(input(), dependencies);
    expect(result.envelope).not.toBeNull();
    expect(inspectAgentOsSnapshotEnvelopeV1(result.envelope, dependencies.verifier))
      .toMatchObject({ integrity: 'valid', authenticity: 'authenticated', issues: [] });
    expect(inspectAgentOsSnapshotEnvelopeV1(result.envelope, null))
      .toMatchObject({ integrity: 'valid', authenticity: 'unavailable', issues: ['authenticator-unavailable'] });
    expect(inspectAgentOsSnapshotEnvelopeV1(result.envelope, authenticator('wrong').verifier))
      .toMatchObject({ integrity: 'valid', authenticity: 'invalid', issues: ['authenticator-invalid'] });

    const tampered = structuredClone(result.envelope!);
    tampered.payload.snapshot.nextAction.reason = 'Altered after signing';
    expect(inspectAgentOsSnapshotEnvelopeV1(tampered, dependencies.verifier))
      .toMatchObject({ integrity: 'invalid', authenticity: 'invalid', issues: ['payload-integrity-failed'] });
  });

  it('detects replay and clock rollback without appending', () => {
    const first = appendAgentOsSnapshotV1(input(), dependencies);
    expect(appendAgentOsSnapshotV1(input(), dependencies)).toMatchObject({
      disposition: 'replayed',
      reason: 'snapshot-replay',
      current: { envelopeDigest: first.envelope?.envelopeDigest },
    });
    now = new Date('2026-09-03T11:59:59.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'rejected',
      reason: 'clock-rollback',
    });
    expect(readAgentOsSnapshotsV1(dependencies).envelopes).toHaveLength(1);
  });

  it('appends a new source-bound envelope when a later source has the same projection', () => {
    const firstInput = input('one');
    const first = appendAgentOsSnapshotV1(firstInput, dependencies);
    expect(first.disposition).toBe('recorded');

    now = new Date('2026-09-03T12:00:01.000Z');
    const secondInput = {
      ...firstInput,
      producerAttemptId: '10000000-0000-4000-8000-000000000001',
    };
    const second = appendAgentOsSnapshotV1(secondInput, {
      ...dependencies,
      readModelVerifier: {
        bundleDigest: digest('second-authenticated-source-bundle'),
        verifier: READ_MODEL_VERIFIER,
      },
    });
    expect(second).toMatchObject({
      disposition: 'recorded',
      envelope: {
        sequence: 2,
        producerAttemptId: secondInput.producerAttemptId,
        sourceDigest: digest('second-authenticated-source-bundle'),
        payload: { snapshotDigest: first.envelope?.payload.snapshotDigest },
      },
    });
  });

  it('enforces the final cancellation and deadline fence before publication', () => {
    for (const decision of ['cancelled-before-commit', 'deadline-before-commit'] as const) {
      const isolatedRoot = join(anchorPath, `snapshots-${decision}`);
      const result = appendAgentOsSnapshotV1(input(decision), {
        ...dependencies,
        rootPath: isolatedRoot,
        commitGuard: () => decision,
      });
      expect(result).toMatchObject({ disposition: 'rejected', reason: decision, envelope: null });
      expect(existsSync(isolatedRoot) && existsSync(join(isolatedRoot, 'records', '000000000001.json')))
        .toBe(false);
    }
  });

  it('rechecks the commit fence inside the immutable writer immediately before link', () => {
    let checks = 0;
    const guardedRoot = join(anchorPath, 'snapshots-crossed-deadline');
    const result = appendAgentOsSnapshotV1(input('crossed-deadline'), {
      ...dependencies,
      rootPath: guardedRoot,
      commitGuard: () => ++checks >= 4 ? 'deadline-before-commit' : 'allow',
    });
    expect(checks).toBe(4);
    expect(result).toMatchObject({ disposition: 'rejected', reason: 'deadline-before-commit' });
    expect(existsSync(join(guardedRoot, 'records', '000000000001.json'))).toBe(false);
  });

  it('fails closed on payload tampering and a widened store', () => {
    expect(appendAgentOsSnapshotV1(input(), dependencies).disposition).toBe('recorded');
    const recordPath = join(rootPath, 'records', '000000000001.json');
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    const payload = parsed['payload'] as { snapshot: AgentOsReadModelV1 };
    payload.snapshot.nextAction.title = 'Tampered title';
    writeFileSync(recordPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({
      sourceState: 'degraded',
      availability: 'unavailable',
      complete: false,
      envelopes: [],
      current: null,
      stopReasons: expect.arrayContaining(['invalid-file']),
    });

    if (process.platform !== 'win32') {
      chmodSync(rootPath, 0o755);
      expect(readAgentOsSnapshotsV1(dependencies).stopReasons).toContain('unsafe-storage');
    }
  });

  it('detects a currently inconsistent signed high-water checkpoint without claiming rollback protection', () => {
    const first = appendAgentOsSnapshotV1(input('one'), dependencies);
    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies).disposition).toBe('recorded');
    unlinkSync(join(rootPath, 'records', '000000000002.json'));
    const read = readAgentOsSnapshotsV1(dependencies);
    expect(read).toMatchObject({
      complete: false,
      availability: 'unavailable',
      rollbackProtected: false,
      historicalAuthority: false,
      stopReasons: expect.arrayContaining(['checkpoint-mismatch']),
    });
    expect(read.current).toBeNull();
    expect(first.envelope).not.toBeNull();
  });

  it('treats a surviving checkpoint without its ledger as degraded, never as a fresh store', () => {
    expect(appendAgentOsSnapshotV1(input(), dependencies).disposition).toBe('recorded');
    rmSync(rootPath, { recursive: true, force: true });
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['checkpoint-orphaned'],
    });
    expect(appendAgentOsSnapshotV1(input('replacement'), dependencies)).toMatchObject({
      disposition: 'unavailable',
      reason: 'chain-unavailable',
    });
  });

  it('detects an authenticated sequence gap and broken predecessor chain', () => {
    expect(appendAgentOsSnapshotV1(input('one'), dependencies).disposition).toBe('recorded');
    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies).disposition).toBe('recorded');
    unlinkSync(join(rootPath, 'records', '000000000001.json'));
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({
      complete: false,
      availability: 'unavailable',
      envelopes: [],
      current: null,
      stopReasons: expect.arrayContaining(['sequence-gap', 'broken-predecessor']),
      rollbackProtected: false,
      historicalAuthority: false,
    });
  });

  it('fails closed on a torn checkpoint and lets a later authenticated writer reconcile it', () => {
    let signatures = 0;
    const base = authenticator();
    dependencies.signer = {
      ...base.signer,
      sign: (value) => {
        signatures += 1;
        return signatures === 1 ? base.signer.sign(value) : null;
      },
    };
    expect(appendAgentOsSnapshotV1(input(), dependencies)).toMatchObject({
      disposition: 'failed',
      reason: 'checkpoint-failed',
    });
    expect(existsSync(join(rootPath, 'records', '000000000001.json'))).toBe(true);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({
      complete: false,
      availability: 'unavailable',
      stopReasons: expect.arrayContaining(['checkpoint-missing']),
    });
    dependencies.signer = base.signer;
    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'recorded',
      reason: 'recorded',
      envelope: { sequence: 2 },
    });
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it.skipIf(process.platform === 'win32')('finalizes an exact authenticated checkpoint temp after a crash', () => {
    const first = appendAgentOsSnapshotV1(input('one'), dependencies);
    expect(first.envelope).not.toBeNull();
    const tipPath = join(anchorPath, '.agent-os-snapshot-tip-v1.json');
    const temporaryTipPath = `${tipPath}.tmp`;
    const tipText = readFileSync(tipPath, 'utf8');
    unlinkSync(tipPath);
    writeFileSync(temporaryTipPath, tipText, { mode: 0o600 });

    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'recorded',
      envelope: { sequence: 2 },
    });
    expect(existsSync(temporaryTipPath)).toBe(false);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it.skipIf(process.platform === 'win32')('removes a partial checkpoint temp and rebuilds the authenticated tip', () => {
    expect(appendAgentOsSnapshotV1(input('one'), dependencies).disposition).toBe('recorded');
    const tipPath = join(anchorPath, '.agent-os-snapshot-tip-v1.json');
    const temporaryTipPath = `${tipPath}.tmp`;
    unlinkSync(tipPath);
    writeFileSync(temporaryTipPath, '{"partial":', { mode: 0o600 });

    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'recorded',
      envelope: { sequence: 2 },
    });
    expect(existsSync(temporaryTipPath)).toBe(false);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it.skipIf(process.platform === 'win32')('unlinks only an exact checkpoint-temp symlink and leaves its target untouched', () => {
    expect(appendAgentOsSnapshotV1(input('one'), dependencies).disposition).toBe('recorded');
    const tipPath = join(anchorPath, '.agent-os-snapshot-tip-v1.json');
    const temporaryTipPath = `${tipPath}.tmp`;
    const symlinkTarget = join(temporary, 'checkpoint-symlink-target');
    const targetText = 'do-not-delete-or-rewrite\n';
    unlinkSync(tipPath);
    writeFileSync(symlinkTarget, targetText, { mode: 0o600 });
    symlinkSync(symlinkTarget, temporaryTipPath);

    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'recorded',
      envelope: { sequence: 2 },
    });
    expect(existsSync(temporaryTipPath)).toBe(false);
    expect(readFileSync(symlinkTarget, 'utf8')).toBe(targetText);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it.skipIf(process.platform === 'win32')('removes a widened checkpoint temp instead of trusting it', () => {
    expect(appendAgentOsSnapshotV1(input('one'), dependencies).disposition).toBe('recorded');
    const tipPath = join(anchorPath, '.agent-os-snapshot-tip-v1.json');
    const temporaryTipPath = `${tipPath}.tmp`;
    const tipText = readFileSync(tipPath, 'utf8');
    unlinkSync(tipPath);
    writeFileSync(temporaryTipPath, tipText, { mode: 0o600 });
    chmodSync(temporaryTipPath, 0o644);

    now = new Date('2026-09-03T12:00:01.000Z');
    expect(appendAgentOsSnapshotV1(input('two'), dependencies)).toMatchObject({
      disposition: 'recorded',
      envelope: { sequence: 2 },
    });
    expect(existsSync(temporaryTipPath)).toBe(false);
    expect(statSync(tipPath).mode & 0o777).toBe(0o600);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it.skipIf(process.platform === 'win32')('discards stale and conflicting authenticated checkpoint temps', () => {
    const first = appendAgentOsSnapshotV1(input('one'), dependencies);
    expect(first.envelope).not.toBeNull();
    now = new Date('2026-09-03T12:00:01.000Z');
    const second = appendAgentOsSnapshotV1(input('two'), dependencies);
    expect(second.envelope).not.toBeNull();
    const tipPath = join(anchorPath, '.agent-os-snapshot-tip-v1.json');
    const temporaryTipPath = `${tipPath}.tmp`;
    writeFileSync(temporaryTipPath, checkpointTipText(first.envelope!, dependencies.signer!), { mode: 0o600 });

    now = new Date('2026-09-03T12:00:02.000Z');
    const third = appendAgentOsSnapshotV1(input('three'), dependencies);
    expect(third).toMatchObject({ disposition: 'recorded', envelope: { sequence: 3 } });
    expect(existsSync(temporaryTipPath)).toBe(false);

    const conflicting = { ...third.envelope!, envelopeDigest: digest('conflicting-envelope') };
    writeFileSync(temporaryTipPath, checkpointTipText(conflicting, dependencies.signer!), { mode: 0o600 });
    now = new Date('2026-09-03T12:00:03.000Z');
    expect(appendAgentOsSnapshotV1(input('four'), dependencies)).toMatchObject({
      disposition: 'recorded',
      envelope: { sequence: 4 },
    });
    expect(existsSync(temporaryTipPath)).toBe(false);
    expect(readAgentOsSnapshotsV1(dependencies)).toMatchObject({ complete: true, availability: 'available' });
  });

  it('rejects non-exact models and a missing source verifier before touching storage', () => {
    const extra = input();
    (extra as AgentOsSnapshotAppendInputV1 & { prompt?: string }).prompt = 'hidden';
    expect(appendAgentOsSnapshotV1(extra, dependencies)).toMatchObject({
      disposition: 'rejected',
      reason: 'invalid-input',
    });

    const callerProse = input('caller-prose');
    (callerProse.readModelInput as AgentOsReadModelInputV1 & { display?: unknown }).display = {
      nextAction: 'Read /Users/operator/.config before proceeding',
    };
    expect(appendAgentOsSnapshotV1(callerProse, dependencies)).toMatchObject({
      disposition: 'rejected',
      reason: 'invalid-input',
    });

    expect(appendAgentOsSnapshotV1(input('no-verifier'), {
      ...dependencies,
      readModelVerifier: null,
    })).toMatchObject({
      disposition: 'rejected',
      reason: 'invalid-input',
    });
    expect(existsSync(rootPath)).toBe(false);
  });
});
