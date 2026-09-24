/**
 * routes/verse/apps/apps-queries.ts — the reads and writes behind Apps &
 * Accounts (server: core/verse/apps-api.ts; C4's terminal for availability).
 *
 * Reads are OPTIONAL (the Usage/MCP convention): a server without the route
 * answers 404, which means "this group has no source here", not "Verse is
 * broken" — the page still renders Accounts and MCP from their own routes.
 * A 401 still propagates: an expired read session is the whole surface's
 * problem, not one group's.
 *
 * Writes pull the held mutation token and touch the hold on success. Nothing
 * here spends: refresh re-runs status commands, and toggle/launch open a
 * visible Terminal window that the operator drives.
 */
import type { VerseAppsResponse, VerseTerminalListResponse } from '../../../../core/verse/workbench-types.js';
import { VERSE_APPS_PATH, VERSE_TERMINAL_PATH } from '../../../../core/verse/workbench-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { oneShotFetcher } from '../health/health-queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const APPS_KEY = 'verse-apps';
export const TERMINAL_STATUS_KEY = 'verse-terminal-status';

export type OptionalResult<T> =
  | { available: true; data: T }
  | { available: false; reason: string };

async function optional<T>(path: string, signal?: AbortSignal): Promise<OptionalResult<T>> {
  try {
    return { available: true, data: await apiGet<T>(path, signal) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ApiError && err.status === 404) {
      return { available: false, reason: 'This server is older than Apps & Accounts, so desktop, terminal and local rows are not available.' };
    }
    return { available: false, reason: err instanceof ApiError ? `The apps check answered HTTP ${err.status}.` : 'The apps check could not be reached.' };
  }
}

/** GET /api/verse/apps — cached on the server; cheap to read. */
export const appsQuery: QueryDef<OptionalResult<VerseAppsResponse>> = {
  key: APPS_KEY,
  fetch: (signal) => optional<VerseAppsResponse>(VERSE_APPS_PATH, signal),
};

/**
 * GET /api/verse/terminal (C4). Only `available` matters here: whether a
 * Launch can open INSIDE Verse (the desktop app's Bun PTY) or has to go to
 * Terminal.app. Absent route = not available.
 */
export const terminalStatusQuery: QueryDef<OptionalResult<VerseTerminalListResponse>> = {
  key: TERMINAL_STATUS_KEY,
  fetch: (signal) => optional<VerseTerminalListResponse>(VERSE_TERMINAL_PATH, signal),
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** Re-ask the login shell for PATH and re-probe every row; every reader sees the result. */
export async function refreshApps(): Promise<VerseAppsResponse> {
  const body = await post<VerseAppsResponse>(`${VERSE_APPS_PATH}/refresh`, {});
  await refetchQuery(
    APPS_KEY,
    oneShotFetcher(() => Promise.resolve({ available: true as const, data: body }), () => appsQuery.fetch()),
    true,
  );
  return body;
}

export interface AppActionResponse {
  ok: true;
  opened: 'terminal-app';
  /** The command as the operator would type it. */
  command: string[];
}

/**
 * Flip a desktop switch. `confirm: true` is sent ONLY from the confirmation
 * dialog, after the operator saw both commands; the server refuses anything
 * else.
 */
export async function toggleDesktopApp(appId: string, enabled: boolean): Promise<AppActionResponse> {
  const result = await post<AppActionResponse>(`${VERSE_APPS_PATH}/${encodeURIComponent(appId)}/toggle`, { enabled, confirm: true });
  void refetchQuery(APPS_KEY, () => appsQuery.fetch(), true);
  return result;
}

export interface LaunchInTerminalAppRequest {
  root: string;
  via?: 'native' | 'ollama';
  model?: string | null;
}

/** Open the agent in a Terminal.app window, in `root`. */
export function launchInTerminalApp(appId: string, request: LaunchInTerminalAppRequest): Promise<AppActionResponse> {
  return post<AppActionResponse>(`${VERSE_APPS_PATH}/${encodeURIComponent(appId)}/launch`, {
    root: request.root,
    ...(request.via ? { via: request.via } : {}),
    ...(request.model ? { model: request.model } : {}),
  });
}
