/** Inert help/version fixtures only. No vendor CLI, authentication or provider requests. */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkResourceLauncherCompatibility, type ResourceLauncherCompatibilityOptions,
  type ResourceLauncherProvider } from '../src/core/resources/launcher-compatibility.js';
import * as verify from '../src/core/run/verify-commands.js';

const FLAGS = {
  codex: ['--model', '--cd', '--sandbox', '--json', '--ephemeral', '--ignore-user-config'],
  claude: ['--print', '--model', '--output-format', '--verbose', '--no-session-persistence',
    '--safe-mode', '--restricted', '--strict-mcp-config', '--tools', '--permission-mode'],
  grok: ['--help'],
};
const VERSIONS = { codex: 'codex-cli 0.114.0', claude: '2.1.248 (Claude Code)', grok: 'grok 0.2.118 (1e1687c1cf6a)' };
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-launcher-check-test-'))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function options(provider: ResourceLauncherProvider = 'codex', patch: Partial<ResourceLauncherCompatibilityOptions> = {}) {
  return { provider, command: ['/fixture/owner-launcher', '--owner-prefix'], cwd: root, timeoutMs: 5000, ...patch };
}
function help(provider: ResourceLauncherProvider, flags = FLAGS[provider]) {
  return `Usage: ${provider}\n\nOptions:\n${flags.map((flag) => `  ${flag}  A fixture option.`).join('\n')}\n`;
}
function result(stdout: string, patch: Partial<verify.VerifySubprocessResult> = {}): verify.VerifySubprocessResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, cancelled: false, signal: null, ...patch };
}
function mock(provider: ResourceLauncherProvider = 'codex', outputs = [VERSIONS[provider], help(provider)]) {
  let index = 0;
  return vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => result(outputs[index++] ?? ''));
}
const GROK_HELP = ['grok 0.2.118 (1e1687c1cf6a)', 'Usage: grok\n\nCommands:\n  agent  Run Grok without UI\n\nOptions:\n  --version  Version\n',
  'Usage: grok agent [OPTIONS] [COMMAND]\n\nCommands:\n  stdio  Run the agent over stdio\n\nOptions:\n  --no-leader  New agent\n',
  'Run the agent over stdio\n\nUsage: grok agent stdio [OPTIONS]\n\nOptions:\n  -h, --help  Print help\n'];

