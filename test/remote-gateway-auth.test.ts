import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateAuthenticationOptions, generateRegistrationOptions,
  type VerifiedAuthenticationResponse, type VerifiedRegistrationResponse } from '@simplewebauthn/server';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore } from '../src/core/web/remote-device-store.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';
import { remoteAdminSocketPath, sendRemoteAdminCommand, startRemoteAdminSocket } from '../src/core/web/remote-admin.js';
import { createRemotePush } from '../src/core/web/remote-push.js';
import { loadOrCreateRemoteVapid } from '../src/core/web/remote-push-vapid.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const READ_TOKEN = 'a'.repeat(64);
const ACT_TOKEN = 'c'.repeat(64);
const CRED_ID = randomBytes(32).toString('base64url');
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const roots: string[] = [];
const servers = new Set<Server>();
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  servers.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

async function setup(mobileAssets = false, withPush = false) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-auth-'));
  roots.push(root);
  const devices = createRemoteDeviceStore(root);
  const push = withPush ? createRemotePush(loadOrCreateRemoteVapid(ORIGIN, root), devices, { root }) : undefined;
  if (mobileAssets) {
    mkdirSync(join(root, 'next', 'assets'), { recursive: true });
    writeFileSync(join(root, 'next', 'index.html'), '<!doctype html><html><head></head><body><script src="/next/assets/index-ABCDEFGH.js"></script></body></html>');
    writeFileSync(join(root, 'next', 'assets', 'index-ABCDEFGH.js'), 'export {};');
  }
  const verifyRegistrationResponse = vi.fn(async () => ({ verified: true, registrationInfo: {
    credential: { id: CRED_ID, publicKey: randomBytes(80), counter: 0, transports: ['internal'] },
    userVerified: true, credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
  } }) as unknown as Promise<VerifiedRegistrationResponse>);
  const verifyAuthenticationResponse = vi.fn(async () => ({ verified: true, authenticationInfo: {
    credentialID: CRED_ID, newCounter: 0, userVerified: true,
    credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
  } }) as unknown as Promise<VerifiedAuthenticationResponse>);
  const pairing = createRemotePairing(CONFIG, devices, { webauthn: {
    generateAuthenticationOptions, generateRegistrationOptions, verifyRegistrationResponse, verifyAuthenticationResponse,
  } });
  const mutations: { path: string; body: string; headers: Record<string, unknown> }[] = [];
  const hub = createServer(async (req, res) => {
    if (req.method === 'POST' && req.headers['x-ashlr-token'] === ACT_TOKEN) {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      mutations.push({ path: req.url ?? '', body, headers: { ...req.headers } });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ accepted: true })); return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  servers.add(hub);
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const jwt = await new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(SUBJECT).setIssuedAt().setNotBefore('0s').setExpirationTime('10m').sign(privateKey);
  const gateway = await startRemoteReadGateway({ access: CONFIG, hub: { port: (hub.address() as { port: number }).port,
    readToken: READ_TOKEN, mutationToken: ACT_TOKEN }, devices, pairing, push, verifier,
    ...(mobileAssets ? { assetsDir: root, mobileAssetsEnabled: true } : {}) });
  async function send(method: string, path: string, cookie = '', csrf = '', body?: unknown, override: Record<string, string> = {}) {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { host: 'phone.example.com', 'cf-access-jwt-assertion': jwt,
      ...(cookie ? { cookie } : {}), ...(csrf ? { origin: ORIGIN, 'x-ashlr-remote-csrf': csrf } : {}),
      ...(bytes !== undefined ? { 'content-type': 'application/json' } : {}), ...override };
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, { method, headers }, (incoming) => {
        resolve(new Response(incoming.statusCode === 204 ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode, headers: incoming.headers as HeadersInit,
        }));
      });
      outgoing.on('error', reject); outgoing.end(bytes);
    });
  }
  return { gateway, pairing, devices, push, mutations, send, verifyAuthenticationResponse, root };
}

