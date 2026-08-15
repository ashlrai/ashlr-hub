import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { observeExecutionPlan } = vi.hoisted(() => ({
  observeExecutionPlan: vi.fn(),
}));

vi.mock('../src/core/daemon/runtime-activation-authority.js', () => ({
  observeRuntimeActivationExecutionPlan: observeExecutionPlan,
}));

import {
  observeRuntimeActivationLaunchHandoffForVerificationOnly,
  type RuntimeActivationLaunchHandoffOptionsV1,
} from '../src/core/daemon/runtime-activation-launch-handoff.js';

const ADMISSION_DIGEST = 'a'.repeat(64);
const PLAN_DIGEST = 'b'.repeat(64);
const REPLAY_KEY = 'c'.repeat(64);
const REQUEST_DIGEST = 'd'.repeat(64);
const TRUST_DIGEST = 'e'.repeat(64);
const CANDIDATE_RECEIPT = '1'.repeat(64);
const ROLLBACK_RECEIPT = '2'.repeat(64);
const tempDirs: string[] = [];

interface Fixture {
  activationRoot: string;
  home: string;
  launcher: string;
  options: RuntimeActivationLaunchHandoffOptionsV1;
  parent: string;
  plan: ReturnType<typeof activationPlan>;
  requestPath: string;
}

function write(path: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: 'utf8', mode });
  chmodSync(path, mode);
}

function activationPlan(input: {
  dependencyRoot: string;
  launcher: string;
  packageRoot: string;
}) {
  return {
    preflight: {
      plan: {
        admissionDigest: ADMISSION_DIGEST,
        planDigest: PLAN_DIGEST,
        replayKey: REPLAY_KEY,
      },
    },
    request: {
      candidate: {
        argv: [input.launcher, 'daemon', 'start'],
        declaredInterpreterPath: process.execPath,
        dependencyRoot: input.dependencyRoot,
        executablePath: process.execPath,
        packageRoot: input.packageRoot,
      },
    },
    canonicalRequestSha256: REQUEST_DIGEST,
    trustRootCanonicalSha256: TRUST_DIGEST,
    candidateLaunchReceiptSha256: CANDIDATE_RECEIPT,
    rollbackLaunchReceiptSha256: ROLLBACK_RECEIPT,
  };
}

function fixture(): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m515-')));
  tempDirs.push(parent);
  const home = join(parent, 'home');
  const activationRoot = join(home, '.ashlr', 'control', 'activation');
  mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
  chmodSync(activationRoot, 0o700);
  const packageRoot = join(parent, 'candidate');
  const dependencyRoot = join(packageRoot, 'node_modules');
  const launcher = join(packageRoot, 'bin', 'ashlr');
  mkdirSync(dependencyRoot, { recursive: true });
  write(launcher, '#!/bin/sh\nexit 91\n', 0o500);
  const requestPath = join(activationRoot, 'plans', 'plan.json');
  write(requestPath, '{}\n');
  const plan = activationPlan({ dependencyRoot, launcher, packageRoot });
  return {
    activationRoot,
    home,
    launcher,
    options: {
      expectedAdmissionDigest: ADMISSION_DIGEST,
      requestPath,
    },
    parent,
    plan,
    requestPath,
  };
}

function installObservation(plan: ReturnType<typeof activationPlan>): void {
  observeExecutionPlan.mockImplementation(() => structuredClone(plan));
}

function verificationHooks(home: string) {
  return { homePath: home, platform: 'darwin' as const };
}

function recordText(f: Fixture): string {
  const records = join(f.activationRoot, 'handoff-claims-v1', 'records');
  const entries = readdirSync(records);
  expect(entries).toHaveLength(1);
  return readFileSync(join(records, entries[0]!), 'utf8');
}