describe('resource launcher help capability checks', () => {
  it.each(['codex', 'claude'] as const)('checks only the exact %s help/version suffixes', async (provider) => {
    const subprocess = mock(provider);
    const report = await checkResourceLauncherCompatibility(options(provider));
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'native-cli-help', provider, status: 'supported',
      reason: 'launcher-flags-advertised', version: provider === 'codex' ? '0.114.0' : '2.1.248',
      requiredFlags: FLAGS[provider], observedFlags: FLAGS[provider], missingFlags: [],
      hubTransport: 'native-cli', upstreamTransport: 'native-cli', upstreamCapability: 'advertised' });
    expect(subprocess.mock.calls.map(([argv]) => argv)).toEqual([
      ['/fixture/owner-launcher', '--owner-prefix', '--version'],
      ['/fixture/owner-launcher', '--owner-prefix', ...(provider === 'codex' ? ['exec', '--help'] : ['--help'])],
    ]);
    for (const [, config] of subprocess.mock.calls) {
      expect(config.cwd).toBe(root); expect(config.maxOutputChars).toBe(64 * 1024);
      expect(config).not.toHaveProperty('input'); expect(config.timeoutMs).toBeGreaterThan(0);
      expect(config.timeoutMs).toBeLessThanOrEqual(5000);
    }
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    for (const privateValue of ['/fixture', root, 'owner-prefix', 'A fixture option']) expect(JSON.stringify(report)).not.toContain(privateValue);
    for (const key of ['accountHint', 'quota', 'observation', 'authenticated', 'billing', 'command', 'cwd']) expect(report).not.toHaveProperty(key);
  });

  it('preserves HOME and only the shared worker environment, without ambient account, loader or billing variables', async () => {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'ANTHROPIC_PROFILE', 'NODE_OPTIONS', 'HTTPS_PROXY']) vi.stubEnv(key, 'PRIVATE_VALUE');
    const subprocess = mock(); await checkResourceLauncherCompatibility(options());
    const env = subprocess.mock.calls[0]![1].env;
    expect(env.HOME).toBe(process.env.HOME);
    expect(Object.keys(env).sort()).toEqual(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).sort());
  });

  it.each(FLAGS.codex)('withholds Codex support without advertised %s', async (missing) => {
    mock('codex', [VERSIONS.codex, help('codex', FLAGS.codex.filter((flag) => flag !== missing))]);
    expect(await checkResourceLauncherCompatibility(options())).toMatchObject({ status: 'incompatible',
      reason: 'launcher-required-flags-missing', missingFlags: [missing], upstreamCapability: 'unverified' });
  });
  it.each(FLAGS.claude)('withholds Claude support without advertised %s', async (missing) => {
    mock('claude', [VERSIONS.claude, help('claude', FLAGS.claude.filter((flag) => flag !== missing))]);
    expect(await checkResourceLauncherCompatibility(options('claude'))).toMatchObject({ status: 'incompatible', missingFlags: [missing] });
  });
  it('accepts conventional short aliases and CRLF declarations', async () => {
    mock('claude', [VERSIONS.claude, help('claude').replace('  --print', '  -p, --print').replace(/\n/g, '\r\n')]);
    expect((await checkResourceLauncherCompatibility(options('claude'))).status).toBe('supported');
  });
  it('never interprets prose, examples, prefix collisions or a different section as declared flags', async () => {
    mock('codex', [VERSIONS.codex, `Use ${FLAGS.codex.join(' ')}.\nExamples:\n${FLAGS.codex.map((flag) => `  ${flag}  sample`).join('\n')}\nOptions:\n${FLAGS.codex.map((flag) => `  ${flag}-other  sample`).join('\n')}\nNotes:\n${help('codex').replace('Options:', 'Example:')}`]);
    expect(await checkResourceLauncherCompatibility(options())).toMatchObject({ status: 'incompatible', observedFlags: [], missingFlags: FLAGS.codex });
  });
  it.each(['PRIVATE_VERSION fixture@example.invalid', 'codex-cli 0.114.0\nPRIVATE_EXTRA', '2.1.248 (Other Client)', '2026-09-08']) (
    'does not guess or expose unknown version format %#', async (version) => {
      mock('claude', [version, help('claude')]);
      expect(await checkResourceLauncherCompatibility(options('claude'))).toMatchObject({ status: 'supported', version: null });
    });
  it.each(['0.9.0', '1.99.999', '2.0.999', '2.1.247'])('rejects known Claude %s older than restricted mode', async (version) => {
    mock('claude', [`${version} (Claude Code)`, help('claude')]);
    expect(await checkResourceLauncherCompatibility(options('claude'))).toMatchObject({ status: 'incompatible',
      reason: 'launcher-version-incompatible', version, missingFlags: [] });
  });
  it.each(['2.1.248', '2.1.249', '2.2.0', '3.0.0'])('accepts advertised capabilities for Claude %s', async (version) => {
    mock('claude', [`${version} (Claude Code)`, help('claude')]);
    expect(await checkResourceLauncherCompatibility(options('claude'))).toMatchObject({ status: 'supported', version });
  });
  it('recognizes only numeric Codex version, not arbitrary release suffixes', async () => {
    mock('codex', ['codex-cli 0.114.0-alpha.1', help('codex')]);
    expect((await checkResourceLauncherCompatibility(options())).version).toBe('0.114.0');
  });

  it('discovers the complete Grok advertised stdio chain without initializing ACP or claiming Hub support', async () => {
    const subprocess = mock('grok', GROK_HELP);
    expect(await checkResourceLauncherCompatibility(options('grok'))).toMatchObject({ status: 'incompatible',
      reason: 'launcher-hub-transport-not-implemented', version: '0.2.118', hubTransport: 'not-implemented',
      upstreamTransport: 'acp', upstreamCapability: 'advertised', observedFlags: ['--help'], missingFlags: [] });
    expect(subprocess.mock.calls.map(([argv]) => argv.slice(2))).toEqual([
      ['--no-auto-update', '--version'], ['--no-auto-update', '--help'],
      ['--no-auto-update', 'agent', '--help'], ['--no-auto-update', 'agent', 'stdio', '--help'],
    ]);
    expect(subprocess.mock.calls.every(([, config]) => config.input === undefined)).toBe(true);
  });
  it.each([1, 2, 3])('withholds unknown Grok upstream capability at help stage %s', async (stage) => {
    const output = [...GROK_HELP]; output[stage] = 'Unknown command help';
    const subprocess = mock('grok', output);
    expect(await checkResourceLauncherCompatibility(options('grok'))).toMatchObject({ status: 'incompatible',
      reason: 'launcher-upstream-capability-unverified', upstreamCapability: 'unverified', hubTransport: 'not-implemented' });
    expect(subprocess).toHaveBeenCalledTimes(stage + 1);
  });
});

