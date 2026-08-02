/**
 * Read-only diagnostics for a resident macOS daemon service.
 *
 * Finite local observations cannot establish activation-time artifact identity,
 * exact loaded launchd policy, an immutable signing root, or lifecycle authority.
 * This module therefore always reports a blocked diagnostic and only exposes
 * local consistency hints.
 */

import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { userInfo } from 'node:os';
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
const MAX_MANIFEST_AGE_MS = 60 * 60 * 1_000;
const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ResidentServiceDiagnosticReasonCode =
  | 'trusted-signed-release-evidence-missing'
  | 'trusted-signed-interpreter-evidence-missing'
  | 'immutable-release-trust-root-missing'
  | 'signed-release-manifest-invalid'
  | 'signed-release-manifest-stale'
  | 'signed-release-manifest-mismatch'
  | 'home-directory-identity-unbound'
  | 'home-directory-identity-unavailable'
  | 'installed-service-environment-absent'
  | 'installed-service-environment-unavailable'
  | 'loaded-service-environment-absent'
  | 'loaded-service-environment-unavailable'
  | 'service-environment-mismatch'
  | 'service-environment-unsafe'
  | 'service-invocation-unsafe'
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
  signedReleaseManifest: ResidentServiceManifestState;
  homeDirectoryIdentity: ResidentServiceHomeDirectoryIdentityState;
  homeDirectoryIdentityBasis: ResidentServiceHomeDirectoryIdentityBasis;
  installedEnvironment: ResidentServiceEnvironmentState;
  loadedEnvironment: ResidentServiceEnvironmentState;
  environmentMatchesSignedManifest: boolean | null;
  environmentSafe: boolean | null;
  invocationSafe: boolean | null;
  exactLoadedDefinitionBound: false;
  killSwitchAbsent: boolean | null;
  repeatedSnapshotConsistent: boolean | null;
  hardDeadlineEnforced: false;
}

export interface ResidentServiceDiagnostic {
  schemaVersion: 5;
  scope: 'observation-only-diagnostic';
  diagnosticStatus: 'blocked';
  lifecycleAuthority: 'none';
  operationalAuthority: false;
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
  signedReleaseManifest?: ResidentServiceSignedReleaseManifestBinding;
  timeoutMs?: number;
}

export type ResidentServiceManifestState = 'absent' | 'degraded' | 'stale' | 'mismatch' | 'signature-consistent';
export type ResidentServiceEnvironmentState = 'absent' | 'degraded' | 'unbound' | 'mismatch' | 'exact';
export type ResidentServiceHomeDirectoryIdentityState = 'degraded' | 'unbound' | 'exact';
export type ResidentServiceHomeDirectoryIdentityBasis = 'system-account' | 'test-injected' | 'unavailable';

interface ResidentServiceHomeDirectoryIdentity {
  state: ResidentServiceHomeDirectoryIdentityState;
  canonicalPath: string | null;
  identity: string | null;
}

interface ResidentServiceHomeDirectoryIdentityFs {
  lstat: (path: string) => BigIntStats;
  open: (path: string, flags: number) => number;
  fstat: (descriptor: number) => BigIntStats;
  close: (descriptor: number) => void;
  realpath: (path: string) => string;
}

interface ResidentServiceAccountIdentity {
  uid: number;
  homeDir: string;
}

export interface ResidentServiceReleaseManifestPayloadV1 {
  schemaVersion: 1;
  release: ResidentServiceDeclaredRelease;
  service: {
    label: typeof SERVICE_LABEL;
    platform: Platform;
    program: string;
    arguments: string[];
    environment: Record<string, string>;
  };
  issuedAt: string;
  expiresAt: string;
}

export interface ResidentServiceSignedReleaseManifestV1 {
  payload: ResidentServiceReleaseManifestPayloadV1;
  keyId: string;
  signatureAlgorithm: 'Ed25519';
  signature: string;
}

export interface ResidentServiceReleaseTrustKeyV1 {
  keyId: string;
  publicKeyPem: string;
  validFrom: string;
  validUntil: string;
}

