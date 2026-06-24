/**
 * confine-linux.ts — M98: Linux OS confinement launchers.
 *
 * Builds a SandboxLauncher for bwrap (bubblewrap) or firejail when one is
 * available on PATH. Called exclusively from confine.ts on process.platform
 * === 'linux'. All logic is pure (no side effects) except the PATH probe via
 * execFileSync.
 *
 * STRATEGY:
 *   1. bwrap (preferred): bind root read-only, bind worktree + TMPDIR
 *      read-write, --unshare-net when networkEgress:false.
 *   2. firejail (secondary): --noprofile + whitelist/blacklist flags for a
 *      compatible portable profile; --net=none when networkEgress:false.
 *   3. Neither present → returns null; caller handles per onUnsupported.
 *
 * CREDENTIAL STRIPPING:
 *   The env passed to the engine is already stripped by buildContainedEnv in
 *   sandboxed-engine.ts. The bwrap/firejail launcher wraps the spawn only —
 *   it does NOT re-inherit the parent process env; the contained env reaches
 *   the engine via the normal spawn env argument. These launchers add no new
 *   credential exposure.
 *
 * INVARIANT — never claim stronger confinement than the platform delivers:
 *   When this module returns null (neither bwrap nor firejail found), the
 *   caller (buildSandboxLauncher in confine.ts) MUST emit an audit event that
 *   honestly reports "no OS sandbox available; relying on worktree + cred-strip
 *   + proposal-only". That is not done here — it is the caller's responsibility.
 */

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { ConfinementProfile, ConfinementCtx, SandboxLauncher } from './confine.js';

// ---------------------------------------------------------------------------
// Internal: PATH probe
// ---------------------------------------------------------------------------