describe('bounded compatibility failures and validation', () => {
  it.each([
    [{ exitCode: 1 }, 'launcher-process-failed'], [{ signal: 'SIGTERM' }, 'launcher-process-failed'],
    [{ error: 'PRIVATE_ERROR' }, 'launcher-process-failed'], [{ outputTruncated: true }, 'launcher-output-limit'],
    [{ stdout: 'é'.repeat(40_000) }, 'launcher-output-limit'], [{ stderr: 'é'.repeat(40_000) }, 'launcher-output-limit'],
    [{ timedOut: true }, 'launcher-timed-out'], [{ cancelled: true }, 'launcher-cancelled'],
    [{ error: 'termination authority lost: PRIVATE' }, 'launcher-termination-uncertain'],
    [{ error: 'termination deadline elapsed with process-group exit unconfirmed' }, 'launcher-termination-uncertain'],
  ] as const)('stops after a bounded subprocess failure %# with redacted reason', async (patch, reason) => {
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(result('PRIVATE_STDOUT', { stderr: 'PRIVATE_STDERR', ...patch }));
    const report = await checkResourceLauncherCompatibility(options());
    expect(report).toMatchObject({ status: 'unavailable', reason, version: null, observedFlags: [] });
    expect(JSON.stringify(report)).not.toContain('PRIVATE'); expect(subprocess).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain termination ahead of timeout/cancellation', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(result('', { cancelled: true, timedOut: true,
      error: 'termination authority lost: fixture' }));
    expect((await checkResourceLauncherCompatibility(options())).reason).toBe('launcher-termination-uncertain');
  });
  it('redacts thrown subprocess errors', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockRejectedValue(new Error('PRIVATE native path'));
    expect((await checkResourceLauncherCompatibility(options())).reason).toBe('launcher-process-failed');
  });
  it('uses one decreasing monotonic allowance, not a fresh timeout per command', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => {
      now += 750; return result(now === 750 ? VERSIONS.codex : help('codex'));
    });
    expect((await checkResourceLauncherCompatibility(options('codex', { timeoutMs: 2000 }))).status).toBe('supported');
    expect(subprocess.mock.calls.map(([, config]) => config.timeoutMs)).toEqual([2000, 1250]);
  });
  it('does not launch help after version has exhausted the shared budget', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => { now = 2000; return result(VERSIONS.codex); });
    expect((await checkResourceLauncherCompatibility(options('codex', { timeoutMs: 2000 }))).reason).toBe('launcher-timed-out');
    expect(subprocess).toHaveBeenCalledTimes(1);
  });
  it('does not start a cancelled check', async () => {
    const controller = new AbortController(); controller.abort(); const subprocess = mock();
    expect((await checkResourceLauncherCompatibility(options('codex', { signal: controller.signal }))).reason).toBe('launcher-cancelled');
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('does not continue after cancellation during version', async () => {
    const controller = new AbortController();
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => { controller.abort(); return result(VERSIONS.codex); });
    expect((await checkResourceLauncherCompatibility(options('codex', { signal: controller.signal }))).reason).toBe('launcher-cancelled');
    expect(subprocess).toHaveBeenCalledTimes(1);
  });
  it('pins mutable caller configuration before awaiting the first command', async () => {
    const request = options(); let calls = 0;
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => {
      request.command[0] = '/private/changed'; request.cwd = '/private/changed'; request.provider = 'claude';
      return result(++calls === 1 ? VERSIONS.codex : help('codex'));
    });
    expect((await checkResourceLauncherCompatibility(request)).status).toBe('supported');
    expect(subprocess.mock.calls[1]![0][0]).toBe('/fixture/owner-launcher'); expect(subprocess.mock.calls[1]![1].cwd).toBe(root);
  });
  it('rechecks private directory before the next subprocess without repairing permissions', async () => {
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => { chmodSync(root, 0o755); return result(VERSIONS.codex); });
    expect((await checkResourceLauncherCompatibility(options())).reason).toBe('launcher-directory-unavailable');
    expect(subprocess).toHaveBeenCalledTimes(1);
  });
  it.each([
    { provider: 'unknown' }, { command: [] }, { command: ['relative'] }, { command: ['/fixture', 'bad\nargument'] },
    { command: ['/fixture', 'bad\u0085argument'] }, { command: ['/fixture', 'x'.repeat(4097)] },
    { command: Array(33).fill('/fixture') }, { command: ['/fixture', ...Array(5).fill('x'.repeat(4096))] },
    { cwd: '/' }, { cwd: 'relative' }, { cwd: '/private/../private' }, { cwd: '/private/' }, { cwd: '/missing-private-fixture' },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 }, { timeoutMs: NaN }, { signal: {} }, { extra: true },
  ])('rejects invalid configuration %# before any command', async (patch) => {
    const subprocess = mock();
    await expect(checkResourceLauncherCompatibility({ ...options(), ...patch } as ResourceLauncherCompatibilityOptions))
      .rejects.toThrow('Invalid resource launcher compatibility configuration');
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('rejects getters, sparse or decorated arrays without evaluating getters', async () => {
    const subprocess = mock(); const getter = vi.fn(() => '/fixture/secret');
    const command = ['/fixture']; Object.defineProperty(command, '0', { get: getter });
    const configurations = [options('codex', { command }), options('codex', { command: Array(1) }),
      options('codex', { command: Object.assign(['/fixture'], { extra: true }) }),
      Object.defineProperty(options(), 'provider', { get: getter })];
    for (const config of configurations) await expect(checkResourceLauncherCompatibility(config)).rejects.toThrow('Invalid resource launcher compatibility configuration');
    expect(getter).not.toHaveBeenCalled(); expect(subprocess).not.toHaveBeenCalled();
  });
  it('rejects a symlink or nonprivate directory without changing it', async () => {
    const subprocess = mock(); const alias = join(root, 'alias'); symlinkSync(root, alias);
    await expect(checkResourceLauncherCompatibility(options('codex', { cwd: alias }))).rejects.toThrow('Invalid resource launcher compatibility configuration');
    chmodSync(root, 0o755);
    await expect(checkResourceLauncherCompatibility(options())).rejects.toThrow('Invalid resource launcher compatibility configuration');
    expect(subprocess).not.toHaveBeenCalled();
  });
});

