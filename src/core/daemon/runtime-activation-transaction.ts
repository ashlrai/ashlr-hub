import { createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import {
  observeRuntimeActivationExecutionPlan,
  type RuntimeActivationPreflightRequestV1,
} from './runtime-activation-authority.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_DESCRIPTOR_BYTES = 256 * 1_024;
const SAFE_LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface RuntimeActivationResult {
  admissionDigest: string | null;
  activationId: string | null;
  activated: boolean;
  serviceStarted: false;
  serviceEnabledChanged: false;
  candidateRevision: string | null;
  phase: 'blocked' | 'activated-stopped';
  planDigest: string | null;
  canonicalRequestSha256: string | null;
  trustRootCanonicalSha256: string | null;
  candidateLaunchReceiptSha256: string | null;
  rollbackLaunchReceiptSha256: string | null;
  reason: string;
  rollbackRestored: boolean;
  recoveryJournalRetained: boolean;
  durableOutcome: 'none' | 'restored-prior' | 'settled-candidate';
}

interface RuntimeActivationPlanEvidence {
  admissionDigest: string;
  activationId: string;
  candidateRevision: string;
  planDigest: string;
  canonicalRequestSha256: string;
  trustRootCanonicalSha256: string;
  candidateLaunchReceiptSha256: string;
  rollbackLaunchReceiptSha256: string;
}

function blocked(
  reason: string,
  plan?: RuntimeActivationPlanEvidence,
): RuntimeActivationResult {
  return {
    admissionDigest: plan?.admissionDigest ?? null,
    activationId: plan?.activationId ?? null,
    activated: false,
    serviceStarted: false,
    serviceEnabledChanged: false,
    candidateRevision: plan?.candidateRevision ?? null,
    phase: 'blocked',
    planDigest: plan?.planDigest ?? null,
    canonicalRequestSha256: plan?.canonicalRequestSha256 ?? null,
    trustRootCanonicalSha256: plan?.trustRootCanonicalSha256 ?? null,
    candidateLaunchReceiptSha256: plan?.candidateLaunchReceiptSha256 ?? null,
    rollbackLaunchReceiptSha256: plan?.rollbackLaunchReceiptSha256 ?? null,
    reason,
    rollbackRestored: false,
    recoveryJournalRetained: false,
    durableOutcome: 'none',
  };
}

function resultFromStopped(
  plan: RuntimeActivationPlanEvidence,
  stopped: {
    admissionDigest: string | null;
    activationId: string | null;
    activated: boolean;
    candidateRevision: string | null;
    durableOutcome: RuntimeActivationResult['durableOutcome'];
    phase: RuntimeActivationResult['phase'];
    planDigest: string | null;
    reason: string;
    recoveryJournalObserved: boolean;
    recoveryJournalRetained: boolean;
    rollbackRestored: boolean;
  },
): RuntimeActivationResult {
  // Retained reconciliation evidence is intentionally identity-unknown unless
  // the stopped consumer supplied authenticated journal-bound identity.
  const journalRecovery = stopped.recoveryJournalObserved || stopped.recoveryJournalRetained;
  return {
    admissionDigest: journalRecovery ? stopped.admissionDigest : stopped.admissionDigest ?? plan.admissionDigest,
    activationId: journalRecovery ? stopped.activationId : stopped.activationId ?? plan.activationId,
    activated: stopped.activated,
    serviceStarted: false,
    serviceEnabledChanged: false,
    candidateRevision: journalRecovery ? stopped.candidateRevision : stopped.candidateRevision ?? plan.candidateRevision,
    phase: stopped.phase,
    planDigest: journalRecovery ? stopped.planDigest : stopped.planDigest ?? plan.planDigest,
    canonicalRequestSha256: journalRecovery ? null : plan.canonicalRequestSha256,
    trustRootCanonicalSha256: journalRecovery ? null : plan.trustRootCanonicalSha256,
    candidateLaunchReceiptSha256: journalRecovery ? null : plan.candidateLaunchReceiptSha256,
    rollbackLaunchReceiptSha256: journalRecovery ? null : plan.rollbackLaunchReceiptSha256,
    reason: stopped.reason,
    rollbackRestored: stopped.rollbackRestored,
    recoveryJournalRetained: stopped.recoveryJournalRetained,
    durableOutcome: stopped.durableOutcome,
  };
}

function sameDigest(left: string, right: string): boolean {
  return SHA256_RE.test(left) && SHA256_RE.test(right)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function accountBoundHome(): { ok: true; homePath: string } | { ok: false; reason: string } {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'runtime activation is supported only on macOS' };
  }
  let homePath: string;
  try {
    const accountHome = userInfo().homedir;
    if (resolve(accountHome) !== accountHome) throw new Error('account home must be absolute');
    homePath = realpathSync(accountHome);
    if (homePath !== accountHome) throw new Error('account home must be canonical');
  } catch {
    return { ok: false, reason: 'runtime activation operating-system account home is unavailable' };
  }
  const environmentHome = process.env['HOME'];
  if (!environmentHome || environmentHome !== homePath || resolve(environmentHome) !== environmentHome) {
    return { ok: false, reason: 'runtime activation HOME does not match the operating-system account home' };
  }
  try {
    if (realpathSync(environmentHome) !== homePath) {
      return { ok: false, reason: 'runtime activation HOME does not match the operating-system account home' };
    }
  } catch {
    return { ok: false, reason: 'runtime activation HOME does not match the operating-system account home' };
  }
  return { ok: true, homePath };
}

