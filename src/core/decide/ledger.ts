/**
 * decide/ledger.ts — config (kill switch, per-kind thresholds, budget) and the
 * append-only decision ledger that makes Jev observable.
 *
 * FILES (all under $ASHLR_HOME, default ~/.ashlr, resolved per call so a test
 * HOME is honoured):
 *   jev/config.json                 operator settings (optional; absent = defaults)
 *   jev/decisions/YYYY-MM-DD.jsonl  one DecisionRecord per decision
 *
 * PRIVACY: a record carries labels, confidences, token counts and latency —
 * never the text that was classified (stderr, operator messages and diffs can
 * hold paths and tokens), and never the key.
 *
 * FAILURE: every function here swallows its own I/O errors. Observability must
 * never be the reason a decision fails.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DecisionKind, DecisionRecord, JevKindStats } from './types.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function ashlrHome(): string {
  const configured = process.env['ASHLR_HOME'];
  return typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
}

export function jevDir(): string {
  return join(ashlrHome(), 'jev');
}

export function jevConfigPath(): string {
  return join(jevDir(), 'config.json');
}

export function jevLedgerDir(): string {
  return join(jevDir(), 'decisions');
}

/** Local calendar day, YYYY-MM-DD — "today" means the operator's today. */
export function localDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Config — the kill switch lives here
// ---------------------------------------------------------------------------

/** Env kill switch. "1"/"true"/"yes" disables every Jev decision process-wide. */
export const JEV_DISABLE_ENV = 'ASHLR_JEV_DISABLE';

/**
 * Default daily ceiling on PAID calls (cache hits are free and uncounted).
 * Every wired site fires at most once per failure / proposal / message, so a
 * busy day is low hundreds; 1500 is headroom that still stops a runaway loop
 * from turning an optimisation into a bill.
 */
export const DEFAULT_DAILY_CALL_BUDGET = 1500;

/**
 * COST ESTIMATE, not a price list. TypeSafe has not published per-token
 * pricing we can verify, so these are placeholder rates chosen to be in the
 * range of small hosted classifiers. Override both in jev/config.json once the
 * invoice gives real numbers; every surface labels the figure "est.".
 */
export const DEFAULT_INPUT_USD_PER_MTOK = 0.5;
export const DEFAULT_OUTPUT_USD_PER_MTOK = 2.0;

