import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, renameSync, linkSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as privateStorage from '../src/core/util/private-storage.js';
import * as preferences from '../src/core/verse/preferences.js';
import { pathToFileURL } from 'node:url';
import { useTmpHome, makePolicy } from './helpers/leader-310b-fakes.js';
import { HUB_REPOSITORY_IDENTITY } from '../src/core/authority/repository-binding.js';
import { enqueueTask, readTaskQueue, recordTaskDispatch, taskQueuePath } from '../src/core/fleet/task-source.js';
import { configureReleaseArticles, importProposedRelease, publicArticleDraft, readReleaseArticles, releaseArticlePaths,
  RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO, defaultReleaseArticlesDeps, syncReleaseArticles, type ReleaseArticlesDeps } from '../src/core/release-articles.js';
import { parseProposedRelease, RELEASE_CI_JOBS, releaseRequiredSteps, releaseRequiredLabels, verifyPublishedRelease, verifyLatestWorkbenchRelease, publicWorkbenchRelease, defaultReleasePublicReader, type ReleasePublicReader } from '../src/core/release-public-facts.js';
import { runReleaseArticlesCli } from '../src/cli/release-articles.js';

const home = useTmpHome();
const NOW = Date.parse('2026-10-07T06:00:00Z');
const REPO = 'ashlrai/ashlr-hub';
const SOURCE = 'a'.repeat(40); const MERGED = 'b'.repeat(40); const TREE = 'c'.repeat(40);
const proposed = { v: 1, repository: REPO, version: '3.24.3' } as const;
const repo = { full_name: REPO, id: HUB_REPOSITORY_IDENTITY.repositoryId, node_id: HUB_REPOSITORY_IDENTITY.repositoryNodeId,
  owner: { id: HUB_REPOSITORY_IDENTITY.ownerId, login: 'ashlrai' }, default_branch: 'master', private: false, visibility: 'public' };
const release = { id: 19, tag_name: 'v3.24.3', draft: false, prerelease: false, published_at: '2026-10-07T03:50:00Z',
  html_url: `https://github.com/${REPO}/releases/tag/v3.24.3`, assets: [{ name: 'ashlr-hub-3.24.3.tgz', size: 30,
    digest: `sha256:${'d'.repeat(64)}`, state: 'uploaded', browser_download_url: `https://github.com/${REPO}/releases/download/v3.24.3/ashlr-hub-3.24.3.tgz` }] };
