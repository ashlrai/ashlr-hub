/**
 * data/client.ts — thin typed HTTP client for the existing /api/* surface.
 * No redefinition of response shapes here — callers type each call with the
 * interfaces re-exported from ./api-types.ts.
 */
import { getReadClientProof, reportSessionExpired } from './auth-store.js';
import { isRemoteMobileMode } from './remote-mode.js';

/** Covers the console's two coherent 60s worker reads plus transport/body slack. */
export const METADATA_JSON_READ_TIMEOUT_MS = 150_000;

/** AbortError keeps optional metadata reads' existing cancellation/warm-data contract. */
export class MetadataReadTimeoutError extends DOMException {
  constructor() { super('The read timed out. Try again.', 'AbortError'); }
}

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
 * The plain reason a READ failed, one or two short sentences for a surface to
 * print after its own "X unavailable." Routes that fail a read answer
 * `{ code, error }` with `error` a sentence written for the operator
 * (budget-api.ts, activity-api.ts), which apiGet keeps as `detail`; prefer it
 * over our own "GET … failed (HTTP N)" wrapper, which names a URL instead of
 * the cause. Anything that is not an ApiError gets a fixed sentence: a
 * browser's own exception text ("Failed to fetch", a JSON parser's
 * "Unexpected token <") is not written for a person. Fits ChartFrame's
 * `{ kind: 'unknown', reason }` and a NoticeSlot line alike.
 */
export function readFailureReason(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? `The server answered HTTP ${err.status}.`;
  if (err instanceof MetadataReadTimeoutError) return err.message;
  // fetch() rejects with a TypeError when the request never got an answer.
  if (err instanceof TypeError) return 'The server did not answer.';
  return 'The request failed.';
}

const loadRemote = () => import('./remote-session.js');

/** GET lifetime belongs to this shared read, including its local/phone JSON body. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal!.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new MetadataReadTimeoutError()), METADATA_JSON_READ_TIMEOUT_MS);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const value = await readApiJson<T>(path, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    return value;
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** 401 reports session-expired; the outer lifetime awaits the complete body. */
async function readApiJson<T>(path: string, signal: AbortSignal): Promise<T> {
  if (isRemoteMobileMode()) return await (await loadRemote()).remoteApiGet<T>(path, signal);
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

/** POST uses the caller's mutation token; read authority never supplies it. */
export function apiPost<T>(path: string, body: unknown, mutationToken: string, signal?: AbortSignal): Promise<T> {
  return mutateJson<T>('POST', path, body, mutationToken, signal);
}

/** DELETE retains its empty-body/text-response contract. */
export function apiDelete<T>(path: string, mutationToken: string, signal?: AbortSignal): Promise<T> {
  return mutateJson<T>('DELETE', path, {}, mutationToken, signal);
}

async function mutateJson<T>(method: 'POST' | 'DELETE', path: string, body: unknown, token: string, signal?: AbortSignal): Promise<T> {
  if (isRemoteMobileMode()) return (await loadRemote()).remoteMutate<T>(method, path, body);
  const post = method === 'POST';
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: post ? { 'Content-Type': 'application/json', 'x-ashlr-token': token } : { 'x-ashlr-token': token },
    ...(post ? { body: JSON.stringify(body ?? {}) } : {}), signal,
  });
  if (res.status === 401) throw new ApiError('Mutation token was rejected.', 401, path);
  if (!res.ok) {
    const { detail, code } = await readRefusal(res);
    // A codeless 404 is the dispatch gate; coded route refusals stay ApiError.
    if (res.status === 404 && code === null) throw new DispatchDisabledError(path);
    throw new ApiError(`${method} ${path} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`, res.status, path, detail || null, code);
  }
  if (res.status === 204) return undefined as T;
  if (post) return (await res.json()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A route's own refusal sentence and code, including daemon `note` bodies. */
async function readRefusal(res: Response): Promise<{ detail: string; code: string | null }> {
  try {
    const j = (await res.json()) as { error?: unknown; note?: unknown; message?: unknown; code?: unknown };
    const detail = typeof j.error === 'string' && j.error ? j.error
      : typeof j.note === 'string' && j.note ? j.note
        : typeof j.message === 'string' ? j.message : '';
    return { detail, code: typeof j.code === 'string' && j.code ? j.code : null };
  } catch {
    return { detail: '', code: null };
  }
}

/** Build the SSE URL, carrying the client proof as the query-string proof
 * EventSource can't attach as a header (see server.ts readSessionClientProof). */
export function eventsUrl(): string {
  return `/api/events?client=${encodeURIComponent(getReadClientProof())}`;
}
