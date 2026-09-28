/** Cookie-bound phone session. No Hub read or mutation token enters this module. */
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ApiError } from './client.js';

export interface RemoteSession {
  authenticated: boolean;
  csrfToken: string;
  capabilities: { writes: boolean; pairing: boolean; push: boolean };
  deviceId?: string;
  label?: string;
  scopes?: { read: boolean; act: boolean };
  expiresAt?: number;
}

export class RemoteClientError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'RemoteClientError';
  }
}

let session: RemoteSession | null = null;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSession(value: unknown): RemoteSession {
  if (!record(value) || typeof value.authenticated !== 'boolean'
    || typeof value.csrfToken !== 'string' || value.csrfToken.length < 16 || value.csrfToken.length > 256
    || !record(value.capabilities) || value.capabilities.writes !== true && value.capabilities.writes !== false) {
    throw new RemoteClientError('The phone session answer was incomplete. Nothing was sent.');
  }
  if (!value.authenticated) return {
    authenticated: false, csrfToken: value.csrfToken,
    capabilities: { writes: false, pairing: value.capabilities.pairing === true, push: value.capabilities.push === true },
  };
  const scopes = value.scopes;
  if (typeof value.deviceId !== 'string' || !value.deviceId || typeof value.label !== 'string'
    || !record(scopes) || scopes.read !== true || typeof scopes.act !== 'boolean'
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new RemoteClientError('The paired device session could not be verified. Nothing was sent.');
  }
  return {
    authenticated: true, csrfToken: value.csrfToken,
    capabilities: { writes: value.capabilities.writes === true, pairing: value.capabilities.pairing === true, push: value.capabilities.push === true },
    deviceId: value.deviceId, label: value.label, scopes: { read: true, act: scopes.act }, expiresAt: value.expiresAt,
  };
}

async function jsonResponse(res: Response): Promise<unknown> {
  if (res.type === 'opaqueredirect' || res.status >= 300 && res.status < 400
    || res.headers.get('content-type')?.includes('text/html')) {
    session = null;
    (await import('./auth-store.js')).reportSessionExpired();
    throw new RemoteClientError('Cloudflare Access sign-in expired. Reload this page to sign in again.', 401);
  }
  if (res.status === 401) {
    session = null;
    (await import('./auth-store.js')).reportSessionExpired();
    throw new RemoteClientError('Phone sign-in expired. Reload to sign in again.', 401);
  }
  let value: unknown;
  try { value = await res.json(); } catch { throw new RemoteClientError('The phone gateway did not return JSON.', res.status); }
  if (!res.ok) {
    const message = record(value) && typeof value.error === 'string' ? value.error.slice(0, 240) : 'The phone gateway refused the request.';
    throw new RemoteClientError(message, res.status);
  }
  return value;
}

async function remoteGet(path: string): Promise<unknown> {
  const res = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
  return jsonResponse(res);
}

/** Remote API reads use only the paired cookie; Access HTML/redirect locks UI. */
export async function remoteApiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal });
  if (res.type === 'opaqueredirect' || res.status >= 300 && res.status < 400
    || res.headers.get('content-type')?.includes('text/html')) {
    session = null;
    (await import('./auth-store.js')).reportSessionExpired();
    throw new ApiError('Cloudflare Access sign-in expired. Reload to sign in again.', 401, path);
  }
  if (res.status === 401) {
    (await import('./auth-store.js')).reportSessionExpired();
    throw new ApiError('Phone session expired.', 401, path);
  }
  if (!res.ok) {
    let detail: string | null = null;
    let code: string | null = null;
    try {
      const value = await res.json() as { error?: unknown; code?: unknown };
      if (typeof value.error === 'string') detail = value.error;
      if (typeof value.code === 'string') code = value.code;
    } catch { /* a non-JSON refusal */ }
    throw new ApiError(`GET ${path} failed (HTTP ${res.status}).`, res.status, path, detail, code);
  }
  return await res.json() as T;
}

async function remotePost(path: string, body: unknown): Promise<unknown> {
  const csrf = session?.csrfToken;
  if (!csrf) throw new RemoteClientError('Connect this phone to the gateway before continuing.');
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'x-ashlr-remote-csrf': csrf },
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 204) return null;
  return jsonResponse(res);
}

/** A fresh cookie and CSRF token come from the gateway, never browser storage. */
export async function probeRemoteSession(): Promise<RemoteSession> {
  session = null;
  const next = parseSession(await remoteGet('/remote/session'));
  session = next;
  return next;
}

export function canRemoteWrite(): boolean {
  return session?.authenticated === true && session.scopes?.act === true && session.capabilities.writes
    && typeof session.expiresAt === 'number' && Date.now() + 5_000 < session.expiresAt;
}

export function currentRemoteSession(): RemoteSession | null { return session; }

export function clearRemoteSessionForTest(): void { session = null; }

