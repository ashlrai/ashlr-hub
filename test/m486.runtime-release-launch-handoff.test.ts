import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  observeRuntimeReleaseLaunchHandoffV1,
  observeRuntimeReleaseLaunchHandoffForVerificationOnly,
  type RuntimeReleaseLaunchHandoffOptionsV1,
  type RuntimeReleaseLaunchHandoffVerificationHooks,
} from '../src/core/daemon/runtime-release-launch-handoff.js';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  signRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  observeRuntimeReleaseImmutableStagedTree,
  runtimeReleaseEnvelopeCanonicalSha256,
  runtimeReleasePolicyId,
  runtimeReleaseServiceInvocationDigest,
  runtimeReleaseTrustRootCanonicalSha256,
} from '../src/core/daemon/runtime-release-launch-revalidation.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';
import { buildUnsignedRuntimeReleaseManifest } from
  '../src/core/daemon/runtime-release-manifest.js';

const REVISION = 'b'.repeat(40);
const POLICY = '{"policyVersion":1,"scope":"release-launch"}\n';
const ALTERNATE_POLICY = '{"policyVersion":2,"scope":"release-launch"}\n';
const NONCE = 'c'.repeat(64);
const tempDirs: string[] = [];
const spawnedProcessGroups = new Set<number>();

interface Fixture {
  home: string;
  launcherPath: string;
  launchSentinel: string;
  options: RuntimeReleaseLaunchHandoffOptionsV1;
  parent: string;
  publicKey: KeyObject;
  trustValidFrom: string;
  trustValidUntil: string;
}

function write(path: string, value: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode });
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeFixture(): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-launch-handoff-')));
  tempDirs.push(parent);
  const home = join(parent, 'home');
  mkdirSync(home, { mode: 0o700 });
  const packageRoot = join(parent, REVISION);
  mkdirSync(packageRoot);
  const launchSentinel = join(parent, 'daemon-command-ran');
  const launcherPath = join(packageRoot, 'bin', 'ashlr');
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  })}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: '3.1.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  })}\n`);
  write(launcherPath, `#!/bin/sh\ntouch ${shellQuote(launchSentinel)}\n`, 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), 'export const runtime = true;\n');
  write(join(packageRoot, 'dist', 'core', 'worker.js'), 'export const worker = true;\n');
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example', 'index.js'), 'export const dependency = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(
    join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson,
  );

  const interpreterPath = join(parent, 'node');
  write(
    interpreterPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
    0o755,
  );
  const manifest = buildUnsignedRuntimeReleaseManifest({
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: process.version,
    dependencyRoot,
    expectedRevision: REVISION,
    packageRoot,
  });
  if (!manifest.ok) throw new Error(manifest.reason);
  const now = Date.now();
  const keys = generateKeyPairSync('ed25519');
  const trustValidFrom = new Date(now - 10 * 60_000).toISOString();
  const trustValidUntil = new Date(now + 20 * 60_000).toISOString();
  const envelope = signRuntimeReleaseEvidenceEnvelope({
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    issuedAt: new Date(now - 60_000).toISOString(),
    manifest: manifest.canonicalJson,
    privateKey: keys.privateKey,
  });
  if (!envelope.ok) throw new Error(envelope.reason);
  const trustRoot = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{
      publicKey: keys.publicKey,
      validFrom: trustValidFrom,
      validUntil: trustValidUntil,
    }],
  });
  if (!trustRoot.ok) throw new Error(trustRoot.reason);
  chmodTree(packageRoot, true);
  chmodTree(interpreterPath, true);

  const stageOptions = {
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: process.version,
    dependencyRoot,
    expectedManifestDigest: manifest.manifest.manifestDigest,
    expectedPackageName: '@ashlr/hub',
    expectedRevision: REVISION,
    manifest: manifest.canonicalJson,
    packageRoot,
  };
  const staged = observeRuntimeReleaseImmutableStagedTree(stageOptions);
  if (!staged.ok) throw new Error(staged.reason);
  const argv = [launcherPath, 'daemon', 'start'];
  const serviceInvocationDigest = runtimeReleaseServiceInvocationDigest(interpreterPath, argv);
  const policyId = runtimeReleasePolicyId(POLICY);
  const envelopeSha = runtimeReleaseEnvelopeCanonicalSha256(envelope.canonicalJson);
  const trustRootSha = runtimeReleaseTrustRootCanonicalSha256(trustRoot.canonicalJson);
  if (!serviceInvocationDigest || !policyId || !envelopeSha || !trustRootSha) {
    throw new Error('fixture launch identities are invalid');
  }
  return {
    home,
    launcherPath,
    launchSentinel,
    parent,
    options: {
      ...stageOptions,
      acknowledgementTimeoutMs: 2_000,
      argv,
      claimStoreAnchorPath: home,
      envelope: envelope.canonicalJson,
      executablePath: interpreterPath,
      expectedEnvelopeCanonicalSha256: envelopeSha,
      expectedKeyId: envelope.keyId,
      expectedPolicyId: policyId,
      expectedServiceInvocationDigest: serviceInvocationDigest,
      expectedStagedTreeIdentity: staged.receipt.stagedTreeIdentity,
      expectedTrustRootCanonicalSha256: trustRootSha,
      handoffNonce: NONCE,
      policy: POLICY,
      trustRoot: trustRoot.canonicalJson,
    },
    publicKey: keys.publicKey,
    trustValidFrom,
    trustValidUntil,
  };
}

