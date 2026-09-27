/**
 * Cloud-PR intake (3.13) — cloud and self-improvement PRs land through the
 * standing gates.
 *
 * Verse's cloud lane (and its self-improvement lane) delivers work as DRAFT
 * PRs on `ashlr-cloud/<taskId>` (cloud/types.ts). The standing merge pass
 * (standing-merge-pass.ts) only evaluates proposals built in a fleet MIRROR,
 * so without this module a cloud PR could only be landed by Mason by hand.
 * Once per standing tick, `ingestCloudPrs` turns each eligible cloud PR into
 * an ordinary pending proposal in the repo's fleet mirror; from there the
 * EXISTING pass does everything — G0–G6, the verified-tree App PR, G7
 * (`ashlr/verify` + required checks), the SHA-pinned merge, the post-merge
 * watch and auto-revert, KILL. Nothing here merges, and no gate is changed.
 *
 * Selection (all must hold, else the task is left alone for Mason's Needs-you
 * triage, with the reason reported):
 *   - task `pr-open`, its PR verified by the tracker, a `deliveryPin` recorded,
 *     not already superseded;
 *   - the repo is in the live standing grant and has a CURRENT fleet mirror
 *     whose default branch is the task's base branch (the fleet only ever
 *     lands on the mirror's base);
 *   - identity, re-read from GitHub this tick: the pinned PR number and URL,
 *     head ref exactly `ashlr-cloud/<taskId>` in the same repository, base ref
 *     still the task's base (a retargeted PR is refused), head SHA read, the
 *     diff read PINNED to `<merge-base>...<headSha>`, and the head re-read
 *     after the download (a push mid-read means "next tick", never a mix);
 *   - the diff is non-empty, within the absolute grant ceilings
 *     (STANDING_GRANT_CEILINGS) and byte cap, and unchanged by the proposal
 *     store's canonicalisation (secret-like content would otherwise be
 *     rewritten, and the proposal would no longer be the head's diff).
 *
 * The proposal: origin 'agent', kind 'pr', repo = the mirror path, the head's
 * diff, engineModel `claude:cloud` (family claude), workItemId = the backlog
 * item, runId = the task id. Its summary carries the session's own report,
 * marked UNVERIFIED — G4 checks that claim against the diff.
 *
 * WHY THE HOST MAY SIGN PROVENANCE FOR A DIFF IT DID NOT PRODUCE. G2 refuses
 * a proposal whose provenance HMAC does not verify, and until now only
 * producers the host ran itself signed (sandboxed-engine, regression
 * sentinel). Here the host signs `claude:cloud|frontier|<diffHash>` for a diff
 * a cloud session wrote. The signature vouches for IDENTITY only: "this host
 * read exactly this diff (hash) from the pinned head of the task's pinned PR,
 * which a Claude cloud session produced". It says nothing about correctness,
 * and nothing downstream treats it as if it did:
 *   - G3 verifies the exact diff in the mirror (tests on the exact tree);
 *   - G4 checks the session's claims against the diff;
 *   - G6 needs an independent judge — `claude:cloud` is family `claude`
 *     (reviewer-independence.ts), so only a codex / grok judge qualifies;
 *   - G7 needs the fleet App's own green `ashlr/verify` plus required checks.
 * The family it asserts (claude) is the one that makes G6 STRICTER, and the
 * tier ('frontier') is what a Claude cloud session is. G1 (protected paths →
 * owner lane) and G1b (tamper) run unchanged on the diff.
 *
 * Dedupe: one proposal per (task, head SHA), remembered in the task's
 * `intake` memo. A new head supersedes the old PENDING proposal (rejected with
 * a reason) before the new one is filed; a proposal the pass is already
 * carrying in an App PR is never touched.
 *
 * Cloud side: once the standing pass has opened the App PR for the ingested
 * proposal (its fleet merge state names a PR whose diff hash is the one we
 * filed), the next intake comments "Superseded by #N" on the cloud PR, closes
 * it and records `supersededBy` on the task; the tracker then follows the App
 * PR, so the task ends `merged` (never `closed`) when the fleet lands it.
 *
 * Shadow mode needs nothing here: when the rollout stage does not allow
 * merging, the pass's would-merge record for the App PR is the dry run.
 *
 * Bounded and never fatal: at most CLOUD_INTAKE_MAX_TASKS_PER_TICK tasks per
 * call (a cursor rotates through the rest), a wall-clock budget, KILL checked
 * before every task and before any write; every failure is a reported
 * outcome. All I/O is injectable (CloudIntakeDeps) for tests.
 *
 * 3.15 — SOURCES. The same intake serves the Devin lane (devin/intake.ts):
 * a `CloudIntakeSource` names the lane's branch prefix, report fence and the
 * producer identity the host vouches for, and the caller passes the lane's
 * task store through `deps`. Every rule above applies unchanged; only the
 * words and the identity differ. A Devin PR is signed `devin:<devin_mode>`,
 * family `devin` (reviewer-independence.ts). G6 needs TWO judges of
 * different families for it (merge-gates.ts evaluateG6), and the standing
 * pass merges it only when the live stage names the `devin` engine and that
 * two-judge rule holds (producerMergeWithheld); otherwise shadow.
 */
