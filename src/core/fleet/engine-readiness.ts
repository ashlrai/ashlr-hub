/**
 * engine-readiness.ts — M81: per-engine readiness preflight.
 *
 * Answers: for each allowed backend engine, is it installed, authenticated,
 * and ready to receive work? Surfaces exactly what to do when it isn't.
 *
 * Design constraints:
 *  - NEVER throws: every probe is bounded + guarded; failures degrade to
 *    authed:'unknown' rather than propagating.
 *  - Bounded probes: short timeouts (2 s) on any subprocess call.
 *  - Pure-ish: no side effects beyond spawning short-lived read-only probes.
 *  - Testable: probe logic is injected via an optional ProbeOverrides bag so
 *    unit tests never need real binaries on PATH.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineId } from '../types.js';
import { engineInstalled, resolveBinAbsolute } from '../run/engines.js';
import { resolveEngineSpec } from '../run/engine-registry.js';
import { engineTierOf } from '../run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuthStatus = boolean | 'unknown';

export interface EngineReadiness {
  /** The engine id, e.g. 'claude', 'codex', 'builtin'. */
  engine: EngineId;
  /** Trust tier: 'local' | 'mid' | 'frontier'. */
  tier: string;
  /** True when the binary (or env key for api-model) is present. */
  installed: boolean;
  /** Absolute path to the binary, when installed and resolvable. */
  binPath?: string;
  /**
   * Whether the engine appears authenticated.
   *   true    — confident it is authed.
   *   false   — confident it is NOT authed.
   *   'unknown' — probe inconclusive (treat as a soft warning, not a blocker).
   */
  authed: AuthStatus;
  /** True only when installed AND (authed === true || authed === 'unknown'). */
  ready: boolean;
  /** Human-readable detail explaining the current state. */
  detail: string;
  /** Precise remediation steps when ready === false. Absent when already ready. */
  fix?: string;
}

// ---------------------------------------------------------------------------
// Probe overrides (for unit testing without real binaries)
// ---------------------------------------------------------------------------

export interface ProbeOverrides {
  /** Override for engineInstalled() probe. */
  isInstalled?: (engine: EngineId, cfg?: AshlrConfig) => boolean;
  /** Override for resolveBinAbsolute() probe. */
  resolveBin?: (bin: string) => string;
  /** Override for the codex login-status probe. */
  codexLoginStatus?: () => 'logged-in' | 'logged-out' | 'unknown';
  /** Override for the claude credential probe. */
  claudeCredential?: () => 'env-token' | 'file-creds' | 'none';
  /** Override for env-var presence (api-model keys). */
  getEnv?: (key: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Internal: bounded subprocess probe (max 2 s, never throws)
// ---------------------------------------------------------------------------

function runProbe(bin: string, args: string[], timeoutMs = 2000): { stdout: string; ok: boolean } {
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      stdout: (r.stdout ?? '').trim(),
      ok: r.status === 0 && !r.error,
    };
  } catch {
    return { stdout: '', ok: false };
  }
}

// ---------------------------------------------------------------------------
// Internal: per-engine auth probes
// ---------------------------------------------------------------------------

/**
 * Probe codex auth state.
 * Runs `codex login status` with a 2-second timeout.
 * "Logged in" in stdout → true; otherwise false (even "Logged in" may have a
 * revoked token; we note this in detail so the operator knows to re-login if
 * codex fails later).
 */
function probeCodexAuth(): 'logged-in' | 'logged-out' | 'unknown' {
  const { stdout, ok } = runProbe('codex', ['login', 'status']);
  if (!ok && !stdout) return 'unknown';
  if (/logged in/i.test(stdout)) return 'logged-in';
  if (/not logged in|logged out|no account/i.test(stdout)) return 'logged-out';
  return 'unknown';
}

/**
 * Probe claude credential state (no subprocess needed — file + env checks).
 * Returns:
 *   'env-token'  — CLAUDE_CODE_OAUTH_TOKEN is set in env
 *   'file-creds' — ~/.claude/credentials.json exists
 *   'none'       — no credential signal found
 */
