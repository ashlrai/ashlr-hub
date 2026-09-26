/**
 * core/verse/accounts.ts — REAL per-account subscription telemetry for Verse
 * (owner T, V2.1). See docs/VERSE-TELEMETRY-V2.md, which is the authority for
 * everything in this file.
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ────────────────────────────────────────
 * `seats.ts` read `<accountsRoot>/observations.json`. That file is an
 * OPERATOR-SEEDED BASELINE that nothing in this repo ever writes — Mason's is
 * `[]`, untouched since the pool was created. The live readings live one
 * directory down under a different name:
 *
 *     <accountsRoot>/ledger/.resource-quota-shared-evidence.json
 *
 * read by `readSharedQuotaEvidence` (core/resources/quota-shared-evidence.ts).
 * Wrong directory AND wrong file, so every seat always saw an empty map and
 * rendered "unknown". The seed file is KEPT as a baseline that live readings
 * merge on top of — exactly the order `resource-console-server.ts` uses
 * (`quotaRefresher.readObservations(base)`), never the other way round.
 *
 * ── WHY THIS SERVER MUST OWN THE COLLECTORS ────────────────────────────────
 * `ResourceConnectionMonitor` keeps its results IN MEMORY ONLY and is served
 * solely by the separate resource-console process. The shared evidence file
 * covers Codex quota workers only, carries a 5-SECOND TTL, and is rejected
 * outright unless a collector is live. So Claude windows and Grok auth state
 * can only reach Verse if the Verse server runs the collectors itself.
 *
 * `acquireResourceQuotaRefreshLease` is EXCLUSIVE PER ROOT and shared by both
 * collectors. If `ashlr resource-console` already holds it, acquisition fails
 * with `collector-owned`; this module degrades to READ-ONLY
 * `readSharedQuotaEvidence` and reports which collector owns the data, rather
 * than crashing or silently showing nothing.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Every probe here is METADATA-ONLY: ZERO tokens and ZERO paid quota. The
 * Claude probe actively verifies `total_cost_usd === 0` and all-zero token
 * counts before accepting output. One cycle is ~9-10 short-lived process
 * spawns, so the poll interval is configurable and polling SUSPENDS after
 * `idleSuspendMs` with no client interest — a backgrounded app must not spawn
 * processes forever.
 *
 * ── SECURITY (non-negotiable, asserted by tests) ───────────────────────────
 *  - `<accountsRoot>/console-startup.json` holds LIVE BEARER TOKENS. This
 *    module never opens it.
 *  - Native-profile launcher commands (`node ~/.ashlr/native-profiles/<x>/
 *    launcher.mjs`) are an account's identity. They are read into the
 *    collector config and NEVER onto a payload, a log line or a snapshot.
 *    Every public shape below is built field-by-field, never by spreading a
 *    connections.json row.
 */

import { dirname, join } from 'node:path';
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';

import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import {
  validateResourcePool,
  type ResourceObservation,
  type ResourcePool,
} from '../resources/pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from '../resources/worker.js';
import {
  createResourceQuotaRefresher,
  validateResourceQuotaRefreshConfig,
  type ResourceQuotaRefreshConfig,
  type ResourceQuotaRefresher,
} from '../resources/quota-refresh.js';
import {
  acquireResourceQuotaRefreshLease,
  ResourceQuotaRefreshLeaseError,
  type ResourceQuotaRefreshLease,
} from '../resources/quota-refresh-lease.js';
import {
  publishSharedQuotaEvidence,
  readSharedQuotaEvidence,
} from '../resources/quota-shared-evidence.js';
import {
  createResourceConnectionMonitor,
  validateResourceConnectionConfig,
  type ResourceConnectionConfig,
  type ResourceConnectionMonitor,
} from '../resources/connection-monitor.js';
import {
  createNativeMetadataCoordinator,
  type NativeMetadataCoordinator,
} from '../resources/metadata-coordinator.js';
import type {
  ResourceAccountConnection,
  ResourceConnectionsSnapshot,
} from '../resources/connection-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The existing collector cadence. One cycle ≈ 9-10 short-lived spawns, $0. */
export const VERSE_ACCOUNTS_DEFAULT_POLL_MS = 30_000;

/** `validateResourceConnectionConfig` accepts only this range. */
export const VERSE_ACCOUNTS_MIN_POLL_MS = 30_000;
export const VERSE_ACCOUNTS_MAX_POLL_MS = 3_600_000;

/** No client has asked for account data in this long ⇒ stop spawning. */
export const VERSE_ACCOUNTS_DEFAULT_IDLE_SUSPEND_MS = 5 * 60_000;

/** How often the idle watchdog checks. Cheap: one clock comparison. */
const IDLE_CHECK_MS = 15_000;

/**
 * How often a read-only collector may retry the native-metadata lease on
 * client interest. The daemon's capacity publisher holds it for one short
 * sample every 5 minutes, so a 30 s spacing takes over within one or two
 * page refreshes without turning every request into a lock attempt.
 */
export const VERSE_ACCOUNTS_LEASE_RETRY_MS = 30_000;

/**
 * Recovery budget for a stopped collection generation.
 *
 * A regeneration only ever runs after the kernel has confirmed every
 * outstanding native process group is gone, so each one is individually safe.
 * The cap is therefore not a safety limit but an ANTI-SPIN limit: it exists so
 * a genuinely broken environment degrades to a truthful "stopped" rather than
 * respawning probes in a tight loop.
 *
 * So the bound is expressed in the only unit that matters — poll cycles. One
 * new generation per cycle costs exactly what normal polling costs (the same
 * probe spawns, plus a few small private writes), and observed behaviour on a
 * healthy machine is that the leftover `git clone` stops a cycle roughly that
 * often. Anything FASTER than one per cycle is a spin, and that is what gets
 * refused. `RECOVERY_MIN_SPACING_MS` is the second, short-horizon guard
 * against a degrade-instantly loop inside a single cycle.
 */
export const VERSE_ACCOUNTS_RECOVERY_WINDOW_MS = 10 * 60_000;

/** Floor for very long poll intervals, so recovery never becomes effectively impossible. */
export const VERSE_ACCOUNTS_MIN_RECOVERIES_PER_WINDOW = 4;

/**
 * Headroom over one-per-cycle. A restarted generation begins its first cycle
 * immediately rather than waiting out the remaining interval, and a cycle runs
 * several codex probes, so the measured healthy-machine rate sits slightly
 * ABOVE one stop per poll interval. Two per cycle covers that with margin
 * while still refusing anything that is actually spinning.
 */
export const VERSE_ACCOUNTS_RECOVERIES_PER_POLL_CYCLE = 2;

/** Generations allowed per rolling window at this poll cadence. */
export function verseAccountsRecoveryBudget(pollIntervalMs: number): number {
  const cycles = Math.ceil(VERSE_ACCOUNTS_RECOVERY_WINDOW_MS / Math.max(1, pollIntervalMs));
  return Math.max(VERSE_ACCOUNTS_MIN_RECOVERIES_PER_WINDOW, cycles * VERSE_ACCOUNTS_RECOVERIES_PER_POLL_CYCLE);
}

/** Shortest gap between two generation starts. Bounds a degrade-instantly loop. */
const RECOVERY_MIN_SPACING_MS = 5_000;

/** How long a single recovery waits for the stranded group before backing off to the watchdog. */
const RECLAIM_BUDGET_MS = 10_000;
/** Cadence of the kernel absence re-check inside that budget. */
const RECLAIM_POLL_MS = 500;

/** Evidence has a 5s TTL, so the owner republishes on a short heartbeat. */
const EVIDENCE_HEARTBEAT_MS = 1_000;

/**
 * The Claude usage probe runs only on VERIFIED Claude Code builds and FAILS
 * CLOSED on any other version (`CLAUDE_USAGE_VERIFIED_VERSIONS` in
 * `src/core/resources/claude-account-usage.ts`). This constant is the NEWEST
 * verified build, kept for display; the drift test asserts it is the last entry
 * of that list. Surfacing the gate is the point: a silent "unknown" would hide it.
 */
export const VERSE_CLAUDE_USAGE_PINNED_VERSION = '2.1.280';

/** The probe's verbatim reason when the installed Claude Code is not the pin. */
export const VERSE_CLAUDE_VERSION_REASON = 'usage-version-unsupported';

