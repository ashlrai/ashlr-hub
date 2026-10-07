import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse, type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { createRemotePairing } from '../src/core/web/remote-pairing.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const OTHER = '6335d417-61da-459d-899c-0a01c76a2f94';
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'a'.repeat(64), allowedSubjects: [SUBJECT, OTHER] };
const CRED_ID = randomBytes(32).toString('base64url');
let roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });

function root() {
  const path = mkdtempSync(join(tmpdir(), 'ashlr-remote-device-test-'));
  roots.push(path);
  return path;
}
function identity(subject = SUBJECT, expiresAt = 1_000_000) {
  return { subject, email: 'owner@example.com', expiresAt };
}
function device(id = '7335d417-61da-459d-899c-0a01c76a2f94', credentialId = CRED_ID): RemoteDevice {
  return { id, credentialId, publicKey: randomBytes(80).toString('base64url'), label: 'Phone', subject: SUBJECT,
    email: 'owner@example.com', scopes: { read: true, act: true }, counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}
function registration(id = CRED_ID): RegistrationResponseJSON {
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: '', attestationObject: '' } };
}
function assertion(id = CRED_ID, challenge = 'ignored', origin = ORIGIN, rp = 'phone.example.com'): AuthenticationResponseJSON {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })).toString('base64url');
  const authData = Buffer.concat([createHash('sha256').update(rp).digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
  return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON, authenticatorData: authData.toString('base64url'), signature: randomBytes(64).toString('base64url'), userHandle: null } };
}
function webauthnStub() {
  const verifyRegistrationResponse = vi.fn(async () => ({ verified: true, registrationInfo: {
    credential: { id: CRED_ID, publicKey: randomBytes(80), counter: 0, transports: ['internal'] },
    userVerified: true, credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
  } }) as unknown as Promise<VerifiedRegistrationResponse>);
  const verifyAuthenticationResponse = vi.fn(async () => ({ verified: true, authenticationInfo: {
    credentialID: CRED_ID, newCounter: 0, userVerified: true,
    credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
  } }) as unknown as Promise<VerifiedAuthenticationResponse>);
  return { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };
}