function probeClaudeCredential(): 'env-token' | 'file-creds' | 'none' {
  if (process.env['CLAUDE_CODE_OAUTH_TOKEN']?.trim()) return 'env-token';
  if (process.env['ANTHROPIC_AUTH_TOKEN']?.trim()) return 'env-token';
  // ~/.claude/credentials.json is the canonical file claude CLI writes
  const creds = join(homedir(), '.claude', 'credentials.json');
  if (existsSync(creds)) return 'file-creds';
  return 'none';
}

// ---------------------------------------------------------------------------
// Per-engine install commands (for fix strings)
// ---------------------------------------------------------------------------

const INSTALL_HINT: Partial<Record<string, string>> = {
  claude:
    'npm install -g @anthropic-ai/claude-code  (or download from https://claude.ai/code)',
  codex:
    'npm install -g @openai/codex',
  hermes:
    'pip install hermes-agent  (or follow https://github.com/NousResearch/Hermes)',
  opencode:
    'npm install -g opencode  (or https://opencode.ai)',
  aw: 'pip install aider-chat  (or https://aider.chat)',
  ashlrcode:
    'npm install -g ashlrcode  (or follow ashlrcode setup docs)',
};

// ---------------------------------------------------------------------------
// Core: single-engine readiness probe
// ---------------------------------------------------------------------------

/**
 * Return a readiness report for one engine. Never throws.
 * Pass `overrides` to replace subprocess/fs probes in unit tests.
 */
