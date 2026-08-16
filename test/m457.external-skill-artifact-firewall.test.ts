import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

// AST-scans the whole src/ tree for runtime import boundaries; that scan
// alone takes ~19s on this machine, well past the 5s default.
vi.setConfig({ testTimeout: 45_000 });
import ts from 'typescript';

import {
  evaluateExternalSkillArtifactFirewall,
  EXTERNAL_SKILL_ARTIFACT_CLASSES,
  EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST,
} from '../src/core/fleet/external-skill-artifact-firewall.js';

type ArtifactKind = 'directory' | 'file' | 'symlink';
type ArtifactMode = '040000' | '100644' | '100755' | '120000';

interface Artifact {
  path: string;
  kind: ArtifactKind;
  mode: ArtifactMode;
  content?: Uint8Array | string;
}

interface Fixture {
  input: {
    firstBundleBytes: Uint8Array;
    secondBundleBytes: Uint8Array;
    firstMarkerBytes: Uint8Array;
    secondMarkerBytes: Uint8Array;
  };
  bundleBytes: Buffer;
  markerBytes: Buffer;
}

const SHA1 = '1111111111111111111111111111111111111111';
const SHA1_TREE = '2222222222222222222222222222222222222222';
const SHA1_PACK = '3333333333333333333333333333333333333333';
const PACK_SUBDIR_HASH = '44'.repeat(32);
const PORTABLE_PACK_DIGEST = '55'.repeat(32);
const SKILL = [
  '---',
  'name: alpha-skill',
  'description: Guides alpha work with deterministic evidence and bounded verification.',
  '---',
  '',
  'Private body canary that must never be returned.',
].join('\n');

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha1(value: string | Uint8Array): string {
  return createHash('sha1').update(value).digest('hex');
}

function utf8Order(left: Artifact, right: Artifact): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
}

function fixture(artifacts: readonly Artifact[]): Fixture {
  const entries = [...artifacts].sort(utf8Order).map((artifact) => {
    const content = artifact.kind === 'directory'
      ? null
      : Buffer.from(artifact.content ?? '', typeof artifact.content === 'string'
        ? 'utf8'
        : undefined);
    return {
      path: artifact.path,
      kind: artifact.kind,
      mode: artifact.mode,
      gitOid: sha1(Buffer.concat([
        Buffer.from(`${artifact.kind}\0${artifact.mode}\0${artifact.path}\0`, 'utf8'),
        content ?? Buffer.alloc(0),
      ])),
      byteLength: content?.length ?? 0,
      contentDigest: content === null ? null : sha256(content),
      contentBase64: content === null ? null : content.toString('base64'),
    };
  });
  const bundleBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    objectFormat: 'sha1',
    commitOid: SHA1,
    commitTreeOid: SHA1_TREE,
    packTreeOid: SHA1_PACK,
    packSubdirHash: PACK_SUBDIR_HASH,
    portablePackDigest: PORTABLE_PACK_DIGEST,
    entries,
  }), 'utf8');
  const bundleDigest = sha256(bundleBytes);
  const captureDigest = sha256(
    `ashlr-external-skill-git-capture-v1\0${bundleDigest}`,
  );
  const sourceIdentity = sha256([
    'ashlr-external-skill-source-v1',
    'sha1',
    SHA1,
    SHA1_TREE,
    SHA1_PACK,
    PACK_SUBDIR_HASH,
  ].join('\0'));
  const markerBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    captureDigest,
    bundleDigest,
    portablePackDigest: PORTABLE_PACK_DIGEST,
    sourceIdentity,
    fileCount: entries.filter((entry) => entry.kind === 'file').length,
    symlinkCount: entries.filter((entry) => entry.kind === 'symlink').length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    custodyAuthenticated: false,
    executionEligible: false,
    policyEligible: false,
    promotionEligible: false,
  }), 'utf8');
  return {
    input: {
      firstBundleBytes: Uint8Array.from(bundleBytes),
      secondBundleBytes: Uint8Array.from(bundleBytes),
      firstMarkerBytes: Uint8Array.from(markerBytes),
      secondMarkerBytes: Uint8Array.from(markerBytes),
    },
    bundleBytes,
    markerBytes,
  };
}

