import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  evaluateSkillRoutingCalibration,
  type SkillRoutingCalibrationSnapshotV1,
} from '../src/core/fleet/skill-routing-calibration.js';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_ROOT, '..');
const FIXTURE_ROOT = join(TEST_ROOT, 'fixtures', 'm454');
const PROVENANCE_PATH = join(FIXTURE_ROOT, 'agent-skills-ff2df4c.provenance.json');
const SNAPSHOT_PATH = join(FIXTURE_ROOT, 'agent-skills-ff2df4c.snapshot.json');
const UPSTREAM_COMMIT = 'ff2df4c07e7836a092ed28e1e9b42f4d6009280c';
const PINNED_SNAPSHOT_DIGEST = '2619a37d660c1d6f63936b7f56f47288d1082e0b9ae504c0d03ed81ea63d7178';
const SELECTED_SOURCE_DIGEST = '150db656d5bac8ad076268d13d715e77c1b578b5f1b56bf4de95683c18eda13b';
const SOURCE_CANONICAL_DIGEST = '06309cbea8afd81a24d882e91ff40f16cd8924fb93569388a9a06e5cb8c7260e';
const IMPLEMENTATION_DIGEST = '152423a072c09a7cac0907a5e5877248121912a2f2e255f408d912562f8377ee';
const EXTRACTOR_DIGEST = 'd8d807dc66a91b22636df64a35f66f67282bbbdeec6fd5740aedd9ed51c3011f';
const OPAQUE_ID_RE = /^[a-f0-9]{64}$/;
const IMPLEMENTATION_FILES = [
  ['src/core/fleet/skill-routing-calibration.ts', '1c9c81bf135b691c404b98d83520f6e60cd113244533ebd286b00acdc7d7578c'],
  ['src/core/fleet/skill-routing-calibration-snapshot.ts', 'fd891a327b7cbc55f1d4c0e3efc09935e134ba6ed978c8444ef9bdfa697a95b2'],
  ['dist/core/fleet/skill-routing-calibration.js', 'cccc98227e8ad95ec78c1ab848cfa0d3b919de03816f0148f9bff41c4b654192'],
  ['dist/core/fleet/skill-routing-calibration-snapshot.js', '093aea3bbaca6da4742a0a18e73e4c0ed9386c577cae91afebc620f383c6ea4f'],
] as const;

const PROVENANCE_KEYS = [
  'schemaVersion', 'fixtureId', 'state', 'authority', 'metadataOnly', 'rawTextIncluded',
  'provenanceState', 'repository', 'commit', 'commitTree', 'skillsTree', 'casesTree',
  'license', 'licenseDigest', 'declaredPackDigest', 'declaredPortablePackDigest',
  'declaredExternalAuditPolicyDigest', 'externalAuditTrialReady', 'selectedSourceDigest',
  'sourceCanonicalDigest', 'snapshotDigest', 'implementationDigest', 'extractorDigest',
  'gitExecutableDigest', 'extractionPolicyVersion', 'projectionPolicyVersion',
  'routerPolicyVersion', 'keyHandling', 'keyHandlingVerified', 'keyPublished',
  'keyCommitmentPublished', 'exactRegeneration', 'semanticRegeneration', 'sourceReadCount',
  'sourceReadsMatched', 'projectedSnapshotsMatched', 'independentReadsVerified',
  'authenticatedAcquisition', 'authenticatedCustody', 'independentReadCustodyAuthenticated',
  'publicationOrder', 'pairAtomic', 'coverage', 'observedAt', 'asOf', 'timeSemantics',
  'routingAuthority', 'learningAuthority',
  'policyAuthority', 'promotionAuthority', 'proposalAuthority', 'verificationAuthority',
  'mergeAuthority', 'releaseAuthority', 'deploymentAuthority',
] as const;

const SNAPSHOT_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'projectionPolicyVersion',
  'sourceState', 'complete', 'invalidRows', 'duplicateRows', 'conflictingRows',
  'limitExceeded', 'skills', 'cases',
] as const;

