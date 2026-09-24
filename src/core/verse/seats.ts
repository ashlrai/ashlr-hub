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
 * SEAT HEALTH comes from the LIVE connection monitor — the same projection
 * `GET /api/verse/accounts` serves (`buildVerseAccountsSnapshot`). It used to
 * come from the shared quota evidence file, whose scope is
 * `codex-native-metadata` and which therefore structurally cannot carry Claude
 * or Grok; those two seats could never be anything but "unknown". That file is
 * now strictly the fallback for when no collector is running.
 *
 * Nothing here throws. A missing/corrupt connections.json yields no native
 * seats; an unreachable Ollama yields no local seats and
 * `localRuntime.ollama.reachable === false`; unreadable account telemetry
 * yields "unknown" health, which is never rendered as zero.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { readClaudeUsage, type ClaudeUsageResult } from '../fabric/claude-usage.js';
import type { VerseSeatLaunch } from './session-engine.js';
import {
  buildVerseAccountsSnapshot,
  getVerseAccountCollector,
  type VerseAccountCollector,
  type VerseAccountRecord,
  type VerseAccountWindow,
} from './accounts.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../run/model-catalog.js';
import {
  claudeAutoCompactAt,
  LOCAL_MIN_USABLE_WINDOW,
  localWindowUsable,
  sessionOverheadTokens,
} from './context-math.js';
import {
  contextWindowFromTagSuffix,
  probeLlamaSlotContext,
  probeOllamaModelDetail,
  probeOllamaResident,
  readOllamaServerDefault,
  resolveLocalContextWindow,
  type VerseLocalWindow,
  type VerseOllamaModelDetail,
  type VerseOllamaServerDefault,
} from './local-models.js';
import {
  claudeModelOptions,
  claudeModelsNeedingNewerCli,
  cliVersionFromExecutable,
  codexModelOptions,
  compareCliVersions,
  defaultClaudeVersionsRoot,
  grokModelOptions,
  joinClaudeLabels,
  localModelOption,
  newestInstalledClaudeVersion,
  readCodexCatalog,
  readGrokCatalog,
} from './model-windows.js';
import {
  type VerseBootstrap,
  type VerseEngine,
  type VerseModelOption,
  type VerseSeat,
  type VerseLocalDispatch,
  type VerseSeatCapacity,
  type VerseSeatEvidenceSource,
  type VerseSeatHealth,
  type VerseSeatUsability,
  type VerseSeatWindow,
} from './types.js';

// ---------------------------------------------------------------------------
// Model catalogue — built per seat by model-windows.ts
// ---------------------------------------------------------------------------

type NativeEngine = Exclude<VerseEngine, 'local'>;

/**
 * The BUILT-IN lists: what a native seat offers when nothing better is known
 * (a Claude seat whose CLI version could not be read, a codex/grok seat that
 * has not fetched its own catalog yet). Real seats are built per account by
 * {@link nativeSeatModels} from the seat's own catalog and pinned binary —
 * see core/verse/model-windows.ts, which holds every window and the evidence
 * for it. Exported for tests and for callers that need the documented
 * defaults without a discovery pass.
 *
 * Never hard-code a model list here again. Two past failures this replaced:
 * Claude models all inherited the CLI's 200k "unknown model" window while the
 * CLI ran six of them at 1M, and `claude-opus-5.5` (dotted) was offered even
 * though every Claude Code binary resolves that spelling to Opus 5.
 */
export const VERSE_NATIVE_MODELS: Readonly<Record<NativeEngine, readonly VerseModelOption[]>> = {
  claude: claudeModelOptions(null),
  codex: codexModelOptions(null),
  grok: grokModelOptions(null),
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
  /** Directory holding connections.json and the account ledger. */
  accountsRoot?: string;
  /** Ollama base URL (no trailing slash, no /v1). DISCOVERY and, by default, dispatch. */
  ollamaBaseUrl?: string;
  /**
   * Override the lane local seats DISPATCH turns down. Tests pass it
   * explicitly; the server lets {@link resolveVerseLocalDispatch} read config.
   */
  localDispatch?: VerseLocalDispatch;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable claude usage reader for tests. */
  claudeUsage?: () => ClaudeUsageResult;
  /**
   * Live account collector override.
   *   `undefined` ⇒ use the collector this process registered at startup.
   *   `null`      ⇒ no collector; degrade to the evidence file / baseline.
   * Tests pass it explicitly; the server never does.
   */
  collector?: VerseAccountCollector | null;
  /**
   * Where Claude Code keeps one file per installed version (default
   * `~/.local/share/claude/versions`). Read only to tell an operator that a
   * newer binary than their seat's pin is already installed.
   */
  claudeVersionsRoot?: string;
  /**
   * llama-server's origin for the per-slot window probe on the llama-server
   * lane. Default: `resolveLlamaServerOrigin(cfg)`. Tests pass it so a real
   * llama-server on this machine can never leak into a hermetic run.
   */
  llamaServerOrigin?: string;
  /**
   * Ollama's unpinned-request default context. `undefined` reads it from the
   * environment / server log ({@link readOllamaServerDefault}).
   */
  ollamaServerDefault?: VerseOllamaServerDefault | null;
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
  verse?: { accountsRoot?: unknown; localDispatch?: unknown };
}