export interface ResidentServiceSignedReleaseManifestBinding {
  manifest: ResidentServiceSignedReleaseManifestV1;
  trustKey: ResidentServiceReleaseTrustKeyV1;
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
  /** Test-only substitute for the independently obtained operating-system account identity. */
  testOnlyTrustedAccountIdentity?: () => ResidentServiceAccountIdentity;
  /** Test-only filesystem seam for deterministic home-directory race fixtures. */
  homeDirectoryIdentityFs?: ResidentServiceHomeDirectoryIdentityFs;
  /** Test-only cooperative clock. It never establishes a hard production deadline. */
  testOnlyNowMs?: () => number;
  /** Test-only wall clock for signed-evidence freshness fixtures. */
  testOnlyWallClockMs?: () => number;
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

function exactIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function exactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizedEnvironment(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) return null;
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, entry] of entries) {
    if (
      !ENVIRONMENT_NAME_RE.test(name)
      || typeof entry !== 'string'
      || Buffer.byteLength(entry, 'utf8') > 4_096
      || entry.includes('\0')
      || entry.includes('\r')
      || entry.includes('\n')
      || Object.hasOwn(environment, name)
    ) return null;
    environment[name] = entry;
  }
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)));
}

function sameEnvironment(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => (
      rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
    ));
}

function exactSafeEnvironment(
  environment: Record<string, string>,
  expected: Record<string, string> | null,
  home: string | null,
): boolean {
  const expectedNames = expected === null ? [] : Object.keys(expected).sort();
  return expected !== null
    && home !== null
    && expectedNames.length === 2
    && expectedNames[0] === 'HOME'
    && expectedNames[1] === 'PATH'
    && expected['HOME'] === home
    && sameEnvironment(environment, expected);
}

function sameHomeDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeOwnedHomeDirectory(stat: BigIntStats, uid: bigint): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid;
}

function observeStableHomeDirectoryIdentity(
  homePath: string,
  expectedUid: number,
  injectedFs?: ResidentServiceHomeDirectoryIdentityFs,
): ResidentServiceHomeDirectoryIdentity {
  if (
    !Number.isSafeInteger(expectedUid)
    || expectedUid < 0
    || !isAbsolute(homePath)
    || resolve(homePath) !== homePath
    || homePath.normalize('NFC') !== homePath
  ) return { state: 'unbound', canonicalPath: null, identity: null };

  const noFollow = fsConstants.O_NOFOLLOW;
  const directoryOnly = fsConstants.O_DIRECTORY;
  if (
    typeof noFollow !== 'number'
    || noFollow === 0
    || typeof directoryOnly !== 'number'
    || directoryOnly === 0
  ) return { state: 'unbound', canonicalPath: null, identity: null };

  const fs = injectedFs ?? {
    lstat: (path: string) => lstatSync(path, { bigint: true }),
    open: (path: string, flags: number) => openSync(path, flags),
    fstat: (descriptor: number) => fstatSync(descriptor, { bigint: true }),
    close: closeSync,
    realpath: (path: string) => realpathSync.native(path),
  };
  let descriptor: number | undefined;
  let observation: ResidentServiceHomeDirectoryIdentity = {
    state: 'degraded',
    canonicalPath: null,
    identity: null,
  };
  try {
    const uid = BigInt(expectedUid);
    const before = fs.lstat(homePath);
    if (!safeOwnedHomeDirectory(before, uid)) {
      return { state: 'unbound', canonicalPath: null, identity: null };
    }
    const canonicalBefore = fs.realpath(homePath);
    if (
      canonicalBefore !== homePath
      || canonicalBefore.normalize('NFC') !== canonicalBefore
    ) return { state: 'unbound', canonicalPath: null, identity: null };

    descriptor = fs.open(homePath, fsConstants.O_RDONLY | noFollow | directoryOnly);
    const openedBefore = fs.fstat(descriptor);
    if (
      !safeOwnedHomeDirectory(openedBefore, uid)
      || !sameHomeDirectorySnapshot(before, openedBefore)
    ) {
      observation = { state: 'degraded', canonicalPath: null, identity: null };
    } else {
      const openedAfter = fs.fstat(descriptor);
      const namedAfter = fs.lstat(homePath);
      const canonicalAfter = fs.realpath(homePath);
      observation = (
        safeOwnedHomeDirectory(openedAfter, uid)
        && safeOwnedHomeDirectory(namedAfter, uid)
        && sameHomeDirectorySnapshot(openedBefore, openedAfter)
        && sameHomeDirectorySnapshot(openedAfter, namedAfter)
        && canonicalAfter === canonicalBefore
        && canonicalAfter === homePath
      )
        ? {
            state: 'exact',
            canonicalPath: canonicalBefore,
            identity: `${openedAfter.dev}:${openedAfter.ino}`,
          }
        : { state: 'degraded', canonicalPath: null, identity: null };
    }
  } catch {
    observation = { state: 'degraded', canonicalPath: null, identity: null };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.close(descriptor);
      } catch {
        observation = { state: 'degraded', canonicalPath: null, identity: null };
      }
    }
  }
  return observation;
}