const UPSTREAM_SKILL_NAMES = [
  'api-and-interface-design',
  'browser-testing-with-devtools',
  'ci-cd-and-automation',
  'code-review-and-quality',
  'code-simplification',
  'context-engineering',
  'debugging-and-error-recovery',
  'deprecation-and-migration',
  'documentation-and-adrs',
  'doubt-driven-development',
  'frontend-ui-engineering',
  'git-workflow-and-versioning',
  'idea-refine',
  'incremental-implementation',
  'interview-me',
  'observability-and-instrumentation',
  'performance-optimization',
  'planning-and-task-breakdown',
  'security-and-hardening',
  'shipping-and-launch',
  'source-driven-development',
  'spec-driven-development',
  'test-driven-development',
  'using-agent-skills',
] as const;

interface M454CoverageV1 {
  skills: number;
  selectedFiles: number;
  positiveCases: number;
  positiveTopK1Cases: number;
  positiveTopK3Cases: number;
  allNegativeCases: number;
  includedOwnerQualifiedNegativeCases: number;
  ownerlessNegativeCases: number;
  behavioralCasesExcluded: number;
}

interface M454ProvenanceV1 {
  schemaVersion: 1;
  fixtureId: string;
  state: 'challenge-only';
  authority: 'observation-only';
  metadataOnly: true;
  rawTextIncluded: false;
  provenanceState: 'review-pinned-unverified';
  repository: string;
  commit: string;
  commitTree: string;
  skillsTree: string;
  casesTree: string;
  license: 'MIT';
  licenseDigest: string;
  declaredPackDigest: string;
  declaredPortablePackDigest: string;
  declaredExternalAuditPolicyDigest: string;
  externalAuditTrialReady: false;
  selectedSourceDigest: string;
  sourceCanonicalDigest: string;
  snapshotDigest: string;
  implementationDigest: string;
  extractorDigest: string;
  gitExecutableDigest: string;
  extractionPolicyVersion: string;
  projectionPolicyVersion: string;
  routerPolicyVersion: string;
  keyHandling: 'ephemeral-random-32-byte-buffer-zeroized-best-effort';
  keyHandlingVerified: false;
  keyPublished: false;
  keyCommitmentPublished: false;
  exactRegeneration: 'unsupported-without-original-key';
  semanticRegeneration: 'fresh-key-aggregate-equivalent';
  sourceReadCount: 2;
  sourceReadsMatched: true;
  projectedSnapshotsMatched: true;
  independentReadsVerified: false;
  authenticatedAcquisition: false;
  authenticatedCustody: false;
  independentReadCustodyAuthenticated: false;
  publicationOrder: 'snapshot-then-provenance-commit-marker';
  pairAtomic: false;
  coverage: M454CoverageV1;
  observedAt: string;
  asOf: string;
  timeSemantics: 'evaluator-fixture-only';
  routingAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  proposalAuthority: false;
  verificationAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deploymentAuthority: false;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(bytes: Buffer): string {
  return sha256(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

function readCanonicalJson<T>(path: string): { bytes: Buffer; value: T } {
  const bytes = readFileSync(path);
  const value = JSON.parse(bytes.toString('utf8')) as T;
  expect(bytes.toString('utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`);
  return { bytes, value };
}

function loadRepeatedFixtureReads(): {
  firstProvenance: M454ProvenanceV1;
  secondProvenance: M454ProvenanceV1;
  firstSnapshot: SkillRoutingCalibrationSnapshotV1;
  secondSnapshot: SkillRoutingCalibrationSnapshotV1;
  provenanceBytes: Buffer;
  snapshotBytes: Buffer;
} {
  const firstProvenance = readCanonicalJson<M454ProvenanceV1>(PROVENANCE_PATH);
  const firstSnapshot = readCanonicalJson<SkillRoutingCalibrationSnapshotV1>(SNAPSHOT_PATH);
  const secondProvenance = readCanonicalJson<M454ProvenanceV1>(PROVENANCE_PATH);
  const secondSnapshot = readCanonicalJson<SkillRoutingCalibrationSnapshotV1>(SNAPSHOT_PATH);
  return {
    firstProvenance: firstProvenance.value,
    secondProvenance: secondProvenance.value,
    firstSnapshot: firstSnapshot.value,
    secondSnapshot: secondSnapshot.value,
    provenanceBytes: firstProvenance.bytes,
    snapshotBytes: firstSnapshot.bytes,
  };
}

function expectExactKeys(value: object, expected: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

function expectSortedUnique(values: readonly string[]): void {
  expect(new Set(values).size).toBe(values.length);
  expect(values).toEqual([...values].sort());
}

function histogram(values: readonly number[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[String(value)] = (result[String(value)] ?? 0) + 1;
  return result;
}

function recursiveFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? recursiveFiles(path) : [path];
  });
}

describe('M454 pinned upstream routing challenge', () => {
  it('binds canonical split fixtures to reviewed Git objects and implementations', () => {
    const {
      firstProvenance,
      secondProvenance,
      firstSnapshot,
      secondSnapshot,
      snapshotBytes,
    } = loadRepeatedFixtureReads();
    expect(firstProvenance).toEqual(secondProvenance);
    expect(firstSnapshot).toEqual(secondSnapshot);
    expectExactKeys(firstProvenance, PROVENANCE_KEYS);
    expectExactKeys(firstSnapshot, SNAPSHOT_KEYS);
    expect(firstProvenance).toMatchObject({
      schemaVersion: 1,
      fixtureId: 'm454-agent-skills-ff2df4c',
      state: 'challenge-only',
      authority: 'observation-only',
      metadataOnly: true,
      rawTextIncluded: false,
      provenanceState: 'review-pinned-unverified',
      repository: 'addyosmani/agent-skills',
      commit: UPSTREAM_COMMIT,
      commitTree: '36876efd1595ee7ff6c487d579b14d7bca68c4a3',
      skillsTree: '06cca6b1b013edccc3e4a17786796fa0e36ea06f',
      casesTree: '4c20914d56f32558f66d62fee0a32f522fed48d9',
      license: 'MIT',
      licenseDigest: '6f202f8bd568cd730dbb2b0d1f8e243bc74c2fa1f64dbce9b2c7ea08bd5c9fd7',
      declaredPackDigest: 'b4e5b36cc59ae906dc8b6190c5b4224b53b3c71366bbaa48544d79af37a11670',
      declaredPortablePackDigest: 'a623e71881424201a414ddb5ade72c7c9ee680cabcd834ee26f39e72d1675523',
      declaredExternalAuditPolicyDigest: 'b1353f227d80c2d86321d629a08904294ddb7984254f47cd32ee241dc43f9ce5',
      externalAuditTrialReady: false,
      selectedSourceDigest: SELECTED_SOURCE_DIGEST,
      sourceCanonicalDigest: SOURCE_CANONICAL_DIGEST,
      implementationDigest: IMPLEMENTATION_DIGEST,
      extractorDigest: EXTRACTOR_DIGEST,
      gitExecutableDigest: expect.stringMatching(OPAQUE_ID_RE),
      extractionPolicyVersion: 'm454-agent-skills-upstream-v2',
      projectionPolicyVersion: 'm453-token-counts-v1',
      routerPolicyVersion: 'm450-tfidf-v1',
      keyHandling: 'ephemeral-random-32-byte-buffer-zeroized-best-effort',
      keyHandlingVerified: false,
      keyPublished: false,
      keyCommitmentPublished: false,
      exactRegeneration: 'unsupported-without-original-key',
      semanticRegeneration: 'fresh-key-aggregate-equivalent',
      sourceReadCount: 2,
      sourceReadsMatched: true,
      projectedSnapshotsMatched: true,
      independentReadsVerified: false,
      authenticatedAcquisition: false,
      authenticatedCustody: false,
      independentReadCustodyAuthenticated: false,
      publicationOrder: 'snapshot-then-provenance-commit-marker',
      pairAtomic: false,
      observedAt: '2026-07-24T09:04:23.000Z',
      asOf: '2026-07-24T09:07:23.000Z',
      timeSemantics: 'evaluator-fixture-only',
    });
    expect(firstSnapshot).toMatchObject({
      sourceRevision: `agent-skills-${UPSTREAM_COMMIT}`,
      routerPolicyVersion: firstProvenance.routerPolicyVersion,
      projectionPolicyVersion: firstProvenance.projectionPolicyVersion,
      sourceState: 'healthy',
      complete: true,
      invalidRows: 0,
      duplicateRows: 0,
      conflictingRows: 0,
      limitExceeded: false,
    });
    expect(firstProvenance.snapshotDigest).toBe(PINNED_SNAPSHOT_DIGEST);
    expect(sha256(snapshotBytes)).toBe(PINNED_SNAPSHOT_DIGEST);

    const implementationInput: unknown[] = ['ashlr.m454.projection-implementation.v1'];
    for (const [path, expectedDigest] of IMPLEMENTATION_FILES) {
      const actualDigest = sha256Text(readFileSync(join(REPO_ROOT, path)));
      expect(actualDigest).toBe(expectedDigest);
      implementationInput.push([path, actualDigest]);
    }
    expect(sha256(Buffer.from(JSON.stringify(implementationInput), 'utf8'))).toBe(IMPLEMENTATION_DIGEST);
    expect(sha256(readFileSync(join(REPO_ROOT, 'scripts', 'generate-m454-agent-skills-challenge.mjs'))))
      .toBe(EXTRACTOR_DIGEST);
  });

  it('contains only opaque, domain-separated identifiers and bounded counts', () => {
    const { firstProvenance, firstSnapshot, provenanceBytes, snapshotBytes } = loadRepeatedFixtureReads();
    const encoded = Buffer.concat([provenanceBytes, snapshotBytes]).toString('utf8');
    for (const rawCanary of [
      ...UPSTREAM_SKILL_NAMES,
      'Write a failing test for this bug before fixing it',
      'Implement the streak calculator using red-green-refactor',
      'Update the architecture diagram in the docs',
      'Tag and publish the release',
      '"prompt"',
      '"description"',
      '"skill_name"',
      '"expected_output"',
      '"expectations"',
      '"files"',
      '"textParts"',
    ]) {
      expect(encoded).not.toContain(rawCanary);
    }

    const skillIds = firstSnapshot.skills.map((skill) => skill.skillId);
    const caseIds = firstSnapshot.cases.map((entry) => entry.caseId);
    const termIds = firstSnapshot.skills
      .flatMap((skill) => skill.vector.map((term) => term.termId))
      .concat(firstSnapshot.cases.flatMap((entry) => entry.vector.map((term) => term.termId)));
    expectSortedUnique(skillIds);
    expectSortedUnique(caseIds);
    expect(skillIds.every((id) => OPAQUE_ID_RE.test(id))).toBe(true);
    expect(caseIds.every((id) => OPAQUE_ID_RE.test(id))).toBe(true);
    expect(termIds.every((id) => OPAQUE_ID_RE.test(id))).toBe(true);
    expect(skillIds.some((id) => caseIds.includes(id))).toBe(false);
    expect(skillIds.some((id) => termIds.includes(id))).toBe(false);
    expect(caseIds.some((id) => termIds.includes(id))).toBe(false);

    for (const skill of firstSnapshot.skills) {
      expectExactKeys(skill, ['skillId', 'vector']);
      expect(skill.vector.length).toBeGreaterThan(0);
      expectSortedUnique(skill.vector.map((term) => term.termId));
      for (const term of skill.vector) {
        expectExactKeys(term, ['termId', 'count']);
        expect(Number.isSafeInteger(term.count)).toBe(true);
        expect(term.count).toBeGreaterThan(0);
        expect(term.count).toBeLessThanOrEqual(1_000_000);
      }
    }
    for (const calibrationCase of firstSnapshot.cases) {
      expectExactKeys(calibrationCase, [
        'caseId', 'kind', 'ownerSkillId', 'excludedSkillId', 'observedAt', 'vector',
      ]);
      expect(skillIds).toContain(calibrationCase.ownerSkillId);
      expect(calibrationCase.vector.length).toBeGreaterThan(0);
      expectSortedUnique(calibrationCase.vector.map((term) => term.termId));
      for (const term of calibrationCase.vector) {
        expectExactKeys(term, ['termId', 'count']);
        expect(Number.isSafeInteger(term.count)).toBe(true);
        expect(term.count).toBeGreaterThan(0);
        expect(term.count).toBeLessThanOrEqual(1_000_000);
      }
      if (calibrationCase.kind === 'positive-owner') {
        expect(calibrationCase.excludedSkillId).toBeNull();
      } else {
        expect(skillIds).toContain(calibrationCase.excludedSkillId);
        expect(calibrationCase.excludedSkillId).not.toBe(calibrationCase.ownerSkillId);
      }
    }
    expect(firstProvenance.rawTextIncluded).toBe(false);
  });

  it('preserves coverage and owner topology without inventing ownerless negatives', () => {
    const { firstProvenance, firstSnapshot } = loadRepeatedFixtureReads();
    expectExactKeys(firstProvenance.coverage, [
      'skills', 'selectedFiles', 'positiveCases', 'positiveTopK1Cases', 'positiveTopK3Cases',
      'allNegativeCases',
      'includedOwnerQualifiedNegativeCases', 'ownerlessNegativeCases',
      'behavioralCasesExcluded',
    ]);
    expect(firstProvenance.coverage).toEqual({
      skills: 24,
      selectedFiles: 48,
      positiveCases: 76,
      positiveTopK1Cases: 4,
      positiveTopK3Cases: 72,
      allNegativeCases: 48,
      includedOwnerQualifiedNegativeCases: 38,
      ownerlessNegativeCases: 10,
      behavioralCasesExcluded: 29,
    });
    expect(Object.values(firstProvenance.coverage).every(Number.isSafeInteger)).toBe(true);

    const positives = firstSnapshot.cases.filter((entry) => entry.kind === 'positive-owner');
    const negatives = firstSnapshot.cases.filter((entry) => entry.kind === 'negative-owner');
    const positiveByOwner = new Map(firstSnapshot.skills.map((skill) => [skill.skillId, 0]));
    const negativeByOwner = new Map(firstSnapshot.skills.map((skill) => [skill.skillId, 0]));
    for (const entry of positives) {
      positiveByOwner.set(entry.ownerSkillId, (positiveByOwner.get(entry.ownerSkillId) ?? 0) + 1);
    }
    for (const entry of negatives) {
      negativeByOwner.set(entry.ownerSkillId, (negativeByOwner.get(entry.ownerSkillId) ?? 0) + 1);
    }
    expect(firstSnapshot.skills).toHaveLength(24);
    expect(firstSnapshot.cases).toHaveLength(114);
    expect(positives).toHaveLength(76);
    expect(negatives).toHaveLength(38);
    expect(histogram([...positiveByOwner.values()])).toEqual({ 3: 22, 5: 2 });
    expect(histogram([...negativeByOwner.values()])).toEqual({ 0: 6, 1: 9, 2: 3, 3: 3, 4: 1, 5: 2 });
    expect(new Set(negatives.map((entry) => `${entry.ownerSkillId}:${entry.excludedSkillId}`)).size).toBe(38);
    expect(firstProvenance.coverage.includedOwnerQualifiedNegativeCases +
      firstProvenance.coverage.ownerlessNegativeCases).toBe(
      firstProvenance.coverage.allNegativeCases,
    );
    expect(firstSnapshot.cases.every((entry) => entry.observedAt === firstProvenance.observedAt)).toBe(true);
  });

  it('remains collecting with the exact descriptive M450 diagnostics', () => {
    const { firstProvenance, firstSnapshot, secondSnapshot } = loadRepeatedFixtureReads();
    expect(evaluateSkillRoutingCalibration({
      asOf: firstProvenance.asOf,
      firstSnapshot,
      secondSnapshot,
    })).toEqual({
      schemaVersion: 1,
      protocol: 'skill-routing-calibration-v1',
      gate: 'collecting',
      reason: 'insufficient-sample',
      sourceState: 'healthy',
      settledThrough: '2026-07-24T09:05:23.000Z',
      excludedCases: 0,
      sample: {
        skills: 24,
        settledCases: 114,
        positiveCases: 76,
        negativeCases: 38,
        skillsMeetingSampleGate: 0,
        requiredPositivePerSkill: 5,
        requiredNegativePerSkill: 3,
      },
      routing: {
        positiveRankOnePassed: 54,
        positiveRankOneAccuracy: 54 / 76,
        minimumPerSkillRankOneAccuracy: 1 / 3,
        negativeOwnerPassed: 29,
        negativeOwnerAccuracy: 29 / 38,
        requiredRankOneAccuracy: 0.8,
        requiredNegativeOwnerAccuracy: 1,
      },
      collisions: {
        evaluatedPairs: 276,
        warningPairs: 0,
        errorPairs: 0,
        warningThreshold: 0.5,
        errorThreshold: 0.75,
      },
      meetsCalibrationThresholds: null,
      authority: 'observation-only',
      routingAuthority: false,
      learningAuthority: false,
      policyAuthority: false,
      promotionAuthority: false,
      mergeAuthority: false,
    });
  });

  it('settles inclusively and withholds changed repeated snapshots', () => {
    const { firstProvenance, firstSnapshot, secondSnapshot } = loadRepeatedFixtureReads();
    const observedAt = Date.parse(firstProvenance.observedAt);
    expect(evaluateSkillRoutingCalibration({
      asOf: new Date(observedAt + 2 * 60_000 - 1).toISOString(),
      firstSnapshot,
      secondSnapshot,
    })).toMatchObject({
      gate: 'collecting',
      reason: 'settlement-window',
      excludedCases: 114,
      sample: null,
      routing: null,
      collisions: null,
    });
    expect(evaluateSkillRoutingCalibration({
      asOf: new Date(observedAt + 2 * 60_000).toISOString(),
      firstSnapshot,
      secondSnapshot,
    })).toMatchObject({
      gate: 'collecting',
      reason: 'insufficient-sample',
      excludedCases: 0,
      sample: { settledCases: 114 },
    });

    const changed = structuredClone(secondSnapshot);
    changed.skills[0]!.vector[0]!.count += 1;
    expect(evaluateSkillRoutingCalibration({
      asOf: firstProvenance.asOf,
      firstSnapshot,
      secondSnapshot: changed,
    })).toMatchObject({
      gate: 'withheld',
      reason: 'snapshot-mutation',
      sourceState: 'degraded',
      sample: null,
      routing: null,
      collisions: null,
    });
  });

  it('carries no custody, learning, routing, or shipping authority', () => {
    const { firstProvenance } = loadRepeatedFixtureReads();
    expect(firstProvenance).toMatchObject({
      authority: 'observation-only',
      provenanceState: 'review-pinned-unverified',
      externalAuditTrialReady: false,
      independentReadsVerified: false,
      authenticatedAcquisition: false,
      authenticatedCustody: false,
      independentReadCustodyAuthenticated: false,
      routingAuthority: false,
      learningAuthority: false,
      policyAuthority: false,
      promotionAuthority: false,
      proposalAuthority: false,
      verificationAuthority: false,
      mergeAuthority: false,
      releaseAuthority: false,
      deploymentAuthority: false,
    });
  });

  it('has no production, CLI, published-script, or package export consumer', () => {
    const consumerCanaries = [
      'agent-skills-ff2df4c',
      'CONTRACT-M454',
      UPSTREAM_COMMIT,
    ];
    for (const root of [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'dist'), join(REPO_ROOT, 'bin')]) {
      for (const path of recursiveFiles(root)) {
        const source = readFileSync(path, 'utf8');
        for (const canary of consumerCanaries) expect(source).not.toContain(canary);
      }
    }
    for (const path of recursiveFiles(join(REPO_ROOT, 'scripts'))) {
      if (path.endsWith('generate-m454-agent-skills-challenge.mjs')) continue;
      const source = readFileSync(path, 'utf8');
      for (const canary of consumerCanaries) expect(source).not.toContain(canary);
    }

    const packageManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      files?: string[];
      exports?: Record<string, unknown>;
    };
    expect(packageManifest.files).toEqual([
      'dist',
      'bin',
      'scripts/run-verify-command.mjs',
      'schema',
      'CHANGELOG.md',
      'docs/MISSION-OS.md',
      'docs/ELITE-AGENT-EFFICIENCY.md',
      'docs/RUNTIME_ACTIVATION_AUTHORITY.md',
      'docs/contracts/CONTRACT-M515.md',
      'docs/contracts/CONTRACT-M521.md',
      'docs/contracts/CONTRACT-MISSION-RECEIPT-V1.md',
    ]);
    expect(JSON.stringify(packageManifest.exports ?? {})).not.toContain('m454');
    expect(packageManifest.files).not.toContain('test');
    expect(packageManifest.files).not.toContain('scripts/generate-m454-agent-skills-challenge.mjs');

    const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const packRoot = mkdtempSync(join(tmpdir(), 'ashlr-m454-pack-'));
    try {
      const packOutput = execFileSync(
        npmExecutable,
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packRoot],
        { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
      const packed = JSON.parse(packOutput) as Array<{
        filename: string;
        files: Array<{ path: string }>;
      }>;
      const archive = packed[0];
      const packedPaths = archive?.files.map((entry) => entry.path) ?? [];
      expect(packedPaths.length).toBeGreaterThan(0);
      expect(packedPaths).toContain('docs/RUNTIME_ACTIVATION_AUTHORITY.md');
      expect(packedPaths).toContain('docs/contracts/CONTRACT-M521.md');
      expect(packedPaths.filter((path) => /(?:m454|agent-skills|generate-m454)/u.test(path))).toEqual([]);
      const archivePath = join(packRoot, archive?.filename ?? '');
      expect(existsSync(archivePath)).toBe(true);
      expect(statSync(archivePath).size).toBeGreaterThan(0);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
