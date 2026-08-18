import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { isProxy } from 'node:util/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const releaseMocks = vi.hoisted(() => ({
  parseEnvelope: vi.fn(),
  parseManifest: vi.fn(),
  parseTrustRoot: vi.fn(),
  verifyEvidence: vi.fn(),
  verifyManifest: vi.fn(),
}));

vi.mock('../src/core/daemon/runtime-release-manifest.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/daemon/runtime-release-manifest.js')>(),
  parseUnsignedRuntimeReleaseManifest: releaseMocks.parseManifest,
  verifyUnsignedRuntimeReleaseManifest: releaseMocks.verifyManifest,
}));
vi.mock('../src/core/daemon/runtime-release-evidence-envelope.js', () => ({
  parseRuntimeReleaseEvidenceEnvelope: releaseMocks.parseEnvelope,
  parseRuntimeReleaseEvidenceTrustRoot: releaseMocks.parseTrustRoot,
  verifyRuntimeReleaseEvidenceEnvelope: releaseMocks.verifyEvidence,
}));
import {
  inspectProductionActivationReadinessV1,
} from '../src/core/daemon/production-activation-readiness.js';
import {
  observeProductionArtifactPackagingV1,
} from '../src/core/daemon/production-activation-observations.js';
import type { RuntimeReleaseLaunchReadinessInputV1 } from '../src/core/daemon/runtime-release-launch-readiness.js';
import type { UnsignedRuntimeReleaseManifest } from '../src/core/daemon/runtime-release-manifest.js';

const MANIFEST_DIGEST = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);
const KEY_ID = `ed25519-sha256:${'c'.repeat(64)}`;
const roots: string[] = [];

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function bytesDigest(domain: string, value: string | Buffer): string {
  return createHash('sha256').update(domain, 'utf8').update('\n', 'utf8').update(value).digest('hex');
}

function writeInventory(
  root: string,
  packageJson: Record<string, unknown>,
  packages: Array<{
    archiveModeSha256: string;
    contentSha256: string;
    fileCount: number;
    name: string;
    path: string;
    size: number;
    version: string;
  }> = [],
): void {
  const dependencies = (packageJson['dependencies'] ?? {}) as Record<string, string>;
  const packageManifestBytes = readFileSync(join(root, 'package.json'));
  const payload = {
    algorithm: 'sha256',
    assurance: 'packaged-build-byte-observation',
    package: {
      manifestSha256: createHash('sha256').update(packageManifestBytes).digest('hex'),
      name: packageJson['name'],
      version: packageJson['version'],
    },
    packages,
    portability: 'platform-independent-no-native-or-install-variance',
    rootDependencies: Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, requested]) => ({ name, requested })),
    schemaVersion: 2,
  };
  const inventory = {
    ...payload,
    inventoryDigest: contractDigest('ashlr:runtime-release-dependency-inventory:v2', payload),
  };
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist/release-dependency-inventory.json'),
    `${JSON.stringify(canonicalize(inventory))}\n`,
  );
}

function packageFixture(options: { inventory?: boolean; dependencies?: boolean } = {}): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-production-readiness-')));
  const root = join(parent, REVISION);
  mkdirSync(root);
  roots.push(root);
  const packageJson = {
    name: '@ashlr/hub',
    version: '3.1.0',
    bin: { ashlr: 'bin/ashlr' },
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
    dependencies: {},
    bundledDependencies: [],
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin/ashlr'), '#!/usr/bin/env node\n', { mode: 0o755 });
  mkdirSync(join(root, 'dist/cli'), { recursive: true });
  writeFileSync(join(root, 'dist/cli/index.js'), 'export {};\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/run-verify-command.mjs'), 'export {};\n');
  if (options.inventory !== false) writeInventory(root, packageJson);
  if (options.dependencies !== false) {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/.package-lock.json'), '{}\n');
  }
  return root;
}

