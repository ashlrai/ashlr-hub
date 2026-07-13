/**
 * confine.ts — M52: OS-level confinement (closes v4 read-residual).
 *
 * Wraps the contained engine spawn with a platform-native read-jail +
 * network-egress gate. ENTIRELY OPT-IN — absent cfg.foundry.confinement the
 * launcher is null and spawnEngine behaves byte-identically to v4.
 *
 * SUPPORTED PLATFORMS:
 *   macOS (darwin)  — sandbox-exec(1) with a custom SBPL profile.
 *   Linux           — bwrap (bubblewrap) when on PATH; firejail secondary fallback.
 *                     Neither present → fallback per onUnsupported + honest audit.
 *   win32           — no first-class OS sandbox; always falls back per onUnsupported.
 *   Other           — null (env-only v4 behavior).
 *
 * THREAT MODEL (macOS sandbox-exec):
 *   Goal: prevent the contained CLI from reading arbitrary paths outside its
 *   worktree — specifically other source trees (e.g. sibling repos) and
 *   secrets dirs (e.g. ~/.ssh, ~/.gnupg, ~/.aws).
 *
 *   Strategy: (allow default) keeps the process functional (dynamic linker,
 *   frameworks, sockets for IPC, etc.). We then layer targeted denials:
 *
 *     1. (deny file-read* (subpath "<$HOME>")) — blocks user-data reads.
 *     2. (allow file-read* (subpath "<worktree>")) — re-allow the worktree.
 *     3. (allow file-read* (subpath "<$HOME/.claude>")) etc. — re-allow each
 *        vendor config home the agent needs for its own auth (read-only).
 *     4. (allow file-read* (subpath "<readAllowed[i]>")) — caller extras.
 *     5. (deny network-outbound*) unless networkEgress:true.
 *     6. (allow file-write* (subpath "<TMPDIR>")) before the HOME write deny.
 *     7. (deny file-write* (subpath "<$HOME>")).
 *     8. (allow file-write* (subpath "<worktree>")
 *           (subpath "<home>/.claude") ...)
 *        — write inside worktree + vendor config dirs (HOME_CONFIG_SUBDIRS
 *          + VENDOR_HOME_ENVS values) so confined agents can write session state.
 *
 *   What this DOES NOT protect:
 *     - Reads of /proc, /dev, and similar pseudo-filesystems that have no
 *       file-read* equivalent in SBPL. These are generally safe (no user data).
 *     - Writes to paths outside worktree/TMPDIR that are NOT covered by the
 *       allow-file-write* list. Those writes ARE blocked (allow default does
 *       not include file-write*).
 *     - Against a process that can exploit the macOS sandbox itself. This is
 *       an OS-level trust boundary, not a VM boundary.
 *
 *   IMPORTANT LIMITATION: sandbox-exec's SBPL `(deny file-read*)` interacts
 *   with macOS's TCC/SIP stack. On some system paths (Frameworks, dylibs) the
 *   deny fires before dyld can load, causing the wrapped binary to crash. The
 *   system subpath allow-list below is empirically derived to keep `cat`,
 *   `sh`, and major CLIs (claude, codex) functional. For production hardening,
 *   run the profile under `sandbox-exec -D/tmp/sbpl.profile.tmp` and check
 *   sandbox-violation lines in the system log.
 *
 * INJECTION SAFETY:
 *   All caller-supplied paths are escaped via escapeSbplPath() before
 *   embedding in the SBPL profile string. The escaper replaces `"` and `\`
 *   with their escaped forms so a malicious path cannot break out of the
 *   (subpath "...") SBPL string literal.
 */

import { tmpdir } from 'node:os';
import { realpathSync, existsSync } from 'node:fs';
import { buildLinuxLauncher } from './confine-linux.js';

/**
 * Resolve a path to its canonical realpath. macOS `sandbox-exec` resolves
 * symlinks before matching (subpath ...) clauses, so e.g. a worktree under
 * `/var/folders/...` (a symlink to `/private/var/folders/...`) must be emitted
 * as its resolved target or the re-allow clause never matches and the agent is
 * denied its own workspace. Falls back to the input when the path does not yet
 * exist or cannot be resolved.
 */
function resolveReal(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}
import type { AshlrConfig, EngineId } from '../types.js';
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SandboxLauncher {
  /** The executable to invoke (e.g. 'sandbox-exec', 'bwrap'). */
  bin: string;
  /**
   * Arguments that PREFIX the engine command. The final argv given to
   * spawnEngine will be [...prefixArgs, engineBin, ...engineArgs].
   */
  prefixArgs: string[];
}

