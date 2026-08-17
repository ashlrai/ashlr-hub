import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeControl = vi.hoisted(() => ({
  roots: [] as unknown[],
  nowMs: Date.now(),
  journalKey: null as Buffer | null,
  returnedJournalKeys: [] as Buffer[],
  observeLaunchd: (() => ({ loaded: false as const, disabled: true })) as () => { loaded: false; disabled: boolean },
  observeMaintenance: (() => ({ ok: false, reason: 'unset', daemonRoots: 0, daemonDescendants: 0 })) as
    () => { ok: boolean; reason: string; daemonRoots: number; daemonDescendants: number },
  acquireOutward: (() => null) as () => object | null,
  ownsOutward: (() => false) as (fence: object | null) => boolean,
  releaseOutward: (() => false) as (fence: object | null) => boolean,
  acquireLifecycle: (() => null) as () => object | null,
  ownsLifecycle: (() => false) as (fence: object | null) => boolean,
  releaseLifecycle: (() => false) as (fence: object | null) => boolean,
}));

vi.mock('../src/core/daemon/runtime-activation-stopped-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/daemon/runtime-activation-stopped-runtime.js')>();
  return {
    ...original,
    runtimeActivationStoppedRuntime: Object.freeze({
      get roots() { return runtimeControl.roots; },
      nowMs: () => runtimeControl.nowMs,
      journalKey: () => {
        if (!runtimeControl.journalKey) return null;
        const owned = Buffer.from(runtimeControl.journalKey);
        runtimeControl.returnedJournalKeys.push(owned);
        return owned;
      },
      observeLaunchd: () => runtimeControl.observeLaunchd(),
      observeMaintenance: () => runtimeControl.observeMaintenance(),
      acquireOutward: () => runtimeControl.acquireOutward(),
      ownsOutward: (fence: object | null) => runtimeControl.ownsOutward(fence),
      releaseOutward: (fence: object | null) => runtimeControl.releaseOutward(fence),
      acquireLifecycle: () => runtimeControl.acquireLifecycle(),
      ownsLifecycle: (fence: object | null) => runtimeControl.ownsLifecycle(fence),
      releaseLifecycle: (fence: object | null) => runtimeControl.releaseLifecycle(fence),
    }),
  };
});

import { canonicalizeDaemonActivationValue } from '../src/core/daemon/activation-permit.js';
import { daemonActivityPath, writeDaemonActivity } from '../src/core/daemon/activity.js';
import { runtimeActivationTransactionInternals } from '../src/core/daemon/runtime-activation-transaction.js';
import {
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS,
  consumeStoppedRuntimeReleaseForTransaction,
  runtimeActivationStoppedConsumerInternals,
  runtimeActivationStoppedConsumerKeyId,
  signRuntimeActivationStoppedPermit,
  type RuntimeActivationStoppedConsumerTrustRoot,
  type RuntimeActivationStoppedPermitPayloadV1,
  type RuntimeActivationStoppedPlan,
} from '../src/core/daemon/runtime-activation-stopped-consumer.js';

interface RuntimeActivationStoppedVerificationHooks {
  nowMs?: number;
  trustRoots?: readonly RuntimeActivationStoppedConsumerTrustRoot[];
  journalKey?: Buffer;
  observeLaunchdState?: () => { loaded: false; disabled: boolean };
  observeMaintenance?: () => { ok: boolean; reason: string; daemonRoots: number; daemonDescendants: number };
  acquireOutwardFence?: () => object | null;
  ownsOutwardFence?: (fence: object | null) => boolean;
  releaseOutwardFence?: (fence: object | null) => boolean;
  acquireLifecycleFence?: () => object | null;
  ownsLifecycleFence?: (fence: object | null) => boolean;
  releaseLifecycleFence?: (fence: object | null) => boolean;
  revalidateAdmission?: () => boolean;
}

