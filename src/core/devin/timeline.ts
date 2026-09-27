/**
 * Devin task evidence timeline (3.15) — READ-ONLY.
 *
 *   GET /api/verse/devin/tasks/<id>/timeline  → CloudTimelineResponse
 *   (served by cloud/timeline-api.ts, mounted before the 'devin' module)
 *
 * The same ordered chain as a cloud task's (cloud/timeline.ts): a Devin task
 * delivers exactly like one — branch `ashlr-devin/<id>`, a PR, a fenced
 * `ashlr-devin-report` block — so the report → PR → diff → checks → gates →
 * merge → release → health steps AND all of the gathering (merge record by
 * repo + PR number / branch / task id, the hash-chained ledger, the
 * post-merge watch, local git tags) are the cloud lane's, reused as-is. Only
 * the steps that describe the worker differ, and they are built here:
 *
 *   objective  the Devin task record (prompt, origin, backlog item)
 *   launch     the session Devin created (mode, id, link on app.devin.ai)
 *   worker     the session's last-read status (+ status_detail) from the
 *              Devin API, and how many messages Verse sent it
 *   cost       ACUs the Devin API reports vs the cap sent at launch, with a
 *              dollar ESTIMATE at the Devin budget's $/ACU calibration (the
 *              docs publish no self-serve price), linked to Devin's usage page
 *
 * EPISTEMICS match the cloud lane's: the report is a claim, the cost an
 * estimate (`verified: false`); the model is 'unknown' unless a record names
 * it — the Devin API does not. Nothing is invented: a message count Verse did
 * not record is said to be unrecorded, never guessed from the session.
 */
import {
  cachedTimeline,
  clearCloudTimelineCaches,
  clip,
  deliveryTimelineSteps,
  gatherTimelineSources,
  httpsLink,
  isoOrNull,
  step,
  type TimelineGatherDeps,
  type TimelineLaneWords,
  type TimelineSources,
} from '../cloud/timeline.js';
import { CLOUD_TIMELINE_SCHEMA_VERSION, type CloudTimelineResponse, type TimelineStep } from '../cloud/timeline-types.js';
import { readDevinBudget, readDevinTask } from './store.js';
import { DEVIN_REPORT_FENCE, DEVIN_TASK_ID_PATTERN, DEVIN_USAGE_URL, type DevinTaskV1 } from './types.js';

export const DEVIN_TIMELINE_WORDS: TimelineLaneWords = {
  record: 'Devin task record',
  tracker: 'GitHub, read by the Devin tracker',
  trackerAndGit: 'GitHub (Devin tracker) + local git',
  pin: 'Devin task delivery pin',
  reportFence: DEVIN_REPORT_FENCE,
  prNoun: 'Devin PR',
};

const ORIGIN_WORD: Record<DevinTaskV1['origin'], string> = {
  chat: 'a chat’s “Run in Devin”',
  operator: 'New Devin task',
  cli: 'the ashlr CLI',
  fleet: 'the fleet',
};

type Step = TimelineStep;

/**
 * The message count the service keeps (an OPTIONAL field on DevinTaskV1 —
 * read through a narrow local type so this file does not depend on when it
 * lands). Only messages Verse sent are counted; ones typed in Devin's own app
 * are not, and the session response's own history is never used to guess.
 */
export function devinMessagesLine(task: DevinTaskV1): string {
  const raw = (task as DevinTaskV1 & { messagesSent?: unknown }).messagesSent;
  if (raw === undefined || raw === null) return 'No messages recorded as sent from Verse.';
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return 'Messages sent from Verse: unknown.';
  if (raw === 0) return 'No messages sent from Verse.';
  return `${raw} ${raw === 1 ? 'message' : 'messages'} sent from Verse.`;
}

function launched(task: DevinTaskV1): boolean {
  return task.sessionId !== null || task.sessionUrl !== null;
}

