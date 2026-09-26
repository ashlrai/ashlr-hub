/**
 * data/client.ts — thin typed HTTP client for the existing /api/* surface.
 * No redefinition of response shapes here — callers type each call with the
 * interfaces re-exported from ./api-types.ts.
 */
import { getReadClientProof, reportSessionExpired } from './auth-store.js';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    /**
     * The server's own sentence about the refusal, when it sent one, without
     * the "POST … failed (HTTP N)" wrapper. A surface that wants to show the
     * operator why an action was refused should prefer this over `message`:
     * it is the text the route author wrote for a person to read.
     */
    public readonly detail: string | null = null,
    /**
     * The route's machine-readable refusal code (`VERSE_SESSION_NOT_FOUND`,
     * `VERSE_SESSION_BUSY`, …) when the body carried one; null otherwise. Lets a
     * caller branch on WHAT was refused without parsing the sentence.
     */
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Raised for the 404 a mutation route answers when --allow-dispatch is off.
 *
 * That gate answers a bare `{ error: 'not found' }` — deliberately the same
 * body as a route that does not exist, so a read-only server does not
 * advertise its write surface. A route that DOES exist and refuses with a 404
 * of its own ("session not found") says so with a `code`; apiPost keeps those
 * as plain ApiErrors, so a deleted chat is never reported as "this server is
 * read-only".
 */
export class DispatchDisabledError extends ApiError {
  constructor(path: string) {
    super('This server was started without --allow-dispatch, so mutations are disabled.', 404, path);
    this.name = 'DispatchDisabledError';
  }
}

/**
 * The plain reason a READ failed, for a surface to print after "Could not
 * read X:". Routes that fail a read answer `{ code, error }` with `error` a
 * sentence written for the operator (budget-api.ts, activity-api.ts), which
 * apiGet keeps as `detail`; prefer it over our own "GET … failed (HTTP N)"
 * wrapper, which names a URL instead of the cause. Fits ChartFrame's
 * `{ kind: 'unknown', reason }` and a NoticeSlot line alike.
 */
export function readFailureReason(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? `The server answered HTTP ${err.status}.`;
  if (err instanceof Error && err.message) return err.message;
  return 'The request failed.';
}

/** GET an authenticated read route. 401 reports session-expired and throws. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': getReadClientProof() },
    signal,
  });
  if (res.status === 401) {
    reportSessionExpired();
    throw new ApiError('Read session expired.', 401, path);
  }
  if (!res.ok) {
    // Keep the route's own sentence and code (e.g. the grant draft's
    // `no-trust-roots`) so a reader can branch on WHAT was refused.
    const { detail, code } = await readRefusal(res);
    throw new ApiError(`GET ${path} failed (HTTP ${res.status}).`, res.status, path, detail || null, code);
  }
  return (await res.json()) as T;
}

/**
 * POST a mutating route with the raw mutation token. `mutationToken` must
 * come from the caller (data/mutations.ts pulls it from auth-store) — this
 * function does not read auth-store itself so it stays trivially testable.
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  mutationToken: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-ashlr-token': mutationToken,
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (res.status === 401) {
    throw new ApiError('Mutation token was rejected.', 401, path);
  }
  if (!res.ok) {
    const { detail, code } = await readRefusal(res);
    // Only a CODELESS 404 is the dispatch gate (see DispatchDisabledError).
    // An unknown sub-path on an older server is codeless too and lands here
    // as well — the two are indistinguishable by design, so callers that
    // word this error must not assert which one it was.
    if (res.status === 404 && code === null) {
      throw new DispatchDisabledError(path);
    }
    throw new ApiError(
      `POST ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`,
      res.status,
      path,
      detail || null,
      code,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The refusal sentence and code from a failed POST's body, if it had any.
 *
 * `error` is the documented refusal field, but the Verse control plane
 * answers a refused daemon/scope action with a full result body whose
 * plain-language sentence lives in `note` and which has NO `error` key at all
 * (see VerseDaemonActionResult). Reading only `error` threw away sentences
 * like "no repositories are enrolled, so the loop would do nothing" and left
 * the caller with a bare status code to guess from.
 */
async function readRefusal(res: Response): Promise<{ detail: string; code: string | null }> {
  try {
    const j = (await res.json()) as { error?: unknown; note?: unknown; code?: unknown };
    const detail = typeof j.error === 'string' && j.error ? j.error : typeof j.note === 'string' ? j.note : '';
    const code = typeof j.code === 'string' && j.code ? j.code : null;
    return { detail, code };
  } catch {
    /* body wasn't JSON */
    return { detail: '', code: null };
  }
}

/** Build the SSE URL, carrying the client proof as the query-string proof
 * EventSource can't attach as a header (see server.ts readSessionClientProof). */
export function eventsUrl(): string {
  return `/api/events?client=${encodeURIComponent(getReadClientProof())}`;
}