function applyRuntimeHooks(hooks: RuntimeActivationStoppedVerificationHooks): void {
  runtimeControl.roots = [...(hooks.trustRoots ?? [])];
  runtimeControl.nowMs = hooks.nowMs ?? Date.now();
  runtimeControl.journalKey = hooks.journalKey ?? null;
  runtimeControl.observeLaunchd = hooks.observeLaunchdState ?? (() => ({ loaded: false, disabled: true }));
  runtimeControl.observeMaintenance = hooks.observeMaintenance ?? (() => ({
    ok: false, reason: 'unset maintenance', daemonRoots: 0, daemonDescendants: 0,
  }));
  runtimeControl.acquireOutward = hooks.acquireOutwardFence ?? (() => null);
  runtimeControl.ownsOutward = hooks.ownsOutwardFence ?? (() => false);
  runtimeControl.releaseOutward = hooks.releaseOutwardFence ?? (() => false);
  runtimeControl.acquireLifecycle = hooks.acquireLifecycleFence ?? (() => null);
  runtimeControl.ownsLifecycle = hooks.ownsLifecycleFence ?? (() => false);
  runtimeControl.releaseLifecycle = hooks.releaseLifecycleFence ?? (() => false);
}

function activateVerifiedStoppedRuntimeRelease(
  plan: RuntimeActivationStoppedPlan,
  home: string,
  hooks?: RuntimeActivationStoppedVerificationHooks,
) {
  if (hooks) applyRuntimeHooks(hooks);
  else runtimeControl.roots = [];
  return consumeStoppedRuntimeReleaseForTransaction(plan, home, hooks?.revalidateAdmission ?? (() => true));
}

const homes: string[] = [];
const NOW = Date.parse('2026-08-17T02:30:00.000Z');

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  runtimeControl.returnedJournalKeys.length = 0;
});

function digest(character: string): string {
  return character.repeat(64);
}

function revision(character: string): string {
  return character.repeat(40);
}

interface Fixture {
  home: string;
  plan: RuntimeActivationStoppedPlan;
  permit: RuntimeActivationStoppedPermitPayloadV1;
  root: RuntimeActivationStoppedConsumerTrustRoot;
  journalKey: Buffer;
  pointerPath: string;
  plistPath: string;
  priorTarget: string;
  candidateTarget: string;
  priorPlist: string;
  candidatePlist: string;
  hooks: RuntimeActivationStoppedVerificationHooks;
  service: { loaded: false; disabled: boolean };
}

