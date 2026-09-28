/**
 * Unmounted pairing and WebAuthn ceremony for a future remote phone gateway.
 * Only the `mac` facade may invite/approve/revoke. Stage 3 must expose those
 * methods solely through a Mac-local operator surface, never through Tunnel.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { parseRemoteAccessConfig, type RemoteAccessIdentity } from './remote-access.js';
import type { RemoteDevice, RemoteDeviceStore } from './remote-device-store.js';

const PAIR_TTL_MS = 5 * 60_000;
const ASSERT_TTL_MS = 2 * 60_000;
const MAX_BODY_BYTES = 65_536;
const MAX_INVITATIONS = 16;
const MAX_REGISTRATIONS = 16;
const MAX_ASSERTIONS = 128;

type WebAuthnOps = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};

const realWebAuthn: WebAuthnOps = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

interface Invitation { subject: string; scopes: RemoteDevice['scopes']; expiresAt: number }
interface Registering {
  stage: 'registering' | 'verifying' | 'awaiting-mac';
  subject: string;
  email: string;
  label: string;
  scopes: RemoteDevice['scopes'];
  challenge: string;
  expiresAt: number;
  credential: Omit<RemoteDevice, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'> | null;
}
interface Assertion {
  purpose: 'login' | 'step-up';
  deviceId: string;
  subject: string;
  challenge: string;
  expiresAt: number;
  operation: OperationDigest | null;
}
interface OperationDigest { method: 'POST' | 'DELETE'; path: string; bodyDigest: string }
export interface RemoteOperation { method: 'POST' | 'DELETE'; path: string; body: string | Uint8Array }

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** This identifies exact bytes. It does not authorize a route; stage 3 must. */
function operationDigest(operation: RemoteOperation): OperationDigest | null {
  if ((operation.method !== 'POST' && operation.method !== 'DELETE')
    || typeof operation.path !== 'string' || operation.path.length > 1024 || !operation.path.startsWith('/api/')
    || /[?#%\\]/.test(operation.path) || operation.path.includes('//')
    || [...operation.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || operation.path.split('/').some((segment) => segment === '.' || segment === '..')
    || !(typeof operation.body === 'string' || operation.body instanceof Uint8Array)) return null;
  const length = Buffer.byteLength(operation.body);
  if (length > MAX_BODY_BYTES) return null;
  return { method: operation.method, path: operation.path, bodyDigest: digest(operation.body) };
}

function sameOperation(a: OperationDigest, b: OperationDigest): boolean {
  return a.method === b.method && a.path === b.path && a.bodyDigest === b.bodyDigest;
}

function cleanLabel(label: string): string | null {
  const value = label.trim();
  return value.length > 0 && value.length <= 80 && !/[\r\n\t]/.test(value) ? value : null;
}

/**
 * In-memory tickets/challenges die on restart. Durable credentials and their
 * revocations live in `store`; all successful assertions update its counter.
 */
export function createRemotePairing(
  configInput: unknown,
  store: RemoteDeviceStore,
  options: { now?: () => number; webauthn?: WebAuthnOps } = {},
) {
  const config = parseRemoteAccessConfig(configInput);
  if (!config) throw new Error('Remote Access configuration is incomplete or invalid');
  const { publicOrigin, allowedSubjects } = config;
  const rpID = new URL(publicOrigin).hostname;
  const webauthn = options.webauthn ?? realWebAuthn;
  const now = options.now ?? Date.now;
  const invitations = new Map<string, Invitation>();
  const registrations = new Map<string, Registering>();
  const registrationResults = new Map<string, { subject: string; state: 'approved' | 'denied'; deviceId?: string; expiresAt: number }>();
  const assertions = new Map<string, Assertion>();

  function pruneExpired(): void {
    const at = now();
    for (const [key, value] of invitations) if (value.expiresAt <= at) invitations.delete(key);
    for (const [key, value] of registrations) if (value.expiresAt <= at) registrations.delete(key);
    for (const [key, value] of registrationResults) if (value.expiresAt <= at) registrationResults.delete(key);
    for (const [key, value] of assertions) if (value.expiresAt <= at) assertions.delete(key);
  }

  function validIdentity(identity: RemoteAccessIdentity): boolean {
    return !!identity && typeof identity.subject === 'string' && allowedSubjects.includes(identity.subject)
      && typeof identity.email === 'string' && !!identity.email.trim()
      && typeof identity.expiresAt === 'number' && identity.expiresAt > now();
  }
  function activeDevice(identity: RemoteAccessIdentity, deviceId: string, act: boolean): RemoteDevice | null {
    if (!validIdentity(identity)) return null;
    const device = store.getActive(deviceId, identity.subject);
    return device && (!act || device.scopes.act) ? device : null;
  }
  async function beginAssertion(identity: RemoteAccessIdentity, deviceId: string, purpose: Assertion['purpose'], operation: OperationDigest | null) {
    pruneExpired();
    const device = activeDevice(identity, deviceId, purpose === 'step-up');
    if (!device || assertions.size >= MAX_ASSERTIONS) return null;
    const opts = await webauthn.generateAuthenticationOptions({
      rpID,
      allowCredentials: [{ id: device.credentialId, transports: device.transports as RemoteDeviceTransports }],
      userVerification: 'required',
      timeout: ASSERT_TTL_MS,
    });
    if (assertions.size >= MAX_ASSERTIONS || !activeDevice(identity, deviceId, purpose === 'step-up')) return null;
    const challengeId = randomUUID();
    assertions.set(challengeId, { purpose, deviceId, subject: identity.subject, challenge: opts.challenge, expiresAt: now() + ASSERT_TTL_MS, operation });
    return { challengeId, options: opts };
  }
  async function finishAssertion(identity: RemoteAccessIdentity, challengeId: string, response: AuthenticationResponseJSON, purpose: Assertion['purpose'], operation: OperationDigest | null) {
    const pending = assertions.get(challengeId);
    if (!pending || !validIdentity(identity) || pending.subject !== identity.subject) return null;
    // Consume before an await: concurrent submissions of one challenge cannot
    // both pass, even if signature verification takes time.
    assertions.delete(challengeId);
    if (pending.expiresAt <= now() || pending.purpose !== purpose
      || (purpose === 'step-up' && (!pending.operation || !operation || !sameOperation(pending.operation, operation)))) return null;
    const device = activeDevice(identity, pending.deviceId, purpose === 'step-up');
    if (!device || response.id !== device.credentialId) return null;
    try {
      const result = await webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: publicOrigin,
        expectedRPID: rpID,
        credential: {
          id: device.credentialId,
          publicKey: new Uint8Array(Buffer.from(device.publicKey, 'base64url')),
          counter: device.counter,
          transports: device.transports as RemoteDeviceTransports,
        },
        requireUserVerification: true,
      });
      if (!result.verified || pending.expiresAt <= now() || !validIdentity(identity)
        || !result.authenticationInfo.userVerified
        || result.authenticationInfo.origin !== publicOrigin || result.authenticationInfo.rpID !== rpID
        || result.authenticationInfo.credentialID !== device.credentialId) return null;
      if (!store.updateCounter(device.id, identity.subject, device.credentialId, result.authenticationInfo.newCounter, now())) return null;
      return store.getActive(device.id, identity.subject);
    } catch { return null; }
  }

  return {
    mac: {
      /** Code is shown on the Mac only; its hash alone stays in memory. */
      issueInvitation(subject: string, scopes: RemoteDevice['scopes']) {
        pruneExpired();
        if (invitations.size >= MAX_INVITATIONS || !allowedSubjects.includes(subject)
          || !scopes || scopes.read !== true || typeof scopes.act !== 'boolean') return null;
        const code = randomBytes(32).toString('base64url');
        const expiresAt = now() + PAIR_TTL_MS;
        invitations.set(digest(code), { subject, scopes: { ...scopes }, expiresAt });
        return { code, expiresAt };
      },
      pendingApprovals() {
        return [...registrations.entries()]
          .filter(([, p]) => p.stage === 'awaiting-mac' && p.expiresAt > now())
          .map(([id, p]) => ({ id, label: p.label, subject: p.subject, email: p.email,
            credentialId: p.credential?.credentialId, deviceType: p.credential?.deviceType, backedUp: p.credential?.backedUp }));
      },
      approvePairing(id: string, confirmation: { approved: true }): RemoteDevice | null {
        if (confirmation?.approved !== true) return null;
        const pending = registrations.get(id);
        if (!pending || pending.stage !== 'awaiting-mac' || pending.expiresAt <= now() || !pending.credential) return null;
        const at = now();
        const device: RemoteDevice = { ...pending.credential, id: randomUUID(), createdAt: at, lastUsedAt: null, revokedAt: null };
        store.add(device);
        registrations.delete(id);
        registrationResults.set(id, { subject: pending.subject, state: 'approved', deviceId: device.id, expiresAt: now() + PAIR_TTL_MS });
        return device;
      },
      denyPairing(id: string): void {
        const pending = registrations.get(id);
        if (pending) registrationResults.set(id, { subject: pending.subject, state: 'denied', expiresAt: now() + PAIR_TTL_MS });
        registrations.delete(id);
      },
      revokeDevice(id: string): boolean { return store.revoke(id, now()); },
    },
    phone: {
      registrationStatus(identity: RemoteAccessIdentity, pendingId: string) {
        pruneExpired();
        if (!validIdentity(identity)) return null;
        const pending = registrations.get(pendingId);
        if (pending?.subject === identity.subject) return { state: 'pending' as const };
        const result = registrationResults.get(pendingId);
        if (result?.subject !== identity.subject) return null;
        return result.state === 'approved'
          ? { state: 'approved' as const, deviceId: result.deviceId! }
          : { state: 'denied' as const };
      },
      async claimInvitation(identity: RemoteAccessIdentity, code: string, label: string) {
        pruneExpired();
        if (!validIdentity(identity) || typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)
          || typeof label !== 'string' || registrations.size >= MAX_REGISTRATIONS) return null;
        const name = cleanLabel(label);
        if (!name) return null;
        const key = digest(code);
        const invite = invitations.get(key);
        if (!invite || invite.subject !== identity.subject) return null;
        invitations.delete(key);
        if (invite.expiresAt <= now()) return null;
        const opts = await webauthn.generateRegistrationOptions({
          rpName: 'Ashlr Verse', rpID, userName: identity.email, userDisplayName: name,
          // Stable, opaque WebAuthn user ID for this Access subject on this RP.
          userID: createHash('sha256').update(`${rpID}:${identity.subject}`).digest(),
          attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          excludeCredentials: store.list().filter((d) => d.subject === identity.subject && d.revokedAt === null)
            .map((d) => ({ id: d.credentialId, transports: d.transports as RemoteDeviceTransports })),
          timeout: PAIR_TTL_MS,
        });
        if (registrations.size >= MAX_REGISTRATIONS || !validIdentity(identity) || invite.expiresAt <= now()) return null;
        const pendingId = randomUUID();
        registrations.set(pendingId, { stage: 'registering', subject: identity.subject, email: identity.email, label: name,
          scopes: invite.scopes, challenge: opts.challenge, expiresAt: Math.min(invite.expiresAt, now() + PAIR_TTL_MS), credential: null });
        return { pendingId, options: opts };
      },
      async completeRegistration(identity: RemoteAccessIdentity, pendingId: string, response: RegistrationResponseJSON): Promise<boolean> {
        const pending = registrations.get(pendingId);
        if (!pending || pending.stage !== 'registering' || !validIdentity(identity) || pending.subject !== identity.subject) return false;
        pending.stage = 'verifying';
        if (pending.expiresAt <= now()) { registrations.delete(pendingId); return false; }
        try {
          const verified = await webauthn.verifyRegistrationResponse({
            response,
            expectedChallenge: pending.challenge,
            expectedOrigin: publicOrigin,
            expectedRPID: rpID,
            requireUserVerification: true,
            supportedAlgorithmIDs: [-7, -257],
          });
          if (!verified.verified || !verified.registrationInfo.userVerified || pending.expiresAt <= now()
            || registrations.get(pendingId) !== pending) return false;
          const info = verified.registrationInfo;
          if (info.origin !== publicOrigin || info.rpID !== rpID || info.credential.id !== response.id) return false;
          pending.credential = {
            label: pending.label, subject: pending.subject, email: pending.email, scopes: pending.scopes,
            credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
            counter: info.credential.counter, transports: info.credential.transports ?? [],
            deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
          };
          pending.stage = 'awaiting-mac';
          return true;
        } catch { return false; }
        finally { if (pending.stage === 'verifying') registrations.delete(pendingId); }
      },
      beginAuthentication(identity: RemoteAccessIdentity, deviceId: string) {
        return beginAssertion(identity, deviceId, 'login', null);
      },
      async completeAuthentication(identity: RemoteAccessIdentity, challengeId: string, response: AuthenticationResponseJSON) {
        const device = await finishAssertion(identity, challengeId, response, 'login', null);
        return device ? { id: device.id, subject: device.subject, scopes: { ...device.scopes } } : null;
      },
      beginStepUp(identity: RemoteAccessIdentity, deviceId: string, operation: RemoteOperation) {
        const bound = operationDigest(operation);
        return bound ? beginAssertion(identity, deviceId, 'step-up', bound) : Promise.resolve(null);
      },
      /** The callback is entered once, immediately after live revocation check. */
      async runWithStepUp<T>(identity: RemoteAccessIdentity, challengeId: string, response: AuthenticationResponseJSON,
        operation: RemoteOperation, run: () => Promise<T> | T): Promise<{ ok: false } | { ok: true; value: T }> {
        const bound = operationDigest(operation);
        if (!bound) return { ok: false };
        const device = await finishAssertion(identity, challengeId, response, 'step-up', bound);
        const live = device && validIdentity(identity) ? store.getActive(device.id, identity.subject) : null;
        if (!live?.scopes.act) return { ok: false };
        // No await between the final live store lookup and dispatch into `run`.
        return { ok: true, value: await run() };
      },
    },
  };
}

type RemoteDeviceTransports = NonNullable<Parameters<typeof generateAuthenticationOptions>[0]['allowCredentials']>[number]['transports'];
