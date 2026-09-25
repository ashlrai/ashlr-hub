/**
 * Cloud lane orchestration (unit C1): the ONLY entry point other code uses
 * to launch. Order: validate → budget gate → persist `queued` → per-repo
 * launch slot → ensureCloudCheckout(base) → buildCloudPrompt →
 * launchCloudSession → persist `running` (or `failed` with a plain reason).
 *
 * The gate check and the `queued` write happen in one synchronous stretch
 * (no await between them), so two launches racing in this process cannot
 * both pass a gate that only has room for one: the second sees the first's
 * queued task in its count.
 */
import type {
  CloudImproveResponse,
  CloudLaunchFailureCode,
  CloudLaunchRequest,
  CloudLaunchResponse,
  CloudOverviewResponse,
  CloudSeatStatus,
  CloudTaskOrigin,
  CloudTaskV1,
} from './types.js';
import { CLOUD_BRANCH_PREFIX, CLOUD_PROMPT_MAX_CHARS, CLOUD_SEAT_ID, CLOUD_TASK_SCHEMA_VERSION } from './types.js';
import { readCloudBacklog, nextBacklogItem } from './backlog.js';
import { cloudBudgetView } from './budget.js';
import { ensureCloudCheckout, isSafeBranchName, KeyedMutex, type CloudCheckoutDeps } from './checkout.js';
import { buildCloudPrompt } from './delivery-contract.js';
import { launchCloudSession, readCloudSeatArgv, SEAT_NOT_READY_REASON, type CloudLaunchDeps } from './launcher.js';
import { CLOUD_REPO_PATTERN, listCloudTasks, newCloudTaskId, readCloudBudget, writeCloudTask } from './store.js';
import { defaultCloudGh, type CloudTrackerDeps } from './tracker.js';

export interface CloudServiceDeps {
  checkout?: CloudCheckoutDeps;
  launcher?: CloudLaunchDeps;
  tracker?: CloudTrackerDeps;
  now?: () => Date;
}

/** Internal launches (Leader approvals, self-improvement) carry their origin + backlog item. */
export type CloudInternalLaunch = Omit<CloudLaunchRequest, 'origin'> & {
  origin: 'leader' | 'self-improve';
  backlogItemId?: string | null;
  needsYouId?: string | null;
};

export const CLOUD_TITLE_MAX_CHARS = 80;
export const CLOUD_IMPROVE_MAX_COUNT = 5;
const OVERVIEW_TASK_LIMIT = 100;
/** Used only when no base branch was given AND GitHub could not say which branch is the default. */
const FALLBACK_BASE_BRANCH = 'main';

const ORIGINS: readonly CloudTaskOrigin[] = ['chat', 'operator', 'cli', 'leader', 'self-improve'];
const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** One launch at a time per repo: every repo has one checkout folder, and the CLI launches from its current branch. */
const launchSlots = new KeyedMutex();

// ---------------------------------------------------------------------------
// Seat
// ---------------------------------------------------------------------------

/**
 * Ready when the claude-a native profile's command.json parses to an argv
 * array. Deliberately does NOT run the CLI to check its sign-in: that costs a
 * process on every overview poll. A signed-out seat surfaces as an `auth`
 * failure on the first launch instead.
 */