describe('real bounded inert launcher acceptance', () => {
  it.each(['claude', 'grok'] as const)('runs only %s help/version and closes stdin with no native client', async (provider) => {
    const log = join(root, 'calls.jsonl'); const launcher = join(root, 'fixture.cjs');
    const outputs = provider === 'grok' ? GROK_HELP : [VERSIONS.claude, help('claude')];
    const suffixes = provider === 'grok' ? [['--no-auto-update', '--version'], ['--no-auto-update', '--help'],
      ['--no-auto-update', 'agent', '--help'], ['--no-auto-update', 'agent', 'stdio', '--help']]
      : [['--version'], ['--help']];
    writeFileSync(launcher, `const fs=require('node:fs');const argv=process.argv.slice(2);const variants=${JSON.stringify(suffixes)};
const index=variants.findIndex(v=>JSON.stringify(v)===JSON.stringify(argv));let input='';process.stdin.on('data',x=>input+=x);
process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({argv,input,pid:process.pid,cwd:process.cwd()})+'\\n');
if(index<0){process.exitCode=2;return;}process.stdout.write(${JSON.stringify(outputs)}[index]);});`);
    const report = await checkResourceLauncherCompatibility(options(provider, { command: [process.execPath, launcher] }));
    expect(report.status).toBe(provider === 'grok' ? 'incompatible' : 'supported');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv)).toEqual(suffixes);
    expect(calls.every((call) => call.input === '' && call.cwd === root)).toBe(true);
    for (const call of calls) expect(() => process.kill(call.pid, 0)).toThrow();
    expect(JSON.stringify(report)).not.toContain(root);
  });
});
