/**
 * Cloud task evidence timeline (3.13) — READ-ONLY.
 *
 * Joins what is already stored about one cloud task into the ordered chain
 * docs/VERSE-COMPETITIVE-ACCEPTANCE.md asks for (objective → worker → diff →
 * checks that actually ran → PR → merge → release → health → cost). Nothing
 * here writes, fetches, or talks to GitHub; every source is local:
 *
 *   cloud task record      store.ts (prompt, origin, backlog item, seat,
 *                          session URL, PR + delivery pin, report, estimate)
 *   fleet merge record     fleet/fleet-merge-state.ts (diff binding, checks
 *                          memo, gate memos, landing) — matched by repo + PR
 *                          number, the task branch, or the task id
 *   authority ledger       gate:result / merge:landed / post-merge:result
 *                          rows (hash-chained; a broken chain is 'unknown')
 *   post-merge watch       fleet/post-merge-watch.ts verdicts
 *   evidence pack          autonomy/evidence-pack.ts (the producing model)
 *   local git              the fleet mirror, else an enrolled checkout whose
 *                          origin is the task's repo: the merge commit (when
 *                          no landing recorded it) and `git tag --contains`
 *
 * EPISTEMICS (the reason this file exists): the session's report is a CLAIM
 * and is always `verified: false`; the cost is an ESTIMATE fixed at launch
 * and is always `verified: false`; the model and account are 'unknown'
 * unless a record names them. Nothing is inferred from the report.
 *
 * BOUNDED: every source has its own time budget and an unreadable or slow
 * source degrades its steps to 'unknown' — the route always answers. Git
 * answers and the merge-record index are cached; a whole timeline is cached
 * briefly per task revision so a re-opened panel costs nothing.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readLedger } from '../authority/ledger.js';
import { readAutonomyEvidencePack } from '../autonomy/evidence-pack.js';
import { listFleetMergeStateKeys, readFleetMergeState, type FleetMergeStateV1 } from '../fleet/fleet-merge-state.js';
import type { GateResult, LandingRecord, PostMergeResult } from '../fleet/fleet-types.js';
import { GATE_ORDER } from '../fleet/fleet-types.js';
import { mirrorPathFor } from '../fleet/mirrors.js';
import { listPostMergeWatches, type PostMergeWatchView } from '../fleet/post-merge-watch.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { discoverProjects } from '../verse/projects.js';
import { readCloudTask } from './store.js';
import {
  CLOUD_TIMELINE_SCHEMA_VERSION,
  type CloudTimelineResponse,
  type TimelineLink,
  type TimelineStep,
} from './timeline-types.js';
import { CLOUD_BALANCE_URL, CLOUD_TASK_ID_PATTERN, type CloudTaskV1 } from './types.js';

// ---------------------------------------------------------------------------
// Sources — what the pure builder is given
// ---------------------------------------------------------------------------

export type MergeRecordSource =
  | { state: 'ok'; record: FleetMergeStateV1 }
  | { state: 'missing' }
  | { state: 'unknown'; reason: string };

export type LedgerSource =
  | {
    state: 'ok';
    /** `ok` = chain verified; `empty` = no ledger yet. */
    chain: 'ok' | 'empty';
    gates: Array<GateResult & { rowAt: string }>;
    landing: LandingRecord | null;
    postMerge: PostMergeResult | null;
  }
  | { state: 'unknown'; reason: string };

export type WatchSource =
  | { state: 'ok'; view: PostMergeWatchView | null }
  | { state: 'unknown'; reason: string };

export interface MergeCommit {
  sha: string;
  /** `landing` = our host merge recorded it; `git` = found by message in local git. */
  basis: 'landing' | 'git';
}

export type ReleaseSource =
  | { state: 'contained'; latestTag: string; firstTag: string | null }
  | { state: 'not-contained'; latestTag: string }
  | { state: 'no-tags' }
  | { state: 'unknown'; reason: string };

export interface TimelineSources {
  task: CloudTaskV1;
  merge: MergeRecordSource;
  ledger: LedgerSource;
  watch: WatchSource;
  /** The producing model from the evidence pack; null = not recorded. */
  model: string | null;
  mergeCommit: MergeCommit | null;
  /** Null when there is no merge commit to look for. */
  release: ReleaseSource | null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const short = (sha: string): string => sha.slice(0, 7);

function isoOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function httpsLink(href: string | null | undefined, host: 'claude.ai' | 'github.com', label: string): TimelineLink | undefined {
  if (typeof href !== 'string' || href.length > 2_048) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname === host ? { href: url.toString(), label } : undefined;
  } catch {
    return undefined;
  }
}

function commitLink(repo: string, sha: string): TimelineLink | undefined {
  return httpsLink(`https://github.com/${repo}/commit/${sha}`, 'github.com', `Commit ${short(sha)}`);
}

function tagLink(repo: string, tag: string): TimelineLink | undefined {
  return httpsLink(`https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`, 'github.com', tag);
}

const ORIGIN_WORD: Record<CloudTaskV1['origin'], string> = {
  chat: 'a chat’s “Run in cloud”',
  operator: 'New cloud task',
  leader: 'the Leader',
  'self-improve': 'self-improvement',
  cli: 'the ashlr CLI',
};

