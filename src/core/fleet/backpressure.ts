/**
 * Fleet backpressure — V3.10 Track B unit U5 (SPEC-310B §3 "Backpressure").
 *
 * Four brakes on PRODUCTION (verification, judging and landing always keep
 * going — backpressure exists so they can catch up):
 *
 *   1. At most 3 open fleet PRs per repo. A 4th would only queue behind the
 *      first three for review and CI, so that repo produces nothing until
 *      one lands or closes.
 *   2. Stop producing while more than 4 proposals wait for verification —
 *      the verifier (2 machine-wide, 1 per repo) is the bottleneck, and more
 *      proposals would go stale on base before it reached them.
 *   3. 3 consecutive rejects or reverts on a repo put it on a 6-hour
 *      `cooldown` hold (fleet/quarantine.ts, actor `backpressure`). The same
 *      on one route — engine × repo × kind — DEMOTES that route for 6 hours
 *      instead: the dispatch router skips it, other engines still work there.
 *   4. Work whose seat has a future `nextEligibleAt` is parked (the dispatch
 *      router's `park` hold; task-source records `parkedUntil`).
 *
 * WHAT COUNTS (from the authority ledger, oldest first):
 *   success — `merge:landed`, `gate:would-merge` (every gate passed; the
 *             merge was withheld by stage / switch / shadow);
 *   reject  — a `gate:result` REFUSAL at a gate that judges the WORK:
 *             G1b tamper, G2 scope, G3 verify, G4 claims, G5 blast radius,
 *             G6 judge, G7 GitHub checks. G0 (authority — daily cap, holds,
 *             no judge seat) refuses for reasons that are not the producer's
 *             fault and never counts; G1 sends to the owner lane, which is
 *             not a rejection;
 *   revert  — `revert:landed` (counted against the reverted landing's route).
 * A new cooldown / demotion needs 3 NEW failures after the previous one
 * started, so an expired cooldown does not re-trigger on the same evidence.
 *
 * PURE core + one small private store (`~/.ashlr/fleet/backpressure.json`,
 * 0600) holding route demotions and the per-repo / per-route watermarks.
 * Unknown inputs fail CLOSED: an unreadable ledger or inbox holds production
 * with a sentence saying so.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { LedgerEntry } from '../authority/types.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { routeKey, type RouteDemotion } from './dispatch-router.js';
import type { GateId, RepoHold } from './fleet-types.js';

export const BACKPRESSURE_LIMITS = Object.freeze({
  maxOpenFleetPrsPerRepo: 3,
  maxWaitingVerify: 4,
  consecutiveFailures: 3,
  cooldownMs: 6 * 60 * 60_000,
  demotionMs: 6 * 60 * 60_000,
});

/** Gates whose refusal says the WORK was bad (see the header). */
export const WORK_JUDGING_GATES: ReadonlySet<GateId> = new Set<GateId>(['G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);

export type OutcomeKind = 'success' | 'reject' | 'revert';

export interface RouteOf {
  engine: string;
  kind: string;
}

export interface OutcomeEvent {
  /** nameWithOwner. */
  repo: string;
  at: string;
  kind: OutcomeKind;
  proposalId: string | null;
  /** The producing route, when the fleet's own journal knows it. */
  route: RouteOf | null;
  /** One short sentence (the gate's code / reason, or the landing id). */
  detail: string;
}

/**
 * Project ledger rows into outcome events. `routeOfProposal` joins the
 * fleet's dispatch journal (proposal id → engine and work kind); a landing
 * carries its producer engine itself.
 */
export function outcomeEventsFromLedger(
  entries: readonly LedgerEntry[],
  routeOfProposal: (proposalId: string) => RouteOf | null,
): OutcomeEvent[] {
  const out: OutcomeEvent[] = [];
  const landingById = new Map<string, { proposalId: string | null; engine: string | null }>();
  const rejected = new Set<string>();
  for (const entry of entries) {
    switch (entry.kind) {
      case 'merge:landed': {
        const rec = entry.data;
        landingById.set(rec.id, { proposalId: rec.proposalId, engine: rec.producer?.engine ?? null });
        const journal = rec.proposalId ? routeOfProposal(rec.proposalId) : null;
        const route = journal ?? (rec.producer ? { engine: rec.producer.engine, kind: 'unknown' } : null);
        out.push({ repo: rec.repo, at: rec.landedAt, kind: 'success', proposalId: rec.proposalId, route, detail: `landed ${rec.id}` });
        break;
      }
      case 'gate:would-merge': {
        const rec = entry.data;
        out.push({
          repo: rec.repo,
          at: rec.at,
          kind: 'success',
          proposalId: rec.proposalId,
          route: routeOfProposal(rec.proposalId),
          detail: `would merge (${rec.withheldBecause})`,
        });
        break;
      }
      case 'gate:result': {
        const rec = entry.data;
        if (rec.verdict !== 'refuse' || !WORK_JUDGING_GATES.has(rec.gate)) break;
        // One reject per proposal: later gates never run after a refusal, but
        // a re-verified proposal could be refused twice — count it once.
        const key = `${rec.repo}|${rec.proposalId}|${rec.headSha ?? ''}`;
        if (rejected.has(key)) break;
        rejected.add(key);
        out.push({
          repo: rec.repo,
          at: rec.at,
          kind: 'reject',
          proposalId: rec.proposalId,
          route: routeOfProposal(rec.proposalId),
          detail: `${rec.gate} ${rec.code}`,
        });
        break;
      }
      case 'revert:landed': {
        const rec = entry.data;
        const original = rec.revertsLandingId ? landingById.get(rec.revertsLandingId) ?? null : null;
        const journal = original?.proposalId ? routeOfProposal(original.proposalId) : null;
        const route = journal ?? (original?.engine ? { engine: original.engine, kind: 'unknown' } : null);
        out.push({
          repo: rec.repo,
          at: rec.landedAt,
          kind: 'revert',
          proposalId: original?.proposalId ?? null,
          route,
          detail: `reverted ${rec.revertsLandingId ?? rec.id}`,
        });
        break;
      }
      default:
        break;
    }
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/** Length of the trailing run of reject / revert events (newest last), counting only after `sinceMs`. */
export function trailingFailures(events: readonly OutcomeEvent[], sinceMs: number): number {
  let run = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && at <= sinceMs) break;
    if (event.kind === 'success') break;
    run += 1;
  }
  return run;
}

// ---------------------------------------------------------------------------
// State (demotions + watermarks)
// ---------------------------------------------------------------------------

export interface BackpressureStateV1 {
  v: 1;
  demotions: RouteDemotion[];
  /** nameWithOwner → ISO time the last cooldown this module set began. */
  lastCooldownAt: Record<string, string>;
  /** routeKey → ISO time the last demotion began. */
  lastDemotedAt: Record<string, string>;
  updatedAt: string;
}

export function emptyBackpressureState(): BackpressureStateV1 {
  return { v: 1, demotions: [], lastCooldownAt: {}, lastDemotedAt: {}, updatedAt: new Date(0).toISOString() };
}

const MAX_STATE_BYTES = 256 * 1024;
const MAX_DEMOTIONS = 500;
const MAX_WATERMARKS = 1_000;

export function backpressureStatePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'backpressure.json');
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function cleanWatermarks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_WATERMARKS) break;
    if (key.length > 400 || !isIso(value)) continue;
    out[key] = value;
    kept += 1;
  }
  return out;
}