// ---------------------------------------------------------------------------
// connections.json — the account roster (and the private launcher)
// ---------------------------------------------------------------------------

interface ConnectionAccount {
  id: string;
  label: string;
  provider: NativeEngine;
  command: string[];
}

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

/**
 * Which lane local seats DISPATCH turns down: `ollama` (the default) or
 * `llama-server`.
 *
 * THIS IS AN EXPLICIT CHOICE AND MUST STAY ONE. The tempting alternative —
 * "use llama-server whenever something answers on its port" — is wrong twice
 * over. A llama-server that is up is not necessarily the one this hub
 * supervises. And the thing a local seat actually has to reach is not
 * llama-server at all but the Anthropic normalising proxy in front of it
 * (local-runtime/llama/anthropic-proxy.ts), a SEPARATE listener that exists
 * only while some process is hosting it — in practice, only while this process
 * has run `startLocalRuntime`. Inferring the lane from a probe therefore turns
 * "the fast runtime happens not to be running" into "the Ollama lane that
 * works today is broken", which is the one outcome worth engineering against.
 *
 * Precedence: explicit argument > `ASHLR_VERSE_LOCAL_DISPATCH` >
 * `cfg.verse.localDispatch` > `ollama`. A value that is neither lane is not a
 * choice, so it is skipped rather than honoured, and an unrecognised value
 * everywhere lands back on the working default.
 */
export function resolveVerseLocalDispatch(
  cfg: AshlrConfig,
  explicit?: VerseLocalDispatch,
): VerseLocalDispatch {
  if (explicit === 'ollama' || explicit === 'llama-server') return explicit;
  const candidates = [
    process.env['ASHLR_VERSE_LOCAL_DISPATCH'],
    (cfg as AshlrConfig & VerseConfigCarrier).verse?.localDispatch,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().toLowerCase();
    if (value === 'llama-server' || value === 'llama' || value === 'llamaserver') return 'llama-server';
    if (value === 'ollama') return 'ollama';
  }
  return 'ollama';
}

/**
 * The base URL a local seat's Anthropic client is pointed at, for a lane.
 *
 * The llama-server answer comes from `resolveLocalAnthropicBaseUrl`, which is
 * the single place that knows where the proxy listens — deriving it here from
 * a port number would be exactly the endpoint drift that module exists to
 * prevent.
 *
 * The import is LAZY because `local-runtime/llama/config` reaches for
 * `node:child_process` (it locates llama-server's binary with `which`), and a
 * server whose operator never opted in must not pay for that on boot. If it
 * cannot be resolved at all the seats fall back to the Ollama lane: a seat
 * list is not worth losing over an address lookup.
 */
async function resolveLocalDispatchBaseUrl(
  cfg: AshlrConfig,
  lane: VerseLocalDispatch,
  ollamaBaseUrl: string,
): Promise<string> {
  if (lane !== 'llama-server') return ollamaBaseUrl;
  try {
    const { resolveLocalAnthropicBaseUrl } = await import('../local-runtime/llama/config.js');
    const resolved = resolveLocalAnthropicBaseUrl(cfg);
    return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : ollamaBaseUrl;
  } catch {
    return ollamaBaseUrl;
  }
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

// ---------------------------------------------------------------------------
// Native profile — the pinned binary and the seat's own state directory
// ---------------------------------------------------------------------------

/**
 * What a native seat's profile says about the CLI it is pinned to. PRIVATE:
 * `nativeStatePath` and `executable` are machine paths and never reach a seat
 * as-is; only the derived version, catalog-derived models and home-relative
 * remediation text do.
 */
export interface VerseSeatProfile {
  /** The profile directory (`<…>/native-profiles/<account>`). */
  directory: string;
  /** The provider CLI's pinned home: CODEX_HOME / GROK_HOME / CLAUDE_CONFIG_DIR. */
  nativeStatePath: string | null;
  /** The one binary the launcher execs. */
  executable: string | null;
}

const MAX_PROFILE_BYTES = 64 * 1024;

/**
 * Locate and read `<profile>/profile.json` from an account's launcher argv —
 * the same derivation `mcp-seat-view.resolveAccountStateRoots` uses
 * (`…/launcher.mjs` ⇒ its directory's `profile.json`), but lifting the
 * executable too, which the seat needs to know which CLI version it runs.
 *
 * A profile whose `provider` disagrees with the account is IGNORED rather
 * than half-trusted: reading a grok catalog for a codex seat would be worse
 * than reading none. Returns null whenever anything is missing.
 */
export function readSeatProfile(command: readonly string[], provider: NativeEngine): VerseSeatProfile | null {
  const launcher = command.find((part) => typeof part === 'string' && part.endsWith('launcher.mjs'));
  if (launcher === undefined || !isAbsolute(launcher)) return null;
  const directory = dirname(launcher);
  let manifest: unknown;
  try {
    const raw = readFileSync(join(directory, 'profile.json'), 'utf8');
    if (raw.length > MAX_PROFILE_BYTES) return null;
    manifest = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(manifest)) return null;
  if (manifest['provider'] !== undefined && manifest['provider'] !== provider) return null;
  const absolute = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) ? value : null;
  return {
    directory,
    nativeStatePath: absolute(manifest['nativeStatePath']),
    executable: absolute(manifest['executable']),
  };
}