function objectiveStep(task: DevinTaskV1): Step {
  const parts = [`From ${ORIGIN_WORD[task.origin] ?? 'an unknown entry point'}, requested by ${task.requestedBy}.`];
  if (task.backlogItemId) parts.push(`Backlog item ${clip(task.backlogItemId, 80)}.`);
  parts.push(`${task.repo} from ${clip(task.baseBranch, 120)}.`);
  const prompt = clip(task.prompt, 600);
  if (prompt) parts.push(`Task: ${prompt}`);
  return step('objective', {
    at: isoOrNull(task.createdAt),
    title: clip(task.title, 120) || 'Untitled Devin task',
    detail: parts.join(' '),
    source: 'Devin task record',
    verified: true,
    reached: true,
  });
}

function launchStep(task: DevinTaskV1): Step {
  // Only Devin's own host becomes a link; anything else stored there is shown as nothing.
  const session = httpsLink(task.sessionUrl, 'app.devin.ai', 'Open in Devin');
  if (task.state === 'failed' && !launched(task)) {
    return step('launch', {
      at: isoOrNull(task.launchedAt) ?? isoOrNull(task.updatedAt),
      title: 'Launch failed',
      detail: clip(task.stateReason ?? `The Devin session was not started (${task.failure ?? 'unknown'}).`, 400),
      source: 'Devin task record',
      verified: true,
      reached: true,
    });
  }
  if (launched(task)) {
    const id = task.sessionId ? ` Session ${clip(task.sessionId, 130)}.` : '';
    return step('launch', {
      at: isoOrNull(task.launchedAt),
      title: `Devin session started (${clip(task.devinMode, 20)} mode)`,
      detail: `Branch ${task.branch}.${id} Capped at ${task.maxAcu} ACUs.`,
      source: 'Devin task record (API answer at launch)',
      verified: true,
      reached: true,
      ...(session ? { link: session } : {}),
    });
  }
  const pending = task.state === 'queued' || task.state === 'launching';
  return step('launch', {
    at: null,
    title: task.state === 'queued' ? 'Waiting for a launch slot' : task.state === 'launching' ? 'Launching' : 'No session recorded',
    detail: pending ? '' : 'The task record has no Devin session id.',
    source: 'Devin task record',
    verified: pending ? true : 'unknown',
    reached: false,
  });
}

function workerStep(task: DevinTaskV1, model: string | null): Step {
  const snap = task.session;
  const messages = devinMessagesLine(task);
  const modelText = model ? `Model: ${clip(model, 80)} (evidence pack).` : 'Model: unknown — the Devin API does not name it.';
  if (!snap) {
    return step('worker', {
      at: null,
      title: 'Devin session · status not read yet',
      detail: `${messages} ${modelText}`,
      source: 'Devin API (not read yet)',
      verified: 'unknown',
      reached: launched(task),
    });
  }
  const detailWord = snap.statusDetail ? ` (${clip(snap.statusDetail.replace(/_/g, ' '), 60)})` : '';
  const failed = task.failure ? ` Failure: ${clip(task.failure, 40)}.` : '';
  return step('worker', {
    at: isoOrNull(snap.readAt),
    title: `Devin session · ${clip(snap.status, 30)}${detailWord}`,
    detail: `${messages}${failed} ${modelText}`,
    // Devin's own API is the record of its session's status — not the
    // session's say-so about its work (that is the report, a claim).
    source: 'Devin API (session status)',
    verified: true,
    reached: true,
  });
}

const fmtAcu = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));

