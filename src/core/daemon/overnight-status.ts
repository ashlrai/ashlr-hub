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
 * PRE-MERGE DISCARDS (V3.10, unit U5). Under a standing grant — the only
 * mode in which a resident run merges anything — every gate writes a row to
 * the authority ledger (`gate:result`, with the gate's own code and sentence),
 * and every landing and revert is a ledger row too. runDaemon folds the rows
 * each tick appended into the live run with {@link recordOvernightLedgerRows}:
 * a landing becomes `merged[]` (real merge SHA), a refusal at a gate that
 * judges the work and a revert become `discarded[]`, each with the specific
 * sentence the gate or the watch wrote. (Outside a standing grant the resident
 * loop is proposal-only and merges nothing, so the local post-merge gate's
 * repository-truth rows above remain the only source.)
 *
 * ARMING FROM THE API (U5). `POST /api/verse/overnight {action:'arm'}` records
 * a PENDING run ({@link requestOvernightRun}: armed, `startedAt: null`). The
 * resident loop — under launchd it is always running — adopts it at the top
 * of its next iteration ({@link adoptOvernightRun}) and from then on it is
 * exactly a `--until` / `--iterations` run. A pending run is honest about it:
 * no start time, no iteration count, until a daemon has actually taken it.
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
import type { LedgerEntry } from '../authority/types.js';

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
  /**
   * The standing fleet's enrolled mirror clones (~/.ashlr/fleet/mirrors/…),
   * counted APART from `repos` so the report can show what the fleet works
   * in without double-counting a repo and its mirror. null = not recorded /
   * unknown. Optional and additive: absent in a status an older build wrote.
   */
  readonly mirrors?: number | null;
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
  readonly mirrors?: number | null;
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
      ...(parsed.mirrors !== undefined ? { mirrors: countOrNull(parsed.mirrors) } : {}),
      gate: parsed.gate ?? null,
      run: parsed.run ?? null,
    };
  } catch {
    return emptyOvernightStatus();
  }
}

