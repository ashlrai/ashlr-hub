import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateRuntimeReleaseCanaryRollbackEvidence,
  type RuntimeReleaseCanaryRollbackEvidenceArtifact,
  type RuntimeReleaseCanaryRollbackEvidenceInput,
} from '../src/core/daemon/runtime-release-canary-rollback-evidence.js';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  signRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import {
  buildUnsignedRuntimeReleaseManifest,
  parseUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';
import { buildLegacyRuntimeReleaseManifestV2 } from './helpers/runtime-release-legacy-v2.js';

const NOW = '2026-08-06T12:05:00.000Z';
const ISSUED_AT = '2026-08-06T12:00:00.000Z';
const EXPIRES_AT = '2026-08-06T12:10:00.000Z';
const VALID_FROM = '2026-08-06T11:00:00.000Z';
const VALID_UNTIL = '2026-08-06T13:00:00.000Z';
const CANDIDATE_REVISION = 'a'.repeat(40);
const ROLLBACK_REVISION = 'b'.repeat(40);
const tempDirs: string[] = [];

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    value,
    mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode },
  );
}

function releaseManifest(
  marker: string,
  revision: string,
  rollbackTarget: string | null,
  generation: 'candidate-v3' | 'legacy-v2' = 'candidate-v3',
): string {
  const legacyV2 = generation === 'legacy-v2';
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-rollback-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: legacyV2 ? '3.3.2' : '3.4.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: [
      'bin',
      'dist',
      'scripts/run-verify-command.mjs',
      ...(legacyV2 ? [] : ['scripts/scorecard-history-worker.mjs']),
    ],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  }, null, 2)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: legacyV2 ? '3.3.2' : '3.4.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: legacyV2 ? '3.3.2' : '3.4.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  }, null, 2)}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), `export const marker = '${marker}';\n`);
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  if (!legacyV2) {
    write(join(packageRoot, 'scripts', 'scorecard-history-worker.mjs'), 'export const worker = true;\n');
  }
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example', 'index.js'), 'export const example = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(
    join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson,
  );
  const interpreterPath = join(packageRoot, 'fixture-node');
  write(interpreterPath, 'fixture node binary\n', 0o755);
  if (legacyV2) {
    return buildLegacyRuntimeReleaseManifestV2({
      artifactPaths: [
        'bin/ashlr',
        'dist/cli/index.js',
        RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
        'package.json',
        'scripts/run-verify-command.mjs',
      ],
      declaredInterpreterPath: interpreterPath,
      declaredInterpreterVersion: 'v22.0.0',
      expectedPackageName: '@ashlr/hub',
      expectedRevision: revision,
      packageRoot,
      rollbackTargetDigest: rollbackTarget,
    });
  }
  const built = buildUnsignedRuntimeReleaseManifest({
    packageRoot,
    dependencyRoot,
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    expectedRevision: revision,
    declaredRollbackTargetDigest: rollbackTarget,
  });
  if (!built.ok) throw new Error(built.reason);
  return built.canonicalJson;
}

function manifestDigest(manifest: string): string {
  const parsed = parseUnsignedRuntimeReleaseManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.manifest.manifestDigest;
}

function rollbackTargetDigest(manifest: string): string | null {
  const parsed = parseUnsignedRuntimeReleaseManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.manifest.rollbackDeclaration.targetManifestDigest;
}

function trustRoot(publicKey: KeyObject): string {
  const built = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{ publicKey, validFrom: VALID_FROM, validUntil: VALID_UNTIL }],
  });
  if (!built.ok) throw new Error(built.reason);
  return built.canonicalJson;
}

