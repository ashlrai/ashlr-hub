import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1,
  RUNTIME_ACTIVATION_AUTHORITY_KEY_DOMAIN_V1,
  RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1,
  observeRuntimeActivationExecutionPlan,
  preflightRuntimeActivationAuthority,
  runtimeActivationAuthorityInternals,
  runtimeActivationBuildBindingSha256,
  runtimeActivationAuthorityPaths,
  runtimeActivationRequestCanonicalJson,
  runtimeActivationTrustRootCanonicalJson,
  signRuntimeActivationManifest,
  type RuntimeActivationArtifactBindingV1,
  type RuntimeActivationAuthorityTrustRootV1,
  type RuntimeActivationAuthorityKeyV1,
  type RuntimeActivationBundleRequestV1,
  type RuntimeActivationManifestPayloadV1,
  type RuntimeActivationPreflightRequestV1,
} from '../src/core/daemon/runtime-activation-authority.js';
import {
  activateRuntimeRelease,
  runtimeActivationTransactionInternals,
} from '../src/core/daemon/runtime-activation-transaction.js';
import {
  observeRuntimeActivationLaunchHandoffForVerificationOnly,
} from '../src/core/daemon/runtime-activation-launch-handoff.js';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  runtimeReleaseEvidenceKeyId,
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
import {
  observeRuntimeReleaseImmutableStagedTree,
  runtimeReleaseEnvelopeCanonicalSha256,
  runtimeReleasePolicyId,
  runtimeReleaseServiceInvocationDigest,
  runtimeReleaseTrustRootCanonicalSha256,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';

const roots: string[] = [];

function thawTree(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) thawTree(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    thawTree(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function digest(character: string): string {
  return character.repeat(64);
}

function revision(character: string): string {
  return character.repeat(40);
}

function activationTrustKey(
  publicKey: KeyObject,
  validFrom = '2026-08-10T11:00:00.000Z',
  validUntil = '2026-08-10T13:00:00.000Z',
): RuntimeActivationAuthorityKeyV1 {
  return {
    algorithm: 'ed25519',
    domain: RUNTIME_ACTIVATION_AUTHORITY_KEY_DOMAIN_V1,
    keyId: runtimeReleaseEvidenceKeyId(publicKey)!,
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom,
    validUntil,
  };
}

function binding(seed: number, keyId: string): RuntimeActivationArtifactBindingV1 {
  const chars = '123456789abcdef';
  const at = (offset: number): string => chars[(seed + offset) % chars.length]!;
  const buildInputs: Omit<RuntimeActivationArtifactBindingV1, 'declarationBindingSha256'> = {
    dependencyInventoryDigest: digest(at(0)),
    envelopeCanonicalSha256: digest(at(1)),
    envelopeSha256: digest(at(2)),
    evidenceKeyId: keyId,
    evidenceTrustRootCanonicalSha256: digest(at(3)),
    evidenceTrustRootSha256: digest(at(4)),
    expectedRevision: revision(at(5)),
    expectedTree: revision(at(6)),
    independentlyPackaged: true,
    interpreterSha256: digest(at(7)),
    manifestDigest: digest(at(8)),
    packageTarballSha256: digest(at(9)),
    packageVersion: '3.2.0',
    policyId: `sha256:${digest(at(10))}`,
    runtimeTreeSha256: digest(at(11)),
    releaseTag: 'v3.2.0',
    serviceDescriptorSha256: digest(at(12)),
    serviceInvocationDigest: digest(at(13)),
  };
  return {
    declarationBindingSha256: runtimeActivationBuildBindingSha256(buildInputs),
    ...buildInputs,
  };
}

function execution(home: string): RuntimeActivationManifestPayloadV1['execution'] {
  return {
    configPath: join(home, '.ashlr', 'config.json'),
    configSha256: digest('e'),
    currentPointerPath: join(home, '.local', 'share', 'ashlr', 'current'),
    homePath: home,
    operation: 'activate-resident-release',
    platform: 'darwin',
    prior: {
      currentRevision: revision('f'),
      plistSha256: digest('f'),
      serviceLoaded: false,
    },
    releasesRoot: join(home, '.local', 'share', 'ashlr', 'releases'),
  };
}

interface Fixture {
  home: string;
  now: number;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  trustRoot: RuntimeActivationAuthorityTrustRootV1;
  payload: RuntimeActivationManifestPayloadV1;
  request: RuntimeActivationPreflightRequestV1;
  requestPath: string;
}

function bundle(root: string): RuntimeActivationBundleRequestV1 {
  return {
    argv: [join(root, 'package', 'bin', 'ashlr'), 'daemon', 'start'],
    bundleRoot: root,
    declaredInterpreterPath: join(root, 'node'),
    declaredInterpreterVersion: 'v24.0.0',
    dependencyRoot: join(root, 'package', 'node_modules'),
    envelopePath: join(root, 'evidence.json'),
    executablePath: join(root, 'node'),
    manifestPath: join(root, 'manifest.json'),
    packageRoot: join(root, 'package'),
    packageTarballPath: join(root, 'package.tgz'),
    policyPath: join(root, 'policy.json'),
    serviceDescriptorPath: join(root, 'service.plist'),
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeText(path: string, value: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode });
}

function freezeTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) freezeTree(join(path, entry));
    chmodSync(path, 0o555);
  } else {
    chmodSync(path, (stat.mode & 0o111) === 0 ? 0o444 : 0o555);
  }
}

interface CompleteBundle {
  binding: RuntimeActivationArtifactBindingV1;
  request: RuntimeActivationBundleRequestV1;
  manifestDigest: string;
}

