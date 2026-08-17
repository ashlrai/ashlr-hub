import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import {
  GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
  _setGoalConductorPermitOperatorTestControlForTest,
  buildGoalConductorPermitRequest,
  canonicalGoalConductorPermitRequest,
  goalConductorPermitPublicationRootPath,
  inspectGoalConductorPermit,
  mintGoalConductorPermitOffline,
  stageGoalConductorPermit,
  writeGoalConductorOperatorArtifact,
} from '../src/core/daemon/goal-conductor-permit-operator.js';
import {
  canonicalizeDaemonActivationValue,
  collectGoalConductorActivationContext,
  consumeGoalConductorActivationPermitForVerification,
  daemonActivationConfigDigest,
  goalConductorActivationNonceReceiptPath,
  goalConductorActivationPermitPath,
  goalConductorActivationReceiptPath,
  type DaemonActivationTrustRoot,
  type GoalConductorActivationContext,
  type GoalConductorActivationTarget,
} from '../src/core/daemon/activation-permit.js';
import { cmdConductorPermit } from '../src/cli/conductor-permit.js';

const NOW = Date.parse('2026-08-16T20:00:00.000Z');
const REVISION = 'a'.repeat(40);
const TARGET: GoalConductorActivationTarget = {
  goalId: 'goal-one',
  milestoneId: 'goal-one-m0',
  goalDigest: 'b'.repeat(64),
  projectPath: '/Users/operator/project',
};
const CFG = { foundry: { simpleConductor: false } } as AshlrConfig;

function context(): GoalConductorActivationContext {
  const releaseRoot = join(resolve(homedir()), '.local', 'share', 'ashlr', 'releases', REVISION);
  return {
    nowMs: NOW,
    configDigest: daemonActivationConfigDigest(CFG),
    buildIdentity: {
      schemaVersion: 1,
      packageVersion: '3.2.7',
      revision: REVISION,
      dirty: null,
      provenance: 'github-actions',
    },
    executable: { path: '/usr/bin/node', sha256: 'c'.repeat(64) },
    entrypoint: { path: join(releaseRoot, 'bin', 'ashlr'), sha256: 'd'.repeat(64) },
    releaseTree: { path: releaseRoot, sha256: 'e'.repeat(64) },
    authorityStateDigest: 'f'.repeat(64),
    killSwitchOff: true,
    guardHealthHealthy: true,
    target: { ...TARGET },
  };
}

function targetResolution() {
  return { ok: true, reason: 'resolved', target: { ...TARGET } };
}

