/**
 * outcome-watcher.ts — M332 (completes M141): detect the REAL-WORLD outcome
 * of auto-merged proposals and link it back onto their judge traces.
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
 * ledger writes go through append-only linkOutcomeResult after a complete
 * source read. Internal throttle (default 6h) keeps the git cost negligible.
 * Never throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import type { AshlrConfig, SkillCard } from '../types.js';
import { readJudgeTraces, linkOutcomeResult } from './judge-trace.js';
import { listProposals, loadProposal } from '../inbox/store.js';
import { recordPostMergeObservation, type PostMergeOutcome } from './post-merge-observations.js';
import { attestSkillCard, verifyAttestedSkillCard } from './skill-attestation.js';
import { readSkillCards, recordSkillCard, sanitizeSkillCard } from './skill-records.js';

export interface OutcomeScan {
  /** Merged traces examined this pass. */
  scanned: number;
  reverts: number;
  followUps: number;
  /** Traces skipped (no proposal/repo, no merge commit found, git error). */
  skipped: number;
  /** True when the throttle short-circuited the pass entirely. */
  throttled: boolean;
}

const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_FOLLOWUP_WINDOW_DAYS = 7;
const MAX_CANDIDATE_COMMITS = 50;
const MAX_OUTCOME_PROPOSALS = 200;
const FOLLOWUP_SUBJECT_RE = /\b(fix|hotfix|revert)\b/i;

function defaultStateFile(): string {
  return join(homedir(), '.ashlr', 'outcome-watcher.json');
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    timeout: 15_000,
    encoding: 'utf8',
  });
}

function filesOf(repo: string, sha: string): Set<string> {
  const out = git(repo, ['show', '--name-only', '--format=', sha]);
  return new Set(out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0));
}

