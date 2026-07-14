import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyAutoMergeCanaryFacts,
  inspectCommittedAutoMergeCanaryPatch,
  inspectStagedAutoMergeCanaryPatch,
  type AutoMergeCanaryFileFact,
  type AutoMergeCanaryGitInvocation,
  type AutoMergeCanaryGitRunResult,
  type AutoMergeCanaryGitRunner,
} from '../src/core/fleet/automerge-canary.js';

let repo: string;
let baseHead: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(relativePath: string, content: string | Buffer): void {
  const target = join(repo, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function stage(...paths: string[]): void {
  git(['add', '--', ...paths]);
}

function inspect() {
  return inspectStagedAutoMergeCanaryPatch(repo, baseHead);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commit(message: string, ...paths: string[]): string {
  stage(...paths);
  git(['commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']);
}

function runRealGit(invocation: AutoMergeCanaryGitInvocation): AutoMergeCanaryGitRunResult {
  try {
    const stdout = execFileSync('git', ['-C', invocation.repo, ...invocation.args], {
      encoding: 'buffer',
      maxBuffer: invocation.maxOutputBytes,
      timeout: invocation.timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, reason: 'git-error' };
  }
}

function fact(overrides: Partial<AutoMergeCanaryFileFact> = {}): AutoMergeCanaryFileFact {
  return {
    path: 'docs/guide.md',
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldOid: '1'.repeat(40),
    newOid: '2'.repeat(40),
    additions: 1,
    deletions: 1,
    oldBlobIsText: true,
    newBlobIsText: true,
    ...overrides,
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ashlr-m396-'));
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'm396@ashlr.test']);
  git(['config', 'user.name', 'M396']);
  git(['config', 'core.filemode', 'true']);
  write('README.md', '# Ashlr\n');
  write('docs/guide.md', 'old guide\n');
  write('docs/remove.md', 'remove me\n');
  write('src/app.ts', 'export const value = 1;\n');
  git(['add', '--', 'README.md', 'docs/guide.md', 'docs/remove.md', 'src/app.ts']);
  git(['commit', '-qm', 'base']);
  baseHead = git(['rev-parse', 'HEAD']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('M396 staged docs-only canary inspector', () => {
  it('accepts a regular documentation modification and reports only bounded metadata', () => {
    write('docs/guide.md', 'new guide\n');
    stage('docs/guide.md');

    expect(inspect()).toMatchObject({
      eligible: true,
      reason: 'eligible docs-only staged patch',
      fileCount: 1,
      lineCount: 2,
      class: 'docs-only',
      stagedTreeOid: expect.stringMatching(/^[a-f0-9]{40}$/),
      baseCommitOid: baseHead,
    });
    expect(Object.keys(inspect()).sort()).toEqual([
      'baseCommitOid', 'class', 'eligible', 'fileCount', 'lineCount', 'reason', 'stagedTreeOid',
    ]);
    expect(inspect().stagedTreeOid).toBe(git(['write-tree']));
  });

  it('rejects executable MDX even under the documentation directory', () => {
    write('docs/component.mdx', 'import Widget from "../src/Widget";\n<Widget />\n');
    stage('docs/component.mdx');

    expect(inspect()).toMatchObject({
      eligible: false,
      reason: 'path is outside the documentation allowlist',
      baseCommitOid: null,
      stagedTreeOid: null,
    });
  });

  it('accepts additions with spaces and deletions of regular text docs', () => {
    write('docs/user guide.md', 'first\nsecond\n');
    stage('docs/user guide.md');
    expect(inspect()).toMatchObject({ eligible: true, fileCount: 1, lineCount: 2, class: 'docs-only' });

    git(['reset', '-q', '--hard', baseHead]);
    unlinkSync(join(repo, 'docs/remove.md'));
    git(['add', '-A', '--', 'docs/remove.md']);
    expect(inspect()).toMatchObject({ eligible: true, fileCount: 1, lineCount: 1, class: 'docs-only' });
  });

  it('accepts canonical root docs but rejects docs-like files in source and test paths', () => {
    write('CHANGELOG.md', '# Next\n');
    stage('CHANGELOG.md');
    expect(inspect()).toMatchObject({ eligible: true, class: 'docs-only' });

    git(['reset', '-q', '--hard', baseHead]);
    write('src/README.md', '# source notes\n');
    stage('src/README.md');
    expect(inspect()).toMatchObject({
      eligible: false,
      reason: 'path is outside the documentation allowlist',
      class: 'rejected',
    });

    git(['reset', '-q', '--hard', baseHead]);
    write('test/README.md', '# fixture\n');
    stage('test/README.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'path is outside the documentation allowlist' });
  });

  it('rejects mixed docs/source and config, build, CI, and manifest paths', () => {
    write('docs/guide.md', 'new guide\n');
    write('src/app.ts', 'export const value = 2;\n');
    stage('docs/guide.md', 'src/app.ts');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'path is outside the documentation allowlist' });

    for (const path of ['config/guide.md', 'build/README.md', '.github/README.md', 'package.json']) {
      git(['reset', '-q', '--hard', baseHead]);
      write(path, path.endsWith('.json') ? '{}\n' : '# unsafe surface\n');
      stage(path);
      expect(inspect(), path).toMatchObject({ eligible: false, class: 'rejected' });
    }
  });

  it('rejects executable mode changes, symlinks, and mode-only patches', () => {
    chmodSync(join(repo, 'docs/guide.md'), 0o755);
    stage('docs/guide.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'file mode is unsupported' });

    git(['reset', '-q', '--hard', baseHead]);
    symlinkSync('guide.md', join(repo, 'docs/link.md'));
    stage('docs/link.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'file mode is unsupported' });

    git(['reset', '-q', '--hard', baseHead]);
    git(['update-index', '--add', '--cacheinfo', `160000,${baseHead},docs/gitlink.md`]);
    expect(inspect()).toMatchObject({ eligible: false, reason: 'file mode is unsupported' });
  });

  it('rejects binary and non-strict text documentation blobs', () => {
    write('docs/binary.md', Buffer.from([0x61, 0x00, 0x62]));
    stage('docs/binary.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'binary content is unsupported' });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/control.md', Buffer.from([0x61, 0x1b, 0x62, 0x0a]));
    stage('docs/control.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'blob content is not strict text' });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/invalid.md', Buffer.from([0xc3, 0x28, 0x0a]));
    stage('docs/invalid.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'blob content is not strict text' });
  });

  it('rejects rename/copy ambiguity and simultaneous additions/deletions', () => {
    renameSync(join(repo, 'docs/guide.md'), join(repo, 'docs/renamed.md'));
    git(['add', '-A', '--', 'docs/guide.md', 'docs/renamed.md']);
    expect(inspect()).toMatchObject({ eligible: false, reason: 'rename or copy is ambiguous' });

    git(['reset', '-q', '--hard', baseHead]);
    copyFileSync(join(repo, 'docs/guide.md'), join(repo, 'docs/copied.md'));
    stage('docs/copied.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'rename or copy is ambiguous' });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/new.md', 'new\n');
    unlinkSync(join(repo, 'docs/remove.md'));
    git(['add', '-A', '--', 'docs/new.md', 'docs/remove.md']);
    expect(inspect()).toMatchObject({ eligible: false, reason: 'rename or copy is ambiguous' });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/one.md', 'same new text\n');
    write('docs/two.md', 'same new text\n');
    stage('docs/one.md', 'docs/two.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'rename or copy is ambiguous' });
  });

  it('binds an accepted verdict to the exact staged tree', () => {
    write('docs/guide.md', 'new guide\n');
    stage('docs/guide.md');
    const accepted = inspect();
    expect(accepted).toMatchObject({ eligible: true, stagedTreeOid: git(['write-tree']) });

    write('src/app.ts', 'export const value = 2;\n');
    stage('src/app.ts');
    expect(git(['write-tree'])).not.toBe(accepted.stagedTreeOid);
    expect(inspect()).toMatchObject({
      eligible: false,
      reason: 'path is outside the documentation allowlist',
      stagedTreeOid: null,
      baseCommitOid: null,
    });
  });

  it('rejects empty staging and invalid or nonexistent base identities', () => {
    expect(inspect()).toEqual({
      eligible: false,
      reason: 'staged patch is empty',
      fileCount: 0,
      lineCount: 0,
      class: 'rejected',
      stagedTreeOid: null,
      baseCommitOid: null,
    });
    expect(inspectStagedAutoMergeCanaryPatch(repo, 'HEAD')).toMatchObject({
      eligible: false,
      reason: 'invalid inspector input',
    });
    expect(inspectStagedAutoMergeCanaryPatch(repo, 'f'.repeat(40))).toMatchObject({
      eligible: false,
      reason: 'git metadata unavailable',
    });
  });

  it('rejects quote-bearing paths fail-closed while safely supporting spaces', () => {
    write('docs/"quoted".md', 'quoted\n');
    stage('docs/"quoted".md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'path is malformed or ambiguous' });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/.well-known/manifest.md', 'hidden\n');
    stage('docs/.well-known/manifest.md');
    expect(inspect()).toMatchObject({ eligible: false, reason: 'path is malformed or ambiguous' });
  });
});

describe('M396 committed docs-only canary inspector', () => {
  it('accepts an exact docs commit and binds the immutable pair, trees, and sorted paths', () => {
    write('docs/guide.md', 'new guide\n');
    const headOid = commit('docs update', 'docs/guide.md');

    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid)).toEqual({
      outcome: 'eligible',
      eligible: true,
      reason: 'eligible docs-only committed patch',
      fileCount: 1,
      lineCount: 2,
      class: 'docs-only',
      baseCommitOid: baseHead,
      headCommitOid: headOid,
      baseTreeOid: git(['rev-parse', `${baseHead}^{tree}`]),
      headTreeOid: git(['rev-parse', `${headOid}^{tree}`]),
      pathDigest: digest('docs/guide.md'),
    });
  });

  it('policy-rejects source and mixed commits while retaining complete bound evidence', () => {
    write('src/app.ts', 'export const value = 2;\n');
    const sourceHead = commit('source update', 'src/app.ts');
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, sourceHead)).toMatchObject({
      outcome: 'policy-rejected',
      eligible: false,
      reason: 'path is outside the documentation allowlist',
      baseCommitOid: baseHead,
      headCommitOid: sourceHead,
      baseTreeOid: git(['rev-parse', `${baseHead}^{tree}`]),
      headTreeOid: git(['rev-parse', `${sourceHead}^{tree}`]),
      pathDigest: digest('src/app.ts'),
    });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/guide.md', 'mixed guide\n');
    write('src/app.ts', 'export const value = 3;\n');
    const mixedHead = commit('mixed update', 'src/app.ts', 'docs/guide.md');
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, mixedHead)).toMatchObject({
      outcome: 'policy-rejected',
      reason: 'path is outside the documentation allowlist',
      fileCount: 2,
      baseCommitOid: baseHead,
      headCommitOid: mixedHead,
      pathDigest: digest('docs/guide.md\0src/app.ts'),
    });
  });

  it('refuses a skipped parent and a merge commit as inspection failures', () => {
    write('docs/guide.md', 'first guide\n');
    const firstHead = commit('first docs update', 'docs/guide.md');
    write('docs/guide.md', 'second guide\n');
    const secondHead = commit('second docs update', 'docs/guide.md');
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, secondHead)).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'head commit does not have base as its sole parent',
      baseCommitOid: null,
      headCommitOid: null,
      pathDigest: null,
    });

    const mergeHead = git([
      'commit-tree', `${firstHead}^{tree}`, '-p', baseHead, '-p', firstHead, '-m', 'merge commit',
    ]);
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, mergeHead)).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'head commit does not have base as its sole parent',
    });
  });

  it('ignores ref, index, and worktree changes and issues only explicit-object read commands', () => {
    write('docs/guide.md', 'committed guide\n');
    const headOid = commit('docs update', 'docs/guide.md');
    write('docs/guide.md', 'dirty worktree guide\n');
    write('src/app.ts', 'export const value = 9;\n');
    stage('src/app.ts');
    git(['update-ref', 'refs/heads/main', baseHead]);
    const indexBefore = git(['write-tree']);
    const statusBefore = git(['status', '--porcelain=v1', '-z']);
    const refBefore = git(['rev-parse', 'refs/heads/main']);
    const invocations: AutoMergeCanaryGitInvocation[] = [];
    const runner: AutoMergeCanaryGitRunner = (invocation) => {
      invocations.push(invocation);
      return runRealGit(invocation);
    };

    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid, { runGit: runner }))
      .toMatchObject({ outcome: 'eligible', headCommitOid: headOid });
    expect(git(['write-tree'])).toBe(indexBefore);
    expect(git(['status', '--porcelain=v1', '-z'])).toBe(statusBefore);
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(refBefore);
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.args).not.toContain('--cached');
      expect(invocation.args).not.toContain('HEAD');
      expect(invocation.args[0]).not.toBe('write-tree');
      expect(invocation.args[0]).not.toBe('status');
      expect(invocation.args[0]).not.toBe('rev-parse');
    }
  });

  it('fails inspection for invalid identities and missing or malformed immutable objects', () => {
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, 'f'.repeat(40))).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'git metadata unavailable',
      baseCommitOid: null,
      pathDigest: null,
    });
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, 'HEAD')).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'invalid inspector input',
    });

    write('docs/guide.md', 'object-backed guide\n');
    const headOid = commit('docs object update', 'docs/guide.md');
    const blobOid = git(['rev-parse', `${headOid}:docs/guide.md`]);
    const objectPath = join(repo, '.git', 'objects', blobOid.slice(0, 2), blobOid.slice(2));
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, 'malformed loose object');
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid)).toMatchObject({
      outcome: 'inspection-failed',
      baseCommitOid: null,
      headCommitOid: null,
      pathDigest: null,
    });

    unlinkSync(objectPath);
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid)).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'git metadata unavailable',
    });
  });

  it('detects parent/tree and diff-metadata reread races with no bound evidence', () => {
    write('docs/guide.md', 'racy guide\n');
    const headOid = commit('docs race fixture', 'docs/guide.md');
    let headReads = 0;
    const runner: AutoMergeCanaryGitRunner = (invocation) => {
      if (invocation.args[0] === 'show' && invocation.args.includes(headOid)) {
        headReads += 1;
        if (headReads === 2) return { ok: false, reason: 'git-error' };
      }
      return runRealGit(invocation);
    };

    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid, { runGit: runner }))
      .toMatchObject({
        outcome: 'inspection-failed',
        reason: 'committed metadata changed during inspection',
        baseCommitOid: null,
        headCommitOid: null,
        pathDigest: null,
      });

    let rawReads = 0;
    const metadataRunner: AutoMergeCanaryGitRunner = (invocation) => {
      const result = runRealGit(invocation);
      if (result.ok && invocation.args[0] === 'diff' &&
        invocation.args.includes('--raw') && invocation.args.includes('--no-renames')) {
        rawReads += 1;
        if (rawReads === 2) {
          return { ok: true, stdout: Buffer.concat([result.stdout, Buffer.from([0])]) };
        }
      }
      return result;
    };
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid, {
      runGit: metadataRunner,
    })).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'committed metadata changed during inspection',
      baseCommitOid: null,
      headCommitOid: null,
      pathDigest: null,
    });
  });

  it('supports SHA-256 repositories when the installed Git supports them', () => {
    const shaRepo = mkdtempSync(join(tmpdir(), 'ashlr-m396-sha256-'));
    try {
      try {
        execFileSync('git', ['init', '-q', '--object-format=sha256', '--initial-branch=main', shaRepo], {
          stdio: 'pipe',
        });
      } catch {
        return;
      }
      const shaGit = (args: string[]): string => execFileSync('git', ['-C', shaRepo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      shaGit(['config', 'user.email', 'm396-sha256@ashlr.test']);
      shaGit(['config', 'user.name', 'M396 SHA256']);
      mkdirSync(join(shaRepo, 'docs'), { recursive: true });
      writeFileSync(join(shaRepo, 'README.md'), '# SHA-256\n');
      writeFileSync(join(shaRepo, 'docs', 'guide.md'), 'old\n');
      shaGit(['add', '--', 'README.md', 'docs/guide.md']);
      shaGit(['commit', '-qm', 'base']);
      const shaBase = shaGit(['rev-parse', 'HEAD']);
      writeFileSync(join(shaRepo, 'docs', 'guide.md'), 'new\n');
      shaGit(['add', '--', 'docs/guide.md']);
      shaGit(['commit', '-qm', 'docs']);
      const shaHead = shaGit(['rev-parse', 'HEAD']);

      expect(inspectCommittedAutoMergeCanaryPatch(shaRepo, shaBase, shaHead)).toMatchObject({
        outcome: 'eligible',
        baseCommitOid: expect.stringMatching(/^[a-f0-9]{64}$/),
        headCommitOid: expect.stringMatching(/^[a-f0-9]{64}$/),
        baseTreeOid: expect.stringMatching(/^[a-f0-9]{64}$/),
        headTreeOid: expect.stringMatching(/^[a-f0-9]{64}$/),
        pathDigest: digest('docs/guide.md'),
      });
    } finally {
      rmSync(shaRepo, { recursive: true, force: true });
    }
  });

  it('binds a 17-file policy rejection but fails closed on an oversized blob', () => {
    const paths = Array.from({ length: 17 }, (_, index) => `docs/bound-${index}.md`);
    for (const path of paths) write(path, `doc ${path}\n`);
    const fileBoundHead = commit('file bound', ...paths);
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, fileBoundHead)).toMatchObject({
      outcome: 'policy-rejected',
      reason: 'staged patch exceeds classifier limits',
      fileCount: 17,
      baseCommitOid: baseHead,
      headCommitOid: fileBoundHead,
      pathDigest: digest([...paths].sort().join('\0')),
    });

    git(['reset', '-q', '--hard', baseHead]);
    write('docs/large.md', Buffer.alloc(512 * 1024 + 1, 0x61));
    const blobBoundHead = commit('blob bound', 'docs/large.md');
    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, blobBoundHead)).toMatchObject({
      outcome: 'inspection-failed',
      baseCommitOid: null,
      headCommitOid: null,
      pathDigest: null,
    });
  });

  it('enforces one bounded whole-inspection deadline across otherwise successful Git calls', () => {
    write('docs/guide.md', 'deadline guide\n');
    const headOid = commit('deadline fixture', 'docs/guide.md');
    let now = 0;
    const timeouts: number[] = [];
    const runner: AutoMergeCanaryGitRunner = (invocation) => {
      timeouts.push(invocation.timeoutMs);
      const result = runRealGit(invocation);
      now += 4;
      return result;
    };

    expect(inspectCommittedAutoMergeCanaryPatch(repo, baseHead, headOid, {
      deadlineMs: 10,
      monotonicNow: () => now,
      runGit: runner,
    })).toMatchObject({
      outcome: 'inspection-failed',
      reason: 'inspection deadline exceeded',
      baseCommitOid: null,
      headCommitOid: null,
    });
    expect(timeouts).toEqual([10, 6, 2]);
  });
});