const ref = { ref: 'refs/tags/v3.24.3', object: { type: 'commit', sha: MERGED } };
const pkg = { name: '@ashlr/hub', version: '3.24.3', dist: { tarball: 'https://registry.npmjs.org/@ashlr/hub/-/hub-3.24.3.tgz', integrity: `sha512-${'A'.repeat(86)}==` } };
function sourcePackageEvidence(bytes: Buffer) {
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { tree: { sha: TREE, truncated: false, tree: [{ path: 'package.json', mode: '100644', type: 'blob', sha, size: bytes.length }] },
    blob: { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64').match(/.{1,60}/g)!.join('\n') + '\n' } };
}
function fixtureReader(change?: (endpoint: string, value: unknown) => unknown,
  options: { repository?: typeof REPO | 'ashlrai/phantom'; packageName?: '@ashlr/hub' | '@ashlr/phantom'; packageBytes?: Buffer } = {}): ReleasePublicReader {
  const repository = options.repository ?? REPO; const packageName = options.packageName ?? '@ashlr/hub';
  const source = sourcePackageEvidence(options.packageBytes ?? Buffer.from(JSON.stringify({ name: packageName, version: proposed.version })));
  const boundRepo = { ...repo, full_name: repository };
  const published = { ...release, html_url: release.html_url.replace(REPO, repository),
    assets: release.assets.map(asset => ({ ...asset, browser_download_url: asset.browser_download_url.replace(REPO, repository) })) };
  const github = vi.fn(async (endpoint: string): Promise<unknown> => {
    let value: unknown;
    if (endpoint === `repos/${repository}`) value = boundRepo;
    else if (endpoint.endsWith('/releases/latest') || endpoint.endsWith('/releases/tags/v3.24.3')) value = published;
    else if (endpoint.endsWith('/git/ref/tags/v3.24.3')) value = ref;
    else if (endpoint.endsWith(`/git/commits/${MERGED}`)) value = { sha: MERGED, tree: { sha: TREE }, parents: [{ sha: 'f'.repeat(40) }, { sha: SOURCE }] };
    else if (endpoint.endsWith(`/git/commits/${SOURCE}`)) value = { sha: SOURCE, tree: { sha: TREE } };
    else if (endpoint === `repos/${repository}/git/trees/${TREE}`) value = source.tree;
    else if (endpoint === `repos/${repository}/git/blobs/${source.blob.sha}`) value = source.blob;
    else if (endpoint.includes('/actions/workflows/')) value = { total_count: 1, workflow_runs: [{ id: endpoint.includes('dependency-audit') ? 21 : 20, run_attempt: 1, head_sha: SOURCE }] };
    else if (endpoint.includes('/jobs?')) {
      const audit = endpoint.includes('/runs/21/'); const names = audit ? ['Dependency audit (root + Raycast)'] : RELEASE_CI_JOBS;
      value = { total_count: names.length, jobs: names.map((name, index) => ({ id: 100 + index, name, run_id: audit ? 21 : 20,
        head_sha: SOURCE, status: 'completed', conclusion: 'success', labels: ['ubuntu-latest', 'macos-15', 'windows-latest', 'windows-2022', 'macos-latest'],
        steps: releaseRequiredSteps(name).map((step) => ({ name: step, status: 'completed', conclusion: 'success' })) })) };
    } else if (/\/actions\/runs\/(20|21)(?:\/attempts\/1)?$/.test(endpoint)) value = { id: /\/runs\/21(?:\/|$)/.test(endpoint) ? 21 : 20,
      run_attempt: 1, head_sha: SOURCE, repository: boundRepo, path: /\/runs\/21(?:\/|$)/.test(endpoint) ? '.github/workflows/dependency-audit.yml' : '.github/workflows/ci.yml',
      status: 'completed', conclusion: 'success', event: 'pull_request' };
    else throw new Error(`Unexpected fixture endpoint ${endpoint}`);
    return change ? change(endpoint, structuredClone(value)) : structuredClone(value);
  });
  return { github, npm: vi.fn(async (_version, _signal, selectedName = '@ashlr/hub') => {
    expect(selectedName).toBe(packageName);
    return { ...structuredClone(pkg), name: packageName,
      dist: { ...pkg.dist, tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split('/')[1]}-${proposed.version}.tgz` } };
  }) };
}
function deps(reader = fixtureReader()): ReleaseArticlesDeps {
  return { now: () => NOW, reader, policy: () => makePolicy({ repos: [{ ...makePolicy().repos[0]!, nameWithOwner: RELEASE_ARTICLE_REPO }] }),
    stopped: () => false, stopEpoch: () => 'unchanged', enrolled: () => [RELEASE_ARTICLE_REPO], queue: () => readTaskQueue(),
    enqueue: vi.fn((input) => enqueueTask(input, { nowMs: NOW })), production: vi.fn(async () => false), teaserProduction: vi.fn(async () => false) };
}
beforeEach(() => home.setup()); afterEach(() => { vi.restoreAllMocks(); home.teardown(); });

describe('fresh public facts are data, not saved release authority', () => {
  it('projects only a fully verified canonical release and brackets latest discovery', async () => {
    const reader = fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    const record = await verifyLatestWorkbenchRelease(reader, NOW);
    expect(record).toMatchObject({ product: 'workbench', version: '3.24.3', packageName: '@ashlr/phantom',
      releaseUrl: 'https://github.com/ashlrai/phantom/releases/tag/v3.24.3', installCommand: 'npm install -g @ashlr/phantom@3.24.3', macDownloadUrl: null });
    expect(record.factsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((reader.github as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => path.endsWith('/releases/latest'))).toHaveLength(2);
    expect(() => publicWorkbenchRelease({ ...record } as never)).toThrow();
  });
  it('projects the published seven-asset Mac archive through the full latest verifier', async () => {
    const names = [`Phantom_${proposed.version}_aarch64.app.tar.gz`, `Phantom_${proposed.version}_aarch64.app.tar.gz.sig`,
      `ashlr-phantom-${proposed.version}.tgz`, `ashlr-phantom-${proposed.version}.tgz.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
    const reader = fixtureReader((endpoint, value) => endpoint.includes('/releases/') ? {
      ...(value as object), assets: names.map(name => ({ name, size: 30, digest: `sha256:${'d'.repeat(64)}`,
        state: 'uploaded', browser_download_url: `https://github.com/ashlrai/phantom/releases/download/v${proposed.version}/${name}` })),
    } : value, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    const record = await verifyLatestWorkbenchRelease(reader, NOW);
    expect(record.macDownloadUrl).toBe(`https://github.com/ashlrai/phantom/releases/download/v${proposed.version}/${names[0]}`);
    expect(record.installCommand).toBe(`npm install -g @ashlr/phantom@${proposed.version}`);
    expect((reader.github as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => path.endsWith('/releases/latest'))).toHaveLength(2);
  });
  it('retains a qualified historical DMG preference and refuses unqualified or wrong-version Mac assets', async () => {
    const facts = await verifyPublishedRelease({ ...proposed, repository: 'ashlrai/phantom' },
      fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' }), NOW);
    const archive = { name: `Phantom_${proposed.version}_aarch64.app.tar.gz`, bytes: 30, digest: `sha256:${'d'.repeat(64)}` };
    const dmg = { ...archive, name: `Phantom_${proposed.version}_aarch64.dmg` };
    expect(publicWorkbenchRelease({ ...facts, assets: [archive, dmg] }).macDownloadUrl).toBe(`https://github.com/ashlrai/phantom/releases/download/v${proposed.version}/${dmg.name}`);
    expect(publicWorkbenchRelease({ ...facts, assets: [{ ...dmg, digest: null }, archive] }).macDownloadUrl).toBe(`https://github.com/ashlrai/phantom/releases/download/v${proposed.version}/${archive.name}`);
    expect(publicWorkbenchRelease({ ...facts, assets: [{ ...archive, bytes: 0 }] }).macDownloadUrl).toBeNull();
    expect(publicWorkbenchRelease({ ...facts, assets: [{ ...archive, digest: null }] }).macDownloadUrl).toBeNull();
    expect(publicWorkbenchRelease({ ...facts, assets: [{ ...archive, digest: 'sha256:invalid' }] }).macDownloadUrl).toBeNull();
    expect(publicWorkbenchRelease({ ...facts, assets: [{ ...archive, name: 'Phantom_3.24.4_aarch64.app.tar.gz' }] }).macDownloadUrl).toBeNull();
  });
  it('withholds public metadata if latest moves or registry verification fails', async () => {
    let latest = 0;
    const reader = fixtureReader((endpoint, value) => endpoint.endsWith('/releases/latest') && ++latest === 2
      ? { ...(value as object), tag_name: 'v3.24.4' } : value, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    await expect(verifyLatestWorkbenchRelease(reader, NOW)).rejects.toThrow('changed during verification');
    const unavailable = fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    unavailable.npm = async () => { throw new Error('Registry visibility unavailable'); };
    await expect(verifyLatestWorkbenchRelease(unavailable, NOW)).rejects.toThrow('Registry visibility unavailable');
  });
  it('catches replacement of the same latest tag or its asset set after full verification', async () => {
    for (const mutation of [{ id: 999 }, { assets: [] }]) {
      let latest = 0;
      const reader = fixtureReader((endpoint, value) => endpoint.endsWith('/releases/latest') && ++latest === 2
        ? { ...(value as object), ...mutation } : value, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
      await expect(verifyLatestWorkbenchRelease(reader, NOW)).rejects.toThrow('changed during verification');
    }
  });
  it('exports metadata through the existing CLI without enabling automation or enqueueing work', async () => {
    const ports = deps(); ports.reader = fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    const print = vi.fn();
    expect(await runReleaseArticlesCli(['metadata', '--json'], ports, print)).toBe(0);
    expect(JSON.parse(print.mock.calls[0]![0])).toMatchObject({ product: 'workbench', version: '3.24.3' });
    expect(readReleaseArticles().enabled).toBe(false); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('accepts only a minimal proposed version and refuses the operational index', () => {
    expect(parseProposedRelease(proposed)).toEqual(proposed);
    for (const input of [{ ...proposed, evidence: { npm: { path: '/private/receipt' } } }, { ...proposed, success: true },
      { ...proposed, repository: 'ashlrai/phantom-lookalike' }, { ...proposed, version: '../secret' }]) expect(() => parseProposedRelease(input)).toThrow();
  });
  it('freshly binds exact numeric repo, tag, identical candidate tree, all 15 jobs, Audit and npm integrity', async () => {
    const reader = fixtureReader(); const facts = await verifyPublishedRelease(proposed, reader, NOW);
    expect(facts).toMatchObject({ sourceSha: SOURCE, mergedSha: MERGED, treeSha: TREE, ci: { id: 20, attempt: 1 }, audit: { id: 21, attempt: 1 }, packageIntegrity: pkg.dist.integrity });
    expect(RELEASE_CI_JOBS).toHaveLength(15); expect(reader.npm).toHaveBeenCalledWith('3.24.3', undefined, '@ashlr/hub');
    expect((reader.github as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => path === `repos/${REPO}`)).toHaveLength(2);
  });
  it.each(['numeric', 'redirect', 'tree', 'ci-failed', 'audit-failed', 'job-missing', 'step-skipped', 'runner', 'tag-race', 'release-race', 'rerun-race'])('withholds facts for %s', async (kind) => {
    let refs = 0; let releases = 0;
    const reader = fixtureReader((endpoint, raw) => {
      const value = raw as Record<string, unknown>;
      if (endpoint === `repos/${REPO}` && kind === 'numeric') value['id'] = 123;
      if (endpoint === `repos/${REPO}` && kind === 'redirect') value['full_name'] = 'ashlrai/phantom';
      if (endpoint.endsWith(`/git/commits/${SOURCE}`) && kind === 'tree') value['tree'] = { sha: 'e'.repeat(40) };
      if (endpoint.endsWith('/attempts/1') && endpoint.includes(kind === 'audit-failed' ? '/runs/21/' : '/runs/20/') && ['ci-failed', 'audit-failed'].includes(kind)) value['conclusion'] = 'failure';
      if (endpoint.includes('/runs/20/') && endpoint.includes('/jobs?')) {
        const jobs = value['jobs'] as Record<string, unknown>[];
        if (kind === 'job-missing') jobs.pop();
        if (kind === 'step-skipped') (jobs[0]!['steps'] as Record<string, unknown>[])[0]!['conclusion'] = 'skipped';
        if (kind === 'runner') jobs[0]!['labels'] = ['self-hosted'];
      }
      if (endpoint.endsWith('/git/ref/tags/v3.24.3') && ++refs === 2 && kind === 'tag-race') value['object'] = { type: 'commit', sha: 'e'.repeat(40) };
      if (endpoint.endsWith('/releases/tags/v3.24.3') && ++releases === 2 && kind === 'release-race') value['draft'] = true;
      if (endpoint.endsWith('/actions/runs/20') && kind === 'rerun-race') value['run_attempt'] = 2;
      return value;
    });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow();
  });
  it('refuses npm version/integrity and arbitrary download hosts', async () => {
    for (const dist of [{ ...pkg.dist, integrity: null }, { ...pkg.dist, tarball: 'https://example.com/package.tgz' }]) {
      const reader = fixtureReader(); reader.npm = async () => ({ ...pkg, dist });
      await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow();
    }
  });
  it('public projection never copies provider responses, operational metadata or observation timestamps into stable identity', async () => {
    const reader = fixtureReader((endpoint, raw) => ({ ...(raw as object), ...(endpoint.endsWith('/releases/tags/v3.24.3') ? { body: '/Users/private token=SECRET' } : {}) }));
    const facts = await verifyPublishedRelease(proposed, reader, NOW);
    const draft = publicArticleDraft(facts); expect(JSON.stringify(draft)).not.toMatch(/SECRET|\/Users|observedAt|installed|account/);
    expect(publicArticleDraft({ ...facts, observedAt: new Date(NOW + 1000).toISOString() }).factsDigest).toBe(draft.factsDigest);
  });
  it('production adapter refuses caller-selected hosts before any transport', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(defaultReleasePublicReader().github('repos/other/repo/releases/latest')).rejects.toThrow();
    await expect(defaultReleasePublicReader().npm('../secret')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('production npm reader consumes the closed official URL with redirect refusal and never fetches archive bytes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(pkg), { status: 200 }));
    expect(await defaultReleasePublicReader().npm('3.24.3')).toEqual(pkg);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe('https://registry.npmjs.org/@ashlr%2fhub/3.24.3');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { 'Cache-Control': 'no-cache' } });
  });
});

describe('source-bound release package identity', () => {
  it.each([
    [REPO, '@ashlr/hub'], ['ashlrai/phantom', '@ashlr/hub'], ['ashlrai/phantom', '@ashlr/phantom'],
  ] as const)('selects %s history from exact source package %s, never the repository label', async (repository, packageName) => {
    const bytes = Buffer.from(JSON.stringify({ name: packageName, version: proposed.version, description: 'Phantom · 工程',
      repository: { url: 'https://github.com/ashlrai/ashlr-hub' }, privatePrompt: 'SECRET' }));
    const reader = fixtureReader(undefined, { repository, packageName, packageBytes: bytes });
    const facts = await verifyPublishedRelease({ ...proposed, repository }, reader, NOW);
    const evidence = sourcePackageEvidence(bytes);
    expect(reader.github).toHaveBeenCalledWith(`repos/${repository}/git/trees/${TREE}`, undefined);
    expect(reader.github).toHaveBeenCalledWith(`repos/${repository}/git/blobs/${evidence.blob.sha}`, undefined);
    expect((reader.github as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => path.includes('/git/trees/'))).toHaveLength(1);
    expect((reader.github as ReturnType<typeof vi.fn>).mock.calls.some(([path]) => path.includes('recursive'))).toBe(false);
    expect(reader.npm).toHaveBeenCalledExactlyOnceWith(proposed.version, undefined, packageName);
    expect(Object.hasOwn(facts, 'packageName')).toBe(packageName === '@ashlr/phantom');
    expect(publicArticleDraft(facts).sources).toContain(`https://www.npmjs.com/package/${packageName}/v/${proposed.version}`);
    expect(JSON.stringify(facts)).not.toMatch(/SECRET|description|repository.*url/);
    expect(publicArticleDraft({ ...facts, observedAt: new Date(NOW + 1000).toISOString() }).factsDigest).toBe(publicArticleDraft(facts).factsDigest);
  });
  it('retains exact legacy fact bytes and digest without a new package property', async () => {
    const facts = await verifyPublishedRelease(proposed, fixtureReader(), NOW);
    const legacy = { ...proposed, sourceSha: SOURCE, mergedSha: MERGED, treeSha: TREE, releaseId: 19,
      publishedAt: '2026-10-07T03:50:00.000Z', observedAt: new Date(NOW).toISOString(),
      ci: { id: 20, attempt: 1 }, audit: { id: 21, attempt: 1 }, packageIntegrity: pkg.dist.integrity,
      assets: [{ name: release.assets[0]!.name, bytes: 30, digest: release.assets[0]!.digest }] };
    expect(JSON.stringify(facts)).toBe(JSON.stringify(legacy));
    expect(publicArticleDraft(facts)).toEqual(publicArticleDraft(legacy));
    expect(publicArticleDraft(facts).factsDigest).toBe('743a721867c1e7bb1368c11d0cb05859920ce22aebe348f40b3d08e812e7c17b');
    expect(Object.hasOwn(publicArticleDraft(facts).facts, 'packageName')).toBe(false);
  });
  it('refuses canonical source under the legacy repository before npm', async () => {
    const reader = fixtureReader(undefined, { packageName: '@ashlr/phantom' });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow('canonical release repository');
    expect(reader.npm).not.toHaveBeenCalled();
  });
  it.each(['wrong-tree', 'truncated', 'not-array', 'too-many', 'missing', 'duplicate-package', 'duplicate-root',
    'nested-path', 'symlink', 'submodule', 'directory', 'unknown-mode', 'array-mode', 'zero-size', 'fraction-size', 'oversize', 'bad-sha'])('refuses %s source trees before npm', async kind => {
    const reader = fixtureReader((endpoint, raw) => {
      if (!endpoint.includes('/git/trees/')) return raw;
      const value = raw as { sha: string; truncated: boolean; tree: Record<string, unknown>[] };
      const entry = value.tree[0]!;
      switch (kind) {
        case 'wrong-tree': value.sha = SOURCE; break;
        case 'truncated': value.truncated = true; break;
        case 'not-array': return { ...value, tree: {} };
        case 'too-many': value.tree = Array.from({ length: 10_001 }, (_, i) => ({ path: `file-${i}` })); break;
        case 'missing': value.tree = []; break;
        case 'duplicate-package': value.tree.push({ ...entry }); break;
        case 'duplicate-root': value.tree.push({ path: 'src' }, { path: 'src' }); break;
        case 'nested-path': value.tree.push({ path: 'src/package.json' }); break;
        case 'symlink': entry['mode'] = '120000'; break;
        case 'submodule': entry['type'] = 'commit'; entry['mode'] = '160000'; break;
        case 'directory': entry['type'] = 'tree'; break;
        case 'unknown-mode': entry['mode'] = '100600'; break;
        case 'array-mode': entry['mode'] = ['100644']; break;
        case 'zero-size': entry['size'] = 0; break;
        case 'fraction-size': entry['size'] = 1.5; break;
        case 'oversize': entry['size'] = 1024 * 1024 + 1; break;
        case 'bad-sha': entry['sha'] = '../other'; break;
      }
      return value;
    });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow(); expect(reader.npm).not.toHaveBeenCalled();
  });
  it.each(['wrong-sha', 'encoding', 'size', 'space', 'tab', 'alphabet', 'partial', 'padding', 'noncanonical',
    'content-bound', 'raw-size', 'raw-hash'])('refuses %s blob evidence before npm', async kind => {
    const reader = fixtureReader((endpoint, raw) => {
      if (!endpoint.includes('/git/blobs/')) return raw;
      const value = raw as { sha: string; encoding: string; size: number; content: string };
      switch (kind) {
        case 'wrong-sha': value.sha = SOURCE; break;
        case 'encoding': value.encoding = 'utf-8'; break;
        case 'size': value.size++; break;
        case 'space': value.content += ' '; break;
        case 'tab': value.content += '\t'; break;
        case 'alphabet': value.content = '!!!!'; break;
        case 'partial': value.content = 'AAA'; break;
        case 'padding': value.content = 'AAAA===='; break;
        case 'noncanonical': value.content = 'AB=='; break;
        case 'content-bound': value.content = 'A'.repeat(2 * 1024 * 1024 + 1); break;
        case 'raw-size': value.content = Buffer.from('{}').toString('base64'); break;
        case 'raw-hash': value.content = Buffer.from('x'.repeat(value.size)).toString('base64'); break;
      }
      return value;
    });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow(); expect(reader.npm).not.toHaveBeenCalled();
  });
  it.each([
    Buffer.from([0xff]), Buffer.from('{bad json'), Buffer.from('[]'),
    Buffer.from(JSON.stringify({ name: '@ashlr/hub-lookalike', version: proposed.version })),
    Buffer.from(JSON.stringify({ name: 'constructor', version: proposed.version })),
    Buffer.from(JSON.stringify({ name: '@ashlr/hub', version: '3.24.4' })),
  ])('refuses hash-valid invalid source package %j without npm or code execution', async packageBytes => {
    const reader = fixtureReader(undefined, { packageBytes });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow(); expect(reader.npm).not.toHaveBeenCalled();
  });
  it('rejects noncanonical padding bits even when decoded bytes, length and Git hash match', async () => {
    const reader = fixtureReader((endpoint, raw) => endpoint.includes('/git/blobs/') ? { ...(raw as object), content: 'MB==' } : raw,
      { packageBytes: Buffer.from('0') });
    await expect(verifyPublishedRelease(proposed, reader, NOW)).rejects.toThrow('package Base64');
    expect(reader.npm).not.toHaveBeenCalled();
  });
  it('accepts documented CRLF wrapping and executable regular package mode', async () => {
    const reader = fixtureReader((endpoint, raw) => {
      const value = raw as Record<string, unknown>;
      if (endpoint.includes('/git/trees/')) (value['tree'] as Record<string, unknown>[])[0]!['mode'] = '100755';
      if (endpoint.includes('/git/blobs/')) value['content'] = (value['content'] as string).replaceAll('\n', '\r\n');
      return value;
    });
    expect((await verifyPublishedRelease(proposed, reader, NOW)).packageIntegrity).toBe(pkg.dist.integrity);
  });
  it('draft projection refuses unknown/mixed package identities', async () => {
    const facts = await verifyPublishedRelease(proposed, fixtureReader(), NOW);
    for (const packageName of ['@ashlr/hub', '@ashlr/other', null, {}, ['@ashlr/phantom']]) {
      expect(() => publicArticleDraft({ ...facts, packageName } as never)).toThrow();
    }
    expect(() => publicArticleDraft({ ...facts, packageName: '@ashlr/phantom' })).toThrow();
  });
  it('the production npm adapter supports the finite canonical argument and refuses unknown names before fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await defaultReleasePublicReader().npm(proposed.version, undefined, '@ashlr/phantom');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://registry.npmjs.org/@ashlr%2fphantom/3.24.3', expect.objectContaining({ redirect: 'error' }));
    fetcher.mockClear();
    for (const name of ['constructor', '@ashlr/hub/../../other', null, {}]) {
      await expect(defaultReleasePublicReader().npm(proposed.version, undefined, name as never)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fresh canonical source unavailability retains durable fences without replay or false publication', async () => {
    configureReleaseArticles(true, 'ashlrai/phantom');
    const ports = deps(fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' }));
    const first = await syncReleaseArticles(ports); expect(first.records[0]!.state).toBe('queued');
    ports.production = async () => true;
    const published = await syncReleaseArticles(ports); expect(published.records[0]!.state).toBe('published');
    ports.reader = fixtureReader((endpoint, raw) => endpoint.includes('/git/trees/') ? { ...(raw as object), truncated: true } : raw,
      { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' });
    for (let pass = 0; pass < 2; pass++) {
      const row = (await syncReleaseArticles(ports)).records[0]!;
      expect(row.state).toBe('pending-public-verification'); expect(row.attempted).toBe(true);
      expect(row.taskId).toBe(first.records[0]!.taskId); expect(row.digest).toBe(first.records[0]!.digest);
      expect(row.publishedAt).toBe(published.records[0]!.publishedAt);
    }
    expect(ports.reader.npm).not.toHaveBeenCalled(); expect(ports.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('durable article maintenance uses the normal task lane', () => {
  it('fresh core defaults are canonical without changing saved legacy settings or history', async () => {
    const ports = deps();
    expect(readReleaseArticles()).toEqual({ v: 1, enabled: false, repository: 'ashlrai/phantom', records: [], observation: null });
    expect(existsSync(releaseArticlePaths().directory)).toBe(false);
    expect(configureReleaseArticles(true).repository).toBe('ashlrai/phantom');
    expect(ports.reader.github).not.toHaveBeenCalled(); expect(ports.reader.npm).not.toHaveBeenCalled(); expect(ports.enqueue).not.toHaveBeenCalled();
    configureReleaseArticles(true, REPO);
    await syncReleaseArticles(ports);
    const saved = readReleaseArticles(); const bytes = readFileSync(releaseArticlePaths().file);
    expect(saved.repository).toBe(REPO); expect(saved.records[0]!.proposed).toEqual(proposed);
    expect(saved.records[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readReleaseArticles()).toEqual(saved); expect(readFileSync(releaseArticlePaths().file)).toEqual(bytes);
    const disabled = configureReleaseArticles(false);
    expect(disabled.repository).toBe(REPO); expect(disabled.records).toEqual(saved.records); expect(disabled.observation).toEqual(saved.observation);
  });
  it('CLI omitted enable uses the canonical default and verifies that exact release on sync', async () => {
    const ports = deps(fixtureReader(undefined, { repository: 'ashlrai/phantom', packageName: '@ashlr/phantom' }));
    const out: string[] = []; const print = (text: string): void => { out.push(text); };
    expect(await runReleaseArticlesCli(['status', '--json'], ports, print)).toBe(0);
    expect(JSON.parse(out.at(-1)!).repository).toBe('ashlrai/phantom'); expect(existsSync(releaseArticlePaths().directory)).toBe(false);
    expect(await runReleaseArticlesCli(['enable'], ports, print)).toBe(0);
    expect(readReleaseArticles()).toMatchObject({ enabled: true, repository: 'ashlrai/phantom', records: [] });
    expect(ports.reader.github).not.toHaveBeenCalled(); expect(ports.reader.npm).not.toHaveBeenCalled(); expect(ports.enqueue).not.toHaveBeenCalled();
    expect(await runReleaseArticlesCli(['sync', proposed.version, '--json'], ports, print)).toBe(0);
    expect(JSON.parse(out.at(-1)!).records[0]).toMatchObject({ state: 'queued', proposed: { ...proposed, repository: 'ashlrai/phantom' } });
    expect(ports.reader.npm).toHaveBeenCalledWith(proposed.version, undefined, '@ashlr/phantom');
    expect(ports.reader.github).toHaveBeenCalledWith('repos/ashlrai/phantom', undefined);
  });
  it('missing/disabled state is read-only and probes nothing', async () => {
    const ports = deps(); expect(readReleaseArticles().enabled).toBe(false);
    await syncReleaseArticles(ports); expect(ports.reader.github).not.toHaveBeenCalled(); expect(existsSync(releaseArticlePaths().directory)).toBe(false);
  });
  it('enable is not a grant; missing company scope yields a visible draft', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.policy = () => null;
    const state = await syncReleaseArticles(ports); expect(state.records[0]!.state).toBe('blocked-repository-authority'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('queues a bounded public-data brief using the actual existing private queue', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const state = await syncReleaseArticles(ports);
    expect(state.records[0]!.state).toBe('queued'); const queue = readTaskQueue(); expect(queue.ok).toBe(true);
    if (!queue.ok) throw new Error('queue'); expect(queue.tasks).toHaveLength(1); expect(queue.tasks[0]!.repo).toBe(RELEASE_ARTICLE_REPO);
    expect(queue.tasks[0]!.detail.length).toBeLessThan(4000); expect(queue.tasks[0]!.detail).toContain('Task completion is not proof');
    expect(queue.tasks[0]!.detail).not.toContain('/private'); expect(state.records[0]!.taskId).toBe(queue.tasks[0]!.id);
  });
  it('freshly observes again without duplicating active, done or pruned tasks', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const first = await syncReleaseArticles(ports);
    await syncReleaseArticles(ports); expect(ports.enqueue).toHaveBeenCalledTimes(1);
    recordTaskDispatch(first.records[0]!.taskId!, { kind: 'produced', proposalId: 'article-proposal' }, { nowMs: NOW });
    const completedQueue = readTaskQueue(); expect(completedQueue.ok && completedQueue.tasks[0]!.status).toBe('done');
    const afterDone = await syncReleaseArticles(ports); expect(afterDone.records[0]!.state).toBe('awaiting-production');
    writeFileSync(taskQueuePath(), JSON.stringify({ v: 1, tasks: [], updatedAt: new Date(NOW).toISOString() }));
    const afterPrune = await syncReleaseArticles(ports); expect(afterPrune.records[0]!.state).toBe('awaiting-production'); expect(ports.enqueue).toHaveBeenCalledTimes(1);
    expect((ports.reader.github as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(40);
  });
  it('never treats producer completion as a deployed article and requires separate live observation', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); await syncReleaseArticles(ports);
    ports.production = async () => true;
    const live = await syncReleaseArticles(ports); expect(live.records[0]!.state).toBe('published'); expect(live.records[0]!.publishedAt).not.toBeNull();
  });
  it('real production observation binds the public marker and canonical page; a generic success JSON proves nothing', async () => {
    const draft = publicArticleDraft(await verifyPublishedRelease(proposed, fixtureReader(), NOW));
    const ports = defaultReleaseArticlesDeps();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => new Response(String(url) === draft.evidenceUrl ?
      JSON.stringify({ canonical: draft.canonical, factsDigest: draft.factsDigest, releaseKey: draft.releaseKey, v: 1 }) :
      `<link rel="canonical" href="${draft.canonical}"><a href="${draft.evidenceUrl}">Evidence</a><a href="${draft.sources[0]}">Release</a>`, { status: 200 }));
    expect(await ports.production(draft)).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: true, success: true }), { status: 200 }));
    expect(await ports.production(draft)).toBe(false);
    await expect(ports.production({ ...draft, canonical: 'https://evil.example/' })).rejects.toThrow();
  });
  it('canonical publication queues a distinct authorized teaser, and pruned teaser tasks do not replay', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true;
    ports.enrolled = () => [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO];
    ports.policy = () => makePolicy({ repos: [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO].map((nameWithOwner) => ({ ...makePolicy().repos[0]!, nameWithOwner })) });
    const state = await syncReleaseArticles(ports); expect(state.records[0]!.state).toBe('published'); expect(state.records[0]!.teaser.state).toBe('queued');
    const queue = readTaskQueue(); expect(queue.ok && queue.tasks[0]!.repo).toBe(RELEASE_TEASER_REPO);
    writeFileSync(taskQueuePath(), JSON.stringify({ v: 1, tasks: [], updatedAt: new Date(NOW).toISOString() }));
    const later = await syncReleaseArticles(ports); expect(later.records[0]!.teaser.state).toBe('awaiting-production'); expect(ports.enqueue).toHaveBeenCalledTimes(1);
  });
  it('without teaser repo authority a published company article stays published while teaser is explicitly blocked', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true;
    const state = await syncReleaseArticles(ports); expect(state.records[0]!.state).toBe('published');
    expect(state.records[0]!.teaser.state).toBe('blocked-repository-authority'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('previous canonical publication becomes awaiting-production when current live proof and queue are unavailable', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true;
    const prior = await syncReleaseArticles(ports); expect(prior.records[0]!.state).toBe('published');
    ports.production = async () => false; ports.queue = () => ({ ok: false, reason: 'unreadable' });
    const current = await syncReleaseArticles(ports); expect(current.records[0]!.state).toBe('awaiting-production');
    expect(current.records[0]!.publishedAt).toBe(prior.records[0]!.publishedAt); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('previous teaser publication becomes awaiting-production on an unreadable queue while canonical article stays live', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true; ports.teaserProduction = async () => true;
    const prior = await syncReleaseArticles(ports); expect(prior.records[0]!.teaser.state).toBe('published');
    ports.teaserProduction = async () => false; ports.queue = () => ({ ok: false, reason: 'unreadable' });
    const current = await syncReleaseArticles(ports); expect(current.records[0]!.state).toBe('published');
    expect(current.records[0]!.teaser.state).toBe('awaiting-production'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it.each(['canonical-unavailable', 'facts-unavailable'] as const)('prior article and teaser publication lose current publication labels when %s without replay', async (failure) => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true; ports.teaserProduction = vi.fn(async () => true);
    ports.enrolled = () => [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO];
    ports.policy = () => makePolicy({ repos: [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO].map((nameWithOwner) => ({ ...makePolicy().repos[0]!, nameWithOwner })) });
    const prior = await syncReleaseArticles(ports); expect(prior.records[0]!.state).toBe('published');
    expect(prior.records[0]!.teaser.state).toBe('published'); expect(prior.records[0]!.teaser.taskId).toBeNull();
    ports.teaserProduction = vi.fn(async () => true);
    if (failure === 'canonical-unavailable') ports.production = async () => { throw new Error('unavailable'); };
    else ports.reader.npm = async () => { throw new Error('unavailable'); };
    for (let pass = 0; pass < 2; pass++) {
      const current = await syncReleaseArticles(ports); const row = current.records[0]!;
      expect(row.state).toBe(failure === 'canonical-unavailable' ? 'awaiting-production' : 'pending-public-verification');
      expect(row.teaser.state).toBe('awaiting-production'); expect(row.teaser).toEqual({ ...prior.records[0]!.teaser, state: 'awaiting-production' });
      expect(row.attempted).toBe(true); expect(row.publishedAt).toBe(prior.records[0]!.publishedAt);
      expect(ports.teaserProduction).not.toHaveBeenCalled(); expect(ports.enqueue).not.toHaveBeenCalled();
    }
  });
  it('a previously published teaser without a task retains its no-replay fence through repeated failed link observations', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.production = async () => true; ports.teaserProduction = async () => true;
    ports.enrolled = () => [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO];
    ports.policy = () => makePolicy({ repos: [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO].map((nameWithOwner) => ({ ...makePolicy().repos[0]!, nameWithOwner })) });
    const prior = await syncReleaseArticles(ports); expect(prior.records[0]!.teaser.taskId).toBeNull();
    ports.teaserProduction = async () => false;
    for (let pass = 0; pass < 2; pass++) {
      const current = await syncReleaseArticles(ports); expect(current.records[0]!.teaser.state).toBe('awaiting-production');
      expect(current.records[0]!.teaser.attempted).toBe(true); expect(ports.enqueue).not.toHaveBeenCalled();
    }
  });
  it.each(['failed', 'cancelled'] as const)('retained %s article and teaser tasks are terminal holds, not active queue or automatic replay', async (status) => {
    configureReleaseArticles(true, REPO); const ports = deps(); const article = await syncReleaseArticles(ports);
    const queue = readTaskQueue(); if (!queue.ok) throw new Error('queue');
    queue.tasks[0]!.status = status;
    writeFileSync(taskQueuePath(), JSON.stringify({ v: 1, tasks: queue.tasks, updatedAt: new Date(NOW).toISOString() }));
    const held = await syncReleaseArticles(ports); expect(held.records[0]!.state).toBe('awaiting-production');
    expect(held.records[0]!.reason).toContain(`article task ${status}`); expect(ports.enqueue).toHaveBeenCalledTimes(1);
    expect(held.records[0]!.taskId).toBe(article.records[0]!.taskId);
    ports.production = async () => true;
    ports.enrolled = () => [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO];
    ports.policy = () => makePolicy({ repos: [RELEASE_ARTICLE_REPO, RELEASE_TEASER_REPO].map((nameWithOwner) => ({ ...makePolicy().repos[0]!, nameWithOwner })) });
    await syncReleaseArticles(ports);
    const withTeaser = readTaskQueue(); if (!withTeaser.ok) throw new Error('queue');
    const teaser = withTeaser.tasks.find((task) => task.repo === RELEASE_TEASER_REPO)!; teaser.status = status;
    writeFileSync(taskQueuePath(), JSON.stringify({ v: 1, tasks: withTeaser.tasks, updatedAt: new Date(NOW).toISOString() }));
    const heldTeaser = await syncReleaseArticles(ports); expect(heldTeaser.records[0]!.teaser.state).toBe('awaiting-production');
    expect(heldTeaser.records[0]!.reason).toContain(`teaser task ${status}`); expect(ports.enqueue).toHaveBeenCalledTimes(2);
  });
  it('changed release facts cannot retain a prior published label while the original correction producer is active', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const first = await syncReleaseArticles(ports);
    ports.production = async () => true; await syncReleaseArticles(ports);
    ports.production = async () => false;
    ports.reader = fixtureReader((endpoint, raw) => endpoint.endsWith('/releases/tags/v3.24.3') ? { ...(raw as object), assets: [{ ...release.assets[0]!, digest: `sha256:${'e'.repeat(64)}` }] } : raw);
    const held = await syncReleaseArticles(ports); expect(held.records[0]!.state).toBe('awaiting-production');
    expect(held.records[0]!.reason).toContain('still active'); expect(held.records[0]!.taskId).toBe(first.records[0]!.taskId);
    expect(ports.enqueue).toHaveBeenCalledTimes(1);
  });
  it('a correction waits for the original active task then preserves the canonical URL and creates one correction', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const first = await syncReleaseArticles(ports);
    ports.reader = fixtureReader((endpoint, raw) => endpoint.endsWith('/releases/tags/v3.24.3') ? { ...(raw as object), assets: [{ ...release.assets[0]!, digest: `sha256:${'e'.repeat(64)}` }] } : raw);
    const waiting = await syncReleaseArticles(ports); expect(waiting.records[0]!.reason).toContain('still active'); expect(ports.enqueue).toHaveBeenCalledTimes(1);
    recordTaskDispatch(first.records[0]!.taskId!, { kind: 'produced', proposalId: 'original' }, { nowMs: NOW });
    const corrected = await syncReleaseArticles(ports); expect(corrected.records[0]!.digest).not.toBe(first.records[0]!.digest); expect(ports.enqueue).toHaveBeenCalledTimes(2);
    const queue = readTaskQueue(); expect(queue.ok && queue.tasks.every((task) => task.detail.includes('https://ashlr.ai/news/phantom-release-3-24-3'))).toBe(true);
    await syncReleaseArticles(ports); expect(ports.enqueue).toHaveBeenCalledTimes(2);
  });
  it('a crash after actual enqueue is recovered from the normal queue without creating another task', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const insert = ports.enqueue;
    ports.enqueue = (input) => { insert(input); throw new Error('crash after queue insertion'); };
    await expect(syncReleaseArticles(ports)).rejects.toThrow('crash'); expect(readReleaseArticles().records[0]!.state).toBe('enqueueing');
    ports.enqueue = vi.fn((input) => insert(input)); const recovered = await syncReleaseArticles(ports);
    expect(recovered.records[0]!.state).toBe('queued'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('Stop before work performs no probes; grant/Stop epoch changes across awaits withhold enqueue', async () => {
    configureReleaseArticles(true, REPO); const stopped = deps(); stopped.stopped = () => true;
    await syncReleaseArticles(stopped); expect(stopped.reader.github).not.toHaveBeenCalled();
    for (const kind of ['grant', 'epoch', 'enrollment', 'disable'] as const) {
      configureReleaseArticles(true, REPO); const ports = deps();
      ports.production = async () => {
        if (kind === 'grant') ports.policy = () => null;
        if (kind === 'epoch') ports.stopEpoch = () => 'changed';
        if (kind === 'enrollment') ports.enrolled = () => [];
        if (kind === 'disable') configureReleaseArticles(false);
        return false;
      };
      const state = await syncReleaseArticles(ports); expect(ports.enqueue).not.toHaveBeenCalled();
      if (kind !== 'disable') expect(state.records[0]!.state).toBe('blocked-repository-authority');
    }
  });
  it('unavailable latest or invalid qualification becomes pending, never published', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.reader.github = async () => { throw new Error('private token should never escape'); };
    const state = await syncReleaseArticles(ports); expect(state.observation!.state).toBe('pending-public-verification');
    expect(JSON.stringify(state)).not.toContain('private token'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('a prior ambiguous crash is held instead of replaying a potentially completed enqueue', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const facts = await verifyPublishedRelease(proposed, ports.reader, NOW);
    importProposedRelease(proposed); const manifest = readReleaseArticles(); manifest.records[0]!.digest = publicArticleDraft(facts).factsDigest; manifest.records[0]!.state = 'enqueueing'; manifest.records[0]!.attempted = true;
    writeFileSync(releaseArticlePaths().file, JSON.stringify(manifest));
    const state = await syncReleaseArticles(ports); expect(state.records[0]!.state).toBe('awaiting-production'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('legacy V1 enqueueing records migrate their uncertain fence on read without status writes or duplicate replay', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const facts = await verifyPublishedRelease(proposed, ports.reader, NOW);
    importProposedRelease(proposed); const manifest = readReleaseArticles();
    manifest.records[0]!.digest = publicArticleDraft(facts).factsDigest; manifest.records[0]!.state = 'enqueueing';
    manifest.records[0]!.teaser = { digest: publicArticleDraft(facts).factsDigest, state: 'enqueueing', taskId: null, attempted: true };
    const { attempted: _attempted, teaser, ...oldRecord } = manifest.records[0]!;
    const { attempted: _teaserAttempted, ...oldTeaser } = teaser;
    const bytes = JSON.stringify({ ...manifest, records: [{ ...oldRecord, teaser: oldTeaser }] });
    writeFileSync(releaseArticlePaths().file, bytes);
    const read = readReleaseArticles(); expect(read.records[0]!.attempted).toBe(true); expect(read.records[0]!.teaser.attempted).toBe(true);
    expect(readFileSync(releaseArticlePaths().file, 'utf8')).toBe(bytes);
    const held = await syncReleaseArticles(ports); expect(held.records[0]!.state).toBe('awaiting-production'); expect(ports.enqueue).not.toHaveBeenCalled();
    ports.production = async () => true;
    const teaserHeld = await syncReleaseArticles(ports); expect(teaserHeld.records[0]!.teaser.state).toBe('awaiting-production'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('failed fresh verification does not erase an uncertain reservation before a later healthy observation', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); const facts = await verifyPublishedRelease(proposed, ports.reader, NOW);
    importProposedRelease(proposed); const manifest = readReleaseArticles(); manifest.records[0]!.digest = publicArticleDraft(facts).factsDigest;
    manifest.records[0]!.state = 'enqueueing'; manifest.records[0]!.attempted = true;
    writeFileSync(releaseArticlePaths().file, JSON.stringify(manifest));
    ports.reader.npm = async () => { throw new Error('unavailable'); };
    const pending = await syncReleaseArticles(ports); expect(pending.records[0]!.state).toBe('pending-public-verification'); expect(pending.records[0]!.attempted).toBe(true);
    ports.reader = fixtureReader(); const recovered = await syncReleaseArticles(ports);
    expect(recovered.records[0]!.state).toBe('awaiting-production'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('unreadable task queue does not enqueue duplicates or reinterpret an error as zero work', async () => {
    configureReleaseArticles(true, REPO); const ports = deps(); ports.queue = () => ({ ok: false, reason: 'fixture broken queue' });
    const state = await syncReleaseArticles(ports); expect(state.records[0]!.reason).toContain('unreadable'); expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it('corrupt/symlink manifests refuse reads rather than returning empty', () => {
    configureReleaseArticles(true, REPO); const path = releaseArticlePaths().file; writeFileSync(path, '{broken'); expect(() => readReleaseArticles()).toThrow();
  });
  it('an unsafe storage ancestor cannot be followed to enable maintenance', () => {
    const elsewhere = join(home.home(), 'elsewhere'); mkdirSync(elsewhere); symlinkSync(elsewhere, join(home.home(), '.ashlr'), 'dir');
    expect(() => readReleaseArticles()).toThrow(); expect(() => configureReleaseArticles(true)).toThrow(); expect(existsSync(join(elsewhere, 'release-articles', 'manifest.json'))).toBe(false);
  });
  // Exercise the real Linux adapter contract on every host: POSIX metadata is
  // checked by this caller, unlike the Darwin/Windows ACL adapter branches.
  function callerCheckedAssurance(): void {
    const actual = privateStorage.assurePrivateStoragePath;
    vi.spyOn(privateStorage, 'assurePrivateStoragePath').mockImplementation((path, kind, mode, options) =>
      actual(path, kind, mode, { ...options, platform: 'linux' }));
  }
  it.each(['.ashlr', 'release-articles'])('rejects a missing manifest under a symlinked %s with caller-checked assurance', (part) => {
    callerCheckedAssurance(); const elsewhere = join(home.home(), 'elsewhere'); mkdirSync(elsewhere, { mode: 0o700 });
    if (part === 'release-articles') mkdirSync(join(home.home(), '.ashlr'), { mode: 0o700 });
    symlinkSync(elsewhere, part === '.ashlr' ? join(home.home(), part) : releaseArticlePaths().directory, 'dir');
    expect(() => readReleaseArticles()).toThrow(/unsafe/);
    expect(() => configureReleaseArticles(true)).toThrow(/unsafe/);
    expect(existsSync(join(elsewhere, 'manifest.json'))).toBe(false);
    expect(existsSync(join(elsewhere, 'release-articles'))).toBe(false);
  });
  it('rejects an existing enabled manifest reached through an ancestor symlink on the caller-checked path', () => {
    configureReleaseArticles(true, REPO); const elsewhere = join(home.home(), 'elsewhere');
    renameSync(join(home.home(), '.ashlr'), elsewhere); symlinkSync(elsewhere, join(home.home(), '.ashlr'), 'dir');
    callerCheckedAssurance(); expect(() => readReleaseArticles()).toThrow(/unsafe/);
    expect(() => configureReleaseArticles(false)).toThrow(/unsafe/);
    expect(JSON.parse(readFileSync(join(elsewhere, 'release-articles', 'manifest.json'), 'utf8')).enabled).toBe(true);
  });
  it('refuses dangling ancestors rather than reporting safely missing configuration', () => {
    callerCheckedAssurance(); symlinkSync(join(home.home(), 'does-not-exist'), join(home.home(), '.ashlr'), 'dir');
    expect(() => readReleaseArticles()).toThrow(/unsafe/);
    expect(() => configureReleaseArticles(true)).toThrow(/unsafe/);
    expect(existsSync(join(home.home(), 'does-not-exist'))).toBe(false);
  });
  it('keeps truly missing state observational without creating or changing directories', () => {
    callerCheckedAssurance(); expect(readReleaseArticles().enabled).toBe(false);
    expect(existsSync(join(home.home(), '.ashlr'))).toBe(false);
    mkdirSync(join(home.home(), '.ashlr'), { mode: 0o700 });
    const before = lstatSync(join(home.home(), '.ashlr'), { bigint: true });
    expect(readReleaseArticles().enabled).toBe(false);
    expect(existsSync(releaseArticlePaths().directory)).toBe(false);
    const after = lstatSync(join(home.home(), '.ashlr'), { bigint: true });
    expect(after.ino).toBe(before.ino); expect(after.mode).toBe(before.mode); expect(after.ctimeNs).toBe(before.ctimeNs);
  });
  it('refuses hard-linked manifest authority on the caller-checked path', () => {
    configureReleaseArticles(true, REPO); callerCheckedAssurance();
    linkSync(releaseArticlePaths().file, join(home.home(), 'second-manifest.json'));
    expect(() => readReleaseArticles()).toThrow(/unsafe/);
  });
  it('refuses a manifest replaced during platform assurance without applying the replacement', () => {
    configureReleaseArticles(true, REPO); const { file } = releaseArticlePaths(); const old = readFileSync(file, 'utf8');
    const actual = privateStorage.assurePrivateStoragePath;
    vi.spyOn(privateStorage, 'assurePrivateStoragePath').mockImplementation((path, kind, mode, options) => {
      const proof = actual(path, kind, mode, { ...options, platform: 'linux' });
      if (path === file) { renameSync(file, `${file}.old`); writeFileSync(file, old.replace('"enabled":true', '"enabled":false'), { mode: 0o600 }); }
      return proof;
    });
    expect(() => readReleaseArticles()).toThrow(/unsafe/);
  });
  it('refuses a manifest replaced during capped reading instead of accepting old authority', () => {
    configureReleaseArticles(true, REPO); callerCheckedAssurance(); const { file } = releaseArticlePaths();
    const actual = preferences.readPrivateFileCapped;
    vi.spyOn(preferences, 'readPrivateFileCapped').mockImplementation((path, bound) => {
      const bytes = actual(path, bound);
      renameSync(path, `${path}.old`); writeFileSync(path, bytes!.text.replace('"enabled":true', '"enabled":false'), { mode: 0o600 });
      return bytes;
    });
    expect(() => readReleaseArticles()).toThrow(/changed during read/);
    expect(JSON.parse(readFileSync(file, 'utf8')).enabled).toBe(false);
  });
  it('keeps existing unsafe POSIX modes unchanged during a refused observational read', () => {
    configureReleaseArticles(true, REPO); const directory = releaseArticlePaths().directory;
    if (process.platform === 'win32') {
      // Windows modes are not its authority boundary; its existing ACL helper
      // must refuse this same read rather than substituting Unix chmod rules.
      vi.spyOn(privateStorage, 'assurePrivateStoragePath').mockReturnValue({ ok: false, reason: 'untrusted-ancestor-owner' });
      expect(() => readReleaseArticles()).toThrow(/unsafe/);
    } else {
      callerCheckedAssurance(); chmodSync(directory, 0o722);
      const before = lstatSync(directory, { bigint: true });
      expect(() => readReleaseArticles()).toThrow(/unsafe/);
      expect(lstatSync(directory, { bigint: true }).mode).toBe(before.mode);
    }
  });
  it('does not reinterpret disappearance during platform assurance as safely missing state', () => {
    mkdirSync(join(home.home(), '.ashlr'), { mode: 0o700 }); const actual = privateStorage.assurePrivateStoragePath;
    vi.spyOn(privateStorage, 'assurePrivateStoragePath').mockImplementation((path, kind, mode, options) => {
      const proof = actual(path, kind, mode, { ...options, platform: 'linux' });
      renameSync(path, `${path}.removed`); return proof;
    });
    expect(() => readReleaseArticles()).toThrow(/unsafe/);
    expect(existsSync(releaseArticlePaths().directory)).toBe(false);
  });
  it('rechecks inspected parents before accepting a missing manifest', () => {
    mkdirSync(releaseArticlePaths().directory, { recursive: true, mode: 0o700 }); const actual = privateStorage.assurePrivateStoragePath;
    const elsewhere = join(home.home(), 'elsewhere'); const parent = join(home.home(), '.ashlr'); const directory = releaseArticlePaths().directory;
    vi.spyOn(privateStorage, 'assurePrivateStoragePath').mockImplementation((path, kind, mode, options) => {
      const proof = actual(path, kind, mode, { ...options, platform: 'linux' });
      if (path === directory) { renameSync(parent, elsewhere); symlinkSync(elsewhere, parent, 'dir'); }
      return proof;
    });
    expect(() => readReleaseArticles()).toThrow(/changed during read/);
    expect(existsSync(join(elsewhere, 'release-articles', 'manifest.json'))).toBe(false);
  });
  it('rechecks parent inodes after reading even when the leaf inode remains unchanged', () => {
    configureReleaseArticles(true, REPO); callerCheckedAssurance(); const { file } = releaseArticlePaths();
    const before = lstatSync(file, { bigint: true }); const actual = preferences.readPrivateFileCapped;
    vi.spyOn(preferences, 'readPrivateFileCapped').mockImplementation((path, bound) => {
      const bytes = actual(path, bound); const parent = join(home.home(), '.ashlr'); const elsewhere = join(home.home(), 'elsewhere');
      renameSync(parent, elsewhere); symlinkSync(elsewhere, parent, 'dir'); return bytes;
    });
    expect(() => readReleaseArticles()).toThrow(/changed during read/);
    expect(lstatSync(file, { bigint: true }).ino).toBe(before.ino);
  });
  it('unknown private manifest fields are refused rather than exported into CLI output', () => {
    configureReleaseArticles(true, REPO); const manifest = readReleaseArticles();
    writeFileSync(releaseArticlePaths().file, JSON.stringify({ ...manifest, token: 'SECRET' }));
    expect(() => readReleaseArticles()).toThrow();
  });
  it('the reviewed repository rename keeps one content identity without granting the renamed label', () => {
    configureReleaseArticles(true, REPO); configureReleaseArticles(false);
    const original = importProposedRelease(proposed);
    expect(importProposedRelease({ ...proposed, repository: 'ashlrai/phantom' })).toEqual(original);
    expect(readReleaseArticles().records).toHaveLength(1);
    expect(readReleaseArticles().enabled).toBe(false);
    expect(readReleaseArticles().repository).toBe(REPO);
  });
  it('CLI status/enable/import/sync/disable use the same real lifecycle and reject unknown imports', async () => {
    const ports = deps(); const out: string[] = []; const print = (text: string): void => { out.push(text); };
    expect(await runReleaseArticlesCli(['status', '--json'], ports, print)).toBe(0); expect(existsSync(releaseArticlePaths().directory)).toBe(false);
    expect(await runReleaseArticlesCli(['enable', REPO], ports, print)).toBe(0);
    const file = join(home.home(), 'proposed.json'); writeFileSync(file, JSON.stringify(proposed));
    expect(await runReleaseArticlesCli(['import', file], ports, print)).toBe(0);
    expect(await runReleaseArticlesCli(['sync', '3.24.3', '--json'], ports, print)).toBe(0);
    expect(JSON.parse(out.at(-1)!).records[0].state).toBe('queued');
    expect(await runReleaseArticlesCli(['disable'], ports, print)).toBe(0); expect(readReleaseArticles().enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ ...proposed, success: true })); expect(await runReleaseArticlesCli(['import', file], ports, print)).toBe(1);
    expect(await runReleaseArticlesCli(['publish-now'], ports, print)).toBe(2);
  });
  it('public CI claim policy matches the existing producer job policy, not caller-authored JSON', async () => {
    const module = await import(pathToFileURL(join(process.cwd(), 'scripts/hosted-build-artifact.mjs')).href) as { requiredJobPolicy(root: string): { name: string; labels: string[]; steps: string[] }[] };
    expect(RELEASE_CI_JOBS.map((name) => ({ name, labels: releaseRequiredLabels(name), steps: releaseRequiredSteps(name) }))).toEqual(module.requiredJobPolicy(process.cwd()));
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const audit = readFileSync(join(process.cwd(), '.github/workflows/dependency-audit.yml'), 'utf8');
    for (const name of RELEASE_CI_JOBS) for (const step of releaseRequiredSteps(name)) expect(ci).toContain(`name: ${step}\n`);
    for (const step of releaseRequiredSteps('Dependency audit (root + Raycast)')) expect(audit).toContain(`name: ${step}\n`);
  });
});
