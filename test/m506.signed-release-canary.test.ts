import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCanaryNpmArguments,
  assertPlainExtractedTree,
  assertRepeatableObservations,
  buildIsolatedEnvironment,
  canonicalCanaryReceipt,
  createSignedObservationReceipt,
  NO_AUTHORITY,
  parseCanaryArgs,
  releaseArchiveArguments,
  SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS,
  SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS,
  SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN,
  verifySelfAuthenticatedCanaryReceipt,
  withReleasePipelineUmask,
} from '../scripts/run-signed-release-canary.mjs';
import {
  verifyReleaseCanaryReceiptBundle,
  verifyReleaseCanaryReceiptBytes,
} from '../scripts/verify-signed-release-canary-receipt.mjs';
import { evaluateRuntimeReleaseCanaryRollbackEvidence } from '../src/core/daemon/runtime-release-canary-rollback-evidence.js';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  signRuntimeReleaseEvidenceEnvelope,
  verifyRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import {
  buildUnsignedRuntimeReleaseManifest,
  parseUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';

const CANDIDATE_REVISION = 'a'.repeat(40);
const ROLLBACK_REVISION = 'b'.repeat(40);
const NOW_MS = Date.now();
const tempDirs: string[] = [];

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, mode === undefined
    ? { encoding: 'utf8' }
    : { encoding: 'utf8', mode });
}

function releaseManifest(
  revision: string,
  rollbackTargetDigest: string | null,
): { canonicalJson: string; manifestDigest: string } {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-script-test-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.2.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs', 'scripts/scorecard-history-worker.mjs'],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  })}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.2.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: '3.2.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  })}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist', 'api', 'index.js'), 'export const fixture = true;\n');
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const fixture = true;\n');
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const fixture = true;\n');
  write(join(packageRoot, 'scripts', 'scorecard-history-worker.mjs'), 'export const worker = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example', 'index.js'), 'export const fixture = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')), inventory.canonicalJson);
  const interpreterPath = join(packageRoot, 'node');
  write(interpreterPath, 'fixture interpreter\n', 0o755);
  const manifest = buildUnsignedRuntimeReleaseManifest({
    packageRoot,
    dependencyRoot,
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.15.0',
    expectedRevision: revision,
    declaredRollbackTargetDigest: rollbackTargetDigest,
  });
  if (!manifest.ok) throw new Error(manifest.reason);
  return { canonicalJson: manifest.canonicalJson, manifestDigest: manifest.manifest.manifestDigest };
}

function release(revision: string, manifest: { canonicalJson: string; manifestDigest: string }) {
  const observation = {
    apiRoot: '/private/temporary-path-never-emitted',
    archiveBuildIdentityProvenance: 'unavailable',
    cliOutputSha256: '1'.repeat(64),
    dependencyInventoryDigest: '2'.repeat(64),
    extractedSourceDirectoryCount: 12,
    extractedSourceEntryCount: 100,
    installedDependencyTreeSha256: '3'.repeat(64),
    manifest: manifest.canonicalJson,
    manifestDigest: manifest.manifestDigest,
    packageCount: 1,
    packageName: '@ashlr/hub',
    packageVersion: '3.2.0',
    packFileCount: 8,
    packIntegrity: 'sha512-fixture',
    packSha256: '4'.repeat(64),
    packShasum: '5'.repeat(40),
    packSize: 100,
    publicExports: ['@ashlr/hub', '@ashlr/hub/core', '@ashlr/hub/types', '@ashlr/hub/plugin'],
    unpackedSize: 200,
  };
  return {
    observations: [observation, { ...observation, apiRoot: '/another/private/path' }],
    primary: observation,
    revision,
  };
}

