/**
 * The DETACHED Anthropic proxy: proxy-supervisor.ts, proxy-process.ts,
 * proxy-record.ts and proxy-host.ts.
 *
 * WHAT THIS FILE EXISTS TO PROVE, and why none of it can be proved in-process:
 * the defect being fixed is that the proxy died with the CLI invocation that
 * started it. "Survives its parent" is not a property of a function — it is a
 * property of a process tree — so the central test here spawns the REAL CLI as
 * an intermediate parent, waits for that parent to exit, and only then asks,
 * from this (entirely separate) process, whether the endpoint still answers.
 * A mock cannot fail that test, which is the point.
 *
 * Pinned, in the order it would hurt to get wrong:
 *
 *   - a proxy started by a one-shot CLI OUTLIVES it, is reparented to init,
 *     and still forwards to llama-server afterwards. This is the whole feature.
 *   - a proxy already on the port is ADOPTED, never duplicated. Every CLI
 *     invocation is a new process that spawned none of them, so adoption is the
 *     ordinary path, not an edge case.
 *   - a listener we cannot prove is ours is REFUSED, never killed, and is still
 *     alive afterwards. Killing a stranger on a port is unrecoverable.
 *   - `stop` releases the port, and stopping nothing is a success.
 *   - NO argv can move the listener off loopback. Neither this proxy nor
 *     llama-server behind it has any authentication whatsoever.
 *   - the child entry point resolves in all three shipping runtimes. This
 *     repository has shipped the /$bunfs/root path-collapse defect three times
 *     (both account probes, then cutoff capture); these assertions are the
 *     fourth not happening.
 *
 * No llama-server is started and no model is loaded: the upstream is a loopback
 * stub, and every port is ephemeral.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANTHROPIC_PROXY_COMMAND,
  ANTHROPIC_PROXY_HOST_FLAG,
  anthropicProxyHostArgs,
  anthropicProxyHostInvocation,
  argvBindsAnthropicPort,
  argvMatchesProxyRecord,
  isAnthropicProxyHostArgv,
} from '../src/core/local-runtime/llama/proxy-process.js';
import {
  anthropicProxyResponds,
  upstreamPortFromArgv,
} from '../src/core/local-runtime/llama/proxy-supervisor.js';
import {
  parseAnthropicProxyRecord,
  readAnthropicProxyRecord,
} from '../src/core/local-runtime/llama/proxy-record.js';
import { parseProxyHostArgs } from '../src/core/local-runtime/llama/proxy-host.js';
import { processAlive, terminateTree } from '../src/core/local-runtime/llama/process.js';
import { isPortFree } from '../src/core/local-runtime/llama/port.js';
import { gateBindHost } from '../src/core/local-runtime/llama/config.js';
import type { AnthropicProxyOwnershipRecord } from '../src/core/local-runtime/llama/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');

/** An isolated HOME, so no test ever reads or writes the developer's ~/.ashlr. */
function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-proxy-sup-'));
}

/** Where the proxy record lands under an isolated HOME. */
function recordPathIn(home: string): string {
  return join(home, '.ashlr', 'local-runtime', 'anthropic-proxy.json');
}

/**
 * Run the REAL CLI, as a real child process, and wait for it to EXIT.
 *
 * `spawnSync` returning is the assertion half of this file's central claim:
 * the command that started a proxy is gone by the time anything is checked.
 *
 * `--import tsx/esm` is how the dev runtime is entered, so `process.argv[1]`
 * inside the child is `src/cli/index.ts` — which means the entry-point
 * resolution under test is the production one, not an injected stand-in.
 */
