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
import { basename, join } from 'node:path';
import type { AshlrConfig, EngineId, EngineCommand } from '../types.js';
import { withToolEnv } from '../env-bridge.js';
import { resolveEngineSpec, compileArgv } from './engine-registry.js';
import { attachStallMonitor } from './run-monitor.js';
import type { TerminationReason } from './run-monitor.js';
import { recordClaudeRateLimitEventLine } from '../fabric/claude-rate-limit-event.js';

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

interface SpawnEngineOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  launcher?: { bin: string; prefixArgs: string[] };
  onEvent?: (ev: RunEvent) => void;
  /**
   * Caller ownership contract. Signaled POSIX runs own their invocation's
   * detached process group only. Descendants that deliberately escape it via
   * setsid()/a detached spawn are outside this termination scope.
   */
  signal?: AbortSignal;
  /** Grace period between SIGINT and SIGKILL. Tests inject small values. */
  _stallGraceMs?: number;
  /** Bounded pipe-drain period after SIGKILL. Tests inject small values. */
  _terminationDrainMs?: number;
  /** Hermetic process-ownership test seams; production callers leave these unset. */
  _platform?: NodeJS.Platform;
  _processKill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

interface SpawnEngineResult {
  ok: boolean;
  output: string;
  usage?: { tokensIn: number; tokensOut: number };
  error?: string;
  terminationReason?: TerminationReason;
  configRecoveryAttempts?: number;
}

function cancelledEngineResult(
  output = '',
  usage?: { tokensIn: number; tokensOut: number },
): SpawnEngineResult {
  const result: SpawnEngineResult = {
    ok: false,
    output,
    error: 'cancelled',
    terminationReason: 'cancelled',
  };
  if (usage) result.usage = usage;
  return result;
}

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
 *
 * TERMINATION SCOPE: cancellation owns only the invocation's detached POSIX
 * process group while the unreaped leader proves that group's identity. It
 * neither targets nor claims cleanup of descendants that deliberately escape
 * that group with setsid() or a detached spawn.
 */