function replacePinnedFile(path: string): void {
  const parent = dirname(path);
  const bytes = readFileSync(path);
  chmodSync(parent, 0o755);
  rmSync(path);
  writeFileSync(path, bytes, { mode: 0o555 });
  chmodSync(parent, 0o555);
}

function acknowledgementSource(
  transactionExpression: string,
  options: {
    delayedSecond?: boolean;
    frame?: 'canonical' | 'crlf' | 'extra-bytes' | 'trailing-space' | 'trailing-tab';
    prefix?: string;
  } = {},
): string {
  const frame = options.frame ?? 'canonical';
  const frameExpression = frame === 'crlf'
    ? "acknowledgement + '\\r\\n'"
    : frame === 'extra-bytes'
      ? "acknowledgement + '\\nextra'"
      : frame === 'trailing-space'
        ? "acknowledgement + ' \\n'"
        : frame === 'trailing-tab'
          ? "acknowledgement + '\\t\\n'"
          : "acknowledgement + '\\n'";
  return String.raw`
${options.prefix ?? ''}
const fs = require('node:fs');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const identity = (fd) => {
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    ctimeNs: stat.ctimeNs.toString(), dev: stat.dev.toString(), ino: stat.ino.toString(),
    mode: stat.mode.toString(), mtimeNs: stat.mtimeNs.toString(),
    nlink: stat.nlink.toString(), size: stat.size.toString(),
  };
};
const acknowledgement = JSON.stringify(canonical({
  schemaVersion: 1,
  protocol: 'runtime-release-launch-handoff-v1',
  transactionId: ${transactionExpression},
  nonceDigest: process.argv[2],
  pid: process.pid,
  descriptors: {
    packageRoot: identity(3), dependencyRoot: identity(4),
    launcher: identity(5), interpreter: identity(6),
  },
}));
${options.delayedSecond === true
    ? "process.stdout.write(acknowledgement + '\\n'); setTimeout(() => process.stdout.end(acknowledgement + '\\n'), 25);"
    : `process.stdout.end(${frameExpression});`}
setInterval(() => {}, 1000);
`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function runVerification(
  options: RuntimeReleaseLaunchHandoffOptionsV1,
  hooks: RuntimeReleaseLaunchHandoffVerificationHooks = {},
) {
  const callerHook = hooks.afterProofChildSpawn;
  return observeRuntimeReleaseLaunchHandoffForVerificationOnly(options, {
    ...hooks,
    afterProofChildSpawn: (pid) => {
      spawnedProcessGroups.add(pid);
      callerHook?.(pid);
    },
  });
}

afterEach(() => {
  for (const processGroupId of spawnedProcessGroups) {
    try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* expected after containment */ }
  }
  spawnedProcessGroups.clear();
  for (const directory of tempDirs.splice(0)) {
    try { chmodTree(directory, false); } catch { /* a hostile test may replace part of the tree */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('dormant POSIX runtime release launch handoff', () => {
  it('retains all descriptors through acknowledgement and terminates a proof child without authority', async () => {
    const fixture = makeFixture();
    let childPid = 0;
    const result = await runVerification(fixture.options, {
      afterProofChildSpawn: (pid) => { childPid = pid; },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({
      assurance: 'bounded-posix-proof-child-observation-only',
      authority: {
        activationPermitted: false,
        deployPermitted: false,
        installPermitted: false,
        launchPermitted: false,
        mergePermitted: false,
        rollbackPermitted: false,
        startPermitted: false,
      },
      claim: {
        disposition: 'recorded',
        cooperativeOneUse: true,
        sameUserTamperResistant: false,
      },
      coverage: {
        launchConsumer: 'proof-child-only-terminated',
        serviceMutation: 'absent',
      },
      proofChild: {
        acknowledged: true,
        directChildCloseObserved: true,
        pid: childPid,
        processGroupDeathObserved: true,
        processGroupId: childPid,
        terminated: true,
      },
    });
    expect(result.receipt.transactionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.bindings.trustRootCanonicalSha256)
      .toBe(fixture.options.expectedTrustRootCanonicalSha256);
    expect(existsSync(fixture.launchSentinel)).toBe(false);
    expect(processExists(childPid)).toBe(false);
    expect(processGroupExists(childPid)).toBe(false);
  });

  it('gives the signed observer fresh exact options and ignores caller-injected underlying hooks', async () => {
    const fixture = makeFixture();
    let underlyingHookCalls = 0;
    const options = {
      ...fixture.options,
      __testHooks: {
        afterBeforeObservation: () => { underlyingHookCalls += 1; },
        afterLaunchReceiptConstruction: () => { underlyingHookCalls += 1; },
      },
    } as RuntimeReleaseLaunchHandoffOptionsV1 & {
      __testHooks: Record<string, () => void>;
    };
    const priorVitest = process.env['VITEST'];
    process.env['VITEST'] = 'true';
    try {
      const result = await observeRuntimeReleaseLaunchHandoffV1(options);
      expect(result.ok).toBe(true);
    } finally {
      if (priorVitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = priorVitest;
    }
    expect(underlyingHookCalls).toBe(0);
  });

  it('rejects replacement of a pinned named launcher before recording the claim', async () => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      afterDescriptorsPinned: () => replacePinnedFile(fixture.launcherPath),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'not-attempted',
      reason: 'runtime release handoff named identity changed before claim',
    });
    expect(existsSync(join(fixture.home, 'runtime-release-launch-handoff-v1'))).toBe(false);
  });

  it('rejects a mismatched proof-child acknowledgement after consuming the claim', async () => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      proofChildSource: acknowledgementSource(`'${'0'.repeat(64)}'`),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime release handoff acknowledgement mismatch',
    });
    expect(existsSync(fixture.launchSentinel)).toBe(false);
  });

  it('handles a pre-PID EACCES spawn error without an unhandled child error', async () => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      beforeProofChildSpawn: () => chmodSync(fixture.options.executablePath, 0o444),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime release handoff proof child spawn failed',
    });
    expect(spawnedProcessGroups.size).toBe(0);
    expect(existsSync(fixture.launchSentinel)).toBe(false);
  });

  it('waits for acknowledgement EOF and rejects a delayed second frame', async () => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      proofChildSource: acknowledgementSource('process.argv[1]', { delayedSecond: true }),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime release handoff acknowledgement was not singular',
    });
  });

  it.each([
    ['CRLF', 'crlf', 'runtime release handoff acknowledgement frame is not canonical'],
    ['trailing space', 'trailing-space',
      'runtime release handoff acknowledgement frame is not canonical'],
    ['trailing tab', 'trailing-tab',
      'runtime release handoff acknowledgement frame is not canonical'],
    ['extra bytes', 'extra-bytes',
      'runtime release handoff acknowledgement was not singular'],
  ] as const)('rejects %s acknowledgement framing', async (_label, frame, reason) => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      proofChildSource: acknowledgementSource('process.argv[1]', { frame }),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason,
    });
  });

  it.each([
    ['timeout', 'setInterval(() => {}, 1000);', 50,
      'runtime release handoff proof child acknowledgement timed out'],
    ['crash', 'process.exit(17);', 2_000,
      'runtime release handoff proof child exited before completion'],
  ])('fails closed when the proof child experiences a %s', async (
    _label,
    source,
    timeoutMs,
    reason,
  ) => {
    const fixture = makeFixture();
    const options = { ...fixture.options };
    options.acknowledgementTimeoutMs = timeoutMs;
    const result = await runVerification(options, { proofChildSource: source });

    expect(result).toMatchObject({ ok: false, claimDisposition: 'recorded', reason });
    expect(existsSync(fixture.launchSentinel)).toBe(false);
  });

  it('recognizes exact replay and nonce conflict without spawning another child', async () => {
    const fixture = makeFixture();
    let childCount = 0;
    const hooks = { afterProofChildSpawn: () => { childCount += 1; } };
    const first = await runVerification(fixture.options, hooks);
    expect(first.ok).toBe(true);

    const replay = await runVerification(fixture.options, hooks);
    expect(replay).toMatchObject({
      ok: false,
      claimDisposition: 'replayed',
      reason: 'runtime release handoff claim exact replay',
    });

    const alternatePolicyId = runtimeReleasePolicyId(ALTERNATE_POLICY);
    if (!alternatePolicyId) throw new Error('alternate policy is invalid');
    const conflict = await runVerification({
      ...fixture.options,
      expectedPolicyId: alternatePolicyId,
      policy: ALTERNATE_POLICY,
    }, hooks);
    expect(conflict).toMatchObject({
      ok: false,
      claimDisposition: 'conflicted',
      reason: 'runtime release handoff claim conflict',
    });
    expect(childCount).toBe(1);
  });

  it('binds trust-root identity so a divergent valid root conflicts in the same nonce slot', async () => {
    const fixture = makeFixture();
    const first = await runVerification(fixture.options);
    expect(first.ok).toBe(true);

    const alternateKey = generateKeyPairSync('ed25519');
    const alternateRoot = buildRuntimeReleaseEvidenceTrustRoot({
      keys: [
        {
          publicKey: fixture.publicKey,
          validFrom: fixture.trustValidFrom,
          validUntil: fixture.trustValidUntil,
        },
        {
          publicKey: alternateKey.publicKey,
          validFrom: fixture.trustValidFrom,
          validUntil: fixture.trustValidUntil,
        },
      ],
    });
    if (!alternateRoot.ok) throw new Error(alternateRoot.reason);
    const alternateRootSha = runtimeReleaseTrustRootCanonicalSha256(alternateRoot.canonicalJson);
    if (!alternateRootSha) throw new Error('alternate trust root is invalid');
    const conflict = await runVerification({
      ...fixture.options,
      expectedTrustRootCanonicalSha256: alternateRootSha,
      trustRoot: alternateRoot.canonicalJson,
    });

    expect(conflict).toMatchObject({
      ok: false,
      claimDisposition: 'conflicted',
      reason: 'runtime release handoff claim conflict',
    });
  });

  it('rejects post-acknowledgement replacement while the old launcher descriptor remains open', async () => {
    const fixture = makeFixture();
    const result = await runVerification(fixture.options, {
      afterAcknowledgement: () => replacePinnedFile(fixture.launcherPath),
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime release handoff descriptor identity changed after acknowledgement',
    });
    expect(existsSync(fixture.launchSentinel)).toBe(false);
  });

  it('escalates to group KILL for a real SIGTERM-resistant proof child', async () => {
    const fixture = makeFixture();
    let childPid = 0;
    const result = await runVerification(fixture.options, {
      afterProofChildSpawn: (pid) => { childPid = pid; },
      proofChildSource: acknowledgementSource('process.argv[1]', {
        prefix: "process.on('SIGTERM', () => {});",
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.proofChild.signalsAttempted).toEqual(['SIGTERM', 'SIGKILL']);
    expect(processExists(childPid)).toBe(false);
    expect(processGroupExists(childPid)).toBe(false);
  });

  it('kills a stubborn same-group descendant before reporting success', async () => {
    const fixture = makeFixture();
    const descendantPidPath = join(fixture.parent, 'descendant.pid');
    let processGroupId = 0;
    const descendantProgram = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const prefix = `
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantProgram)}], {
  detached: false,
  stdio: 'ignore',
});
require('node:fs').writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
process.on('SIGTERM', () => {});
`;
    const result = await runVerification(fixture.options, {
      afterProofChildSpawn: (pid) => { processGroupId = pid; },
      proofChildSource: acknowledgementSource('process.argv[1]', { prefix }),
    });

    expect(result.ok).toBe(true);
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(processExists(descendantPid)).toBe(false);
    expect(processGroupExists(processGroupId)).toBe(false);
  });

  it('returns bounded remediation metadata and no termination claim when cleanup is unconfirmed', async () => {
    const fixture = makeFixture();
    let childPid = 0;
    const result = await runVerification(fixture.options, {
      afterProofChildSpawn: (pid) => { childPid = pid; },
      forceCleanupUnconfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime release handoff proof process-group cleanup was not confirmed',
      remediation: {
        bounded: true,
        directChildCloseObserved: true,
        pid: childPid,
        processGroupDeathObserved: false,
        processGroupId: childPid,
      },
    });
    expect(JSON.stringify(result)).not.toContain('"terminated":true');
    expect(result.authority).toEqual({
      activationPermitted: false,
      deployPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      mergePermitted: false,
      rollbackPermitted: false,
      startPermitted: false,
    });
    expect(processExists(childPid)).toBe(false);
    expect(processGroupExists(childPid)).toBe(false);
  });

  it.each(['win32', 'freebsd', 'aix'] as const)(
    'returns platform-unsupported on %s before observing or touching storage',
    async (platform) => {
    let observed = false;
    const result = await observeRuntimeReleaseLaunchHandoffForVerificationOnly(
      {} as RuntimeReleaseLaunchHandoffOptionsV1,
      {
        afterInitialObservation: () => { observed = true; },
        platform,
      },
    );

    expect(result).toEqual({
      ok: false,
      authority: {
        activationPermitted: false,
        deployPermitted: false,
        installPermitted: false,
        launchPermitted: false,
        mergePermitted: false,
        rollbackPermitted: false,
        startPermitted: false,
      },
      claimDisposition: 'not-attempted',
      reason: 'platform-unsupported',
    });
    expect(observed).toBe(false);
    },
  );

  it('contains no daemon, service, or CLI integration surface', () => {
    const source = readFileSync(
      new URL('../src/core/daemon/runtime-release-launch-handoff.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*(?:service|loop|cli|activation-trust-roots)/u);
    expect(source).not.toContain("['daemon', 'start']");
    expect(source).not.toContain('install(');
    expect(source).not.toContain('ensureRunning(');
    expect(source).not.toContain('__testHooks');
    expect(source).not.toContain("process.env['VITEST']");
    expect(source).toContain(
      'observeRuntimeReleaseLaunchHandoffInternal(options, undefined, process.platform)',
    );
  });
});
