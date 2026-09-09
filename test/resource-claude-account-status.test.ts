/** Inert fixtures only: never execute a vendor CLI or inspect real authentication. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeClaudeAccountStatus, type ClaudeAccountStatusOptions } from '../src/core/resources/claude-account-status.js';
import * as verify from '../src/core/run/verify-commands.js';

let root: string;
const retained: string[] = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-claude-status-test-'))); });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  for (const directory of retained.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function options(patch: Partial<ClaudeAccountStatusOptions> = {}): ClaudeAccountStatusOptions {
  return { command: ['/fixture/launcher', '--owner-prefix'], cwd: root, timeoutMs: 5000, ...patch };
}
function processResult(payload: unknown = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
  patch: Partial<verify.VerifySubprocessResult> = {}): verify.VerifySubprocessResult {
  return { stdout: JSON.stringify(payload), stderr: '', exitCode: 0, timedOut: false, cancelled: false, signal: null,
    processGroupSettlement: 'group-exit-confirmed', ...patch };
}
function mock(payload?: unknown, patch?: Partial<verify.VerifySubprocessResult>) {
  return vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(processResult(payload, patch));
}

describe('Claude native account status', () => {
  it.each([false, true])('preserves lifecycle identity without invoking it (null prototype: %s)', async (nullPrototype) => {
    const prepare = vi.fn();
    const lifecycle = Object.assign(Object.create(nullPrototype ? null : Object.prototype), { prepare });
    const subprocess = mock();
    expect((await probeClaudeAccountStatus(options({ processGroupLifecycle: lifecycle }))).status).toBe('observed');
    expect(subprocess).toHaveBeenCalledTimes(1);
    const config = subprocess.mock.calls[0]![1];
    expect(config.processGroupLifecycle).toBe(lifecycle); expect(config.requireProcessGroupExit).toBe(true);
    expect(config.input).toBeUndefined(); expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects malformed lifecycle hooks before transport without reading accessors', async () => {
    const getter = vi.fn(() => vi.fn()); const prepare = vi.fn();
    const accessor = Object.defineProperty({}, 'prepare', { get: getter, enumerable: true });
    const subprocess = mock();
    for (const value of [null, [], {}, { prepare: null }, Object.create({ prepare }),
      { prepare, extra: true }, { prepare, [Symbol('extra')]: true }, accessor]) {
      await expect(probeClaudeAccountStatus(options({
        processGroupLifecycle: value as verify.VerifyProcessGroupLifecycle,
      }))).rejects.toThrow('Invalid Claude account status configuration');
    }
    expect(getter).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('uses exactly one JSON status invocation in a fresh private scratch and discards identity fields', async () => {
    const subprocess = mock({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max',
      email: 'PRIVATE_EMAIL', orgId: 'PRIVATE_ORG', apiKeySource: 'PRIVATE_SOURCE',
      projectsDirectory: 'PRIVATE_PATH', extra: { token: 'PRIVATE_TOKEN' } });
    const report = await probeClaudeAccountStatus(options());
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed',
      reason: 'status-login-observed', loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
    expect(subprocess).toHaveBeenCalledTimes(1);
    expect(subprocess.mock.calls[0]![0]).toEqual(['/fixture/launcher', '--owner-prefix', 'auth', 'status', '--json']);
    const config = subprocess.mock.calls[0]![1];
    expect(config.requireProcessGroupExit).toBe(true);
    expect(config.cwd).not.toBe(root); expect(config.cwd.startsWith(root)).toBe(false);
    expect(config.maxOutputChars).toBe(32 * 1024); expect(config.input).toBeUndefined();
    expect(config.timeoutMs).toBeGreaterThan(0); expect(config.timeoutMs).toBeLessThanOrEqual(5000);
    expect(existsSync(config.cwd)).toBe(false);
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    for (const key of ['observation', 'quota', 'ready', 'billing', 'command', 'cwd']) expect(report).not.toHaveProperty(key);
  });
  it('treats native exit1 with loggedIn:false/none as an observation, not a process failure', async () => {
    mock({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false,
      projectsDirectory: '/PRIVATE' }, { exitCode: 1 });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'observed', reason: 'status-not-logged-in',
      loggedIn: false, authMethod: 'none', subscriptionType: null });
  });
  it('normalizes only the actual native API-key method, without attaching a subscription', async () => {
    mock({ loggedIn: true, authMethod: 'api_key', subscriptionType: 'max' });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'observed', loggedIn: true,
      authMethod: 'api-key', subscriptionType: null });
  });
  it.each(['oauth_token', 'api_key_helper', 'third_party', 'api-key', 'PRIVATE_METHOD', '', null, 7])(
    'fails closed for unsupported method %#', async (authMethod) => {
      mock({ loggedIn: true, authMethod });
      expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'failed',
        reason: 'status-auth-method-unsupported', loggedIn: null, authMethod: 'unknown', subscriptionType: null });
    });
  it.each([undefined, null, 'PRIVATE_PLAN', { token: 'PRIVATE' }, 7])('drops unknown plan value %#', async (subscriptionType) => {
    mock({ loggedIn: true, authMethod: 'claude.ai', subscriptionType });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'observed', subscriptionType: null });
  });
  it.each([
    [{ loggedIn: false, authMethod: 'none' }, 0], [{ loggedIn: true, authMethod: 'claude.ai' }, 1],
    [{ loggedIn: true, authMethod: 'none' }, 0], [{ loggedIn: false, authMethod: 'claude.ai' }, 1],
    [{ loggedIn: 'true', authMethod: 'claude.ai' }, 0], [null, 0], [[], 0], [{}, 0],
  ])('rejects contradictory or malformed status %#', async (payload, exitCode) => {
    mock(payload, { exitCode: exitCode as number });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'failed', reason: 'status-output-invalid', loggedIn: null });
  });
  it('rejects mixed logs/JSON and never parses stderr as metadata', async () => {
    mock(undefined, { stdout: 'PRIVATE_LOG\n{}', stderr: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) });
    expect((await probeClaudeAccountStatus(options())).reason).toBe('status-output-invalid');
  });
  it('strips ambient account, cloud, proxy and loader variables using the shared environment', async () => {
    for (const key of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'HTTPS_PROXY', 'NODE_OPTIONS']) vi.stubEnv(key, 'PRIVATE');
    const subprocess = mock(); await probeClaudeAccountStatus(options());
    expect(Object.keys(subprocess.mock.calls[0]![1].env).sort()).toEqual(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).sort());
  });
});

describe('bounded redacted failures', () => {
  it.each([
    [{ exitCode: 2 }, 'failed', 'status-process-failed'], [{ exitCode: null }, 'failed', 'status-process-failed'],
    [{ signal: 'SIGTERM' }, 'failed', 'status-process-failed'], [{ error: 'PRIVATE' }, 'failed', 'status-process-failed'],
    [{ outputTruncated: true }, 'failed', 'status-output-limit'], [{ stdout: 'é'.repeat(20_000) }, 'failed', 'status-output-limit'],
    [{ stderr: 'é'.repeat(20_000) }, 'failed', 'status-output-limit'], [{ timedOut: true }, 'timed-out', 'status-timed-out'],
    [{ cancelled: true }, 'cancelled', 'status-cancelled'],
  ] as const)('reports fixed subprocess failure %#', async (patch, status, reason) => {
    const subprocess = mock(undefined, patch);
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status, reason, loggedIn: null, authMethod: 'unknown', subscriptionType: null });
    expect(subprocess).toHaveBeenCalledTimes(1);
  });
  it.each(['termination authority lost: PRIVATE', 'termination deadline elapsed with process-group exit unconfirmed'])(
    'retains uncertain cwd and prioritizes uncertain termination %#', async (error) => {
      const subprocess = mock(undefined, { error, cancelled: true, timedOut: true, processGroupSettlement: 'unconfirmed' });
      expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'uncertain', reason: 'status-termination-uncertain', loggedIn: null });
      const scratch = subprocess.mock.calls[0]![1].cwd; retained.push(scratch); expect(existsSync(scratch)).toBe(true);
    });
  it.each([undefined, 'unconfirmed'] as const)('rejects successful output without settlement receipt %s', async (processGroupSettlement) => {
    const subprocess = mock({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max',
      email: 'PRIVATE_EMAIL', orgId: 'PRIVATE_ORG' }, { processGroupSettlement });
    const report = await probeClaudeAccountStatus(options());
    expect(report).toMatchObject({ status: 'uncertain', reason: 'status-termination-uncertain', loggedIn: null,
      authMethod: 'unknown', subscriptionType: null, accountHint: null });
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    const scratch = subprocess.mock.calls[0]![1].cwd; retained.push(scratch); expect(existsSync(scratch)).toBe(true);
  });
  it.each(['not-started', 'group-exit-confirmed'] as const)('keeps settled failure semantics for %s', async (processGroupSettlement) => {
    const subprocess = mock(undefined, { exitCode: -1, error: 'PRIVATE_FAILURE', processGroupSettlement });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'failed', reason: 'status-process-failed', loggedIn: null });
    expect(existsSync(subprocess.mock.calls[0]![1].cwd)).toBe(false);
  });
  it('leaves native-created files in private scratch instead of deleting them', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (_, config) => {
      retained.push(config.cwd); writeFileSync(join(config.cwd, 'native-file'), 'fixture'); return processResult();
    });
    expect((await probeClaudeAccountStatus(options())).status).toBe('observed');
    expect(readFileSync(join(retained[0]!, 'native-file'), 'utf8')).toBe('fixture');
  });
  it.each(['sync-throw', 'rejection'] as const)('retains uncertainty after runner %s without settlement', async (failure) => {
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation((_, config) => {
      retained.push(config.cwd);
      if (failure === 'sync-throw') throw new Error('PRIVATE_RUNNER');
      return Promise.reject(new Error('PRIVATE_RUNNER'));
    });
    const report = await probeClaudeAccountStatus(options());
    expect(report).toMatchObject({ status: 'uncertain', reason: 'status-termination-uncertain',
      loggedIn: null, authMethod: 'unknown', subscriptionType: null, accountHint: null });
    expect(JSON.stringify(report)).not.toContain('PRIVATE'); expect(subprocess).toHaveBeenCalledTimes(1);
    expect(existsSync(retained[0]!)).toBe(true);
  });
  it('keeps scratch creation refusal a no-contact failure', async () => {
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync');
    vi.stubEnv('TMPDIR', join(root, 'PRIVATE_missing_scratch_root'));
    const report = await probeClaudeAccountStatus(options());
    expect(report).toMatchObject({ status: 'failed', reason: 'status-process-failed', loggedIn: null });
    expect(subprocess).not.toHaveBeenCalled(); expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('does not launch when pre-cancelled', async () => {
    const subprocess = mock(); const controller = new AbortController(); controller.abort();
    expect((await probeClaudeAccountStatus(options({ signal: controller.signal }))).status).toBe('cancelled');
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('honors abort arriving alongside a successful status', async () => {
    const controller = new AbortController();
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => { controller.abort(); return processResult(); });
    expect((await probeClaudeAccountStatus(options({ signal: controller.signal }))).status).toBe('cancelled');
  });
  it('withholds metadata when the monotonic deadline expires despite exit0', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => { now = 5000; return processResult(); });
    expect(await probeClaudeAccountStatus(options())).toMatchObject({ status: 'timed-out', loggedIn: null });
  });
});

describe('configuration and real inert execution', () => {
  it.each([
    { command: [] }, { command: ['relative'] }, { command: ['/fixture', 'bad\narg'] },
    { command: ['/fixture', 'x'.repeat(4097)] }, { command: Array(2) }, { command: Array(33).fill('/fixture') },
    { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { cwd: '/' }, { cwd: 'relative' },
    { unexpected: 'PRIVATE' }, { signal: {} },
  ])('rejects invalid configuration %# without launching', async (patch) => {
    const subprocess = mock();
    await expect(probeClaudeAccountStatus({ ...options(), ...patch } as ClaudeAccountStatusOptions)).rejects.toThrow('Invalid Claude account status configuration');
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('rejects getter configuration without executing it', async () => {
    const getter = vi.fn(() => ['/fixture']); const config = options();
    Object.defineProperty(config, 'command', { get: getter });
    await expect(probeClaudeAccountStatus(config)).rejects.toThrow('Invalid Claude account status configuration'); expect(getter).not.toHaveBeenCalled();
  });
  it('rejects nonprivate or symlink cwd', async () => {
    chmodSync(root, 0o755);
    await expect(probeClaudeAccountStatus(options())).rejects.toThrow('Invalid Claude account status configuration');
    chmodSync(root, 0o700); const link = join(root, 'alias'); symlinkSync(root, link);
    await expect(probeClaudeAccountStatus(options({ cwd: link }))).rejects.toThrow('Invalid Claude account status configuration');
  });
  it('runs a real inert fixture, forwards no input and cleans only its empty scratch', async () => {
    const fixture = join(root, 'fixture.cjs'); const receipt = join(root, 'receipt.json');
    writeFileSync(fixture, `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),mode:fs.statSync(process.cwd()).mode&511,input}));console.log(JSON.stringify({loggedIn:false,authMethod:'none',projectsDirectory:'PRIVATE'}));process.exitCode=1;});`);
    expect(await probeClaudeAccountStatus(options({ command: [process.execPath, fixture, '--prefix'] }))).toMatchObject({
      status: 'observed', loggedIn: false, authMethod: 'none' });
    const value = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(value.argv).toEqual(['--prefix', 'auth', 'status', '--json']); expect(value.input).toBe(''); expect(value.mode).toBe(0o700);
    expect(existsSync(value.cwd)).toBe(false);
  });
  it('cancels a real inert waiting process without retaining a running child', async () => {
    const original = verify.runVerifySubprocessAsync;
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation((argv, config) =>
      original(argv, { ...config, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
    const fixture = join(root, 'wait.cjs'); const receipt = join(root, 'cwd');
    writeFileSync(fixture, `process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({cwd:process.cwd(),pid:process.pid}));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const running = probeClaudeAccountStatus(options({ command: [process.execPath, fixture], signal: controller.signal }));
    await vi.waitFor(() => expect(existsSync(receipt)).toBe(true)); controller.abort();
    expect((await running).status).toBe('cancelled');
    const value = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(existsSync(value.cwd)).toBe(false); expect(() => process.kill(value.pid, 0)).toThrow();
  });
});
