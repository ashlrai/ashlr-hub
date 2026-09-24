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
 *
 * V3.10 — FORCED AUTONOMOUS CONFINEMENT (SPEC-310B §1, unit U2):
 *   While a standing policy is live, confinementProfileFor() ignores config
 *   and returns autonomousConfinementProfile(engine): mode 'os', fail when
 *   unsupported, network egress only for frontier CLI engines. Its profile
 *   (buildAutonomousSbplProfile) keeps `(allow default)` so CLIs run, and adds,
 *   each verified on this macOS with real sandbox-exec runs:
 *     - reads: the whole HOME, /Users, /Volumes, /private/tmp, /private/var/tmp
 *       and the per-user temp dir are denied; only the worktree, the run's
 *       private dir (ephemeral homes), named executables/toolchains and the
 *       worktree's own git dir (read-only) come back, plus metadata of their
 *       ancestors so realpath() works;
 *     - writes: denied everywhere except the worktree (never its `.git`
 *       entry), the run dir and a few devices — real vendor homes, shell rc
 *       files, ~/Library/LaunchAgents and Homebrew bins are all unwritable;
 *     - Keychain / Secure Enclave / Touch ID / pasteboard mach services,
 *       LaunchServices opens, AppleEvents, launchd job creation, preference
 *       writes (cfprefsd) and authorization rights are denied, as is exec of
 *       security, launchctl, open, osascript and the custody helper;
 *       setuid binaries (sudo, crontab, at, su) never exec inside a sandbox;
 *     - signals and process inspection only within the sandbox;
 *     - network: `local` engines reach loopback model ports only; egress
 *       engines reach the internet (DNS via mDNSResponder) but no loopback
 *       service and no unix socket outside the run dir; no TCP listening;
 *     - tripwires: reading the custody dir, ~/.ashlr/{authority,activation,
 *       foundry}, ~/Library/Keychains or the helper kills the reader (SIGKILL),
 *       so a probe is loud (see sandboxViolationsInOutput / isSandboxTripwireKill).
 *   The rules above are emitted LAST where they must win (SBPL is last-match).
 */

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  realpathSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildLinuxLauncher } from './confine-linux.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { CUSTODY_DATA_DIR_RELATIVE, CUSTODY_HELPER_PATH } from '../authority/custody-client.js';
import {
  autonomousEngineClass,
  buildAutonomousEnvOverlay,
  type AutonomousEngineClass,
  type AutonomousEnvOverlay,
} from './autonomous-env.js';

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
  /**
   * V3.10: the hardened profile forced while a standing policy is live
   * (autonomousConfinementProfile). Requires ConfinementCtx.overlay; ignores
   * `readAllowed` (config may only tighten autonomous confinement).
   */
  autonomous?: boolean;
  /** V3.10 autonomous only: loopback TCP ports the child may connect to (local model servers). */
  loopbackPorts?: readonly number[];
  /**
   * V3.10 autonomous only — for VERIFICATION runs (G3), not agents: let the
   * child bind, accept and connect on loopback, because repo test suites start
   * their own servers. Residual (why agents never get it): anything listening
   * on loopback (the Verse API, Ollama's admin endpoints) becomes reachable to
   * the verified code. Use only with networkEgress false.
   */
  loopbackServers?: boolean;
}

export interface ConfinementCtx {
  /** Absolute path to the sandbox worktree. */
  worktree: string;
  /** The real HOME directory (for vendor config-homes). */
  home?: string;
  /** Extra env vars in scope (used to find CODEX_HOME, CLAUDE_CONFIG_DIR, etc.). */
  env?: NodeJS.ProcessEnv;
  /** V3.10 autonomous runs: the run's overlay from buildAutonomousEnvOverlay (required when profile.autonomous). */
  overlay?: AutonomousEnvOverlay;
  /**
   * V3.10 (INT4) legacy / config-opt-in profile only: a native-profile SEAT the
   * engine launches through (`node launcher.mjs` → pinned binary with the
   * seat's vendor home). Build it with nativeSeatConfinement(). Ignored by the
   * autonomous profile, which never runs the launcher (it execs the pinned
   * binary directly with a per-run copy of the vendor home — autonomous-env).
   */
  nativeSeat?: NativeSeatConfinement;
  /**
   * V3.10 (review d0) autonomous only: the run's kernel-evidence tag
   * (kernel-evidence.ts newViolationTag). Every VIOLATION deny rule then
   * carries `(with message "<tag>")`, so the kernel logs each such denial —
   * by the engine or any descendant — attributably to this run, whatever the
   * agent prints. Absent ⇒ the rules are unchanged (no kernel evidence).
   */
  violationTag?: string;
}

