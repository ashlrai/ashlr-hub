/** Actual built CLI, private fixtures and inert help-only launchers. No provider accounts. */
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceGenerationRuntimeCheck } from '../src/core/universe/resource-runtime-check.js';
import type { ResourceLauncherCompatibilityResult } from '../src/core/resources/launcher-compatibility.js';

const CLI = resolve('dist/cli/index.js');
const fixtures: Array<{ base: string; server: Server; contacts: string[] }> = [];
const save = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await new Promise<void>((done, reject) => f.server.close((error) => error ? reject(error) : done()));
    expect(f.contacts).toEqual([]);
    rmSync(f.base, { recursive: true, force: true });
  }
});

function tree(path: string): unknown {
  const stat = lstatSync(path);
  return stat.isDirectory() ? { mode: stat.mode, entries: readdirSync(path).sort().filter((name) => name !== 'help-invocations.jsonl')
    .map((name) => [name, tree(join(path, name))]) } : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

async function cli(base: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    execFile(process.execPath, [CLI, ...args], { cwd: base, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
      if (error && (error.killed || error.signal || typeof error.code !== 'number')) { reject(error); return; }
      done({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-commissioning-cli-')));
  const contacts: string[] = [];
  const server = createServer((request, response) => {
    contacts.push(`${request.method} ${request.url}`); response.writeHead(503).end('No model transport permitted in commissioning checks');
  });
  fixtures.push({ base, server, contacts });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const workspace = join(base, 'workspace'); const launcherCwd = join(base, 'launcher-cwd');
  mkdirSync(workspace, { mode: 0o700 }); mkdirSync(launcherCwd, { mode: 0o700 });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '--template=', workspace], { timeout: 5000, stdio: 'pipe',
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const marker = join(base, 'help-invocations.jsonl'); const script = join(base, 'inert-help.cjs');
  const codexFlags = ['--model', '--cd', '--sandbox', '--json', '--ephemeral', '--ignore-user-config'];
  const claudeFlags = ['--print', '--model', '--output-format', '--verbose', '--no-session-persistence', '--safe-mode',
    '--restricted', '--strict-mcp-config', '--tools', '--permission-mode'];
  writeFileSync(script, `
const fs=require('node:fs');const provider=process.argv[2];const args=process.argv.slice(3);
const rawArgs=[...args];if(provider==='grok'&&args[0]==='--no-auto-update')args.shift();
const key=JSON.stringify(args);const log=value=>fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(value)+'\\n',{mode:0o600});
log({provider,args:rawArgs});process.stdin.on('data',()=>{log({unexpected:'stdin'});process.exitCode=83;});
const flags=${JSON.stringify({ codex: codexFlags, claude: claudeFlags })};
if(key==='["--version"]')console.log(provider==='codex'?'codex-cli 0.114.0':provider==='claude'?'2.1.248 (Claude Code)':'grok 0.2.118 (1e1687c1cf6a)');
else if(provider==='codex'&&key==='["exec","--help"]'||provider==='claude'&&key==='["--help"]')console.log('Usage: fixture\\n\\nOptions:\\n'+flags[provider].map(flag=>'  '+flag+'  Private help text').join('\\n'));
else if(provider==='grok'&&key==='["--help"]')console.log('Usage: grok\\n\\nCommands:\\n  agent  Run the agent\\n');
else if(provider==='grok'&&key==='["agent","--help"]')console.log('Usage: grok agent\\n\\nCommands:\\n  stdio  Run over stdio\\n');
else if(provider==='grok'&&key==='["agent","stdio","--help"]')console.log('Usage: grok agent stdio [OPTIONS]\\n\\nOptions:\\n  -h, --help  Show help\\n');
else{log({unexpected:'non-help invocation'});process.exitCode=84;}
`, { mode: 0o600 });
  const codexCommand = [process.execPath, script, 'codex'];
  const pool = { schemaVersion: 1, id: 'commissioning-fleet', workers: ['codex-a', 'codex-b', 'claude-a', 'local-a'].map((id) => ({
    id, provider: id.startsWith('codex') ? 'codex' : id.startsWith('claude') ? 'claude' : 'local', model: 'private-model',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 })) };
  const bindings = pool.workers.map((worker) => worker.provider === 'local'
    ? { workerId: worker.id, capacityKey: worker.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }
    : { workerId: worker.id, capacityKey: worker.id, kind: 'native-cli', command: worker.provider === 'codex' ? codexCommand
      : [process.execPath, script, 'claude'] });
  const poolDigest = digest(canonical({ pool, bindings })); const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  const observations = pool.workers.map((worker) => ({ workerId: worker.id, observedAt: at(-1000), expiresAt: at(120_000),
    health: 'ready', retryAfter: null, windows: worker.provider === 'local' ? [] : [{ id: 'weekly', usedPercent: 20, resetsAt: at(180_000) }] }));
  const runtime = { schemaVersion: 1, poolPath: join(base, 'pool.json'), bindingsPath: join(base, 'bindings.json'),
    observationsPath: join(base, 'observations.json'), root: join(base, 'ledger'), workspace,
    quotaConfigPath: join(base, 'quota.json'), localModelConfigPath: join(base, 'local.json') };
  const runtimePath = join(base, 'runtime.json');
  save(runtime.poolPath, pool); save(runtime.bindingsPath, bindings); save(runtime.observationsPath, observations); save(runtimePath, runtime);
  save(runtime.quotaConfigPath, { schemaVersion: 1, poolDigest, workers: ['codex-a', 'codex-b'].map((workerId, index) =>
    ({ workerId, accountHint: (index ? 'b' : 'a').repeat(64), bucketIds: ['codex'] })) });
  save(runtime.localModelConfigPath, { schemaVersion: 1, poolDigest, workers: [{ workerId: 'local-a', modelDigest: `sha256:${'c'.repeat(64)}` }] });
  const commands = { codex: join(base, 'codex-command.json'), claude: join(base, 'claude-command.json'), grok: join(base, 'grok-command.json') };
  for (const provider of ['codex', 'claude', 'grok'] as const) save(commands[provider], [process.execPath, script, provider]);
  return { base, contacts, marker, launcherCwd, runtime, runtimePath, commands, poolDigest, observations, at,
    events: () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [],
    check: () => cli(base, ['universe', 'resources', 'check', '--resource-runtime', runtimePath, '--json']),
    launcher: (provider: 'codex' | 'claude' | 'grok') => cli(base, ['resources', 'launcher', 'check', '--provider', provider,
      '--command', commands[provider], '--cwd', launcherCwd, '--timeout-ms', '5000', '--json']) };
}

function redacted(stdout: string, base: string): void {
  for (const privateValue of [base, 'private-model', '127.0.0.1', 'a'.repeat(64), 'b'.repeat(64), 'sha256:', 'Private help text', 'inert-help.cjs']) {
    expect(stdout).not.toContain(privateValue);
  }
}

describe.skipIf(process.platform === 'win32')('built resource commissioning commands', () => {
  it('checks the actual four-worker runtime without dispatch, shows duplicate capacity risk and leaves a missing store absent', async () => {
    const f = await fixture(); const before = tree(f.base); const result = await f.check();
    expect(result.code).toBe(0); expect(result.stderr).toBe(''); redacted(result.stdout, f.base);
    const report = JSON.parse(result.stdout) as ResourceGenerationRuntimeCheck;
    expect(report).toMatchObject({ status: 'valid', evidenceScope: 'local-configuration-only', providerContacted: false,
      poolDigest: f.poolDigest, sourceState: 'missing' });
    expect(report.workers.map((worker) => [worker.workerId, worker.provider, worker.eligibility])).toEqual([
      ['codex-a', 'codex', 'eligible'], ['codex-b', 'codex', 'eligible'], ['claude-a', 'claude', 'eligible'], ['local-a', 'local', 'eligible']]);
    expect(report.workers.slice(0, 2).every((row) => row.quotaRefreshConfigured &&
      row.warnings.includes('duplicate-native-command-across-capacities'))).toBe(true);
    expect(report.workers[2]!.warnings).toContain('quota-refresh-not-configured'); expect(report.workers[3]!.localModelRefreshConfigured).toBe(true);
    expect(f.events()).toEqual([]); expect(f.contacts).toEqual([]); expect(tree(f.base)).toEqual(before); expect(existsSync(f.runtime.root)).toBe(false);
  });
  it('preserves a real prior reservation and valid-but-excluded status with exit zero', async () => {
    const f = await fixture(); mkdirSync(f.runtime.root, { mode: 0o700 });
    save(join(f.runtime.root, 'pool-state.json'), { schemaVersion: 1, poolDigest: f.poolDigest, observations: [], attempts: [{
      schemaVersion: 1, id: 'prior-owner', taskDigest: 'd'.repeat(64), poolDigest: f.poolDigest, workerId: 'codex-a', capacityKey: 'codex-a',
      status: 'reserved', startedAt: f.at(-500), finishedAt: null, outputDigest: null, inputTokens: null, outputTokens: null,
      reason: 'resource-task-reserved', verifiedAccepted: false,
    }] });
    const before = tree(f.base); const result = await f.check(); expect(result.code).toBe(0); redacted(result.stdout, f.base);
    const report = JSON.parse(result.stdout) as ResourceGenerationRuntimeCheck;
    expect(report).toMatchObject({ status: 'valid', sourceState: 'healthy' });
    expect(report.workers[0]).toMatchObject({ eligibility: 'excluded', exclusionReasons: ['concurrency-exhausted'] });
    expect(report.workers[1]!.eligibility).toBe('eligible'); expect(f.events()).toEqual([]); expect(tree(f.base)).toEqual(before);
  });
  it('returns fixed invalid-runtime and invalid-argument statuses without provider startup or private errors', async () => {
    const f = await fixture(); writeFileSync(f.runtime.localModelConfigPath, `${f.base} MALFORMED_PRIVATE_CONFIG`);
    const before = tree(f.base); const invalid = await f.check(); expect(invalid.code).toBe(1); redacted(invalid.stdout, f.base);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ status: 'invalid', workers: [], poolId: null, providerContacted: false });
    expect(JSON.parse(invalid.stdout).checks).toContainEqual({ code: 'local-model-refresh', status: 'failed' });
    const syntax = await cli(f.base, ['universe', 'resources', 'check', '--resource-runtime', 'relative.json', '--json']);
    expect(syntax.code).toBe(2); expect(JSON.parse(syntax.stdout).error).toEqual(expect.any(String));
    expect(f.events()).toEqual([]); expect(tree(f.base)).toEqual(before); expect(existsSync(f.runtime.root)).toBe(false);
  });
  it('runs only Codex and Claude help/version and separates advertised Grok ACP from unimplemented Hub execution', async () => {
    const f = await fixture(); const before = tree(f.base);
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      const result = await f.launcher(provider); expect(result.code).toBe(provider === 'grok' ? 1 : 0);
      expect(result.stderr).toBe(''); redacted(result.stdout, f.base);
      const report = JSON.parse(result.stdout) as ResourceLauncherCompatibilityResult;
      expect(report).toMatchObject({ provider, scope: 'native-cli-help', upstreamCapability: 'advertised', missingFlags: [],
        status: provider === 'grok' ? 'incompatible' : 'supported',
        hubTransport: provider === 'grok' ? 'not-implemented' : 'native-cli',
        reason: provider === 'grok' ? 'launcher-hub-transport-not-implemented' : 'launcher-flags-advertised' });
    }
    expect(f.events()).toEqual([
      { provider: 'codex', args: ['--version'] }, { provider: 'codex', args: ['exec', '--help'] },
      { provider: 'claude', args: ['--version'] }, { provider: 'claude', args: ['--help'] },
      { provider: 'grok', args: ['--no-auto-update', '--version'] }, { provider: 'grok', args: ['--no-auto-update', '--help'] },
      { provider: 'grok', args: ['--no-auto-update', 'agent', '--help'] }, { provider: 'grok', args: ['--no-auto-update', 'agent', 'stdio', '--help'] },
    ]);
    expect(tree(f.base)).toEqual(before); expect(f.contacts).toEqual([]); expect(existsSync(f.runtime.root)).toBe(false);
  });
  it('does not launch any executable for an invalid private command file', async () => {
    const f = await fixture(); save(f.commands.codex, { privateCommand: f.base }); const before = tree(f.base);
    const result = await f.launcher('codex'); expect(result.code).toBe(1); redacted(result.stdout, f.base);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'Native launcher compatibility check unavailable' });
    expect(f.events()).toEqual([]); expect(tree(f.base)).toEqual(before);
  });
});
