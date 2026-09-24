/**
 * Real-git / real-process fixtures for the V3.10 U6 throughput suites
 * (test/throughput-310b.test.ts, test/mirrors-310b.test.ts,
 * test/execution-leases-310b.test.ts).
 *
 * These suites are REAL-IO (they run git and spawn tsx children), so they
 * belong in the real-io lane (test/config/realio-lane-membership.mjs). Every
 * repo lives under os.tmpdir(); every child runs with the caller's isolated
 * HOME. Nothing here touches the developer's real ~/.ashlr or any real repo.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const GIT_TIMEOUT_MS = 30_000;

/** Plain git for FIXTURE setup (never the code under test). Identity is per-invocation. */
export function fixtureGit(dir: string, args: readonly string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Ashlr U6 Test',
    '-c', 'user.email=u6@ashlr.test',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', 'init.defaultBranch=main',
    '-C', dir,
    ...args,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUT_MS }).trim();
}

export interface BareOrigin {
  /** The bare repository (acts as GitHub). */
  readonly bareDir: string;
  /** A private working clone used to push new commits to the origin. */
  readonly pusherDir: string;
  /** Commit `files` on main in the pusher and push; returns the new sha. */
  push(files: Record<string, string>, message: string): string;
  /** HEAD of main on the origin. */
  head(): string;
  destroy(): void;
}

export function makeBareOrigin(files: Record<string, string> = { 'README.md': '# origin\n' }): BareOrigin {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-u6-origin-')));
  const bareDir = join(root, 'origin.git');
  const pusherDir = join(root, 'pusher');
  mkdirSync(bareDir);
  fixtureGit(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main']);
  mkdirSync(pusherDir);
  fixtureGit(pusherDir, ['init', '--quiet', '--initial-branch=main']);
  fixtureGit(pusherDir, ['remote', 'add', 'origin', bareDir]);
  const push = (next: Record<string, string>, message: string): string => {
    for (const [rel, content] of Object.entries(next)) {
      const full = join(pusherDir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    fixtureGit(pusherDir, ['add', '-A']);
    fixtureGit(pusherDir, ['commit', '--quiet', '--no-verify', '-m', message]);
    fixtureGit(pusherDir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
    return fixtureGit(pusherDir, ['rev-parse', 'HEAD']);
  };
  push(files, 'init');
  return {
    bareDir,
    pusherDir,
    push,
    head: () => fixtureGit(bareDir, ['rev-parse', 'refs/heads/main']),
    destroy: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A clone standing in for one of Mason's checkouts: on a feature branch, dirty. */
export function makeSourceCheckout(origin: BareOrigin): { dir: string; destroy(): void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-u6-checkout-')));
  const dir = join(root, 'checkout');
  execFileSync('git', ['clone', '--quiet', origin.bareDir, dir], { stdio: 'pipe', timeout: GIT_TIMEOUT_MS });
  fixtureGit(dir, ['checkout', '--quiet', '-b', 'feature/masons-work']);
  writeFileSync(join(dir, 'README.md'), '# local edits in progress\n', 'utf8');
  writeFileSync(join(dir, 'scratch.txt'), 'untracked\n', 'utf8');
  return { dir, destroy: () => rmSync(root, { recursive: true, force: true }) };
}

export interface CheckoutSnapshot {
  head: string;
  branch: string;
  status: string;
  worktrees: string;
  config: string;
  readme: string;
}

/** Everything a fleet operation could disturb in a checkout. */
export function snapshotCheckout(dir: string): CheckoutSnapshot {
  return {
    head: fixtureGit(dir, ['rev-parse', 'HEAD']),
    branch: fixtureGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: fixtureGit(dir, ['status', '--porcelain']),
    worktrees: fixtureGit(dir, ['worktree', 'list', '--porcelain']),
    config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
    readme: readFileSync(join(dir, 'README.md'), 'utf8'),
  };
}

function childEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ASHLR_HOME: join(home, '.ashlr'),
  };
}

/** Run a one-shot ESM snippet (tsx) in a child with the given HOME; returns its stdout. */
export function runTsxChild(source: string, home: string, timeoutMs = 20_000): string {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    { cwd: process.cwd(), env: childEnv(home), encoding: 'utf8', timeout: timeoutMs },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`tsx child failed (${child.status}): ${child.stderr}`);
  return child.stdout;
}

/**
 * Start a long-lived ESM snippet (tsx). Resolves once the child prints a line
 * containing `readyToken`; the handle kills it.
 */
export function startTsxChild(
  source: string,
  home: string,
  readyToken: string,
  timeoutMs = 20_000,
): Promise<{ child: ChildProcess; kill(): Promise<void> }> {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: process.cwd(), env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectStart(new Error(`tsx child not ready after ${timeoutMs}ms: ${err}`));
    }, timeoutMs);
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes(readyToken)) {
        clearTimeout(timer);
        resolveStart({
          child,
          kill: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
          },
        });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!out.includes(readyToken)) rejectStart(new Error(`tsx child exited (${code}) before ready: ${err}`));
    });
  });
}