/** What the M52 profile must add for one native-profile seat launch. */
export interface NativeSeatConfinement {
  /** Read-only subtrees / files: the profile dir (launcher.mjs, profile.json, the vendor home) and the pinned binary. */
  readPaths: string[];
  /** Ancestors whose METADATA the launcher needs (it realpath()s and lstat()s its recorded directories). */
  metadataPaths: string[];
  /** Writable subtrees inside the vendor home (measured runtime state only). */
  writeSubpaths: string[];
  /** SBPL regex for writable top-level files of the vendor home (locks, caches, temp siblings). */
  writeRegex: string | null;
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
  'GROK_HOME',
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

/**
 * Grok SEAT runtime state (V3.10 INT4, B-U7 request to U2) — what grok writes
 * under a native profile's GROK_HOME (`<profile>/native-state`).
 *
 * MEASURED, not guessed (2026-09-24, grok 0.2.118, grok-a): every entry whose
 * mtime moved after the seat's config.toml was written — i.e. what real
 * seat sessions changed — was: active_sessions.json/.lock, auth.json and
 * auth.json.lock (token refresh), models_cache.json, worktrees.db, sessions/
 * (incl. session_search.sqlite), logs/ (incl. MCP stderr logs), memtrace/,
 * upload_queue/ and relocations/ (lock files); first-run init also wrote
 * bundled/, vendor/ (a ripgrep binary grok EXECUTES), docs/, README.md and
 * .metadata_version. The binary's own strings add the siblings it writes
 * through: `*.tmp.*` temp files it renames into place, managed_config.toml /
 * managed_config.lock, .config-init.lock, leader.lock.sock (its leader
 * socket) and sqlite's -journal/-wal/-shm next to worktrees.db. (Running grok
 * to trace writes was not permitted here; the mtimes are the measurement.)
 *
 * WRITABLE = the runtime set. READ-ONLY on purpose: config.toml and agent_id
 * (identity/config Mason's own sessions load), bundled/ and vendor/ (code a
 * later session executes — writable, an agent could plant a binary there),
 * docs/, README.md, .metadata_version. Grok fails a write to those loudly and
 * carries on (its import-marker and managed-config writers log and retry).
 * A temp file can be created next to config.toml but never renamed over it:
 * rename needs write on the target.
 */
export const GROK_SEAT_WRITABLE_DIRS: readonly string[] = Object.freeze([
  'sessions',
  'logs',
  'memtrace',
  'upload_queue',
  'relocations',
]);

/** Top-level GROK_HOME files grok writes (anchored by nativeSeatConfinement). */
export const GROK_SEAT_WRITABLE_FILE_PATTERN =
  '(auth\\.json|auth\\.json\\.lock|active_sessions\\.json|active_sessions\\.lock|models_cache\\.json|' +
  'worktrees\\.db|worktrees\\.db-journal|worktrees\\.db-wal|worktrees\\.db-shm|managed_config\\.toml|managed_config\\.lock|' +
  '\\.config-init\\.lock|leader\\.lock|leader\\.lock\\.sock|[^/]*\\.tmp[^/]*)';

/** Escape a literal path for an SBPL `#"…"` regex. Refuses a `"` (it would end the literal). */
function sbplRegexLiteral(p: string): string {
  if (p.includes('"')) throw new ConfinementUnsupportedError('a path with a double quote cannot be expressed in the sandbox profile');
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The legacy-profile additions for a native-profile seat launch (grok-cli
 * through `node launcher.mjs`). `launch` is resolveNativeSeatLaunch()'s
 * result; `home` bounds the metadata ancestors. Pure apart from realpath.
 */
export function nativeSeatConfinement(
  launch: { command: readonly [string, string]; nativeStatePath: string; executable: string; provider?: string },
  home: string,
): NativeSeatConfinement {
  const profileDir = resolveReal(dirname(launch.command[1]));
  const state = resolveReal(launch.nativeStatePath);
  const homeReal = resolveReal(home);
  const metadataPaths: string[] = [];
  for (const dir of [profileDir, state]) {
    for (let a = dirname(dir); a !== dirname(a); a = dirname(a)) {
      if (!metadataPaths.includes(a)) metadataPaths.push(a);
      if (a === homeReal) break;
    }
  }
  const grok = (launch.provider ?? 'grok') === 'grok';
  return {
    readPaths: [profileDir, resolveReal(launch.executable), resolveReal(launch.command[0])],
    metadataPaths,
    writeSubpaths: grok ? GROK_SEAT_WRITABLE_DIRS.map((d) => join(state, d)) : [],
    writeRegex: grok ? `^${sbplRegexLiteral(state)}/${GROK_SEAT_WRITABLE_FILE_PATTERN}$` : null,
  };
}

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

  // V3.10 (INT4): a native-profile seat launch (grok-cli) — the launcher chain
  // needs its profile dir and pinned binary readable, and grok its measured
  // runtime state writable (GROK_SEAT_WRITABLE_*). Nothing else of the seat.
  const seat = ctx.nativeSeat;
  if (seat) {
    for (const p of seat.readPaths) if (p) reallowRead.push(p);
    for (const p of seat.writeSubpaths) if (p) reallowWrite.push(p);
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
    if (seat && seat.metadataPaths.length > 0) {
      lines.push(
        '; Native-profile seat: the launcher realpath()s its recorded directories.',
        `(allow file-read-metadata ${seat.metadataPaths.map((p) => `(literal "${escapeSbplPath(p)}")`).join(' ')})`,
      );
    }
    if (seat?.writeRegex) {
      lines.push(
        '; Native-profile seat: measured top-level runtime files only (config.toml, agent_id, bundled/, vendor/ stay read-only).',
        `(allow file-write* (regex #"${seat.writeRegex}"))`,
      );
    }
  } else {
    // No resolvable HOME: the HOME read-jail is inexpressible; degrade to the
    // network gate only — still never weaker than v4's env-only containment.
    lines.push('', '; No resolvable HOME — read-jail not expressible; network gate only.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// V3.10 autonomous profile (forced while a standing policy is live)
// ---------------------------------------------------------------------------

/** Absolute, SIP-protected — never resolved through an agent-influenced PATH. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/** Ollama and llama-server defaults: the only loopback services a `local` engine may reach. */
export const AUTONOMOUS_DEFAULT_LOOPBACK_PORTS: readonly number[] = Object.freeze([11434, 8080]);

/**
 * Mach services an autonomous process may never look up: the Keychain
 * (securityd, secd), SecurityAgent UI, CryptoTokenKit (Secure Enclave keys),
 * Touch ID / LocalAuthentication (so an agent cannot even put up a Touch ID
 * prompt to phish Mason), LaunchServices, AppleEvents and the pasteboard.
 * Verified: Keychain queries fail (-50 instead of reaching securityd), SE key
 * creation fails with "Sandbox restriction", LAContext cannot evaluate.
 * TLS still works — trust evaluation goes through trustd, which stays allowed.
 */
export const AUTONOMOUS_DENIED_MACH_SERVICES: readonly string[] = Object.freeze([
  'com.apple.SecurityServer',
  'com.apple.security.agent',
  'com.apple.security.keychaind',
  'com.apple.secd',
  'com.apple.coreservices.launchservicesd',
  'com.apple.coreservices.appleevents',
  'com.apple.pasteboard.1',
]);

/** Regex families of the same (securityd.xpc et al., ctkd.*, CoreAuthentication.* / LocalAuthentication.*). */
export const AUTONOMOUS_DENIED_MACH_SERVICE_PATTERNS: readonly string[] = Object.freeze([
  '^com\\.apple\\.securityd',
  '^com\\.apple\\.ctkd\\.',
  '^com\\.apple\\.(CoreAuthentication|LocalAuthentication)\\.',
]);

/**
 * Executables denied by path (defense in depth: the mach and operation
 * denials below stop the same escapes from any copy or re-implementation —
 * and copied Apple binaries are killed by the OS anyway).
 */
export const AUTONOMOUS_DENIED_EXECUTABLES: readonly string[] = Object.freeze([
  '/usr/bin/security',
  '/bin/launchctl',
  '/usr/bin/open',
  '/usr/bin/osascript',
  '/usr/bin/osacompile',
  '/usr/bin/shortcuts',
  '/usr/bin/automator',
  '/usr/bin/pbcopy',
  '/usr/bin/pbpaste',
  '/usr/bin/tccutil',
  '/usr/sbin/screencapture',
  CUSTODY_HELPER_PATH,
]);

/** SBPL operations denied outright (each blocks a way to start or steer code outside the sandbox). */
export const AUTONOMOUS_DENIED_OPERATIONS: readonly string[] = Object.freeze([
  'job-creation',            // launchd jobs (launchctl submit, SMJobSubmit)
  'lsopen',                  // LaunchServices opens (open -a Terminal, NSWorkspace)
  'appleevent-send',         // AppleEvents (Terminal "do script", System Events)
  'user-preference-write',   // cfprefsd writes, e.g. a Terminal startup command
  'authorization-right-obtain',
  'distributed-notification-post',
]);

/**
 * HOME-relative paths whose mere READ attempt marks a violation: reading one
 * kills the reader (SIGKILL). Nothing legitimate ever reads them.
 */
export const AUTONOMOUS_TRIPWIRE_HOME_PATHS: readonly string[] = Object.freeze([
  CUSTODY_DATA_DIR_RELATIVE,
  '.ashlr/authority',
  '.ashlr/activation',
  '.ashlr/foundry',
  'Library/Keychains',
]);

/** The profile forced for `engine` while a standing policy is live (config is ignored). */
export function autonomousConfinementProfile(engine: string): ConfinementProfile {
  const engineClass = autonomousEngineClass(engine);
  return {
    mode: 'os',
    onUnsupported: 'fail',
    networkEgress: engineClass !== 'local',
    autonomous: true,
    loopbackPorts: engineClass === 'local' ? [...AUTONOMOUS_DEFAULT_LOOPBACK_PORTS] : [],
  };
}

/**
 * The profile for running a repo's verification (G3) on agent-authored code
 * while a standing policy is live: the same hardening as an agent run, no
 * network egress, but the test suite may serve and connect on loopback.
 * Pair it with an overlay built for engine `local` (no vendor state).
 */
export function autonomousVerificationProfile(): ConfinementProfile {
  return { mode: 'os', onUnsupported: 'fail', networkEgress: false, autonomous: true, loopbackPorts: [], loopbackServers: true };
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every proper ancestor of `p` ('/' excluded), nearest last. */
function ancestorsOf(p: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(p); dir !== dirname(dir); dir = dirname(dir)) out.unshift(dir);
  return out;
}

/**
 * The linked worktree's git dir and common dir, read from its `.git` file
 * BEFORE the agent starts (the profile makes that file unwritable, so what the
 * agent's own read-only `git status` sees is what the daemon created). Empty
 * when `.git` is absent or a directory (then it lives in the worktree).
 */
function worktreeGitDirs(worktree: string): string[] {
  const dotGit = join(worktree, '.git');
  try {
    const stat = lstatSync(dotGit);
    if (!stat.isFile() || stat.size > 4096) return [];
    const match = /^gitdir: (.+)\n?$/.exec(readFileSync(dotGit, 'utf8'));
    if (!match) return [];
    const gitDir = realpathSync(resolve(worktree, match[1]!));
    const out = [gitDir];
    const commonFile = join(gitDir, 'commondir');
    if (existsSync(commonFile)) {
      const common = realpathSync(resolve(gitDir, readFileSync(commonFile, 'utf8').trim()));
      if (!isInsidePath(gitDir, common)) out.push(common);
      else out.splice(0, 1, common);
    }
    return out;
  } catch {
    return [];
  }
}

/** The per-user temp dir (…/T under /private/var/folders), or null when TMPDIR points elsewhere. */
function darwinUserTempDir(): string | null {
  try {
    const t = realpathSync(tmpdir());
    return t.startsWith('/private/var/folders/') ? t : null;
  } catch {
    return null;
  }
}

function sbplString(value: string): string {
  return `"${escapeSbplPath(value)}"`;
}

/**
 * The hardened SBPL profile for one autonomous run. Pure apart from reading
 * the worktree's `.git` file and resolving real paths. Throws
 * ConfinementUnsupportedError when the run cannot be confined as specified.
 */
export function buildAutonomousSbplProfile(profile: ConfinementProfile, ctx: ConfinementCtx): string {
  const overlay = ctx.overlay;
  if (!overlay) {
    throw new ConfinementUnsupportedError(
      'autonomous confinement needs the run overlay from buildAutonomousEnvOverlay (ephemeral homes and denied paths)',
    );
  }
  const homeRaw = ctx.home ?? ctx.env?.HOME ?? process.env.HOME;
  if (!homeRaw || !isAbsolute(homeRaw)) throw new ConfinementUnsupportedError('autonomous confinement needs the real HOME');
  const home = resolveReal(homeRaw);
  const worktree = resolveReal(ctx.worktree);
  if (!isAbsolute(worktree) || !existsSync(worktree)) {
    throw new ConfinementUnsupportedError('autonomous confinement needs an existing worktree');
  }
  if (isInsidePath(home, worktree)) throw new ConfinementUnsupportedError('the worktree must not contain the home directory');

  const denied = overlay.deniedReadPaths.map((p) => resolveReal(p));
  for (const p of [worktree, ...overlay.writablePaths.map((w) => resolveReal(w))]) {
    // Neither inside a protected directory nor containing one: a writable
    // ancestor of ~/.ashlr/authority would make the denial meaningless.
    if (denied.some((d) => isInsidePath(p, d) || isInsidePath(d, p))) {
      throw new ConfinementUnsupportedError(`${p} overlaps a protected directory`);
    }
  }

  const writable = [worktree, ...overlay.writablePaths.map((p) => resolveReal(p))];
  const readOnly = overlay.readOnlyPaths.map((p) => resolveReal(p));
  const gitDirs = worktreeGitDirs(worktree).filter((d) => !denied.some((x) => isInsidePath(d, x)) && !isInsidePath(home, d));
  const reallowRead = [...writable, ...readOnly, ...gitDirs];
  const ancestors = new Set<string>();
  for (const p of reallowRead) for (const a of ancestorsOf(p)) ancestors.add(a);

  const run = resolveReal(overlay.writablePaths[0] ?? worktree);
  const sub = (p: string): string => `(subpath ${sbplString(p)})`;
  const lit = (p: string): string => `(literal ${sbplString(p)})`;
  const readPath = (p: string): string => {
    try {
      return lstatSync(p).isDirectory() ? sub(p) : lit(p);
    } catch {
      return sub(p);
    }
  };

  const ports = [...(profile.loopbackPorts ?? [])];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfinementUnsupportedError(`invalid loopback port ${String(port)}`);
    }
  }

  const lines: string[] = [
    '(version 1)',
    '; ashlr V3.10 autonomous profile — generated by sandbox/confine.ts (buildAutonomousSbplProfile).',
    '(allow default)',
    '',
    '; --- network',
  ];
  if (profile.networkEgress) {
    lines.push(
      '(deny network-outbound (remote ip "localhost:*"))',
      '(deny network-outbound (remote unix-socket))',
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    );
  } else {
    lines.push('(deny network*)');
  }
  for (const port of ports) lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
  lines.push(
    `(allow network-outbound (remote unix-socket ${sub(run)}))`,
    '(deny network-bind)',
    `(allow network-bind (local unix-socket ${sub(run)}))`,
  );
  if (profile.loopbackServers) {
    if (profile.networkEgress) {
      throw new ConfinementUnsupportedError('loopbackServers is for verification runs without network egress');
    }
    lines.push(
      '; verification run: test suites may serve and connect on loopback',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    );
  }
  lines.push(
    '',
    '; --- other processes: no signals, no inspection outside this sandbox',
    '(deny signal)',
    '(allow signal (target self))',
    '(allow signal (target same-sandbox))',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(allow process-info* (target same-sandbox))',
    '',
    '; --- reads: jail HOME and every shared or foreign area, then re-allow what the run needs',
  );
  // Other processes' temp files (including other runs' ephemeral homes) live
  // in the per-user temp dir and /private/tmp; the run's own dir is
  // re-allowed right after (last match wins).
  const readJail = [home, '/Users', '/Volumes', '/private/tmp', '/private/var/tmp'];
  const userTemp = darwinUserTempDir();
  if (userTemp) readJail.push(userTemp);
  lines.push(`(deny file-read* ${readJail.map(sub).join(' ')})`);
  lines.push(`(allow file-read* ${reallowRead.map(readPath).join(' ')})`);
  if (ancestors.size > 0) {
    lines.push(`(allow file-read-metadata ${[...ancestors].sort().map(lit).join(' ')})`);
  }
  lines.push(
    '',
    '; --- writes: only the worktree (never its .git entry), the run dir and devices',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(sub).join(' ')})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")' +
      ' (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/stdout") (literal "/dev/stderr")' +
      ' (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))',
    `(deny file-write* ${lit(join(worktree, '.git'))} ${sub(join(worktree, '.git'))})`,
    '',
    '; --- protected paths (last, so nothing above can re-allow them)',
  );
  const tripwires = AUTONOMOUS_TRIPWIRE_HOME_PATHS.map((rel) => join(home, rel));
  const quietDenied = denied.filter((p) => !tripwires.includes(p) && p !== CUSTODY_HELPER_PATH);
  // d0: the kernel logs a denial whose rule carries a message, so tagging the
  // VIOLATION rules (and only those — the quiet ones stay quiet, or innocent
  // tool probes would regress the rollout) makes the kernel, not the agent's
  // own output, the evidence. Hex-only tag, validated before it reaches SBPL.
  const report = ctx.violationTag !== undefined && /^ashlr-sbx-[0-9a-f]{32}$/.test(ctx.violationTag)
    ? ` (with message ${sbplString(ctx.violationTag)})`
    : '';
  if (quietDenied.length > 0) lines.push(`(deny file-read* file-write* ${quietDenied.map(sub).join(' ')})`);
  lines.push(`(deny file-read* file-write* (with send-signal SIGKILL)${report} ${tripwires.map(sub).join(' ')})`);
  // The helper sits in a world-readable system dir: a `find /usr/local` may
  // stat it innocently, so only reading its bytes (to copy it) or writing it
  // trips; exec is denied separately below.
  lines.push(`(deny file-read-data file-write* (with send-signal SIGKILL)${report} ${lit(CUSTODY_HELPER_PATH)})`);
  // Escape tools are a violation to attempt; the rest (open, pbcopy…) are
  // denied quietly, exactly the split sandboxViolationsInOutput always used.
  const violationExecs = AUTONOMOUS_DENIED_EXECUTABLES.filter((exe) => VIOLATION_EXECUTABLES.includes(exe));
  const quietExecs = AUTONOMOUS_DENIED_EXECUTABLES.filter((exe) => !VIOLATION_EXECUTABLES.includes(exe));
  if (quietExecs.length > 0) lines.push(`(deny process-exec ${quietExecs.map(lit).join(' ')})`);
  if (violationExecs.length > 0) lines.push(`(deny process-exec${report} ${violationExecs.map(lit).join(' ')})`);
  lines.push(
    `(deny mach-lookup ${AUTONOMOUS_DENIED_MACH_SERVICES.map((n) => `(global-name ${sbplString(n)})`).join(' ')} ` +
      `${AUTONOMOUS_DENIED_MACH_SERVICE_PATTERNS.map((r) => `(global-name-regex #"${r}")`).join(' ')})`,
  );
  for (const op of AUTONOMOUS_DENIED_OPERATIONS) lines.push(`(deny ${op})`);
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

  // V3.10: an autonomous run is confined by the hardened profile or not at
  // all — "no confinement means no grant and no ticks" — so there is no
  // fallback, whatever onUnsupported says.
  if (profile.autonomous) {
    if (platform !== 'darwin') {
      throw new ConfinementUnsupportedError(
        `autonomous confinement needs macOS sandbox-exec; ${platform} has no equivalent profile`,
      );
    }
    return { bin: SANDBOX_EXEC_PATH, prefixArgs: ['-p', buildAutonomousSbplProfile(profile, ctx)] };
  }

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
 * Is a standing policy in force? WHY here and not in config: an agent-
 * writable config file must never be able to switch confinement off while
 * autonomy is live. When the answer cannot be determined, confine.
 */
function standingPolicyLive(): boolean {
  try {
    return currentStandingPolicy() !== null;
  } catch {
    return true;
  }
}

/**
 * Resolve the effective ConfinementProfile for a specific engine from
 * `cfg.foundry.confinement`. Per-engine key overrides the `*` (fleet-wide)
 * default; absent → mode:'off' (v4 env-only, no side effects).
 *
 * A `*` key in cfg.foundry.confinement sets the fleet-wide default.
 *
 * V3.10: while a standing policy is live the config is IGNORED and the forced
 * autonomous profile is returned (autonomousConfinementProfile).
 */
export function confinementProfileFor(
  engine: EngineId,
  cfg: AshlrConfig,
): ConfinementProfile {
  if (standingPolicyLive()) return autonomousConfinementProfile(engine);
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
// V3.10: is autonomous confinement actually working here? (self-probe)
// ---------------------------------------------------------------------------

export type AutonomousConfinementProbe =
  | { ok: true; checkedAt: string }
  | { ok: false; reason: string; checkedAt: string };

const PROBE_CACHE_MS = 10 * 60_000;
let probeCache: { at: number; result: AutonomousConfinementProbe } | null = null;

/**
 * "No confinement means no grant and no ticks" — proven, not assumed: build
 * the real autonomous profile for a throwaway fake home and run it under
 * sandbox-exec. It must (1) be accepted by this macOS, (2) let the worktree
 * be written, (3) kill a read of a tripwire in ~/.ashlr/authority and (4)
 * refuse a write elsewhere in HOME. Synchronous (~50 ms) and cached for 10
 * minutes; call it where a tick or a grant decision is made, not per request.
 */
export function probeAutonomousConfinement(options: { force?: boolean } = {}): AutonomousConfinementProbe {
  const now = Date.now();
  if (!options.force && probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.result;
  const checkedAt = new Date(now).toISOString();
  const result = runConfinementProbe(checkedAt);
  probeCache = { at: now, result };
  return result;
}

function runConfinementProbe(checkedAt: string): AutonomousConfinementProbe {
  const fail = (reason: string): AutonomousConfinementProbe => ({ ok: false, reason, checkedAt });
  if (process.platform !== 'darwin') return fail(`autonomous confinement needs macOS; this is ${process.platform}`);
  if (!existsSync(SANDBOX_EXEC_PATH)) return fail(`${SANDBOX_EXEC_PATH} is missing`);
  let root: string | null = null;
  try {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-confine-probe-')));
    const home = join(root, 'home');
    const worktree = join(home, '.ashlr', 'sandboxes', 'probe');
    const run = join(root, 'run');
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true, mode: 0o700 });
    mkdirSync(run, { mode: 0o700 });
    const tripwire = join(home, '.ashlr', 'authority', 'probe.json');
    writeFileSync(tripwire, '{"probe":true}\n', { mode: 0o600 });
    const outside = join(home, 'planted.txt');
    const overlay = buildAutonomousEnvOverlay({ engine: 'local', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
    const profile = buildAutonomousSbplProfile(autonomousConfinementProfile('local'), { worktree, home, overlay });
    const script = [
      'echo ok > "$W/probe-write" || exit 10',
      'if /bin/cat "$T" >/dev/null 2>&1; then exit 11; fi',
      'if echo planted > "$O" 2>/dev/null; then exit 12; fi',
      'exit 0',
    ].join('\n');
    const child = spawnSync(SANDBOX_EXEC_PATH, ['-p', profile, '/bin/sh', '-c', script], {
      env: { PATH: '/usr/bin:/bin', W: worktree, T: tripwire, O: outside },
      timeout: 10_000,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    if (child.error) return fail(`sandbox-exec could not run: ${child.error.message}`);
    if (child.status === 11) return fail('a confined process could read a protected authority file');
    if (child.status === 12) return fail('a confined process could write outside its worktree');
    if (child.status === 10) return fail('a confined process could not write its own worktree');
    if (child.status !== 0) {
      const detail = (child.stderr ?? '').split('\n').find((l) => l.trim()) ?? `exit ${String(child.status ?? child.signal)}`;
      return fail(`this macOS rejected the autonomous profile (${detail.slice(0, 200)})`);
    }
    if (!existsSync(join(worktree, 'probe-write')) || existsSync(outside)) {
      return fail('the probe did not observe the expected confinement');
    }
    return { ok: true, checkedAt };
  } catch (error) {
    return fail(`confinement probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
    }
  }
}

/** TEST SEAM: forget the cached probe result. */
export function _resetConfinementProbeForTest(): void {
  probeCache = null;
}

// ---------------------------------------------------------------------------
// V3.10: recognizing a violation (for `sandbox:violation` ledger rows)
// ---------------------------------------------------------------------------

/** Absolute tripwire targets for `home` (reading any of them kills the reader). */
export function autonomousTripwirePaths(home: string): string[] {
  return [...AUTONOMOUS_TRIPWIRE_HOME_PATHS.map((rel) => join(home, rel)), CUSTODY_HELPER_PATH];
}

/** Escape tools whose exec attempt is itself a violation (`open`, pbcopy… are denied quietly). */
const VIOLATION_EXECUTABLES = [
  '/usr/bin/security',
  '/bin/launchctl',
  '/usr/bin/osascript',
  '/usr/bin/osacompile',
  '/usr/bin/shortcuts',
  '/usr/bin/automator',
  '/usr/bin/tccutil',
  CUSTODY_HELPER_PATH,
];

const DENIAL_MARKER = /Operation not permitted|Killed: 9|\bKilled\b|EPERM|execvp\(\) of|sandbox/i;

/**
 * Best-effort scan of an autonomous run's output (tool results, stderr) for
 * attempts on protected paths or escape tools, e.g.
 * `cat: /Users/m/.ashlr/authority/ledger.jsonl: Operation not permitted`.
 * Returns unique operation strings with the home shown as `~`, ready for a
 * SandboxViolationRecord. WHY best-effort is still worth it: macOS does not
 * report sandbox-exec denials to unprivileged log readers, so this output and
 * isSandboxTripwireKill() are the daemon's only signals. An adversarial agent
 * can hide its own output — the DENIAL (and the SIGKILL) is the protection;
 * this is the evidence the rollout regresses on.
 */
export function sandboxViolationsInOutput(output: string, home: string): string[] {
  const found = new Set<string>();
  const tilde = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const targets = autonomousTripwirePaths(home).map((abs) => ({ abs, short: tilde(abs), kind: 'access' as const }));
  const text = output.length > 4 * 1024 * 1024 ? output.slice(-4 * 1024 * 1024) : output;
  for (const line of text.split('\n')) {
    if (!DENIAL_MARKER.test(line)) continue;
    for (const t of targets) {
      if (line.includes(t.abs) || line.includes(t.short)) found.add(`access ${t.short}`);
    }
    for (const exe of VIOLATION_EXECUTABLES) {
      if (line.includes(exe)) found.add(`exec ${exe}`);
    }
  }
  return [...found].sort();
}

/**
 * d0: the violation operations the KERNEL reported for a run (the source of
 * truth — kernel-evidence.ts), in the same `access ~/…` / `exec /…` form as
 * sandboxViolationsInOutput so the two signals deduplicate. Only rules tagged
 * with the run's violation tag are ever reported, so every denial here is a
 * violation; an unrecognised target is still reported (never dropped).
 */
export function sandboxViolationsFromKernel(
  denials: readonly { operation: string; target: string; process: string }[],
  home: string,
): string[] {
  const found = new Set<string>();
  const tilde = (p: string): string => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const targets = autonomousTripwirePaths(home);
  for (const denial of denials) {
    const target = denial.target.trim();
    if (denial.operation.startsWith('process-exec')) {
      found.add(`exec ${target || denial.process}`.slice(0, 300));
      continue;
    }
    const root = targets.find((t) => target === t || target.startsWith(`${t}/`));
    found.add((root ? `access ${tilde(root)}` : `${denial.operation} ${tilde(target)}`).slice(0, 300));
  }
  return [...found].sort();
}

/**
 * An autonomous engine process that died of SIGKILL the daemon did not send
 * was killed by a tripwire rule (a direct read of a protected path by the
 * engine itself). Timeouts, Stop and drains are daemon-sent and excluded.
 */
export function isSandboxTripwireKill(exit: { signal: string | null; killedByDaemon: boolean }): boolean {
  return exit.signal === 'SIGKILL' && !exit.killedByDaemon;
}

/** The confinement class of `engine` (re-exported for callers that only import confine.ts). */
export function confinementEngineClass(engine: string): AutonomousEngineClass {
  return autonomousEngineClass(engine);
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
