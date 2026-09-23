/**
 * Where the serving runtime's launch parameters and base URL come from.
 *
 * This module is the SINGLE place that answers "which llama-server are we
 * talking about?", so `engines.ts` (dispatch), `providers.ts` (liveness) and
 * the supervisor cannot drift into pointing at different ports. Two
 * independent answers to that question is the same failure mode as two
 * independent slot counts: everything looks fine until traffic goes somewhere
 * nobody is listening.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_LOCAL_MODEL_TAG } from '../../run/model-catalog.js';
import { readOwnershipRecord } from './record.js';
import type { AshlrConfig } from '../../types.js';
import type { LlamaRuntimeConfig } from './types.js';

/** llama-server's own default port, and the historical hub default. */
export const DEFAULT_LLAMA_PORT = 8080;

/** Loopback only by default: a local fleet has no business on the LAN. */
export const DEFAULT_LLAMA_HOST = '127.0.0.1';

/**
 * Four slots is what docs/LOCAL-FLEET.md measured on this machine (four
 * concurrent completions finishing together at ~9.0s each). Raising it raises
 * KV-cache memory linearly, and past the point where the cache no longer fits,
 * throughput collapses rather than degrading. This is a DEFAULT REQUEST — the
 * live server's `/props.total_slots` remains the source of truth.
 */
export const DEFAULT_LLAMA_SLOTS = 4;

/**
 * Total context, SHARED across slots — llama-server divides `-c` by `--parallel`,
 * so this is not the per-agent window. At the default 4 slots each agent gets
 * 65,536.
 *
 * The old default of 65,536 gave each agent 16,384, and a Claude Code system
 * prompt measured 23,310 tokens on this machine. The agent's own instructions
 * did not fit in its context before a single turn began, which is a failure
 * with no useful error attached.
 *
 * 262,144 is Qwen3.8 27B's native trained context.
 *
 * CORRECTION. This comment previously claimed raising `-c` from 131,072 to
 * 262,144 cost no extra memory, citing 46.2 GB falling to 43.4 GB. That
 * comparison was invalid: the 46.2 GB reading came from a process that had been
 * serving for hours with a populated cache, the 43.4 GB from one measured
 * seconds after startup with an empty one. Warm against cold, no control.
 *
 * The arithmetic contradicts it. From the model card — 4 KV heads, 256 head
 * dim, fp16 K and V, and 16 of 64 layers carrying a full KV cache — the cache
 * costs 64 KiB per token: 8 GiB at 131,072 and 16 GiB at 262,144. The same
 * process later measured 47.0 GB resident, consistent with the cache filling.
 *
 * So the honest statement is: this costs up to ~8 GiB more than 131,072 once
 * the cache is populated, which a 128 GB machine carries comfortably. The 48
 * linear-attention layers do make it far cheaper than a full-attention model of
 * this size would be, but "free" was wrong.
 *
 * Verified separately and still true: a real agent turn at this setting made
 * the correct edit with the prefix cache reusing (23,301 cold, then 56 and 306
 * tokens).
 *
 * Operators on less memory override it with `--ctx` or
 * `models.llamaServer.contextSize`.
 */
export const DEFAULT_LLAMA_CONTEXT = 262_144;

/**
 * Default port for the Anthropic normalising proxy (anthropic-proxy.ts).
 *
 * One above llama-server's own default, so the pair is obvious at a glance in
 * `lsof`. It is a SEPARATE listener rather than a path on llama-server because
 * llama-server is a foreign binary we do not patch, and because the OpenAI
 * lane must keep reaching it byte-for-byte — see `resolveLlamaServerBaseUrl`
 * (unchanged, still llama-server) versus `resolveLocalAnthropicBaseUrl`.
 */
export const DEFAULT_ANTHROPIC_PROXY_PORT = 8081;

/** The historical base URL, pinned by test/m144.llama-server.test.ts. */
export const LEGACY_DEFAULT_BASE_URL = `http://localhost:${DEFAULT_LLAMA_PORT}/v1`;

