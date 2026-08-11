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
const CONSUMER_UNAVAILABLE = 'runtime-activation-consumer-unavailable' as const;

export interface RuntimeActivationResult {
  activationId: string | null;
  activated: false;
  candidateRevision: string | null;
  phase: 'blocked';
  planDigest: string | null;
  reason: string;
  rollbackRestored: false;
}

function blocked(
  reason: string,
  plan?: {
    activationId: string;
    candidateRevision: string;
    planDigest: string;
  },
): RuntimeActivationResult {
  return {
    activationId: plan?.activationId ?? null,
    activated: false,
    candidateRevision: plan?.candidateRevision ?? null,
    phase: 'blocked',
    planDigest: plan?.planDigest ?? null,
    reason,
    rollbackRestored: false,
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
  const expectedArguments = [request.candidate.executablePath, ...request.candidate.argv];
  if (
    !Array.isArray(argumentsValue)
    || argumentsValue.some((entry) => typeof entry !== 'string')
    || JSON.stringify(argumentsValue) !== JSON.stringify(expectedArguments)
    || request.candidate.executablePath !== request.candidate.declaredInterpreterPath
    || request.candidate.argv[0] !== join(request.candidate.packageRoot, 'bin', 'ashlr')
    || request.candidate.argv[1] !== 'daemon'
    || request.candidate.argv[2] !== 'start'
    || request.candidate.argv.some((argument) => ['--once', '--dry-run', '--drain'].includes(argument))
  ) {
    throw new Error('candidate launchd descriptor invocation contract is invalid');
  }
  const environment = parsed['EnvironmentVariables'];
  if (!record(environment)) throw new Error('candidate launchd descriptor environment is invalid');
  const expectedEnvironment = {
    ASHLR_ACTIVATION_CONFIG_SHA256: payload.execution.configSha256,
    ASHLR_ACTIVATION_ID: payload.planId,
    ASHLR_ACTIVATION_MANIFEST_DIGEST: payload.candidate.manifestDigest,
    ASHLR_ACTIVATION_RELEASE_REVISION: payload.candidate.expectedRevision,
    ASHLR_ACTIVATION_RELEASE_TREE_SHA256: payload.candidate.runtimeTreeSha256,
    HOME: payload.execution.homePath,
  };
  const allowed = [...Object.keys(expectedEnvironment), 'PATH'].sort();
  if (
    !exactKeys(environment, allowed)
    || typeof environment['PATH'] !== 'string'
    || environment['PATH'].length < 1
    || environment['PATH'].length > 16_384
    || environment['PATH'].includes('\0')
    || environment['PATH'].includes('\n')
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
    || payload.rollback.packageVersion !== '3.1.0'
    || payload.rollback.releaseTag !== 'v3.1.0'
  ) {
    throw new Error('signed activation rollback must bind the exact stopped 3.1 release and prior plist');
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
  const descriptorRead = readStableRegularFile(request.candidate.serviceDescriptorPath, {
    anchorPath: request.candidate.bundleRoot,
    maxFileBytes: MAX_DESCRIPTOR_BYTES,
    remainingBytes: MAX_DESCRIPTOR_BYTES,
  });
  if (!descriptorRead.ok || !sameDigest(
    sha256(descriptorRead.text),
    payload.candidate.serviceDescriptorSha256,
  )) {
    throw new Error('candidate launchd descriptor binding mismatch');
  }
  validateClosedDescriptor(request, descriptorRead.text);
}

function sha256(value: string | Buffer): string {
  // Kept local so the mutation-disabled consumer has no release-writer imports.
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read-only admission for a future native launchd transaction.
 *
 * This wrapper deliberately exposes no HOME/platform/clock/effect injection.
 * It derives identity from the operating-system account database, rejects a
 * poisoned HOME, validates the exact signed plan and already-read descriptor
 * bytes, and always withholds resident mutation.
 */
export function activateRuntimeRelease(input: {
  authorize: string;
  confirm: string;
  requestPath: string;
}): RuntimeActivationResult {
  const account = accountBoundHome();
  if (!account.ok) return blocked(account.reason);

  let observed: ReturnType<typeof observeRuntimeActivationExecutionPlan>;
  try {
    observed = observeRuntimeActivationExecutionPlan({
      requestPath: input.requestPath,
      homePath: account.homePath,
    });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
  const planDigest = observed.preflight.plan.planDigest!;
  const payload = observed.request.signedManifest.payload;
  const plan = {
    activationId: payload.planId,
    candidateRevision: payload.candidate.expectedRevision,
    planDigest,
  };
  if (!sameDigest(input.authorize, planDigest) || !sameDigest(input.confirm, planDigest)) {
    return blocked('runtime activation requires two exact plan-digest confirmations', plan);
  }
  try {
    validateMutationDisabledPlan(observed.request, account.homePath);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error), plan);
  }
  return blocked(CONSUMER_UNAVAILABLE, plan);
}

export const runtimeActivationTransactionInternals = {
  CONSUMER_UNAVAILABLE,
  accountBoundHome,
  parseDescriptorBytes,
  validateClosedDescriptor,
  validateMutationDisabledPlan,
};
