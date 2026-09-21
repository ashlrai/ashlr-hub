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

/** Total context shared across slots (65536 / 4 slots = 16384 per agent). */
export const DEFAULT_LLAMA_CONTEXT = 65_536;

/** The historical base URL, pinned by test/m144.llama-server.test.ts. */
export const LEGACY_DEFAULT_BASE_URL = `http://localhost:${DEFAULT_LLAMA_PORT}/v1`;

/** Loose read of `cfg.models.llamaServer` without widening the config type. */
interface LlamaServerConfigSection {
  baseUrl?: unknown;
  host?: unknown;
  /** Persisted opt-in required before `host` may leave loopback. */
  allowNonLoopback?: unknown;
  port?: unknown;
  slots?: unknown;
  context?: unknown;
  model?: unknown;
  modelPath?: unknown;
  bin?: unknown;
  extraArgs?: unknown;
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
  const allowNonLoopback = section.allowNonLoopback === true;
  const hostPermitted = isLoopbackHost(requestedHost) || allowNonLoopback;
  const host = hostPermitted ? requestedHost : DEFAULT_LLAMA_HOST;
  const hostDowngradedFrom = hostPermitted ? null : requestedHost;
  const port =
    int(process.env['ASHLR_LOCAL_RUNTIME_PORT'], 1, 65_535) ??
    int(section.port, 1, 65_535) ??
    DEFAULT_LLAMA_PORT;
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