/** `~/…` for a path under home, so remediation text is copyable but not machine-specific. */
function homeRelative(path: string): string {
  const home = homedir();
  const rel = relative(home, path);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return path;
  return `~/${rel.split(sep).join('/')}`;
}

/** Stable-partition: runnable models first, so `models[0]` (the default) always runs. */
function runnableFirst(models: VerseModelOption[]): VerseModelOption[] {
  return [
    ...models.filter((m) => !m.unavailableReason),
    ...models.filter((m) => m.unavailableReason),
  ];
}

/**
 * The operator command that points a prepared native profile at another CLI
 * binary (src/cli/resources.ts routes `resources` → `profile` → `repin`). It is
 * a constant because the seat note is copy-paste remediation: a spelling that
 * does not route (`ashlr resource-profile …` never existed) is worse than no
 * hint, and tests pin the exact text through this one name.
 */
export const VERSE_REPIN_COMMAND = 'ashlr resources profile repin';

export const VERSE_CATALOG_PENDING_NOTE =
  "Model list is Verse's built-in list until this seat's first turn fetches its own catalog.";

/**
 * One native seat's models, pinned CLI version and notes.
 *
 * Every source is the SEAT's: its own catalog file under its profile's
 * `nativeStatePath` and the binary its launcher execs. The unpinned global
 * homes (`~/.codex`, `~/.grok`, `~/.claude`) belong to a different account or
 * binary and are never read — codex-a and codex-b run different CLI versions
 * with different catalogs on this very machine.
 */
export function nativeSeatModels(
  provider: NativeEngine,
  profile: VerseSeatProfile | null,
  opts: { claudeVersionsRoot?: string } = {},
): { models: VerseModelOption[]; cliVersion: string | null; notes: string[] } {
  const cliVersion = profile?.executable ? cliVersionFromExecutable(profile.executable) : null;
  const notes: string[] = [];

  if (provider === 'claude') {
    const models = runnableFirst(claudeModelOptions(cliVersion));
    const tooOld = claudeModelsNeedingNewerCli(cliVersion);
    if (tooOld.length > 0 && cliVersion !== null) {
      const needed = tooOld
        .map((spec) => spec.minCliVersion as string)
        .reduce((a, b) => (compareCliVersions(a, b) >= 0 ? a : b));
      const versionsRoot = opts.claudeVersionsRoot ?? defaultClaudeVersionsRoot();
      const newest = newestInstalledClaudeVersion(versionsRoot);
      const labels = joinClaudeLabels(tooOld);
      const verb = tooOld.length === 1 ? 'needs' : 'need';
      if (newest !== null && compareCliVersions(newest, needed) >= 0 && compareCliVersions(newest, cliVersion) > 0) {
        const dir = profile ? homeRelative(profile.directory) : '<profile directory>';
        notes.push(
          `Pinned to Claude Code ${cliVersion}; ${newest} is installed — ${labels} ${verb} it. `
          + `Re-pin with: ${VERSE_REPIN_COMMAND} --directory ${dir} --executable ${homeRelative(join(versionsRoot, newest))}`,
        );
      } else {
        notes.push(`Pinned to Claude Code ${cliVersion}; ${labels} ${verb} ${needed} or newer, which is not installed on this machine.`);
      }
    } else if (cliVersion === null && models.some((m) => m.minCliVersion)) {
      const gated = models.filter((m) => m.minCliVersion).map((m) => m.label.replace(/^Claude\s+/, ''));
      notes.push(
        `Could not tell which Claude Code version this seat is pinned to; ${gated.join(', ')} `
        + 'may silently run as an older model on an older binary.',
      );
    }
    return { models, cliVersion, notes };
  }

  const statePath = profile?.nativeStatePath ?? null;
  if (provider === 'codex') {
    const catalog = statePath ? readCodexCatalog(statePath) : null;
    if (catalog === null) notes.push(VERSE_CATALOG_PENDING_NOTE);
    return { models: runnableFirst(codexModelOptions(catalog)), cliVersion, notes };
  }

  const catalog = statePath ? readGrokCatalog(statePath) : null;
  if (catalog === null) notes.push(VERSE_CATALOG_PENDING_NOTE);
  return { models: runnableFirst(grokModelOptions(catalog)), cliVersion, notes };
}

// ---------------------------------------------------------------------------
// Seat telemetry — the LIVE connection monitor, not the Codex-only evidence file
// ---------------------------------------------------------------------------

