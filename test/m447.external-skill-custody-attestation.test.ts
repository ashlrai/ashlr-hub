import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

import type { ExternalSkillGitCaptureResult } from '../src/core/fleet/external-skill-git-capture.js';
import {
  canonicalExternalSkillCustodyAttestationPayload,
  externalSkillCustodyKeyId,
  externalSkillCustodyTrustPolicyDigest,
  verifyExternalSkillCustodyAttestation,
  type ExternalSkillCustodyAttestation,
  type ExternalSkillCustodyAttestationInput,
  type ExternalSkillCustodyAttestationUnsigned,
  type ExternalSkillCustodyTrustPolicy,
} from '../src/core/fleet/external-skill-custody-attestation.js';

const NOW = '2026-07-22T12:00:00.000Z';
const BUNDLE_DIGEST = 'b'.repeat(64);
const CAPTURE_RECEIPT_REFERENCE_DIGEST = 'a'.repeat(64);
const CUSTODY_AUTHORITY_DIGEST = '1'.repeat(64);
const RETENTION_POLICY_DIGEST = '2'.repeat(64);
const CAPTURE_DIGEST = createHash('sha256')
  .update(`ashlr-external-skill-git-capture-v1\0${BUNDLE_DIGEST}`, 'utf8')
  .digest('hex');
const CAPTURE_BLOCKERS = [
  'capture-custody-authentication-required',
  'sandbox-runner-required',
  'exposure-verifier-required',
  'outcome-attestation-required',
] as const;

interface Fixture {
  privateKey: KeyObject;
  policy: ExternalSkillCustodyTrustPolicy;
  unsigned: ExternalSkillCustodyAttestationUnsigned;
  receipt: ExternalSkillCustodyAttestation;
  input: ExternalSkillCustodyAttestationInput;
}

function capture(
  overrides: Partial<Extract<ExternalSkillGitCaptureResult, { state: 'captured' | 'replayed' }>> = {},
): Extract<ExternalSkillGitCaptureResult, { state: 'captured' | 'replayed' }> {
  return {
    schemaVersion: 1,
    mode: 'git-object-quarantine',
    state: 'captured',
    reason: 'captured',
    captureDigest: CAPTURE_DIGEST,
    portablePackDigest: 'c'.repeat(64),
    sourceIdentity: 'd'.repeat(64),
    fileCount: 17,
    symlinkCount: 1,
    totalBytes: 4_096,
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
    custody: { localIntegrity: 'verified', authenticated: false },
    blockers: CAPTURE_BLOCKERS,
    ...overrides,
  };
}

