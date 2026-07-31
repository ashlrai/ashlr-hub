/**
 * Read-only admission evidence for a resident macOS daemon service.
 *
 * This module observes launchd and local release artifacts only. A ready result
 * is not an activation capability and deliberately grants no lifecycle authority.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { daemonActivationReleaseTreeBinding } from './activation-permit.js';
import {
  generateServiceDefinition,
  parseExactLaunchdPrintRuntime,
  type Platform,
  type ServiceInstallOptions,
} from './service.js';

const SERVICE_LABEL = 'ai.ashlr.daemon';
const RELEASE_ID_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 5_000;

export type ResidentServiceReadinessState = 'ready' | 'blocked' | 'degraded';

export type ResidentServiceReadinessReasonCode =
  | 'unsupported-platform'
  | 'release-contract-invalid'
  | 'release-binding-unavailable'
  | 'release-binding-mismatch'
  | 'service-definition-unavailable'
  | 'service-label-mismatch'
  | 'service-invocation-mismatch'
  | 'restart-policy-mismatch'
  | 'service-not-loaded'
  | 'service-state-unavailable'
  | 'service-disabled'
  | 'service-enable-state-unavailable'
  | 'kill-switch-present'
  | 'kill-switch-state-unavailable'
  | 'observation-changed';

export interface ResidentServiceReadinessReason {
  code: ResidentServiceReadinessReasonCode;
  severity: 'blocked' | 'degraded';
  detail: string;
}

export interface ResidentServiceReadinessChecks {
  exactLabel: boolean | null;
  loaded: boolean | null;
  enabled: boolean | null;
  immutableRelease: boolean | null;
  exactInvocation: boolean | null;
  restartPolicyCompatible: boolean | null;
  killSwitchAbsent: boolean | null;
  stableObservation: boolean | null;
}

export interface ResidentServiceReadiness {
  schemaVersion: 1;
  authority: 'observation-only';
  state: ResidentServiceReadinessState;
  ready: boolean;
  residentStartAuthorized: false;
  installAuthorized: false;
  enableAuthorized: false;
  loadAuthorized: false;
  kickstartAuthorized: false;
  killSwitchClearAuthorized: false;
  serviceLabel: typeof SERVICE_LABEL;
  releaseIdentity: string;
  checks: ResidentServiceReadinessChecks;
  reasons: ResidentServiceReadinessReason[];
}

export interface ResidentServiceReleaseContract {
  /** Canonical immutable release root, ending in the exact release identity. */
  root: string;
  /** Exact 40-character lowercase Git object identity. */
  identity: string;
  /** Expected digest of package.json, bin/ashlr, and the complete dist tree. */
  treeSha256: string;
}

export interface ResidentServiceReadinessOptions extends ServiceInstallOptions {
  release: ResidentServiceReleaseContract;
  timeoutMs?: number;
}

interface CommandObservation {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface ReleaseTreeObservation {
  path: string;
  sha256: string;
}

export interface ResidentServiceReadinessDependencies {
  run?: (command: string, args: readonly string[], timeoutMs: number) => CommandObservation;
  releaseTreeBinding?: (entrypointPath: string) => ReleaseTreeObservation;
  killSwitchState?: (path: string) => 'absent' | 'present' | 'unknown';
  uid?: () => number;
}

interface LaunchdSnapshot {
  runtime: CommandObservation;
  disabled: CommandObservation;
  plist: CommandObservation;
  killSwitch: 'absent' | 'present' | 'unknown';
}

function runReadOnlyCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): CommandObservation {
  try {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error.message } : {}),
    };
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function observeKillSwitch(path: string): 'absent' | 'present' | 'unknown' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

function commandSucceeded(result: CommandObservation): boolean {
  return result.status === 0 && result.error === undefined && result.stderr.trim() === '';
}

function sameCommandObservation(left: CommandObservation, right: CommandObservation): boolean {
  return left.status === right.status
    && left.stdout === right.stdout
    && left.stderr === right.stderr
    && left.error === right.error;
}

function sameSnapshot(left: LaunchdSnapshot, right: LaunchdSnapshot): boolean {
  return sameCommandObservation(left.runtime, right.runtime)
    && sameCommandObservation(left.disabled, right.disabled)
    && sameCommandObservation(left.plist, right.plist)
    && left.killSwitch === right.killSwitch;
}

function launchdAbsent(result: CommandObservation): boolean {
  return result.status !== 0 && /(?:could not find (?:specified )?service|service .* not found|no such process|not loaded)/i
    .test(`${result.stdout}\n${result.stderr}`);
}

function exactDisabledState(output: string, label: string): boolean | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...output.matchAll(
    new RegExp(`"${escaped}"\\s*=>\\s*(enabled|disabled)(?:\\s|$)`, 'g'),
  )];
  if (matches.length !== 1) return null;
  return matches[0]?.[1] === 'disabled';
}