const MAX_BASELINE_BYTES = 1024 * 1024;
const MAX_CREDIT_FILE_TAIL_BYTES = 256 * 1024;
const MAX_CREDIT_DIRS_PER_LEVEL = 8;
const MAX_CREDIT_FILES = 8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VerseAccountProvider = 'codex' | 'claude' | 'grok';

/** Display names used in plain-language notes. */
const VERSE_PROVIDER_NAME: Readonly<Record<VerseAccountProvider, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
};

export interface VerseAccountWindow {
  id: string;
  /** Provider-reported percent, or null for NO SIGNAL (which is not zero). */
  usedPercent: number | null;
  /**
   * Machine-readable reset instant. For CLAUDE this is STRUCTURALLY ALWAYS
   * NULL — the provider gives a human string only, in `nativeReport`. Never
   * synthesize a countdown from it.
   */
  resetsAt: string | null;
  /** Claude's verbatim human reset text ("resets Sep 25 at 7pm (America/New_York)"). */
  nativeReport: { source: 'claude-usage'; resetDescription: string | null } | null;
  /**
   * TRUE only when the provider explicitly FLAGGED the limit (Codex's
   * classified `rateLimitReachedType`) and that flag survived to this module.
   * It is never inferred from `usedPercent === 100`: since V3.10 the upstream
   * normalizer writes the flag as the sentinel 100 AND keeps
   * `limitReached: true` beside it, so a bare 100 is a measured 100 (or a
   * pre-3.10 row that lost the flag). See `windowLimitReached`.
   */
  limitReached: boolean;
  /** False when `usedPercent` is a flagged sentinel rather than a reading. */
  measured: boolean;
}

/**
 * Codex credits are INDEPENDENT of the window. A weekly window at 100% with a
 * spendable balance is NOT blocked; showing only the percentage would say the
 * opposite of the truth.
 */
export interface VerseCodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-reported decimal string, kept verbatim — never rounded to a float. */
  balance: string | null;
}

export interface VerseAccountRecord {
  id: string;
  label: string;
  provider: VerseAccountProvider;
  state: ResourceAccountConnection['state'];
  authentication: ResourceAccountConnection['authentication'];
  health: ResourceAccountConnection['health'];
  planType: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  windows: VerseAccountWindow[];
  /** Machine-readable probe reason, verbatim. Never rewritten into prose. */
  reason: string;
  onDemandEnabled: boolean | null;
  executionSupported: boolean;
  /** Codex only; null for every other provider and when no signal exists. */
  credits: VerseCodexCredits | null;
  /**
   * THE CONSTRAINT THAT ACTUALLY BLOCKS WORK: the window with the highest
   * `usedPercent`. "Which account can I use right now" is the only question
   * this view exists to answer, so it is computed here rather than in the UI.
   */
  binding: { id: string; usedPercent: number; limitReached: boolean } | null;
  /** Plain-language facts the UI must show instead of implying a fault. */
  notes: string[];
}

export type VerseAccountsCollectorMode = 'owned' | 'read-only' | 'unconfigured';

export interface VerseAccountsCollectorStatus {
  mode: VerseAccountsCollectorMode;
  state: 'running' | 'suspended' | 'blocked' | 'stopped';
  /** Who owns the exclusive per-root native metadata lease. */
  owner: 'this-server' | 'another-collector' | 'none';
  /** Lease refusal code (`collector-owned`, …) or a config reason. Null when fine. */
  reasonCode: string | null;
  pollIntervalMs: number;
  idleSuspendMs: number;
  lastPolledAt: string | null;
  lastRequestAt: string | null;
  note: string;
}

export interface VerseAccountsSnapshot {
  sampledAt: string;
  refreshing: boolean;
  collector: VerseAccountsCollectorStatus;
  accounts: VerseAccountRecord[];
  /** Where the windows came from, so the UI never implies freshness it lacks. */
  evidenceSource: VerseEvidenceSource;
  notes: string[];
}

export type VerseEvidenceSource = 'collector' | 'shared-evidence' | 'baseline' | 'none';

/** Per-account health evidence in the shape `seats.ts` consumes. */
export interface VerseAccountObservation {
  health: string;
  windows: Array<{
    id: string;
    usedPercent: number | null;
    resetsAt: string | null;
    nativeReport?: { source: 'claude-usage'; resetDescription: string | null };
    /** Only ever the literal `true`, and only when the provider flagged it (see `windowLimitReached`). */
    limitReached?: true;
  }>;
  observedAt: string | null;
  /** Original native expiry; an owner heartbeat never extends it. */
  expiresAt?: string | null;
}

export interface VerseAccountEvidence {
  byAccount: Map<string, VerseAccountObservation>;
  /** Accounts with an individually unexpired native observation, including denied rows. */
  liveAccountIds: ReadonlySet<string>;
  /** A current owner veto: retained windows are display evidence, not authority. */
  unavailableAccountIds: ReadonlySet<string>;
  source: VerseEvidenceSource;
  /** Non-null when another process owns the collector. */
  ownerNote: string | null;
}

// ---------------------------------------------------------------------------
// Paths + small helpers
// ---------------------------------------------------------------------------

/** The private ledger root: where the lease, activity and evidence files live. */
export function accountsLedgerRoot(accountsRoot: string): string {
  return join(accountsRoot, 'ledger');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bounded, permissive JSON read for owner-authored CONFIG ONLY (the account
 * roster and the seeded baseline). The private-storage reader
 * (`readResourceJson`) still guards everything that feeds the collector or the
 * lease. Nothing read through here is a secret: the launcher `command` key is
 * never touched by either caller.
 */
function readJsonLenient(file: string, maxBytes: number): unknown {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    if (raw.length > maxBytes) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function clampPollMs(value: number | undefined): number {
  const raw = value ?? VERSE_ACCOUNTS_DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(raw)) return VERSE_ACCOUNTS_DEFAULT_POLL_MS;
  return Math.max(VERSE_ACCOUNTS_MIN_POLL_MS, Math.min(VERSE_ACCOUNTS_MAX_POLL_MS, raw));
}

// ---------------------------------------------------------------------------
// Account identities (PUBLIC fields only — the launcher never leaves this file)
// ---------------------------------------------------------------------------

export interface VerseAccountIdentity {
  id: string;
  label: string;
  provider: VerseAccountProvider;
}

function isProvider(value: unknown): value is VerseAccountProvider {
  return value === 'codex' || value === 'claude' || value === 'grok';
}

/**
 * The id/label/provider triple from connections.json — and NOTHING else. The
 * `command` key is deliberately not read here: this result is serialized.
 */
export function readVerseAccountIdentities(accountsRoot: string): VerseAccountIdentity[] {
  const parsed = readJsonLenient(join(accountsRoot, 'connections.json'), MAX_BASELINE_BYTES);
  if (!isRecord(parsed) || !Array.isArray(parsed['accounts'])) return [];
  const out: VerseAccountIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of parsed['accounts']) {
    if (!isRecord(entry)) continue;
    const id = entry['id'];
    const provider = entry['provider'];
    if (typeof id !== 'string' || id.length === 0 || id.length > 64 || seen.has(id)) continue;
    if (!isProvider(provider)) continue;
    const rawLabel = entry['label'];
    const label = typeof rawLabel === 'string' && rawLabel.length > 0 && rawLabel.length <= 80 ? rawLabel : id;
    seen.add(id);
    out.push({ id, label, provider });
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collector configuration
// ---------------------------------------------------------------------------

interface VerseAccountsConfig {
  accountsRoot: string;
  ledgerRoot: string;
  pool: ResourcePool;
  bindings: ResourceBinding[];
  /** Codex quota workers. Null when quota-config.json is absent/invalid. */
  quota: ResourceQuotaRefreshConfig | null;
  /** All accounts, including Claude and Grok. Null when unusable. */
  connections: ResourceConnectionConfig | null;
}

/**
 * Load every collector input from the accounts root. Never throws: each piece
 * degrades independently, and a missing pool.json disables collection entirely
 * (there is nothing to validate observations against).
 */
export function readVerseAccountsConfig(accountsRoot: string, pollIntervalMs?: number): VerseAccountsConfig | null {
  let pool: ResourcePool;
  let bindings: ResourceBinding[];
  try {
    pool = validateResourcePool(readResourceJson(join(accountsRoot, 'pool.json')));
    bindings = validateResourceBindings(readResourceJson(join(accountsRoot, 'bindings.json')), pool);
  } catch {
    return null;
  }

  let quota: ResourceQuotaRefreshConfig | null = null;
  try {
    quota = validateResourceQuotaRefreshConfig(
      readResourceJson(join(accountsRoot, 'quota-config.json')), pool, bindings);
  } catch {
    quota = null;
  }

  let connections: ResourceConnectionConfig | null = null;
  try {
    const raw = readResourceJson(join(accountsRoot, 'connections.json'), 1024 * 1024);
    const validated = validateResourceConnectionConfig(raw);
    // The ONLY change we make to the operator's config: the poll cadence.
    connections = { ...validated, intervalMs: clampPollMs(pollIntervalMs ?? validated.intervalMs) };
  } catch {
    connections = null;
  }

  return { accountsRoot, ledgerRoot: accountsLedgerRoot(accountsRoot), pool, bindings, quota, connections };
}

// ---------------------------------------------------------------------------
// Evidence: baseline ← shared evidence ← in-process collector
// ---------------------------------------------------------------------------

function toObservationMap(rows: ResourceObservation[]): Map<string, VerseAccountObservation> {
  const out = new Map<string, VerseAccountObservation>();
  const now = Date.now();
  for (const row of rows) {
    // The shared file's five-second heartbeat proves its OWNER is alive, not
    // that each older native sample is still current. Never renew a row here.
    if (Date.parse(row.observedAt) > now || !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= now || row.windows.length === 0) continue;
    out.set(row.workerId, {
      health: row.health,
      // V3.10 — KEEP THE FLAG. This is the evidence path (in-process collector
      // and the shared ledger file); rebuilding the window as the old
      // three-key shape silently turned a provider DENIAL back into an
      // unexplained measured 100, so `seatUsability` could not see Codex as
      // exhausted here even though the live connection path could.
      windows: row.windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt,
        ...(w.limitReached ? { limitReached: true as const } : {}) })),
      observedAt: row.observedAt,
      expiresAt: row.expiresAt,
    });
  }
  return out;
}

