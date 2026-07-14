import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveGitHubOriginAuthority,
  resolveGitHubOriginAuthorityDetails,
} from '../src/core/git.js';

const repos: string[] = [];

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function makeRepo(fetchUrl?: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'ashlr-m387-origin-'));
  repos.push(repo);
  git(repo, ['init', '--quiet']);
  if (fetchUrl) git(repo, ['remote', 'add', 'origin', fetchUrl]);
  return repo;
}

function addFetchUrl(repo: string, url: string): void {
  git(repo, ['remote', 'set-url', '--add', 'origin', url]);
}

function addPushUrl(repo: string, url: string): void {
  git(repo, ['remote', 'set-url', '--add', '--push', 'origin', url]);
}

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('M387 canonical GitHub origin authority', () => {
  it('normalizes matching HTTPS and SSH fetch and push destinations', () => {
    const repo = makeRepo('https://GitHub.com/Owner/Project.git');
    addFetchUrl(repo, 'git@github.com:owner/project.git');
    addPushUrl(repo, 'ssh://git@github.com/OWNER/PROJECT.git');
    addPushUrl(repo, 'https://github.com/owner/project');

    expect(resolveGitHubOriginAuthority(repo)).toBe('owner/project');
    expect(resolveGitHubOriginAuthorityDetails(repo)).toMatchObject({
      nameWithOwner: 'owner/project',
      pushUrl: 'ssh://git@github.com/OWNER/PROJECT.git',
    });
  });

  it('uses fetch destinations as effective push destinations without pushurl', () => {
    const repo = makeRepo('https://account@github.com/Acme/Service.git');

    expect(resolveGitHubOriginAuthority(repo)).toBe('acme/service');
  });

  it('fails closed when a configured pushurl targets another repository', () => {
    const repo = makeRepo('https://github.com/acme/service.git');
    addPushUrl(repo, 'git@github.com:acme/service.git');
    addPushUrl(repo, 'git@github.com:attacker/service.git');

    expect(resolveGitHubOriginAuthority(repo)).toBeNull();
  });

  it('fails closed when multiple fetch URLs diverge despite a matching pushurl', () => {
    const repo = makeRepo('https://github.com/acme/service.git');
    addFetchUrl(repo, 'git@github.com:acme/other.git');
    addPushUrl(repo, 'git@github.com:acme/service.git');

    expect(resolveGitHubOriginAuthority(repo)).toBeNull();
  });

  it('fails closed when any fetch or push destination is not GitHub', () => {
    const fetchRepo = makeRepo('https://github.com/acme/service.git');
    addFetchUrl(fetchRepo, '/tmp/local-bare-repo');
    expect(resolveGitHubOriginAuthority(fetchRepo)).toBeNull();

    const pushRepo = makeRepo('git@github.com:acme/service.git');
    addPushUrl(pushRepo, 'git@gitlab.com:acme/service.git');
    expect(resolveGitHubOriginAuthority(pushRepo)).toBeNull();
  });

  it.each(['insteadOf', 'pushInsteadOf'])('rejects every url rewrite rule, including %s', (kind) => {
    const repo = makeRepo('https://github.com/acme/service.git');
    git(repo, [
      'config',
      `url.https://github.com/acme/evil.git.${kind}`,
      'https://github.com/acme/service.git',
    ]);

    expect(resolveGitHubOriginAuthority(repo)).toBeNull();
    expect(resolveGitHubOriginAuthorityDetails(repo)).toBeNull();
  });

  it.each([
    'http://github.com/acme/service.git',
    'git://github.com/acme/service.git',
    'https://github.com/acme/service.git?mirror=1',
    'https://github.com/acme/service/extra.git',
    'ssh://owner@github.com/acme/service.git',
    'https://github.com/acme',
  ])('rejects unsupported or malformed URL %s', (url) => {
    expect(resolveGitHubOriginAuthority(makeRepo(url))).toBeNull();
  });

  it('returns null when origin is missing or the path is not a repository', () => {
    expect(resolveGitHubOriginAuthority(makeRepo())).toBeNull();

    const plainDirectory = mkdtempSync(join(tmpdir(), 'ashlr-m387-plain-'));
    repos.push(plainDirectory);
    expect(resolveGitHubOriginAuthority(plainDirectory)).toBeNull();
  });
});