function observeAccountBoundHomeDirectoryIdentity(
  declaredHomePath: string,
  accountHomePath: string,
  expectedUid: number,
  injectedFs?: ResidentServiceHomeDirectoryIdentityFs,
): ResidentServiceHomeDirectoryIdentity {
  const account = observeStableHomeDirectoryIdentity(accountHomePath, expectedUid, injectedFs);
  const declared = declaredHomePath === accountHomePath
    ? account
    : observeStableHomeDirectoryIdentity(declaredHomePath, expectedUid, injectedFs);
  if (account.state === 'degraded' || declared.state === 'degraded') {
    return { state: 'degraded', canonicalPath: null, identity: null };
  }
  if (
    account.state !== 'exact'
    || declared.state !== 'exact'
    || account.canonicalPath !== declared.canonicalPath
    || account.identity !== declared.identity
  ) return { state: 'unbound', canonicalPath: null, identity: null };
  return account;
}

const UNSAFE_NODE_ARGUMENT_RE = /^(?:-r|--require(?:=|$)|--import(?:=|$)|--loader(?:=|$)|--experimental-loader(?:=|$)|-e|--eval(?:=|$)|--inspect(?:-brk)?(?:=|$))/i;

function exactSafeInvocation(
  args: readonly string[],
  interpreterPath: string,
  entrypointPath: string,
): boolean {
  return args.length >= 2
    && args[0] === interpreterPath
    && args[1] === entrypointPath
    && args.every((argument) => !UNSAFE_NODE_ARGUMENT_RE.test(argument));
}