function completeBundle(input: {
  parent: string;
  role: 'candidate' | 'rollback';
  revision: string;
  tree: string;
  marker: string;
  privateKey: KeyObject;
  keyId: string;
  evidenceTrustRoot: string;
  rollbackTargetDigest: string | null;
  directoryName?: string;
  executableInterpreter?: boolean;
}): CompleteBundle {
  const bundleRoot = join(input.parent, input.directoryName ?? `${input.role}-bundle`);
  const packageRoot = join(bundleRoot, input.revision);
  mkdirSync(packageRoot, { recursive: true });
  writeText(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: '@ashlr/hub',
      version: '3.2.0',
      type: 'module',
      bin: { ashlr: 'bin/ashlr' },
      files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
      dependencies: { example: '1.0.0' },
      bundledDependencies: ['example'],
    })}\n`,
  );
  writeText(
    join(packageRoot, 'package-lock.json'),
    `${JSON.stringify({
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
    })}\n`,
  );
  writeText(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  writeText(join(packageRoot, 'dist', 'cli', 'index.js'), `export const marker = '${input.marker}';\n`);
  writeText(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  writeText(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  writeText(join(dependencyRoot, 'example', 'index.js'), `export const marker = '${input.marker}';\n`);
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  writeText(join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')), inventory.canonicalJson);
  const interpreterPath = join(bundleRoot, 'node');
  const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  writeText(
    interpreterPath,
    input.executableInterpreter
      ? `#!/bin/sh\nexec ${quotedNode} "$@"\n`
      : `fixture node ${input.marker}\n`,
    0o755,
  );
  const built = buildUnsignedRuntimeReleaseManifest({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v24.0.0',
    dependencyRoot,
    expectedRevision: input.revision,
    packageRoot,
    declaredRollbackTargetDigest: input.rollbackTargetDigest,
  });
  if (!built.ok) throw new Error(built.reason);
  const signed = signRuntimeReleaseEvidenceEnvelope({
    expiresAt: '2026-08-10T12:10:00.000Z',
    issuedAt: '2026-08-10T11:55:00.000Z',
    manifest: built.canonicalJson,
    privateKey: input.privateKey,
  });
  if (!signed.ok) throw new Error(signed.reason);
  const manifestPath = join(bundleRoot, 'manifest.json');
  const envelopePath = join(bundleRoot, 'evidence.json');
  const policyPath = join(bundleRoot, 'policy.json');
  const packageTarballPath = join(bundleRoot, 'package.tgz');
  const serviceDescriptorPath = join(bundleRoot, 'service.plist');
  const policy = `{"policyEpoch":7,"role":"${input.role}"}\n`;
  const tarball = `independently-packaged-${input.role}-${input.marker}\n`;
  const descriptor = `service=${input.role}\nrevision=${input.revision}\n`;
  writeText(manifestPath, built.canonicalJson);
  writeText(envelopePath, signed.canonicalJson);
  writeText(policyPath, policy);
  writeText(packageTarballPath, tarball);
  writeText(serviceDescriptorPath, descriptor);
  freezeTree(packageRoot);
  freezeTree(interpreterPath);
  freezeTree(manifestPath);
  freezeTree(envelopePath);
  freezeTree(policyPath);
  freezeTree(packageTarballPath);
  freezeTree(serviceDescriptorPath);
  chmodSync(bundleRoot, 0o555);
  const observed = observeRuntimeReleaseImmutableStagedTree({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v24.0.0',
    dependencyRoot,
    expectedManifestDigest: built.manifest.manifestDigest,
    expectedRevision: input.revision,
    manifest: built.canonicalJson,
    packageRoot,
  });
  if (!observed.ok) throw new Error(observed.reason);
  const executablePath = interpreterPath;
  const argv = [join(packageRoot, 'bin', 'ashlr'), 'daemon', 'start'];
  const invocation = runtimeReleaseServiceInvocationDigest(executablePath, argv);
  const policyId = runtimeReleasePolicyId(policy);
  const envelopeCanonicalSha256 = runtimeReleaseEnvelopeCanonicalSha256(signed.canonicalJson);
  const evidenceTrustRootCanonicalSha256 = runtimeReleaseTrustRootCanonicalSha256(input.evidenceTrustRoot);
  if (!invocation || !policyId || !envelopeCanonicalSha256 || !evidenceTrustRootCanonicalSha256) {
    throw new Error('complete bundle identity could not be derived');
  }
  const parsed = parseUnsignedRuntimeReleaseManifest(built.canonicalJson);
  if (!parsed.ok) throw new Error(parsed.reason);
  const buildInputs: Omit<RuntimeActivationArtifactBindingV1, 'declarationBindingSha256'> = {
    dependencyInventoryDigest: parsed.manifest.dependencyInventory.inventoryDigest,
    envelopeCanonicalSha256,
    envelopeSha256: sha256(signed.canonicalJson),
    evidenceKeyId: input.keyId,
    evidenceTrustRootCanonicalSha256,
    evidenceTrustRootSha256: sha256(input.evidenceTrustRoot),
    expectedRevision: input.revision,
    expectedTree: input.tree,
    independentlyPackaged: true,
    interpreterSha256: parsed.manifest.interpreterDeclaration.observedArtifactSha256,
    manifestDigest: parsed.manifest.manifestDigest,
    packageTarballSha256: sha256(tarball),
    packageVersion: '3.2.0',
    policyId,
    runtimeTreeSha256: observed.receipt.stagedTreeIdentity,
    releaseTag: 'v3.2.0',
    serviceDescriptorSha256: sha256(descriptor),
    serviceInvocationDigest: invocation,
  };
  return {
    binding: {
      declarationBindingSha256: runtimeActivationBuildBindingSha256(buildInputs),
      ...buildInputs,
    },
    manifestDigest: parsed.manifest.manifestDigest,
    request: {
      argv,
      bundleRoot,
      declaredInterpreterPath: interpreterPath,
      declaredInterpreterVersion: 'v24.0.0',
      dependencyRoot,
      envelopePath,
      executablePath,
      manifestPath,
      packageRoot,
      packageTarballPath,
      policyPath,
      serviceDescriptorPath,
    },
  };
}

