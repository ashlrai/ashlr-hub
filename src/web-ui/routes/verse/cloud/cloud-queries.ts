/**
 * routes/verse/cloud/cloud-queries.ts — the one read and the writes behind
 * the cloud lane's UI (3.11 unit C3; server: core/cloud/cloud-api.ts, C2).
 *
 *   GET  /api/verse/cloud                    CloudOverviewResponse
 *   POST /api/verse/cloud/launch             CloudLaunchRequest  → CloudLaunchResponse
 *   POST /api/verse/cloud/budget             CloudBudgetUpdate
 *   POST /api/verse/cloud/refresh            (re-read tasks from GitHub)
 *   POST /api/verse/cloud/improve            CloudImproveRequest → CloudImproveResponse
 *   POST /api/verse/cloud/tasks/<id>/dismiss (mark closed; never touches GitHub)
 *
 * WHY the read is OPTIONAL (the surface-data.ts rule): the routes land in a
 * parallel unit, and a server without them answers 404. That is "this build
 * has no cloud lane yet" — one card's designed state — never a broken
 * Command. 401 and aborts still propagate: an expired read session is the
 * whole app's state.
 *
 * LAZY ONLY. Everything that imports this file (Command's card, the Usage
 * panel, the Fleet chip, the composer's "Run in cloud") is itself behind an
 * import(); nothing cloud-related may cost chat first-paint bytes.
 *
 * Writes pull the held mutation token (CloudLockedError without one — the
 * callers route every write through a token gate that opens the unlock
 * dialog first), then invalidate the overview so every cloud view moves
 * together, and nudge the shell's activity poll (Needs-you carries cloud
 * items).
 */
import {
  CLOUD_TASK_ID_PATTERN,
  VERSE_CLOUD_BUDGET_PATH,
  VERSE_CLOUD_IMPROVE_PATH,
  VERSE_CLOUD_LAUNCH_PATH,
  VERSE_CLOUD_PATH,
  VERSE_CLOUD_REFRESH_PATH,
  VERSE_CLOUD_TASKS_PATH,
  type CloudBudgetUpdate,
  type CloudImproveRequest,
  type CloudImproveResponse,
  type CloudLaunchFailureCode,
  type CloudLaunchRequest,
  type CloudLaunchResponse,
  type CloudOverviewResponse,
} from '../../../../core/cloud/types.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { refreshActivity } from '../shell/useActivity.js';
import type { OptionalRead } from '../command/surface-data.js';

export const CLOUD_KEY = 'verse-cloud';

/** The card, the chip and the panel all poll at this pace while visible (SPEC 3.11 C3). */
export const CLOUD_POLL_MS = 30_000;

export class CloudLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token first.');
    this.name = 'CloudLockedError';
  }
}

/**
 * The server answered a launch with `ok: false` — a budget gate, a missing
 * seat, a CLI that printed no session. `message` is the server's own
 * sentence; `failure` the machine code for tests and chips.
 */
export class CloudLaunchRefusedError extends Error {
  constructor(message: string, public readonly failure: CloudLaunchFailureCode | null) {
    super(message);
    this.name = 'CloudLaunchRefusedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Just enough structure that no render can crash on `undefined.map` or read
 * a budget field that is not there. Field-level honesty (null = unknown) is
 * the model's job.
 */
export function narrowCloudOverview(raw: unknown): CloudOverviewResponse | null {
  if (!isRecord(raw)) return null;
  const { seat, budget, tasks, backlog } = raw;
  if (!isRecord(seat) || typeof seat['ready'] !== 'boolean') return null;
  if (!isRecord(budget) || !isRecord(budget['budget']) || !isRecord(budget['canLaunch']) || !isRecord(budget['canSelfImprove'])) return null;
  for (const key of ['creditsTotalUsd', 'estimatedSpentUsd', 'estimatedRemainingUsd', 'sessionsToday', 'selfImproveToday', 'running']) {
    if (typeof budget[key] !== 'number' || !Number.isFinite(budget[key])) return null;
  }
  if (!Array.isArray(tasks) || !tasks.every((t) => isRecord(t) && typeof t['id'] === 'string' && typeof t['state'] === 'string')) return null;
  if (!isRecord(backlog) || !Array.isArray(backlog['items'])) return null;
  return raw as unknown as CloudOverviewResponse;
}

/** Operator words for a cloud read that did not answer — never a path, never a trace. */
function absence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'The cloud lane is not in this build yet.';
    if (err.status === 503) return 'The cloud lane failed to load on the server.';
    return `The cloud lane answered HTTP ${err.status}.`;
  }
  return 'The cloud lane could not be reached.';
}

