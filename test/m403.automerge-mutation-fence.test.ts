import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';

const policyTestHooks = vi.hoisted(() => ({
  afterKillPrecheck: null as null | ((repo: string) => void),
}));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/policy.js')>();
  return {
    ...actual,
    isEnrolled: (repo: string) => {
      policyTestHooks.afterKillPrecheck?.(repo);
      return actual.isEnrolled(repo);
    },
  };
});

import {
  acquireOutwardMutationFence,
  outwardMutationFencePath,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import {
  enroll,
  enrollmentPath,
  isEnrolled,
  killSwitchOn,
  setKill,
} from '../src/core/sandbox/policy.js';
import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { createProposal, loadProposal } from '../src/core/inbox/store.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  assurePrivateStoragePath,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';

const CHILD_TIMEOUT_MS = 8_000;
const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};
const tsxImportUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const fenceModuleUrl = new URL('../src/core/sandbox/mutation-fence.ts', import.meta.url).href;
const policyModuleUrl = new URL('../src/core/sandbox/policy.ts', import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import {
    acquireOutwardMutationFence,
    ownsOutwardMutationFence,
    releaseOutwardMutationFence,
  } from ${JSON.stringify(fenceModuleUrl)};
  import { unenroll } from ${JSON.stringify(policyModuleUrl)};

  const send = (message) => new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC unavailable'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });

  if (process.env.M403_ROLE === 'hold') {
    const fence = acquireOutwardMutationFence(Number(process.env.M403_WAIT_MS ?? 1_000));
    await send({
      type: 'ready',
      acquired: fence !== null,
      owns: ownsOutwardMutationFence(fence),
      fence,
    });
    if (!fence) {
      process.disconnect();
    } else {
      const keepAlive = setInterval(() => {}, 1_000);
      process.on('message', async (message) => {
        if (message !== 'release') return;
        releaseOutwardMutationFence(fence);
        clearInterval(keepAlive);
        await send({ type: 'released' });
        process.disconnect();
      });
    }
  } else if (process.env.M403_ROLE === 'unenroll') {
    await send({ type: 'started' });
    const result = unenroll(
      process.env.M403_REPO,
      { waitMs: Number(process.env.M403_WAIT_MS ?? 2_000) },
    );
    await send({ type: 'result', result });
    process.disconnect();
  } else {
    throw new Error('unknown M403 child role');
  }
`;

type ChildMessage =
  | { type: 'ready'; acquired: boolean; owns: boolean; fence: LocalStoreLock | null }
  | { type: 'released' }
  | { type: 'started' }
  | { type: 'result'; result: unknown };

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousAshlrHome: string | undefined;
const children = new Set<ChildProcess>();

function useNativePrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
}

function useSemanticPrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
    runner: semanticPrivateStorageRunner,
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function spawnWorker(role: 'hold' | 'unenroll', env: Record<string, string> = {}): ChildProcess {
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
        M403_ROLE: role,
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitForMessage<T extends ChildMessage['type']>(
  child: ChildProcess,
  type: T,
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
      if (message.type !== type) return;
      cleanup();
      resolve(message as Extract<ChildMessage, { type: T }>);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`M403 child exited before ${type}: code=${code} signal=${signal}; ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`M403 child did not send ${type}: ${stderr}`));
    }, CHILD_TIMEOUT_MS);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function startHolder(): Promise<ChildProcess> {
  const child = spawnWorker('hold');
  await expect(waitForMessage(child, 'ready')).resolves.toMatchObject({
    type: 'ready',
    acquired: true,
    owns: true,
  });
  return child;
}

async function releaseHolder(child: ChildProcess): Promise<void> {
  const released = waitForMessage(child, 'released');
  child.send('release');
  await expect(released).resolves.toEqual({ type: 'released' });
  await waitForExit(child);
}

