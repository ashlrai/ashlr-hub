/**
 * Resident admission — the resident daemon SERVICE under the operator's
 * standing grant (docs/RESIDENT-RUNTIME.md §d). Tier-1 (src/core/authority/**)
 * and inside the authority surface, so a deploy that changes it pauses the
 * grant until Mason re-approves.
 *
 * WHAT IT DECIDES. Whether `ashlr authority resident start` may install or
 * restart the launchd service `ai.ashlr.daemon`. It adds NO authority: the
 * daemon that service starts can only act inside the Touch-ID-signed standing
 * grant it re-verifies on every tick (authority/capability.ts). The only root
 * is the custody key compiled into STANDING_GRANT_TRUST_ROOTS — no new key,
 * file, env value or flag is ever trusted here.
 *
 * WHY NO SECOND TOUCH ID. The grant IS the operator's resident authorization
 * (≤ 30 days, host-bound, bound to this release's authority surface). The
 * custody helper's only Touch-ID signature is `sign-grant`; a presence-only
 * verb would need a helper reinstall (sudo) and is listed as optional future
 * hardening in the design doc.
 *
 * WHO MAY START IT. Only an operator at an interactive terminal: never a
 * daemon/swarm child, never an agent harness shell, never a process whose
 * HOME was redirected (every autonomous run gets an ephemeral HOME), and
 * never without a TTY — or, from the desktop app, without a click on a
 * native confirm dialog (the one-time native gesture below, 3.15, which
 * stands in for the TTY only). That is a speed bump for UNCONFINED same-user
 * processes, not the boundary — the boundary is that confined agents cannot
 * exec launchctl or write ~/Library/LaunchAgents at all (sandbox/confine.ts),
 * and that nothing started here can exceed the signed grant.
 *
 * HOW THE EFFECT IS GATED. `mintResidentServiceCapability()` re-observes and
 * re-verifies EVERYTHING itself (a caller cannot hand in a weaker check) and
 * returns a single-use, WeakMap-branded capability; daemon/service.ts
 * `installResidentService` claims it before any mutation, and the claim
 * re-checks expiry, Stop and the live grant id — the same pattern as
 * activation-permit.ts's resident-standing capability.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { readBuildIdentity, type BuildIdentity } from '../build-identity.js';
import { killSwitchOn } from '../sandbox/policy.js';
import {
  currentStandingPolicy,
  evaluateStandingAuthority,
  primeStandingPolicyCache,
  type StandingEvaluation,
} from './effective-config.js';
import { runningPackageRoot } from './surface.js';

/** The one command that installs or restarts the resident service. */
export const RESIDENT_START_COMMAND = 'ashlr authority resident start';
export const RESIDENT_STOP_COMMAND = 'ashlr authority resident stop';
export const RESIDENT_STATUS_COMMAND = 'ashlr authority resident status';

/** A minted capability is good for this long — mint happens right before the install. */
export const RESIDENT_CAPABILITY_TTL_MS = 60_000;

export type ResidentAdmissionCode =
  | 'admitted'
  | 'unsupported-platform'
  | 'not-compiled-release'
  | 'build-identity-untrusted'
  | 'grant-inactive'
  | 'stopped'
  | 'switch-off'
  | 'policy-unavailable';

/** `admitted`: start may run. `waiting-on-you`: one operator command fixes it. `blocked`: a prerequisite is missing. */
export type ResidentAdmissionStatus = 'admitted' | 'waiting-on-you' | 'blocked';

export interface ResidentAdmission {
  ok: boolean;
  code: ResidentAdmissionCode;
  status: ResidentAdmissionStatus;
  reason: string;
  /** The exact command Mason runs next; null when admitted or when no single command fixes it. */
  command: string | null;
  grantId: string | null;
  grantSeq: number | null;
  expiresAt: string | null;
  /** Build revision of the release the service would run (null = unknown). */
  revision: string | null;
  packageRoot: string | null;
}

/** The observations an admission verdict is computed from (all read fresh by the caller). */
export interface ResidentAdmissionInput {
  platform: string;
  /** The compiled release this process runs (surface.ts runningPackageRoot); null for tsx source / single-file binaries. */
  packageRoot: string | null;
  buildIdentity: BuildIdentity;
  evaluation: Pick<StandingEvaluation, 'grantState' | 'grantReason' | 'grant' | 'kill' | 'effectiveSwitch' | 'switch' | 'inactiveReason' | 'policy'>;
}

/**
 * PURE: is this release's build identity one a resident service may run?
 * Git provenance must be a clean tree (a dirty build is not what was
 * reviewed); CI provenance carries its revision; anything else is unknown.
 */