function parsePlistJson(result: CommandObservation): Record<string, unknown> | null {
  if (!commandSucceeded(result)) return null;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function restartPolicyCompatible(plist: Record<string, unknown>, restartSec: number): boolean {
  const keepAlive = plist['KeepAlive'];
  return plist['RunAtLoad'] === true
    && plist['LaunchOnlyOnce'] !== true
    && plist['Program'] === undefined
    && keepAlive !== null
    && typeof keepAlive === 'object'
    && !Array.isArray(keepAlive)
    && Object.keys(keepAlive as Record<string, unknown>).length === 1
    && (keepAlive as Record<string, unknown>)['SuccessfulExit'] === false
    && plist['ThrottleInterval'] === restartSec;
}

function strictAnd(left: boolean | null, right: boolean): boolean | null {
  if (left === false || !right) return false;
  return left === null ? null : true;
}

function blocked(
  reasons: ResidentServiceReadinessReason[],
  code: ResidentServiceReadinessReasonCode,
  detail: string,
): void {
  reasons.push({ code, severity: 'blocked', detail });
}

function degraded(
  reasons: ResidentServiceReadinessReason[],
  code: ResidentServiceReadinessReasonCode,
  detail: string,
): void {
  reasons.push({ code, severity: 'degraded', detail });
}

function result(
  releaseIdentity: string,
  checks: ResidentServiceReadinessChecks,
  reasons: ResidentServiceReadinessReason[],
): ResidentServiceReadiness {
  const state: ResidentServiceReadinessState = reasons.some((reason) => reason.severity === 'blocked')
    ? 'blocked'
    : reasons.some((reason) => reason.severity === 'degraded')
      ? 'degraded'
      : 'ready';
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    state,
    ready: state === 'ready',
    residentStartAuthorized: false,
    installAuthorized: false,
    enableAuthorized: false,
    loadAuthorized: false,
    kickstartAuthorized: false,
    killSwitchClearAuthorized: false,
    serviceLabel: SERVICE_LABEL,
    releaseIdentity,
    checks,
    reasons,
  };
}

function emptyChecks(): ResidentServiceReadinessChecks {
  return {
    exactLabel: null,
    loaded: null,
    enabled: null,
    immutableRelease: null,
    exactInvocation: null,
    restartPolicyCompatible: null,
    killSwitchAbsent: null,
    stableObservation: null,
  };
}

/**
 * Observe resident launchd readiness without changing service or kill state.
 * The two complete snapshots must match, closing obvious observation races.
 */