function parseDescriptorBytes(descriptor: string): Record<string, unknown> {
  const parsed = spawnSync(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '--', '-'],
    {
      encoding: 'utf8',
      input: descriptor,
      maxBuffer: MAX_DESCRIPTOR_BYTES,
      shell: false,
      timeout: 5_000,
    },
  );
  if (parsed.status !== 0 || parsed.error || parsed.stderr.trim() !== '') {
    throw new Error('candidate launchd descriptor bytes are invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(parsed.stdout);
  } catch {
    throw new Error('candidate launchd descriptor conversion is invalid');
  }
  if (!record(value)) throw new Error('candidate launchd descriptor must be a dictionary');
  return value;
}

function validateClosedDescriptor(
  request: RuntimeActivationPreflightRequestV1,
  bundle: RuntimeActivationPreflightRequestV1['candidate'],
  binding: RuntimeActivationPreflightRequestV1['signedManifest']['payload']['candidate'],
  descriptor: string,
): void {
  const payload = request.signedManifest.payload;
  const parsed = parseDescriptorBytes(descriptor);
  if (!exactKeys(parsed, [
    'EnvironmentVariables',
    'KeepAlive',
    'Label',
    'ProcessType',
    'ProgramArguments',
    'RunAtLoad',
    'StandardErrorPath',
    'StandardOutPath',
    'ThrottleInterval',
  ])) {
    throw new Error('candidate launchd descriptor has unbound execution keys');
  }
  if (
    parsed['Label'] !== 'ai.ashlr.daemon'
    || parsed['ProcessType'] !== 'Background'
    || parsed['RunAtLoad'] !== true
    || !Number.isInteger(parsed['ThrottleInterval'])
    || Number(parsed['ThrottleInterval']) < 5
    || Number(parsed['ThrottleInterval']) > 3_600
    || parsed['StandardOutPath'] !== join(payload.execution.homePath, '.ashlr', 'daemon.launchd.out.log')
    || parsed['StandardErrorPath'] !== join(payload.execution.homePath, '.ashlr', 'daemon.launchd.err.log')
  ) {
    throw new Error('candidate launchd descriptor supervisor contract is invalid');
  }
  const keepAlive = parsed['KeepAlive'];
  if (!record(keepAlive) || !exactKeys(keepAlive, ['SuccessfulExit']) || keepAlive['SuccessfulExit'] !== false) {
    throw new Error('candidate launchd descriptor KeepAlive contract is invalid');
  }
  const argumentsValue = parsed['ProgramArguments'];
  const expectedArguments = [bundle.executablePath, ...bundle.argv];
  if (
    !Array.isArray(argumentsValue)
    || argumentsValue.some((entry) => typeof entry !== 'string')
    || JSON.stringify(argumentsValue) !== JSON.stringify(expectedArguments)
    || bundle.executablePath !== bundle.declaredInterpreterPath
    || bundle.argv[0] !== join(bundle.packageRoot, 'bin', 'ashlr')
    || bundle.argv[1] !== 'daemon'
    || bundle.argv[2] !== 'start'
    || bundle.argv.some((argument) => ['--once', '--dry-run', '--drain'].includes(argument))
  ) {
    throw new Error('candidate launchd descriptor invocation contract is invalid');
  }
  const environment = parsed['EnvironmentVariables'];
  if (!record(environment)) throw new Error('candidate launchd descriptor environment is invalid');
  const expectedEnvironment = {
    ASHLR_ACTIVATION_CONFIG_SHA256: payload.execution.configSha256,
    ASHLR_ACTIVATION_ID: payload.planId,
    ASHLR_ACTIVATION_MANIFEST_DIGEST: binding.manifestDigest,
    ASHLR_ACTIVATION_RELEASE_REVISION: binding.expectedRevision,
    ASHLR_ACTIVATION_RELEASE_TREE_SHA256: binding.runtimeTreeSha256,
    HOME: payload.execution.homePath,
  };
  if (
    !exactKeys(environment, [...Object.keys(expectedEnvironment), 'PATH'].sort())
    || environment['PATH'] !== SAFE_LAUNCHD_PATH
  ) {
    throw new Error('candidate launchd descriptor environment is not exact and bounded');
  }
  for (const [key, value] of Object.entries(expectedEnvironment)) {
    if (environment[key] !== value) {
      throw new Error(`candidate launchd descriptor ${key} binding mismatch`);
    }
  }
}