export function trustedResidentBuildIdentity(identity: BuildIdentity): boolean {
  if (typeof identity.revision !== 'string' || identity.revision.length === 0) return false;
  if (identity.provenance === 'git') return identity.dirty === false;
  return identity.provenance === 'github-actions';
}

/** PURE: the admission verdict. Order = the order Mason has to fix things in. */
export function evaluateResidentAdmission(input: ResidentAdmissionInput): ResidentAdmission {
  const ev = input.evaluation;
  const grant = ev.grant;
  const base = {
    grantId: grant?.grantId ?? null,
    grantSeq: grant?.grantSeq ?? null,
    expiresAt: grant?.expiresAt ?? null,
    revision: input.buildIdentity.revision ?? null,
    packageRoot: input.packageRoot,
  };
  const verdict = (
    code: ResidentAdmissionCode,
    status: ResidentAdmissionStatus,
    reason: string,
    command: string | null,
  ): ResidentAdmission => ({ ok: status === 'admitted', code, status, reason, command, ...base });

  if (input.platform !== 'darwin') {
    return verdict('unsupported-platform', 'blocked', 'the resident service runs under launchd with a Secure Enclave custody key, so it is macOS-only', null);
  }
  if (input.packageRoot === null) {
    return verdict('not-compiled-release', 'blocked', 'this ashlr is not a compiled release (TypeScript source or a single-file binary), so it cannot vouch for the code a service would run — run the installed `ashlr`', null);
  }
  if (!trustedResidentBuildIdentity(input.buildIdentity)) {
    const why = input.buildIdentity.provenance === 'git' && input.buildIdentity.dirty === true
      ? 'this release was built from a dirty working tree'
      : 'this release has no trusted build identity';
    return verdict('build-identity-untrusted', 'blocked', `${why} — commit, \`npm run build\` and install the release from a clean tree`, null);
  }
  if (ev.grantState !== 'active' || !grant) {
    return verdict('grant-inactive', 'blocked', `no active standing grant: ${ev.grantReason ?? ev.grantState}`, 'ashlr authority grant');
  }
  if (ev.kill) {
    return verdict('stopped', 'waiting-on-you', 'Stop is engaged (~/.ashlr/KILL)', 'ashlr authority clear-stop');
  }
  if (ev.effectiveSwitch === 'off') {
    if (ev.switch === 'off') {
      return verdict('switch-off', 'waiting-on-you', 'the autonomy switch is Off', 'ashlr authority switch autonomous');
    }
    return verdict('policy-unavailable', 'blocked', ev.inactiveReason ?? 'no standing policy is in force', null);
  }
  if (!ev.policy) {
    return verdict('policy-unavailable', 'blocked', ev.inactiveReason ?? 'no standing policy is in force', null);
  }
  return verdict('admitted', 'admitted', `grant #${grant.grantSeq} is active until ${grant.expiresAt}; release ${base.revision?.slice(0, 12) ?? '?'} is a clean build`, null);
}

/** Observe and verify NOW, for the code this process runs (fresh: the surface is re-hashed). */
export function observeResidentAdmission(opts: { nowMs?: number } = {}): { admission: ResidentAdmission; evaluation: StandingEvaluation } {
  const evaluation = evaluateStandingAuthority({ mode: 'fresh', surface: 'running', ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}) });
  const admission = evaluateResidentAdmission({
    platform: process.platform,
    packageRoot: runningPackageRoot(),
    buildIdentity: readBuildIdentity(),
    evaluation,
  });
  return { admission, evaluation };
}

// ---------------------------------------------------------------------------
// Operator context
// ---------------------------------------------------------------------------

/**
 * Environment markers of a process that is NOT the operator at a terminal:
 * the daemon / swarm re-entrancy markers ashlr sets on its own children, and
 * the markers agent harnesses set on the shells they drive (Claude Code sets
 * CLAUDECODE and AI_AGENT; Codex sets CODEX_SANDBOX*).
 */
export const NON_OPERATOR_ENV_MARKERS: readonly string[] = Object.freeze([
  'ASHLR_IN_DAEMON',
  'ASHLR_IN_SWARM',
  'CLAUDECODE',
  'AI_AGENT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
]);

export interface OperatorContext {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** HOME from the password database (never $HOME); null when unknown. */
  passwdHome: string | null;
  /**
   * 3.15: the operator clicked a NATIVE confirm dialog in the desktop app
   * (desktop/src-tauri/src/fleet_ops.rs), which minted a one-time gesture
   * token for this process. It stands in for the TTY — and only for the TTY:
   * the agent markers and the login-HOME check still apply. Absent = false.
   */
  nativeGesture?: boolean;
}