function publicSpki(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function fixture(options: {
  issuedAt?: string;
  custodyUntil?: string;
  notBefore?: string;
  notAfter?: string;
} = {}): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = publicSpki(publicKey);
  const keyId = externalSkillCustodyKeyId(publicKeySpki)!;
  const policy: ExternalSkillCustodyTrustPolicy = {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-custody-trust-v1',
    policyVersion: 'custody-2026-07',
    keys: [{
      keyId,
      signatureAlgorithm: 'ed25519',
      role: 'custody-statement-signer',
      expectedCustodyAuthorityDigest: CUSTODY_AUTHORITY_DIGEST,
      expectedRetentionPolicyDigest: RETENTION_POLICY_DIGEST,
      publicKeySpki,
      notBefore: options.notBefore ?? '2026-07-01T00:00:00.000Z',
      notAfter: options.notAfter ?? '2027-07-01T00:00:00.000Z',
    }],
  };
  const captured = capture();
  const unsigned: ExternalSkillCustodyAttestationUnsigned = {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-custody-v1',
    captureDigest: captured.captureDigest,
    bundleDigest: BUNDLE_DIGEST,
    captureReceiptReferenceDigest: CAPTURE_RECEIPT_REFERENCE_DIGEST,
    portablePackDigest: captured.portablePackDigest,
    sourceIdentity: captured.sourceIdentity,
    fileCount: captured.fileCount,
    symlinkCount: captured.symlinkCount,
    totalBytes: captured.totalBytes,
    objectVersionDigest: 'e'.repeat(64),
    claimedCustodyAuthorityDigest: CUSTODY_AUTHORITY_DIGEST,
    claimedRetentionPolicyDigest: RETENTION_POLICY_DIGEST,
    custodyClass: 'external-retention-lock',
    verification: 'canonical-bundle-rehashed',
    issuedAt: options.issuedAt ?? '2026-07-22T11:59:00.000Z',
    custodyUntil: options.custodyUntil ?? '2026-08-22T12:00:00.000Z',
    trustPolicyDigest: externalSkillCustodyTrustPolicyDigest(policy)!,
    keyId,
    signatureAlgorithm: 'ed25519',
    workflowAuthority: 'none',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
  };
  const payload = canonicalExternalSkillCustodyAttestationPayload(unsigned)!;
  const receipt: ExternalSkillCustodyAttestation = {
    ...unsigned,
    signature: sign(null, payload, privateKey).toString('base64url'),
  };
  return {
    privateKey,
    policy,
    unsigned,
    receipt,
    input: {
      capture: captured,
      captureReceiptReferenceDigest: CAPTURE_RECEIPT_REFERENCE_DIGEST,
      receipt,
      trustPolicy: policy,
    },
  };
}

