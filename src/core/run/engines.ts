/**
 * engines.ts — M11: hardened per-engine adapters.
 *
 * Each engine maps a goal to its REAL CLI argv. This is the source of truth
 * for external engine invocations and MUST be unit-tested for exact argv.
 *
 * Confirmed real CLIs (probed via --help where installed):
 *   - claude (INSTALLED): `claude -p "<goal>" --model <M> --output-format json`
 *   - aw (INSTALLED):     `aw auto "<goal>" --cwd <D>` [+ `--model <M>` when given]
 *   - ashlrcode (ABSENT): `ac --goal "<goal>"` style (fallback to builtin when absent)
 *
 * GUARDRAILS:
 *   - buildEngineCommand is PURE: no spawn, no PATH probe, no network.
 *   - spawnEngine MUST NOT be called against a real delegated agent during
 *     build/integrate/verify (unit-tests assert argv only, never spawn).
 *   - phantomWrap is a pure arg transform; never logs secret values.
 *   - withToolEnv is allowlist-only (no secrets in env).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import type { AshlrConfig, EngineId, EngineCommand } from '../types.js';
import { withToolEnv } from '../env-bridge.js';
import { resolveEngineSpec, compileArgv } from './engine-registry.js';

// ---------------------------------------------------------------------------
// Phantom detection (cached, best-effort)
// ---------------------------------------------------------------------------

let _phantomInstalled: boolean | undefined;

function phantomInstalled(): boolean {
  if (_phantomInstalled === undefined) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', ['phantom'], { stdio: 'ignore' });
      _phantomInstalled = true;
    } catch {
      _phantomInstalled = false;
    }
  }
  return _phantomInstalled;
}

// ---------------------------------------------------------------------------
// engineInstalled
// ---------------------------------------------------------------------------

/**
 * Whether the engine's real binary is on PATH.
 * - 'builtin' => always true (no external binary needed).
 * - 'claude'  => checks for 'claude' binary.
 * - 'aw'      => checks for 'aw' binary.
 * - 'ashlrcode' => checks for 'ac' (primary alias) or 'ashlrcode'.
 *
 * Best-effort, never throws.
 */
