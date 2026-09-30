import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateRemoteDevice, canRemoteWrite, claimRemotePairing, clearRemoteSessionForTest, directCsrfWrite, probeRemoteSession, remotePairStatus,
  remoteMutate, remotePushPublicKey, subscribeRemotePush, logoutRemoteDevice, remoteApiGet,
} from './remote-session.js';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'passkey' })),
  startRegistration: vi.fn(async () => ({ id: 'new-passkey' })),
}));

afterEach(() => { clearRemoteSessionForTest(); vi.unstubAllGlobals(); });

const csrfToken = 'c'.repeat(40);
const ready = { authenticated: true, deviceId: 'device-1', label: 'My phone',
  scopes: { read: true, act: true }, csrfToken, expiresAt: Date.now() + 60_000,
  capabilities: { pairing: true, writes: false, push: false } };

describe('remote phone session', () => {
  it('keeps the valid session while checking, and a late check cannot restore it after logout', async () => {
    let answer!: (response: Response) => void;
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path !== '/remote/session') return new Response(null, { status: 204 });
      if (++probes === 1) return Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } });
      return new Promise<Response>((resolve) => { answer = resolve; });
    }));
    await probeRemoteSession();
    const checking = probeRemoteSession();
    expect(canRemoteWrite()).toBe(true);
    await logoutRemoteDevice();
    expect(canRemoteWrite()).toBe(false);
    answer(Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } }));
    await expect(checking).rejects.toThrow('session changed');
    expect(canRemoteWrite()).toBe(false);
  });

  it('does not let a slower earlier check overwrite a newer read-only session', async () => {
    let answer!: (response: Response) => void;
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++probes === 1
      ? new Promise<Response>((resolve) => { answer = resolve; }) : Response.json(ready)));
    const older = probeRemoteSession();
    await probeRemoteSession();
    answer(Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } }));
    await expect(older).rejects.toThrow('session changed');
    expect(canRemoteWrite()).toBe(false);
  });

  it('ignores an older read refusal after a newer authenticated session check', async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/remote/session'
      ? Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } })
      : new Promise<Response>((resolve) => { answer = resolve; })));
    await probeRemoteSession();
    const reading = remoteApiGet('/api/verse/bootstrap');
    await probeRemoteSession();
    answer(Response.json({ error: 'Old cookie expired' }, { status: 401 }));
    await expect(reading).rejects.toThrow('expired');
    expect(canRemoteWrite()).toBe(true);
  });

  it('does not restore authority when a passkey response completes after logout', async () => {
    let answer!: (response: Response) => void;
    let finishing!: () => void;
    const pendingFinish = new Promise<void>((resolve) => { finishing = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/remote/session') return Response.json({ ...ready, authenticated: false });
      if (path === '/remote/auth/begin') return Response.json({ challengeId: 'auth', options: { challenge: 'YQ' } });
      if (path === '/remote/auth/finish') {
        finishing();
        return new Promise<Response>((resolve) => { answer = resolve; });
      }
      return new Response(null, { status: 204 });
    }));
    await probeRemoteSession();
    const signingIn = authenticateRemoteDevice('device-1');
    await pendingFinish;
    await logoutRemoteDevice();
    answer(Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } }));
    await expect(signingIn).rejects.toThrow('session changed');
    expect(canRemoteWrite()).toBe(false);
  });

  it('requires a complete gateway answer and keeps writes closed when advertised read-only', async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json(ready));
    vi.stubGlobal('fetch', fetch);
    expect((await probeRemoteSession()).authenticated).toBe(true);
    expect(canRemoteWrite()).toBe(false);
    await expect(remoteMutate('POST', '/api/verse/agents', {})).rejects.toThrow('read-only');
    await expect(remotePushPublicKey()).rejects.toThrow('not enabled');
    await expect(subscribeRemotePush({ toJSON: () => ({}) } as PushSubscription)).rejects.toThrow('not enabled');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/remote/session');
  });

  it('rejects malformed or incomplete scopes rather than opening a shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...ready, scopes: { read: true } })));
    await expect(probeRemoteSession()).rejects.toThrow('could not be verified');
    expect(canRemoteWrite()).toBe(false);
  });

  it('sends only exact low-risk routes directly with CSRF and no passkey ceremony', async () => {
    expect(directCsrfWrite('/api/verse/sessions/vs_1/turns')).toBe(true);
    expect(directCsrfWrite('/api/verse/cloud/tasks/t1/land')).toBe(false);
    expect(directCsrfWrite('/api/verse/agents/ag_12345678/plan')).toBe(false);
    expect(directCsrfWrite('/api/verse/queue/vs_1/012345abcdef/send')).toBe(false);
    expect(directCsrfWrite('/api/verse/authority/clear-stop')).toBe(false);
    expect(directCsrfWrite('/api/verse/sessions/vs_1/turns?force=true')).toBe(false);
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      return path === '/remote/session'
        ? Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } })
        : Response.json({ sent: true });
    }));
    await probeRemoteSession();
    await expect(remoteMutate('POST', '/api/verse/sessions/vs_1/turns', { text: 'hello' })).resolves.toEqual({ sent: true });
    expect(calls.map((call) => call.path)).toEqual(['/remote/session', '/api/verse/sessions/vs_1/turns']);
    expect(new Headers(calls[1]!.init.headers).get('x-ashlr-remote-csrf')).toBe(csrfToken);
    expect(new Headers(calls[1]!.init.headers).has('x-ashlr-token')).toBe(false);
  });

  it('expires write capability before the server session deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...ready, expiresAt: Date.now() + 2_000, capabilities: { ...ready.capabilities, writes: true } })));
    await probeRemoteSession();
    expect(canRemoteWrite()).toBe(false);
    await expect(remoteMutate('POST', '/api/verse/activity/seen', {})).rejects.toThrow('refreshing');
  });

  it('uses a single exact JSON body for one passkey-bound operation and never sends Hub token headers', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      if (path === '/remote/session') return Response.json({ ...ready, capabilities: { ...ready.capabilities, writes: true } });
      if (path === '/remote/step-up/begin') return Response.json({ challengeId: 'challenge-1', options: { challenge: 'YQ', timeout: 60000 } });
      if (path === '/remote/step-up/finish') return Response.json({ ok: true });
      throw new Error(`unexpected ${path}`);
    }));
    await probeRemoteSession();
    await expect(remoteMutate('POST', '/api/verse/agents/ag_12345678/plan', { action: 'approve' })).resolves.toEqual({ ok: true });
    const begin = JSON.parse(String(calls[1]!.init.body));
    const finish = JSON.parse(String(calls[2]!.init.body));
    expect(begin.path).toBe('/api/verse/agents/ag_12345678/plan');
    expect(begin.body).toBe('{"action":"approve"}');
    expect(finish.body).toBe(begin.body);
    expect(finish.challengeId).toBe('challenge-1');
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('x-ashlr-remote-csrf')).toBe(csrfToken);
      expect(headers.has('x-ashlr-token')).toBe(false);
      expect(headers.has('x-ashlr-read-client')).toBe(false);
    }
  });

  it('pairs and signs in only through CSRF-bound passkey requests', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      switch (path) {
        case '/remote/session': return Response.json({ authenticated: false, csrfToken, capabilities: { pairing: true, writes: false } });
        case '/remote/pair/claim': return Response.json({ pendingId: 'pending-1', options: { challenge: 'YQ' } });
        case '/remote/pair/complete': return Response.json({ pendingApproval: true });
        case '/remote/pair/status?pendingId=pending-1': return Response.json({ state: 'approved', deviceId: 'device-1' });
        case '/remote/auth/begin': return Response.json({ challengeId: 'auth-1', options: { challenge: 'YQ' } });
        case '/remote/auth/finish': return Response.json(ready);
        default: throw new Error(`unexpected ${path}`);
      }
    }));
    await probeRemoteSession();
    await expect(claimRemotePairing(' code ', ' My phone ')).resolves.toEqual({ pendingId: 'pending-1' });
    await expect(remotePairStatus('pending-1')).resolves.toEqual({ state: 'approved', deviceId: 'device-1' });
    await expect(authenticateRemoteDevice('device-1')).resolves.toMatchObject({ authenticated: true, deviceId: 'device-1' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ code: 'code', label: 'My phone' });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ pendingId: 'pending-1', response: { id: 'new-passkey' } });
    expect(JSON.parse(String(calls[5]!.init.body))).toMatchObject({ challengeId: 'auth-1', response: { id: 'passkey' } });
    for (const call of calls.filter((entry) => entry.init.method === 'POST')) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('x-ashlr-remote-csrf')).toBe(csrfToken);
      expect(headers.has('x-ashlr-token')).toBe(false);
      expect(headers.has('x-ashlr-read-client')).toBe(false);
    }
  });

  it('removes this device’s push subscription before signing out', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      if (path === '/remote/session') return Response.json({ ...ready, capabilities: { pairing: true, writes: true, push: true } });
      if (path === '/remote/push/subscribe' || path === '/remote/logout') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    }));
    await probeRemoteSession();
    expect(canRemoteWrite()).toBe(true);
    await logoutRemoteDevice();
    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ['GET', '/remote/session'], ['DELETE', '/remote/push/subscribe'], ['POST', '/remote/logout'],
    ]);
    for (const call of calls.slice(1)) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('x-ashlr-remote-csrf')).toBe(csrfToken);
      expect(headers.has('x-ashlr-token')).toBe(false);
    }
    expect(canRemoteWrite()).toBe(false);
  });

  it('continues logout after push removal fails and drops local authority even offline', async () => {
    const calls: string[] = [];
    let offline = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      calls.push(path);
      if (path === '/remote/session') return Response.json({ ...ready, capabilities: { pairing: true, writes: true, push: true } });
      if (path === '/remote/push/subscribe') throw new Error('network down');
      if (path === '/remote/logout' && !offline) return new Response(null, { status: 204 });
      throw new Error('network down');
    }));
    await probeRemoteSession();
    await expect(logoutRemoteDevice()).resolves.toBeUndefined();
    expect(calls).toEqual(['/remote/session', '/remote/push/subscribe', '/remote/logout']);
    expect(canRemoteWrite()).toBe(false);

    await probeRemoteSession();
    offline = true;
    await expect(logoutRemoteDevice()).rejects.toThrow('network down');
    expect(calls.slice(3)).toEqual(['/remote/session', '/remote/push/subscribe', '/remote/logout']);
    expect(canRemoteWrite()).toBe(false);
  });
});
