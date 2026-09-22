/**
 * Where the supervised llama-server runtime keeps its own state.
 *
 * Every path is re-resolved from `homedir()` at call time (the convention in
 * src/core/config.ts) so a relocated HOME — a test, a different user — is
 * always honoured. Nothing here ever touches ~/.ashlr/config.json,
 * ~/.ashlr/enrollment.json or ~/.ashlr/KILL: this family reads those and owns
 * none of them.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.ashlr` — the hub root. */
export function ashlrHome(): string {
  return join(homedir(), '.ashlr');
}

/** `~/.ashlr/local-runtime` — this runtime's private state directory. */
export function localRuntimeDir(): string {
  return join(ashlrHome(), 'local-runtime');
}

/** `~/.ashlr/local-runtime/llama-server.json` — the ownership record. */
export function ownershipRecordPath(): string {
  return join(localRuntimeDir(), 'llama-server.json');
}

/**
 * `~/.ashlr/local-runtime/llama-server-launch.sh` — the launch agent's shim.
 *
 * launchd runs THIS rather than llama-server directly. See
 * {@link import('./launchd.js').buildLaunchAgentShim} for why: Ollama's blob
 * store is content-addressed, so a frozen `sha256-…` path in the plist dies
 * permanently on the next `ollama pull`.
 */
export function launchAgentShimPath(): string {
  return join(localRuntimeDir(), 'llama-server-launch.sh');
}

/** `~/.ashlr/logs` — where a supervised process's stdout/stderr land. */
export function logsDir(): string {
  return join(ashlrHome(), 'logs');
}

/** Absolute stdout log path for the supervised runtime. */
export function stdoutLogPath(): string {
  return join(logsDir(), 'local-runtime.out.log');
}

/** Absolute stderr log path for the supervised runtime. */
export function stderrLogPath(): string {
  return join(logsDir(), 'local-runtime.err.log');
}

/** launchd job label. Reverse-DNS, matching the hub's other agents. */
export const LAUNCH_AGENT_LABEL = 'ai.ashlr.local-runtime';

/**
 * `~/Library/LaunchAgents/ai.ashlr.local-runtime.plist`.
 *
 * This path is OUTSIDE the repository and outside ~/.ashlr. Writing it changes
 * the machine's login-time behaviour, so it only ever happens behind an
 * explicit `--install` and the path is printed to the operator.
 */
export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * Ollama's model store root. `OLLAMA_MODELS` wins when set, exactly as the
 * Ollama server itself resolves it; otherwise `~/.ollama/models`.
 */
export function ollamaModelsRoot(): string {
  const override = process.env['OLLAMA_MODELS']?.trim();
  if (override) return override;
  return join(homedir(), '.ollama', 'models');
}