beforeEach(() => {
  observeExecutionPlan.mockReset();
});

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('M515 activation-bound launch handoff', () => {
  it('retains exact admitted descriptors through a canonical ACK and proves child-group death', async () => {
    const f = fixture();
    installObservation(f.plan);

    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      verificationHooks(f.home),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authority).toEqual({
      activationPermitted: false,
      deployPermitted: false,
      dispatchPermitted: false,
      effectPermitted: false,
      installPermitted: false,
      launchPermitted: false,
      mergePermitted: false,
      rollbackPermitted: false,
      serviceMutationPermitted: false,
      startPermitted: false,
    });
    expect(result.receipt.bindings).toEqual({
      admissionDigest: ADMISSION_DIGEST,
      candidateLaunchReceiptSha256: CANDIDATE_RECEIPT,
      canonicalRequestSha256: REQUEST_DIGEST,
      planDigest: PLAN_DIGEST,
      rollbackLaunchReceiptSha256: ROLLBACK_RECEIPT,
      trustRootCanonicalSha256: TRUST_DIGEST,
    });
    expect(result.receipt.proofChild).toMatchObject({
      acknowledged: true,
      directChildCloseObserved: true,
      processGroupDeathObserved: true,
      terminated: true,
    });
    expect(result.receipt.proofChild.signalsAttempted[0]).toBe('SIGTERM');
    expect(observeExecutionPlan).toHaveBeenCalledTimes(3);

    const persisted = recordText(f);
    expect(persisted).not.toContain(f.home);
    expect(persisted).not.toContain(f.parent);
    expect(persisted).not.toContain(f.requestPath);
    expect(persisted).not.toContain(REPLAY_KEY);
    expect(persisted).not.toMatch(/argv|environment|manifest|prompt|output|policy/i);
  });

  it('consumes cooperative replay before spawning another proof child', async () => {
    const f = fixture();
    installObservation(f.plan);
    const first = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      verificationHooks(f.home),
    );
    expect(first.ok).toBe(true);

    const spawned = vi.fn();
    const second = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      { ...verificationHooks(f.home), afterProofChildSpawn: spawned },
    );
    expect(second).toMatchObject({
      ok: false,
      claimDisposition: 'replayed',
      reason: 'runtime activation handoff claim exact replay',
    });
    expect(spawned).not.toHaveBeenCalled();
  });

  it('refuses an admission digest mismatch before claim storage or child spawn', async () => {
    const f = fixture();
    installObservation(f.plan);
    const spawned = vi.fn();
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      { ...f.options, expectedAdmissionDigest: 'f'.repeat(64) },
      { ...verificationHooks(f.home), afterProofChildSpawn: spawned },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'not-attempted',
      reason: 'runtime activation handoff admission digest mismatch',
    });
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(join(f.activationRoot, 'handoff-claims-v1'))).toBe(false);
  });

  it('rejects excess fields and accessors without evaluating hostile input', async () => {
    const f = fixture();
    installObservation(f.plan);
    const getter = vi.fn(() => ADMISSION_DIGEST);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'expectedAdmissionDigest', {
      enumerable: true,
      get: getter,
    });
    Object.defineProperty(hostile, 'requestPath', {
      enumerable: true,
      value: f.requestPath,
    });
    const accessorResult = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      hostile as unknown as RuntimeActivationLaunchHandoffOptionsV1,
      verificationHooks(f.home),
    );
    expect(accessorResult).toMatchObject({
      ok: false,
      reason: 'runtime activation handoff input is invalid',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(observeExecutionPlan).not.toHaveBeenCalled();

    const excessResult = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      { ...f.options, unexpected: true } as RuntimeActivationLaunchHandoffOptionsV1,
      verificationHooks(f.home),
    );
    expect(excessResult).toMatchObject({
      ok: false,
      reason: 'runtime activation handoff input is invalid',
    });
  });

  it('detects post-ACK admission-output drift and still proves cleanup', async () => {
    const f = fixture();
    let calls = 0;
    observeExecutionPlan.mockImplementation(() => {
      calls += 1;
      const plan = structuredClone(f.plan);
      if (calls >= 3) plan.preflight.plan.planDigest = '9'.repeat(64);
      return plan;
    });
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      verificationHooks(f.home),
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime activation handoff stable admission identity changed after acknowledgement',
    });
  });

  it('rejects named launcher replacement before recording a claim', async () => {
    const f = fixture();
    installObservation(f.plan);
    const prior = `${f.launcher}.prior`;
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      {
        ...verificationHooks(f.home),
        afterDescriptorsPinned: () => {
          renameSync(f.launcher, prior);
          write(f.launcher, '#!/bin/sh\nexit 92\n', 0o500);
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'not-attempted',
      reason: 'runtime activation handoff named identity changed before claim',
    });
  });

  it('rejects a symlinked launcher before recording a claim or spawning a child', async () => {
    const f = fixture();
    installObservation(f.plan);
    const prior = `${f.launcher}.prior`;
    renameSync(f.launcher, prior);
    symlinkSync(prior, f.launcher);
    const spawned = vi.fn();
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      { ...verificationHooks(f.home), afterProofChildSpawn: spawned },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'not-attempted',
    });
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(join(f.activationRoot, 'handoff-claims-v1'))).toBe(false);
  });

  it('rejects a named launcher swap after open before recording a claim', async () => {
    const f = fixture();
    installObservation(f.plan);
    const prior = `${f.launcher}.prior`;
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      {
        ...verificationHooks(f.home),
        afterDescriptorOpened: (label) => {
          if (label !== 'launcher') return;
          renameSync(f.launcher, prior);
          write(f.launcher, '#!/bin/sh\nexit 92\n', 0o500);
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'not-attempted',
      reason: 'runtime activation handoff launcher changed before descriptor pin',
    });
    expect(existsSync(join(f.activationRoot, 'handoff-claims-v1'))).toBe(false);
  });

  it.each([
    ['noncanonical JSON', "process.stdout.end('{}\\n'); setInterval(() => {}, 1000);"],
    ['CRLF frame', "process.stdout.end('{}\\r\\n'); setInterval(() => {}, 1000);"],
  ])('rejects a %s acknowledgement and confirms cleanup', async (_label, proofChildSource) => {
    const f = fixture();
    installObservation(f.plan);
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      f.options,
      { ...verificationHooks(f.home), proofChildSource },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
    });
    if (!result.ok) expect(result.remediation).toBeUndefined();
  });

  it('bounds a missing acknowledgement and kills the proof process group', async () => {
    const f = fixture();
    installObservation(f.plan);
    const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
      { ...f.options, acknowledgementTimeoutMs: 20 },
      {
        ...verificationHooks(f.home),
        proofChildSource: 'setInterval(() => {}, 1000);',
      },
    );
    expect(result).toMatchObject({
      ok: false,
      claimDisposition: 'recorded',
      reason: 'runtime activation handoff proof child acknowledgement timed out',
    });
  });

  it.each(['linux', 'win32', 'freebsd'] as const)(
    'refuses %s before admission observation or storage',
    async (platform) => {
      const f = fixture();
      installObservation(f.plan);
      const result = await observeRuntimeActivationLaunchHandoffForVerificationOnly(
        f.options,
        { homePath: f.home, platform },
      );
      expect(result).toMatchObject({ ok: false, reason: 'platform-unsupported' });
      expect(observeExecutionPlan).not.toHaveBeenCalled();
      expect(existsSync(join(f.activationRoot, 'handoff-claims-v1'))).toBe(false);
    },
  );

  it('has no service, launchctl, daemon, provider, or activation transaction consumer', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/core/daemon/runtime-activation-launch-handoff.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*(?:service|launchd-plist-transaction|runtime-activation-transaction)/);
    expect(source).not.toMatch(/launchctl|activateRuntimeRelease|daemon start|provider/i);
    expect(source).not.toMatch(/child_process.*exec|execFile|shell:\s*true/);
  });
});