/**
 * Merge live readings ON TOP OF the seeded baseline, by account id — the same
 * precedence `resource-console-server.ts` uses (`readObservations(base)`). A
 * live row REPLACES its baseline row; baseline rows with no live counterpart
 * survive. Never the other way round: a stale seed must not mask a live read.
 */
export function overlayObservations(
  baseline: Map<string, VerseAccountObservation>,
  live: Map<string, VerseAccountObservation>,
): Map<string, VerseAccountObservation> {
  const merged = new Map(baseline);
  for (const [id, row] of live) merged.set(id, row);
  return merged;
}

/**
 * The operator-seeded `observations.json` baseline.
 *
 * Read leniently, on purpose: it is owner-authored configuration that predates
 * the private-storage rules, and this is exactly the parse `seats.ts` used
 * before V2.1. It is only ever a FLOOR — every live reading overlays it.
 */
export function readBaselineObservations(accountsRoot: string): Map<string, VerseAccountObservation> {
  const out = new Map<string, VerseAccountObservation>();
  const parsed = readJsonLenient(join(accountsRoot, 'observations.json'), MAX_BASELINE_BYTES);
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const workerId = entry['workerId'];
    if (typeof workerId !== 'string' || workerId.length === 0) continue;
    const windows: VerseAccountObservation['windows'] = [];
    if (Array.isArray(entry['windows'])) {
      for (const w of entry['windows']) {
        if (!isRecord(w) || typeof w['id'] !== 'string') continue;
        const used = w['usedPercent'];
        const resets = w['resetsAt'];
        windows.push({
          id: w['id'],
          usedPercent: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
          resetsAt: typeof resets === 'string' ? resets : null,
        });
      }
    }
    out.set(workerId, {
      health: typeof entry['health'] === 'string' ? entry['health'] : 'unknown',
      windows,
      observedAt: typeof entry['observedAt'] === 'string' ? entry['observedAt'] : null,
    });
  }
  return out;
}

/**
 * Read the evidence a READER sees, in strictly decreasing freshness:
 *   1. the in-process collector, when this server owns it,
 *   2. `<accountsRoot>/ledger/.resource-quota-shared-evidence.json` (Codex
 *      workers only, 5s TTL, rejected unless a collector is live),
 *   3. the operator-seeded `observations.json` baseline.
 *
 * Never throws. `source` says which of the three answered, so nothing implies
 * freshness it does not have.
 */
export function readVerseAccountEvidence(
  accountsRoot: string,
  collector?: VerseAccountCollector | null,
): VerseAccountEvidence {
  const baseline = readBaselineObservations(accountsRoot);

  if (collector && collector.accountsRoot === accountsRoot) {
    const live = collector.observations();
    if (live.length > 0) {
      // The owner retains its last measured rows across probe failures. Its
      // current admission veto must win over those rows here as well as in the
      // shared publication read by another process.
      const unavailable = new Set(collector.unavailableWorkerIds());
      const fresh = toObservationMap(live);
      return {
        byAccount: overlayObservations(baseline, fresh),
        liveAccountIds: new Set(fresh.keys()),
        unavailableAccountIds: new Set([...fresh.keys()].filter((id) => unavailable.has(id))),
        source: 'collector',
        ownerNote: null,
      };
    }
  }

  const config = readVerseAccountsConfig(accountsRoot);
  if (config?.quota) {
    try {
      const evidence = readSharedQuotaEvidence({
        root: config.ledgerRoot,
        pool: config.pool,
        bindings: config.bindings,
        config: config.quota,
      });
      // The shared owner may retain a prior native observation after a probe
      // fails. Its unavailable-worker veto outranks that still-unexpired row;
      // the row is history, not proof that this account is usable now.
      const unavailable = new Set(evidence.unavailableWorkerIds);
      const fresh = toObservationMap(evidence.observations);
      return {
        byAccount: overlayObservations(baseline, fresh),
        liveAccountIds: new Set(fresh.keys()),
        unavailableAccountIds: new Set([...fresh.keys()].filter((id) => unavailable.has(id))),
        source: 'shared-evidence',
        ownerNote: 'Another collector owns the native metadata lease; these readings are read-only.',
      };
    } catch {
      // No live collector, stale, or past the 5s TTL — fall back to the seed.
    }
  }

  return {
    byAccount: baseline,
    liveAccountIds: new Set(),
    unavailableAccountIds: new Set(),
    source: baseline.size > 0 ? 'baseline' : 'none',
    ownerNote: null,
  };
}

// ---------------------------------------------------------------------------
// Codex credits — bounded read of the account's own session transcripts
// ---------------------------------------------------------------------------