/** Total: a missing or mangled file is the empty state (no demotions — the lenient direction only for DEMOTIONS, which lower nothing when absent). */
export function loadBackpressureState(file: string = backpressureStatePath()): BackpressureStateV1 {
  const read = readPrivateFileCapped(file, MAX_STATE_BYTES);
  if (!read || read.truncated) return emptyBackpressureState();
  try {
    const raw = JSON.parse(read.text) as Record<string, unknown>;
    if (raw['v'] !== 1) return emptyBackpressureState();
    const demotions: RouteDemotion[] = [];
    if (Array.isArray(raw['demotions'])) {
      for (const d of raw['demotions'].slice(0, MAX_DEMOTIONS)) {
        if (typeof d !== 'object' || d === null) continue;
        const r = d as Record<string, unknown>;
        if (typeof r['engine'] !== 'string' || typeof r['repo'] !== 'string' || typeof r['kind'] !== 'string') continue;
        if (!isIso(r['since']) || !isIso(r['until']) || typeof r['reason'] !== 'string') continue;
        demotions.push({
          engine: r['engine'].slice(0, 80),
          repo: r['repo'].slice(0, 140),
          kind: r['kind'].slice(0, 40),
          since: r['since'],
          until: r['until'],
          reason: scrubSecrets(r['reason'].slice(0, 300)),
        });
      }
    }
    return {
      v: 1,
      demotions,
      lastCooldownAt: cleanWatermarks(raw['lastCooldownAt']),
      lastDemotedAt: cleanWatermarks(raw['lastDemotedAt']),
      updatedAt: isIso(raw['updatedAt']) ? raw['updatedAt'] : new Date(0).toISOString(),
    };
  } catch {
    return emptyBackpressureState();
  }
}

