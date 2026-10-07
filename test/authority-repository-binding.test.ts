import { describe, expect, it } from 'vitest';

import {
  HUB_REPOSITORY_IDENTITY,
  githubRepositoryFromRemote,
  isHubRepositoryLabel,
  requireHubRepositoryMetadata,
} from '../src/core/authority/repository-binding.js';
import { nameWithOwnerFromRemote, originUrlFromConfig } from '../src/core/fleet/repo-identity.js';
import { isCloudSelfRepo } from '../src/core/cloud/pr-actions.js';

const identity = HUB_REPOSITORY_IDENTITY;
const metadata = (name = identity.legacyName) => ({
  id: identity.repositoryId,
  node_id: identity.repositoryNodeId,
  full_name: name,
  owner: { id: identity.ownerId, login: identity.ownerLogin },
  default_branch: identity.defaultBranch,
  private: false,
  visibility: 'public',
});

describe('reviewed same-repository identity', () => {
  it.each([identity.legacyName, identity.renamedName])('binds fresh exact metadata for %s', (name) => {
    const binding = requireHubRepositoryMetadata(name, metadata(name));
    expect(binding).toEqual({ nameWithOwner: name, repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw', ownerId: 258113726, ownerLogin: 'ashlrai', defaultBranch: 'master' });
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it('refuses GitHub redirect metadata in both directions rather than transferring a grant', () => {
    expect(() => requireHubRepositoryMetadata(identity.legacyName, metadata(identity.renamedName))).toThrow(TypeError);
    expect(() => requireHubRepositoryMetadata(identity.renamedName, metadata())).toThrow(TypeError);
  });

  it.each([
    { id: 1263526320 }, { id: '1263526319' }, { node_id: 'R_kgDOother' },
    { owner: { id: 258113727, login: 'ashlrai' } },
    { owner: { id: 258113726, login: 'someone' } }, { owner: null },
    { full_name: 'someone/phantom' }, { full_name: 'ashlrai/phantom-secrets' },
    { full_name: 'ASHLRAI/ASHLR-HUB' }, { default_branch: 'main' },
    { private: true }, { visibility: 'private' },
  ])('refuses a replaced/transferred/drifted repository: %j', (drift) => {
    expect(() => requireHubRepositoryMetadata(identity.legacyName, { ...metadata(), ...drift })).toThrow(TypeError);
  });

  it.each([null, [], {}, 'repository'])('fails closed on malformed metadata: %j', (raw) => {
    expect(() => requireHubRepositoryMetadata(identity.legacyName, raw)).toThrow(TypeError);
  });

  it('does not authorize an unrelated requested label even with the real numeric tuple', () => {
    expect(() => requireHubRepositoryMetadata('someone/phantom', metadata('someone/phantom'))).toThrow(TypeError);
  });

  it.each([identity.legacyName, identity.renamedName, 'ASHLRAI/PHANTOM'])('conservatively protects self label %s', (name) => {
    expect(isHubRepositoryLabel(name)).toBe(true);
    expect(isCloudSelfRepo(name, null)).toBe(true);
  });

  it.each(['someone/phantom', 'ashlrai/phantom-secrets', 'ashlrai/phantom-fork', 'ashlrai/phantom/', ' ashlrai/phantom'])('does not classify another label as self: %s', (name) => {
    expect(isHubRepositoryLabel(name)).toBe(false);
    expect(isCloudSelfRepo(name, null)).toBe(false);
  });
});

describe('strict GitHub remote hints', () => {
  it.each(['[remote  "origin"]', '[remote\t"origin"]'])('preserves supported origin header whitespace: %s', (header) => {
    const origin = originUrlFromConfig(`${header}\nurl = git@github.com:ashlrai/phantom\n`);
    expect(origin).toBe('git@github.com:ashlrai/phantom');
    expect(nameWithOwnerFromRemote(origin!)).toBe('ashlrai/phantom');
  });

  it.each([
    ['https://github.com/ashlrai/ashlr-hub.git', 'ashlrai/ashlr-hub'],
    ['ssh://git@github.com/ashlrai/phantom.git', 'ashlrai/phantom'],
    ['git@github.com:ashlrai/phantom', 'ashlrai/phantom'],
    ['https://GITHUB.COM/SomeOwner/a-b.c_1.git/', 'SomeOwner/a-b.c_1'],
    [' git@github.com:another/project.git\n', 'another/project'],
  ])('reads supported remote %s', (remote, name) => {
    expect(githubRepositoryFromRemote(remote)).toBe(name);
    expect(nameWithOwnerFromRemote(remote)).toBe(name);
  });

  it.each([
    'https://evilgithub.com/ashlrai/phantom.git',
    'https://github.com.evil/ashlrai/phantom.git',
    'https://evil.test/github.com/ashlrai/phantom.git',
    'https://user:password@github.com/ashlrai/phantom',
    'https://git@github.com/ashlrai/phantom',
    'ssh://root@github.com/ashlrai/phantom',
    'https://github.com:443/ashlrai/phantom',
    'http://github.com/ashlrai/phantom', 'git://github.com/ashlrai/phantom',
    'https://github.com/ashlrai/phantom?x=y', 'https://github.com/ashlrai/phantom#main',
    'https://github.com/ashlrai/phantom/extra', 'https://github.com/ashlrai/phantom//',
    'https://github.com/ashlrai/%70hantom', 'https://github.com/ashlrai/..',
    'https://github.com/ashlrai/.', 'https://github.com/ashlrai/phantom\nignored',
  ])('refuses deceptive or decorated origin %s', (remote) => {
    expect(githubRepositoryFromRemote(remote)).toBeNull();
    expect(nameWithOwnerFromRemote(remote)).toBeNull();
  });
});
