/**
 * Read-only diagnostics for a resident macOS daemon service.
 *
 * Finite local observations cannot establish activation-time artifact identity,
 * exact loaded launchd policy, or lifecycle authority. This module therefore
 * always reports a blocked diagnostic and only exposes local consistency hints.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
const MAX_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

export type ResidentServiceDiagnosticReasonCode =
  | 'trusted-signed-release-evidence-missing'
  | 'trusted-signed-interpreter-evidence-missing'
  | 'exact-loaded-definition-binding-missing'
  | 'atomic-activation-handoff-missing'
  | 'hard-deadline-worker-missing'
  | 'native-consumer-evidence-missing'
  | 'unsupported-platform'
  | 'release-declaration-invalid'
  | 'release-binding-unavailable'
  | 'release-binding-mismatch'
  | 'interpreter-declaration-invalid'
  | 'interpreter-binding-unavailable'
  | 'interpreter-binding-mismatch'
  | 'service-definition-unavailable'
  | 'service-label-mismatch'
  | 'service-invocation-mismatch'
  | 'restart-policy-mismatch'
  | 'service-not-loaded'
  | 'service-not-running'
  | 'service-state-unavailable'
  | 'service-disabled'
  | 'service-enable-state-unavailable'
  | 'kill-switch-present'
  | 'kill-switch-state-unavailable'
  | 'observation-deadline-exceeded'
  | 'observation-changed';

export interface ResidentServiceDiagnosticReason {
  code: ResidentServiceDiagnosticReasonCode;
  severity: 'blocked' | 'degraded';
  detail: string;
}

export interface ResidentServiceDiagnosticChecks {
  exactLabel: boolean | null;
  loaded: boolean | null;
  running: boolean | null;
  enabled: boolean | null;
  localReleaseMatchesDeclaredDigest: boolean | null;
  localInterpreterMatchesDeclaredDigest: boolean | null;
  observedInvocationMatchesDeclaration: boolean | null;
  diskDefinitionRestartPolicyCompatible: boolean | null;
  loadedRestartPolicyHintsCompatible: boolean | null;
  exactLoadedDefinitionBound: false;
  killSwitchAbsent: boolean | null;
  repeatedSnapshotConsistent: boolean | null;
  hardDeadlineEnforced: false;
}

export interface ResidentServiceDiagnostic {
  schemaVersion: 2;
  scope: 'observation-only-diagnostic';
  diagnosticStatus: 'blocked';
  lifecycleAuthority: 'none';
  serviceLabel: typeof SERVICE_LABEL;
  declaredReleaseIdentity: string;
  localChecks: ResidentServiceDiagnosticChecks;
  findings: ResidentServiceDiagnosticReason[];
}

export interface ResidentServiceDeclaredRelease {
  /** Caller-declared canonical release root, ending in the declared identity. */
  root: string;
  /** Caller-declared 40-character lowercase Git-shaped identity. */
  identity: string;
  /** Caller-declared digest of package.json, bin/ashlr, and the complete dist tree. */
  treeSha256: string;
  /** Caller-declared local interpreter path and digest. */
  interpreter: ResidentServiceFileBinding;
}

export interface ResidentServiceDiagnosticOptions extends ServiceInstallOptions {
  release: ResidentServiceDeclaredRelease;
  timeoutMs?: number;
}

