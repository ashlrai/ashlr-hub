import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

// AST-scans the whole src/ tree for runtime import boundaries; that scan
// alone takes ~18s on this machine, well past the 5s default.
vi.setConfig({ testTimeout: 45_000 });

const auditOverride = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('../src/core/fleet/external-skill-audit-receipt.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/core/fleet/external-skill-audit-receipt.js')
  >();
  return {
    ...actual,
    verifyTrustedExternalSkillAuditReceipt: (...args: Parameters<
      typeof actual.verifyTrustedExternalSkillAuditReceipt
    >) => auditOverride.value ?? actual.verifyTrustedExternalSkillAuditReceipt(...args),
  };
});

import {
  projectExternalSkillMaturity,
  type ExternalSkillMaturityProjectionInputV1,
} from '../src/core/fleet/external-skill-maturity.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const snapshotPath = join(root, 'test/fixtures/m454/agent-skills-ff2df4c.snapshot.json');
const snapshotBytes = readFileSync(snapshotPath);
const asOf = '2026-07-24T09:07:23.000Z';
const falseAuthority = {
  authority: 'observation-only',
  executionAuthority: false,
  exposureAuthority: false,
  routingAuthority: false,
  learningAuthority: false,
  policyAuthority: false,
  promotionAuthority: false,
  proposalAuthority: false,
  verificationAuthority: false,
  mergeAuthority: false,
  releaseAuthority: false,
  deploymentAuthority: false,
  transitionAuthority: false,
  revocationAuthority: false,
  globalReplayProtectionVerified: false,
} as const;

function input(
  overrides: Partial<ExternalSkillMaturityProjectionInputV1> = {},
): ExternalSkillMaturityProjectionInputV1 {
  return {
    asOf,
    auditEvidence: null,
    routingEvidence: null,
    ...overrides,
  };
}

afterEach(() => {
  auditOverride.value = null;
});