function chmodTree(path: string, frozen: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, frozen ? 0o555 : 0o755);
    for (const entry of readdirSync(path)) chmodTree(join(path, entry), frozen);
    return;
  }
  const executable = (stat.mode & 0o111) !== 0;
  chmodSync(path, frozen ? (executable ? 0o555 : 0o444) : (executable ? 0o755 : 0o644));
}

let currentManifest: UnsignedRuntimeReleaseManifest;

function launchInput(root: string = roots.at(-1) ?? packageFixture()): RuntimeReleaseLaunchReadinessInputV1 {
  const interpreterPath = join(root, 'fixture-node');
  const interpreterBytes = Buffer.from('fixture interpreter bytes\n');
  writeFileSync(interpreterPath, interpreterBytes, { mode: 0o755 });
  const packaging = observeProductionArtifactPackagingV1(root);
  if (!packaging.inventoryDigest || !packaging.installedTreeSha256 ||
    !packaging.packageName || !packaging.packageVersion || packaging.packageCount === null) {
    throw new Error(`launch fixture packaging is incomplete: ${JSON.stringify(packaging)}`);
  }
  const artifacts: UnsignedRuntimeReleaseManifest['artifacts'] = [];
  const artifactRootSha256 = contractDigest(
    'ashlr:runtime-release-artifact-root:v1',
    artifacts,
  );
  const interpreterContent = {
    executable: true,
    path: interpreterPath,
    sha256: createHash('sha256').update(interpreterBytes).digest('hex'),
    size: interpreterBytes.length,
  };
  const interpreterRootSha256 = contractDigest(
    'ashlr:runtime-release-interpreter-root:v1',
    interpreterContent,
  );
  const expectedStagedTreeIdentity = contractDigest(
    'ashlr:runtime-release-immutable-staged-tree:v1',
    {
      artifactRootSha256,
      dependencyRootSha256: packaging.installedTreeSha256,
      expectedRevision: REVISION,
      interpreterRootSha256,
      manifestDigest: MANIFEST_DIGEST,
    },
  );
  currentManifest = {
    artifacts,
    dependencyInventory: {
      installedDependencyRootSha256: packaging.installedTreeSha256,
      inventoryDigest: packaging.inventoryDigest,
      packageCount: packaging.packageCount,
    },
    expectedRevision: REVISION,
    interpreterDeclaration: {
      claimedVersion: 'v22.0.0',
      declaredPath: interpreterPath,
      observedArtifactSha256: interpreterContent.sha256,
      observedResolvedPath: interpreterPath,
    },
    manifestDigest: MANIFEST_DIGEST,
    package: { name: packaging.packageName, version: packaging.packageVersion },
    rollbackDeclaration: { targetManifestDigest: null },
  } as UnsignedRuntimeReleaseManifest;
  const argv = [join(root, 'bin/ashlr'), 'daemon', 'start'];
  const envelope = Buffer.from('{}\n');
  const policy = Buffer.from('{}\n');
  const trustRoot = Buffer.from('{}\n');
  chmodTree(root, true);
  return {
    argv,
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot: join(root, 'node_modules'),
    envelope,
    executablePath: interpreterPath,
    expectedEnvelopeCanonicalSha256: bytesDigest(
      'ashlr:runtime-release-launch-envelope-canonical:v1',
      envelope,
    ),
    expectedKeyId: KEY_ID,
    expectedManifestDigest: MANIFEST_DIGEST,
    expectedPackageName: '@ashlr/hub',
    expectedPolicyId: `sha256:${bytesDigest(
      'ashlr:runtime-release-launch-policy-canonical:v1',
      policy,
    )}`,
    expectedRevision: REVISION,
    expectedServiceInvocationDigest: contractDigest(
      'ashlr:runtime-release-service-invocation:v1',
      { argv, executablePath: interpreterPath },
    ),
    expectedStagedTreeIdentity,
    expectedTrustRootCanonicalSha256: bytesDigest(
      'ashlr:runtime-release-launch-trust-root-canonical:v1',
      trustRoot,
    ),
    manifest: Buffer.from('manifest'),
    packageRoot: root,
    policy,
    trustRoot,
  };
}

