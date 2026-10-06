/**
 * 3.14 — "a hung dependency install can't stall the tick".
 *
 * 2026-09-26, the fleet's first live standing tick: the mirror phase ran
 * `bun install` (ashlrai/ashlrcode, whose root package.json installs four
 * `file:../<sibling>` packages that never exist next to a mirror) and
 * `pnpm install` (ashlrai/binshield) concurrently; both sat at 0% CPU until
 * the 10-minute execFile timeout killed ONLY the direct child, then a
 * synchronous rmSync of the half-written node_modules held the event loop for
 * minutes on an overloaded machine. The tick was recorded ~16 minutes late and
 * `ashlr daemon status` said "last tick 25d ago" the whole time.
 *
 * Covered here:
 *   A. runDependencyInstall — hard timeout kills the WHOLE process group
 *      (SIGTERM → SIGKILL), stdin is /dev/null, abort cancels, output tail.
 *   B. installMirrorDependencies — the install step's policy: spawned
 *      directly by the trusted daemon (no sandbox wrapper ⇒ network allowed),
 *      lifecycle scripts off, no inherited secrets, frozen argv.
 *   C. planMirrorDependencies — out-of-repo `file:` dependencies are refused
 *      up front instead of hanging an install.
 *   D. prepareMirrorsForTick — a hung install fails ITS repo ("prep failed:
 *      …") at the prep deadline while the other repos are synced.
 *   E. boundedBeforeTick — the tick's preparation deadline; an abandoned hook
 *      is not stacked.
 *   F. tick progress — `ashlr daemon status` (and the fleet status API) say
 *      "tick in progress: <phase> for <duration>".
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The status test's daemon is this test process, which holds no daemon lock;
// the lock-based liveness proof is covered elsewhere, so it is stubbed here.
vi.mock('../src/core/daemon/liveness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/liveness.js')>();
  return {
    ...actual,
    probeDaemonLiveness: () => ({ state: 'running', alive: true, reason: 'test: this process', staleRecord: false }),
  };
});

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { makeBareOrigin, type BareOrigin } from './helpers/throughput-310b.js';
import {
  installMirrorDependencies,
  mirrorPathFor,
  planMirrorDependencies,
  prepareMirrorsForTick,
  readMirrorState,
  runDependencyInstall,
  type MirrorDependencyInstallPlan,
  type MirrorDeps,
} from '../src/core/fleet/mirrors.js';
import {
  abandonedBeforeTickRunning,
  boundedBeforeTick,
  resetBoundedBeforeTickForTests,
} from '../src/core/daemon/tick-deadline.js';
import {
  beginTickProgress,
  daemonTickProgressPath,
  describeTickProgress,
  noteTickPhase,
  readTickProgress,
} from '../src/core/daemon/tick-progress.js';
import { loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { verifiedProcessStartRef } from '../src/core/fleet/local-store-lock.js';
import { cmdDaemon } from '../src/cli/daemon.js';
import { readFleetDaemonStatus } from '../src/core/fleet/status.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { BeforeTickResult } from '../src/core/daemon/tick-hooks.js';

const REAL_IO_TIMEOUT = 60_000;

let fx: H1Fixture;
const disposers: Array<() => void> = [];
const origins = new Map<string, BareOrigin>();

beforeEach(() => {
  fx = makeFixture();
  resetBoundedBeforeTickForTests();
});

afterEach(() => {
  fx.cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  origins.clear();
  vi.restoreAllMocks();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function eventually(check: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return check();
}

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const posixOnly = process.platform === 'win32' ? it.skip : it;

// ---------------------------------------------------------------------------
// A. The process-group runner
// ---------------------------------------------------------------------------

// Cold executable shell startup can exceed 400ms before printing or installing
// its SIGTERM trap. Keep these fixture deadlines bounded while allowing the
// child effects needed to prove whole-group cleanup; production limits are unchanged.
const HUNG_MANAGER_FIXTURE_TIMEOUT_MS = 2_000;

describe('A · runDependencyInstall', () => {
  posixOnly('a hung install hits its hard timeout and its WHOLE process group is killed', async () => {
    const dir = join(fx.home, 'hung');
    const pids = join(dir, 'pids');
    // A manager that prints, forks a worker, and waits forever (like the
    // stalled bun/pnpm): the worker must die with it.
    const bin = script(dir, 'fake-pm', `echo "resolving…"\nsleep 300 &\necho $! > "${pids}"\necho $$ >> "${pids}"\nwait`);
    const started = Date.now();
    const run = await runDependencyInstall(bin, ['install'], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: HUNG_MANAGER_FIXTURE_TIMEOUT_MS, killGraceMs: 300 });
    expect(run.ok).toBe(false);
    expect(run.timedOut).toBe(true);
    expect(run.cancelled).toBe(false);
    expect(run.outputTail).toMatch(/resolving/);
    expect(Date.now() - started).toBeLessThan(10_000);
    const [worker, leader] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    expect(await eventually(() => !alive(worker!) && !alive(leader!))).toBe(true);
  }, REAL_IO_TIMEOUT);

  posixOnly('a manager that ignores SIGTERM is SIGKILLed after the grace', async () => {
    const dir = join(fx.home, 'stubborn');
    const pids = join(dir, 'pids');
    const bin = script(dir, 'fake-pm', `trap '' TERM\necho $$ > "${pids}"\nwhile :; do sleep 1; done`);
    const run = await runDependencyInstall(bin, [], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: HUNG_MANAGER_FIXTURE_TIMEOUT_MS, killGraceMs: 300 });
    expect(run.timedOut).toBe(true);
    expect(run.signal === 'SIGKILL' || run.abandoned).toBe(true);
    const leader = Number(readFileSync(pids, 'utf8').trim());
    expect(await eventually(() => !alive(leader))).toBe(true);
  }, REAL_IO_TIMEOUT);

  posixOnly('stdin is /dev/null: a manager that would wait on a prompt reads EOF instead of hanging', async () => {
    const dir = join(fx.home, 'prompt');
    const bin = script(dir, 'fake-pm', 'if read answer; then echo "answered:$answer"; exit 3; fi\necho "eof"\nexit 0');
    const run = await runDependencyInstall(bin, [], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 5_000 });
    expect(run).toMatchObject({ ok: true, timedOut: false, code: 0 });
  }, REAL_IO_TIMEOUT);

  posixOnly('an abort (tick deadline / shutdown) cancels the install and kills its group', async () => {
    const dir = join(fx.home, 'abort');
    const pids = join(dir, 'pids');
    // Opening a redirect creates the PID file before echo writes it. Publish
    // the complete worker PID atomically before allowing the caller to abort.
    const bin = script(dir, 'fake-pm', `sleep 300 &\nprintf '%s\\n' "$!" > "${pids}.tmp"\n/bin/mv "${pids}.tmp" "${pids}"\nwait`);
    const controller = new AbortController();
    const running = runDependencyInstall(bin, [], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 60_000, killGraceMs: 300, signal: controller.signal });
    try {
      const ready = await eventually(() => {
        if (!existsSync(pids)) return false;
        const value = readFileSync(pids, 'utf8');
        if (!/^[1-9][0-9]*\n$/.test(value)) return false;
        const pid = Number(value.trim());
        return Number.isSafeInteger(pid) && pid > 1;
      });
      expect(ready, 'A complete positive worker PID must be published before abort').toBe(true);
      const worker = Number(readFileSync(pids, 'utf8').trim());
      expect(Number.isSafeInteger(worker) && worker > 1).toBe(true);
      const workerStartRef = verifiedProcessStartRef(worker);
      expect(workerStartRef, 'Bind the actual live fixture worker before abort').toBeDefined();
      controller.abort();
      const run = await running;
      expect(run).toMatchObject({ ok: false, cancelled: true, timedOut: false });
      const stopped = await eventually(() => !alive(worker));
      let failureContext: unknown;
      if (!stopped) {
        let selectedProcess: string | null = null;
        try {
          selectedProcess = execFileSync('/bin/ps', ['-p', String(worker), '-o', 'pid=,ppid=,pgid=,state=,comm='], {
            encoding: 'utf8', timeout: 1_000, maxBuffer: 4_096, stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch { /* Unknown process state remains a failed liveness proof. */ }
        failureContext = { worker, workerStartRef, currentWorkerStartRef: verifiedProcessStartRef(worker) ?? null,
          selectedProcess, run: { ok: run.ok, code: run.code, signal: run.signal, timedOut: run.timedOut,
            cancelled: run.cancelled, abandoned: run.abandoned, durationMs: run.durationMs } };
      }
      // Keep the original assertion: a zombie, live survivor or unreadable
      // process is not silently accepted as whole-group cleanup.
      expect(stopped, failureContext === undefined ? undefined : JSON.stringify(failureContext)).toBe(true);
    } finally {
      // Failed readiness/identity assertions must also cancel and await the
      // exact install owned by this test before fixture directories disappear.
      controller.abort();
      await running;
    }
  }, REAL_IO_TIMEOUT);

  posixOnly('a failing install reports its exit code and the tail of its output; a clean exit reaps stragglers', async () => {
    const dir = join(fx.home, 'fail');
    const pids = join(dir, 'pids');
    const failing = script(dir, 'fail-pm', 'echo "ERR_PNPM_FETCH_404 nope" 1>&2\nexit 1');
    const failed = await runDependencyInstall(failing, [], { cwd: dir, env: {}, timeoutMs: 5_000 });
    expect(failed).toMatchObject({ ok: false, code: 1, timedOut: false });
    expect(failed.outputTail).toMatch(/ERR_PNPM_FETCH_404/);

    // Leaves a background worker behind (holding no pipe) and exits 0.
    const leaky = script(dir, 'leaky-pm', `sleep 300 >/dev/null 2>&1 &\necho $! > "${pids}"\nexit 0`);
    const ok = await runDependencyInstall(leaky, [], { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 5_000, killGraceMs: 300 });
    expect(ok.ok).toBe(true);
    const straggler = Number(readFileSync(pids, 'utf8').trim());
    expect(await eventually(() => !alive(straggler))).toBe(true);
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// B. The install step's policy (network allowed, scripts off, no secrets)
// ---------------------------------------------------------------------------

describe('B · installMirrorDependencies policy', () => {
  posixOnly('runs the manager directly under the trusted daemon — no sandbox wrapper, so the registry is reachable — with scripts off and no inherited secrets', async () => {
    const binDir = join(fx.home, 'fake-bin');
    const out = join(fx.home, 'install-probe.txt');
    script(binDir, 'npm', [
      `{`,
      `  echo "ppid=$PPID"`,
      `  echo "argv=$*"`,
      `  echo "CI=$CI"`,
      `  echo "npm_config_ignore_scripts=$npm_config_ignore_scripts"`,
      `  echo "YARN_ENABLE_SCRIPTS=$YARN_ENABLE_SCRIPTS"`,
      `  echo "HTTPS_PROXY=$HTTPS_PROXY"`,
      `  echo "GITHUB_TOKEN=\${GITHUB_TOKEN:-unset}"`,
      `  echo "NPM_TOKEN=\${NPM_TOKEN:-unset}"`,
      `  echo "ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY:-unset}"`,
      `} > "${out}"`,
    ].join('\n'));
    const repo = join(fx.home, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { a: '1.0.0' } }));
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    const plan = planMirrorDependencies(repo) as MirrorDependencyInstallPlan;
    expect(plan.kind).toBe('install');

    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example:3128');
    vi.stubEnv('GITHUB_TOKEN', 'ghs_should_not_leak');
    vi.stubEnv('NPM_TOKEN', 'npm_should_not_leak');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-should-not-leak');
    try {
      const run = await installMirrorDependencies(plan, repo);
      expect(run).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllEnvs();
    }
    const probe = Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    // Parent is this process: not sandbox-exec / a confinement wrapper. The
    // install is the designed network exception (a TRUSTED daemon step whose
    // safety comes from frozen lockfiles + lifecycle scripts off, see the
    // mirrors.ts header "DEPENDENCIES").
    expect(Number(probe['ppid'])).toBe(process.pid);
    expect(probe['argv']).toBe('ci --ignore-scripts --no-audit --no-fund --prefer-offline');
    expect(probe['CI']).toBe('1');
    expect(probe['npm_config_ignore_scripts']).toBe('true');
    expect(probe['YARN_ENABLE_SCRIPTS']).toBe('false');
    expect(probe['HTTPS_PROXY']).toBe('http://proxy.example:3128');
    expect(probe['GITHUB_TOKEN']).toBe('unset');
    expect(probe['NPM_TOKEN']).toBe('unset');
    expect(probe['ANTHROPIC_API_KEY']).toBe('unset');
  }, REAL_IO_TIMEOUT);

  posixOnly('a hung manager is reported as a timeout with a group kill, not "Command failed"', async () => {
    const binDir = join(fx.home, 'fake-bin-hung');
    script(binDir, 'npm', 'sleep 300 &\nwait');
    const repo = join(fx.home, 'repo-hung');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { a: '1.0.0' } }));
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    const plan = planMirrorDependencies(repo) as MirrorDependencyInstallPlan;
    vi.stubEnv('PATH', `${binDir}:${process.env['PATH'] ?? ''}`);
    try {
      const run = await installMirrorDependencies(plan, repo, undefined, { timeoutMs: 300, killGraceMs: 200 });
      expect(run.ok).toBe(false);
      expect(run.reason).toMatch(/^npm ci timed out after 300 ms and its process group was killed/);
      expect(run.reason).toMatch(/process group was killed; it printed nothing/);
    } finally {
      vi.unstubAllEnvs();
    }
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// C. Out-of-repo local dependencies
// ---------------------------------------------------------------------------

describe('C · planMirrorDependencies refuses installs that cannot succeed in a mirror', () => {
  it('refuses file:/link: dependencies outside the repository (ashlrai/ashlrcode, unless pinned — see mirror-sibling-deps-314) and allows ones inside it', () => {
    const dir = join(fx.home, 'plan');
    mkdirSync(dir, { recursive: true });
    const write = (pkg: Record<string, unknown>) => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...pkg }));
      writeFileSync(join(dir, 'bun.lock'), '{}');
    };
    write({ dependencies: { '@ashlr/auth': 'file:../ashlr-auth', zod: '^3.0.0' } });
    expect(planMirrorDependencies(dir)).toMatchObject({
      kind: 'refuse',
      // 3.14: a direct sibling installs only against a pinned, enrolled sibling mirror.
      reason: expect.stringMatching(/installs @ashlr\/auth from "file:\.\.\/ashlr-auth", a sibling repository; .*\.\.\/ashlr-auth was not resolved to one/),
    });
    write({ devDependencies: { tool: 'link:/opt/tool' } });
    expect(planMirrorDependencies(dir).kind).toBe('refuse');
    write({ optionalDependencies: { up: '../up' } });
    expect(planMirrorDependencies(dir).kind).toBe('refuse');
    write({ dependencies: { local: 'file:./packages/local', zod: '^3.0.0' } });
    expect(planMirrorDependencies(dir)).toMatchObject({ kind: 'install', manager: 'bun' });
    // Peers are not installed from their spec.
    write({ dependencies: { zod: '^3.0.0' }, peerDependencies: { host: 'file:../host' } });
    expect(planMirrorDependencies(dir)).toMatchObject({ kind: 'install' });
  });
});