function fixture(options: { minimumPolicyEpoch?: number; policyEpoch?: number } = {}): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-authority-')));
  roots.push(home);
  chmodSync(home, 0o700);
  const paths = runtimeActivationAuthorityPaths(home);
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
  mkdirSync(join(home, '.ashlr', 'control'), { mode: 0o700 });
  mkdirSync(paths.rootPath, { mode: 0o700 });
  mkdirSync(paths.plansPath, { mode: 0o700 });
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const releaseKeys = generateKeyPairSync('ed25519');
  const evidence = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [
      {
        publicKey: releaseKeys.publicKey,
        validFrom: '2026-08-10T11:00:00.000Z',
        validUntil: '2026-08-10T13:00:00.000Z',
      },
    ],
  });
  if (!evidence.ok) throw new Error(evidence.reason);
  const trustRoot: RuntimeActivationAuthorityTrustRootV1 = {
    activationKeys: [activationTrustKey(publicKey)],
    assurance: 'operator-custodied-public-trust-root',
    domain: RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1,
    evidenceTrustRoot: JSON.parse(evidence.canonicalJson) as RuntimeActivationAuthorityTrustRootV1['evidenceTrustRoot'],
    minimumPolicyEpoch: options.minimumPolicyEpoch ?? 7,
    permittedActivationModes: ['resident-canary'],
    schemaVersion: 1,
  };
  writeFileSync(paths.trustRootPath, runtimeActivationTrustRootCanonicalJson(trustRoot), { mode: 0o600 });
  chmodSync(paths.trustRootPath, 0o600);
  const keyId = runtimeReleaseEvidenceKeyId(releaseKeys.publicKey)!;
  const payload: RuntimeActivationManifestPayloadV1 = {
    activationMode: 'resident-canary',
    candidate: binding(1, keyId),
    execution: execution(home),
    expiresAt: '2026-08-10T12:10:00.000Z',
    issuedAt: '2026-08-10T11:55:00.000Z',
    planId: '123e4567-e89b-42d3-a456-426614174000',
    policyEpoch: options.policyEpoch ?? 7,
    rollback: binding(8, keyId),
  };
  const signed = signRuntimeActivationManifest(payload, privateKey);
  const request: RuntimeActivationPreflightRequestV1 = {
    candidate: bundle(join(home, 'candidate')),
    domain: RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1,
    rollback: bundle(join(home, 'rollback')),
    schemaVersion: 1,
    signedManifest: signed.manifest,
  };
  const requestPath = join(paths.plansPath, `${payload.planId}.json`);
  writeFileSync(requestPath, runtimeActivationRequestCanonicalJson(request), {
    mode: 0o600,
  });
  chmodSync(requestPath, 0o600);
  return {
    home,
    now,
    privateKey,
    publicKey,
    trustRoot,
    payload,
    request,
    requestPath,
  };
}