export function residentServiceReadiness(
  options: ResidentServiceReadinessOptions,
  dependencies: ResidentServiceReadinessDependencies = {},
): ResidentServiceReadiness {
  const checks = emptyChecks();
  const reasons: ResidentServiceReadinessReason[] = [];
  const platform = (options.platform ?? process.platform) as Platform;
  if (platform !== 'darwin') {
    blocked(reasons, 'unsupported-platform', 'resident readiness currently requires launchd on macOS');
    return result(options.release.identity, checks, reasons);
  }

  const releaseRoot = resolve(options.release.root);
  const releaseContractValid = RELEASE_ID_RE.test(options.release.identity)
    && SHA256_RE.test(options.release.treeSha256)
    && basename(releaseRoot) === options.release.identity
    && releaseRoot === options.release.root;
  if (!releaseContractValid) {
    checks.immutableRelease = false;
    blocked(reasons, 'release-contract-invalid', 'release root, identity, or tree digest is not canonical');
    return result(options.release.identity, checks, reasons);
  }

  const entrypoint = join(releaseRoot, 'bin', 'ashlr');
  const releaseTreeBinding = dependencies.releaseTreeBinding ?? daemonActivationReleaseTreeBinding;
  let firstReleaseBinding: ReleaseTreeObservation | null = null;
  try {
    firstReleaseBinding = releaseTreeBinding(entrypoint);
    checks.immutableRelease = firstReleaseBinding.path === releaseRoot
      && firstReleaseBinding.sha256 === options.release.treeSha256;
    if (!checks.immutableRelease) {
      blocked(reasons, 'release-binding-mismatch', 'observed release tree does not match the admitted immutable identity');
    }
  } catch {
    checks.immutableRelease = null;
    degraded(reasons, 'release-binding-unavailable', 'immutable release tree could not be observed safely');
  }

  let definition;
  try {
    definition = generateServiceDefinition({
      ...options,
      platform: 'darwin',
      binPath: entrypoint,
    });
  } catch {
    degraded(reasons, 'service-definition-unavailable', 'expected launchd service definition could not be generated');
    return result(options.release.identity, checks, reasons);
  }
  if (!definition.launchdRuntime) {
    degraded(reasons, 'service-definition-unavailable', 'expected launchd runtime contract is unavailable');
    return result(options.release.identity, checks, reasons);
  }

  const uid = (dependencies.uid ?? (() => (
    typeof process.getuid === 'function' ? process.getuid() : userInfo().uid
  )))();
  const domainTarget = `gui/${uid}`;
  const serviceTarget = `${domainTarget}/${SERVICE_LABEL}`;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const run = dependencies.run ?? runReadOnlyCommand;
  const killSwitchState = dependencies.killSwitchState ?? observeKillSwitch;
  const killPath = join(options.homeDir ?? homedir(), '.ashlr', 'KILL');

  const observe = (): LaunchdSnapshot => ({
    runtime: run('launchctl', ['print', serviceTarget], timeoutMs),
    disabled: run('launchctl', ['print-disabled', domainTarget], timeoutMs),
    plist: run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', definition.filePath], timeoutMs),
    killSwitch: killSwitchState(killPath),
  });
  const first = observe();
  const second = observe();
  let secondReleaseBinding: ReleaseTreeObservation | null = null;
  if (firstReleaseBinding) {
    try {
      secondReleaseBinding = releaseTreeBinding(entrypoint);
    } catch {
      checks.immutableRelease = null;
      degraded(reasons, 'release-binding-unavailable', 'immutable release tree could not be re-observed safely');
    }
  }
  const releaseStable = firstReleaseBinding === null || secondReleaseBinding === null
    ? null
    : firstReleaseBinding.path === secondReleaseBinding.path
      && firstReleaseBinding.sha256 === secondReleaseBinding.sha256;
  const serviceStable = sameSnapshot(first, second);
  checks.stableObservation = serviceStable ? releaseStable : false;
  if (releaseStable === false) {
    checks.immutableRelease = false;
    degraded(reasons, 'observation-changed', 'immutable release identity changed during the bounded observation window');
    return result(options.release.identity, checks, reasons);
  }
  if (!checks.stableObservation) {
    degraded(reasons, 'observation-changed', 'resident service state changed during the bounded observation window');
    return result(options.release.identity, checks, reasons);
  }

  const plist = parsePlistJson(second.plist);
  if (!plist) {
    degraded(reasons, 'service-definition-unavailable', 'installed launchd plist could not be parsed as structured data');
  } else {
    checks.exactLabel = plist['Label'] === SERVICE_LABEL;
    if (!checks.exactLabel) {
      blocked(reasons, 'service-label-mismatch', 'installed launchd plist label does not match the resident service label');
    }
    checks.exactInvocation = exactStringArray(
      plist['ProgramArguments'],
      definition.launchdRuntime.arguments,
    );
    if (!checks.exactInvocation) {
      blocked(reasons, 'service-invocation-mismatch', 'installed launchd plist does not invoke the admitted immutable release');
    }
    const restartSec = Number.isFinite(options.restartSec) && options.restartSec !== undefined
      ? Math.max(5, Math.floor(options.restartSec))
      : 30;
    checks.restartPolicyCompatible = restartPolicyCompatible(plist, restartSec);
    if (!checks.restartPolicyCompatible) {
      blocked(reasons, 'restart-policy-mismatch', 'launchd restart policy is incompatible with resident crash recovery');
    }
  }

  if (launchdAbsent(second.runtime)) {
    checks.loaded = false;
    blocked(reasons, 'service-not-loaded', 'launchd has no loaded resident service for the exact label');
  } else if (!commandSucceeded(second.runtime)) {
    checks.loaded = null;
    degraded(reasons, 'service-state-unavailable', 'loaded launchd service state could not be observed');
  } else {
    checks.loaded = true;
    const exactRuntime = parseExactLaunchdPrintRuntime(
      second.runtime.stdout,
      serviceTarget,
      definition.filePath,
      definition.launchdRuntime.program,
      definition.launchdRuntime.arguments,
    );
    const runtimeInvocationExact = exactRuntime?.loaded === true;
    const runtimeLabelExact = second.runtime.stdout.trimEnd().split(/\r?\n/, 1)[0]
      === `${serviceTarget} = {`;
    checks.exactLabel = strictAnd(checks.exactLabel, runtimeLabelExact);
    checks.exactInvocation = strictAnd(checks.exactInvocation, runtimeInvocationExact);
    if (!runtimeInvocationExact) {
      blocked(reasons, 'service-invocation-mismatch', 'loaded launchd runtime does not match the admitted service path and argv');
    }
  }

  if (!commandSucceeded(second.disabled)) {
    checks.enabled = null;
    degraded(reasons, 'service-enable-state-unavailable', 'launchd disabled state could not be observed');
  } else {
    const disabled = exactDisabledState(second.disabled.stdout, SERVICE_LABEL);
    checks.enabled = disabled === null ? null : !disabled;
    if (disabled === null) {
      degraded(reasons, 'service-enable-state-unavailable', 'launchd returned an ambiguous disabled state for the exact label');
    } else if (disabled) {
      blocked(reasons, 'service-disabled', 'resident launchd service is explicitly disabled');
    }
  }

  checks.killSwitchAbsent = second.killSwitch === 'absent'
    ? true
    : second.killSwitch === 'present'
      ? false
      : null;
  if (second.killSwitch === 'present') {
    blocked(reasons, 'kill-switch-present', 'daemon kill switch is present');
  } else if (second.killSwitch === 'unknown') {
    degraded(reasons, 'kill-switch-state-unavailable', 'daemon kill-switch absence could not be proven');
  }

  return result(options.release.identity, checks, reasons);
}
