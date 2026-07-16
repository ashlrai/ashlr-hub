/**
 * M431 - dedicated evidence-pack v3 signing-key identity and self-excluding seal.
 *
 * HOME is isolated per test so no real provenance key is read or modified.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authorityHarness = vi.hoisted(() => ({
  privateStorageRequests: [] as Array<{
    path: string;
    kind: 'file' | 'directory';
    mode: 'secure-created' | 'inspect-existing' | 'inspect-owned';
    anchorPath: string | undefined;
  }>,
  rejectPrivatePath: undefined as string | undefined,
  durablePaths: [] as string[],
  rejectDurablePath: undefined as string | undefined,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath(
      assuredPath: string,
      kind: 'file' | 'directory',
      mode: 'secure-created' | 'inspect-existing' | 'inspect-owned',
      options: { anchorPath?: string } = {},
    ) {
      authorityHarness.privateStorageRequests.push({
        path: assuredPath,
        kind,
        mode,
        anchorPath: options.anchorPath,
      });
      return authorityHarness.rejectPrivatePath === assuredPath
        ? { ok: false, reason: 'injected-unsafe-existing-path' }
        : { ok: true, reason: mode === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl' };
    },
  };
});

vi.mock('../src/core/util/durability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/durability.js')>();
  return {
    ...actual,
    fsyncDirectory(durablePath: string, options?: import('../src/core/util/durability.js').DirectoryDurabilityOptions) {
      authorityHarness.durablePaths.push(durablePath);
      if (authorityHarness.rejectDurablePath === durablePath) {
        throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
      }
      return actual.fsyncDirectory(durablePath, options);
    },
  };
});

import {
  canonicalEvidencePackJsonV3,
  EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM,
  loadOrCreateKey,
  provenanceKeyPath,
  sealedEvidencePackDigestV3,
  signEvidencePackPayloadV3,
  verifyEvidencePackPayloadV3,
  verifySealedEvidencePackDigestV3,
  type EvidencePackPayloadSignatureV3,
} from '../src/core/foundry/provenance.js';

const PAYLOAD_DOMAIN = 'ashlr.autonomy-evidence-pack.payload.v3';
const SIGNATURE_DOMAIN = 'ashlr.autonomy-evidence-pack.signature.v3';
const SEAL_DOMAIN = 'ashlr.autonomy-evidence-pack.seal.v3';
const SIGNING_KEY_DOMAIN = 'ashlr.autonomy-evidence-pack.signing-key.v3';
const SIGNING_KEY_ID_DOMAIN = 'ashlr.autonomy-evidence-pack.signing-key-id.v3';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let tmpHome: string;

const payload = {
  version: 3,
  generatedAt: '2026-07-16T12:00:00.000Z',
  proposal: { id: 'proposal-m431', title: 'dedicated evidence signing key' },
};

function verify(
  value: unknown,
  signed: EvidencePackPayloadSignatureV3,
) {
  return verifyEvidencePackPayloadV3(
    value,
    signed.payloadDigest,
    signed.signature,
    signed.signatureAlgorithm,
    signed.signingKeyId,
  );
}

function domainDigest(domain: string, value: unknown): string {
  const canonical = canonicalEvidencePackJsonV3(value);
  expect(canonical).not.toBeNull();
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n')
    .update(canonical!, 'utf8')
    .digest('hex');
}

beforeEach(() => {
  authorityHarness.privateStorageRequests.length = 0;
  authorityHarness.rejectPrivatePath = undefined;
  authorityHarness.durablePaths.length = 0;
  authorityHarness.rejectDurablePath = undefined;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m431-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  authorityHarness.rejectPrivatePath = undefined;
  authorityHarness.rejectDurablePath = undefined;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

describe('M431 dedicated evidence signing key', () => {
  it('assures exact private storage for a fresh key root and file', () => {
    const keyPath = provenanceKeyPath();
    const ashlrRoot = path.join(tmpHome, '.ashlr');
    const keyRoot = path.dirname(keyPath);

    expect(loadOrCreateKey()).toHaveLength(32);
    expect(authorityHarness.privateStorageRequests).toEqual([
      { path: ashlrRoot, kind: 'directory', mode: 'secure-created', anchorPath: tmpHome },
      { path: keyRoot, kind: 'directory', mode: 'secure-created', anchorPath: tmpHome },
      expect.objectContaining({
        path: expect.stringMatching(/provenance\.key\.\d+\.[a-f0-9]{24}\.tmp$/),
        kind: 'file',
        mode: 'secure-created',
        anchorPath: keyRoot,
      }),
      { path: keyPath, kind: 'file', mode: 'inspect-existing', anchorPath: keyRoot },
    ]);
    expect(authorityHarness.durablePaths).toEqual([tmpHome, ashlrRoot, keyRoot]);
  });

  it.each([
    ['Ashlr root', () => path.join(tmpHome, '.ashlr')],
    ['key root', () => path.dirname(provenanceKeyPath())],
    ['key file', () => provenanceKeyPath()],
  ])('fails closed without repairing an unsafe existing %s', (_label, rejectedPath) => {
    const keyPath = provenanceKeyPath();
    expect(loadOrCreateKey()).toHaveLength(32);
    const before = fs.lstatSync(keyPath);
    const bytes = fs.readFileSync(keyPath);
    authorityHarness.privateStorageRequests.length = 0;
    authorityHarness.rejectPrivatePath = rejectedPath();

    expect(() => loadOrCreateKey()).toThrow(/exact private storage.*injected-unsafe-existing-path/i);
    expect(signEvidencePackPayloadV3(payload)).toBeNull();
    const after = fs.lstatSync(keyPath);
    expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      size: before.size,
    });
    expect(fs.readFileSync(keyPath)).toEqual(bytes);
    expect(authorityHarness.privateStorageRequests.some(({ mode }) => mode === 'secure-created')).toBe(false);
  });

  it('does not return newly installed authority when parent durability fails', () => {
    const keyPath = provenanceKeyPath();
    const keyRoot = path.dirname(keyPath);
    authorityHarness.rejectDurablePath = keyRoot;

    expect(() => loadOrCreateKey()).toThrow(/could not make storage directory durable/i);
    expect(fs.readFileSync(keyPath)).toHaveLength(32);
    expect(fs.readdirSync(keyRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(authorityHarness.durablePaths).toEqual([
      tmpHome,
      path.join(tmpHome, '.ashlr'),
      keyRoot,
    ]);

    authorityHarness.rejectDurablePath = undefined;
    expect(loadOrCreateKey()).toEqual(fs.readFileSync(keyPath));
  });

  it.each([
    ['home', () => tmpHome],
    ['Ashlr root', () => path.join(tmpHome, '.ashlr')],
  ])('does not create a key when the fresh %s directory entry is not durable', (_label, parentPath) => {
    authorityHarness.rejectDurablePath = parentPath();

    expect(() => loadOrCreateKey()).toThrow(/could not make storage directory durable/i);
    expect(fs.existsSync(provenanceKeyPath())).toBe(false);
  });

  it('rejects relative HOME and USERPROFILE without creating worktree authority', () => {
    process.env.HOME = '.';
    process.env.USERPROFILE = '.';

    expect(() => provenanceKeyPath()).toThrow(/invalid home directory/i);
    expect(signEvidencePackPayloadV3(payload)).toBeNull();
    expect(fs.existsSync(path.join(process.cwd(), '.ashlr', 'foundry', 'provenance.key'))).toBe(false);
  });

  it.each([
    ['filesystem root', () => path.parse(tmpHome).root],
    ['current worktree', () => process.cwd()],
    ['worktree descendant', () => path.join(process.cwd(), '.m431-unsafe-home')],
  ])('rejects the absolute but unsafe %s as HOME and USERPROFILE', (_label, unsafeHome) => {
    process.env.HOME = unsafeHome();
    process.env.USERPROFILE = unsafeHome();

    expect(() => provenanceKeyPath()).toThrow(/unsafe home directory/i);
    expect(signEvidencePackPayloadV3(payload)).toBeNull();
  });

  it('freezes the derived key identity and complete HMAC transcript', () => {
    const signed = signEvidencePackPayloadV3(payload);
    expect(signed).not.toBeNull();

    const provenanceKey = fs.readFileSync(provenanceKeyPath());
    const signingKey = createHmac('sha256', provenanceKey)
      .update(SIGNING_KEY_DOMAIN, 'utf8')
      .update('\n')
      .digest();
    const expectedKeyId = createHash('sha256')
      .update(SIGNING_KEY_ID_DOMAIN, 'utf8')
      .update('\n')
      .update(signingKey)
      .digest('hex');
    const expectedPayloadDigest = domainDigest(PAYLOAD_DOMAIN, payload);
    const expectedSignature = createHmac('sha256', signingKey)
      .update(SIGNATURE_DOMAIN, 'utf8')
      .update('\n')
      .update(EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM, 'utf8')
      .update('\n')
      .update(expectedKeyId, 'utf8')
      .update('\n')
      .update(expectedPayloadDigest, 'utf8')
      .digest('hex');

    expect(signed).toEqual({
      payloadDigest: expectedPayloadDigest,
      signatureAlgorithm: 'hmac-sha256',
      signingKeyId: expectedKeyId,
      signature: expectedSignature,
    });
    authorityHarness.durablePaths.length = 0;
    expect(verify(payload, signed!)).toMatchObject({ ok: true });
    expect(authorityHarness.durablePaths).toEqual([]);
    expect(authorityHarness.privateStorageRequests.slice(-3)).toEqual([
      { path: path.join(tmpHome, '.ashlr'), kind: 'directory', mode: 'inspect-existing', anchorPath: tmpHome },
      {
        path: path.join(tmpHome, '.ashlr', 'foundry'),
        kind: 'directory',
        mode: 'inspect-existing',
        anchorPath: tmpHome,
      },
      {
        path: provenanceKeyPath(),
        kind: 'file',
        mode: 'inspect-existing',
        anchorPath: path.join(tmpHome, '.ashlr', 'foundry'),
      },
    ]);
  });

  it('keeps one stable identity per protected provenance-key generation', () => {
    const first = signEvidencePackPayloadV3(payload);
    const second = signEvidencePackPayloadV3({ ...payload, generatedAt: '2026-07-16T12:01:00.000Z' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.signatureAlgorithm).toBe(EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM);
    expect(first!.signingKeyId).toMatch(/^[0-9a-f]{64}$/);
    expect(second!.signingKeyId).toBe(first!.signingKeyId);
    expect(second!.signature).not.toBe(first!.signature);
  });

  it('reports a replaced current key as unknown instead of a signature mismatch', () => {
    const historical = signEvidencePackPayloadV3(payload);
    expect(historical).not.toBeNull();

    fs.writeFileSync(provenanceKeyPath(), randomBytes(32), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(provenanceKeyPath(), 0o600);
    const current = signEvidencePackPayloadV3(payload);
    expect(current).not.toBeNull();
    expect(current!.signingKeyId).not.toBe(historical!.signingKeyId);

    expect(verify(payload, historical!)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/unknown.*signing key id/i),
    });
    expect(verify(payload, current!)).toMatchObject({ ok: true });
  });

  it('distinguishes unknown algorithms, unknown key ids, and bad signatures', () => {
    const signed = signEvidencePackPayloadV3(payload);
    expect(signed).not.toBeNull();

    expect(verifyEvidencePackPayloadV3(
      payload,
      signed!.payloadDigest,
      signed!.signature,
      'hmac-sha512',
      signed!.signingKeyId,
    ).reason).toMatch(/unsupported.*algorithm/i);
    expect(verifyEvidencePackPayloadV3(
      payload,
      signed!.payloadDigest,
      signed!.signature,
      signed!.signatureAlgorithm,
      '0'.repeat(64),
    ).reason).toMatch(/unknown.*signing key id/i);
    expect(verifyEvidencePackPayloadV3(
      payload,
      signed!.payloadDigest,
      '0'.repeat(64),
      signed!.signatureAlgorithm,
      signed!.signingKeyId,
    ).reason).toMatch(/signature mismatch/i);
  });

  it('rejects identity-less legacy calls and never creates a key while verifying', () => {
    const payloadDigest = domainDigest(PAYLOAD_DOMAIN, payload);

    expect(verifyEvidencePackPayloadV3(
      payload,
      payloadDigest,
      '0'.repeat(64),
    ).reason).toMatch(/missing.*signature algorithm/i);
    expect(verifyEvidencePackPayloadV3(
      payload,
      payloadDigest,
      '0'.repeat(64),
      EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM,
      'a'.repeat(64),
    ).reason).toMatch(/missing.*provenance key/i);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr'))).toBe(false);
  });
});

describe('M431 self-excluding complete-pack seal', () => {
  it('excludes exactly sealedPackDigest from a complete plain envelope', () => {
    const preSeal = {
      version: 3,
      payloadDigest: 'a'.repeat(64),
      signatureAlgorithm: EVIDENCE_PACK_V3_SIGNATURE_ALGORITHM,
      signingKeyId: 'b'.repeat(64),
      signature: 'c'.repeat(64),
      similarlyNamedSealedPackDigest: 'retained',
    };
    const complete = { ...preSeal, sealedPackDigest: 'd'.repeat(64) };
    const expected = domainDigest(SEAL_DOMAIN, preSeal);

    expect(sealedEvidencePackDigestV3(preSeal)).toBe(expected);
    expect(sealedEvidencePackDigestV3(complete)).toBe(expected);
    expect(sealedEvidencePackDigestV3({
      ...complete,
      sealedPackDigest: 'e'.repeat(64),
    })).toBe(expected);
    expect(sealedEvidencePackDigestV3({
      ...complete,
      similarlyNamedSealedPackDigest: 'changed',
    })).not.toBe(expected);
    expect(verifySealedEvidencePackDigestV3(complete, expected)).toMatchObject({ ok: true });
  });

  it('requires a plain data envelope before performing self-exclusion', () => {
    const accessor = { version: 3 } as Record<string, unknown>;
    Object.defineProperty(accessor, 'sealedPackDigest', {
      enumerable: true,
      get: () => 'a'.repeat(64),
    });

    expect(sealedEvidencePackDigestV3([])).toBeNull();
    expect(sealedEvidencePackDigestV3(new Date())).toBeNull();
    expect(sealedEvidencePackDigestV3(accessor)).toBeNull();
  });
});
