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
import * as http from 'node:http';
import * as https from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
// phantomInitializedAt — per-directory check (cheap, never throws)
// ---------------------------------------------------------------------------

/**
 * Returns true when the given directory contains a .phantom.toml file,
 * meaning phantom exec can run there. Self-authenticating CLI agents (claude,
 * codex) do NOT need phantom and run in sandbox worktrees that have NO
 * .phantom.toml — skip wrapping them to avoid the hard-fail from phantom exec.
 *
 * Pure fs probe; never throws.
 */
export function phantomInitializedAt(cwd: string): boolean {
  try {
    return existsSync(join(cwd, '.phantom.toml'));
  } catch {
    return false;
  }
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
/**
 * Resolve a bare engine bin name to its ABSOLUTE path via `which`/`where`, so it
 * runs under sandbox-exec — whose execvp does NOT resolve PATH like the shell
 * (a bare name fails: "execvp() of 'claude' failed: No such file or directory").
 * Returns the input unchanged when it's already a path or can't be resolved.
 */
export function resolveBinAbsolute(bin: string): string {
  if (!bin || bin.includes('/')) return bin;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probe, [bin], { encoding: 'utf8' }).trim().split('\n')[0]?.trim();
    return out && out.length > 0 ? out : bin;
  } catch {
    return bin;
  }
}

export function engineInstalled(engine: EngineId, cfg?: AshlrConfig): boolean {
  if (engine === 'builtin') return true;
  const spec = resolveEngineSpec(engine, cfg);
  // An OpenAI-compatible api-model is "installed" when:
  //   - envKey is non-empty: the key env var is present (cloud API — key required).
  //   - envKey is empty/absent: probe the endpoint URL synchronously (local engines
  //     like Ollama require no key; "installed" = the server is reachable).
  //     Uses the baseUrlEnv override when set, else the spec's defaultBaseUrl.
  //     A 200 from /v1/models (or any non-connection-refused response) = installed.
  //     This is a SYNC probe (spawnSync curl) to keep engineInstalled synchronous
  //     and pure-ish; failures / missing curl fall back to false (safe default).
  if (spec?.kind === 'api-model') {
    const key = spec.api?.envKey;
    if (key) return Boolean(process.env[key]?.trim());
    // No key → local endpoint probe (e.g. Ollama at http://localhost:11434/v1).
    // Uses Node's built-in http/https — no curl dependency, works inside any
    // confined subprocess that inherits the Node runtime (M117).
    const baseUrlEnv = spec.api?.baseUrlEnv;
    const baseUrl = (baseUrlEnv && process.env[baseUrlEnv]?.trim()) ||
      spec.api?.defaultBaseUrl ||
      'http://localhost:11434/v1';
    try {
      const url = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
      const transport = url.protocol === 'https:' ? https : http;
      let reachable = false;
      // Synchronous-style probe via a shared-nothing child process that exits
      // with code 0 on any HTTP response (connection refused → code 1).
      // We avoid a full async refactor of engineInstalled by using spawnSync
      // with a Node one-liner that uses the built-in http module (no curl).
      const probe = spawnSync(
        process.execPath,
        [
          '-e',
          `const h=require('${url.protocol === 'https:' ? 'https' : 'http'}');` +
          `const r=h.get('${url.toString()}',{timeout:1500},(res)=>{process.exit(0)});` +
          `r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});`,
        ],
        { timeout: 2500 },
      );
      reachable = probe.status === 0;
      void transport; // suppress unused-import lint
      return reachable;
    } catch {
      return false;
    }
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
  // Apply phantom-exec wrap when enabled, installed, AND the cwd contains
  // .phantom.toml. Self-authenticating CLIs (claude, codex) run in sandbox
  // worktrees that have no .phantom.toml — wrapping them is both unnecessary
  // and fatal (phantom hard-fails with "No .phantom.toml found"). Skip wrap
  // gracefully; the agent authenticates via its own ~/.claude / ~/.codex.
  // phantomWrap composes BEFORE the launcher — the OS jail wraps the whole thing.
  let effective = cmd;
  const wrapCwd = cmd.cwd ?? process.cwd();
  if (cfg.phantom?.enabled && phantomInstalled() && phantomInitializedAt(wrapCwd)) {
    effective = phantomWrap(cmd, cfg);
  } else if (cfg.phantom?.enabled && phantomInstalled() && !phantomInitializedAt(wrapCwd)) {
    // Audit note: skipping phantom wrap — no .phantom.toml in cwd (engine self-authenticates).
    process.stderr.write(`[ashlr] phantomWrap skipped for ${cmd.bin}: no .phantom.toml in ${wrapCwd}
`);
  }

  // M52: apply the OS sandbox launcher when provided. The launcher wraps the
  // already-phantom-wrapped command so the jail contains the entire chain.
  // When absent ⇒ exactly v4 behavior (default-off parity guaranteed).
  // Resolve the engine bin to an ABSOLUTE path: sandbox-exec's execvp does not
  // do shell-style PATH resolution, so a bare name ('claude') fails with
  // "execvp() of 'claude' failed: No such file or directory".
  const engineBinAbs = resolveBinAbsolute(effective.bin);
  let spawnBin = engineBinAbs;
  let spawnArgs = effective.args;
  if (opts?.launcher) {
    spawnBin = opts.launcher.bin;
    spawnArgs = [...opts.launcher.prefixArgs, engineBinAbs, ...effective.args];
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
