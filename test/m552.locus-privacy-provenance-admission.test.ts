import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalLocusWorkspaceIdentityObservationBytesV1,
  compileExternalLocusWorkspaceIdentityObservationV1,
  LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
  locusWorkspaceIdentityObservationDigestV1,
  type LocusWorkspaceIdentityObservationV1,
} from '../src/core/fabric/external-locus-workspace-identity.js';
import {
  LOCUS_BINDING_CAPABILITY_PURPOSE,
  canonicalLocusBindingCapabilityBytesV1,
  mintLocusBindingCapabilityV1,
  type LocusBindingCapabilityV1,
} from '../src/core/fabric/locus-binding-capability.js';
import {
  admitLocusWorkspaceIdentityObservationV1,
  appendLocusWorkspaceIdentityObservationV1,
  readLocusWorkspaceIdentityLedgerV1,
  verifyLocusWorkspaceIdentityLedgerRecordV1,
  type LocusWorkspaceIdentityLedgerDependenciesV1,
} from '../src/core/fabric/locus-workspace-identity-ledger.js';

const KEY = Buffer.alloc(32, 0x52);
const MINT_TIME = new Date('2026-09-03T16:00:00.000Z');
const COMMIT_TIME = new Date('2026-09-03T16:00:30.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(now: () => Date = () => COMMIT_TIME, key: Buffer | null = KEY):
LocusWorkspaceIdentityLedgerDependenciesV1 {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m552-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const anchorPath = join(root, '.ashlr');
  mkdirSync(anchorPath, { mode: 0o700 });
  return {
    anchorPath,
    rootPath: join(anchorPath, 'locus-workspace-identity-ledger-v1'),
    key: key ? Buffer.from(key) : null,
    now,
  };
}

function capability(options: {
  sequence?: number;
  previousObservationDigest?: string;
  generation?: number;
  lifetimeMs?: number;
  nonce?: number;
} = {}): LocusBindingCapabilityV1 {
  const result = mintLocusBindingCapabilityV1({
    audienceLabel: 'ashlr-hub:observer',
    workspaceLocator: '/private/workspace-label',
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: options.generation ?? 7,
    sequence: options.sequence ?? 1,
    previousObservationDigest: options.previousObservationDigest ??
      LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
    lifetimeMs: options.lifetimeMs ?? 5 * 60_000,
  }, {
    key: () => Buffer.from(KEY),
    now: () => MINT_TIME,
    randomBytes: (size) => Buffer.alloc(size, options.nonce ?? 0x31),
  });
  if (!result.ok) throw new Error(`mint failed: ${result.issue}`);
  return result.capability;
}

function capabilityBytes(value: LocusBindingCapabilityV1): Buffer {
  const bytes = canonicalLocusBindingCapabilityBytesV1(value);
  if (!bytes) throw new Error('capability bytes unavailable');
  return bytes;
}

function context(value: LocusBindingCapabilityV1) {
  return {
    capabilityId: value.capabilityId,
    purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
    policyGeneration: value.policyGeneration,
  };
}

function observationBytes(binding: LocusBindingCapabilityV1, options: {
  observedAt?: string;
  expiresAt?: string;
  phantomAvailable?: boolean;
  audienceDigest?: string;
  workspaceDigest?: string;
  sequence?: number;
  previousObservationDigest?: string;
} = {}): Buffer {
  const unsigned = {
    schemaVersion: 1 as const,
    protocol: 'ashlr-locus-workspace-identity-observation-v1' as const,
    recordType: 'locus-workspace-identity-observation' as const,
    authority: 'observation_only' as const,
    sourceState: 'local_unverified' as const,
    privacyClass: 'metadata_only' as const,
    planningAuthority: false as const,
    executionAuthority: false as const,
    effectAuthority: false as const,
    producer: { product: 'locus' as const, version: '0.5.0', commit: 'a'.repeat(40) },
    observedAt: options.observedAt ?? '2026-09-03T16:00:15.000Z',
    expiresAt: options.expiresAt ?? '2026-09-03T16:04:45.000Z',
    sequence: options.sequence ?? binding.sequence,
    previousObservationDigest: options.previousObservationDigest ?? binding.previousObservationDigest,
    audienceDigest: options.audienceDigest ?? binding.audienceDigest,
    workspaceDigest: options.workspaceDigest ?? binding.workspaceDigest,
    identityPosture: 'ready' as const,
    pinPosture: 'valid' as const,
    authorityAnchor: 'verified' as const,
    workspacePolicy: { state: 'valid' as const, requirePin: true, pinAllowed: true },
    mcpRegistered: { claude: true, cursor: false, codex: true, grok: false },
    adapterManifestDigest: null,
    phantomAvailable: options.phantomAvailable ?? true,
    unresolvedCredentials: 0,
    approvalStore: { state: 'healthy' as const, pending: 0, dualControlWaiting: 0 },
    effects: {
      files: false as const, providers: false as const, credentials: false as const,
      pins: false as const, approvals: false as const, dispatches: false as const,
      proposals: false as const, merges: false as const, releases: false as const,
      deployments: false as const, publications: false as const,
      externalMutations: false as const, budgets: false as const, learning: false as const,
    },
  };
  const observationDigest = locusWorkspaceIdentityObservationDigestV1(unsigned);
  if (!observationDigest) throw new Error('observation digest unavailable');
  const value = { ...unsigned, observationDigest } satisfies LocusWorkspaceIdentityObservationV1;
  const bytes = canonicalLocusWorkspaceIdentityObservationBytesV1(value);
  if (!bytes) throw new Error('observation bytes unavailable');
  return bytes;
}

function admissionInput(binding: LocusBindingCapabilityV1, bytes = observationBytes(binding)) {
  return {
    capabilityBytes: capabilityBytes(binding),
    capabilityContext: context(binding),
    observationBytes: bytes,
  };
}

describe('M552 atomic Locus privacy-provenance admission', () => {
  it('verifies M549, compiles M547, and durably appends capability provenance through M548', () => {
    const binding = capability();
    const dependencies = harness();
    const result = admitLocusWorkspaceIdentityObservationV1(admissionInput(binding), dependencies);
    expect(result.disposition).toBe('recorded');
    if (result.disposition !== 'recorded') return;
    expect(result.record.bindingAdmission).toEqual({
      mode: 'privacy-provenance-verified',
      capabilityId: binding.capabilityId,
      purpose: LOCUS_BINDING_CAPABILITY_PURPOSE,
      policyGeneration: 7,
      issuedAt: binding.issuedAt,
      expiresAt: binding.expiresAt,
    });
    expect(result.record).toMatchObject({
      authority: 'observation-only', truthVerified: false, releaseProvenanceVerified: false,
      trusted: false, policyAuthority: false, effectAuthorityGranted: false,
      sameUserTamperResistant: false, rollbackProtected: false,
    });
    expect(verifyLocusWorkspaceIdentityLedgerRecordV1(result.record, KEY)).toEqual(result.record);
    const read = readLocusWorkspaceIdentityLedgerV1({
      audienceDigest: binding.audienceDigest, workspaceDigest: binding.workspaceDigest,
    }, dependencies);
    expect(read.records[0]?.bindingAdmission).toEqual(result.record.bindingAdmission);
  });

  it('marks the preserved low-level append path explicitly direct-unverified', () => {
    const binding = capability();
    const dependencies = harness();
    const compiled = compileExternalLocusWorkspaceIdentityObservationV1(
      observationBytes(binding), {
        audienceDigest: binding.audienceDigest,
        workspaceDigest: binding.workspaceDigest,
        sequence: binding.sequence,
        previousObservationDigest: binding.previousObservationDigest,
      }, COMMIT_TIME,
    );
    if (!compiled.ok) throw new Error('fixture compile failed');
    const result = appendLocusWorkspaceIdentityObservationV1({
      audienceDigest: binding.audienceDigest, workspaceDigest: binding.workspaceDigest,
    }, compiled.observation, dependencies);
    expect(result.disposition).toBe('recorded');
    if (result.disposition === 'recorded') expect(result.record.bindingAdmission).toEqual({
      mode: 'direct-unverified', capabilityId: null, purpose: null,
      policyGeneration: null, issuedAt: null, expiresAt: null,
    });
  });

  it('rejects direct audience, workspace, sequence, and predecessor substitutions', () => {
    const binding = capability();
    for (const bytes of [
      observationBytes(binding, { audienceDigest: `sha256:${'1'.repeat(64)}` }),
      observationBytes(binding, { workspaceDigest: `sha256:${'2'.repeat(64)}` }),
      observationBytes(binding, { sequence: 2, previousObservationDigest: `sha256:${'3'.repeat(64)}` }),
    ]) {
      const dependencies = harness();
      expect(admitLocusWorkspaceIdentityObservationV1(
        admissionInput(binding, bytes), dependencies,
      ).disposition).toBe('invalid-observation');
      expect(readLocusWorkspaceIdentityLedgerV1({
        audienceDigest: binding.audienceDigest, workspaceDigest: binding.workspaceDigest,
      }, dependencies).records).toEqual([]);
    }
    const successorBinding = capability({
      sequence: 2, previousObservationDigest: `sha256:${'5'.repeat(64)}`,
    });
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(
      successorBinding,
      observationBytes(successorBinding, { previousObservationDigest: `sha256:${'6'.repeat(64)}` }),
    ), harness()).disposition).toBe('invalid-observation');
  });

  it('rejects caller policy-generation substitution before persistence', () => {
    const binding = capability();
    const dependencies = harness();
    const candidate = admissionInput(binding);
    candidate.capabilityContext = { ...candidate.capabilityContext, policyGeneration: 8 };
    expect(admitLocusWorkspaceIdentityObservationV1(candidate, dependencies).disposition)
      .toBe('generation-mismatch');
  });

  it('rejects a capability expired before admission or exactly at publication', () => {
    const expired = capability({ lifetimeMs: 1_000 });
    expect(admitLocusWorkspaceIdentityObservationV1(
      admissionInput(expired, observationBytes(expired, {
        observedAt: '2026-09-03T16:00:00.000Z', expiresAt: '2026-09-03T16:00:00.900Z',
      })), harness(() => new Date('2026-09-03T16:00:01.000Z')),
    ).disposition).toBe('capability-expired');

    let reads = 0;
    const movingClock = harness(() => {
      reads += 1;
      return reads < 3
        ? new Date('2026-09-03T16:00:00.500Z')
        : new Date('2026-09-03T16:00:01.000Z');
    });
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(expired, observationBytes(expired, {
      observedAt: '2026-09-03T16:00:00.000Z', expiresAt: '2026-09-03T16:00:00.900Z',
    })), movingClock).disposition).toBe('capability-expired');
    expect(readLocusWorkspaceIdentityLedgerV1({
      audienceDigest: expired.audienceDigest, workspaceDigest: expired.workspaceDigest,
    }, { ...movingClock, now: () => COMMIT_TIME }).records).toEqual([]);
  });

  it('requires the complete observation interval to fit inside the capability window', () => {
    const binding = capability();
    for (const bytes of [
      observationBytes(binding, { observedAt: '2026-09-03T15:59:59.999Z' }),
      observationBytes(binding, { expiresAt: '2026-09-03T16:05:00.001Z' }),
    ]) {
      expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(binding, bytes), harness()).disposition)
        .toBe('capability-window-mismatch');
    }
  });

  it('rejects reuse of one capability for a different observation', () => {
    const binding = capability();
    const dependencies = harness();
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(binding), dependencies).disposition)
      .toBe('recorded');
    expect(admitLocusWorkspaceIdentityObservationV1(
      admissionInput(binding, observationBytes(binding, { phantomAvailable: false })), dependencies,
    ).disposition).toBe('capability-replay');
  });

  it('rejects replay of one observation under a different capability identity', () => {
    const first = capability({ nonce: 1 });
    const second = capability({ nonce: 2 });
    const sourceBytes = observationBytes(first);
    const dependencies = harness();
    expect(admitLocusWorkspaceIdentityObservationV1(
      admissionInput(first, sourceBytes), dependencies,
    ).disposition).toBe('recorded');
    expect(admitLocusWorkspaceIdentityObservationV1(
      admissionInput(second, sourceBytes), dependencies,
    ).disposition).toBe('cross-capability-replay');
  });

  it('will not promote an existing direct-unverified lineage into verified provenance', () => {
    const first = capability();
    const dependencies = harness();
    const compiled = compileExternalLocusWorkspaceIdentityObservationV1(observationBytes(first), {
      audienceDigest: first.audienceDigest, workspaceDigest: first.workspaceDigest,
      sequence: 1, previousObservationDigest: LOCUS_WORKSPACE_IDENTITY_OBSERVATION_GENESIS_DIGEST,
    }, COMMIT_TIME);
    if (!compiled.ok) throw new Error('fixture compile failed');
    expect(appendLocusWorkspaceIdentityObservationV1({
      audienceDigest: first.audienceDigest, workspaceDigest: first.workspaceDigest,
    }, compiled.observation, dependencies).disposition).toBe('recorded');
    const second = capability({ sequence: 2, previousObservationDigest: compiled.observation.sourceObservationDigest, nonce: 2 });
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(second, observationBytes(second, {
      observedAt: '2026-09-03T16:00:31.000Z', expiresAt: '2026-09-03T16:04:59.000Z',
    })), dependencies).disposition).toBe('unverified-lineage');
  });

  it('will not contaminate a verified lineage through the low-level direct append', () => {
    const first = capability();
    const dependencies = harness();
    const recorded = admitLocusWorkspaceIdentityObservationV1(admissionInput(first), dependencies);
    expect(recorded.disposition).toBe('recorded');
    if (recorded.disposition !== 'recorded') return;
    const second = capability({
      sequence: 2, previousObservationDigest: recorded.record.sourceObservationDigest, nonce: 2,
    });
    const compiled = compileExternalLocusWorkspaceIdentityObservationV1(observationBytes(second, {
      observedAt: '2026-09-03T16:00:31.000Z', expiresAt: '2026-09-03T16:04:59.000Z',
    }), {
      audienceDigest: second.audienceDigest, workspaceDigest: second.workspaceDigest,
      sequence: second.sequence, previousObservationDigest: second.previousObservationDigest,
    }, COMMIT_TIME);
    if (!compiled.ok) throw new Error('fixture compile failed');
    expect(appendLocusWorkspaceIdentityObservationV1({
      audienceDigest: second.audienceDigest, workspaceDigest: second.workspaceDigest,
    }, compiled.observation, dependencies).disposition).toBe('unverified-lineage');
    const read = readLocusWorkspaceIdentityLedgerV1({
      audienceDigest: first.audienceDigest, workspaceDigest: first.workspaceDigest,
    }, dependencies, { requireComplete: true });
    expect(read).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(read.records).toHaveLength(1);
    expect(read.tip?.bindingAdmission.mode).toBe('privacy-provenance-verified');
  });

  it('starts policy rotation as a separate genesis chain without claiming an anchor', () => {
    const first = capability({ generation: 7 });
    const rotated = capability({ generation: 8, nonce: 2 });
    const dependencies = harness();
    expect(first.audienceDigest).not.toBe(rotated.audienceDigest);
    expect(first.workspaceDigest).not.toBe(rotated.workspaceDigest);
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(first), dependencies).disposition)
      .toBe('recorded');
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(rotated), dependencies).disposition)
      .toBe('recorded');
    expect(readLocusWorkspaceIdentityLedgerV1({
      audienceDigest: rotated.audienceDigest, workspaceDigest: rotated.workspaceDigest,
    }, dependencies).tip?.bindingAdmission.policyGeneration).toBe(8);
  });

  it('requires an existing key and never creates a new persistence root', () => {
    const binding = capability();
    const dependencies = harness(() => COMMIT_TIME, null);
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(binding), dependencies).disposition)
      .toBe('key-unavailable');
    expect(() => readdirSync(dependencies.rootPath)).toThrow();
  });

  it('detects durable capability provenance tampering', () => {
    const binding = capability();
    const dependencies = harness();
    expect(admitLocusWorkspaceIdentityObservationV1(admissionInput(binding), dependencies).disposition)
      .toBe('recorded');
    const recordsPath = join(dependencies.rootPath, 'records');
    const file = join(recordsPath, readdirSync(recordsPath)[0]!);
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const admission = value['bindingAdmission'] as Record<string, unknown>;
    admission['policyGeneration'] = 8;
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    expect(readLocusWorkspaceIdentityLedgerV1({
      audienceDigest: binding.audienceDigest, workspaceDigest: binding.workspaceDigest,
    }, dependencies, { requireComplete: true })).toMatchObject({
      sourceState: 'degraded', records: [], tip: null,
    });
  });

  it('does not leak private mint labels into admission records or filenames', () => {
    const binding = capability();
    const dependencies = harness();
    const result = admitLocusWorkspaceIdentityObservationV1(admissionInput(binding), dependencies);
    expect(result.disposition).toBe('recorded');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ashlr-hub:observer');
    expect(serialized).not.toContain('/private/workspace-label');
    const files = readdirSync(join(dependencies.rootPath, 'records'));
    expect(files.join('\n')).not.toContain('workspace-label');
  });

  it('owns capability, observation, and context inputs before caller-controlled clock callbacks', () => {
    const binding = capability();
    const candidate = admissionInput(binding);
    const dependencies = harness(() => {
      candidate.capabilityBytes.fill(0);
      candidate.observationBytes.fill(0);
      candidate.capabilityContext.capabilityId = `hmac-sha256:${'0'.repeat(64)}`;
      candidate.capabilityContext.policyGeneration = 99;
      return COMMIT_TIME;
    });
    const result = admitLocusWorkspaceIdentityObservationV1(candidate, dependencies);
    expect(result.disposition).toBe('recorded');
    if (result.disposition !== 'recorded') return;
    expect(result.record.bindingAdmission).toMatchObject({
      capabilityId: binding.capabilityId,
      policyGeneration: binding.policyGeneration,
    });
  });
});