/**
 * The native gesture (3.15). The desktop app shows a native modal dialog —
 * page script can ask for it but cannot answer it, and no seat tool can reach
 * the app's event bus — and only after Mason clicks it writes
 * `~/.ashlr/authority/native-gestures/<32 hex>.json` (0600, create-new,
 * no-follow) and runs `ashlr authority resident start` with
 * `ASHLR_NATIVE_GESTURE=<32 hex>` in a scrubbed environment. The token is
 * accepted only when the file is a regular file owned by this user, private,
 * at most NATIVE_GESTURE_TTL_MS old, and names `resident-start`; it is
 * deleted BEFORE it is trusted, so it works exactly once. Confined fleet
 * agents cannot read or write `~/.ashlr/authority` at all (the sandbox
 * profile's tripwire). The residual risk — an UNCONFINED same-user process
 * forging the file — is the one docs/RESIDENT-RUNTIME.md already accepts for
 * the TTY check, and it still gets only the daemon the grant authorizes.
 */
export const NATIVE_GESTURE_ENV = 'ASHLR_NATIVE_GESTURE';
export const NATIVE_GESTURE_TTL_MS = 120_000;
export const NATIVE_GESTURE_DIR_RELATIVE = join('.ashlr', 'authority', 'native-gestures');
const NATIVE_GESTURE_RE = /^[a-f0-9]{32}$/u;
const NATIVE_GESTURE_MAX_BYTES = 512;

export type NativeGestureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Consume the gesture named by `env` (reads the file, deletes it, then
 * judges it). Pure apart from that one file. `absent` when no token was given.
 */
