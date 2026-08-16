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
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised specifically for 404s on mutation routes: --allow-dispatch is off. */
export class DispatchDisabledError extends ApiError {
  constructor(path: string) {
    super('This server was started without --allow-dispatch, so mutations are disabled.', 404, path);
    this.name = 'DispatchDisabledError';
  }
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
    throw new ApiError(`GET ${path} failed (HTTP ${res.status}).`, res.status, path);
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
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-ashlr-token': mutationToken,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 404) {
    throw new DispatchDisabledError(path);
  }
  if (res.status === 401) {
    throw new ApiError('Mutation token was rejected.', 401, path);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ? `: ${j.error}` : '';
    } catch {
      /* body wasn't JSON */
    }
    throw new ApiError(`POST ${path} failed (HTTP ${res.status})${detail}.`, res.status, path);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Build the SSE URL, carrying the client proof as the query-string proof
 * EventSource can't attach as a header (see server.ts readSessionClientProof). */
export function eventsUrl(): string {
  return `/api/events?client=${encodeURIComponent(getReadClientProof())}`;
}
