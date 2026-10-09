/** Fresh public release facts. This is claim eligibility, never build or effect authority. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireHubRepositoryMetadata, requireHubRepositoryReference, type HubRepositoryLabel } from './authority/repository-binding.js';
import { desktopUpdateProfileForPackage, type DesktopUpdateProfile } from './desktop/update-manifest.js';

export interface ProposedRelease { v: 1; repository: HubRepositoryLabel; version: string }
export interface PublishedReleaseFacts extends ProposedRelease {
  sourceSha: string; mergedSha: string; treeSha: string;
  releaseId: number; publishedAt: string; observedAt: string;
  ci: { id: number; attempt: number }; audit: { id: number; attempt: number };
  packageIntegrity: string;
  assets: { name: string; bytes: number; digest: string | null }[];
  /** Omitted for legacy facts so their stable public representation is unchanged. */
  packageName?: '@ashlr/phantom';
}
export interface ReleasePublicReader {
  github(endpoint: string, signal?: AbortSignal): Promise<unknown>;
  npm(version: string, signal?: AbortSignal, packageName?: DesktopUpdateProfile['packageName']): Promise<unknown>;
}
/** Public presentation only; this record never authorizes installation or effects. */
export interface PublicWorkbenchRelease {
  v: 1; product: 'workbench'; repository: 'ashlrai/phantom'; packageName: '@ashlr/phantom';
  version: string; sourceSha: string; publishedAt: string; observedAt: string;
  releaseUrl: string; registryUrl: string; installCommand: string;
  macDownloadUrl: string | null; factsDigest: string;
}
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_PACKAGE = 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid public release response');
  return value as Record<string, unknown>;
};
const positive = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid public identifier');
  return Number(value);
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error('Invalid public source hash');
  return value;
};
function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`Public ${label} does not match`);
}
function iso(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error('Invalid publication time');
  return new Date(value).toISOString();
}
export function parseProposedRelease(value: unknown): ProposedRelease {
  const raw = object(value);
  if (Object.keys(raw).sort().join(',') !== 'repository,v,version' || raw['v'] !== 1 ||
    !['ashlrai/ashlr-hub', 'ashlrai/phantom'].includes(String(raw['repository'])) ||
    typeof raw['version'] !== 'string' || raw['version'].length > 40 || !VERSION.test(raw['version'])) {
    throw new Error('Expected only proposed release {v:1, repository, version}; saved receipts are not evidence');
  }
  return { v: 1, repository: raw['repository'] as HubRepositoryLabel, version: raw['version'] };
}

// Closed official reads only. No arbitrary URL, token argument, candidate code,
// output logging, asset execution, or native build-adoption capability is exposed.
export function defaultReleasePublicReader(): ReleasePublicReader {
  return {
    github: async (endpoint, signal) => {
      if (!/^repos\/ashlrai\/(?:ashlr-hub|phantom)(?:\/[A-Za-z0-9_./?=&%-]+)?$/.test(endpoint) || endpoint.includes('..')) throw new Error('Non-release GitHub endpoint refused');
      const output = await new Promise<string>((done, fail) => {
        execFile('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint], {
          encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_JSON, signal,
          env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        }, (error, stdout) => error ? fail(new Error('Fresh GitHub release facts unavailable')) : done(stdout));
      });
      return JSON.parse(output) as unknown;
    },
    npm: async (version, signal, packageName = '@ashlr/hub') => {
      if (!VERSION.test(version)) throw new Error('Invalid npm release version');
      const profile = desktopUpdateProfileForPackage(packageName);
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetch(`https://registry.npmjs.org/${profile.packageName.replace('/', '%2f')}/${version}`, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (!response.ok || !response.body) throw new Error('Fresh npm release facts unavailable');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_JSON) throw new Error('Public npm response too large');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    },
  };
}