// ---------------------------------------------------------------------------
// D. Mirror prep: a hung repo fails alone; the others are synced
// ---------------------------------------------------------------------------

function origin(nameWithOwner: string, files: Record<string, string>): BareOrigin {
  const made = makeBareOrigin(files);
  origins.set(nameWithOwner, made);
  disposers.push(() => made.destroy());
  return made;
}

function deps(extra: Partial<MirrorDeps> = {}): MirrorDeps {
  return {
    originUrlFor: (nameWithOwner) => origins.get(nameWithOwner)?.bareDir ?? `/nonexistent/${nameWithOwner}.git`,
    allowLocalOrigin: true,
    githubToken: async () => null,
    ...extra,
  };
}

function policyOf(...repos: string[]): Pick<EffectivePolicy, 'repos'> {
  return {
    repos: repos.map((nameWithOwner) => ({
      nameWithOwner, stage: 'merge' as const, enforcement: 'server' as const, maxRisk: 'low' as const,
      maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null,
    })),
  };
}

const NODE_REPO = {
  'README.md': '# node\n',
  '.gitignore': 'node_modules\n',
  'package.json': `${JSON.stringify({ name: 'w', version: '1.0.0', devDependencies: { vitest: '^3.0.0' } })}\n`,
  'package-lock.json': '{}\n',
};