function prNumberOf(task: CloudTaskV1): number | null {
  return task.pr?.number ?? task.deliveryPin?.number ?? null;
}

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------
// The pure builder
// ---------------------------------------------------------------------------

type Step = TimelineStep;

function step(kind: Step['kind'], fields: Omit<Step, 'kind'>): Step {
  const out: Step = { kind, at: fields.at, title: fields.title, detail: fields.detail, source: fields.source, verified: fields.verified, reached: fields.reached };
  if (fields.link) out.link = fields.link;
  return out;
}

function objectiveStep(task: CloudTaskV1): Step {
  const parts = [`From ${ORIGIN_WORD[task.origin]}, requested by ${task.requestedBy}.`];
  if (task.backlogItemId) parts.push(`Backlog item ${clip(task.backlogItemId, 80)}.`);
  parts.push(`${task.repo} from ${clip(task.baseBranch, 120)}.`);
  const prompt = clip(task.prompt, 600);
  if (prompt) parts.push(`Task: ${prompt}`);
  return step('objective', {
    at: isoOrNull(task.createdAt),
    title: clip(task.title, 120) || 'Untitled cloud task',
    detail: parts.join(' '),
    source: 'cloud task record',
    verified: true,
    reached: true,
  });
}

function launchStep(task: CloudTaskV1): Step {
  const session = httpsLink(task.sessionUrl, 'claude.ai', 'Open session');
  if (task.state === 'failed') {
    return step('launch', {
      at: isoOrNull(task.launchedAt) ?? isoOrNull(task.updatedAt),
      title: 'Launch failed',
      detail: clip(task.stateReason ?? `The cloud session was not started (${task.failure ?? 'unknown'}).`, 400),
      source: 'cloud task record',
      verified: true,
      reached: true,
    });
  }
  if (task.sessionId || session) {
    return step('launch', {
      at: isoOrNull(task.launchedAt),
      title: `Cloud session started on seat ${clip(task.seat, 40)}`,
      detail: `Branch ${task.branch}.`,
      source: 'cloud task record (CLI output at launch)',
      verified: true,
      reached: true,
      ...(session ? { link: session } : {}),
    });
  }
  return step('launch', {
    at: null,
    title: task.state === 'queued' ? 'Waiting for a launch slot' : task.state === 'launching' ? 'Launching' : 'No session recorded',
    detail: task.state === 'queued' || task.state === 'launching' ? '' : 'The task record has no session id.',
    source: 'cloud task record',
    verified: task.state === 'queued' || task.state === 'launching' ? true : 'unknown',
    reached: false,
  });
}

function workerStep(task: CloudTaskV1, model: string | null): Step {
  const launched = task.sessionId !== null || task.sessionUrl !== null;
  const modelText = model ? `Model: ${clip(model, 80)} (evidence pack).` : 'Model: unknown — not recorded.';
  return step('worker', {
    at: isoOrNull(task.launchedAt),
    title: `Claude Code cloud session · seat ${clip(task.seat, 40)}`,
    detail: `${modelText} Account: unknown — the claude.ai account behind the seat is not recorded with the task.`,
    source: model ? 'evidence pack' : 'not recorded',
    verified: model ? true : 'unknown',
    reached: launched,
  });
}

function reportStep(task: CloudTaskV1): Step {
  const report = task.report;
  if (!report) {
    const hasPr = task.pr !== null;
    return step('report', {
      at: null,
      title: hasPr ? 'No session report' : 'No session report yet',
      detail: hasPr ? 'The pull request carries no ashlr-cloud-report block.' : '',
      source: 'pull request body',
      verified: 'unknown',
      reached: hasPr,
    });
  }
  const parts = [clip(report.summary, 500)];
  if (report.testsRun.length > 0) parts.push(`Tests it says it ran: ${clip(report.testsRun.slice(0, 8).join('; '), 300)}.`);
  else parts.push('It names no tests.');
  if (report.risks.length > 0) parts.push(`Risks it names: ${clip(report.risks.slice(0, 5).join('; '), 300)}.`);
  return step('report', {
    at: null,
    title: `Session reports “${report.status}” (unverified)`,
    detail: parts.filter(Boolean).join(' '),
    source: 'session report (a claim, not evidence)',
    verified: false,
    reached: true,
  });
}

function prStep(task: CloudTaskV1, merge: MergeRecordSource): Step {
  const openedAt = merge.state === 'ok' ? isoOrNull(merge.record.pr?.openedAt) : null;
  if (task.pr) {
    const link = httpsLink(task.pr.url, 'github.com', `PR #${task.pr.number}`);
    const pinned = task.deliveryPin ? task.deliveryPin.number === task.pr.number : null;
    const stateWord = task.pr.state === 'open' ? (task.pr.draft ? 'open (draft)' : 'open') : task.pr.state;
    return step('pr', {
      at: openedAt,
      title: `PR #${task.pr.number} ${stateWord}`,
      detail: `${clip(task.pr.title, 200)}. Repository, branch and base checked against the task by the tracker${pinned === false ? '; it differs from the PR first pinned for this task' : ''}.`,
      source: 'GitHub, read by the cloud tracker',
      verified: pinned === false ? 'unknown' : true,
      reached: true,
      ...(link ? { link } : {}),
    });
  }
  if (task.deliveryPin) {
    const link = httpsLink(task.deliveryPin.url, 'github.com', `PR #${task.deliveryPin.number}`);
    return step('pr', {
      at: openedAt,
      title: `PR #${task.deliveryPin.number} (not currently verified)`,
      detail: 'This PR was verified for the task earlier; the latest GitHub lookup could not confirm it.',
      source: 'cloud task delivery pin',
      verified: 'unknown',
      reached: true,
      ...(link ? { link } : {}),
    });
  }
  return step('pr', {
    at: null,
    title: 'No pull request yet',
    detail: task.state === 'expired' ? 'No PR appeared within the watch window; the session link still works.' : '',
    source: 'GitHub, read by the cloud tracker',
    verified: 'unknown',
    reached: false,
  });
}