function recordRealizedOutcome(
  proposalId: string,
  mergeCommit: string,
  observedHead: string,
  outcome: PostMergeOutcome,
  basis: 'git-revert-reference' | 'overlapping-fix',
  now: number,
): boolean {
  const proposal = loadProposal(proposalId);
  if (!proposal?.repo) return false;
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
 * Build a sanitized, newly attested lifecycle revision. Existing attestation
 * fields are never carried across changed revision/status content.
 */
export function buildSkillLifecycleRevision(
  current: SkillCard,
  status: 'deprecated' | 'revoked',
  nowMs: number,
): SkillCard | null {
  try {
    const revision = sanitizeSkillCard({
      ...current,
      revision: current.revision + 1,
      ts: new Date(nowMs).toISOString(),
      status,
      contentHash: undefined,
      attestation: undefined,
    });
    return attestSkillCard(revision);
  } catch {
    return null;
  }
}

function invalidateVerifiedSkills(
  proposalId: string,
  status: 'deprecated' | 'revoked',
  nowMs: number,
): void {
  try {
    const cards = readSkillCards({ limit: 1_000, maxFiles: 31 });
    const histories = new Map<string, typeof cards>();
    for (const card of cards) {
      if (!verifyAttestedSkillCard(card)) continue;
      const history = histories.get(card.skillId) ?? [];
      history.push(card);
      histories.set(card.skillId, history);
    }

    const invalidations: SkillCard[] = [];
    for (const history of histories.values()) {
      // Revocation is terminal even if a malformed later revision attempts to
      // revive the skill. Conflicting latest revisions also fail closed.
      if (history.some((card) => card.status === 'revoked')) continue;
      const latestRevision = Math.max(...history.map((card) => card.revision));
      if (!Number.isSafeInteger(latestRevision) || latestRevision >= Number.MAX_SAFE_INTEGER) continue;
      const latest = history.filter((card) => card.revision === latestRevision);
      if (latest.length === 0) continue;
      const current = latest[0]!;
      const fingerprint = JSON.stringify(current);
      if (latest.some((card) => JSON.stringify(card) !== fingerprint)) continue;
      if (current.proposalId !== proposalId) continue;
      const canInvalidate = current.status === 'verified'
        || (status === 'revoked' && current.status === 'deprecated');
      if (!canInvalidate) continue;
      const invalidation = buildSkillLifecycleRevision(current, status, nowMs);
      if (invalidation) invalidations.push(invalidation);
    }
    if (invalidations.length > 0) recordSkillCard(invalidations);
  } catch {
    // Skill lifecycle history is best-effort and must never disrupt scanning.
  }
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
  },
): Promise<OutcomeScan> {
  const scan: OutcomeScan = { scanned: 0, reverts: 0, followUps: 0, skipped: 0, throttled: false };
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
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ lastScanAt: now }) + '\n', 'utf8');
    } catch {
      /* throttle is best-effort */
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
    const candidates = new Map<string, { proposalId: string; traceBacked: boolean }>();
    for (const trace of traces) candidates.set(trace.proposalId, { proposalId: trace.proposalId, traceBacked: true });
    const appliedProposals = typeof listProposals === 'function'
      ? listProposals({ status: 'applied' })
      : [];
    for (const proposal of appliedProposals) {
      const candidateAt = proposal.remoteHandoff?.updatedAt ?? proposal.createdAt;
      if (Date.parse(candidateAt) < sinceMs) continue;
      if (!candidates.has(proposal.id)) candidates.set(proposal.id, { proposalId: proposal.id, traceBacked: false });
      if (candidates.size >= MAX_OUTCOME_PROPOSALS) break;
    }
    if (candidates.size === 0) return scan;

    for (const candidate of candidates.values()) {
      scan.scanned++;
      try {
        const proposal = loadProposal(candidate.proposalId);
        const repo = proposal?.repo;
        if (!repo || !existsSync(repo)) {
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
          if (!recordRealizedOutcome(candidate.proposalId, mergeSha, observedHead, 'reverted', 'git-revert-reference', now)) {
            scan.skipped++;
            continue;
          }
          const linked = candidate.traceBacked
            ? linkOutcomeResult(candidate.proposalId, 'reverted')
            : { status: 'not-applicable' as const };
          if (candidate.traceBacked && linked.status !== 'linked' && linked.status !== 'already-linked') {
            scan.skipped++;
            continue;
          }
          invalidateVerifiedSkills(candidate.proposalId, 'revoked', now);
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

        // M337 (review fix): git log is newest-first, but the commits INSIDE
        // the follow-up window are the OLDEST ones since the merge — slicing
        // the newest 50 silently dropped exactly the window commits in any
        // active repo. Examine oldest-first and stop once past the window.
        const candidates = git(repo, [
          'log', `${mergeSha}..HEAD`, '--format=%H%x09%ct%x09%s',
        ])
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .reverse()
          .slice(0, MAX_CANDIDATE_COMMITS);

        for (const line of candidates) {
          const [sha, ctRaw, ...subjectParts] = line.split('\t');
          const subject = subjectParts.join('\t');
          const ctMs = Number(ctRaw) * 1000;
          if (!sha || !Number.isFinite(ctMs)) continue;
          if (ctMs > windowEnd) break; // oldest-first: past the window ⇒ done
          if (!FOLLOWUP_SUBJECT_RE.test(subject ?? '')) continue;
          const touched = filesOf(repo, sha);
          const overlaps = [...touched].some((f) => mergedFiles.has(f));
          if (overlaps) {
            if (!recordRealizedOutcome(candidate.proposalId, mergeSha, observedHead, 'followed-up', 'overlapping-fix', now)) {
              scan.skipped++;
              break;
            }
            const linked = candidate.traceBacked
              ? linkOutcomeResult(candidate.proposalId, 'followed-up')
              : { status: 'not-applicable' as const };
            if (candidate.traceBacked && linked.status !== 'linked' && linked.status !== 'already-linked') {
              scan.skipped++;
              break;
            }
            invalidateVerifiedSkills(candidate.proposalId, 'deprecated', now);
            scan.followUps++;
            break;
          }
        }
      } catch {
        scan.skipped++;
      }
    }
    return scan;
  } catch {
    return scan;
  }
}