import { existsSync } from 'node:fs';

import { STANDING_GRANT_CEILINGS, type EffectivePolicy } from '../authority/types.js';
import { parseCloudReport } from '../cloud/delivery-contract.js';
import { HEAD_SHA_PATTERN, readPinnedDiff, type CloudDeliveryTask, type CloudGh } from '../cloud/pr-actions.js';
import { listCloudTasks, readCloudTask, writeCloudTask } from '../cloud/store.js';
import { defaultCloudGh } from '../cloud/tracker.js';
import { CLOUD_BRANCH_PREFIX, CLOUD_REPORT_FENCE, type CloudIntakeMemo, type CloudTaskReport, type CloudTaskV1 } from '../cloud/types.js';
import { measureAutoMergeDiffScope } from '../foundry/automerge-diff-scope.js';
import { hashDiff, signProvenance, verifyProvenance } from '../foundry/provenance.js';
import { createProposal, isDiffDedupResult, loadProposal, setStatus } from '../inbox/store.js';
import { killSwitchOn } from '../sandbox/policy.js';
import type { AshlrConfig, Proposal } from '../types.js';
import { canonicalizeProposalDiff, scrubSecrets } from '../util/scrub.js';
import { lockFleetMergeState, proposalStateKey, readFleetMergeState, unlockFleetMergeState, type FleetMergeStateRead } from './fleet-merge-state.js';
import { repoPolicyFor } from './merge-gates.js';
import { mirrorNameForPath, mirrorPathFor, readMirrorState } from './mirrors.js';

/** Producer identity the host vouches for (family `claude` — G6 then needs a codex / grok judge). */
export const CLOUD_INTAKE_ENGINE_MODEL = 'claude:cloud' as const;
export const CLOUD_INTAKE_ENGINE_TIER = 'frontier' as const;
/** Tasks examined per call (each costs up to four `gh` calls). */
export const CLOUD_INTAKE_MAX_TASKS_PER_TICK = 6;
/** Wall-clock budget per call; the tick hook also bounds the whole call. */
export const CLOUD_INTAKE_BUDGET_MS = 60_000;
/** A cloud diff larger than this is never ingested (the mirror's G3 would not see the same bytes GitHub truncates). */
export const CLOUD_INTAKE_MAX_DIFF_BYTES = 256 * 1024;

const PR_VIEW_FIELDS = 'number,url,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,body';

// ---------------------------------------------------------------------------
// Sources (3.15)
// ---------------------------------------------------------------------------

/** What the intake reads from a task of any lane (a CloudTaskV1 or a devin/types.ts DevinTaskV1). */
export interface CloudIntakeTask extends CloudDeliveryTask {
  title: string;
  origin: string;
  createdAt: string;
  backlogItemId: string | null;
  intake?: CloudIntakeMemo;
}

/** A lane whose PRs the intake takes in. */
export interface CloudIntakeSource<T extends CloudIntakeTask = CloudTaskV1> {
  /** Cursor key and log word (`cloud`, `devin`). */
  kind: string;
  /** The only head-ref prefix accepted: `<prefix><task id>`. */
  branchPrefix: string;
  /** Report fence in the PR body (delivery-contract.ts parseCloudReport). */
  reportFence: string;
  /** The producer identity the host signs for this task's diff (`<engine>:<model>`). */
  engineModel: (task: T) => string;
  engineTier: 'frontier' | 'mid';
  /** Proposal title prefix. */
  titlePrefix: string;
  /** "cloud task" — the summary's source line. */
  taskNoun: string;
  /** "a Claude cloud session" — who produced the diff. */
  producerPhrase: string;
  /** Report header word ("Cloud session", "Devin session"). */
  reportLabel: string;
}

