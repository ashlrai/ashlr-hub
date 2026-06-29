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

import { spawnSync, execFileSync, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AshlrConfig, EngineId, EngineCommand } from '../types.js';
import { withToolEnv } from '../env-bridge.js';
import { resolveEngineSpec, compileArgv } from './engine-registry.js';
import { attachStallMonitor } from './run-monitor.js';
import type { TerminationReason } from './run-monitor.js';

// ---------------------------------------------------------------------------
// RunEvent — normalised event emitted by a streaming engine subprocess
// ---------------------------------------------------------------------------

/**
 * A single event produced by a streaming engine subprocess.
 * Normalised from both `claude --output-format stream-json` (JSONL) and
 * `codex` line-based JSONL output so the stall monitor can work engine-agnostic.
 */
export interface RunEvent {
  /** Event kind. */
  kind: 'text' | 'tool_call' | 'file_touched' | 'usage' | 'raw';
  /** ISO timestamp this event was created (Date.now()). */
  ts: number;
  /** Tool name when kind === 'tool_call'. */
  toolName?: string;
  /** Normalised absolute path when kind === 'file_touched'. */
  fileTouched?: string;
  /** Human-readable text fragment (model delta or status message). */
  text?: string;
  /** Raw line that produced this event (for debugging). */
  rawLine?: string;
}

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
// llama-server adapter (M144)
// ---------------------------------------------------------------------------

/**
 * Resolve the llama.cpp llama-server base URL.
 *
 * Priority order (loose cfg read — no types.ts edit):
 *   1. cfg.models.llamaServer?.baseUrl  (operator config override)
 *   2. LLAMA_SERVER_BASE_URL env var
 *   3. http://localhost:8080/v1          (llama-server OpenAI-compat default)
 *
 * Recommended launch command for Apple Silicon (EAGLE-3 speculative decoding,
 * continuous batching, prefix-cache, 4 parallel slots):
 *
 *   llama-server \
 *     -m <qwen3-coder-next-q4.gguf> \
 *     -np 4 \
 *     -cb \
 *     --cache-prompt \
 *     --slot-prompt-similarity 0.1 \
 *     --spec-type draft-eagle3 \
 *     --model-draft <small-draft.gguf>
 *
 * This gives ~1.5–2.5x throughput over single-slot Ollama at zero quality cost
 * on Apple Silicon. qwen3-coder-next (80B-A3B, q4, ~52 GB) fits a 128 GB Mac.
 * Default draft model: any sub-4B GGUF (e.g. qwen2.5-coder-1.5b-instruct-q8).
 */
export function buildLlamaServerBaseUrl(cfg?: AshlrConfig): string {
  const cfgModels = (cfg as unknown as Record<string, unknown>)?.['models'] as
    | Record<string, unknown>
    | undefined;
  const cfgLlamaServer = cfgModels?.['llamaServer'] as
    | { baseUrl?: string }
    | undefined;
  return (
    cfgLlamaServer?.baseUrl?.trim() ||
    process.env['LLAMA_SERVER_BASE_URL']?.trim() ||
    'http://localhost:8080/v1'
  );
}

/**
 * Synthesise an inline EngineSpec for llama-server.
 *
 * llama-server speaks the same OpenAI-compatible /v1/chat/completions protocol
 * as Ollama — so it reuses the runApiModelSandboxed path in sandboxed-engine.ts
 * unchanged. No envKey (local, no API key needed); probe via GET /v1/models like
 * Ollama. Not registered in engine-registry.ts (file-ownership bounds for M144).
 */
