/**
 * core/verse/seats.ts — Verse seat discovery (owner B).
 *
 * A seat is one selectable execution identity: a native account
 * (claude / codex / grok) recorded in ~/.ashlr/account-connections/
 * connections.json, or a local Ollama model tag.
 *
 * PRIVACY BOUNDARY: connections.json carries each account's launcher
 * `command` (a native-profile wrapper that pins CLAUDE_CONFIG_DIR /
 * CODEX_HOME / GROK_HOME). That command is the account's identity and must
 * NEVER be serialized onto the wire. This module therefore returns two
 * separate things from one discovery pass:
 *   - `seats`: the public VerseSeat[] (no command, no env) — safe for JSON.
 *   - `launches`: a Map<seatId, VerseSeatLaunch> the engine consumes when a
 *     session is created. It stays inside the server process.
 *
 * Nothing here throws. A missing/corrupt connections.json yields no native
 * seats; an unreachable Ollama yields no local seats and
 * `localRuntime.ollama.reachable === false`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { readClaudeUsage, type ClaudeUsageResult } from '../fabric/claude-usage.js';
import type { VerseSeatLaunch } from './session-engine.js';
import { readVerseAccountEvidence, type VerseAccountObservation } from './accounts.js';
import { probeOllamaModelDetail, type VerseOllamaModelDetail } from './local-models.js';
import {
  VERSE_DEFAULT_CONTEXT_WINDOWS,
  type VerseBootstrap,
  type VerseEngine,
  type VerseModelOption,
  type VerseSeat,
  type VerseSeatHealth,
} from './types.js';

// ---------------------------------------------------------------------------
// Model catalogue — one const so the lists are easy to edit.
// ---------------------------------------------------------------------------

type NativeEngine = Exclude<VerseEngine, 'local'>;

export const VERSE_NATIVE_MODELS: Readonly<Record<NativeEngine, readonly VerseModelOption[]>> = {
  claude: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['claude'] ?? null },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['claude'] ?? null },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['claude'] ?? null },
  ],
  codex: [
    { id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['codex'] ?? null },
    { id: 'gpt-5.5-mini', label: 'GPT-5.5 Mini', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['codex'] ?? null },
  ],
  grok: [
    { id: 'grok-4', label: 'Grok 4', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['grok'] ?? null },
    { id: 'grok-4-fast', label: 'Grok 4 Fast', contextWindow: VERSE_DEFAULT_CONTEXT_WINDOWS['grok'] ?? null },
  ],
};

/**
 * LEGACY FALLBACK ONLY. Local seat visibility is now decided by the model's
 * actual `tools` capability from Ollama `/api/show` — a model without it CANNOT
 * drive an agentic session, and no amount of name-matching changes that. This
 * regex is still consulted for one case: the runtime reported NO `capabilities`
 * key at all (an older Ollama), where hiding everything would be a worse lie
 * than the old guess.
 */
export const VERSE_LOCAL_TAG_RE = /coder|code|qwen|deepseek|devstral|llama/i;

export const VERSE_DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 2_000;
const MAX_CONNECTIONS_FILE_BYTES = 1024 * 1024;
const MAX_LOCAL_TAGS = 64;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerseSeatDiscoveryOptions {
  /** Directory holding connections.json + observations.json. */
  accountsRoot?: string;
  /** Ollama base URL (no trailing slash, no /v1). */
  ollamaBaseUrl?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable claude usage reader for tests. */
  claudeUsage?: () => ClaudeUsageResult;
}

export interface VerseSeatDiscovery {
  /** Public, JSON-safe seats. */
  seats: VerseSeat[];
  /** PRIVATE: seatId -> launch (launcher command / ollama base). Never serialize. */
  launches: ReadonlyMap<string, VerseSeatLaunch>;
  localRuntime: VerseBootstrap['localRuntime'];
}

/** Optional top-level `verse` block in config.json (not part of AshlrConfig yet). */
interface VerseConfigCarrier {
  verse?: { accountsRoot?: unknown };
}