function envelope(manifest: string, privateKey: KeyObject): string {
  const signed = signRuntimeReleaseEvidenceEnvelope({
    manifest,
    privateKey,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  if (!signed.ok) throw new Error(signed.reason);
  return signed.canonicalJson;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validInput(options: {
  candidateGeneration?: 'candidate-v3' | 'legacy-v2';
  rollbackGeneration?: 'candidate-v3' | 'legacy-v2';
} = {}): RuntimeReleaseCanaryRollbackEvidenceInput {
  const keys = generateKeyPairSync('ed25519');
  const root = trustRoot(keys.publicKey);
  const rollbackManifest = releaseManifest(
    'rollback',
    ROLLBACK_REVISION,
    null,
    options.rollbackGeneration ?? 'legacy-v2',
  );
  const rollbackDigest = manifestDigest(rollbackManifest);
  const candidateManifest = releaseManifest(
    'candidate',
    CANDIDATE_REVISION,
    rollbackDigest,
    options.candidateGeneration ?? 'candidate-v3',
  );
  const candidateEnvelope = envelope(candidateManifest, keys.privateKey);
  const rollbackEnvelope = envelope(rollbackManifest, keys.privateKey);
  return {
    observationEnabled: true,
    candidate: {
      envelope: candidateEnvelope,
      manifest: candidateManifest,
      trustRoot: root,
    },
    rollback: {
      envelope: rollbackEnvelope,
      manifest: rollbackManifest,
      trustRoot: root,
    },
    expected: {
      candidateEnvelopeSha256: sha256(candidateEnvelope),
      candidateManifestDigest: manifestDigest(candidateManifest),
      candidateRevision: CANDIDATE_REVISION,
      rollbackEnvelopeSha256: sha256(rollbackEnvelope),
      rollbackManifestDigest: rollbackDigest,
      rollbackRevision: ROLLBACK_REVISION,
      trustRootSha256: sha256(root),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime release canary and rollback evidence', () => {
  it('is disabled by default and performs no verification or execution', () => {
    const junk: RuntimeReleaseCanaryRollbackEvidenceArtifact = {
      envelope: 'not-an-envelope',
      manifest: 'not-a-manifest',
      trustRoot: 'not-a-root',
    };
    const result = evaluateRuntimeReleaseCanaryRollbackEvidence({
      candidate: junk,
      rollback: junk,
      expected: {
        candidateEnvelopeSha256: 'x',
        candidateManifestDigest: 'x',
        candidateRevision: 'x',
        rollbackEnvelopeSha256: 'x',
        rollbackManifestDigest: 'x',
        rollbackRevision: 'x',
        trustRootSha256: 'x',
      },
    });

    expect(result).toMatchObject({
      authority: 'observation-only',
      verdict: 'disabled',
      evidenceReady: false,
      releasePairVerified: false,
      observationEnabled: false,
      deployCanaryPermitted: false,
      rollbackPermitted: false,
      activationPermitted: false,
      executionPerformed: false,
      blockers: [{ code: 'observation-disabled' }],
      immutableBindings: { exactBytesPinned: false },
    });
    expect(result.candidate).toBeNull();
    expect(result.rollback).toBeNull();
  });

  it('verifies a signed immutable release pair without claiming fleet evidence readiness', () => {
    const input = validInput();
    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    const candidate = parseUnsignedRuntimeReleaseManifest(input.candidate.manifest);
    const rollback = parseUnsignedRuntimeReleaseManifest(input.rollback.manifest);
    expect(candidate).toMatchObject({ ok: true, manifest: { schemaVersion: 3 } });
    expect(rollback).toMatchObject({
      ok: true,
      manifest: { package: { version: '3.3.2' }, schemaVersion: 2 },
    });

    expect(result).toMatchObject({
      schemaVersion: 2,
      authority: 'observation-only',
      verdict: 'release-pair-verified',
      evidenceReady: false,
      releasePairVerified: true,
      observationEnabled: true,
      deployCanaryPermitted: false,
      rollbackPermitted: false,
      activationPermitted: false,
      executionPerformed: false,
      immutableBindings: {
        candidateEnvelopeSha256: input.expected.candidateEnvelopeSha256,
        rollbackEnvelopeSha256: input.expected.rollbackEnvelopeSha256,
        trustRootSha256: input.expected.trustRootSha256,
        exactBytesPinned: true,
      },
      candidate: {
        manifestDigest: input.expected.candidateManifestDigest,
        revision: CANDIDATE_REVISION,
        signatureVerified: true,
      },
      rollback: {
        manifestDigest: input.expected.rollbackManifestDigest,
        revision: ROLLBACK_REVISION,
        signatureVerified: true,
      },
      rollbackTarget: {
        declaredManifestDigest: input.expected.rollbackManifestDigest,
        verifiedManifestDigest: input.expected.rollbackManifestDigest,
        matched: true,
      },
      blockers: [],
      authorityBlockers: [
        'protected-remote-pr-unbound',
        'signed-source-and-diff-unbound',
        'verification-commands-unbound',
        'activation-scope-caps-unbound',
        'post-merge-observations-unbound',
        'deployment-consumer-absent',
        'rollback-consumer-absent',
        'activation-authority-unbound',
      ],
      admissionBoundary: {
        protectedRemotePr: {
          bound: false,
          branchProtectionBound: false,
          localFallbackDisabled: false,
          selfTargetExcluded: false,
        },
        signedSourceAndDiff: { bound: false, current: false },
        verification: { commandsBound: false, commandCount: 0 },
        activationScopeCaps: { bound: false, maxFiles: null, maxLines: null },
        postMergeObservations: { bound: false, fresh: false },
      },
    });
  });

  it('blocks a signed schema-v2 candidate downgrade while retaining v2 rollback support', () => {
    const input = validInput({ candidateGeneration: 'legacy-v2' });
    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result).toMatchObject({
      verdict: 'blocked',
      releasePairVerified: false,
      blockers: [{
        code: 'candidate-manifest-schema-unsupported',
        detail: 'The candidate must use current runtime release manifest schema v3.',
      }],
    });
  });

  it('fails closed when immutable envelope and release bindings do not match', () => {
    const input = validInput();
    input.expected.candidateEnvelopeSha256 = 'c'.repeat(64);
    input.expected.rollbackRevision = 'd'.repeat(40);

    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result.verdict).toBe('blocked');
    expect(result.evidenceReady).toBe(false);
    expect(result.releasePairVerified).toBe(false);
    expect(result.immutableBindings.exactBytesPinned).toBe(false);
    expect(result.blockers.map(({ code }) => code)).toEqual([
      'candidate-envelope-identity-mismatch',
      'rollback-release-identity-mismatch',
    ]);
    expect(result.deployCanaryPermitted).toBe(false);
    expect(result.rollbackPermitted).toBe(false);
  });

  it('rejects exactly pinned bytes when the candidate signature is invalid', () => {
    const input = validInput();
    const tampered = JSON.parse(input.candidate.envelope as string) as Record<string, unknown>;
    const signature = tampered['signature'] as string;
    tampered['signature'] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const tamperedEnvelope = `${JSON.stringify(tampered)}\n`;
    input.candidate.envelope = tamperedEnvelope;
    input.expected.candidateEnvelopeSha256 = sha256(tamperedEnvelope);

    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result.immutableBindings.exactBytesPinned).toBe(true);
    expect(result.blockers.map(({ code }) => code)).toEqual([
      'candidate-signature-invalid',
    ]);
    expect(result.candidate).toBeNull();
    expect(result.evidenceReady).toBe(false);
    expect(result.releasePairVerified).toBe(false);
    expect(result.executionPerformed).toBe(false);
  });

  it('rejects a validly signed rollback release that is not the declared target', () => {
    const input = validInput();
    const declaredTarget = rollbackTargetDigest(input.candidate.manifest as string);
    const keys = generateKeyPairSync('ed25519');
    const root = trustRoot(keys.publicKey);
    const otherManifest = releaseManifest('other', 'e'.repeat(40), null);
    const otherEnvelope = envelope(otherManifest, keys.privateKey);
    input.rollback = { envelope: otherEnvelope, manifest: otherManifest, trustRoot: root };
    input.candidate.trustRoot = root;
    input.candidate.envelope = envelope(input.candidate.manifest as string, keys.privateKey);
    input.expected.candidateEnvelopeSha256 = sha256(input.candidate.envelope);
    input.expected.rollbackEnvelopeSha256 = sha256(otherEnvelope);
    input.expected.rollbackManifestDigest = manifestDigest(otherManifest);
    input.expected.rollbackRevision = 'e'.repeat(40);
    input.expected.trustRootSha256 = sha256(root);

    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result.blockers.map(({ code }) => code)).toContain('rollback-target-mismatch');
    expect(result.rollbackTarget).toEqual({
      declaredManifestDigest: declaredTarget,
      verifiedManifestDigest: input.expected.rollbackManifestDigest,
      matched: false,
    });
    expect(result.evidenceReady).toBe(false);
  });

  it('rejects missing rollback declarations and distinct trust-root bytes', () => {
    const input = validInput();
    const candidateKeys = generateKeyPairSync('ed25519');
    const rollbackKeys = generateKeyPairSync('ed25519');
    const candidateRoot = trustRoot(candidateKeys.publicKey);
    const rollbackRoot = trustRoot(rollbackKeys.publicKey);
    const candidateManifest = releaseManifest('candidate-no-target', CANDIDATE_REVISION, null);
    const rollbackManifest = input.rollback.manifest as string;
    const candidateEnvelope = envelope(candidateManifest, candidateKeys.privateKey);
    const rollbackEnvelope = envelope(rollbackManifest, rollbackKeys.privateKey);
    input.candidate = {
      envelope: candidateEnvelope,
      manifest: candidateManifest,
      trustRoot: candidateRoot,
    };
    input.rollback = {
      envelope: rollbackEnvelope,
      manifest: rollbackManifest,
      trustRoot: rollbackRoot,
    };
    input.expected = {
      candidateEnvelopeSha256: sha256(candidateEnvelope),
      candidateManifestDigest: manifestDigest(candidateManifest),
      candidateRevision: CANDIDATE_REVISION,
      rollbackEnvelopeSha256: sha256(rollbackEnvelope),
      rollbackManifestDigest: manifestDigest(rollbackManifest),
      rollbackRevision: ROLLBACK_REVISION,
      trustRootSha256: sha256(candidateRoot),
    };

    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result.blockers.map(({ code }) => code)).toEqual([
      'trust-root-identity-mismatch',
      'trust-root-pair-mismatch',
      'rollback-target-missing',
    ]);
    expect(result.verdict).toBe('blocked');
  });

  it('rejects candidate and rollback evidence for the same revision', () => {
    const input = validInput();
    const keys = generateKeyPairSync('ed25519');
    const root = trustRoot(keys.publicKey);
    const rollbackManifest = releaseManifest('rollback-same-revision', CANDIDATE_REVISION, null);
    const rollbackDigest = manifestDigest(rollbackManifest);
    const candidateManifest = releaseManifest(
      'candidate-same-revision',
      CANDIDATE_REVISION,
      rollbackDigest,
    );
    const candidateEnvelope = envelope(candidateManifest, keys.privateKey);
    const rollbackEnvelope = envelope(rollbackManifest, keys.privateKey);
    input.candidate = { envelope: candidateEnvelope, manifest: candidateManifest, trustRoot: root };
    input.rollback = { envelope: rollbackEnvelope, manifest: rollbackManifest, trustRoot: root };
    input.expected = {
      candidateEnvelopeSha256: sha256(candidateEnvelope),
      candidateManifestDigest: manifestDigest(candidateManifest),
      candidateRevision: CANDIDATE_REVISION,
      rollbackEnvelopeSha256: sha256(rollbackEnvelope),
      rollbackManifestDigest: rollbackDigest,
      rollbackRevision: CANDIDATE_REVISION,
      trustRootSha256: sha256(root),
    };

    const result = evaluateRuntimeReleaseCanaryRollbackEvidence(input);

    expect(result.blockers.map(({ code }) => code)).toEqual(['rollback-self-reference']);
    expect(result.evidenceReady).toBe(false);
  });
});
