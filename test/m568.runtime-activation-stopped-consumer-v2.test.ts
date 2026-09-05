import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  sign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { canonicalizeDaemonActivationValue } from '../src/core/daemon/activation-permit.js';
import {
  evaluateRuntimeActivationStoppedConsumerV2Permit,
  parseRuntimeActivationStoppedConsumerV2Permit,
  parseRuntimeActivationStoppedConsumerV2PermitFrame,
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN,
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL,
  runtimeActivationStoppedConsumerV2KeyId,
  runtimeActivationStoppedConsumerV2PermitFrame,
  runtimeActivationStoppedConsumerV2PermitPayloadDigest,
  signRuntimeActivationStoppedConsumerV2Permit,
  verifyRuntimeActivationStoppedConsumerV2Permit,
  type RuntimeActivationStoppedConsumerV2Bindings,
  type RuntimeActivationStoppedConsumerV2PermitPayload,
  type RuntimeActivationStoppedConsumerV2TrustRoot,
} from '../src/core/daemon/runtime-activation-stopped-consumer-v2-protocol.js';
import {
  NATIVE_VERSION_GENERAL_STOPPED_SELECTION_UNAVAILABLE,
  RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS,
  runtimeActivationStoppedConsumerV2Runtime,
} from '../src/core/daemon/runtime-activation-stopped-consumer-v2-runtime.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');
const fixturePath = join(testDir, 'fixtures', 'm568', 'permit-golden.json');
const NOW = Date.parse('2026-09-04T16:00:30.000Z');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);
const SHA_F = 'f'.repeat(64);
const CANDIDATE_REVISION = '1'.repeat(40);
const CANDIDATE_TREE = '2'.repeat(40);
const ROLLBACK_REVISION = '3'.repeat(40);
const ROLLBACK_TREE = '4'.repeat(40);

interface GoldenFixture {
  publicKeySpki: string;
  keyId: string;
  payload: RuntimeActivationStoppedConsumerV2PermitPayload;
  signature: string;
  frameSha256: string;
  payloadDigest: string;
}

function keyFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = runtimeActivationStoppedConsumerV2KeyId(publicKey);
  const root: RuntimeActivationStoppedConsumerV2TrustRoot = {
    algorithm: 'ed25519',
    keyId,
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-09-04T15:59:00.000Z',
    validUntil: '2026-09-04T16:03:00.000Z',
  };
  return { privateKey, publicKey, keyId, root };
}

function bindings(
  candidateVersion = '3.4.0',
  rollbackVersion = '3.3.2',
): RuntimeActivationStoppedConsumerV2Bindings {
  return {
    activationId: '11111111-1111-4111-8111-111111111111',
    admissionDigest: SHA_A,
    planDigest: SHA_B,
    canonicalRequestSha256: SHA_C,
    trustRootCanonicalSha256: SHA_D,
    configSha256: SHA_E,
    homePath: '/Users/operator',
    releasesRoot: '/Users/operator/.local/share/ashlr/releases',
    currentPointerPath: '/Users/operator/.local/share/ashlr/current',
    plistPath: '/Users/operator/Library/LaunchAgents/ai.ashlr.daemon.plist',
    candidateRevision: CANDIDATE_REVISION,
    candidateExpectedTree: CANDIDATE_TREE,
    candidateVersion,
    candidateReleaseTag: `v${candidateVersion}`,
    candidateRuntimeTreeSha256: SHA_F,
    candidateManifestDigest: SHA_A,
    candidateLaunchReceiptSha256: SHA_B,
    candidateServiceDescriptorSha256: SHA_C,
    candidateServiceInvocationDigest: SHA_D,
    candidateCurrentTarget: `releases/${CANDIDATE_REVISION}`,
    rollbackRevision: ROLLBACK_REVISION,
    rollbackExpectedTree: ROLLBACK_TREE,
    rollbackVersion,
    rollbackReleaseTag: `v${rollbackVersion}`,
    rollbackRuntimeTreeSha256: SHA_E,
    rollbackManifestDigest: SHA_F,
    rollbackLaunchReceiptSha256: SHA_A,
    rollbackServiceDescriptorSha256: SHA_B,
    rollbackServiceInvocationDigest: SHA_C,
    priorCurrentTarget: `releases/${ROLLBACK_REVISION}`,
    priorPlistSha256: SHA_D,
    priorServiceLoaded: false,
    priorServiceDisabled: true,
    hostUid: 501,
    serviceLabel: 'ai.ashlr.daemon',
    serviceTarget: 'gui/501/ai.ashlr.daemon',
  };
}

