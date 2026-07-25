import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_ROOT, '..');
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-m454-agent-skills-challenge.mjs');
const FIXTURE_ROOT = join(TEST_ROOT, 'fixtures', 'm454');
const SYSTEM_GIT = '/usr/bin/git';
const CAN_RUN_POSIX_BOUNDARY_TESTS = process.platform !== 'win32' && existsSync(SYSTEM_GIT);
const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixtureDigests(): string[] {
  return [
    sha256(join(FIXTURE_ROOT, 'agent-skills-ff2df4c.snapshot.json')),
    sha256(join(FIXTURE_ROOT, 'agent-skills-ff2df4c.provenance.json')),
  ];
}

function runGenerator(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [GENERATOR, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!CAN_RUN_POSIX_BOUNDARY_TESTS)('M454 generator execution boundary', () => {
  it('rejects relative and symlinked Git executables before source access', () => {
    const before = fixtureDigests();
    const relative = runGenerator(['git', REPO_ROOT]);
    expect(relative.status).toBe(1);
    expect(relative.stderr).toContain('Git executable must be an absolute path');

    const root = temporaryRoot('ashlr-m454-git-link-');
    const linkedGit = join(root, 'git');
    symlinkSync(SYSTEM_GIT, linkedGit);
    const symlinked = runGenerator([linkedGit, REPO_ROOT]);
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain('Git executable must be a direct regular file');
    expect(fixtureDigests()).toEqual(before);
  });

  it('ignores hostile PATH and rejects worktree-configured promisors before pinned-object reads', () => {
    const before = fixtureDigests();
    const root = temporaryRoot('ashlr-m454-promisor-');
    const repository = join(root, 'repo');
    const fakeBin = join(root, 'bin');
    const marker = join(root, 'fake-git-executed');
    mkdirSync(fakeBin);
    execFileSync(SYSTEM_GIT, ['init', '--quiet', repository]);
    execFileSync(SYSTEM_GIT, ['-C', repository, 'config', '--local', 'extensions.worktreeConfig', 'true']);
    execFileSync(SYSTEM_GIT, [
      '-C', repository, 'config', '--worktree', 'remote.origin.promisor', 'true',
    ]);
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 97\n`, { mode: 0o700 });
    chmodSync(fakeGit, 0o700);

    const result = runGenerator(
      [SYSTEM_GIT, repository],
      { ...process.env, PATH: fakeBin },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('partial/promisor repositories are unsupported');
    expect(existsSync(marker)).toBe(false);
    expect(fixtureDigests()).toEqual(before);
  });

  it('rejects repositories backed by object alternates', () => {
    const before = fixtureDigests();
    const root = temporaryRoot('ashlr-m454-alternates-');
    const repository = join(root, 'repo');
    execFileSync(SYSTEM_GIT, ['init', '--quiet', repository]);
    const info = join(repository, '.git', 'objects', 'info');
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, 'alternates'), `${join(root, 'other-objects')}\n`);

    const result = runGenerator([SYSTEM_GIT, repository]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('object alternates are unsupported');
    expect(fixtureDigests()).toEqual(before);
  });

  it('rejects a lexical output symlink before loading tools or implementations', () => {
    const root = temporaryRoot('ashlr-m454-output-link-');
    const copiedGenerator = join(root, 'scripts', 'generate-m454-agent-skills-challenge.mjs');
    const fixtures = join(root, 'test', 'fixtures');
    const external = join(root, 'external-output');
    mkdirSync(dirname(copiedGenerator), { recursive: true });
    mkdirSync(fixtures, { recursive: true });
    mkdirSync(external);
    copyFileSync(GENERATOR, copiedGenerator);
    symlinkSync(external, join(fixtures, 'm454'));

    const result = spawnSync(process.execPath, [copiedGenerator, SYSTEM_GIT, root], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('output path m454 must be a direct directory');
    expect(existsSync(join(external, 'agent-skills-ff2df4c.snapshot.json'))).toBe(false);
    expect(existsSync(join(external, 'agent-skills-ff2df4c.provenance.json'))).toBe(false);
  });
});