describe('private device registry', () => {
  it('atomically persists private credentials and durable revocation across instances', () => {
    const dir = root();
    const store = createRemoteDeviceStore(dir);
    const seen: string[] = [];
    store.onRevoked((id) => seen.push(id));
    store.add(device());
    const file = join(dir, 'remote-devices.json');
    expect(lstatSync(dir).mode & 0o077).toBe(0);
    expect(lstatSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('x-ashlr-token');
    expect(createRemoteDeviceStore(dir).getActive(device().id, SUBJECT)?.id).toBe(device().id);
    expect(store.revoke(device().id, 100)).toBe(true);
    expect(seen).toEqual([device().id]);
    expect(createRemoteDeviceStore(dir).getActive(device().id, SUBJECT)).toBeNull();
    expect(store.revoke(device().id, 101)).toBe(false);
  });

  it('denies malformed, publicly readable, and symlinked registry state', () => {
    const dir = root();
    const file = join(dir, 'remote-devices.json');
    writeFileSync(file, '{bad', { mode: 0o600 });
    expect(() => createRemoteDeviceStore(dir).list()).toThrow();
    writeFileSync(file, JSON.stringify({ v: 1, devices: [] }));
    chmodSync(file, 0o644);
    expect(() => createRemoteDeviceStore(dir).list()).toThrow();
    rmSync(file);
    symlinkSync(join(dir, 'missing'), file);
    expect(() => createRemoteDeviceStore(dir).list()).toThrow();
  });

  it('rejects duplicate credentials and counter rollback', () => {
    const store = createRemoteDeviceStore(root());
    store.add(device());
    expect(() => store.add(device('6335d417-61da-459d-899c-0a01c76a2f94'))).toThrow();
    expect(store.updateCounter(device().id, SUBJECT, CRED_ID, 2, 10)).toBe(true);
    expect(store.updateCounter(device().id, SUBJECT, CRED_ID, 1, 11)).toBe(false);
    expect(store.updateCounter(device().id, OTHER, CRED_ID, 3, 12)).toBe(false);
  });
});

describe('Mac-approved pairing and WebAuthn', () => {
  it('consumes the invitation once, binds registration to Access subject and RP, and waits for Mac approval', async () => {
    let time = 1000;
    const store = createRemoteDeviceStore(root());
    const webauthn = webauthnStub();
    const ceremony = createRemotePairing(CONFIG, store, { now: () => time, webauthn });
    const invite = ceremony.mac.issueInvitation(SUBJECT, { read: true, act: true })!;
    expect(await ceremony.phone.claimInvitation(identity(OTHER), invite.code, 'Other')).toBeNull();
    const claim = await ceremony.phone.claimInvitation(identity(), invite.code, 'Mason’s phone');
    expect(claim?.options.rp.name).toBe('Phantom');
    expect(claim?.options.rp.id).toBe('phone.example.com');
    expect(claim?.options.authenticatorSelection?.userVerification).toBe('required');
    expect(await ceremony.phone.claimInvitation(identity(), invite.code, 'Replay')).toBeNull();
    expect(await ceremony.phone.completeRegistration(identity(OTHER), claim!.pendingId, registration())).toBe(false);
    expect(await ceremony.phone.completeRegistration(identity(), claim!.pendingId, registration())).toBe(true);
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: claim!.options.challenge, expectedOrigin: ORIGIN, expectedRPID: 'phone.example.com', requireUserVerification: true,
    }));
    expect(await ceremony.phone.completeRegistration(identity(), claim!.pendingId, registration())).toBe(false);
    expect(store.list()).toEqual([]);
    expect(ceremony.mac.pendingApprovals()).toHaveLength(1);
    expect(ceremony.mac.approvePairing(claim!.pendingId, { approved: false as true })).toBeNull();
    const approved = ceremony.mac.approvePairing(claim!.pendingId, { approved: true });
    expect(approved?.subject).toBe(SUBJECT);
    expect(store.getActive(approved!.id, SUBJECT)).not.toBeNull();
    time += 10;
  });

  it('will not queue Mac approval without authenticator user verification', async () => {
    const store = createRemoteDeviceStore(root());
    const webauthn = webauthnStub();
    webauthn.verifyRegistrationResponse.mockResolvedValueOnce({ verified: true, registrationInfo: {
      credential: { id: CRED_ID, publicKey: randomBytes(80), counter: 0, transports: ['internal'] },
      userVerified: false, credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
    } } as unknown as VerifiedRegistrationResponse);
    const ceremony = createRemotePairing(CONFIG, store, { now: () => 1000, webauthn });
    const invite = ceremony.mac.issueInvitation(SUBJECT, { read: true, act: true })!;
    const claim = await ceremony.phone.claimInvitation(identity(), invite.code, 'Phone');
    expect(await ceremony.phone.completeRegistration(identity(), claim!.pendingId, registration())).toBe(false);
    expect(ceremony.mac.pendingApprovals()).toEqual([]);
  });

  it('expires Mac invitations and pending approvals', async () => {
    let time = 1000;
    const ceremony = createRemotePairing(CONFIG, createRemoteDeviceStore(root()), { now: () => time, webauthn: webauthnStub() });
    const old = ceremony.mac.issueInvitation(SUBJECT, { read: true, act: false })!;
    time = old.expiresAt;
    expect(await ceremony.phone.claimInvitation(identity(), old.code, 'Phone')).toBeNull();
    const fresh = ceremony.mac.issueInvitation(SUBJECT, { read: true, act: false })!;
    const claim = await ceremony.phone.claimInvitation(identity(), fresh.code, 'Phone');
    expect(claim).not.toBeNull();
    time = fresh.expiresAt;
    expect(await ceremony.phone.completeRegistration(identity(), claim!.pendingId, registration())).toBe(false);
    expect(ceremony.mac.approvePairing(claim!.pendingId, { approved: true })).toBeNull();
  });

  it('requires a current device, exact subject, fresh one-time challenge and UV for login', async () => {
    let time = 1000;
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const webauthn = webauthnStub();
    const ceremony = createRemotePairing(CONFIG, store, { now: () => time, webauthn });
    expect(await ceremony.phone.beginAuthentication(identity(OTHER), d.id)).toBeNull();
    const login = await ceremony.phone.beginAuthentication(identity(), d.id);
    expect(login?.options.userVerification).toBe('required');
    expect(login?.options.allowCredentials?.[0]?.id).toBe(CRED_ID);
    const result = await ceremony.phone.completeAuthentication(identity(), login!.challengeId, assertion());
    expect(result?.id).toBe(d.id);
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: login!.options.challenge, expectedOrigin: ORIGIN, expectedRPID: 'phone.example.com', requireUserVerification: true,
    }));
    expect(await ceremony.phone.completeAuthentication(identity(), login!.challengeId, assertion())).toBeNull();
    const wrongDevice = await ceremony.phone.beginAuthentication(identity(), d.id);
    expect(await ceremony.phone.completeAuthentication(identity(), wrongDevice!.challengeId, assertion(randomBytes(32).toString('base64url')))).toBeNull();
    const wrongSubject = await ceremony.phone.beginAuthentication(identity(), d.id);
    expect(await ceremony.phone.completeAuthentication(identity(OTHER), wrongSubject!.challengeId, assertion())).toBeNull();
    expect(await ceremony.phone.completeAuthentication(identity(), wrongSubject!.challengeId, assertion())).not.toBeNull();
    const expired = await ceremony.phone.beginAuthentication(identity(), d.id);
    time += 120_000;
    expect(await ceremony.phone.completeAuthentication(identity(), expired!.challengeId, assertion())).toBeNull();
    const next = await ceremony.phone.beginAuthentication(identity(), d.id);
    webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: {
      credentialID: CRED_ID, newCounter: 0, userVerified: false,
      credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com',
    } });
    expect(await ceremony.phone.completeAuthentication(identity(), next!.challengeId, assertion())).toBeNull();
  });

  it('uses the actual verifier to reject a wrong browser origin and RP ID', async () => {
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const ceremony = createRemotePairing(CONFIG, store);
    const wrongOrigin = await ceremony.phone.beginAuthentication(identity(SUBJECT, Date.now() + 600_000), d.id);
    expect(await ceremony.phone.completeAuthentication(identity(SUBJECT, Date.now() + 600_000), wrongOrigin!.challengeId,
      assertion(CRED_ID, wrongOrigin!.options.challenge, 'https://evil.example'))).toBeNull();
    const wrongRP = await ceremony.phone.beginAuthentication(identity(SUBJECT, Date.now() + 600_000), d.id);
    expect(await ceremony.phone.completeAuthentication(identity(SUBJECT, Date.now() + 600_000), wrongRP!.challengeId,
      assertion(CRED_ID, wrongRP!.options.challenge, ORIGIN, 'other.example.com'))).toBeNull();
  });

  it('binds a step-up to method, path, exact body bytes and one callback; revocation stops execution', async () => {
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const webauthn = webauthnStub();
    const ceremony = createRemotePairing(CONFIG, store, { now: () => 1000, webauthn });
    const operation = { method: 'POST' as const, path: '/api/verse/daemon', body: '{"action":"stop"}' };
    const run = vi.fn(async () => 'stopped');
    const first = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    expect(first?.options.userVerification).toBe('required');
    expect(await ceremony.phone.runWithStepUp(identity(), first!.challengeId, assertion(),
      { ...operation, body: '{"action":"start"}' }, run)).toEqual({ ok: false });
    expect(run).not.toHaveBeenCalled();
    const second = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    expect(await ceremony.phone.runWithStepUp(identity(), second!.challengeId, assertion(),
      { ...operation, path: '/api/verse/other' }, run)).toEqual({ ok: false });
    const third = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    expect(await ceremony.phone.runWithStepUp(identity(), third!.challengeId, assertion(),
      { ...operation, method: 'DELETE' }, run)).toEqual({ ok: false });
    const fourth = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    expect(await ceremony.phone.runWithStepUp(identity(), fourth!.challengeId, assertion(), operation, run)).toEqual({ ok: true, value: 'stopped' });
    expect(await ceremony.phone.runWithStepUp(identity(), fourth!.challengeId, assertion(), operation, run)).toEqual({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
    const fifth = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    ceremony.mac.revokeDevice(d.id);
    expect(await ceremony.phone.runWithStepUp(identity(), fifth!.challengeId, assertion(), operation, run)).toEqual({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('consumes a challenge before slow verification and refuses a concurrent replay', async () => {
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const webauthn = webauthnStub();
    let release!: (value: VerifiedAuthenticationResponse) => void;
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const ceremony = createRemotePairing(CONFIG, store, { now: () => 1000, webauthn });
    const operation = { method: 'POST' as const, path: '/api/verse/daemon', body: '{"action":"stop"}' };
    const challenge = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    const run = vi.fn(() => 'done');
    const first = ceremony.phone.runWithStepUp(identity(), challenge!.challengeId, assertion(), operation, run);
    expect(await ceremony.phone.runWithStepUp(identity(), challenge!.challengeId, assertion(), operation, run)).toEqual({ ok: false });
    release({ verified: true, authenticationInfo: { credentialID: CRED_ID, newCounter: 0, userVerified: true,
      credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com' } });
    expect(await first).toEqual({ ok: true, value: 'done' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses dispatch when the device is revoked while signature verification runs', async () => {
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const webauthn = webauthnStub();
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
      store.revoke(d.id, 1001);
      return { verified: true, authenticationInfo: { credentialID: CRED_ID, newCounter: 0, userVerified: true,
        credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com' } };
    });
    const ceremony = createRemotePairing(CONFIG, store, { now: () => 1000, webauthn });
    const operation = { method: 'POST' as const, path: '/api/verse/daemon', body: '{}' };
    const challenge = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    const run = vi.fn();
    expect(await ceremony.phone.runWithStepUp(identity(), challenge!.challengeId, assertion(), operation, run)).toEqual({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a challenge that expires during signature verification', async () => {
    let time = 1000;
    const store = createRemoteDeviceStore(root());
    const d = device(); store.add(d);
    const webauthn = webauthnStub();
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
      time += 120_000;
      return { verified: true, authenticationInfo: { credentialID: CRED_ID, newCounter: 0, userVerified: true,
        credentialDeviceType: 'multiDevice', credentialBackedUp: true, origin: ORIGIN, rpID: 'phone.example.com' } };
    });
    const ceremony = createRemotePairing(CONFIG, store, { now: () => time, webauthn });
    const operation = { method: 'POST' as const, path: '/api/verse/daemon', body: '{}' };
    const challenge = await ceremony.phone.beginStepUp(identity(), d.id, operation);
    const run = vi.fn();
    expect(await ceremony.phone.runWithStepUp(identity(), challenge!.challengeId, assertion(), operation, run)).toEqual({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });
});
