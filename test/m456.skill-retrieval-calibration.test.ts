import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AST-scans the whole src/ tree for runtime import boundaries; that scan
// alone takes ~18s on this machine, well past the 5s default.
vi.setConfig({ testTimeout: 45_000 });
import ts from 'typescript';

const trustState = vi.hoisted(() => ({
  policy: {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-audit-trust-v1',
    policyGeneration: 0,
    roots: [] as unknown[],
  },
}));

vi.mock('../src/core/fleet/external-skill-audit-trust-roots.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/external-skill-audit-trust-roots.js')>(),
  EXTERNAL_SKILL_AUDIT_TRUST_POLICY: trustState.policy,
}));

import {
  auditExternalSkillPack,
  canonicalExternalSkillAuditReportBytes,
  EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
  projectExternalSkillCandidateMetadata,
} from '../src/core/fleet/external-skill-audit.js';
import {
  canonicalExternalSkillAuditReceiptBytes,
  canonicalExternalSkillAuditReceiptPayload,
  externalSkillAuditTrustPolicyDigest,
  externalSkillAuditVerifierKeyId,
  type ExternalSkillAuditReceipt,
  type ExternalSkillAuditReceiptUnsigned,
} from '../src/core/fleet/external-skill-audit-receipt.js';
import {
  evaluateSkillRetrievalCalibration,
  type EvaluateSkillRetrievalCalibrationInputV1,
  type SkillRetrievalCalibrationCaseV1,
  type SkillRetrievalCalibrationSnapshotV1,
} from '../src/core/fleet/skill-retrieval-calibration.js';
import {
  SKILL_RETRIEVAL_POLICY_VERSION,
  type SkillRetrievalScoringCandidate,
} from '../src/core/fleet/skill-retrieval.js';

const AS_OF = '2026-07-22T12:30:00.000Z';
const SETTLED_AT = '2026-07-22T12:00:00.000Z';
const roots: string[] = [];

interface AuditFixture {
  packPath: string;
  candidateSkillBytes: Buffer;
  reportBytes: Buffer;
  receiptBytes: Buffer;
  receipt: ExternalSkillAuditReceipt;
  privateKey: KeyObject;
}

function sha256(domain: string, value: Uint8Array | string): string {
  return createHash('sha256').update(domain, 'utf8').update(value).digest('hex');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stable((value as Record<string, unknown>)[key]);
  }
  return output;
}

function canonical(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(stable(value)), 'utf8');
}

