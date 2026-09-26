/**
 * Leader cadence for full-time use (3.14) — PURE.
 *
 * The 3.10 cadence is one deep memo a day (06:30) plus event triggers, at most
 * 3 model runs a day. That leaves Mason without a Leader for the whole
 * working day, and a failed 06:30 run (2026-09-26) waited until tomorrow.
 * Two additions:
 *
 *   RETRY — a failed / no-seat / unparseable full run schedules a bounded
 *   retry (15 min, then 45 min, then 2 h; 3 attempts), instead of waiting for
 *   the next slot. Retries count toward the 3 full runs a day.
 *
 *   CHECK-IN — during working hours, at most every `checkinHours` (default
 *   2; 0 disables), a cheap run (grok or local only, short output, advisory:
 *   nothing it proposes is enacted) — and only when the evidence changed
 *   MATERIALLY since the last memo. Check-ins have their own room under a
 *   total cap of 8 model runs a day; the 3-a-day cap on full runs is unchanged.
 *
 * Config (`foundry.leader`, all optional):
 *   checkinHours: number   — default 2; 0 disables check-ins; clamped to 1..24
 *   workingHours: { start: 0-23, end: 1-24 } — local hours, default 8..22
 */
import { createHash } from 'node:crypto';

import type { AshlrConfig } from '../types.js';
import { LEADER_LIMITS } from './leader-types.js';

export const LEADER_CADENCE_LIMITS = Object.freeze({
  /** Every model run in a local day, check-ins included. */
  maxRunsPerDayTotal: 8,
  defaultCheckinHours: 2,
  defaultWorkingHours: Object.freeze({ start: 8, end: 22 }),
  /** A check-in that found nothing material waits this long before looking again. */
  checkinRecheckMs: 30 * 60_000,
  /** Retry delays after the 1st, 2nd, 3rd failure; no 4th attempt. */
  retryBackoffMs: Object.freeze([15 * 60_000, 45 * 60_000, 120 * 60_000]),
});

export interface LeaderCadence {
  /** 0 = check-ins disabled. */
  checkinHours: number;
  workingHours: { start: number; end: number };
  /** Full runs (schedule, triggers, retries, manual) per local day. */
  maxRunsPerDay: number;
  /** All model runs per local day, check-ins included. */
  maxRunsPerDayTotal: number;
}

/** The 3.10 cadence: no check-ins, 3 runs a day. What callers that pass nothing get. */
export const LEGACY_LEADER_CADENCE: LeaderCadence = Object.freeze({
  checkinHours: 0,
  workingHours: { ...LEADER_CADENCE_LIMITS.defaultWorkingHours },
  maxRunsPerDay: LEADER_LIMITS.maxRunsPerDay,
  maxRunsPerDayTotal: LEADER_LIMITS.maxRunsPerDay,
}) as LeaderCadence;