interface CommandObservation {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ResidentServiceFileBinding {
  path: string;
  sha256: string;
}

export interface ResidentServiceDiagnosticDependencies {
  run?: (command: string, args: readonly string[], timeoutMs: number) => CommandObservation;
  releaseTreeBinding?: (entrypointPath: string, timeoutMs: number) => ResidentServiceFileBinding;
  interpreterBinding?: (interpreterPath: string, timeoutMs: number) => ResidentServiceFileBinding;
  killSwitchState?: (path: string) => 'absent' | 'present' | 'unknown';
  uid?: () => number;
  /** Test-only cooperative clock. It never establishes a hard production deadline. */
  testOnlyNowMs?: () => number;
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
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
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

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function bindingDeadline(timeoutMs: number): () => void {
  const deadlineAt = Date.now() + timeoutMs;
  return () => {
    if (Date.now() >= deadlineAt) throw new Error('artifact binding deadline exceeded');
  };
}

function hashStableFile(path: string, assertWithinDeadline: () => void): ResidentServiceFileBinding {
  assertWithinDeadline();
  const canonical = realpathSync(resolve(path));
  assertWithinDeadline();
  const fd = openSync(canonical, 'r');
  try {
    assertWithinDeadline();
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`artifact is not a regular file: ${canonical}`);
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      assertWithinDeadline();
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset);
      if (count <= 0) throw new Error(`short artifact binding read: ${canonical}`);
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    assertWithinDeadline();
    const after = fstatSync(fd, { bigint: true });
    assertWithinDeadline();
    if (!sameFileSnapshot(before, after) || realpathSync(canonical) !== canonical) {
      throw new Error(`artifact changed during read: ${canonical}`);
    }
    assertWithinDeadline();
    return { path: canonical, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function hashStableInterpreter(path: string, timeoutMs: number): ResidentServiceFileBinding {
  return hashStableFile(path, bindingDeadline(timeoutMs));
}

function releasePackageRoot(entrypointPath: string, assertWithinDeadline: () => void): string {
  assertWithinDeadline();
  let current = dirname(realpathSync(resolve(entrypointPath)));
  for (;;) {
    assertWithinDeadline();
    if (
      existsSync(join(current, 'package.json'))
      && existsSync(join(current, 'bin', 'ashlr'))
      && existsSync(join(current, 'dist', 'cli', 'index.js'))
    ) {
      assertWithinDeadline();
      return realpathSync(current);
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('runtime-release-root-unavailable');
    current = parent;
  }
}

function releaseFilePaths(root: string, assertWithinDeadline: () => void): string[] {
  const files = [join(root, 'package.json'), join(root, 'bin', 'ashlr')];
  const pending = [join(root, 'dist')];
  while (pending.length > 0) {
    assertWithinDeadline();
    const directory = pending.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertWithinDeadline();
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`runtime release contains a symlink: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`runtime release contains an unsupported entry: ${path}`);
      if (files.length + pending.length > 20_000) {
        throw new Error('runtime release file bound exceeded');
      }
    }
  }
  assertWithinDeadline();
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

function releaseFilesDigest(
  root: string,
  files: readonly string[],
  assertWithinDeadline: () => void,
): string {
  const hash = createHash('sha256');
  for (const path of files) {
    assertWithinDeadline();
    const binding = hashStableFile(path, assertWithinDeadline);
    const name = relative(root, binding.path).replaceAll('\\', '/');
    if (name.startsWith('../') || name === '..' || isAbsolute(name)) {
      throw new Error('runtime release file escaped package root');
    }
    hash.update(`${name}\0${binding.sha256}\0`, 'utf8');
  }
  assertWithinDeadline();
  return hash.digest('hex');
}

function hashStableReleaseTree(entrypointPath: string, timeoutMs: number): ResidentServiceFileBinding {
  const assertWithinDeadline = bindingDeadline(timeoutMs);
  const root = releasePackageRoot(entrypointPath, assertWithinDeadline);
  const before = releaseFilePaths(root, assertWithinDeadline);
  const firstDigest = releaseFilesDigest(root, before, assertWithinDeadline);
  const after = releaseFilePaths(root, assertWithinDeadline);
  if (before.length !== after.length || before.some((path, index) => path !== after[index])) {
    throw new Error('runtime release tree changed during hashing');
  }
  const secondDigest = releaseFilesDigest(root, after, assertWithinDeadline);
  if (firstDigest !== secondDigest) throw new Error('runtime release content changed during hashing');
  assertWithinDeadline();
  return { path: root, sha256: secondDigest };
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

function exactLaunchdValue(output: string, field: string): string | null {
  const prefix = `\t${field} = `;
  const values = output.trimEnd().split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
  return values.length === 1 ? values[0]! : null;
}

function loadedRestartPolicyHintsCompatible(output: string): boolean | null {
  const properties = exactLaunchdValue(output, 'properties');
  if (properties === null) return null;
  const propertySet = new Set(properties.split('|').map((entry) => entry.trim()).filter(Boolean));
  return propertySet.has('runatload')
    && !propertySet.has('keepalive')
    && !propertySet.has('launchonlyonce');
}

function launchdRuntimeState(output: string): string | null {
  return exactLaunchdValue(output, 'state');
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

function diskDefinitionRestartPolicyCompatible(plist: Record<string, unknown>): boolean {
  return plist['RunAtLoad'] === true
    && plist['LaunchOnlyOnce'] !== true
    && plist['Program'] === undefined
    && plist['KeepAlive'] === false
    && plist['ThrottleInterval'] === undefined;
}

function sameBinding(
  left: ResidentServiceFileBinding,
  right: ResidentServiceFileBinding,
): boolean {
  return left.path === right.path && left.sha256 === right.sha256;
}

function strictAnd(left: boolean | null, right: boolean): boolean | null {
  if (left === false || !right) return false;
  return left === null ? null : true;
}

function blocked(
  reasons: ResidentServiceDiagnosticReason[],
  code: ResidentServiceDiagnosticReasonCode,
  detail: string,
): void {
  reasons.push({ code, severity: 'blocked', detail });
}

function degraded(
  reasons: ResidentServiceDiagnosticReason[],
  code: ResidentServiceDiagnosticReasonCode,
  detail: string,
): void {
  reasons.push({ code, severity: 'degraded', detail });
}

function architecturalBlockers(): ResidentServiceDiagnosticReason[] {
  return [
    {
      code: 'trusted-signed-release-evidence-missing',
      severity: 'blocked',
      detail: 'caller-declared release identity and digest are not bound to trusted signed release evidence',
    },
    {
      code: 'trusted-signed-interpreter-evidence-missing',
      severity: 'blocked',
      detail: 'caller-declared interpreter identity is not bound to trusted signed release evidence',
    },
    {
      code: 'exact-loaded-definition-binding-missing',
      severity: 'blocked',
      detail: 'launchd runtime output cannot prove the exact loaded SuccessfulExit=false definition',
    },
    {
      code: 'atomic-activation-handoff-missing',
      severity: 'blocked',
      detail: 'no atomic activation-time handoff or final revalidation binds this finite observation to lifecycle mutation',
    },
    {
      code: 'hard-deadline-worker-missing',
      severity: 'blocked',
      detail: 'synchronous filesystem inspection is not isolated in a killable hard-deadline worker',
    },
    {
      code: 'native-consumer-evidence-missing',
      severity: 'blocked',
      detail: 'no production lifecycle consumer or native resident-service integration evidence exists',
    },
  ];
}

function result(
  declaredReleaseIdentity: string,
  localChecks: ResidentServiceDiagnosticChecks,
  findings: ResidentServiceDiagnosticReason[],
): ResidentServiceDiagnostic {
  return {
    schemaVersion: 2,
    scope: 'observation-only-diagnostic',
    diagnosticStatus: 'blocked',
    lifecycleAuthority: 'none',
    serviceLabel: SERVICE_LABEL,
    declaredReleaseIdentity,
    localChecks,
    findings,
  };
}

function emptyChecks(): ResidentServiceDiagnosticChecks {
  return {
    exactLabel: null,
    loaded: null,
    running: null,
    enabled: null,
    localReleaseMatchesDeclaredDigest: null,
    localInterpreterMatchesDeclaredDigest: null,
    observedInvocationMatchesDeclaration: null,
    diskDefinitionRestartPolicyCompatible: null,
    loadedRestartPolicyHintsCompatible: null,
    exactLoadedDefinitionBound: false,
    killSwitchAbsent: null,
    repeatedSnapshotConsistent: null,
    hardDeadlineEnforced: false,
  };
}

/**
 * Observe local resident launchd consistency without changing service or kill
 * state. Repeated snapshots are diagnostic hints only; they cannot close the
 * post-read or activation-time race.
 */
export function observeResidentServiceDiagnostic(
  options: ResidentServiceDiagnosticOptions,
  dependencies: ResidentServiceDiagnosticDependencies = {},
): ResidentServiceDiagnostic {
  const checks = emptyChecks();
  const reasons = architecturalBlockers();
  const platform = process.platform as Platform;
  if (platform !== 'darwin') {
    blocked(reasons, 'unsupported-platform', 'resident diagnostic currently requires launchd on macOS');
    return result(options.release.identity, checks, reasons);
  }

  const releaseRoot = resolve(options.release.root);
  const releaseDeclarationValid = RELEASE_ID_RE.test(options.release.identity)
    && SHA256_RE.test(options.release.treeSha256)
    && basename(releaseRoot) === options.release.identity
    && releaseRoot === options.release.root;
  if (!releaseDeclarationValid) {
    checks.localReleaseMatchesDeclaredDigest = false;
    blocked(reasons, 'release-declaration-invalid', 'caller-declared release root, identity, or tree digest is not canonical');
    return result(options.release.identity, checks, reasons);
  }

  const interpreterPath = resolve(options.release.interpreter.path);
  const interpreterDeclarationValid = interpreterPath === options.release.interpreter.path
    && SHA256_RE.test(options.release.interpreter.sha256)
    && (options.nodePath === undefined || options.nodePath === interpreterPath);
  if (!interpreterDeclarationValid) {
    checks.localInterpreterMatchesDeclaredDigest = false;
    blocked(
      reasons,
      'interpreter-declaration-invalid',
      'caller-declared interpreter path and digest must be canonical and agree with the service invocation',
    );
    return result(options.release.identity, checks, reasons);
  }

  const entrypoint = join(releaseRoot, 'bin', 'ashlr');
  let definition;
  try {
    definition = generateServiceDefinition({
      ...options,
      platform: 'darwin',
      binPath: entrypoint,
      nodePath: interpreterPath,
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
  const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeout)))
    : DEFAULT_TIMEOUT_MS;
  const run = dependencies.run ?? runReadOnlyCommand;
  const killSwitchState = dependencies.killSwitchState ?? observeKillSwitch;
  const releaseTreeBinding = dependencies.releaseTreeBinding ?? hashStableReleaseTree;
  const interpreterBinding = dependencies.interpreterBinding ?? hashStableInterpreter;
  const killPath = join(options.homeDir ?? homedir(), '.ashlr', 'KILL');
  const nowMs = dependencies.testOnlyNowMs ?? Date.now;
  const startedAt = nowMs();
  let lastObservedAt = startedAt;
  let deadlineExceeded = !Number.isFinite(startedAt);
  const deadlineAt = deadlineExceeded ? startedAt : startedAt + timeoutMs;

  const remainingMs = (): number => {
    const observedAt = nowMs();
    if (
      !Number.isFinite(observedAt)
      || observedAt < lastObservedAt
      || observedAt >= deadlineAt
    ) {
      deadlineExceeded = true;
      return 0;
    }
    lastObservedAt = observedAt;
    return Math.max(1, Math.floor(deadlineAt - observedAt));
  };
  const unavailableCommand = (): CommandObservation => ({
    status: null,
    stdout: '',
    stderr: '',
    error: 'resident diagnostic cooperative observation budget exceeded',
  });
  const runBounded = (command: string, args: readonly string[]): CommandObservation => {
    const remaining = remainingMs();
    if (remaining === 0) return unavailableCommand();
    const observation = run(command, args, remaining);
    remainingMs();
    return observation;
  };
  const bindBounded = (
    binding: (path: string, remaining: number) => ResidentServiceFileBinding,
    path: string,
  ): ResidentServiceFileBinding | null => {
    const remaining = remainingMs();
    if (remaining === 0) return null;
    try {
      const observation = binding(path, remaining);
      remainingMs();
      return observation;
    } catch {
      remainingMs();
      return null;
    }
  };
  const observeKillSwitchBounded = (): 'absent' | 'present' | 'unknown' => {
    if (remainingMs() === 0) return 'unknown';
    let observation: 'absent' | 'present' | 'unknown';
    try {
      observation = killSwitchState(killPath);
    } catch {
      observation = 'unknown';
    }
    remainingMs();
    return observation;
  };
  const observe = (): LaunchdSnapshot => ({
    runtime: runBounded('/bin/launchctl', ['print', serviceTarget]),
    disabled: runBounded('/bin/launchctl', ['print-disabled', domainTarget]),
    plist: runBounded('/usr/bin/plutil', ['-convert', 'json', '-o', '-', definition.filePath]),
    killSwitch: observeKillSwitchBounded(),
  });

  const firstReleaseBinding = bindBounded(releaseTreeBinding, entrypoint);
  const firstInterpreterBinding = bindBounded(interpreterBinding, interpreterPath);
  const first = observe();
  const second = observe();
  const secondReleaseBinding = bindBounded(releaseTreeBinding, entrypoint);
  const secondInterpreterBinding = bindBounded(interpreterBinding, interpreterPath);
  const finalKillSwitch = observeKillSwitchBounded();
  // These repeated reads are consistency hints only, not a final authority handoff.
  const finalInterpreterBinding = bindBounded(interpreterBinding, interpreterPath);
  const finalReleaseBinding = bindBounded(releaseTreeBinding, entrypoint);

  const releaseBindings = [firstReleaseBinding, secondReleaseBinding, finalReleaseBinding];
  const completeReleaseBindings = releaseBindings.filter(
    (binding): binding is ResidentServiceFileBinding => binding !== null,
  );
  const releaseMatchesDeclaration = completeReleaseBindings.every((binding) => (
    binding.path === releaseRoot && binding.sha256 === options.release.treeSha256
  ));
  if (!releaseMatchesDeclaration) {
    checks.localReleaseMatchesDeclaredDigest = false;
    blocked(reasons, 'release-binding-mismatch', 'observed release tree does not match the caller-declared digest');
  } else if (completeReleaseBindings.length !== releaseBindings.length) {
    checks.localReleaseMatchesDeclaredDigest = null;
    degraded(reasons, 'release-binding-unavailable', 'local release tree could not be observed across the full diagnostic window');
  } else {
    checks.localReleaseMatchesDeclaredDigest = true;
  }
  const releaseStable = completeReleaseBindings.length === releaseBindings.length
    ? completeReleaseBindings.every((binding) => sameBinding(binding, completeReleaseBindings[0]!))
    : null;

  const interpreterBindings = [
    firstInterpreterBinding,
    secondInterpreterBinding,
    finalInterpreterBinding,
  ];
  const completeInterpreterBindings = interpreterBindings.filter(
    (binding): binding is ResidentServiceFileBinding => binding !== null,
  );
  const interpreterMatchesDeclaration = completeInterpreterBindings.every((binding) => (
    binding.path === options.release.interpreter.path
    && binding.sha256 === options.release.interpreter.sha256
  ));
  if (!interpreterMatchesDeclaration) {
    checks.localInterpreterMatchesDeclaredDigest = false;
    blocked(reasons, 'interpreter-binding-mismatch', 'local interpreter does not match the caller-declared digest');
  } else if (completeInterpreterBindings.length !== interpreterBindings.length) {
    checks.localInterpreterMatchesDeclaredDigest = null;
    degraded(reasons, 'interpreter-binding-unavailable', 'local interpreter could not be observed across the full diagnostic window');
  } else {
    checks.localInterpreterMatchesDeclaredDigest = true;
  }
  const interpreterStable = completeInterpreterBindings.length === interpreterBindings.length
    ? completeInterpreterBindings.every((binding) => sameBinding(binding, completeInterpreterBindings[0]!))
    : null;

  const serviceStable = sameSnapshot(first, second)
    && second.killSwitch === finalKillSwitch;
  const bindingChanged = releaseStable === false || interpreterStable === false;
  checks.repeatedSnapshotConsistent = deadlineExceeded
    ? false
    : !serviceStable || bindingChanged
      ? false
      : releaseStable === true && interpreterStable === true
        ? true
        : null;
  if (deadlineExceeded) {
    degraded(reasons, 'observation-deadline-exceeded', 'resident diagnostic exceeded its cooperative observation budget');
  }
  if (checks.repeatedSnapshotConsistent === false && !deadlineExceeded) {
    degraded(reasons, 'observation-changed', 'resident service, release, interpreter, or kill state changed during the diagnostic');
  }

  const plist = parsePlistJson(second.plist);
  let diskRestartPolicyCompatible: boolean | null = null;
  let loadedRestartPolicy: boolean | null = null;
  if (!plist) {
    degraded(reasons, 'service-definition-unavailable', 'installed launchd plist could not be parsed as structured data');
  } else {
    checks.exactLabel = plist['Label'] === SERVICE_LABEL;
    if (!checks.exactLabel) {
      blocked(reasons, 'service-label-mismatch', 'installed launchd plist label does not match the resident service label');
    }
    checks.observedInvocationMatchesDeclaration = exactStringArray(
      plist['ProgramArguments'],
      definition.launchdRuntime.arguments,
    );
    if (!checks.observedInvocationMatchesDeclaration) {
      blocked(reasons, 'service-invocation-mismatch', 'installed launchd plist does not match the caller-declared invocation');
    }
    diskRestartPolicyCompatible = diskDefinitionRestartPolicyCompatible(plist);
    if (!diskRestartPolicyCompatible) {
      blocked(reasons, 'restart-policy-mismatch', 'launchd policy does not prove automatic crash relaunch is disabled');
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
    checks.observedInvocationMatchesDeclaration = strictAnd(
      checks.observedInvocationMatchesDeclaration,
      runtimeInvocationExact,
    );
    if (!runtimeInvocationExact) {
      blocked(reasons, 'service-invocation-mismatch', 'loaded launchd runtime does not match the caller-declared service path and argv');
    }
    const runtimeState = launchdRuntimeState(second.runtime.stdout);
    checks.running = runtimeState === 'running' && exactRuntime?.pid !== undefined;
    if (!checks.running) {
      blocked(reasons, 'service-not-running', 'loaded launchd resident service is not proven running with a live pid');
    }
    loadedRestartPolicy = loadedRestartPolicyHintsCompatible(second.runtime.stdout);
    if (loadedRestartPolicy !== true) {
      blocked(
        reasons,
        'restart-policy-mismatch',
        loadedRestartPolicy === null
          ? 'loaded launchd restart policy could not be proven from native runtime state'
          : 'loaded launchd state does not prove automatic crash relaunch is disabled',
      );
    }
  }

  checks.diskDefinitionRestartPolicyCompatible = diskRestartPolicyCompatible;
  checks.loadedRestartPolicyHintsCompatible = loadedRestartPolicy;

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

  const killObservations = [first.killSwitch, second.killSwitch, finalKillSwitch];
  checks.killSwitchAbsent = killObservations.includes('present')
    ? false
    : killObservations.includes('unknown')
      ? null
      : true;
  if (killObservations.includes('present')) {
    blocked(reasons, 'kill-switch-present', 'daemon kill switch is present');
  } else if (killObservations.includes('unknown')) {
    degraded(reasons, 'kill-switch-state-unavailable', 'daemon kill-switch absence could not be proven');
  }

  return result(options.release.identity, checks, reasons);
}
