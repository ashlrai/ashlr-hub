import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  evaluateRuntimeActivationResidentStartAcknowledgement,
  parseRuntimeActivationResidentStartAcknowledgement,
  parseRuntimeActivationResidentStartAcknowledgementFrame,
  parseRuntimeActivationResidentStartPermit,
  parseRuntimeActivationResidentStartPermitFrame,
  RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
  RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL,
  runtimeActivationResidentStartAcknowledgementFrame,
  runtimeActivationResidentStartKeyId,
  runtimeActivationResidentStartPermitPayloadDigest,
  runtimeActivationResidentStartPermitFrame,
  signRuntimeActivationResidentStartPermit,
  verifyRuntimeActivationResidentStartPermit,
  type RuntimeActivationResidentNativeObservationV1,
  type RuntimeActivationResidentStartAcknowledgementV1,
  type RuntimeActivationResidentStartPermitPayloadV1,
  type RuntimeActivationResidentStartTrustRootV1,
} from '../src/core/daemon/runtime-activation-resident-start-protocol.js';
import {
  NATIVE_HOSTILE_PROCESS_CAS_UNAVAILABLE,
  RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS,
  runtimeActivationResidentStartRuntime,
} from '../src/core/daemon/runtime-activation-resident-start-runtime.js';

const NOW = Date.parse('2026-08-17T12:00:30.000Z');
const ISSUED_AT = '2026-08-17T12:00:00.000Z';
const EXPIRES_AT = '2026-08-17T12:02:00.000Z';
const PERMIT_ID = '11111111-1111-4111-8111-111111111111';
const STOPPED_PERMIT_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVATION_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE = Buffer.alloc(32, 0x42).toString('base64url');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const SHA_F = 'f'.repeat(64);
const REVISION = '1'.repeat(40);
const TREE = '2'.repeat(40);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = runtimeActivationResidentStartKeyId(publicKey);
  const root: RuntimeActivationResidentStartTrustRootV1 = {
    algorithm: 'ed25519',
    keyId,
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-08-17T11:59:00.000Z',
    validUntil: '2026-08-17T12:03:00.000Z',
  };
  return { privateKey, publicKey, keyId, root };
}

function permitPayload(keyId: string): RuntimeActivationResidentStartPermitPayloadV1 {
  return {
    schemaVersion: 1,
    protocol: RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL,
    permitId: PERMIT_ID,
    keyId,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    scope: {
      action: 'start-exact-selected-resident-release',
      platform: 'darwin',
      nativeBrokerRequired: true,
      killSwitch: 'healthy-engaged',
      providerEffectsBlocked: true,
      serviceStartRequested: true,
      serviceEnable: false,
      serviceInstall: false,
      pointerMutation: false,
      residentAcknowledgement: 'required-pre-dispatch',
      dispatchAuthorized: false,
    },
    bindings: {
      activationId: ACTIVATION_ID,
      admissionDigest: SHA_A,
      planDigest: SHA_B,
      canonicalRequestSha256: SHA_C,
      trustRootCanonicalSha256: SHA_D,
      stoppedPermitId: STOPPED_PERMIT_ID,
      stoppedReceiptDigest: SHA_E,
      candidateRevision: REVISION,
      candidateExpectedTree: TREE,
      candidateVersion: '3.2.8-beta.1+build.7',
      candidateReleaseTag: 'v3.2.8-beta.1+build.7',
      candidateRuntimeTreeSha256: SHA_F,
      candidateManifestDigest: SHA_A,
      candidateLaunchReceiptSha256: SHA_B,
      candidateServiceDescriptorSha256: SHA_C,
      candidateServiceInvocationDigest: SHA_D,
      configSha256: SHA_E,
      currentTarget: `releases/${REVISION}`,
      priorServiceLoaded: false,
      priorServiceDisabled: true,
      hostUid: 501,
      serviceLabel: 'ai.ashlr.daemon',
      serviceTarget: 'gui/501/ai.ashlr.daemon',
      brokerChallenge: CHALLENGE,
      acknowledgementDeadlineMs: 30_000,
    },
  };
}

function nativeObservation(): RuntimeActivationResidentNativeObservationV1 {
  return {
    pid: 42_424,
    processStartIdentitySha256: SHA_A,
    auditTokenSha256: SHA_B,
    executableVnodeSha256: SHA_C,
    codeIdentitySha256: SHA_D,
    launchdJobGenerationSha256: SHA_E,
  };
}