function safeArtifacts(overrides: readonly Artifact[] = []): Artifact[] {
  const base: Artifact[] = [
    { path: '.github', kind: 'directory', mode: '040000' },
    { path: '.github/workflows', kind: 'directory', mode: '040000' },
    {
      path: '.github/workflows/check.yml',
      kind: 'file',
      mode: '100644',
      content: 'workflow canary',
    },
    { path: '.opencode', kind: 'directory', mode: '040000' },
    {
      path: '.opencode/skills',
      kind: 'symlink',
      mode: '120000',
      content: '../skills',
    },
    { path: 'AGENTS.md', kind: 'file', mode: '100644', content: 'instruction canary' },
    { path: 'LICENSE', kind: 'file', mode: '100644', content: 'license canary' },
    { path: 'README.md', kind: 'file', mode: '100644', content: 'documentation canary' },
    { path: 'docs', kind: 'directory', mode: '040000' },
    { path: 'docs/agents.md', kind: 'file', mode: '100644', content: 'docs canary' },
    { path: 'evals', kind: 'directory', mode: '040000' },
    { path: 'evals/cases', kind: 'directory', mode: '040000' },
    {
      path: 'evals/cases/alpha-skill.json',
      kind: 'file',
      mode: '100644',
      content: '{}',
    },
    { path: 'evals/fixtures', kind: 'directory', mode: '040000' },
    {
      path: 'evals/fixtures/input.txt',
      kind: 'file',
      mode: '100644',
      content: 'fixture canary',
    },
    { path: 'hooks', kind: 'directory', mode: '040000' },
    { path: 'hooks/policy.md', kind: 'file', mode: '100644', content: 'hook canary' },
    { path: 'plugin.json', kind: 'file', mode: '100644', content: '{}' },
    { path: 'references', kind: 'directory', mode: '040000' },
    {
      path: 'references/security.md',
      kind: 'file',
      mode: '100644',
      content: 'reference canary',
    },
    { path: 'skills', kind: 'directory', mode: '040000' },
    { path: 'skills/alpha-skill', kind: 'directory', mode: '040000' },
    {
      path: 'skills/alpha-skill/SKILL.md',
      kind: 'file',
      mode: '100644',
      content: SKILL,
    },
    {
      path: 'skills/alpha-skill/guide.md',
      kind: 'file',
      mode: '100644',
      content: 'support canary',
    },
    { path: 'skills/alpha-skill/references', kind: 'directory', mode: '040000' },
    {
      path: 'skills/alpha-skill/references/detail.md',
      kind: 'file',
      mode: '100644',
      content: 'skill reference canary',
    },
    { path: 'skills/alpha-skill/scripts', kind: 'directory', mode: '040000' },
    {
      path: 'skills/alpha-skill/scripts/check.js',
      kind: 'file',
      mode: '100644',
      content: 'script canary',
    },
  ];
  const replaced = new Map(overrides.map((entry) => [entry.path, entry]));
  return base.map((entry) => replaced.get(entry.path) ?? entry);
}

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
  rawContentReturned: false,
  pathsReturned: false,
  artifactNamesReturned: false,
  projectedTextReturned: false,
  sourceIdentityReturned: false,
  referenceExpansion: false,
  distinctReadReceiptsVerified: false,
  captureReceiptBindingVerified: false,
  custodyAuthenticated: false,
  auditReceiptBindingVerified: false,
  sourceCompletenessVerified: false,
  sourceProvenanceVerified: false,
  licensePolicyVerified: false,
  runtimeConsumerVerified: false,
} as const;