function validateMutationDisabledPlan(
  request: RuntimeActivationPreflightRequestV1,
  homePath: string,
  descriptors: { candidate: string; rollback: string },
): void {
  const payload = request.signedManifest.payload;
  if (
    payload.execution.homePath !== homePath
    || payload.execution.platform !== 'darwin'
    || payload.execution.configPath !== join(homePath, '.ashlr', 'config.json')
    || payload.execution.releasesRoot !== join(homePath, '.local', 'share', 'ashlr', 'releases')
    || payload.execution.currentPointerPath !== join(homePath, '.local', 'share', 'ashlr', 'current')
    || request.candidate.bundleRoot !== join(payload.execution.releasesRoot, payload.candidate.expectedRevision)
    || request.rollback.bundleRoot !== join(payload.execution.releasesRoot, payload.rollback.expectedRevision)
  ) {
    throw new Error('signed activation host or release path binding mismatch');
  }
  if (
    payload.execution.prior.currentRevision !== payload.rollback.expectedRevision
    || payload.execution.prior.plistSha256 === null
    || payload.execution.prior.serviceLoaded !== false
  ) {
    throw new Error('signed activation rollback must bind the exact declared stopped prior release and plist');
  }
  const config = readStableRegularFile(payload.execution.configPath, {
    anchorPath: homePath,
    maxFileBytes: 4 * 1024 * 1024,
    remainingBytes: 4 * 1024 * 1024,
  });
  if (!config.ok || !sameDigest(
    sha256(config.text),
    payload.execution.configSha256,
  )) {
    throw new Error('signed activation configuration binding mismatch');
  }
  if (!sameDigest(sha256(descriptors.candidate), payload.candidate.serviceDescriptorSha256)) {
    throw new Error('candidate launchd descriptor binding mismatch');
  }
  if (!sameDigest(sha256(descriptors.rollback), payload.rollback.serviceDescriptorSha256)) {
    throw new Error('rollback launchd descriptor binding mismatch');
  }
  validateClosedDescriptor(request, request.candidate, payload.candidate, descriptors.candidate);
  validateClosedDescriptor(request, request.rollback, payload.rollback, descriptors.rollback);
}

function sha256(value: string | Buffer): string {
  // Kept local so the mutation-disabled consumer has no release-writer imports.
  return createHash('sha256').update(value).digest('hex');
}

