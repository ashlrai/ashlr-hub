import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const trustState = vi.hoisted(() => ({
  policy: {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-audit-trust-v1',
    policyGeneration: 0,
    roots: [] as unknown[],
  },
}));

vi.mock('../src/core/fleet/external-skill-audit-trust-roots.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/external-skill-audit-trust-roots.js')>(),
  EXTERNAL_SKILL_AUDIT_TRUST_POLICY: trustState.policy,
}));

import {
  auditExternalSkillPack,
  canonicalExternalSkillAuditReportBytes,
  EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
  EXTERNAL_SKILL_AUDIT_REPORT_MAX_BYTES,
} from '../src/core/fleet/external-skill-audit.js';
import {
  canonicalExternalSkillAuditReceiptBytes,
  canonicalExternalSkillAuditReceiptPayload,
  externalSkillAuditTrustPolicyDigest,
  externalSkillAuditVerifierKeyId,
  verifyTrustedExternalSkillAuditReceipt,
  type ExternalSkillAuditReceipt,
  type ExternalSkillAuditReceiptInput,
  type ExternalSkillAuditReceiptUnsigned,
} from '../src/core/fleet/external-skill-audit-receipt.js';
import { externalSkillCustodyKeyId } from '../src/core/fleet/external-skill-custody-attestation.js';

const roots: string[] = [];