function readTail(file: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 2) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/** Depth-bounded search for the provider's `credits` object inside one row. */
function findCredits(value: unknown, depth = 0): VerseCodexCredits | null {
  if (depth > 6 || !isRecord(value)) return null;
  const credits = value['credits'];
  if (isRecord(credits) && typeof credits['has_credits'] === 'boolean') {
    const balance = credits['balance'];
    return {
      hasCredits: credits['has_credits'],
      unlimited: credits['unlimited'] === true,
      balance: typeof balance === 'string' && balance.length <= 64 ? balance
        : typeof balance === 'number' && Number.isFinite(balance) ? String(balance) : null,
    };
  }
  for (const nested of Object.values(value)) {
    const found = findCredits(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Newest-first bounded descent through a `YYYY/MM/DD` session tree. */
function newestRolloutFiles(sessionsRoot: string): string[] {
  const descend = (dir: string, depth: number): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    entries.sort((a, b) => b.localeCompare(a));
    if (depth === 3) {
      return entries
        .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
        .slice(0, MAX_CREDIT_FILES)
        .map((name) => join(dir, name));
    }
    const out: string[] = [];
    for (const name of entries.slice(0, MAX_CREDIT_DIRS_PER_LEVEL)) {
      out.push(...descend(join(dir, name), depth + 1));
      if (out.length >= MAX_CREDIT_FILES) break;
    }
    return out.slice(0, MAX_CREDIT_FILES);
  };
  return descend(sessionsRoot, 0);
}

/**
 * Credits + plan for ONE pinned Codex profile, from the newest
 * `rollout-*.jsonl` under that profile's `CODEX_HOME`.
 *
 * NOTE (verified 2026-09-19): the pinned per-account profiles' session
 * directories are EMPTY, so this legitimately returns null today — which is
 * "no signal", not "no credits". The caller must render those differently.
 *
 * `sessionsRoot` is an absolute private path and is NEVER returned or logged.
 */
export function readCodexCreditsFromSessions(sessionsRoot: string): VerseCodexCredits | null {
  for (const file of newestRolloutFiles(sessionsRoot)) {
    const tail = readTail(file, MAX_CREDIT_FILE_TAIL_BYTES);
    if (!tail) continue;
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"credits"')) continue;
      try {
        const found = findCredits(JSON.parse(line));
        if (found) return found;
      } catch {
        // A truncated first line of the tail window, or a non-JSON row.
      }
    }
  }
  return null;
}

/**
 * Map account id → that account's Codex session directory, derived from the
 * launcher path in connections.json (`<profile>/launcher.mjs` ⇒
 * `<profile>/native-state/sessions`).
 *
 * The returned paths are PRIVATE: they name native-profile directories and
 * must never reach a payload, a log line or a snapshot.
 */
function codexSessionRoots(config: ResourceConnectionConfig): Map<string, string> {
  const out = new Map<string, string>();
  for (const account of config.accounts) {
    if (account.provider !== 'codex') continue;
    const launcher = account.command[account.command.length - 1];
    if (typeof launcher !== 'string' || !launcher.endsWith('.mjs')) continue;
    out.set(account.id, join(dirname(launcher), 'native-state', 'sessions'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record derivation
// ---------------------------------------------------------------------------

/**
 * TRUE when a provider actually FLAGGED the limit, which is a different fact
 * from a window that measured 100%.
 *
 * This used to be inferred as `provider === 'codex' && usedPercent === 100`.
 * That inference is wrong: `codexWindow()` clamps a genuine reading with
 * `Math.min(100, raw)`, and the telemetry doc's own verified Codex payload
 * (docs/VERSE-TELEMETRY-V2.md:40-43) is a MEASURED `used_percent: 100.0` with
 * no `rateLimitReachedType` — exactly the case the old inference got
 * backwards, suppressing the number behind prose asserting a provenance
 * nothing here witnessed.
 *
 * So this reads a flag it was GIVEN and never derives one. Since V3.10 the
 * flag is threaded end to end: `normalizeCodexResourceObservation`
 * (core/resources/provider-observations.ts) keeps `limitReached: true` beside
 * the sentinel 100, `ResourceQuotaWindow` (pool-policy.ts) validates and keeps
 * it, and `toObservationMap` here preserves it on the evidence path. A bare
 * 100 therefore renders as the measured 100% it is; the only rows where the
 * provenance is still ambiguous are ones written by a pre-3.10 build (or a
 * hand-seeded `observations.json`), which `providerNotes` says plainly.
 */
function windowLimitReached(window: { limitReached?: boolean }): boolean {
  return window.limitReached === true;
}

function mapWindow(
  provider: VerseAccountProvider,
  window: { id: string; usedPercent: number | null; resetsAt: string | null; limitReached?: boolean;
    nativeReport?: { source: 'claude-usage'; resetDescription: string | null } },
): VerseAccountWindow {
  const limitReached = windowLimitReached(window);
  return {
    id: window.id,
    usedPercent: window.usedPercent,
    // Claude never supplies a machine-readable reset; only the human string.
    resetsAt: provider === 'claude' ? null : window.resetsAt,
    nativeReport: window.nativeReport ?? null,
    limitReached,
    measured: !limitReached,
  };
}

/** The window with the highest `usedPercent` — the constraint that blocks work. */
export function bindingWindow(windows: VerseAccountWindow[]): VerseAccountRecord['binding'] {
  let best: VerseAccountWindow | null = null;
  for (const window of windows) {
    if (window.usedPercent === null) continue;
    if (best === null || window.usedPercent > best.usedPercent!) best = window;
  }
  return best === null ? null
    : { id: best.id, usedPercent: best.usedPercent!, limitReached: best.limitReached };
}

/**
 * The probe reasons that mean "the pinned Grok profile answered and it has NO
 * usable account identity" — i.e. it is not authenticated.
 *
 * Grok's probe cannot report "observed but signed out": `checkedOutput` in
 * core/resources/grok-account-probe.ts REJECTS any `observed` result whose
 * `loggedIn` is not exactly `true`, so an unauthenticated profile always comes
 * back `failed` with a reason. `ResourceConnectionMonitor` then leaves the row
 * on its `connection-probe-unavailable` initializer (`state: 'unavailable'`,
 * `authentication: 'unknown'`), and the single most actionable account state
 * on this machine — docs/VERSE-TELEMETRY-V2.md:56-63 and :142 — would render
 * as a shrug instead of "signed out — reconnect".
 *
 * `probe-account-unavailable` is what the helper emits when `_x.ai/auth/info`
 * carries no usable email/method (grok-account-probe-process.ts:116). The
 * identity-CHANGE reasons (`probe-account-changed`,
 * `probe-account-hint-mismatch`) are deliberately NOT here: those profiles are
 * signed in, as somebody else, and calling that "signed out" would be a second
 * lie in place of the first. Transport failures (`probe-native-unavailable`,
 * `probe-provider-error`, …) are not here either — they are "no reading".
 */
export const VERSE_GROK_SIGNED_OUT_REASONS: readonly string[] = ['probe-account-unavailable'];

/** Whether this row is a Grok profile the probe found unauthenticated. */
export function grokSignedOut(connection: Pick<ResourceAccountConnection,
  'provider' | 'state' | 'authentication' | 'reason'>): boolean {
  if (connection.provider !== 'grok') return false;
  if (connection.state === 'signed-out' || connection.authentication === 'signed-out') return true;
  return connection.authentication !== 'signed-in' &&
    VERSE_GROK_SIGNED_OUT_REASONS.includes(connection.reason);
}

function providerNotes(
  provider: VerseAccountProvider,
  record: Pick<VerseAccountRecord, 'state' | 'health' | 'reason' | 'windows' | 'credits'>,
): string[] {
  const notes: string[] = [];
  if (provider === 'claude') {
    notes.push('Claude reports no machine-readable reset time; the window text is the provider\'s own wording.');
    if (record.health === 'unknown') {
      notes.push('Claude health is always "unknown" by construction — that is not a fault.');
    }
    if (record.reason === VERSE_CLAUDE_VERSION_REASON) {
      notes.push(
        `The Claude usage probe runs only on verified Claude Code builds (newest: ${VERSE_CLAUDE_USAGE_PINNED_VERSION}) ` +
        `and failed closed with "${VERSE_CLAUDE_VERSION_REASON}". Verify the new build's /usage is local and ` +
        'zero-cost, then add it to CLAUDE_USAGE_VERIFIED_VERSIONS in src/core/resources/claude-account-usage.ts.',
      );
    }
  }
  if (provider === 'codex') {
    if (record.windows.some((w) => w.limitReached)) {
      notes.push('The provider flagged this Codex window as "limit reached" — that flag is a denial, not a measurement.');
    } else if (record.windows.some((w) => w.usedPercent === 100)) {
      // Honest about what this layer can and cannot witness. Since V3.10 a
      // flagged denial arrives WITH `limitReached`, so an unflagged 100 is
      // most likely measured — but a row persisted by a pre-3.10 build, or
      // hand-seeded in observations.json, still carries a flagged 100 with
      // the flag stripped. The number is reported as given; the provenance
      // is not claimed in either direction.
      notes.push(
        'A Codex window reads exactly 100% with no "limit reached" flag. Current builds keep that flag when ' +
        'the provider sets it, but rows written by an older build or seeded by hand may have lost it, so this ' +
        'surface reports the number it was given and does not claim which of the two it is.',
      );
    }
    if (record.credits?.hasCredits) {
      notes.push('Codex credits are independent of the window: a fully used window with a balance is not blocked.');
    } else if (record.credits === null) {
      notes.push('No Codex credit signal for this account (its pinned session history is empty) — unknown, not zero.');
    }
  }
  if (provider === 'grok') {
    notes.push('Grok is absent from frontier-usage.ts, so /api/usage never carries it; this probe is its only source.');
  }
  if (record.state === 'signed-out') {
    // The literal reconnect command IS the pinned launcher invocation, which
    // is the account's identity and must never be serialized. Name the remedy
    // (V3.10: Verse's Reconnect runs that command server-side, in Terminal)
    // and say plainly why the rest is withheld.
    notes.push(
      `${VERSE_PROVIDER_NAME[provider]} is signed out. Re-authenticate it with Reconnect in Verse, which opens this ` +
      "profile's own sign-in in Terminal, before this seat can be used; the profile path is withheld from this " +
      'payload on purpose.',
    );
  }
  return notes;
}

/**
 * Project one live `ResourceAccountConnection` onto the public record. Built
 * field-by-field on purpose: the source row's sibling launcher config must not
 * be able to ride along through a spread.
 */
export function deriveVerseAccountRecord(
  connection: ResourceAccountConnection,
  extra: { credits?: VerseCodexCredits | null } = {},
): VerseAccountRecord {
  const provider = connection.provider;
  const windows = connection.windows.map((w) => mapWindow(provider, w));
  const credits = provider === 'codex' ? extra.credits ?? null : null;
  // See VERSE_GROK_SIGNED_OUT_REASONS: the monitor structurally cannot set
  // this state for Grok, so it is derived here from the verbatim probe reason
  // — and only from the reason that actually means "not authenticated".
  const signedOut = grokSignedOut(connection);
  const state = signedOut ? 'signed-out' : connection.state;
  const base = {
    state,
    health: connection.health,
    reason: connection.reason,
    windows,
    credits,
  };
  return {
    id: connection.id,
    label: connection.label,
    provider,
    state,
    authentication: signedOut ? 'signed-out' : connection.authentication,
    health: connection.health,
    planType: connection.planType,
    observedAt: connection.observedAt,
    expiresAt: connection.expiresAt,
    windows,
    reason: connection.reason,
    onDemandEnabled: connection.onDemandEnabled,
    executionSupported: connection.executionSupported,
    credits,
    binding: bindingWindow(windows),
    notes: providerNotes(provider, base),
  };
}

/**
 * The degraded record: no live connection monitor, so identity comes from
 * connections.json and windows (Codex only) from whatever evidence exists.
 */
export function deriveVerseAccountRecordFromEvidence(
  identity: VerseAccountIdentity,
  observation: VerseAccountObservation | null,
  reason: string,
  historical = false,
  unavailable = false,
): VerseAccountRecord {
  // Operator-seeded baselines have no native expiry witness. Keep them in the
  // evidence reader for diagnostics, but never publish them as current meters.
  const windows = historical ? [] : (observation?.windows ?? []).map((w) => mapWindow(identity.provider, w));
  const health: ResourceAccountConnection['health'] =
    historical ? 'unknown' : unavailable ? 'unavailable'
      : observation?.health === 'ready' ? 'reachable' : observation ? 'unavailable' : 'unknown';
  const evidenceReason = historical && observation ? 'baseline-historical'
    : unavailable ? 'native-account-unavailable' : reason;
  const base = { state: 'unavailable' as const, health, reason: evidenceReason, windows, credits: null };
  return {
    id: identity.id,
    label: identity.label,
    provider: identity.provider,
    state: observation && !historical && !unavailable ? 'observed' : 'unavailable',
    authentication: 'unknown',
    health,
    planType: null,
    observedAt: historical ? null : observation?.observedAt ?? null,
    expiresAt: historical ? null : observation?.expiresAt ?? null,
    windows,
    reason: evidenceReason,
    onDemandEnabled: null,
    executionSupported: identity.provider !== 'grok',
    credits: null,
    binding: bindingWindow(windows),
    notes: providerNotes(identity.provider, base),
  };
}

/**
 * Shown when native collection stopped under a held lease. It states the fact,
 * the blast radius, and the remedy, and it never names a profile path or a
 * launcher command.
 */
export const VERSE_COLLECTOR_STOPPED_NOTE =
  'Native account polling stopped after a metadata sample could not confirm its process cleanup, so these account readings are stale and no new ones are being collected. Restart `ashlr verse` to begin a new collection generation.';

/** Shown while a stopped generation waits for the kernel to confirm its stranded group is gone. */
export const VERSE_COLLECTOR_RECOVERING_NOTE =
  'Native account polling stopped after a metadata sample could not confirm its process cleanup. These readings are stale; a new collection generation starts automatically as soon as the leftover process group is confirmed gone. No restart is needed.';

/** Shown once the bounded recovery budget for the rolling window is spent. */
export const VERSE_COLLECTOR_RECOVERY_EXHAUSTED_NOTE =
  'Native account polling kept stopping without confirming its process cleanup, so automatic recovery has paused for this window and no new readings are being collected. Restart `ashlr verse` to begin a new collection generation immediately.';

export const VERSE_ACCOUNT_NOTES: readonly string[] = [
  'Every probe behind this view is metadata-only: zero tokens and zero paid quota.',
  'A null percent means the provider gave no signal — it is not the same as zero.',
];

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

export interface VerseAccountCollectorOptions {
  accountsRoot: string;
  /** Default 30_000, clamped to the monitor's accepted 30s-1h range. */
  pollIntervalMs?: number;
  /** Suspend polling after this long with no client interest. Default 5 min. */
  idleSuspendMs?: number;
  signal?: AbortSignal;
  /** Diagnostics sink. Receives plain sentences only — never a command or token. */
  log?: (message: string) => void;
}

export interface VerseAccountCollector {
  readonly accountsRoot: string;
  status(): VerseAccountsCollectorStatus;
  /** Record client interest; resumes a suspended collector. */
  touch(): void;
  /** Live per-account connection snapshot, or null when this server is read-only. */
  connections(): ResourceConnectionsSnapshot | null;
  /** Live Codex observations (NOT merged with the baseline — the caller merges). */
  observations(): ResourceObservation[];
  /** Current account/transport vetoes, including failures after a prior sample. */
  unavailableWorkerIds(): string[];
  /** Codex credits by account id, best effort. */
  credits(accountId: string): VerseCodexCredits | null;
  close(): Promise<void>;
}

/**
 * Acquire the exclusive per-root native-metadata lease and run both collectors.
 * On `collector-owned` (or any other clean refusal) the returned collector runs
 * in READ-ONLY mode: it spawns nothing and every reader falls back to
 * `readSharedQuotaEvidence`. It never throws for that case.
 */
export async function startVerseAccountCollector(
  options: VerseAccountCollectorOptions,
): Promise<VerseAccountCollector> {
  const accountsRoot = options.accountsRoot;
  const pollIntervalMs = clampPollMs(options.pollIntervalMs);
  const idleSuspendMs = Math.max(60_000, options.idleSuspendMs ?? VERSE_ACCOUNTS_DEFAULT_IDLE_SUSPEND_MS);
  const log = options.log ?? (() => {});

  const config = readVerseAccountsConfig(accountsRoot, pollIntervalMs);

  let mode: VerseAccountsCollectorMode = 'unconfigured';
  let state: VerseAccountsCollectorStatus['state'] = 'stopped';
  let owner: VerseAccountsCollectorStatus['owner'] = 'none';
  let reasonCode: string | null = config ? null : 'accounts-pool-unavailable';
  let lastPolledAt: string | null = null;
  let lastRequestAt: number = Date.now();

  let lease: ResourceQuotaRefreshLease | null = null;
  let coordinator: NativeMetadataCoordinator | null = null;
  let monitor: ResourceConnectionMonitor | null = null;
  let refresher: ResourceQuotaRefresher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastConnections: ResourceConnectionsSnapshot | null = null;
  let lastObservations: ResourceObservation[] = [];
  let publicationFailed = false;
  let cleanupUncertain = false;
  let closed = false;
  /** Set at the top of close(), so an in-flight recovery can bail out at once. */
  let closing = false;

  /** Bumped every time a NEW collection generation starts behind a discharged fence. */
  let generation = 0;
  /** Start times of recent generations, pruned to the rolling recovery window. */
  const recoveries: number[] = [];
  /** The in-flight recovery, shared so concurrent callers never overlap teardown. */
  let recovering: Promise<void> | null = null;
  /**
   * A stopped generation whose stranded native process group is not yet
   * confirmed absent (or whose recovery budget is spent). Distinct from
   * `state`, because the monitor is already torn down by then and
   * `collectionDegraded()` can no longer see the evidence that stopped it.
   */
  let recoveryHold: null | 'awaiting-cleanup' | 'exhausted' = null;

  const creditsCache = new Map<string, VerseCodexCredits | null>();
  const sessionRoots = config?.connections ? codexSessionRoots(config.connections) : new Map<string, string>();

  function publishEvidence(): void {
    if (!config?.quota || !lease || !refresher || publicationFailed) return;
    try {
      publishSharedQuotaEvidence({
        root: config.ledgerRoot,
        pool: config.pool,
        bindings: config.bindings,
        config: config.quota,
        lease,
        state: refresher.snapshot().state,
        evidence: {
          observations: refresher.readObservations([]),
          unavailableWorkerIds: refresher.unavailableWorkerIds(true),
          quotaUnavailableWorkerIds: refresher.quotaUnavailableWorkerIds(true),
        },
      });
    } catch {
      // Publication is the witness that this owner is live. Losing it makes
      // every reader's evidence stale — which is correct — so stop republishing
      // rather than emitting something that claims freshness.
      publicationFailed = true;
      if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
      log('Verse account collector: shared quota evidence publication failed; readers fall back to the baseline.');
    }
  }

  function captureLive(): void {
    if (monitor) {
      lastConnections = monitor.snapshot();
      lastPolledAt = lastConnections.sampledAt;
    }
    if (refresher) lastObservations = refresher.readObservations([]);
  }

  /** Spin the collectors up. Requires a held lease. */
  function resume(): void {
    if (closed || mode !== 'owned' || !lease || !config) return;
    if (monitor || refresher) return;
    try {
      coordinator = createNativeMetadataCoordinator({
        ...(options.signal ? { signal: options.signal } : {}),
        // The cap of 2 is deliberate and must not be raised.
        beginNativeActivity: () => lease!.beginNativeActivity(),
      });
      if (config.quota) {
        refresher = createResourceQuotaRefresher({
          pool: config.pool,
          bindings: config.bindings,
          config: config.quota,
          cwd: config.ledgerRoot,
          ...(options.signal ? { signal: options.signal } : {}),
          assertOwnership: lease.assertOwnership,
          coordinator,
          onChange: publishEvidence,
        });
        publishEvidence();
        if (!publicationFailed) {
          heartbeat = setInterval(publishEvidence, EVIDENCE_HEARTBEAT_MS);
          heartbeat.unref?.();
        }
      }
      if (config.connections) {
        monitor = createResourceConnectionMonitor({
          config: config.connections,
          cwd: config.ledgerRoot,
          ...(options.signal ? { signal: options.signal } : {}),
          assertOwnership: lease.assertOwnership,
          coordinator,
        });
      }
      state = 'running';
    } catch {
      state = 'blocked';
      reasonCode = 'collector-start-failed';
      log('Verse account collector: could not start native metadata collection; account data will read as unknown.');
    }
  }

  /**
   * Stop spawning, keep the lease. A suspended collector costs nothing.
   *
   * `suspend()` nulls `monitor`/`refresher` BEFORE awaiting their teardown, so
   * a second caller — `close()`, landing while the idle watchdog's suspend is
   * still inside `Promise.allSettled` — used to hit the "nothing to stop"
   * guard and return IMMEDIATELY. Two things went wrong then: `close()` read
   * `cleanupUncertain` while the first suspend had not yet set it, asking the
   * lease for the non-preserving close even when the sample turned out
   * uncertain; and `collectorClose()` in src/cli/verse.ts resolved early, so
   * the process could exit while detached probe process GROUPS were still in
   * their SIGINT→grace window — the exact guarantee this shutdown path exists
   * to provide. So the in-flight teardown is shared: every caller awaits the
   * same promise.
   */
  let suspending: Promise<void> | null = null;

  function suspend(): Promise<void> {
    if (suspending) return suspending;
    if (!monitor && !refresher) { state = mode === 'owned' ? 'suspended' : state; return Promise.resolve(); }
    suspending = doSuspend().finally(() => { suspending = null; });
    return suspending;
  }

  async function doSuspend(): Promise<void> {
    captureLive();
    if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
    coordinator?.dispose();
    const current = { monitor, refresher };
    monitor = null;
    refresher = null;
    coordinator = null;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => current.refresher?.close()),
      // close() THROWS when any sample ended `uncertain`. That is information,
      // not a crash: catch it, record it, keep going.
      Promise.resolve().then(() => current.monitor?.close()),
    ]);
    if (results.some((r) => r.status === 'rejected')) {
      cleanupUncertain = true;
      log('Verse account collector: a native metadata sample ended uncertain; the durable fence is preserved.');
    }
    if (!closed) state = 'suspended';
  }

  function tickIdle(): void {
    if (closed || mode !== 'owned') return;
    if (!monitor && !refresher) return;
    if (Date.now() - lastRequestAt < idleSuspendMs) return;
    log('Verse account collector: no client has asked for account data recently; pausing native polling.');
    void suspend().catch(() => {});
  }

  /** Prune the rolling window and report whether another generation may start. */
  function recoveryBudgetAvailable(): boolean {
    const now = Date.now();
    while (recoveries.length > 0 && now - recoveries[0]! >= VERSE_ACCOUNTS_RECOVERY_WINDOW_MS) recoveries.shift();
    return recoveries.length < verseAccountsRecoveryBudget(pollIntervalMs);
  }

  /** Milliseconds still owed before the next generation may start. */
  function recoverySpacingWaitMs(): number {
    const last = recoveries[recoveries.length - 1];
    if (last === undefined) return 0;
    return Math.max(0, RECOVERY_MIN_SPACING_MS - (Date.now() - last));
  }

  /**
   * ── WHY A NEW GENERATION IS SAFE, AND WHY ONE IS NEEDED ──────────────────
   *
   * A sample ends `uncertain` when `runVerifySubprocessAsync`'s fixed
   * post-close drain expires before `kill(-pgid, 0)` reports ESRCH. Measured
   * cause here: `codex app-server` kicks off a background
   * `git clone --depth 1 …/openai/plugins.git` into its CODEX_HOME; the clone
   * inherits the probe's POSIX group, outlives both the App Server and the
   * helper (reparented to PID 1), and keeps the group alive past the drain.
   * The receipt is CORRECT — the group really was still there.
   *
   * What was wrong was the response: one such sample latched the monitor, the
   * shared coordinator and the collector for the whole life of the process, so
   * a transient, self-clearing clone permanently blanked the whole feature.
   *
   * `unconfirmed` means "not witnessed YET", so recovery FINISHES the witness
   * instead of discarding it: `lease.reclaimNativeActivity()` re-runs the same
   * kernel check and releases the stranded reservation ONLY on ESRCH. Until
   * then nothing is started, the durable pending fence stays published, and
   * the status keeps saying collection is stopped. So a new generation only
   * ever begins when the ≤2-concurrent-native-client invariant is provably
   * restored — never on a downgraded or assumed witness.
   *
   * Discharging the fence also unleaks the lease: `cleanupUncertain` goes back
   * to false, so `close()` can remove the pending marker and release the lock
   * instead of preserving a fence that no longer describes anything.
   */
  async function recoverGeneration(): Promise<void> {
    if (closing || closed || mode !== 'owned' || !lease) return;
    if (!collectionDegraded() && recoveryHold === null) return;
    recoveryHold ??= 'awaiting-cleanup';
    // Stop spawning first: teardown is what makes the outstanding reservation
    // set final, and it is what `monitor.close()` reports uncertainty through.
    await suspend();
    const deadline = Date.now() + RECLAIM_BUDGET_MS;
    for (;;) {
      if (closing || closed || !lease) return;
      let outcome: ReturnType<ResourceQuotaRefreshLease['reclaimNativeActivity']>;
      try { outcome = lease.reclaimNativeActivity(); }
      catch { outcome = { state: 'blocked', reasonCode: 'activity-evidence-unavailable' }; }
      if (outcome.state !== 'blocked') break;
      if (outcome.reasonCode !== 'process-group-not-confirmed-absent' || Date.now() >= deadline || closing) {
        // Not confirmed absent. Keep the fence, keep reporting stopped, and
        // let the watchdog re-check — re-checking costs one signal-zero probe.
        recoveryHold = 'awaiting-cleanup';
        state = 'blocked';
        return;
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, RECLAIM_POLL_MS).unref?.(); });
    }
    if (closing || closed || !lease) return;
    // Every outstanding group is kernel-confirmed absent, so the fence is
    // discharged whether or not a new generation follows. Doing this BEFORE the
    // budget and idle checks is what keeps the lease from being leaked: `close()`
    // can now drop the pending marker instead of preserving a spent fence.
    cleanupUncertain = false;
    recoveryHold = null;
    if (Date.now() - lastRequestAt >= idleSuspendMs) {
      // Nobody is watching. Park discharged rather than spending a generation:
      // `touch()` resumes normally now that `collectionDegraded()` is false.
      state = 'suspended';
      return;
    }
    if (!recoveryBudgetAvailable()) {
      recoveryHold = 'exhausted';
      state = 'blocked';
      log('Verse account collector: native collection kept stopping; the recovery budget for this window is spent and polling stays stopped.');
      return;
    }
    // Anti-spin: never start two generations closer together than this, even
    // when the kernel confirms cleanup instantly.
    const spacing = recoverySpacingWaitMs();
    if (spacing > 0) await new Promise<void>((resolve) => { setTimeout(resolve, spacing).unref?.(); });
    if (closing || closed || !lease) return;
    recoveries.push(Date.now());
    generation += 1;
    recoveryHold = null;
    reasonCode = null;
    resume();
    if (state === 'running') {
      log(`Verse account collector: native process cleanup confirmed; started collection generation ${generation}.`);
    }
  }

  /** Single-flight entry point. Never throws into a status read or a route. */
  function requestRecovery(): void {
    if (closing || closed || mode !== 'owned' || !lease) return;
    if (recovering) return;
    if (!collectionDegraded() && recoveryHold === null) return;
    recovering = recoverGeneration()
      .catch(() => { recoveryHold = 'awaiting-cleanup'; state = 'blocked'; })
      .finally(() => { recovering = null; });
  }

  /**
   * Try to take the exclusive per-root lease and, on success, start native
   * collection. `retry` = a later attempt by a collector that started
   * read-only (see `requestLeaseRetry`). Never throws.
   */
  async function acquireLease(retry: boolean): Promise<void> {
    if (!config) return;
    const previousCode = reasonCode;
    let acquired: ResourceQuotaRefreshLease | null = null;
    try {
      acquired = await acquireResourceQuotaRefreshLease(config.ledgerRoot, {
        ...(options.signal ? { signal: options.signal } : {}),
        trackNativeActivity: true,
        scope: config.connections ? 'native-connection-metadata' : 'codex-native-metadata',
      });
    } catch (error) {
      // Only a typed, cleanly released refusal may degrade to read-only.
      // Anything else leaves this collector inert rather than guessing.
      const typed = error instanceof ResourceQuotaRefreshLeaseError ? error : null;
      mode = typed?.safeReadOnlyFallback ? 'read-only' : 'unconfigured';
      state = 'blocked';
      owner = typed?.code === 'collector-owned' ? 'another-collector' : 'none';
      reasonCode = typed?.code ?? 'collector-unavailable';
      // A retry that is refused for the same reason is not news (touch-driven).
      if (!retry || reasonCode !== previousCode) {
        log(
          typed?.code === 'collector-owned'
            ? 'Verse account collector: another collector (ashlr resource-console) owns the metadata lease; reading shared evidence only.'
            : `Verse account collector: metadata lease unavailable (${reasonCode}); reading shared evidence only.`,
        );
      }
      return;
    }
    if (closing || closed) {
      // close() landed while this attempt was in flight: nothing was marked
      // pending and no native contact happened, so a plain release is exact.
      try { acquired.close(false); } catch { /* the lock stays durable, which is the safe side. */ }
      return;
    }
    lease = acquired;
    mode = 'owned';
    owner = 'this-server';
    reasonCode = null;
    // Everything past acquisition is a DIFFERENT failure from the refusal
    // the catch above is written for. `markPending()` is a durable fs
    // write and can throw on EIO/ENOSPC/EPERM — and the refusal handler
    // would then report `owner: 'none'` and "reading shared evidence
    // only" while this process silently still HELD the exclusive
    // per-root lock, so `ashlr resource-console` could never acquire it
    // and the watchdog (which requires mode 'owned') never revisited the
    // state. Hand the lock back before degrading, so the reported owner
    // matches reality.
    try {
      lease.markPending();
      resume();
    } catch {
      try { lease.close(true); } catch { /* the pending marker stays durable, which is the safe side. */ }
      lease = null;
      mode = 'unconfigured';
      state = 'blocked';
      owner = 'none';
      reasonCode = 'collector-start-failed';
      log('Verse account collector: the metadata lease was acquired but could not be marked pending; it has been released and no native polling is running.');
      return;
    }
    if (watchdog === null) {
      watchdog = setInterval(() => { tickIdle(); requestRecovery(); }, IDLE_CHECK_MS);
      watchdog.unref?.();
    }
    if (retry) log('Verse account collector: the metadata lease was released by its previous owner; this server now collects live readings.');
  }

  /**
   * 3.10 c8 follow-up: a collector that started read-only because another
   * process held the lease — typically the daemon's short-lived capacity
   * publisher, which holds it for one 5–10 s sample and then releases it —
   * used to stay read-only for the whole session, so Claude windows read as
   * unknown until Verse restarted. Client interest (`touch()`) now retries
   * the lease, at most once per VERSE_ACCOUNTS_LEASE_RETRY_MS and one attempt
   * at a time. Only a clean, typed refusal (mode 'read-only') is retried: an
   * inert ('unconfigured') collector stays inert, as before.
   */
  let leaseRetry: Promise<void> | null = null;
  let lastLeaseAttemptAt = Date.now();

  function requestLeaseRetry(): void {
    if (closing || closed || mode !== 'read-only' || leaseRetry) return;
    if (Date.now() - lastLeaseAttemptAt < VERSE_ACCOUNTS_LEASE_RETRY_MS) return;
    lastLeaseAttemptAt = Date.now();
    leaseRetry = acquireLease(true)
      .catch(() => { /* acquireLease never throws; defensive */ })
      .finally(() => { leaseRetry = null; });
  }

  if (config) {
    if (!config.quota && !config.connections) {
      reasonCode = 'accounts-collection-not-configured';
    } else {
      await acquireLease(false);
      lastLeaseAttemptAt = Date.now();
    }
  }

  /**
   * Has native collection died underneath a nominally running collector?
   *
   * `ResourceConnectionMonitor` latches: the FIRST sample that ends `uncertain`
   * (or whose native invocation throws) aborts the shared coordinator, projects
   * every row to `connection-monitor-stopped`, and never reschedules its timer.
   * The object stays non-null, so `resume()`'s `if (monitor || refresher)`
   * guard sees a live collector and the status keeps reporting `running` with
   * "readings are live" over four permanently dead accounts — a confident
   * banner on top of nothing, which is the one outcome this whole surface
   * exists to prevent.
   *
   * This mirrors `collectorLifecycle()` in `core/web/resource-console-server.ts`
   * exactly, including the `collector-unavailable` code: the console demotes to
   * `blocked` on the same signal and deliberately does NOT restart the monitor.
   * The abort is a process-cleanup fence — re-spawning probes behind it is
   * precisely the hazard it exists to stop — so the fix is to report the truth,
   * not to resurrect the collector.
   */
  function collectionDegraded(): boolean {
    if (mode !== 'owned' || closed) return false;
    // A generation already torn down for recovery is still degraded: its
    // monitor is gone, so the rows that proved it stopped are gone with it.
    // `cleanupUncertain` is the same signal surviving an IDLE suspend, and it
    // is what stops `touch()` from resuming straight into an undischarged
    // fence — every restart must go through kernel-confirmed reclamation.
    if (recoveryHold !== null || cleanupUncertain) return true;
    try {
      if (refresher && refresher.snapshot().state === 'closed') return true;
      if (monitor && monitor.snapshot().accounts.some((row) => row.reason === 'connection-monitor-stopped')) {
        return true;
      }
    } catch {
      // A status read must never throw; an unreadable collector is degraded.
      return true;
    }
    return false;
  }

  function note(): string {
    if (mode === 'owned') {
      if (recoveryHold === 'awaiting-cleanup') return VERSE_COLLECTOR_RECOVERING_NOTE;
      if (recoveryHold === 'exhausted') return VERSE_COLLECTOR_RECOVERY_EXHAUSTED_NOTE;
      if (collectionDegraded()) return VERSE_COLLECTOR_STOPPED_NOTE;
      return state === 'suspended'
        ? 'Native polling is paused because no client has asked for account data recently; it resumes on the next request.'
        : 'This server owns the native metadata lease; readings are live.';
    }
    if (mode === 'read-only') {
      return owner === 'another-collector'
        ? 'Another collector (ashlr resource-console) owns the native metadata lease; Verse is reading its shared evidence only.'
        : 'The native metadata lease is unavailable; Verse is reading shared evidence only.';
    }
    return 'Native account metadata collection is not configured for this accounts root.';
  }

  const collector: VerseAccountCollector = {
    accountsRoot,
    status: () => {
      // The demotion is applied HERE rather than mutating `state`, so a later
      // genuine suspend/close still reports its own state and the collector has
      // exactly one source of truth for "is native collection actually alive".
      const degraded = collectionDegraded();
      return {
        mode,
        state: degraded && state === 'running' ? 'blocked' : state,
        owner,
        reasonCode: degraded ? (reasonCode ?? 'collector-unavailable') : reasonCode,
        pollIntervalMs,
        idleSuspendMs,
        lastPolledAt,
        lastRequestAt: new Date(lastRequestAt).toISOString(),
        note: note(),
      };
    },
    touch: () => {
      lastRequestAt = Date.now();
      // Only an IDLE-suspended collector resumes directly. A collector whose
      // monitor latched stopped must NOT be restarted by a page refresh: the
      // abort is a process-cleanup fence. It goes through `requestRecovery()`
      // instead, which starts a new generation only once the kernel has
      // confirmed the stranded process group is gone.
      if (closed) return;
      if (mode === 'read-only') { requestLeaseRetry(); return; }
      if (mode !== 'owned') return;
      if (collectionDegraded()) { requestRecovery(); return; }
      if (state === 'suspended') resume();
    },
    connections: () => {
      if (monitor) {
        lastConnections = monitor.snapshot();
        lastPolledAt = lastConnections.sampledAt;
      }
      return lastConnections;
    },
    observations: () => {
      if (refresher) lastObservations = refresher.readObservations([]);
      return lastObservations;
    },
    unavailableWorkerIds: () => {
      // A suspended generation can retain historical observations in memory;
      // without its owner refresher none may become current evidence.
      const all = config?.quota?.workers.map((row) => row.workerId) ?? [];
      if (!refresher) return all;
      try { return refresher.unavailableWorkerIds(true); } catch { return all; }
    },
    credits: (accountId: string) => {
      if (creditsCache.has(accountId)) return creditsCache.get(accountId) ?? null;
      const root = sessionRoots.get(accountId);
      const found = root ? readCodexCreditsFromSessions(root) : null;
      creditsCache.set(accountId, found);
      return found;
    },
    close: async () => {
      if (closed) return;
      closing = true;
      if (watchdog !== null) { clearInterval(watchdog); watchdog = null; }
      // Let an in-flight recovery finish its teardown + reclamation first, so
      // shutdown never races it into releasing the lock under a live probe.
      // `closed` is set AFTER, because the recovery bails out early on it.
      if (recovering) { try { await recovering; } catch { /* already recorded as a hold */ } }
      // Same for a lease retry: it sees `closing` and hands the lock back, or
      // it finished first and `lease` below is released normally.
      if (leaseRetry) { try { await leaseRetry; } catch { /* never throws */ } }
      if (watchdog !== null) { clearInterval(watchdog); watchdog = null; }
      closed = true;
      await suspend();
      state = 'stopped';
      try {
        // Preserve the durable pending fence when cleanup was not confirmed;
        // it must survive this process exiting.
        lease?.close(publicationFailed || cleanupUncertain);
      } catch {
        log('Verse account collector: the metadata lease could not be released cleanly; its marker stays durable.');
      }
      lease = null;
    },
  };
  return collector;
}

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------
//
// `control-api.ts` cannot reach the CLI's collector through
// `VerseControlApiContext` without changing `src/core/web/api.ts` (owned
// elsewhere), so the CLI registers the collector here at startup and the routes
// look it up. Absent ⇒ every route degrades to read-only evidence.

