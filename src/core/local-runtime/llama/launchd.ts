/**
 * The launch agent — what makes "24/7" true rather than aspirational.
 *
 * A supervised process that dies with its terminal is not a service. launchd
 * is macOS's answer: `RunAtLoad` starts the runtime at login and `KeepAlive`
 * restarts it if it crashes or is killed, without anything of ours having to
 * be running to notice.
 *
 * ## This writes OUTSIDE the repository
 *
 * The plist lands in `~/Library/LaunchAgents/`, which is the machine's login
 * configuration, not project state. That is a different kind of change from
 * anything else this codebase does, so:
 *
 *   * it happens ONLY behind an explicit `--install` flag, never as a side
 *     effect of `start`;
 *   * the absolute plist path is printed to the operator every time; and
 *   * `local-runtime uninstall` removes it completely, so the change is
 *     reversible by the same tool that made it.
 *
 * It is also refused while `~/.ashlr/KILL` is engaged. Installing a job that
 * brings a serving runtime up at every login is exactly the standing
 * authority that switch exists to withhold; the caller performs that check
 * (see src/cli/local-runtime.ts) and this module never reads, creates or
 * removes the sentinel itself.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  launchAgentShimPath,
  localRuntimeDir,
  logsDir,
  stderrLogPath,
  stdoutLogPath,
} from './paths.js';

/** Escape a string for an XML text node. Paths may legitimately contain `&`. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Everything the plist needs. Kept explicit so generation stays pure. */
export interface LaunchAgentSpec {
  /** Absolute llama-server path. */
  binPath: string;
  /** argv after argv[0]. */
  args: string[];
  stdoutLog: string;
  stderrLog: string;
  /** Working directory for the job. */
  workingDirectory: string;
  /**
   * The Ollama model reference the `-m` blob path was resolved FROM, when it
   * was. Null when the operator supplied an explicit `modelPath` — that path is
   * their own choice and must never be second-guessed at launch.
   */
  modelRef?: string | null;
  /**
   * argv of a command that prints the current absolute blob path for
   * {@link LaunchAgentSpec.modelRef} on stdout and exits 0, e.g.
   * `['/usr/local/bin/ashlr', 'local-runtime', 'resolve-model']`. Null disables
   * re-resolution and the frozen path is used verbatim.
   */
  resolverCommand?: readonly string[] | null;
}

/**
 * Single-quote a string for POSIX sh. Safe for every byte but NUL.
 *
 * An embedded quote closes the literal, emits an escaped quote, and reopens
 * it — the only portable way, since sh has no escapes inside single quotes.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Render the launcher shim the launch agent actually executes.
 *
 * ── WHY A SHIM AND NOT `llama-server` DIRECTLY ────────────────────────────
 *
 * Ollama's model store is CONTENT-ADDRESSED. The GGUF we serve lives at
 * `~/.ollama/models/blobs/sha256-<digest>`, and that digest changes whenever
 * the tag is re-pulled or retagged — at which point the old blob is garbage
 * collected. A plist that froze the digest at install time would then point at
 * a file that no longer exists, and launchd's unconditional `KeepAlive` with
 * `ThrottleInterval 10` would respawn llama-server against it every ten
 * seconds, forever, while every hub surface reported only `state: 'down'`.
 * That is a permanently dead 24/7 runtime produced by a routine `ollama pull`.
 *
 * So the shim re-checks at every launch: use the frozen path when it is still
 * there (the fast, offline, no-dependency case), otherwise ask the hub to
 * re-resolve the reference from the manifest, and fall back to the frozen path
 * if that cannot answer either — a stale path that fails loudly in the log is
 * strictly better than refusing to start at all.
 *
 * `exec` replaces the shell, so launchd supervises llama-server's OWN pid.
 * Nothing here is interpolated unquoted: every path goes through
 * {@link shQuote}.
 *
 * PURE — string in, string out — so the exact script is pinned by unit tests.
 */
export function buildLaunchAgentShim(spec: LaunchAgentSpec): string {
  const modelFlagAt = spec.args.indexOf('-m');
  const frozen = modelFlagAt >= 0 ? spec.args[modelFlagAt + 1] ?? '' : '';
  const rest = spec.args.filter(
    (_, index) => modelFlagAt < 0 || (index !== modelFlagAt && index !== modelFlagAt + 1),
  );

  const canReResolve =
    spec.resolverCommand !== null &&
    spec.resolverCommand !== undefined &&
    spec.resolverCommand.length > 0 &&
    typeof spec.modelRef === 'string' &&
    spec.modelRef.length > 0;

  // The model reference reaches the script as a shell VARIABLE rather than
  // being interpolated into a double-quoted string, so a reference containing
  // `$`, a backtick or a quote can never become shell syntax.
  const resolveBlock = canReResolve
    ? `REF=${shQuote(spec.modelRef as string)}
  RESOLVED="$(${(spec.resolverCommand as readonly string[]).map(shQuote).join(' ')} --model "$REF" 2>/dev/null || true)"
  if [ -n "$RESOLVED" ] && [ -f "$RESOLVED" ]; then
    echo "[ashlr local-runtime] model blob moved; re-resolved $REF -> $RESOLVED" >&2
    MODEL="$RESOLVED"
  else
    echo "[ashlr local-runtime] model blob is gone and could not be re-resolved from $REF: $MODEL" >&2
    echo "[ashlr local-runtime] re-run: ashlr local-runtime install" >&2
  fi`
    : `echo "[ashlr local-runtime] configured model file is missing: $MODEL" >&2`;

  return `#!/bin/sh
# Generated by \`ashlr local-runtime install\`. Do not edit — reinstall instead.
# Removed by \`ashlr local-runtime uninstall\`.
set -u

MODEL=${shQuote(frozen)}

if [ ! -f "$MODEL" ]; then
  ${resolveBlock}
fi

exec ${shQuote(spec.binPath)} -m "$MODEL"${rest.length > 0 ? ` ${rest.map(shQuote).join(' ')}` : ''}
`;
}