describe('M457 external-skill artifact firewall', () => {
  it('classifies the complete inventory exactly once with fail-closed precedence', () => {
    const result = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts()).input);
    expect(result).toMatchObject({
      state: 'classified',
      reason: 'inventory-classified',
      gate: 'collecting',
      classificationComplete: true,
      artifactCount: 28,
      unknownArtifactCount: 0,
      canonicalCaptureConsistencyVerified: true,
      repeatableSnapshotVerified: true,
      projection: {
        eligibleArtifacts: 1,
        invalidArtifacts: 0,
      },
      ...falseAuthority,
    });
    expect(result.classCounts).toEqual([
      { artifactClass: 'directory', count: 13, bytes: 0 },
      { artifactClass: 'skill-entry', count: 1, bytes: Buffer.byteLength(SKILL) },
      { artifactClass: 'skill-support', count: 1, bytes: 14 },
      { artifactClass: 'reference', count: 2, bytes: 38 },
      { artifactClass: 'eval-contract', count: 1, bytes: 2 },
      { artifactClass: 'eval-fixture', count: 1, bytes: 14 },
      { artifactClass: 'license', count: 1, bytes: 14 },
      { artifactClass: 'documentation', count: 2, bytes: 31 },
      { artifactClass: 'instruction-surface', count: 1, bytes: 18 },
      { artifactClass: 'executable-surface', count: 3, bytes: 39 },
      { artifactClass: 'plugin-manifest', count: 1, bytes: 2 },
      { artifactClass: 'repository-metadata', count: 0, bytes: 0 },
      { artifactClass: 'symlink', count: 1, bytes: 9 },
      { artifactClass: 'unknown', count: 0, bytes: 0 },
    ]);
    expect(result.classCounts.map((entry) => entry.artifactClass))
      .toEqual(EXTERNAL_SKILL_ARTIFACT_CLASSES);
    expect(result.classCounts.reduce((sum, entry) => sum + entry.count, 0))
      .toBe(result.artifactCount);
  });

  it('gives kind, mode, and execution paths precedence over attractive names', () => {
    const cases: Array<{
      artifact: Artifact;
      expected: string;
      state: 'classified' | 'withheld';
    }> = [
      {
        artifact: {
          path: 'skills/alpha-skill/SKILL.md',
          kind: 'file',
          mode: '100644',
          content: SKILL,
        },
        expected: 'skill-entry',
        state: 'classified',
      },
      {
        artifact: {
          path: 'skills/alpha-skill/SKILL.md',
          kind: 'file',
          mode: '100755',
          content: SKILL,
        },
        expected: 'executable-surface',
        state: 'classified',
      },
      {
        artifact: {
          path: 'skills/alpha-skill/SKILL.md',
          kind: 'symlink',
          mode: '120000',
          content: '../../../private',
        },
        expected: 'symlink',
        state: 'classified',
      },
      {
        artifact: {
          path: 'skills/alpha-skill/SKILL.md',
          kind: 'directory',
          mode: '040000',
        },
        expected: 'directory',
        state: 'classified',
      },
    ];
    for (const sample of cases) {
      const artifacts = safeArtifacts([sample.artifact]);
      const result = evaluateExternalSkillArtifactFirewall(fixture(artifacts).input);
      expect(result.state).toBe(sample.state);
      expect(result.classCounts.find((entry) => entry.artifactClass === sample.expected)?.count)
        .toBeGreaterThan(0);
      expect(result.projection.eligibleArtifacts)
        .toBe(sample.expected === 'skill-entry' ? 1 : 0);
    }
  });

  it('keeps quarantined bytes out of projection identity', () => {
    const baseline = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts()).input);
    const scriptMutation = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts([{
      path: 'skills/alpha-skill/scripts/check.js',
      kind: 'file',
      mode: '100644',
      content: 'different script bytes',
    }])).input);
    const skillMutation = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts([{
      path: 'skills/alpha-skill/SKILL.md',
      kind: 'file',
      mode: '100644',
      content: SKILL.replace('Private body', 'Changed private body'),
    }])).input);
    expect(scriptMutation.inventoryDigest).not.toBe(baseline.inventoryDigest);
    expect(scriptMutation.projection.projectionDigest)
      .toBe(baseline.projection.projectionDigest);
    expect(skillMutation.inventoryDigest).not.toBe(baseline.inventoryDigest);
    expect(skillMutation.projection.projectionDigest)
      .not.toBe(baseline.projection.projectionDigest);
  });

  it('withholds unknown and invalid projections while returning no private material', () => {
    const unknown = evaluateExternalSkillArtifactFirewall(fixture([
      ...safeArtifacts(),
      { path: 'future.asset', kind: 'file', mode: '100644', content: 'UNKNOWN_CANARY' },
    ]).input);
    expect(unknown).toMatchObject({
      state: 'withheld',
      reason: 'unknown-artifacts',
      gate: 'withheld',
      classificationComplete: false,
      unknownArtifactCount: 1,
      projection: {
        eligibleArtifacts: 0,
        invalidArtifacts: 0,
        projectionDigest: null,
      },
    });

    const invalidProjection = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts([{
      path: 'skills/alpha-skill/SKILL.md',
      kind: 'file',
      mode: '100644',
      content: SKILL.replace('name: alpha-skill', 'name: wrong-name'),
    }])).input);
    expect(invalidProjection).toMatchObject({
      state: 'withheld',
      reason: 'projection-invalid',
      gate: 'withheld',
      projection: {
        eligibleArtifacts: 0,
        invalidArtifacts: 1,
        projectionDigest: null,
      },
    });

    const serialized = JSON.stringify(unknown);
    for (const canary of [
      'future.asset',
      'UNKNOWN_CANARY',
      'alpha-skill',
      'Private body canary',
      'contentBase64',
      SHA1,
      '../skills',
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(Object.hasOwn(unknown, 'sourceIdentity')).toBe(false);
    expect(unknown).toMatchObject(falseAuthority);
  });

  it('withholds projection above the fixed skill-entry ceiling', () => {
    const artifacts: Artifact[] = [
      { path: 'skills', kind: 'directory', mode: '040000' },
    ];
    for (let index = 0; index < 129; index += 1) {
      const name = `skill-${index}`;
      artifacts.push(
        { path: `skills/${name}`, kind: 'directory', mode: '040000' },
        {
          path: `skills/${name}/SKILL.md`,
          kind: 'file',
          mode: '100644',
          content: [
            '---',
            `name: ${name}`,
            'description: Bounded deterministic evidence for a synthetic skill.',
            '---',
          ].join('\n'),
        },
      );
    }
    const result = evaluateExternalSkillArtifactFirewall(fixture(artifacts).input);
    expect(result).toMatchObject({
      state: 'withheld',
      reason: 'projection-invalid',
      classificationComplete: true,
      artifactCount: 259,
      projection: {
        eligibleArtifacts: 0,
        invalidArtifacts: 129,
        projectionDigest: null,
      },
    });
  });

  it('rejects noncanonical, inconsistent, and hostile inputs', () => {
    const valid = fixture(safeArtifacts());
    const tamperedBundle = Uint8Array.from(valid.bundleBytes);
    tamperedBundle[tamperedBundle.length - 1] ^= 1;
    expect(evaluateExternalSkillArtifactFirewall({
      ...valid.input,
      firstBundleBytes: tamperedBundle,
      secondBundleBytes: Uint8Array.from(tamperedBundle),
    }).reason).toBe('invalid-input');
    expect(evaluateExternalSkillArtifactFirewall({
      ...valid.input,
      secondBundleBytes: Uint8Array.from(valid.bundleBytes.subarray(0, -1)),
    }).reason).toBe('invalid-input');
    expect(evaluateExternalSkillArtifactFirewall({
      ...valid.input,
      firstMarkerBytes: Uint8Array.from(Buffer.from(
        valid.markerBytes.toString('utf8').replace(PORTABLE_PACK_DIGEST, '66'.repeat(32)),
      )),
      secondMarkerBytes: Uint8Array.from(Buffer.from(
        valid.markerBytes.toString('utf8').replace(PORTABLE_PACK_DIGEST, '66'.repeat(32)),
      )),
    }).reason).toBe('invalid-input');

    for (const path of [
      '../escape',
      '/absolute',
      'skills\\alpha-skill\\SKILL.md',
      'skills/./SKILL.md',
      'skills/alpha-skill /SKILL.md',
      'skills/con/SKILL.md',
      `skills/e\u0301/SKILL.md`,
    ]) {
      expect(evaluateExternalSkillArtifactFirewall(fixture([{
        path,
        kind: 'file',
        mode: '100644',
        content: SKILL,
      }]).input).reason).toBe('invalid-input');
    }
    expect(evaluateExternalSkillArtifactFirewall(fixture([
      { path: 'README.md', kind: 'file', mode: '100644', content: 'one' },
      { path: 'readme.md', kind: 'file', mode: '100644', content: 'two' },
    ]).input).reason).toBe('invalid-input');

    class ByteSubclass extends Uint8Array {}
    expect(evaluateExternalSkillArtifactFirewall({
      ...valid.input,
      firstBundleBytes: new ByteSubclass(valid.bundleBytes),
    }).reason).toBe('invalid-input');
    expect(evaluateExternalSkillArtifactFirewall({
      ...valid.input,
      firstBundleBytes: new Uint16Array(2),
    }).reason).toBe('invalid-input');
    const hostile = new Proxy(valid.input, {
      ownKeys() {
        throw new Error('hostile input');
      },
    });
    expect(evaluateExternalSkillArtifactFirewall(hostile).reason).toBe('invalid-input');
    if (typeof SharedArrayBuffer !== 'undefined') {
      expect(evaluateExternalSkillArtifactFirewall({
        ...valid.input,
        firstBundleBytes: new Uint8Array(new SharedArrayBuffer(16)),
      }).reason).toBe('invalid-input');
    }
  });

  it('keeps deterministic golden identities across native platforms', () => {
    const result = evaluateExternalSkillArtifactFirewall(fixture(safeArtifacts()).input);
    expect(result.policyDigest).toBe(EXTERNAL_SKILL_ARTIFACT_FIREWALL_POLICY_DIGEST);
    expect(result.policyDigest)
      .toBe('2d1a0da49663492e650115ea38b21bfa96933881a070cabe5c5a0ad5001e5d8f');
    expect(result.inventoryDigest)
      .toBe('6fe230f44e5a8285f79fdce17279dbabd6a7fdef66eae68255ef40b342b5fc1c');
    expect(result.projection.projectionDigest)
      .toBe('51d390f57ece0e5d857cd584f52c5b4218302280d7ef31636f2e729eac0ce4a8');
  });

  it('has no effect capability, runtime consumer, or runtime package export', () => {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const modulePath = join(
      root,
      'src',
      'core',
      'fleet',
      'external-skill-artifact-firewall.ts',
    );
    const moduleSource = readFileSync(modulePath, 'utf8');
    for (const forbidden of [
      "from 'node:fs'",
      "from 'node:path'",
      "from 'node:child_process'",
      "from 'node:http'",
      "from 'node:https'",
      'process.env',
      'eval(',
      'new Function',
    ]) {
      expect(moduleSource).not.toContain(forbidden);
    }

    const references: Array<{ file: string; kind: string; typeOnly: boolean }> = [];
    const target = /(?:^|\/)external-skill-artifact-firewall\.js(?:[?#].*)?$/;
    const sourceFiles = (directory: string): string[] => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) ? [path] : [];
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
    for (const path of sourceFiles(join(root, 'src'))) {
      const sourceFile = ts.createSourceFile(
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
            typeOnly: node.importClause?.isTypeOnly === true,
          });
        } else if (ts.isExportDeclaration(node) &&
          target.test(moduleText(node.moduleSpecifier) ?? '')) {
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: 'export',
            typeOnly: node.isTypeOnly,
          });
        } else if (ts.isCallExpression(node) &&
          target.test(moduleText(node.arguments[0]) ?? '')) {
          references.push({
            file: relative(root, path).replaceAll('\\', '/'),
            kind: node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? 'dynamic-import'
              : 'literal-call',
            typeOnly: false,
          });
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    }
    expect(references).toEqual([{
      file: 'src/api/types.ts',
      kind: 'export',
      typeOnly: true,
    }]);

    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(JSON.stringify(packageJson.exports))
      .not.toContain('external-skill-artifact-firewall');
    for (const directory of ['bin', 'scripts']) {
      const path = join(root, directory);
      if (!existsSync(path)) continue;
      for (const file of sourceFiles(path)) {
        expect(readFileSync(file, 'utf8'))
          .not.toContain('external-skill-artifact-firewall');
      }
    }
    const blockedImport = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import('@ashlr/hub/core/fleet/external-skill-artifact-firewall.js')",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(blockedImport.status).not.toBe(0);
    expect(blockedImport.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