/** The Claude cloud lane (3.13): exactly the identity and words the intake always used. */
export const CLOUD_INTAKE_SOURCE: CloudIntakeSource<CloudTaskV1> = Object.freeze({
  kind: 'cloud',
  branchPrefix: CLOUD_BRANCH_PREFIX,
  reportFence: CLOUD_REPORT_FENCE,
  engineModel: () => CLOUD_INTAKE_ENGINE_MODEL,
  engineTier: CLOUD_INTAKE_ENGINE_TIER,
  titlePrefix: '[cloud]',
  taskNoun: 'cloud task',
  producerPhrase: 'a Claude cloud session',
  reportLabel: 'Cloud session',
});
const SAFE_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SUMMARY_TEXT_MAX = 1_500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CloudIntakeAction =
  /** A pending proposal was filed for the task's current head. */
  | 'ingested'
  /** The current head was already ingested (or refused) — nothing to do. */
  | 'unchanged'
  /** The cloud PR was closed in favour of the fleet App PR. */
  | 'superseded'
  /** Not eligible; the reason says why. The cloud PR stays for Mason. */
  | 'refused'
  /** Transient (GitHub unreadable, a push mid-read, a lock held): retried next tick. */
  | 'deferred';

export interface CloudIntakeOutcome {
  taskId: string;
  repo: string;
  action: CloudIntakeAction;
  /** Short stable code (e.g. `head-ref-mismatch`, `diff-over-caps`). */
  code: string;
  reason: string;
  proposalId?: string;
  headSha?: string;
  appPr?: number;
}

export interface CloudIntakeResult {
  checked: number;
  ingested: number;
  superseded: number;
  refused: number;
  deferred: number;
  /** True when KILL stopped the call before or between tasks. */
  killed: boolean;
  outcomes: CloudIntakeOutcome[];
}

/** A mirror the tick made current (mirrors.ts MirrorTickPreparation.ready). */
export interface CloudIntakeMirror {
  nameWithOwner: string;
  path: string;
  base: string;
}

export interface CloudIntakeDeps<T extends CloudIntakeTask = CloudTaskV1> {
  gh: CloudGh;
  listTasks: () => T[];
  readTask: (id: string) => T | null;
  writeTask: (task: T) => void;
  /** The repo's current fleet mirror (path + default branch), or null. */
  mirrorFor: (nameWithOwner: string) => CloudIntakeMirror | null;
  createProposal: (p: Omit<Proposal, 'id' | 'status' | 'createdAt'>, cfg: AshlrConfig) => Proposal;
  loadProposal: (id: string) => Proposal | null;
  /** Reject a PENDING proposal (expected status 'pending'); false when it was not pending. */
  rejectPending: (id: string, reason: string) => boolean;
  readFleetMergeState: (key: string) => FleetMergeStateRead;
  /** Hold the proposal's fleet merge state while its proposal is superseded (the pass holds it while evaluating). */
  lockFleetState: (key: string) => (() => void) | null;
  killActive: () => boolean;
  nowMs: () => number;
}

export interface IngestCloudPrsOptions<T extends CloudIntakeTask = CloudTaskV1> {
  /** The tick's current mirrors; when given, ONLY these are used (a stale mirror is never a target). */
  mirrors?: readonly CloudIntakeMirror[];
  deps?: Partial<CloudIntakeDeps<T>>;
  /**
   * 3.15: another lane (default: the cloud lane). A non-cloud source MUST
   * pass its own listTasks / readTask / writeTask in `deps` — the defaults
   * read the cloud store, and a source/store mismatch is refused.
   */
  source?: CloudIntakeSource<T>;
}

function defaultMirrorFor(nameWithOwner: string): CloudIntakeMirror | null {
  try {
    const state = readMirrorState(nameWithOwner);
    if (!state || state.lastSyncOk !== true || !state.base) return null;
    const path = mirrorPathFor(nameWithOwner);
    return existsSync(path) ? { nameWithOwner: state.nameWithOwner, path, base: state.base } : null;
  } catch {
    return null;
  }
}

