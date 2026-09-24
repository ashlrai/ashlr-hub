/**
 * V3.10 Track B unit U3 — gate G1 (protected paths → owner lane) and gate
 * G1b (test tampering → high risk → refused). Pure: no I/O.
 */
import { describe, expect, it } from 'vitest';

import {
  PROTECTED_PATH_RULES,
  TIER1_SOURCE_PATTERNS,
  detectTestTampering,
  diffAddedLinesByPath,
  globMatches,
  importSpecifiersIn,
  isTestPath,
  isTier1ClosureRoot,
  isTier1SourcePath,
  isTier1TestPath,
  matchProtectedPath,
  normalizeRepoPath,
  protectedPathHits,
  renderCodeownersBlock,
  resolveRelativeImport,
  testContentImportsTier1,
} from '../src/core/authority/protected-paths.js';

const OTHER = { selfRepo: false };
const SELF = { selfRepo: true };

describe('G1 — protected paths in every repo', () => {
  it.each([
    ['package.json', 'manifest'],
    ['packages/ui/package.json', 'manifest'],
    ['package-lock.json', 'manifest'],
    ['pnpm-lock.yaml', 'manifest'],
    ['yarn.lock', 'manifest'],
    ['bun.lockb', 'manifest'],
    ['Cargo.lock', 'manifest'],
    ['go.sum', 'manifest'],
    ['requirements-dev.txt', 'manifest'],
    ['ashlr.verify.json', 'manifest'],
    ['.npmrc', 'manifest'],
    ['.github/workflows/ci.yml', 'ci-config'],
    ['.github/dependabot.yml', 'ci-config'],
    ['.gitlab-ci.yml', 'ci-config'],
    ['.circleci/config.yml', 'ci-config'],
    ['CODEOWNERS', 'codeowners'],
    ['docs/CODEOWNERS', 'codeowners'],
    ['.husky/pre-commit', 'build-and-hooks'],
    ['.gitattributes', 'build-and-hooks'],
    ['.gitmodules', 'build-and-hooks'],
    ['Dockerfile', 'build-and-hooks'],
    ['deploy/app.dockerfile', 'build-and-hooks'],
    ['Makefile', 'build-and-hooks'],
    ['.envrc', 'build-and-hooks'],
    ['.vscode/tasks.json', 'build-and-hooks'],
    ['scripts/release.mjs', 'release-tooling'],
    ['scripts/build-identity.mjs', 'release-tooling'],
    ['scripts/authority-surface.mjs', 'release-tooling'],
    ['tools/custody/Sources/main.swift', 'release-tooling'],
    ['launchd/ai.ashlr.daemon.plist', 'release-tooling'],
    ['desktop/src-tauri/capabilities/default.json', 'release-tooling'],
    ['desktop/src-tauri/tauri.conf.json', 'release-tooling'],
    ['config/server.pem', 'secrets'],
    ['.env', 'secrets'],
    ['apps/web/.env.production', 'secrets'],
    ['keys/id_ed25519', 'secrets'],
    ['docs/RUNTIME_ACTIVATION_AUTHORITY.md', 'authority-doc'],
    ['docs/AUTHORITY.md', 'authority-doc'],
    // G1 verify-config gap (3.10 integration): the verify detector reads these outside ashlr-hub too.
    ['tsconfig.json', 'verify-config'],
    ['packages/api/tsconfig.json', 'verify-config'],
    ['tsconfig.base.json', 'verify-config'],
    ['mypy.ini', 'verify-config'],
    ['.mypy.ini', 'verify-config'],
    ['ruff.toml', 'verify-config'],
    ['services/py/.ruff.toml', 'verify-config'],
    ['pytest.ini', 'verify-config'],
    ['tox.ini', 'verify-config'],
  ])('%s → owner lane (%s) in any repo', (path, ruleId) => {
    expect(matchProtectedPath(path, OTHER)).toMatchObject({ path, ruleId });
  });

  it('matches case-insensitively (macOS checkouts fold case)', () => {
    expect(matchProtectedPath('Package.JSON', OTHER)?.ruleId).toBe('manifest');
    expect(matchProtectedPath('.GitHub/Workflows/CI.yml', OTHER)?.ruleId).toBe('ci-config');
    expect(matchProtectedPath('codeowners', OTHER)?.ruleId).toBe('codeowners');
  });

  it.each(['src/app/index.ts', 'README.md', 'docs/guide.md', 'test/math.test.ts', 'src/core/policy/rules.ts', 'lib/package-helpers.ts'])(
    '%s is not protected outside ashlr-hub',
    (path) => {
      expect(matchProtectedPath(path, OTHER)).toBeNull();
    },
  );

  it.each([
    ['../etc/passwd'],
    ['/etc/passwd'],
    ['src/../package.json'],
    ['src//x.ts'],
    ['.git/hooks/pre-commit'],
    ['vendor/.git/config'],
    ['bad\u0000name'],
    ['line\nbreak'],
    [''],
  ])('an unnormalizable path %j is treated as protected (unsafe-path)', (path) => {
    expect(matchProtectedPath(path, OTHER)?.ruleId).toBe('unsafe-path');
  });

  it('normalizeRepoPath strips ./ and backslashes, refuses escapes', () => {
    expect(normalizeRepoPath('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeRepoPath('src\\x.ts')).toBe('src/x.ts');
    expect(normalizeRepoPath('a/../b')).toBeNull();
    expect(normalizeRepoPath('/abs')).toBeNull();
  });
});

describe('G1 — ashlr-hub Tier-1 (self repo only)', () => {
  it.each([
    'src/core/authority/standing-grant.ts',
    'src/core/authority/protected-paths.ts',
    'src/core/daemon/activation-permit.ts',
    'src/core/daemon/tick-hooks.ts',
    'src/core/daemon/loop.ts',
    'src/core/daemon/post-merge-halt.ts',
    'src/core/inbox/merge.ts',
    'src/core/fleet/automerge-pass.ts',
    'src/core/fleet/host-merge.ts',
    'src/core/fleet/merge-gates.ts',
    'src/core/fleet/standing-merge-pass.ts',
    'src/core/fleet/fleet-merge-state.ts',
    'src/core/fleet/post-merge-watch.ts',
    'src/core/fleet/quarantine.ts',
    'src/core/fleet/manager.ts',
    'src/core/fleet/reviewer-independence.ts',
    'src/core/sandbox/confine.ts',
    'src/core/sandbox/safe-git.ts',
    'src/core/policy/local-only.ts',
    'src/core/routing/router.ts',
    'src/core/foundry/provenance.ts',
    'src/core/run/sandboxed-engine.ts',
    'src/core/vision/leader-apply.ts',
    'src/core/learn/harness-registry.ts',
    'src/core/autonomy/host-merge-revocation-protocol.ts',
    'src/core/learning/agent-semantic-events.ts',
    'src/core/verse/authority-api.ts',
    'src/cli/authority.ts',
    'test/setup/home-isolation-guard.ts',
    'test/config/realio-lane-membership.mjs',
    'test/fixtures/authority/tier1-closure.json',
    'vitest.config.ts',
    'vitest.config.web.ts',
    'tsconfig.json',
    'src/web-ui/tsconfig.json',
  ])('%s → owner lane in ashlr-hub, and only there', (path) => {
    expect(matchProtectedPath(path, SELF)).not.toBeNull();
    if (path.startsWith('src/core/') || path.startsWith('src/cli/') || path.startsWith('test/') || path.startsWith('vitest')) {
      expect(matchProtectedPath(path, OTHER)).toBeNull();
    }
  });

  it('non-authority ashlr-hub code stays mergeable (merge-non-authority)', () => {
    for (const path of ['src/web-ui/routes/verse/Transcript.tsx', 'src/core/verse/session-engine.ts', 'docs/QUICKSTART.md', 'src/cli/verse.ts']) {
      expect(matchProtectedPath(path, SELF)).toBeNull();
    }
  });

  it('tests for Tier-1 code are protected by name, by the invariant list, or by what they import', () => {
    expect(isTier1TestPath('test/m47.merge.test.ts')).toBe(true);
    expect(isTier1TestPath('test/h1.safety.test.ts')).toBe(true);
    expect(isTier1TestPath('test/h4.proposal-only.test.ts')).toBe(true);
    expect(isTier1TestPath('test/merge-gates-310b.test.ts')).toBe(true);
    expect(isTier1TestPath('test/host-merge-310b.test.ts')).toBe(true);
    expect(isTier1TestPath('test/confine-custody.darwin.test.ts')).toBe(true);
    expect(isTier1TestPath('test/verse-transcript.test.ts')).toBe(false);
    expect(isTier1TestPath('test/verse-transcript.test.ts', true)).toBe(true);
    expect(isTier1TestPath('src/web-ui/foo.test.ts')).toBe(false);

    const importing = new Set(['test/verse-transcript.test.ts']);
    expect(matchProtectedPath('test/verse-transcript.test.ts', { selfRepo: true, testsImportingTier1: importing })?.ruleId).toBe('tier1-test');
    expect(matchProtectedPath('test/verse-transcript.test.ts', SELF)).toBeNull();
  });

  it('finds Tier-1 imports in test content (static, dynamic, vi.mock, re-export)', () => {
    const content = [
      "import { autoMergeProposal } from '../src/core/inbox/merge.js';",
      "const m = await import('../src/core/verse/verse-api.js');",
      "vi.mock('../src/core/sandbox/policy.js', () => ({}));",
      "export { x } from './helpers/thing.js';",
    ].join('\n');
    expect(importSpecifiersIn(content)).toEqual(expect.arrayContaining([
      '../src/core/inbox/merge.js',
      '../src/core/verse/verse-api.js',
      '../src/core/sandbox/policy.js',
      './helpers/thing.js',
    ]));
    expect(testContentImportsTier1('test/a.test.ts', [content])).toBe(true);
    expect(testContentImportsTier1('test/a.test.ts', ["import { x } from '../src/core/verse/verse-api.js';"])).toBe(false);
    expect(testContentImportsTier1('test/a.test.ts', [null, "import('../src/core/routing/router.js')"])).toBe(true);
    expect(resolveRelativeImport('test/deep/a.test.ts', '../../src/core/x.js')).toBe('src/core/x.ts');
    expect(resolveRelativeImport('test/a.test.ts', 'vitest')).toBeNull();
    expect(resolveRelativeImport('test/a.test.ts', '../../../escape.js')).toBeNull();
  });

  it('closure-snapshot roots are Tier-1 source minus HTTP API modules', () => {
    expect(isTier1ClosureRoot('src/core/routing/router.ts')).toBe(true);
    expect(isTier1ClosureRoot('src/core/routing/budget-api.ts')).toBe(false);
    expect(isTier1ClosureRoot('src/core/verse/authority-api.ts')).toBe(false);
    expect(isTier1ClosureRoot('src/core/verse/session-engine.ts')).toBe(false);
    expect(isTier1SourcePath('src/core/authority/anything/deep.ts')).toBe(true);
  });

  it('protectedPathHits reports each protected path once, in order', () => {
    const hits = protectedPathHits(['src/app.ts', 'package.json', 'package.json', '.github/workflows/ci.yml'], OTHER);
    expect(hits.map((h) => h.path)).toEqual(['package.json', '.github/workflows/ci.yml']);
  });

  it('every rule has a stable id and a reason; the Tier-1 list names the gate modules', () => {
    const ids = PROTECTED_PATH_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of PROTECTED_PATH_RULES) expect(rule.why.length).toBeGreaterThan(10);
    for (const gate of ['src/core/inbox/merge.ts', 'src/core/fleet/host-merge.ts', 'src/core/authority/**']) {
      expect(TIER1_SOURCE_PATTERNS).toContain(gate);
    }
    expect(globMatches('src/core/authority/**', 'src/core/authority/x/y.ts')).toBe(true);
    expect(globMatches('**/package.json', 'package.json')).toBe(true);
    expect(globMatches('scripts/release*', 'scripts/nested/release.mjs')).toBe(false);
  });

  it('renders CODEOWNERS lines that GitHub anchors the same way', () => {
    const other = renderCodeownersBlock('@masonwyatt', { selfRepo: false });
    expect(other).toContain('/.github/** @masonwyatt');
    expect(other).toContain('**/package.json @masonwyatt');
    expect(other).toContain('/CODEOWNERS @masonwyatt');
    expect(other).not.toContain('/src/core/authority/** @masonwyatt');
    const self = renderCodeownersBlock('@ashlrai/owners', { selfRepo: true });
    expect(self).toContain('/src/core/authority/** @ashlrai/owners');
    expect(self).toContain('/src/core/inbox/merge.ts @ashlrai/owners');
    expect(() => renderCodeownersBlock('masonwyatt', { selfRepo: false })).toThrow();
  });
});

function testDiff(path: string, hunk: string, header = ''): string {
  return `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n${hunk}`;
}

describe('G1b — test tampering', () => {
  it('removing an it( / expect( call is tampering (net, per call kind)', () => {
    const diff = testDiff('test/math.test.ts', "@@ -1,4 +1,3 @@\n it('adds', () => {\n-  expect(add(1, 2)).toBe(3);\n+  add(1, 2);\n });\n");
    const scan = detectTestTampering(diff);
    expect(scan.parseError).toBeNull();
    expect(scan.findings).toEqual([expect.objectContaining({ kind: 'test-calls-removed', path: 'test/math.test.ts' })]);
    expect(scan.findings[0]!.detail).toMatch(/expect\(/);
  });

  it('moving an expect (removed and re-added) is not tampering', () => {
    const diff = testDiff('test/math.test.ts', "@@ -1,4 +1,4 @@\n it('adds', () => {\n-  expect(add(1, 2)).toBe(3);\n+  expect(add(1, 2)).toBe(3); // same assertion\n });\n");
    expect(detectTestTampering(diff).findings).toEqual([]);
  });

  it('removing a whole it( block is tampering', () => {
    const diff = testDiff('src/lib/util.spec.ts', "@@ -1,6 +1,2 @@\n import { x } from './util';\n-it('works', () => {\n-  expect(x()).toBe(1);\n-});\n-\n const y = 1;\n");
    const kinds = detectTestTampering(diff).findings.map((f) => f.kind);
    expect(kinds).toEqual(['test-calls-removed', 'test-calls-removed']);
  });

  it.each([
    ["+describe.skip('suite', () => {"],
    ["+  it.only('focus', () => {"],
    ["+  test.skipIf(process.env.CI)('x', () => {"],
    ["+  xit('disabled', () => {"],
    ["+  fdescribe('focused', () => {"],
  ])('adding %s is tampering', (line) => {
    const diff = testDiff('test/a.test.ts', `@@ -1,1 +1,2 @@\n const a = 1;\n${line}\n`);
    expect(detectTestTampering(diff).findings.map((f) => f.kind)).toContain('test-focused-or-skipped');
  });

  it('deleting a test file is tampering', () => {
    const diff = `diff --git a/test/old.test.ts b/test/old.test.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/test/old.test.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-it('x', () => {});\n`;
    expect(detectTestTampering(diff).findings).toEqual([expect.objectContaining({ kind: 'test-file-deleted', path: 'test/old.test.ts' })]);
  });

  it('editing an existing snapshot is tampering; a new snapshot file is not', () => {
    const edited = testDiff('test/__snapshots__/view.test.ts.snap', '@@ -1,1 +1,1 @@\n-exports[`a`] = `1`;\n+exports[`a`] = `2`;\n');
    expect(detectTestTampering(edited).findings.map((f) => f.kind)).toEqual(['snapshot-edited']);
    const created = `diff --git a/test/__snapshots__/new.test.ts.snap b/test/__snapshots__/new.test.ts.snap\nnew file mode 100644\n--- /dev/null\n+++ b/test/__snapshots__/new.test.ts.snap\n@@ -0,0 +1,1 @@\n+exports[\`a\`] = \`1\`;\n`;
    expect(detectTestTampering(created).findings).toEqual([]);
    const inline = testDiff('test/view.test.ts', "@@ -1,1 +1,1 @@\n-  expect(render()).toMatchInlineSnapshot(`\"a\"`);\n+  expect(render()).toMatchInlineSnapshot(`\"b\"`);\n");
    expect(detectTestTampering(inline).findings.map((f) => f.kind)).toContain('snapshot-edited');
  });

  it('changing test-runner configuration is tampering in any repo', () => {
    for (const path of ['vitest.config.ts', 'packages/a/jest.config.js', 'playwright.config.ts', 'conftest.py']) {
      const diff = testDiff(path, '@@ -1,1 +1,1 @@\n-a\n+b\n');
      expect(detectTestTampering(diff).findings.map((f) => f.kind)).toEqual(['test-config-edited']);
    }
  });

  it('a plain source change and new tests are not tampering', () => {
    const src = testDiff('src/math.ts', '@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;\n');
    expect(detectTestTampering(src)).toEqual({ findings: [], parseError: null });
    const added = testDiff('test/math.test.ts', "@@ -1,1 +1,3 @@\n const a = 1;\n+it('b', () => {\n+  expect(b).toBe(2);\n");
    expect(detectTestTampering(added).findings).toEqual([]);
  });

  it('fails closed on what it cannot read', () => {
    expect(detectTestTampering('').parseError).not.toBeNull();
    expect(detectTestTampering('not a diff at all').parseError).not.toBeNull();
    const binary = 'diff --git a/test/x.bin b/test/x.bin\nindex 1..2 100644\nBinary files a/test/x.bin and b/test/x.bin differ\n';
    expect(detectTestTampering(binary).parseError).toMatch(/binary/);
  });

  it('handles C-quoted paths git emits for special characters', () => {
    const diff = 'diff --git "a/test/sp ace.test.ts" "b/test/sp ace.test.ts"\n--- "a/test/sp ace.test.ts"\n+++ "b/test/sp ace.test.ts"\n@@ -1,1 +1,0 @@\n-expect(1).toBe(1);\n';
    const scan = detectTestTampering(diff);
    expect(scan.parseError).toBeNull();
    expect(scan.findings[0]).toMatchObject({ kind: 'test-calls-removed', path: 'test/sp ace.test.ts' });
  });

  it('diffAddedLinesByPath returns each file section\'s added lines', () => {
    const diff = `${testDiff('test/a.test.ts', "@@ -1,1 +1,2 @@\n a\n+import { m } from '../src/core/inbox/merge.js';\n")}${testDiff('src/b.ts', '@@ -1,1 +1,1 @@\n-x\n+y\n')}`;
    const added = diffAddedLinesByPath(diff)!;
    expect(added.get('test/a.test.ts')).toEqual(["import { m } from '../src/core/inbox/merge.js';"]);
    expect(added.get('src/b.ts')).toEqual(['y']);
    expect(isTestPath('test/a.test.ts')).toBe(true);
    expect(isTestPath('src/b.ts')).toBe(false);
  });
});
