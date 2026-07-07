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
 * ledger writes go through linkOutcome (serial maintenance phase only — the
 * in-place JSONL rewrite must never run inside the concurrent dispatch
 * closure). Internal throttle (default 6h) keeps the git cost negligible.
 * Never throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import type { AshlrConfig } from '../types.js';
import { readJudgeTraces, linkOutcome } from './judge-trace.js';

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
    const allTraces = readJudgeTraces({ sinceMs });
    const alreadyLinked = new Set(
      allTraces
        .filter((t) => t.outcome === 'reverted' || t.outcome === 'followed-up')
        .map((t) => t.proposalId),
    );
    const traces = allTraces.filter(
      (t) => t.outcome === 'merged' && !alreadyLinked.has(t.proposalId),
    );
    if (traces.length === 0) return scan;

    const { loadProposal } = await import('../inbox/store.js');

    for (const trace of traces) {
      scan.scanned++;
      try {
        const repo = loadProposal(trace.proposalId)?.repo;
        if (!repo || !existsSync(repo)) {
          scan.skipped++;
          continue;
        }

        // Merge commit via the auto-merge message convention (-F = fixed
        // string). Take the OLDEST match: a `git revert` of the merge quotes
        // the original subject (Revert "ashlr: auto-merge proposal <id>"), so
        // the newest match can be the revert itself — the true merge commit
        // always predates it.
        const mergeMatches = git(repo, [
          'log', '-F', `--grep=ashlr: auto-merge proposal ${trace.proposalId}`,
          '--format=%H',
        ])
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const mergeSha = mergeMatches.at(-1) ?? '';
        if (!mergeSha) {
          scan.skipped++;
          continue;
        }

        // (a) Revert: any commit referencing the merge sha.
        const revertSha = git(repo, [
          'log', '-F', `--grep=This reverts commit ${mergeSha}`,
          '--format=%H', '-n', '1',
        ]).trim();
        if (revertSha) {
          linkOutcome(trace.proposalId, 'reverted');
          scan.reverts++;
          continue;
        }

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
            linkOutcome(trace.proposalId, 'followed-up');
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