describe('remote pairing and one-use WebAuthn HTTP writes', () => {
  it('recovers a private admin socket left by SIGKILL but refuses a live listener or file', async () => {
    // Keep the Unix socket below Darwin's path limit even when the test
    // runner supplies a deeply nested private TMPDIR.
    const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ashlr-remote-admin-restart-'));
    roots.push(root);
    const path = remoteAdminSocketPath(root);
    const devices = createRemoteDeviceStore(root);
    const pairing = createRemotePairing(CONFIG, devices);
    const killed = spawnSync(process.execPath, ['-e', `
      const net = require('node:net');
      const fs = require('node:fs');
      net.createServer().listen(process.argv[1], () => {
        fs.chmodSync(process.argv[1], 0o600);
        process.kill(process.pid, 'SIGKILL');
      });
    `, path], { timeout: 5_000 });
    expect(killed.signal).toBe('SIGKILL');
    expect(lstatSync(path).isSocket()).toBe(true);
    const restarted = await startRemoteAdminSocket(pairing, devices, root, async () => false);
    try {
      expect(await sendRemoteAdminCommand({ action: 'pending' }, root)).toEqual({ approvals: [] });
    } finally { await restarted.close(); }

    const live = createNetServer();
    await new Promise<void>((resolve) => live.listen(path, resolve));
    chmodSync(path, 0o600);
    try {
      await expect(startRemoteAdminSocket(pairing, devices, root, async () => false))
        .rejects.toThrow(/live listener/);
      expect(lstatSync(path).isSocket()).toBe(true);
    } finally { await new Promise<void>((resolve) => live.close(() => resolve())); }

    writeFileSync(path, 'operator data', { mode: 0o600 });
    await expect(startRemoteAdminSocket(pairing, devices, root, async () => false))
      .rejects.toThrow(/not a private owned socket/);
    expect(lstatSync(path).isFile()).toBe(true);
  });

  it('serves only the marked mobile shell and hashed assets to an Access user before pairing', async () => {
    const f = await setup(true);
    try {
      const shell = await f.send('GET', '/verse/m/');
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('<meta name="ashlr-remote-gateway" content="v1">');
      expect((await f.send('GET', '/next/assets/index-ABCDEFGH.js')).status).toBe(200);
      expect((await f.send('GET', '/next/index.html')).status).toBe(401);
      expect((await f.send('GET', '/api/verse/activity')).status).toBe(401);
    } finally { await f.gateway.close(); }
  });

  it('keeps Mac approval on a private Unix socket, never a remote HTTP route', async () => {
    const f = await setup();
    const confirmation = { allow: false };
    const confirmMac = vi.fn(async () => confirmation.allow);
    const admin = await startRemoteAdminSocket(f.pairing, f.devices, f.root, confirmMac);
    try {
      expect(lstatSync(admin.path).mode & 0o077).toBe(0);
      expect((await f.send('GET', '/remote/admin/pending')).status).toBe(401);
      expect(await sendRemoteAdminCommand({ action: 'invite', subject: SUBJECT, scope: 'act' }, f.root))
        .toEqual({ error: 'Mac operator confirmation required' });
      confirmation.allow = true;
      const invite = await sendRemoteAdminCommand({ action: 'invite', subject: SUBJECT, scope: 'act' }, f.root) as { code: string };
      expect(invite.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(confirmMac).toHaveBeenCalledWith('invite', SUBJECT);
      expect(await sendRemoteAdminCommand({ action: 'pending' }, f.root)).toEqual({ approvals: [] });
    } finally { await admin.close(); await f.gateway.close(); }
  });

  it('requires Mac approval, Access-bound preauth CSRF, login, live scope and single-use exact operation', async () => {
    const f = await setup(false, true);
    try {
      const initial = await f.send('GET', '/remote/session');
      const probe = await initial.json() as { authenticated: boolean; csrfToken: string; capabilities: { pairing: boolean; writes: boolean } };
      expect(probe).toMatchObject({ authenticated: false, capabilities: { pairing: true, writes: true, push: true } });
      expect((await f.send('GET', '/remote/push/config')).status).toBe(401);
      const preauth = initial.headers.get('set-cookie')!.split(';', 1)[0]!;
      expect((await f.send('POST', '/remote/pair/claim', preauth, 'wrong', { code: 'x', label: 'Phone' })).status).toBe(403);
      const invitation = f.pairing.mac.issueInvitation(SUBJECT, { read: true, act: true })!;
      const claim = await f.send('POST', '/remote/pair/claim', preauth, probe.csrfToken, { code: invitation.code, label: 'Phone' });
      expect(claim.status).toBe(200);
      const { pendingId } = await claim.json() as { pendingId: string };
      const regResponse = { id: CRED_ID, rawId: CRED_ID, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: '', attestationObject: '' } };
      expect((await f.send('POST', '/remote/pair/complete', preauth, probe.csrfToken,
        { pendingId, response: regResponse })).status).toBe(200);
      expect(await (await f.send('GET', `/remote/pair/status?pendingId=${pendingId}`, preauth)).json()).toEqual({ state: 'pending' });
      const approved = f.pairing.mac.approvePairing(pendingId, { approved: true })!;
      expect(await (await f.send('GET', `/remote/pair/status?pendingId=${pendingId}`, preauth)).json())
        .toEqual({ state: 'approved', deviceId: approved.id });
      expect((await f.send('GET', '/api/verse/activity', preauth)).status).toBe(401);
      const begun = await f.send('POST', '/remote/auth/begin', preauth, probe.csrfToken, { deviceId: approved.id });
      const { challengeId } = await begun.json() as { challengeId: string };
      const authResponse = { id: CRED_ID, rawId: CRED_ID, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: '', authenticatorData: '', signature: '' } };
      const login = await f.send('POST', '/remote/auth/finish', preauth, probe.csrfToken, { challengeId, response: authResponse });
      expect(login.status).toBe(200);
      const logged = await login.json() as { csrfToken: string; capabilities: { writes: boolean } };
      expect(logged.capabilities.writes).toBe(true);
      const authCookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
      const pushConfig = await f.send('GET', '/remote/push/config', authCookie);
      expect(await pushConfig.json()).toEqual({ publicKey: f.push!.publicKey });
      const subscription = { endpoint: 'https://web.push.apple.com/QvMqW-123456789012345678901234567890',
        keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } };
      expect((await f.send('POST', '/remote/push/subscribe', authCookie, '', subscription)).status).toBe(403);
      expect((await f.send('POST', '/remote/push/subscribe', authCookie, logged.csrfToken, subscription)).status).toBe(204);
      const low = await f.send('POST', '/api/verse/leader/thread', authCookie, logged.csrfToken, { text: 'Hello' });
      expect(low.status).toBe(200);
      expect(f.mutations.at(-1)?.headers['x-ashlr-token']).toBe(ACT_TOKEN);
      expect(f.mutations.at(-1)?.headers.cookie).toBeUndefined();
      expect((await f.send('POST', '/api/verse/authority', authCookie, logged.csrfToken, { action: 'stop' })).status).toBe(403);
      const operation = { method: 'POST', path: '/api/verse/authority', body: JSON.stringify({ action: 'stop' }) };
      const step = await f.send('POST', '/remote/step-up/begin', authCookie, logged.csrfToken, operation);
      expect(step.status).toBe(200);
      const { challengeId: stepId } = await step.json() as { challengeId: string };
      expect((await f.send('POST', '/remote/step-up/finish', authCookie, logged.csrfToken,
        { ...operation, path: '/api/verse/daemon', challengeId: stepId, response: authResponse })).status).toBe(403);
      expect(f.mutations).toHaveLength(1);
      const secondStep = await f.send('POST', '/remote/step-up/begin', authCookie, logged.csrfToken, operation);
      const { challengeId: secondId } = await secondStep.json() as { challengeId: string };
      expect((await f.send('POST', '/remote/step-up/finish', authCookie, logged.csrfToken,
        { ...operation, body: JSON.stringify({ action: 'switch', to: 'off' }), challengeId: secondId, response: authResponse })).status).toBe(403);
      const thirdStep = await f.send('POST', '/remote/step-up/begin', authCookie, logged.csrfToken, operation);
      const { challengeId: thirdId } = await thirdStep.json() as { challengeId: string };
      const approvedWrite = await f.send('POST', '/remote/step-up/finish', authCookie, logged.csrfToken,
        { ...operation, challengeId: thirdId, response: authResponse });
      expect(approvedWrite.status).toBe(200);
      expect(f.mutations).toHaveLength(2);
      expect(f.mutations.at(-1)?.body).toBe(operation.body);
      expect((await f.send('POST', '/remote/step-up/finish', authCookie, logged.csrfToken,
        { ...operation, challengeId: thirdId, response: authResponse })).status).toBe(403);
      expect(f.mutations).toHaveLength(2);
      for (const guarded of [
        { path: '/api/verse/agents/ag_12345678/plan', body: { action: 'approve' } },
        { path: '/api/verse/queue/vs_1/012345abcdef/send', body: {} },
      ]) {
        expect((await f.send('POST', guarded.path, authCookie, logged.csrfToken, guarded.body)).status).toBe(403);
        const exact = { method: 'POST', path: guarded.path, body: JSON.stringify(guarded.body) };
        const begun = await f.send('POST', '/remote/step-up/begin', authCookie, logged.csrfToken, exact);
        expect(begun.status).toBe(200);
        const { challengeId: exactId } = await begun.json() as { challengeId: string };
        expect((await f.send('POST', '/remote/step-up/finish', authCookie, logged.csrfToken,
          { ...exact, challengeId: exactId, response: authResponse })).status).toBe(200);
        expect(f.mutations.at(-1)).toMatchObject({ path: guarded.path, body: exact.body });
      }
      expect(f.mutations).toHaveLength(4);
      f.devices.revoke(approved.id, Date.now());
      expect((await f.send('POST', '/api/verse/leader/thread', authCookie, logged.csrfToken, { text: 'After revoke' })).status).toBe(403);
      expect((await f.send('GET', '/remote/push/config', authCookie)).status).toBe(401);
      expect(await f.push!.send('needs-you')).toEqual({ attempted: 0, delivered: 0, retired: 0 });
    } finally { await f.gateway.close(); f.push?.close(); }
  });
});
