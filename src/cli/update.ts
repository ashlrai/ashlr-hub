/**
 * `ashlr update` — safe self-update for ashlr-hub.
 *
 * Usage:
 *   ashlr update [--check] [--json]
 *
 * Flags:
 *   --check   Report whether an update is available (git fetch + compare) without applying.
 *   --json    Emit UpdateResult JSON on stdout; human text goes to stderr.
 *
 * Behaviour:
 *   1. Detect the repo root from this file's location (import.meta.url).
 *   2. If no git remote is configured, report "no remote configured — update is a no-op" (exit 0).
 *   3. Abort on a dirty working tree — tell the user to commit first (exit 1).
 *   4. --check: git fetch + compare HEAD..origin/<branch>; exit 0 if up-to-date, exit 0 if
 *      updates are available (it's informational only; never modifies anything).
 *   5. Normal update: git pull --ff-only, npm install, npm run build, then verify
 *      `ashlr --version` / `ashlr help` works and the ~/.local/bin symlink points here.
 *   6. Print a clear before/after version line.
 *
 * Safety guarantees:
 *   - NEVER force-push, reset, rebase, or do any other destructive git operation.
 *   - NEVER pushes to the remote.
 *   - Aborts immediately on dirty working tree.
 *   - Only uses git pull --ff-only (fails if the remote diverged; user must resolve).
 *
 * Exit codes:
 *   0  success (or up-to-date / no-remote)
 *   1  update failed, dirty tree, or other error
 *   2  bad usage
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readlinkSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const IS_TTY = process.stdout.isTTY === true;

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
} as const;

function colorize(code: string, s: string): string {
  if (!IS_TTY) return s;
  return `${code}${s}${C.reset}`;
}

function bold(s: string):   string { return colorize(C.bold,   s); }
function dim(s: string):    string { return colorize(C.dim,    s); }
function red(s: string):    string { return colorize(C.red,    s); }
function green(s: string):  string { return colorize(C.green,  s); }
function yellow(s: string): string { return colorize(C.yellow, s); }
function cyan(s: string):   string { return colorize(C.cyan,   s); }
function gray(s: string):   string { return colorize(C.gray,   s); }

// ---------------------------------------------------------------------------
// Repo / version helpers
// ---------------------------------------------------------------------------

/** Detect the repo root by walking up from this file's compiled location. */
function detectRepoRoot(): string {
  // In production: __filename is dist/cli/update.js → go up two levels to reach repo root.
  // In source: src/cli/update.ts → same structure.
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli → dist → repo root
  return resolve(here, '..', '..');
}