describe('D · prepareMirrorsForTick with a hung install', () => {
  it('fails the hung repo with "prep failed: …deadline…" at the prep deadline, syncs the others, and records the failure for backoff', async () => {
    origin('acme/hung', NODE_REPO);
    origin('acme/plain', { 'README.md': '# plain\n' });
    origin('acme/later', { 'README.md': '# later\n' });
    let aborted = false;
    // Hangs until cancelled (a well-behaved production install does exactly
    // this: the signal kills its process group).
    const installDependencies = (_plan: MirrorDependencyInstallPlan, _path: string, signal?: AbortSignal) =>
      new Promise<{ ok: boolean; reason: string }>((resolveRun) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolveRun({ ok: false, reason: 'npm ci was cancelled and its process group was killed; it printed nothing' });
        }, { once: true });
      });
    const started = Date.now();
    const prep = await prepareMirrorsForTick(
      policyOf('acme/hung', 'acme/plain', 'acme/later'),
      { ...deps({ installDependencies }), deadlineMs: 4_000, abortGraceMs: 2_000 },
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(aborted).toBe(true);
    expect(prep.ready.map((r) => r.nameWithOwner)).toEqual(['acme/later', 'acme/plain']);
    expect(prep.failed).toHaveLength(1);
    expect(prep.failed[0]!.nameWithOwner).toBe('acme/hung');
    expect(prep.failed[0]!.reason).toMatch(/^prep failed: the tick's mirror-prep deadline \(4 s\) passed: .*process group was killed/);
    expect(prep.pausedRepoPaths).toEqual([mirrorPathFor('acme/hung')]);
    // Recorded, so the next tick does not re-run the same install at once.
    expect(readMirrorState('acme/hung')).toMatchObject({ lastSyncOk: false, deps: { status: 'failed' } });
  }, REAL_IO_TIMEOUT);

  it('stops waiting for a sync that ignores cancellation, and fails repos it never reached', async () => {
    origin('acme/stuck', NODE_REPO);
    origin('acme/queued', { 'README.md': '# queued\n' });
    // Ignores the signal entirely (the worst case: never settles).
    const installDependencies = () => new Promise<{ ok: boolean; reason: string }>(() => undefined);
    const prep = await prepareMirrorsForTick(
      policyOf('acme/stuck', 'acme/queued'),
      { ...deps({ installDependencies }), concurrency: 1, deadlineMs: 3_000, abortGraceMs: 300 },
    );
    expect(prep.ready).toEqual([]);
    const byRepo = Object.fromEntries(prep.failed.map((f) => [f.nameWithOwner, f.reason]));
    expect(byRepo['acme/stuck']).toMatch(/^prep failed: the tick's mirror-prep deadline \(3 s\) passed and its sync had not stopped/);
    expect(byRepo['acme/queued']).toMatch(/^prep failed: the tick's mirror-prep deadline \(3 s\) passed before acme\/queued was synced/);
    expect(prep.pausedRepoPaths.sort()).toEqual([mirrorPathFor('acme/queued'), mirrorPathFor('acme/stuck')].sort());
  }, REAL_IO_TIMEOUT);

  it('a failed install is recorded at the time it failed, so a long timeout does not shorten the backoff', async () => {
    origin('acme/slow', NODE_REPO);
    let now = new Date('2026-09-26T23:52:07.000Z');
    const installDependencies = async () => {
      now = new Date(now.getTime() + 10 * 60_000); // "ran" for 10 minutes
      return { ok: false, reason: 'npm ci timed out after 10 min and its process group was killed; it printed nothing' };
    };
    await prepareMirrorsForTick(policyOf('acme/slow'), deps({ installDependencies, now: () => now }));
    expect(readMirrorState('acme/slow')?.deps?.at).toBe('2026-09-27T00:02:07.000Z');
  }, REAL_IO_TIMEOUT);
});

// ---------------------------------------------------------------------------
// E. The tick's preparation deadline
// ---------------------------------------------------------------------------

const OK: BeforeTickResult = { pausedRepos: ['/r'], laneCaps: { local: 2 }, holdProduction: null };

describe('E · boundedBeforeTick', () => {
  it('returns the hook result untouched when it settles in time', async () => {
    let seen: AbortSignal | null = null;
    const result = await boundedBeforeTick(async (signal) => { seen = signal; return OK; }, { deadlineMs: 1_000 });
    expect(result).toEqual(OK);
    expect(seen!.aborted).toBe(false);
  });

  it('a hook that winds down on abort: production is held with its own results kept', async () => {
    const result = await boundedBeforeTick(
      (signal) => new Promise((resolveHook) => {
        signal.addEventListener('abort', () => resolveHook({ ...OK }), { once: true });
      }),
      { deadlineMs: 50, graceMs: 1_000 },
    );
    expect(result.pausedRepos).toEqual(['/r']);
    expect(result.holdProduction).toMatch(/tick preparation exceeded its 50 ms deadline and was cancelled; production held/);
    expect(abandonedBeforeTickRunning()).toBe(false);
  });

  it('a hook that never settles is abandoned: this tick holds, the next does not stack a second one, and it clears once it settles', async () => {
    let release!: () => void;
    const hung = new Promise<BeforeTickResult>((resolveHook) => { release = () => resolveHook(OK); });
    let calls = 0;
    const first = await boundedBeforeTick(async () => { calls += 1; return hung; }, { deadlineMs: 50, graceMs: 50 });
    expect(first.holdProduction).toMatch(/had not stopped .* later and is left to finish/);
    expect(abandonedBeforeTickRunning()).toBe(true);

    const second = await boundedBeforeTick(async () => { calls += 1; return OK; }, { deadlineMs: 1_000 });
    expect(second.holdProduction).toMatch(/previous tick's preparation has not finished/);
    expect(calls).toBe(1);

    release();
    await eventually(() => !abandonedBeforeTickRunning());
    const third = await boundedBeforeTick(async () => { calls += 1; return OK; }, { deadlineMs: 1_000 });
    expect(third).toEqual(OK);
    expect(calls).toBe(2);
  });

  it('a daemon shutdown aborts the hook signal', async () => {
    const parent = new AbortController();
    let seen: AbortSignal | null = null;
    const running = boundedBeforeTick(async (signal) => {
      seen = signal;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      return OK;
    }, { parentSignal: parent.signal, deadlineMs: 5_000 });
    parent.abort();
    await running;
    expect(seen!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. "tick in progress: <phase> for <duration>"
// ---------------------------------------------------------------------------

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  let out = '';
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += args.map((arg) => String(arg)).join(' ') + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return { code: await fn(), out };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('F · tick progress', () => {
  it('records phases only while a tick is open, and removes its record when the tick ends', () => {
    noteTickPhase('mirror prep', 'ignored: no tick open');
    expect(existsSync(daemonTickProgressPath())).toBe(false);
    const t0 = new Date(Date.now() - 14 * 60_000);
    const end = beginTickProgress(t0);
    noteTickPhase('mirror prep', 'ashlrai/binshield: installing dependencies with pnpm (pnpm-lock.yaml)', new Date(t0.getTime() + 5 * 60_000));
    const read = readTickProgress();
    expect(read?.progress).toMatchObject({ pid: process.pid, phase: 'mirror prep', tickStartedAt: t0.toISOString() });
    expect(describeTickProgress(read!)).toMatch(
      /^tick in progress: mirror prep \(ashlrai\/binshield: installing dependencies with pnpm \(pnpm-lock\.yaml\)\) for 9m \(tick 14m\)$/,
    );
    expect(readTickProgress({ expectPid: process.pid + 1 })).toBeNull();
    end();
    expect(existsSync(daemonTickProgressPath())).toBe(false);
    expect(readTickProgress()).toBeNull();
  });

  it('a record whose writer is gone is not a tick in progress', () => {
    mkdirSync(join(fx.home, '.ashlr'), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(daemonTickProgressPath(), JSON.stringify({ v: 1, authority: 'none', pid: 999_999, tickStartedAt: at, phase: 'mirror prep', detail: null, phaseStartedAt: at }));
    expect(readTickProgress()).toBeNull();
  });

  it('`ashlr daemon status` and the fleet status API show the tick in progress', async () => {
    const state = loadDaemonState();
    state.running = true;
    state.pid = process.pid;
    state.startedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    state.lastTickAt = new Date(Date.now() - 25 * 86_400_000).toISOString();
    saveDaemonState(state);
    const end = beginTickProgress(new Date(Date.now() - 16 * 60_000));
    try {
      noteTickPhase('mirror prep', 'acme/widget: installing dependencies with pnpm (pnpm-lock.yaml)', new Date(Date.now() - 10 * 60_000));

      const json = await captureStdout(() => cmdDaemon(['status', '--json']));
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.out) as { tickInProgress: { phase: string; detail: string; summary: string } | null };
      expect(parsed.tickInProgress).toMatchObject({ phase: 'mirror prep', detail: 'acme/widget: installing dependencies with pnpm (pnpm-lock.yaml)' });
      expect(parsed.tickInProgress?.summary).toMatch(/^tick in progress: mirror prep \(acme\/widget: .*\) for 10m \(tick 16m\)$/);

      const human = await captureStdout(() => cmdDaemon(['status']));
      expect(human.out).toMatch(/last tick: +25d ago|last tick: +.*ago/);
      expect(human.out).toMatch(/tick in progress: mirror prep \(acme\/widget/);

      const fleet = await readFleetDaemonStatus();
      expect(fleet.daemon.tickProgress).toMatchObject({ phase: 'mirror prep', detail: expect.stringMatching(/acme\/widget/) });
      expect(fleet.daemon.tickProgress?.summary).toMatch(/^tick in progress: mirror prep/);
    } finally {
      end();
    }
    const after = await captureStdout(() => cmdDaemon(['status', '--json']));
    expect((JSON.parse(after.out) as { tickInProgress: unknown }).tickInProgress).toBeNull();
  });
});