function diffStep(task: CloudTaskV1, merge: MergeRecordSource): Step {
  const record = merge.state === 'ok' ? merge.record : null;
  const landing = record?.landing ?? null;
  const files = landing?.files ?? record?.files ?? null;
  const added = landing?.linesAdded ?? record?.linesAdded ?? null;
  const deleted = landing?.linesDeleted ?? record?.linesDeleted ?? null;
  if (files !== null && added !== null && deleted !== null) {
    const risk = landing?.risk ?? record?.risk ?? null;
    const tree = record?.treeSha ? ` Tree ${short(record.treeSha)} verified on base ${record.baseSha ? short(record.baseSha) : 'unknown'}.` : '';
    return step('diff', {
      at: null,
      title: `${files} ${files === 1 ? 'file' : 'files'}, +${added} −${deleted}`,
      detail: `${risk ? `Risk ${risk}.` : ''}${tree}`.trim(),
      source: 'fleet merge record',
      verified: true,
      reached: true,
    });
  }
  const claimed = task.report?.filesChanged;
  if (typeof claimed === 'number') {
    return step('diff', {
      at: null,
      title: `${claimed} ${claimed === 1 ? 'file' : 'files'} changed (claimed)`,
      detail: 'Only the session report gives a size; no merge record measured the diff.',
      source: 'session report (a claim, not evidence)',
      verified: false,
      reached: true,
    });
  }
  return step('diff', {
    at: null,
    title: 'Diff not measured',
    detail: merge.state === 'unknown' ? `The fleet merge record could not be read: ${clip(merge.reason, 200)}` : 'No merge record measured this PR’s diff.',
    source: 'fleet merge record',
    verified: 'unknown',
    reached: task.pr !== null,
  });
}

function checksStep(task: CloudTaskV1, merge: MergeRecordSource): Step {
  const checks = merge.state === 'ok' ? merge.record.pr?.checks ?? null : null;
  if (checks) {
    const title = checks.state === 'green' ? 'Required checks passed'
      : checks.state === 'red' ? 'Required checks failed'
        : checks.state === 'pending' ? 'Required checks running'
          : 'No required checks on this repo';
    return step('checks', {
      at: isoOrNull(checks.at),
      title,
      detail: clip(checks.detail, 300),
      source: 'fleet merge record (GitHub required checks)',
      verified: true,
      reached: true,
    });
  }
  const claimed = task.report?.testsRun.length ?? 0;
  return step('checks', {
    at: null,
    title: 'No check run recorded',
    detail: claimed > 0
      ? `Verse recorded no check run for this PR. The ${claimed} ${claimed === 1 ? 'test' : 'tests'} in the session report are its own claim.`
      : 'Verse recorded no check run for this PR.',
    source: merge.state === 'unknown' ? 'fleet merge record (unreadable)' : 'fleet merge record',
    verified: 'unknown',
    reached: task.pr !== null,
  });
}

function gatesStep(task: CloudTaskV1, merge: MergeRecordSource, ledger: LedgerSource): Step {
  if (ledger.state === 'ok' && ledger.gates.length > 0) {
    const latest = new Map<string, GateResult & { rowAt: string }>();
    for (const row of ledger.gates) latest.set(row.gate, row); // oldest first ⇒ last wins
    const ordered = GATE_ORDER.map((g) => latest.get(g)).filter((r): r is GateResult & { rowAt: string } => r !== undefined);
    const stop = ordered.find((r) => r.verdict !== 'pass') ?? null;
    const summary = ordered.map((r) => `${r.gate} ${r.verdict}`).join(' · ');
    const at = ordered.reduce<string | null>((max, r) => (max === null || r.rowAt > max ? r.rowAt : max), null);
    return step('gates', {
      at: isoOrNull(at),
      title: stop ? `Merge gates: ${stop.gate} ${stop.verdict}` : `Merge gates passed (${ordered.length})`,
      detail: `${summary}.${stop ? ` ${clip(stop.reason, 300)}` : ''}`,
      source: 'authority ledger (hash-chained)',
      verified: true,
      reached: true,
    });
  }
  const memos = merge.state === 'ok' ? merge.record.gates : null;
  const memoRows = memos ? GATE_ORDER.map((g) => (memos[g] ? { gate: g, ...memos[g]! } : null)).filter((m): m is NonNullable<typeof m> => m !== null) : [];
  if (memoRows.length > 0) {
    const stop = memoRows.find((m) => m.verdict !== 'pass') ?? null;
    const at = memoRows.reduce<string | null>((max, m) => (max === null || m.at > max ? m.at : max), null);
    return step('gates', {
      at: isoOrNull(at),
      title: stop ? `Merge gates: ${stop.gate} ${stop.verdict}` : `Merge gates passed (${memoRows.length})`,
      detail: `${memoRows.map((m) => `${m.gate} ${m.verdict}`).join(' · ')}.${ledger.state === 'unknown' ? ` The ledger rows could not be read: ${clip(ledger.reason, 200)}` : ''}`,
      source: 'fleet merge record (gate memos)',
      verified: true,
      reached: true,
    });
  }
  return step('gates', {
    at: null,
    title: 'No merge-gate evaluation recorded',
    detail: ledger.state === 'unknown'
      ? `The authority ledger could not be read: ${clip(ledger.reason, 200)}`
      : 'Neither the ledger nor a merge record shows the gates judging this PR; it is merged by the gates or by Mason.',
    source: ledger.state === 'unknown' ? 'authority ledger (unreadable)' : 'authority ledger',
    verified: 'unknown',
    reached: task.pr !== null,
  });
}

