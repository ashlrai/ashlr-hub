/**
 * test/h1.fixture.test.ts — H1 BUILD task 4: the TESTKIT proves ITSELF.
 *
 * Self-tests for test/helpers/h1-fixture.ts so the other H1 BUILD agents can
 * trust it as the shared foundation:
 *   - makeFixture relocates HOME to a fresh tmp dir and restores it on cleanup.
 *   - makeDisposableRepo builds a real git repo with a resolvable HEAD + clean tree.
 *   - shasumTree is stable, order-independent, excludes .git, detects byte changes.
 *   - makeAddFileDiff produces a diff that `git apply` accepts.
 *   - seedBacklog writes the exact shape loadBacklog() parses.
 *   - cleanup is idempotent and unenrolls tracked repos.
 *
 * SAFETY: every assertion here runs inside a relocated tmp HOME and operates
 * ONLY on disposable tmp repos. The real ~/.ashlr is never read or written.
 * This suite has NO live-LLM dependency and touches only tmp dirs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  makeFixture,
  withTmpHome,
  makeDisposableRepo,
  shasumTree,
  makeAddFileDiff,
  seedBacklog,
  type H1Fixture,
} from './helpers/h1-fixture.js';
import { loadBacklog } from '../src/core/portfolio/backlog.js';
import {
  canonicalEnrollmentPath,
  enrollmentPath,
  listEnrolled,
} from '../src/core/sandbox/policy.js';

/** Capture the REAL HOME once, before any fixture relocates it, so every test
 *  can assert isolation against a stable baseline. */
const REAL_HOME = process.env.HOME;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

// ===========================================================================
// makeFixture — HOME isolation
// ===========================================================================

