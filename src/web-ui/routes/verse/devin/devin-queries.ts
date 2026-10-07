/**
 * routes/verse/devin/devin-queries.ts — the read and writes behind the Devin
 * lane's UI (3.15; server: core/devin/devin-api.ts).
 *
 *   GET  /api/verse/devin                        DevinOverviewResponse
 *   POST /api/verse/devin/launch                 DevinLaunchRequest → DevinLaunchResponse
 *   POST /api/verse/devin/tasks/<id>/message     { message } (reply to a waiting session)
 *
 * The read is OPTIONAL: a server without the lane answers 404 — "not in this
 * build", a designed state. 401 and aborts propagate. There is no write that
 * carries an API key: the key is entered only in a terminal.
 *
 * LAZY ONLY: everything importing this file sits behind an import().
 */
import {
  DEVIN_TASK_ID_PATTERN,
  VERSE_DEVIN_LAUNCH_PATH,
  VERSE_DEVIN_PATH,
  VERSE_DEVIN_TASKS_PATH,
  type DevinFailureCode,
  type DevinLaunchRequest,
  type DevinLaunchResponse,
  type DevinOverviewResponse,
} from '../../../../core/devin/types.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { refreshActivity } from '../shell/useActivity.js';
import type { OptionalRead } from '../command/surface-data.js';
import { narrowDevinOverview } from './devin-model.js';

export const DEVIN_KEY = 'verse-devin';
export const DEVIN_POLL_MS = 60_000;
export const DEVIN_NOT_IN_BUILD = 'The Devin lane is not in this build yet.';
export const DEVIN_CONSUMPTION_REFRESH_PATH = '/api/verse/devin/consumption/refresh';

export class DevinLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token first.');
    this.name = 'DevinLockedError';
  }
}

export class DevinLaunchRefusedError extends Error {
  constructor(message: string, public readonly failure: DevinFailureCode | null) {
    super(message);
    this.name = 'DevinLaunchRefusedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function absence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return DEVIN_NOT_IN_BUILD;
    if (err.status === 503) return 'The Devin lane failed to load on the server.';
    return `The Devin lane answered HTTP ${err.status}.`;
  }
  return 'The Devin lane could not be reached.';
}

export const devinQuery: QueryDef<OptionalRead<DevinOverviewResponse>> = {
  key: DEVIN_KEY,
  fetch: async (signal) => {
    try {
      const value = narrowDevinOverview(await apiGet<unknown>(VERSE_DEVIN_PATH, signal));
      if (value === null) return { value: null, available: true, reason: 'Unrecognized response — update Phantom.' };
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
  if (!token) throw new DevinLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

function settled(): void {
  invalidate(DEVIN_KEY);
  void refreshActivity();
}

/** Metadata only; the shared guarded POST still requires the operator's mutation token. */
export async function refreshDevinConsumption(): Promise<void> {
  try { await post(DEVIN_CONSUMPTION_REFRESH_PATH, {}); }
  finally { invalidate(DEVIN_KEY); }
}

/** Launch one Devin session; resolves only on `ok: true` with a task. */
export async function launchDevinTask(request: DevinLaunchRequest): Promise<DevinLaunchResponse & { task: NonNullable<DevinLaunchResponse['task']> }> {
  try {
    const response = await post<DevinLaunchResponse>(VERSE_DEVIN_LAUNCH_PATH, request);
    if (!isRecord(response) || response.ok !== true || !isRecord(response.task)) {
      const error = isRecord(response) && typeof response.error === 'string' && response.error ? response.error : 'The Devin session was not started, and the server sent no reason.';
      const failure = isRecord(response) && typeof response.failure === 'string' ? (response.failure as DevinFailureCode) : null;
      throw new DevinLaunchRefusedError(error, failure);
    }
    return response as DevinLaunchResponse & { task: NonNullable<DevinLaunchResponse['task']> };
  } finally {
    settled();
  }
}

/** Reply to a waiting session. The id is re-checked before it is spliced into a path. */
export async function messageDevinTask(taskId: string, message: string): Promise<unknown> {
  if (!DEVIN_TASK_ID_PATTERN.test(taskId)) throw new Error('That is not a Devin task id.');
  try {
    return await post<unknown>(`${VERSE_DEVIN_TASKS_PATH}/${taskId}/message`, { message });
  } finally {
    settled();
  }
}
