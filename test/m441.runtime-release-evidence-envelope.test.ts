import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeReleaseEvidenceTrustRoot,
  parseRuntimeReleaseEvidenceEnvelope,
  parseRuntimeReleaseEvidenceTrustRoot,
  RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2,
  RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2,
  runtimeReleaseEvidenceKeyId,
  signRuntimeReleaseEvidenceEnvelope,
  verifyRuntimeReleaseEvidenceEnvelope,
} from '../src/core/daemon/runtime-release-evidence-envelope.js';
import {
  buildUnsignedRuntimeReleaseManifest,
} from '../src/core/daemon/runtime-release-manifest.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';

const ISSUED_AT = '2026-07-29T12:00:00.000Z';
const EXPIRES_AT = '2026-07-29T12:10:00.000Z';
const NOW = '2026-07-29T12:05:00.000Z';
const REVISION = 'a'.repeat(40);
const KEY_VALID_FROM = '2026-07-29T11:00:00.000Z';
const KEY_VALID_UNTIL = '2026-07-29T13:00:00.000Z';
const SIGNATURE_INPUT_DOMAIN = 'ashlr:runtime-release-evidence-signature-input:v2';
const tempDirs: string[] = [];

function write(path: string, value: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    value,
    mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode },
  );
}

function releaseManifest(marker = 'first', expectedRevision = REVISION): string {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-signed-release-')));
  tempDirs.push(packageRoot);
  write(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    dependencies: { example: '1.0.0' },
    bundledDependencies: ['example'],
  }, null, 2)}\n`);
  write(join(packageRoot, 'package-lock.json'), `${JSON.stringify({
    name: '@ashlr/hub',
    version: '3.1.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: '@ashlr/hub',
        version: '3.1.0',
        bin: { ashlr: 'bin/ashlr' },
        dependencies: { example: '1.0.0' },
      },
      'node_modules/example': { version: '1.0.0' },
    },
  }, null, 2)}\n`);
  write(join(packageRoot, 'bin', 'ashlr'), '#!/usr/bin/env node\n', 0o755);
  write(join(packageRoot, 'dist', 'cli', 'index.js'), `export const marker = '${marker}';\n`);
  write(join(packageRoot, 'scripts', 'run-verify-command.mjs'), 'export const run = true;\n');
  const dependencyRoot = join(packageRoot, 'node_modules');
  write(join(dependencyRoot, 'example', 'package.json'), '{"name":"example","version":"1.0.0"}\n');
  write(join(dependencyRoot, 'example', 'index.js'), 'export const example = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(packageRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(
    join(packageRoot, ...RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH.split('/')),
    inventory.canonicalJson,
  );
  const interpreterPath = join(packageRoot, 'fixture-node');
  write(interpreterPath, 'fixture node binary\n', 0o755);
  const built = buildUnsignedRuntimeReleaseManifest({
    packageRoot,
    dependencyRoot,
    declaredInterpreterPath: interpreterPath,
    declaredInterpreterVersion: 'v22.0.0',
    expectedRevision,
  });
  if (!built.ok) throw new Error(built.reason);
  return built.canonicalJson;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

function encode(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function object(input: string): Record<string, unknown> {
  return JSON.parse(input) as Record<string, unknown>;
}

function trustRoot(publicKey: KeyObject): string {
  const built = buildRuntimeReleaseEvidenceTrustRoot({
    keys: [{
      publicKey,
      validFrom: KEY_VALID_FROM,
      validUntil: KEY_VALID_UNTIL,
    }],
  });
  if (!built.ok) throw new Error(built.reason);
  return built.canonicalJson;
}

function signed(
  manifest: string,
  privateKey: KeyObject,
  issuedAt = ISSUED_AT,
  expiresAt = EXPIRES_AT,
): string {
  const result = signRuntimeReleaseEvidenceEnvelope({
    manifest,
    privateKey,
    issuedAt,
    expiresAt,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.canonicalJson;
}

function resign(envelope: Record<string, unknown>, privateKey: KeyObject): void {
  const { signature: _signature, ...unsigned } = envelope;
  envelope['signature'] = cryptoSign(
    null,
    Buffer.concat([
      Buffer.from(`${SIGNATURE_INPUT_DOMAIN}\n`, 'utf8'),
      Buffer.from(JSON.stringify(canonicalValue(unsigned)), 'utf8'),
    ]),
    privateKey,
  ).toString('base64url');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('signed runtime release evidence envelope', () => {
  it('signs deterministic canonical observation evidence and verifies a caller trust root', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const first = signRuntimeReleaseEvidenceEnvelope({
      manifest,
      privateKey: keys.privateKey,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
    const second = signRuntimeReleaseEvidenceEnvelope({
      manifest,
      privateKey: keys.privateKey,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.canonicalJson.endsWith('\n')).toBe(true);
    expect(first.envelope).toMatchObject({
      algorithm: 'ed25519',
      domain: RUNTIME_RELEASE_EVIDENCE_ENVELOPE_DOMAIN_V2,
      keyId: runtimeReleaseEvidenceKeyId(keys.publicKey),
      payload: {
        assurance: 'signed-observation-only',
        coverage: RUNTIME_RELEASE_EVIDENCE_REQUIRED_COVERAGE_V2,
        expiresAt: EXPIRES_AT,
        expectedRevision: REVISION,
        issuedAt: ISSUED_AT,
        schemaVersion: 2,
      },
      schemaVersion: 2,
    });
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: first.canonicalJson,
      manifest,
      trustRoot: trustRoot(keys.publicKey),
    })).toEqual({
      ok: true,
      assurance: 'signed-observation-only',
      expiresAt: EXPIRES_AT,
      issuedAt: ISSUED_AT,
      keyId: first.keyId,
      manifestDigest: first.envelope.payload.manifestDigest,
      expectedRevision: REVISION,
      rollbackTargetManifestDigest: null,
      verifiedAtMs: Date.parse(NOW),
    });
  });

  it('fails closed on an unknown key and a signature from the wrong key', () => {
    const manifest = releaseManifest();
    const signer = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const envelope = signed(manifest, signer.privateKey);

    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope,
      manifest,
      trustRoot: trustRoot(other.publicKey),
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence signing key is unknown',
    });

    const tamperedRoot = object(trustRoot(signer.publicKey));
    const keys = tamperedRoot['keys'] as Array<Record<string, unknown>>;
    const otherRoot = object(trustRoot(other.publicKey));
    keys[0]!['publicKeySpki'] =
      (otherRoot['keys'] as Array<Record<string, unknown>>)[0]!['publicKeySpki'];
    expect(parseRuntimeReleaseEvidenceTrustRoot(encode(tamperedRoot))).toEqual({
      ok: false,
      reason: 'runtime release evidence trust key id does not match public key',
    });
  });

  it('rejects malformed, noncanonical, and cryptographically invalid signatures', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const envelope = object(signed(manifest, keys.privateKey));

    envelope['signature'] = `${envelope['signature'] as string}=`;
    expect(parseRuntimeReleaseEvidenceEnvelope(encode(envelope))).toEqual({
      ok: false,
      reason: 'runtime release evidence signature is invalid',
    });

    const invalid = object(signed(manifest, keys.privateKey));
    const signature = invalid['signature'] as string;
    invalid['signature'] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: encode(invalid),
      manifest,
      trustRoot: trustRoot(keys.publicKey),
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence signature verification failed',
    });

    const canonical = signed(manifest, keys.privateKey);
    expect(parseRuntimeReleaseEvidenceEnvelope(JSON.stringify(object(canonical), null, 2)))
      .toEqual({
        ok: false,
        reason: 'runtime release evidence envelope encoding is not canonical',
      });
  });

  it('rejects unsupported schema, algorithm, and domain identifiers', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');

    for (const [field, value, reason] of [
      ['schemaVersion', 1, 'runtime release evidence envelope schema is unsupported'],
      ['algorithm', 'rsa-pss-sha256', 'runtime release evidence envelope algorithm is unsupported'],
      ['domain', 'ashlr:other:v1', 'runtime release evidence envelope domain is unsupported'],
    ] as const) {
      const envelope = object(signed(manifest, keys.privateKey));
      envelope[field] = value;
      expect(parseRuntimeReleaseEvidenceEnvelope(encode(envelope))).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('rejects stale, future, and overlong evidence lifetimes', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const root = trustRoot(keys.publicKey);

    vi.setSystemTime(EXPIRES_AT);
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: signed(manifest, keys.privateKey),
      manifest,
      trustRoot: root,
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence is stale',
    });
    const historicalTimestampReplay = {
      clock: () => Date.parse(NOW),
      envelope: signed(manifest, keys.privateKey),
      manifest,
      trustRoot: root,
    };
    expect(verifyRuntimeReleaseEvidenceEnvelope(historicalTimestampReplay)).toEqual({
      ok: false,
      reason: 'runtime release evidence is stale',
    });
    vi.setSystemTime('2026-07-29T11:59:59.999Z');
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: signed(manifest, keys.privateKey),
      manifest,
      trustRoot: root,
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence is not yet valid',
    });
    expect(signRuntimeReleaseEvidenceEnvelope({
      manifest,
      privateKey: keys.privateKey,
      issuedAt: ISSUED_AT,
      expiresAt: '2026-07-29T12:15:00.001Z',
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence lifetime is invalid',
    });
  });

  it('binds both the manifest digest and its complete canonical bytes', () => {
    const firstManifest = releaseManifest('first');
    const secondManifest = releaseManifest('second');
    const keys = generateKeyPairSync('ed25519');

    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: signed(firstManifest, keys.privateKey),
      manifest: secondManifest,
      trustRoot: trustRoot(keys.publicKey),
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence manifest digest mismatch',
    });

    const envelope = object(signed(firstManifest, keys.privateKey));
    const payload = envelope['payload'] as Record<string, unknown>;
    payload['manifestCanonicalSha256'] = '0'.repeat(64);
    resign(envelope, keys.privateKey);
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: encode(envelope),
      manifest: firstManifest,
      trustRoot: trustRoot(keys.publicKey),
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence canonical manifest digest mismatch',
    });
  });

  it('binds the signed payload to the manifest revision', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const envelope = object(signed(manifest, keys.privateKey));
    const payload = envelope['payload'] as Record<string, unknown>;
    payload['expectedRevision'] = 'b'.repeat(40);
    resign(envelope, keys.privateKey);

    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope: encode(envelope),
      manifest,
      trustRoot: trustRoot(keys.publicKey),
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence expected revision mismatch',
    });
  });

  it('requires the complete observation-only coverage contract in envelope and trust root', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const envelope = object(signed(manifest, keys.privateKey));
    const payload = envelope['payload'] as Record<string, unknown>;
    delete (payload['coverage'] as Record<string, unknown>)['authority'];
    expect(parseRuntimeReleaseEvidenceEnvelope(encode(envelope))).toEqual({
      ok: false,
      reason: 'runtime release evidence coverage is incomplete or unsupported',
    });

    const root = object(trustRoot(keys.publicKey));
    delete (root['requiredCoverage'] as Record<string, unknown>)['configuration'];
    expect(parseRuntimeReleaseEvidenceTrustRoot(encode(root))).toEqual({
      ok: false,
      reason: 'runtime release evidence required coverage is incomplete or unsupported',
    });

    const overclaim = object(signed(manifest, keys.privateKey));
    const overclaimPayload = overclaim['payload'] as Record<string, unknown>;
    (overclaimPayload['coverage'] as Record<string, unknown>)['authority'] = 'install-authority';
    expect(parseRuntimeReleaseEvidenceEnvelope(encode(overclaim))).toEqual({
      ok: false,
      reason: 'runtime release evidence coverage is incomplete or unsupported',
    });
  });

  it('enforces trust-key identity, uniqueness, algorithm, and validity boundaries', () => {
    const manifest = releaseManifest();
    const keys = generateKeyPairSync('ed25519');
    const envelope = signed(manifest, keys.privateKey);

    expect(buildRuntimeReleaseEvidenceTrustRoot({
      keys: [
        {
          publicKey: keys.publicKey,
          validFrom: KEY_VALID_FROM,
          validUntil: KEY_VALID_UNTIL,
        },
        {
          publicKey: keys.publicKey,
          validFrom: KEY_VALID_FROM,
          validUntil: KEY_VALID_UNTIL,
        },
      ],
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence trust keys must be unique',
    });

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(buildRuntimeReleaseEvidenceTrustRoot({
      keys: [{
        publicKey: rsa.publicKey,
        validFrom: KEY_VALID_FROM,
        validUntil: KEY_VALID_UNTIL,
      }],
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence public key must be Ed25519',
    });

    const shortValidity = buildRuntimeReleaseEvidenceTrustRoot({
      keys: [{
        publicKey: keys.publicKey,
        validFrom: KEY_VALID_FROM,
        validUntil: '2026-07-29T12:05:00.000Z',
      }],
    });
    if (!shortValidity.ok) throw new Error(shortValidity.reason);
    vi.setSystemTime('2026-07-29T12:04:00.000Z');
    expect(verifyRuntimeReleaseEvidenceEnvelope({
      envelope,
      manifest,
      trustRoot: shortValidity.canonicalJson,
    })).toEqual({
      ok: false,
      reason: 'runtime release evidence falls outside signing key validity',
    });
  });

  it('bounds untrusted envelope and trust-root bytes', () => {
    expect(parseRuntimeReleaseEvidenceEnvelope(Buffer.alloc(16 * 1_024 + 1, 0x61)))
      .toEqual({
        ok: false,
        reason: 'runtime release evidence envelope byte length is invalid',
      });
    expect(parseRuntimeReleaseEvidenceTrustRoot(Buffer.alloc(64 * 1_024 + 1, 0x61)))
      .toEqual({
        ok: false,
        reason: 'runtime release evidence trust root byte length is invalid',
      });
  });
});