function activationPlist(
  request: RuntimeActivationPreflightRequestV1,
  role: 'candidate' | 'rollback' = 'candidate',
): string {
  const payload = request.signedManifest.payload;
  const binding = payload[role];
  const bundle = request[role];
  const env = {
    ASHLR_ACTIVATION_CONFIG_SHA256: payload.execution.configSha256,
    ASHLR_ACTIVATION_ID: payload.planId,
    ASHLR_ACTIVATION_MANIFEST_DIGEST: binding.manifestDigest,
    ASHLR_ACTIVATION_RELEASE_REVISION: binding.expectedRevision,
    ASHLR_ACTIVATION_RELEASE_TREE_SHA256: binding.runtimeTreeSha256,
    HOME: payload.execution.homePath,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const argumentsXml = [bundle.executablePath, ...bundle.argv]
    .map((argument) => `<string>${argument}</string>`)
    .join('');
  const environmentXml = Object.entries(env)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>EnvironmentVariables</key><dict>${environmentXml}</dict>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>Label</key><string>ai.ashlr.daemon</string>
<key>ProcessType</key><string>Background</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>${join(payload.execution.homePath, '.ashlr', 'daemon.launchd.err.log')}</string>
<key>StandardOutPath</key><string>${join(payload.execution.homePath, '.ashlr', 'daemon.launchd.out.log')}</string>
<key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
`;
}

interface CompleteActivationFixture {
  home: string;
  now: number;
  request: RuntimeActivationPreflightRequestV1;
  requestPath: string;
  trustRootPath: string;
}

function completeActivationFixture(executableCandidate = false): CompleteActivationFixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-complete-')));
  roots.push(home);
  chmodSync(home, 0o700);
  const paths = runtimeActivationAuthorityPaths(home);
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
  mkdirSync(join(home, '.ashlr', 'control'), { mode: 0o700 });
  mkdirSync(paths.rootPath, { mode: 0o700 });
  mkdirSync(paths.plansPath, { mode: 0o700 });
  const releasesRoot = join(home, '.local', 'share', 'ashlr', 'releases');
  mkdirSync(releasesRoot, { recursive: true });
  const releaseKeys = generateKeyPairSync('ed25519');
  const activationKeys = generateKeyPairSync('ed25519');
  const evidence = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{
      publicKey: releaseKeys.publicKey,
      validFrom: '2026-08-10T11:00:00.000Z',
      validUntil: '2026-08-10T13:00:00.000Z',
    }],
  });
  if (!evidence.ok) throw new Error(evidence.reason);
  const trustRoot: RuntimeActivationAuthorityTrustRootV1 = {
    activationKeys: [activationTrustKey(activationKeys.publicKey)],
    assurance: 'operator-custodied-public-trust-root',
    domain: RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1,
    evidenceTrustRoot: JSON.parse(evidence.canonicalJson) as RuntimeActivationAuthorityTrustRootV1['evidenceTrustRoot'],
    minimumPolicyEpoch: 7,
    permittedActivationModes: ['resident-canary'],
    schemaVersion: 1,
  };
  writeFileSync(paths.trustRootPath, runtimeActivationTrustRootCanonicalJson(trustRoot), { mode: 0o600 });
  const releaseKeyId = runtimeReleaseEvidenceKeyId(releaseKeys.publicKey)!;
  const rollbackRevision = revision('b');
  const candidateRevision = revision('a');
  const rollback = completeBundle({
    parent: releasesRoot,
    directoryName: rollbackRevision,
    role: 'rollback',
    revision: rollbackRevision,
    tree: revision('c'),
    marker: 'rollback',
    privateKey: releaseKeys.privateKey,
    keyId: releaseKeyId,
    evidenceTrustRoot: evidence.canonicalJson,
    rollbackTargetDigest: null,
  });
  const candidate = completeBundle({
    parent: releasesRoot,
    directoryName: candidateRevision,
    role: 'candidate',
    revision: candidateRevision,
    tree: revision('d'),
    marker: 'candidate',
    privateKey: releaseKeys.privateKey,
    keyId: releaseKeyId,
    evidenceTrustRoot: evidence.canonicalJson,
    rollbackTargetDigest: rollback.manifestDigest,
    executableInterpreter: executableCandidate,
  });
  const config = '{}\n';
  const configPath = join(home, '.ashlr', 'config.json');
  writeFileSync(configPath, config, { mode: 0o600 });
  const payload: RuntimeActivationManifestPayloadV1 = {
    activationMode: 'resident-canary',
    candidate: candidate.binding,
    execution: {
      ...execution(home),
      configSha256: sha256(config),
      prior: {
        currentRevision: rollbackRevision,
        plistSha256: digest('f'),
        serviceLoaded: false,
      },
    },
    expiresAt: '2026-08-10T12:10:00.000Z',
    issuedAt: '2026-08-10T11:55:00.000Z',
    planId: '123e4567-e89b-42d3-a456-426614174000',
    policyEpoch: 7,
    rollback: rollback.binding,
  };
  let signed = signRuntimeActivationManifest(payload, activationKeys.privateKey);
  const request: RuntimeActivationPreflightRequestV1 = {
    candidate: candidate.request,
    domain: RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1,
    rollback: rollback.request,
    schemaVersion: 1,
    signedManifest: signed.manifest,
  };
  for (const role of ['candidate', 'rollback'] as const) {
    const bundle = request[role];
    chmodSync(bundle.bundleRoot, 0o700);
    chmodSync(bundle.serviceDescriptorPath, 0o600);
    const descriptor = activationPlist(request, role);
    writeFileSync(bundle.serviceDescriptorPath, descriptor, { mode: 0o444 });
    chmodSync(bundle.serviceDescriptorPath, 0o444);
    payload[role].serviceDescriptorSha256 = sha256(descriptor);
    const {
      declarationBindingSha256: _declarationBindingSha256,
      ...declarationInputs
    } = payload[role];
    payload[role].declarationBindingSha256 = runtimeActivationBuildBindingSha256(declarationInputs);
    chmodSync(bundle.bundleRoot, 0o555);
  }
  signed = signRuntimeActivationManifest(payload, activationKeys.privateKey);
  request.signedManifest = signed.manifest;
  const requestPath = join(paths.plansPath, `${payload.planId}.json`);
  writeFileSync(requestPath, runtimeActivationRequestCanonicalJson(request), { mode: 0o600 });
  return {
    home,
    now: Date.parse('2026-08-10T12:00:00.000Z'),
    request,
    requestPath,
    trustRootPath: paths.trustRootPath,
  };
}

function assertNoMutationAuthority(result: ReturnType<typeof preflightRuntimeActivationAuthority>): void {
  expect(result).toMatchObject({
    activationPermitted: false,
    deployPermitted: false,
    executionPerformed: false,
    installPermitted: false,
    launchPermitted: false,
    rollbackPermitted: false,
    startPermitted: false,
  });
}

describe('M502 runtime activation authority', () => {
  it('returns preflight-passed-no-authority only for a fully bound candidate and rollback byte pair', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-10T12:00:00.000Z');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-complete-')));
    roots.push(home);
    chmodSync(home, 0o700);
    const paths = runtimeActivationAuthorityPaths(home);
    mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    mkdirSync(join(home, '.ashlr', 'control'), { mode: 0o700 });
    mkdirSync(paths.rootPath, { mode: 0o700 });
    mkdirSync(paths.plansPath, { mode: 0o700 });
    const releaseKeys = generateKeyPairSync('ed25519');
    const activationKeys = generateKeyPairSync('ed25519');
    const evidence = buildRuntimeReleaseEvidenceTrustRoot({
      keys: [
        {
          publicKey: releaseKeys.publicKey,
          validFrom: '2026-08-10T11:00:00.000Z',
          validUntil: '2026-08-10T13:00:00.000Z',
        },
      ],
    });
    if (!evidence.ok) throw new Error(evidence.reason);
    const trustRoot: RuntimeActivationAuthorityTrustRootV1 = {
      activationKeys: [activationTrustKey(activationKeys.publicKey)],
      assurance: 'operator-custodied-public-trust-root',
      domain: RUNTIME_ACTIVATION_AUTHORITY_TRUST_ROOT_DOMAIN_V1,
      evidenceTrustRoot: JSON.parse(
        evidence.canonicalJson,
      ) as RuntimeActivationAuthorityTrustRootV1['evidenceTrustRoot'],
      minimumPolicyEpoch: 7,
      permittedActivationModes: ['resident-canary'],
      schemaVersion: 1,
    };
    writeFileSync(paths.trustRootPath, runtimeActivationTrustRootCanonicalJson(trustRoot), { mode: 0o600 });
    const keyId = runtimeReleaseEvidenceKeyId(releaseKeys.publicKey)!;
    const rollback = completeBundle({
      parent: home,
      role: 'rollback',
      revision: revision('b'),
      tree: revision('c'),
      marker: 'rollback',
      privateKey: releaseKeys.privateKey,
      keyId,
      evidenceTrustRoot: evidence.canonicalJson,
      rollbackTargetDigest: null,
    });
    const candidate = completeBundle({
      parent: home,
      role: 'candidate',
      revision: revision('a'),
      tree: revision('d'),
      marker: 'candidate',
      privateKey: releaseKeys.privateKey,
      keyId,
      evidenceTrustRoot: evidence.canonicalJson,
      rollbackTargetDigest: rollback.manifestDigest,
    });
    const payload: RuntimeActivationManifestPayloadV1 = {
      activationMode: 'resident-canary',
      candidate: candidate.binding,
      execution: execution(home),
      expiresAt: '2026-08-10T12:10:00.000Z',
      issuedAt: '2026-08-10T11:55:00.000Z',
      planId: '123e4567-e89b-42d3-a456-426614174000',
      policyEpoch: 7,
      rollback: rollback.binding,
    };
    const signed = signRuntimeActivationManifest(payload, activationKeys.privateKey);
    const request: RuntimeActivationPreflightRequestV1 = {
      candidate: candidate.request,
      domain: RUNTIME_ACTIVATION_REQUEST_DOMAIN_V1,
      rollback: rollback.request,
      schemaVersion: 1,
      signedManifest: signed.manifest,
    };
    const requestPath = join(paths.plansPath, `${payload.planId}.json`);
    writeFileSync(requestPath, runtimeActivationRequestCanonicalJson(request), {
      mode: 0o600,
    });
    const result = preflightRuntimeActivationAuthority({
      homePath: home,
      nowMs: Date.parse('2026-08-10T12:00:00.000Z'),
      requestPath,
    });
    expect(result).toMatchObject({
      verdict: 'preflight-passed-no-authority',
      preflightPassed: true,
      blockers: [],
      trust: { operatorCustodyVerified: true, signatureVerified: true },
      releases: {
        pair: {
          observedByteEvidencePairVerified: true,
          gitObjectProvenanceVerified: false,
          releaseTagPublicationVerified: false,
          buildProvenanceVerified: false,
          independentPackagingVerified: false,
          tarballToRuntimeTreeBindingVerified: false,
        },
      },
      nativeAuthority: { activationSigningRootIndependent: true },
    });
    expect(result.plan.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.releases.candidate.signedDeclarations).toMatchObject({
      expectedTree: revision('d'),
      releaseTag: 'v3.2.0',
      independentlyPackaged: true,
    });
    expect(result.releases.candidate.observedEvidence).toMatchObject({
      packageTarballSha256: candidate.binding.packageTarballSha256,
      runtimeTreeSha256: candidate.binding.runtimeTreeSha256,
      serviceDescriptorSha256: candidate.binding.serviceDescriptorSha256,
    });
    assertNoMutationAuthority(result);

    let clockReads = 0;
    const expiredDuringObservation = preflightRuntimeActivationAuthority({
      clock: () => Date.parse(clockReads++ === 0 ? '2026-08-10T12:00:00.000Z' : '2026-08-10T12:10:00.000Z'),
      homePath: home,
      requestPath,
    });
    expect(expiredDuringObservation).toMatchObject({
      verdict: 'blocked',
      preflightPassed: false,
      blockers: [{ code: 'signed-manifest-expired' }],
    });
    assertNoMutationAuthority(expiredDuringObservation);

    const packageTarballPath = candidate.request.packageTarballPath;
    const displacedTarballPath = `${packageTarballPath}.displaced`;
    thawTree(candidate.request.bundleRoot);
    renameSync(packageTarballPath, displacedTarballPath);
    writeFileSync(packageTarballPath, 'substituted-package-bytes\n', { mode: 0o400 });
    rmSync(displacedTarballPath);
    freezeTree(candidate.request.bundleRoot);
    const replacedArtifact = preflightRuntimeActivationAuthority({
      homePath: home,
      nowMs: Date.parse('2026-08-10T12:00:00.000Z'),
      requestPath,
    });
    expect(replacedArtifact.blockers).toContainEqual({
      code: 'candidate-artifact-invalid',
      detail: 'package tarball or service descriptor digest mismatch',
    });
    assertNoMutationAuthority(replacedArtifact);
  });

  it('returns the exact final verified request and stable admission bindings', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-10T12:00:00.000Z');
    const f = completeActivationFixture();
    const observed = observeRuntimeActivationExecutionPlan({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(observed.request).toEqual(f.request);
    expect(observed.canonicalRequestSha256).toBe(
      sha256(runtimeActivationRequestCanonicalJson(f.request)),
    );
    expect(observed.trustRootCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.candidateLaunchReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.rollbackLaunchReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.preflight.plan.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(observed.preflight.plan.admissionDigest).not.toBe(observed.preflight.plan.planDigest);
  });

  it('feeds a genuine exact M502 admission through the dormant bounded handoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime('2026-08-10T12:00:00.000Z');
    const f = completeActivationFixture(true);
    const admitted = observeRuntimeActivationExecutionPlan({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      {
        expectedAdmissionDigest: admitted.preflight.plan.admissionDigest!,
        requestPath: f.requestPath,
      },
      {
        homePath: f.home,
        nowMs: f.now,
        platform: 'darwin',
      },
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.receipt.bindings.admissionDigest).toBe(admitted.preflight.plan.admissionDigest);
    expect(result.receipt.proofChild).toMatchObject({
      acknowledged: true,
      directChildCloseObserved: true,
      processGroupDeathObserved: true,
      terminated: true,
    });
    expect(Object.values(result.authority).every((value) => value === false)).toBe(true);
  });

  it('rejects a valid outer-request path swap between verified snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-10T12:00:00.000Z');
    const f = completeActivationFixture();
    const candidate = f.request.candidate;
    chmodSync(candidate.bundleRoot, 0o700);
    const alternatePolicy = join(candidate.bundleRoot, 'policy-alternate.json');
    writeFileSync(alternatePolicy, readFileSync(candidate.policyPath), { mode: 0o444 });
    chmodSync(candidate.bundleRoot, 0o555);
    expect(() => observeRuntimeActivationExecutionPlan({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
      testOnlyAfterFirstSnapshot: () => {
        const changed = structuredClone(f.request);
        changed.candidate.policyPath = alternatePolicy;
        writeFileSync(f.requestPath, runtimeActivationRequestCanonicalJson(changed), { mode: 0o600 });
      },
    })).toThrow('runtime activation request changed during execution admission');
  });

  it('rejects operator trust-root rotation during one preflight scan', () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-10T12:00:00.000Z');
    const f = completeActivationFixture();
    let clockReads = 0;
    const result = preflightRuntimeActivationAuthority({
      clock: () => {
        clockReads += 1;
        if (clockReads === 2) {
          const current = JSON.parse(readFileSync(f.trustRootPath, 'utf8')) as RuntimeActivationAuthorityTrustRootV1;
          const extra = generateKeyPairSync('ed25519');
          current.activationKeys.push(activationTrustKey(extra.publicKey));
          writeFileSync(
            f.trustRootPath,
            runtimeActivationTrustRootCanonicalJson(current),
            { mode: 0o600 },
          );
        }
        return f.now;
      },
      homePath: f.home,
      requestPath: f.requestPath,
    });
    expect(result).toMatchObject({
      verdict: 'blocked',
      preflightPassed: false,
    });
    expect(result.blockers).toContainEqual({
      code: 'operator-trust-root-changed',
      detail: 'operator trust root changed during activation preflight',
    });
  });

  it('verifies operator custody and signature before refusing absent immutable bundles', () => {
    const f = fixture();
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.verdict).toBe('blocked');
    expect(result.trust).toMatchObject({
      operatorCustodyVerified: true,
      signatureVerified: true,
    });
    expect(result.plan).toMatchObject({
      planId: f.payload.planId,
      policyEpoch: 7,
      activationMode: 'resident-canary',
    });
    expect(result.blockers.map((entry) => entry.code)).toEqual([
      'candidate-artifact-invalid',
      'rollback-artifact-invalid',
    ]);
    expect(result.authorityBlockers).toContain('durable-replay-consumption-required');
    expect(result.authorityBlockers).toEqual(expect.arrayContaining([
      'trusted-monotonic-time-required',
      'external-monotonic-cas-required',
      'native-prior-state-attestation-required',
      'signed-fsynced-lifecycle-journal-required',
      'launchd-runtime-ack-required',
      'release-bound-dispatch-permit-required',
      'atomic-current-pointer-cas-required',
      'crash-recovery-required',
      'exact-rollback-revalidation-required',
    ]));
    expect(result.nativeAuthority).toEqual({
      activationSigningRootIndependent: true,
      trustedMonotonicTime: false,
      externalMonotonicCas: false,
      nativePriorStateObserved: false,
      lifecycleJournalDurable: false,
      launchdRuntimeAcknowledged: false,
      dispatchAuthorizationBound: false,
      currentPointerCasVerified: false,
      crashRecoveryVerified: false,
      rollbackExecutionVerified: false,
    });
    assertNoMutationAuthority(result);
  });

  it('rejects a signature made by a key outside the operator root', () => {
    const f = fixture();
    const outsider = generateKeyPairSync('ed25519');
    const signed = signRuntimeActivationManifest(f.payload, outsider.privateKey);
    f.request.signedManifest = signed.manifest;
    writeFileSync(f.requestPath, runtimeActivationRequestCanonicalJson(f.request), { mode: 0o600 });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'signed-manifest-invalid' })]),
    );
    assertNoMutationAuthority(result);
  });

  it('rejects activation keys that overlap the release-evidence key set', () => {
    const f = fixture();
    const evidence = f.trustRoot.evidenceTrustRoot as {
      keys: Array<{ keyId: string; publicKeySpki: string; validFrom: string; validUntil: string }>;
    };
    const releaseKey = evidence.keys[0]!;
    f.trustRoot.activationKeys = [{
      algorithm: 'ed25519',
      domain: RUNTIME_ACTIVATION_AUTHORITY_KEY_DOMAIN_V1,
      keyId: releaseKey.keyId,
      publicKeySpki: releaseKey.publicKeySpki,
      validFrom: releaseKey.validFrom,
      validUntil: releaseKey.validUntil,
    }];
    writeFileSync(
      runtimeActivationAuthorityPaths(f.home).trustRootPath,
      runtimeActivationTrustRootCanonicalJson(f.trustRoot),
      { mode: 0o600 },
    );
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result).toMatchObject({
      verdict: 'blocked',
      preflightPassed: false,
      blockers: [{ code: 'operator-trust-root-unavailable' }],
      nativeAuthority: { activationSigningRootIndependent: false },
    });
  });

  it('rejects expired and not-yet-valid manifests before artifact observation', () => {
    const f = fixture();
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: Date.parse('2026-08-10T13:00:00.000Z'),
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]?.code).toBe('signed-manifest-expired');
    expect(result.blockers).toHaveLength(1);
    assertNoMutationAuthority(result);
  });

  it('rejects a signed policy epoch below the operator floor', () => {
    const f = fixture({ minimumPolicyEpoch: 8, policyEpoch: 7 });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]?.code).toBe('policy-epoch-stale');
    assertNoMutationAuthority(result);
  });

  it('rejects a plan filename that is not the signed plan id', () => {
    const f = fixture();
    const wrong = join(runtimeActivationAuthorityPaths(f.home).plansPath, '123e4567-e89b-42d3-a456-426614174001.json');
    writeFileSync(wrong, readFileSync(f.requestPath), { mode: 0o600 });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: wrong,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    assertNoMutationAuthority(result);
  });

  it('rejects noncanonical request bytes and extra fields', () => {
    const f = fixture();
    const parsed = JSON.parse(readFileSync(f.requestPath, 'utf8')) as Record<string, unknown>;
    parsed['unexpected'] = true;
    writeFileSync(f.requestPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: 0o600,
    });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    assertNoMutationAuthority(result);
  });

  it('rejects relative artifact paths before release observation', () => {
    const f = fixture();
    f.request.candidate.bundleRoot = 'candidate-bundle';
    writeFileSync(f.requestPath, runtimeActivationRequestCanonicalJson(f.request), { mode: 0o600 });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    expect(result.blockers[0]?.detail).toContain('absolute and canonical');
    assertNoMutationAuthority(result);
  });

  it('rejects permissive trust-root and request modes', () => {
    const f = fixture();
    const paths = runtimeActivationAuthorityPaths(f.home);
    chmodSync(paths.trustRootPath, 0o644);
    let result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]).toMatchObject({
      code: 'operator-trust-root-unavailable',
    });
    chmodSync(paths.trustRootPath, 0o600);
    chmodSync(f.requestPath, 0o644);
    result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    assertNoMutationAuthority(result);
  });

  it.skipIf(process.platform === 'win32')('rejects symlink and hard-link plan substitution', () => {
    const f = fixture();
    const paths = runtimeActivationAuthorityPaths(f.home);
    const real = join(paths.plansPath, 'real.json');
    const symlink = join(paths.plansPath, '123e4567-e89b-42d3-a456-426614174001.json');
    writeFileSync(real, readFileSync(f.requestPath), { mode: 0o600 });
    symlinkSync(real, symlink);
    let result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: symlink,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    rmSync(symlink);
    const hardlink = join(paths.plansPath, '123e4567-e89b-42d3-a456-426614174002.json');
    linkSync(f.requestPath, hardlink);
    result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: hardlink,
    });
    expect(result.blockers[0]).toMatchObject({ code: 'request-unavailable' });
    assertNoMutationAuthority(result);
  });

  it('hashes only immutable, single-link artifacts inside the pinned bundle root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-bundle-')));
    roots.push(root);
    chmodSync(root, 0o500);
    const artifact = join(root, 'release.tgz');
    chmodSync(root, 0o700);
    writeFileSync(artifact, 'release-bytes', { mode: 0o400 });
    chmodSync(root, 0o500);
    expect(runtimeActivationAuthorityInternals.hashStableArtifact(artifact, root)).toMatch(SHA256_RE_FOR_TEST);
    chmodSync(root, 0o700);
    chmodSync(artifact, 0o600);
    chmodSync(root, 0o500);
    expect(() => runtimeActivationAuthorityInternals.hashStableArtifact(artifact, root)).toThrow('custody');
  });

  it.skipIf(process.platform === 'win32')('rejects writable ancestors and hard-linked bundle artifacts', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-bundle-')));
    roots.push(root);
    const nested = join(root, 'nested');
    mkdirSync(nested, { mode: 0o700 });
    const artifact = join(nested, 'release.tgz');
    const alias = join(nested, 'alias.tgz');
    writeFileSync(artifact, 'release-bytes', { mode: 0o400 });
    linkSync(artifact, alias);
    chmodSync(nested, 0o500);
    chmodSync(root, 0o500);
    expect(() => runtimeActivationAuthorityInternals.hashStableArtifact(artifact, root)).toThrow('custody');

    chmodSync(root, 0o700);
    chmodSync(nested, 0o700);
    rmSync(alias);
    chmodSync(nested, 0o700);
    chmodSync(root, 0o500);
    expect(() => runtimeActivationAuthorityInternals.hashStableArtifact(artifact, root)).toThrow('custody');
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked artifact and ancestor path substitutions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-bundle-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-activation-outside-')));
    roots.push(root, outside);
    const artifact = join(root, 'release.tgz');
    const artifactAlias = join(root, 'release-alias.tgz');
    const outsideArtifact = join(outside, 'release.tgz');
    const swappedAncestor = join(root, 'swapped');
    writeFileSync(artifact, 'release-bytes', { mode: 0o400 });
    writeFileSync(outsideArtifact, 'outside-bytes', { mode: 0o400 });
    symlinkSync(artifact, artifactAlias);
    symlinkSync(outside, swappedAncestor);
    chmodSync(root, 0o500);
    chmodSync(outside, 0o500);

    expect(() => runtimeActivationAuthorityInternals.hashStableArtifact(artifactAlias, root)).toThrow();
    expect(() =>
      runtimeActivationAuthorityInternals.hashStableArtifact(join(swappedAncestor, 'release.tgz'), root),
    ).toThrow('custody');
  });

  it('keeps candidate and rollback identity in the signature boundary', () => {
    const f = fixture();
    const signed = signRuntimeActivationManifest(f.payload, f.privateKey);
    const mutated = structuredClone(signed.manifest);
    mutated.payload.rollback.expectedTree = revision('0');
    const {
      declarationBindingSha256: _declarationBindingSha256,
      ...declarationInputs
    } = mutated.payload.rollback;
    mutated.payload.rollback.declarationBindingSha256 = runtimeActivationBuildBindingSha256(
      declarationInputs,
    );
    f.request.signedManifest = mutated;
    writeFileSync(f.requestPath, runtimeActivationRequestCanonicalJson(f.request), { mode: 0o600 });
    const result = preflightRuntimeActivationAuthority({
      homePath: f.home,
      nowMs: f.now,
      requestPath: f.requestPath,
    });
    expect(result.blockers[0]?.code).toBe('signed-manifest-invalid');
    assertNoMutationAuthority(result);
  });
});

describe('M504 mutation-disabled macOS activation consumer', () => {
  it.skipIf(process.platform !== 'darwin')(
    'takes a complete valid signed plan through exact admission to consumer-unavailable',
    () => {
      vi.useFakeTimers();
      vi.setSystemTime('2026-08-10T12:00:00.000Z');
      const f = completeActivationFixture();
      const preflight = preflightRuntimeActivationAuthority({
        homePath: f.home,
        nowMs: f.now,
        requestPath: f.requestPath,
      });
      expect(preflight).toMatchObject({
        verdict: 'preflight-passed-no-authority',
        preflightPassed: true,
      });
      const admissionDigest = preflight.plan.admissionDigest!;
      const result = runtimeActivationTransactionInternals.testOnlyActivateRuntimeReleaseForHome({
        authorize: admissionDigest,
        confirm: admissionDigest,
        requestPath: f.requestPath,
      }, f.home);
      expect(result).toMatchObject({
        activated: false,
        phase: 'blocked',
        reason: 'runtime-activation-consumer-unavailable',
        admissionDigest,
        planDigest: preflight.plan.planDigest,
        rollbackRestored: false,
      });
      expect(result.canonicalRequestSha256).toBe(
        sha256(runtimeActivationRequestCanonicalJson(f.request)),
      );
      expect(result.trustRootCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.candidateLaunchReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.rollbackLaunchReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it.skipIf(process.platform !== 'darwin')('accepts only the exact closed launchd descriptor schema', () => {
    const f = fixture();
    const valid = activationPlist(f.request);
    expect(() => runtimeActivationTransactionInternals.validateClosedDescriptor(
      f.request,
      f.request.candidate,
      f.request.signedManifest.payload.candidate,
      valid,
    )).not.toThrow();

    const poisoned = [
      valid.replace('<key>Label</key>', '<key>Program</key><string>/tmp/evil</string><key>Label</key>'),
      valid.replace('<key>Label</key>', '<key>BundleProgram</key><string>evil</string><key>Label</key>'),
      valid.replace(
        '<key>SuccessfulExit</key><false/>',
        '<key>SuccessfulExit</key><false/><key>NetworkState</key><true/>',
      ),
      valid.replace(
        '</dict>\n<key>KeepAlive',
        '<key>NODE_OPTIONS</key><string>--require /tmp/evil.js</string></dict>\n<key>KeepAlive',
      ),
    ];
    for (const descriptor of poisoned) {
      expect(() => runtimeActivationTransactionInternals.validateClosedDescriptor(
        f.request,
        f.request.candidate,
        f.request.signedManifest.payload.candidate,
        descriptor,
      )).toThrow();
    }
  });

  it.skipIf(process.platform !== 'darwin')('validates the already-read plist bytes and never reopens a supplied path', () => {
    const f = fixture();
    const descriptorPath = join(f.home, 'swappable.plist');
    const admittedBytes = activationPlist(f.request);
    writeFileSync(descriptorPath, admittedBytes, { mode: 0o600 });
    const captured = readFileSync(descriptorPath, 'utf8');
    writeFileSync(descriptorPath, '<plist><dict><key>Program</key><string>/tmp/evil</string></dict></plist>', {
      mode: 0o600,
    });
    expect(runtimeActivationTransactionInternals.parseDescriptorBytes(captured)['Label']).toBe('ai.ashlr.daemon');
    expect(() => runtimeActivationTransactionInternals.validateClosedDescriptor(
      f.request,
      f.request.candidate,
      f.request.signedManifest.payload.candidate,
      captured,
    )).not.toThrow();
  });

  it.skipIf(process.platform !== 'darwin')('rejects a poisoned HOME before reading the request', () => {
    const originalHome = process.env['HOME'];
    process.env['HOME'] = '/tmp';
    try {
      const result = activateRuntimeRelease({
        authorize: digest('a'),
        confirm: digest('a'),
        requestPath: '/definitely/not-read/activation-plan.json',
      });
      expect(result).toMatchObject({
        activated: false,
        phase: 'blocked',
        reason: 'runtime activation HOME does not match the operating-system account home',
        rollbackRestored: false,
      });
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it.each([
    {
      name: 'prior revision substitution',
      poison: (request: RuntimeActivationPreflightRequestV1) => {
        request.signedManifest.payload.execution.prior.currentRevision = revision('0');
      },
    },
    {
      name: 'missing prior plist binding',
      poison: (request: RuntimeActivationPreflightRequestV1) => {
        request.signedManifest.payload.execution.prior.plistSha256 = null;
      },
    },
    {
      name: 'loaded prior service',
      poison: (request: RuntimeActivationPreflightRequestV1) => {
        request.signedManifest.payload.execution.prior.serviceLoaded = true;
      },
    },
  ])('rejects $name before configuration or service observation', ({ poison }) => {
    const f = fixture();
    const payload = f.request.signedManifest.payload;
    f.request.candidate.bundleRoot = join(payload.execution.releasesRoot, payload.candidate.expectedRevision);
    f.request.rollback.bundleRoot = join(payload.execution.releasesRoot, payload.rollback.expectedRevision);
    payload.execution.prior.currentRevision = payload.rollback.expectedRevision;
    payload.execution.prior.plistSha256 = digest('f');
    payload.execution.prior.serviceLoaded = false;
    poison(f.request);

    expect(() => runtimeActivationTransactionInternals.validateMutationDisabledPlan(
      f.request,
      f.home,
      { candidate: '', rollback: '' },
    )).toThrow(
      'exact declared stopped prior release and plist',
    );
  });

  it('keeps production identity non-injectable and the admitted result explicitly unavailable', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/core/daemon/runtime-activation-transaction.ts'),
      'utf8',
    );
    expect(source).toContain("const CONSUMER_UNAVAILABLE = 'runtime-activation-consumer-unavailable'");
    expect(source).toContain("if (process.platform !== 'darwin')");
    expect(source).toContain('userInfo().homedir');
    expect(source).not.toMatch(/activateRuntimeRelease\([^)]*(homePath|platform|effects|clock)/s);
    expect(source).not.toContain('export function acknowledgeRuntimeActivationBootstrap');
    expect(source).not.toContain('runtime-activation-launch-handoff');
    expect(source).not.toMatch(/\b(?:writeFile|rename|symlink|unlink|mkdir|launchctl)\w*\b/);
    expect(readFileSync(join(process.cwd(), 'src/cli/daemon.ts'), 'utf8')).not.toContain(
      'acknowledgeRuntimeActivationBootstrap',
    );
    expect(readFileSync(join(process.cwd(), 'src/cli/daemon.ts'), 'utf8')).not.toContain(
      'runtime-activation-launch-handoff',
    );
    expect(runtimeActivationTransactionInternals.CONSUMER_UNAVAILABLE).toBe(
      'runtime-activation-consumer-unavailable',
    );
  });
});

const SHA256_RE_FOR_TEST = /^[a-f0-9]{64}$/;