export function cloudSeatStatus(): CloudSeatStatus {
  const ready = readCloudSeatArgv(CLOUD_SEAT_ID) !== null;
  return { id: CLOUD_SEAT_ID, ready, reason: ready ? null : SEAT_NOT_READY_REASON };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** First non-empty line, whitespace collapsed, at most 80 chars, cut at a word boundary. */
export function deriveCloudTitle(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= CLOUD_TITLE_MAX_CHARS) return line;
  const room = line.slice(0, CLOUD_TITLE_MAX_CHARS - 1);
  const space = room.lastIndexOf(' ');
  // A single 80-char word has no boundary to cut at; cutting it is the only option.
  return `${(space >= CLOUD_TITLE_MAX_CHARS / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

const refusal = (error: string, failure: CloudLaunchFailureCode | null = null): CloudLaunchResponse =>
  ({ ok: false, task: null, error, failure });

/** The repo's default branch from GitHub, or null (gh missing, offline, repo unknown). */
async function defaultBranchOf(repo: string, deps: CloudServiceDeps): Promise<string | null> {
  try {
    const res = await (deps.tracker?.gh ?? defaultCloudGh)(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    const name = res.ok ? res.stdout.trim() : '';
    return isSafeBranchName(name) ? name : null;
  } catch {
    return null;
  }
}

type GateKind = 'launch' | 'self-improve';

async function launchWithGate(req: CloudLaunchRequest | CloudInternalLaunch, gate: GateKind, deps: CloudServiceDeps): Promise<CloudLaunchResponse> {
  const clock = deps.now ?? (() => new Date());

  // --- validate --------------------------------------------------------
  if (!req || typeof req !== 'object') return refusal('The launch request is empty.');
  const repo = typeof req.repo === 'string' ? req.repo.trim() : '';
  if (!CLOUD_REPO_PATTERN.test(repo)) return refusal('The repo must look like owner/name, for example ashlrai/ashlr-hub.');
  if (!ORIGINS.includes(req.origin)) return refusal('The launch came from an unknown place.');
  // NUL cannot travel in an argv element; drop it rather than fail the spawn.
  const rawPrompt = typeof req.prompt === 'string' ? req.prompt.replace(/\0/g, '').trim() : '';
  if (rawPrompt === '') return refusal('Describe the task before launching it.');
  const prompt = rawPrompt.slice(0, CLOUD_PROMPT_MAX_CHARS);
  const givenTitle = typeof req.title === 'string' ? req.title.trim() : '';
  const title = deriveCloudTitle(givenTitle !== '' ? givenTitle : prompt);
  const givenBase = typeof req.baseBranch === 'string' ? req.baseBranch.trim() : '';
  if (givenBase !== '' && !isSafeBranchName(givenBase)) return refusal(`"${givenBase.slice(0, 80)}" isn't a branch name the cloud lane accepts.`);
  const internal = req as Partial<CloudInternalLaunch>;
  const backlogItemId = typeof internal.backlogItemId === 'string' && REF_ID_RE.test(internal.backlogItemId) ? internal.backlogItemId : null;
  const needsYouId = typeof internal.needsYouId === 'string' && REF_ID_RE.test(internal.needsYouId) ? internal.needsYouId : null;
  // Resolved before the gate so no await separates the gate from the queued write.
  const baseBranch = givenBase !== '' ? givenBase : (await defaultBranchOf(repo, deps)) ?? FALLBACK_BASE_BRANCH;

  // --- gates (seat, then budget) -----------------------------------------
  const seatArgv = (deps.launcher?.seatArgv ?? (() => readCloudSeatArgv(CLOUD_SEAT_ID)))();
  if (!seatArgv) return refusal(SEAT_NOT_READY_REASON, 'seat-unavailable');
  const now = clock();
  const budget = readCloudBudget();
  const view = cloudBudgetView(listCloudTasks(), budget, now);
  const verdict = gate === 'self-improve' ? view.canSelfImprove : view.canLaunch;
  if (!verdict.ok) return refusal(verdict.reason ?? 'The cloud budget refused this launch.', 'budget');

  // --- persist queued ------------------------------------------------------
  const id = newCloudTaskId(now);
  const createdAt = now.toISOString();
  const task: CloudTaskV1 = {
    v: CLOUD_TASK_SCHEMA_VERSION,
    id,
    repo,
    baseBranch,
    branch: `${CLOUD_BRANCH_PREFIX}${id}`,
    title,
    prompt,
    origin: req.origin,
    requestedBy: req.origin === 'leader' ? 'leader' : req.origin === 'self-improve' ? 'self-improve' : 'mason',
    seat: CLOUD_SEAT_ID,
    sessionId: null,
    sessionUrl: null,
    state: 'queued',
    stateReason: 'Waiting for this repo\'s launch slot.',
    failure: null,
    createdAt,
    launchedAt: null,
    updatedAt: createdAt,
    pr: null,
    report: null,
    estimatedCostUsd: budget.estimatedCostPerSessionUsd,
    backlogItemId,
    needsYouId,
  };
  try {
    writeCloudTask(task);
  } catch {
    return refusal("Couldn't save the cloud task, so it wasn't launched.", 'unknown');
  }

  // --- launch (one per repo at a time) -------------------------------------
  const fail = (failure: CloudLaunchFailureCode, reason: string): CloudLaunchResponse => {
    Object.assign(task, { state: 'failed', failure, stateReason: reason });
    try { writeCloudTask(task); } catch { /* the response still carries the failure */ }
    return { ok: false, task, error: reason, failure };
  };
  return launchSlots.run(repo.toLowerCase(), async () => {
    try {
      Object.assign(task, { state: 'launching', stateReason: 'Starting the cloud session.' });
      writeCloudTask(task);
      const checkout = await ensureCloudCheckout(repo, baseBranch, deps.checkout);
      if (!checkout.ok) return fail(checkout.failure, checkout.message);
      const launched = await launchCloudSession({ cwd: checkout.path, prompt: buildCloudPrompt(task) }, deps.launcher);
      if (!launched.ok) return fail(launched.failure, launched.message);
      Object.assign(task, {
        state: 'running',
        sessionId: launched.sessionId,
        sessionUrl: launched.url,
        launchedAt: clock().toISOString(),
        stateReason: 'The cloud session is running. Its pull request will appear here.',
        failure: null,
      });
      writeCloudTask(task);
      return { ok: true, task, error: null, failure: null };
    } catch {
      // A session may already exist if only the final write failed; the
      // tracker still finds its PR by branch name.
      return fail('unknown', 'Something went wrong while launching the cloud session.');
    }
  });
}

