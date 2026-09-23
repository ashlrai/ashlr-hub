/**
 * overnight-status.ts — the engine half of the `GET /api/verse/overnight`
 * contract. The route (owned elsewhere, under src/web-ui / verse) reads this;
 * this module never serves HTTP and never imports a web module.
 *
 * ── THE TRI-STATE RULE, WHICH IS THE WHOLE POINT ───────────────────────────
 * Every field except `armed` is tri-state: `null` means "the engine did not
 * say", and the client renders that differently from zero. So nothing here
 * ever defaults an unknown to 0. `iterationsDone: null` is "no run has
 * reported yet"; `iterationsDone: 0` is "a run is going and has finished no
 * iteration". Those are different facts and the operator can tell them apart.
 *
 * ── WHERE `merged[]` COMES FROM ────────────────────────────────────────────
 * From the repositories, not from a counter. `daemon/post-merge-halt` detects
 * landings by comparing each ENROLLED repo's head across a tick, so every row
 * carries a real commit OID and the real subject line. A count can drift from
 * what actually landed; a commit OID cannot.
 *
 * ── WHERE `discarded[].reason` COMES FROM ──────────────────────────────────
 * Whoever discarded it says why, in their own words, and this module passes
 * the sentence through untouched. "post-merge suite failed on <repo>" and
 * "typecheck failed" are answers; "rejected" is not. A quiet night has to be
 * legible in the morning or the run window is not worth having.
 *
 * `~/.ashlr/run-window/status.json`, written durably (exclusive tmp + atomic
 * rename). Metadata only — never a diff, a token, or command output.
 *
 * No new runtime deps; node builtins only. Never throws out of a public API.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { RunWindowStopRule } from './run-window.js';
import type { PostMergeGateResult } from './post-merge-halt.js';

// ---------------------------------------------------------------------------
// The wire shapes — shared verbatim with the client's overnight-contract.ts
// ---------------------------------------------------------------------------

export interface OvernightMergedItem {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly at: string | null;
  readonly commit: string | null;
}

export interface OvernightDiscardedItem {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly at: string | null;
  /** A SPECIFIC sentence. Never a bare 'rejected'. */
  readonly reason: string;
}

export interface OvernightRun {
  readonly runId: string;
  readonly startedAt: string | null;
  readonly stopRule: RunWindowStopRule | null;
  /** null means "did not say" — NOT zero. */
  readonly iterationsDone: number | null;
  readonly repo: string | null;
  /** Free text in the engine's own words, rendered verbatim. */
  readonly activity: string | null;
  readonly merged: OvernightMergedItem[];
  readonly discarded: OvernightDiscardedItem[];
}

export interface OvernightGate {
  readonly tests: boolean;
  readonly lint: boolean;
  readonly typecheck: boolean;
  readonly autoMerge: boolean | null;
  readonly branch: string | null;
}

