/**
 * outcome-watcher.ts — M332 (completes M141): detect the REAL-WORLD outcome
 * of auto-merged proposals and record it as signed observational evidence.
 *
 * 'reverted' has been in the JudgeOutcome union since M141, but nothing ever
 * DETECTED a revert — judge calibration and learned routing only ever saw the
 * moment-of-merge verdict. This maintenance pass scans each merged trace's
 * repo history for:
 *   (a) a revert commit referencing the merge commit
 *       ("This reverts commit <sha>")            → linkOutcome('reverted')
 *   (b) a near-term commit touching the same files whose subject matches
 *       /\b(fix|hotfix|revert)\b/i               → linkOutcome('followed-up')
 *
 * The merge commit is found via the auto-merge commit-message convention
 * ("ashlr: auto-merge proposal <id>", merge.ts M47). READ-ONLY on repos;
 * findings are persisted only to the signed observation-only ledger. They do
 * not rewrite judge labels or verified-skill lifecycle state: cohort coverage
 * is not yet complete enough to grant this heuristic scanner policy authority.
 * Internal throttle (default 6h) keeps the git cost negligible.
 * Never throws.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import type { AshlrConfig, Proposal } from '../types.js';
import { readJudgeTraces } from './judge-trace.js';
import { listProposals, listProposalsDetailed } from '../inbox/store.js';
import { realizedMergeOf } from '../inbox/realized-merge.js';
import { recordPostMergeObservation, type PostMergeOutcome } from './post-merge-observations.js';
import { inspectPostMergeWindow } from './post-merge-window.js';
import {
  buildMonitoringCursor,
  loadMonitoringCursor,
  outcomeCandidateKey,
  saveMonitoringCursor,
  type MonitoringCursorV1,
  type MonitoringOutcomeCandidateCursor,
} from './monitoring-cursor.js';

export interface OutcomeScan {
  /** Merged traces examined this pass. */
  scanned: number;
  reverts: number;
  followUps: number;
  /** Traces skipped (no proposal/repo, no merge commit found, git error). */
  skipped: number;
  /** True when the throttle short-circuited the pass entirely. */
  throttled: boolean;
  /** False when proposal/trace enumeration or candidate bounds were incomplete. */
  sourceComplete: boolean;
  candidateLimitReached: boolean;
}

const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_FOLLOWUP_WINDOW_DAYS = 7;
const MAX_OUTCOME_PROPOSALS = 200;
const MAX_OUTCOME_CANDIDATES_PER_PASS = 25;

function defaultStateFile(): string {
  return join(homedir(), '.ashlr', 'outcome-watcher.json');
}

function cursorThrottleToken(cursor: MonitoringCursorV1): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:outcome-watcher-throttle:v1',
    cursor.enrollmentDigest,
    cursor.outcome,
  ])).digest('hex');
}

function candidateSetDigest(candidates: readonly MonitoringOutcomeCandidateCursor[]): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:outcome-candidate-set:v1',
    candidates.map(outcomeCandidateKey).sort((left, right) => left.localeCompare(right)),
  ])).digest('hex');
}

function recordCompletedScan(stateFile: string, now: number, cursor?: MonitoringCursorV1): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
      lastScanAt: now,
      ...(cursor ? { cursorToken: cursorThrottleToken(cursor) } : {}),
    }) + '\n', 'utf8');
  } catch {
    // The durable monitoring cursor supersedes this compatibility throttle.
  }
}

function recordRealizedOutcome(
  proposalId: string,
  proposal: Proposal,
  mergeCommit: string,
  observedHead: string,
  outcome: PostMergeOutcome,
  basis: 'git-revert-reference' | 'overlapping-fix',
  now: number,
): boolean {
  if (!proposal.repo) return false;
  const result = recordPostMergeObservation({
    observedAt: new Date(now).toISOString(),
    outcome,
    basis,
    confidence: basis === 'git-revert-reference' ? 'deterministic' : 'heuristic',
    repo: proposal.repo,
    proposalId,
    ...(proposal.runId ? { runId: proposal.runId } : {}),
    ...(proposal.trajectoryId ? { trajectoryId: proposal.trajectoryId } : {}),
    ...(proposal.workItemId ? { workItemId: proposal.workItemId } : {}),
    mergeCommit,
    observedHead,
    ...(proposal.verifyResult?.ran?.length
      ? { commandKinds: [...new Set(proposal.verifyResult.ran.map((command) => command.kind))].sort() }
      : {}),
  });
  return result.recorded + result.upgraded + result.replayed > 0;
}

