/**
 * Read-only ecosystem doctor.
 *
 * Scans immediate sibling repositories under a root directory and reports
 * git/package/docs health. This module intentionally never runs package
 * managers, package scripts, builds, or tests, and never writes files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

export type EcosystemDoctorStatus = 'pass' | 'warn' | 'fail';

export interface EcosystemDoctorCheck {
  id: string;
  label: string;
  status: EcosystemDoctorStatus;
  detail: string;
  repo?: string;
  path?: string;
}

export interface EcosystemDoctorSummary {
  pass: number;
  warn: number;
  fail: number;
  total: number;
}

export interface EcosystemDoctorRepo {
  name: string;
  path: string;
  summary: EcosystemDoctorSummary;
  checks: EcosystemDoctorCheck[];
  git: {
    branch: string | null;
    dirty: number;
    ahead: number;
    behind: number;
    lastCommitAt: string | null;
  } | null;
  package: {
    name: string | null;
    version: string | null;
    packageManager: string | null;
    scripts: string[];
    dependencies: number;
    devDependencies: number;
  } | null;
  docs: {
    readme: boolean;
    docsMarkdown: number;
  };
}

export interface EcosystemDoctorReport {
  generatedAt: string;
  root: string;
  summary: EcosystemDoctorSummary & { repos: number };
  checks: EcosystemDoctorCheck[];
  repos: EcosystemDoctorRepo[];
}

export interface EcosystemDoctorOptions {
  root?: string;
  deep?: boolean;
  now?: Date;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

interface PackageInfo {
  name: string | null;
  version: string | null;
  packageManager: string | null;
  scripts: string[];
  dependencies: number;
  devDependencies: number;
}

function makeCheck(
  id: string,
  label: string,
  status: EcosystemDoctorStatus,
  detail: string,
  repo?: string,
  path?: string,
): EcosystemDoctorCheck {
  const check: EcosystemDoctorCheck = { id, label, status, detail };
  if (repo !== undefined) check.repo = repo;
  if (path !== undefined) check.path = path;
  return check;
}

function summarize(checks: EcosystemDoctorCheck[]): EcosystemDoctorSummary {
  const summary: EcosystemDoctorSummary = { pass: 0, warn: 0, fail: 0, total: checks.length };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return summary;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function nearestRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultEcosystemRoot(startDir = process.cwd()): string {
  const repoRoot = nearestRepoRoot(startDir);
  return dirname(repoRoot ?? resolve(startDir));
}

function resolveRoot(root: string | undefined): string {
  return resolve(root ?? defaultEcosystemRoot());
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build';
}

function looksLikeRepo(path: string): boolean {
  return existsSync(join(path, '.git')) || existsSync(join(path, 'package.json'));
}

function discoverRepos(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !shouldSkipDir(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((path) => looksLikeRepo(path))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

function runGit(repoPath: string, args: string[]): GitResult {
  try {
    const result = spawnSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    return {
      ok: !result.error && result.status === 0,
      stdout,
      stderr,
      status: result.status,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      status: null,
    };
  }
}

function parseBranchHeader(header: string): { branch: string | null; ahead: number; behind: number } {
  const branchText = header.replace(/^##\s+/, '').trim();
  const ahead = Number(branchText.match(/ahead\s+(\d+)/)?.[1] ?? 0);
  const behind = Number(branchText.match(/behind\s+(\d+)/)?.[1] ?? 0);
  const name = branchText
    .replace(/\s+\[.*\]$/, '')
    .replace(/^No commits yet on\s+/, '')
    .split('...')[0]
    ?.trim();
  return {
    branch: name && name !== 'HEAD (no branch)' ? name : null,
    ahead,
    behind,
  };
}

function checkGit(repoPath: string, repoName: string, deep: boolean, nowMs: number): {
  checks: EcosystemDoctorCheck[];
  git: EcosystemDoctorRepo['git'];
} {
  const checks: EcosystemDoctorCheck[] = [];
  const inside = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    checks.push(makeCheck(
      'git',
      'Git',
      'fail',
      inside.stderr || 'not a readable git work tree',
      repoName,
      repoPath,
    ));
    return { checks, git: null };
  }

  const status = runGit(repoPath, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
  if (!status.ok) {
    checks.push(makeCheck('git', 'Git', 'fail', status.stderr || 'git status failed', repoName, repoPath));
    return { checks, git: null };
  }

  const lines = status.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const header = lines.find((line) => line.startsWith('## ')) ?? '## unknown';
  const dirty = lines.filter((line) => !line.startsWith('## ')).length;
  const branch = parseBranchHeader(header);
  const syncBits: string[] = [];
  if (dirty > 0) syncBits.push(`${dirty} dirty/untracked`);
  if (branch.ahead > 0) syncBits.push(`ahead ${branch.ahead}`);
  if (branch.behind > 0) syncBits.push(`behind ${branch.behind}`);
  checks.push(makeCheck(
    'git',
    'Git',
    syncBits.length === 0 ? 'pass' : 'warn',
    syncBits.length === 0
      ? `clean on ${branch.branch ?? 'detached HEAD'}`
      : `${branch.branch ?? 'detached HEAD'}: ${syncBits.join(', ')}`,
    repoName,
    repoPath,
  ));

  let lastCommitAt: string | null = null;
  if (deep) {
    const log = runGit(repoPath, ['log', '-1', '--format=%cI']);
    if (log.ok && log.stdout) {
      lastCommitAt = log.stdout;
      const ageDays = Math.floor((nowMs - Date.parse(log.stdout)) / 86_400_000);
      checks.push(makeCheck(
        'git-recent',
        'Git recency',
        ageDays > 90 ? 'warn' : 'pass',
        ageDays > 90 ? `last commit ${ageDays}d ago` : `last commit ${ageDays}d ago`,
        repoName,
        repoPath,
      ));
    } else {
      checks.push(makeCheck(
        'git-recent',
        'Git recency',
        'warn',
        'no commits found',
        repoName,
        repoPath,
      ));
    }
  }

  return {
    checks,
    git: {
      branch: branch.branch,
      dirty,
      ahead: branch.ahead,
      behind: branch.behind,
      lastCommitAt,
    },
  };
}

function countObjectKeys(value: unknown): number {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0;
}

function readPackage(repoPath: string): { check: EcosystemDoctorCheck; info: PackageInfo | null } {
  const repoName = basename(repoPath);
  const packagePath = join(repoPath, 'package.json');
  if (!existsSync(packagePath)) {
    return {
      check: makeCheck('package', 'Package', 'warn', 'package.json not found', repoName, repoPath),
      info: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    const scriptsValue = parsed.scripts;
    const scripts = scriptsValue && typeof scriptsValue === 'object' && !Array.isArray(scriptsValue)
      ? Object.keys(scriptsValue as Record<string, unknown>).sort()
      : [];
    const info: PackageInfo = {
      name: typeof parsed.name === 'string' ? parsed.name : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : null,
      scripts,
      dependencies: countObjectKeys(parsed.dependencies),
      devDependencies: countObjectKeys(parsed.devDependencies),
    };
    const missing: string[] = [];
    if (!info.name) missing.push('name');
    if (!info.version) missing.push('version');
    return {
      check: makeCheck(
        'package',
        'Package',
        missing.length === 0 ? 'pass' : 'warn',
        missing.length === 0
          ? `${info.name}@${info.version}; ${scripts.length} script(s)`
          : `valid package.json; missing ${missing.join(', ')}`,
        repoName,
        repoPath,
      ),
      info,
    };
  } catch (err) {
    return {
      check: makeCheck(
        'package',
        'Package',
        'fail',
        `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        repoName,
        repoPath,
      ),
      info: null,
    };
  }
}

function hasLockfile(repoPath: string): boolean {
  return [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ].some((name) => existsSync(join(repoPath, name)));
}

function checkPackageLock(repoPath: string, info: PackageInfo | null): EcosystemDoctorCheck | null {
  if (!info) return null;
  const depCount = info.dependencies + info.devDependencies;
  if (depCount === 0) {
    return makeCheck('package-lock', 'Package lock', 'pass', 'no dependencies declared', basename(repoPath), repoPath);
  }
  return makeCheck(
    'package-lock',
    'Package lock',
    hasLockfile(repoPath) ? 'pass' : 'warn',
    hasLockfile(repoPath) ? `lockfile present for ${depCount} dependency entries` : `no lockfile for ${depCount} dependency entries`,
    basename(repoPath),
    repoPath,
  );
}

function findReadme(repoPath: string): string | null {
  for (const name of ['README.md', 'Readme.md', 'readme.md']) {
    const path = join(repoPath, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function countDocsMarkdown(repoPath: string): number {
  const docsDir = join(repoPath, 'docs');
  if (!isDirectory(docsDir)) return 0;
  try {
    return readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

function checkDocs(repoPath: string): { check: EcosystemDoctorCheck; docs: EcosystemDoctorRepo['docs'] } {
  const readmePath = findReadme(repoPath);
  const docsMarkdown = countDocsMarkdown(repoPath);
  const ok = readmePath !== null || docsMarkdown > 0;
  return {
    check: makeCheck(
      'docs',
      'Docs',
      ok ? 'pass' : 'warn',
      ok
        ? `${readmePath ? 'README present' : 'no README'}; ${docsMarkdown} docs markdown file(s)`
        : 'no README.md or docs/*.md found',
      basename(repoPath),
      repoPath,
    ),
    docs: {
      readme: readmePath !== null,
      docsMarkdown,
    },
  };
}

function checkDocsDepth(repoPath: string): EcosystemDoctorCheck {
  const supportingDocs = ['CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'ARCHITECTURE.md']
    .filter((name) => existsSync(join(repoPath, name)));
  return makeCheck(
    'docs-depth',
    'Docs depth',
    supportingDocs.length > 0 ? 'pass' : 'warn',
    supportingDocs.length > 0
      ? `supporting docs: ${supportingDocs.join(', ')}`
      : 'no supporting docs found (CONTRIBUTING, CHANGELOG, SECURITY, or ARCHITECTURE)',
    basename(repoPath),
    repoPath,
  );
}

function scanRepo(repoPath: string, deep: boolean, nowMs: number): EcosystemDoctorRepo {
  const repoName = basename(repoPath);
  const checks: EcosystemDoctorCheck[] = [];
  const git = checkGit(repoPath, repoName, deep, nowMs);
  checks.push(...git.checks);

  const packageResult = readPackage(repoPath);
  checks.push(packageResult.check);
  if (deep) {
    const lockCheck = checkPackageLock(repoPath, packageResult.info);
    if (lockCheck) checks.push(lockCheck);
  }

  const docs = checkDocs(repoPath);
  checks.push(docs.check);
  if (deep) checks.push(checkDocsDepth(repoPath));

  return {
    name: repoName,
    path: repoPath,
    summary: summarize(checks),
    checks,
    git: git.git,
    package: packageResult.info,
    docs: docs.docs,
  };
}

export async function runEcosystemDoctor(options: EcosystemDoctorOptions = {}): Promise<EcosystemDoctorReport> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const root = resolveRoot(options.root);
  const deep = options.deep === true;
  const checks: EcosystemDoctorCheck[] = [];
  let repos: EcosystemDoctorRepo[] = [];

  if (!isDirectory(root)) {
    checks.push(makeCheck('root', 'Root', 'fail', 'root does not exist or is not a directory', undefined, root));
    const summary = { ...summarize(checks), repos: 0 };
    return { generatedAt, root, summary, checks, repos };
  }

  checks.push(makeCheck('root', 'Root', 'pass', 'root is readable', undefined, root));

  try {
    const repoPaths = discoverRepos(root);
    checks.push(makeCheck(
      'discovery',
      'Discovery',
      repoPaths.length > 0 ? 'pass' : 'warn',
      repoPaths.length > 0 ? `${repoPaths.length} sibling repo(s) found` : 'no sibling repos found',
      undefined,
      root,
    ));
    repos = repoPaths.map((repoPath) => scanRepo(repoPath, deep, now.getTime()));
  } catch (err) {
    checks.push(makeCheck(
      'discovery',
      'Discovery',
      'fail',
      `could not scan root: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      root,
    ));
  }

  const allChecks = checks.concat(repos.flatMap((repo) => repo.checks));
  const summary = { ...summarize(allChecks), repos: repos.length };
  return { generatedAt, root, summary, checks: allChecks, repos };
}