export function consumeNativeGesture(
  env: Readonly<Record<string, string | undefined>>,
  home: string | null,
  op: 'resident-start',
  nowMs: number = Date.now(),
): NativeGestureVerdict {
  const name = env[NATIVE_GESTURE_ENV];
  if (name === undefined || name === '') return { ok: false, reason: 'absent' };
  if (!NATIVE_GESTURE_RE.test(name)) return { ok: false, reason: 'the gesture token is malformed' };
  if (!home) return { ok: false, reason: 'the login home is unknown' };
  const path = join(home, NATIVE_GESTURE_DIR_RELATIVE, `${name}.json`);
  let text: string;
  let mtimeMs: number;
  try {
    const link = lstatSync(path);
    if (!link.isFile()) return { ok: false, reason: 'the gesture token is not a regular file' };
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    try {
      const stat = fstatSync(fd);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return { ok: false, reason: 'the gesture token is not yours' };
      if ((stat.mode & 0o077) !== 0) return { ok: false, reason: 'the gesture token is readable by others' };
      if (stat.size > NATIVE_GESTURE_MAX_BYTES) return { ok: false, reason: 'the gesture token is too large' };
      const buffer = Buffer.alloc(stat.size);
      readSync(fd, buffer, 0, stat.size, 0);
      text = buffer.toString('utf8');
      mtimeMs = stat.mtimeMs;
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: 'the gesture token was not found (it is used once and expires after two minutes)' };
  } finally {
    // Consumed whatever it said: a token is never read twice.
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  let body: { v?: unknown; op?: unknown; createdAt?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return { ok: false, reason: 'the gesture token is unreadable' };
  }
  if (body.v !== 1 || body.op !== op || typeof body.createdAt !== 'number') return { ok: false, reason: `the gesture token is not for ${op}` };
  // Both the body's clock and the file's must be recent; a future stamp (more
  // than clock skew) is refused too.
  const fresh = (at: number): boolean => at <= nowMs + 5_000 && nowMs - at <= NATIVE_GESTURE_TTL_MS;
  if (!fresh(body.createdAt) || !fresh(mtimeMs)) {
    return { ok: false, reason: 'the gesture token expired (it is good for two minutes)' };
  }
  return { ok: true };
}

/** Consumed once per process: the CLI asks twice (refusal, then mint). */
let nativeGestureMemo: NativeGestureVerdict | null = null;

export function currentOperatorContext(): OperatorContext {
  let passwdHome: string | null = null;
  try {
    passwdHome = userInfo().homedir || null;
  } catch {
    passwdHome = null;
  }
  if (nativeGestureMemo === null) nativeGestureMemo = consumeNativeGesture(process.env, passwdHome, 'resident-start');
  return {
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    env: process.env,
    passwdHome,
    nativeGesture: nativeGestureMemo.ok,
  };
}

/** Why a native gesture given to this process was refused; null when none was given or it was accepted. */
export function nativeGestureRefusal(): string | null {
  if (nativeGestureMemo === null || nativeGestureMemo.ok || nativeGestureMemo.reason === 'absent') return null;
  return nativeGestureMemo.reason;
}

/** Test hook: forget the per-process gesture verdict. */
export function resetNativeGestureForTest(): void {
  nativeGestureMemo = null;
}

/** PURE: why this is not the operator at a terminal, or null when it is. */
export function operatorContextRefusal(ctx: OperatorContext): string | null {
  for (const marker of NON_OPERATOR_ENV_MARKERS) {
    const value = ctx.env[marker];
    if (value !== undefined && value !== '' && value !== '0') {
      return `${marker} is set — the resident service is started by you in your own terminal, never by an agent, daemon or swarm process`;
    }
  }
  const home = ctx.env['HOME'];
  if (!ctx.passwdHome || !home || resolve(home) !== resolve(ctx.passwdHome)) {
    return 'HOME is not your login home (autonomous runs get an ephemeral HOME) — run it from your own terminal';
  }
  if ((!ctx.stdinTTY || !ctx.stdoutTTY) && ctx.nativeGesture !== true) {
    return 'not an interactive terminal — run it yourself in Terminal (or press Start in the desktop app\'s Fleet tab) so you can confirm it';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

const residentServiceBrand: unique symbol = Symbol('ashlr.resident-service-capability');

export interface ResidentServiceCapability {
  readonly kind: 'resident-service';
  readonly capabilityId: string;
  readonly grantId: string;
  readonly [residentServiceBrand]: true;
}

const liveCapabilities = new WeakMap<object, () => boolean>();

export type MintResidentServiceResult =
  | { ok: true; capability: ResidentServiceCapability; admission: ResidentAdmission }
  | { ok: false; reason: string; admission: ResidentAdmission | null };

/**
 * Mint the single-use capability `installResidentService` requires — only
 * after observing the operator context and re-verifying the admission from
 * scratch here (never from caller-supplied observations).
 */
export function mintResidentServiceCapability(opts: { nowMs?: number } = {}): MintResidentServiceResult {
  const refusal = operatorContextRefusal(currentOperatorContext());
  if (refusal) return { ok: false, reason: refusal, admission: null };
  let observed: ReturnType<typeof observeResidentAdmission>;
  try {
    observed = observeResidentAdmission(opts);
  } catch (error) {
    return { ok: false, reason: `resident admission could not be evaluated (${(error as Error).message})`, admission: null };
  }
  const { admission, evaluation } = observed;
  if (!admission.ok || !evaluation.grant) {
    return { ok: false, reason: admission.reason, admission };
  }
  // The claim below reads currentStandingPolicy(); seed it with the verdict
  // just computed so claim and mint agree (lowering still wins: the cache is
  // invalidated by Stop / a switch change on every read).
  primeStandingPolicyCache(evaluation);
  const grantId = evaluation.grant.grantId;
  const grantExpiresAtMs = Date.parse(evaluation.grant.expiresAt);
  const mintedAtMs = opts.nowMs ?? Date.now();
  const capability: ResidentServiceCapability = Object.freeze({
    kind: 'resident-service' as const,
    capabilityId: randomBytes(16).toString('hex'),
    grantId,
    [residentServiceBrand]: true as const,
  });
  liveCapabilities.set(capability, () => {
    const now = Date.now();
    if (now >= grantExpiresAtMs || now - mintedAtMs > RESIDENT_CAPABILITY_TTL_MS || now < mintedAtMs - 5_000) return false;
    if (killSwitchOn()) return false;
    return currentStandingPolicy()?.grantId === grantId;
  });
  return { ok: true, capability, admission };
}

/**
 * Consume a capability exactly once. False for anything this module did not
 * mint (a structurally identical object included), a capability already
 * claimed, or one whose grant / Stop / freshness changed since it was minted.
 */
export function claimResidentServiceCapability(value: unknown): value is ResidentServiceCapability {
  if (typeof value !== 'object' || value === null) return false;
  const check = liveCapabilities.get(value);
  if (!check) return false;
  liveCapabilities.delete(value);
  try {
    return check();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plist drift (pure)
// ---------------------------------------------------------------------------

export type ResidentPlistState = 'current' | 'drifted' | 'absent' | 'unknown';

/** PURE: compare the installed service file with the one `resident start` would write now. */
export function residentPlistState(installed: string | null | undefined, expected: string | null): ResidentPlistState {
  if (expected === null || installed === undefined) return 'unknown';
  if (installed === null) return 'absent';
  return installed === expected ? 'current' : 'drifted';
}

/** PURE: the `--budget` a generated launchd plist passes (null when absent/unparsable). */
export function plistBudgetUsd(content: string | null): number | null {
  if (!content) return null;
  const match = /<string>--budget<\/string>\s*<string>([0-9]+(?:\.[0-9]+)?)<\/string>/u.exec(content);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