describe('H1 testkit — makeFixture HOME isolation', () => {
  it('relocates homedir() to the fresh tmp HOME while active', () => {
    const fx = makeFixture();
    try {
      // The fixture's home is a fresh tmp dir, not the real HOME.
      expect(resolve(fx.home)).not.toBe(resolve(REAL_HOME ?? ''));
      expect(fx.home.startsWith(realpathSync.native(tmpdir()))).toBe(true);
      // os.homedir() (the seam the whole chain resolves through) now points at it.
      expect(resolve(homedir())).toBe(resolve(fx.home));
      expect(resolve(process.env.HOME ?? '')).toBe(resolve(fx.home));
      expect(resolve(process.env.USERPROFILE ?? '')).toBe(resolve(fx.home));
      expect(resolve(process.env.ASHLR_HOME ?? '')).toBe(resolve(fx.ashlrDir));
      // The isolated ~/.ashlr resolves under the tmp HOME, and enrollmentPath()
      // — the real production path helper — points inside it (never the real one).
      expect(fx.ashlrDir).toBe(join(fx.home, '.ashlr'));
      expect(enrollmentPath().startsWith(resolve(fx.home))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('cleanup() restores the prior HOME, USERPROFILE, and ASHLR_HOME exactly', () => {
    const before = process.env.HOME;
    const beforeUserProfile = process.env.USERPROFILE;
    const beforeAshlrHome = process.env.ASHLR_HOME;
    const fx = makeFixture();
    expect(process.env.HOME).toBe(fx.home); // relocated
    expect(process.env.USERPROFILE).toBe(fx.home);
    expect(process.env.ASHLR_HOME).toBe(fx.ashlrDir);
    fx.cleanup();
    expect(process.env.HOME).toBe(before); // restored byte-for-byte
    expect(process.env.USERPROFILE).toBe(beforeUserProfile);
    expect(process.env.ASHLR_HOME).toBe(beforeAshlrHome);
    expect(resolve(homedir())).toBe(resolve(REAL_HOME ?? ''));
  });

  it('cleanup() removes the tmp HOME directory', () => {
    const fx = makeFixture();
    const home = fx.home;
    expect(existsSync(home)).toBe(true);
    fx.cleanup();
    expect(existsSync(home)).toBe(false);
  });

  it('clears + restores ASHLR_IN_DAEMON / ASHLR_IN_SWARM around the fixture', () => {
    // Simulate being invoked from inside a daemon/swarm: the fixture must clear
    // these so a real tick is not refused by the re-entrancy guard, then restore.
    const prevDaemon = process.env.ASHLR_IN_DAEMON;
    const prevSwarm = process.env.ASHLR_IN_SWARM;
    process.env.ASHLR_IN_DAEMON = '1';
    process.env.ASHLR_IN_SWARM = '1';
    try {
      const fx = makeFixture();
      // Cleared while the fixture is active.
      expect(process.env.ASHLR_IN_DAEMON).toBeUndefined();
      expect(process.env.ASHLR_IN_SWARM).toBeUndefined();
      fx.cleanup();
      // Restored exactly after cleanup.
      expect(process.env.ASHLR_IN_DAEMON).toBe('1');
      expect(process.env.ASHLR_IN_SWARM).toBe('1');
    } finally {
      if (prevDaemon === undefined) delete process.env.ASHLR_IN_DAEMON;
      else process.env.ASHLR_IN_DAEMON = prevDaemon;
      if (prevSwarm === undefined) delete process.env.ASHLR_IN_SWARM;
      else process.env.ASHLR_IN_SWARM = prevSwarm;
    }
  });

  it('hands back a tmp HOME that is not the real HOME (no real-state risk)', () => {
    // The fixture only proceeds once homedir() resolves to the fresh tmp dir; if
    // relocation had not taken effect it would throw rather than risk the real
    // ~/.ashlr (see makeFixture's guard). Here we assert the positive outcome:
    // a tmp HOME distinct from the real one, with a matching homedir().
    const fx = makeFixture();
    try {
      expect(resolve(fx.home)).not.toBe(resolve(REAL_HOME ?? ''));
      expect(resolve(homedir())).toBe(resolve(fx.home));
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// makeDisposableRepo
// ===========================================================================

describe('H1 testkit — makeDisposableRepo', () => {
  let fx: H1Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('creates a real git repo with a resolvable HEAD', () => {
    const repo = fx.makeRepo();
    // The dir is a real git repo under os.tmpdir().
    expect(repo.dir.startsWith(realpathSync.native(tmpdir()))).toBe(true);
    expect(existsSync(join(repo.dir, '.git'))).toBe(true);
    // HEAD resolves to a real commit (the initial commit).
    const head = git(repo.dir, ['rev-parse', 'HEAD']);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.currentBranch()).toBe('main');
    expect(repo.branch).toBe('main');
  });

  it('seeds the requested files into the initial commit; git status is clean', () => {
    const repo = fx.makeRepo({
      files: { 'src/index.ts': 'export const x = 1;\n', 'docs/readme.md': '# hi\n' },
      branch: 'trunk',
      message: 'seed',
    });
    expect(repo.branch).toBe('trunk');
    expect(repo.currentBranch()).toBe('trunk');
    // Files are present and were committed (clean working tree, no untracked).
    expect(repo.readFile('src/index.ts')).toBe('export const x = 1;\n');
    expect(repo.readFile('docs/readme.md')).toBe('# hi\n');
    expect(repo.gitStatus()).toBe('');
    // The commit message landed.
    expect(git(repo.dir, ['log', '-1', '--pretty=%s'])).toBe('seed');
    // The seeded files are tracked in HEAD's tree.
    const tracked = git(repo.dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
      .split('\n')
      .sort();
    expect(tracked).toEqual(['docs/readme.md', 'src/index.ts']);
  });

  it('defaults to a single README.md when no files are given', () => {
    const repo = fx.makeRepo();
    const tracked = git(repo.dir, ['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tracked).toBe('README.md');
    expect(repo.readFile('README.md')).toContain('disposable test repo');
    expect(repo.gitStatus()).toBe('');
  });

  it('enroll()/unenroll()/isEnrolled() round-trip against the isolated registry', () => {
    const repo = fx.makeRepo();
    const canonicalRepo = canonicalEnrollmentPath(repo.dir);
    expect(canonicalRepo).not.toBeNull();
    expect(repo.isEnrolled()).toBe(false);
    expect(listEnrolled()).not.toContain(canonicalRepo);

    repo.enroll();
    expect(repo.isEnrolled()).toBe(true);
    expect(listEnrolled()).toContain(canonicalRepo);
    // The registry that changed lives under the tmp HOME, NOT the real ~/.ashlr.
    expect(enrollmentPath().startsWith(resolve(fx.home))).toBe(true);

    // enroll() is idempotent — no duplicate entries.
    repo.enroll();
    const dupes = listEnrolled().filter((r) => r === canonicalRepo);
    expect(dupes.length).toBe(1);

    repo.unenroll();
    expect(repo.isEnrolled()).toBe(false);
    // unenroll() is idempotent — calling again is a no-op, never throws.
    expect(() => repo.unenroll()).not.toThrow();
    expect(repo.isEnrolled()).toBe(false);
  });
});

// ===========================================================================
// shasumTree — REAL-TREE-UNCHANGED primitive
// ===========================================================================

describe('H1 testkit — shasumTree', () => {
  let fx: H1Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('is deterministic: two calls on an unchanged tree return the same hash', () => {
    const repo = fx.makeRepo({ files: { 'a.txt': 'A\n', 'b.txt': 'B\n' } });
    const h1 = repo.shasumTree();
    const h2 = repo.shasumTree();
    expect(h1).toBe(h2);
    // It is a real SHA-256 hex digest.
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // The standalone shasumTree(dir) agrees with the handle's bound method.
    expect(shasumTree(repo.dir)).toBe(h1);
  });

  it('is order-independent: file creation order does not change the hash', () => {
    // Two repos with the SAME content set, seeded in different orders, must hash
    // equal — proving the walk sorts by path before folding.
    const a = makeDisposableRepo({ files: { 'one.txt': '1\n', 'two.txt': '2\n' } });
    const b = makeDisposableRepo({ files: { 'two.txt': '2\n', 'one.txt': '1\n' } });
    try {
      expect(shasumTree(a.dir)).toBe(shasumTree(b.dir));
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('excludes .git internals (a new commit alone does not change the hash)', () => {
    const repo = fx.makeRepo({ files: { 'keep.txt': 'keep\n' } });
    const before = repo.shasumTree();
    // A new commit (no working-tree content change) rewrites .git but the tracked
    // files are byte-identical, so the working-tree hash must be unchanged.
    git(repo.dir, ['commit', '--allow-empty', '--no-verify', '-m', 'empty']);
    expect(repo.shasumTree()).toBe(before);
    // git status is still clean and HEAD advanced — proving .git DID change.
    expect(repo.gitStatus()).toBe('');
  });

  it('changes when a tracked working-tree file changes by even one byte', () => {
    const repo = fx.makeRepo({ files: { 'data.txt': 'hello\n' } });
    const before = repo.shasumTree();
    repo.writeFile('data.txt', 'hellp\n'); // one byte flipped
    expect(repo.shasumTree()).not.toBe(before);
  });

  it('changes when a new working-tree file is added', () => {
    const repo = fx.makeRepo({ files: { 'only.txt': 'x\n' } });
    const before = repo.shasumTree();
    repo.writeFile('extra.txt', 'new\n');
    expect(repo.shasumTree()).not.toBe(before);
  });
});

// ===========================================================================
// makeAddFileDiff — the deterministic propose-path stand-in
// ===========================================================================

describe('H1 testkit — makeAddFileDiff', () => {
  let fx: H1Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('produces a unified diff that `git apply` accepts in a disposable repo', () => {
    const repo = fx.makeRepo();
    const diff = makeAddFileDiff('added/file.txt', 'line one\nline two\n');
    // git apply --check must accept it (validates without mutating the tree).
    const patchFile = join(repo.dir, '.h1.patch');
    writeFileSync(patchFile, diff, 'utf8');
    expect(() => git(repo.dir, ['apply', '--check', patchFile])).not.toThrow();
    // Apply for real and confirm the new file lands with exact content.
    git(repo.dir, ['apply', patchFile]);
    expect(repo.readFile('added/file.txt')).toBe('line one\nline two\n');
    rmSync(patchFile);
  });

  it('handles content with and without a trailing newline without spurious lines', () => {
    const repo = fx.makeRepo();

    // With trailing newline.
    const withNl = makeAddFileDiff('with-nl.txt', 'a\nb\nc\n');
    const p1 = join(repo.dir, '.with.patch');
    writeFileSync(p1, withNl, 'utf8');
    git(repo.dir, ['apply', p1]);
    expect(repo.readFile('with-nl.txt')).toBe('a\nb\nc\n');

    // Without trailing newline in the source content — the builder must not emit
    // a spurious empty '+' line, so the diff still applies cleanly. (The builder
    // does not write a `\ No newline at end of file` marker, so git apply lands
    // the three lines with a normalized trailing newline; the key guarantee is a
    // clean apply with NO 4th/empty line.)
    const noNl = makeAddFileDiff('no-nl.txt', 'a\nb\nc');
    expect(noNl).not.toContain('+\n+'); // no spurious empty added line
    const p2 = join(repo.dir, '.nonl.patch');
    writeFileSync(p2, noNl, 'utf8');
    expect(() => git(repo.dir, ['apply', '--check', p2])).not.toThrow();
    git(repo.dir, ['apply', p2]);
    expect(repo.readFile('no-nl.txt')).toBe('a\nb\nc\n');

    rmSync(p1);
    rmSync(p2);
  });

  it('refuses empty content rather than emitting a hunk git apply would reject', () => {
    // Truly empty content collapses to zero body lines => a `@@ -0,0 +1,0 @@`
    // hunk with no added lines, which `git apply` rejects. The builder must throw
    // rather than return such a patch.
    expect(() => makeAddFileDiff('empty.txt', '')).toThrow(/empty content/i);
  });

  it('a lone newline is a VALID single empty-line file and applies cleanly', () => {
    // '\n' is one (empty) line of content, not empty content: the builder emits a
    // valid `@@ -0,0 +1,1 @@` hunk with one empty added line that git apply lands.
    const repo = fx.makeRepo();
    const diff = makeAddFileDiff('one-empty-line.txt', '\n');
    const patchFile = join(repo.dir, '.lone-nl.patch');
    writeFileSync(patchFile, diff, 'utf8');
    expect(() => git(repo.dir, ['apply', '--check', patchFile])).not.toThrow();
    git(repo.dir, ['apply', patchFile]);
    expect(repo.readFile('one-empty-line.txt')).toBe('\n');
    rmSync(patchFile);
  });
});

// ===========================================================================
// seedBacklog — deterministic backlog that loadBacklog() parses
// ===========================================================================

describe('H1 testkit — seedBacklog', () => {
  let fx: H1Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('writes ~/.ashlr/backlog.json in the exact shape loadBacklog() parses', () => {
    const repo = fx.makeRepo();
    seedBacklog(fx.home, repo.dir, [
      { title: 'tidy imports', detail: 'sort + dedupe' },
      { title: 'add test', value: 5, effort: 1 },
    ]);

    // The file lives under the ISOLATED tmp HOME, never the real ~/.ashlr.
    const path = join(fx.home, '.ashlr', 'backlog.json');
    expect(existsSync(path)).toBe(true);

    // The real production loader parses it (proves the shape is exact).
    const loaded = loadBacklog();
    expect(loaded).not.toBeNull();
    expect(loaded?.repos).toEqual([repo.dir]);
    expect(loaded?.items.length).toBe(2);
    expect(typeof loaded?.generatedAt).toBe('string');

    const first = loaded!.items[0]!;
    expect(first.id).toBe('h1-item-0');
    expect(first.repo).toBe(repo.dir);
    expect(first.source).toBe('todo');
    expect(first.title).toBe('tidy imports');
    expect(first.detail).toBe('sort + dedupe');
    expect(Array.isArray(first.tags)).toBe(true);
    expect(typeof first.ts).toBe('string');
  });

  it('scores each item as value/effort so selection ordering is deterministic', () => {
    const repo = fx.makeRepo();
    seedBacklog(fx.home, repo.dir, [
      { title: 'low', value: 2, effort: 4 }, // 0.5
      { title: 'high', value: 5, effort: 1 }, // 5.0
      { title: 'default' }, // value 3 / effort 2 => 1.5
    ]);
    const loaded = loadBacklog();
    expect(loaded).not.toBeNull();
    const byTitle = new Map(loaded!.items.map((i) => [i.title, i]));
    expect(byTitle.get('low')!.score).toBeCloseTo(0.5, 10);
    expect(byTitle.get('high')!.score).toBeCloseTo(5.0, 10);
    expect(byTitle.get('default')!.value).toBe(3);
    expect(byTitle.get('default')!.effort).toBe(2);
    expect(byTitle.get('default')!.score).toBeCloseTo(1.5, 10);
  });
});

// ===========================================================================
// cleanup — idempotent + leak-free
// ===========================================================================

describe('H1 testkit — cleanup', () => {
  it('is idempotent: calling cleanup() twice never throws', () => {
    const fx = makeFixture();
    fx.makeRepo();
    expect(() => fx.cleanup()).not.toThrow();
    // Second cleanup is a no-op: HOME already restored, dirs already gone.
    expect(() => fx.cleanup()).not.toThrow();
    expect(process.env.HOME).toBe(REAL_HOME);
  });

  it('unenrolls every tracked repo so no enrollment leaks across tests', () => {
    const fx = makeFixture();
    const a = fx.makeRepo();
    const b = fx.makeRepo();
    a.enroll();
    b.enroll();
    expect(listEnrolled().length).toBe(2);
    fx.cleanup();
    // After cleanup HOME is restored; a fresh fixture sees an EMPTY registry —
    // proving no enrollment leaked from the prior fixture into a new isolated one.
    const fx2 = makeFixture();
    try {
      expect(listEnrolled()).toEqual([]);
    } finally {
      fx2.cleanup();
    }
  });
});

// ===========================================================================
// withTmpHome — the primary entry point + the real-~/.ashlr untouched proof
// ===========================================================================

describe('H1 testkit — withTmpHome + real-HOME isolation', () => {
  it('runs fn inside a relocated tmp HOME and restores afterward', async () => {
    let observedHome = '';
    const ret = await withTmpHome((fx) => {
      observedHome = resolve(homedir());
      expect(observedHome).toBe(resolve(fx.home));
      return 'result';
    });
    expect(ret).toBe('result');
    // HOME restored after the callback resolves.
    expect(resolve(homedir())).toBe(resolve(REAL_HOME ?? ''));
    expect(observedHome).not.toBe(resolve(REAL_HOME ?? ''));
  });

  it('runs cleanup even when fn throws', async () => {
    const before = process.env.HOME;
    await expect(
      withTmpHome(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(process.env.HOME).toBe(before);
  });

  it('NEVER touches the real ~/.ashlr/enrollment.json (byte-identical before/after)', async () => {
    // Snapshot the REAL enrollment.json (if present) while HOME is the real one.
    const realEnrollment = join(resolve(REAL_HOME ?? ''), '.ashlr', 'enrollment.json');
    const existedBefore = existsSync(realEnrollment);
    const bytesBefore = existedBefore ? readFileSync(realEnrollment) : null;

    // Do a full enroll/kill cycle entirely inside an isolated tmp HOME.
    await withTmpHome((fx) => {
      const repo = fx.makeRepo();
      repo.enroll();
      seedBacklog(fx.home, repo.dir, [{ title: 'work' }]);
      fx.setKill(true);
      fx.setKill(false);
      expect(repo.isEnrolled()).toBe(true);
    });

    // The real enrollment.json is byte-identical (or still absent) afterward.
    const existsAfter = existsSync(realEnrollment);
    expect(existsAfter).toBe(existedBefore);
    if (existedBefore && bytesBefore) {
      expect(readFileSync(realEnrollment).equals(bytesBefore)).toBe(true);
    }
  });
});

// ===========================================================================
// A standalone-repo lifecycle smoke (no fixture harness) to cover the exported
// makeDisposableRepo path that suites managing their own lifecycle use.
// ===========================================================================

describe('H1 testkit — standalone makeDisposableRepo lifecycle', () => {
  it('creates, mutates, and destroys a repo under a manually relocated HOME', () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ashlr-h1-standalone-'));
    process.env.HOME = home;
    try {
      expect(resolve(homedir())).toBe(resolve(home));
      const repo = makeDisposableRepo({ files: { 'f.txt': 'v\n' } });
      try {
        expect(existsSync(repo.dir)).toBe(true);
        const before = repo.shasumTree();
        repo.writeFile('f.txt', 'v2\n');
        expect(repo.shasumTree()).not.toBe(before);
        expect(repo.gitStatus()).not.toBe(''); // dirty after working-tree edit
      } finally {
        repo.destroy();
        expect(existsSync(repo.dir)).toBe(false);
        // destroy() is idempotent.
        expect(() => repo.destroy()).not.toThrow();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