export function engineInstalled(engine: EngineId, cfg?: AshlrConfig): boolean {
  if (engine === 'builtin') return true;
  const spec = resolveEngineSpec(engine, cfg);
  // An OpenAI-compatible api-model is "installed" when its key is present (the
  // local-first gate still applies at completion time); CLI agents probe PATH.
  if (spec?.kind === 'api-model') {
    const key = spec.api?.envKey;
    return key ? Boolean(process.env[key]?.trim()) : false;
  }
  const candidates = spec?.bins ?? [spec?.bin ?? engine];
  for (const bin of candidates) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// buildEngineCommand — PURE, no side effects
// ---------------------------------------------------------------------------

/**
 * Build the EXACT external command for an engine, or null for the builtin loop.
 *
 * Returns null when `engine === 'builtin'`.
 * Returns a fully-resolved EngineCommand for 'ashlrcode' | 'aw' | 'claude'.
 *
 * This function is PURE: it does not spawn, probe PATH, or touch the network.
 * opts.model is the hub-selected model; opts.cwd the target dir (default process.cwd()).
 *
 * EXACT argvs (asserted in unit tests):
 *   claude:     bin='claude', args=['-p', G, '--model', M, '--output-format', 'json']
 *   aw:         bin='aw',     args=['auto', G, '--cwd', D] [+ '--model', M when given]
 *   ashlrcode:  bin='ac',     args=['--goal', G]
 */
export function buildEngineCommand(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts?: { cwd?: string; model?: string; autonomous?: boolean },
): EngineCommand | null {
  // M50: argv is driven by the declarative engine registry (single source of
  // truth). The builtin engine and api-model engines have no CLI argv → null
  // (api-models run through the in-process loop + provider client, not a spawn).
  const spec = resolveEngineSpec(engine, cfg);
  if (!spec || spec.kind !== 'cli-agent' || !spec.argv) return null;

  const cwd = opts?.cwd ?? process.cwd();
  const args = compileArgv(
    spec.argv,
    { goal, cwd, model: opts?.model, autonomous: opts?.autonomous },
    spec.autonomousArgv,
  );
  const bin = spec.bin ?? spec.bins?.[0] ?? spec.id;
  return { bin, args, cwd };
}

// ---------------------------------------------------------------------------
// phantomWrap — pure arg transform
// ---------------------------------------------------------------------------

/**
 * Wrap an EngineCommand to run under `phantom exec -- <bin> <args...>`.
 *
 * PURE arg transform — never logs secret values.
 * Caller decides when to apply it (only when cfg.phantom?.enabled && phantomInstalled).
 */
export function phantomWrap(cmd: EngineCommand, _cfg: AshlrConfig): EngineCommand {
  return {
    bin: 'phantom',
    args: ['exec', '--', cmd.bin, ...cmd.args],
    cwd: cmd.cwd,
  };
}

// ---------------------------------------------------------------------------
// spawnEngine
// ---------------------------------------------------------------------------

/**
 * Spawn a resolved EngineCommand and capture its result.
 *
 * - Applies withToolEnv(cfg) (M10 env-bridge; allowlist, NON-SECRET only).
 * - Wraps via phantomWrap when cfg.phantom?.enabled AND phantom is installed.
 * - Captures stdout as `output`.
 * - For claude with --output-format json: parses usage/cost from stdout JSON.
 * - Never throws; failures reported as { ok: false, error }.
 *
 * GUARDRAIL: MUST NOT be called against a real delegated agent during
 * build/integrate/verify — unit tests assert argv builders only.
 */
export function spawnEngine(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /**
     * M52: optional OS-level sandbox launcher. When present, the engine is
     * spawned as `launcher.bin [...launcher.prefixArgs, cmd.bin, ...cmd.args]`
     * (the phantomWrap, if any, composes BEFORE the launcher — jail wraps the
     * whole thing). When absent ⇒ exactly v4 behavior (default-off parity).
     */
    launcher?: { bin: string; prefixArgs: string[] };
  },
): { ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string } {
  // CONTRACT: spawnEngine NEVER throws. Any synchronous failure (spawnSync
  // throwing, env-bridge/phantom probe errors, etc.) is reported as
  // { ok:false, error } rather than propagated to the caller.
  try {
    return spawnEngineInner(cmd, cfg, opts);
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function spawnEngineInner(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; launcher?: { bin: string; prefixArgs: string[] } },
): { ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string } {
  // Apply phantom-exec wrap when enabled and installed (best-effort).
  // phantomWrap composes BEFORE the launcher — the OS jail wraps the whole thing.
  let effective = cmd;
  if (cfg.phantom?.enabled && phantomInstalled()) {
    effective = phantomWrap(cmd, cfg);
  }

  // M52: apply the OS sandbox launcher when provided. The launcher wraps the
  // already-phantom-wrapped command so the jail contains the entire chain.
  // When absent ⇒ exactly v4 behavior (default-off parity guaranteed).
  let spawnBin = effective.bin;
  let spawnArgs = effective.args;
  if (opts?.launcher) {
    spawnBin = opts.launcher.bin;
    spawnArgs = [...opts.launcher.prefixArgs, effective.bin, ...effective.args];
  }

  // M45: a caller (sandboxed-engine) may pass a hardened, containment env; else
  // fall back to the allowlist-only env-bridge env (NON-SECRET).
  const childEnv = opts?.env ?? withToolEnv(cfg);

  const result = spawnSync(spawnBin, spawnArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    timeout: opts?.timeoutMs ?? 5 * 60 * 1000, // hard wall-clock limit (default 5 min)
    cwd: effective.cwd,
    env: childEnv,
  });

  if (result.error || result.status !== 0) {
    const errMsg =
      result.error?.message ??
      (result.stderr ? String(result.stderr).trim() : `exit ${result.status ?? 'unknown'}`);
    return { ok: false, output: '', error: errMsg };
  }

  const rawOutput = String(result.stdout ?? '').trim();

  // Attempt to parse usage from claude --output-format json output
  let usage: { tokensIn: number; tokensOut: number } | undefined;
  if (cmd.bin === 'claude') {
    try {
      const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
      // Claude JSON output shape: { cost_usd, usage: { input_tokens, output_tokens }, result, ... }
      const u = parsed['usage'] as Record<string, unknown> | undefined;
      if (u && typeof u['input_tokens'] === 'number' && typeof u['output_tokens'] === 'number') {
        usage = {
          tokensIn: u['input_tokens'] as number,
          tokensOut: u['output_tokens'] as number,
        };
      }
    } catch {
      // Not JSON or unexpected shape — usage stays undefined; caller estimates
    }
  }

  // M45: best-effort usage parse for codex --json (JSONL events). The token-count
  // event shape is not contractually stable across versions, so this is a guarded
  // scan: find any line carrying input/output token counts. Undefined on miss
  // (caller estimates). ⚠️ Refine in M46 once the event schema is pinned.
  if (cmd.bin === 'codex' && !usage) {
    for (const line of rawOutput.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        const u = (ev['usage'] ?? ev['token_usage'] ?? ev) as Record<string, unknown>;
        const tin = u['input_tokens'] ?? u['prompt_tokens'];
        const tout = u['output_tokens'] ?? u['completion_tokens'];
        if (typeof tin === 'number' && typeof tout === 'number') {
          usage = { tokensIn: tin, tokensOut: tout };
        }
      } catch {
        // skip non-JSON / unexpected line
      }
    }
  }

  return { ok: true, output: rawOutput, usage };
}