/** Persist atomically (0600 in a 0700 dir). Throws on a storage failure. */
export function saveBackpressureState(state: BackpressureStateV1, file: string = backpressureStatePath()): void {
  ensurePrivateDirectory(dirname(file));
  writePrivateFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface BackpressureInput {
  nowMs: number;
  /** Repos (nameWithOwner) in the grant's current stage. */
  repos: readonly string[];
  /**
   * Open fleet PRs per repo (openFleetPrsFromLedger — a repo absent from the
   * map has none open); null = the ledger could not be read, which pauses
   * every repo (fail closed).
   */
  openPrsByRepo: Readonly<Record<string, number>> | null;
  /** Proposals waiting for verification across the fleet; null = unknown. */
  waitingVerify: number | null;
  /** Outcome events, oldest first (outcomeEventsFromLedger). */
  outcomes: readonly OutcomeEvent[];
  /** Active repo holds (fleet/quarantine.ts listRepoHolds). */
  holds: readonly RepoHold[];
  state: BackpressureStateV1;
}

export interface CooldownRequest {
  repo: string;
  reason: string;
  until: string;
}

export interface BackpressureVerdict {
  /** Non-null ⇒ start no new production this tick. */
  holdProduction: string | null;
  /** nameWithOwner → why that repo produces nothing this tick (open PR cap). */
  pausedRepos: Record<string, string>;
  /** Cooldown holds to set now (repo-level: 3 consecutive rejects / reverts). */
  cooldowns: CooldownRequest[];
  /** New route demotions to add. */
  demotions: RouteDemotion[];
  /** The state after this evaluation (expired demotions dropped, watermarks advanced). */
  nextState: BackpressureStateV1;
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Pure: evaluate every brake for one tick. */
export function evaluateBackpressure(input: BackpressureInput): BackpressureVerdict {
  const { nowMs } = input;
  const nowIso = new Date(nowMs).toISOString();
  const pausedRepos: Record<string, string> = {};
  const cooldowns: CooldownRequest[] = [];
  const newDemotions: RouteDemotion[] = [];
  const lastCooldownAt = { ...input.state.lastCooldownAt };
  const lastDemotedAt = { ...input.state.lastDemotedAt };

  // 2. Verification queue.
  let holdProduction: string | null = null;
  if (input.waitingVerify === null) {
    holdProduction = 'The verification queue could not be read, so no new work is started until it can be.';
  } else if (input.waitingVerify > BACKPRESSURE_LIMITS.maxWaitingVerify) {
    holdProduction = `${input.waitingVerify} proposals are waiting for verification (limit ${BACKPRESSURE_LIMITS.maxWaitingVerify}); `
      + 'production pauses until the verifier catches up.';
  }

  for (const repo of input.repos) {
    // 1. Open PR cap.
    const counts = input.openPrsByRepo;
    const open = counts === null
      ? null
      : Object.entries(counts).reduce((sum, [key, n]) => (sameRepo(key, repo) ? sum + n : sum), 0);
    if (open === null) {
      pausedRepos[repo] = 'Its open fleet PRs could not be counted, so it produces nothing until they can be.';
    } else if (open >= BACKPRESSURE_LIMITS.maxOpenFleetPrsPerRepo) {
      pausedRepos[repo] = `${open} fleet PRs are already open (limit ${BACKPRESSURE_LIMITS.maxOpenFleetPrsPerRepo}); `
        + 'it produces nothing until one lands or closes.';
    }

    // 3a. Repo cooldown.
    const repoEvents = input.outcomes.filter((e) => sameRepo(e.repo, repo));
    const watermark = lastCooldownAt[repo] ? Date.parse(lastCooldownAt[repo]!) : Number.NEGATIVE_INFINITY;
    const failures = trailingFailures(repoEvents, watermark);
    const alreadyCooling = input.holds.some((h) => sameRepo(h.repo, repo) && h.kind === 'cooldown');
    if (failures >= BACKPRESSURE_LIMITS.consecutiveFailures && !alreadyCooling) {
      const recent = repoEvents.slice(-failures).map((e) => e.detail).slice(-3).join('; ');
      cooldowns.push({
        repo,
        reason: scrubSecrets(`${failures} consecutive rejects or reverts (${recent}) — cooling down for 6 h.`).slice(0, 480),
        until: new Date(nowMs + BACKPRESSURE_LIMITS.cooldownMs).toISOString(),
      });
      lastCooldownAt[repo] = nowIso;
    }
  }

  // 3b. Route demotions.
  const byRoute = new Map<string, { engine: string; repo: string; kind: string; events: OutcomeEvent[] }>();
  for (const event of input.outcomes) {
    if (!event.route) continue;
    const key = routeKey(event.route.engine, event.repo, event.route.kind);
    const bucket = byRoute.get(key) ?? { engine: event.route.engine, repo: event.repo, kind: event.route.kind, events: [] };
    bucket.events.push(event);
    byRoute.set(key, bucket);
  }
  const live = input.state.demotions.filter((d) => Date.parse(d.until) > nowMs);
  for (const [key, bucket] of byRoute) {
    const watermark = lastDemotedAt[key] ? Date.parse(lastDemotedAt[key]!) : Number.NEGATIVE_INFINITY;
    const failures = trailingFailures(bucket.events, watermark);
    if (failures < BACKPRESSURE_LIMITS.consecutiveFailures) continue;
    if (live.some((d) => routeKey(d.engine, d.repo, d.kind) === key)) continue;
    newDemotions.push({
      engine: bucket.engine,
      repo: bucket.repo,
      kind: bucket.kind,
      since: nowIso,
      until: new Date(nowMs + BACKPRESSURE_LIMITS.demotionMs).toISOString(),
      reason: `${failures} consecutive rejects or reverts on this route.`,
    });
    lastDemotedAt[key] = nowIso;
  }

  return {
    holdProduction,
    pausedRepos,
    cooldowns,
    demotions: newDemotions,
    nextState: {
      v: 1,
      demotions: [...live, ...newDemotions].slice(-MAX_DEMOTIONS),
      lastCooldownAt,
      lastDemotedAt,
      updatedAt: nowIso,
    },
  };
}

// ---------------------------------------------------------------------------
// Open fleet PRs (from the ledger)
// ---------------------------------------------------------------------------

/**
 * Open fleet PRs per repo from ledger rows: `pr:opened` minus `pr:closed`,
 * plus `pr:reopened`, minus a merge / revert landing on the same PR. Repos
 * absent from the result have none open.
 */
export function openFleetPrsFromLedger(entries: readonly LedgerEntry[]): Record<string, number> {
  const open = new Map<string, string>(); // `${repo}#${n}` → repo
  for (const entry of entries) {
    switch (entry.kind) {
      case 'pr:opened':
        open.set(`${entry.data.repo.toLowerCase()}#${entry.data.number}`, entry.data.repo);
        break;
      case 'pr:reopened':
        open.set(`${entry.data.repo.toLowerCase()}#${entry.data.number}`, entry.data.repo);
        break;
      case 'pr:closed':
        open.delete(`${entry.data.repo.toLowerCase()}#${entry.data.number}`);
        break;
      case 'merge:landed':
      case 'revert:landed':
        open.delete(`${entry.data.repo.toLowerCase()}#${entry.data.prNumber}`);
        break;
      default:
        break;
    }
  }
  const counts: Record<string, number> = {};
  for (const repo of open.values()) counts[repo] = (counts[repo] ?? 0) + 1;
  return counts;
}
