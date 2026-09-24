/**
 * V3.10 Track B unit U2 — the autonomous profile under REAL sandbox-exec
 * (SPEC-310B §7 U2 key tests). Everything runs against a temp fake HOME; the
 * only real-home paths touched are the pinned grok/claude binaries, read-only,
 * for `--version`. Nothing here can launch an app, create a launchd job or
 * write a preference even if a rule regressed: every escape is either
 * guarded by a harmless probe first or aimed at a target that cannot exist.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  autonomousConfinementProfile,
  autonomousVerificationProfile,
  buildSandboxLauncher,
  probeAutonomousConfinement,
  type ConfinementProfile,
} from '../src/core/sandbox/confine.js';
import { applyAutonomousEnvOverlay, buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'confine-darwin-')));
const home = join(root, 'home');
const worktree = join(home, '.ashlr', 'sandboxes', 'sb1');

function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) {
      try { return realpathSync(candidate); } catch { /* next */ }
    }
  }
  return null;
}

let runCounter = 0;
interface Confined { status: number | null; signal: string | null; stdout: string; stderr: string }
function confined(engine: string, argv: string[], opts: { executables?: string[]; profile?: Partial<ConfinementProfile>; seat?: boolean } = {}): Confined {
  const run = join(root, `run-${runCounter++}`);
  mkdirSync(run, { mode: 0o700 });
  const overlay = buildAutonomousEnvOverlay({
    engine, runTmpDir: run, home, seatId: opts.seat ? 'grok-a' : null, executables: opts.executables,
    path: process.env['PATH'] ?? '/usr/bin:/bin',
  });
  const launcher = buildSandboxLauncher({ ...autonomousConfinementProfile(engine), ...opts.profile }, { worktree, home, overlay })!;
  const env = applyAutonomousEnvOverlay({ PATH: '/usr/bin:/bin', LANG: 'C' }, overlay);
  const r = spawnSync(launcher.bin, [...launcher.prefixArgs, ...argv], { cwd: worktree, env, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Same, without blocking the event loop — needed when the peer (a test server) lives in this process. */
function confinedAsync(engine: string, argv: string[], opts: { profile?: Partial<ConfinementProfile>; seat?: boolean; executables?: string[] } = {}): Promise<Confined> {
  const run = join(root, `run-${runCounter++}`);
  mkdirSync(run, { mode: 0o700 });
  const overlay = buildAutonomousEnvOverlay({
    engine, runTmpDir: run, home, seatId: opts.seat ? 'grok-a' : null, path: '/usr/bin:/bin', executables: opts.executables,
  });
  const launcher = buildSandboxLauncher({ ...autonomousConfinementProfile(engine), ...opts.profile }, { worktree, home, overlay })!;
  const env = applyAutonomousEnvOverlay({ PATH: '/usr/bin:/bin', LANG: 'C' }, overlay);
  return new Promise((resolve) => {
    const child = spawn(launcher.bin, [...launcher.prefixArgs, ...argv], { cwd: worktree, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

describe.runIf(process.platform === 'darwin')('autonomous confinement under real sandbox-exec', () => {
  const authorityFile = join(home, '.ashlr', 'authority', 'ledger.jsonl');
  const custodyBlob = join(home, 'Library', 'Application Support', 'ashlr-custody', 'signing-key.blob');

  beforeAll(() => {
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(home, '.ashlr', 'authority'), { recursive: true });
    writeFileSync(authorityFile, '{"secret":"ledger"}\n');
    mkdirSync(join(home, 'Library', 'Application Support', 'ashlr-custody'), { recursive: true });
    writeFileSync(custodyBlob, 'blob');
    mkdirSync(join(home, '.config', 'git'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    const state = join(home, '.ashlr', 'native-profiles', 'grok-a', 'native-state');
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o700);
    writeFileSync(join(state, 'auth.json'), '{"https://auth.x.ai::c":{"user_id":"u","principal_id":"p","team_id":"t","key":"a.b.c","refresh_token":"r"}}', { mode: 0o600 });
    writeFileSync(join(home, '.ashlr', 'native-profiles', 'grok-a', 'profile.json'), JSON.stringify({ provider: 'grok', nativeStatePath: state }));
  });

  it('the self-probe proves confinement works on this Mac', () => {
    expect(probeAutonomousConfinement({ force: true })).toMatchObject({ ok: true });
  }, 20_000);

  it('the worktree stays readable and writable', () => {
    const r = confined('local-coder', ['/bin/sh', '-c', 'echo ok > made.txt && cat made.txt']);
    expect(r).toMatchObject({ status: 0, stdout: 'ok\n' });
  });

  it('reading ~/.ashlr/authority or the custody dir fails — and kills the reader', () => {
    for (const target of [authorityFile, custodyBlob]) {
      const r = confined('local-coder', ['/bin/sh', '-c', `/bin/cat "${target}"; echo "status=$?"`]);
      expect(r.stdout).toContain('status=137');
      expect(r.stdout).not.toContain('secret');
      expect(r.stdout).not.toContain('blob');
      const direct = confined('local-coder', ['/bin/cat', target]);
      expect(direct.signal).toBe('SIGKILL');
    }
  });

  it.runIf(existsSync('/usr/local/libexec/ashlr-custody'))('the installed helper can be listed but never read, copied or run', () => {
    const helper = '/usr/local/libexec/ashlr-custody';
    expect(confined('local-coder', ['/bin/ls', '-l', helper]).status).toBe(0);
    expect(confined('local-coder', ['/bin/cp', helper, 'copied']).signal ?? confined('local-coder', ['/bin/cat', helper]).signal).toBe('SIGKILL');
    expect(confined('local-coder', [helper, 'status']).status).toBe(71);
  });

  it('writes to ~/.config/git and ~/.claude fail (no planted hooks for later)', () => {
    for (const target of [join(home, '.config', 'git', 'config'), join(home, '.claude', 'settings.json')]) {
      const r = confined('local-coder', ['/bin/sh', '-c', `echo planted > "${target}"`]);
      expect(r.status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    }
    const git = confined('local-coder', ['/bin/sh', '-c', 'echo "gitdir: /evil" > .git']);
    expect(git.status).not.toBe(0);
  });

  it('security, launchctl submit, open -a Terminal and osascript cannot run', () => {
    expect(confined('local-coder', ['/usr/bin/security', 'list-keychains']).status).toBe(71);
    // Guard first with harmless invocations: if exec ever became possible, the
    // mutating forms below are never attempted.
    const launchctlGuard = confined('local-coder', ['/bin/launchctl', 'version']);
    const openGuard = confined('local-coder', ['/usr/bin/open', '-h']);
    expect(launchctlGuard.status).toBe(71);
    expect(openGuard.status).toBe(71);
    if (launchctlGuard.status === 71) {
      expect(confined('local-coder', ['/bin/launchctl', 'submit', '-l', 'ai.ashlr.test.never', '--', '/usr/bin/false']).status).toBe(71);
    }
    if (openGuard.status === 71) {
      expect(confined('local-coder', ['/usr/bin/open', '-a', 'Terminal']).status).toBe(71);
    }
    expect(confined('local-coder', ['/usr/bin/osascript', '-e', 'return 1']).status).toBe(71);
    expect(confined('local-coder', ['/usr/bin/sudo', '-n', 'true']).status).toBe(71);
  });

  describe('loopback: only named model ports', () => {
    let allowed: Server;
    let other: Server;
    const ports: { allowed: number; other: number } = { allowed: 0, other: 0 };
    const listen = (s: Server) => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as { port: number }).port)));
    beforeAll(async () => {
      allowed = createServer((c) => c.end('model-server\n'));
      other = createServer((c) => c.end('other-local-service\n'));
      ports.allowed = await listen(allowed);
      ports.other = await listen(other);
    });
    afterAll(() => { allowed.close(); other.close(); });

    const connect = (port: number) => ['/usr/bin/nc', '-w', '2', '127.0.0.1', String(port)];
    it('a local engine reaches its model port and nothing else on loopback', async () => {
      const profile = { loopbackPorts: [ports.allowed] };
      expect((await confinedAsync('local-coder', connect(ports.allowed), { profile })).stdout).toContain('model-server');
      expect((await confinedAsync('local-coder', connect(ports.other), { profile })).stdout).not.toContain('other-local-service');
      // Control: the same client, unconfined, does reach the other service.
      const direct = await new Promise<string>((resolve) => {
        const c = spawn(connect(ports.other)[0]!, connect(ports.other).slice(1));
        let text = '';
        c.stdout.on('data', (d: Buffer) => { text += d.toString('utf8'); });
        c.on('close', () => resolve(text));
      });
      expect(direct).toContain('other-local-service');
    }, 20_000);
    it('an egress engine reaches no loopback service at all', async () => {
      const r = await confinedAsync('grok-cli', connect(ports.allowed), { seat: true });
      expect(r.stdout).not.toContain('model-server');
    }, 20_000);
  });

  it('agents cannot serve on loopback; a verification run can (test suites start servers)', async () => {
    const serveAndConnect = ['/usr/bin/env', 'node', '-e',
      "const s=require('net').createServer(c=>c.end('pong'));s.on('error',e=>{console.log('listen',e.code);process.exit(0)});" +
      "s.listen(0,'127.0.0.1',()=>{require('net').connect(s.address().port,'127.0.0.1').on('data',d=>{console.log(String(d));process.exit(0)}).on('error',e=>{console.log('connect',e.code);process.exit(0)})})"];
    const node = onPath('node');
    if (!node) return;
    const argv = [node, ...serveAndConnect.slice(2)];
    expect((await confinedAsync('local-coder', argv, { executables: [node] })).stdout).toContain('listen EPERM');
    expect((await confinedAsync('local-coder', argv, { executables: [node], profile: autonomousVerificationProfile() })).stdout).toContain('pong');
  }, 20_000);

  const grok = onPath('grok');
  it.runIf(grok !== null)('grok still runs (pinned binary, snapshot GROK_HOME)', () => {
    const r = confined('grok-cli', [grok!, '--no-auto-update', '--version'], { executables: [grok!], seat: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/grok \d+\.\d+/);
  }, 20_000);

  const claude = onPath('claude');
  it.runIf(claude !== null)('restricted claude still runs', () => {
    const r = confined('claude-cli', [claude!, '--restricted', '--version'], { executables: [claude!] });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Claude Code/);
  }, 20_000);

  const swiftc = existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : null;
  describe.runIf(swiftc !== null)('Keychain, Touch ID, Secure Enclave, pasteboard, LaunchServices and launchd via direct API calls', () => {
    const probe = join(root, 'probe');
    let compiled = false;
    beforeAll(() => {
      try {
        execFileSync(swiftc!, ['-O', '-o', probe, fileURLToPath(new URL('./fixtures/sandbox-probe/probe.swift', import.meta.url))],
          { stdio: 'pipe', timeout: 120_000 });
        compiled = true;
      } catch {
        compiled = false;
      }
    }, 130_000);

    it('every one of them is unreachable from the sandbox', () => {
      expect(compiled, 'swiftc is installed but the probe did not compile').toBe(true);
      const unconfined = JSON.parse(execFileSync(probe, { encoding: 'utf8' })) as Record<string, number | boolean>;
      const r = confined('local-coder', [probe]);
      expect(r.status).toBe(0);
      const inside = JSON.parse(r.stdout) as Record<string, number | boolean>;
      // Unsandboxed the Keychain answers "not found" (-25300); confined it is unreachable.
      expect(unconfined['keychainStatus']).toBe(-25300);
      expect(inside['keychainStatus']).not.toBe(-25300);
      expect(inside['laCanEvaluate']).toBe(false);
      expect(inside['secureEnclaveKey']).not.toBe(true);
      expect(inside['pasteboardTypes']).toBe(-1);
      // lsopen: "no app for this scheme" outside (-10814), permission error inside (-54).
      expect(unconfined['lsopenStatus']).toBe(-10814);
      expect(inside['lsopenStatus']).toBe(-54);
      // job-creation: launchd validates (and rejects) the dict outside; the sandbox refuses first inside.
      expect(inside['jobSubmitted']).toBe(false);
      expect(inside['jobErrorCode']).not.toBe(unconfined['jobErrorCode']);
    }, 30_000);
  });

  it('nothing escaped into the fake home', () => {
    expect(existsSync(join(home, '.config', 'git', 'config'))).toBe(false);
    expect(readFileSync(authorityFile, 'utf8')).toContain('ledger');
  });
});
