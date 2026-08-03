import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const releaseMocks = vi.hoisted(() => ({
  parseManifest: vi.fn(),
  verifyEvidence: vi.fn(),
  evaluateAdmission: vi.fn(),
}));

vi.mock('../src/core/daemon/runtime-release-manifest.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/daemon/runtime-release-manifest.js')>(),
  parseUnsignedRuntimeReleaseManifest: releaseMocks.parseManifest,
}));
vi.mock('../src/core/daemon/runtime-release-evidence-envelope.js', () => ({
  verifyRuntimeReleaseEvidenceEnvelope: releaseMocks.verifyEvidence,
}));
vi.mock('../src/core/daemon/runtime-release-launch-admission.js', () => ({
  evaluateRuntimeReleaseLaunchAdmission: releaseMocks.evaluateAdmission,
}));

import {
  inspectProductionActivationReadinessV1,
} from '../src/core/daemon/production-activation-readiness.js';
import {
  observeProductionArtifactPackagingV1,
} from '../src/core/daemon/production-activation-observations.js';
import type { RuntimeReleaseLaunchObservationOptions } from '../src/core/daemon/runtime-release-launch-revalidation.js';
import type { UnsignedRuntimeReleaseManifest } from '../src/core/daemon/runtime-release-manifest.js';

const MANIFEST_DIGEST = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);
const KEY_ID = `ed25519-sha256:${'c'.repeat(64)}`;
const roots: string[] = [];

function packageFixture(options: { lockfile?: boolean; dependencies?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-production-readiness-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/hub', version: '3.1.0' }));
  if (options.lockfile !== false) writeFileSync(join(root, 'package-lock.json'), '{}\n');
  if (options.dependencies !== false) mkdirSync(join(root, 'node_modules'));
  return root;
}

function launchInput(): RuntimeReleaseLaunchObservationOptions {
  return {
    argv: ['/release/bin/ashlr', 'daemon', 'start'],
    declaredInterpreterPath: '/release/node',
    declaredInterpreterVersion: 'v22.0.0',
    dependencyRoot: '/release/node_modules',
    envelope: Buffer.from('envelope'),
    executablePath: '/release/node',
    expectedEnvelopeCanonicalSha256: 'd'.repeat(64),
    expectedKeyId: KEY_ID,
    expectedManifestDigest: MANIFEST_DIGEST,
    expectedPolicyId: `sha256:${'e'.repeat(64)}`,
    expectedRevision: REVISION,
    expectedServiceInvocationDigest: 'f'.repeat(64),
    expectedStagedTreeIdentity: '1'.repeat(64),
    expectedTrustRootCanonicalSha256: '2'.repeat(64),
    manifest: Buffer.from('manifest'),
    packageRoot: '/release',
    policy: Buffer.from('policy'),
    trustRoot: Buffer.from('trust-root'),
  };
}

function manifest(): UnsignedRuntimeReleaseManifest {
  return {
    manifestDigest: MANIFEST_DIGEST,
    expectedRevision: REVISION,
  } as UnsignedRuntimeReleaseManifest;
}

function healthyResident(findings: Array<{ code: unknown; detail?: unknown }> = []) {
  return { diagnosticStatus: 'blocked' as const, findings };
}

function healthyTip(stopReasons: unknown[] = []) {
  return { sourceState: 'healthy' as const, complete: true, stopReasons };
}

function containsCallable(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsCallable(child, seen));
}

beforeEach(() => {
  releaseMocks.parseManifest.mockReturnValue({ ok: true, manifest: manifest(), canonicalJson: '{}\n' });
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
  releaseMocks.evaluateAdmission.mockReturnValue({
    schemaVersion: 2,
    authority: 'observation-only',
    verdict: 'blocked',
    admissionPermitted: false,
    deployPermitted: false,
    installPermitted: false,
    launchPermitted: false,
    rollbackPermitted: false,
    startPermitted: false,
    blockers: [{
      code: 'atomic-launch-handoff-absent',
      detail: 'descriptors are closed',
    }],
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
      lockfileEvidence: 'package-lock',
      installedDependencyTree: 'present-unattested',
      expectation: {
        schemaVersion: 1,
        packageManifestPath: 'package.json',
        lockfilePath: 'package-lock.json',
        installedDependencyRootPath: 'node_modules',
      },
      reasonCode: 'observed',
    });
  });

  it.each([
    { options: { lockfile: false }, reasonCode: 'lockfile-missing' },
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
    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation: launchInput(),
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
  });

  it('preserves replacement classification but scrubs hostile launch detail', () => {
    releaseMocks.evaluateAdmission.mockReturnValue({
      blockers: [{
        code: 'launch-observation-failed',
        detail: '/private/release changed; Authorization: Bearer secret-value',
      }],
    });

    const report = inspectProductionActivationReadinessV1({
      packageRoot: packageFixture(),
      launchObservation: launchInput(),
      residentServiceDiagnostic: healthyResident(),
      releaseTipObservation: healthyTip(),
    });
    const serialized = JSON.stringify(report);

    expect(report.observations.launchAdmission.blockerCodes).toEqual(['launch-observation-failed']);
    expect(report.blockers.find(({ code }) => code === 'launch-admission-blocked')?.detail)
      .toBe('Closed launch admission remains observation-only and blocked.');
    expect(serialized).not.toContain('/private/release');
    expect(serialized).not.toContain('secret-value');
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

  it('reconstructs launch admission input from declared data-only keys', () => {
    let hookReads = 0;
    const launchObservation = launchInput() as RuntimeReleaseLaunchObservationOptions &
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
    expect(releaseMocks.evaluateAdmission).toHaveBeenCalledOnce();
    const isolated = releaseMocks.evaluateAdmission.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(isolated).sort()).toEqual([
      'argv',
      'declaredInterpreterPath',
      'declaredInterpreterVersion',
      'dependencyRoot',
      'envelope',
      'executablePath',
      'expectedEnvelopeCanonicalSha256',
      'expectedKeyId',
      'expectedManifestDigest',
      'expectedPolicyId',
      'expectedRevision',
      'expectedServiceInvocationDigest',
      'expectedStagedTreeIdentity',
      'expectedTrustRootCanonicalSha256',
      'manifest',
      'packageRoot',
      'policy',
      'trustRoot',
    ]);
    expect(containsCallable(isolated)).toBe(false);
    expect(isolated).not.toHaveProperty('__testHooks');
    expect(isolated).not.toHaveProperty('callback');
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
    expect(releaseMocks.evaluateAdmission).not.toHaveBeenCalled();
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
      'core/daemon/release-current-tip-store.ts',
      'core/daemon/loop.ts',
      'core/daemon/launchd-plist-transaction.ts',
      'core/inbox/merge.ts',
    ];
    const relative = [...visited].map((file) => file.slice(sourceRoot.length + 1));
    for (const path of forbidden) expect(relative).not.toContain(path);
    expect(relative).toContain('core/daemon/activation-trust-roots.ts');
    expect(relative).toContain('core/daemon/runtime-release-launch-revalidation.ts');
  });

  it('keeps the observation module bounded to expected source files', () => {
    const files = readdirSync(resolve(process.cwd(), 'src/core/daemon'));
    expect(files).toContain('production-activation-observations.ts');
    expect(files).toContain('activation-trust-roots.ts');
  });
});