/** Loose read of `cfg.models.llamaServer` without widening the config type. */
interface LlamaServerConfigSection {
  baseUrl?: unknown;
  /** Operator override for the Anthropic lane's base URL. Always wins. */
  anthropicBaseUrl?: unknown;
  host?: unknown;
  /** Persisted opt-in required before `host` may leave loopback. */
  allowNonLoopback?: unknown;
  port?: unknown;
  /** Port for the Anthropic normalising proxy. */
  anthropicPort?: unknown;
  slots?: unknown;
  context?: unknown;
  model?: unknown;
  modelPath?: unknown;
  bin?: unknown;
  extraArgs?: unknown;
  /** Per-request defaults for the local AGENT lane. See {@link resolveLocalAgentDefaults}. */
  agentDefaults?: unknown;
}

/**
 * The reasoning efforts Qwen3.8's chat template will actually accept.
 *
 * MEASURED against the live template, with a deliberately bogus value as a
 * control (both behave identically, which is how we know the check is real):
 *
 *   reasoning_effort=xhigh   -> 200, and it is the template's OWN default
 *   reasoning_effort=medium  -> 200
 *   reasoning_effort=low     -> 200
 *   reasoning_effort=high    -> 500  raise_exception('Unexpected reasoning effort high')
 *   reasoning_effort=bogus   -> 500  (the control)
 *
 * `high` is the trap: it is the spelling every other vendor uses, it is what
 * Claude Code itself puts in `output_config.effort`, and it is fatal here —
 * a template exception fires BEFORE inference, so the turn dies with no
 * partial output. Hence a closed list rather than a string passthrough.
 */
export const LOCAL_AGENT_REASONING_EFFORTS = ['low', 'medium', 'xhigh'] as const;
export type LocalAgentReasoningEffort = (typeof LOCAL_AGENT_REASONING_EFFORTS)[number];

/**
 * Per-request defaults the Anthropic lane applies when the CLIENT DID NOT.
 *
 * `null` everywhere means "send what the client sent", which is today's
 * behaviour exactly. Nothing here is defaulted to a non-null value on
 * purpose — see the note on {@link resolveLocalAgentDefaults}.
 */
export interface LocalAgentRequestDefaults {
  readonly reasoningEffort: LocalAgentReasoningEffort | null;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly topK: number | null;
}

/** Every field null — "change nothing", the shipping default. */
export const NO_LOCAL_AGENT_DEFAULTS: LocalAgentRequestDefaults = {
  reasoningEffort: null, temperature: null, topP: null, topK: null,
};