/**
 * Scan merged judge traces for real-world reverts / follow-up fixes and link
 * the outcome. Idempotent per trace (already-linked reverted/followed-up
 * traces are excluded by the outcome==='merged' filter). Never throws.
 */
export async function scanRealWorldOutcomes(
  _cfg: AshlrConfig,
  opts?: {
    lookbackDays?: number;
    followUpWindowDays?: number;
    /** Bypass the 6h throttle (tests / manual runs). */
    force?: boolean;
    /** Injectable clock + state path for deterministic tests. */
    nowMs?: number;
    stateFile?: string;
    /** Explicit production enrollment snapshot. Omitted only for legacy/manual callers. */
    enrolledRepos?: string[];
  },
): Promise<OutcomeScan> {
  const scan: OutcomeScan = {
    scanned: 0, reverts: 0, followUps: 0, skipped: 0, throttled: false,
    sourceComplete: true, candidateLimitReached: false,
  };
  try {
    const now = opts?.nowMs ?? Date.now();
    const stateFile = opts?.stateFile ?? defaultStateFile();
    const productionCursorMode = opts?.enrolledRepos !== undefined;

    // Throttle (best-effort state file; a corrupt file simply re-runs).
    if (opts?.force !== true) {
      try {
        if (existsSync(stateFile)) {
          const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
          const last = typeof raw['lastScanAt'] === 'number' ? raw['lastScanAt'] : 0;
          const cursorToken = typeof raw['cursorToken'] === 'string' ? raw['cursorToken'] : null;
          const cursorRead = productionCursorMode
            ? loadMonitoringCursor(opts?.enrolledRepos ?? [])
            : null;
          const productionThrottleValid = !productionCursorMode || (
            cursorRead?.sourceState !== 'degraded' &&
            cursorRead?.cursor?.outcome.sweepComplete === true &&
            cursorRead.cursor.outcome.hadIncomplete === false &&
            cursorToken === cursorThrottleToken(cursorRead.cursor)
          );
          if (now - last < THROTTLE_MS && productionThrottleValid) {
            scan.throttled = true;
            return scan;
          }
        }
      } catch {
        /* re-run */
      }
    }
    const lookbackDays = Math.max(1, opts?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
    const windowDays = Math.max(1, opts?.followUpWindowDays ?? DEFAULT_FOLLOWUP_WINDOW_DAYS);
    const sinceMs = now - lookbackDays * 24 * 60 * 60 * 1000;

    // M337 (review fix): linkOutcome cannot rewrite a PRIOR-day trace file —
    // it appends a patch record to today's file and the original line keeps
    // outcome:'merged' forever. Filtering on 'merged' alone therefore
    // re-detected the same revert on every scan, appending duplicate patch
    // records that multiplied the reject signal. Skip any proposal that
    // ALREADY has a reverted/followed-up record anywhere in the stream.
    const allTraces = readJudgeTraces({ sinceMs, requireComplete: true });
    const traceQuality = (allTraces as typeof allTraces & {
      sourceQuality?: { sourceState?: string; complete?: boolean };
    }).sourceQuality;
    const traceSourceHealthy = traceQuality === undefined ||
      (traceQuality.sourceState !== 'degraded' && traceQuality.complete === true);
    if (!traceSourceHealthy) {
      scan.skipped++;
      scan.sourceComplete = false;
    }
    // M338 (review fix): only 'reverted' is TERMINAL. A 'followed-up' link
    // must not block a later real revert — the proposal stays scannable for
    // the revert upgrade, while the follow-up re-link is suppressed below.
    const revertedPids = new Set(
      allTraces.filter((t) => t.outcome === 'reverted').map((t) => t.proposalId),
    );
    const followedUpPids = new Set(
      allTraces.filter((t) => t.outcome === 'followed-up').map((t) => t.proposalId),
    );
    // M339 (review fix): a SAME-day linkOutcome('followed-up') rewrites the
    // trace IN PLACE, so a followed-up proposal may have no surviving
    // 'merged' record at all — filtering on 'merged' alone made the reverted
    // upgrade path dead for same-UTC-day merges. Scan each proposal ONCE
    // whose latest known outcome is merged OR followed-up (reverted stays
    // terminal; the follow-up re-link is suppressed inside the loop).
    const seenPid = new Set<string>();
    const traces = (traceSourceHealthy ? allTraces : []).filter((t) => {
      if (t.outcome !== 'merged' && t.outcome !== 'followed-up') return false;
      if (revertedPids.has(t.proposalId)) return false;
      if (seenPid.has(t.proposalId)) return false;
      seenPid.add(t.proposalId);
      return true;
    });
    type Candidate = {
      proposalId: string;
      proposal: Proposal;
      cursor: MonitoringOutcomeCandidateCursor;
    };
    const candidates = new Map<string, Candidate>();
    const detailed = typeof listProposalsDetailed === 'function'
      ? listProposalsDetailed({ status: 'applied', requireComplete: true })
      : null;
    const proposalSourceIncomplete = Boolean(detailed &&
      (!detailed.complete || detailed.sourceState === 'degraded' ||
        (productionCursorMode && detailed.sourceState !== 'healthy')));
    if (proposalSourceIncomplete) {
      scan.sourceComplete = false;
      scan.skipped++;
    }
    const appliedProposals = detailed?.proposals ?? (typeof listProposals === 'function'
      ? listProposals({ status: 'applied' })
      : []);
    if (productionCursorMode && proposalSourceIncomplete) return scan;
    const strictProposals = new Map(
      appliedProposals
        .filter((proposal) => proposal.status === 'applied' && realizedMergeOf(proposal) !== null)
        .map((proposal) => [proposal.id, proposal]),
    );
    for (const trace of traces) {
      const proposal = strictProposals.get(trace.proposalId);
      if (!proposal) continue;
      if (!productionCursorMode && candidates.size >= MAX_OUTCOME_PROPOSALS) {
        scan.candidateLimitReached = true;
        scan.sourceComplete = false;
        break;
      }
      const merge = realizedMergeOf(proposal)!;
      candidates.set(trace.proposalId, {
        proposalId: trace.proposalId,
        proposal,
        cursor: { proposalId: trace.proposalId, mergeCommitOid: merge.mergeCommitOid },
      });
    }
    for (const proposal of appliedProposals) {
      if (proposal.status !== 'applied') continue;
      const merge = realizedMergeOf(proposal);
      if (!merge) continue;
      const candidateAt = merge.source === 'github-host' ? merge.mergedAt : merge.observedAt;
      if (Date.parse(candidateAt) < sinceMs) continue;
      if (!productionCursorMode && candidates.size >= MAX_OUTCOME_PROPOSALS && !candidates.has(proposal.id)) {
        scan.candidateLimitReached = true;
        scan.sourceComplete = false;
        break;
      }
      candidates.set(proposal.id, {
        proposalId: proposal.id,
        proposal,
        cursor: { proposalId: proposal.id, mergeCommitOid: merge.mergeCommitOid },
      });
    }
    if (candidates.size === 0) {
      if (!productionCursorMode) {
        if (scan.skipped === 0 && scan.sourceComplete) recordCompletedScan(stateFile, now);
        return scan;
      }
      const enrollment = opts?.enrolledRepos ?? [];
      const cursorRead = loadMonitoringCursor(enrollment);
      if (cursorRead.sourceState === 'degraded') {
        scan.skipped++;
        scan.sourceComplete = false;
        return scan;
      }
      const current = cursorRead.cursor ?? buildMonitoringCursor(enrollment);
      if (!current) return scan;
      const completed: MonitoringCursorV1 = {
        ...current,
        outcome: {
          candidateAfter: current.outcome.candidateAfter,
          sweepComplete: true,
          hadIncomplete: current.outcome.hadIncomplete || !scan.sourceComplete || scan.skipped > 0,
          candidateSetDigest: candidateSetDigest([]),
        },
      };
      if (!saveMonitoringCursor(completed, {
        enrolledRepos: enrollment,
        expectedCursor: cursorRead.storedCursor,
      })) {
        scan.skipped++;
        scan.sourceComplete = false;
        return scan;
      }
      if (!completed.outcome.hadIncomplete) recordCompletedScan(stateFile, now, completed);
      return scan;
    }
    const enrolled = opts?.enrolledRepos === undefined
      ? null
      : new Set(opts.enrolledRepos.map((repo) => resolve(repo)));
    let monitoringCursor: MonitoringCursorV1 | null = null;
    let monitoringCursorExpected: MonitoringCursorV1 | null = null;
    let selectedCandidates = [...candidates.values()];
    let finalCandidateKey: string | null = null;
    const sweepSourceIncomplete = !scan.sourceComplete;
    if (productionCursorMode) {
      const enrollment = opts.enrolledRepos ?? [];
      const cursorRead = loadMonitoringCursor(enrollment);
      if (cursorRead.sourceState === 'degraded') {
        scan.sourceComplete = false;
        scan.skipped++;
        return scan;
      }
      monitoringCursor = cursorRead.cursor ?? buildMonitoringCursor(enrollment);
      monitoringCursorExpected = cursorRead.storedCursor;
      if (!monitoringCursor) return scan;
      const cursorCandidates = [...candidates.values()].map((candidate) => candidate.cursor);
      const ordered = [...cursorCandidates]
        .sort((left, right) => outcomeCandidateKey(left).localeCompare(outcomeCandidateKey(right)));
      const currentCandidateSetDigest = candidateSetDigest(ordered);
      if (monitoringCursor.outcome.sweepComplete ||
        (monitoringCursor.outcome.candidateAfter !== null &&
          monitoringCursor.outcome.candidateSetDigest !== currentCandidateSetDigest)) {
        monitoringCursor = {
          ...monitoringCursor,
          outcome: {
            candidateAfter: null,
            sweepComplete: false,
            hadIncomplete: false,
            candidateSetDigest: currentCandidateSetDigest,
          },
        };
      } else if (monitoringCursor.outcome.candidateSetDigest === null) {
        monitoringCursor = {
          ...monitoringCursor,
          outcome: { ...monitoringCursor.outcome, candidateSetDigest: currentCandidateSetDigest },
        };
      }
      const after = monitoringCursor.outcome.candidateAfter;
      const afterKey = after ? outcomeCandidateKey(after) : null;
      const selectedForSweep = ordered
        .filter((candidate) => afterKey === null || outcomeCandidateKey(candidate).localeCompare(afterKey) > 0)
        .slice(0, MAX_OUTCOME_CANDIDATES_PER_PASS);
      const candidateByKey = new Map([...candidates.values()]
        .map((candidate) => [outcomeCandidateKey(candidate.cursor), candidate]));
      selectedCandidates = [];
      for (const selectedCursor of selectedForSweep) {
        const candidate = candidateByKey.get(outcomeCandidateKey(selectedCursor));
        if (candidate) selectedCandidates.push(candidate);
      }
      finalCandidateKey = ordered.length > 0 ? outcomeCandidateKey(ordered[ordered.length - 1]!) : null;
      if (selectedCandidates.length === 0 && afterKey !== null) {
        monitoringCursor = {
          ...monitoringCursor,
          outcome: {
            candidateAfter: monitoringCursor.outcome.candidateAfter,
            sweepComplete: true,
            hadIncomplete: monitoringCursor.outcome.hadIncomplete || sweepSourceIncomplete,
            candidateSetDigest: currentCandidateSetDigest,
          },
        };
        if (!saveMonitoringCursor(monitoringCursor, {
          enrolledRepos: enrollment,
          expectedCursor: monitoringCursorExpected,
        })) {
          scan.skipped++;
          scan.sourceComplete = false;
          return scan;
        }
        monitoringCursorExpected = monitoringCursor;
      }
    }

    for (const candidate of selectedCandidates) {
      let cursorPersistFailed = false;
      const skippedBeforeCandidate = scan.skipped;
      scan.scanned++;
      try {
        const proposal = candidate.proposal;
        const repo = proposal.repo;
        if (!repo || !existsSync(repo) || (enrolled !== null && !enrolled.has(resolve(repo)))) {
          scan.skipped++;
          continue;
        }

        const merge = realizedMergeOf(proposal);
        if (!merge) {
          scan.skipped++;
          continue;
        }
        const mergeSha = merge.mergeCommitOid;
        const mergedAt = merge.source === 'github-host' ? merge.mergedAt : undefined;
        const inspection = inspectPostMergeWindow({
          repo: resolve(repo),
          mergeCommit: mergeSha,
          observedAtMs: now,
          followUpWindowMs: windowDays * 24 * 60 * 60 * 1_000,
          ...(mergedAt ? { windowStartedAtMs: Date.parse(mergedAt) } : {}),
        });
        if (inspection.state === 'inconclusive') {
          scan.skipped++;
          continue;
        }
        if (inspection.adverse?.outcome === 'reverted') {
          if (!recordRealizedOutcome(
            candidate.proposalId,
            proposal,
            inspection.mergeCommit,
            inspection.observedHead,
            'reverted',
            'git-revert-reference',
            now,
          )) {
            scan.skipped++;
            continue;
          }
          scan.reverts++;
          continue;
        }

        // An existing heuristic observation remains scannable for a later
        // deterministic revert, but never emits the same heuristic twice.
        if (followedUpPids.has(candidate.proposalId)) continue;
        if (inspection.adverse?.outcome === 'followed-up') {
          if (!recordRealizedOutcome(
            candidate.proposalId,
            proposal,
            inspection.mergeCommit,
            inspection.observedHead,
            'followed-up',
            'overlapping-fix',
            now,
          )) {
            scan.skipped++;
            continue;
          }
          scan.followUps++;
        }
      } catch {
        scan.skipped++;
      } finally {
        if (productionCursorMode && monitoringCursor && candidate.cursor) {
          const sweepComplete = finalCandidateKey === outcomeCandidateKey(candidate.cursor);
          const candidateIncomplete = scan.skipped > skippedBeforeCandidate;
          monitoringCursor = {
            ...monitoringCursor,
            outcome: {
              candidateAfter: candidate.cursor,
              sweepComplete,
              hadIncomplete: monitoringCursor.outcome.hadIncomplete || sweepSourceIncomplete || candidateIncomplete,
              candidateSetDigest: monitoringCursor.outcome.candidateSetDigest,
            },
          };
          if (!saveMonitoringCursor(monitoringCursor, {
            enrolledRepos: opts?.enrolledRepos ?? [],
            expectedCursor: monitoringCursorExpected,
          })) {
            scan.skipped++;
            scan.sourceComplete = false;
            cursorPersistFailed = true;
          } else {
            monitoringCursorExpected = monitoringCursor;
          }
        }
      }
      if (cursorPersistFailed) break;
    }
    if (scan.skipped > 0) scan.sourceComplete = false;
    const sweepComplete = !productionCursorMode || monitoringCursor?.outcome.sweepComplete === true;
    const sweepHadIncomplete = productionCursorMode && monitoringCursor?.outcome.hadIncomplete === true;
    if (scan.sourceComplete && sweepComplete && !sweepHadIncomplete) {
      if (productionCursorMode && monitoringCursor) recordCompletedScan(stateFile, now, monitoringCursor);
      else if (!productionCursorMode) recordCompletedScan(stateFile, now);
    }
    return scan;
  } catch {
    return scan;
  }
}