export interface OvernightStatus {
  /** The one field that may never be absent. */
  readonly armed: boolean;
  readonly repos: number | null;
  readonly gate: OvernightGate | null;
  readonly run: OvernightRun | null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function overnightStatusDir(): string {
  return join(homedir(), '.ashlr', 'run-window');
}

export function overnightStatusPath(): string {
  return join(overnightStatusDir(), 'status.json');
}

interface StoredStatus {
  readonly recordType: 'daemon-overnight-status';
  readonly armed: boolean;
  readonly repos: number | null;
  readonly gate: OvernightGate | null;
  readonly run: OvernightRun | null;
}

/** The safe empty answer. Disarmed, and honest that it knows nothing else. */
export function emptyOvernightStatus(): OvernightStatus {
  return { armed: false, repos: null, gate: null, run: null };
}

function writeStatus(status: StoredStatus): boolean {
  try {
    const dir = overnightStatusDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = overnightStatusPath();
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the rename already consumed it */ }
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current status. A missing or unreadable file answers
 * {@link emptyOvernightStatus} — DISARMED. That is the fail-safe direction:
 * an engine that cannot prove it armed a run must never claim it did.
 */
export function readOvernightStatus(): OvernightStatus {
  try {
    const parsed = JSON.parse(readFileSync(overnightStatusPath(), 'utf8')) as StoredStatus;
    if (parsed?.recordType !== 'daemon-overnight-status') return emptyOvernightStatus();
    return {
      armed: parsed.armed === true,
      repos: typeof parsed.repos === 'number' ? parsed.repos : null,
      gate: parsed.gate ?? null,
      run: parsed.run ?? null,
    };
  } catch {
    return emptyOvernightStatus();
  }
}

/** Merge a partial update into the stored status. Never throws. */
export function updateOvernightStatus(patch: Partial<OvernightStatus>): OvernightStatus {
  const current = readOvernightStatus();
  const next: OvernightStatus = {
    armed: patch.armed ?? current.armed,
    repos: patch.repos !== undefined ? patch.repos : current.repos,
    gate: patch.gate !== undefined ? patch.gate : current.gate,
    run: patch.run !== undefined ? patch.run : current.run,
  };
  writeStatus({ recordType: 'daemon-overnight-status', ...next });
  return next;
}

/**
 * Arm a run. `disarm` stops the NEXT run, not this one — halting a LIVE run is
 * the existing pause (`POST /api/verse/daemon {action:'pause'}`), and this
 * module deliberately offers no second way to do it.
 */
export function armOvernightRun(
  stopRule: RunWindowStopRule,
  opts: { repos?: number | null; gate?: OvernightGate | null; runId?: string; now?: () => number } = {},
): OvernightStatus {
  const nowMs = (opts.now ?? Date.now)();
  return updateOvernightStatus({
    armed: true,
    repos: opts.repos ?? null,
    gate: opts.gate ?? null,
    run: {
      runId: opts.runId ?? randomUUID(),
      startedAt: new Date(nowMs).toISOString(),
      stopRule,
      // A freshly armed run HAS done zero iterations — that is a fact it can
      // state, so it is 0 and not null.
      iterationsDone: 0,
      repo: null,
      activity: 'armed; waiting for the first tick',
      merged: [],
      discarded: [],
    },
  });
}

/** Disarm the NEXT run. Leaves the last run's record intact for the morning. */
export function disarmOvernightRun(): OvernightStatus {
  return updateOvernightStatus({ armed: false });
}

// ---------------------------------------------------------------------------
// Recording progress
// ---------------------------------------------------------------------------

/** `ashlr: auto-merge proposal <id>` / `ashlr: merge proposal branch ashlr/merge/<id>`. */
const PROPOSAL_ID_PATTERNS: RegExp[] = [
  /^ashlr:\s*auto-merge proposal\s+(\S+)/,
  /^ashlr:\s*merge proposal branch\s+ashlr\/merge\/(\S+)/,
];

/**
 * Recover the proposal id a landed commit came from, so `merged[].id` is the
 * id the inbox knows rather than an invented one. Returns null when the
 * subject is not one the merge path writes — a hand-made commit is reported
 * honestly as having no proposal id, never given a fabricated one.
 */
export function proposalIdFromCommitSubject(subject: string): string | null {
  for (const pattern of PROPOSAL_ID_PATTERNS) {
    const match = pattern.exec(subject ?? '');
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Fold one iteration's post-merge gate result into the live run record.
 *
 * A CLEAN landing appends to `merged[]`; a HALT appends to `discarded[]` with
 * the gate's own specific sentence. Both come from repository truth.
 */
export function recordOvernightIteration(
  result: PostMergeGateResult,
  opts: { iterationsDone?: number; activity?: string | null; now?: () => number } = {},
): OvernightStatus {
  const current = readOvernightStatus();
  if (!current.run) return current;
  const nowMs = (opts.now ?? Date.now)();
  const at = new Date(nowMs).toISOString();

  const merged: OvernightMergedItem[] = [...current.run.merged];
  const discarded: OvernightDiscardedItem[] = [...current.run.discarded];

  if (!result.halt) {
    for (const landing of result.landings) {
      for (const commit of landing.commits) {
        merged.push({
          id: proposalIdFromCommitSubject(commit.subject) ?? commit.sha.slice(0, 12),
          repo: landing.repo,
          title: commit.subject,
          at,
          commit: commit.sha,
        });
      }
    }
  } else {
    // A halted landing is not a merge that stuck — it is work the operator
    // must back out, and it says exactly why and exactly how.
    for (const landing of result.landings) {
      const why = result.failures
        .filter((f) => f.repo === landing.repo)
        .map((f) => `${f.kind} ${f.detail}`)
        .join('; ');
      discarded.push({
        id: landing.commits[0]
          ? proposalIdFromCommitSubject(landing.commits[0].subject) ?? landing.commits[0].sha.slice(0, 12)
          : landing.afterHead.slice(0, 12),
        repo: landing.repo,
        title: landing.commits[0]?.subject ?? `landing ${landing.beforeHead.slice(0, 8)}..${landing.afterHead.slice(0, 8)}`,
        at,
        reason: result.verdict === 'regressed'
          ? `post-merge suite failed on ${landing.repo}: ${why || 'a required check went red after the merge'}. ` +
            `Back it out with: ${landing.revertCommand}`
          : `the merge on ${landing.repo} could not be verified: ${why || 'no required verify command could be run'}. ` +
            `Back it out with: ${landing.revertCommand}`,
      });
    }
  }

  return updateOvernightStatus({
    run: {
      ...current.run,
      iterationsDone: opts.iterationsDone ?? current.run.iterationsDone,
      repo: result.landings[0]?.repo ?? current.run.repo,
      activity: opts.activity !== undefined ? opts.activity : current.run.activity,
      merged,
      discarded,
    },
  });
}

/** Append a discard the engine decided outside the post-merge gate. */
export function recordOvernightDiscard(
  item: Omit<OvernightDiscardedItem, 'at'> & { at?: string | null },
  opts: { now?: () => number } = {},
): OvernightStatus {
  const current = readOvernightStatus();
  if (!current.run) return current;
  return updateOvernightStatus({
    run: {
      ...current.run,
      discarded: [...current.run.discarded, {
        ...item,
        at: item.at ?? new Date((opts.now ?? Date.now)()).toISOString(),
      }],
    },
  });
}

/** Update the live "what is it doing right now" fields. Cheap; called per tick. */
export function recordOvernightActivity(
  patch: { iterationsDone?: number | null; repo?: string | null; activity?: string | null },
): OvernightStatus {
  const current = readOvernightStatus();
  if (!current.run) return current;
  return updateOvernightStatus({
    run: {
      ...current.run,
      iterationsDone: patch.iterationsDone !== undefined ? patch.iterationsDone : current.run.iterationsDone,
      repo: patch.repo !== undefined ? patch.repo : current.run.repo,
      activity: patch.activity !== undefined ? patch.activity : current.run.activity,
    },
  });
}

/**
 * Mark the run concluded. The record is KEPT, not cleared: the morning's first
 * question is "what happened last night", and a status that erases itself on
 * exit cannot answer it.
 */
export function concludeOvernightRun(summary: string): OvernightStatus {
  const current = readOvernightStatus();
  return updateOvernightStatus({
    armed: false,
    run: current.run ? { ...current.run, activity: summary } : null,
  });
}