function writeSkill(root: string, name: string, other: string, word: string): void {
  const skillRoot = join(root, 'skills', name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Guides ${word} work with deterministic evidence and bounded verification.`,
    '---',
    '',
    '## When to Use',
    `Use for ${word}.`,
    '## Workflow',
    'Follow the bounded workflow.',
    '## Common Rationalizations',
    'Do not skip proof.',
    '## Red Flags',
    'Unsupported claims.',
    '## Verification',
    'Produce deterministic evidence.',
  ].join('\n'));
  const fixtureRoot = join(root, 'evals', 'fixtures', name);
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, 'input.txt'), word);
  writeFileSync(join(root, 'evals', 'cases', `${name}.json`), JSON.stringify({
    skill_name: name,
    trigger: {
      positive: [
        { prompt: `${word} ${word} workflow`, top_k: 1 },
        { prompt: `perform ${word} carefully`, top_k: 1 },
        { prompt: `need ${word} evidence`, top_k: 1 },
      ],
      negative: [
        { prompt: `${other.replaceAll('-', ' ')} workflow`, owner: other },
        { prompt: `perform ${other.replaceAll('-', ' ')}`, owner: other },
      ],
    },
    evals: [{
      id: 1,
      kind: 'execution',
      prompt: `Complete private ${word} prompt canary`,
      expected_output: 'Private output canary',
      files: [name],
      expectations: ['Private expectation canary'],
    }],
  }));
}

function validPack(): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m456-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'evals', 'cases'), { recursive: true });
  writeSkill(root, 'testing-workflow', 'documentation-workflow', 'testing');
  writeSkill(root, 'documentation-workflow', 'testing-workflow', 'documentation');
  return root;
}

function auditFixture(provisionRoot = true): AuditFixture {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = Buffer.from(
    publicKey.export({ format: 'der', type: 'spki' }),
  ).toString('base64url');
  const keyId = externalSkillAuditVerifierKeyId(publicKeySpki)!;
  if (provisionRoot) {
    trustState.policy.policyGeneration = 7;
    trustState.policy.roots = [{
      keyId,
      publicKeySpki,
      signerRole: 'external-skill-audit-verifier',
      signatureAlgorithm: 'ed25519',
      auditPolicyDigest: EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2026-08-01T00:00:00.000Z',
      revokedAt: null,
    }];
  }
  const packPath = validPack();
  const report = auditExternalSkillPack(packPath);
  expect(report.trialReady).toBe(true);
  const reportBytes = canonicalExternalSkillAuditReportBytes(report)!;
  const selected = report.skills[0]!;
  const candidateSkillBytes = readFileSync(
    join(packPath, 'skills', selected.name, 'SKILL.md'),
  );
  const unsigned: ExternalSkillAuditReceiptUnsigned = {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-audit-receipt-v1',
    reportDigest: sha256('ashlr:external-skill-audit-report:v1\0', reportBytes),
    packDigest: report.packDigest,
    portablePackDigest: report.portablePackDigest,
    selectedSkillName: selected.name,
    selectedSkillContentHash: selected.contentHash,
    auditPolicyDigest: EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
    verdict: 'trial-ready',
    issuedAt: '2026-07-22T12:00:00.000Z',
    expiresAt: '2026-07-22T13:00:00.000Z',
    trustPolicyDigest: externalSkillAuditTrustPolicyDigest()!,
    policyGeneration: trustState.policy.policyGeneration,
    keyId,
    signerRole: 'external-skill-audit-verifier',
    signatureAlgorithm: 'ed25519',
    workflowAuthority: 'none',
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
  };
  const receipt = {
    ...unsigned,
    signature: sign(
      null,
      canonicalExternalSkillAuditReceiptPayload(unsigned)!,
      privateKey,
    ).toString('base64url'),
  };
  return {
    packPath,
    candidateSkillBytes,
    reportBytes,
    receiptBytes: canonicalExternalSkillAuditReceiptBytes(receipt)!,
    receipt,
    privateKey,
  };
}

function candidateFixture(value: AuditFixture): SkillRetrievalScoringCandidate[] {
  const selected = projectExternalSkillCandidateMetadata(value.candidateSkillBytes)!;
  return [
    {
      candidateId: selected.contentHash,
      name: selected.name,
      summary: selected.description,
      tags: [],
      taskKinds: [],
      commandKinds: [],
    },
    {
      candidateId: sha256('ashlr:m456:test-candidate:v1\0', 'competitor'),
      name: 'testing sentinel',
      summary: 'Guides testing work with deterministic evidence.',
      tags: [],
      taskKinds: [],
      commandKinds: [],
    },
  ].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function caseDigest(domain: string, value: string): string {
  return sha256(`ashlr:m456:${domain}:v1\0`, value);
}

function semanticToken(index: number): string {
  return `sample${index.toString(36)}`;
}

function cases(candidates: SkillRetrievalScoringCandidate[]): SkillRetrievalCalibrationCaseV1[] {
  const rows: SkillRetrievalCalibrationCaseV1[] = [];
  for (const owner of candidates) {
    const excluded = candidates.find((candidate) => candidate.candidateId !== owner.candidateId)!;
    for (let index = 0; index < 50; index += 1) {
      rows.push({
        caseId: caseDigest('case', `positive:${owner.candidateId}:${index}`),
        clusterId: caseDigest('cluster', `positive:${owner.candidateId}:${index}`),
        groupId: caseDigest('group', `positive:${owner.candidateId}:${index % 5}`),
        kind: 'positive-owner',
        ownerCandidateId: owner.candidateId,
        excludedCandidateId: null,
        observedAt: SETTLED_AT,
        query: {
          title: owner.name,
          detail: `positive calibration ${semanticToken(index)}`,
          source: '',
          tags: [],
          route: { backend: '', model: '', reason: '', tier: '' },
        },
      });
    }
    for (let index = 0; index < 60; index += 1) {
      rows.push({
        caseId: caseDigest('case', `negative:${owner.candidateId}:${index}`),
        clusterId: caseDigest('cluster', `negative:${owner.candidateId}:${index}`),
        groupId: caseDigest('group', `negative:${owner.candidateId}:${index % 5}`),
        kind: 'negative-owner',
        ownerCandidateId: owner.candidateId,
        excludedCandidateId: excluded.candidateId,
        observedAt: SETTLED_AT,
        query: {
          title: owner.name,
          detail: `negative calibration ${semanticToken(index)}`,
          source: '',
          tags: [],
          route: { backend: '', model: '', reason: '', tier: '' },
        },
      });
    }
  }
  return rows.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function snapshot(
  value: AuditFixture,
  overrides: Partial<SkillRetrievalCalibrationSnapshotV1> = {},
): SkillRetrievalCalibrationSnapshotV1 {
  const candidates = candidateFixture(value);
  return {
    schemaVersion: 1,
    sourceRevision: 'fixture-revision-1',
    routerPolicyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
    sourceState: 'healthy',
    complete: true,
    invalidRows: 0,
    duplicateRows: 0,
    conflictingRows: 0,
    limitExceeded: false,
    auditBinding: {
      reportDigest: value.receipt.reportDigest,
      receiptDigest: sha256(
        'ashlr:external-skill-audit-receipt:v1\0',
        value.receiptBytes,
      ),
      packDigest: value.receipt.packDigest,
      portablePackDigest: value.receipt.portablePackDigest,
      selectedSkillName: value.receipt.selectedSkillName,
      selectedSkillContentHash: value.receipt.selectedSkillContentHash,
    },
    candidates,
    cases: cases(candidates),
    ...overrides,
  };
}

function input(
  value = auditFixture(),
  first = snapshot(value),
  second = structuredClone(first),
): EvaluateSkillRetrievalCalibrationInputV1 {
  return {
    asOf: AS_OF,
    auditEvidence: {
      reportBytes: value.reportBytes,
      receiptBytes: value.receiptBytes,
      selectedSkillName: value.receipt.selectedSkillName,
    },
    candidateSkillBytes: value.candidateSkillBytes,
    firstSnapshotBytes: canonical(first),
    secondSnapshotBytes: canonical(second),
  };
}

const falseAuthority = {
  authority: 'observation-only',
  executionAuthority: false,
  exposureAuthority: false,
  routingAuthority: false,
  learningAuthority: false,
  policyAuthority: false,
  promotionAuthority: false,
  proposalAuthority: false,
  verificationAuthority: false,
  mergeAuthority: false,
  releaseAuthority: false,
  deploymentAuthority: false,
  transitionAuthority: false,
  revocationAuthority: false,
  scoringKernelEquivalent: true,
  runtimeRouterEquivalent: false,
  runtimeBuildAttestationVerified: false,
  independentHeldoutVerified: false,
  distinctReadReceiptsVerified: false,
  trustedClockVerified: false,
  captureReceiptBindingVerified: false,
  appendOnlyTransparencyVerified: false,
  choiceSetBindingVerified: false,
  sourceCompletenessVerified: false,
  simultaneousConfidenceVerified: false,
  marginalConfidenceVerified: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AS_OF);
  trustState.policy.policyGeneration = 0;
  trustState.policy.roots = [];
});

afterEach(() => vi.useRealTimers());
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('M456 candidate-bound shadow-router calibration', () => {
  it('collects sample-complete evidence without claiming heldout or runtime authority', () => {
    const result = evaluateSkillRetrievalCalibration(input());

    expect(result).toMatchObject({
      schemaVersion: 1,
      protocol: 'skill-retrieval-calibration-v1',
      state: 'projected',
      gate: 'collecting',
      reason: 'evidence-collected',
      sourceState: 'declared-healthy',
      asOf: AS_OF,
      settledThrough: '2026-07-22T12:28:00.000Z',
      selectedCandidateBindingVerified: true,
      auditAuthenticationVerified: true,
      ...falseAuthority,
    });
    expect(result.sample).toEqual({
      candidates: 2,
      settledCases: 220,
      excludedCases: 0,
      positiveCases: 100,
      negativeCases: 120,
      candidatesMeetingSampleGate: 2,
      candidatesMeetingDiversityGate: 2,
      requiredPositivePerCandidate: 50,
      requiredNegativePerCandidate: 60,
      requiredGroupsPerKind: 5,
      maximumGroupShare: 0.25,
    });
    expect(result.routing).toMatchObject({
      ambiguousCutoffCases: 0,
      statisticScope: 'descriptive-wilson-per-candidate',
      positiveSelectedPassed: 100,
      positiveSelectedAccuracy: 1,
      positiveRankOnePassed: 100,
      positiveRankOneAccuracy: 1,
      negativeExcludedPassed: 120,
      negativeExcludedAccuracy: 1,
    });
    expect(result.routing!.minimumPerCandidatePositiveDescriptiveWilson).toBeGreaterThan(0.8);
    expect(result.routing!.minimumPerCandidateNegativeDescriptiveWilson).toBeGreaterThan(0.95);
    expect(result.blockers).toContain('independent-heldout-receipt-required');
  });

  it('ships with no production audit root and keeps descriptive metrics collecting', () => {
    const value = auditFixture(false);
    const result = evaluateSkillRetrievalCalibration(input(value));

    expect(result).toMatchObject({
      state: 'projected',
      gate: 'collecting',
      reason: 'audit-authentication-required',
      auditReason: 'trust-root-unprovisioned',
      auditAuthenticationVerified: false,
      selectedCandidateBindingVerified: false,
      ...falseAuthority,
    });
    expect(result.sample?.settledCases).toBe(220);
  });

  it('requires exact candidate bytes and the deterministic name-description mapping', () => {
    const value = auditFixture();
    const changedBytes = Buffer.from(value.candidateSkillBytes);
    changedBytes[changedBytes.length - 1] = changedBytes[changedBytes.length - 1]! ^ 1;
    expect(evaluateSkillRetrievalCalibration({
      ...input(value),
      candidateSkillBytes: changedBytes,
    })).toMatchObject({
      gate: 'withheld',
      reason: 'audit-binding-mismatch',
      sourceState: 'degraded',
    });
    const bomPrefixed = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      value.candidateSkillBytes,
    ]);
    expect(projectExternalSkillCandidateMetadata(bomPrefixed)).toBeNull();
    expect(evaluateSkillRetrievalCalibration({
      ...input(value),
      candidateSkillBytes: bomPrefixed,
    })).toMatchObject({
      gate: 'withheld',
      reason: 'audit-binding-mismatch',
    });

    const changed = snapshot(value);
    const index = changed.candidates.findIndex(
      (candidate) => candidate.candidateId === value.receipt.selectedSkillContentHash,
    );
    changed.candidates[index] = {
      ...changed.candidates[index]!,
      summary: 'Caller substituted metadata.',
    };
    expect(evaluateSkillRetrievalCalibration(input(value, changed, structuredClone(changed))))
      .toMatchObject({ gate: 'withheld', reason: 'audit-binding-mismatch' });
  });

  it('rejects candidate, audit, policy, and choice-set substitutions', () => {
    const value = auditFixture();
    const auditChanged = snapshot(value);
    auditChanged.auditBinding = {
      ...auditChanged.auditBinding,
      receiptDigest: 'f'.repeat(64),
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, auditChanged, structuredClone(auditChanged)),
    ).reason).toBe('audit-binding-mismatch');

    const policyChanged = snapshot(value, { routerPolicyVersion: 'other-router-v1' as never });
    expect(evaluateSkillRetrievalCalibration(
      input(value, policyChanged, structuredClone(policyChanged)),
    ).reason).toBe('router-policy-mismatch');

    const omitted = snapshot(value);
    omitted.candidates = omitted.candidates.slice(0, 1);
    expect(evaluateSkillRetrievalCalibration(
      input(value, omitted, structuredClone(omitted)),
    ).reason).toBe('audit-binding-mismatch');

    const baseline = evaluateSkillRetrievalCalibration(input(value));
    const substituted = snapshot(value);
    const competitorIndex = substituted.candidates.findIndex(
      (candidate) => candidate.candidateId !== value.receipt.selectedSkillContentHash,
    );
    substituted.candidates[competitorIndex] = {
      ...substituted.candidates[competitorIndex]!,
      name: 'caller supplied competitor',
      summary: 'Unauthenticated competitor metadata.',
    };
    const competitorChanged = evaluateSkillRetrievalCalibration(
      input(value, substituted, structuredClone(substituted)),
    );
    expect(competitorChanged).toMatchObject({
      selectedCandidateBindingVerified: true,
      choiceSetBindingVerified: false,
    });
    expect(competitorChanged.evidenceRoot).not.toBe(baseline.evidenceRoot);
    expect(competitorChanged.submittedChoiceSetDigest)
      .not.toBe(baseline.submittedChoiceSetDigest);
  });

  it('requires two exact canonical snapshot reads and rejects duplicate JSON keys', () => {
    const value = auditFixture();
    const first = snapshot(value);
    const changed = structuredClone(first);
    changed.sourceRevision = 'fixture-revision-2';
    expect(evaluateSkillRetrievalCalibration(input(value, first, changed)))
      .toMatchObject({ gate: 'withheld', reason: 'snapshot-mutation' });

    const valid = input(value);
    const duplicate = Buffer.from(
      valid.firstSnapshotBytes.toString('utf8').replace(
        '{"auditBinding":',
        '{"schemaVersion":1,"auditBinding":',
      ),
      'utf8',
    );
    expect(evaluateSkillRetrievalCalibration({
      ...valid,
      firstSnapshotBytes: duplicate,
      secondSnapshotBytes: duplicate,
    }).reason).toBe('snapshot-not-canonical');

    expect(evaluateSkillRetrievalCalibration({
      ...valid,
      firstSnapshotBytes: Buffer.from(` ${valid.firstSnapshotBytes.toString('utf8')}`),
    }).reason).toBe('snapshot-not-canonical');
  });

  it('rejects semantically duplicate cases even when caller-minted IDs differ', () => {
    const value = auditFixture();
    const duplicated = snapshot(value);
    duplicated.cases[1] = {
      ...duplicated.cases[0]!,
      caseId: caseDigest('case', 'caller-minted-duplicate'),
      clusterId: caseDigest('cluster', 'caller-minted-duplicate'),
      groupId: caseDigest('group', 'caller-minted-duplicate'),
      query: {
        ...duplicated.cases[0]!.query,
        title: `${duplicated.cases[0]!.query.title?.toUpperCase()}!!!`,
      },
    };

    expect(evaluateSkillRetrievalCalibration(
      input(value, duplicated, structuredClone(duplicated)),
    )).toMatchObject({
      gate: 'withheld',
      reason: 'duplicate-input',
    });
  });

  it('rejects cases that differ only after the scorer term cutoff', () => {
    const value = auditFixture();
    const duplicated = snapshot(value);
    const base = duplicated.cases[0]!;
    const detailPrefix = Array.from(
      { length: 60 },
      (_, index) => `detail${index.toString(36)}`,
    ).join(' ');
    const queryBase = {
      ...base.query,
      title: 'testing workflow',
      source: 'calibration-source',
      tags: Array.from({ length: 16 }, (_, index) => `tag${index.toString(36)}`),
    };
    duplicated.cases[0] = {
      ...base,
      query: { ...queryBase, detail: `${detailPrefix} ignored-alpha` },
    };
    duplicated.cases[1] = {
      ...base,
      caseId: caseDigest('case', 'term-cutoff-duplicate'),
      clusterId: caseDigest('cluster', 'term-cutoff-duplicate'),
      groupId: caseDigest('group', 'term-cutoff-duplicate'),
      query: { ...queryBase, detail: `${detailPrefix} ignored-beta` },
    };

    expect(evaluateSkillRetrievalCalibration(
      input(value, duplicated, structuredClone(duplicated)),
    )).toMatchObject({
      gate: 'withheld',
      reason: 'duplicate-input',
    });
  });

  it('withholds degraded, incomplete, invalid, duplicate, conflicting, and limited sources', () => {
    const value = auditFixture();
    for (const [overrides, reason] of [
      [{ sourceState: 'degraded' }, 'source-degraded'],
      [{ complete: false }, 'source-incomplete'],
      [{ invalidRows: 1 }, 'source-invalid'],
      [{ duplicateRows: 1 }, 'duplicate-input'],
      [{ conflictingRows: 1 }, 'conflicting-input'],
      [{ limitExceeded: true }, 'input-limit-exceeded'],
    ] as const) {
      const next = snapshot(value, overrides as Partial<SkillRetrievalCalibrationSnapshotV1>);
      expect(evaluateSkillRetrievalCalibration(
        input(value, next, structuredClone(next)),
      )).toMatchObject({ gate: 'withheld', reason, sourceState: 'degraded' });
    }
  });

  it('collects until every candidate meets sample and diversity gates', () => {
    const value = auditFixture();
    const sparse = snapshot(value);
    sparse.cases = sparse.cases.slice(0, 80);
    expect(evaluateSkillRetrievalCalibration(
      input(value, sparse, structuredClone(sparse)),
    )).toMatchObject({
      gate: 'collecting',
      reason: 'insufficient-sample',
      selectedCandidateBindingVerified: true,
    });

    const concentrated = snapshot(value);
    concentrated.cases = concentrated.cases.map((entry) => ({
      ...entry,
      groupId: caseDigest('group', `${entry.ownerCandidateId}:${entry.kind}`),
    }));
    expect(evaluateSkillRetrievalCalibration(
      input(value, concentrated, structuredClone(concentrated)),
    )).toMatchObject({ gate: 'collecting', reason: 'insufficient-sample' });
  });

  it('withholds quality when complete samples miss operational selection thresholds', () => {
    const value = auditFixture();
    const failing = snapshot(value);
    failing.cases = failing.cases.map((entry) => (
      entry.kind === 'negative-owner'
        ? {
            ...entry,
            query: {
              ...entry.query,
              title: `${failing.candidates[0]!.name} ${failing.candidates[1]!.name}`,
              detail: `negative collision ${entry.caseId.slice(0, 12)}`,
            },
          }
        : entry
    ));
    expect(evaluateSkillRetrievalCalibration(
      input(value, failing, structuredClone(failing)),
    )).toMatchObject({
      gate: 'withheld',
      reason: 'thresholds-not-met',
      sourceState: 'declared-healthy',
    });
  });

  it('compares full-precision Wilson bounds before rounding output', () => {
    const value = auditFixture();
    const boundary = snapshot(value);
    const owner = boundary.candidates[0]!;
    const retained = boundary.cases.filter((entry) => (
      entry.kind === 'negative-owner' ||
      entry.ownerCandidateId !== owner.candidateId
    ));
    const boundaryCases = Array.from({ length: 1_398 }, (_, index) => ({
      caseId: caseDigest('case', `wilson:${owner.candidateId}:${index}`),
      clusterId: caseDigest('cluster', `wilson:${owner.candidateId}:${index}`),
      groupId: caseDigest('group', `wilson:${owner.candidateId}:${index % 5}`),
      kind: 'positive-owner' as const,
      ownerCandidateId: owner.candidateId,
      excludedCandidateId: null,
      observedAt: SETTLED_AT,
      query: {
        title: index < 1_143 ? owner.name : 'unrelated vocabulary',
        detail: `sample row ${semanticToken(index)}`,
        source: '',
        tags: [],
        route: { backend: '', model: '', reason: '', tier: '' },
      },
    }));
    boundary.cases = [...retained, ...boundaryCases]
      .sort((left, right) => left.caseId.localeCompare(right.caseId));
    const result = evaluateSkillRetrievalCalibration(
      input(value, boundary, structuredClone(boundary)),
    );

    expect(result.routing?.minimumPerCandidatePositiveDescriptiveWilson).toBe(0.8);
    expect(result).toMatchObject({
      gate: 'withheld',
      reason: 'thresholds-not-met',
    });
  });

  it('accepts null route fields emitted by production query snapshots', () => {
    const value = auditFixture();
    const productionShape = snapshot(value);
    productionShape.cases = productionShape.cases.map((entry) => ({
      ...entry,
      query: {
        ...entry.query,
        tags: [
          `case${entry.caseId.slice(0, 12)}`,
          ...Array.from({ length: 49 }, (_, index) => semanticToken(index)),
        ],
        route: {
          backend: null,
          model: null,
          reason: '',
          tier: null,
        },
      },
    }));

    expect(evaluateSkillRetrievalCalibration(
      input(value, productionShape, structuredClone(productionShape)),
    )).toMatchObject({
      reason: 'evidence-collected',
      sourceState: 'declared-healthy',
    });
  });

  it('preserves production query-tag order and duplicates before scorer cutoffs', () => {
    const value = auditFixture();
    const ordered = snapshot(value);
    const competitorIndex = ordered.candidates.findIndex(
      (candidate) => candidate.candidateId !== value.receipt.selectedSkillContentHash,
    );
    const competitor = ordered.candidates[competitorIndex]!;
    ordered.candidates[competitorIndex] = {
      ...competitor,
      tags: ['zzmatch'],
    };
    const orderedTags = [
      'zzmatch',
      'zzmatch',
      ...Array.from({ length: 48 }, (_, index) => `aa${semanticToken(index)}`),
    ];
    ordered.cases = ordered.cases.map((entry) => (
      entry.ownerCandidateId === competitor.candidateId
        ? {
            ...entry,
            query: {
              ...entry.query,
              title: 'unrelated vocabulary',
              tags: orderedTags,
            },
          }
        : entry
    ));

    expect(evaluateSkillRetrievalCalibration(
      input(value, ordered, structuredClone(ordered)),
    )).toMatchObject({
      reason: 'evidence-collected',
      sourceState: 'declared-healthy',
    });
  });

  it('reports deterministic top-two selection separately from cutoff ambiguity', () => {
    const value = auditFixture();
    const tied = snapshot(value);
    const competitor = tied.candidates.find(
      (candidate) => candidate.candidateId !== value.receipt.selectedSkillContentHash,
    )!;
    tied.candidates.push({
      ...competitor,
      candidateId: sha256('ashlr:m456:test-candidate:v1\0', 'tied-competitor'),
    });
    tied.candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    tied.cases = cases(tied.candidates).map((entry) => ({
      ...entry,
      query: {
        ...entry.query,
        title: 'deterministic evidence',
        detail: `cutoff ambiguity ${entry.caseId.slice(0, 12)}`,
      },
    }));
    const result = evaluateSkillRetrievalCalibration(
      input(value, tied, structuredClone(tied)),
    );

    expect(result).toMatchObject({
      gate: 'withheld',
      reason: 'thresholds-not-met',
      selectedCandidateBindingVerified: true,
      choiceSetBindingVerified: false,
    });
    expect(result.routing?.ambiguousCutoffCases).toBe(tied.cases.length);
    expect(result.routing?.positiveSelectedPassed).toBe(100);
  });

  it('excludes unsettled cases and rejects future cases', () => {
    const value = auditFixture();
    const recent = snapshot(value);
    recent.cases = recent.cases.map((entry) => ({
      ...entry,
      observedAt: '2026-07-22T12:29:00.000Z',
    }));
    expect(evaluateSkillRetrievalCalibration(
      input(value, recent, structuredClone(recent)),
    )).toMatchObject({ gate: 'collecting', reason: 'settlement-window' });

    const future = snapshot(value);
    future.cases[0] = { ...future.cases[0]!, observedAt: '2026-07-22T12:31:00.000Z' };
    expect(evaluateSkillRetrievalCalibration(
      input(value, future, structuredClone(future)),
    )).toMatchObject({ gate: 'withheld', reason: 'source-invalid' });
  });

  it('rejects duplicate case, cluster, and candidate identities', () => {
    const value = auditFixture();
    const duplicateCase = snapshot(value);
    duplicateCase.cases[1] = {
      ...duplicateCase.cases[1]!,
      caseId: duplicateCase.cases[0]!.caseId,
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, duplicateCase, structuredClone(duplicateCase)),
    ).reason).toBe('duplicate-input');

    const duplicateCluster = snapshot(value);
    duplicateCluster.cases[1] = {
      ...duplicateCluster.cases[1]!,
      clusterId: duplicateCluster.cases[0]!.clusterId,
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, duplicateCluster, structuredClone(duplicateCluster)),
    ).reason).toBe('duplicate-input');

    const duplicateCandidate = snapshot(value);
    duplicateCandidate.candidates[1] = {
      ...duplicateCandidate.candidates[1]!,
      candidateId: duplicateCandidate.candidates[0]!.candidateId,
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, duplicateCandidate, structuredClone(duplicateCandidate)),
    ).reason).toBe('duplicate-input');
  });

  it('rejects unknown fields, invalid ownership, and malformed query metadata', () => {
    const value = auditFixture();
    const unknown = snapshot(value) as SkillRetrievalCalibrationSnapshotV1 & {
      eligible?: boolean;
    };
    unknown.eligible = true;
    expect(evaluateSkillRetrievalCalibration(
      input(value, unknown, structuredClone(unknown)),
    ).reason).toBe('source-invalid');

    const ownership = snapshot(value);
    ownership.cases[0] = {
      ...ownership.cases[0]!,
      ownerCandidateId: 'f'.repeat(64),
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, ownership, structuredClone(ownership)),
    ).reason).toBe('source-invalid');

    const query = snapshot(value);
    query.cases[0] = {
      ...query.cases[0]!,
      query: { ...query.cases[0]!.query, title: 'x'.repeat(641) },
    };
    expect(evaluateSkillRetrievalCalibration(
      input(value, query, structuredClone(query)),
    ).reason).toBe('source-invalid');
  });

  it('owns byte inputs and rejects proxies, generic typed arrays, and shared buffers', () => {
    const value = auditFixture();
    const valid = input(value);
    const proxied = new Proxy(valid.firstSnapshotBytes, {
      get() {
        throw new Error('hostile view');
      },
    });
    expect(evaluateSkillRetrievalCalibration({
      ...valid,
      firstSnapshotBytes: proxied,
    }).reason).toBe('invalid-input');
    expect(evaluateSkillRetrievalCalibration({
      ...valid,
      firstSnapshotBytes: new Uint16Array([1, 2]) as unknown as Uint8Array,
    }).reason).toBe('invalid-input');
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(evaluateSkillRetrievalCalibration({
        ...valid,
        firstSnapshotBytes: new Uint8Array(new SharedArrayBuffer(16)),
      }).reason).toBe('invalid-input');
    }

    const outer = new Proxy(valid, {
      ownKeys() {
        throw new Error('hostile record');
      },
    });
    expect(evaluateSkillRetrievalCalibration(outer).reason).toBe('invalid-input');

    class LyingBytes extends Uint8Array {
      override get byteLength(): number {
        return 1;
      }

      override get buffer(): ArrayBuffer {
        return new ArrayBuffer(1);
      }
    }
    expect(projectExternalSkillCandidateMetadata(new LyingBytes((256 * 1024) + 1)))
      .toBeNull();
  });

  it('never returns raw private text or caller authority fields', () => {
    const value = auditFixture();
    const raw = input(value);
    const source = JSON.parse(raw.firstSnapshotBytes.toString('utf8')) as Record<string, unknown>;
    source['rawPrompt'] = 'RAW_PROMPT_CANARY';
    const invalid = evaluateSkillRetrievalCalibration({
      ...raw,
      firstSnapshotBytes: canonical(source),
      secondSnapshotBytes: canonical(source),
    });
    expect(JSON.stringify(invalid)).not.toContain('RAW_PROMPT_CANARY');
    expect(invalid.evidenceRoot).toBeNull();

    const result = evaluateSkillRetrievalCalibration(raw);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(value.receipt.selectedSkillName);
    expect(serialized).not.toContain('Guides documentation work');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('"eligible"');
    expect(result).toMatchObject(falseAuthority);
  });

  it('has no runtime consumer and remains absent from runtime package exports', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sourceRoot = join(root, 'src');
    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const target = /(?:^|\/)skill-retrieval-calibration\.js(?:[?#].*)?$/;
    const sourceFiles = (directory: string): string[] => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
    });
    const moduleText = (node: ts.Expression | undefined): string | null => {
      if (node === undefined) return null;
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }
      if (ts.isParenthesizedExpression(node)) return moduleText(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = moduleText(node.left);
        const right = moduleText(node.right);
        return left === null || right === null ? null : left + right;
      }
      return null;
    };
    const importIsTypeOnly = (node: ts.ImportDeclaration): boolean => {
      const clause = node.importClause;
      if (!clause) return false;
      if (clause.isTypeOnly) return true;
      return clause.name === undefined && clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
    };

    for (const path of sourceFiles(sourceRoot)) {
      const sourceFile = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const inspect = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && target.test(moduleText(node.moduleSpecifier) ?? '')) {
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'import',
            typeOnly: importIsTypeOnly(node),
          });
        } else if (ts.isExportDeclaration(node) &&
          target.test(moduleText(node.moduleSpecifier) ?? '')) {
          const namedTypeOnly = node.exportClause !== undefined &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly);
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'export',
            typeOnly: node.isTypeOnly || namedTypeOnly,
          });
        } else if (ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          target.test(moduleText(node.moduleReference.expression) ?? '')) {
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'import-equals',
            typeOnly: node.isTypeOnly,
          });
        } else if (ts.isCallExpression(node)) {
          const specifier = moduleText(node.arguments[0]);
          if (target.test(specifier ?? '')) {
            references.push({
              file: relative(root, path).replaceAll('\\', '/'),
              kind: node.expression.kind === ts.SyntaxKind.ImportKeyword
                ? 'dynamic-import'
                : ts.isIdentifier(node.expression) && node.expression.text === 'require'
                  ? 'require'
                  : 'literal-call',
              typeOnly: false,
            });
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    }

    expect(references).toEqual([{
      file: 'src/api/types.ts',
      kind: 'export',
      typeOnly: true,
    }]);

    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './core',
      './package.json',
      './plugin',
      './types',
    ]);
    expect(JSON.stringify(packageJson.exports)).not.toContain('skill-retrieval-calibration');
    for (const directory of ['bin', 'scripts', 'dist']) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const file of sourceFiles(path)) {
        if (directory === 'dist' && file.endsWith('.d.ts')) continue;
        if (relative(root, file).replaceAll('\\', '/') ===
          'dist/core/fleet/skill-retrieval-calibration.js') {
          continue;
        }
        expect(readFileSync(file, 'utf8')).not.toContain('skill-retrieval-calibration');
      }
    }
    expect(readFileSync(join(root, 'bin', 'ashlr'), 'utf8'))
      .not.toContain('skill-retrieval-calibration');
    const blockedImport = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import('@ashlr/hub/core/fleet/skill-retrieval-calibration.js')",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(blockedImport.status).not.toBe(0);
    expect(blockedImport.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