export const cloudQuery: QueryDef<OptionalRead<CloudOverviewResponse>> = {
  key: CLOUD_KEY,
  fetch: async (signal) => {
    try {
      const value = narrowCloudOverview(await apiGet<unknown>(VERSE_CLOUD_PATH, signal));
      if (value === null) {
        return { value: null, available: true, reason: 'The cloud lane answered in a shape this version does not recognise, so nothing is shown rather than guessed.' };
      }
      return { value, available: true, reason: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { value: null, available: false, reason: absence(err) };
    }
  },
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new CloudLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

function settled(): void {
  invalidate(CLOUD_KEY);
  void refreshActivity();
}

/**
 * Launch one cloud session. Resolves only on `ok: true` with a task; a
 * refusal the server words in a 200 body is thrown as CloudLaunchRefusedError
 * so every caller shows it the same way as a 4xx refusal (whose sentence is
 * `ApiError.detail`). Invalidates either way — a failed launch is still a
 * recorded task.
 */
export async function launchCloudTask(request: CloudLaunchRequest): Promise<CloudLaunchResponse & { task: NonNullable<CloudLaunchResponse['task']> }> {
  try {
    const response = await post<CloudLaunchResponse>(VERSE_CLOUD_LAUNCH_PATH, request);
    if (!isRecord(response) || response.ok !== true || !isRecord(response.task)) {
      const error = isRecord(response) && typeof response.error === 'string' && response.error ? response.error : 'The cloud session was not started, and the server sent no reason.';
      const failure = isRecord(response) && typeof response.failure === 'string' ? response.failure : null;
      throw new CloudLaunchRefusedError(error, failure);
    }
    return response as CloudLaunchResponse & { task: NonNullable<CloudLaunchResponse['task']> };
  } finally {
    settled();
  }
}

/** One budget change (any subset; the server validates and clamps). */
export async function updateCloudBudget(update: CloudBudgetUpdate): Promise<unknown> {
  const result = await post<unknown>(VERSE_CLOUD_BUDGET_PATH, update);
  invalidate(CLOUD_KEY);
  return result;
}

/** Launch up to `count` backlog items now (the "Improve Verse" button). */
export async function runCloudImprove(request: CloudImproveRequest = { count: 1 }): Promise<CloudImproveResponse> {
  try {
    const result = await post<unknown>(VERSE_CLOUD_IMPROVE_PATH, request);
    const launched = isRecord(result) && Array.isArray(result['launched']) ? (result['launched'] as CloudImproveResponse['launched']) : [];
    const skipped = isRecord(result) && Array.isArray(result['skipped']) ? (result['skipped'] as CloudImproveResponse['skipped']) : [];
    return { launched, skipped };
  } finally {
    settled();
  }
}

/** Ask the server to re-read every open task from GitHub now. */
export async function refreshCloudTasks(): Promise<unknown> {
  try {
    return await post<unknown>(VERSE_CLOUD_REFRESH_PATH, {});
  } finally {
    settled();
  }
}

/**
 * Stop tracking one task (it becomes `closed`, "Dismissed in Verse."). The id
 * is re-checked against the contract's pattern: it came from the server, but
 * it is spliced into a path the mutation token is sent to.
 */
export async function dismissCloudTask(taskId: string): Promise<unknown> {
  if (!CLOUD_TASK_ID_PATTERN.test(taskId)) throw new Error('That task id is not one Verse issued, so nothing was sent.');
  try {
    return await post<unknown>(`${VERSE_CLOUD_TASKS_PATH}/${taskId}/dismiss`, {});
  } finally {
    settled();
  }
}
