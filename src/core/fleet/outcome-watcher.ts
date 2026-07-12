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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import type { AshlrConfig, Proposal } from '../types.js';
import { readJudgeTraces } from './judge-trace.js';
import { listProposals, listProposalsDetailed, loadProposal } from '../inbox/store.js';
import { recordPostMergeObservation, type PostMergeOutcome } from './post-merge-observations.js';
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
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const FOLLOWUP_SUBJECT_RE = /\b(fix|hotfix|revert)\b/i;

function defaultStateFile(): string {
  return join(homedir(), '.ashlr', 'outcome-watcher.json');
}

function recordCompletedScan(stateFile: string, now: number): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ lastScanAt: now }) + '\n', 'utf8');
  } catch {
    // The durable monitoring cursor supersedes this compatibility throttle.
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    encoding: 'utf8',
  });
}

function filesOf(repo: string, sha: string): Set<string> {
  const out = git(repo, ['show', '--name-only', '--format=', sha]);
  return new Set(out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0));
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

    // Throttle (best-effort state file; a corrupt file simply re-runs).
    if (opts?.force !== true) {
      try {
        if (existsSync(stateFile)) {
          const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
          const last = typeof raw['lastScanAt'] === 'number' ? raw['lastScanAt'] : 0;
          if (now - last < THROTTLE_MS) {
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
      proposal?: Proposal;
      cursor?: MonitoringOutcomeCandidateCursor;
    };
    const candidates = new Map<string, Candidate>();
    const productionCursorMode = opts?.enrolledRepos !== undefined;
    const detailed = typeof listProposalsDetailed === 'function'
      ? listProposalsDetailed({ status: 'applied', requireComplete: true })
      : null;
    if (detailed && (!detailed.complete || detailed.sourceState === 'degraded' ||
      (productionCursorMode && detailed.sourceState !== 'healthy'))) {
      scan.sourceComplete = false;
      scan.skipped++;
    }
    const appliedProposals = detailed?.proposals ?? (typeof listProposals === 'function'
      ? listProposals({ status: 'applied' })
      : []);
    if (productionCursorMode && !scan.sourceComplete) return scan;
    const strictProposals = new Map(appliedProposals.map((proposal) => [proposal.id, proposal]));
    for (const trace of traces) {
      const proposal = strictProposals.get(trace.proposalId);
      if (productionCursorMode && !proposal) continue;
      if (!productionCursorMode && candidates.size >= MAX_OUTCOME_PROPOSALS) {
        scan.candidateLimitReached = true;
        scan.sourceComplete = false;
        break;
      }
      candidates.set(trace.proposalId, { proposalId: trace.proposalId, ...(proposal ? { proposal } : {}) });
    }
    for (const proposal of appliedProposals) {
      const candidateAt = proposal.remoteHandoff?.updatedAt ?? proposal.createdAt;
      if (Date.parse(candidateAt) < sinceMs) continue;
      const mergeCommitOid = proposal.remoteHandoff?.mergeCommitOid;
      if (productionCursorMode && (typeof mergeCommitOid !== 'string' || !/^[a-f0-9]{40}$/i.test(mergeCommitOid))) {
        scan.skipped++;
        scan.sourceComplete = false;
        continue;
      }
      if (!productionCursorMode && candidates.size >= MAX_OUTCOME_PROPOSALS && !candidates.has(proposal.id)) {
        scan.candidateLimitReached = true;
        scan.sourceComplete = false;
        break;
      }
      candidates.set(proposal.id, {
        proposalId: proposal.id,
        proposal,
        ...(mergeCommitOid ? { cursor: { proposalId: proposal.id, mergeCommitOid } } : {}),
      });
    }
    if (candidates.size === 0) {
      if (scan.skipped === 0 && scan.sourceComplete) recordCompletedScan(stateFile, now);
      return scan;
    }
    const enrolled = opts?.enrolledRepos === undefined
      ? null
      : new Set(opts.enrolledRepos.map((repo) => resolve(repo)));
    let monitoringCursor: MonitoringCursorV1 | null = null;
    let monitoringCursorExpected: MonitoringCursorV1 | null = null;
    let selectedCandidates = [...candidates.values()];
    let finalCandidateKey: string | null = null;
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
      const cursorCandidates = [...candidates.values()]
        .map((candidate) => candidate.cursor)
        .filter((candidate): candidate is MonitoringOutcomeCandidateCursor => candidate !== undefined);
      const after = monitoringCursor.outcome.sweepComplete ? null : monitoringCursor.outcome.candidateAfter;
      const afterKey = after ? outcomeCandidateKey(after) : null;
      const ordered = [...cursorCandidates]
        .sort((left, right) => outcomeCandidateKey(left).localeCompare(outcomeCandidateKey(right)));
      const selectedForSweep = ordered
        .filter((candidate) => afterKey === null || outcomeCandidateKey(candidate).localeCompare(afterKey) > 0)
        .slice(0, MAX_OUTCOME_CANDIDATES_PER_PASS);
      const candidateByKey = new Map([...candidates.values()]
        .filter((candidate): candidate is Candidate & { cursor: MonitoringOutcomeCandidateCursor } => candidate.cursor !== undefined)
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
          outcome: { candidateAfter: monitoringCursor.outcome.candidateAfter, sweepComplete: true },
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
      scan.scanned++;
      try {
        const proposal = candidate.proposal ?? loadProposal(candidate.proposalId);
        const repo = proposal?.repo;
        if (!repo || !existsSync(repo) || (enrolled !== null && !enrolled.has(resolve(repo)))) {
          scan.skipped++;
          continue;
        }

        // Merge commit via the auto-merge message convention (-F = fixed
        // string). Take the OLDEST match: a `git revert` of the merge quotes
        // the original subject (Revert "ashlr: auto-merge proposal <id>"), so
        // the newest match can be the revert itself — the true merge commit
        // always predates it.
        const expectedSubject = `ashlr: auto-merge proposal ${candidate.proposalId}`;
        const mergeMatches = git(repo, ['log', '--format=%H%x09%s'])
          .split('\n')
          .map((line) => line.split('\t', 2))
          .filter((parts) => parts[1] === expectedSubject)
          .map((parts) => parts[0] ?? '')
          .filter(Boolean);
        const mergeSha = proposal.remoteHandoff?.mergeCommitOid ?? mergeMatches.at(-1) ?? '';
        if (!mergeSha) {
          scan.skipped++;
          continue;
        }
        const observedHead = git(repo, ['rev-parse', 'HEAD']).trim();
        if (!/^[0-9a-f]{40}$/i.test(mergeSha) || !/^[0-9a-f]{40}$/i.test(observedHead)) {
          scan.skipped++;
          continue;
        }
        git(repo, ['cat-file', '-e', `${mergeSha}^{commit}`]);
        git(repo, ['merge-base', '--is-ancestor', mergeSha, observedHead]);

        // (a) Revert: any commit referencing the merge sha.
        const revertSha = git(repo, [
          'log', '-F', `--grep=This reverts commit ${mergeSha}`,
          '--format=%H', '-n', '1',
        ]).trim();
        if (revertSha) {
          if (!recordRealizedOutcome(candidate.proposalId, proposal, mergeSha, observedHead, 'reverted', 'git-revert-reference', now)) {
            scan.skipped++;
            continue;
          }
          scan.reverts++;
          continue;
        }

        // M338: already followed-up — only the reverted UPGRADE above is
        // interesting for this proposal; never re-link the same outcome.
        if (followedUpPids.has(candidate.proposalId)) continue;

        // (b) Follow-up fix: a near-term commit after the merge touching the
        //     same files with a fix-flavored subject.
        const mergeTimeRaw = git(repo, ['show', '-s', '--format=%ct', mergeSha]).trim();
        const mergeTimeMs = Number(mergeTimeRaw) * 1000;
        if (!Number.isFinite(mergeTimeMs)) {
          continue;
        }
        const windowEnd = mergeTimeMs + windowDays * 24 * 60 * 60 * 1000;
        const mergedFiles = filesOf(repo, mergeSha);
        if (mergedFiles.size === 0) continue;

        // Read the complete time-bounded window in one output- and timeout-
        // bounded process. This avoids a fixed commit-count blind spot while
        // retaining a hard resource ceiling for unusually large histories.
        const history = git(repo, [
          'log', `${mergeSha}..HEAD`, `--until=${Math.floor(windowEnd / 1000)}`,
          '--no-renames', '--format=%H%x09%ct%x09%s', '--name-only',
        ]);
        const commits: Array<{ sha: string; subject: string; touched: Set<string> }> = [];
        let current: { sha: string; subject: string; touched: Set<string> } | null = null;
        for (const rawLine of history.split('\n')) {
          const line = rawLine.trim();
          const header = /^([a-f0-9]{40})\t(\d+)\t(.*)$/i.exec(line);
          if (header) {
            current = { sha: header[1]!, subject: header[3]!, touched: new Set<string>() };
            commits.push(current);
          } else if (line && current) {
            current.touched.add(line);
          }
        }

        for (const commit of commits.reverse()) {
          if (!FOLLOWUP_SUBJECT_RE.test(commit.subject)) continue;
          const touched = commit.touched;
          const overlaps = [...touched].some((f) => mergedFiles.has(f));
          if (overlaps) {
            if (!recordRealizedOutcome(candidate.proposalId, proposal, mergeSha, observedHead, 'followed-up', 'overlapping-fix', now)) {
              scan.skipped++;
              break;
            }
            scan.followUps++;
            break;
          }
        }
      } catch {
        scan.skipped++;
      } finally {
        if (productionCursorMode && monitoringCursor && candidate.cursor) {
          const sweepComplete = finalCandidateKey === outcomeCandidateKey(candidate.cursor);
          monitoringCursor = {
            ...monitoringCursor,
            outcome: { candidateAfter: candidate.cursor, sweepComplete },
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
    if (scan.sourceComplete && sweepComplete) recordCompletedScan(stateFile, now);
    return scan;
  } catch {
    return scan;
  }
}