async function runCli(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  // spawn, NOT spawnSync. spawnSync blocks this process's event loop, which
  // would freeze the upstream stub below for the whole run — the proxy would
  // then forward a request to a socket nobody is reading and `start` would time
  // out waiting for an answer that could not come. (Measured: that is exactly
  // how this file first failed.) A real CLI invocation does not freeze
  // llama-server, so the async spawn is also the faithful shape.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', CLI_ENTRY, 'local-runtime', ...args],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ASHLR_HOME: join(home, '.ashlr'),
        ...env,
      },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number | null>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`CLI did not exit within 45s: ${args.join(' ')}`));
    }, 45_000);
    child.once('error', (err) => { clearTimeout(timer); fail(err); });
    child.once('close', (code) => { clearTimeout(timer); done(code); });
  });
  return { status, stdout, stderr };
}

/** `runCli` with `--json`, parsed. Fails loudly rather than returning junk. */
async function runCliJson(home: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  status: number | null;
  result: { ok: boolean; action: string; detail: string; record: AnthropicProxyOwnershipRecord | null; baseUrl: string | null };
}> {
  const run = await runCli(home, [...args, '--json'], env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout) as unknown;
  } catch {
    throw new Error(
      `CLI did not emit JSON (status ${String(run.status)}).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return {
    status: run.status,
    result: parsed as Awaited<ReturnType<typeof runCliJson>>['result'],
  };
}

/** A loopback stand-in for llama-server that records what it received. */
interface Upstream {
  port: number;
  seen: { method: string; url: string }[];
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const seen: Upstream['seen'] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((done) => server.listen({ host: '127.0.0.1', port: 0 }, () => done()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('upstream bound no port');
  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Ask the OS for a port nobody is using, then give it straight back. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createSocketServer();
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        fail(new Error('no port'));
        return;
      }
      const port = address.port;
      server.close(() => done(port));
    });
  });
}

/** One HTTP GET through the proxy, so "it answers" means more than "it accepts". */
function getThroughProxy(port: number, path: string): Promise<number> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', timeout: 5_000 },
      (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode ?? 0));
      },
    );
    req.on('error', fail);
    req.on('timeout', () => {
      req.destroy();
      fail(new Error('timed out'));
    });
    req.end();
  });
}

/** Everything a test brought up, torn down even when the test failed. */
const live: { homes: string[]; pids: number[]; closers: (() => Promise<void>)[] } = {
  homes: [],
  pids: [],
  closers: [],
};

function track(home: string): string {
  live.homes.push(home);
  return home;
}

afterEach(async () => {
  // Kill spawned host processes FIRST: a leaked one holds a port and, worse,
  // keeps running long after the suite that created it.
  for (const pid of live.pids) {
    if (processAlive(pid)) await terminateTree(pid, 3_000);
  }
  live.pids.length = 0;
  for (const close of live.closers) {
    await close().catch(() => undefined);
  }
  live.closers.length = 0;
  for (const home of live.homes) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best-effort fixture cleanup must never fail a test.
    }
  }
  live.homes.length = 0;
});

/** Start a proxy through the real CLI and register it for teardown. */
async function startViaCli(
  home: string,
  proxyPort: number,
  upstreamPort: number,
  env: NodeJS.ProcessEnv = {},
): Promise<ReturnType<typeof runCliJson>> {
  const run = await runCliJson(
    home,
    ['proxy', 'start', '--anthropic-port', String(proxyPort), '--port', String(upstreamPort)],
    env,
  );
  if (run.result.record) live.pids.push(run.result.record.pid);
  return run;
}

// ---------------------------------------------------------------------------

describe('detached anthropic proxy — the child entry point', () => {
  // These three cases are the whole reason probe-helper-invocation.ts exports
  // its virtual-root predicates. Pure, so all three runtimes are covered
  // without needing all three installed.
  const DEV_MODULE = 'file:///owned/src/core/local-runtime/llama/proxy-process.ts';
  const DIST_MODULE = 'file:///owned/dist/core/local-runtime/llama/proxy-process.js';
  const BUNDLED_MODULE = 'file:///$bunfs/root/_entry.js';

  it('passes the entry script in dev, and carries tsx\'s loader with it', () => {
    const invocation = anthropicProxyHostInvocation(8081, 8080, {
      execPath: '/usr/bin/node',
      entry: '/owned/src/cli/index.ts',
      execArgv: ['--require', '/owned/node_modules/tsx/dist/preflight.cjs',
        '--import', 'file:///owned/node_modules/tsx/dist/loader.mjs', '--inspect=9229'],
      moduleUrl: DEV_MODULE,
      cwd: '/owned',
    });

    expect(invocation.command).toBe('/usr/bin/node');
    expect(invocation.args).toEqual([
      '--require', '/owned/node_modules/tsx/dist/preflight.cjs',
      '--import', 'file:///owned/node_modules/tsx/dist/loader.mjs',
      '/owned/src/cli/index.ts',
      'local-runtime', '--_proxy-host', '--anthropic-port', '8081', '--upstream-port', '8080',
    ]);
    // --inspect is deliberately NOT forwarded: the child would fight its parent
    // for the debug port and die at startup.
    expect(invocation.args).not.toContain('--inspect=9229');
  });

  it('makes a bare loader specifier absolute before handing it to the child', () => {
    // REGRESSION, caught by the lifecycle tests below. The child runs with
    // `cwd: homedir()`, so a bare `--import tsx/esm` resolves from the home
    // directory, finds no node_modules/tsx, and the host dies with
    // ERR_MODULE_NOT_FOUND before it can log anything. tsx's own launcher puts
    // ABSOLUTE paths in execArgv, so the defect is invisible until someone uses
    // the plain spelling.
    const invocation = anthropicProxyHostInvocation(8081, 8080, {
      execPath: process.execPath,
      entry: join(REPO_ROOT, 'src', 'cli', 'index.ts'),
      execArgv: ['--import', 'tsx/esm', '--require=tsx/cjs'],
      moduleUrl: DEV_MODULE,
      cwd: REPO_ROOT,
    });

    const imported = invocation.args[invocation.args.indexOf('--import') + 1] as string;
    expect(imported.startsWith('file://')).toBe(true);
    expect(imported).toContain('tsx');
    expect(imported).not.toBe('tsx/esm');

    const required = invocation.args.find((a) => a.startsWith('--require=')) as string;
    expect(required.startsWith('--require=file://')).toBe(true);

    // An unresolvable specifier is passed through rather than silently dropped:
    // the child's own error is more useful than a missing loader.
    expect(
      anthropicProxyHostInvocation(1, 2, {
        execPath: process.execPath,
        entry: '/owned/src/cli/index.ts',
        execArgv: ['--import', 'no-such-loader-package-xyz'],
        moduleUrl: DEV_MODULE,
        cwd: REPO_ROOT,
      }).args,
    ).toContain('no-such-loader-package-xyz');
  });

  it('passes the built entry in dist, with no loader flags', () => {
    const invocation = anthropicProxyHostInvocation(8081, 8080, {
      execPath: '/usr/bin/node',
      entry: '/owned/dist/cli/index.js',
      execArgv: [],
      moduleUrl: DIST_MODULE,
      cwd: '/owned',
    });
    expect(invocation.args).toEqual([
      '/owned/dist/cli/index.js',
      'local-runtime', '--_proxy-host', '--anthropic-port', '8081', '--upstream-port', '8080',
    ]);
  });

  it('re-enters the binary itself inside a Bun single-file bundle', () => {
    // THE REGRESSION CLASS. Inside `bun build --compile` every bundled module's
    // URL collapses onto /$bunfs/root, a path with no on-disk file. Passing
    // argv[1] through would spawn `<binary> /$bunfs/root/_entry.js local-runtime
    // …`, which the CLI parses as an unknown command and rejects with exit 2 —
    // a proxy that never starts and never says why. Shipped three times in this
    // repository already.
    const byModuleUrl = anthropicProxyHostInvocation(8081, 8080, {
      execPath: '/Applications/ashlr',
      entry: '/$bunfs/root/_entry.js',
      execArgv: [],
      moduleUrl: BUNDLED_MODULE,
      cwd: '/owned',
    });
    expect(byModuleUrl).toEqual({
      command: '/Applications/ashlr',
      args: ['local-runtime', '--_proxy-host', '--anthropic-port', '8081', '--upstream-port', '8080'],
    });

    // The intrinsic signal alone is enough, even when argv looks ordinary...
    expect(
      anthropicProxyHostInvocation(1, 2, {
        execPath: '/Applications/ashlr',
        entry: '/somewhere/real.js',
        execArgv: [],
        moduleUrl: BUNDLED_MODULE,
        cwd: '/owned',
      }).args[0],
    ).toBe('local-runtime');

    // ...and so is the argv spelling alone, which is the only form a unit test
    // can simulate, since import.meta.url cannot be stubbed.
    expect(
      anthropicProxyHostInvocation(1, 2, {
        execPath: '/Applications/ashlr',
        entry: 'B:\\~BUN\\root\\ashlr.exe',
        execArgv: [],
        moduleUrl: DIST_MODULE,
        cwd: '/owned',
      }).args[0],
    ).toBe('local-runtime');
  });

  it('re-enters the executable for a Node SEA and for a missing entry', () => {
    for (const entry of ['/Applications/ashlr', undefined, '']) {
      expect(
        anthropicProxyHostInvocation(8081, 8080, {
          execPath: '/Applications/ashlr',
          entry,
          execArgv: [],
          moduleUrl: DIST_MODULE,
          cwd: '/owned',
        }).args[0],
      ).toBe('local-runtime');
    }
  });

  it('never lets a bind host cross the argv boundary', () => {
    // The gate that matters. llama-server and this proxy both have NO
    // authentication, so the host must come from the persisted config and
    // nowhere else. If a host ever appears in these args, an argument has
    // become able to put an unauthenticated inference server on the network.
    const args = anthropicProxyHostArgs(8081, 8080);
    expect(args).toEqual([
      'local-runtime', '--_proxy-host', '--anthropic-port', '8081', '--upstream-port', '8080',
    ]);
    for (const token of args) {
      expect(token).not.toMatch(/0\.0\.0\.0|127\.0\.0\.1|localhost|--host|::/);
    }
    // And the host parser refuses anything that is not those two flags, so a
    // future caller cannot smuggle one in either.
    expect(parseProxyHostArgs([...args.slice(2), '--host', '0.0.0.0'])).toEqual({
      error: 'unexpected argument "--host"',
    });
  });
});