function acknowledgement(
  permit: RuntimeActivationResidentStartPermitPayloadV1,
): RuntimeActivationResidentStartAcknowledgementV1 {
  return {
    schemaVersion: 1,
    protocol: RUNTIME_ACTIVATION_RESIDENT_START_PROTOCOL,
    acknowledgement: 'resident-start-pre-dispatch',
    permitId: permit.permitId,
    permitPayloadDigest: runtimeActivationResidentStartPermitPayloadDigest(permit),
    activationId: permit.bindings.activationId,
    brokerChallenge: permit.bindings.brokerChallenge,
    acknowledgedAt: '2026-08-17T12:00:20.000Z',
    bindings: structuredClone(permit.bindings),
    nativeObservation: nativeObservation(),
    channel: {
      transport: 'broker-owned-inherited-fd',
      peerCredentialsVerified: true,
      challengeVerified: true,
      framing: 'canonical-json-single-lf-eof',
    },
    state: {
      killSwitch: 'healthy-engaged',
      phase: 'pre-dispatch',
      dispatchAuthorized: false,
      providerEffectsBlocked: true,
    },
    authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
  };
}

describe('M521 dormant resident-start protocol', () => {
  it('verifies a distinct signed permit and exact dynamic-release pre-dispatch ACK without authority', () => {
    const key = keyFixture();
    const permit = permitPayload(key.keyId);
    const envelope = signRuntimeActivationResidentStartPermit(permit, key.privateKey);

    expect(verifyRuntimeActivationResidentStartPermit(envelope, [key.root], NOW)).toBeNull();
    expect(parseRuntimeActivationResidentStartPermitFrame(
      runtimeActivationResidentStartPermitFrame(envelope),
    )).toEqual(envelope);

    const ack = acknowledgement(permit);
    expect(parseRuntimeActivationResidentStartAcknowledgementFrame(
      runtimeActivationResidentStartAcknowledgementFrame(ack),
    )).toEqual(ack);
    const evaluated = evaluateRuntimeActivationResidentStartAcknowledgement(
      ack,
      permit,
      nativeObservation(),
    );
    expect(evaluated).toMatchObject({
      ok: true,
      authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
    });
    expect(evaluated.acknowledgementDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.values(evaluated.authority)).toEqual(Array(9).fill(false));
  });

  it('keeps resident-start signing distinct and rejects root, signature, and time substitution', () => {
    const key = keyFixture();
    const other = keyFixture();
    const permit = permitPayload(key.keyId);
    const envelope = signRuntimeActivationResidentStartPermit(permit, key.privateKey);

    expect(verifyRuntimeActivationResidentStartPermit(envelope, [other.root], NOW))
      .toBe('runtime activation resident-start signing root is unavailable');
    expect(verifyRuntimeActivationResidentStartPermit(envelope, [key.root, key.root], NOW))
      .toBe('runtime activation resident-start signing root is unavailable');

    const rootGetter = vi.fn(() => key.keyId);
    const hostileRoot = { ...key.root } as unknown as Record<string, unknown>;
    Object.defineProperty(hostileRoot, 'keyId', { enumerable: true, get: rootGetter });
    expect(verifyRuntimeActivationResidentStartPermit(
      envelope,
      [hostileRoot as unknown as RuntimeActivationResidentStartTrustRootV1],
      NOW,
    )).toBe('runtime activation resident-start signing root is unavailable');
    expect(rootGetter).not.toHaveBeenCalled();

    const tampered = structuredClone(envelope);
    tampered.payload.bindings.configSha256 = SHA_F;
    expect(verifyRuntimeActivationResidentStartPermit(tampered, [key.root], NOW))
      .toBe('runtime activation resident-start permit signature is invalid');

    expect(verifyRuntimeActivationResidentStartPermit(envelope, [key.root], Date.parse(EXPIRES_AT)))
      .toBe('runtime activation resident-start permit is outside its validity window');
    expect(verifyRuntimeActivationResidentStartPermit(envelope, [key.root], Date.parse(ISSUED_AT) - 30_001))
      .toBe('runtime activation resident-start permit is outside its validity window');

    const long = permitPayload(key.keyId);
    long.expiresAt = '2026-08-17T12:02:00.001Z';
    const longEnvelope = signRuntimeActivationResidentStartPermit(long, key.privateKey);
    expect(verifyRuntimeActivationResidentStartPermit(longEnvelope, [key.root], NOW))
      .toBe('runtime activation resident-start permit is outside its validity window');
  });

  it.each([
    ['activation', 'activationId', '44444444-4444-4444-8444-444444444444'],
    ['admission', 'admissionDigest', SHA_F],
    ['plan', 'planDigest', SHA_F],
    ['request', 'canonicalRequestSha256', SHA_F],
    ['trust root', 'trustRootCanonicalSha256', SHA_F],
    ['stopped permit', 'stoppedPermitId', '55555555-5555-4555-8555-555555555555'],
    ['stopped receipt', 'stoppedReceiptDigest', SHA_F],
    ['revision', 'candidateRevision', '3'.repeat(40)],
    ['tree', 'candidateExpectedTree', '4'.repeat(40)],
    ['runtime tree', 'candidateRuntimeTreeSha256', SHA_A],
    ['manifest', 'candidateManifestDigest', SHA_F],
    ['launch receipt', 'candidateLaunchReceiptSha256', SHA_F],
    ['service descriptor', 'candidateServiceDescriptorSha256', SHA_F],
    ['service invocation', 'candidateServiceInvocationDigest', SHA_F],
    ['config', 'configSha256', SHA_F],
    ['disabled bit', 'priorServiceDisabled', false],
    ['host', 'hostUid', 502],
    ['challenge', 'brokerChallenge', Buffer.alloc(32, 0x43).toString('base64url')],
    ['deadline', 'acknowledgementDeadlineMs', 20_000],
  ] as const)('rejects cross-%s acknowledgement binding', (_label, field, replacement) => {
    const key = keyFixture();
    const permit = permitPayload(key.keyId);
    const ack = acknowledgement(permit);
    (ack.bindings as unknown as Record<string, unknown>)[field] = replacement;
    const result = evaluateRuntimeActivationResidentStartAcknowledgement(
      ack,
      permit,
      nativeObservation(),
    );
    expect(result.ok).toBe(false);
    expect(result.authority.startPermitted).toBe(false);
  });

  it('rejects release-tag drift, current-target drift, service-target drift, and post-deadline ACKs', () => {
    const key = keyFixture();
    const permit = permitPayload(key.keyId);

    for (const mutate of [
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => { ack.permitPayloadDigest = SHA_F; },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => { ack.bindings.candidateReleaseTag = 'v9.9.9'; },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => { ack.bindings.currentTarget = `releases/${'9'.repeat(40)}`; },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => { ack.bindings.serviceTarget = 'gui/502/ai.ashlr.daemon'; },
    ]) {
      const ack = acknowledgement(permit);
      mutate(ack);
      expect(evaluateRuntimeActivationResidentStartAcknowledgement(
        ack,
        permit,
        nativeObservation(),
      ).ok).toBe(false);
    }

    const late = acknowledgement(permit);
    late.acknowledgedAt = '2026-08-17T12:00:30.001Z';
    expect(evaluateRuntimeActivationResidentStartAcknowledgement(
      late,
      permit,
      nativeObservation(),
    )).toMatchObject({
      ok: false,
      reason: 'runtime activation resident-start acknowledgement missed its bound deadline',
    });
  });

  it.each([
    'pid',
    'processStartIdentitySha256',
    'auditTokenSha256',
    'executableVnodeSha256',
    'codeIdentitySha256',
    'launchdJobGenerationSha256',
  ] as const)('rejects native %s substitution', (field) => {
    const key = keyFixture();
    const permit = permitPayload(key.keyId);
    const ack = acknowledgement(permit);
    const observed = nativeObservation();
    (observed as unknown as Record<string, unknown>)[field] = field === 'pid' ? 42_425 : SHA_F;
    expect(evaluateRuntimeActivationResidentStartAcknowledgement(ack, permit, observed)).toMatchObject({
      ok: false,
      reason: 'runtime activation resident-start native observation mismatch',
    });
  });

  it('rejects accessors and exotic prototypes without evaluating hostile fields', () => {
    const getter = vi.fn(() => 'x');
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'payload', { enumerable: true, get: getter });
    Object.defineProperty(hostile, 'signature', { enumerable: true, value: Buffer.alloc(64).toString('base64url') });
    expect(parseRuntimeActivationResidentStartPermit(hostile)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const key = keyFixture();
    const envelope = signRuntimeActivationResidentStartPermit(permitPayload(key.keyId), key.privateKey);
    const exotic = Object.assign(Object.create({ inherited: true }), envelope);
    expect(parseRuntimeActivationResidentStartPermit(exotic)).toBeNull();

    const ack = acknowledgement(envelope.payload) as unknown as Record<string, unknown>;
    Object.defineProperty(ack, 'unexpected', { enumerable: false, value: true });
    expect(parseRuntimeActivationResidentStartAcknowledgement(ack)).toBeNull();
  });

  it('requires one canonical UTF-8 JSON frame followed by one LF and EOF', () => {
    const key = keyFixture();
    const envelope = signRuntimeActivationResidentStartPermit(permitPayload(key.keyId), key.privateKey);
    const permitFrame = runtimeActivationResidentStartPermitFrame(envelope);
    const ackFrame = runtimeActivationResidentStartAcknowledgementFrame(acknowledgement(envelope.payload));
    expect(parseRuntimeActivationResidentStartPermitFrame(permitFrame)).not.toBeNull();
    expect(parseRuntimeActivationResidentStartAcknowledgementFrame(ackFrame)).not.toBeNull();

    const invalidPermitFrames = [
      permitFrame.slice(0, -1),
      permitFrame.replace(/\n$/u, '\r\n'),
      `${permitFrame} `,
      `${permitFrame}${permitFrame}`,
      `\uFEFF${permitFrame}`,
      permitFrame.replace('{', '{"payload":null,'),
      Buffer.from([0xff, 0x0a]),
      Buffer.alloc(64 * 1024 + 1, 0x20),
    ];
    for (const frame of invalidPermitFrames) {
      expect(parseRuntimeActivationResidentStartPermitFrame(frame)).toBeNull();
    }
    const invalidAckFrames = [
      ackFrame.slice(0, -1),
      ackFrame.replace(/\n$/u, '\r\n'),
      `${ackFrame}x`,
      `${ackFrame}${ackFrame}`,
      `\uFEFF${ackFrame}`,
      ackFrame.replace('{', '{"authority":null,'),
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.alloc(64 * 1024 + 1, 0x20),
    ];
    for (const frame of invalidAckFrames) {
      expect(parseRuntimeActivationResidentStartAcknowledgementFrame(frame)).toBeNull();
    }
  });

  it('rejects self-asserted authority, post-dispatch state, and unauthenticated channels', () => {
    const key = keyFixture();
    const permit = permitPayload(key.keyId);
    const attempts = [
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => {
        ack.authority = {
          ...ack.authority,
          startPermitted: true,
        } as unknown as RuntimeActivationResidentStartAcknowledgementV1['authority'];
      },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => {
        (ack.state as unknown as Record<string, unknown>)['phase'] = 'running';
      },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => {
        (ack.state as unknown as Record<string, unknown>)['dispatchAuthorized'] = true;
      },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => {
        (ack.channel as unknown as Record<string, unknown>)['peerCredentialsVerified'] = false;
      },
      (ack: RuntimeActivationResidentStartAcknowledgementV1) => {
        (ack.channel as unknown as Record<string, unknown>)['transport'] = 'local-file';
      },
    ];
    for (const mutate of attempts) {
      const ack = acknowledgement(permit);
      mutate(ack);
      expect(parseRuntimeActivationResidentStartAcknowledgement(ack)).toBeNull();
    }
  });

  it('keeps the production adapter frozen, empty-rooted, and unconditionally unavailable', () => {
    expect(Object.isFrozen(RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS)).toBe(true);
    expect(RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS).toEqual([]);
    expect(Object.isFrozen(runtimeActivationResidentStartRuntime)).toBe(true);
    expect(runtimeActivationResidentStartRuntime.roots).toBe(RUNTIME_ACTIVATION_RESIDENT_START_TRUST_ROOTS);
    expect(runtimeActivationResidentStartRuntime.requestNativeResidentStart()).toEqual({
      ok: false,
      reason: NATIVE_HOSTILE_PROCESS_CAS_UNAVAILABLE,
      authority: RUNTIME_ACTIVATION_RESIDENT_START_AUTHORITY,
      trustRootCount: 0,
      acknowledgementAccepted: false,
      serviceStarted: false,
      serviceEnabledChanged: false,
      pointerChanged: false,
      providerEffectsUnblocked: false,
    });
  });

  it('has no production effect graph, root registrar, environment gate, CLI, or package export', () => {
    const runtimeSource = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-resident-start-runtime.ts',
    ), 'utf8');
    const protocolSource = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-resident-start-protocol.ts',
    ), 'utf8');
    const daemonCli = readFileSync(join(repoRoot, 'src/cli/daemon.ts'), 'utf8');
    const packageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8');

    expect(runtimeSource).not.toMatch(/node:(?:child_process|fs|os)|launchctl|spawn|execFile|ensureRunning|install\(/u);
    expect(runtimeSource).not.toMatch(/process\.env|\.(?:register|replace)\s*\(|testOnly|homePath|HOME\s*[:=]/u);
    expect(protocolSource).not.toMatch(/node:(?:child_process|fs|os)|launchctl|spawn|execFile|ensureRunning/u);
    expect(daemonCli).not.toContain('runtime-activation-resident-start');
    expect(packageJson).not.toContain('runtime-activation-resident-start');
  });
});