function keyFixture(): { root: DaemonActivationTrustRoot; privateDer: Buffer } {
  const keys = generateKeyPairSync('ed25519');
  return {
    root: {
      keyId: 'offline-custodian-1',
      publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    },
    privateDer: Buffer.from(keys.privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

const rootsToClean: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalArgv1 = process.argv[1];
const BUILD_IDENTITY_STATE = Symbol.for('ashlr.build-identity.v1');
const originalBuildIdentity = Reflect.get(globalThis, BUILD_IDENTITY_STATE) as unknown;
const hadOriginalBuildIdentity = Reflect.has(globalThis, BUILD_IDENTITY_STATE);

function privateFixtureRoot(): string {
  const root = mkdtempSync(join(realpathSync(resolve(homedir())), '.ashlr-permit-m518-'));
  chmodSync(root, 0o700);
  rootsToClean.push(root);
  return root;
}

interface Fixture {
  home: string;
  requestDir: string;
  keyDir: string;
  outputDir: string;
}

function fixture(): Fixture {
  const home = privateFixtureRoot();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const paths = {
    home,
    requestDir: join(home, 'request-transfer'),
    keyDir: join(home, 'offline-key-custody'),
    outputDir: join(home, 'permit-transfer'),
  };
  for (const path of [join(home, '.ashlr'), join(home, '.ashlr', 'control'),
    paths.requestDir, paths.keyDir, paths.outputDir]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  return paths;
}

function installImmutableReleaseFixture(state: Fixture): string {
  const releaseRoot = join(state.home, '.local', 'share', 'ashlr', 'releases', REVISION);
  const bin = join(releaseRoot, 'bin');
  const cli = join(releaseRoot, 'dist', 'cli');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(cli, { recursive: true, mode: 0o700 });
  writeFileSync(join(releaseRoot, 'package.json'), '{"name":"@ashlr/hub","version":"3.2.7"}\n', { mode: 0o600 });
  writeFileSync(join(bin, 'ashlr'), '#!/usr/bin/env node\n', { mode: 0o600 });
  writeFileSync(join(cli, 'index.js'), 'export {};\n', { mode: 0o600 });
  for (const path of [
    join(releaseRoot, 'package.json'), join(bin, 'ashlr'), join(cli, 'index.js'),
  ]) chmodSync(path, 0o444);
  for (const path of [cli, join(releaseRoot, 'dist'), bin, releaseRoot]) chmodSync(path, 0o555);
  process.argv[1] = join(bin, 'ashlr');
  Reflect.set(globalThis, BUILD_IDENTITY_STATE, JSON.stringify({
    schemaVersion: 1,
    packageVersion: '3.2.7',
    revision: REVISION,
    dirty: null,
    provenance: 'github-actions',
  }));
  return releaseRoot;
}

function makeFixtureTreeRemovable(root: string): void {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop()!;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else chmodSync(child, 0o600);
    }
  }
}

function buildRequest(
  state: Fixture,
  root: DaemonActivationTrustRoot,
  name = 'request.json',
  runtimeContext = context(),
) {
  const outputPath = join(state.requestDir, name);
  return {
    outputPath,
    result: buildGoalConductorPermitRequest(CFG, {
      goalId: TARGET.goalId,
      expectedReleaseRevision: REVISION,
      outputPath,
    }, {
      trustRoots: [root],
      resolveTarget: targetResolution,
      collectContext: () => runtimeContext,
      verifyInstalledRelease: () => null,
      nowMs: () => NOW,
    }),
  };
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalArgv1;
  if (hadOriginalBuildIdentity) Reflect.set(globalThis, BUILD_IDENTITY_STATE, originalBuildIdentity);
  else Reflect.deleteProperty(globalThis, BUILD_IDENTITY_STATE);
  _setGoalConductorPermitOperatorTestControlForTest(
    GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
    undefined,
  );
  for (const root of rootsToClean.splice(0)) {
    makeFixtureTreeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('M518 dormant goal-conductor permit request', () => {
  it('blocks before target/context work when compiled production roots are empty', () => {
    const resolveTarget = vi.fn(targetResolution);
    const collectContext = vi.fn(() => context());
    const result = buildGoalConductorPermitRequest(CFG, {
      goalId: TARGET.goalId,
      expectedReleaseRevision: REVISION,
      outputPath: '/not-written/request.json',
    }, { resolveTarget, collectContext, trustRoots: [] });
    expect(result).toEqual({
      ok: false,
      state: 'blocked',
      reason: 'no-trusted-goal-conductor-activation-roots',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(collectContext).not.toHaveBeenCalled();
  });

  it('requires complete exact target, strict config, healthy guards, and exact GitHub Actions release', () => {
    const state = fixture();
    const { root } = keyFixture();
    const base = {
      trustRoots: [root],
      resolveTarget: targetResolution,
      collectContext: () => context(),
      nowMs: () => NOW,
    };
    expect(buildGoalConductorPermitRequest(CFG, {
      goalId: TARGET.goalId,
      expectedReleaseRevision: REVISION,
      outputPath: join(state.requestDir, 'request.json'),
    }, { ...base, verifyInstalledRelease: () => null }).ok).toBe(true);

    for (const [reason, mutate] of [
      ['kill-switch-is-on', (value: GoalConductorActivationContext) => { value.killSwitchOff = false; }],
      ['guard-health-degraded', (value: GoalConductorActivationContext) => { value.guardHealthHealthy = false; }],
      ['goal-conductor-runtime-build-identity-not-exact-github-actions-release',
        (value: GoalConductorActivationContext) => { value.buildIdentity.provenance = 'git'; value.buildIdentity.dirty = false; }],
    ] as const) {
      const changed = context();
      mutate(changed);
      const result = buildGoalConductorPermitRequest(CFG, {
        goalId: TARGET.goalId,
        expectedReleaseRevision: REVISION,
        outputPath: join(state.requestDir, 'request.json'),
      }, {
        ...base,
        collectContext: () => changed,
        verifyInstalledRelease: reason.startsWith('goal-conductor-runtime')
          ? undefined
          : () => null,
      });
      expect(result.reason).toBe(reason);
    }
  });

  it('requires a preexisting exact-private Ashlr control directory and never creates it', () => {
    const state = fixture();
    const { root } = keyFixture();
    rmSync(join(state.home, '.ashlr', 'control'), { recursive: true });
    const result = buildGoalConductorPermitRequest(CFG, {
      goalId: TARGET.goalId,
      expectedReleaseRevision: REVISION,
      outputPath: join(state.requestDir, 'request.json'),
    }, {
      trustRoots: [root], resolveTarget: targetResolution,
      collectContext: () => context(), verifyInstalledRelease: () => null,
    });
    expect(result.reason).toBe('goal-conductor-preexisting-private-control-required');
    expect(existsSync(join(state.home, '.ashlr', 'control'))).toBe(false);
  });

  it('refuses request output inside Ashlr or the exact bound project tree', () => {
    const state = fixture();
    const { root } = keyFixture();
    const runtimeContext = context();
    runtimeContext.target.projectPath = state.requestDir;
    const dependencies = {
      trustRoots: [root], resolveTarget: targetResolution,
      collectContext: () => runtimeContext, verifyInstalledRelease: () => null,
    };
    for (const outputPath of [
      join(state.home, '.ashlr', 'control', 'request.json'),
      join(state.requestDir, 'request.json'),
    ]) {
      expect(buildGoalConductorPermitRequest(CFG, {
        goalId: TARGET.goalId,
        expectedReleaseRevision: REVISION,
        outputPath,
      }, dependencies).reason).toBe('goal-conductor-operator-output-inside-bound-or-custody-tree');
      expect(existsSync(outputPath)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === 'win32')('M518 offline mint, inspection, and staging custody', () => {
  it('mints only a matching Ed25519 PKCS#8 key, exactly 120 seconds, and zeroes no path into output', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result: requestResult } = buildRequest(state, matching.root);
    expect(requestResult.ok).toBe(true);
    writeGoalConductorOperatorArtifact(requestPath, requestResult.value);
    const keyPath = join(state.keyDir, 'custodian.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const outputPath = join(state.outputDir, 'permit.json');

    const minted = mintGoalConductorPermitOffline({
      requestPath, privateKeyPath: keyPath, outputPath, nowMs: NOW,
    });
    expect(minted.ok).toBe(true);
    expect(Date.parse(minted.value!.payload.expiresAt) - Date.parse(minted.value!.payload.issuedAt))
      .toBe(120_000);
    const serialized = canonicalizeDaemonActivationValue(minted.value);
    expect(serialized).not.toContain(keyPath);
    expect(serialized).not.toContain('PRIVATE KEY');

    const wrong = keyFixture();
    const wrongPath = join(state.keyDir, 'wrong.pk8');
    writeFileSync(wrongPath, wrong.privateDer, { mode: 0o600 });
    chmodSync(wrongPath, 0o600);
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: wrongPath,
      outputPath,
      nowMs: NOW,
    }).reason).toBe('goal-conductor-private-key-not-request-trusted');
  });

  it('rejects writable, linked, noncanonical, and non-PKCS8 key inputs without output', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    const request = result.value!;
    writeGoalConductorOperatorArtifact(requestPath, request);
    const keyPath = join(state.keyDir, 'unsafe.pk8');
    const outputPath = join(state.outputDir, 'permit.json');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: keyPath, outputPath }).ok).toBe(false);
    chmodSync(keyPath, 0o600);
    writeFileSync(keyPath, 'not-pkcs8', { mode: 0o600 });
    expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: keyPath, outputPath }).reason)
      .toBe('goal-conductor-private-key-invalid');
  });

  it('fails closed for missing and descriptor-unsafe pinned inputs without output', () => {
    const state = fixture();
    const matching = keyFixture();
    const outputPath = join(state.outputDir, 'permit.json');
    const keyPath = join(state.keyDir, 'key.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    expect(mintGoalConductorPermitOffline({
      requestPath: join(state.requestDir, 'missing.json'),
      privateKeyPath: keyPath,
      outputPath,
    })).toMatchObject({ ok: false, state: 'degraded' });

    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    chmodSync(requestPath, 0o644);
    expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: keyPath, outputPath }))
      .toMatchObject({ ok: false, state: 'degraded' });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects an open-to-named swap before reading or transferring key bytes', () => {
    const state = fixture();
    const matching = keyFixture();
    const replacement = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'key.pk8');
    const displacedPath = join(state.keyDir, 'displaced.pk8');
    const replacementPath = join(state.keyDir, 'replacement.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    writeFileSync(replacementPath, replacement.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    chmodSync(replacementPath, 0o600);
    const observed: Buffer[] = [];
    _setGoalConductorPermitOperatorTestControlForTest(
      GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
      {
        pinnedFileAfterOpen: ({ path }) => {
          if (path !== keyPath) return;
          renameSync(keyPath, displacedPath);
          renameSync(replacementPath, keyPath);
        },
        observePinnedFileBuffer: (path, bytes) => {
          if (path === keyPath) observed.push(bytes);
        },
      },
    );
    const outputPath = join(state.outputDir, 'permit.json');
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath,
      nowMs: NOW,
    })).toMatchObject({ ok: false, state: 'degraded' });
    expect(observed).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('accepts an owned group-writable HOME anchor above exact-private custody', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    chmodSync(state.home, 0o770);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'group-custody.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    })).toMatchObject({ ok: true, state: 'ready' });
  });

  it('rejects world-writable and symlinked custody above an exact-private parent', () => {
    const state = fixture();
    const matching = keyFixture();
    const { result } = buildRequest(state, matching.root);
    const unsafeAncestor = join(state.home, 'unsafe-ancestor');
    const unsafeParent = join(unsafeAncestor, 'transfer');
    mkdirSync(unsafeAncestor, { mode: 0o700 });
    mkdirSync(unsafeParent, { mode: 0o700 });
    chmodSync(unsafeAncestor, 0o777);
    chmodSync(unsafeParent, 0o700);
    const unsafePath = join(unsafeParent, 'request.json');
    expect(() => writeGoalConductorOperatorArtifact(unsafePath, result.value))
      .toThrow('unsafe-custody-ancestor');
    expect(existsSync(unsafePath)).toBe(false);

    chmodSync(unsafeAncestor, 0o700);
    const realAncestor = join(state.home, 'real-ancestor');
    const realParent = join(realAncestor, 'transfer');
    const linkedAncestor = join(state.home, 'linked-ancestor');
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    chmodSync(realAncestor, 0o700);
    chmodSync(realParent, 0o700);
    symlinkSync(realAncestor, linkedAncestor, 'dir');
    const linkedPath = join(linkedAncestor, 'transfer', 'request.json');
    expect(() => writeGoalConductorOperatorArtifact(linkedPath, result.value)).toThrow();
    expect(existsSync(linkedPath)).toBe(false);
  });

  it('rejects a foreign-owned custody parent after descriptor open', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'foreign-parent.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const actualUid = process.getuid!();
    let restoreUid: (() => void) | undefined;
    _setGoalConductorPermitOperatorTestControlForTest(
      GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
      {
        pinnedFileAfterOpen: ({ path }) => {
          if (path !== keyPath) return;
          const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
          restoreUid = () => uidSpy.mockRestore();
        },
      },
    );
    const outputPath = join(state.outputDir, 'permit.json');
    try {
      expect(mintGoalConductorPermitOffline({
        requestPath,
        privateKeyPath: keyPath,
        outputPath,
        nowMs: NOW,
      })).toMatchObject({ ok: false, state: 'degraded' });
    } finally {
      restoreUid?.();
    }
    expect(existsSync(outputPath)).toBe(false);
  });

  it('inspect is read-only; stage is O_EXCL 0600 and returns only the exact loop target', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    const request = result.value!;
    writeGoalConductorOperatorArtifact(requestPath, request);
    const keyPath = join(state.keyDir, 'key.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const envelope = mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    }).value!;
    const dependencies = {
      trustRoots: [matching.root], resolveTarget: targetResolution,
      collectContext: () => context(),
      verifyInstalledRelease: () => null,
    };
    const before = readFileSync(requestPath, 'utf8');
    const inspected = inspectGoalConductorPermit(CFG, envelope, dependencies);
    expect(inspected).toMatchObject({
      ok: true,
      state: 'ready',
      command: ['ashlr', 'loop', '--goal', TARGET.goalId],
    });
    expect(readFileSync(requestPath, 'utf8')).toBe(before);
    expect(existsSync(goalConductorPermitPublicationRootPath())).toBe(false);

    const authorityBefore = statSync(join(state.home, '.ashlr'), { bigint: true });
    const staged = stageGoalConductorPermit(CFG, envelope, dependencies);
    expect(staged).toMatchObject({
      ok: true,
      state: 'staged',
      command: ['ashlr', 'loop', '--goal', TARGET.goalId],
    });
    const permitPath = goalConductorActivationPermitPath();
    expect(readFileSync(permitPath, 'utf8')).toBe(`${canonicalizeDaemonActivationValue(envelope)}\n`);
    const authorityAfter = statSync(join(state.home, '.ashlr'), { bigint: true });
    expect({
      dev: authorityAfter.dev,
      ino: authorityAfter.ino,
      mtimeNs: authorityAfter.mtimeNs,
      ctimeNs: authorityAfter.ctimeNs,
    }).toEqual({
      dev: authorityBefore.dev,
      ino: authorityBefore.ino,
      mtimeNs: authorityBefore.mtimeNs,
      ctimeNs: authorityBefore.ctimeNs,
    });
    expect(stageGoalConductorPermit(CFG, envelope, dependencies).reason)
      .toBe('goal-conductor-staged-permit-already-exists');
  });

  it('rejects noncanonical request bytes before opening a signing key', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    const request = result.value!;
    writeFileSync(requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });
    chmodSync(requestPath, 0o600);
    const absentKey = join(state.keyDir, 'does-not-exist.pk8');
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: absentKey,
      outputPath: join(state.outputDir, 'permit.json'),
    }).reason)
      .toBe('goal-conductor-permit-request-not-canonical');
    expect(canonicalGoalConductorPermitRequest(request)).not.toBe(readFileSync(requestPath, 'utf8'));
  });

  it('zeroes every observed private-key buffer on success and parse failure', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const observed: Buffer[] = [];
    _setGoalConductorPermitOperatorTestControlForTest(
      GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
      { observePrivateKeyBuffer: (bytes) => observed.push(bytes) },
    );
    const validKey = join(state.keyDir, 'valid.pk8');
    writeFileSync(validKey, matching.privateDer, { mode: 0o600 });
    chmodSync(validKey, 0o600);
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: validKey,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    }).ok).toBe(true);
    const invalidKey = join(state.keyDir, 'invalid.pk8');
    writeFileSync(invalidKey, 'invalid-private-key', { mode: 0o600 });
    chmodSync(invalidKey, 0o600);
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: invalidKey,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    }).reason).toBe('goal-conductor-private-key-invalid');
    expect(observed).toHaveLength(2);
    for (const bytes of observed) expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    'mid-read',
    'short-read',
    'post-fstat',
    'post-lstat',
    'close',
  ] as const)('zeroes the owned key buffer on injected %s failure before transfer', (fault) => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'faulted.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    const observed: Buffer[] = [];
    _setGoalConductorPermitOperatorTestControlForTest(
      GOAL_CONDUCTOR_PERMIT_OPERATOR_TEST_CONTROL,
      {
        observePinnedFileBuffer: (path, bytes) => {
          if (path === keyPath) observed.push(bytes);
        },
        ...(fault === 'mid-read' || fault === 'short-read' ? {
          pinnedFileRead: ({ path, offset, length, read }) => {
            if (path !== keyPath) return read();
            if (offset === 0) return read(Math.max(1, Math.floor(length / 2)));
            if (fault === 'mid-read') throw new Error('injected-mid-read-failure');
            return 0;
          },
        } : {}),
        ...(fault === 'post-fstat' ? {
          pinnedFilePostFstat: ({ path, stat }) => {
            const snapshot = stat();
            if (path === keyPath) throw new Error('injected-post-fstat-failure');
            return snapshot;
          },
        } : {}),
        ...(fault === 'post-lstat' ? {
          pinnedFilePostLstat: ({ path, stat }) => {
            const snapshot = stat();
            if (path === keyPath) throw new Error('injected-post-lstat-failure');
            return snapshot;
          },
        } : {}),
        ...(fault === 'close' ? {
          pinnedFileClose: ({ path, close }) => {
            close();
            if (path === keyPath) throw new Error('injected-close-failure');
          },
        } : {}),
      },
    );
    const outputPath = join(state.outputDir, 'permit.json');
    expect(mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath,
      nowMs: NOW,
    })).toMatchObject({ ok: false, state: 'degraded', reason: 'goal-conductor-offline-mint-failed' });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.every((byte) => byte === 0)).toBe(true);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('keeps the private key outside Ashlr, request, output, repository, and linked custody', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const outputPath = join(state.outputDir, 'permit.json');
    const forbidden = [
      join(state.home, '.ashlr', 'control', 'key.pk8'),
      join(state.requestDir, 'key.pk8'),
      join(state.outputDir, 'key.pk8'),
    ];
    for (const keyPath of forbidden) {
      writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: keyPath, outputPath }).reason)
        .toBe('goal-conductor-private-key-inside-forbidden-tree');
    }
    const repo = join(state.home, 'offline-repo');
    const repoKeyDir = join(repo, 'custody');
    mkdirSync(join(repo, '.git'), { recursive: true, mode: 0o700 });
    mkdirSync(repoKeyDir, { mode: 0o700 });
    chmodSync(repo, 0o700);
    chmodSync(join(repo, '.git'), 0o700);
    chmodSync(repoKeyDir, 0o700);
    const repoKey = join(repoKeyDir, 'key.pk8');
    writeFileSync(repoKey, matching.privateDer, { mode: 0o600 });
    expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: repoKey, outputPath }).reason)
      .toBe('goal-conductor-private-key-inside-forbidden-tree');

    const safeKey = join(state.keyDir, 'safe.pk8');
    const linkedKey = join(state.keyDir, 'linked.pk8');
    writeFileSync(safeKey, matching.privateDer, { mode: 0o600 });
    linkSync(safeKey, linkedKey);
    expect(mintGoalConductorPermitOffline({ requestPath, privateKeyPath: linkedKey, outputPath }).ok)
      .toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects expired, target-drifted, and replayed permits without staging', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'key.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    const envelope = mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    }).value!;
    const base = {
      trustRoots: [matching.root],
      resolveTarget: targetResolution,
      verifyInstalledRelease: () => null,
    };
    const expired = context();
    expired.nowMs = NOW + 120_000;
    expect(inspectGoalConductorPermit(CFG, envelope, {
      ...base, collectContext: () => expired,
    }).reason).toBe('permit-expired');
    expect(inspectGoalConductorPermit(CFG, envelope, {
      ...base,
      resolveTarget: () => ({
        ok: true,
        reason: 'drifted',
        target: { ...TARGET, goalDigest: '9'.repeat(64) },
      }),
      collectContext: (_cfg, target) => ({ ...context(), target }),
    }).reason).toBe('goal-conductor-permit-runtime-binding-mismatch');

    const liveResolve = vi.fn(targetResolution);
    const liveContext = vi.fn(() => context());
    expect(stageGoalConductorPermit(CFG, envelope, {
      ...base, resolveTarget: liveResolve, collectContext: liveContext,
    }).ok).toBe(true);
    expect(liveResolve).toHaveBeenCalledTimes(1);
    expect(liveContext).toHaveBeenCalledTimes(1);
    const consumed = consumeGoalConductorActivationPermitForVerification(CFG, TARGET, {
      trustRoots: [matching.root],
      context: context(),
    });
    expect(consumed.authorized).toBe(true);
    expect(existsSync(goalConductorActivationPermitPath())).toBe(false);
    expect(existsSync(goalConductorActivationReceiptPath(envelope.payload.permitId))).toBe(true);
    expect(inspectGoalConductorPermit(CFG, envelope, {
      ...base, collectContext: () => context(),
    }).reason).toBe('goal-conductor-permit-already-consumed');
  });

  it('stages and consumes through default live context and immutable-release verification, then refuses drift', () => {
    const state = fixture();
    installImmutableReleaseFixture(state);
    const target: GoalConductorActivationTarget = {
      ...TARGET,
      projectPath: join(state.home, 'enrolled-project'),
    };
    mkdirSync(target.projectPath, { mode: 0o700 });
    chmodSync(target.projectPath, 0o700);
    const resolveTarget = () => ({ ok: true, reason: 'resolved', target: { ...target } });
    const matching = keyFixture();
    const keyPath = join(state.keyDir, 'default-path-key.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const mintDefaultPathPermit = (suffix: string) => {
      const requestPath = join(state.requestDir, `request-${suffix}.json`);
      const request = buildGoalConductorPermitRequest(CFG, {
        goalId: target.goalId,
        expectedReleaseRevision: REVISION,
        outputPath: requestPath,
      }, {
        trustRoots: [matching.root],
        resolveTarget,
      });
      expect(request).toMatchObject({ ok: true, state: 'ready' });
      const independentlyCollected = collectGoalConductorActivationContext(CFG, target);
      expect({ ...request.value!.context, nowMs: 0 })
        .toEqual({ ...independentlyCollected, nowMs: 0 });
      writeGoalConductorOperatorArtifact(requestPath, request.value);
      const minted = mintGoalConductorPermitOffline({
        requestPath,
        privateKeyPath: keyPath,
        outputPath: join(state.outputDir, `permit-${suffix}.json`),
        nowMs: Date.now(),
      });
      expect(minted).toMatchObject({ ok: true, state: 'ready' });
      return minted.value!;
    };

    const envelope = mintDefaultPathPermit('success');
    expect(stageGoalConductorPermit(CFG, envelope, {
      trustRoots: [matching.root],
      resolveTarget,
    })).toMatchObject({ ok: true, state: 'staged' });
    const consumed = consumeGoalConductorActivationPermitForVerification(CFG, target, {
      trustRoots: [matching.root],
    });
    expect(consumed).toMatchObject({
      authorized: true,
      reason: 'goal-conductor-proposal-once-activation-authorized',
      permitId: envelope.payload.permitId,
    });
    expect(existsSync(goalConductorActivationPermitPath())).toBe(false);
    expect(existsSync(goalConductorActivationReceiptPath(envelope.payload.permitId))).toBe(true);
    const nonceDigest = createHash('sha256').update(envelope.payload.nonce, 'utf8').digest('hex');
    expect(existsSync(goalConductorActivationNonceReceiptPath(nonceDigest))).toBe(true);

    const driftedEnvelope = mintDefaultPathPermit('drift');
    expect(stageGoalConductorPermit(CFG, driftedEnvelope, {
      trustRoots: [matching.root],
      resolveTarget,
    })).toMatchObject({ ok: true, state: 'staged' });
    const entrypoint = process.argv[1]!;
    chmodSync(entrypoint, 0o600);
    writeFileSync(entrypoint, '#!/usr/bin/env node\n// drift\n', { mode: 0o600 });
    chmodSync(entrypoint, 0o444);
    expect(consumeGoalConductorActivationPermitForVerification(CFG, target, {
      trustRoots: [matching.root],
    })).toMatchObject({
      authorized: false,
      reason: 'goal-conductor-permit-runtime-binding-mismatch',
    });
    expect(existsSync(goalConductorActivationPermitPath())).toBe(true);
    expect(existsSync(goalConductorActivationReceiptPath(driftedEnvelope.payload.permitId))).toBe(false);
  });

  it('recovers authenticated one-link and two-link publication crash states with exact inode custody', () => {
    const state = fixture();
    const matching = keyFixture();
    const { outputPath: requestPath, result } = buildRequest(state, matching.root);
    writeGoalConductorOperatorArtifact(requestPath, result.value!);
    const keyPath = join(state.keyDir, 'key.pk8');
    writeFileSync(keyPath, matching.privateDer, { mode: 0o600 });
    const envelope = mintGoalConductorPermitOffline({
      requestPath,
      privateKeyPath: keyPath,
      outputPath: join(state.outputDir, 'permit.json'),
      nowMs: NOW,
    }).value!;
    const root = goalConductorPermitPublicationRootPath();
    const records = join(root, 'records');
    const staging = join(root, 'staging');
    for (const path of [root, records, staging]) {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const canonical = `${canonicalizeDaemonActivationValue(envelope)}\n`;
    const token = createHash('sha256')
      .update(canonicalizeDaemonActivationValue(envelope), 'utf8')
      .digest('hex')
      .slice(0, 32);
    const stagePath = join(staging, `.${envelope.payload.permitId}.${token}.stage`);
    writeFileSync(stagePath, canonical, { mode: 0o600 });
    const dependencies = {
      trustRoots: [matching.root], resolveTarget: targetResolution,
      collectContext: () => context(), verifyInstalledRelease: () => null,
    };
    expect(stageGoalConductorPermit(CFG, envelope, dependencies).ok).toBe(true);
    const target = goalConductorActivationPermitPath();
    expect(readFileSync(target, 'utf8')).toBe(canonical);
    expect(readdirSync(staging)).toEqual([]);
    expect(statSync(target).nlink).toBe(1);

    rmSync(target);
    writeFileSync(stagePath, canonical, { mode: 0o600 });
    linkSync(stagePath, target);
    expect(statSync(stagePath).ino).toBe(statSync(target).ino);
    expect(statSync(stagePath).nlink).toBe(2);
    expect(stageGoalConductorPermit(CFG, envelope, dependencies).ok).toBe(true);
    expect(existsSync(stagePath)).toBe(false);
    expect(statSync(target).nlink).toBe(1);
  });

  it('CLI rejects relative custody paths without disclosing them or writing output', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdConductorPermit([
        'mint', '--request', 'relative-request.json', '--key', 'secret-key.pk8',
        '--out', 'relative-permit.json',
      ])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(
        'conductor-permit refused: invalid, unsafe, or unavailable input',
      );
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('secret-key.pk8');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});

describe('M518 source authority guards', () => {
  it('keeps production roots frozen empty and does not add a second activation CLI', () => {
    const activation = readFileSync(
      new URL('../src/core/daemon/activation-permit.ts', import.meta.url),
      'utf8',
    );
    const cli = readFileSync(new URL('../src/cli/conductor-permit.ts', import.meta.url), 'utf8');
    expect(activation).toMatch(/GOAL_CONDUCTOR_ACTIVATION_TRUST_ROOTS:[\s\S]*Object\.freeze\(\[\]\)/u);
    expect(existsSync(new URL('../src/cli/activation.ts', import.meta.url))).toBe(false);
    expect(cli).not.toMatch(/node:child_process|reserveGoalConductorProviderQuota|runAuthorizedConductorOnce/u);
  });
});