function landingOf(sources: TimelineSources): LandingRecord | null {
  if (sources.merge.state === 'ok' && sources.merge.record.landing) return sources.merge.record.landing;
  return sources.ledger.state === 'ok' ? sources.ledger.landing : null;
}

function mergeStep(sources: TimelineSources): Step {
  const { task, mergeCommit } = sources;
  const landing = landingOf(sources);
  if (landing) {
    return step('merge', {
      at: isoOrNull(landing.landedAt),
      title: `Merged as ${short(landing.mergeSha)}`,
      detail: `Landed on ${clip(landing.baseBranch, 80)} by the fleet host merge (grant ${clip(landing.grantId, 40)}), pinned to head ${short(landing.headSha)}.`,
      source: 'fleet landing record',
      verified: true,
      reached: true,
      ...(commitLink(task.repo, landing.mergeSha) ? { link: commitLink(task.repo, landing.mergeSha)! } : {}),
    });
  }
  if (task.state === 'merged' || task.pr?.state === 'merged') {
    const found = mergeCommit?.basis === 'git' ? mergeCommit.sha : null;
    return step('merge', {
      at: null,
      title: found ? `Merged as ${short(found)}` : 'Merged on GitHub',
      detail: found
        ? 'GitHub reports the PR merged; the commit was found in local git by its merge message (no fleet landing recorded it).'
        : 'GitHub reports the PR merged. No landing record or local commit names the merge commit.',
      source: found ? 'GitHub (cloud tracker) + local git' : 'GitHub, read by the cloud tracker',
      verified: true,
      reached: true,
      ...(found && commitLink(task.repo, found) ? { link: commitLink(task.repo, found)! } : {}),
    });
  }
  if (task.state === 'pr-open' && task.supersededBy) {
    // 3.13: the cloud PR was closed in favour of the fleet App PR (fleet/cloud-intake.ts).
    return step('merge', {
      at: null,
      title: `Superseded by fleet PR #${task.supersededBy.number}`,
      detail: 'The fleet rebuilt this change through the standing merge gates; it lands from that PR, never from the cloud PR.',
      source: 'cloud task record',
      verified: true,
      reached: false,
    });
  }
  if (task.state === 'closed' || task.pr?.state === 'closed') {
    return step('merge', {
      at: null,
      title: 'Closed without merging',
      detail: clip(task.stateReason ?? '', 300),
      source: 'cloud task record',
      verified: true,
      reached: true,
    });
  }
  return step('merge', {
    at: null,
    title: 'Not merged',
    detail: task.state === 'pr-open' ? 'The PR is open; nothing merges on its own.' : '',
    source: 'cloud task record',
    verified: task.state === 'pr-open' ? true : 'unknown',
    reached: false,
  });
}

function releaseStep(sources: TimelineSources): Step {
  const { task, mergeCommit, release } = sources;
  if (!mergeCommit || !release) {
    return step('release', {
      at: null,
      title: 'Release unknown',
      detail: task.state === 'merged' ? 'Without a merge commit there is nothing to look for in the release tags.' : 'Not merged, so not released.',
      source: 'local git tags',
      verified: 'unknown',
      reached: false,
    });
  }
  switch (release.state) {
    case 'contained':
      return step('release', {
        at: null,
        title: `In the latest release, ${release.latestTag}`,
        detail: release.firstTag && release.firstTag !== release.latestTag ? `First released in ${release.firstTag}.` : `${short(mergeCommit.sha)} is contained in ${release.latestTag}.`,
        source: 'local git tags (git tag --contains)',
        verified: true,
        reached: true,
        ...(tagLink(task.repo, release.latestTag) ? { link: tagLink(task.repo, release.latestTag)! } : {}),
      });
    case 'not-contained':
      return step('release', {
        at: null,
        title: `Not in the latest release (${release.latestTag}) yet`,
        detail: `${short(mergeCommit.sha)} is not contained in ${release.latestTag}.`,
        source: 'local git tags (git tag --contains)',
        verified: true,
        reached: false,
        ...(tagLink(task.repo, release.latestTag) ? { link: tagLink(task.repo, release.latestTag)! } : {}),
      });
    case 'no-tags':
      return step('release', {
        at: null,
        title: 'No release tags',
        detail: 'The local checkout has no release-looking tags.',
        source: 'local git tags',
        verified: 'unknown',
        reached: false,
      });
    default:
      return step('release', {
        at: null,
        title: 'Release unknown',
        detail: clip(release.reason, 300),
        source: 'local git tags',
        verified: 'unknown',
        reached: false,
      });
  }
}