/** A finite number in range, or undefined. Never throws on junk. */
function num(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * Resolve the local agent lane's per-request defaults.
 *
 * WHY THESE ARE ALL OFF BY DEFAULT — the measurements, so the next person
 * does not have to re-derive them.
 *
 * REASONING EFFORT is the largest lever measured on this runtime, and it is
 * currently unreachable. The template defaults to `xhigh`; Claude Code's own
 * `output_config.effort` is dropped on the floor by llama-server (verified:
 * sending it changes nothing), so no caller can ask for less. Holding
 * sampling at greedy and varying only the effort, on identical tool-calling
 * prompts, the DECODE TOKEN COUNT for the same correct answer was:
 *
 *   task              xhigh   medium   low   thinking-off
 *   verbatim_sha       536      218    141        64
 *   verbatim_oddpath    78       59     59        48
 *
 * Decode, not prompt processing, is what a warm agent turn spends its time
 * on: a measured hard-tool-call turn was 69.7s wall of which 65s was decode
 * and ~1s was prompt (473 tokens against a warm prefix cache). So `low` is
 * worth roughly 3.8x on the decode-bound part of a turn.
 *
 * It is still NOT the default here. Every task in that battery is a SINGLE
 * tool call, and single-call accuracy is not evidence about multi-step
 * debugging — which is the work the local lane actually has to do. Shipping a
 * global reduction in a reasoning model's thinking on single-call evidence is
 * the kind of over-claim this module's history is made of. The mechanism is
 * here, the numbers are here, and the operator chooses:
 *
 *   "models": { "llamaServer": { "agentDefaults": { "reasoningEffort": "low" } } }
 *
 * SAMPLING is off for a different reason: it was measured and REJECTED. The
 * hypothesis was that llama-server's chat-tuned defaults (temperature 1.0,
 * top_k 20, top_p 0.95, min_p 0.05 — taken from the GGUF's own metadata)
 * corrupt tool calls. Across the batteries run against the live runtime the
 * shipping default did not drop a single call that greedy decoding kept. The
 * knob exists for an operator with a different model; it is not a fix,
 * because no defect was found to fix.
 *
 * `min_p` is deliberately absent even though the server honours it: it is not
 * part of the Anthropic request schema, and this lane's carrier is
 * `/v1/messages`. Offering a field that would be dropped in transit is worse
 * than not offering it — see the reasoning-effort note in anthropic-shim.ts
 * for the measurement that made that failure mode concrete.
 */
export function resolveLocalAgentDefaults(cfg?: AshlrConfig): LocalAgentRequestDefaults {
  const raw = readSection(cfg).agentDefaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return NO_LOCAL_AGENT_DEFAULTS;
  const section = raw as Record<string, unknown>;

  const effortRaw = str(section['reasoningEffort']);
  const reasoningEffort =
    effortRaw !== undefined
    && (LOCAL_AGENT_REASONING_EFFORTS as readonly string[]).includes(effortRaw)
      ? (effortRaw as LocalAgentReasoningEffort)
      : null;

  return {
    reasoningEffort,
    temperature: num(section['temperature'], 0, 2) ?? null,
    topP: num(section['topP'], 0, 1) ?? null,
    topK: int(section['topK'], 1, 1_000) ?? null,
  };
}

function readSection(cfg?: AshlrConfig): LlamaServerConfigSection {
  const models = (cfg as unknown as Record<string, unknown> | undefined)?.['models'];
  if (typeof models !== 'object' || models === null) return {};
  const section = (models as Record<string, unknown>)['llamaServer'];
  if (typeof section !== 'object' || section === null) return {};
  return section as LlamaServerConfigSection;
}

/** Non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Positive integer within bounds, or undefined. Never throws on junk. */
function int(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

/** Is this host name one that only reaches this machine? */
export function isLoopbackHost(host: string): boolean {
  const normalised = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalised === 'localhost' || normalised === '127.0.0.1' || normalised === '::1';
}

/** A bind host after the loopback gate, plus what was refused (or null). */
export interface GatedBindHost {
  host: string;
  /** The requested host when it was refused, so the refusal can be reported. */
  downgradedFrom: string | null;
}

/**
 * THE bind-host rule, in one place.
 *
 * Neither llama-server nor the Anthropic proxy in front of it has any
 * authentication: whoever reaches the port can run inference, read `/props`,
 * and read every slot's prompt via `/slots`. Leaving loopback therefore
 * requires the PERSISTED opt-in `models.llamaServer.allowNonLoopback: true` —
 * an environment variable, a CLI flag or a function argument must never be
 * able to do it on its own, because `local-runtime install` freezes the
 * resolved argv into a `KeepAlive` launchd job that returns at every login.
 *
 * Anything else is silently downgraded back to loopback, and the downgrade is
 * RETURNED rather than swallowed so callers can say so out loud.
 */
export function gateBindHost(requested: string, allowNonLoopback: boolean): GatedBindHost {
  if (isLoopbackHost(requested) || allowNonLoopback) {
    return { host: requested, downgradedFrom: null };
  }
  return { host: DEFAULT_LLAMA_HOST, downgradedFrom: requested };
}

/** Is `models.llamaServer.allowNonLoopback` genuinely set to `true`? */
export function allowsNonLoopback(cfg?: AshlrConfig): boolean {
  return readSection(cfg).allowNonLoopback === true;
}

/**
 * Resolve llama-server's binary path.
 *
 * Absolute, because a bare name does not survive `sandbox-exec`'s `execvp`,
 * and because the ownership record compares argv against this exact string.
 */
export function resolveLlamaServerBin(configured?: string): string | null {
  const explicit = configured ?? str(process.env['LLAMA_SERVER_BIN']);
  if (explicit) {
    if (explicit.includes('/')) return existsSync(explicit) ? explicit : null;
    return whichBin(explicit);
  }
  return whichBin('llama-server');
}

function whichBin(bin: string): string | null {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(probe, [bin], { encoding: 'utf8', timeout: 5_000 })
      .trim()
      .split('\n')[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Merge config, environment and defaults into the launch parameters.
 *
 * Precedence, highest first: environment (an operator overriding one run),
 * then `cfg.models.llamaServer`, then the measured defaults above. `binPath`
 * is null when llama-server is not installed; the supervisor turns that into a
 * legible refusal rather than an ENOENT from `spawn`.
 */
export function resolveLlamaRuntimeConfig(cfg?: AshlrConfig): LlamaRuntimeConfig {
  const section = readSection(cfg);

  // BIND HOST. llama-server has no authentication whatsoever: whoever reaches
  // the port can run inference, read `/props`, and read every slot's prompt via
  // `/slots`. A single environment variable must therefore NOT be able to put
  // it on the LAN — especially not via `local-runtime install`, which writes
  // the resolved argv into a `KeepAlive` launchd job that returns at every
  // login. Widening the bind requires the PERSISTED opt-in
  // `models.llamaServer.allowNonLoopback: true`, which an operator has to
  // write into their config by hand; anything else is silently downgraded back
  // to loopback and the downgrade is reported rather than swallowed.
  const requestedHost =
    str(process.env['ASHLR_LOCAL_RUNTIME_HOST']) ?? str(section.host) ?? DEFAULT_LLAMA_HOST;
  const { host, downgradedFrom: hostDowngradedFrom } = gateBindHost(
    requestedHost,
    section.allowNonLoopback === true,
  );
  const port =
    int(process.env['ASHLR_LOCAL_RUNTIME_PORT'], 1, 65_535) ??
    int(section.port, 1, 65_535) ??
    DEFAULT_LLAMA_PORT;
  const anthropicPort =
    int(process.env['ASHLR_LOCAL_RUNTIME_ANTHROPIC_PORT'], 1, 65_535) ??
    int(section.anthropicPort, 1, 65_535) ??
    DEFAULT_ANTHROPIC_PROXY_PORT;
  const slots =
    int(process.env['ASHLR_LOCAL_RUNTIME_SLOTS'], 1, 64) ??
    int(section.slots, 1, 64) ??
    DEFAULT_LLAMA_SLOTS;
  const context =
    int(process.env['ASHLR_LOCAL_RUNTIME_CONTEXT'], 512, 4_194_304) ??
    int(section.context, 512, 4_194_304) ??
    DEFAULT_LLAMA_CONTEXT;
  const modelRef =
    str(process.env['ASHLR_LOCAL_RUNTIME_MODEL']) ??
    str(section.model) ??
    DEFAULT_LOCAL_MODEL_TAG;
  const modelPath =
    str(process.env['ASHLR_LOCAL_RUNTIME_MODEL_PATH']) ?? str(section.modelPath) ?? null;

  const extraArgs = Array.isArray(section.extraArgs)
    ? section.extraArgs.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
    : [];

  return {
    host,
    hostDowngradedFrom,
    port,
    anthropicPort,
    slots,
    context,
    modelRef,
    modelPath,
    binPath: resolveLlamaServerBin(str(section.bin)),
    extraArgs,
  };
}

/**
 * Build the exact argv (excluding argv[0]) for a launch.
 *
 * PURE — no spawn, no probe — so the flags are pinned by unit tests rather
 * than discovered from a running process.
 */
export function buildLlamaServerArgs(
  runtime: Pick<LlamaRuntimeConfig, 'host' | 'port' | 'slots' | 'context' | 'extraArgs'>,
  modelPath: string,
): string[] {
  return [
    '-m',
    modelPath,
    '--host',
    runtime.host,
    '--port',
    String(runtime.port),
    '--parallel',
    String(runtime.slots),
    '-c',
    String(runtime.context),
    // Continuous batching across slots is the entire reason this runtime
    // exists; prompt caching keeps an agent loop from re-processing its whole
    // growing transcript every turn.
    '--cont-batching',
    '--cache-prompt',
    // MEASURED, not assumed: without this flag `GET /metrics` answers
    //
    //   501 {"error":{"code":501,"message":"This server does not support
    //        metrics endpoint. Start it with `--metrics`", ...}}
    //
    // — llama-server's own instruction. `/props` and `/slots` answer fine, so
    // a runbook that says "read /metrics" looks correct until someone
    // actually does it, which is the worst kind of gap. It is the only
    // endpoint that reports CUMULATIVE prompt/decode token counts and
    // per-request timing histograms; `/slots` is a point-in-time view and
    // cannot answer "how much of this session went into reprocessed prompt",
    // which is exactly the question the prefix-cache bug turned on.
    //
    // The endpoint is read-only counters and inherits the same loopback gate
    // as everything else here. NOTE the deliberate asymmetry with `--props`,
    // which is NOT passed: that one enables POST /props, i.e. mutating global
    // sampling on a live launchd-managed server from anything that can reach
    // the port. Observability yes, remote mutation no.
    '--metrics',
    // CORS. llama-server's default is `--cors-origins *`, and it announces the
    // consequence itself at startup: "CORS is set to allow all origins ('*')
    // and no API key is set / this can be a security risk (cross-origin
    // attacks)". That warning is correct and it is not theoretical. MEASURED
    // against the live loopback server with its shipping defaults:
    //
    //   GET /props, no Origin (control)      -> Access-Control-Allow-Origin: (empty)
    //   GET /props, Origin: https://evil.example
    //                                        -> Access-Control-Allow-Origin: https://evil.example
    //   OPTIONS /v1/messages, same Origin    -> Allow-Origin: https://evil.example
    //                                           Allow-Credentials: true
    //                                           Allow-Methods: GET, POST, DELETE, OPTIONS
    //                                           Allow-Headers: *
    //
    // The origin is ECHOED, so any page the operator visits in any browser can
    // read the response: run inference on this machine, and read `/slots`,
    // which carries the prompts of whatever the local lane is currently
    // processing. Binding to loopback does not help — the browser is already
    // on loopback. It mattered less when this was hand-started for an hour at
    // a time; it is a KeepAlive launchd job now, up from login and restarted
    // on crash.
    //
    // `localhost` is llama-server's own special value: reflect the Origin only
    // when it is localhost. It closes the internet-origin hole completely.
    //
    // WHY THIS CANNOT BREAK THE LANE, measured rather than assumed: CORS is a
    // browser mechanism and applies only to requests carrying an `Origin`
    // header. A capture server put in llama-server's place recorded every
    // request a real `claude` turn makes through this proxy — `HEAD
    // /api/hello` and two `POST /v1/messages?beta=true` — and NONE of them
    // carried an Origin. Nothing in the hub's own web UI fetches this port
    // from a browser either; it renders status the hub server probed
    // server-side. So no client of this runtime engages CORS at all.
    //
    // NOT `--api-key`, deliberately, and this was measured too. The same
    // capture shows the lane sends `authorization: Bearer ollama` — the
    // literal value of ANTHROPIC_AUTH_TOKEN that verse/adapters/claude.ts
    // sets. llama-server's `--api-key` checks exactly that header, so turning
    // it on would 401 every turn unless the proxy rewrote the header on the
    // way through. That is a real change to the request path, not a flag, and
    // it is not worth shipping untested alongside this one.
    '--cors-origins',
    'localhost',
    ...runtime.extraArgs,
  ];
}

/** `http://host:port` for a resolved runtime. IPv6 hosts are bracketed. */
export function originFor(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/**
 * The base URL a runtime record implies, or null when the default already
 * reaches it.
 *
 * Pure, and separated from {@link resolveLlamaServerBaseUrl} so the rule is
 * unit-testable without a record on disk. A record for loopback:8080 returns
 * null deliberately: the documented default already points there, and
 * rewriting `localhost` to `127.0.0.1` would change a published default
 * spelling for no behavioural gain.
 */
export function baseUrlFromRecord(record: { host: string; port: number } | null): string | null {
  if (record === null) return null;
  if (record.port === DEFAULT_LLAMA_PORT && isLoopbackHost(record.host)) return null;
  return `${originFor(record.host, record.port)}/v1`;
}

/**
 * Resolve the OpenAI-compatible base URL the fleet should dispatch to.
 *
 * Precedence:
 *   1. `cfg.models.llamaServer.baseUrl`   — operator override, always wins
 *   2. `LLAMA_SERVER_BASE_URL`            — per-process override
 *   3. the ownership record, but ONLY when it names something the default
 *      would miss (a non-8080 port, or a non-loopback host). A record for
 *      loopback:8080 changes nothing, and deferring to it there would break
 *      the documented default spelling for no behavioural gain.
 *   4. `http://localhost:8080/v1`         — llama-server's own default
 */
export function resolveLlamaServerBaseUrl(cfg?: AshlrConfig): string {
  const section = readSection(cfg);
  const fromCfg = str(section.baseUrl);
  if (fromCfg) return fromCfg;

  const fromEnv = str(process.env['LLAMA_SERVER_BASE_URL']);
  if (fromEnv) return fromEnv;

  return baseUrlFromRecord(readOwnershipRecord()) ?? LEGACY_DEFAULT_BASE_URL;
}

/**
 * Resolve the base URL for LOCAL **Anthropic** (`/v1/messages`) traffic.
 *
 * This is deliberately NOT {@link resolveLlamaServerBaseUrl}. Claude Code
 * cannot talk to llama-server directly: the CLI sends a system-role turn
 * second in `messages`, and Qwen3.8's template answers
 * `Jinja Exception: System message must be at the beginning` before inference.
 * `anthropic-proxy.ts` is the listener that fixes that on the way through, so
 * the Anthropic lane must point at the PROXY while the OpenAI-compatible lane
 * keeps pointing straight at llama-server. Two resolvers, because they are two
 * different endpoints — collapsing them is how one lane silently loses its
 * normalisation.
 *
 * Precedence mirrors {@link resolveLlamaServerBaseUrl} exactly:
 *   1. `cfg.models.llamaServer.anthropicBaseUrl` — operator override, always wins
 *   2. `LLAMA_SERVER_ANTHROPIC_BASE_URL`         — per-process override
 *   3. the resolved proxy host/port
 *
 * Note what is absent: there is no ownership-record step. The record describes
 * llama-server, not the proxy, and inferring one endpoint from the other is
 * precisely the drift this module exists to prevent.
 */
export function resolveLocalAnthropicBaseUrl(cfg?: AshlrConfig): string {
  const section = readSection(cfg);
  const fromCfg = str(section.anthropicBaseUrl);
  if (fromCfg) return fromCfg;

  const fromEnv = str(process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL']);
  if (fromEnv) return fromEnv;

  const runtime = resolveLlamaRuntimeConfig(cfg);
  return `${originFor(runtime.host, runtime.anthropicPort)}/v1`;
}

/** Scheme + authority of the resolved base URL, with `/v1` stripped. */
export function resolveLlamaServerOrigin(cfg?: AshlrConfig): string {
  const base = resolveLlamaServerBaseUrl(cfg);
  try {
    return new URL(base).origin;
  } catch {
    return base.replace(/\/v1\/?$/, '');
  }
}

/**
 * The model id to send with a request to this runtime.
 *
 * llama-server serves ONE model and ignores the `model` field of an
 * OpenAI-compatible request, so this value never changes which weights answer.
 * It is still worth getting right: it is what appears in run records, usage
 * telemetry and logs, and a fleet whose telemetry claims a model it is not
 * running is a fleet nobody can debug. The live runtime's own reference wins;
 * the catalog default is the fallback.
 */
export function resolveLlamaServerDefaultModel(cfg?: AshlrConfig): string {
  const section = readSection(cfg);
  const configured = str(section.model);
  if (configured) return configured;
  const record = readOwnershipRecord();
  if (record?.modelRef) return record.modelRef;
  return DEFAULT_LOCAL_MODEL_TAG;
}