function challenge(value: unknown): { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON } {
  if (!record(value) || typeof value.challengeId !== 'string' || !value.challengeId || !record(value.options)
    || typeof value.options.challenge !== 'string') {
    throw new RemoteClientError('The passkey challenge was incomplete. Nothing was sent.');
  }
  return { challengeId: value.challengeId, options: value.options as unknown as PublicKeyCredentialRequestOptionsJSON };
}

export async function claimRemotePairing(code: string, label: string): Promise<{ pendingId: string }> {
  const started = await remotePost('/remote/pair/claim', { code: code.trim(), label: label.trim() });
  if (!record(started) || typeof started.pendingId !== 'string' || !started.pendingId || !record(started.options)
    || typeof started.options.challenge !== 'string') {
    throw new RemoteClientError('The pairing challenge was incomplete. Nothing was sent.');
  }
  const { startRegistration } = await import('@simplewebauthn/browser');
  const response = await startRegistration({ optionsJSON: started.options as unknown as PublicKeyCredentialCreationOptionsJSON });
  const completed = await remotePost('/remote/pair/complete', { pendingId: started.pendingId, response });
  if (!record(completed) || completed.pendingApproval !== true) {
    throw new RemoteClientError('Pairing still needs approval on your Mac.');
  }
  return { pendingId: started.pendingId };
}

export async function remotePairStatus(pendingId: string): Promise<{ state: 'pending' | 'approved' | 'denied'; deviceId?: string }> {
  const value = await remoteGet(`/remote/pair/status?pendingId=${encodeURIComponent(pendingId)}`);
  if (!record(value) || value.state !== 'pending' && value.state !== 'approved' && value.state !== 'denied') {
    throw new RemoteClientError('The pairing status was incomplete.');
  }
  if (value.state === 'approved') {
    if (typeof value.deviceId !== 'string' || !value.deviceId) throw new RemoteClientError('The approved device ID was missing.');
    return { state: 'approved', deviceId: value.deviceId };
  }
  return { state: value.state };
}

export async function authenticateRemoteDevice(deviceId: string): Promise<RemoteSession> {
  const started = challenge(await remotePost('/remote/auth/begin', { deviceId }));
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const response = await startAuthentication({ optionsJSON: started.options });
  const next = parseSession(await remotePost('/remote/auth/finish', { challengeId: started.challengeId, response }));
  if (!next.authenticated || next.deviceId !== deviceId) throw new RemoteClientError('The passkey sign-in did not complete.');
  session = next;
  return next;
}

export async function logoutRemoteDevice(): Promise<void> {
  await remotePost('/remote/logout', {});
  session = null;
}

/** Push is dormant until the gateway explicitly advertises and mounts it. */
export async function subscribeRemotePush(subscription: PushSubscription): Promise<void> {
  if (session?.authenticated !== true || session.capabilities.push !== true) {
    throw new RemoteClientError('Phone notifications are not enabled by this gateway.');
  }
  await remotePost('/remote/push/subscribe', subscription.toJSON());
}

export async function remotePushPublicKey(): Promise<string> {
  if (session?.authenticated !== true || session.capabilities.push !== true) {
    throw new RemoteClientError('Phone notifications are not enabled by this gateway.');
  }
  const value = await remoteGet('/remote/push/config');
  if (!record(value) || typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{80,120}$/.test(value.publicKey)) {
    throw new RemoteClientError('The gateway push key is unavailable.');
  }
  return value.publicKey;
}

/** A server capability enables this later; stage 3 returns writes:false. */
export async function remoteMutate<T>(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<T> {
  if (!canRemoteWrite()) throw new RemoteClientError(session?.authenticated && typeof session.expiresAt === 'number'
    && session.expiresAt <= Date.now() + 5_000
    ? 'The phone session is refreshing. No action was sent.'
    : 'This gateway is read-only. No action was sent.');
  if (method === 'POST' && directCsrfWrite(path)) return await remotePost(path, body) as T;
  const bytes = JSON.stringify(body ?? {});
  const operation = { method, path, body: bytes };
  const started = challenge(await remotePost('/remote/step-up/begin', operation));
  const { startAuthentication } = await import('@simplewebauthn/browser');
  const response = await startAuthentication({ optionsJSON: started.options });
  const result = await remotePost('/remote/step-up/finish', { ...operation, challengeId: started.challengeId, response });
  return result as T;
}

/** Mirrors only gateway routes classified low-risk; unknown paths step up. */
export function directCsrfWrite(path: string): boolean {
  return path === '/api/verse/activity/seen'
    || path === '/api/verse/sessions'
    || path === '/api/verse/leader/thread'
    || path === '/api/verse/leader/directives'
    || /^\/api\/verse\/sessions\/[^/?#]+\/turns$/.test(path)
    || /^\/api\/verse\/queue\/[^/?#]+$/.test(path)
    || /^\/api\/verse\/leader\/questions\/[^/?#]+\/answer$/.test(path)
    || /^\/api\/verse\/(cloud|devin)\/tasks\/[^/?#]+\/dismiss$/.test(path);
}
