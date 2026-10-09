/** Concrete host adapter. Neither request arguments nor saved success receipts supply executable callbacks. */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { evaluateStandingAuthority } from '../authority/effective-config.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { defaultHostMergeDeps, readHeadChecks, readRequiredChecks } from '../fleet/host-merge.js';
import { evaluateG7Checks } from '../fleet/merge-gates.js';
import { ensureMirror, mirrorPathFor } from '../fleet/mirrors.js';
import { registerExecutionLease, withVerificationSlot, type ExecutionLease } from '../sandbox/execution-leases.js';
import { runSafeGit } from '../sandbox/safe-git.js';
import { authorityDir } from '../authority/ledger.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { acquireOutwardMutationFenceAsync, releaseOutwardMutationFence } from '../sandbox/mutation-fence.js';
import {
  WEBSITE_PROFILE, assertWebsiteAuthority, inventoryWebsiteOutput, websiteDigest, websiteToolsDir,
  type WebsiteCommission, type WebsiteHostAdapter, type WebsiteOperation, type WebsiteSource,
} from './host-release.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Website provider metadata is incomplete');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('Website provider identity is missing'); return value; }
function sha(value: unknown): string { const result = string(value); if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('Website source SHA is invalid'); return result; }
function fileDigest(path: string): string { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Website tool is not a regular file'); return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function privateDirectory(path: string): void {
  const parent = dirname(path); if (!existsSync(parent)) privateDirectory(parent);
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const proof = assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: homedir() });
  if (!proof.ok) throw new Error('Website host directory is not private');
}
function hostEnv(): NodeJS.ProcessEnv {
  // Preserve native authenticated CLI configuration only in the host uploader.
  return { PATH: process.env['PATH'], HOME: homedir(), USER: process.env['USER'], TMPDIR: process.env['TMPDIR'],
    VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1', CI: '1' };
}
function run(file: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number } = {}): Promise<string> {
  return new Promise((done, fail) => execFile(file, [...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 60_000, ...options, windowsHide: true,
  }, (error, stdout) => error ? fail(new Error('Website host command failed; credentials and child output are not returned')) : done(stdout.trim())));
}
function assertToolchain(commission: WebsiteCommission): void {
  const pins = commission.toolchain;
  const tools = realpathSync(websiteToolsDir());
  for (const path of [pins.cli, pins.node]) {
    const canonical = realpathSync(path); const rel = relative(tools, canonical);
    if (canonical !== resolve(path) || rel.startsWith('..') || rel === '') throw new Error('Website publisher tool is outside its private toolchain');
  }
  if (fileDigest(pins.node) !== pins.nodeSha256 || fileDigest(pins.docker) !== pins.dockerSha256 ||
      inventoryToolTree(join(tools, `vercel-${WEBSITE_PROFILE.cliVersion}`)) !== pins.treeSha256 || !/^sha256:[a-f0-9]{64}$/.test(pins.image)) throw new Error('Website publisher toolchain changed');
  const tarball = readFileSync(join(tools, `vercel-${WEBSITE_PROFILE.cliVersion}`, `vercel-${WEBSITE_PROFILE.cliVersion}.tgz`));
  if (`sha512-${createHash('sha512').update(tarball).digest('base64')}` !== WEBSITE_PROFILE.cliIntegrity) throw new Error('Website CLI original npm artifact is unqualified');
  const pkg = object(JSON.parse(readFileSync(join(dirname(dirname(pins.cli)), 'package.json'), 'utf8')));
  if (pkg['name'] !== 'vercel' || pkg['version'] !== WEBSITE_PROFILE.cliVersion) throw new Error('Website publisher CLI version changed');
}
/** Inventory executable dependencies too; a package.json version alone never pins a publisher. */
export function inventoryToolTree(root: string): string {
  // The same no-symlink complete inventory is reused; tooling has no output config requirement.
  const inventory = (path: string): unknown => {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      const canonical = realpathSync(path); const rel = relative(root, canonical);
      if (rel.startsWith('..') || rel === '') throw new Error('Website toolchain link escapes its pinned root');
      return { path: relative(root, path), target: rel };
    }
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Website toolchain contains unsupported paths');
    if (stat.isFile()) return { path: relative(root, path), mode: Number(stat.mode & 0o777n), hash: fileDigest(path) };
    // npm bin symlinks are outside this inspected package/dependency tree.
    const children = requireDirectoryEntries(path);
    return { path: relative(root, path), mode: Number(stat.mode & 0o777n), children: children.map((name) => inventory(join(path, name))) };
  };
  return websiteDigest(inventory(root));
}
import { readdirSync } from 'node:fs';
function requireDirectoryEntries(path: string): string[] { return readdirSync(path).sort(); }