/** Same exhaustive role set as the release producer; no caller-supplied job policy. */
export const RELEASE_CI_JOBS = Object.freeze([
  ...['ubuntu, authority 1/3', 'ubuntu, authority 2/3', 'ubuntu, authority 3/3',
    'windows, portability 1/3', 'windows, portability 2/3', 'windows, portability 3/3', 'windows, portability overflow',
    'macos, shared queue authority'].map((label) => `CI (Node 22, ${label})`),
  ...[1, 2, 3, 4].map((shard) => `Mac exhaustive (${shard}/4)`), 'Mac exhaustive (isolated)',
  'Native macOS broker foundation (Rust 1.97.1)', 'Windows service authority (Server 2022)',
]);
export function releaseRequiredSteps(name: string): readonly string[] {
  if (name.startsWith('CI (Node 22,')) {
    const steps = ['Bind candidate source', 'Install dependencies', 'Check generated authority ownership (hermetic)', 'Build', 'Test (hermetic)'];
    if (name.includes('ubuntu, authority 1/3')) steps.push('Capture pack smoke build snapshot', 'Test web operator console', 'Pack smoke (exports map)', 'Upload qualified build handoff');
    if (name.includes('ubuntu, authority 3/3')) steps.push('Typecheck', 'Lint', 'Check documentation', 'Test complete dispatch production ledger (hermetic)');
    if (name.includes('windows, portability 2/3') || name.includes('macos, shared queue authority')) steps.push('Test native alias authority (hermetic)');
    if (name.includes('windows, portability 1/3')) steps.push('Test native path and lifecycle authority (hermetic)');
    if (name.includes('windows, portability overflow')) steps.push('Test native ACL enrollment fences (hermetic)');
    if (name.includes('macos, shared queue authority')) steps.push('Test npm runtime snapshot authority (hermetic)', 'Clean disposable native launchd fixture');
    return steps;
  }
  if (name.startsWith('Mac exhaustive (')) return ['Bind candidate source', 'Install dependencies', 'Build',
    name === 'Mac exhaustive (isolated)' ? 'Test complete Mac isolated suites' : 'Test complete Mac general partition', 'Upload Mac qualification'];
  if (name.startsWith('Native macOS broker')) return ['Bind candidate source', 'Check native broker formatting', 'Check native broker library', 'Lint native broker library', 'Test native broker library', 'Remove disposable Tauri sidecar fixture'];
  if (name.startsWith('Windows service authority')) return ['Bind candidate source', 'Install dependencies', 'Build hardened inventory', 'Test npm runtime snapshot authority (hermetic)', 'Test native Windows service authority (hermetic)'];
  return ['Install pinned npm', 'Verify root dependency graph installs', 'Verify Raycast dependency graph installs', 'Audit root dependencies',
    'Audit root production dependencies', 'Audit Raycast dependencies', 'Audit Raycast production dependencies', 'Audit desktop Cargo dependencies'];
}
export function releaseRequiredLabels(name: string): readonly string[] {
  if (name.startsWith('Mac exhaustive')) return ['macos-15'];
  if (name.startsWith('Native macOS broker') || name.includes('macos, shared')) return ['macos-latest'];
  if (name.startsWith('Windows service')) return ['windows-2022'];
  if (name.includes('windows, portability')) return ['windows-latest'];
  return ['ubuntu-latest'];
}
async function jobsFor(reader: ReleasePublicReader, base: string, id: number, attempt: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const jobs: Record<string, unknown>[] = []; let expected: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const raw = object(await reader.github(`${base}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`, signal));
    const count = raw['total_count'];
    if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 1000 || !Array.isArray(raw['jobs'])) throw new Error('Invalid job enumeration');
    if (expected === undefined) expected = Number(count); else equal(count, expected, 'job inventory');
    jobs.push(...raw['jobs'].map(object));
    if (jobs.length === expected) return jobs;
    if (jobs.length > expected || raw['jobs'].length !== 100) throw new Error('Incomplete job enumeration');
  }
  throw new Error('Job enumeration limit exceeded');
}
async function successfulRun(reader: ReleasePublicReader, base: string, repository: string, sourceSha: string, workflow: string, signal?: AbortSignal): Promise<{ id: number; attempt: number }> {
  // Query a fixed workflow and exact candidate. Pick the newest run, not an old
  // green attempt of a newer failed run; fresh attempt and jobs are rechecked.
  const listing = object(await reader.github(`${base}/actions/workflows/${workflow}/runs?head_sha=${sourceSha}&per_page=100`, signal));
  if (!Array.isArray(listing['workflow_runs']) || !Number.isSafeInteger(listing['total_count']) || Number(listing['total_count']) < 1) throw new Error('Candidate qualification unavailable');
  const runs = listing['workflow_runs'].map(object).filter((run) => run['head_sha'] === sourceSha);
  if (runs.length === 0) throw new Error('Candidate qualification missing');
  const selected = runs.sort((a, b) => positive(b['id']) - positive(a['id']))[0]!;
  const id = positive(selected['id']); const attempt = positive(selected['run_attempt']);
  const run = object(await reader.github(`${base}/actions/runs/${id}/attempts/${attempt}`, signal));
  requireHubRepositoryReference(repository, run['repository']);
  equal(run['id'], id, 'run'); equal(run['run_attempt'], attempt, 'run attempt'); equal(run['head_sha'], sourceSha, 'candidate');
  equal(run['path'], `.github/workflows/${workflow}`, 'workflow'); equal(run['status'], 'completed', 'run status'); equal(run['conclusion'], 'success', 'run outcome');
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(String(run['event']))) throw new Error('Unexpected qualification event');
  const jobs = await jobsFor(reader, base, id, attempt, signal);
  const names = workflow === 'ci.yml' ? RELEASE_CI_JOBS : ['Dependency audit (root + Raycast)'];
  if (jobs.length !== names.length || new Set(jobs.map((job) => job['id'])).size !== jobs.length) throw new Error('Unexpected qualification job inventory');
  for (const name of names) {
    const matches = jobs.filter((job) => job['name'] === name);
    if (matches.length !== 1) throw new Error('Required qualification job missing or ambiguous');
    const job = matches[0]!;
    equal(job['run_id'], id, 'job run'); equal(job['head_sha'], sourceSha, 'job candidate');
    equal(job['status'], 'completed', 'job status'); equal(job['conclusion'], 'success', 'job outcome');
    if (!Array.isArray(job['labels']) || job['labels'].includes('self-hosted') ||
      releaseRequiredLabels(name).some((label) => !(job['labels'] as unknown[]).includes(label))) throw new Error('Unexpected qualification runner');
    if (!Array.isArray(job['steps']) || !job['steps'].some((step) => object(step)['conclusion'] === 'success') ||
      job['steps'].some((step) => !['success', 'skipped'].includes(String(object(step)['conclusion'])) || object(step)['status'] !== 'completed')) throw new Error('Qualification steps incomplete');
    for (const stepName of releaseRequiredSteps(name)) {
      const matches = job['steps'].map(object).filter((step) => step['name'] === stepName);
      if (matches.length !== 1 || matches[0]!['conclusion'] !== 'success') throw new Error('Required qualification step missing or skipped');
    }
  }
  const current = object(await reader.github(`${base}/actions/runs/${id}`, signal));
  requireHubRepositoryReference(repository, current['repository']);
  equal(current['id'], id, 'current run'); equal(current['run_attempt'], attempt, 'current run attempt');
  equal(current['status'], 'completed', 'current run status'); equal(current['conclusion'], 'success', 'current run outcome');
  equal(current['head_sha'], sourceSha, 'current candidate'); equal(current['path'], `.github/workflows/${workflow}`, 'current workflow');
  return { id, attempt };
}