function sameStoppedAdmission(
  left: ReturnType<typeof observeRuntimeActivationExecutionPlan>,
  right: ReturnType<typeof observeRuntimeActivationExecutionPlan>,
): boolean {
  return sameDigest(left.preflight.plan.admissionDigest ?? '', right.preflight.plan.admissionDigest ?? '') &&
    sameDigest(left.preflight.plan.planDigest ?? '', right.preflight.plan.planDigest ?? '') &&
    sameDigest(left.canonicalRequestSha256, right.canonicalRequestSha256) &&
    sameDigest(left.trustRootCanonicalSha256, right.trustRootCanonicalSha256) &&
    left.candidateServiceDescriptor === right.candidateServiceDescriptor &&
    left.rollbackServiceDescriptor === right.rollbackServiceDescriptor;
}

/**
 * Production entrypoint for the dormant stopped-release transaction.
 *
 * This wrapper exposes no HOME/platform/clock/effect injection. It derives
 * identity from the operating-system account database, rejects a poisoned
 * HOME, repeats exact signed-plan observation, and delegates only to M520. The
 * compiled M520 trust roots are empty, and even a separately provisioned permit
 * cannot start, enable, or acknowledge a resident service.
 */
export async function activateRuntimeRelease(input: {
  authorize: string;
  confirm: string;
  requestPath: string;
}): Promise<RuntimeActivationResult> {
  const account = accountBoundHome();
  if (!account.ok) return blocked(account.reason);

  return activateRuntimeReleaseForHome(input, account.homePath);
}

async function activateRuntimeReleaseForHome(
  input: { authorize: string; confirm: string; requestPath: string },
  homePath: string,
): Promise<RuntimeActivationResult> {
  const stoppedConsumer = await import('./runtime-activation-stopped-consumer.js');
  const recovery = stoppedConsumer.recoverStoppedRuntimeReleaseForTransaction(homePath);
  if (recovery) {
    return {
      admissionDigest: recovery.admissionDigest,
      activationId: recovery.activationId,
      activated: recovery.activated,
      serviceStarted: false,
      serviceEnabledChanged: false,
      candidateRevision: recovery.candidateRevision,
      phase: recovery.phase,
      planDigest: recovery.planDigest,
      canonicalRequestSha256: null,
      trustRootCanonicalSha256: null,
      candidateLaunchReceiptSha256: null,
      rollbackLaunchReceiptSha256: null,
      reason: recovery.reason,
      rollbackRestored: recovery.rollbackRestored,
      recoveryJournalRetained: recovery.recoveryJournalRetained,
      durableOutcome: recovery.durableOutcome,
    };
  }

  let observed: ReturnType<typeof observeRuntimeActivationExecutionPlan>;
  try {
    observed = observeRuntimeActivationExecutionPlan({
      requestPath: input.requestPath,
      homePath,
    });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
  const planDigest = observed.preflight.plan.planDigest!;
  const admissionDigest = observed.preflight.plan.admissionDigest!;
  const payload = observed.request.signedManifest.payload;
  const plan = {
    admissionDigest,
    activationId: payload.planId,
    candidateRevision: payload.candidate.expectedRevision,
    planDigest,
    canonicalRequestSha256: observed.canonicalRequestSha256,
    trustRootCanonicalSha256: observed.trustRootCanonicalSha256,
    candidateLaunchReceiptSha256: observed.candidateLaunchReceiptSha256,
    rollbackLaunchReceiptSha256: observed.rollbackLaunchReceiptSha256,
  };
  if (!sameDigest(input.authorize, admissionDigest) || !sameDigest(input.confirm, admissionDigest)) {
    return blocked('runtime activation requires two exact admission-digest confirmations', plan);
  }
  try {
    validateMutationDisabledPlan(observed.request, homePath, {
      candidate: observed.candidateServiceDescriptor,
      rollback: observed.rollbackServiceDescriptor,
    });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error), plan);
  }
  const revalidateAdmission = (): boolean => {
    try {
      return sameStoppedAdmission(observed, observeRuntimeActivationExecutionPlan({
        requestPath: input.requestPath,
        homePath,
      }));
    } catch {
      return false;
    }
  };
  const stopped = stoppedConsumer.consumeStoppedRuntimeReleaseForTransaction(
    observed,
    homePath,
    revalidateAdmission,
  );
  return resultFromStopped(plan, stopped);
}

export const runtimeActivationTransactionInternals = {
  accountBoundHome,
  parseDescriptorBytes,
  resultFromStopped,
  sameStoppedAdmission,
  validateClosedDescriptor,
  validateMutationDisabledPlan,
};