function healthStep(sources: TimelineSources): Step {
  const { watch, ledger, task } = sources;
  const view = watch.state === 'ok' ? watch.view : null;
  if (view) {
    if (view.verdict) {
      return step('health', {
        at: isoOrNull(view.checkedAt),
        title: view.verdict === 'green' ? 'Healthy after merge' : 'Red after merge',
        detail: `CI ${view.ci ?? 'unknown'}, suite ${view.suite}.${view.detail ? ` ${clip(view.detail, 300)}` : ''}`,
        source: 'post-merge watch',
        verified: true,
        reached: true,
      });
    }
    return step('health', {
      at: isoOrNull(view.checkedAt),
      title: view.phase === 'reverting' ? 'Reverting after a red watch' : 'Post-merge watch in progress',
      detail: `Watching until ${isoOrNull(view.watchUntil) ?? 'unknown'}. CI ${view.ci ?? 'unknown'}, suite ${view.suite}.`,
      source: 'post-merge watch',
      verified: true,
      reached: true,
    });
  }
  const row = ledger.state === 'ok' ? ledger.postMerge : null;
  if (row) {
    return step('health', {
      at: isoOrNull(row.checkedAt),
      title: row.verdict === 'green' ? 'Healthy after merge' : 'Red after merge',
      detail: `CI ${row.ci}, suite ${row.suite}. ${clip(row.detail, 300)}`,
      source: 'authority ledger (post-merge result)',
      verified: true,
      reached: true,
    });
  }
  const merged = task.state === 'merged' || landingOf(sources) !== null;
  return step('health', {
    at: null,
    title: merged ? 'No post-merge watch recorded' : 'Health unknown',
    detail: watch.state === 'unknown'
      ? `The post-merge watch store could not be read: ${clip(watch.reason, 200)}`
      : landingOf(sources) !== null
        ? 'The fleet landed this merge, but no post-merge verdict is recorded yet.'
        : merged ? 'Only fleet landings are watched after merge; this merge was not.' : 'Not merged, so nothing to watch.',
    source: 'post-merge watch',
    verified: 'unknown',
    reached: false,
  });
}

function costStep(task: CloudTaskV1): Step {
  const amount = Number.isInteger(task.estimatedCostUsd) ? String(task.estimatedCostUsd) : task.estimatedCostUsd.toFixed(2);
  return step('cost', {
    at: isoOrNull(task.launchedAt) ?? isoOrNull(task.createdAt),
    title: `$${amount} estimated`,
    detail: 'Fixed at launch from the per-session estimate. Claude does not expose the credit balance, so the real spend is only on claude.ai.',
    source: 'cloud budget estimate',
    verified: false,
    reached: true,
    link: { href: CLOUD_BALANCE_URL, label: 'Check usage on claude.ai' },
  });
}