function writeSkill(root: string, name: string, other: string, word: string): void {
  const skillRoot = join(root, 'skills', name);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: Guides ${word} work with deterministic evidence and bounded verification.`,
    '---',
    '',
    '## When to Use',
    `Use for ${word}.`,
    '## Workflow',
    'Follow the bounded workflow.',
    '## Common Rationalizations',
    'Do not skip proof.',
    '## Red Flags',
    'Unsupported claims.',
    '## Verification',
    'Produce deterministic evidence.',
  ].join('\n'));
  const fixtureRoot = join(root, 'evals', 'fixtures', name);
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, 'input.txt'), word);
  writeFileSync(join(root, 'evals', 'cases', `${name}.json`), JSON.stringify({
    skill_name: name,
    trigger: {
      positive: [
        { prompt: `${word} ${word} workflow`, top_k: 1 },
        { prompt: `perform ${word} carefully`, top_k: 1 },
        { prompt: `need ${word} evidence`, top_k: 1 },
      ],
      negative: [
        { prompt: `${other.replaceAll('-', ' ')} workflow`, owner: other },
        { prompt: `perform ${other.replaceAll('-', ' ')}`, owner: other },
      ],
    },
    evals: [{
      id: 1,
      kind: 'execution',
      prompt: `Complete private ${word} prompt canary`,
      expected_output: 'Private output canary',
      files: [name],
      expectations: ['Private expectation canary'],
    }],
  }));
}

function validPack(): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-m451-pack-'));
  roots.push(root);
  mkdirSync(join(root, 'evals', 'cases'), { recursive: true });
  writeSkill(root, 'testing-workflow', 'documentation-workflow', 'testing');
  writeSkill(root, 'documentation-workflow', 'testing-workflow', 'documentation');
  return root;
}

function reportFixture(): {
  packPath: string;
  reportBytes: Buffer;
  selectedSkillName: string;
  selectedHash: string;
} {
  const packPath = validPack();
  const report = auditExternalSkillPack(packPath);
  expect(report.trialReady).toBe(true);
  const reportBytes = canonicalExternalSkillAuditReportBytes(report);
  expect(reportBytes).not.toBeNull();
  return {
    packPath,
    reportBytes: reportBytes!,
    selectedSkillName: report.skills[0]!.name,
    selectedHash: report.skills[0]!.contentHash,
  };
}

function sha256(domain: string, value: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update(value).digest('hex');
}

function fixture(options: {
  provisionRoot?: boolean;
  expiresAt?: string;
  rootNotAfter?: string;
  revokedAt?: string | null;
} = {}): {
  input: ExternalSkillAuditReceiptInput;
  packPath: string;
  privateKey: KeyObject;
  receipt: ExternalSkillAuditReceipt;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
  const keyId = externalSkillAuditVerifierKeyId(publicKeySpki)!;
  if (options.provisionRoot) {
    trustState.policy.policyGeneration = 7;
    trustState.policy.roots = [{
      keyId,
      publicKeySpki,
      signerRole: 'external-skill-audit-verifier',
      signatureAlgorithm: 'ed25519',
      auditPolicyDigest: EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: options.rootNotAfter ?? '2026-08-01T00:00:00.000Z',
      revokedAt: options.revokedAt ?? null,
    }];
  }
  const report = reportFixture();
  const trustPolicyDigest = externalSkillAuditTrustPolicyDigest();
  expect(trustPolicyDigest).not.toBeNull();
  const parsed = JSON.parse(report.reportBytes.toString('utf8')) as {
    packDigest: string;
    portablePackDigest: string;
  };
  const unsigned: ExternalSkillAuditReceiptUnsigned = {
    schemaVersion: 1,
    protocol: 'ashlr-external-skill-audit-receipt-v1',
    reportDigest: sha256('ashlr:external-skill-audit-report:v1\0', report.reportBytes),
    packDigest: parsed.packDigest,
    portablePackDigest: parsed.portablePackDigest,
    selectedSkillName: report.selectedSkillName,
    selectedSkillContentHash: report.selectedHash,
    auditPolicyDigest: EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
    verdict: 'trial-ready',
    issuedAt: '2026-07-22T12:00:00.000Z',
    expiresAt: options.expiresAt ?? '2026-07-22T13:00:00.000Z',
    trustPolicyDigest: trustPolicyDigest!,
    policyGeneration: trustState.policy.policyGeneration,
    keyId,
    signerRole: 'external-skill-audit-verifier',
    signatureAlgorithm: 'ed25519',
    workflowAuthority: 'none',
    authority: 'observation-only',
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
  };
  const payload = canonicalExternalSkillAuditReceiptPayload(unsigned)!;
  const receipt = {
    ...unsigned,
    signature: sign(null, payload, privateKey).toString('base64url'),
  };
  return {
    input: {
      reportBytes: report.reportBytes,
      receiptBytes: canonicalExternalSkillAuditReceiptBytes(receipt)!,
      selectedSkillName: report.selectedSkillName,
    },
    packPath: report.packPath,
    privateKey,
    receipt,
  };
}

function resign(
  value: ReturnType<typeof fixture>,
  overrides: Partial<ExternalSkillAuditReceiptUnsigned> & { signature?: string },
): ExternalSkillAuditReceiptInput {
  const { signature: _signature, ...unsigned } = value.receipt;
  const { signature: explicitSignature, ...unsignedOverrides } = overrides;
  const nextUnsigned = { ...unsigned, ...unsignedOverrides };
  const payload = canonicalExternalSkillAuditReceiptPayload(nextUnsigned)!;
  const receipt = {
    ...nextUnsigned,
    signature: explicitSignature ?? sign(null, payload, value.privateKey).toString('base64url'),
  };
  return {
    ...value.input,
    receiptBytes: canonicalExternalSkillAuditReceiptBytes(receipt)!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-07-22T12:30:00.000Z');
  trustState.policy.policyGeneration = 0;
  trustState.policy.roots = [];
});

afterEach(() => vi.useRealTimers());
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('M451 authenticated external-skill audit receipt', () => {
  it('ships with no production root and withholds otherwise valid evidence', () => {
    const value = fixture();
    expect(verifyTrustedExternalSkillAuditReceipt(value.input)).toMatchObject({
      state: 'withheld',
      reason: 'trust-root-unprovisioned',
      trustRootProvisioned: false,
      signatureVerified: false,
      authority: 'observation-only',
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
    });
    const source = readFileSync(join(
      process.cwd(), 'src/core/fleet/external-skill-audit-trust-roots.ts',
    ), 'utf8');
    expect(source).toContain('roots: Object.freeze([])');
    expect(source).not.toMatch(/BEGIN (?:PRIVATE|OPENSSH) KEY/);
  });

  it('authenticates exact M444 bytes under a code-owned mocked verifier root', () => {
    const value = fixture({ provisionRoot: true });
    const first = verifyTrustedExternalSkillAuditReceipt(value.input);
    const replay = verifyTrustedExternalSkillAuditReceipt(value.input);

    expect(first).toMatchObject({
      state: 'authenticated',
      reason: 'audit-receipt-authenticated',
      selectedSkillName: value.receipt.selectedSkillName,
      selectedSkillContentHash: value.receipt.selectedSkillContentHash,
      signatureVerified: true,
      trustRootProvisioned: true,
      replayProtectionVerified: false,
      transparencyVerified: false,
      onlineRevocationVerified: false,
      trustedClockVerified: false,
      independentVerifierPrincipalVerified: false,
      captureReceiptBindingVerified: false,
      authority: 'observation-only',
      executionEligible: false,
      policyEligible: false,
      promotionEligible: false,
    });
    expect(replay).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(value.receipt.signature);
    expect(serialized).not.toContain('Private output canary');
    expect(serialized).not.toContain('Private expectation canary');
    expect(serialized).not.toContain('private testing prompt canary');
    expect(serialized).not.toContain(value.packPath);
  });

  it.each([
    ['report', 'reportBytes'],
    ['receipt', 'receiptBytes'],
  ] as const)('rejects a one-byte mutation of exact %s bytes', (_label, field) => {
    const value = fixture({ provisionRoot: true });
    const mutated = Buffer.from(value.input[field]);
    mutated[mutated.length - 2] = mutated[mutated.length - 2]! ^ 1;
    expect(verifyTrustedExternalSkillAuditReceipt({ ...value.input, [field]: mutated }).state)
      .toBe('withheld');
  });

  it('rejects reordered or whitespace-changed report and receipt bytes', () => {
    const value = fixture({ provisionRoot: true });
    const report = JSON.parse(Buffer.from(value.input.reportBytes).toString('utf8')) as Record<string, unknown>;
    const receipt = JSON.parse(Buffer.from(value.input.receiptBytes).toString('utf8')) as Record<string, unknown>;
    const reorderedReport = Buffer.from(JSON.stringify({ trialReady: report.trialReady, ...report }));
    const spacedReceipt = Buffer.from(JSON.stringify(receipt, null, 2));

    expect(verifyTrustedExternalSkillAuditReceipt({ ...value.input, reportBytes: reorderedReport }).reason)
      .toBe('report-not-canonical');
    expect(verifyTrustedExternalSkillAuditReceipt({ ...value.input, receiptBytes: spacedReceipt }).reason)
      .toBe('receipt-not-canonical');
  });

  it('rejects an internally impossible trial-ready report before signature verification', () => {
    const value = fixture({ provisionRoot: true });
    const report = JSON.parse(Buffer.from(value.input.reportBytes).toString('utf8')) as {
      structural: { passed: boolean };
      trialReady: boolean;
    };
    report.structural.passed = false;
    report.trialReady = true;

    expect(verifyTrustedExternalSkillAuditReceipt({
      ...value.input,
      reportBytes: Buffer.from(JSON.stringify(report)),
    })).toMatchObject({
      state: 'withheld',
      reason: 'report-not-canonical',
      signatureVerified: false,
    });
  });

  it('rejects trial-ready reports below M444 sample minimums', () => {
    const value = fixture({ provisionRoot: true });
    const report = JSON.parse(Buffer.from(value.input.reportBytes).toString('utf8')) as {
      behavioral: { declaredCases: number; state: string };
      routing: {
        negativePassed: number; negativePrompts: number; passed: boolean;
        positivePrompts: number; rankOnePassed: number; rankOneRate: number; topKPassed: number;
      };
      skills: Array<{
        routing: {
          negativePassed: number; passed: boolean; rankOnePassed: number;
          rankOneRate: number; topKPassed: number;
        };
        triggerCases: { behavioral: number; negative: number; positive: number };
      }>;
      trialReady: boolean;
    };
    const first = report.skills[0]!;
    first.triggerCases = { positive: 1, negative: 0, behavioral: 0 };
    first.routing = {
      passed: true, topKPassed: 1, rankOnePassed: 1, rankOneRate: 1, negativePassed: 0,
    };
    report.routing.positivePrompts = report.skills.reduce((sum, skill) => sum + skill.triggerCases.positive, 0);
    report.routing.topKPassed = report.skills.reduce((sum, skill) => sum + skill.routing.topKPassed, 0);
    report.routing.rankOnePassed = report.skills.reduce((sum, skill) => sum + skill.routing.rankOnePassed, 0);
    report.routing.rankOneRate = 1;
    report.routing.negativePrompts = report.skills.reduce((sum, skill) => sum + skill.triggerCases.negative, 0);
    report.routing.negativePassed = report.skills.reduce((sum, skill) => sum + skill.routing.negativePassed, 0);
    report.behavioral.declaredCases = report.skills.reduce(
      (sum, skill) => sum + skill.triggerCases.behavioral, 0,
    );
    report.routing.passed = true;
    report.behavioral.state = 'declared';
    report.trialReady = true;

    expect(canonicalExternalSkillAuditReportBytes(report)).toBeNull();
  });

  it('rejects issue-severity downgrades and impossible byte aggregates', () => {
    const value = fixture({ provisionRoot: true });
    const report = JSON.parse(Buffer.from(value.input.reportBytes).toString('utf8')) as {
      bytesRead: number;
      issues: Array<{ code: string; level: string; skill?: string }>;
      skills: Array<{ name: string }>;
      structural: { errors: number; passed: boolean; warnings: number };
      trialReady: boolean;
    };
    report.issues = [{
      code: 'incomplete-eval-contract',
      level: 'warning',
      skill: report.skills[0]!.name,
    }];
    report.structural = { passed: true, errors: 0, warnings: 1 };
    report.trialReady = true;
    expect(canonicalExternalSkillAuditReportBytes(report)).toBeNull();

    const impossibleBytes = JSON.parse(
      Buffer.from(value.input.reportBytes).toString('utf8'),
    ) as typeof report;
    impossibleBytes.bytesRead = 0;
    expect(canonicalExternalSkillAuditReportBytes(impossibleBytes)).toBeNull();
  });

  it('contains hostile proxies and oversized bytes inside the fail-closed boundary', () => {
    const explosive = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('proxy canary'); },
    });
    expect(() => verifyTrustedExternalSkillAuditReceipt(explosive)).not.toThrow();
    expect(verifyTrustedExternalSkillAuditReceipt(explosive).reason).toBe('invalid-input');

    const value = fixture({ provisionRoot: true });
    const typedArrayProxy = new Proxy(value.input.reportBytes, {
      get: (_target, property) => {
        if (property === 'byteLength') throw new Error('typed array canary');
        return Reflect.get(_target, property);
      },
    });
    expect(verifyTrustedExternalSkillAuditReceipt({
      ...value.input,
      reportBytes: typedArrayProxy,
    }).reason).toBe('invalid-input');
    expect(verifyTrustedExternalSkillAuditReceipt({
      ...value.input,
      reportBytes: Buffer.alloc(EXTERNAL_SKILL_AUDIT_REPORT_MAX_BYTES + 1),
    }).reason).toBe('invalid-input');
  });

  it('binds the selected skill and rejects caller-selected trust material', () => {
    const value = fixture({ provisionRoot: true });
    const otherSkill = value.receipt.selectedSkillName === 'documentation-workflow'
      ? 'testing-workflow'
      : 'documentation-workflow';
    expect(verifyTrustedExternalSkillAuditReceipt({
      ...value.input,
      selectedSkillName: otherSkill,
    }).reason).toBe('selected-skill-mismatch');
    expect(verifyTrustedExternalSkillAuditReceipt({
      ...value.input,
      trustPolicy: trustState.policy,
    }).reason).toBe('invalid-input');
  });

  it('rejects expired receipts and custody-role key substitution', () => {
    const expired = fixture({ provisionRoot: true, expiresAt: '2026-07-22T12:15:00.000Z' });
    expect(verifyTrustedExternalSkillAuditReceipt(expired.input).reason).toBe('receipt-expired');

    const value = fixture({ provisionRoot: true });
    const root = trustState.policy.roots[0] as { keyId: string; publicKeySpki: string };
    root.keyId = externalSkillCustodyKeyId(root.publicKeySpki)!;
    expect(verifyTrustedExternalSkillAuditReceipt(value.input).reason).toBe('trust-policy-invalid');
  });

  it('rejects receipts that outlive or postdate a revoked verifier root', () => {
    const outlivesRoot = fixture({
      provisionRoot: true,
      rootNotAfter: '2026-07-22T12:45:00.000Z',
    });
    expect(verifyTrustedExternalSkillAuditReceipt(outlivesRoot.input).reason)
      .toBe('trust-key-inactive');

    const revoked = fixture({
      provisionRoot: true,
      revokedAt: '2026-07-22T12:15:00.000Z',
    });
    expect(verifyTrustedExternalSkillAuditReceipt(revoked.input).reason)
      .toBe('trust-key-revoked');
  });

  it.each([
    ['report digest', { reportDigest: 'a'.repeat(64) }, 'report-mismatch'],
    ['pack digest', { packDigest: 'b'.repeat(64) }, 'report-mismatch'],
    ['audit policy', { auditPolicyDigest: 'c'.repeat(64) }, 'audit-policy-mismatch'],
    ['trust policy', { trustPolicyDigest: 'd'.repeat(64) }, 'trust-policy-mismatch'],
    ['policy generation', { policyGeneration: 8 }, 'policy-generation-mismatch'],
    ['unknown key', { keyId: 'e'.repeat(64) }, 'trust-key-unknown'],
    ['signature', { signature: Buffer.alloc(64, 7).toString('base64url') }, 'signature-invalid'],
  ] as const)('rejects a signed %s substitution at its exact branch', (_label, overrides, reason) => {
    const value = fixture({ provisionRoot: true });
    expect(verifyTrustedExternalSkillAuditReceipt(resign(
      value,
      overrides as Partial<ExternalSkillAuditReceiptUnsigned> & { signature?: string },
    )).reason).toBe(reason);
  });

  it('has no runtime import path from src into the verifier-only module', () => {
    const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const sourceRoot = join(repositoryRoot, 'src');
    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const target = /(?:^|\/)external-skill-audit-receipt\.js$/;
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