describe('detached anthropic proxy — host argv parsing', () => {
  it('accepts exactly the two integers and nothing else', () => {
    expect(parseProxyHostArgs(['--anthropic-port', '8081', '--upstream-port', '8080']))
      .toEqual({ port: 8081, upstreamPort: 8080 });
    expect(parseProxyHostArgs(['--upstream-port', '8080', '--anthropic-port', '8081']))
      .toEqual({ port: 8081, upstreamPort: 8080 });
  });

  it('refuses rather than defaulting', () => {
    // A proxy that silently binds a port nobody asked for is worse than one
    // that refuses and says so in its log.
    expect(parseProxyHostArgs([])).toHaveProperty('error');
    expect(parseProxyHostArgs(['--anthropic-port', '8081'])).toHaveProperty('error');
    expect(parseProxyHostArgs(['--anthropic-port', '0', '--upstream-port', '8080'])).toHaveProperty('error');
    expect(parseProxyHostArgs(['--anthropic-port', '70000', '--upstream-port', '8080'])).toHaveProperty('error');
    expect(parseProxyHostArgs(['--anthropic-port', 'x', '--upstream-port', '8080'])).toHaveProperty('error');
    expect(parseProxyHostArgs(['--anthropic-port', '1', '--anthropic-port', '2'])).toHaveProperty('error');
  });
});