async function latestReleaseObservation(repository: HubRepositoryLabel, reader: ReleasePublicReader, signal?: AbortSignal): Promise<{ proposed: ProposedRelease; release: Record<string, unknown> }> {
  requireHubRepositoryMetadata(repository, await reader.github(`repos/${repository}`, signal));
  const release = object(await reader.github(`repos/${repository}/releases/latest`, signal));
  if (typeof release['tag_name'] !== 'string' || !release['tag_name'].startsWith('v')) throw new Error('Stable release version missing');
  return { proposed: parseProposedRelease({ v: 1, repository, version: release['tag_name'].slice(1) }), release };
}
export async function discoverLatestRelease(repository: HubRepositoryLabel, reader: ReleasePublicReader, signal?: AbortSignal): Promise<ProposedRelease> {
  return (await latestReleaseObservation(repository, reader, signal)).proposed;
}

export function publicWorkbenchRelease(facts: PublishedReleaseFacts): PublicWorkbenchRelease {
  parseProposedRelease({ v: facts.v, repository: facts.repository, version: facts.version });
  if (facts.repository !== 'ashlrai/phantom' || facts.packageName !== '@ashlr/phantom') throw new Error('Canonical workbench release facts required');
  hash(facts.sourceSha); iso(facts.publishedAt); iso(facts.observedAt);
  const { observedAt: _observedAt, ...stable } = facts;
  const releaseUrl = `https://github.com/ashlrai/phantom/releases/tag/v${facts.version}`;
  const macAsset = `Phantom_${facts.version}_aarch64.dmg`;
  const mac = facts.assets.find((asset) => asset.name === macAsset && asset.bytes > 0 && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''));
  return { v: 1, product: 'workbench', repository: 'ashlrai/phantom', packageName: '@ashlr/phantom', version: facts.version,
    sourceSha: facts.sourceSha, publishedAt: facts.publishedAt, observedAt: facts.observedAt, releaseUrl,
    registryUrl: `https://www.npmjs.com/package/@ashlr/phantom/v/${facts.version}`,
    installCommand: `npm install -g @ashlr/phantom@${facts.version}`,
    macDownloadUrl: mac ? `https://github.com/ashlrai/phantom/releases/download/v${facts.version}/${macAsset}` : null,
    factsDigest: createHash('sha256').update(JSON.stringify(stable)).digest('hex') };
}