function payload(
  keyId: string,
  candidateVersion = '3.4.0',
  rollbackVersion = '3.3.2',
): RuntimeActivationStoppedConsumerV2PermitPayload {
  return {
    schemaVersion: 2,
    protocol: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PROTOCOL,
    permitId: '22222222-2222-4222-8222-222222222222',
    keyId,
    issuedAt: '2026-09-04T16:00:00.000Z',
    expiresAt: '2026-09-04T16:02:00.000Z',
    scope: {
      action: 'select-exact-admitted-stopped-release',
      platform: 'darwin',
      nativeBrokerRequired: true,
      nativeConditionalCasRequired: true,
      maintenance: true,
      killSwitch: 'healthy-engaged',
      providerEffectsBlocked: true,
      serviceLoaded: false,
      serviceStart: false,
      serviceEnable: false,
      serviceInstall: false,
      pointerSelectionRequested: true,
      exactStoppedRollbackRequired: true,
      residentAcknowledgement: false,
      dispatchAuthorized: false,
    },
    bindings: bindings(candidateVersion, rollbackVersion),
  };
}

function rootFromFixture(fixture: GoldenFixture): RuntimeActivationStoppedConsumerV2TrustRoot {
  return {
    algorithm: 'ed25519',
    keyId: fixture.keyId,
    publicKeySpki: fixture.publicKeySpki,
    validFrom: '2026-09-04T15:59:00.000Z',
    validUntil: '2026-09-04T16:03:00.000Z',
  };
}

function loadFixture(): GoldenFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as GoldenFixture;
}