const evidenceApi = {
  buildRuntimeReleaseEvidenceTrustRoot,
  evaluateRuntimeReleaseCanaryRollbackEvidence,
  signRuntimeReleaseEvidenceEnvelope,
  verifyRuntimeReleaseEvidenceEnvelope,
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

function externalPins(bundle: ReturnType<typeof createSignedObservationReceipt>) {
  return {
    publicKeySpkiSha256: bundle.selfAuthentication.publicKeySpkiSha256,
    signedCanonicalReceiptSha256: bundle.selfAuthentication.signedCanonicalReceiptSha256,
  };
}

function attackerResign(bundle: ReturnType<typeof createSignedObservationReceipt>) {
  const keys = generateKeyPairSync('ed25519');
  const publicKeyBytes = keys.publicKey.export({ type: 'spki', format: 'der' });
  const signedInput = Buffer.from(
    `${SIGNED_RELEASE_CANARY_RECEIPT_SIGNATURE_DOMAIN}\n${JSON.stringify(canonicalValue(bundle.receipt))}`,
    'utf8',
  );
  bundle.selfAuthentication.publicKeySpkiBase64url = publicKeyBytes.toString('base64url');
  bundle.selfAuthentication.publicKeySpkiSha256 = sha256(publicKeyBytes);
  bundle.selfAuthentication.signatureBase64url = cryptoSign(null, signedInput, keys.privateKey).toString('base64url');
  bundle.selfAuthentication.signedCanonicalReceiptSha256 = sha256(signedInput);
  return bundle;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('signed release canary command', () => {
  it('binds immutable archive headers to npm-portable source modes', () => {
    expect(releaseArchiveArguments('/private/source.tar', CANDIDATE_REVISION)).toEqual([
      '-c',
      'tar.umask=0022',
      'archive',
      '--format=tar',
      '--output=/private/source.tar',
      CANDIDATE_REVISION,
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'normalizes a restrictive caller umask for the private release pipeline and always restores it',
    () => {
      const program = `
        import { statSync, writeFileSync } from 'node:fs';
        import { withReleasePipelineUmask } from ${JSON.stringify(
          new URL('../scripts/run-signed-release-canary.mjs', import.meta.url).href,
        )};
        const target = process.argv[1];
        process.umask(0o077);
        const observedInside = await withReleasePipelineUmask(async () => {
          await Promise.resolve();
          writeFileSync(target, 'fixture');
          return process.umask();
        });
        let restoredAfterSuccess = process.umask();
        try {
          await withReleasePipelineUmask(async () => {
            await Promise.resolve();
            throw new Error('fixture failure');
          });
        } catch {}
        const restoredAfterFailure = process.umask();
        process.stdout.write(JSON.stringify({
          mode: statSync(target).mode & 0o777,
          rootMode: statSync(process.argv[2]).mode & 0o777,
          observedInside,
          restoredAfterSuccess,
          restoredAfterFailure,
        }));
      `;
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-umask-test-')));
      tempDirs.push(root);
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', program, join(root, 'file'), root],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        mode: 0o644,
        rootMode: 0o700,
        observedInside: 0o022,
        restoredAfterSuccess: 0o077,
        restoredAfterFailure: 0o077,
      });
    },
  );

  it('rejects ambiguous revisions and mutation-shaped arguments', () => {
    expect(parseCanaryArgs([
      '--candidate', CANDIDATE_REVISION,
      '--expected-revision', CANDIDATE_REVISION,
      '--trusted-protected-source',
    ])).toMatchObject({
      candidate: CANDIDATE_REVISION,
      expectedRevision: CANDIDATE_REVISION,
      trustedProtectedSource: true,
    });
    expect(() => parseCanaryArgs(['--candidate', '-evil'])).toThrow('candidate revision is invalid');
    expect(() => parseCanaryArgs(['--rollback', 'main\npublish'])).toThrow('rollback revision is invalid');
    expect(() => parseCanaryArgs(['--expected-revision', 'A'.repeat(40)]))
      .toThrow('40 lowercase hexadecimal');
    expect(() => parseCanaryArgs(['--publish'])).toThrow('unknown argument');
    expect(() => parseCanaryArgs([
      '--candidate', CANDIDATE_REVISION,
      '--expected-revision', CANDIDATE_REVISION,
    ])).toThrow('trusted-protected-source is required');
    expect(() => parseCanaryArgs([
      '--candidate', CANDIDATE_REVISION,
      '--expected-revision', ROLLBACK_REVISION,
      '--trusted-protected-source',
    ])).toThrow('candidate must exactly match');
  });

  it('allowlists only isolated non-mutating npm operations', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-npm-test-')));
    tempDirs.push(root);
    const prefix = join(root, 'install');
    assertCanaryNpmArguments([
      'install', '/tmp/release.tgz', '--prefix', prefix, '--offline',
      '--ignore-scripts', '--omit=dev',
    ], root);
    expect(() => assertCanaryNpmArguments(['publish'], root)).toThrow('forbidden');
    expect(() => assertCanaryNpmArguments(['run', 'postinstall'], root)).toThrow('only the repository build');
    expect(() => assertCanaryNpmArguments([
      'install', '/tmp/release.tgz', '--prefix', dirname(root), '--offline',
      '--ignore-scripts', '--omit=dev',
    ], root)).toThrow('escaped');
    expect(() => assertCanaryNpmArguments([
      'install', '/tmp/release.tgz', '--prefix', prefix, '--ignore-scripts', '--omit=dev',
    ], root)).toThrow('must be offline');
  });

  it('creates a credential-free environment entirely below the temporary root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-env-test-')));
    tempDirs.push(root);
    const environment = buildIsolatedEnvironment({
      PATH: process.env.PATH,
      NPM_TOKEN: 'must-not-cross',
      GH_TOKEN: 'must-not-cross',
      NODE_AUTH_TOKEN: 'must-not-cross',
      GITHUB_SHA: ROLLBACK_REVISION,
    }, root, CANDIDATE_REVISION);
    expect(environment).not.toHaveProperty('NPM_TOKEN');
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('NODE_AUTH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_SHA');
    for (const name of [
      'HOME', 'TEMP', 'TMP', 'TMPDIR', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG',
    ]) {
      expect(realpathSync(environment[name])).toContain(root);
    }
  });

  it('rejects symbolic links and special files anywhere in an extracted source tree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-canary-tree-test-')));
    tempDirs.push(root);
    write(join(root, 'nested', 'file.txt'), 'safe\n');
    expect(assertPlainExtractedTree(root)).toMatchObject({ directories: 2, entries: 2 });
    const link = join(root, 'nested', 'link');
    symlinkSync('file.txt', link);
    expect(() => assertPlainExtractedTree(root)).toThrow('contains a symbolic link');
    unlinkSync(link);
    const fifo = join(root, 'nested', 'fifo');
    const mkfifo = spawnSync('/usr/bin/mkfifo', [fifo]);
    if (mkfifo.status !== 0) throw new Error('test fixture mkfifo failed');
    expect(() => assertPlainExtractedTree(root)).toThrow('contains a special file');
  });

  it('fails closed when independent observations differ', () => {
    const manifest = releaseManifest(CANDIDATE_REVISION, null);
    const candidate = release(CANDIDATE_REVISION, manifest);
    assertRepeatableObservations(candidate.observations);
    candidate.observations[1] = { ...candidate.observations[1], packSha256: 'f'.repeat(64) };
    expect(() => assertRepeatableObservations(candidate.observations)).toThrow('not byte-identical');
  });

  it('signs a candidate and distinct rollback pair without granting authority', () => {
    const rollbackManifest = releaseManifest(ROLLBACK_REVISION, null);
    const candidateManifest = releaseManifest(CANDIDATE_REVISION, rollbackManifest.manifestDigest);
    const bundle = createSignedObservationReceipt({
      candidate: release(CANDIDATE_REVISION, candidateManifest),
      rollback: release(ROLLBACK_REVISION, rollbackManifest),
    }, evidenceApi, NOW_MS);
    expect(bundle).toMatchObject({
      receipt: {
        assurance: 'signed-observation-only',
        verdict: 'candidate-and-rollback-observed',
        authority: NO_AUTHORITY,
        executionBoundary: {
          confinement: 'not-enforced',
          environmentEffects: 'unattested',
          requiredEnvironment: 'disposable-vm-or-account',
        },
        candidate: { signatureVerified: true, expectedRevision: CANDIDATE_REVISION },
        rollback: { signatureVerified: true, expectedRevision: ROLLBACK_REVISION },
        pair: {
          releasePairVerified: true,
          evidenceReady: false,
          deployCanaryPermitted: false,
          rollbackPermitted: false,
          activationPermitted: false,
          executionPerformed: false,
        },
      },
      selfAuthentication: {
        algorithm: 'ed25519',
        trust: 'self-authenticated-integrity-only-no-external-trust-or-authority',
      },
    });
    expect(bundle.receipt.ephemeralSigner.envelopeLifetimeMs).toBe(SIGNED_RELEASE_CANARY_ENVELOPE_LIFETIME_MS);
    expect(bundle.receipt.ephemeralSigner.keyLifetimeMs).toBe(SIGNED_RELEASE_CANARY_KEY_LIFETIME_MS);
    expect(bundle.receipt.ephemeralSigner.privateKeyPersistence).toBe('memory-only-never-serialized');
    expect(bundle.receipt.candidate.reproducibility)
      .toEqual({ exactMatch: true, independentArchiveExtractInstallBuildPackObservations: 2 });
    expect(bundle.receipt.candidate.sourceTree).toMatchObject({
      buildIdentityProvenance: 'unavailable',
      symbolicLinksOrSpecialFilesAccepted: false,
    });
    const pins = externalPins(bundle);
    expect(verifySelfAuthenticatedCanaryReceipt(bundle)).toBe(false);
    expect(verifySelfAuthenticatedCanaryReceipt(bundle, pins)).toBe(true);
    expect(verifyReleaseCanaryReceiptBundle(bundle, {
      candidateRevision: CANDIDATE_REVISION,
      rollbackRevision: ROLLBACK_REVISION,
    })).toBe(true);
    const emittedBytes = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
    expect(verifyReleaseCanaryReceiptBytes(emittedBytes, {
      candidateRevision: CANDIDATE_REVISION,
      rollbackRevision: ROLLBACK_REVISION,
    })).toBe(sha256(emittedBytes));
    expect(() => verifyReleaseCanaryReceiptBytes(Buffer.alloc(0), {
      candidateRevision: CANDIDATE_REVISION,
      rollbackRevision: ROLLBACK_REVISION,
    })).toThrow('empty or out of bounds');
    expect(() => verifyReleaseCanaryReceiptBytes(Buffer.alloc(1024 * 1024 + 1), {
      candidateRevision: CANDIDATE_REVISION,
      rollbackRevision: ROLLBACK_REVISION,
    })).toThrow('empty or out of bounds');
    expect(() => verifyReleaseCanaryReceiptBundle(bundle, {
      candidateRevision: 'c'.repeat(40),
      rollbackRevision: ROLLBACK_REVISION,
    })).toThrow('NO_AUTHORITY release-pair contract');
    expect(() => verifyReleaseCanaryReceiptBundle(bundle, {
      candidateRevision: CANDIDATE_REVISION,
      rollbackRevision: CANDIDATE_REVISION,
    })).toThrow('must be distinct exact commit SHAs');
    expect(canonicalCanaryReceipt(bundle.receipt)).toContain('"environmentEffects":"unattested"');
    expect(JSON.stringify(bundle)).not.toContain('/private/');
    expect(parseUnsignedRuntimeReleaseManifest(candidateManifest.canonicalJson)).toMatchObject({ ok: true });

    const tampered = structuredClone(bundle);
    tampered.receipt.candidate.packSize += 1;
    attackerResign(tampered);
    expect(verifySelfAuthenticatedCanaryReceipt(tampered, pins)).toBe(false);
    expect(verifySelfAuthenticatedCanaryReceipt(tampered, externalPins(tampered))).toBe(true);

    for (const mutate of [
      (attack: typeof bundle) => { attack.receipt.assurance = 'signed-production-authority'; },
      (attack: typeof bundle) => { attack.receipt.authority.deployPermitted = true; },
      (attack: typeof bundle) => { attack.receipt.executionBoundary.environmentEffects = 'contained'; },
      (attack: typeof bundle) => { attack.receipt.pair.authority = 'deployment-authority'; },
      (attack: typeof bundle) => { attack.receipt.unexpected = true; },
    ]) {
      const attack = structuredClone(bundle);
      mutate(attack);
      attackerResign(attack);
      expect(verifySelfAuthenticatedCanaryReceipt(attack, externalPins(attack))).toBe(false);
      expect(() => verifyReleaseCanaryReceiptBundle(attack, {
        candidateRevision: CANDIDATE_REVISION,
        rollbackRevision: ROLLBACK_REVISION,
      })).toThrow();
    }
  });

  it('rejects any release-pair API regression that attempts to grant authority', () => {
    const rollbackManifest = releaseManifest(ROLLBACK_REVISION, null);
    const candidateManifest = releaseManifest(CANDIDATE_REVISION, rollbackManifest.manifestDigest);
    expect(() => createSignedObservationReceipt({
      candidate: release(CANDIDATE_REVISION, candidateManifest),
      rollback: release(ROLLBACK_REVISION, rollbackManifest),
    }, {
      ...evidenceApi,
      evaluateRuntimeReleaseCanaryRollbackEvidence: () => ({ evidenceReady: true }),
    }, NOW_MS)).toThrow('attempted to grant evidenceReady');
  });

  it('rejects an authority-string regression from the release-pair evaluator before emission', () => {
    const rollbackManifest = releaseManifest(ROLLBACK_REVISION, null);
    const candidateManifest = releaseManifest(CANDIDATE_REVISION, rollbackManifest.manifestDigest);
    expect(() => createSignedObservationReceipt({
      candidate: release(CANDIDATE_REVISION, candidateManifest),
      rollback: release(ROLLBACK_REVISION, rollbackManifest),
    }, {
      ...evidenceApi,
      evaluateRuntimeReleaseCanaryRollbackEvidence: (input: Parameters<
        typeof evaluateRuntimeReleaseCanaryRollbackEvidence
      >[0]) => ({
        ...evaluateRuntimeReleaseCanaryRollbackEvidence(input),
        authority: 'deployment-authority',
      }),
    }, NOW_MS)).toThrow('exact observation-only authority contract');

    expect(() => createSignedObservationReceipt({
      candidate: release(CANDIDATE_REVISION, candidateManifest),
      rollback: release(ROLLBACK_REVISION, rollbackManifest),
    }, {
      ...evidenceApi,
      evaluateRuntimeReleaseCanaryRollbackEvidence: (input: Parameters<
        typeof evaluateRuntimeReleaseCanaryRollbackEvidence
      >[0]) => {
        const evaluated = evaluateRuntimeReleaseCanaryRollbackEvidence(input);
        return { ...evaluated, authorityBlockers: evaluated.authorityBlockers.slice(1) };
      },
    }, NOW_MS)).toThrow('exact observation-only authority contract');
  });

  it('never places a private key or raw manifest in the receipt', () => {
    const manifest = releaseManifest(CANDIDATE_REVISION, null);
    const bundle = createSignedObservationReceipt({
      candidate: release(CANDIDATE_REVISION, manifest),
      rollback: null,
    }, evidenceApi, NOW_MS);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain(manifest.canonicalJson);
    expect(bundle.receipt.rollback).toBeNull();
    expect(verifySelfAuthenticatedCanaryReceipt(bundle, externalPins(bundle))).toBe(true);
  });
});
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