/** PURE: the ordered evidence chain for one task from already-gathered sources. */
export function buildCloudTimeline(sources: TimelineSources, now: Date = new Date()): CloudTimelineResponse {
  const { task } = sources;
  const steps: TimelineStep[] = [
    objectiveStep(task),
    launchStep(task),
    workerStep(task, sources.model),
    reportStep(task),
    prStep(task, sources.merge),
    diffStep(task, sources.merge),
    checksStep(task, sources.merge),
    gatesStep(task, sources.merge, sources.ledger),
    mergeStep(sources),
    releaseStep(sources),
    healthStep(sources),
    costStep(task),
  ];
  return {
    v: CLOUD_TIMELINE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    taskId: task.id,
    repo: task.repo,
    title: clip(task.title, 120) || 'Untitled cloud task',
    state: task.state,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Gathering — bounded, cached, every failure degrades to 'unknown'
// ---------------------------------------------------------------------------

const LEDGER_BUDGET_MS = 2_500;
const GIT_TIMEOUT_MS = 2_500;
/** Everything git-shaped for one timeline together (finding a checkout, the merge commit, the tags). */
const GIT_TOTAL_BUDGET_MS = 5_000;
const GIT_MAX_STDOUT = 256 * 1024;
const MERGE_INDEX_TTL_MS = 30_000;
const MERGE_SCAN_MAX = 1_024;
const GIT_CACHE_TTL_MS = 5 * 60_000;
const CHECKOUT_CACHE_TTL_MS = 5 * 60_000;
const TIMELINE_CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 256;
const MAX_PROJECTS_PROBED = 40;
const SHA_RE = /^[0-9a-f]{40}$/;
/** A release-looking tag: `v3.12.0`, `3.12.0`, `v3.12.0-rc.1`. */
const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

class TimedOut extends Error {}

async function withBudget<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimedOut(`took longer than ${ms} ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof TimedOut) return `the read ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** A tiny TTL map that never grows past CACHE_MAX_ENTRIES (oldest insert evicted). */
class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string, now: number): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V, now: number): void {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > CACHE_MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

export interface TimelineDeps {
  now?: () => Date;
  readTask?: (id: string) => CloudTaskV1 | null;
  /** Every merge record key (null = directory unreadable). */
  listMergeKeys?: () => string[] | null;
  readMergeRecord?: typeof readFleetMergeState;
  readLedger?: typeof readLedger;
  listWatches?: () => PostMergeWatchView[];
  readEvidenceModel?: (proposalId: string) => string | null;
  git?: GitRunner;
  /** A local clone of `repo` with its tags (fleet mirror, else an enrolled checkout); null = none. */
  checkoutFor?: (repo: string) => Promise<string | null>;
  /** Time budget for the ledger read (default 2.5 s). */
  ledgerBudgetMs?: number;
  /** Time budget for every git step together (default 5 s). */
  gitBudgetMs?: number;
}

interface MergeIndexEntry {
  key: string;
  repo: string;
  prNumber: number | null;
  landingPrNumber: number | null;
  branch: string | null;
  proposalId: string | null;
}

const mergeIndexCache = new TtlCache<{ entries: MergeIndexEntry[]; complete: boolean } | null>(MERGE_INDEX_TTL_MS);
const gitCache = new TtlCache<unknown>(GIT_CACHE_TTL_MS);
const checkoutCache = new TtlCache<string | null>(CHECKOUT_CACHE_TTL_MS);
const timelineCache = new TtlCache<CloudTimelineResponse>(TIMELINE_CACHE_TTL_MS);
const inFlight = new Map<string, Promise<CloudTimelineResponse | null>>();

/** Test hook: drop every cache (the merge index, git answers, checkouts, whole timelines). */
export function clearCloudTimelineCaches(): void {
  mergeIndexCache.clear();
  gitCache.clear();
  checkoutCache.clear();
  timelineCache.clear();
  inFlight.clear();
}

function mergeIndex(deps: Required<Pick<TimelineDeps, 'listMergeKeys' | 'readMergeRecord'>>, now: number): { entries: MergeIndexEntry[]; complete: boolean } | null {
  const cached = mergeIndexCache.get('all', now);
  if (cached !== undefined) return cached;
  const keys = deps.listMergeKeys();
  if (keys === null) {
    mergeIndexCache.set('all', null, now);
    return null;
  }
  const entries: MergeIndexEntry[] = [];
  for (const key of keys.slice(0, MERGE_SCAN_MAX)) {
    const read = deps.readMergeRecord(key);
    if (read.state !== 'ok') continue;
    const r = read.record;
    entries.push({
      key,
      repo: r.repo,
      prNumber: r.pr?.number ?? null,
      landingPrNumber: r.landing?.prNumber ?? null,
      branch: r.pr?.branch ?? null,
      proposalId: r.proposalId,
    });
  }
  const index = { entries, complete: keys.length <= MERGE_SCAN_MAX };
  mergeIndexCache.set('all', index, now);
  return index;
}

function findMergeRecord(task: CloudTaskV1, deps: Required<Pick<TimelineDeps, 'listMergeKeys' | 'readMergeRecord'>>, now: number): MergeRecordSource {
  try {
    const index = mergeIndex(deps, now);
    if (!index) return { state: 'unknown', reason: 'the fleet merge records could not be listed' };
    const pr = prNumberOf(task);
    const hit = index.entries.find((e) => sameRepo(e.repo, task.repo) && (
      (pr !== null && (e.prNumber === pr || e.landingPrNumber === pr))
      || e.branch === task.branch
      || e.proposalId === task.id
    ));
    if (!hit) return index.complete ? { state: 'missing' } : { state: 'unknown', reason: `more than ${MERGE_SCAN_MAX} merge records; not all were searched` };
    const read = deps.readMergeRecord(hit.key);
    if (read.state === 'ok') return { state: 'ok', record: read.record };
    if (read.state === 'missing') return { state: 'missing' };
    return { state: 'unknown', reason: read.reason };
  } catch (error) {
    return { state: 'unknown', reason: reasonOf(error) };
  }
}

async function gatherLedger(task: CloudTaskV1, merge: MergeRecordSource, read: typeof readLedger, budgetMs: number): Promise<LedgerSource> {
  try {
    const result = await withBudget(budgetMs, () => read({
      kinds: ['gate:result', 'merge:landed', 'post-merge:result'],
      sinceAt: task.createdAt,
    }));
    if (result.chain === 'broken') {
      return { state: 'unknown', reason: `the ledger chain is broken${result.brokenAtSeq !== null ? ` at entry ${result.brokenAtSeq}` : ''}, so its rows are not trusted` };
    }
    const proposals = new Set<string>([task.id]);
    if (merge.state === 'ok' && merge.record.proposalId) proposals.add(merge.record.proposalId);
    const pr = prNumberOf(task);
    const gates: Array<GateResult & { rowAt: string }> = [];
    let landing: LandingRecord | null = null;
    let postMerge: PostMergeResult | null = null;
    for (const entry of result.entries) {
      if (entry.kind === 'gate:result') {
        if (sameRepo(entry.data.repo, task.repo) && proposals.has(entry.data.proposalId)) gates.push({ ...entry.data, rowAt: entry.at });
      } else if (entry.kind === 'merge:landed') {
        if (pr !== null && sameRepo(entry.data.repo, task.repo) && entry.data.prNumber === pr) landing = entry.data;
      }
    }
    if (landing) {
      for (const entry of result.entries) {
        if (entry.kind === 'post-merge:result' && (entry.data.landingId === landing.id || entry.data.mergeSha === landing.mergeSha)) postMerge = entry.data;
      }
    }
    return { state: 'ok', chain: result.chain, gates, landing, postMerge };
  } catch (error) {
    return { state: 'unknown', reason: reasonOf(error) };
  }
}

function gatherWatch(task: CloudTaskV1, landing: LandingRecord | null, mergeSha: string | null, list: () => PostMergeWatchView[]): WatchSource {
  try {
    const pr = prNumberOf(task);
    const views = list().filter((v) => sameRepo(v.repo, task.repo) && v.kind === 'merge');
    const view = views.find((v) => (landing && v.landingId === landing.id) || (mergeSha !== null && v.mergeSha === mergeSha))
      ?? (pr !== null ? views.find((v) => v.prNumber === pr) : undefined)
      ?? null;
    return { state: 'ok', view };
  } catch (error) {
    return { state: 'unknown', reason: reasonOf(error) };
  }
}

async function gitLines(git: GitRunner, cwd: string, args: string[]): Promise<{ ok: true; lines: string[] } | { ok: false; reason: string }> {
  // `core.fsmonitor=false`: a read must never start a repo-configured helper.
  const result = await git('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: GIT_MAX_STDOUT });
  if (result.missing) return { ok: false, reason: 'git is not installed' };
  if (result.timedOut) return { ok: false, reason: 'git took too long' };
  if (result.truncated) return { ok: false, reason: 'git answered more than expected' };
  if (result.code !== 0) return { ok: false, reason: clip(result.stderr, 200) || `git exited ${result.code}` };
  return { ok: true, lines: result.stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
}

/** The merge commit by its message in local git: the task branch in a merge commit, else a squash subject ending `(#N)`. */
async function findMergeCommitInGit(git: GitRunner, cwd: string, task: CloudTaskV1, pr: number): Promise<string | null> {
  const merged = await gitLines(git, cwd, [
    'log', '--all', '-n', '1', '--format=%H', '--fixed-strings', '--all-match',
    `--grep=Merge pull request #${pr} from `, `--grep=${task.branch}`,
  ]);
  if (merged.ok && merged.lines[0] && SHA_RE.test(merged.lines[0])) return merged.lines[0];
  const squash = await gitLines(git, cwd, ['log', '--all', '-n', '5', '--format=%H%x09%s', '--fixed-strings', `--grep=(#${pr})`]);
  if (!squash.ok) return null;
  for (const line of squash.lines) {
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (SHA_RE.test(sha) && subject.endsWith(`(#${pr})`) && !/^revert\b/i.test(subject)) return sha;
  }
  return null;
}

async function releaseFor(git: GitRunner, cwd: string, sha: string): Promise<ReleaseSource> {
  const tags = await gitLines(git, cwd, ['tag', '--list', '--sort=-v:refname']);
  if (!tags.ok) return { state: 'unknown', reason: `The release tags could not be read: ${tags.reason}.` };
  const latest = tags.lines.find((t) => RELEASE_TAG_RE.test(t)) ?? null;
  if (!latest) return { state: 'no-tags' };
  const containing = await gitLines(git, cwd, ['tag', '--contains', sha, '--sort=v:refname']);
  if (!containing.ok) return { state: 'unknown', reason: `Commit ${short(sha)} is not in the local checkout (it may need a fetch).` };
  const released = containing.lines.filter((t) => RELEASE_TAG_RE.test(t));
  if (!released.includes(latest)) return { state: 'not-contained', latestTag: latest };
  return { state: 'contained', latestTag: latest, firstTag: released[0] ?? null };
}

function isGitDir(path: string): boolean {
  try {
    return existsSync(join(path, '.git')) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `owner/name` of a GitHub remote URL (https, ssh, scp-style), lowercased; null otherwise. */
export function githubNameFromRemote(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Production checkout finder: the fleet mirror, else an enrolled project whose origin is `repo`. */
export function defaultCheckoutFor(git: GitRunner): (repo: string) => Promise<string | null> {
  return async (repo) => {
    try {
      const mirror = mirrorPathFor(repo);
      if (isGitDir(mirror)) return mirror;
    } catch { /* not a valid owner/name — fall through */ }
    const want = repo.toLowerCase();
    for (const project of discoverProjects().filter((p) => p.enrolled).slice(0, MAX_PROJECTS_PROBED)) {
      if (!isGitDir(project.path)) continue;
      const origin = await gitLines(git, project.path, ['remote', 'get-url', 'origin']);
      if (origin.ok && origin.lines[0] && githubNameFromRemote(origin.lines[0]) === want) return project.path;
    }
    return null;
  };
}

async function gatherGit(
  task: CloudTaskV1,
  landing: LandingRecord | null,
  deps: { git: GitRunner; checkoutFor: (repo: string) => Promise<string | null> },
  now: number,
): Promise<{ mergeCommit: MergeCommit | null; release: ReleaseSource | null }> {
  const merged = landing !== null || task.state === 'merged' || task.pr?.state === 'merged';
  if (!merged) return { mergeCommit: null, release: null };
  let checkout: string | null | undefined = checkoutCache.get(task.repo.toLowerCase(), now);
  try {
    if (checkout === undefined) {
      checkout = await deps.checkoutFor(task.repo);
      checkoutCache.set(task.repo.toLowerCase(), checkout, now);
    }
  } catch {
    checkout = null;
  }
  let mergeCommit: MergeCommit | null = landing && SHA_RE.test(landing.mergeSha) ? { sha: landing.mergeSha, basis: 'landing' } : null;
  if (!checkout) {
    return { mergeCommit, release: mergeCommit ? { state: 'unknown', reason: `No local mirror or checkout of ${task.repo} to read release tags from.` } : null };
  }
  const pr = prNumberOf(task);
  if (!mergeCommit && pr !== null) {
    const key = `merge\0${checkout}\0${task.id}\0${pr}`;
    let sha = gitCache.get(key, now) as string | null | undefined;
    if (sha === undefined) {
      sha = await findMergeCommitInGit(deps.git, checkout, task, pr).catch(() => null);
      // Only a hit is cached: a miss may just mean the checkout has not fetched the merge yet.
      if (sha) gitCache.set(key, sha, now);
    }
    if (sha) mergeCommit = { sha, basis: 'git' };
  }
  if (!mergeCommit) return { mergeCommit: null, release: null };
  const releaseKey = `release\0${checkout}\0${mergeCommit.sha}`;
  let release = gitCache.get(releaseKey, now) as ReleaseSource | undefined;
  if (release === undefined) {
    release = await releaseFor(deps.git, checkout, mergeCommit.sha).catch((error: unknown): ReleaseSource => ({ state: 'unknown', reason: reasonOf(error) }));
    // Only settled answers are cached; an unknown is retried next time.
    if (release.state !== 'unknown') gitCache.set(releaseKey, release, now);
  }
  return { mergeCommit, release };
}

function evidenceModel(proposalId: string): string | null {
  const pack = readAutonomyEvidencePack(proposalId);
  const model = pack?.producer.engineModel;
  return typeof model === 'string' && model.trim() ? model : null;
}

/** Gather every source for one task. Never throws; a failing source becomes 'unknown'. */
export async function gatherTimelineSources(task: CloudTaskV1, deps: TimelineDeps = {}): Promise<TimelineSources> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const git = deps.git ?? defaultGitRunner;
  const merge = findMergeRecord(task, {
    listMergeKeys: deps.listMergeKeys ?? listFleetMergeStateKeys,
    readMergeRecord: deps.readMergeRecord ?? readFleetMergeState,
  }, now);
  const ledger = await gatherLedger(task, merge, deps.readLedger ?? readLedger, deps.ledgerBudgetMs ?? LEDGER_BUDGET_MS);
  const landing = merge.state === 'ok' && merge.record.landing ? merge.record.landing : ledger.state === 'ok' ? ledger.landing : null;
  const recorded: MergeCommit | null = landing && SHA_RE.test(landing.mergeSha) ? { sha: landing.mergeSha, basis: 'landing' } : null;
  const { mergeCommit, release } = await withBudget(
    deps.gitBudgetMs ?? GIT_TOTAL_BUDGET_MS,
    () => gatherGit(task, landing, { git, checkoutFor: deps.checkoutFor ?? defaultCheckoutFor(git) }, now),
  ).catch((error: unknown): { mergeCommit: MergeCommit | null; release: ReleaseSource | null } => ({
    mergeCommit: recorded,
    release: recorded ? { state: 'unknown', reason: `Local git ${error instanceof TimedOut ? error.message : 'failed'}.` } : null,
  }));
  const watch = gatherWatch(task, landing, mergeCommit?.sha ?? null, deps.listWatches ?? listPostMergeWatches);
  let model: string | null = null;
  const proposalId = merge.state === 'ok' ? merge.record.proposalId : null;
  if (proposalId) {
    try {
      model = (deps.readEvidenceModel ?? evidenceModel)(proposalId);
    } catch {
      model = null;
    }
  }
  return { task, merge, ledger, watch, model, mergeCommit, release };
}

let routeDeps: TimelineDeps | null = null;

/** Test hook: the sources the HTTP route reads (null restores production). Clears every cache. */
export function setCloudTimelineDepsForTest(deps: TimelineDeps | null): void {
  routeDeps = deps;
  clearCloudTimelineCaches();
}

/** What timeline-api.ts passes to cloudTaskTimeline (production: real stores and git). */
export function timelineDepsForRoute(): TimelineDeps {
  return routeDeps ?? {};
}

/**
 * The timeline for task `id`, or null when there is no such task. Cached per
 * task revision (`updatedAt`) for a few seconds, and concurrent requests for
 * one task share a single gather.
 */
export async function cloudTaskTimeline(id: string, deps: TimelineDeps = {}): Promise<CloudTimelineResponse | null> {
  if (!CLOUD_TASK_ID_PATTERN.test(id)) return null;
  const clock = deps.now ?? (() => new Date());
  const task = (deps.readTask ?? readCloudTask)(id);
  if (!task) return null;
  const key = `${task.id}\0${task.updatedAt}`;
  const cached = timelineCache.get(key, clock().getTime());
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    try {
      const timeline = buildCloudTimeline(await gatherTimelineSources(task, deps), clock());
      timelineCache.set(key, timeline, clock().getTime());
      return timeline;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, work);
  return work;
}