function validAcu(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function costStep(task: DevinTaskV1, usdPerAcu: number | null): Step {
  const acus = validAcu(task.session?.acusConsumed);
  const rate = validAcu(usdPerAcu);
  const cap = validAcu(task.maxAcu);
  const capText = cap !== null ? `${fmtAcu(cap)}` : 'unknown';
  const usd = acus !== null && rate !== null ? acus * rate : null;
  const rateText = rate !== null ? `$${rate.toFixed(2)} per ACU` : null;
  let title: string;
  let detail: string;
  if (acus !== null) {
    title = `${fmtAcu(acus)} of ${capText} ACUs used${usd !== null ? ` · ~$${usd.toFixed(2)} estimated` : ''}`;
    detail = `ACUs as the Devin API reports them for this session, against the cap sent at launch. ${rateText
      ? `The dollar figure is an estimate at ${rateText} (the Devin budget’s calibration); Devin publishes no self-serve price per ACU.`
      : 'The Devin budget’s $/ACU could not be read, so there is no dollar estimate.'} Real usage is in Devin’s settings.`;
  } else {
    title = `ACUs not reported (cap ${capText})`;
    detail = launched(task)
      ? 'The Devin API has not reported ACUs for this session; the budget counts its full cap until it does.'
      : 'No session was started, so no ACUs were used.';
  }
  return step('cost', {
    at: isoOrNull(task.session?.readAt) ?? isoOrNull(task.launchedAt) ?? isoOrNull(task.createdAt),
    title,
    detail,
    source: rateText ? 'Devin API (ACUs) · budget estimate ($)' : 'Devin API (ACUs)',
    // An estimate either way: ACUs are Devin's reading, dollars are a calibration.
    verified: false,
    reached: true,
    link: { href: DEVIN_USAGE_URL, label: 'Check usage in Devin' },
  });
}

/** PURE: the ordered evidence chain for one Devin task from already-gathered sources. */
export function buildDevinTimeline(sources: TimelineSources<DevinTaskV1>, usdPerAcu: number | null, now: Date = new Date()): CloudTimelineResponse {
  const { task } = sources;
  const steps: TimelineStep[] = [
    objectiveStep(task),
    launchStep(task),
    workerStep(task, sources.model),
    ...deliveryTimelineSteps(sources, DEVIN_TIMELINE_WORDS),
    costStep(task, usdPerAcu),
  ];
  return {
    v: CLOUD_TIMELINE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    taskId: task.id,
    repo: task.repo,
    title: clip(task.title, 120) || 'Untitled Devin task',
    state: task.state,
    steps,
  };
}

export interface DevinTimelineDeps extends TimelineGatherDeps {
  readTask?: (id: string) => DevinTaskV1 | null;
  /** The Devin budget's $/ACU estimate; null = unreadable (no dollar figure is shown). */
  usdPerAcu?: () => number | null;
}

function defaultUsdPerAcu(): number | null {
  try {
    return readDevinBudget().usdPerAcu;
  } catch {
    return null;
  }
}

/**
 * The timeline for Devin task `id`, or null when there is no such task (or
 * the id is not one Verse issues). Cached per task revision like the cloud
 * lane's (cloud/timeline.ts cachedTimeline).
 */
export async function devinTaskTimeline(id: string, deps: DevinTimelineDeps = {}): Promise<CloudTimelineResponse | null> {
  if (!DEVIN_TASK_ID_PATTERN.test(id)) return null;
  const clock = deps.now ?? (() => new Date());
  const task = (deps.readTask ?? readDevinTask)(id);
  if (!task) return null;
  return cachedTimeline(task, clock, async () => {
    const sources = await gatherTimelineSources<DevinTaskV1>(task, deps);
    let rate: number | null;
    try {
      rate = (deps.usdPerAcu ?? defaultUsdPerAcu)();
    } catch {
      rate = null;
    }
    return buildDevinTimeline(sources, rate, clock());
  });
}

let routeDeps: DevinTimelineDeps | null = null;

/** Test hook: the sources the HTTP route reads (null restores production). Clears every timeline cache. */
export function setDevinTimelineDepsForTest(deps: DevinTimelineDeps | null): void {
  routeDeps = deps;
  clearCloudTimelineCaches();
}

/** What timeline-api.ts passes to devinTaskTimeline (production: real stores and git). */
export function devinTimelineDepsForRoute(): DevinTimelineDeps {
  return routeDeps ?? {};
}