function hour(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function resolveLeaderCadence(cfg: AshlrConfig | undefined): LeaderCadence {
  const foundry = cfg?.foundry as Record<string, unknown> | undefined;
  const raw = foundry?.['leader'];
  const leader = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const hoursRaw = leader['checkinHours'];
  let checkinHours: number = LEADER_CADENCE_LIMITS.defaultCheckinHours;
  if (typeof hoursRaw === 'number' && Number.isFinite(hoursRaw)) {
    checkinHours = hoursRaw <= 0 ? 0 : Math.min(24, Math.max(1, hoursRaw));
  }
  const whRaw = leader['workingHours'];
  const wh = whRaw && typeof whRaw === 'object' && !Array.isArray(whRaw) ? (whRaw as Record<string, unknown>) : {};
  const start = hour(wh['start'], 0, 23);
  const end = hour(wh['end'], 1, 24);
  const workingHours = start !== null && end !== null && end > start
    ? { start, end }
    : { ...LEADER_CADENCE_LIMITS.defaultWorkingHours };
  return {
    checkinHours,
    workingHours,
    maxRunsPerDay: LEADER_LIMITS.maxRunsPerDay,
    maxRunsPerDayTotal: checkinHours > 0 ? LEADER_CADENCE_LIMITS.maxRunsPerDayTotal : LEADER_LIMITS.maxRunsPerDay,
  };
}

export function isWorkingHour(nowMs: number, wh: { start: number; end: number }): boolean {
  const d = new Date(nowMs);
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= wh.start && h < wh.end;
}

/** Delay before retry `attempt` (1-based); null when the attempts are spent. */
export function retryDelayMs(attempt: number): number | null {
  return LEADER_CADENCE_LIMITS.retryBackoffMs[attempt - 1] ?? null;
}

export const LEADER_MAX_RETRY_ATTEMPTS = LEADER_CADENCE_LIMITS.retryBackoffMs.length;

export interface CheckinClock {
  /** Last time a model run finished (any mode / outcome). */
  lastMemoAt: string | null;
  /** Last time a due check-in looked at the evidence and found nothing material. */
  lastCheckinEvalAt?: string | null;
}

/** Earliest time a check-in may run, ignoring working hours; null when disabled. */
export function nextCheckinAt(clock: CheckinClock, cadence: LeaderCadence): number | null {
  if (cadence.checkinHours <= 0) return null;
  const last = clock.lastMemoAt ? Date.parse(clock.lastMemoAt) : NaN;
  const evalAt = clock.lastCheckinEvalAt ? Date.parse(clock.lastCheckinEvalAt) : NaN;
  const byMemo = Number.isFinite(last) ? last + cadence.checkinHours * 3_600_000 : -Infinity;
  const byEval = Number.isFinite(evalAt) ? evalAt + LEADER_CADENCE_LIMITS.checkinRecheckMs : -Infinity;
  return Math.max(byMemo, byEval);
}

/** Is a check-in's time window open (the material-change test happens after the evidence is read)? */
export function checkinWindowOpen(nowMs: number, clock: CheckinClock, cadence: LeaderCadence): boolean {
  const next = nextCheckinAt(clock, cadence);
  return next !== null && nowMs >= next && isWorkingHour(nowMs, cadence.workingHours);
}

/**
 * The evidence fields whose change is MATERIAL for a check-in. Coarse on
 * purpose: counts that drift (merges, proposals) are bucketed; sets that
 * matter (holds, high-severity insights, exhausted seats, unknown sources)
 * are exact. Anything else — a usage meter moving, a new low-severity
 * insight — is not worth a model run.
 */
export interface MaterialEvidenceInput {
  grant: { stageId: string; switch: string } | null;
  budget: { mode: string } | null;
  seats: { seatId: string; windows: { limitReached: boolean }[] }[] | null;
  goals: { open: number; complete?: boolean } | null;
  fleet: {
    merges7d: number | null;
    reverts7d: number | null;
    holds: { repo: string; kind: string }[];
    quality7d: { proposalsCreated: number; merged: number; rejected: number } | null;
  };
  reasoning: { insights: { severity: string; title: string }[] } | null;
  unknown: string[];
}

const bucket = (n: number | null | undefined, size: number): number | null => (typeof n === 'number' ? Math.floor(n / size) : null);

export function materialEvidenceDigest(e: MaterialEvidenceInput): string {
  const material = {
    grant: e.grant ? `${e.grant.stageId}/${e.grant.switch}` : null,
    budget: e.budget?.mode ?? null,
    exhausted: (e.seats ?? []).filter((s) => s.windows.some((w) => w.limitReached)).map((s) => s.seatId).sort(),
    goalsOpen: e.goals?.open ?? null,
    goalsComplete: e.goals?.complete ?? null,
    merges: bucket(e.fleet.merges7d, 5),
    reverts: e.fleet.reverts7d,
    holds: e.fleet.holds.map((h) => `${h.repo}:${h.kind}`).sort(),
    proposals: bucket(e.fleet.quality7d?.proposalsCreated, 5),
    merged: bucket(e.fleet.quality7d?.merged, 3),
    rejected: bucket(e.fleet.quality7d?.rejected, 3),
    high: (e.reasoning?.insights ?? []).filter((i) => i.severity === 'high').map((i) => i.title).sort(),
    unknown: [...e.unknown].sort(),
  };
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

/**
 * Appended to the full prompt for a check-in (the evidence blocks are the
 * same; the ask is smaller). Kept here, not in buildLeaderPrompt, so the
 * daily prompt is unchanged.
 */
export const LEADER_CHECKIN_SUFFIX = `=== CHECK-IN ===
This is a short working-hours CHECK-IN, not the daily memo. Something in the evidence changed since the last memo. In the same JSON shape: name the bottleneck NOW and the one move for the next few hours (with expectedDelta), and at most one question for Mason. Leave goals, hypotheses, standards, critiques, seatPlan and actions empty: a check-in is advisory, and nothing it proposes is applied.`;
