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
export function engineInstalled(engine: EngineId): boolean {
  if (engine === 'builtin') return true;
  const bins: Record<string, string[]> = {
    claude: ['claude'],
    codex: ['codex'],
    aw: ['aw'],
    ashlrcode: ['ac', 'ashlrcode'],
  };
  const candidates = bins[engine] ?? [engine];
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
  _cfg: AshlrConfig,
  opts?: { cwd?: string; model?: string; autonomous?: boolean },
): EngineCommand | null {
  if (engine === 'builtin') return null;

  const cwd = opts?.cwd ?? process.cwd();
  const model = opts?.model?.trim();

  switch (engine) {
    case 'claude': {
      const args: string[] = ['-p', goal, '--output-format', 'json'];
      if (model) {
        // --model must come before --output-format per claude's -p mode
        args.splice(2, 0, '--model', model);
      }
      if (opts?.autonomous) {
        // M45: unattended, sandbox-confined edits. acceptEdits auto-applies file
        // edits without prompting (least-privilege — it will not run bash); --add-dir
        // scopes tool access to the worktree. Real containment is the throwaway
        // worktree + severed git push creds (see sandboxed-engine.ts), and claude
        // authenticates via its own HOME subscription session.
        args.push('--permission-mode', 'acceptEdits', '--add-dir', cwd);
      }
      return { bin: 'claude', args, cwd };
    }

    case 'codex': {
      // M45: non-interactive `codex exec`. `--sandbox workspace-write` is Codex's
      // OWN sandbox — it may edit the workspace (the worktree) but has no network
      // and asks for no approvals; this layers on top of our worktree containment.
      // -C scopes the working root to the worktree; --json emits JSONL events.
      const args: string[] = ['exec'];
      if (model) args.push('--model', model);
      args.push('--sandbox', 'workspace-write', '--cd', cwd, '--json', goal);
      return { bin: 'codex', args, cwd };
    }

    case 'aw': {
      const args: string[] = ['auto', goal, '--cwd', cwd];
      if (model) {
        args.push('--model', model);
      }
      return { bin: 'aw', args, cwd };
    }

    case 'ashlrcode': {
      // Real CLI is 'ac' (alias 'ashlrcode'). Arg builder must be correct for
      // when present; absence routes to builtin per M9/M10.
      const args: string[] = ['--goal', goal];
      return { bin: 'ac', args, cwd };
    }

    default:
      return null;
  }
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
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
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
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string } {
  // Apply phantom-exec wrap when enabled and installed (best-effort)
  let effective = cmd;
  if (cfg.phantom?.enabled && phantomInstalled()) {
    effective = phantomWrap(cmd, cfg);
  }

  // M45: a caller (sandboxed-engine) may pass a hardened, containment env; else
  // fall back to the allowlist-only env-bridge env (NON-SECRET).
  const childEnv = opts?.env ?? withToolEnv(cfg);

  const result = spawnSync(effective.bin, effective.args, {
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