describe('M568 authority-free stopped-consumer v2 protocol', () => {
  it('matches a static cross-language golden frame and grants no authority', () => {
    const fixture = loadFixture();
    const publicKey = createPublicKey({
      key: Buffer.from(fixture.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    const envelope = { payload: fixture.payload, signature: fixture.signature };
    const frame = runtimeActivationStoppedConsumerV2PermitFrame(envelope);

    expect(runtimeActivationStoppedConsumerV2KeyId(publicKey)).toBe(fixture.keyId);
    expect(envelope.signature).toBe(fixture.signature);
    expect(createHash('sha256').update(frame).digest('hex')).toBe(fixture.frameSha256);
    expect(runtimeActivationStoppedConsumerV2PermitPayloadDigest(fixture.payload))
      .toBe(fixture.payloadDigest);
    expect(parseRuntimeActivationStoppedConsumerV2PermitFrame(frame)).toEqual(envelope);
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [rootFromFixture(fixture)],
      NOW,
    )).toBeNull();

    const evaluated = evaluateRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [rootFromFixture(fixture)],
      NOW,
      fixture.payload.bindings,
    );
    expect(evaluated).toEqual({
      ok: true,
      reason: 'exact version-general stopped-selection permit matched; mutation authority remains external',
      authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
      permitDigest: fixture.payloadDigest,
    });
    expect(Object.values(evaluated.authority)).toEqual(Array(11).fill(false));
  });

  it.each([
    ['3.4.0', '3.3.2'],
    ['3.4.0', '3.4.0'],
    ['4.0.0-rc.1', '3.4.0-beta.2'],
    ['12.345.678-native.9', '9.8.7-rollback.1'],
  ])('binds dynamic candidate %s and rollback %s versions only through the signed permit', (
    candidateVersion,
    rollbackVersion,
  ) => {
    const key = keyFixture();
    const next = payload(key.keyId, candidateVersion, rollbackVersion);
    const envelope = signRuntimeActivationStoppedConsumerV2Permit(next, key.privateKey);
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [key.root],
      NOW,
    )).toBeNull();
    expect(evaluateRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [key.root],
      NOW,
      next.bindings,
    ).ok).toBe(true);
  });

  it.each([
    ['candidate tag', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.candidateReleaseTag = 'v9.9.9';
    }],
    ['rollback tag', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.rollbackReleaseTag = 'v9.9.9';
    }],
    ['candidate current target', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.candidateCurrentTarget = `releases/${ROLLBACK_REVISION}`;
    }],
    ['prior current target', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.priorCurrentTarget = `releases/${CANDIDATE_REVISION}`;
    }],
    ['service target', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.serviceTarget = 'gui/502/ai.ashlr.daemon';
    }],
    ['host UID outside Darwin uid_t', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.hostUid = 0x1_0000_0000;
      value.bindings.serviceTarget = 'gui/4294967296/ai.ashlr.daemon';
    }],
    ['noncanonical HOME path', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.homePath = '/Users/operator/../operator';
    }],
    ['release-root relationship', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.releasesRoot = '/Users/operator/releases';
    }],
    ['candidate version outside M502 grammar', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.candidateVersion = '3.4';
      value.bindings.candidateReleaseTag = 'v3.4';
    }],
    ['candidate build metadata outside M502 grammar', (value: RuntimeActivationStoppedConsumerV2PermitPayload) => {
      value.bindings.candidateVersion = '3.4.0+build.1';
      value.bindings.candidateReleaseTag = 'v3.4.0+build.1';
    }],
  ])('rejects an invalid %s even when freshly signed', (_label, mutate) => {
    const key = keyFixture();
    const next = payload(key.keyId);
    mutate(next);
    const envelope = signRuntimeActivationStoppedConsumerV2Permit(next, key.privateKey);
    expect(parseRuntimeActivationStoppedConsumerV2Permit(envelope)).toBeNull();
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [key.root],
      NOW,
    )).toBe('runtime activation stopped-consumer v2 permit is invalid');
  });

  it('rejects cross-domain replay, duplicate roots, signature drift, and time drift', () => {
    const key = keyFixture();
    const next = payload(key.keyId);
    const envelope = signRuntimeActivationStoppedConsumerV2Permit(next, key.privateKey);
    const root = key.root;

    const crossDomain = structuredClone(envelope);
    crossDomain.signature = sign(
      null,
      Buffer.from(`ashlr:runtime-activation-stopped-consumer:permit:v1\0${canonicalizeDaemonActivationValue(
        next,
      )}`, 'utf8'),
      key.privateKey,
    ).toString('base64url');
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(crossDomain, [root], NOW))
      .toBe('runtime activation stopped-consumer v2 permit signature is invalid');
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(envelope, [root, root], NOW))
      .toBe('runtime activation stopped-consumer v2 signing root is unavailable');

    const rootGetter = vi.fn(() => key.keyId);
    const hostileRoot = { ...root } as unknown as Record<string, unknown>;
    Object.defineProperty(hostileRoot, 'keyId', { enumerable: true, get: rootGetter });
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [hostileRoot as unknown as RuntimeActivationStoppedConsumerV2TrustRoot],
      NOW,
    )).toBe('runtime activation stopped-consumer v2 signing root is unavailable');
    expect(rootGetter).not.toHaveBeenCalled();

    const tampered = structuredClone(envelope);
    tampered.payload.bindings.candidateVersion = '3.4.1';
    tampered.payload.bindings.candidateReleaseTag = 'v3.4.1';
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(tampered, [root], NOW))
      .toBe('runtime activation stopped-consumer v2 permit signature is invalid');
    expect(verifyRuntimeActivationStoppedConsumerV2Permit(
      envelope,
      [root],
      Date.parse(next.expiresAt),
    )).toBe('runtime activation stopped-consumer v2 permit is outside its validity window');
  });

  it('rejects complete-binding drift after signature verification', () => {
    const fixture = loadFixture();
    const envelope = {
      payload: fixture.payload,
      signature: fixture.signature,
    };
    const root = rootFromFixture(fixture);
    for (const field of [
      'candidateVersion',
      'candidateRevision',
      'candidateManifestDigest',
      'rollbackVersion',
      'rollbackRevision',
      'rollbackManifestDigest',
      'priorPlistSha256',
      'priorServiceDisabled',
      'hostUid',
      'currentPointerPath',
    ] as const) {
      const expected = structuredClone(fixture.payload.bindings);
      const value = expected as unknown as Record<string, unknown>;
      value[field] = typeof value[field] === 'boolean'
        ? !value[field]
        : typeof value[field] === 'number'
          ? Number(value[field]) + 1
          : `${String(value[field])}x`;
      expect(evaluateRuntimeActivationStoppedConsumerV2Permit(
        envelope,
        [root],
        NOW,
        expected,
      )).toMatchObject({
        ok: false,
        reason: 'runtime activation stopped-consumer v2 binding mismatch',
        permitDigest: null,
      });
    }
  });

  it('rejects accessors, exotic prototypes, noncanonical frames, and malformed UTF-8', () => {
    const getter = vi.fn(() => fixturePath);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'payload', { enumerable: true, get: getter });
    Object.defineProperty(hostile, 'signature', {
      enumerable: true,
      value: Buffer.alloc(64).toString('base64url'),
    });
    expect(parseRuntimeActivationStoppedConsumerV2Permit(hostile)).toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const fixture = loadFixture();
    const envelope = { payload: fixture.payload, signature: fixture.signature };
    expect(parseRuntimeActivationStoppedConsumerV2Permit(
      Object.assign(Object.create({ inherited: true }), envelope),
    )).toBeNull();
    const frame = runtimeActivationStoppedConsumerV2PermitFrame(envelope);
    for (const invalid of [
      frame.slice(0, -1),
      frame.replace(/\n$/u, '\r\n'),
      `${frame} `,
      `${frame}${frame}`,
      `\uFEFF${frame}`,
      Buffer.from([0xc3, 0x28, 0x0a]),
      Buffer.alloc(64 * 1024 + 1, 0x20),
    ]) {
      expect(parseRuntimeActivationStoppedConsumerV2PermitFrame(invalid)).toBeNull();
    }
  });

  it('keeps production roots frozen and the runtime unconditionally unavailable', () => {
    expect(Object.isFrozen(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS)).toBe(true);
    expect(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS).toEqual([]);
    expect(Object.isFrozen(runtimeActivationStoppedConsumerV2Runtime)).toBe(true);
    expect(runtimeActivationStoppedConsumerV2Runtime.roots)
      .toBe(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_TRUST_ROOTS);
    expect(runtimeActivationStoppedConsumerV2Runtime.requestStoppedSelection()).toEqual({
      ok: false,
      reason: NATIVE_VERSION_GENERAL_STOPPED_SELECTION_UNAVAILABLE,
      authority: RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_AUTHORITY,
      trustRootCount: 0,
      permitAccepted: false,
      selectionAuthorized: false,
      pointerChanged: false,
      plistChanged: false,
      serviceStarted: false,
      serviceEnabledChanged: false,
      acknowledgementAccepted: false,
      dispatchAuthorized: false,
      rollbackAuthorized: false,
      providerEffectsUnblocked: false,
    });
  });

  it('preserves M520 v1 and has no production effect graph or runtime injection seam', () => {
    const v1 = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-stopped-consumer.ts',
    ), 'utf8');
    const protocol = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-stopped-consumer-v2-protocol.ts',
    ), 'utf8');
    const runtime = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-stopped-consumer-v2-runtime.ts',
    ), 'utf8');
    const transaction = readFileSync(join(
      repoRoot,
      'src/core/daemon/runtime-activation-transaction.ts',
    ), 'utf8');
    const daemonCli = readFileSync(join(repoRoot, 'src/cli/daemon.ts'), 'utf8');

    expect(v1).toContain("const PROTOCOL = 'runtime-activation-stopped-consumer-v1'");
    expect(v1).toContain("action: 'select-verified-3.2.7-stopped-release'");
    expect(v1).toContain("candidateVersion: '3.2.7'");
    expect(v1).not.toContain('stopped-consumer-v2');
    expect(transaction).not.toContain('stopped-consumer-v2');
    expect(daemonCli).not.toContain('stopped-consumer-v2');
    expect(protocol).not.toMatch(/node:(?:child_process|fs|os)|launchctl|spawn|execFile|ensureRunning|install\(/u);
    expect(runtime).not.toMatch(/node:(?:child_process|fs|os)|launchctl|spawn|execFile|ensureRunning|install\(/u);
    expect(runtime).not.toMatch(/process\.env|\.(?:register|replace)\s*\(|testOnly|homePath|HOME\s*[:=]/u);
  });

  it('uses a permit domain distinct from M520 v1 and M521 resident start', () => {
    expect(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN)
      .toBe('ashlr:runtime-activation-stopped-consumer:permit:v2');
    expect(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN)
      .not.toBe('ashlr:runtime-activation-stopped-consumer:permit:v1');
    expect(RUNTIME_ACTIVATION_STOPPED_CONSUMER_V2_PERMIT_DOMAIN)
      .not.toBe('ashlr:runtime-activation-resident-start:permit:v1');
  });
});