function fixture(options: { disabled?: boolean } = {}): Fixture {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m520-')));
  homes.push(home);
  chmodSync(home, 0o700);
  const activationId = '123e4567-e89b-42d3-a456-426614174520';
  const permitId = '223e4567-e89b-42d3-a456-426614174520';
  const rollbackRevision = revision('b');
  const candidateRevision = revision('a');
  const priorTarget = join('releases', rollbackRevision);
  const candidateTarget = join('releases', candidateRevision);
  const pointerPath = join(home, '.local', 'share', 'ashlr', 'current');
  const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.ashlr.daemon.plist');
  const permitPath = runtimeActivationStoppedConsumerInternals.permitPath(home, activationId);
  for (const directory of [
    join(home, '.ashlr'),
    join(home, '.ashlr', 'locks'),
    join(home, '.ashlr', 'control'),
    join(home, '.ashlr', 'control', 'activation'),
    dirname(permitPath),
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(pointerPath), { recursive: true, mode: 0o755 });
  const priorRelease = join(dirname(pointerPath), priorTarget);
  const candidateRelease = join(dirname(pointerPath), candidateTarget);
  mkdirSync(priorRelease, { recursive: true, mode: 0o755 });
  mkdirSync(candidateRelease, { recursive: true, mode: 0o755 });
  mkdirSync(dirname(plistPath), { recursive: true, mode: 0o755 });
  symlinkSync(priorTarget, pointerPath);
  const priorPlist = '<plist><dict><key>release</key><string>rollback</string></dict></plist>\n';
  const candidatePlist = '<plist><dict><key>release</key><string>candidate-3.2.7</string></dict></plist>\n';
  writeFileSync(plistPath, priorPlist, { mode: 0o600 });
  chmodSync(plistPath, 0o600);
  const plan: RuntimeActivationStoppedPlan = {
    request: {
      signedManifest: {
        payload: {
          planId: activationId,
          candidate: {
            expectedRevision: candidateRevision,
            packageVersion: '3.2.7',
            releaseTag: 'v3.2.7',
          },
          rollback: { expectedRevision: rollbackRevision },
          execution: {
            homePath: home,
            currentPointerPath: pointerPath,
            releasesRoot: join(dirname(pointerPath), 'releases'),
            prior: {
              currentRevision: rollbackRevision,
              plistSha256: digest('f'),
              serviceLoaded: false,
            },
          },
        },
      },
    },
    preflight: { plan: { admissionDigest: digest('1'), planDigest: digest('2') } },
    canonicalRequestSha256: digest('3'),
    trustRootCanonicalSha256: digest('4'),
    candidateServiceDescriptor: candidatePlist,
    rollbackServiceDescriptor: priorPlist,
  };
  const priorPlistSha256 = createHash('sha256').update(priorPlist).digest('hex');
  plan.request.signedManifest.payload.execution.prior.plistSha256 = priorPlistSha256;
  const keys = generateKeyPairSync('ed25519');
  const keyId = runtimeActivationStoppedConsumerKeyId(keys.publicKey);
  const root: RuntimeActivationStoppedConsumerTrustRoot = {
    algorithm: 'ed25519',
    keyId,
    publicKeySpki: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-08-17T02:00:00.000Z',
    validUntil: '2026-08-17T03:00:00.000Z',
  };
  const permit: RuntimeActivationStoppedPermitPayloadV1 = {
    schemaVersion: 1,
    protocol: 'runtime-activation-stopped-consumer-v1',
    permitId,
    keyId,
    issuedAt: '2026-08-17T02:29:00.000Z',
    expiresAt: '2026-08-17T02:31:00.000Z',
    scope: {
      action: 'select-verified-3.2.7-stopped-release',
      maintenance: true,
      killSwitch: 'healthy-engaged',
      providerEffectsBlocked: true,
      serviceLoaded: false,
      serviceStart: false,
      serviceEnable: false,
      residentAcknowledgement: false,
    },
    bindings: {
      activationId,
      admissionDigest: digest('1'),
      planDigest: digest('2'),
      canonicalRequestSha256: digest('3'),
      trustRootCanonicalSha256: digest('4'),
      candidateRevision,
      candidateVersion: '3.2.7',
      rollbackRevision,
      priorCurrentTarget: priorTarget,
      priorPlistSha256,
      priorServiceDisabled: options.disabled ?? true,
      priorServiceLoaded: false,
    },
  };
  const envelope = signRuntimeActivationStoppedPermit(permit, keys.privateKey);
  writeFileSync(permitPath, `${canonicalizeDaemonActivationValue(envelope)}\n`, { mode: 0o600 });
  chmodSync(permitPath, 0o600);
  const service = { loaded: false as const, disabled: permit.bindings.priorServiceDisabled };
  const fence = {};
  const hooks: RuntimeActivationStoppedVerificationHooks = {
    nowMs: NOW,
    trustRoots: [root],
    journalKey: randomBytes(32),
    observeLaunchdState: () => ({ ...service }),
    observeMaintenance: () => ({
      ok: true,
      reason: 'healthy explicitly engaged kill switch; zero daemon roots and descendants',
      daemonRoots: 0,
      daemonDescendants: 0,
    }),
    acquireOutwardFence: () => fence,
    ownsOutwardFence: (value) => value === fence,
    releaseOutwardFence: (value) => value === fence,
    acquireLifecycleFence: () => fence,
    ownsLifecycleFence: (value) => value === fence,
    releaseLifecycleFence: (value) => value === fence,
    revalidateAdmission: () => true,
  };
  return {
    home,
    plan,
    permit,
    root,
    journalKey: hooks.journalKey!,
    pointerPath,
    plistPath,
    priorTarget,
    candidateTarget,
    priorPlist,
    candidatePlist,
    hooks,
    service,
  };
}

type TestTransactionPhase = 'prepared' | 'plist-replaced' | 'pointer-switched' | 'receipt-recorded';

function observedTransactionPhase(f: Fixture): TestTransactionPhase | null {
  const receiptPath = join(
    runtimeActivationStoppedConsumerInternals.recordStore(f.home).rootPath,
    'records',
    `receipt-${f.permit.permitId}.json`,
  );
  if (existsSync(receiptPath)) return 'receipt-recorded';
  const path = runtimeActivationStoppedConsumerInternals.journalPath(f.home);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { phase?: unknown };
  return ['prepared', 'plist-replaced', 'pointer-switched'].includes(String(parsed.phase))
    ? parsed.phase as TestTransactionPhase
    : null;
}

function interceptPhaseOnce(
  f: Fixture,
  phase: TestTransactionPhase,
  effect: () => boolean,
): () => void {
  const previous = f.hooks.ownsOutwardFence!;
  let fired = false;
  let forced: boolean | undefined;
  f.hooks.ownsOutwardFence = (fence) => {
    if (forced !== undefined) return forced;
    const owned = previous(fence);
    if (!owned || fired || observedTransactionPhase(f) !== phase) return owned;
    fired = true;
    const decision = effect();
    if (!decision) forced = false;
    return decision;
  };
  return () => {
    f.hooks.ownsOutwardFence = previous;
  };
}

function expectReturnedJournalKeysZeroized(): void {
  expect(runtimeControl.returnedJournalKeys.length).toBeGreaterThan(0);
  for (const key of runtimeControl.returnedJournalKeys) {
    expect(key).toEqual(Buffer.alloc(key.length));
  }
}

describe.skipIf(process.platform === 'win32')('M520 stopped runtime activation consumer', () => {
  it('keeps production authority frozen empty and blocks before creating records or journals', () => {
    const f = fixture();
    expect(RUNTIME_ACTIVATION_STOPPED_CONSUMER_TRUST_ROOTS).toEqual([]);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home)).toMatchObject({
      activated: false,
      phase: 'blocked',
      reason: 'runtime activation stopped consumer authority is unprovisioned',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.recordStore(f.home).rootPath)).toBe(false);
  });

  it('selects exact 3.2.7 while preserving loaded=false and the disabled bit', () => {
    const f = fixture({ disabled: true });
    const result = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(result).toMatchObject({
      activated: true,
      phase: 'activated-stopped',
      serviceStarted: false,
      serviceEnabledChanged: false,
      rollbackRestored: false,
      permitId: f.permit.permitId,
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.candidatePlist);
    expect(f.service).toEqual({ loaded: false, disabled: true });
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    expect(result.receiptPath && existsSync(result.receiptPath)).toBe(true);
    expect(lstatSync(result.receiptPath!).mode & 0o777).toBe(0o600);
    expectReturnedJournalKeysZeroized();
  });

  it('owns and wipes the original journal-key buffer on an activation refusal', () => {
    const f = fixture();
    f.hooks.observeMaintenance = () => ({
      ok: false,
      reason: 'injected maintenance refusal',
      daemonRoots: 0,
      daemonDescendants: 0,
    });
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      reason: 'injected maintenance refusal',
    });
    expectReturnedJournalKeysZeroized();
  });

  it('preserves an enabled-but-unloaded bit without invoking a service start', () => {
    const f = fixture({ disabled: false });
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: true,
      serviceStarted: false,
      serviceEnabledChanged: false,
    });
    expect(f.service).toEqual({ loaded: false, disabled: false });
  });

  it.each([
    {
      name: 'kill switch not healthy and engaged',
      observation: { ok: false, reason: 'maintenance requires healthy engaged kill', daemonRoots: 0, daemonDescendants: 0 },
    },
    {
      name: 'daemon root remains',
      observation: { ok: false, reason: 'daemon root remains', daemonRoots: 1, daemonDescendants: 0 },
    },
    {
      name: 'daemon descendant remains',
      observation: { ok: false, reason: 'daemon descendant remains', daemonRoots: 0, daemonDescendants: 1 },
    },
  ])('refuses $name before pointer, plist, claim, or journal mutation', ({ observation }) => {
    const f = fixture();
    f.hooks.observeMaintenance = () => observation;
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      phase: 'blocked',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.recordStore(f.home).rootPath)).toBe(false);
  });

  it('refuses loaded or disabled-state drift before mutation', () => {
    const f = fixture();
    f.hooks.observeLaunchdState = () => ({ loaded: false, disabled: false });
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      reason: 'runtime activation launchd state does not match the explicit permit',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
  });

  it('restores the exact pointer and plist when settlement fails after the switch', () => {
    const f = fixture();
    let observations = 0;
    f.hooks.observeMaintenance = () => {
      observations += 1;
      return observations === 1
        ? { ok: true, reason: 'quiescent', daemonRoots: 0, daemonDescendants: 0 }
        : { ok: false, reason: 'descendant appeared during settlement', daemonRoots: 0, daemonDescendants: 1 };
    };
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      rollbackRestored: true,
      reason: 'runtime activation stopped settlement revalidation failed',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(f.service).toEqual({ loaded: false, disabled: true });
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
  });

  it.each(['prepared', 'plist-replaced', 'pointer-switched'] as const)(
    'restores exact prior stopped state when a phase-bound effect fails at %s',
    (failedPhase) => {
      const f = fixture();
      interceptPhaseOnce(f, failedPhase, () => {
        throw new Error(`injected-${failedPhase}-failure`);
      });
      expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
        activated: false,
        rollbackRestored: true,
        reason: `injected-${failedPhase}-failure`,
      });
      expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
      expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
      expect(f.service).toEqual({ loaded: false, disabled: true });
      expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    },
  );

  it('persists the claim before effects and refuses an exact replay', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'prepared', () => {
      throw new Error('injected-before-plist');
    });
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      rollbackRestored: true,
    });
    restorePhaseObservation();
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      reason: 'runtime activation stopped permit claim was replayed',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
  });

  it('retains an authenticated journal without further mutation when fence ownership is lost', () => {
    const f = fixture();
    interceptPhaseOnce(f, 'prepared', () => false);
    const result = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(result).toMatchObject({ activated: false, rollbackRestored: false });
    expect(result.reason).toContain('fence ownership lost');
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(true);
  });

  it('rolls back when exact admission drifts before cooperative pointer selection', () => {
    const f = fixture();
    let observations = 0;
    f.hooks.revalidateAdmission = () => {
      observations += 1;
      return observations < 2;
    };
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      rollbackRestored: true,
      reason: 'runtime activation exact admission changed before pointer selection',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
  });

  it('returns committed success when a later response step fails after the durable receipt', () => {
    const f = fixture();
    interceptPhaseOnce(f, 'receipt-recorded', () => {
      throw new Error('injected-after-receipt');
    });
    const result = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(result).toMatchObject({
      activated: true,
      phase: 'activated-stopped',
      rollbackRestored: false,
      recoveryJournalRetained: false,
      durableOutcome: 'settled-candidate',
    });
    expect(result.reason).toContain('durable stopped settlement was retained');
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.candidatePlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    expectReturnedJournalKeysZeroized();
  });

  it('recovers an authenticated switched journal on a later expired, root-empty invocation', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'pointer-switched', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);

    restorePhaseObservation();
    f.hooks.nowMs = NOW + 10 * 60_000;
    f.hooks.trustRoots = [];
    rmSync(dirname(runtimeActivationStoppedConsumerInternals.permitPath(
      f.home,
      f.permit.bindings.activationId,
    )), { recursive: true });
    const recovered = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(recovered).toMatchObject({
      activationId: f.permit.bindings.activationId,
      activated: false,
      candidateRevision: f.permit.bindings.candidateRevision,
      admissionDigest: f.permit.bindings.admissionDigest,
      planDigest: f.permit.bindings.planDigest,
      rollbackRestored: true,
      recoveryJournalRetained: false,
      durableOutcome: 'restored-prior',
      reason: 'authenticated stopped-release journal restored the exact prior stopped state after restart',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
    expectReturnedJournalKeysZeroized();
  });

  it('does not overlay plan-A evidence on a raced settled journal-B result', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'receipt-recorded', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });
    restorePhaseObservation();
    const path = runtimeActivationStoppedConsumerInternals.journalPath(f.home);
    const heldPath = `${path}.held`;
    renameSync(path, heldPath);
    f.hooks.observeLaunchdState = () => {
      if (existsSync(heldPath)) renameSync(heldPath, path);
      return { ...f.service };
    };
    const raced = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(raced).toMatchObject({
      activationId: f.permit.bindings.activationId,
      activated: true,
      candidateRevision: f.permit.bindings.candidateRevision,
      admissionDigest: f.permit.bindings.admissionDigest,
      planDigest: f.permit.bindings.planDigest,
      recoveryJournalObserved: true,
      durableOutcome: 'settled-candidate',
    });
    const mapped = runtimeActivationTransactionInternals.resultFromStopped({
      admissionDigest: digest('1'),
      activationId: '523e4567-e89b-42d3-a456-426614174520',
      candidateRevision: revision('2'),
      planDigest: digest('3'),
      canonicalRequestSha256: digest('4'),
      trustRootCanonicalSha256: digest('5'),
      candidateLaunchReceiptSha256: digest('6'),
      rollbackLaunchReceiptSha256: digest('7'),
    }, raced);
    expect(mapped).toMatchObject({
      activationId: f.permit.bindings.activationId,
      candidateRevision: f.permit.bindings.candidateRevision,
      admissionDigest: f.permit.bindings.admissionDigest,
      planDigest: f.permit.bindings.planDigest,
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
      activated: true,
    });
  });

  it('keeps every identity null for an unauthenticated raced retained journal', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'pointer-switched', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });
    restorePhaseObservation();
    const path = runtimeActivationStoppedConsumerInternals.journalPath(f.home);
    const heldPath = `${path}.held`;
    renameSync(path, heldPath);
    const poisoned = JSON.parse(readFileSync(heldPath, 'utf8')) as Record<string, unknown>;
    poisoned['attestation'] = digest('0');
    writeFileSync(heldPath, `${JSON.stringify(poisoned)}\n`, { mode: 0o600 });
    f.hooks.observeLaunchdState = () => {
      if (existsSync(heldPath)) renameSync(heldPath, path);
      return { ...f.service };
    };
    const raced = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(raced).toMatchObject({
      activationId: null,
      candidateRevision: null,
      admissionDigest: null,
      planDigest: null,
      activated: false,
      recoveryJournalObserved: true,
      recoveryJournalRetained: true,
      durableOutcome: 'none',
      permitId: null,
    });
    const mapped = runtimeActivationTransactionInternals.resultFromStopped({
      admissionDigest: digest('1'),
      activationId: '523e4567-e89b-42d3-a456-426614174520',
      candidateRevision: revision('2'),
      planDigest: digest('3'),
      canonicalRequestSha256: digest('4'),
      trustRootCanonicalSha256: digest('5'),
      candidateLaunchReceiptSha256: digest('6'),
      rollbackLaunchReceiptSha256: digest('7'),
    }, raced);
    expect(mapped).toMatchObject({
      activationId: null,
      candidateRevision: null,
      admissionDigest: null,
      planDigest: null,
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
      activated: false,
      recoveryJournalRetained: true,
    });
    expect(runtimeActivationTransactionInternals.resultFromStopped({
      admissionDigest: digest('1'),
      activationId: '523e4567-e89b-42d3-a456-426614174520',
      candidateRevision: revision('2'),
      planDigest: digest('3'),
      canonicalRequestSha256: digest('4'),
      trustRootCanonicalSha256: digest('5'),
      candidateLaunchReceiptSha256: digest('6'),
      rollbackLaunchReceiptSha256: digest('7'),
    }, { ...raced, recoveryJournalObserved: false })).toMatchObject({
      activationId: null,
      candidateRevision: null,
      admissionDigest: null,
      planDigest: null,
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
    });
  });

  it('settles an authenticated receipt on a true second invocation without current roots', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'receipt-recorded', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);

    restorePhaseObservation();
    f.hooks.nowMs = NOW + 10 * 60_000;
    f.hooks.trustRoots = [];
    rmSync(dirname(runtimeActivationStoppedConsumerInternals.permitPath(
      f.home,
      f.permit.bindings.activationId,
    )), { recursive: true });
    const settled = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(settled).toMatchObject({
      activationId: f.permit.bindings.activationId,
      activated: true,
      candidateRevision: f.permit.bindings.candidateRevision,
      admissionDigest: f.permit.bindings.admissionDigest,
      planDigest: f.permit.bindings.planDigest,
      rollbackRestored: false,
      recoveryJournalRetained: false,
      durableOutcome: 'settled-candidate',
      reason: 'authenticated stopped-release receipt settled after restart without new mutation authority',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.candidatePlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
  });

  it('retains reconciliation evidence when a restart loses a fence between pointer and plist restore', () => {
    const f = fixture();
    const restorePhaseObservation = interceptPhaseOnce(f, 'pointer-switched', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.candidateTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.candidatePlist);

    let outwardChecks = 0;
    f.hooks.trustRoots = [];
    restorePhaseObservation();
    f.hooks.ownsOutwardFence = () => {
      outwardChecks += 1;
      return outwardChecks < 6;
    };
    f.hooks.ownsLifecycleFence = () => true;
    const interrupted = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(interrupted).toMatchObject({
      activated: false,
      rollbackRestored: false,
      recoveryJournalRetained: true,
      durableOutcome: 'none',
    });
    expect(interrupted.reason).toContain('recovery fence ownership was lost');
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.candidatePlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(true);

    f.hooks.ownsOutwardFence = () => true;
    const recovered = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(recovered).toMatchObject({
      activated: false,
      rollbackRestored: true,
      recoveryJournalRetained: false,
      durableOutcome: 'restored-prior',
    });
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(false);
  });

  it('returns journal-B identity when concurrent plan-A metadata accompanies receipt recovery', () => {
    const f = fixture();
    const journalIdentity = {
      activationId: f.permit.bindings.activationId,
      candidateRevision: f.permit.bindings.candidateRevision,
      admissionDigest: f.permit.bindings.admissionDigest,
      planDigest: f.permit.bindings.planDigest,
    };
    const restorePhaseObservation = interceptPhaseOnce(f, 'receipt-recorded', () => false);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks)).toMatchObject({
      activated: false,
      recoveryJournalRetained: true,
    });

    const concurrentPlan = structuredClone(f.plan);
    concurrentPlan.request.signedManifest.payload.planId = '423e4567-e89b-42d3-a456-426614174520';
    concurrentPlan.request.signedManifest.payload.candidate.expectedRevision = revision('c');
    concurrentPlan.preflight.plan.admissionDigest = digest('d');
    concurrentPlan.preflight.plan.planDigest = digest('e');
    restorePhaseObservation();
    f.hooks.trustRoots = [];
    const settled = activateVerifiedStoppedRuntimeRelease(concurrentPlan, f.home, f.hooks);
    expect(settled).toMatchObject({
      ...journalIdentity,
      activated: true,
      durableOutcome: 'settled-candidate',
      recoveryJournalRetained: false,
    });
    expect(settled.activationId).not.toBe(concurrentPlan.request.signedManifest.payload.planId);
    expect(settled.candidateRevision).not.toBe(
      concurrentPlan.request.signedManifest.payload.candidate.expectedRevision,
    );
    expect(settled.admissionDigest).not.toBe(concurrentPlan.preflight.plan.admissionDigest);
    expect(settled.planDigest).not.toBe(concurrentPlan.preflight.plan.planDigest);
  });

  it('rejects dead or reused owner evidence with children or an ambiguous terminal phase', () => {
    const base = {
      sourceState: 'healthy' as const,
      freshness: 'stale' as const,
      ownerState: 'dead' as const,
      phaseStartedAt: '2026-08-17T02:20:00.000Z',
      ageMs: 600_000,
      activity: {
        schemaVersion: 1 as const,
        observedAt: '2026-08-17T02:20:00.000Z',
        authority: 'none' as const,
        instanceId: '123e4567-e89b-42d3-a456-426614174521',
        pid: 999_999,
        processStartRef: digest('a'),
        daemonStartedAt: '2026-08-17T02:00:00.000Z',
        phase: 'post-tick' as const,
        activeChildren: 0,
      },
    };
    expect(runtimeActivationStoppedConsumerInternals.activityAllowsStoppedRecovery(base)).toBe(true);
    expect(runtimeActivationStoppedConsumerInternals.activityAllowsStoppedRecovery({
      ...base,
      activity: { ...base.activity, activeChildren: 1 },
    })).toBe(false);
    expect(runtimeActivationStoppedConsumerInternals.activityAllowsStoppedRecovery({
      ...base,
      ownerState: 'reused',
      activity: { ...base.activity, phase: 'stopping', activeChildren: null },
    })).toBe(false);
  });

  it('has the real default maintenance observer reject durable orphan-child evidence', () => {
    const f = fixture();
    const priorHome = process.env['HOME'];
    const priorAshlrHome = process.env['ASHLR_HOME'];
    process.env['HOME'] = f.home;
    process.env['ASHLR_HOME'] = join(f.home, '.ashlr');
    try {
      writeFileSync(join(f.home, '.ashlr', 'KILL'), 'kill switch active\n', { mode: 0o600 });
      const observedAt = new Date();
      expect(writeDaemonActivity({
        instanceId: '323e4567-e89b-42d3-a456-426614174520',
        daemonStartedAt: new Date(observedAt.getTime() - 60_000).toISOString(),
        phase: 'post-tick',
        activeChildren: 1,
        now: observedAt,
      })).toBe(true);
      const activityPath = daemonActivityPath(observedAt.toISOString().slice(0, 10));
      const row = JSON.parse(readFileSync(activityPath, 'utf8')) as Record<string, unknown>;
      row['pid'] = 999_999;
      row['processStartRef'] = digest('a');
      writeFileSync(activityPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      chmodSync(activityPath, 0o600);

      expect(runtimeActivationStoppedConsumerInternals.observeMaintenanceDefault(f.home)).toMatchObject({
        ok: false,
        reason: 'maintenance cannot prove daemon activity is quiescent',
        daemonRoots: 0,
        daemonDescendants: 1,
      });
      process.env['ASHLR_HOME'] = join(f.home, 'foreign-ashlr-root');
      expect(runtimeActivationStoppedConsumerInternals.observeMaintenanceDefault(f.home)).toMatchObject({
        ok: false,
        reason: 'maintenance ASHLR_HOME does not match the operating-system account home',
        daemonRoots: 0,
        daemonDescendants: 1,
      });
    } finally {
      if (priorHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = priorHome;
      if (priorAshlrHome === undefined) delete process.env['ASHLR_HOME'];
      else process.env['ASHLR_HOME'] = priorAshlrHome;
    }
  });

  it('rejects a noncanonical base64url signature that decodes to the same 64 bytes', () => {
    const f = fixture();
    const permitPath = runtimeActivationStoppedConsumerInternals.permitPath(f.home, f.permit.bindings.activationId);
    const envelope = JSON.parse(readFileSync(permitPath, 'utf8')) as { signature: string };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalIndex = alphabet.indexOf(envelope.signature.at(-1)!);
    const alternate = alphabet[(finalIndex & ~3) | ((finalIndex + 1) & 3)]!;
    const noncanonical = `${envelope.signature.slice(0, -1)}${alternate}`;
    expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(envelope.signature, 'base64url'));
    envelope.signature = noncanonical;
    expect(runtimeActivationStoppedConsumerInternals.parsePermit(envelope)).toBeNull();
  });

  it('detects a same-UID cooperative-CAS interloper and leaves reconciliation evidence', () => {
    const f = fixture();
    const foreignTarget = join('releases', revision('c'));
    interceptPhaseOnce(f, 'prepared', () => {
      unlinkSync(f.pointerPath);
      symlinkSync(foreignTarget, f.pointerPath);
      return true;
    });
    const result = activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks);
    expect(result).toMatchObject({ activated: false, rollbackRestored: false });
    expect(result.reason).toContain('interleaved current pointer');
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(foreignTarget);
    expect(existsSync(runtimeActivationStoppedConsumerInternals.journalPath(f.home))).toBe(true);
  });

  it.each([
    { name: 'permissive permit', poison: (f: Fixture) => chmodSync(
      runtimeActivationStoppedConsumerInternals.permitPath(f.home, f.permit.bindings.activationId),
      0o640,
    ) },
    { name: 'permissive control directory', poison: (f: Fixture) => chmodSync(
      join(f.home, '.ashlr', 'control'),
      0o750,
    ) },
    { name: 'writable current-pointer parent', poison: (f: Fixture) => chmodSync(
      dirname(f.pointerPath),
      0o777,
    ) },
  ])('fails closed for $name custody before pointer or plist mutation', ({ poison }) => {
    const f = fixture();
    poison(f);
    expect(activateVerifiedStoppedRuntimeRelease(f.plan, f.home, f.hooks).activated).toBe(false);
    expect(readlinkSync(f.pointerPath, 'utf8')).toBe(f.priorTarget);
    expect(readFileSync(f.plistPath, 'utf8')).toBe(f.priorPlist);
  });

  it('rejects expiry, binding drift, noncanonical permit bytes, and pointer substitution', () => {
    const expired = fixture();
    expired.hooks.nowMs = NOW + 120_000;
    expect(activateVerifiedStoppedRuntimeRelease(expired.plan, expired.home, expired.hooks).reason)
      .toBe('runtime activation stopped permit is outside its validity window');

    const drifted = fixture();
    drifted.plan.canonicalRequestSha256 = digest('9');
    expect(activateVerifiedStoppedRuntimeRelease(drifted.plan, drifted.home, drifted.hooks).reason)
      .toBe('runtime activation stopped permit does not bind the exact admitted 3.2.7 plan');

    const noncanonical = fixture();
    const permitPath = runtimeActivationStoppedConsumerInternals.permitPath(noncanonical.home, noncanonical.permit.bindings.activationId);
    writeFileSync(permitPath, `${JSON.stringify(JSON.parse(readFileSync(permitPath, 'utf8')), null, 2)}\n`, { mode: 0o600 });
    expect(activateVerifiedStoppedRuntimeRelease(noncanonical.plan, noncanonical.home, noncanonical.hooks).reason)
      .toBe('runtime activation stopped permit is not canonical');

    const substituted = fixture();
    unlinkSync(substituted.pointerPath);
    symlinkSync(join('releases', revision('c')), substituted.pointerPath);
    expect(activateVerifiedStoppedRuntimeRelease(substituted.plan, substituted.home, substituted.hooks).reason)
      .toBe('runtime activation current pointer does not match the signed prior release');
  });
});