/** A stored count: a non-negative integer, else unknown (never defaulted to 0). */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Merge a partial update into the stored status. Never throws. */
export function updateOvernightStatus(patch: Partial<OvernightStatus>): OvernightStatus {
  const current = readOvernightStatus();
  const mirrors = patch.mirrors !== undefined ? patch.mirrors : current.mirrors;
  const next: OvernightStatus = {
    armed: patch.armed ?? current.armed,
    repos: patch.repos !== undefined ? patch.repos : current.repos,
    ...(mirrors !== undefined ? { mirrors } : {}),
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
// Prose — the sentences a person reads in the morning
// ---------------------------------------------------------------------------
//
// 3.10.0 built the post-merge discard reason by joining fragments with "; "
// and then appending ". ", so a fragment that already ended in a full stop
// printed "(exit 1).; lint …" or "… failed.. Back it out". The client now
// tidies that for display (autonomy/format.ts tidyProse), but the record is
// also read by the morning report and by anything that tails status.json, so
// the engine writes clean prose itself. The rules mirror tidyProse so the two
// never disagree. Kept inline (no import): this module is in the Tier-1
// runtime import closure, which must not grow for a string helper.
//
// ISO instants inside a passed-through sentence (a run-window refusal, a
// gate's own words) are deliberately NOT rewritten here: the reader's local
// time is the client's call, and every such row already carries its instant
// as a structured `at` field.

/** A sentence terminator, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
/** A fragment that opens a sentence of its own, rather than continuing a clause. */
const STARTS_SENTENCE = /^[\p{Lu}\p{N}"'“‘]/u;

/**
 * One fragment made printable: line breaks (an Error message can carry
 * several) folded to one space, an accidental ".." or ".;" collapsed, and any
 * dangling ",", ";" or ":" dropped — "could not be run: " with an empty error
 * would otherwise close as "run:.".
 */
function cleanFragment(text: string): string {
  return String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/(?<!\.)\.\s*;/g, ';')
    .replace(/([^.])\.\.(?!\.)/g, '$1.')
    .trim()
    .replace(/[\s,;:]+$/, '');
}

/**
 * Join reason fragments into prose without ".;" or "..":
 *   - after a fragment that is still a clause (no terminator): "; ";
 *   - after a finished sentence, before one that starts a new sentence
 *     (capital, digit or opening quote): a single space;
 *   - after a sentence closed by ONE full stop, before a lowercase clause:
 *     the stop is dropped and "; " joins them ("(exit 1); lint timed out");
 *   - after "?", "!" or an ellipsis: a space (dropping those would change
 *     what the sentence says).
 * Empty fragments are skipped. The result keeps the LAST fragment's own
 * ending; close it with {@link closeSentence} when it ends the sentence.
 */
export function joinReasonParts(parts: readonly string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = cleanFragment(raw);
    if (part.length === 0) continue;
    if (out.length === 0) out = part;
    else if (!SENTENCE_END.test(out)) out = `${out}; ${part}`;
    else if (STARTS_SENTENCE.test(part)) out = `${out} ${part}`;
    else if (/(?<!\.)\.$/.test(out)) out = `${out.slice(0, -1)}; ${part}`;
    else out = `${out} ${part}`;
  }
  return out;
}

/** End `text` with a full stop unless it already ends a sentence ("." "!" "?" "…"). */
function closeSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 || SENTENCE_END.test(trimmed) ? trimmed : `${trimmed}.`;
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
      const why = joinReasonParts(
        result.failures
          .filter((f) => f.repo === landing.repo)
          .map((f) => `${f.kind} ${f.detail}`),
      );
      const verdict = result.verdict === 'regressed'
        ? `post-merge suite failed on ${landing.repo}: ${why || 'a required check went red after the merge'}`
        : `the merge on ${landing.repo} could not be verified: ${why || 'no required verify command could be run'}`;
      discarded.push({
        id: landing.commits[0]
          ? proposalIdFromCommitSubject(landing.commits[0].subject) ?? landing.commits[0].sha.slice(0, 12)
          : landing.afterHead.slice(0, 12),
        repo: landing.repo,
        title: landing.commits[0]?.subject ?? `landing ${landing.beforeHead.slice(0, 8)}..${landing.afterHead.slice(0, 8)}`,
        at,
        // The revert command is left exactly as the gate wrote it (no period
        // appended, whitespace untouched) so it can be copied and run.
        reason: `${closeSentence(verdict)} Back it out with: ${landing.revertCommand}`,
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

// ---------------------------------------------------------------------------
// V3.10 (unit U5): arming from the API, adoption by a resident loop
// ---------------------------------------------------------------------------

/**
 * The armed run a daemon has not adopted yet (`armed`, `startedAt: null`),
 * or null.
 */
export function pendingOvernightRun(status: OvernightStatus = readOvernightStatus()): OvernightRun | null {
  return status.armed && status.run !== null && status.run.startedAt === null && status.run.stopRule !== null
    ? status.run
    : null;
}

/** True while an armed run has been adopted and has not concluded. */
export function overnightRunInProgress(status: OvernightStatus = readOvernightStatus()): boolean {
  return status.armed && status.run !== null && status.run.startedAt !== null;
}

/**
 * Arm the NEXT run from the API. It stays pending until a daemon adopts it:
 * no start time and no iteration count are claimed before one has.
 */
export function requestOvernightRun(
  stopRule: RunWindowStopRule,
  opts: { repos?: number | null; mirrors?: number | null; gate?: OvernightGate | null; runId?: string } = {},
): OvernightStatus {
  return updateOvernightStatus({
    armed: true,
    repos: opts.repos ?? null,
    // Recorded per arm (an arm without a count clears a stale one to unknown).
    mirrors: opts.mirrors ?? null,
    gate: opts.gate ?? null,
    run: {
      runId: opts.runId ?? randomUUID(),
      startedAt: null,
      stopRule,
      iterationsDone: null,
      repo: null,
      activity: 'armed; waiting for the daemon to take it (it does on its next cycle)',
      merged: [],
      discarded: [],
    },
  });
}

/**
 * A resident loop took the pending run: from now it has a start time and
 * counts iterations. Returns null when there was no pending run.
 */
export function adoptOvernightRun(opts: { now?: () => number; pid?: number } = {}): OvernightStatus | null {
  const current = readOvernightStatus();
  const pending = pendingOvernightRun(current);
  if (!pending) return null;
  const nowMs = (opts.now ?? Date.now)();
  return updateOvernightStatus({
    run: {
      ...pending,
      startedAt: new Date(nowMs).toISOString(),
      iterationsDone: 0,
      activity: `taken by the daemon${typeof opts.pid === 'number' ? ` (pid ${opts.pid})` : ''}; waiting for the first tick`,
    },
  });
}

/** Refuse a pending run a daemon could not adopt, saying why; the record is kept. */
export function refuseOvernightRun(reason: string): OvernightStatus {
  const current = readOvernightStatus();
  return updateOvernightStatus({
    armed: false,
    run: current.run ? { ...current.run, activity: `not started: ${reason}` } : null,
  });
}

/** Gates whose refusal throws the work away (the same set backpressure counts). */
const DISCARDING_GATES = new Set(['G1b', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);

/**
 * Fold authority-ledger rows from a standing tick into the live run:
 * `merge:landed` → merged[] (the merge SHA), a refusal at a work-judging gate
 * and `revert:landed` → discarded[] with the gate's / watch's own sentence.
 * Idempotent per row (a row already folded is skipped). No-op without a run
 * in progress.
 */
export function recordOvernightLedgerRows(
  rows: readonly LedgerEntry[],
  opts: { titleOf?: (proposalId: string) => string | null; iterationsDone?: number } = {},
): OvernightStatus {
  const current = readOvernightStatus();
  if (!overnightRunInProgress(current) || !current.run) return current;
  const merged: OvernightMergedItem[] = [...current.run.merged];
  const discarded: OvernightDiscardedItem[] = [...current.run.discarded];
  const seenMerged = new Set(merged.map((m) => `${m.repo}|${m.id}|${m.commit ?? ''}`));
  const seenDiscarded = new Set(discarded.map((d) => `${d.repo}|${d.id}|${d.reason}`));
  const title = (proposalId: string | null, fallback: string): string => {
    if (!proposalId) return fallback;
    try {
      return opts.titleOf?.(proposalId) ?? fallback;
    } catch {
      return fallback;
    }
  };
  let lastRepo: string | null = null;
  for (const row of rows) {
    if (row.kind === 'merge:landed') {
      const rec = row.data;
      const id = rec.proposalId ?? rec.id;
      const key = `${rec.repo}|${id}|${rec.mergeSha}`;
      if (seenMerged.has(key)) continue;
      seenMerged.add(key);
      merged.push({ id, repo: rec.repo, title: title(rec.proposalId, `PR #${rec.prNumber}`), at: rec.landedAt, commit: rec.mergeSha });
      lastRepo = rec.repo;
    } else if (row.kind === 'gate:result') {
      const rec = row.data;
      if (rec.verdict !== 'refuse' || !DISCARDING_GATES.has(rec.gate)) continue;
      const reason = `${rec.gate} refused it: ${rec.reason}`;
      const key = `${rec.repo}|${rec.proposalId}|${reason}`;
      if (seenDiscarded.has(key)) continue;
      seenDiscarded.add(key);
      discarded.push({ id: rec.proposalId, repo: rec.repo, title: title(rec.proposalId, rec.proposalId), at: rec.at, reason });
      lastRepo = rec.repo;
    } else if (row.kind === 'revert:landed') {
      const rec = row.data;
      const id = rec.revertsLandingId ?? rec.id;
      const reason = `reverted after a red post-merge check (revert PR #${rec.prNumber}, ${rec.mergeSha.slice(0, 12)})`;
      const key = `${rec.repo}|${id}|${reason}`;
      if (seenDiscarded.has(key)) continue;
      seenDiscarded.add(key);
      discarded.push({ id, repo: rec.repo, title: title(null, `landing ${id}`), at: rec.landedAt, reason });
      lastRepo = rec.repo;
    }
  }
  return updateOvernightStatus({
    run: {
      ...current.run,
      iterationsDone: opts.iterationsDone ?? current.run.iterationsDone,
      repo: lastRepo ?? current.run.repo,
      merged,
      discarded,
    },
  });
}