/**
 * THE V2.1 BUG THIS SECTION EXISTS TO FIX.
 *
 * Seat health used to be derived from `readVerseAccountEvidence`, whose best
 * available source is
 * `<accountsRoot>/ledger/.resource-quota-shared-evidence.json`. That file's
 * scope is literally `codex-native-metadata`: it structurally CANNOT carry
 * Claude or Grok, so those two seats could never be anything but "unknown".
 * Measured against a live server, `GET /api/verse/accounts` reported claude
 * `observed` with three windows and grok `observed` with one, while the very
 * same server's `bootstrap.seats[].health` reported `unknown` for both,
 * permanently.
 *
 * The live rows were already in the process: the connection monitor has all
 * four providers and `buildVerseAccountsSnapshot` already projects them with
 * every honesty rule applied. Seats now read THAT — one derivation, one set of
 * rules, one place to fix. The Codex-only evidence file survives strictly as
 * the fallback for when no collector is running, which
 * `buildVerseAccountsSnapshot` applies itself through
 * `deriveVerseAccountRecordFromEvidence`.
 */
export interface VerseSeatTelemetry {
  health: VerseSeatHealth;
  capacity: VerseSeatCapacity;
}

/** At or above this percent the binding window is reported as `tight`. */
export const VERSE_SEAT_TIGHT_PERCENT = 90;

function seatWindow(window: VerseAccountWindow): VerseSeatWindow {
  return {
    id: window.id,
    usedPercent: window.usedPercent,
    // Already forced to null for Claude upstream; the sentence below is that
    // provider's ONLY reset signal and is never turned into a countdown.
    resetsAt: window.resetsAt,
    resetDescription: window.nativeReport?.resetDescription ?? null,
    limitReached: window.limitReached,
    measured: window.measured,
  };
}

/**
 * The coarse "can I use this seat right now" verdict.
 *
 * TWO TRAPS THIS RULE EXISTS TO AVOID.
 *
 * 1. A SPENT WINDOW IS NOT A SPENT ACCOUNT. Claude publishes a per-model
 *    weekly window alongside its account-wide ones, and on this machine
 *    `seven_day_fable` reads 100% while `five_hour` reads 15%. `bindingWindow`
 *    correctly names the fable window as the highest — but Fable is not even a
 *    model this seat can select, so calling the seat `exhausted` because of it
 *    would be false about the seat Mason works in all day. So `exhausted` is
 *    reserved for the case where EVERY window that carried a reading is spent;
 *    a mix is `tight`, which says "something is at its limit" without claiming
 *    the account is.
 * 2. CODEX CREDITS ARE INDEPENDENT OF THE WINDOW. A fully used weekly window
 *    with a spendable balance is not blocked, so it never reads `exhausted`.
 *
 * A flagged denial and a measured 100 collapse to the same verdict because the
 * consequence is the same. They stay DISTINGUISHABLE in
 * `windows[].limitReached` / `measured`, which is where the provenance belongs;
 * the verdict does not claim one.
 */
export function seatUsability(
  record: Pick<VerseAccountRecord, 'state' | 'binding' | 'credits' | 'windows'>,
): VerseSeatUsability {
  if (record.state === 'signed-out') return 'signed-out';
  const binding = record.binding;
  // No window carried a percent: no signal. Not zero, not healthy.
  if (binding === null) return 'unknown';
  // Windows with no reading are excluded entirely — a null percent says
  // nothing about headroom in either direction.
  const read = record.windows.filter((w) => w.usedPercent !== null);
  const spent = read.filter((w) => w.limitReached || (w.usedPercent ?? 0) >= 100);
  if (spent.length === read.length) return record.credits?.hasCredits === true ? 'tight' : 'exhausted';
  if (spent.length > 0) return 'tight';
  return binding.usedPercent >= VERSE_SEAT_TIGHT_PERCENT ? 'tight' : 'ready';
}

/**
 * REACHABILITY ONLY — usage never demotes this.
 *
 * Claude's per-model weekly window sits at 100% while its five-hour window is
 * at 15%; calling that seat "unavailable" would be false, and it is exactly the
 * seat Mason uses all day. The usage story lives in `capacity.usability`;
 * `health.state` answers only "did we get a reading at all".
 */
export function seatHealthState(
  record: Pick<VerseAccountRecord, 'state' | 'windows' | 'observedAt'>,
): VerseSeatHealth['state'] {
  if (record.state === 'observed') return 'ready';
  // The one account state worth a red dot, because it has a remedy.
  if (record.state === 'signed-out') return 'unavailable';
  if (record.state === 'checking') return 'unknown';
  // `unavailable`: a probe that failed while a prior reading is still in hand
  // is degraded; one that never produced a reading is unknown — not zero.
  return record.windows.length > 0 || record.observedAt !== null ? 'degraded' : 'unknown';
}