export interface JevConfig {
  /** Master switch. Default true (still inert until a key is present). */
  readonly enabled: boolean;
  readonly disabledKinds: readonly DecisionKind[];
  /** Per-kind threshold overrides, each in (0, 1]. */
  readonly thresholds: Readonly<Partial<Record<DecisionKind, number>>>;
  readonly dailyCallBudget: number;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

const DEFAULT_CONFIG: JevConfig = {
  enabled: true,
  disabledKinds: [],
  thresholds: {},
  dailyCallBudget: DEFAULT_DAILY_CALL_BUDGET,
  inputUsdPerMTok: DEFAULT_INPUT_USD_PER_MTOK,
  outputUsdPerMTok: DEFAULT_OUTPUT_USD_PER_MTOK,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read config; a missing or malformed file is the defaults (never throws). */
export function readJevConfig(): JevConfig {
  const path = jevConfigPath();
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return DEFAULT_CONFIG;
    const thresholds: Partial<Record<DecisionKind, number>> = {};
    if (typeof raw['thresholds'] === 'object' && raw['thresholds'] !== null) {
      for (const [k, v] of Object.entries(raw['thresholds'] as Record<string, unknown>)) {
        // A threshold of 0 would accept any coin-flip; refuse it rather than obey it.
        if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) {
          thresholds[k as DecisionKind] = v;
        }
      }
    }
    return {
      enabled: raw['enabled'] !== false,
      disabledKinds: Array.isArray(raw['disabledKinds'])
        ? (raw['disabledKinds'].filter((k) => typeof k === 'string') as DecisionKind[])
        : [],
      thresholds,
      dailyCallBudget: positiveNumber(raw['dailyCallBudget'], DEFAULT_DAILY_CALL_BUDGET),
      inputUsdPerMTok: positiveNumber(raw['inputUsdPerMTok'], DEFAULT_INPUT_USD_PER_MTOK),
      outputUsdPerMTok: positiveNumber(raw['outputUsdPerMTok'], DEFAULT_OUTPUT_USD_PER_MTOK),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function truthyEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Jev's own kill switch. */
export function jevKilledByEnv(): boolean {
  return truthyEnv(JEV_DISABLE_ENV);
}

/** The classifier client's process-wide switch (also honoured before the cache). */
export function classifierKilledByEnv(): boolean {
  return truthyEnv('ASHLR_CLASSIFY_DISABLE');
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, cfg: JevConfig = readJevConfig()): number {
  return (inputTokens * cfg.inputUsdPerMTok + outputTokens * cfg.outputUsdPerMTok) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Paid calls made today, tracked in memory and seeded from the ledger on first
 * use per day, so the budget holds across a daemon restart without re-reading
 * the ledger on every decision.
 */
let callCounter: { day: string; home: string; calls: number } | undefined;

export function paidCallsToday(): number {
  const day = localDay();
  const home = ashlrHome();
  if (!callCounter || callCounter.day !== day || callCounter.home !== home) {
    const calls = readLedger(day).filter((r) => r.called).length;
    callCounter = { day, home, calls };
  }
  return callCounter.calls;
}

/** Append one record. Never throws. */
export function recordDecision(record: DecisionRecord): void {
  const day = localDay(new Date(record.ts));
  if (record.called) {
    // Seed first so the in-memory count includes prior lines, then bump.
    paidCallsToday();
    if (callCounter && callCounter.day === day) callCounter.calls += 1;
  }
  try {
    const dir = jevLedgerDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* observability never fails a decision */
  }
}

/** Read one day's records. Malformed lines are skipped. */
export function readLedger(day: string = localDay()): DecisionRecord[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const path = join(jevLedgerDir(), `${day}.jsonl`);
  if (!existsSync(path)) return [];
  try {
    const out: DecisionRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as DecisionRecord;
        if (parsed && typeof parsed.kind === 'string' && typeof parsed.path === 'string') out.push(parsed);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The days that have a ledger file, newest first. */
export function ledgerDays(): string[] {
  try {
    return readdirSync(jevLedgerDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Per-kind rollup over a set of records. */
export function summarizeByKind(records: readonly DecisionRecord[]): JevKindStats[] {
  const groups = new Map<DecisionKind, DecisionRecord[]>();
  for (const r of records) {
    const list = groups.get(r.kind) ?? [];
    list.push(r);
    groups.set(r.kind, list);
  }
  const stats: JevKindStats[] = [];
  for (const [kind, list] of groups) {
    const jev = list.filter((r) => r.path === 'jev').length;
    const answered = list.filter((r) => typeof r.jevConfidence === 'number');
    const called = list.filter((r) => r.called);
    const reasons = new Map<string, number>();
    for (const r of list) if (r.path === 'fallback' && r.reason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    stats.push({
      kind,
      decisions: list.length,
      jev,
      fallback: list.length - jev,
      cached: list.filter((r) => r.cached).length,
      calls: called.length,
      avgConfidence: answered.length
        ? answered.reduce((s, r) => s + (r.jevConfidence ?? 0), 0) / answered.length
        : null,
      fallbackRate: list.length ? (list.length - jev) / list.length : 0,
      estCostUsd: list.reduce((s, r) => s + (r.estCostUsd ?? 0), 0),
      avgLatencyMs: called.length ? called.reduce((s, r) => s + r.durationMs, 0) / called.length : null,
      topFallbackReasons: [...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count })),
    });
  }
  return stats.sort((a, b) => b.decisions - a.decisions || a.kind.localeCompare(b.kind));
}

/** Test seam: forget the in-memory paid-call counter. */
export function resetLedgerCountersForTests(): void {
  callCounter = undefined;
}