describe('detached anthropic proxy — process identity', () => {
  const record: AnthropicProxyOwnershipRecord = {
    schemaVersion: 1,
    pid: 4242,
    port: 8081,
    host: '127.0.0.1',
    execPath: '/usr/bin/node',
    upstreamPort: 8080,
    upstreamOrigin: 'http://127.0.0.1:8080',
    startedAt: '2026-09-21T00:00:00.000Z',
    owner: 'cli',
  };
  const argv = '/usr/bin/node /owned/dist/cli/index.js local-runtime --_proxy-host --anthropic-port 8081 --upstream-port 8080';

  it('requires the executable, the invocation shape AND the port together', () => {
    expect(argvMatchesProxyRecord(argv, record)).toBe(true);

    // Each condition alone is forgeable by an unrelated command line, which is
    // the entire reason there are three of them. A recycled pid belongs to some
    // other program, and this is what keeps that harmless.
    expect(argvMatchesProxyRecord(argv, { ...record, execPath: '/opt/other/node' })).toBe(false);
    expect(argvMatchesProxyRecord(argv, { ...record, port: 9999 })).toBe(false);
    expect(argvMatchesProxyRecord('/usr/bin/node /owned/dist/cli/index.js serve --anthropic-port 8081', record)).toBe(false);
    expect(argvMatchesProxyRecord('', record)).toBe(false);

    // A prefix match on the executable must not be enough: /usr/bin/nodemon is
    // not /usr/bin/node.
    expect(argvMatchesProxyRecord('/usr/bin/nodemon x local-runtime --_proxy-host --anthropic-port 8081', record)).toBe(false);
  });

  it('recognises our invocation and reads its ports back', () => {
    expect(isAnthropicProxyHostArgv(argv)).toBe(true);
    expect(isAnthropicProxyHostArgv('grep --_proxy-host')).toBe(false);
    expect(argvBindsAnthropicPort(argv, 8081)).toBe(true);
    expect(argvBindsAnthropicPort(argv, 808)).toBe(false);
    expect(argvBindsAnthropicPort('node cli local-runtime --_proxy-host --anthropic-port=8081', 8081)).toBe(true);
    expect(upstreamPortFromArgv(argv)).toBe(8080);
    expect(upstreamPortFromArgv('node cli local-runtime --_proxy-host --anthropic-port 8081')).toBeNull();
  });

  it('discards a record whose shape is not exactly ours', () => {
    // The shape check is the security boundary: a record that fails here is
    // discarded, and a discarded record can never become a kill decision.
    expect(parseAnthropicProxyRecord(record)).toEqual(record);
    expect(parseAnthropicProxyRecord({ ...record, schemaVersion: 2 })).toBeNull();
    expect(parseAnthropicProxyRecord({ ...record, pid: 1 })).toBeNull();
    expect(parseAnthropicProxyRecord({ ...record, port: 0 })).toBeNull();
    expect(parseAnthropicProxyRecord({ ...record, execPath: '' })).toBeNull();
    expect(parseAnthropicProxyRecord({ ...record, owner: 'someone-else' })).toBeNull();
    expect(parseAnthropicProxyRecord({ ...record, startedAt: 'not a date' })).toBeNull();
    expect(parseAnthropicProxyRecord(null)).toBeNull();
    expect(parseAnthropicProxyRecord('{}')).toBeNull();

    // Nothing that could carry a credential round-trips, because there is no
    // field for one: the record is exactly these keys.
    expect(Object.keys(parseAnthropicProxyRecord(record) as object).sort()).toEqual([
      'execPath', 'host', 'owner', 'pid', 'port', 'schemaVersion', 'startedAt',
      'upstreamOrigin', 'upstreamPort',
    ]);
  });
});