function canonicalManifestPayload(
  payload: ResidentServiceReleaseManifestPayloadV1 | null | undefined,
): ResidentServiceReleaseManifestPayloadV1 | null {
  const release = payload?.release;
  const service = payload?.service;
  const environment = normalizedEnvironment(service?.environment);
  if (
    !exactObjectKeys(payload, ['schemaVersion', 'release', 'service', 'issuedAt', 'expiresAt'])
    || payload.schemaVersion !== 1
    || !exactObjectKeys(release, ['root', 'identity', 'treeSha256', 'interpreter'])
    || typeof release.root !== 'string'
    || typeof release.identity !== 'string'
    || typeof release.treeSha256 !== 'string'
    || !exactObjectKeys(release.interpreter, ['path', 'sha256'])
    || typeof release.interpreter.path !== 'string'
    || typeof release.interpreter.sha256 !== 'string'
    || !exactObjectKeys(service, ['label', 'platform', 'program', 'arguments', 'environment'])
    || service.label !== SERVICE_LABEL
    || !['darwin', 'linux', 'win32'].includes(service.platform)
    || typeof service.program !== 'string'
    || !Array.isArray(service.arguments)
    || service.arguments.length === 0
    || service.arguments.length > 64
    || service.arguments.some((argument) => (
      typeof argument !== 'string'
      || Buffer.byteLength(argument, 'utf8') > 8_192
      || argument.includes('\0')
      || argument.includes('\r')
      || argument.includes('\n')
    ))
    || environment === null
    || !exactIsoTimestamp(payload.issuedAt)
    || !exactIsoTimestamp(payload.expiresAt)
  ) return null;
  return {
    schemaVersion: 1,
    release: {
      root: release.root,
      identity: release.identity,
      treeSha256: release.treeSha256,
      interpreter: {
        path: release.interpreter.path,
        sha256: release.interpreter.sha256,
      },
    },
    service: {
      label: SERVICE_LABEL,
      platform: service.platform,
      program: service.program,
      arguments: [...service.arguments],
      environment,
    },
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

export function residentServiceReleaseManifestPayloadBytes(
  payload: ResidentServiceReleaseManifestPayloadV1,
): Buffer | null {
  const canonical = canonicalManifestPayload(payload);
  return canonical === null ? null : Buffer.from(JSON.stringify(canonical), 'utf8');
}

interface ManifestVerification {
  state: Exclude<ResidentServiceManifestState, 'absent' | 'mismatch'>;
  payload: ResidentServiceReleaseManifestPayloadV1 | null;
}

function verifyReleaseManifestBinding(
  binding: ResidentServiceSignedReleaseManifestBinding,
  nowMs: number,
): ManifestVerification {
  const { manifest, trustKey } = binding;
  const payload = canonicalManifestPayload(manifest?.payload);
  const payloadBytes = payload === null ? null : residentServiceReleaseManifestPayloadBytes(payload);
  const signature = typeof manifest?.signature === 'string'
    && BASE64_RE.test(manifest.signature)
    ? Buffer.from(manifest.signature, 'base64')
    : null;
  if (
    !exactObjectKeys(manifest, ['payload', 'keyId', 'signatureAlgorithm', 'signature'])
    || !exactObjectKeys(trustKey, ['keyId', 'publicKeyPem', 'validFrom', 'validUntil'])
    || payload === null
    || payloadBytes === null
    || manifest.keyId !== trustKey?.keyId
    || manifest.signatureAlgorithm !== 'Ed25519'
    || typeof trustKey.publicKeyPem !== 'string'
    || !exactIsoTimestamp(trustKey.validFrom)
    || !exactIsoTimestamp(trustKey.validUntil)
    || signature === null
    || signature.length !== 64
  ) return { state: 'degraded', payload: null };

  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const keyValidFrom = Date.parse(trustKey.validFrom);
  const keyValidUntil = Date.parse(trustKey.validUntil);
  if (
    !Number.isFinite(nowMs)
    || nowMs < keyValidFrom
    || issuedAt > nowMs + 60_000
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_MANIFEST_AGE_MS
    || issuedAt < keyValidFrom
    || expiresAt > keyValidUntil
    || nowMs >= expiresAt
  ) return { state: 'stale', payload: null };

  try {
    const publicKey = createPublicKey(trustKey.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return { state: 'degraded', payload: null };
    return verifySignature(null, payloadBytes, publicKey, signature)
      ? { state: 'signature-consistent', payload }
      : { state: 'degraded', payload: null };
  } catch {
    return { state: 'degraded', payload: null };
  }
}

interface EnvironmentObservation {
  state: 'absent' | 'degraded' | 'observed';
  environment: Record<string, string> | null;
}

function installedLaunchdEnvironment(plist: Record<string, unknown> | null): EnvironmentObservation {
  if (plist === null) return { state: 'degraded', environment: null };
  if (!Object.hasOwn(plist, 'EnvironmentVariables')) return { state: 'absent', environment: null };
  const environment = normalizedEnvironment(plist['EnvironmentVariables']);
  return environment === null
    ? { state: 'degraded', environment: null }
    : { state: 'observed', environment };
}

function loadedLaunchdEnvironment(output: string): EnvironmentObservation {
  const lines = output.trimEnd().split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line === '\tenvironment = {' ? [index] : []);
  if (starts.length === 0) return { state: 'absent', environment: null };
  if (starts.length !== 1) return { state: 'degraded', environment: null };
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  let closed = false;
  for (let index = starts[0]! + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === '\t}') {
      closed = true;
      break;
    }
    const match = /^\t\t([A-Za-z_][A-Za-z0-9_]*) => (.*)$/.exec(line);
    if (!match || Object.hasOwn(environment, match[1]!)) {
      return { state: 'degraded', environment: null };
    }
    environment[match[1]!] = match[2]!;
  }
  const normalized = closed ? normalizedEnvironment(environment) : null;
  return normalized === null
    ? { state: 'degraded', environment: null }
    : { state: 'observed', environment: normalized };
}

function diskDefinitionRestartPolicyCompatible(
  plist: Record<string, unknown>,
  expected: {
    processType: 'Background';
    runAtLoad: true;
    keepAliveSuccessfulExit: false;
    throttleIntervalSec: number;
    standardOutPath: string;
    standardErrorPath: string;
  },
): boolean {
  const keepAlive = plist['KeepAlive'];
  return exactObjectKeys(plist, [
    'Label',
    'ProcessType',
    'ProgramArguments',
    'EnvironmentVariables',
    'RunAtLoad',
    'KeepAlive',
    'ThrottleInterval',
    'StandardOutPath',
    'StandardErrorPath',
  ])
    && plist['ProcessType'] === expected.processType
    && plist['RunAtLoad'] === expected.runAtLoad
    && exactObjectKeys(keepAlive, ['SuccessfulExit'])
    && keepAlive['SuccessfulExit'] === expected.keepAliveSuccessfulExit
    && typeof plist['ThrottleInterval'] === 'number'
    && Number.isSafeInteger(plist['ThrottleInterval'])
    && plist['ThrottleInterval'] === expected.throttleIntervalSec
    && plist['StandardOutPath'] === expected.standardOutPath
    && plist['StandardErrorPath'] === expected.standardErrorPath;
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
      code: 'immutable-release-trust-root-missing',
      severity: 'blocked',
      detail: 'the evidence key is caller-supplied and is not anchored to an independently configured immutable release trust root',
    },
    {
      code: 'exact-loaded-definition-binding-missing',
      severity: 'blocked',
      detail: 'launchd runtime output cannot prove the exact loaded conditional crash-relaunch definition',
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
    schemaVersion: 5,
    scope: 'observation-only-diagnostic',
    diagnosticStatus: 'blocked',
    lifecycleAuthority: 'none',
    operationalAuthority: false,
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
    signedReleaseManifest: 'absent',
    homeDirectoryIdentity: 'unbound',
    homeDirectoryIdentityBasis: 'unavailable',
    installedEnvironment: 'absent',
    loadedEnvironment: 'absent',
    environmentMatchesSignedManifest: null,
    environmentSafe: null,
    invocationSafe: null,
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
    checks.environmentSafe = false;
    blocked(
      reasons,
      'unsupported-platform',
      'this dormant slice cannot authenticate systemd loaded environments or the inherited environment of Windows Task Scheduler processes',
    );
    return result(options.release.identity, checks, reasons);
  }

  const accountIdentityBasis: ResidentServiceHomeDirectoryIdentityBasis = dependencies.testOnlyTrustedAccountIdentity
    ? 'test-injected'
    : 'system-account';
  let accountIdentity: ResidentServiceAccountIdentity = { uid: -1, homeDir: '' };
  try {
    const observedAccountIdentity = dependencies.testOnlyTrustedAccountIdentity
      ? dependencies.testOnlyTrustedAccountIdentity()
      : (() => {
          const identity = userInfo();
          return { uid: identity.uid, homeDir: identity.homedir };
        })();
    if (
      observedAccountIdentity !== null
      && typeof observedAccountIdentity === 'object'
      && Number.isSafeInteger(observedAccountIdentity.uid)
      && observedAccountIdentity.uid >= 0
      && typeof observedAccountIdentity.homeDir === 'string'
    ) accountIdentity = observedAccountIdentity;
  } catch {
    // Invalid identity observations are normalized below and remain fail-closed.
  }
  const uid = accountIdentity.uid;
  const accountHomePath = typeof accountIdentity.homeDir === 'string' ? accountIdentity.homeDir : '';
  const declaredHomePath = options.homeDir ?? accountHomePath;
  checks.homeDirectoryIdentityBasis = accountIdentityBasis;
  const observeHomeIdentity = (): ResidentServiceHomeDirectoryIdentity => {
    try {
      const observation = observeAccountBoundHomeDirectoryIdentity(
        declaredHomePath,
        accountHomePath,
        uid,
        dependencies.homeDirectoryIdentityFs,
      );
      if (
        !['degraded', 'unbound', 'exact'].includes(observation?.state)
        || (observation.state === 'exact' && (
          typeof observation.canonicalPath !== 'string'
          || typeof observation.identity !== 'string'
          || observation.identity.length === 0
        ))
      ) return { state: 'degraded', canonicalPath: null, identity: null };
      return observation;
    } catch {
      return { state: 'degraded', canonicalPath: null, identity: null };
    }
  };
  let homeIdentity = observeHomeIdentity();
  checks.homeDirectoryIdentity = homeIdentity.state;
  let trustedHomePath = homeIdentity.state === 'exact' ? homeIdentity.canonicalPath : null;
  const noteHomeIdentityFailure = (): void => {
    checks.environmentSafe = false;
    if (homeIdentity.state === 'degraded') {
      if (!reasons.some(({ code }) => code === 'home-directory-identity-unavailable')) {
        degraded(
          reasons,
          'home-directory-identity-unavailable',
          'home directory identity is missing, unreadable, unsupported, or changed during descriptor-bound observation',
        );
      }
    } else {
      if (!reasons.some(({ code }) => code === 'home-directory-identity-unbound')) {
        blocked(
          reasons,
          'home-directory-identity-unbound',
          'declared HOME must match the independently obtained account HOME by canonical path and stable descriptor identity',
        );
      }
    }
  };
  if (trustedHomePath === null || homeIdentity.identity === null) {
    noteHomeIdentityFailure();
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
  const expectedEnvironment = normalizedEnvironment(definition.launchdRuntime.environment);
  if (expectedEnvironment === null) {
    degraded(reasons, 'service-definition-unavailable', 'expected launchd environment contract is unavailable');
    return result(options.release.identity, checks, reasons);
  }

  const entrypointInvocationSafe = exactSafeInvocation(
    definition.launchdRuntime.arguments,
    interpreterPath,
    entrypoint,
  );
  checks.invocationSafe = entrypointInvocationSafe;
  if (!entrypointInvocationSafe) {
    blocked(reasons, 'service-invocation-unsafe', 'resident invocation contains a loader, preload, eval, or debug injection surface');
  }

  let manifestPayload: ResidentServiceReleaseManifestPayloadV1 | null = null;
  if (!options.signedReleaseManifest) {
    blocked(reasons, 'trusted-signed-release-evidence-missing', 'signed immutable release manifest is absent');
    blocked(reasons, 'trusted-signed-interpreter-evidence-missing', 'signed interpreter binding is absent');
  } else {
    const manifestVerification = verifyReleaseManifestBinding(
      options.signedReleaseManifest,
      (dependencies.testOnlyWallClockMs ?? Date.now)(),
    );
    checks.signedReleaseManifest = manifestVerification.state;
    if (manifestVerification.state === 'degraded') {
      blocked(reasons, 'signed-release-manifest-invalid', 'signed release manifest or trust-key binding is invalid or unreadable');
    } else if (manifestVerification.state === 'stale') {
      blocked(reasons, 'signed-release-manifest-stale', 'signed release manifest is expired, future-dated, or outside the trust-key validity window');
    } else if (manifestVerification.payload) {
      const payload = manifestVerification.payload;
      const signedInvocationSafe = exactSafeInvocation(
        payload.service.arguments,
        interpreterPath,
        entrypoint,
      );
      checks.invocationSafe = checks.invocationSafe === true && signedInvocationSafe;
      if (!signedInvocationSafe) {
        blocked(reasons, 'service-invocation-unsafe', 'signed invocation contains a loader, preload, eval, or debug injection surface');
      }
      const releaseExact = payload.release.root === options.release.root
        && payload.release.identity === options.release.identity
        && payload.release.treeSha256 === options.release.treeSha256
        && sameBinding(payload.release.interpreter, options.release.interpreter);
      const serviceExact = payload.service.label === SERVICE_LABEL
        && payload.service.platform === 'darwin'
        && payload.service.program === definition.launchdRuntime.program
        && exactStringArray(payload.service.arguments, definition.launchdRuntime.arguments);
      if (!releaseExact || !serviceExact) {
        checks.signedReleaseManifest = 'mismatch';
        blocked(reasons, 'signed-release-manifest-mismatch', 'signed release manifest does not match the declared release, interpreter, platform, or invocation');
      } else {
        manifestPayload = payload;
        if (!exactSafeEnvironment(payload.service.environment, expectedEnvironment, trustedHomePath)) {
          checks.environmentSafe = false;
          blocked(
            reasons,
            'service-environment-unsafe',
            'signed environment must equal the generated HOME and PATH contract; extra Node, npm, loader, dynamic-linker, and shell startup variables are refused',
          );
        }
      }
    }
  }

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
  const killPath = trustedHomePath === null ? null : join(trustedHomePath, '.ashlr', 'KILL');
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
    if (killPath === null) return 'unknown';
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
    diskRestartPolicyCompatible = diskDefinitionRestartPolicyCompatible(
      plist,
      definition.launchdRuntime.supervisor,
    );
    if (!diskRestartPolicyCompatible) {
      blocked(reasons, 'restart-policy-mismatch', 'launchd policy does not match the generated bounded conditional crash-relaunch contract');
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
          : 'loaded launchd state is incompatible with the generated conditional crash-relaunch hints',
      );
    }
  }

  if (homeIdentity.state === 'exact') {
    const initialHomeIdentity = homeIdentity;
    const finalHomeIdentity = observeHomeIdentity();
    if (
      finalHomeIdentity.state !== 'exact'
      || finalHomeIdentity.canonicalPath !== initialHomeIdentity.canonicalPath
      || finalHomeIdentity.identity === null
      || finalHomeIdentity.identity !== initialHomeIdentity.identity
    ) {
      homeIdentity = { state: 'degraded', canonicalPath: null, identity: null };
      trustedHomePath = null;
      checks.homeDirectoryIdentity = 'degraded';
      noteHomeIdentityFailure();
    }
  }

  const installedEnvironment = installedLaunchdEnvironment(plist);
  const loadedEnvironment = launchdAbsent(second.runtime)
    ? { state: 'absent', environment: null } as const
    : commandSucceeded(second.runtime)
      ? loadedLaunchdEnvironment(second.runtime.stdout)
      : { state: 'degraded', environment: null } as const;

  if (installedEnvironment.state === 'absent') {
    checks.installedEnvironment = 'absent';
    checks.environmentSafe = false;
    blocked(reasons, 'installed-service-environment-absent', 'installed launchd definition has no explicit environment');
  } else if (installedEnvironment.state === 'degraded') {
    checks.installedEnvironment = 'degraded';
    checks.environmentSafe = false;
    degraded(reasons, 'installed-service-environment-unavailable', 'installed launchd environment is unreadable or structurally ambiguous');
  } else {
    checks.installedEnvironment = 'unbound';
  }
  if (loadedEnvironment.state === 'absent') {
    checks.loadedEnvironment = 'absent';
    checks.environmentSafe = false;
    blocked(reasons, 'loaded-service-environment-absent', 'loaded launchd state has no exact environment observation');
  } else if (loadedEnvironment.state === 'degraded') {
    checks.loadedEnvironment = 'degraded';
    checks.environmentSafe = false;
    degraded(reasons, 'loaded-service-environment-unavailable', 'loaded launchd environment is unreadable or structurally ambiguous');
  } else {
    checks.loadedEnvironment = 'unbound';
  }

  if (installedEnvironment.environment && loadedEnvironment.environment) {
    const installedSafe = exactSafeEnvironment(
      installedEnvironment.environment,
      expectedEnvironment,
      trustedHomePath,
    );
    const loadedSafe = exactSafeEnvironment(
      loadedEnvironment.environment,
      expectedEnvironment,
      trustedHomePath,
    );
    const observedSafe = installedSafe && loadedSafe;
    checks.environmentSafe = checks.environmentSafe === false ? false : observedSafe;
    if (!observedSafe && !reasons.some(({ code }) => code === 'service-environment-unsafe')) {
      blocked(
        reasons,
        'service-environment-unsafe',
        'installed or loaded environment differs from the generated HOME and PATH contract or adds runtime-influence variables',
      );
    }

    if (manifestPayload && trustedHomePath !== null) {
      const signedEnvironmentBound = exactSafeEnvironment(
        manifestPayload.service.environment,
        expectedEnvironment,
        trustedHomePath,
      );
      const installedExact = signedEnvironmentBound
        && installedSafe
        && sameEnvironment(installedEnvironment.environment, manifestPayload.service.environment);
      const loadedExact = signedEnvironmentBound
        && loadedSafe
        && sameEnvironment(loadedEnvironment.environment, manifestPayload.service.environment);
      checks.installedEnvironment = installedExact ? 'exact' : 'mismatch';
      checks.loadedEnvironment = loadedExact ? 'exact' : 'mismatch';
      checks.environmentMatchesSignedManifest = installedExact
        && loadedExact
        && sameEnvironment(installedEnvironment.environment, loadedEnvironment.environment);
      if (!checks.environmentMatchesSignedManifest) {
        blocked(reasons, 'service-environment-mismatch', 'installed and loaded environments do not both equal the signed immutable release manifest');
      }
    } else {
      const identityState = homeIdentity.state === 'degraded' ? 'degraded' : 'unbound';
      checks.installedEnvironment = identityState;
      checks.loadedEnvironment = identityState;
      checks.environmentMatchesSignedManifest = null;
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