function telemetryOf(record: VerseAccountRecord, evidenceSource: VerseSeatEvidenceSource): VerseSeatTelemetry {
  const windows = record.windows.map(seatWindow);
  const bindingId = record.binding?.id ?? null;
  const binding = bindingId === null ? null : windows.find((w) => w.id === bindingId) ?? null;
  return {
    health: {
      state: seatHealthState(record),
      summary: windowsSummary(windows),
      // `VerseSeatHealth.windows` is a FROZEN V1 shape — the richer per-window
      // facts (reset wording, sentinel provenance) go on `capacity.windows`.
      windows: windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
      observedAt: record.observedAt,
    },
    capacity: {
      planType: record.planType,
      binding,
      windows,
      // Structurally identical to `VerseCodexCredits`; this assignment is the
      // compile-time drift guard between core and the browser-safe contract.
      credits: record.credits,
      usability: seatUsability(record),
      observedAt: record.observedAt,
      evidenceSource,
      notes: [...record.notes],
    },
  };
}

/**
 * Per-account telemetry keyed by account id, from the same projection
 * `GET /api/verse/accounts` serves. Never throws: telemetry is colour on the
 * seat list and must never stop a seat from appearing.
 */
export function buildSeatTelemetry(
  accountsRoot: string,
  opts: { collector?: VerseAccountCollector | null } = {},
): Map<string, VerseSeatTelemetry> {
  const out = new Map<string, VerseSeatTelemetry>();
  try {
    const collector = opts.collector === undefined ? getVerseAccountCollector() : opts.collector;
    const snapshot = buildVerseAccountsSnapshot({ accountsRoot, collector });
    // `snapshot.evidenceSource` describes the EVIDENCE MAP, which is only what
    // the degraded records were built from. A record the live monitor answered
    // for did not come from that map, so it is labelled for what it is —
    // otherwise a live Claude reading would claim to be a stale seed.
    const liveIds = new Set((collector?.connections()?.accounts ?? []).map((a) => a.id));
    for (const record of snapshot.accounts) {
      out.set(record.id, telemetryOf(record, liveIds.has(record.id) ? 'collector' : snapshot.evidenceSource));
    }
  } catch {
    // Missing/corrupt account files: every seat degrades to unknown health.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Health rendering
// ---------------------------------------------------------------------------

function shortClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function windowsSummary(windows: VerseSeatWindow[]): string | null {
  const parts: string[] = [];
  for (const w of windows) {
    // A null percent is NO SIGNAL. Rendering it as 0% would be a lie, so the
    // window is simply absent from the summary.
    if (w.usedPercent === null) continue;
    // Claude supplies NO machine-readable reset — only the provider's own
    // wording, which is rendered verbatim and never turned into a countdown.
    const reset = w.resetsAt
      ? `, resets ${shortClock(w.resetsAt)}`
      : w.resetDescription
        ? `, resets ${w.resetDescription}`
        : '';
    const used = w.limitReached
      // A flagged sentinel is a denial, not a measurement.
      ? 'limit reached'
      : `${Math.round(w.usedPercent)}% used`;
    parts.push(`${w.id} window ${used}${reset}`);
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

/**
 * One native seat's public health + capacity. Every returned object is fresh,
 * so the shared telemetry map is never mutated by a per-seat augmentation.
 */
function nativeSeatFacets(
  accountId: string,
  provider: NativeEngine,
  telemetry: ReadonlyMap<string, VerseSeatTelemetry>,
  claudeUsage: () => ClaudeUsageResult,
): { health: VerseSeatHealth; capacity: VerseSeatCapacity | null } {
  const found = telemetry.get(accountId) ?? null;
  const health: VerseSeatHealth = found
    ? { ...found.health, windows: found.health.windows.map((w) => ({ ...w })) }
    : unknownHealth();

  if (provider === 'claude') {
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
  return { health, capacity: found?.capacity ?? null };
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

/**
 * The local tags this machine prefers, strongest first.
 *
 * `cfg.foundry.models['local-coder']` is the operator's own answer to "which
 * local model do I actually use", so it leads. `DEFAULT_LOCAL_MODEL_TAG` (the
 * same constant `local-coder`'s registry `api.defaultModel` resolves to) backs
 * it up, so a machine with no override still surfaces the model the rest of
 * the codebase would have dispatched to.
 */
export function preferredLocalTags(cfg: AshlrConfig): string[] {
  const out: string[] = [];
  const configured = cfg.foundry?.models?.['local-coder'];
  if (typeof configured === 'string' && configured.trim().length > 0) out.push(configured.trim());
  if (!out.some((t) => t.toLowerCase() === DEFAULT_LOCAL_MODEL_TAG.toLowerCase())) {
    out.push(DEFAULT_LOCAL_MODEL_TAG);
  }
  return out;
}

/** The model family of an Ollama tag: `qwen3.8:27b-ctx64k` → `qwen3.8`. */
function tagBase(tag: string): string {
  return (tag.split(':')[0] ?? tag).trim().toLowerCase();
}

/**
 * Sort key for one local tag against `preferred` — LOWER SORTS FIRST.
 *
 * Three bands, so a near-miss still beats an unrelated model:
 *   0 .. n-1    exact tag match, in preference order.
 *   n .. 2n-1   same model family, different variant — `qwen3.8:27b-q8_0`
 *               when `qwen3.8:27b-ctx64k` is preferred. The right model at
 *               the wrong context size is still the right model.
 *   2n          everything else, which keeps its discovery order because the
 *               sort is stable.
 *
 * This replaces relying on Ollama's `/api/tags` ordering, which is by mtime:
 * the preferred model sank below whatever was pulled most recently. Ranking is
 * ORDER ONLY — `localSeatIsSelectable` still decides membership, so a model
 * without tool support stays hidden no matter how preferred its tag is.
 */
export function localSeatPreferenceRank(tag: string, preferred: readonly string[]): number {
  const normalized = tag.trim().toLowerCase();
  for (let i = 0; i < preferred.length; i += 1) {
    if (normalized === preferred[i]!.trim().toLowerCase()) return i;
  }
  const base = tagBase(normalized);
  if (base.length > 0) {
    for (let i = 0; i < preferred.length; i += 1) {
      if (base === tagBase(preferred[i]!)) return preferred.length + i;
    }
  }
  return preferred.length * 2;
}

/**
 * Re-exported: the tag-suffix parser now lives beside the one local window
 * resolver in local-models.ts (and accepts `-ctx64k`, which it used to miss).
 */
export { contextWindowFromTagSuffix };

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

function formatWindow(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Plain-language caveats for one local seat's window, or none. Only the cases
 * where the number on screen is weaker than it looks get a note: a figure
 * Ollama actually allocates (pinned num_ctx, resident instance, its own
 * default, llama-server's slot) needs no apology.
 */
export function localWindowNotes(resolved: VerseLocalWindow, lane: VerseLocalDispatch, slotReported: boolean): string[] {
  const notes: string[] = [];
  if (lane === 'llama-server' && !slotReported) {
    notes.push(
      'llama-server did not report its per-slot context, so this window is Ollama\'s figure for the tag; '
      + 'turns on the llama-server lane get one slot\'s share, which may be less.',
    );
  }
  if (resolved.basis === 'native-estimate') {
    notes.push(
      `Ollama's default context for models without a pinned num_ctx could not be read; ${formatWindow(resolved.window)} `
      + 'is this model\'s trained maximum, and Ollama may allocate less.',
    );
  } else if (resolved.basis === 'tag-suffix' || resolved.basis === 'default') {
    notes.push(`Ollama did not describe this model; the ${formatWindow(resolved.window)}-token context window is an estimate.`);
  }
  return notes;
}

/**
 * Why a local window cannot host a Claude Code session, or null when it can.
 *
 * Local turns run Claude Code with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<window>`
 * (the window must be stated: the CLI otherwise assumes 200k and overflows
 * the runner). The CLI then reserves up to 20k for the reply and compacts
 * 13k below that, so a 32,768 window compacts at 0 — below its own ~15k fixed
 * prompt — and every turn is blocked or loops through compaction. Such a seat
 * is LISTED with this reason (the operator learns why, and which tag would
 * work) rather than offered as runnable or silently hidden.
 */
export function localWindowUnusableReason(window: number): string | null {
  if (localWindowUsable(window)) return null;
  const compactAt = claudeAutoCompactAt(window, null, null);
  return `Context window ${formatWindow(window)} is too small for Claude Code: it would compact at `
    + `≈${Math.round(compactAt / 1000)}k tokens, with no real room above its ~${Math.round(sessionOverheadTokens('local') / 1000)}k base prompt. `
    + `Use a tag with a window of at least ${formatWindow(LOCAL_MIN_USABLE_WINDOW)} tokens.`;
}

/**
 * The per-slot window on the llama-server lane, or null. The origin is
 * llama-server's own (NOT the Anthropic proxy turns are dispatched to): the
 * proxy has no `/props`. The imports are lazy for the same reason as
 * {@link resolveLocalDispatchBaseUrl} — an operator who never opted into this
 * lane must not pay for the process-table machinery on boot.
 */
async function llamaSlotWindow(
  cfg: AshlrConfig,
  fetchImpl: typeof fetch,
  explicitOrigin: string | undefined,
): Promise<number | null> {
  try {
    let origin = explicitOrigin;
    if (origin === undefined) {
      const { resolveLlamaServerOrigin } = await import('../local-runtime/llama/config.js');
      origin = resolveLlamaServerOrigin(cfg);
    }
    // The `-c` we launched it with, but only from a record that describes THIS
    // server: a record for another port says nothing about the one answering.
    let requestedContext: number | null = null;
    try {
      const { readOwnershipRecord } = await import('../local-runtime/llama/record.js');
      const record = readOwnershipRecord();
      const port = Number.parseInt(new URL(origin).port, 10);
      if (record !== null && record.port === port && typeof record.requestedContext === 'number') {
        requestedContext = record.requestedContext;
      }
    } catch {
      requestedContext = null;
    }
    const reading = await probeLlamaSlotContext(fetchImpl, origin, { timeoutMs: OLLAMA_TIMEOUT_MS, requestedContext });
    return reading.perSlot;
  } catch {
    return null;
  }
}

async function discoverLocalSeats(
  fetchImpl: typeof fetch,
  baseUrl: string,
  preferred: readonly string[],
  dispatch: { lane: VerseLocalDispatch; baseUrl: string },
  windows: {
    /** Pending llama-server per-slot probe; null on the Ollama lane. */
    llamaSlot: Promise<number | null> | null;
    /** Ollama's unpinned-request default; read lazily, only if a tag needs it. */
    serverDefault: () => VerseOllamaServerDefault | null;
  },
): Promise<{ seats: VerseSeat[]; launches: Map<string, VerseSeatLaunch>; localRuntime: VerseBootstrap['localRuntime'] }> {
  // DISCOVERY IS OLLAMA'S, ALWAYS. `/api/tags` names the installed models and
  // `/api/show` carries the context window and the `tools` capability that
  // decides whether a tag can be a seat at all; llama-server implements
  // neither. `dispatch` changes where the resulting seats SEND turns — and, on
  // the llama-server lane, the window (llama-server allocates per slot,
  // whatever the tag's Modelfile says).
  const probe = await probeOllamaTags(fetchImpl, baseUrl);
  const localRuntime: VerseBootstrap['localRuntime'] = {
    ollama: { reachable: probe.reachable, baseUrl, models: probe.tags },
    ...(dispatch.lane === 'llama-server'
      ? { dispatch: { lane: dispatch.lane, baseUrl: dispatch.baseUrl } }
      : {}),
  };
  const seats: VerseSeat[] = [];
  const launches = new Map<string, VerseSeatLaunch>();
  if (!probe.reachable) return { seats, launches, localRuntime };

  // One /api/show per installed tag: it carries BOTH the context facts and the
  // tool capability that decides whether this can be a seat. The llama-server
  // slot probe (if any) runs concurrently.
  const [details, slotWindow] = await Promise.all([
    Promise.all(probe.tags.map((tag) => probeOllamaModelDetail(fetchImpl, baseUrl, tag, OLLAMA_TIMEOUT_MS))),
    windows.llamaSlot ?? Promise.resolve(null),
  ]);
  const selectable: Array<{ tag: string; detail: VerseOllamaModelDetail | null }> = [];
  probe.tags.forEach((tag, i) => {
    const detail = details[i] ?? null;
    if (localSeatIsSelectable(detail, tag)) selectable.push({ tag, detail });
  });

  // Unpinned tags need what Ollama would ACTUALLY allocate an unpinned request:
  // the server's default (its log, else our env). `/api/ps` residency is read
  // only when no default is known — a resident runner may have been loaded by
  // another client's `options.num_ctx`, so it is not what Verse's turns get
  // (local-models.ts `resolveLocalContextWindow`). Both reads are skipped when
  // every tag pins num_ctx or the llama-server slot already answered.
  const needsServerFacts = slotWindow === null
    && selectable.some(({ detail }) => detail !== null && (detail.numCtx ?? null) === null);
  const serverDefault = needsServerFacts ? windows.serverDefault() : null;
  // (A tag with no native length cannot use the default either — it is never
  // applied uncapped — so residency is its best fact too.)
  const needsResidency = needsServerFacts && (
    (serverDefault?.contextLength ?? null) === null
    || selectable.some(({ detail }) => detail !== null && (detail.numCtx ?? null) === null && (detail.nativeContextLength ?? null) === null)
  );
  const resident = needsResidency ? await probeOllamaResident(fetchImpl, baseUrl, OLLAMA_TIMEOUT_MS) : null;
  const residentByTag = new Map((resident ?? []).map((row) => [row.tag, row.contextLength]));

  const observedAt = new Date().toISOString();
  const built = selectable.map(({ tag, detail }) => {
    const resolved = resolveLocalContextWindow({
      tag,
      lane: dispatch.lane,
      llamaSlotWindow: slotWindow,
      detail,
      residentContext: residentByTag.get(tag) ?? null,
      serverDefault,
    });
    const notes = localWindowNotes(resolved, dispatch.lane, slotWindow !== null);
    const label = localSeatLabel(tag);
    const unavailableReason = localWindowUnusableReason(resolved.window);
    const option = localModelOption(tag, label.replace(/ \(local\)$/, ''), resolved.window, resolved.source);
    const seat: VerseSeat = {
      id: `local:${tag}`,
      engine: 'local',
      label,
      accountId: 'local',
      // Present only when set, so a usable seat's wire shape is unchanged.
      models: [unavailableReason !== null ? { ...option, unavailableReason } : option],
      contextWindow: resolved.window,
      health: { state: 'ready', summary: null, windows: [], observedAt },
      ...(notes.length > 0 ? { notes } : {}),
    };
    return { tag, seat, usable: unavailableReason === null };
  });

  // Usable seats first, then preferred model first, then discovery order.
  // `sort` is stable, so every tag that is not preferred keeps the order
  // `/api/tags` reported it in — and a preferred tag whose window is too small
  // never becomes the default ahead of one that can actually run.
  built.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    return localSeatPreferenceRank(a.tag, preferred) - localSeatPreferenceRank(b.tag, preferred);
  });

  built.forEach(({ seat }) => {
    seats.push(seat);
    launches.set(seat.id, {
      seat,
      launcher: null,
      ollamaBaseUrl: baseUrl,
      // Only on the opted-in lane. Leaving it absent on the default lane keeps
      // a launch record byte-identical to the ones already on disk.
      ...(dispatch.lane === 'llama-server' ? { anthropicBaseUrl: dispatch.baseUrl } : {}),
    });
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
  const dispatchLane = resolveVerseLocalDispatch(cfg, opts.localDispatch);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const claudeUsage = opts.claudeUsage ?? readClaudeUsage;

  const seats: VerseSeat[] = [];
  const launches = new Map<string, VerseSeatLaunch>();

  try {
    const accounts = readConnections(accountsRoot);
    // `undefined` here means "the collector this process registered", which is
    // the whole point: seat health comes from the LIVE monitor, not from the
    // Codex-only evidence file.
    const telemetry = buildSeatTelemetry(accountsRoot, { collector: opts.collector });
    for (const account of accounts) {
      // Models come from THIS seat's own catalog and pinned binary.
      const profile = readSeatProfile(account.command, account.provider);
      const built = nativeSeatModels(account.provider, profile, { claudeVersionsRoot: opts.claudeVersionsRoot });
      const models = built.models;
      const facets = nativeSeatFacets(account.id, account.provider, telemetry, claudeUsage);
      const seat: VerseSeat = {
        id: account.id,
        engine: account.provider,
        label: account.label,
        accountId: account.id,
        models,
        // `models[0]` is the default and is always runnable (runnableFirst),
        // so the seat's headline window is one a new session can actually get.
        contextWindow: models.find((m) => !m.unavailableReason)?.contextWindow ?? null,
        health: facets.health,
      };
      if (facets.capacity) seat.capacity = facets.capacity;
      // Both optional and absent when there is nothing to say, so an ordinary
      // seat's wire shape does not change.
      if (built.cliVersion !== null) seat.cliVersion = built.cliVersion;
      if (built.notes.length > 0) seat.notes = built.notes;
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
    const dispatchBaseUrl = await resolveLocalDispatchBaseUrl(cfg, dispatchLane, ollamaBaseUrl);
    const local = await discoverLocalSeats(
      fetchImpl,
      ollamaBaseUrl,
      preferredLocalTags(cfg),
      { lane: dispatchLane, baseUrl: dispatchBaseUrl },
      {
        llamaSlot: dispatchLane === 'llama-server' ? llamaSlotWindow(cfg, fetchImpl, opts.llamaServerOrigin) : null,
        serverDefault: () => (opts.ollamaServerDefault !== undefined ? opts.ollamaServerDefault : readOllamaServerDefault()),
      },
    );
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

// ---------------------------------------------------------------------------
// Re-read telemetry without re-probing Ollama
// ---------------------------------------------------------------------------

/**
 * Return `discovery` with every NATIVE seat's health and capacity recomputed
 * from the collector's CURRENT state.
 *
 * THE STALENESS BUG THIS FIXES: `GET /api/verse/bootstrap` is a mount-time
 * snapshot behind a short discovery cache. A client that opened the app before
 * the collector's first cycle finished kept an "unknown" seat list for the life
 * of the page. Seat *identity* (which accounts exist, which Ollama tags are
 * installed) is what is expensive to discover and it changes rarely; seat
 * *telemetry* is cheap and changes every poll cycle. So this splits them: the
 * caller may cache the discovery and still hand every reader a live reading.
 *
 * Pure: `discovery` is not mutated. Local seats are returned unchanged — an
 * Ollama tag has no subscription window.
 */
export function refreshSeatTelemetry(
  cfg: AshlrConfig,
  discovery: VerseSeatDiscovery,
  opts: VerseSeatDiscoveryOptions = {},
): VerseSeatDiscovery {
  const accountsRoot = resolveAccountsRoot(cfg, opts.accountsRoot);
  const claudeUsage = opts.claudeUsage ?? readClaudeUsage;
  const telemetry = buildSeatTelemetry(accountsRoot, { collector: opts.collector });

  const seats = discovery.seats.map((seat) => {
    if (seat.engine === 'local') return seat;
    const facets = nativeSeatFacets(seat.accountId, seat.engine, telemetry, claudeUsage);
    const next: VerseSeat = { ...seat, health: facets.health };
    if (facets.capacity) next.capacity = facets.capacity;
    else delete next.capacity;
    return next;
  });

  // Keep the private launch map pointing at the seat objects that were just
  // returned, so the engine and the wire never disagree about a seat.
  const bySeatId = new Map(seats.map((seat) => [seat.id, seat]));
  const launches = new Map<string, VerseSeatLaunch>();
  for (const [id, launch] of discovery.launches) {
    const seat = bySeatId.get(id);
    launches.set(id, seat && seat !== launch.seat ? { ...launch, seat } : launch);
  }

  return { seats, launches, localRuntime: discovery.localRuntime };
}