export function engineReadiness(
  engine: EngineId,
  cfg?: AshlrConfig,
  overrides?: ProbeOverrides,
): EngineReadiness {
  const spec = resolveEngineSpec(engine, cfg);
  const tier = engineTierOf(engine, cfg);

  const isInstalledFn = overrides?.isInstalled ?? engineInstalled;
  const resolveBinFn = overrides?.resolveBin ?? resolveBinAbsolute;
  const getEnvFn = overrides?.getEnv ?? ((k: string) => process.env[k]);

  // ── builtin: always ready, no binary ──────────────────────────────────────
  if (engine === 'builtin' || spec?.kind === 'builtin') {
    return {
      engine,
      tier,
      installed: true,
      authed: true,
      ready: true,
      detail: 'built-in local agent loop — always available.',
    };
  }

  // ── api-model: "installed" = env key present ───────────────────────────────
  if (spec?.kind === 'api-model') {
    const envKey = spec.api?.envKey ?? '';
    const keyPresent = Boolean(getEnvFn(envKey)?.trim());
    if (!envKey) {
      return {
        engine,
        tier,
        installed: false,
        authed: false,
        ready: false,
        detail: 'api-model spec is missing api.envKey — cannot verify.',
        fix: `Add api.envKey to the engine spec in cfg.foundry.engines.${engine}`,
      };
    }
    if (!keyPresent) {
      return {
        engine,
        tier,
        installed: false,
        authed: false,
        ready: false,
        detail: `env var ${envKey} is not set.`,
        fix: `export ${envKey}=<your-api-key>`,
      };
    }
    return {
      engine,
      tier,
      installed: true,
      authed: true,
      ready: true,
      detail: `${envKey} is set — API key present.`,
    };
  }

  // ── cli-agent: check binary first, then auth ───────────────────────────────
  const installed = isInstalledFn(engine, cfg);
  if (!installed) {
    const installCmd = INSTALL_HINT[engine] ?? `install the '${engine}' CLI and ensure it is on PATH`;
    return {
      engine,
      tier,
      installed: false,
      authed: false,
      ready: false,
      detail: `binary not found on PATH.`,
      fix: installCmd,
    };
  }

  // Resolve absolute path for display
  const primaryBin = spec?.bin ?? spec?.bins?.[0] ?? engine;
  const binPath = resolveBinFn(primaryBin);

  // ── claude auth probe ──────────────────────────────────────────────────────
  if (engine === 'claude') {
    const credFn = overrides?.claudeCredential ?? probeClaudeCredential;
    const cred = credFn();

    if (cred === 'env-token') {
      return {
        engine,
        tier,
        installed: true,
        binPath,
        authed: true,
        ready: true,
        detail: 'CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_AUTH_TOKEN) found in env.',
      };
    }
    if (cred === 'file-creds') {
      return {
        engine,
        tier,
        installed: true,
        binPath,
        authed: true,
        ready: true,
        detail: '~/.claude/credentials.json found — subscription credentials present.',
      };
    }
    // 'none' — no credential signal
    return {
      engine,
      tier,
      installed: true,
      binPath,
      authed: false,
      ready: false,
      detail:
        'No credential found (neither CLAUDE_CODE_OAUTH_TOKEN nor ~/.claude/credentials.json).',
      fix:
        'Run: claude (interactive login), then export CLAUDE_CODE_OAUTH_TOKEN if running under a daemon/launchd. ' +
        'To set the env for launchd: launchctl setenv CLAUDE_CODE_OAUTH_TOKEN <token>',
    };
  }

  // ── codex auth probe ───────────────────────────────────────────────────────
  if (engine === 'codex') {
    const codexFn = overrides?.codexLoginStatus ?? probeCodexAuth;
    const status = codexFn();

    if (status === 'logged-in') {
      return {
        engine,
        tier,
        installed: true,
        binPath,
        authed: true,
        ready: true,
        detail:
          '`codex login status` reports logged in. Note: a revoked/expired token may ' +
          'still report "logged in" — re-login if codex fails with an auth error.',
      };
    }
    if (status === 'logged-out') {
      return {
        engine,
        tier,
        installed: true,
        binPath,
        authed: false,
        ready: false,
        detail: '`codex login status` reports not logged in.',
        fix: 'run: codex logout && codex login',
      };
    }
    // 'unknown' — probe inconclusive (codex binary exists but status unclear)
    return {
      engine,
      tier,
      installed: true,
      binPath,
      authed: 'unknown',
      ready: true, // installed + unknown → optimistically ready (will surface at runtime)
      detail:
        '`codex login status` output was inconclusive — auth state unknown. ' +
        'Will surface a login error at runtime if unauthenticated.',
      fix: 'If codex fails: run codex logout && codex login',
    };
  }

  // ── other cli-agents (aw, ashlrcode, hermes, opencode): auth is opaque ────
  // These agents authenticate implicitly (local keys, config files, etc.).
  // Being installed is sufficient; auth state is not probeable without running them.
  return {
    engine,
    tier,
    installed: true,
    binPath,
    authed: 'unknown',
    ready: true,
    detail: `${primaryBin} found on PATH — auth state is opaque (managed by the agent itself).`,
  };
}

// ---------------------------------------------------------------------------
// Fleet-level: probe all allowed backends
// ---------------------------------------------------------------------------

/**
 * Return readiness reports for every engine in cfg.foundry.allowedBackends
 * (or ['builtin'] when foundry is absent). Never throws.
 */
export function fleetReadiness(
  cfg?: AshlrConfig,
  overrides?: ProbeOverrides,
): EngineReadiness[] {
  const allowed: EngineId[] = (cfg?.foundry?.allowedBackends as EngineId[] | undefined) ?? ['builtin'];
  // Always include builtin first if not already listed
  const engines: EngineId[] = allowed.includes('builtin' as EngineId)
    ? allowed
    : ['builtin' as EngineId, ...allowed];

  return engines.map((engine) => {
    try {
      return engineReadiness(engine, cfg, overrides);
    } catch {
      // Defensive: engineReadiness is supposed to never throw, but if something
      // slips through (e.g. a cfg.foundry.engines entry with bad shape), degrade.
      return {
        engine,
        tier: 'local',
        installed: false,
        authed: false,
        ready: false,
        detail: 'preflight probe threw unexpectedly — engine spec may be malformed.',
        fix: `Check cfg.foundry.engines.${engine} for a valid EngineSpec shape.`,
      } satisfies EngineReadiness;
    }
  });
}