// ---------------------------------------------------------------------------
// connections.json / observations.json
// ---------------------------------------------------------------------------

interface ConnectionAccount {
  id: string;
  label: string;
  provider: NativeEngine;
  command: string[];
}

type ObservationWindow = VerseAccountObservation['windows'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNativeEngine(value: unknown): value is NativeEngine {
  return value === 'claude' || value === 'codex' || value === 'grok';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    if (raw.length > MAX_CONNECTIONS_FILE_BYTES) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function defaultAccountsRoot(): string {
  return join(homedir(), '.ashlr', 'account-connections');
}

/** Resolve the accounts root: explicit option > cfg.verse.accountsRoot > default. */
export function resolveAccountsRoot(cfg: AshlrConfig, explicit?: string): string {
  if (explicit) return explicit;
  const fromCfg = (cfg as AshlrConfig & VerseConfigCarrier).verse?.accountsRoot;
  if (typeof fromCfg === 'string' && fromCfg.trim().length > 0) return fromCfg;
  return defaultAccountsRoot();
}

/** Resolve the Ollama base URL: explicit option > cfg.models.ollama > default. Strips `/` and `/v1`. */
export function resolveOllamaBaseUrl(cfg: AshlrConfig, explicit?: string): string {
  const raw = explicit ?? cfg.models?.ollama ?? VERSE_DEFAULT_OLLAMA_BASE_URL;
  let out = raw.trim();
  if (out.length === 0) out = VERSE_DEFAULT_OLLAMA_BASE_URL;
  out = out.replace(/\/+$/, '');
  if (out.endsWith('/v1')) out = out.slice(0, -3);
  return out;
}

function readConnections(accountsRoot: string): ConnectionAccount[] {
  const parsed = readJsonFile(join(accountsRoot, 'connections.json'));
  if (!isRecord(parsed) || !Array.isArray(parsed['accounts'])) return [];
  const out: ConnectionAccount[] = [];
  const seen = new Set<string>();
  for (const entry of parsed['accounts']) {
    if (!isRecord(entry)) continue;
    const id = entry['id'];
    const provider = entry['provider'];
    const command = entry['command'];
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (!isNativeEngine(provider)) continue;
    if (!isStringArray(command) || command.length === 0) continue;
    const label = typeof entry['label'] === 'string' && entry['label'].length > 0 ? entry['label'] : id;
    seen.add(id);
    out.push({ id, label, provider, command: [...command] });
  }
  return out;
}

/**
 * Per-account health evidence.
 *
 * THE V1 BUG: this used to read `<accountsRoot>/observations.json` directly.
 * That file is an operator-seeded BASELINE that nothing in this repo ever
 * writes (Mason's is `[]`), so every seat always rendered "unknown". The live
 * readings are at `<accountsRoot>/ledger/.resource-quota-shared-evidence.json`.
 * `readVerseAccountEvidence` reads the in-process collector first, then that
 * ledger evidence, then the seed baseline — and merges live readings ON TOP OF
 * the baseline, never the other way round.
 */
function readObservations(accountsRoot: string): Map<string, VerseAccountObservation> {
  return readVerseAccountEvidence(accountsRoot).byAccount;
}

// ---------------------------------------------------------------------------
// Health mapping
// ---------------------------------------------------------------------------

function healthStateOf(raw: string): VerseSeatHealth['state'] {
  const h = raw.toLowerCase();
  if (h === 'ready' || h === 'healthy' || h === 'ok' || h === 'available') return 'ready';
  if (h === 'degraded' || h === 'throttled' || h === 'warning' || h === 'limited') return 'degraded';
  if (h === 'unavailable' || h === 'exhausted' || h === 'down' || h === 'error' || h === 'failed') return 'unavailable';
  return 'unknown';
}

function shortClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function windowsSummary(windows: ObservationWindow[]): string | null {
  const parts: string[] = [];
  for (const w of windows) {
    if (w.usedPercent === null) continue;
    // Claude supplies NO machine-readable reset — only the provider's own
    // wording, which is rendered verbatim and never turned into a countdown.
    const reset = w.resetsAt
      ? `, resets ${shortClock(w.resetsAt)}`
      : w.nativeReport?.resetDescription
        ? `, resets ${w.nativeReport.resetDescription}`
        : '';
    parts.push(`${w.id} window ${Math.round(w.usedPercent)}% used${reset}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function unknownHealth(): VerseSeatHealth {
  return { state: 'unknown', summary: null, windows: [], observedAt: null };
}

function nativeHealth(
  account: ConnectionAccount,
  observations: Map<string, VerseAccountObservation>,
  claudeUsage: () => ClaudeUsageResult,
): VerseSeatHealth {
  const obs = observations.get(account.id);
  const health: VerseSeatHealth = obs
    ? {
      state: healthStateOf(obs.health),
      summary: windowsSummary(obs.windows),
      windows: obs.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
      observedAt: obs.observedAt,
    }
    : unknownHealth();

  if (account.provider === 'claude') {
    try {
      const usage = claudeUsage();
      if (usage.messages5h > 0 || usage.messages7d > 0) {
        const extra = `5h: ${formatTokens(usage.tokens5h)} tokens · 7d: ${formatTokens(usage.tokens7d)} tokens`;
        health.summary = health.summary ? `${health.summary} · ${extra}` : extra;
        if (!health.observedAt) health.observedAt = new Date(usage.readAt).toISOString();
      }
    } catch {
      // Usage is best-effort colour; never block seat discovery.
    }
  }
  return health;
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

interface OllamaProbe {
  reachable: boolean;
  tags: string[];
}

async function fetchJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function probeOllamaTags(fetchImpl: typeof fetch, baseUrl: string): Promise<OllamaProbe> {
  const body = await fetchJson(fetchImpl, `${baseUrl}/api/tags`);
  if (!isRecord(body) || !Array.isArray(body['models'])) return { reachable: false, tags: [] };
  const tags: string[] = [];
  for (const m of body['models']) {
    if (!isRecord(m)) continue;
    const name = typeof m['name'] === 'string' ? m['name'] : typeof m['model'] === 'string' ? m['model'] : null;
    if (name && !tags.includes(name)) tags.push(name);
    if (tags.length >= MAX_LOCAL_TAGS) break;
  }
  return { reachable: true, tags };
}

/**
 * Can this tag be a seat?
 *
 * A model WITHOUT the `tools` capability cannot drive an agentic session — it
 * will fail at turn time, after the user has already chosen it. So visibility
 * is decided by the capability the runtime actually reports, not by whether
 * the model's NAME happens to contain "coder". When the runtime reports no
 * capabilities at all (`supportsTools === null`, e.g. an older Ollama), fall
 * back to the legacy name heuristic rather than emptying the picker.
 */
export function localSeatIsSelectable(detail: VerseOllamaModelDetail | null, tag: string): boolean {
  if (detail === null || detail.supportsTools === null) return VERSE_LOCAL_TAG_RE.test(tag);
  return detail.supportsTools;
}

/** `qwen3-coder-next:ctx64k` → 65536; null when no such suffix. */
export function contextWindowFromTagSuffix(tag: string): number | null {
  const m = /:ctx(\d+)k$/i.exec(tag);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n * 1024 : null;
}

/** `qwen3-coder-next:ctx64k` → "Qwen3-Coder-Next (local)". */
export function localSeatLabel(tag: string): string {
  const [base = tag, ...rest] = tag.split(':');
  const pretty = base
    .split('-')
    .map((seg) => (seg.length > 0 ? seg[0]!.toUpperCase() + seg.slice(1) : seg))
    .join('-');
  // Keep the Ollama variant tag (e.g. `ctx64k`, `q4_K_M`) so two quantizations
  // of the same model are distinguishable in the seat picker.
  const variant = rest.join(':');
  return variant && variant !== 'latest' ? `${pretty} ${variant} (local)` : `${pretty} (local)`;
}

async function discoverLocalSeats(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<{ seats: VerseSeat[]; launches: Map<string, VerseSeatLaunch>; localRuntime: VerseBootstrap['localRuntime'] }> {
  const probe = await probeOllamaTags(fetchImpl, baseUrl);
  const localRuntime: VerseBootstrap['localRuntime'] = {
    ollama: { reachable: probe.reachable, baseUrl, models: probe.tags },
  };
  const seats: VerseSeat[] = [];
  const launches = new Map<string, VerseSeatLaunch>();
  if (!probe.reachable) return { seats, launches, localRuntime };

  // One /api/show per installed tag: it carries BOTH the effective context
  // window and the tool capability that decides whether this can be a seat.
  const details = await Promise.all(
    probe.tags.map((tag) => probeOllamaModelDetail(fetchImpl, baseUrl, tag, OLLAMA_TIMEOUT_MS)),
  );
  const selectable: Array<{ tag: string; contextWindow: number }> = [];
  probe.tags.forEach((tag, i) => {
    const detail = details[i] ?? null;
    if (!localSeatIsSelectable(detail, tag)) return;
    selectable.push({
      tag,
      contextWindow: detail?.contextWindow
        ?? contextWindowFromTagSuffix(tag)
        ?? VERSE_DEFAULT_CONTEXT_WINDOWS['local']
        ?? 65_536,
    });
  });

  selectable.forEach(({ tag, contextWindow }) => {
    const seat: VerseSeat = {
      id: `local:${tag}`,
      engine: 'local',
      label: localSeatLabel(tag),
      accountId: 'local',
      models: [{ id: tag, label: localSeatLabel(tag).replace(/ \(local\)$/, ''), contextWindow }],
      contextWindow,
      health: { state: 'ready', summary: null, windows: [], observedAt: new Date().toISOString() },
    };
    seats.push(seat);
    launches.set(seat.id, { seat, launcher: null, ollamaBaseUrl: baseUrl });
  });
  return { seats, launches, localRuntime };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Discover every seat available to this server. Never throws; native seats
 * and local seats degrade independently.
 */
export async function discoverSeats(cfg: AshlrConfig, opts: VerseSeatDiscoveryOptions = {}): Promise<VerseSeatDiscovery> {
  const accountsRoot = resolveAccountsRoot(cfg, opts.accountsRoot);
  const ollamaBaseUrl = resolveOllamaBaseUrl(cfg, opts.ollamaBaseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const claudeUsage = opts.claudeUsage ?? readClaudeUsage;

  const seats: VerseSeat[] = [];
  const launches = new Map<string, VerseSeatLaunch>();

  try {
    const accounts = readConnections(accountsRoot);
    const observations = readObservations(accountsRoot);
    for (const account of accounts) {
      const models = VERSE_NATIVE_MODELS[account.provider].map((m) => ({ ...m }));
      const seat: VerseSeat = {
        id: account.id,
        engine: account.provider,
        label: account.label,
        accountId: account.id,
        models,
        contextWindow: models[0]?.contextWindow ?? null,
        health: nativeHealth(account, observations, claudeUsage),
      };
      seats.push(seat);
      // The launcher command stays here — it is the account's identity.
      launches.set(seat.id, { seat, launcher: account.command, ollamaBaseUrl });
    }
  } catch {
    // Corrupt account files yield no native seats; local seats still work.
  }

  let localRuntime: VerseBootstrap['localRuntime'] = {
    ollama: { reachable: false, baseUrl: ollamaBaseUrl, models: [] },
  };
  try {
    const local = await discoverLocalSeats(fetchImpl, ollamaBaseUrl);
    localRuntime = local.localRuntime;
    for (const seat of local.seats) {
      if (launches.has(seat.id)) continue;
      seats.push(seat);
      const launch = local.launches.get(seat.id);
      if (launch) launches.set(seat.id, launch);
    }
  } catch {
    // Unreachable runtime: reported via localRuntime.reachable === false.
  }

  return { seats, launches, localRuntime };
}