describe('M396 pure staged fact classifier', () => {
  it('fails closed above the bounded 16-file inspection budget', () => {
    const facts = Array.from({ length: 17 }, (_, index) => fact({
      path: `docs/guide-${index}.md`,
      oldOid: (index + 1).toString(16).padStart(40, '0'),
      newOid: (index + 101).toString(16).padStart(40, '0'),
    }));

    expect(classifyAutoMergeCanaryFacts(facts)).toMatchObject({
      eligible: false,
      reason: 'staged patch exceeds classifier limits',
      fileCount: 17,
    });
  });

  it('rejects traversal, controls, /dev/null, and case-folded duplicate paths', () => {
    for (const path of ['../README.md', 'docs/../README.md', '/dev/null', 'docs/bad\nname.md']) {
      expect(classifyAutoMergeCanaryFacts([fact({ path })]), path).toMatchObject({
        eligible: false,
        reason: 'path is malformed or ambiguous',
      });
    }
    expect(classifyAutoMergeCanaryFacts([
      fact({ path: 'docs/Guide.md' }),
      fact({ path: 'docs/guide.md', oldOid: '3'.repeat(40), newOid: '4'.repeat(40) }),
    ])).toMatchObject({ eligible: false, reason: 'duplicate or conflicting path metadata' });
  });

  it('rejects unsupported modes/statuses, binary counts, and no-hunk facts', () => {
    expect(classifyAutoMergeCanaryFacts([fact({ newMode: '100755' })])).toMatchObject({
      eligible: false,
      reason: 'file mode is unsupported',
    });
    expect(classifyAutoMergeCanaryFacts([fact({ oldMode: '120000' })])).toMatchObject({
      eligible: false,
      reason: 'file mode is unsupported',
    });
    expect(classifyAutoMergeCanaryFacts([fact({ oldMode: '160000' })])).toMatchObject({
      eligible: false,
      reason: 'file mode is unsupported',
    });
    expect(classifyAutoMergeCanaryFacts([fact({ status: 'R100' })])).toMatchObject({
      eligible: false,
      reason: 'change status is unsupported',
    });
    expect(classifyAutoMergeCanaryFacts([fact({ additions: null, deletions: null })])).toMatchObject({
      eligible: false,
      reason: 'binary content is unsupported',
    });
    expect(classifyAutoMergeCanaryFacts([fact({ additions: 0, deletions: 0 })])).toMatchObject({
      eligible: false,
      reason: 'file change has no content lines',
    });
  });

  it('requires status, modes, and object identities to agree', () => {
    expect(classifyAutoMergeCanaryFacts([fact({
      status: 'A',
      oldMode: '000000',
      oldOid: '0'.repeat(40),
      additions: 1,
      deletions: 0,
    })])).toMatchObject({ eligible: true, class: 'docs-only' });

    expect(classifyAutoMergeCanaryFacts([fact({
      status: 'A',
      oldMode: '000000',
      oldOid: '1'.repeat(40),
    })])).toMatchObject({ eligible: false, reason: 'malformed git metadata' });
  });
});