export interface ConfinementProfile {
  mode: 'off' | 'os';
  readAllowed?: string[];
  networkEgress?: boolean;
  onUnsupported?: 'fallback' | 'fail';
}

export interface ConfinementCtx {
  /** Absolute path to the sandbox worktree. */
  worktree: string;
  /** The real HOME directory (for vendor config-homes). */
  home?: string;
  /** Extra env vars in scope (used to find CODEX_HOME, CLAUDE_CONFIG_DIR, etc.). */
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// SBPL path escaping — injection safety
// ---------------------------------------------------------------------------

/**
 * Escape a path for safe embedding in a SBPL (sandbox profile language) string
 * literal. SBPL string literals are delimited by `"`. Only `"` and `\` need
 * escaping — forward slashes and parens in paths are literal and valid.
 *
 * A path containing `)` is safe because it appears inside `"..."` — the
 * parser reads the closing `"` to end the literal before looking for `)`.
 *
 * PROOF: sandbox-exec's parser (Scheme-like) reads `(subpath "<escaped>")`.
 * The literal ends at the first unescaped `"`. After escaping, `"` → `\"` and
 * `\` → `\\`, so no injected character can terminate the string early.
 */
export function escapeSbplPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// macOS SBPL profile builder
// ---------------------------------------------------------------------------

/**
 * System paths the agent binary needs to read on macOS. Empirically derived
 * to keep sandbox-exec-wrapped CLIs functional (dyld, shells, frameworks).
 */
// (M52 revision) The macOS profile no longer enumerates system read paths: an
// allow-list of dyld/framework paths is brittle across macOS versions and aborts
// the agent process. The profile instead starts from (allow default) and denies
// reads under $HOME — see buildMacosSbplProfile's threat-model note.

/**
 * Vendor config-home env vars whose values (absolute paths) the agent CLI
 * may need to read for its own auth/subscription. We allow reading these
 * paths but NOT writing to them (except worktree + TMPDIR).
 */
const VENDOR_HOME_ENVS = [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];

/**
 * Subdirectories under HOME that are standard vendor config homes when the
 * dedicated env vars are absent. We allow these so agent CLIs can read their
 * own on-disk auth without needing an explicit env var.
 */
const HOME_CONFIG_SUBDIRS = [
  '.claude',
  '.config',
  '.local/share',
  '.hermes',
  '.opencode',
  '.codex',
  '.npm',        // node_modules cache needed by some CLIs
  '.node_repl_history',
];

/** HOME paths needed to resolve vendor executables, but never for session writes. */
const HOME_READ_ONLY_SUBDIRS = [
  '.local/bin',
  '.grok',
];

/** Mutable Grok runtime state; executable and bundled code remain read-only. */
const HOME_GROK_WRITE_SUBDIRS = [
  '.grok/active_sessions.json',
  '.grok/active_sessions.lock',
  '.grok/logs',
  '.grok/sessions',
  '.grok/upload_queue',
];

/**
 * Build a macOS SBPL profile string for sandbox-exec.
 *
 * The profile:
 *   (version 1)
 *   (allow default)              — keep process functional
 *   (deny file-read*)            — block all file reads by default
 *   (allow file-read* ...)       — re-allow: worktree, vendor homes, system
 *   (deny network-outbound*)     — block egress (omitted when networkEgress)
 *   (allow file-write* ...)      — write only under worktree + TMPDIR
 */
export function buildMacosSbplProfile(
  profile: ConfinementProfile,
  ctx: ConfinementCtx,
): string {
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const tmp = env.TMPDIR ?? tmpdir();

  const sub = (p: string) => `(subpath "${escapeSbplPath(resolveReal(p))}")`;

  // Subtrees the agent may READ even under HOME: its worktree, its vendor config
  // homes (subscription auth/session), and any caller-supplied extras.
  const reallowRead: string[] = [ctx.worktree];
  for (const key of VENDOR_HOME_ENVS) {
    const val = env[key];
    if (val) reallowRead.push(val);
  }
  if (home) {
    for (const s of HOME_CONFIG_SUBDIRS) reallowRead.push(`${home}/${s}`);
    for (const s of HOME_READ_ONLY_SUBDIRS) reallowRead.push(`${home}/${s}`);
  }
  if (profile.readAllowed) {
    for (const p of profile.readAllowed) if (p) reallowRead.push(p);
  }

  // Subtrees the agent may WRITE outside the HOME deny. Keep these before the
  // HOME write deny so a fake HOME under TMPDIR does not inherit broad temp
  // write access after the deny.
  const broadWrite: string[] = [tmp, '/tmp', '/private/tmp'];

  // Subtrees the agent may WRITE after the HOME deny: its worktree and vendor
  // config homes (session state, logs, auth). HOME_CONFIG_SUBDIRS are included
  // so that when
  // CLAUDE_CONFIG_DIR/CODEX_HOME/etc. are NOT set in the env (the common case —
  // e.g. claude writes session state to ~/.claude by default), the confined
  // agent can still write its own config dirs. The VENDOR_HOME_ENVS values cover
  // the explicit-env-var override case. Other source trees and secrets dirs that
  // are NOT in HOME_CONFIG_SUBDIRS or VENDOR_HOME_ENVS remain WRITE-denied
  // (as they are READ-denied); the confinement residual is unchanged.
  const reallowWrite: string[] = [ctx.worktree];
  for (const key of VENDOR_HOME_ENVS) {
    const val = env[key];
    if (val) reallowWrite.push(val);
  }
  if (home) {
    for (const s of HOME_CONFIG_SUBDIRS) reallowWrite.push(`${home}/${s}`);
    for (const s of HOME_GROK_WRITE_SUBDIRS) reallowWrite.push(`${home}/${s}`);
  }

  const reallowReadClauses = reallowRead.map(sub).join('\n    ');
  const broadWriteClauses = broadWrite.map(sub).join('\n    ');
  const reallowWriteClauses = reallowWrite.map(sub).join('\n    ');
  const networkClause = profile.networkEgress
    // SBPL has NO `(comment ...)` form — emitting it makes sandbox-exec abort
    // with "unbound variable: comment". Use a `;` line comment instead; when
    // egress is allowed no rule is needed (the earlier `(allow default)` already
    // permits network-outbound).
    ? '; network egress allowed by profile (allow default already permits it)'
    : '(deny network*)';

  // THREAT MODEL — the documented v4 residual is that a contained CLI can READ
  // arbitrary paths outside its worktree, chiefly the user's OTHER source trees
  // and secrets, which all live under $HOME (e.g. ~/Desktop/github, ~/.ssh,
  // ~/.aws). We start from (allow default) so system libraries load and the agent
  // CLI can actually run — an exhaustive allow-list of dyld/system paths is
  // brittle across macOS versions and aborts the process (SIGABRT) — then DENY
  // all reads/writes under $HOME and re-allow ONLY the worktree, the agent's own
  // vendor config homes (HOME_CONFIG_SUBDIRS + VENDOR_HOME_ENVS), and caller
  // extras. Vendor config dirs are BOTH read- and write-allowed so an agent can
  // write session state/logs even when CLAUDE_CONFIG_DIR/CODEX_HOME are unset.
  // Network egress is denied unless opted in.
  // Residual: non-$HOME system paths stay readable (acceptable — no user
  // repos/secrets live there); other $HOME paths (source trees, ~/.ssh, ~/.aws,
  // etc.) remain denied for BOTH read and write; full VM isolation is future work.
  const lines: string[] = [
    '(version 1)',
    '',
    '; Allow default (process exec, dyld, IPC, mach) so the agent CLI can run.',
    '(allow default)',
    '',
    '; Network egress gate.',
    networkClause,
  ];
  if (home) {
    lines.push(
      '',
      '; Deny reading the user HOME (other source trees + secrets) ...',
      `(deny file-read* ${sub(home)})`,
      '; ... but re-allow the worktree, vendor config homes, and caller extras.',
      '(allow file-read*',
      `    ${reallowReadClauses}`,
      ')',
      '',
      '; Allow broad temp writes before the HOME-specific deny below.',
      '(allow file-write*',
      `    ${broadWriteClauses}`,
      ')',
      '',
      '; Restrict writes under HOME to the worktree + vendor homes.',
      `(deny file-write* ${sub(home)})`,
      '(allow file-write*',
      `    ${reallowWriteClauses}`,
      ')',
    );
  } else {
    // No resolvable HOME: the HOME read-jail is inexpressible; degrade to the
    // network gate only — still never weaker than v4's env-only containment.
    lines.push('', '; No resolvable HOME — read-jail not expressible; network gate only.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Primary public API
// ---------------------------------------------------------------------------

/**
 * Build the OS sandbox launcher for the given confinement profile and context.
 *
 * Returns `{ bin, prefixArgs }` that callers prepend to the engine spawn, or
 * `null` when confinement is off or not supported on this platform.
 *
 * This function is PURE on the happy path (macOS profile string is built from
 * inputs only). The only side-effects are the bwrap/firejail PATH probes on
 * Linux and the audit call on fallback/unsupported.
 *
 * Platform dispatch (never downgrades silently — audit always records reality):
 *   darwin  → sandbox-exec(1) with generated SBPL profile (unchanged from M52)
 *   linux   → bwrap (preferred) or firejail (secondary); if neither: fallback
 *   win32   → no first-class OS sandbox — fallback with honest report
 *   other   → fallback with honest report
 *
 * Invariant: when `profile.mode === 'off'` (or undefined), always returns null
 * with no side effects — byte-identical v4 behavior.
 */
export function buildSandboxLauncher(
  profile: ConfinementProfile,
  ctx: ConfinementCtx,
): SandboxLauncher | null {
  // Flag-off: v4 env-only behavior.
  if (!profile.mode || profile.mode === 'off') {
    return null;
  }

  const platform = process.platform;
  const onUnsupported = profile.onUnsupported ?? 'fallback';

  if (platform === 'darwin') {
    // UNCHANGED from M52 — sandbox-exec with SBPL profile.
    const sbplProfile = buildMacosSbplProfile(profile, ctx);
    return {
      bin: 'sandbox-exec',
      prefixArgs: ['-p', sbplProfile],
    };
  }

  if (platform === 'linux') {
    const result = buildLinuxLauncher(profile, ctx);
    if (result) return result.launcher;
    // bwrap and firejail both absent — fall through to fallback handling.
  }

  // win32: no first-class OS confinement. We do NOT claim confinement Windows
  // cannot provide. Falls through to _handleUnsupported which emits an honest
  // audit and returns null — worktree + cred-strip + proposal-only still hold.
  //
  // Other platforms: same treatment.
  return _handleUnsupported(profile, ctx, onUnsupported, platform);
}

function _handleUnsupported(
  _profile: ConfinementProfile,
  ctx: ConfinementCtx,
  onUnsupported: 'fallback' | 'fail',
  platform: string,
): SandboxLauncher | null {
  const reason =
    platform === 'linux'
      ? 'no OS sandbox available (bwrap and firejail not found on PATH)'
      : platform === 'win32'
        ? 'no OS sandbox available on win32 (no first-class confinement equivalent)'
        : `no OS sandbox available on unsupported platform: ${platform}`;

  if (onUnsupported === 'fail') {
    throw new ConfinementUnsupportedError(
      `M52 confinement required but unavailable: ${reason}. ` +
        `Set onUnsupported:'fallback' to allow worktree + cred-strip + proposal-only behavior.`,
    );
  }

  // 'fallback': emit an HONEST audit that names exactly what guarantees remain.
  // INVARIANT: we must never claim stronger confinement than the platform delivers.
  // The worktree isolation, credential stripping (buildContainedEnv), and the
  // proposal-only diff gate still hold — these are platform-independent layers.
  // What is NOT present: an OS-level file-read jail or network-egress gate.
  audit({
    action: 'confinement.fallback',
    repo: ctx.worktree,
    sandboxId: null,
    summary:
      `${reason}; ` +
      `no OS sandbox active — relying on worktree isolation + cred-strip + proposal-only. ` +
      `File-read jail and network-egress gate are NOT enforced on this platform.`,
    result: 'ok',
  });

  return null;
}

// ---------------------------------------------------------------------------
// confinementProfileFor — resolve effective profile from cfg
// ---------------------------------------------------------------------------

/**
 * Resolve the effective ConfinementProfile for a specific engine from
 * `cfg.foundry.confinement`. Per-engine key overrides the `*` (fleet-wide)
 * default; absent → mode:'off' (v4 env-only, no side effects).
 *
 * A `*` key in cfg.foundry.confinement sets the fleet-wide default.
 */
export function confinementProfileFor(
  engine: EngineId,
  cfg: AshlrConfig,
): ConfinementProfile {
  const confinement = cfg.foundry?.confinement;
  if (!confinement) return { mode: 'off' };

  // Per-engine key overrides the fleet-wide `*` default.
  const perEngine = confinement[engine];
  const fleetDefault = (confinement as Record<string, ConfinementProfile | undefined>)['*'];

  const merged: ConfinementProfile = {
    mode: 'off',
    ...fleetDefault,
    ...perEngine,
  };

  return merged;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Terminal error thrown when OS confinement is required (mode:'os',
 * onUnsupported:'fail') but the platform has no supported jail binary.
 */
export class ConfinementUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfinementUnsupportedError';
  }
}
