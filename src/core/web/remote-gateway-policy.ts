/**
 * Policy for a future phone gateway. This module is deliberately not mounted by
 * the Hub server: a remote browser must never reach the local token prompt,
 * desktop assets, or the general /api/* router through an early gateway build.
 */
import { timingSafeEqual } from 'node:crypto';

export interface RemoteRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export type RemoteReadRoute =
  | '/api/verse/bootstrap'
  | '/api/verse/activity'
  | '/api/verse/sessions'
  | '/api/verse/control'
  | '/api/verse/fleet/live'
  | '/api/verse/authority'
  | '/api/verse/budget';

const READ_ROUTES = new Set<RemoteReadRoute>([
  '/api/verse/bootstrap',
  '/api/verse/activity',
  '/api/verse/sessions',
  '/api/verse/control',
  '/api/verse/fleet/live',
  '/api/verse/authority',
  '/api/verse/budget',
]);

export type RemoteRouteDecision = { kind: 'read'; path: RemoteReadRoute } | { kind: 'deny' };

/** Exact, query-free reads only. Every future route needs its own reviewed shape. */
export function classifyRemoteRoute(method: string | undefined, rawTarget: string | undefined): RemoteRouteDecision {
  if (method !== 'GET' || !rawTarget || !rawTarget.startsWith('/')) return { kind: 'deny' };
  // Reject alternate URL spellings before URL normalization can hide them.
  if (/[?#%\\]/.test(rawTarget) || rawTarget.includes('//')
    || [...rawTarget].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return { kind: 'deny' };
  if (rawTarget.split('/').some((segment) => segment === '.' || segment === '..')) return { kind: 'deny' };
  return READ_ROUTES.has(rawTarget as RemoteReadRoute)
    ? { kind: 'read', path: rawTarget as RemoteReadRoute }
    : { kind: 'deny' };
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RemoteEnvelopeDecision = { ok: true } | { ok: false; reason: 'host' | 'origin' | 'csrf' | 'hub-token' };

/**
 * Check the public origin before dispatch. `csrfSecret` will come from a paired
 * device's server-side session; leaving it absent denies every unsafe method.
 */
export function checkRemoteEnvelope(
  request: RemoteRequest,
  publicOrigin: string,
  csrfSecret?: string,
): RemoteEnvelopeDecision {
  let expected: URL;
  try { expected = new URL(publicOrigin); } catch { return { ok: false, reason: 'host' }; }
  if (expected.protocol !== 'https:' || expected.origin !== publicOrigin || !expected.hostname) return { ok: false, reason: 'host' };
  if (oneHeader(request.headers.host) !== expected.host) return { ok: false, reason: 'host' };
  // Hub's local read/mutation credentials are never valid on a remote request.
  if (request.headers['x-ashlr-token'] !== undefined || request.headers['x-ashlr-read-client'] !== undefined) {
    return { ok: false, reason: 'hub-token' };
  }
  const origin = request.headers.origin;
  if (origin !== undefined && oneHeader(origin) !== publicOrigin) return { ok: false, reason: 'origin' };
  if (request.method === 'GET' || request.method === 'HEAD') return { ok: true };
  if (origin === undefined || oneHeader(origin) !== publicOrigin) return { ok: false, reason: 'origin' };
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && oneHeader(site) !== 'same-origin') return { ok: false, reason: 'origin' };
  const proof = oneHeader(request.headers['x-ashlr-remote-csrf']);
  if (!csrfSecret || !proof || !equalSecret(proof, csrfSecret)) return { ok: false, reason: 'csrf' };
  return { ok: true };
}