function healthyResident(findings: Array<{ code: unknown; detail?: unknown }> = []) {
  return { diagnosticStatus: 'blocked' as const, findings };
}

function healthyTip(stopReasons: unknown[] = []) {
  return { sourceState: 'healthy' as const, complete: true, stopReasons };
}

beforeEach(() => {
  releaseMocks.parseEnvelope.mockReturnValue({ ok: true, canonicalJson: '{}\n' });
  releaseMocks.parseManifest.mockImplementation(() => ({
    ok: true,
    manifest: currentManifest,
    canonicalJson: '{}\n',
  }));
  releaseMocks.parseTrustRoot.mockReturnValue({ ok: true, canonicalJson: '{}\n' });
  releaseMocks.verifyEvidence.mockReturnValue({
    ok: true,
    assurance: 'signed-observation-only',
    expiresAt: '2026-08-03T01:00:00.000Z',
    issuedAt: '2026-08-03T00:00:00.000Z',
    keyId: KEY_ID,
    manifestDigest: MANIFEST_DIGEST,
    expectedRevision: REVISION,
    rollbackTargetManifestDigest: null,
    verifiedAtMs: 1,
  });
  releaseMocks.verifyManifest.mockReturnValue({
    ok: true,
    assurance: 'unsigned-observation-only',
    manifestDigest: MANIFEST_DIGEST,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    const parent = dirname(root);
    try {
      chmodTree(parent, false);
    } catch {
      // Hostile fixtures can intentionally remove part of the tree.
    }
    rmSync(parent, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('Production Activation Readiness V1', () => {
  it('observes present runtime packaging requirements without npm assumptions', () => {
    const root = packageFixture();

    expect(observeProductionArtifactPackagingV1(root)).toEqual({
      sourceState: 'healthy',
      complete: true,
      state: 'requirements-present',
      packageManifest: 'present',
      dependencyInventory: 'canonical-package-bytes-matched',
      installedDependencyTree: 'inventory-matched-unsealed-root',
      inventoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      installedTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      packageCount: 0,
      packageName: '@ashlr/hub',
      packageVersion: '3.1.0',
      expectation: {
        schemaVersion: 2,
        packageManifestPath: 'package.json',
        dependencyInventoryPath: 'dist/release-dependency-inventory.json',
        installedDependencyRootPath: 'node_modules',
        installedByteCoverage: 'inventory-v2-package-manifest-bound-root-unsealed',
      },
      reasonCode: 'observed',
    });
  });

  it.each([
    { options: { inventory: false }, reasonCode: 'dependency-inventory-missing' },
    { options: { dependencies: false }, reasonCode: 'dependency-tree-missing' },
  ])('reports missing packaged evidence from the actual runtime tree: $reasonCode', ({ options, reasonCode }) => {
    const observation = observeProductionArtifactPackagingV1(packageFixture(options));

    expect(observation).toMatchObject({
      sourceState: 'missing',
      complete: false,
      state: 'requirements-missing',
      reasonCode,
    });
    const report = inspectProductionActivationReadinessV1({ packageRoot: roots.at(-1) });
    expect(report.topBlocker.code).toBe('artifact-packaging-incompatible');
    expect(report.sourceQuality.reasons).toContain('artifact-packaging');
  });

  it('keeps healthy complete evidence separate from a blocked policy verdict', () => {
    const packageRoot = packageFixture();
    const launchObservation = launchInput(packageRoot);
    const report = inspectProductionActivationReadinessV1({
      packageRoot,
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });

    expect(report.sourceQuality).toEqual({
      sourceState: 'healthy',
      complete: true,
      reasons: [],
    });
    expect(report.verdict).toBe('blocked');
    expect(report.topBlocker.code).toBe('launch-admission-blocked');
    expect(report.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'activation-permit-blocked',
      'release-tip-untrusted',
      'production-authority-chain-absent',
    ]));
    expect(Object.values(report.authorityFlags).every((value) => value === false)).toBe(true);
  });

  it('fails closed on forged release evidence without forwarding its detail', () => {
    const hostile = '/Users/operator/.ssh/id_ed25519 token=super-secret';
    releaseMocks.verifyEvidence.mockReturnValue({ ok: false, reason: hostile });

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation: launchInput(),
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });
    const serialized = JSON.stringify(report);

    expect(report.topBlocker.code).toBe('release-evidence-invalid');
    expect(report.observations.releaseEvidence).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'release-evidence-invalid',
      keyId: null,
    });
    expect(serialized).not.toContain('/Users/operator');
    expect(serialized).not.toContain('super-secret');
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'launch-observation-failed',
      state: 'unavailable',
      blockerCodes: ['launch-observation-failed'],
    });
  });

  it('propagates failed launch observation as degraded and incomplete', () => {
    releaseMocks.parseManifest.mockReturnValue({
      ok: false,
      reason: '/private/release changed; Authorization: Bearer secret-value',
    });

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation: launchInput(),
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });
    const serialized = JSON.stringify(report);

    expect(report.observations.launchAdmission.blockerCodes).toEqual(['launch-observation-failed']);
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
    });
    expect(report.blockers.find(({ code }) => code === 'launch-admission-unavailable')?.detail)
      .toBe('Read-only launch readiness evidence is unavailable or incomplete.');
    expect(serialized).not.toContain('/private/release');
    expect(serialized).not.toContain('secret-value');
  });

  it('marks mismatched caller-pinned launch identities incomplete', () => {
    const launchObservation = launchInput();
    launchObservation.expectedPolicyId = `sha256:${'9'.repeat(64)}`;

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });

    expect(report.observations.releaseManifest.sourceState).toBe('healthy');
    expect(report.observations.releaseEvidence.sourceState).toBe('healthy');
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'launch-observation-failed',
      state: 'unavailable',
      blockerCodes: ['launch-observation-failed'],
    });
    expect(report.sourceQuality.reasons).toContain('launch-admission');
  });

  it('drops hostile resident and release-tip fields from daemon-safe output', () => {
    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation: launchInput(),
      residentServiceDiagnostic: healthyResident([
        { code: 'service-not-running', detail: '/Users/mason/.env API_KEY=hunter2' },
        { code: '/Users/mason/private' },
        { code: 'token-secret-value' },
      ]),
      releaseTipObservation: healthyTip([
        'bootstrap-required',
        '/Users/mason/.ashlr',
        'Authorization:Bearer-secret',
      ]),
    });
    const serialized = JSON.stringify(report);

    expect(report.observations.residentService.findingCodes).toEqual(['service-not-running']);
    expect(report.observations.releaseTip.stopReasons).toEqual(['bootstrap-required']);
    for (const secret of ['/Users/mason', 'hunter2', 'Bearer-secret', 'API_KEY']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('normalizes malformed projected enums to fixed degraded observations', () => {
    const hostileSourceState = '/Users/attacker/.env Authorization: Bearer source-secret';
    const hostileDiagnosticStatus = '/private/attacker/token=diagnostic-secret';
    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      residentServiceDiagnostic: {
        diagnosticStatus: hostileDiagnosticStatus,
        findings: [{ code: 'service-not-running' }],
      } as unknown as Parameters<typeof inspectProductionActivationReadinessV1>[0]['residentServiceDiagnostic'],
      releaseTipObservation: {
        sourceState: hostileSourceState,
        complete: true,
        stopReasons: ['bootstrap-required', hostileSourceState],
      } as unknown as Parameters<typeof inspectProductionActivationReadinessV1>[0]['releaseTipObservation'],
    });
    const serialized = JSON.stringify(report);

    expect(report.observations.residentService).toEqual({
      sourceState: 'degraded',
      complete: false,
      state: 'invalid',
      findingCodes: [],
      reasonCode: 'diagnostic-invalid',
    });
    expect(report.observations.releaseTip).toEqual({
      sourceState: 'degraded',
      complete: false,
      state: 'invalid',
      stopReasons: [],
      reasonCode: 'tip-invalid',
    });
    expect(serialized).not.toContain('/Users/attacker');
    expect(serialized).not.toContain('/private/attacker');
    expect(serialized).not.toContain('source-secret');
    expect(serialized).not.toContain('diagnostic-secret');
  });

  it('does not invoke projected enum accessors', () => {
    let sourceStateReads = 0;
    const releaseTipObservation = {
      complete: true,
      stopReasons: ['bootstrap-required'],
    } as Record<string, unknown>;
    Object.defineProperty(releaseTipObservation, 'sourceState', {
      enumerable: true,
      get() {
        sourceStateReads += 1;
        return '/Users/attacker/source-secret';
      },
    });

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      releaseTipObservation: releaseTipObservation as never,
    });

    expect(sourceStateReads).toBe(0);
    expect(report.observations.releaseTip.reasonCode).toBe('tip-invalid');
    expect(JSON.stringify(report)).not.toContain('source-secret');
  });

  it('reconstructs launch readiness input from declared data-only keys', () => {
    let hookReads = 0;
    const launchObservation = launchInput() as RuntimeReleaseLaunchReadinessInputV1 &
      Record<string, unknown>;
    Object.defineProperty(launchObservation, '__testHooks', {
      enumerable: true,
      get() {
        hookReads += 1;
        return { afterBeforeObservation: vi.fn() };
      },
    });
    launchObservation['callback'] = vi.fn();

    inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation,
    });

    expect(hookReads).toBe(0);
    expect(releaseMocks.parseManifest).toHaveBeenCalledWith(Buffer.from('manifest'));
    expect(releaseMocks.verifyEvidence).toHaveBeenCalledWith({
      envelope: Buffer.from('{}\n'),
      manifest: Buffer.from('manifest'),
      trustRoot: Buffer.from('{}\n'),
    });
  });

  it('rejects declared launch accessors without invoking or forwarding them', () => {
    let manifestReads = 0;
    const launchObservation = launchInput();
    Object.defineProperty(launchObservation, 'manifest', {
      enumerable: true,
      get() {
        manifestReads += 1;
        return Buffer.from('/Users/attacker/manifest-secret');
      },
    });

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation,
    });

    expect(manifestReads).toBe(0);
    expect(releaseMocks.parseManifest).not.toHaveBeenCalled();
    expect(releaseMocks.verifyEvidence).not.toHaveBeenCalled();
    expect(report.observations.releaseManifest.reasonCode).toBe('manifest-invalid');
    expect(report.observations.releaseEvidence.reasonCode).toBe('release-evidence-invalid');
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
    });
    expect(JSON.stringify(report)).not.toContain('/Users/attacker');
    expect(JSON.stringify(report)).not.toContain('manifest-secret');
  });

  it('rejects outer getters without invoking them', () => {
    let packageRootReads = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'packageRoot', {
      enumerable: true,
      get() {
        packageRootReads += 1;
        return '/Users/attacker/package-secret';
      },
    });

    const report = inspectProductionActivationReadinessV1(hostile as never);

    expect(packageRootReads).toBe(0);
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
    });
    expect(JSON.stringify(report)).not.toContain('package-secret');
  });

  it('rejects outer proxies without invoking their traps', () => {
    let trapCalls = 0;
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error('proxy trap must not run');
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error('proxy trap must not run');
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error('proxy trap must not run');
      },
    });
    expect(isProxy(hostile)).toBe(true);

    const report = inspectProductionActivationReadinessV1(hostile as never);

    expect(trapCalls).toBe(0);
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
    });
  });

  it('matches inventoried dependency bytes and fails closed after tampering', () => {
    const root = packageFixture();
    const packageJson = {
      ...JSON.parse(readFileSync(join(root, 'package.json'), 'utf8') as string) as Record<string, unknown>,
      dependencies: { dependency: '1.0.0' },
      bundledDependencies: ['dependency'],
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
    const dependencyRoot = join(root, 'node_modules/dependency');
    mkdirSync(dependencyRoot, { recursive: true });
    const dependencyManifest = Buffer.from(JSON.stringify({ name: 'dependency', version: '1.0.0' }));
    writeFileSync(join(dependencyRoot, 'package.json'), dependencyManifest);
    const files = [{
      path: 'package.json',
      sha256: createHash('sha256').update(dependencyManifest).digest('hex'),
      size: dependencyManifest.length,
    }];
    writeInventory(root, packageJson, [{
      archiveModeSha256: contractDigest(
        'ashlr:runtime-release-dependency-archive-mode:v1',
        [{ mode: 0o644, path: 'package.json' }],
      ),
      contentSha256: contractDigest(
        'ashlr:runtime-release-dependency-package-content:v1',
        files,
      ),
      fileCount: 1,
      name: 'dependency',
      path: 'dependency',
      size: dependencyManifest.length,
      version: '1.0.0',
    }]);

    expect(observeProductionArtifactPackagingV1(root)).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      packageCount: 1,
    });

    writeFileSync(join(dependencyRoot, 'package.json'), '{"name":"dependency","version":"9.9.9"}');
    expect(observeProductionArtifactPackagingV1(root)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      dependencyInventory: 'canonical-package-bytes-matched',
      installedDependencyTree: 'mismatch',
      reasonCode: 'dependency-tree-mismatch',
    });
  });

  it.each([
    'package-root',
    'inventory-digest',
    'installed-tree',
    'staged-tree',
    'interpreter-declaration',
    'package-name',
  ] as const)('blocks a mixed release binding: %s', (mutation) => {
    const root = packageFixture();
    const launchObservation = launchInput(root);
    if (mutation === 'package-root') {
      launchObservation.packageRoot = packageFixture();
    } else if (mutation === 'inventory-digest') {
      currentManifest.dependencyInventory.inventoryDigest = '8'.repeat(64);
    } else if (mutation === 'installed-tree') {
      currentManifest.dependencyInventory.installedDependencyRootSha256 = '7'.repeat(64);
    } else if (mutation === 'staged-tree') {
      launchObservation.expectedStagedTreeIdentity = '6'.repeat(64);
    } else if (mutation === 'interpreter-declaration') {
      currentManifest.interpreterDeclaration.claimedVersion = 'v99.0.0';
    } else {
      launchObservation.expectedPackageName = '@ashlr/not-hub';
    }

    const report = inspectProductionActivationReadinessV1({
      packageRoot: root,
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });

    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      state: 'unavailable',
      reasonCode: 'launch-observation-failed',
    });
    expect(report.sourceQuality.reasons).toContain('launch-admission');
  });

  it('binds unsigned .bin bytes into the signed installed-tree identity', () => {
    const root = packageFixture();
    const launchObservation = launchInput(root);
    chmodTree(join(root, 'node_modules'), false);
    const binRoot = join(root, 'node_modules/.bin');
    mkdirSync(binRoot);
    writeFileSync(join(binRoot, 'injected'), '#!/usr/bin/env node\n', { mode: 0o755 });
    chmodTree(join(root, 'node_modules'), true);

    const report = inspectProductionActivationReadinessV1({
      packageRoot: root,
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });

    expect(report.observations.artifactPackaging.installedTreeSha256)
      .not.toBe(currentManifest.dependencyInventory.installedDependencyRootSha256);
    expect(report.observations.launchAdmission.complete).toBe(false);
    expect(report.sourceQuality.sourceState).toBe('degraded');
  });

  it('rejects world-writable staged bytes even when portable packaging still matches', () => {
    const root = packageFixture();
    const launchObservation = launchInput(root);
    const injected = join(root, 'node_modules/.package-lock.json');
    chmodSync(injected, 0o666);
    expect(observeProductionArtifactPackagingV1(root)).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      installedDependencyTree: 'inventory-matched-unsealed-root',
      reasonCode: 'observed',
    });
    expect(inspectProductionActivationReadinessV1({
      packageRoot: root,
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    }).observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'launch-observation-failed',
    });
  });

  it('rejects hard-linked staged dependency bytes', () => {
    const root = packageFixture();
    const launchObservation = launchInput(root);
    const dependencyRoot = join(root, 'node_modules');
    chmodTree(dependencyRoot, false);
    linkSync(
      join(dependencyRoot, '.package-lock.json'),
      join(dependencyRoot, 'hard-linked-lock.json'),
    );
    chmodTree(dependencyRoot, true);

    const report = inspectProductionActivationReadinessV1({
      packageRoot: root,
      launchObservation,
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });
    expect(report.observations.launchAdmission).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
    expect(report.authorityFlags).toMatchObject({
      activationPermitted: false,
      installPermitted: false,
      launchPermitted: false,
    });
  });

  it.runIf(typeof process.getuid === 'function')(
    'rejects executable evidence not owned by root or the observing user',
    () => {
      const root = packageFixture();
      const launchObservation = launchInput(root);
      const uid = process.getuid!();
      const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        expect(inspectProductionActivationReadinessV1({
          packageRoot: root,
          launchObservation,
          residentServiceDiagnostic: healthyResident(),
          releaseTipObservation: healthyTip(),
        }).observations.launchAdmission).toMatchObject({
          sourceState: 'degraded',
          complete: false,
          reasonCode: 'launch-observation-failed',
        });
      } finally {
        getuid.mockRestore();
      }
    },
  );

  it('deep-freezes every authority-bearing output and nested flag', () => {
    const root = packageFixture();
    const report = inspectProductionActivationReadinessV1({
      packageRoot: root,
      launchObservation: launchInput(root),
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });

    for (const value of [
      report,
      report.authorityFlags,
      report.blockers,
      report.blockers[0],
      report.sourceQuality,
      report.sourceQuality.reasons,
      report.observations,
      report.observations.artifactPackaging,
      report.observations.launchAdmission,
      report.observations.launchAdmission.blockerCodes,
    ]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      (report.authorityFlags as { launchPermitted: boolean }).launchPermitted = true;
    }).toThrow(TypeError);
    expect(() => report.blockers.push(report.blockers[0]!)).toThrow(TypeError);
  });

  it('rejects symlinked and oversized inventory files before parsing', () => {
    const symlinkRoot = packageFixture();
    const inventoryPath = join(symlinkRoot, 'dist/release-dependency-inventory.json');
    rmSync(inventoryPath);
    symlinkSync(join(symlinkRoot, 'package.json'), inventoryPath);
    expect(observeProductionArtifactPackagingV1(symlinkRoot)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'dependency-inventory-unreadable',
    });

    const oversizedRoot = packageFixture();
    writeFileSync(
      join(oversizedRoot, 'dist/release-dependency-inventory.json'),
      Buffer.alloc(512 * 1024 + 1, 0x20),
    );
    expect(observeProductionArtifactPackagingV1(oversizedRoot)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'dependency-inventory-unreadable',
    });
  });

  it('rejects root install variance without claiming portable packaging', () => {
    const root = packageFixture();
    const packageJson = {
      name: '@ashlr/hub',
      version: '3.1.0',
      scripts: { install: 'node install.js' },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson));
    writeInventory(root, packageJson);

    expect(observeProductionArtifactPackagingV1(root)).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      dependencyInventory: 'mismatch',
      reasonCode: 'dependency-inventory-mismatch',
    });
  });

  it('derives degraded source quality only from incomplete observations', () => {
    const report = inspectProductionActivationReadinessV1({ packageRoot: packageFixture() });

    expect(report.sourceQuality).toEqual({
      sourceState: 'degraded',
      complete: false,
      reasons: [
        'release-manifest',
        'release-evidence',
        'launch-admission',
        'resident-service',
        'release-tip',
      ],
    });
    expect(report.sourceQuality.reasons).not.toContain('activation-permit-blocked');
    expect(report.blockers.map(({ code }) => code)).toContain('activation-permit-blocked');
  });

  it('has no exported dependency callback seam', () => {
    const source = readFileSync(
      new URL('../src/core/daemon/production-activation-readiness.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('ProductionActivationReadinessDependencies');
    expect(source).not.toContain('DEFAULT_DEPENDENCIES');
    expect(source).not.toMatch(/inspectProductionActivationReadinessV1\([^)]*,\s*dependencies/);
    expect(source).not.toContain('evaluateRuntimeReleaseLaunchAdmission(input.launchObservation)');
    const publicInput = source.match(
      /export interface InspectProductionActivationReadinessInputV1 \{[\s\S]*?\n\}/,
    )?.[0] ?? '';
    expect(publicInput).not.toMatch(/__testHooks|callback|Function|=>/i);
  });

  it('cannot transitively import lifecycle mutation modules', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const entry = resolve(sourceRoot, 'core/daemon/production-activation-readiness.ts');
    const visited = new Set<string>();
    const pending = [entry];
    const importRe = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        const candidate = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (extname(candidate) === '.ts') pending.push(candidate);
      }
      expect(visited.size).toBeLessThan(64);
    }

    const forbidden = [
      'core/daemon/service.ts',
      'core/daemon/activation-permit.ts',
      'core/daemon/runtime-release-launch-admission.ts',
      'core/daemon/release-current-tip-store.ts',
      'core/daemon/loop.ts',
      'core/daemon/launchd-plist-transaction.ts',
      'core/inbox/merge.ts',
    ];
    const relative = [...visited].map((file) => file.slice(sourceRoot.length + 1));
    for (const path of forbidden) expect(relative).not.toContain(path);
    expect(relative).toContain('core/daemon/activation-trust-roots.ts');
    expect(relative).toContain('core/daemon/runtime-release-launch-readiness.ts');
    expect(relative).toContain('core/daemon/runtime-release-launch-revalidation.ts');
    expect(relative).toContain('core/daemon/runtime-release-packaging-readiness.ts');

    const reachableSource = [...visited].map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(reachableSource).not.toMatch(/\b(?:writeFile|rename|unlink|mkdir|chmod|chown)Sync\b/);
    const readinessSource = readFileSync(
      new URL('../src/core/daemon/runtime-release-launch-readiness.ts', import.meta.url),
      'utf8',
    );
    expect(readinessSource).toContain('observeRuntimeReleaseStagedTreeIdentityReadOnly');
    expect(readinessSource).not.toContain('observeRuntimeReleaseImmutableStagedTree(');
    const revalidationSource = readFileSync(
      new URL('../src/core/daemon/runtime-release-launch-revalidation.ts', import.meta.url),
      'utf8',
    );
    expect(revalidationSource).toContain('observeStage(options, observationDeadline(), false)');
  });

  it('uses bounded no-follow descriptor reads for package and inventory evidence', () => {
    const source = readFileSync(
      new URL('../src/core/daemon/runtime-release-packaging-readiness.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('fsConstants.O_NOFOLLOW');
    expect(source).toContain('fstatSync');
    expect(source).toContain('readSync');
    expect(source).toContain('openedAfter');
    expect(source).toContain('assertDirectoryStable(packageRoot.path, packageRoot.snapshot)');
    expect(source).not.toMatch(/\b(?:writeFile|rename|unlink|mkdir|chmod|chown|fsync)Sync\b/);
  });

  it('keeps the observation module bounded to expected source files', () => {
    const files = readdirSync(resolve(process.cwd(), 'src/core/daemon'));
    expect(files).toContain('production-activation-observations.ts');
    expect(files).toContain('activation-trust-roots.ts');
    expect(files).toContain('runtime-release-launch-readiness.ts');
    expect(files).toContain('runtime-release-packaging-readiness.ts');
  });
});