/** Bracket the existing full verifier so candidate bumps or a moving latest pointer cannot become public latest claims. */
export async function verifyLatestWorkbenchRelease(reader: ReleasePublicReader, nowMs: number, signal?: AbortSignal): Promise<PublicWorkbenchRelease> {
  const before = await latestReleaseObservation('ashlrai/phantom', reader, signal);
  const facts = await verifyPublishedRelease(before.proposed, reader, nowMs, signal);
  const after = await latestReleaseObservation('ashlrai/phantom', reader, signal);
  const fingerprint = (release: Record<string, unknown>): string => {
    if (release['draft'] !== false || release['prerelease'] !== false || !Array.isArray(release['assets'])) throw new Error('Latest public workbench release is incomplete');
    const assets = release['assets'].map((raw) => { const asset = object(raw); return { name: stringAssetName(asset['name']), size: asset['size'], digest: asset['digest'] ?? null, state: asset['state'], url: asset['browser_download_url'] }; }).sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ id: positive(release['id']), tag: release['tag_name'], publishedAt: iso(release['published_at']), assets });
  };
  const latestAssets = Array.isArray(before.release['assets']) ? before.release['assets'].map((raw) => {
    const asset = object(raw); return { name: stringAssetName(asset['name']), bytes: positive(asset['size']), digest: asset['digest'] ?? null };
  }).sort((a, b) => a.name.localeCompare(b.name)) : null;
  if (facts.releaseId !== positive(before.release['id']) || facts.publishedAt !== iso(before.release['published_at']) ||
      JSON.stringify(latestAssets) !== JSON.stringify(facts.assets) ||
      fingerprint(before.release) !== fingerprint(after.release) || signal?.aborted) throw new Error('Latest workbench release changed during verification');
  return publicWorkbenchRelease(facts);
}
function stringAssetName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) throw new Error('Invalid latest release asset name');
  return value;
}