describe('detached anthropic proxy — lifecycle through the real CLI', () => {
  it('outlives the CLI that started it and keeps forwarding', async () => {
    // THE FEATURE. Before this, `local-runtime start` hosted the listener
    // in-process, set process.exitCode and returned — taking the Anthropic lane
    // with it while llama-server (detached) kept serving. The operator was left
    // with a runtime Claude Code could not reach.
    const home = track(makeHome());
    const upstream = await startUpstream();
    live.closers.push(upstream.close);
    const proxyPort = await freePort();

    const started = await startViaCli(home, proxyPort, upstream.port);

    // spawnSync has RETURNED: the CLI process is gone.
    expect(started.status).toBe(0);
    expect(started.result.action).toBe('started');
    expect(started.result.ok).toBe(true);
    const record = started.result.record;
    expect(record).not.toBeNull();
    if (record === null) return;

    // ...and the proxy it spawned is not.
    expect(processAlive(record.pid)).toBe(true);
    expect(record.port).toBe(proxyPort);
    expect(record.upstreamOrigin).toBe(`http://127.0.0.1:${upstream.port}`);

    // Asked from THIS process, which is neither the CLI nor the proxy.
    expect(await anthropicProxyResponds('127.0.0.1', proxyPort)).toBe(true);

    // "Answers" is not enough — it must actually be proxying. The upstream stub
    // is the witness: these bytes went through the detached child.
    expect(await getThroughProxy(proxyPort, '/health')).toBe(200);
    expect(upstream.seen.map((s) => s.url)).toContain('/health');

    // The record survived on disk for the next invocation to reclaim.
    const onDisk = readAnthropicProxyRecord(recordPathIn(home));
    expect(onDisk?.pid).toBe(record.pid);
    expect(onDisk?.owner).toBe('cli');
  });

  it('adopts a proxy already on the port instead of duplicating it', async () => {
    const home = track(makeHome());
    const upstream = await startUpstream();
    live.closers.push(upstream.close);
    const proxyPort = await freePort();

    const first = await startViaCli(home, proxyPort, upstream.port);
    const firstPid = first.result.record?.pid;
    expect(firstPid).toBeGreaterThan(1);

    // A second start with the record intact is a no-op that says so.
    const again = await startViaCli(home, proxyPort, upstream.port);
    expect(again.result.action).toBe('already-running');
    expect(again.result.record?.pid).toBe(firstPid);

    // Now the harder case: the record is GONE (a crashed supervisor, a wiped
    // state dir) but the proxy is still serving. This is the ordinary path —
    // every CLI invocation is a new process that spawned none of them — so it
    // must adopt, not refuse and not start a second listener.
    rmSync(recordPathIn(home), { force: true });
    const adopted = await startViaCli(home, proxyPort, upstream.port);
    expect(adopted.result.action).toBe('adopted');
    expect(adopted.result.record?.pid).toBe(firstPid);
    expect(adopted.result.record?.owner).toBe('adopted');

    // Exactly one host process ever existed for this port.
    const hosts = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((line) => line.includes(ANTHROPIC_PROXY_HOST_FLAG) &&
        line.includes(ANTHROPIC_PROXY_COMMAND) &&
        argvBindsAnthropicPort(line, proxyPort));
    expect(hosts).toHaveLength(1);
  });

  it('refuses a listener it cannot prove is ours, and leaves it running', async () => {
    const home = track(makeHome());
    const upstream = await startUpstream();
    live.closers.push(upstream.close);

    // A foreign HTTP server on the port we want. It ANSWERS, so "something
    // replies" is not evidence of ownership — only the process table is.
    const foreign: Server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('not ours');
    });
    await new Promise<void>((done) => foreign.listen({ host: '127.0.0.1', port: 0 }, () => done()));
    const address = foreign.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const proxyPort = address.port;
    live.closers.push(
      () => new Promise<void>((done) => {
        foreign.closeAllConnections();
        foreign.close(() => done());
      }),
    );

    const refused = await startViaCli(home, proxyPort, upstream.port);
    expect(refused.status).toBe(1);
    expect(refused.result.ok).toBe(false);
    expect(refused.result.action).toBe('refused');
    expect(refused.result.record).toBeNull();

    // Still alive. Killing a stranger's listener is unrecoverable, so the
    // convention across this module family is to refuse and say so.
    expect(foreign.listening).toBe(true);
    expect(await getThroughProxy(proxyPort, '/anything')).toBe(200);
    // Nothing was recorded, either — a refusal must not leave a record claiming
    // ownership of something we do not own.
    expect(readAnthropicProxyRecord(recordPathIn(home))).toBeNull();
  });

  it('stops it, releases the port, and stopping nothing is a success', async () => {
    const home = track(makeHome());
    const upstream = await startUpstream();
    live.closers.push(upstream.close);
    const proxyPort = await freePort();

    const started = await startViaCli(home, proxyPort, upstream.port);
    const pid = started.result.record?.pid as number;
    expect(processAlive(pid)).toBe(true);

    const stopped = await runCliJson(home, [
      'proxy', 'stop', '--anthropic-port', String(proxyPort), '--port', String(upstream.port),
    ]);
    expect(stopped.status).toBe(0);
    expect(stopped.result.action).toBe('stopped');
    expect(processAlive(pid)).toBe(false);
    // A dead process is not a released port. This is the distinction isPortFree
    // exists for, so it is asserted rather than assumed.
    expect(await isPortFree('127.0.0.1', proxyPort)).toBe(true);
    expect(await anthropicProxyResponds('127.0.0.1', proxyPort)).toBe(false);
    // The record is gone, so the next start begins from a clean state.
    expect(readAnthropicProxyRecord(recordPathIn(home))).toBeNull();

    // IDEMPOTENT. `stop` runs on paths that may already have released it, and a
    // stop that errors when there is nothing to stop makes every teardown
    // script conditional.
    const again = await runCliJson(home, [
      'proxy', 'stop', '--anthropic-port', String(proxyPort), '--port', String(upstream.port),
    ]);
    expect(again.status).toBe(0);
    expect(again.result.ok).toBe(true);
    expect(again.result.action).toBe('not-running');
  });

  it('refuses a non-loopback bind host no matter who asks for it', async () => {
    const home = track(makeHome());
    const upstream = await startUpstream();
    live.closers.push(upstream.close);
    const proxyPort = await freePort();

    // ASHLR_LOCAL_RUNTIME_HOST is the widest lever available without editing
    // the persisted config, and it must not be enough. Neither this proxy nor
    // llama-server behind it authenticates anything: whoever reaches the port
    // can run inference and read every slot's prompt via /slots.
    const started = await startViaCli(home, proxyPort, upstream.port, {
      ASHLR_LOCAL_RUNTIME_HOST: '0.0.0.0',
    });

    expect(started.result.ok).toBe(true);
    expect(started.result.record?.host).toBe('127.0.0.1');
    expect(started.result.baseUrl).toBe(`http://127.0.0.1:${proxyPort}/v1`);
    // The record on disk agrees — nothing downstream can be told otherwise.
    expect(readAnthropicProxyRecord(recordPathIn(home))?.host).toBe('127.0.0.1');
    // The child logged the refusal rather than swallowing it.
    const log = readFileSync(join(home, '.ashlr', 'logs', 'anthropic-proxy.err.log'), 'utf8');
    expect(log).toContain('0.0.0.0');

    // The rule itself, stated once: only the PERSISTED opt-in opens it, and it
    // is the same `gateBindHost` llama-server is held to.
    expect(gateBindHost('0.0.0.0', false)).toEqual({ host: '127.0.0.1', downgradedFrom: '0.0.0.0' });
    expect(gateBindHost('0.0.0.0', true)).toEqual({ host: '0.0.0.0', downgradedFrom: null });
  });
});