function buildLlamaServerSpec(cfg?: AshlrConfig): {
  id: string; kind: 'api-model'; tier: 'mid';
  api: { envKey: string; baseUrlEnv: string; defaultBaseUrl: string; defaultModel: string; protocol: 'openai' };
  capabilities: string[];
} {
  return {
    id: 'llama-server',
    kind: 'api-model',
    tier: 'mid',
    api: {
      envKey: '',
      baseUrlEnv: 'LLAMA_SERVER_BASE_URL',
      defaultBaseUrl: buildLlamaServerBaseUrl(cfg),
      defaultModel: 'qwen3-coder-next',
      protocol: 'openai',
    },
    capabilities: ['agent', 'edit', 'tools'],
  };
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
 * - 'llama-server' => probes http://localhost:8080/v1/models (M144).
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
  // M144: llama-server is not in the built-in engine registry (engine-registry.ts
  // is outside file-ownership for M144). Synthesise its spec inline so the
  // api-model probe path (Node http GET /v1/models) applies correctly.
  const spec = engine === ('llama-server' as EngineId)
    ? buildLlamaServerSpec(cfg)
    : resolveEngineSpec(engine, cfg);
  // An OpenAI-compatible api-model is "installed" when:
  //   - envKey is non-empty: the key env var is present (cloud API — key required).
  //   - envKey is empty/absent: probe the endpoint URL synchronously (local engines
  //     like Ollama require no key; "installed" = the server is reachable).
  //     Uses the baseUrlEnv override when set, else the spec's defaultBaseUrl.
  //     A 200 from /v1/models (or any non-connection-refused response) = installed.
  //     This is a SYNC probe (spawnSync node) to keep engineInstalled synchronous
  //     and pure-ish; failures fall back to false (safe default).
  if (spec?.kind === 'api-model') {
    const key = spec.api?.envKey;
    if (key) return Boolean(process.env[key]?.trim());
    // No key -> local endpoint probe (e.g. Ollama at http://localhost:11434/v1,
    // or llama-server at http://localhost:8080/v1).
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
      // with code 0 on any HTTP response (connection refused -> code 1).
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
 *   llama-server: null (api-model -- no CLI argv, runs via runApiModelSandboxed)
 */
export function buildEngineCommand(
  engine: EngineId,
  goal: string,
  cfg: AshlrConfig,
  opts?: { cwd?: string; model?: string; autonomous?: boolean },
): EngineCommand | null {
  // M50: argv is driven by the declarative engine registry (single source of
  // truth). The builtin engine and api-model engines have no CLI argv -> null
  // (api-models run through the in-process loop + provider client, not a spawn).
  // M144: llama-server is api-model -- always returns null (no CLI argv).
  if (engine === ('llama-server' as EngineId)) return null;
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
 * M236: converted from spawnSync + wall-clock kill to async streaming spawn +
 * stall-based termination. Frontier agents (Claude/Codex) run as long as they
 * are PRODUCTIVE — termination is driven by the stall monitor (run-monitor.ts)
 * rather than a fixed wall-clock. The 2h backstop in timeoutMs is a runaway-
 * cost safety net only.
 *
 * - Applies withToolEnv(cfg) (M10 env-bridge; allowlist, NON-SECRET only).
 * - Wraps via phantomWrap when cfg.phantom?.enabled AND phantom is installed.
 * - Captures stdout as `output`; normalises lines to RunEvents.
 * - For claude: parses usage from the final stream-json summary event.
 * - Never throws; failures reported as { ok: false, error }.
 *
 * GUARDRAIL: MUST NOT be called against a real delegated agent during
 * build/integrate/verify -- unit tests assert argv builders only.
 *
 * RETURN CONTRACT (preserved from pre-M236 for m233/m45/m52 compatibility):
 *   { ok: boolean; output: string; usage?: { tokensIn, tokensOut }; error?: string }
 */
export async function spawnEngine(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /**
     * M52: optional OS-level sandbox launcher. When present, the engine is
     * spawned as `launcher.bin [...launcher.prefixArgs, cmd.bin, ...cmd.args]`
     * (the phantomWrap, if any, composes BEFORE the launcher -- jail wraps the
     * whole thing). When absent => exactly v4 behavior (default-off parity).
     */
    launcher?: { bin: string; prefixArgs: string[] };
    /**
     * M236: callback invoked for each normalised RunEvent from the child
     * process stdout/stderr. Used by run-monitor.ts for stall detection.
     * When absent, events are collected internally only (no stall monitoring).
     */
    onEvent?: (ev: RunEvent) => void;
    /** M236 test hook: grace period (ms) between SIGINT and SIGKILL in stall-stop. */
    _stallGraceMs?: number;
  },
): Promise<{ ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string; terminationReason?: TerminationReason }> {
  // CONTRACT: spawnEngine NEVER throws. Any failure is reported as { ok:false, error }.
  try {
    return await spawnEngineInner(cmd, cfg, opts);
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// RunEvent normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a stdout/stderr line from a streaming engine subprocess to a RunEvent.
 * Handles `claude --output-format stream-json` JSONL and codex JSONL.
 * Lines that don't parse as JSON become kind:'raw' events.
 */
function normaliseEngineOutputLine(line: string, engineBin: string, ts: number): RunEvent {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return { kind: 'raw', ts, text: trimmed, rawLine: line };
  }
  try {
    const ev = JSON.parse(trimmed) as Record<string, unknown>;

    // claude stream-json: tool_use events carry name + input
    if (engineBin === 'claude') {
      // tool_use block start: { type: 'content_block_start', content_block: { type: 'tool_use', name: ... } }
      const cb = ev['content_block'] as Record<string, unknown> | undefined;
      if (ev['type'] === 'content_block_start' && cb?.['type'] === 'tool_use') {
        return { kind: 'tool_call', ts, toolName: String(cb['name'] ?? ''), rawLine: line };
      }
      // text delta: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
      const delta = ev['delta'] as Record<string, unknown> | undefined;
      if (ev['type'] === 'content_block_delta' && delta?.['type'] === 'text_delta') {
        return { kind: 'text', ts, text: String(delta['text'] ?? ''), rawLine: line };
      }
      // result summary: { type: 'result', ... } with usage
      if (ev['type'] === 'result') {
        const u = ev['usage'] as Record<string, unknown> | undefined;
        if (u && typeof u['input_tokens'] === 'number') {
          return {
            kind: 'usage', ts,
            text: `tokensIn=${u['input_tokens']} tokensOut=${u['output_tokens'] ?? 0}`,
            rawLine: line,
          };
        }
      }
    }

    // codex JSONL: tool_call events
    if (engineBin === 'codex') {
      if (ev['type'] === 'function_call' || ev['type'] === 'tool_call') {
        return { kind: 'tool_call', ts, toolName: String(ev['name'] ?? ev['function'] ?? ''), rawLine: line };
      }
    }

    // Generic usage line (any engine): any line with input_tokens + output_tokens
    const u = (ev['usage'] ?? ev['token_usage']) as Record<string, unknown> | undefined;
    if (u && typeof u['input_tokens'] === 'number') {
      return {
        kind: 'usage', ts,
        text: `tokensIn=${u['input_tokens']} tokensOut=${u['output_tokens'] ?? 0}`,
        rawLine: line,
      };
    }

    return { kind: 'raw', ts, text: trimmed, rawLine: line };
  } catch {
    return { kind: 'raw', ts, text: trimmed, rawLine: line };
  }
}

/**
 * Parse usage from the accumulated stdout lines (final pass after run completes).
 * For claude stream-json: reads the 'result' summary event.
 * For codex JSONL: scans for any usage line.
 * Returns undefined when no usage line found.
 */
function parseUsageFromLines(
  lines: string[],
  engineBin: string,
): { tokensIn: number; tokensOut: number } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>;
      // claude stream-json: final result event
      if (engineBin === 'claude' && ev['type'] === 'result') {
        const u = ev['usage'] as Record<string, unknown> | undefined;
        if (u && typeof u['input_tokens'] === 'number' && typeof u['output_tokens'] === 'number') {
          return { tokensIn: u['input_tokens'] as number, tokensOut: u['output_tokens'] as number };
        }
      }
      // generic / codex
      const u = (ev['usage'] ?? ev['token_usage'] ?? ev) as Record<string, unknown>;
      const tin = u['input_tokens'] ?? u['prompt_tokens'];
      const tout = u['output_tokens'] ?? u['completion_tokens'];
      if (typeof tin === 'number' && typeof tout === 'number') {
        return { tokensIn: tin, tokensOut: tout };
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

async function spawnEngineInner(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    launcher?: { bin: string; prefixArgs: string[] };
    onEvent?: (ev: RunEvent) => void;
    /** Grace period between SIGINT and SIGKILL during stall-stop (ms). Tests inject small values. */
    _stallGraceMs?: number;
  },
): Promise<{ ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string; terminationReason?: TerminationReason }> {
  // Apply phantom-exec wrap when enabled, installed, AND the cwd contains
  // .phantom.toml. Self-authenticating CLIs (claude, codex) run in sandbox
  // worktrees that have no .phantom.toml -- wrapping them is both unnecessary
  // and fatal (phantom hard-fails with "No .phantom.toml found"). Skip wrap
  // gracefully; the agent authenticates via its own ~/.claude / ~/.codex.
  // phantomWrap composes BEFORE the launcher -- the OS jail wraps the whole thing.
  let effective = cmd;
  const wrapCwd = cmd.cwd ?? process.cwd();
  if (cfg.phantom?.enabled && phantomInstalled() && phantomInitializedAt(wrapCwd)) {
    effective = phantomWrap(cmd, cfg);
  } else if (cfg.phantom?.enabled && phantomInstalled() && !phantomInitializedAt(wrapCwd)) {
    // Audit note: skipping phantom wrap -- no .phantom.toml in cwd (engine self-authenticates).
    process.stderr.write(`[ashlr] phantomWrap skipped for ${cmd.bin}: no .phantom.toml in ${wrapCwd}\n`);
  }

  // M52: apply the OS sandbox launcher when provided. The launcher wraps the
  // already-phantom-wrapped command so the jail contains the entire chain.
  // When absent => exactly v4 behavior (default-off parity guaranteed).
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

  // M236: streaming spawn — read stdout/stderr line-by-line, emit RunEvents.
  // The backstop timeoutMs is the outer runaway-cost safety net (default 2h).
  // Stall detection (idle / loop / no-diff) terminates early via SIGINT → grace → SIGKILL.
  return new Promise((resolve) => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const callerOnEvent = opts?.onEvent;
    let terminationReason: TerminationReason | undefined;
    let settled = false;

    function settle(
      result: { ok: boolean; output: string; usage?: { tokensIn: number; tokensOut: number }; error?: string; terminationReason?: TerminationReason },
    ): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const child = spawn(spawnBin, spawnArgs, {
      cwd: effective.cwd,
      env: childEnv,
      // pipe stdout + stderr for line reading; stdin closed (no input).
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ---------------------------------------------------------------------------
    // M236: Stall monitor — graceful-stop ladder owned here (we have child ref).
    // SIGINT → grace → SIGKILL. Grace period is short for tests, 15s in prod.
    // ---------------------------------------------------------------------------
    const stallGraceMs = opts?._stallGraceMs ?? 15_000;
    const monitor = attachStallMonitor(cfg, (reason) => {
      terminationReason = reason;
      // Graceful stop: SIGINT first, then SIGKILL after grace period.
      try { if (!child.killed) child.kill('SIGINT'); } catch { /* already dead */ }
      const killTimer = setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already dead */ }
      }, stallGraceMs);
      if (killTimer.unref) killTimer.unref();
    });

    // Backstop kill timer (runaway-cost safety net — fires only after timeoutMs).
    const backstopMs = opts?.timeoutMs ?? 5 * 60 * 1000;
    const backstopTimer = setTimeout(() => {
      terminationReason = 'backstop-timeout';
      monitor.detach();
      try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already dead */ }
    }, backstopMs);
    if (backstopTimer.unref) backstopTimer.unref();

    // ---------------------------------------------------------------------------
    // Line reader — stdout
    // ---------------------------------------------------------------------------
    let stdoutBuf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        stdoutLines.push(line);
        const ev = normaliseEngineOutputLine(line, cmd.bin, Date.now());
        monitor.onEvent(ev);
        if (callerOnEvent) callerOnEvent(ev);
      }
    });

    // ---------------------------------------------------------------------------
    // Line reader — stderr (collected for error messages; not fed to monitor)
    // ---------------------------------------------------------------------------
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        stderrLines.push(line);
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(backstopTimer);
      monitor.detach();
      settle({ ok: false, output: '', error: err.message, terminationReason });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(backstopTimer);
      monitor.detach();

      // Flush any remaining partial line buffers.
      if (stdoutBuf.trim()) {
        stdoutLines.push(stdoutBuf);
        const ev = normaliseEngineOutputLine(stdoutBuf, cmd.bin, Date.now());
        if (callerOnEvent) callerOnEvent(ev);
      }
      if (stderrBuf.trim()) stderrLines.push(stderrBuf);

      const exitedClean = code === 0 && signal === null;

      if (!exitedClean) {
        const errMsg =
          signal
            ? `killed by signal ${signal}`
            : (stderrLines.join('\n').trim() || `exit ${code ?? 'unknown'}`);
        settle({ ok: false, output: '', error: errMsg, terminationReason });
        return;
      }

      const rawOutput = stdoutLines.join('\n').trim();
      const usage = parseUsageFromLines(stdoutLines, cmd.bin);
      settle({ ok: true, output: rawOutput, usage });
    });
  });
}