/** Returns the binary name if it is on PATH, otherwise null. */
export function findBinary(name: string): string | null {
  try {
    execFileSync('which', [name], { stdio: 'ignore', timeout: 3_000 });
    return name;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// bwrap (bubblewrap) launcher
// ---------------------------------------------------------------------------

/**
 * Build a bwrap launcher, or null if bwrap is not on PATH.
 *
 * Profile:
 *   --ro-bind / /           bind the root filesystem read-only (system access)
 *   --bind <worktree> …     bind the agent worktree read-write
 *   --bind <TMPDIR> …       bind TMPDIR read-write (agent may write temp files)
 *   --tmpfs /tmp            fresh tmpfs so /tmp writes are isolated
 *   --proc /proc            process information filesystem
 *   --dev /dev              device access (needed by many CLIs)
 *   --die-with-parent       sandbox is cleaned up when parent exits
 *   --unshare-net           (when networkEgress:false) network namespace isolation
 *   --ro-bind <extra> …     (when readAllowed) extra read-only bind mounts
 *
 * HOME credential protection: the root-bind is read-only, so $HOME is readable
 * (same as the macOS profile's "non-$HOME system paths stay readable" residual).
 * The caller's buildContainedEnv already strips git-push credential env vars.
 * The net-unshare prevents exfiltration over the network when egress is off.
 *
 * Residual (documented, same as macOS): $HOME is readable inside the bwrap
 * namespace because we ro-bind /. True HOME isolation requires a user-ns UID
 * remap that drops $HOME read access, which is a future hardening step.
 *
 * @param _finder  Optional PATH-probe override — used by tests to avoid real
 *   `which` invocations. Defaults to the module-level `findBinary`.
 */
export function buildBwrapLauncher(
  profile: ConfinementProfile,
  ctx: ConfinementCtx,
  _finder: (name: string) => string | null = findBinary,
): SandboxLauncher | null {
  const bwrap = _finder('bwrap');
  if (!bwrap) return null;

  const env = ctx.env ?? process.env;
  const tmp = env.TMPDIR ?? tmpdir();

  const args: string[] = [
    // Bind root read-only (system paths, libraries).
    '--ro-bind', '/', '/',
    // Bind worktree read-write (agent's workspace).
    '--bind', ctx.worktree, ctx.worktree,
    // Bind TMPDIR read-write (agent temp files).
    '--bind', tmp, tmp,
    // Fresh tmpfs for /tmp inside the namespace.
    '--tmpfs', '/tmp',
    // Proc + dev for process / device functionality.
    '--proc', '/proc',
    '--dev', '/dev',
    // Clean up the sandbox when the parent process exits.
    '--die-with-parent',
  ];

  if (!profile.networkEgress) {
    // Unshare the network namespace → no outbound connections.
    args.push('--unshare-net');
  }

  // Extra caller-supplied read-allowed paths: bind read-only.
  if (profile.readAllowed) {
    for (const p of profile.readAllowed) {
      if (p) args.push('--ro-bind', p, p);
    }
  }

  // Separator: everything after '--' is the engine command.
  args.push('--');

  return { bin: bwrap, prefixArgs: args };
}

// ---------------------------------------------------------------------------
// firejail launcher (secondary fallback when bwrap absent)
// ---------------------------------------------------------------------------

/**
 * Build a firejail launcher, or null if firejail is not on PATH.
 *
 * Profile:
 *   --noprofile             no system/user profile (reproducible behaviour)
 *   --whitelist=<worktree>  allow read-write access to the worktree
 *   --whitelist=<TMPDIR>    allow read-write access to TMPDIR
 *   --blacklist=<HOME>      deny access to the rest of HOME (credentials)
 *   --net=none              (when networkEgress:false) block all network
 *
 * Limitations vs. bwrap:
 *   - Requires SUID or kernel capabilities; may not be available in all
 *     container environments.
 *   - The whitelist model is less precise than bwrap's bind-mount model — some
 *     system paths remain accessible beyond what bwrap exposes.
 *   - Credential protection relies on --blacklist=<HOME> which firejail
 *     applies as a kernel seccomp/mnt-ns filter. Effectiveness varies by
 *     firejail version and kernel.
 *
 * When firejail returns a launcher, the audit summary must reflect
 * "firejail OS sandbox" so the operator knows which confinement layer is active.
 */
export function buildFirejailLauncher(
  profile: ConfinementProfile,
  ctx: ConfinementCtx,
  _finder: (name: string) => string | null = findBinary,
): SandboxLauncher | null {
  const firejail = _finder('firejail');
  if (!firejail) return null;

  const env = ctx.env ?? process.env;
  const tmp = env.TMPDIR ?? tmpdir();
  const home = ctx.home ?? env.HOME ?? env.USERPROFILE ?? '';

  const args: string[] = [
    // No system or user profile — gives deterministic confinement.
    '--noprofile',
    // Allow the worktree (read-write).
    `--whitelist=${ctx.worktree}`,
    // Allow TMPDIR (read-write).
    `--whitelist=${tmp}`,
  ];

  if (home) {
    // Deny the rest of HOME (other source trees, credentials).
    args.push(`--blacklist=${home}`);
  }

  if (!profile.networkEgress) {
    args.push('--net=none');
  }

  // Extra caller-supplied read-allowed paths.
  if (profile.readAllowed) {
    for (const p of profile.readAllowed) {
      if (p) args.push(`--whitelist=${p}`);
    }
  }

  // firejail takes the command directly (no '--' separator needed).
  return { bin: firejail, prefixArgs: args };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the best available Linux OS sandbox launcher.
 *
 * Priority: bwrap > firejail > null.
 * Returns null when neither is on PATH — caller emits fallback audit.
 *
 * @param _finder  Optional PATH-probe override — threaded through to
 *   buildBwrapLauncher and buildFirejailLauncher. Defaults to findBinary.
 */
export function buildLinuxLauncher(
  profile: ConfinementProfile,
  ctx: ConfinementCtx,
  _finder: (name: string) => string | null = findBinary,
): { launcher: SandboxLauncher; tool: 'bwrap' | 'firejail' } | null {
  const bwrapResult = buildBwrapLauncher(profile, ctx, _finder);
  if (bwrapResult) return { launcher: bwrapResult, tool: 'bwrap' };

  const firejailResult = buildFirejailLauncher(profile, ctx, _finder);
  if (firejailResult) return { launcher: firejailResult, tool: 'firejail' };

  return null;
}