describe('M455 external skill maturity readiness', () => {
  it('projects the complete ladder while keeping every promotion fail-closed', () => {
    const result = projectExternalSkillMaturity(input());

    expect(result).toMatchObject({
      schemaVersion: 1,
      protocol: 'external-skill-maturity-projection-v1',
      state: 'projected',
      reason: 'evidence-chain-incomplete',
      sourceState: 'healthy',
      gate: 'collecting',
      highestDefensibleState: 'quarantined',
      nextState: 'structurally-valid',
      terminal: false,
      topBlocker: 'audit-receipt-authentication-required',
      evidence: { audit: null, routing: null },
      ...falseAuthority,
    });
    expect(result.state).toBe('projected');
    if (result.state !== 'projected') throw new Error('expected projection');
    expect(result.stages.map((entry) => [entry.state, entry.gate])).toEqual([
      ['quarantined', 'satisfied'],
      ['structurally-valid', 'blocked'],
      ['routing-valid', 'blocked'],
      ['sandbox-trialed', 'blocked'],
      ['shadow-observed', 'blocked'],
      ['verified-active', 'blocked'],
      ['revoked', 'blocked'],
    ]);
    expect(result.stages.at(-1)?.blockers).toEqual(['candidate-revocation-receipt-required']);
  });

  it('does not let a positive verifier result become a confused deputy', () => {
    auditOverride.value = {
      state: 'authenticated',
      reason: 'audit-receipt-authenticated',
      signatureVerified: true,
      trustRootProvisioned: true,
      receiptDigest: 'a'.repeat(64),
      expiresAt: '2026-07-25T09:07:23.000Z',
    };
    const result = projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1),
        receiptBytes: Uint8Array.of(2),
        selectedSkillName: 'test-skill',
      },
    }));

    expect(result.state).toBe('projected');
    if (result.state !== 'projected') throw new Error('expected projection');
    expect(result.evidence.audit).toMatchObject({
      state: 'authenticated',
      signatureVerified: true,
    });
    expect(result.highestDefensibleState).toBe('quarantined');
    expect(result.topBlocker).toBe('capture-receipt-binding-required');
    expect(result.stages[1]?.blockers).toEqual([
      'capture-receipt-binding-required',
      'trusted-clock-required',
      'online-revocation-required',
      'independent-verifier-principal-required',
      'one-use-replay-protection-required',
      'append-only-transparency-required',
    ]);
  });

  it.each([
    'receipt-expired',
    'receipt-not-current',
    'trust-key-inactive',
    'trust-key-revoked',
  ] as const)('classifies %s evidence as a currentness failure', (reason) => {
    auditOverride.value = {
      state: 'withheld',
      reason,
      signatureVerified: false,
      trustRootProvisioned: true,
      receiptDigest: null,
      expiresAt: null,
    };
    const result = projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1),
        receiptBytes: Uint8Array.of(2),
        selectedSkillName: 'test-skill',
      },
    }));

    expect(result).toMatchObject({
      state: 'projected',
      sourceState: 'degraded',
      topBlocker: 'audit-receipt-currentness-required',
    });
  });

  it('reports the pinned upstream calibration without treating it as routing authority', () => {
    const result = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: snapshotBytes,
        secondSnapshotBytes: snapshotBytes,
      },
    }));

    expect(result.state).toBe('projected');
    if (result.state !== 'projected') throw new Error('expected projection');
    expect(result.evidence.routing).toEqual({
      gate: 'collecting',
      reason: 'insufficient-sample',
      sourceState: 'healthy',
      meetsCalibrationThresholds: null,
    });
    const routing = result.stages.find((entry) => entry.state === 'routing-valid');
    expect(routing?.blockers).toEqual(expect.arrayContaining([
      'routing-calibration-ready-required',
      'routing-candidate-binding-required',
      'runtime-router-equivalence-required',
      'independent-heldout-corpus-required',
      'routing-confidence-policy-required',
    ]));
    expect(result.routingAuthority).toBe(false);
  });

  it('marks supplied unusable evidence degraded instead of presenting a healthy zero', () => {
    const result = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: Buffer.from('{'),
        secondSnapshotBytes: Buffer.from('{}'),
      },
    }));

    expect(result).toMatchObject({
      state: 'projected',
      sourceState: 'degraded',
      evidence: {
        routing: {
          gate: 'withheld',
          reason: 'invalid-input',
          sourceState: 'degraded',
        },
      },
    });
  });

  it('does not assign a raw evidence identity to withheld routing bytes', () => {
    const first = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: Buffer.from('{'),
        secondSnapshotBytes: Buffer.from('['),
      },
    }));
    const second = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: Buffer.from('not-json'),
        secondSnapshotBytes: Buffer.from('also-not-json'),
      },
    }));

    expect(first.state).toBe('projected');
    expect(second.state).toBe('projected');
    if (first.state !== 'projected' || second.state !== 'projected') {
      throw new Error('expected projections');
    }
    expect(first.sourceState).toBe('degraded');
    expect(second.sourceState).toBe('degraded');
    expect(first.evidenceRoot).toBe(second.evidenceRoot);
  });

  it('canonicalizes routing JSON identity across key order and line endings', () => {
    const parsed = JSON.parse(snapshotBytes.toString('utf8')) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    const prettyCrLf = Buffer.from(JSON.stringify(reversed, null, 2).replaceAll('\n', '\r\n'));

    const canonical = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: snapshotBytes,
        secondSnapshotBytes: snapshotBytes,
      },
    }));
    const reformatted = projectExternalSkillMaturity(input({
      routingEvidence: {
        firstSnapshotBytes: prettyCrLf,
        secondSnapshotBytes: prettyCrLf,
      },
    }));

    expect(canonical.state).toBe('projected');
    expect(reformatted.state).toBe('projected');
    if (canonical.state !== 'projected' || reformatted.state !== 'projected') {
      throw new Error('expected projections');
    }
    expect(reformatted.evidenceRoot).toBe(canonical.evidenceRoot);
    expect(reformatted.evidence.routing).toEqual(canonical.evidence.routing);
  });

  it('copies evidence bytes before verifier evaluation', () => {
    const reportBytes = Uint8Array.of(1, 2, 3);
    const receiptBytes = Uint8Array.of(4, 5, 6);
    const first = projectExternalSkillMaturity(input({
      auditEvidence: { reportBytes, receiptBytes, selectedSkillName: 'test-skill' },
    }));
    reportBytes.fill(9);
    receiptBytes.fill(8);
    const second = projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1, 2, 3),
        receiptBytes: Uint8Array.of(4, 5, 6),
        selectedSkillName: 'test-skill',
      },
    }));

    expect(first.state).toBe('projected');
    expect(second.state).toBe('projected');
    if (first.state !== 'projected' || second.state !== 'projected') {
      throw new Error('expected projections');
    }
    expect(first.evidenceRoot).toBe(second.evidenceRoot);
  });

  it('never reflects raw audit or routing content into the metadata-only result', () => {
    const reportCanary = 'private-report-canary';
    const receiptCanary = 'private-receipt-canary';
    const routingCanary = 'private-routing-canary';
    const result = projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: Buffer.from(reportCanary),
        receiptBytes: Buffer.from(receiptCanary),
        selectedSkillName: 'test-skill',
      },
      routingEvidence: {
        firstSnapshotBytes: Buffer.from(JSON.stringify({ secret: routingCanary })),
        secondSnapshotBytes: Buffer.from(JSON.stringify({ secret: routingCanary })),
      },
    }));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(reportCanary);
    expect(serialized).not.toContain(receiptCanary);
    expect(serialized).not.toContain(routingCanary);
    expect(serialized).not.toContain('reportBytes');
    expect(serialized).not.toContain('snapshotBytes');
  });

  it.each([
    ['extra key', { ...input(), claimedState: 'verified-active' }],
    ['invalid timestamp', input({ asOf: '2026-07-24' })],
    ['empty report', input({
      auditEvidence: {
        reportBytes: new Uint8Array(),
        receiptBytes: Uint8Array.of(1),
        selectedSkillName: 'test-skill',
      },
    })],
    ['invalid skill name', input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1),
        receiptBytes: Uint8Array.of(2),
        selectedSkillName: '../escape',
      },
    })],
    ['oversized skill name', input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1),
        receiptBytes: Uint8Array.of(2),
        selectedSkillName: 'a'.repeat(129),
      },
    })],
    ['caller result', {
      ...input(),
      auditEvidence: {
        state: 'authenticated',
        signatureVerified: true,
        promotionEligible: true,
      },
    }],
    ['caller routing result', {
      ...input(),
      routingEvidence: {
        gate: 'ready',
        meetsCalibrationThresholds: true,
        routingAuthority: true,
      },
    }],
    ['prototype', Object.assign(Object.create({ inherited: true }), input())],
  ])('withholds %s input without reflecting caller metadata', (_label, value) => {
    expect(projectExternalSkillMaturity(value)).toEqual(expect.objectContaining({
      state: 'withheld',
      reason: 'invalid-input',
      sourceState: 'degraded',
      gate: 'withheld',
      asOf: null,
      highestDefensibleState: null,
      evidenceRoot: null,
      stages: [],
      evidence: { audit: null, routing: null },
      ...falseAuthority,
    }));
  });

  it('rejects accessor and symbol-bearing records without invoking accessors', () => {
    let reads = 0;
    const accessor = {
      ...input(),
      get auditEvidence() {
        reads += 1;
        return null;
      },
    };
    const symbolBearing = { ...input(), [Symbol('claim')]: 'verified-active' };

    expect(projectExternalSkillMaturity(accessor).state).toBe('withheld');
    expect(reads).toBe(0);
    expect(projectExternalSkillMaturity(symbolBearing).state).toBe('withheld');
  });

  it('snapshots proxy descriptors once and never trusts later property reads', () => {
    let propertyReads = 0;
    const proxied = new Proxy(input(), {
      get(target, property, receiver) {
        propertyReads += 1;
        if (property === 'asOf') return 'attacker-controlled';
        return Reflect.get(target, property, receiver);
      },
    });

    const result = projectExternalSkillMaturity(proxied);
    expect(result).toMatchObject({
      state: 'projected',
      asOf,
      highestDefensibleState: 'quarantined',
    });
    expect(propertyReads).toBe(0);
  });

  it('uses intrinsic byte length and rejects non-byte or proxied typed arrays', () => {
    class LyingBytes extends Uint8Array {
      override get byteLength(): number {
        return 1;
      }
    }
    const oversizedReceipt = new LyingBytes(16 * 1024 + 1);
    const proxiedReport = new Proxy(Uint8Array.of(1), {});
    const wordArray = new Uint16Array([1, 2]);

    expect(projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: Uint8Array.of(1),
        receiptBytes: oversizedReceipt,
        selectedSkillName: 'test-skill',
      },
    })).state).toBe('withheld');
    expect(projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: proxiedReport,
        receiptBytes: Uint8Array.of(1),
        selectedSkillName: 'test-skill',
      },
    })).state).toBe('withheld');
    expect(projectExternalSkillMaturity(input({
      auditEvidence: {
        reportBytes: wordArray as unknown as Uint8Array,
        receiptBytes: Uint8Array.of(1),
        selectedSkillName: 'test-skill',
      },
    })).state).toBe('withheld');
  });

  it('has no runtime consumer in src and remains a type-only package surface', () => {
    const sourceRoot = join(root, 'src');
    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const target = /(?:^|\/)external-skill-maturity\.js(?:[?#].*)?$/;
    const sourceFiles = (directory: string): string[] => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
    });
    const moduleText = (node: ts.Expression | undefined): string | null => {
      if (node === undefined) return null;
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
      }
      if (ts.isParenthesizedExpression(node)) return moduleText(node.expression);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = moduleText(node.left);
        const right = moduleText(node.right);
        return left === null || right === null ? null : left + right;
      }
      return null;
    };
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
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'import',
            typeOnly: importIsTypeOnly(node),
          });
        } else if (ts.isExportDeclaration(node) &&
          target.test(moduleText(node.moduleSpecifier) ?? '')) {
          const namedTypeOnly = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly);
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'export',
            typeOnly: node.isTypeOnly || namedTypeOnly,
          });
        } else if (ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          target.test(moduleText(node.moduleReference.expression) ?? '')) {
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'import-equals',
            typeOnly: node.isTypeOnly,
          });
        } else if (ts.isCallExpression(node)) {
          const specifier = moduleText(node.arguments[0]);
          const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
          if (target.test(specifier ?? '')) {
            references.push({
              file: relative(root, path).replaceAll('\\', '/'),
              kind: dynamicImport ? 'dynamic-import' : requireCall ? 'require' : 'literal-call',
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
