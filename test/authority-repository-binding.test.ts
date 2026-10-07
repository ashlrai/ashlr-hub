import { describe, expect, it } from 'vitest';

import {
  HUB_REPOSITORY_IDENTITY,
  githubRepositoryFromRemote,
  isHubRepositoryLabel,
  requireHubRepositoryMetadata,
  requireHubRepositoryReference,
} from '../src/core/authority/repository-binding.js';
import { nameWithOwnerFromRemote, originUrlFromConfig } from '../src/core/fleet/repo-identity.js';
import { hubRepositoryEffectRefusal, isHubRepositoryApiPath } from '../src/core/authority/github-repository-admission.js';
import { fetchGithubTransport, readRepoInfo, readPr } from '../src/core/fleet/host-merge.js';
import type { HostMergeDeps, GithubCall } from '../src/core/fleet/host-merge.js';
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


describe('fresh current-name effect admission', () => {
  it('accepts a minimal PR base reference without inventing branch/visibility metadata', () => {
    const { default_branch: _branch, private: _private, visibility: _visibility, ...ref } = metadata();
    expect(requireHubRepositoryReference(identity.legacyName, ref).repositoryId).toBe(identity.repositoryId);
    expect(() => requireHubRepositoryMetadata(identity.legacyName, ref)).toThrow(TypeError);
    expect(() => requireHubRepositoryReference(identity.legacyName, { ...ref, id: identity.repositoryId + 1 })).toThrow(TypeError);
  });

  it.each([identity.legacyName, identity.renamedName])('freshly observes every effect on %s without a reusable pass', async (repo) => {
    const calls: GithubCall[] = [];
    let replacement = false;
    const transport = async (call: GithubCall) => { calls.push(call); return { status: 200, body: { ...metadata(repo), id: replacement ? 1 : identity.repositoryId } }; };
    expect(await hubRepositoryEffectRefusal(repo, transport, 'memory-only')).toBeNull();
    replacement = true;
    expect(await hubRepositoryEffectRefusal(repo, transport, 'memory-only')).toMatchObject({ status: 409 });
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ method: 'GET', path: `/repos/${repo}`, token: 'memory-only' })));
  });

  it('does not probe unrelated repositories or mistake a component namespace for the workbench', async () => {
    const transport = async () => { throw new Error('unexpected contact'); };
    expect(await hubRepositoryEffectRefusal('ashlrai/phantom-secrets', transport, 'memory-only')).toBeNull();
    expect(isHubRepositoryApiPath('/repos/ashlrai/phantom-secrets/check-runs')).toBe(false);
    expect(isHubRepositoryApiPath('/repos/ashlrai/phantom/check-runs')).toBe(true);
  });

  it.each([301, 302, 307, 308])('refuses HTTP %i without following the old-name redirect', async (status) => {
    let options: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => { options = init; return new Response(null, { status, headers: { location: 'https://api.github.com/repos/ashlrai/phantom' } }); }) as typeof fetch;
    expect(await fetchGithubTransport(fetchImpl)({ method: 'POST', path: `/repos/${identity.legacyName}/check-runs`, token: 'memory-only', body: {} })).toMatchObject({ status: 409 });
    expect(options?.redirect).toBe('manual');
  });

  it('rejects an already redirected response even when it reports success', async () => {
    const response = new Response('{}', { status: 200 });
    Object.defineProperty(response, 'redirected', { value: true });
    expect(await fetchGithubTransport((async () => response) as typeof fetch)({ method: 'GET', path: `/repos/${identity.legacyName}`, token: 'memory-only' })).toMatchObject({ status: 409 });
  });

  it('refuses replaced repository metadata and mismatched PR base identity at read admission', async () => {
    const deps = { token: async () => ({ token: 'memory-only', expiresAt: null }), transport: async () => ({ status: 200, body: { ...metadata(), id: 1 } }) } as unknown as HostMergeDeps;
    expect(await readRepoInfo(identity.legacyName, deps)).toBe('Repository metadata does not match the reviewed exact Hub identity.');
    deps.transport = async () => ({ status: 200, body: { number: 1, node_id: 'PR_1', state: 'open', head: { sha: 'a'.repeat(40), ref: 'work' }, base: { ref: 'master', repo: metadata(identity.renamedName) } } });
    expect(await readPr(identity.legacyName, 1, deps)).toBe('GitHub returned a malformed pull request');
  });
});