/** A renamed repository does not identify an historical release's npm package. */
async function sourcePackageProfile(base: string, treeSha: string, pin: ProposedRelease, reader: ReleasePublicReader,
  signal?: AbortSignal): Promise<DesktopUpdateProfile> {
  // Omit recursive entirely: GitHub treats even recursive=0 as recursive.
  const tree = object(await reader.github(`${base}/git/trees/${treeSha}`, signal));
  equal(tree['sha'], treeSha, 'package source tree');
  if (tree['truncated'] !== false || !Array.isArray(tree['tree']) || tree['tree'].length > 10_000) {
    throw new Error('Complete bounded package source tree unavailable');
  }
  const paths = new Set<string>(); let entry: Record<string, unknown> | undefined;
  for (const raw of tree['tree']) {
    const row = object(raw); const path = row['path'];
    if (typeof path !== 'string' || path.length < 1 || path.length > 255 || path === '.' || path === '..' ||
      /[\\/\0]/.test(path) || paths.has(path)) throw new Error('Invalid root package source tree');
    paths.add(path);
    if (path === 'package.json') entry = row;
  }
  if (!entry || entry['type'] !== 'blob' || !['100644', '100755'].includes(entry['mode'] as string) ||
    !Number.isSafeInteger(entry['size']) || Number(entry['size']) < 1 || Number(entry['size']) > MAX_PACKAGE) {
    throw new Error('Regular bounded source package unavailable');
  }
  const blobSha = hash(entry['sha']); const blob = object(await reader.github(`${base}/git/blobs/${blobSha}`, signal));
  equal(blob['sha'], blobSha, 'package source blob'); equal(blob['encoding'], 'base64', 'package blob encoding');
  equal(blob['size'], entry['size'], 'package source size');
  const content = blob['content'];
  if (typeof content !== 'string' || content.length > MAX_PACKAGE * 2) throw new Error('Package blob exceeds bound');
  // GitHub wraps Base64 with ASCII line breaks; Buffer's other tolerances are refused.
  const encoded = content.replace(/[\r\n]/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Invalid package blob Base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  equal(bytes.length, entry['size'], 'package raw byte length'); equal(bytes.toString('base64'), encoded, 'package Base64');
  const actualSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  equal(actualSha, blobSha, 'package Git blob hash');
  const pkg = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  const profile = desktopUpdateProfileForPackage(pkg['name']); equal(pkg['version'], pin.version, 'source package version');
  if (profile.name === 'canonical-v2') equal(pin.repository, profile.repository, 'canonical release repository');
  return profile;
}

export async function verifyPublishedRelease(proposed: ProposedRelease, reader: ReleasePublicReader, nowMs: number, signal?: AbortSignal): Promise<PublishedReleaseFacts> {
  const pin = parseProposedRelease(proposed); const base = `repos/${pin.repository}`; const tag = `v${pin.version}`;
  requireHubRepositoryMetadata(pin.repository, await reader.github(base, signal));
  const release = object(await reader.github(`${base}/releases/tags/${tag}`, signal));
  equal(release['tag_name'], tag, 'release tag'); equal(release['draft'], false, 'release visibility'); equal(release['prerelease'], false, 'release stability');
  equal(release['html_url'], `https://github.com/${pin.repository}/releases/tag/${tag}`, 'release URL');
  const ref = object(await reader.github(`${base}/git/ref/tags/${tag}`, signal));
  equal(ref['ref'], `refs/tags/${tag}`, 'tag ref'); let target = object(ref['object']);
  for (let depth = 0; target['type'] === 'tag'; depth++) {
    if (depth >= 4) throw new Error('Annotated tag nesting exceeds bound');
    const annotated = object(await reader.github(`${base}/git/tags/${hash(target['sha'])}`, signal));
    equal(annotated['sha'], target['sha'], 'annotated tag'); target = object(annotated['object']);
  }
  equal(target['type'], 'commit', 'tag target'); const mergedSha = hash(target['sha']);
  const merged = object(await reader.github(`${base}/git/commits/${mergedSha}`, signal)); equal(merged['sha'], mergedSha, 'merged commit');
  const treeSha = hash(object(merged['tree'])['sha']);
  if (!Array.isArray(merged['parents']) || merged['parents'].length > 2) throw new Error('Unexpected release merge ancestry');
  const sourceSha = merged['parents'].length === 2 ? hash(object(merged['parents'][1])['sha']) : mergedSha;
  const source = object(await reader.github(`${base}/git/commits/${sourceSha}`, signal));
  equal(source['sha'], sourceSha, 'source commit'); equal(object(source['tree'])['sha'], treeSha, 'candidate tree');
  const ci = await successfulRun(reader, base, pin.repository, sourceSha, 'ci.yml', signal);
  const audit = await successfulRun(reader, base, pin.repository, sourceSha, 'dependency-audit.yml', signal);
  const profile = await sourcePackageProfile(base, treeSha, pin, reader, signal);
  const pkg = object(await reader.npm(pin.version, signal, profile.packageName)); const dist = object(pkg['dist']);
  equal(pkg['name'], profile.packageName, 'npm package'); equal(pkg['version'], pin.version, 'npm version');
  equal(dist['tarball'], `https://registry.npmjs.org/${profile.packageName}/-/${profile.packageName.split('/')[1]}-${pin.version}.tgz`, 'npm tarball');
  if (typeof dist['integrity'] !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist['integrity'])) throw new Error('npm integrity missing');
  if (!Array.isArray(release['assets']) || release['assets'].length === 0 || release['assets'].length > 100) throw new Error('Published asset inventory unavailable');
  const assets = release['assets'].map((raw) => {
    const asset = object(raw); const name = asset['name'];
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(name)) throw new Error('Invalid public asset name');
    equal(asset['state'], 'uploaded', 'asset state');
    equal(asset['browser_download_url'], `https://github.com/${pin.repository}/releases/download/${tag}/${name}`, 'asset URL');
    if (asset['digest'] !== null && asset['digest'] !== undefined && (typeof asset['digest'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset['digest']))) throw new Error('Invalid public asset digest');
    return { name, bytes: positive(asset['size']), digest: typeof asset['digest'] === 'string' ? asset['digest'] : null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(assets.map((asset) => asset.name)).size !== assets.length) throw new Error('Ambiguous public assets');
  if (Date.parse(iso(release['published_at'])) > nowMs) throw new Error('Release publication time is in the future');
  // Final repository/ref reads catch rename or retag races. Observation is not
  // an immutable signature or permission to adopt a serialized build receipt.
  requireHubRepositoryMetadata(pin.repository, await reader.github(base, signal));
  equal(JSON.stringify(object(await reader.github(`${base}/git/ref/tags/${tag}`, signal))['object']), JSON.stringify(ref['object']), 'tag stability');
  const finalRelease = object(await reader.github(`${base}/releases/tags/${tag}`, signal));
  for (const field of ['id', 'tag_name', 'draft', 'prerelease', 'published_at', 'assets']) equal(JSON.stringify(finalRelease[field]), JSON.stringify(release[field]), 'release stability');
  if (signal?.aborted) throw new Error('Release observation stopped');
  return { ...pin, sourceSha, mergedSha, treeSha, releaseId: positive(release['id']), publishedAt: iso(release['published_at']),
    observedAt: new Date(nowMs).toISOString(), ci, audit, packageIntegrity: dist['integrity'], assets,
    ...(profile.name === 'canonical-v2' ? { packageName: '@ashlr/phantom' as const } : {}) };
}