export function launchCloudTask(req: CloudLaunchRequest | CloudInternalLaunch, deps: CloudServiceDeps = {}): Promise<CloudLaunchResponse> {
  // A self-improvement launch through the public entry point is held to the
  // self-improvement caps; only runSelfImprove's operator path relaxes that.
  return launchWithGate(req, req?.origin === 'self-improve' ? 'self-improve' : 'launch', deps);
}

/**
 * Launch up to `count` backlog items (default 1, max 5). `auto: true` is the
 * scheduler path and additionally requires budget.selfImprove.enabled and
 * the canSelfImprove gate; `auto: false` is the operator's "Improve Verse"
 * button (canLaunch gate only).
 */
export async function runSelfImprove(opts: { count?: number; auto: boolean }, deps: CloudServiceDeps = {}): Promise<CloudImproveResponse> {
  const clock = deps.now ?? (() => new Date());
  const requested = typeof opts?.count === 'number' && Number.isFinite(opts.count) ? Math.floor(opts.count) : 1;
  const count = Math.min(CLOUD_IMPROVE_MAX_COUNT, Math.max(1, requested));
  const launched: CloudTaskV1[] = [];
  const skipped: CloudImproveResponse['skipped'] = [];
  const repo = readCloudBudget().selfImprove.repo;
  for (let i = 0; i < count; i += 1) {
    // Re-read each round: the previous launch's task now claims its item.
    const item = nextBacklogItem(listCloudTasks(), repo, clock());
    if (!item) break;
    const res = await launchWithGate({
      repo: item.repo ?? repo,
      title: item.title,
      prompt: item.prompt,
      origin: 'self-improve',
      backlogItemId: item.id,
    }, opts?.auto ? 'self-improve' : 'launch', deps);
    if (res.ok && res.task) {
      launched.push(res.task);
      continue;
    }
    skipped.push({ itemId: item.id, reason: res.error ?? 'The launch did not start.' });
    // A refusal or a failed launch will refuse the next item for the same
    // reason (budget, seat, auth); stop instead of burning through the backlog.
    break;
  }
  return { launched, skipped };
}

/** Cheap: reads disk only — no gh, no git, no CLI. Refreshing is the scheduler's and the refresh route's job. */
export async function cloudOverview(deps: CloudServiceDeps = {}): Promise<CloudOverviewResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const tasks = listCloudTasks();
  return {
    generatedAt: now.toISOString(),
    seat: cloudSeatStatus(),
    budget: cloudBudgetView(tasks, readCloudBudget(), now),
    tasks: tasks.slice(0, OVERVIEW_TASK_LIMIT),
    backlog: readCloudBacklog(tasks, now),
  };
}