// Next/Vercel can spawn their own package installer after the first npm ci.
// Keep those installers offline and on the same qualified public cache too.
export const WEBSITE_OFFLINE_BUILD_ENV = Object.freeze({
  NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  NPM_CONFIG_CACHE: '/opt/phantom-publisher/npm-cache', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false',
});

/** Only browser-public, source-needed settings enter the credential-free builder. */
export async function readWebsitePublicBuildEnv(api: (endpoint: string) => Promise<Record<string, unknown>>): Promise<Record<string, string>> {
  const keys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST'];
  const production = (row: Record<string, unknown>): boolean => !row['gitBranch'] &&
    (row['target'] === 'production' || (Array.isArray(row['target']) && row['target'].includes('production')));
  const metadata = await api(`/v10/projects/${WEBSITE_PROFILE.projectId}/env?decrypt=false`);
  if (!Array.isArray(metadata['envs'])) throw new Error('Website public client configuration metadata is unavailable');
  const values: Record<string, string> = { NEXT_PUBLIC_PHANTOM_SITE_URL: 'https://phm.dev' };
  for (const key of keys) {
    const selected = metadata['envs'].filter((entry) => {
      const row = object(entry);
      return row['key'] === key && production(row);
    });
    if (selected.length > 1) throw new Error('Website public client configuration is ambiguous');
    if (selected.length === 0) continue;
    const row = object(selected[0]); const id = string(row['id']);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || row['type'] === 'sensitive' || row['type'] === 'secret') throw new Error('Website public client configuration is not readable public Config');
    // The single-variable endpoint cannot retrieve unrelated server credentials.
    const observed = await api(`/v1/projects/${WEBSITE_PROFILE.projectId}/env/${id}`);
    if ((observed['id'] !== undefined && observed['id'] !== id) || observed['key'] !== key || !production(observed) || observed['type'] === 'sensitive' || observed['type'] === 'secret') throw new Error('Website public client configuration identity changed');
    const value = string(observed['value']);
    if (value.length > 4096 || /[\r\n]/.test(value) || value.includes('\0')) throw new Error('Website public client configuration value is invalid');
    values[key] = value;
  }
  if (values['NEXT_PUBLIC_POSTHOG_KEY'] && !/^phc_[A-Za-z0-9_-]+$/.test(values['NEXT_PUBLIC_POSTHOG_KEY'])) throw new Error('Website public analytics key is invalid');
  if (values['NEXT_PUBLIC_POSTHOG_HOST'] && !/^https:\/\/(?:us|eu)\.i\.posthog\.com\/?$/.test(values['NEXT_PUBLIC_POSTHOG_HOST'])) throw new Error('Website public analytics host is invalid');
  const url = values['NEXT_PUBLIC_SUPABASE_URL']; const token = values['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  // The public website can precede separately commissioned Secrets Cloud.
  // Preserve a wholly absent service configuration, without inventing keys.
  if (!url && !token) return values;
  const ref = url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1];
  if (!ref || !token || !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Complete the existing website production Supabase public URL and anon key before commissioning');
  let claims: Record<string, unknown>;
  try { claims = object(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'))); }
  catch { throw new Error('Website public Supabase anon key is invalid'); }
  if (claims['role'] !== 'anon' || claims['ref'] !== ref) throw new Error('Website Supabase key is not the matching public anon key');
  return values;
}

export function createWebsiteHostAdapter(commission: WebsiteCommission, signal?: AbortSignal): WebsiteHostAdapter {
  const host = defaultHostMergeDeps();
  const assertRepositoryReadBuild = (): void => {
    const policy = evaluateStandingAuthority({ mode: 'fresh', surface: 'running' }).policy;
    if (signal?.aborted || killSwitchOn() || !policy || !policy.repos.some((r) => r.nameWithOwner === WEBSITE_PROFILE.repo)) throw new Error('Website repository read/build authority is unavailable');
  };
  const gh = async (suffix: string): Promise<unknown> => {
    assertRepositoryReadBuild();
    const minted = await host.token(WEBSITE_PROFILE.repo); assertRepositoryReadBuild();
    const reply = await host.transport({ method: 'GET', path: `/repos/${WEBSITE_PROFILE.repo}${suffix}`, token: minted.token });
    if (reply.status !== 200) throw new Error('Website GitHub source observation failed');
    return reply.body;
  };
  const vc = async (args: readonly string[], cwd?: string): Promise<string> => {
    assertToolchain(commission);
    return run(commission.toolchain.node, [commission.toolchain.cli, ...args, '--scope', WEBSITE_PROFILE.scope, '--non-interactive'], { cwd, env: hostEnv(), signal });
  };
  const api = async (endpoint: string): Promise<Record<string, unknown>> => object(JSON.parse(await vc(['api', endpoint, '--raw'])));
  const identities = async (): Promise<void> => {
    const actor = object((await api('/v2/user'))['user']);
    const project = await api(`/v9/projects/${WEBSITE_PROFILE.projectId}`);
    if (actor['id'] !== commission.actorId || project['id'] !== WEBSITE_PROFILE.projectId || project['accountId'] !== commission.teamId || project['name'] !== 'web' || project['rootDirectory'] !== WEBSITE_PROFILE.projectRootDirectory) throw new Error('Website Vercel account/project changed');
    for (const [key, value] of Object.entries(commission.projectSettings)) if (websiteDigest(project[key] ?? null) !== websiteDigest(value)) throw new Error('Website production build settings changed');
    if (websiteDigest(await readWebsitePublicBuildEnv(api)) !== websiteDigest(commission.publicBuildEnv)) throw new Error('Website production public client configuration changed');
  };
  const aliases = async (): Promise<Record<string, string | null>> => {
    const result: Record<string, string | null> = {}; let until: number | null = null;
    do {
      const page = await api(`/v9/projects/${WEBSITE_PROFILE.projectId}/domains${until === null ? '' : `?until=${until}`}`);
      if (!Array.isArray(page['domains'])) throw new Error('Website project domain set is unavailable');
      for (const entry of page['domains']) {
        const name = string(object(entry)['name']);
        if (Object.prototype.hasOwnProperty.call(result, name)) throw new Error('Website domain pagination repeated');
        const observation = await api(`/v4/aliases/${encodeURIComponent(name)}`);
        if (observation['alias'] !== name || observation['projectId'] !== WEBSITE_PROFILE.projectId) throw new Error('Website production alias is unbound');
        result[name] = string(object(observation['deployment'])['id']);
      }
      const pagination = object(page['pagination']); const next = pagination['next'];
      if (next !== null && next !== undefined && (!Number.isSafeInteger(next) || (until !== null && Number(next) >= until))) throw new Error('Website domain pagination is invalid');
      until = typeof next === 'number' ? next : null;
    } while (until !== null);
    if (websiteDigest(Object.keys(result).sort()) !== websiteDigest([...commission.domains].sort())) throw new Error('Website production domain set changed');
    return result;
  };
  const currentMerge = async (): Promise<string> => {
    const repo = object(await gh('')); const owner = object(repo['owner']);
    if (repo['id'] !== WEBSITE_PROFILE.repoId || owner['id'] !== WEBSITE_PROFILE.ownerId || repo['full_name'] !== WEBSITE_PROFILE.repo || repo['default_branch'] !== WEBSITE_PROFILE.branch) throw new Error('Website repository identity changed');
    const branch = object(await gh(`/branches/${WEBSITE_PROFILE.branch}`));
    if (branch['protected'] !== true) throw new Error('Website default branch is not protected');
    return sha(object(branch['commit'])['sha']);
  };
  const qualifySource = async (revision: string): Promise<WebsiteSource> => {
    if (await currentMerge() !== revision) throw new Error('Website source is no longer the current default branch');
    const commit = object(await gh(`/git/commits/${revision}`));
    const tree = sha(object(commit['tree'])['sha']);
    const pulls = await gh(`/commits/${revision}/pulls?per_page=100`);
    if (!Array.isArray(pulls) || pulls.length === 100) throw new Error('Website merged PR observation is incomplete');
    const merged = pulls.filter((row) => object(row)['merge_commit_sha'] === revision && object(row)['merged_at'] !== null && object(row)['state'] === 'closed');
    if (merged.length !== 1) throw new Error('Website revision has no unique normal merged PR');
    const pull = object(merged[0]); const base = object(pull['base']); const head = object(pull['head']);
    if (base['ref'] !== WEBSITE_PROFILE.branch || object(base['repo'])['id'] !== WEBSITE_PROFILE.repoId) throw new Error('Website PR base changed');
    const headSha = sha(head['sha']); const baseSha = sha(base['sha']);
    const headCommit = object(await gh(`/git/commits/${headSha}`));
    if (sha(object(headCommit['tree'])['sha']) !== tree) throw new Error('Merged website tree differs from its qualified PR head');
    const rules = await readRequiredChecks(WEBSITE_PROFILE.repo, WEBSITE_PROFILE.branch, host);
    const checks = await readHeadChecks(WEBSITE_PROFILE.repo, headSha, host);
    if (typeof rules === 'string' || typeof checks === 'string' || rules.rulesetsUnavailable || rules.strict !== true ||
        !rules.required.some((r) => r.context === 'ashlr/verify' && r.appId === '5089472') ||
        evaluateG7Checks({ enforcement: 'server', required: rules.required, runs: checks.runs, statuses: checks.statuses, pendingSinceMs: Date.now(), nowMs: Date.now() }).state !== 'green') throw new Error('Website required checks and App identity are not green');
    const rawRules = await gh(`/rules/branches/${WEBSITE_PROFILE.branch}?per_page=100`);
    if (!Array.isArray(rawRules) || rawRules.length === 100) throw new Error('Website effective rule definitions are incomplete');
    const definitions: unknown[] = [];
    for (const id of [...new Set(rawRules.map((row) => object(row)['ruleset_id']))]) {
      if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new Error('Website effective ruleset identity is unavailable');
      definitions.push(await gh(`/rulesets/${id}`));
    }
    // Include full rule parameters and bypass actors, not only required context names.
    return { merge: revision, head: headSha, base: baseSha, tree, pr: Number(pull['number']), rulesDigest: websiteDigest({ checks: rules.protectionDigest, effective: rawRules, definitions }) };
  };
  const operationRoot = (op: WebsiteOperation): string => join(authorityDir(), 'website-operations', op.id);
  const output = (op: WebsiteOperation): string => join(operationRoot(op), 'upload', '.vercel', 'output');
  const routeContract = async (base: string): Promise<void> => {
    const origin = new URL(base);
    if (origin.protocol !== 'https:' || (!origin.hostname.endsWith('.vercel.app') && origin.hostname !== WEBSITE_PROFILE.primaryDomain)) throw new Error('Website route origin is invalid');
    for (const route of WEBSITE_PROFILE.routes) {
      const response = await fetch(new URL(route, origin), { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Website public route is not available');
      const body = await response.text();
      if (body.length > 4 * 1024 * 1024 || !body.includes(`https://${WEBSITE_PROFILE.primaryDomain}${route === '/' ? '' : route}`) ||
          !/<title>[^<]*Phantom[^<]*<\/title>/i.test(body) || !/property=["']og:title["']/i.test(body) ||
          !body.includes(route === '/' ? 'Work with me' : 'Secrets')) throw new Error('Website public route contract failed');
    }
  };
  const deployment = async (op: WebsiteOperation): Promise<Record<string, unknown>> => {
    if (!op.deploymentId || !/^dpl_[A-Za-z0-9]+$/.test(op.deploymentId)) throw new Error('Website deployment ID is missing');
    const result = await api(`/v13/deployments/${op.deploymentId}`);
    if (result['id'] !== op.deploymentId || result['projectId'] !== WEBSITE_PROFILE.projectId || result['ownerId'] !== commission.teamId || object(result['team'])['id'] !== commission.teamId || result['target'] !== 'production' || result['readyState'] !== 'READY') throw new Error('Website staged deployment is not exact READY production');
    return result;
  };
  return {
    currentMerge, qualifySource, identities, aliases, output,
    build: async (op, source) => {
      assertToolchain(commission); assertRepositoryReadBuild();
      const root = operationRoot(op); privateDirectory(root);
      const sourceRoot = join(root, 'source');
      if (existsSync(sourceRoot)) throw new Error('Website build source already exists; no silent rebuild');
      privateDirectory(sourceRoot); privateDirectory(join(root, 'upload'));
      const mirror = await ensureMirror({ nameWithOwner: WEBSITE_PROFILE.repo, base: WEBSITE_PROFILE.branch }, { signal, githubToken: async () => (await host.token(WEBSITE_PROFILE.repo)).token });
      if (!mirror.ok || mirror.path !== mirrorPathFor(WEBSITE_PROFILE.repo) || mirror.headSha !== source.merge) throw new Error('Website trusted mirror is not the exact merge');
      const target = { workTree: mirror.path, gitDir: join(mirror.path, '.git'), layout: 'repo' as const };
      const tree = await runSafeGit({ ...target, args: ['rev-parse', `${source.merge}^{tree}`], noOptionalLocks: true, signal });
      if (!tree.ok || tree.stdout.trim() !== source.tree) throw new Error('Website mirror tree changed');
      const files = await runSafeGit({ ...target, args: ['ls-tree', '-rz', source.tree], noOptionalLocks: true, signal, maxOutputBytes: 32 * 1024 * 1024 });
      if (!files.ok) throw new Error('Website source listing failed');
      const sourceFiles = files.stdout.split('\0').filter(Boolean).map((item) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(item);
        if (!match || match[3]!.split('/').some((p) => p === '..' || p === '.' || p === '.git') || match[3]!.startsWith('/')) throw new Error('Website source contains unsupported paths or submodules');
        return { mode: match[1]!, oid: match[2]!, path: match[3]! };
      });
      // One bounded binary batch avoids launching a Git process per asset.
      const blobs = await new Promise<Buffer>((done, fail) => {
        const child = execFile('git', ['--no-pager', '--git-dir', target.gitDir, '-c', 'core.fsmonitor=false', 'cat-file', '--batch'],
          { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 60_000, signal, env: { PATH: process.env['PATH'], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } },
          (error, stdout) => error ? fail(new Error('Website blob materialization failed')) : done(stdout));
        child.stdin?.end(sourceFiles.map((entry) => entry.oid).join('\n')+'\n');
      });
      let cursor = 0;
      for (const entry of sourceFiles) {
        const lineEnd = blobs.indexOf(10, cursor);
        if (lineEnd === -1) throw new Error('Website binary source stream is truncated');
        const header = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(blobs.subarray(cursor,lineEnd).toString('ascii'));
        if (!header || header[1] !== entry.oid || !Number.isSafeInteger(Number(header[2]))) throw new Error('Website binary source object changed');
        const size = Number(header[2]); const end = lineEnd + 1 + size;
        if (end >= blobs.length || blobs[end] !== 10) throw new Error('Website binary source object is truncated');
        const bytes = blobs.subarray(lineEnd+1,end);
        if (createHash('sha1').update(`blob ${size}\0`).update(bytes).digest('hex') !== entry.oid) throw new Error('Website source blob hash changed');
        const file = join(sourceRoot, entry.path); privateDirectory(dirname(file));
        writeFileSync(file, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o700 : 0o600 }); cursor = end+1;
      }
      if (cursor !== blobs.length) throw new Error('Website binary source stream has trailing content');
      const prepared = join(root, 'prepared'); privateDirectory(prepared);
      writeFileSync(join(prepared, 'project.json'), JSON.stringify({ projectId: WEBSITE_PROFILE.projectId, orgId: commission.teamId, projectName: 'web', settings: commission.projectSettings }), { mode: 0o600, flag: 'wx' });
      writeFileSync(join(prepared, '.env.production.local'), Object.entries(commission.publicBuildEnv).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600, flag: 'wx' });
      const image = object(JSON.parse(await run(commission.toolchain.docker, ['image', 'inspect', commission.toolchain.image, '--format', '{{json .}}'], { env: hostEnv(), signal })));
      if (image['Id'] !== commission.toolchain.image || image['Os'] !== 'linux' || image['Architecture'] !== 'amd64') throw new Error('Website builder must be the commissioned Linux x64 image');
      const script = 'set -eu; mkdir -p /tmp/work /tmp/home; cp -R /source/. /tmp/work/; cd /tmp/work/apps/web; mkdir -p .vercel; cp /prepared/project.json .vercel/project.json; cp /prepared/.env.production.local .vercel/.env.production.local; npm ci --offline --ignore-scripts --cache /opt/phantom-publisher/npm-cache; node /opt/phantom-publisher/node_modules/vercel/dist/index.js build --prod --standalone --non-interactive; cp -R .vercel /output/';
      assertRepositoryReadBuild();
      // Reuse the existing verification admission and Stop/drain lease. Killing a Docker CLI alone
      // does not prove its container stopped, so remove only this exact source-owned container before release.
      await withVerificationSlot(mirror.path, async () => {
        let lease: ExecutionLease | null = null;
        const fence = await acquireOutwardMutationFenceAsync(2_000, { signal });
        if (!fence) throw new Error('Website build admission fence unavailable');
        try {
          assertRepositoryReadBuild();
          const registered = registerExecutionLease(fence, { runId: `website-${op.id}`, repoKey: mirror.path, engine: 'website-production-build', parentSignal: signal,
            shouldAbort: () => { try { assertRepositoryReadBuild(); return null; } catch { return 'website authority stopped'; } } });
          if (!registered.ok) throw new Error('Website build execution lease unavailable');
          lease = registered.lease;
        } finally { releaseOutwardMutationFence(fence); }
        const container = `phantom-website-${op.id}`;
        let buildError: unknown = null; let cleanupError: unknown = null;
        try {
          await run(commission.toolchain.docker, ['run', '--rm', '--name', container, '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', `--user=${userInfo().uid}:${userInfo().gid}`,
            ...Object.entries(WEBSITE_OFFLINE_BUILD_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777', '--mount', `type=bind,src=${sourceRoot},dst=/source,readonly`, '--mount', `type=bind,src=${prepared},dst=/prepared,readonly`, '--mount', `type=bind,src=${join(root, 'upload')},dst=/output`,
        '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'NEXT_TELEMETRY_DISABLED=1', '-e', 'VERCEL_TELEMETRY_DISABLED=1', commission.toolchain.image, '/bin/sh', '-c', script], { env: hostEnv(), signal: lease.signal, timeout: 30 * 60_000 });
        } catch (error) { buildError = error; } finally {
          try {
            // This cleanup is intentionally not passed the aborted run signal.
            await run(commission.toolchain.docker, ['container', 'rm', '--force', container], { env: hostEnv(), timeout: 30_000 });
          } catch {
            // --rm normally removed it already; inspect proves that absence instead of assuming cleanup.
            try {
              const exists = await run(commission.toolchain.docker, ['container', 'ls', '--all', '--filter', `name=^/${container}$`, '--format', '{{.ID}}'], { env: hostEnv(), timeout: 30_000 });
              if (exists) cleanupError = new Error('Website builder cleanup is incomplete');
            } catch { cleanupError = new Error('Website builder cleanup could not be verified'); }
          }
          if (!cleanupError) lease.release();
        }
        if (cleanupError) throw cleanupError;
        if (buildError) throw buildError;
      }, { signal });
      const config = object(JSON.parse(readFileSync(join(output(op), 'config.json'), 'utf8')));
      if (config['version'] !== 3) throw new Error('Website build output version is unsupported');
      return inventoryWebsiteOutput(output(op)).digest;
    },
    stage: async (op, authorize) => {
      const fence = await acquireOutwardMutationFenceAsync(2_000, { signal }); if (!fence) throw new Error('Website upload mutation fence unavailable');
      try {
        assertWebsiteAuthority(commission);
        if (inventoryWebsiteOutput(output(op)).digest !== op.outputDigest) throw new Error('Website output changed before upload');
        await authorize();
        const url = await vc(['deploy', '--prebuilt', '--prod', '--skip-domain', '--yes'], join(operationRoot(op), 'upload'));
        const parsed = new URL(url); if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.vercel.app') || parsed.pathname !== '/') throw new Error('Website upload returned no exact deployment URL');
        const observed = await api(`/v13/deployments/${encodeURIComponent(parsed.hostname)}`);
        return { id: string(observed['id']), url: parsed.origin };
      } finally { releaseOutwardMutationFence(fence); }
    },
    validateStage: async (op) => { const observed = await deployment(op); if (`https://${string(observed['url'])}` !== op.deploymentUrl) throw new Error('Website staged URL changed'); await routeContract(op.deploymentUrl!); },
    promote: async (op, authorize) => {
      const fence = await acquireOutwardMutationFenceAsync(2_000, { signal }); if (!fence) throw new Error('Website promotion mutation fence unavailable');
      try { assertWebsiteAuthority(commission); await deployment(op); assertWebsiteAuthority(commission); await authorize(); await vc(['promote', op.deploymentId!, '--yes']); }
      finally { releaseOutwardMutationFence(fence); }
    },
    published: async (op) => {
      try { await identities(); await deployment(op); const observed = await aliases();
        if (Object.values(observed).some((id) => id !== op.deploymentId)) return false;
        await routeContract(`https://${WEBSITE_PROFILE.primaryDomain}`); return true;
      } catch { return false; }
    },
  };
}

/** Read-only preflight. No login, new credentials, environment pull, deploy or domain mutation. */
export async function prepareWebsiteCommission(input: { image: string }): Promise<WebsiteCommission> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new Error('Exact qualified Linux publisher image digest is required');
  const toolRoot = join(websiteToolsDir(), `vercel-${WEBSITE_PROFILE.cliVersion}`);
  const node = join(toolRoot, 'node'); const cli = join(toolRoot, 'node_modules', 'vercel', 'dist', 'index.js');
  const docker = realpathSync('/usr/local/bin/docker');
  const call = async (args: string[]) => object(JSON.parse(await run(node, [cli, ...args, '--scope', WEBSITE_PROFILE.scope, '--non-interactive'], { env: hostEnv() })));
  const user = object((await call(['api', '/v2/user', '--raw']))['user']);
  const project = await call(['api', `/v9/projects/${WEBSITE_PROFILE.projectId}`, '--raw']);
  if (project['id'] !== WEBSITE_PROFILE.projectId || project['rootDirectory'] !== WEBSITE_PROFILE.projectRootDirectory || project['name'] !== 'web') throw new Error('Fixed website project identity is unavailable');
  const settings: Record<string, unknown> = {};
  for (const key of ['framework','buildCommand','installCommand','outputDirectory','nodeVersion','rootDirectory']) settings[key] = project[key] ?? null;
  const domains: string[] = []; let until: number | null = null;
  do {
    const page = await call(['api', `/v9/projects/${WEBSITE_PROFILE.projectId}/domains${until === null ? '' : `?until=${until}`}`, '--raw']);
    if (!Array.isArray(page['domains'])) throw new Error('Website domain metadata is unavailable');
    for (const d of page['domains']) domains.push(string(object(d)['name']));
    const next = object(page['pagination'])['next'];
    if (next !== null && next !== undefined && (!Number.isSafeInteger(next) || (until !== null && Number(next) >= until))) throw new Error('Website domain pagination is invalid');
    until = typeof next === 'number' ? next : null;
  } while (until !== null);
  const image = object(JSON.parse(await run(docker, ['image', 'inspect', input.image, '--format', '{{json .}}'], { env: hostEnv() })));
  if (image['Id'] !== input.image || image['Os'] !== 'linux' || image['Architecture'] !== 'amd64') throw new Error('Website publisher image is not exact Linux x64');
  const payload = { v: 1 as const, profile: WEBSITE_PROFILE, actorId: string(user['id']), teamId: string(project['accountId']), domains: domains.sort(), projectSettings: settings,
    publicBuildEnv: await readWebsitePublicBuildEnv((endpoint) => call(['api', endpoint, '--raw'])),
    toolchain: { node, nodeSha256: fileDigest(node), cli, treeSha256: inventoryToolTree(toolRoot), image: input.image, docker, dockerSha256: fileDigest(docker) } };
  const provisional = { ...payload, builderQualification: { source: { merge: '0'.repeat(40), head: '0'.repeat(40), base: '0'.repeat(40), tree: '0'.repeat(40), pr: 0, rulesDigest: '0'.repeat(64) }, outputDigest: '0'.repeat(64), image: input.image } };
  const result = { ...provisional, profileDigest: websiteDigest(provisional) };
  assertToolchain(result);
  // This no-network probe proves exact CLI availability, not that a website source build succeeds.
  const version = await run(docker, ['run','--rm','--pull=never','--platform=linux/amd64','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',input.image,'node','/opt/phantom-publisher/node_modules/vercel/dist/index.js','--version'], { env: hostEnv() });
  if (!version.includes(WEBSITE_PROFILE.cliVersion)) throw new Error('Website Linux publisher CLI version is unavailable');
  const adapter = createWebsiteHostAdapter(result);
  const source = await adapter.qualifySource(await adapter.currentMerge());
  const op: WebsiteOperation = { v: 1, id: randomBytes(32).toString('hex'), revision: source.merge, profileDigest: result.profileDigest, phase: 'building', at: new Date().toISOString(), reason: null };
  const outputDigest = await adapter.build(op, source);
  const qualified = { ...payload, builderQualification: { source, outputDigest, image: input.image } };
  return { ...qualified, profileDigest: websiteDigest(qualified) };
}