let registered: VerseAccountCollector | null = null;

export function setVerseAccountCollector(collector: VerseAccountCollector | null): void {
  registered = collector;
}

export function getVerseAccountCollector(): VerseAccountCollector | null {
  return registered;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function unconfiguredStatus(reasonCode: string): VerseAccountsCollectorStatus {
  return {
    mode: 'unconfigured',
    state: 'stopped',
    owner: 'none',
    reasonCode,
    pollIntervalMs: VERSE_ACCOUNTS_DEFAULT_POLL_MS,
    idleSuspendMs: VERSE_ACCOUNTS_DEFAULT_IDLE_SUSPEND_MS,
    lastPolledAt: null,
    lastRequestAt: null,
    note: 'No account collector is running in this server; account data comes from shared evidence only.',
  };
}

/**
 * The `GET /api/verse/accounts` body. Live records when this server owns the
 * collectors, evidence-derived records otherwise, and an explicit collector
 * status either way — the UI must never have to guess why a field is null.
 */
export function buildVerseAccountsSnapshot(options: {
  accountsRoot: string;
  collector?: VerseAccountCollector | null;
}): VerseAccountsSnapshot {
  const { accountsRoot } = options;
  const collector = options.collector ?? null;
  collector?.touch();

  const identities = readVerseAccountIdentities(accountsRoot);
  const evidence = readVerseAccountEvidence(accountsRoot, collector);
  const live = collector?.connections() ?? null;
  const liveById = new Map<string, ResourceAccountConnection>();
  for (const row of live?.accounts ?? []) liveById.set(row.id, row);

  const status = collector?.status() ?? unconfiguredStatus('collector-not-running');
  const degradedReason = status.mode === 'owned' && status.state === 'suspended'
    ? 'connection-polling-paused'
    : status.reasonCode ?? 'connection-not-checked';

  // connections.json is the identity roster; the monitor may carry extra rows
  // only if the operator changed the file under us, so union both.
  const ids = [...new Set([...identities.map((i) => i.id), ...liveById.keys()])];
  const identityById = new Map(identities.map((i) => [i.id, i]));

  const accounts: VerseAccountRecord[] = [];
  for (const id of ids) {
    const connection = liveById.get(id);
    if (connection) {
      accounts.push(deriveVerseAccountRecord(connection, {
        credits: connection.provider === 'codex' ? collector?.credits(id) ?? null : null,
      }));
      continue;
    }
    const identity = identityById.get(id);
    if (!identity) continue;
    accounts.push(deriveVerseAccountRecordFromEvidence(
      identity,
      evidence.byAccount.get(id) ?? null,
      degradedReason,
      !evidence.liveAccountIds.has(id),
      evidence.unavailableAccountIds.has(id),
    ));
  }

  const notes = [...VERSE_ACCOUNT_NOTES];
  if (status.mode === 'owned' && status.reasonCode === 'collector-unavailable') {
    // The collector's own note, not a fixed string: a stopped generation that
    // is already recovering must not tell the reader to restart the app.
    notes.push(status.note || VERSE_COLLECTOR_STOPPED_NOTE);
  }
  if (evidence.ownerNote) notes.push(evidence.ownerNote);
  if (evidence.source === 'baseline') {
    notes.push('These readings come from the operator-seeded baseline, not a live collector.');
  }

  return {
    sampledAt: new Date().toISOString(),
    refreshing: live?.refreshing ?? false,
    collector: status,
    accounts,
    evidenceSource: evidence.source,
    notes,
  };
}

/** Best-effort private-directory check used by callers before starting a collector. */
export function accountsRootIsPrivate(accountsRoot: string): boolean {
  try {
    inspectPrivateDirectory(accountsRoot);
    return true;
  } catch {
    return false;
  }
}