export function defaultCloudIntakeDeps(): CloudIntakeDeps {
  return {
    gh: defaultCloudGh,
    listTasks: () => listCloudTasks(Number.MAX_SAFE_INTEGER),
    readTask: (id) => readCloudTask(id),
    writeTask: (task) => writeCloudTask(task),
    mirrorFor: defaultMirrorFor,
    createProposal: (p, cfg) => createProposal(p, cfg),
    loadProposal: (id) => loadProposal(id),
    rejectPending: (id, reason) => setStatus(id, 'rejected', reason, reason, undefined, {}, 'pending'),
    readFleetMergeState: (key) => readFleetMergeState(key),
    lockFleetState: (key) => {
      const lock = lockFleetMergeState(key, 0);
      return lock ? () => unlockFleetMergeState(lock) : null;
    },
    killActive: () => killSwitchOn(),
    nowMs: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function runGh(gh: CloudGh, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await gh(args);
    return { ok: result.ok, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

const short = (sha: string): string => sha.slice(0, 12);

interface CloudPrRead {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  body: string | null;
}

type IdentityRead = { ok: true; pr: CloudPrRead } | { ok: false; transient: boolean; code: string; reason: string };

/**
 * The task's pinned PR as GitHub describes it now — the same identity rules
 * as the tracker and the Needs-you actions (pr-actions.ts), with a precise
 * refusal code for each mismatch.
 */
async function readPinnedPr<T extends CloudIntakeTask>(task: T, gh: CloudGh, source: CloudIntakeSource<T>): Promise<IdentityRead> {
  const pin = task.deliveryPin!;
  const view = await runGh(gh, ['pr', 'view', String(pin.number), '--repo', task.repo, '--json', PR_VIEW_FIELDS]);
  const raw = view.ok ? parseJson(view.stdout) : undefined;
  if (!isRecord(raw)) return { ok: false, transient: true, code: 'github-unreadable', reason: 'GitHub did not describe the pull request' };
  if (raw['number'] !== pin.number || typeof raw['url'] !== 'string' || raw['url'].toLowerCase() !== pin.url.toLowerCase()) {
    return { ok: false, transient: false, code: 'pr-identity-changed', reason: `GitHub's PR is no longer the pinned #${pin.number}` };
  }
  if (raw['isCrossRepository'] !== false) {
    return { ok: false, transient: false, code: 'cross-repository', reason: 'the head lives in another repository' };
  }
  if (raw['headRefName'] !== task.branch || task.branch !== `${source.branchPrefix}${task.id}`) {
    return {
      ok: false,
      transient: false,
      code: 'head-ref-mismatch',
      reason: `the head ref is ${typeof raw['headRefName'] === 'string' ? `"${raw['headRefName'].slice(0, 120)}"` : 'unreadable'}, not ${source.branchPrefix}${task.id}`,
    };
  }
  if (raw['baseRefName'] !== task.baseBranch) {
    return {
      ok: false,
      transient: false,
      code: 'base-moved',
      reason: `the PR now targets ${typeof raw['baseRefName'] === 'string' ? `"${raw['baseRefName'].slice(0, 120)}"` : 'an unreadable base'}, not the task's ${task.baseBranch}`,
    };
  }
  const state = raw['state'];
  const headSha = raw['headRefOid'];
  if ((state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') || typeof headSha !== 'string' || !HEAD_SHA_PATTERN.test(headSha)) {
    return { ok: false, transient: true, code: 'github-unreadable', reason: 'GitHub did not describe the pull request' };
  }
  return { ok: true, pr: { state, headSha, body: typeof raw['body'] === 'string' ? raw['body'] : null } };
}

/** The merge base of the task's base branch and `headSha` (the diff is pinned to it). */
async function readMergeBase(task: CloudIntakeTask, headSha: string, gh: CloudGh): Promise<string | null> {
  if (!SAFE_REF_RE.test(task.baseBranch) || task.baseBranch.includes('..')) return null;
  const cmp = await runGh(gh, ['api', `repos/${task.repo}/compare/${task.baseBranch}...${headSha}`, '--jq', '{merge_base: .merge_base_commit.sha}']);
  const parsed = cmp.ok ? parseJson(cmp.stdout) : undefined;
  const mergeBase = isRecord(parsed) ? parsed['merge_base'] : undefined;
  return typeof mergeBase === 'string' && HEAD_SHA_PATTERN.test(mergeBase) ? mergeBase : null;
}

/**
 * The proposal summary. The session's report is a CLAIM: it is marked
 * UNVERIFIED and shaped so G4's claim-vs-diff check reads the report's own
 * status — `done` / `partial` claim a change; `blocked` / `no-change` claim
 * none, so their free text (which could contain change verbs) is withheld and
 * a diff under them is the "silent change" G4 refuses. No report claims
 * nothing (G4: not evidence either way — the same reading as the Needs-you
 * preview's claimOfReport).
 */
export function cloudIntakeSummary<T extends CloudIntakeTask = CloudTaskV1>(
  task: T,
  report: CloudTaskReport | null,
  pr: { url: string; headSha: string },
  lane: CloudIntakeSource<T> = CLOUD_INTAKE_SOURCE as unknown as CloudIntakeSource<T>,
): string {
  const source = `Source: ${lane.taskNoun} ${task.id} (${task.origin}), ${pr.url} at head ${short(pr.headSha)}. ` +
    `Produced by ${lane.producerPhrase}; the host vouches only for this identity. Tests, claims, an independent judge and ashlr/verify decide the rest.`;
  const header = `${lane.reportLabel} report (UNVERIFIED: the producing session's own claim, checked against the diff by gate G4, never trusted as evidence).`;
  if (!report) {
    return [header, `No ${lane.reportFence} block was found in the pull request, so the session claims nothing.`, '', source].join('\n');
  }
  if (report.status === 'blocked' || report.status === 'no-change') {
    return [
      header,
      `Report status: ${report.status}. The session reports it was blocked and did not make the change (its free text is withheld so this status is what G4 checks).`,
      '',
      source,
    ].join('\n');
  }
  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const lines = [
    header,
    `Report status: ${report.status}. The session reports it made the change.`,
    clip(report.summary.trim(), SUMMARY_TEXT_MAX),
  ];
  if (report.testsRun.length > 0) lines.push(`Tests the session says it ran: ${clip(report.testsRun.slice(0, 10).join('; '), 400)}`);
  if (report.risks.length > 0) lines.push(`Risks it names: ${clip(report.risks.slice(0, 10).join('; '), 400)}`);
  lines.push('', source);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** Rotates through eligible tasks when more than the per-tick bound are waiting (one cursor per source). */
const lastIntakeTaskIds = new Map<string, string | null>();

/** Test seam. */
export function resetCloudIntakeCursorForTest(): void {
  lastIntakeTaskIds.clear();
}

function candidates<T extends CloudIntakeTask>(tasks: readonly T[], kind: string): T[] {
  let lastIntakeTaskId = lastIntakeTaskIds.get(kind) ?? null;
  const eligible = tasks
    .filter((task) => task.state === 'pr-open' && task.pr !== null && task.pr.state === 'open' && task.deliveryPin !== undefined && task.supersededBy === undefined)
    // Oldest first: the work that has waited longest is looked at first.
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  if (eligible.length <= CLOUD_INTAKE_MAX_TASKS_PER_TICK) {
    lastIntakeTaskIds.set(kind, null);
    return eligible;
  }
  const prior = eligible.findIndex((task) => task.id === lastIntakeTaskId);
  const start = prior >= 0 ? (prior + 1) % eligible.length : 0;
  const selected = Array.from({ length: CLOUD_INTAKE_MAX_TASKS_PER_TICK }, (_, i) => eligible[(start + i) % eligible.length]!);
  lastIntakeTaskId = selected.at(-1)!.id;
  lastIntakeTaskIds.set(kind, lastIntakeTaskId);
  return selected;
}

/**
 * Turn eligible cloud PRs into pending fleet proposals, and close cloud PRs
 * the standing pass has superseded. Never throws; see the module header.
 */
export async function ingestCloudPrs<T extends CloudIntakeTask = CloudTaskV1>(
  cfg: AshlrConfig,
  policy: EffectivePolicy,
  options: IngestCloudPrsOptions<T> = {},
): Promise<CloudIntakeResult> {
  const source = options.source ?? (CLOUD_INTAKE_SOURCE as unknown as CloudIntakeSource<T>);
  const result0: CloudIntakeResult = { checked: 0, ingested: 0, superseded: 0, refused: 0, deferred: 0, killed: false, outcomes: [] };
  // Another lane's source over the cloud store's default readers would ingest
  // the wrong tasks under the wrong identity: refuse the call outright.
  if (source.kind !== CLOUD_INTAKE_SOURCE.kind && (!options.deps?.listTasks || !options.deps.readTask || !options.deps.writeTask)) return result0;
  const deps = { ...(defaultCloudIntakeDeps() as unknown as CloudIntakeDeps<T>), ...options.deps } as CloudIntakeDeps<T>;
  const result: CloudIntakeResult = { checked: 0, ingested: 0, superseded: 0, refused: 0, deferred: 0, killed: false, outcomes: [] };
  const record = (outcome: CloudIntakeOutcome): void => {
    const reason = scrubSecrets(outcome.reason).slice(0, 400);
    result.outcomes.push({ ...outcome, reason });
    if (outcome.action === 'ingested') result.ingested++;
    else if (outcome.action === 'superseded') result.superseded++;
    else if (outcome.action === 'refused') result.refused++;
    else if (outcome.action === 'deferred') result.deferred++;
  };
  const killed = (): boolean => {
    let on = true;
    try {
      on = deps.killActive();
    } catch {
      on = true; // unreadable KILL state fails closed
    }
    if (on) result.killed = true;
    return on;
  };
  if (killed()) return result;

  let tasks: T[];
  try {
    // A task that is not on this source's branch never reaches the identity read.
    tasks = candidates(deps.listTasks().filter((task) => task.branch === `${source.branchPrefix}${task.id}`), source.kind);
  } catch {
    return result;
  }
  const started = deps.nowMs();
  const tickMirrors = options.mirrors
    ? new Map(options.mirrors.map((m) => [m.nameWithOwner.toLowerCase(), m] as const))
    : null;

  for (const task of tasks) {
    if (killed()) break;
    if (deps.nowMs() - started > CLOUD_INTAKE_BUDGET_MS) break;
    result.checked++;
    try {
      await intakeOne(task, cfg, policy, deps, tickMirrors, record, killed, source);
    } catch (error) {
      record({ taskId: task.id, repo: task.repo, action: 'deferred', code: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

async function intakeOne<T extends CloudIntakeTask>(
  task: T,
  cfg: AshlrConfig,
  policy: EffectivePolicy,
  deps: CloudIntakeDeps<T>,
  tickMirrors: Map<string, CloudIntakeMirror> | null,
  record: (outcome: CloudIntakeOutcome) => void,
  killed: () => boolean,
  source: CloudIntakeSource<T>,
): Promise<void> {
  const base = { taskId: task.id, repo: task.repo };
  const refuse = (code: string, reason: string, extra: Partial<CloudIntakeOutcome> = {}): void =>
    record({ ...base, action: 'refused', code, reason, ...extra });
  const defer = (code: string, reason: string, extra: Partial<CloudIntakeOutcome> = {}): void =>
    record({ ...base, action: 'deferred', code, reason, ...extra });

  // ── Grant and mirror (no GitHub call) ────────────────────────────────────
  const repoPolicy = repoPolicyFor(policy, task.repo);
  if (!repoPolicy) return refuse('repo-not-in-grant', `${task.repo} is not in the standing grant`);
  const mirror = tickMirrors ? tickMirrors.get(task.repo.toLowerCase()) ?? null : deps.mirrorFor(task.repo);
  if (!mirror || mirrorNameForPath(mirror.path)?.toLowerCase() !== task.repo.toLowerCase()) {
    return refuse('no-mirror', `${task.repo} has no current fleet mirror`);
  }
  if (mirror.base !== task.baseBranch) {
    return refuse('base-not-mirror-default', `the task targets ${task.baseBranch}, but the fleet lands only on ${mirror.base}`);
  }

  // ── Identity, read from GitHub now ───────────────────────────────────────
  const read = await readPinnedPr(task, deps.gh, source);
  const memo = task.intake ?? null;

  // A PR the standing pass already opened for our proposal supersedes the cloud PR.
  if (memo?.proposalId) {
    const carried = appPrCarrying(memo, deps);
    if (carried) {
      if (!read.ok) return defer(read.transient ? read.code : `supersede-${read.code}`, `cannot close the cloud PR in favour of #${carried}: ${read.reason}`);
      if (read.pr.state !== 'OPEN') {
        return refuse('cloud-pr-not-open', `the cloud PR is ${read.pr.state.toLowerCase()}; fleet PR #${carried} is left to the tracker`, { appPr: carried });
      }
      if (killed()) return;
      const moved = read.pr.headSha !== memo.headSha
        ? ` Commits pushed after ${short(memo.headSha)} are not part of #${carried}.`
        : '';
      const comment = `Superseded by #${carried}: the ashlr fleet rebuilt this change (head ${short(memo.headSha)}) ` +
        `and it lands through the standing merge gates there, pinned to the verified tree. This draft is closed so there is one PR per change.${moved}`;
      const closed = await runGh(deps.gh, ['pr', 'close', String(task.deliveryPin!.number), '--repo', task.repo, '--comment', comment]);
      if (!closed.ok) return defer('close-failed', `GitHub would not close the cloud PR in favour of #${carried}`, { appPr: carried });
      const written = patchTask(task, deps, (current) => ({
        ...current,
        supersededBy: { repo: current.repo, number: carried },
        pr: current.pr ? { ...current.pr, state: 'closed' } : current.pr,
        stateReason: `Superseded by fleet PR #${carried}; it lands through the standing gates.`,
      }) as T);
      record({
        ...base,
        action: 'superseded',
        code: written ? 'superseded' : 'superseded-unrecorded',
        reason: written ? `closed in favour of #${carried}` : `closed in favour of #${carried}, but the task could not be updated`,
        appPr: carried,
        proposalId: memo.proposalId,
      });
      return;
    }
  }

  if (!read.ok) {
    if (read.transient) return defer(read.code, read.reason);
    return refuse(read.code, read.reason);
  }
  const headSha = read.pr.headSha;
  if (read.pr.state !== 'OPEN') return defer('cloud-pr-not-open', `the cloud PR is ${read.pr.state.toLowerCase()}`, { headSha });
  if (memo && memo.headSha === headSha) {
    return record({
      ...base,
      action: 'unchanged',
      code: memo.proposalId ? 'already-ingested' : `already-refused:${memo.refused ?? 'unknown'}`,
      reason: memo.proposalId ? `head ${short(headSha)} is already proposal ${memo.proposalId}` : `head ${short(headSha)} was already refused (${memo.refused})`,
      headSha,
      ...(memo.proposalId ? { proposalId: memo.proposalId } : {}),
    });
  }

  // ── A new head: the old pending proposal is superseded first ─────────────
  if (memo?.proposalId) {
    const superseded = supersedeOldProposal(memo.proposalId, task, headSha, deps);
    if (superseded !== 'ok') return defer('old-proposal-busy', superseded, { headSha, proposalId: memo.proposalId });
  }

  // A refusal for THIS head is remembered, so it is not re-downloaded every tick.
  const refuseHead = (code: string, reason: string): void => {
    patchTask(task, deps, (current) => ({ ...current, intake: { headSha, proposalId: null, diffHash: null, refused: code, at: new Date(deps.nowMs()).toISOString() } }) as T);
    refuse(code, reason, { headSha });
  };

  // ── The diff, pinned to (merge base, head) ───────────────────────────────
  const mergeBase = await readMergeBase(task, headSha, deps.gh);
  if (!mergeBase) return defer('compare-unreadable', 'GitHub did not compare the head with its base', { headSha });
  const rawDiff = await readPinnedDiff(task, mergeBase, headSha, deps.gh);
  if (rawDiff === null) return defer('diff-unreadable', 'the pinned diff could not be read in full', { headSha });
  const reread = await readPinnedPr(task, deps.gh, source);
  if (!reread.ok || reread.pr.headSha !== headSha || reread.pr.state !== 'OPEN') {
    return defer('head-moved', 'the head moved (or became unreadable) while its diff was read; next tick', { headSha });
  }

  if (!rawDiff.trim()) return refuseHead('empty-diff', 'the head changes nothing');
  if (Buffer.byteLength(rawDiff, 'utf8') > CLOUD_INTAKE_MAX_DIFF_BYTES) {
    return refuseHead('diff-over-caps', `the diff is larger than ${CLOUD_INTAKE_MAX_DIFF_BYTES} bytes`);
  }
  const scope = measureAutoMergeDiffScope(rawDiff);
  if (!scope.ok) return refuseHead('diff-unmeasurable', `the diff could not be measured (${scope.reason})`);
  if (scope.files > STANDING_GRANT_CEILINGS.maxFiles || scope.changedLines > STANDING_GRANT_CEILINGS.maxLines) {
    return refuseHead(
      'diff-over-caps',
      `the diff touches ${scope.files} file(s) / ${scope.changedLines} line(s); no grant lands more than ${STANDING_GRANT_CEILINGS.maxFiles} / ${STANDING_GRANT_CEILINGS.maxLines}`,
    );
  }
  let diff: string;
  try {
    diff = canonicalizeProposalDiff(rawDiff);
  } catch {
    return refuseHead('diff-not-canonical', 'the diff could not be canonicalised');
  }
  if (diff !== rawDiff) {
    return refuseHead('diff-not-canonical', 'the diff carries secret-like or long-hex content the proposal store would rewrite; review it on GitHub');
  }

  // ── The proposal ─────────────────────────────────────────────────────────
  if (killed()) return;
  const diffHash = hashDiff(diff);
  const report = parseCloudReport(read.pr.body, source.reportFence);
  const engineModel = source.engineModel(task);
  const created = deps.createProposal({
    repo: mirror.path,
    origin: 'agent',
    kind: 'pr',
    title: `${source.titlePrefix} ${task.title}`.slice(0, 120),
    summary: cloudIntakeSummary(task, report, { url: task.deliveryPin!.url, headSha }, source),
    diff,
    diffHash,
    // Identity only — see the module header for why the host may sign this.
    provenanceSig: signProvenance(engineModel, source.engineTier, diffHash),
    engineModel,
    engineTier: source.engineTier,
    runId: task.id,
    ...(task.backlogItemId ? { workItemId: task.backlogItemId } : {}),
  }, cfg);

  let proposalId: string;
  if (created.status === 'pending') {
    proposalId = created.id;
  } else if (isDiffDedupResult(created)) {
    // An identical pending diff already exists. Adopt it only if it is this
    // task's (a crash between filing and recording the memo), never another's.
    const existing = deps.loadProposal(created.id);
    if (!existing || existing.runId !== task.id || existing.engineModel !== engineModel) {
      return refuseHead('duplicate-of-other-proposal', `an identical pending diff already exists as ${created.id}`);
    }
    proposalId = existing.id;
  } else {
    return refuseHead('proposal-refused', `the inbox refused the proposal: ${created.decisionReason ?? 'unknown reason'}`);
  }

  // Belt and braces: the stored proposal must carry exactly the signed diff.
  const stored = deps.loadProposal(proposalId);
  if (!stored || stored.status !== 'pending' || stored.diffHash !== diffHash || !verifyProvenance(stored).ok) {
    deps.rejectPending(proposalId, 'cloud intake: the stored proposal does not verify against the diff it signed');
    return refuseHead('provenance-mismatch', 'the stored proposal did not verify against the signed diff');
  }

  const memoNext: CloudIntakeMemo = { headSha, proposalId, diffHash, refused: null, at: new Date(deps.nowMs()).toISOString() };
  const written = patchTask(task, deps, (current) => ({ ...current, intake: memoNext }) as T);
  record({
    ...base,
    action: 'ingested',
    code: written ? 'ingested' : 'ingested-unrecorded',
    reason: `head ${short(headSha)} filed as ${proposalId} in ${mirror.nameWithOwner}'s mirror (${scope.files} file(s), ${scope.changedLines} line(s))`,
    proposalId,
    headSha,
  });
}

/**
 * The fleet App PR number carrying the memo's proposal, when the standing pass
 * has opened one for exactly the diff we filed (and it is not closed); else null.
 */
function appPrCarrying<T extends CloudIntakeTask>(memo: CloudIntakeMemo, deps: CloudIntakeDeps<T>): number | null {
  const key = memo.proposalId ? proposalStateKey(memo.proposalId) : null;
  if (!key) return null;
  let read: FleetMergeStateRead;
  try {
    read = deps.readFleetMergeState(key);
  } catch {
    return null;
  }
  if (read.state !== 'ok') return null;
  const state = read.record;
  if (state.kind !== 'change' || state.proposalId !== memo.proposalId || !state.pr || state.pr.state === 'closed') return null;
  if (!memo.diffHash || state.diffHash !== memo.diffHash) return null;
  return state.pr.number;
}

/** Reject the old pending proposal for a superseded head. 'ok', or why it cannot be done now. */
function supersedeOldProposal<T extends CloudIntakeTask>(proposalId: string, task: T, headSha: string, deps: CloudIntakeDeps<T>): 'ok' | string {
  const key = proposalStateKey(proposalId);
  if (!key) return 'ok';
  const unlock = deps.lockFleetState(key);
  if (!unlock) return `proposal ${proposalId} is being evaluated; next tick`;
  try {
    const state = deps.readFleetMergeState(key);
    if (state.state === 'corrupt') return `proposal ${proposalId}'s fleet state is unreadable`;
    if (state.state === 'ok' && state.record.pr !== null) return `proposal ${proposalId} already has fleet PR #${state.record.pr.number}`;
    const existing = deps.loadProposal(proposalId);
    if (!existing || existing.status !== 'pending') return 'ok';
    if (existing.runId !== task.id) return 'ok'; // not ours: never touched
    deps.rejectPending(proposalId, `cloud intake: superseded by newer head ${short(headSha)} of ${task.id}`);
    return 'ok';
  } finally {
    unlock();
  }
}

/**
 * Apply `patch` to the task as it is on disk NOW, only while it is still the
 * same open delivery (a tracker refresh or a Verse action in between wins).
 */
function patchTask<T extends CloudIntakeTask>(task: T, deps: CloudIntakeDeps<T>, patch: (current: T) => T): boolean {
  try {
    const current = deps.readTask(task.id);
    if (!current || current.state !== 'pr-open' || current.supersededBy !== undefined
      || !current.deliveryPin || current.deliveryPin.number !== task.deliveryPin?.number) return false;
    deps.writeTask(patch(current));
    return true;
  } catch {
    return false;
  }
}