export async function spawnEngine(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: SpawnEngineOptions,
): Promise<SpawnEngineResult> {
  // CONTRACT: spawnEngine NEVER throws. Any failure is reported as { ok:false, error }.
  try {
    if (opts?.signal?.aborted) return cancelledEngineResult();
    if (opts?.signal && (opts._platform ?? process.platform) === 'win32') {
      return {
        ok: false,
        output: '',
        error: 'AbortSignal-owned external execution is unsupported on Windows because complete process-tree ownership cannot be guaranteed',
        terminationReason: 'error-exit',
      };
    }
    const first = await spawnEngineInner(cmd, cfg, opts);
    const recovery = codexReasoningConfigRecovery(cmd, first);
    if (!recovery) return first;
    if (opts?.signal?.aborted) return cancelledEngineResult(first.output, first.usage);
    const recovered = await spawnEngineInner(recovery, cfg, opts);
    return { ...recovered, configRecoveryAttempts: 1 };
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function codexReasoningConfigRecovery(
  cmd: EngineCommand,
  result: {
    ok: boolean;
    output: string;
    usage?: { tokensIn: number; tokensOut: number };
    error?: string;
    terminationReason?: TerminationReason;
  },
): EngineCommand | null {
  if (result.ok || !result.error) return null;
  if (result.output.trim() || result.usage || result.terminationReason) return null;
  const bin = basename(cmd.bin).toLowerCase();
  if (bin !== 'codex' && bin !== 'codex.exe') return null;
  if (!/model_reasoning_effort/i.test(result.error)) return null;
  if (!/(?:unknown variant|expected one of|error loading config)/i.test(result.error)) return null;
  if (hasCodexConfigKey(cmd.args, 'model_reasoning_effort')) return null;

  const modelIndex = cmd.args.findIndex((arg) => arg === '--model' || arg === '-m');
  const modelArg = cmd.args.find((arg) => /^--model=/.test(arg));
  const model = (
    modelIndex >= 0 ? cmd.args[modelIndex + 1] : modelArg?.slice('--model='.length)
  )?.trim().toLowerCase();
  const supportsXHigh = model !== undefined && /^gpt-5\.(?:4|5|6)(?:$|[-.])/.test(model);
  const effort = supportsXHigh ? 'xhigh' : 'medium';
  const execIndex = cmd.args.indexOf('exec');
  const insertAt = execIndex >= 0 ? execIndex + 1 : 0;
  const args = [...cmd.args];
  args.splice(insertAt, 0, '-c', `model_reasoning_effort="${effort}"`);
  return { ...cmd, args };
}

function hasCodexConfigKey(args: string[], expectedKey: string): boolean {
  const assignments: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-c' || arg === '--config') {
      assignments.push(args[i + 1] ?? '');
      i++;
    } else if (arg.startsWith('--config=')) {
      assignments.push(arg.slice('--config='.length));
    } else if (arg.startsWith('-c=')) {
      assignments.push(arg.slice('-c='.length));
    } else if (arg.startsWith('-c') && arg.length > 2) {
      assignments.push(arg.slice(2));
    }
  }
  return assignments.some((assignment) => {
    const separator = assignment.indexOf('=');
    if (separator < 0) return false;
    return assignment.slice(0, separator).trim() === expectedKey;
  });
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

function isClaudeEngineBin(bin: string): boolean {
  const base = basename(bin);
  return base === 'claude' || base === 'claude.exe';
}

async function spawnEngineInner(
  cmd: EngineCommand,
  cfg: AshlrConfig,
  opts?: SpawnEngineOptions,
): Promise<SpawnEngineResult> {
  if (opts?.signal?.aborted) return cancelledEngineResult();
  const platform = opts?._platform ?? process.platform;
  if (opts?.signal && platform === 'win32') {
    return {
      ok: false,
      output: '',
      error: 'AbortSignal-owned external execution is unsupported on Windows because complete process-tree ownership cannot be guaranteed',
      terminationReason: 'error-exit',
    };
  }
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
    let stdoutBuf = '';
    let stderrBuf = '';
    const callerOnEvent = opts?.onEvent;
    const captureClaudeRateLimitEvents = isClaudeEngineBin(cmd.bin);
    const ownsProcessGroup = opts?.signal !== undefined && platform !== 'win32';
    const processKill = opts?._processKill ?? ((pid: number, signal: NodeJS.Signals | 0) => {
      process.kill(pid, signal);
    });
    let terminationReason: TerminationReason | undefined;
    let settled = false;
    let terminationRequested = false;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let backstopTimer: ReturnType<typeof setTimeout> | null = null;
    let childClosed = false;
    let leaderExited = false;
    let hardKillSent = false;
    let groupAuthorityFailure: string | undefined;

    function captureClaudeRateLimitLine(line: string): void {
      if (!captureClaudeRateLimitEvents) return;
      recordClaudeRateLimitEventLine(line);
    }

    function settle(result: SpawnEngineResult): void {
      if (settled) return;
      settled = true;
      monitor.detach();
      if (backstopTimer !== null) clearTimeout(backstopTimer);
      if (escalationTimer !== null) clearTimeout(escalationTimer);
      if (drainTimer !== null) clearTimeout(drainTimer);
      opts?.signal?.removeEventListener('abort', onAbort);
      releaseProcessResources();
      resolve(result);
    }

    const child = spawn(spawnBin, spawnArgs, {
      cwd: effective.cwd,
      env: childEnv,
      // pipe stdout + stderr for line reading; stdin closed (no input).
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(ownsProcessGroup ? { detached: true } : {}),
    });

    // A detached POSIX child is its process-group leader, so its invocation-local
    // PID is also the only PGID we are authorized to signal. The group can outlive
    // its leader, so retain this invocation-scoped authority until the group is
    // proven absent or the bounded termination protocol finishes.
    let ownedPgid = ownsProcessGroup && typeof child.pid === 'number' && child.pid > 0
      ? child.pid
      : null;

    function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
      if (timer.unref) timer.unref();
    }

    function revokeOwnedPgid(): void {
      ownedPgid = null;
    }

    function releaseProcessResources(): void {
      // A descendant can inherit the leader's pipe writers. Destroy our readers
      // and unref the ChildProcess so those inherited descriptors cannot keep the
      // daemon alive after this invocation's bounded settlement deadline.
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (typeof child.stdout?.destroy === 'function') child.stdout.destroy();
      if (typeof child.stderr?.destroy === 'function') child.stderr.destroy();
      child.removeAllListeners();
      child.on('error', () => { /* ignore events after bounded settlement */ });
      if (typeof child.unref === 'function') child.unref();
    }

    function capturedOutputAndUsage(): {
      output: string;
      usage?: { tokensIn: number; tokensOut: number };
    } {
      const lines = stdoutBuf.trim() ? [...stdoutLines, stdoutBuf] : stdoutLines;
      const output = lines.join('\n').trim();
      const usage = parseUsageFromLines(lines, cmd.bin);
      return usage ? { output, usage } : { output };
    }

    function processSignalError(err: unknown, operation: string): 'absent' | 'failed' {
      const code = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code ?? '')
        : '';
      if (code === 'ESRCH') {
        revokeOwnedPgid();
        return 'absent';
      }
      groupAuthorityFailure = `${operation} failed${code ? ` (${code})` : ''}: ${err instanceof Error ? err.message : String(err)}`;
      return 'failed';
    }

    function leaderIdentityIsLive(): boolean {
      // Before Node reaps the leader, its PID cannot be reused. Once exitCode or
      // signalCode is populated (or `exit` fires), the numeric PGID alone is not
      // sufficient authorization for any delayed group operation.
      return !leaderExited && child.exitCode === null && child.signalCode === null;
    }

    function failUnverifiableGroupIdentity(operation: string): 'failed' {
      groupAuthorityFailure ??= `${operation} refused: process-group leader identity is no longer provable`;
      return 'failed';
    }

    function signalOwnedGroup(signal: NodeJS.Signals): 'sent' | 'absent' | 'failed' {
      if (ownedPgid === null) return 'absent';
      if (!leaderIdentityIsLive()) return failUnverifiableGroupIdentity(`${signal} process-group signal`);
      try {
        processKill(-ownedPgid, signal);
        return 'sent';
      } catch (err) {
        return processSignalError(err, `${signal} process-group signal`);
      }
    }

    function probeOwnedGroup(): 'present' | 'absent' | 'failed' {
      if (ownedPgid === null) return 'absent';
      if (!leaderIdentityIsLive()) return failUnverifiableGroupIdentity('process-group exit probe');
      try {
        processKill(-ownedPgid, 0);
        return 'present';
      } catch (err) {
        return processSignalError(err, 'process-group exit probe');
      }
    }

    function settleAtTerminationDeadline(groupState?: 'present' | 'absent' | 'failed'): void {
      const captured = capturedOutputAndUsage();
      const observedGroupState = groupState ?? (
        groupAuthorityFailure
          ? 'failed'
          : (ownsProcessGroup ? probeOwnedGroup() : (childClosed ? 'absent' : 'present'))
      );
      if (groupAuthorityFailure || observedGroupState === 'failed') {
        settle({
          ok: false,
          ...captured,
          error: `termination authority lost: ${groupAuthorityFailure ?? 'process-group state could not be authenticated'}`,
          terminationReason: 'error-exit',
        });
        return;
      }
      if (observedGroupState === 'present') {
        settle({
          ok: false,
          ...captured,
          error: 'termination deadline elapsed with process-group exit unconfirmed',
          terminationReason: 'error-exit',
        });
        return;
      }
      if (!childClosed) {
        settle({
          ok: false,
          ...captured,
          error: 'termination deadline elapsed with process and stdio closure unconfirmed',
          terminationReason: 'error-exit',
        });
        return;
      }
      if (terminationReason === 'cancelled') {
        settle(cancelledEngineResult(captured.output, captured.usage));
        return;
      }
      settle({
        ok: false,
        ...captured,
        error: `termination deadline elapsed (${terminationReason ?? 'unknown'})`,
        terminationReason,
      });
    }

    function beginTerminationDrain(): void {
      if (settled || drainTimer !== null) return;
      const drainMs = opts?._terminationDrainMs ?? 100;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        settleAtTerminationDeadline();
      }, drainMs);
      // Deliberately referenced: this is the final bounded ownership deadline.
    }

    const monitor = attachStallMonitor(cfg, (reason) => requestTermination(reason, true));

    function requestTermination(reason: TerminationReason, graceful: boolean): void {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      monitor.detach();

      const stallGraceMs = opts?._stallGraceMs ?? 15_000;
      if (ownsProcessGroup) {
        const firstSignal = graceful ? 'SIGINT' : 'SIGKILL';
        const firstResult = signalOwnedGroup(firstSignal);
        if (!graceful) hardKillSent = firstResult === 'sent';
        if (firstResult === 'failed') {
          beginTerminationDrain();
          return;
        }
        if (!graceful) {
          beginTerminationDrain();
          return;
        }
        // The leader may exit while descendants remain in its detached group.
        // Keep the PGID authority and escalate the original group at deadline.
        escalationTimer = setTimeout(() => {
          escalationTimer = null;
          const killResult = signalOwnedGroup('SIGKILL');
          hardKillSent = killResult === 'sent';
          beginTerminationDrain();
        }, stallGraceMs);
        return;
      }

      if (!graceful) {
        try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already dead */ }
        hardKillSent = true;
        beginTerminationDrain();
        return;
      }
      try { if (!child.killed) child.kill('SIGINT'); } catch { /* already dead */ }
      escalationTimer = setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch { /* already dead */ }
        hardKillSent = true;
        beginTerminationDrain();
      }, stallGraceMs);
    }

    function onAbort(): void {
      requestTermination('cancelled', true);
    }

    // ---------------------------------------------------------------------------
    // M236: Stall monitor — graceful-stop ladder owned here (we have child ref).
    // SIGINT → grace → SIGKILL. Grace period is short for tests, 15s in prod.
    // ---------------------------------------------------------------------------
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts?.signal?.aborted) onAbort();

    // Backstop kill timer (runaway-cost safety net — fires only after timeoutMs).
    const backstopMs = opts?.timeoutMs ?? 5 * 60 * 1000;
    backstopTimer = setTimeout(() => requestTermination('backstop-timeout', false), backstopMs);
    unrefTimer(backstopTimer);

    // ---------------------------------------------------------------------------
    // Line reader — stdout
    // ---------------------------------------------------------------------------
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        stdoutLines.push(line);
        captureClaudeRateLimitLine(line);
        const ev = normaliseEngineOutputLine(line, cmd.bin, Date.now());
        monitor.onEvent(ev);
        if (callerOnEvent) callerOnEvent(ev);
      }
    });

    // ---------------------------------------------------------------------------
    // Line reader — stderr (collected for error messages; not fed to monitor)
    // ---------------------------------------------------------------------------
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        stderrLines.push(line);
        captureClaudeRateLimitLine(line);
      }
    });

    child.on('error', (err: Error) => {
      monitor.detach();
      if (terminationRequested && ownsProcessGroup) {
        // A late ChildProcess error does not prove that the detached group is
        // gone. In particular, never let it erase a prior EPERM/authority
        // failure or downgrade that failure to ordinary cancellation.
        if (groupAuthorityFailure) return;
        const groupState = probeOwnedGroup();
        if (groupState === 'failed' || groupState === 'absent' || hardKillSent) {
          beginTerminationDrain();
        }
        return;
      }
      revokeOwnedPgid();
      const captured = capturedOutputAndUsage();
      if (terminationReason === 'cancelled') {
        settle(cancelledEngineResult(captured.output, captured.usage));
      } else {
        settle({ ok: false, ...captured, error: err.message, terminationReason });
      }
    });

    child.on('exit', () => {
      leaderExited = true;
      if (!terminationRequested || !ownsProcessGroup) return;
      if (hardKillSent) {
        // SIGKILL was authorized while the unreaped leader still proved the
        // invocation PGID. Do not perform any later numeric-PGID operation.
        revokeOwnedPgid();
        return;
      }
      failUnverifiableGroupIdentity('delayed process-group escalation');
      if (escalationTimer !== null) {
        clearTimeout(escalationTimer);
        escalationTimer = null;
      }
      beginTerminationDrain();
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      monitor.detach();
      childClosed = true;

      // Flush any remaining partial line buffers.
      if (stdoutBuf.trim()) {
        stdoutLines.push(stdoutBuf);
        captureClaudeRateLimitLine(stdoutBuf);
        const ev = normaliseEngineOutputLine(stdoutBuf, cmd.bin, Date.now());
        if (callerOnEvent) callerOnEvent(ev);
      }
      if (stderrBuf.trim()) {
        stderrLines.push(stderrBuf);
        captureClaudeRateLimitLine(stderrBuf);
      }
      stdoutBuf = '';
      stderrBuf = '';

      const exitedClean = code === 0 && signal === null;
      const rawOutput = stdoutLines.join('\n').trim();
      const usage = parseUsageFromLines(stdoutLines, cmd.bin);

      if (terminationRequested && ownsProcessGroup) {
        const groupState = probeOwnedGroup();
        if (groupState === 'absent') {
          if (terminationReason === 'cancelled') {
            settle(cancelledEngineResult(rawOutput, usage));
          } else {
            settle({
              ok: false,
              output: rawOutput,
              usage,
              error: signal ? `killed by signal ${signal}` : `terminated (${terminationReason ?? 'unknown'})`,
              terminationReason,
            });
          }
        } else if (groupState === 'failed') {
          settleAtTerminationDeadline(groupState);
        } else if (hardKillSent) {
          beginTerminationDrain();
        }
      } else if (terminationReason === 'cancelled') {
        settle(cancelledEngineResult(rawOutput, usage));
      } else if (!exitedClean) {
        revokeOwnedPgid();
        const errMsg =
          signal
            ? `killed by signal ${signal}`
            : (stderrLines.join('\n').trim() || `exit ${code ?? 'unknown'}`);
        settle({ ok: false, output: rawOutput, usage, error: errMsg, terminationReason });
      } else {
        revokeOwnedPgid();
        settle({ ok: true, output: rawOutput, usage });
      }
    });
  });
}
