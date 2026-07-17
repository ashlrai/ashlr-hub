import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enroll, killSwitchPath, setKill } from '../src/core/sandbox/policy.js';
import { createSandbox, removeSandbox } from '../src/core/sandbox/worktree.js';

const CHILD_TIMEOUT_MS = 10_000;
const worktreeModuleUrl = new URL('../src/core/sandbox/worktree.ts', import.meta.url).href;
const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import { removeSandbox } from ${JSON.stringify(worktreeModuleUrl)};
  import { setKill } from ${JSON.stringify(policyModuleUrl)};

  const send = (message) => new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC unavailable'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });

  await send({ type: 'started', role: process.env.M417_ROLE });
  if (process.env.M417_ROLE === 'cleanup') {
    const sandbox = JSON.parse(process.env.M417_SANDBOX);
    const result = removeSandbox(sandbox, { authorityWaitMs: 5_000 });
    await send({ type: 'result', role: 'cleanup', result });
  } else if (process.env.M417_ROLE === 'pause') {
    const result = setKill(true, { waitMs: 5_000 });
    await send({ type: 'result', role: 'pause', result });
  } else {
    throw new Error('unknown M417 child role');
  }
  process.disconnect();
`;

type ChildMessage =
  | { type: 'started'; role: 'cleanup' | 'pause' }
  | { type: 'result'; role: 'cleanup' | 'pause'; result: unknown };

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;
const children = new Set<ChildProcess>();

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function waitForMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T,
  role: ChildMessage['role'],
): Promise<Extract<ChildMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    const onStderr = (chunk: string): void => { stderr += chunk; };
    child.stderr?.on('data', onStderr);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
    };
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== type || message.role !== role) return;
      cleanup();
      resolve(message as Extract<ChildMessage, { type: T }>);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`M417 ${role} child exited before ${type}: code=${code} signal=${signal}; ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`M417 ${role} child did not send ${type}: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function spawnWorker(
  role: 'cleanup' | 'pause',
  env: Record<string, string> = {},
): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', CHILD_SOURCE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ASHLR_HOME: join(home, '.ashlr'),
        M417_ROLE: role,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init']);
  git(path, ['config', 'user.email', 'm417@example.test']);
  git(path, ['config', 'user.name', 'M417']);
  writeFileSync(join(path, 'seed.txt'), 'seed\n');
  git(path, ['add', 'seed.txt']);
  git(path, ['commit', '-m', 'seed']);
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = join(tmpdir(), `ashlr-m417-${process.pid}-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});

afterEach(async () => {
  const running = [...children];
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(running.map(waitForExit));
  setKill(false, { waitMs: 500 });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M417 sandbox cleanup quiescence', { timeout: 20_000 }, () => {
  it.runIf(process.platform !== 'win32')(
    'waits for in-flight cleanup and refuses cleanup after pause quiesces',
    async () => {
      const repo = join(home, 'repo');
      initRepo(repo);
      expect(enroll(repo).ok).toBe(true);
      const inFlight = createSandbox(repo);
      const afterPause = createSandbox(repo);

      const bin = join(home, 'bin');
      const entered = join(home, 'cleanup-entered');
      const release = join(home, 'cleanup-release');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      mkdirSync(bin, { recursive: true });
      const shim = join(bin, 'git');
      writeFileSync(shim, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  : > "$M417_ENTERED"
  while [ ! -f "$M417_RELEASE" ]; do sleep 0.05; done
fi
exec "$M417_REAL_GIT" "$@"
`);
      chmodSync(shim, 0o700);

      const cleanupChild = spawnWorker('cleanup', {
        M417_SANDBOX: JSON.stringify(inFlight),
        M417_ENTERED: entered,
        M417_RELEASE: release,
        M417_REAL_GIT: realGit,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      });
      await expect(waitForMessage(cleanupChild, 'started', 'cleanup')).resolves.toEqual({
        type: 'started',
        role: 'cleanup',
      });
      await waitForPath(entered);

      const pauseChild = spawnWorker('pause');
      await expect(waitForMessage(pauseChild, 'started', 'pause')).resolves.toEqual({
        type: 'started',
        role: 'pause',
      });
      await waitForPath(killSwitchPath());
      let pauseSettled = false;
      const pauseResult = waitForMessage(pauseChild, 'result', 'pause').then((message) => {
        pauseSettled = true;
        return message;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pauseSettled).toBe(false);
      expect(existsSync(inFlight.worktreePath)).toBe(true);

      writeFileSync(release, 'release\n');
      const cleanupResult = await waitForMessage(cleanupChild, 'result', 'cleanup');
      expect(cleanupResult.result).toMatchObject({ status: 'complete' });
      await waitForExit(cleanupChild);
      await expect(pauseResult).resolves.toMatchObject({
        result: { ok: true, quiesced: true },
      });
      await waitForExit(pauseChild);

      const refused = removeSandbox(afterPause, { authorityWaitMs: 500 });
      expect(refused).toMatchObject({
        status: 'unavailable',
        failureClasses: ['cleanup-locked'],
        retryable: true,
      });
      expect(existsSync(afterPause.worktreePath)).toBe(true);
      expect(git(repo, ['branch', '--list', afterPause.branch])).toContain(afterPause.branch);
    },
  );
});