/**
 * Render the launch agent plist.
 *
 * PURE — no filesystem, no launchctl — so the exact XML is pinned by unit
 * tests. `KeepAlive` is unconditional rather than `SuccessfulExit: false`:
 * the point of this job is that the runtime is ALWAYS up, so a clean exit is
 * just as much a reason to restart as a crash. `ProcessType: Background` keeps
 * macOS from treating a long-running inference process as a misbehaving
 * foreground app and throttling it.
 */
export function buildLaunchAgentPlist(
  spec: LaunchAgentSpec,
  shimPath: string = launchAgentShimPath(),
): string {
  // The job runs the shim, which re-resolves the model blob and `exec`s
  // llama-server — so launchd still supervises the serving process itself,
  // but a re-pulled model no longer leaves a job respawning against a path
  // that was garbage collected. See `buildLaunchAgentShim`.
  const programArguments = ['/bin/sh', shimPath]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(spec.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(spec.stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(spec.stderrLog)}</string>
  </dict>
</plist>
`;
}

/** Is our plist present in ~/Library/LaunchAgents? Never throws. */
export function launchAgentInstalled(path = launchAgentPlistPath()): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** `gui/<uid>` — the per-user launchd domain. */
function guiDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}`;
}

/** Run launchctl, returning stdout, or null on any failure. Never throws. */
function launchctl(args: string[]): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/bin/launchctl', args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Is the job currently bootstrapped into launchd? */
export function launchAgentLoaded(): boolean {
  if (process.platform !== 'darwin') return false;
  return launchctl(['print', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]) !== null;
}

/** Result of an install/uninstall attempt. Never a thrown error. */
export interface LaunchAgentMutation {
  ok: boolean;
  /** Absolute plist path — always reported, so the operator can see and audit it. */
  plistPath: string;
  /** Whether launchd accepted the bootstrap/bootout. */
  loaded: boolean;
  detail: string;
}

/**
 * Write the plist and bootstrap the job.
 *
 * The write happens first and is reported even when `launchctl` refuses, so a
 * partially-applied install is visible rather than silent. Re-installing over
 * an existing job boots it out first — `bootstrap` on an already-loaded label
 * fails, and the operator asked for the NEW argv, not the old one.
 */
export function installLaunchAgent(spec: LaunchAgentSpec): LaunchAgentMutation {
  const plistPath = launchAgentPlistPath();

  if (process.platform !== 'darwin') {
    return {
      ok: false,
      plistPath,
      loaded: false,
      detail: 'launch agents are a macOS facility; this platform has no equivalent here',
    };
  }

  const shimPath = launchAgentShimPath();
  try {
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    mkdirSync(localRuntimeDir(), { recursive: true, mode: 0o700 });
    // The shim is only executable by its owner: it names an absolute binary
    // and `exec`s it at every login, so a world-writable copy would be a
    // standing privilege-escalation path into a KeepAlive job.
    writeFileSync(shimPath, buildLaunchAgentShim(spec), { mode: 0o700 });
    writeFileSync(plistPath, buildLaunchAgentPlist(spec, shimPath), { mode: 0o644 });
  } catch (err: unknown) {
    return {
      ok: false,
      plistPath,
      loaded: false,
      detail: `could not write the launch agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Idempotent: an existing job must go before the new definition is loaded.
  launchctl(['bootout', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  const bootstrapped = launchctl(['bootstrap', guiDomain(), plistPath]) !== null;
  if (bootstrapped) launchctl(['enable', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);

  const loaded = bootstrapped && launchAgentLoaded();
  return {
    ok: true,
    plistPath,
    loaded,
    detail: loaded
      ? 'launch agent written and bootstrapped; the runtime now starts at login and restarts on crash'
      : 'launch agent written, but launchctl did not bootstrap it — it will still load at next login',
  };
}

/** Boot the job out and delete the plist. Idempotent; never throws. */
export function uninstallLaunchAgent(): LaunchAgentMutation {
  const plistPath = launchAgentPlistPath();
  const wasInstalled = launchAgentInstalled(plistPath);

  launchctl(['bootout', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);

  try {
    rmSync(plistPath, { force: true });
    rmSync(launchAgentShimPath(), { force: true });
  } catch (err: unknown) {
    return {
      ok: false,
      plistPath,
      loaded: launchAgentLoaded(),
      detail: `could not remove the plist: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    plistPath,
    loaded: false,
    detail: wasInstalled
      ? 'launch agent booted out and removed'
      : 'no launch agent was installed; nothing to remove',
  };
}

/** Stop a loaded job without removing its plist, so `stop` can free the port. */
export function bootoutLaunchAgent(): boolean {
  if (!launchAgentLoaded()) return false;
  launchctl(['bootout', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  return !launchAgentLoaded();
}

/** Default log paths, re-exported so callers do not reach into paths.ts. */
export function launchAgentLogPaths(): { stdout: string; stderr: string } {
  return { stdout: stdoutLogPath(), stderr: stderrLogPath() };
}