/** Read the version from package.json in the repo root. Returns null on error. */
function readPackageVersion(repoRoot: string): string | null {
  try {
    // Use createRequire to load the JSON; avoids import assertions that vary by Node version.
    const req = createRequire(import.meta.url);
    const pkg = req(join(repoRoot, 'package.json')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function gitRun(args: string[], cwd: string): GitRunResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    // Do NOT inherit stdio — we capture for JSON/clean output.
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

/** Return true when git is on PATH. */
function gitAvailable(): boolean {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0;
}

/** Return the list of configured remote names (empty array if none). */
function getRemoteNames(cwd: string): string[] {
  const r = gitRun(['remote'], cwd);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

/** Return true when the working tree has uncommitted changes. */
function isWorkingTreeDirty(cwd: string): boolean {
  // --porcelain exits 0 and produces output when dirty.
  const r = gitRun(['status', '--porcelain'], cwd);
  return r.ok && r.stdout.length > 0;
}

/** Return the current branch name. Falls back to 'HEAD' on detached HEAD. */
function getCurrentBranch(cwd: string): string {
  const r = gitRun(['symbolic-ref', '--short', 'HEAD'], cwd);
  if (r.ok && r.stdout) return r.stdout;
  // Detached HEAD
  const rev = gitRun(['rev-parse', '--short', 'HEAD'], cwd);
  return rev.ok ? rev.stdout : 'HEAD';
}

/** Return the short commit hash for a ref. */
function getCommitHash(ref: string, cwd: string): string | null {
  const r = gitRun(['rev-parse', '--short', ref], cwd);
  return r.ok ? r.stdout : null;
}

/** Fetch from the default remote (non-destructive). */
function gitFetch(remote: string, cwd: string): { ok: boolean; error: string } {
  const r = gitRun(['fetch', remote], cwd);
  return { ok: r.ok, error: r.stderr };
}

/**
 * Count commits in <a>..<b>.
 * Returns { count, error } where count is null on failure.
 */
function countCommitsBetween(
  from: string,
  to: string,
  cwd: string,
): { count: number | null; error: string } {
  const r = gitRun(['rev-list', '--count', `${from}..${to}`], cwd);
  if (!r.ok) return { count: null, error: r.stderr };
  const n = parseInt(r.stdout, 10);
  return { count: isNaN(n) ? 0 : n, error: '' };
}

// ---------------------------------------------------------------------------
// npm helpers
// ---------------------------------------------------------------------------

interface NpmRunResult {
  ok: boolean;
  output: string; // combined stdout+stderr
}

function npmRun(args: string[], cwd: string): NpmRunResult {
  try {
    const out = execFileSync('npm', args, {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout ?? '', e.stderr ?? '', e.message ?? ''].join('\n');
    return { ok: false, output: combined };
  }
}

// ---------------------------------------------------------------------------
// Symlink verification
// ---------------------------------------------------------------------------

interface SymlinkCheck {
  path: string;
  ok: boolean;
  pointsHere: boolean;
  target: string | null;
  detail: string;
}

/**
 * Verify that ~/.local/bin/ashlr is a symlink that resolves to the bin/ashlr
 * in this repo root.
 */
function checkSymlink(repoRoot: string): SymlinkCheck {
  const symlinkPath = join(homedir(), '.local', 'bin', 'ashlr');
  const expectedTarget = join(repoRoot, 'bin', 'ashlr');

  if (!existsSync(symlinkPath)) {
    return {
      path: symlinkPath,
      ok: false,
      pointsHere: false,
      target: null,
      detail: `symlink not found at ${symlinkPath}`,
    };
  }

  let target: string | null = null;
  try {
    const stat = lstatSync(symlinkPath);
    if (stat.isSymbolicLink()) {
      // readlinkSync gives the raw link target (may be relative).
      const rawTarget = readlinkSync(symlinkPath);
      // Resolve relative to the symlink's directory.
      target = resolve(dirname(symlinkPath), rawTarget);
    } else {
      // Not a symlink — could be a copy or an install script wrote it directly.
      return {
        path: symlinkPath,
        ok: true, // it exists and is executable; not our concern
        pointsHere: false,
        target: null,
        detail: `${symlinkPath} exists but is not a symlink (real file)`,
      };
    }
  } catch (err) {
    return {
      path: symlinkPath,
      ok: false,
      pointsHere: false,
      target: null,
      detail: `failed to read symlink: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const pointsHere = target === expectedTarget;
  return {
    path: symlinkPath,
    ok: true,
    pointsHere,
    target,
    detail: pointsHere
      ? `${symlinkPath} → ${target}`
      : `${symlinkPath} → ${target} (expected ${expectedTarget})`,
  };
}

// ---------------------------------------------------------------------------
// Smoke-test: verify ashlr still works after update
// ---------------------------------------------------------------------------

interface SmokeResult {
  ok: boolean;
  detail: string;
}

function smokeTest(repoRoot: string): SmokeResult {
  const binPath = join(repoRoot, 'bin', 'ashlr');
  const node = process.execPath;

  // Try `ashlr help` via absolute bin path.
  const r = spawnSync(node, [binPath, 'help'], {
    encoding: 'utf8',
    timeout: 15_000,
  });

  if (r.status === 0) {
    return { ok: true, detail: 'ashlr help exited 0' };
  }
  return {
    ok: false,
    detail: `ashlr help exited ${r.status ?? '?'}: ${(r.stderr ?? '').slice(0, 200)}`,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface UpdateResult {
  /** true = an update was available and pulled */
  updated: boolean;
  /** When --check was used: whether upstream has new commits */
  upToDate: boolean | null;
  /** Number of new commits fetched (null when not checked / unknown) */
  newCommits: number | null;
  versionBefore: string | null;
  versionAfter: string | null;
  commitBefore: string | null;
  commitAfter: string | null;
  remotes: string[];
  branch: string;
  symlink: SymlinkCheck | null;
  smokeOk: boolean | null;
  message: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedUpdateArgs {
  check: boolean;
  json: boolean;
  usageError?: string;
}

function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const result: ParsedUpdateArgs = { check: false, json: false };

  for (const arg of args) {
    if (arg === '--check') {
      result.check = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      // handled upstream
    } else {
      result.usageError = `unknown flag: ${arg}`;
      return result;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Human output helpers
// ---------------------------------------------------------------------------

function out(line: string, jsonMode: boolean): void {
  // In JSON mode human text goes to stderr; stdout is reserved for the JSON payload.
  if (jsonMode) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function printHelp(): void {
  console.log('');
  console.log(bold('  ashlr update') + dim(' — safe self-update'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr update ${cyan('[--check]')} ${cyan('[--json]')}`);
  console.log('');
  console.log('  ' + bold('Flags:'));
  console.log('');
  console.log(`    ${cyan('--check')}   Report if an update is available without applying it.`);
  console.log(`    ${cyan('--json')}    Emit UpdateResult JSON on stdout; human text to stderr.`);
  console.log('');
  console.log('  ' + bold('Safety:'));
  console.log('');
  console.log(`    ${dim('• Only uses git pull --ff-only — never force-push/reset/rebase.')}`);
  console.log(`    ${dim('• Aborts on a dirty working tree (commit your changes first).')}`);
  console.log(`    ${dim('• If no remote is configured, reports no-op and exits 0.')}`);
  console.log('');
  console.log('  ' + bold('Exit codes:'));
  console.log('');
  console.log(`    ${dim('0  success (or already up-to-date / no remote)')}`);
  console.log(`    ${dim('1  update failed, dirty tree, or other error')}`);
  console.log(`    ${dim('2  bad usage')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdUpdate — main entry point
// ---------------------------------------------------------------------------

export async function cmdUpdate(args: string[]): Promise<number> {
  // Help shortcircuit
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp();
    return 0;
  }

  const parsed = parseUpdateArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  const jsonMode = parsed.json;

  // ── Detect repo root ───────────────────────────────────────────────────────

  const repoRoot = detectRepoRoot();

  out('', jsonMode);
  out(bold('  ashlr update') + gray(`  —  ${repoRoot}`), jsonMode);
  out('', jsonMode);

  // ── Check git availability ─────────────────────────────────────────────────

  if (!gitAvailable()) {
    const msg = 'git not found on PATH — update requires git';
    process.stderr.write(red('error: ') + msg + '\n');
    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore: null, versionAfter: null,
        commitBefore: null, commitAfter: null,
        remotes: [], branch: '',
        symlink: null, smokeOk: null,
        message: msg, error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  // ── Check for git repo ─────────────────────────────────────────────────────

  const gitCheck = gitRun(['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!gitCheck.ok) {
    const msg = `${repoRoot} is not a git repository — update requires a git checkout`;
    process.stderr.write(red('error: ') + msg + '\n');
    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore: null, versionAfter: null,
        commitBefore: null, commitAfter: null,
        remotes: [], branch: '',
        symlink: null, smokeOk: null,
        message: msg, error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  // ── Check for remote ──────────────────────────────────────────────────────

  const remotes = getRemoteNames(repoRoot);
  const branch = getCurrentBranch(repoRoot);

  if (remotes.length === 0) {
    const msg = 'no remote configured — update is a no-op';
    out(`  ${yellow('!')}  ${msg}`, jsonMode);
    out('', jsonMode);
    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: true, newCommits: 0,
        versionBefore: readPackageVersion(repoRoot), versionAfter: null,
        commitBefore: getCommitHash('HEAD', repoRoot), commitAfter: null,
        remotes, branch,
        symlink: null, smokeOk: null,
        message: msg, error: null,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 0;
  }

  const remote = remotes[0]!; // prefer 'origin' if present, else first

  // Prefer 'origin' if it exists in the list.
  const preferredRemote = remotes.includes('origin') ? 'origin' : remote;

  // ── Snapshot before-state ─────────────────────────────────────────────────

  const versionBefore = readPackageVersion(repoRoot);
  const commitBefore  = getCommitHash('HEAD', repoRoot);

  out(`  ${dim('remote:')}  ${cyan(preferredRemote)}`, jsonMode);
  out(`  ${dim('branch:')}  ${cyan(branch)}`, jsonMode);
  if (versionBefore) {
    out(`  ${dim('version:')} ${cyan(versionBefore)}  ${dim(`(${commitBefore ?? '?'})`)}`, jsonMode);
  }
  out('', jsonMode);

  // ── Dirty working tree check ───────────────────────────────────────────────

  if (isWorkingTreeDirty(repoRoot)) {
    const msg =
      'working tree has uncommitted changes — please commit or stash them before updating';
    out(`  ${red('✗')}  ${bold('Dirty working tree')}`, jsonMode);
    out(`  ${dim(msg)}`, jsonMode);
    out(`  ${dim('Run:')}  ${cyan('git status')}  ${dim('to see what changed.')}`, jsonMode);
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore, versionAfter: null,
        commitBefore, commitAfter: null,
        remotes, branch,
        symlink: null, smokeOk: null,
        message: msg, error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────

  out(`  ${dim('Fetching from')} ${cyan(preferredRemote)}${dim('…')}`, jsonMode);

  const fetchResult = gitFetch(preferredRemote, repoRoot);
  if (!fetchResult.ok) {
    const msg = `git fetch failed: ${fetchResult.error}`;
    out(`  ${yellow('!')}  ${msg}`, jsonMode);
    out(`  ${dim('Continuing with local state only.')}`, jsonMode);
    out('', jsonMode);
    // Non-fatal: we can still check / pull if network was flaky but the ref exists.
    // For --check we need fetch to succeed to give accurate info; report the error.
  }

  // ── Determine remote tracking ref ─────────────────────────────────────────

  const remoteRef = `${preferredRemote}/${branch}`;

  // Check the remote ref exists (may not if the remote is bare or branch name differs).
  const remoteRefCheck = gitRun(['rev-parse', '--verify', remoteRef], repoRoot);
  const hasRemoteRef = remoteRefCheck.ok;

  // ── --check mode: just report availability ────────────────────────────────

  if (parsed.check) {
    let upToDate = true;
    let newCommits: number | null = null;

    if (hasRemoteRef) {
      const { count, error } = countCommitsBetween('HEAD', remoteRef, repoRoot);
      if (error) {
        out(`  ${yellow('!')}  Could not count commits: ${error}`, jsonMode);
      } else {
        newCommits = count;
        upToDate = (count ?? 0) === 0;
      }
    } else {
      out(`  ${yellow('!')}  Remote ref ${cyan(remoteRef)} not found — cannot compare`, jsonMode);
    }

    if (upToDate) {
      out(`  ${green('✓')}  ${bold('Up to date')}  ${dim(`(${commitBefore ?? '?'})`)}`, jsonMode);
    } else {
      out(
        `  ${yellow('!')}  ${bold(`${newCommits} new commit(s) available`)}` +
        `  ${dim(`on ${remoteRef}`)}`,
        jsonMode,
      );
      out(`  ${dim('Run')}  ${cyan('ashlr update')}  ${dim('to apply.')}`, jsonMode);
    }
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate, newCommits,
        versionBefore, versionAfter: null,
        commitBefore, commitAfter: null,
        remotes, branch,
        symlink: null, smokeOk: null,
        message: upToDate
          ? 'already up to date'
          : `${newCommits ?? '?'} new commit(s) available`,
        error: null,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 0;
  }

  // ── Apply update: git pull --ff-only ──────────────────────────────────────

  out(`  ${dim('Running')} ${cyan('git pull --ff-only')}${dim('…')}`, jsonMode);

  const pullResult = gitRun(['pull', '--ff-only', preferredRemote, branch], repoRoot);

  if (!pullResult.ok) {
    const msg =
      `git pull --ff-only failed: ${pullResult.stderr || pullResult.stdout}\n` +
      `This means the remote has diverged from your local branch.\n` +
      `Resolve manually: git pull (merge/rebase) or git reset`;
    out(`  ${red('✗')}  ${bold('Pull failed')}`, jsonMode);
    out(`  ${dim(pullResult.stderr || pullResult.stdout)}`, jsonMode);
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore, versionAfter: null,
        commitBefore, commitAfter: null,
        remotes, branch,
        symlink: null, smokeOk: null,
        message: 'pull failed', error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  const alreadyUpToDate =
    pullResult.stdout.toLowerCase().includes('already up to date') ||
    pullResult.stdout.toLowerCase().includes('already up-to-date');

  if (alreadyUpToDate) {
    out(`  ${green('✓')}  ${bold('Already up to date')}  ${dim(`(${commitBefore ?? '?'})`)}`, jsonMode);
    out('', jsonMode);

    // Even when already up-to-date, verify the symlink and smoke-test.
    const symlinkInfo = checkSymlink(repoRoot);
    const smoke = smokeTest(repoRoot);

    if (symlinkInfo.ok && symlinkInfo.pointsHere) {
      out(`  ${green('✓')}  symlink  ${dim(symlinkInfo.detail)}`, jsonMode);
    } else {
      out(`  ${yellow('!')}  symlink  ${dim(symlinkInfo.detail)}`, jsonMode);
    }
    out(`  ${smoke.ok ? green('✓') : yellow('!')}  smoke    ${dim(smoke.detail)}`, jsonMode);
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: true, newCommits: 0,
        versionBefore, versionAfter: versionBefore,
        commitBefore, commitAfter: commitBefore,
        remotes, branch,
        symlink: symlinkInfo, smokeOk: smoke.ok,
        message: 'already up to date', error: null,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 0;
  }

  out(`  ${green('✓')}  ${bold('Pulled')}  ${dim(pullResult.stdout.split('\n')[0] ?? '')}`, jsonMode);
  out('', jsonMode);

  // ── npm install ────────────────────────────────────────────────────────────

  out(`  ${dim('Running')} ${cyan('npm install')}${dim('…')}`, jsonMode);
  const installResult = npmRun(['install'], repoRoot);

  if (!installResult.ok) {
    const msg = `npm install failed: ${installResult.output.slice(0, 500)}`;
    out(`  ${red('✗')}  ${bold('npm install failed')}`, jsonMode);
    out(`  ${dim(installResult.output.slice(0, 300))}`, jsonMode);
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore, versionAfter: null,
        commitBefore, commitAfter: getCommitHash('HEAD', repoRoot),
        remotes, branch,
        symlink: null, smokeOk: null,
        message: 'npm install failed', error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  out(`  ${green('✓')}  npm install`, jsonMode);

  // ── npm run build ─────────────────────────────────────────────────────────

  out(`  ${dim('Running')} ${cyan('npm run build')}${dim('…')}`, jsonMode);
  const buildResult = npmRun(['run', 'build'], repoRoot);

  if (!buildResult.ok) {
    const msg = `npm run build failed: ${buildResult.output.slice(0, 500)}`;
    out(`  ${red('✗')}  ${bold('npm run build failed')}`, jsonMode);
    out(`  ${dim(buildResult.output.slice(0, 300))}`, jsonMode);
    out('', jsonMode);

    if (jsonMode) {
      const result: UpdateResult = {
        updated: false, upToDate: null, newCommits: null,
        versionBefore, versionAfter: null,
        commitBefore, commitAfter: getCommitHash('HEAD', repoRoot),
        remotes, branch,
        symlink: null, smokeOk: null,
        message: 'build failed', error: msg,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return 1;
  }

  out(`  ${green('✓')}  npm run build → dist/`, jsonMode);
  out('', jsonMode);

  // ── After-state ────────────────────────────────────────────────────────────

  const commitAfter  = getCommitHash('HEAD', repoRoot);
  const versionAfter = readPackageVersion(repoRoot);

  // ── Symlink verification ───────────────────────────────────────────────────

  const symlinkInfo = checkSymlink(repoRoot);

  if (symlinkInfo.ok && symlinkInfo.pointsHere) {
    out(`  ${green('✓')}  symlink  ${dim(symlinkInfo.detail)}`, jsonMode);
  } else if (symlinkInfo.ok) {
    out(`  ${yellow('!')}  symlink  ${dim(symlinkInfo.detail)}`, jsonMode);
    out(`  ${dim('Run')} ${cyan('./install.sh')} ${dim('to re-point the symlink.')}`, jsonMode);
  } else {
    out(`  ${yellow('!')}  symlink  ${dim(symlinkInfo.detail)}`, jsonMode);
    out(`  ${dim('Run')} ${cyan('./install.sh')} ${dim('to create the symlink.')}`, jsonMode);
  }

  // ── Smoke test ─────────────────────────────────────────────────────────────

  const smoke = smokeTest(repoRoot);
  out(`  ${smoke.ok ? green('✓') : red('✗')}  smoke    ${dim(smoke.detail)}`, jsonMode);
  out('', jsonMode);

  // ── Version summary ────────────────────────────────────────────────────────

  if (versionBefore !== versionAfter && versionAfter) {
    out(
      `  ${bold('Updated:')}  ${yellow(versionBefore ?? '?')} → ${green(versionAfter)}  ` +
      `${dim(`(${commitBefore ?? '?'} → ${commitAfter ?? '?'})`)}`,
      jsonMode,
    );
  } else if (versionAfter) {
    out(
      `  ${bold('Updated:')}  ${green(versionAfter)}  ` +
      `${dim(`(${commitBefore ?? '?'} → ${commitAfter ?? '?'})`)}`,
      jsonMode,
    );
  }

  if (!smoke.ok) {
    out(`  ${red('!')}  Smoke test failed — the build may be broken.`, jsonMode);
    out(`  ${dim('Try running')} ${cyan('npm run build')} ${dim('manually from')} ${gray(repoRoot)}`, jsonMode);
  }

  out('', jsonMode);

  // ── JSON output ────────────────────────────────────────────────────────────

  if (jsonMode) {
    const result: UpdateResult = {
      updated: true, upToDate: false, newCommits: null,
      versionBefore, versionAfter,
      commitBefore, commitAfter,
      remotes, branch,
      symlink: symlinkInfo, smokeOk: smoke.ok,
      message: smoke.ok ? 'update applied successfully' : 'update applied but smoke test failed',
      error: smoke.ok ? null : smoke.detail,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  return smoke.ok ? 0 : 1;
}