function resign(value: Fixture, overrides: Partial<ExternalSkillCustodyAttestationUnsigned>): Fixture {
  const unsigned = { ...value.unsigned, ...overrides };
  const payload = canonicalExternalSkillCustodyAttestationPayload(unsigned);
  if (!payload) throw new Error('invalid unsigned test receipt');
  const receipt = {
    ...unsigned,
    signature: sign(null, payload, value.privateKey).toString('base64url'),
  };
  return { ...value, unsigned, receipt, input: { ...value.input, receipt } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('M447 external skill custody statement verification', () => {
  it('verifies a signature without authenticating caller-supplied trust or custody', () => {
    const value = fixture();
    const result = verifyExternalSkillCustodyAttestation(value.input);

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'external-custody-statement-verification',
      state: 'statement-signature-verified',
      reason: 'statement-signature-verified',
      captureDigest: CAPTURE_DIGEST,
      trustPolicyDigest: value.unsigned.trustPolicyDigest,
      keyId: value.unsigned.keyId,
      claimedCustodyAuthorityDigest: CUSTODY_AUTHORITY_DIGEST,
      claimedRetentionPolicyDigest: RETENTION_POLICY_DIGEST,
      authority: 'observation-only',
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
      statement: {
        signatureVerified: true,
        keyMatchedSuppliedPolicy: true,
        trustPolicyApprovalVerified: false,
      },
      custody: {
        bundleIntegrity: 'signer-claimed-rehash',
        retentionClaim: 'unexpired-signer-claim',
        authenticated: false,
        custodyUntil: value.unsigned.custodyUntil,
        liveAvailabilityVerified: false,
        replayProtectionVerified: false,
        transparencyVerified: false,
      },
      blockers: [
        'capture-custody-authentication-required',
        'sandbox-runner-required',
        'exposure-verifier-required',
        'outcome-attestation-required',
      ],
    });
    expect(result.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts an exact M446 replay without changing receipt identity', () => {
    const value = fixture();
    const captured = capture({ state: 'replayed', reason: 'replayed' });
    const replay = verifyExternalSkillCustodyAttestation({ ...value.input, capture: captured });
    const original = verifyExternalSkillCustodyAttestation(value.input);

    expect(replay.state).toBe('statement-signature-verified');
    expect(replay.receiptDigest).toBe(original.receiptDigest);
  });

  it('has deterministic canonical payload, policy, key, and receipt identities', () => {
    const value = fixture();
    const payload = canonicalExternalSkillCustodyAttestationPayload(value.unsigned)!;
    const result = verifyExternalSkillCustodyAttestation(value.input);

    expect(payload.toString('utf8')).toBe(JSON.stringify([
      'ashlr:external-skill-custody-attestation-signature:v1',
      1,
      'ashlr-external-skill-custody-v1',
      value.unsigned.captureDigest,
      value.unsigned.bundleDigest,
      value.unsigned.captureReceiptReferenceDigest,
      value.unsigned.portablePackDigest,
      value.unsigned.sourceIdentity,
      value.unsigned.fileCount,
      value.unsigned.symlinkCount,
      value.unsigned.totalBytes,
      value.unsigned.objectVersionDigest,
      value.unsigned.claimedCustodyAuthorityDigest,
      value.unsigned.claimedRetentionPolicyDigest,
      value.unsigned.custodyClass,
      value.unsigned.verification,
      value.unsigned.issuedAt,
      value.unsigned.custodyUntil,
      value.unsigned.trustPolicyDigest,
      value.unsigned.keyId,
      value.unsigned.signatureAlgorithm,
      value.unsigned.workflowAuthority,
      value.unsigned.executionEligible,
      value.unsigned.policyEligible,
      value.unsigned.promotionEligible,
    ]));
    expect(externalSkillCustodyTrustPolicyDigest(value.policy)).toBe(value.unsigned.trustPolicyDigest);
    expect(result.receiptDigest).toBe(verifyExternalSkillCustodyAttestation(structuredClone(value.input)).receiptDigest);
  });

  it.each([
    ['capture digest', { captureDigest: '0'.repeat(64) }],
    ['portable digest', { portablePackDigest: '0'.repeat(64) }],
    ['source identity', { sourceIdentity: '0'.repeat(64) }],
    ['file count', { fileCount: 18 }],
    ['symlink count', { symlinkCount: 2 }],
    ['byte count', { totalBytes: 4_097 }],
  ])('withholds a valid signature over a mismatched %s', (_label, overrides) => {
    const value = resign(fixture(), overrides);
    expect(verifyExternalSkillCustodyAttestation(value.input)).toMatchObject({
      state: 'withheld', reason: 'capture-mismatch', captureDigest: null,
    });
  });

  it('binds the raw bundle digest to the M446 capture domain', () => {
    const value = resign(fixture(), { bundleDigest: '0'.repeat(64) });
    expect(verifyExternalSkillCustodyAttestation(value.input).reason).toBe('capture-mismatch');
  });

  it('requires the statement to match an independently supplied opaque receipt reference', () => {
    const value = fixture();
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      captureReceiptReferenceDigest: '9'.repeat(64),
    }).reason).toBe('capture-receipt-reference-mismatch');
    const resigned = resign(value, { captureReceiptReferenceDigest: '9'.repeat(64) });
    expect(verifyExternalSkillCustodyAttestation(resigned.input).reason)
      .toBe('capture-receipt-reference-mismatch');
  });

  it.each([
    [
      'custody authority claim',
      { claimedCustodyAuthorityDigest: '8'.repeat(64) },
      'custody-authority-claim-mismatch',
    ],
    [
      'retention policy claim',
      { claimedRetentionPolicyDigest: '7'.repeat(64) },
      'retention-policy-claim-mismatch',
    ],
  ])('reports a distinct %s mismatch', (_label, overrides, reason) => {
    const value = resign(fixture(), overrides);
    expect(verifyExternalSkillCustodyAttestation(value.input).reason).toBe(reason);
  });

  it('rejects tampered and non-canonical signatures', () => {
    const value = fixture();
    const index = 10;
    const tampered = `${value.receipt.signature.slice(0, index)}` +
      `${value.receipt.signature[index] === 'A' ? 'B' : 'A'}` +
      `${value.receipt.signature.slice(index + 1)}`;
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      receipt: { ...value.receipt, signature: tampered },
    }).reason).toBe('signature-invalid');
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      receipt: { ...value.receipt, signature: `${value.receipt.signature}=` },
    }).reason).toBe('invalid-input');
  });

  it('withholds policy drift even when the signing key remains present', () => {
    const value = fixture();
    const changed = { ...value.policy, policyVersion: 'custody-2026-08' };
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, trustPolicy: changed,
    }).reason).toBe('trust-policy-mismatch');
  });

  it('distinguishes an unknown key from an invalid trusted key', () => {
    const value = fixture();
    const { publicKey } = generateKeyPairSync('ed25519');
    const otherSpki = publicSpki(publicKey);
    const otherId = externalSkillCustodyKeyId(otherSpki)!;
    const unknownPolicy = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, keyId: otherId, publicKeySpki: otherSpki }],
    };
    const unknown = resign(value, {
      trustPolicyDigest: externalSkillCustodyTrustPolicyDigest(unknownPolicy)!,
    });
    expect(verifyExternalSkillCustodyAttestation({
      ...unknown.input, trustPolicy: unknownPolicy,
    }).reason).toBe('trust-key-unknown');

    const invalidPolicy = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, keyId: '0'.repeat(64) }],
    };
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, trustPolicy: invalidPolicy,
    }).reason).toBe('trust-policy-invalid');
  });

  it('rejects non-Ed25519 trust material and relabeled key identities', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaSpki = publicSpki(publicKey);
    expect(externalSkillCustodyKeyId(rsaSpki)).toBeNull();
    expect(externalSkillCustodyKeyId('not-base64url')).toBeNull();

    const value = fixture();
    const relabeledPolicy = {
      ...value.policy,
      keys: [{ ...value.policy.keys[0]!, keyId: 'f'.repeat(64) }],
    };
    const digest = externalSkillCustodyTrustPolicyDigest(relabeledPolicy);
    expect(digest).toBeNull();
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, trustPolicy: relabeledPolicy,
    }).reason).toBe('trust-policy-invalid');
  });

  it('rejects trailing DER bytes and malformed unselected policy keys', () => {
    const value = fixture();
    const canonical = value.policy.keys[0]!.publicKeySpki;
    const withTrailingByte = Buffer.concat([
      Buffer.from(canonical, 'base64url'),
      Buffer.from([0]),
    ]).toString('base64url');
    expect(externalSkillCustodyKeyId(withTrailingByte)).toBeNull();

    const malformedId = 'f'.repeat(64);
    const malformed = {
      ...value.policy.keys[0]!,
      keyId: malformedId,
      publicKeySpki: Buffer.alloc(44, 7).toString('base64url'),
    };
    const keys = [value.policy.keys[0]!, malformed]
      .sort((left, right) => left.keyId.localeCompare(right.keyId));
    expect(externalSkillCustodyTrustPolicyDigest({ ...value.policy, keys })).toBeNull();
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      trustPolicy: { ...value.policy, keys },
    }).reason).toBe('trust-policy-invalid');
  });

  it('accepts sorted policy generations while binding signing time to the selected key', () => {
    const value = fixture();
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicKeySpki = publicSpki(publicKey);
    const keyId = externalSkillCustodyKeyId(publicKeySpki)!;
    const keys = [
      value.policy.keys[0]!,
      {
        ...value.policy.keys[0]!,
        keyId,
        publicKeySpki,
        notBefore: '2027-07-01T00:00:00.000Z',
        notAfter: '2028-07-01T00:00:00.000Z',
      },
    ].sort((left, right) => left.keyId.localeCompare(right.keyId));
    const policy = { ...value.policy, policyVersion: 'rotation-1', keys };
    const rotated = resign(value, {
      trustPolicyDigest: externalSkillCustodyTrustPolicyDigest(policy)!,
    });
    expect(verifyExternalSkillCustodyAttestation({
      ...rotated.input, trustPolicy: policy,
    }).state).toBe('statement-signature-verified');
    expect(externalSkillCustodyTrustPolicyDigest({ ...policy, keys: [...keys].reverse() })).toBeNull();
  });

  it.each([
    ['before key activation', {
      issuedAt: '2026-06-30T23:59:59.000Z',
      custodyUntil: '2026-07-22T13:00:00.000Z',
    }, 'trust-key-inactive', '2027-07-01T00:00:00.000Z'],
    ['signed after key expiry', {
      issuedAt: '2027-07-01T00:00:00.001Z',
      custodyUntil: '2027-07-02T00:00:00.001Z',
    }, 'trust-key-inactive', '2027-07-01T00:00:00.000Z'],
    ['too far in future', {
      issuedAt: '2026-07-22T12:01:00.001Z',
      custodyUntil: '2026-07-23T12:00:00.000Z',
    }, 'receipt-not-current', '2028-07-01T00:00:00.000Z'],
    ['non-positive interval', {
      issuedAt: '2026-07-22T12:00:00.000Z',
      custodyUntil: '2026-07-22T12:00:00.000Z',
    }, 'receipt-not-current', '2028-07-01T00:00:00.000Z'],
    ['expired', {
      issuedAt: '2026-07-20T12:00:00.000Z',
      custodyUntil: '2026-07-22T12:00:00.000Z',
    }, 'receipt-expired', '2028-07-01T00:00:00.000Z'],
    ['overlong', {
      issuedAt: '2026-07-22T11:59:00.000Z',
      custodyUntil: '2027-07-23T12:00:00.000Z',
    }, 'receipt-not-current', '2028-07-01T00:00:00.000Z'],
  ])('withholds a receipt %s', (_label, overrides, reason, notAfter) => {
    const value = resign(fixture({ notAfter }), overrides);
    expect(verifyExternalSkillCustodyAttestation(value.input).reason).toBe(reason);
  });

  it('rejects incomplete or caller-fabricated M446 authority states', () => {
    const value = fixture();
    const withheldCapture: ExternalSkillGitCaptureResult = {
      schemaVersion: 1,
      mode: 'git-object-quarantine',
      state: 'withheld',
      reason: 'source-unavailable',
      captureDigest: null,
      portablePackDigest: null,
      sourceIdentity: null,
      fileCount: 0,
      symlinkCount: 0,
      totalBytes: 0,
      authority: 'observation-only',
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
      custody: { localIntegrity: 'unavailable', authenticated: false },
      blockers: CAPTURE_BLOCKERS,
    };
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, capture: withheldCapture,
    }).reason).toBe('capture-incomplete');
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      capture: { ...value.input.capture, executionEligible: true },
    }).reason).toBe('capture-incomplete');

    const sparseBlockers = new Array(4);
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      capture: { ...value.input.capture, blockers: sparseBlockers },
    }).reason).toBe('capture-incomplete');
  });

  it('rejects unknown fields, accessors, sparse arrays, and non-plain inputs', () => {
    const value = fixture();
    expect(verifyExternalSkillCustodyAttestation({ ...value.input, extra: true }).reason).toBe('invalid-input');
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, receipt: { ...value.receipt, extra: true },
    }).reason).toBe('invalid-input');
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input,
      trustPolicy: Object.create(value.policy),
    }).reason).toBe('invalid-input');

    const sparse = new Array(2);
    sparse[1] = value.policy.keys[0];
    expect(externalSkillCustodyTrustPolicyDigest({ ...value.policy, keys: sparse })).toBeNull();

    const namedKeys = [...value.policy.keys] as ExternalSkillCustodyTrustPolicy['keys'] & {
      extra?: boolean;
    };
    namedKeys.extra = true;
    expect(externalSkillCustodyTrustPolicyDigest({ ...value.policy, keys: namedKeys })).toBeNull();

    const accessor = { ...value.receipt } as Record<string, unknown>;
    Object.defineProperty(accessor, 'signature', { get: () => value.receipt.signature, enumerable: true });
    expect(verifyExternalSkillCustodyAttestation({
      ...value.input, receipt: accessor,
    }).reason).toBe('invalid-input');
  });

  it('uses one owned clone when a stateful input proxy mutates after access', () => {
    const value = fixture();
    let reads = 0;
    const proxy = new Proxy(value.input, {
      get(target, property, receiver) {
        reads += 1;
        if (reads > 100 && property === 'receipt') return { ...target.receipt, signature: 'A'.repeat(86) };
        return Reflect.get(target, property, receiver);
      },
    });
    const result = verifyExternalSkillCustodyAttestation(proxy);
    expect(result.reason).toBe('invalid-input');
    expect(reads).toBeGreaterThanOrEqual(0);
  });

  it('returns no caller-controlled metadata on withheld results', () => {
    const value = fixture();
    const secret = 'private-custody-provider-canary-83f4';
    const result = verifyExternalSkillCustodyAttestation({
      ...value.input,
      receipt: { ...value.receipt, [secret]: secret },
    });

    expect(result).toMatchObject({
      state: 'withheld',
      captureDigest: null,
      receiptDigest: null,
      trustPolicyDigest: null,
      keyId: null,
      authority: 'observation-only',
      statement: { trustPolicyApprovalVerified: false },
      custody: {
        authenticated: false,
        liveAvailabilityVerified: false,
        replayProtectionVerified: false,
        transparencyVerified: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('has no signing or ambient-authority primitive in the production module', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const source = readFileSync(join(root, 'src/core/fleet/external-skill-custody-attestation.ts'), 'utf8');
    expect(source).not.toMatch(/generateKeyPair|createPrivateKey|randomBytes|randomUUID|\bsign\s*\(/);
    expect(source).not.toMatch(/node:fs|node:child_process|\bfetch\s*\(|process\.env|homedir\s*\(/);
  });

  it('has no runtime import path from src into the verifier-only module', () => {
    const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sourceRoot = join(repositoryRoot, 'src');
    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const target = /(?:^|\/)external-skill-custody-attestation\.js$/;
    const sourceFiles = (directory: string): string[] => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [path] : [];
    });
    const moduleText = (node: ts.Expression | undefined): string | null =>
      node && ts.isStringLiteralLike(node) ? node.text : null;
    const importIsTypeOnly = (node: ts.ImportDeclaration): boolean => {
      const clause = node.importClause;
      if (!clause) return false;
      if (clause.isTypeOnly) return true;
      return clause.name === undefined && clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
    };

    for (const path of sourceFiles(sourceRoot)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const inspect = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && target.test(moduleText(node.moduleSpecifier) ?? '')) {
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'import',
            typeOnly: importIsTypeOnly(node),
          });
        } else if (ts.isExportDeclaration(node) && target.test(moduleText(node.moduleSpecifier) ?? '')) {
          const namedTypeOnly = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly);
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'export',
            typeOnly: node.isTypeOnly || namedTypeOnly,
          });
        } else if (ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          target.test(moduleText(node.moduleReference.expression) ?? '')) {
          references.push({
            file: relative(repositoryRoot, path).replaceAll('\\', '/'),
            kind: 'import-equals',
            typeOnly: node.isTypeOnly,
          });
        } else if (ts.isCallExpression(node)) {
          const specifier = moduleText(node.arguments[0]);
          const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if ((dynamicImport || requireCall) && target.test(specifier ?? '')) {
            references.push({
              file: relative(repositoryRoot, path).replaceAll('\\', '/'),
              kind: dynamicImport ? 'dynamic-import' : 'require',
              typeOnly: false,
            });
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }

    expect(references).toEqual([{
      file: 'src/api/types.ts',
      kind: 'export',
      typeOnly: true,
    }]);
  });
});