beforeEach(() => {
  useNativePrivateStorageRunner();
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = join(tmpdir(), `ashlr-m403-${process.pid}-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  policyTestHooks.afterKillPrecheck = null;

  // Establish the authority root through the production path so spawned Windows
  // processes inherit the same protected root they are expected to validate.
  const fence = acquireOutwardMutationFence();
  if (!ownsOutwardMutationFence(fence)) {
    throw new Error('failed to establish the M403 outward mutation authority root');
  }
  releaseOutwardMutationFence(fence);
  if (process.platform === 'win32') useSemanticPrivateStorageRunner();
});

afterEach(async () => {
  useNativePrivateStorageRunner();
  policyTestHooks.afterKillPrecheck = null;
  const running = [...children];
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(running.map(waitForExit));
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M403 cooperative outward mutation fence', { timeout: 15_000 }, () => {
  it('is exclusive across independent processes', async () => {
    const holder = await startHolder();

    const blocked = acquireOutwardMutationFence(25);
    expect(blocked).toBeNull();

    await releaseHolder(holder);
    const successor = acquireOutwardMutationFence(500);
    expect(successor).not.toBeNull();
    expect(ownsOutwardMutationFence(successor)).toBe(true);
    releaseOutwardMutationFence(successor);
  });

  it('arms kill before drain and reports a held fence as non-quiesced', async () => {
    const holder = await startHolder();

    expect(setKill(true, { waitMs: 25 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
    expect(readFileSync(join(home, '.ashlr', 'KILL'), 'utf8')).toBe('kill switch active\n');

    await releaseHolder(holder);
  });

  it('keeps pause non-quiesced and suppresses an automerge cleanup write after KILL', async () => {
    const repo = join(home, 'automerge-cleanup-repo');
    mkdirSync(repo, { recursive: true });
    expect(enroll(repo)).toMatchObject({ ok: true, quiesced: true });
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'Fix regression in /tmp/.ashlr/tmp/vwt-m403/src.ts',
      summary: 'Race cleanup persistence against the global kill switch.',
      diff: 'diff --git a/src.ts b/src.ts\n+mutation fence\n',
      engineTier: 'local',
      workSource: 'goal',
    });
    expect(proposal.status).toBe('pending');

    let pauseResult: ReturnType<typeof setKill> | null = null;
    policyTestHooks.afterKillPrecheck = () => {
      policyTestHooks.afterKillPrecheck = null;
      const child = spawnSync(
        process.execPath,
        ['--import', tsxImportUrl, '--input-type=module', '--eval', `
          import { setKill } from ${JSON.stringify(policyModuleUrl)};
          process.stdout.write(JSON.stringify(setKill(true, { waitMs: 25 })));
        `],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr') },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      if (child.error) throw child.error;
      expect(child.status, child.stderr).toBe(0);
      pauseResult = JSON.parse(child.stdout) as ReturnType<typeof setKill>;
    };

    const result = await runAutoMergePass({
      version: 1,
      foundry: { autoMerge: { enabled: true } },
    } as AshlrConfig);

    expect(pauseResult).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
    expect(result.invalidRejected).toBe(0);
    expect(loadProposal(proposal.id)?.status).toBe('pending');
  });

  it('refuses kill-off while the fence is held and leaves kill armed', async () => {
    expect(setKill(true)).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'kill-armed',
    });
    const holder = await startHolder();

    expect(setKill(false, { waitMs: 25 })).toEqual({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'outward mutation fence unavailable; kill remains active',
    });
    expect(killSwitchOn()).toBe(true);

    await releaseHolder(holder);
    expect(setKill(false, { waitMs: 500 })).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'kill-cleared',
    });
    expect(killSwitchOn()).toBe(false);
  });

  it('linearizes unenrollment after an already-held outward fence', async () => {
    const repo = join(home, 'repo');
    if (process.platform === 'win32') useNativePrivateStorageRunner();
    try {
      expect(enroll(repo)).toEqual({
        ok: true,
        changed: true,
        quiesced: true,
        reason: 'enrolled',
      });
    } finally {
      if (process.platform === 'win32') useSemanticPrivateStorageRunner();
    }
    const holder = await startHolder();
    const worker = spawnWorker('unenroll', {
      M403_REPO: repo,
      M403_WAIT_MS: '2000',
    });
    await expect(waitForMessage(worker, 'started')).resolves.toEqual({ type: 'started' });

    let settled = false;
    const result = waitForMessage(worker, 'result').then((message) => {
      settled = true;
      return message;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(isEnrolled(repo)).toBe(true);

    await releaseHolder(holder);
    await expect(result).resolves.toEqual({
      type: 'result',
      result: {
        ok: true,
        changed: true,
        quiesced: true,
        reason: 'unenrolled',
      },
    });
    await waitForExit(worker);
    expect(isEnrolled(repo)).toBe(false);
  });

  it('rejects an unrelated owned lock as borrowed outward authority', async () => {
    const holder = await startHolder();
    const repo = join(home, 'forged-borrowed-authority-repo');
    const unrelatedPath = join(home, '.ashlr', 'authority', `unrelated-${randomUUID()}.lock`);
    const unrelated = acquireLocalStoreLock(unrelatedPath, 500);
    expect(unrelated).not.toBeNull();
    try {
      expect(ownsOutwardMutationFence(unrelated)).toBe(false);
      expect(enroll(repo, { borrowedFence: unrelated! })).toEqual({
        ok: false,
        changed: false,
        quiesced: false,
        reason: 'outward mutation fence unavailable',
      });
      expect(isEnrolled(repo)).toBe(false);
    } finally {
      releaseLocalStoreLock(unrelated);
      await releaseHolder(holder);
    }
  });

  it('does not trust readable lock metadata as same-process authority', () => {
    const repo = join(home, 'legitimate-borrower-repo');
    const fence = acquireOutwardMutationFence(500);
    expect(fence).not.toBeNull();
    const stat = lstatSync(outwardMutationFencePath());
    const metadata = JSON.parse(readFileSync(outwardMutationFencePath(), 'utf8')) as { token: string };
    const forged: LocalStoreLock = {
      path: outwardMutationFencePath(),
      token: metadata.token,
      dev: stat.dev,
      ino: stat.ino,
    };

    expect(ownsOutwardMutationFence(forged)).toBe(false);
    expect(ownsLocalStoreLock(forged)).toBe(false);
    releaseOutwardMutationFence(forged);
    releaseLocalStoreLock(forged);
    expect(ownsOutwardMutationFence(fence)).toBe(true);

    expect(enroll(repo, { borrowedFence: fence! })).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'enrolled',
    });
    expect(ownsOutwardMutationFence(fence)).toBe(true);
    releaseOutwardMutationFence(fence);
  });

  it('does not let a different process release a serialized fence handle', async () => {
    const holder = spawnWorker('hold');
    const ready = await waitForMessage(holder, 'ready');
    expect(ready).toMatchObject({ acquired: true, owns: true });
    expect(ready.fence).not.toBeNull();

    releaseOutwardMutationFence(ready.fence);
    releaseLocalStoreLock(ready.fence);
    expect(acquireOutwardMutationFence(25)).toBeNull();

    await releaseHolder(holder);
  });

  it('retains exact process authority when a fail-closed release can be retried', () => {
    const fence = acquireOutwardMutationFence(500);
    expect(fence).not.toBeNull();
    const alias = `${outwardMutationFencePath()}.unexpected-hardlink`;
    linkSync(outwardMutationFencePath(), alias);

    releaseOutwardMutationFence(fence);
    expect(existsSync(outwardMutationFencePath())).toBe(true);
    expect(ownsOutwardMutationFence(fence)).toBe(false);

    unlinkSync(alias);
    expect(ownsOutwardMutationFence(fence)).toBe(true);
    releaseOutwardMutationFence(fence);
    expect(existsSync(outwardMutationFencePath())).toBe(false);
  });

  it('rejects a path-swapping getter without reading attacker-controlled fields', () => {
    const unrelatedPath = join(home, '.ashlr', 'authority', `getter-${randomUUID()}.lock`);
    const unrelated = acquireLocalStoreLock(unrelatedPath, 500);
    expect(unrelated).not.toBeNull();
    const captured = { ...unrelated! };
    const reads = { path: 0, token: 0, dev: 0, ino: 0 };
    const forged = {
      get path() {
        reads.path += 1;
        return reads.path === 1 ? outwardMutationFencePath() : captured.path;
      },
      get token() { reads.token += 1; return captured.token; },
      get dev() { reads.dev += 1; return captured.dev; },
      get ino() { reads.ino += 1; return captured.ino; },
    };
    try {
      expect(ownsOutwardMutationFence(forged)).toBe(false);
      expect(reads).toEqual({ path: 0, token: 0, dev: 0, ino: 0 });
    } finally {
      releaseLocalStoreLock(unrelated);
    }
  });

  it('refuses relative homes across split working directories without creating local state', () => {
    const cwdA = join(home, 'cwd-a');
    const cwdB = join(home, 'cwd-b');
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const source = `
      import { acquireOutwardMutationFence, outwardMutationFencePath } from ${JSON.stringify(fenceModuleUrl)};
      import { enroll, setKill } from ${JSON.stringify(policyModuleUrl)};
      let pathRejected = false;
      try { outwardMutationFencePath(); } catch { pathRejected = true; }
      const fence = acquireOutwardMutationFence(10);
      process.stdout.write(JSON.stringify({
        pathRejected,
        acquired: fence !== null,
        enroll: enroll('./repo', { waitMs: 10 }),
        kill: setKill(true, { waitMs: 10 }),
      }));
    `;
    for (const cwd of [cwdA, cwdB]) {
      const child = spawnSync(
        process.execPath,
        ['--import', tsxImportUrl, '--input-type=module', '--eval', source],
        {
          cwd,
          env: { ...process.env, HOME: 'relative-home', USERPROFILE: 'relative-home', ASHLR_HOME: 'relative-home/.ashlr' },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      if (child.error) throw child.error;
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({
        pathRejected: true,
        acquired: false,
        enroll: { ok: false, changed: false, quiesced: false },
        kill: { ok: false, changed: false, quiesced: false },
      });
      expect(existsSync(join(cwd, '.ashlr'))).toBe(false);
      expect(existsSync(join(cwd, 'relative-home', '.ashlr'))).toBe(false);
    }
  });

  it.runIf(process.platform !== 'win32')('recovers a fence whose POSIX owner was killed', async () => {
    const holder = await startHolder();
    expect(existsSync(outwardMutationFencePath())).toBe(true);

    holder.kill('SIGKILL');
    await waitForExit(holder);
    expect(existsSync(outwardMutationFencePath())).toBe(true);

    const recovered = acquireOutwardMutationFence(1_500);
    expect(recovered).not.toBeNull();
    expect(ownsOutwardMutationFence(recovered)).toBe(true);
    releaseOutwardMutationFence(recovered);
    expect(existsSync(outwardMutationFencePath())).toBe(false);
  });
});

describe('M403 policy registry refusal contracts', () => {
  it('refuses a malformed registry without replacing it', () => {
    if (process.platform === 'win32') useNativePrivateStorageRunner();
    try {
      const repo = join(home, 'repo');
      mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
      const malformed = `${JSON.stringify({ repos: [repo], unexpected: true })}\n`;
      writeFileSync(enrollmentPath(), malformed, { mode: 0o600 });
      expect(assurePrivateStoragePath(
        enrollmentPath(),
        'file',
        'secure-created',
        { anchorPath: process.env.ASHLR_HOME! },
      ).ok).toBe(true);

      expect(enroll(join(home, 'other-repo'))).toEqual({
        ok: false,
        changed: false,
        quiesced: false,
        reason: 'malformed-registry',
      });
      expect(readFileSync(enrollmentPath(), 'utf8')).toBe(malformed);
    } finally {
      if (process.platform === 'win32') useSemanticPrivateStorageRunner();
    }
  });

  it('refuses an unsafe registry path without replacing it', () => {
    mkdirSync(enrollmentPath(), { recursive: true, mode: 0o700 });

    expect(enroll(join(home, 'repo'))).toEqual({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'unsafe-or-oversized-registry',
    });
    expect(lstatSync(enrollmentPath()).isDirectory()).toBe(true);
  });
});
