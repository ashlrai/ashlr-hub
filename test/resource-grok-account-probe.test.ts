/** Inert subprocess fixtures only. No installed Grok, native credentials, network, or inference. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeGrokAccount, type GrokAccountProbeOptions } from '../src/core/resources/grok-account-probe.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as verify from '../src/core/run/verify-commands.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-grok-probe-fixture-'))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const EMAIL = 'fixture@example.invalid';
const ACCOUNT = { methodId: 'cached_token', email: EMAIL, principalId: null, principalType: null, teamId: null, organizationId: null,
  profileImageUrl: 'https://private.example.invalid/avatar', firstName: 'PRIVATE_FIRST_NAME' };
const HINT = digest(canonical({ schemaVersion: 1, provider: 'grok', methodId: 'cached_token', email: EMAIL,
  principalId: null, principalType: null, teamId: null, organizationId: null }));
const INIT = { protocolVersion: 1, agentCapabilities: {}, _meta: { grokShell: true, agentVersion: '0.2.118',
  currentWorkingDirectory: '/private/unknown', agentId: 'PRIVATE_AGENT_ID' } };
const BILLING = { config: { creditUsagePercent: 37.25, isUnifiedBillingUser: true,
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2030-01-01T00:00:00Z', end: '2030-01-08T00:00:00Z' },
  prepaidBalance: { val: 500 }, history: [{ PRIVATE_HISTORY: EMAIL }] }, subscription_tier: 'SuperGrok Heavy', on_demand_enabled: false };

describe('in-process Grok lifecycle ownership', () => {
  it.each([false, true])('preserves lifecycle identity without invoking or serializing it (null prototype: %s)', async (nullPrototype) => {
    const prepare = vi.fn();
    const lifecycle = Object.assign(Object.create(nullPrototype ? null : Object.prototype), { prepare });
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: '', stderr: '',
      exitCode: 1, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'not-started' });
    await probeGrokAccount(options({}, { processGroupLifecycle: lifecycle }));
    expect(subprocess).toHaveBeenCalledTimes(1);
    const config = subprocess.mock.calls[0]![1];
    expect(config.processGroupLifecycle).toBe(lifecycle); expect(config.requireProcessGroupExit).toBe(true);
    expect(JSON.parse(config.input!)).not.toHaveProperty('processGroupLifecycle');
    expect(config.input).not.toContain('prepare'); expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects malformed lifecycle hooks before transport without reading accessors', async () => {
    const getter = vi.fn(() => vi.fn()); const prepare = vi.fn();
    const accessor = Object.defineProperty({}, 'prepare', { get: getter, enumerable: true });
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync');
    for (const value of [null, [], {}, { prepare: null }, Object.create({ prepare }),
      { prepare, extra: true }, { prepare, [Symbol('extra')]: true }, accessor]) {
      await expect(probeGrokAccount(options({}, {
        processGroupLifecycle: value as verify.VerifyProcessGroupLifecycle,
      }))).rejects.toThrow('Invalid Grok account probe configuration');
    }
    expect(getter).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(subprocess).not.toHaveBeenCalled();
  });
});

function options(config: Record<string, unknown> = {}, patch: Partial<GrokAccountProbeOptions> = {}): GrokAccountProbeOptions {
  const script = join(root, 'native.cjs');
  writeFileSync(script, `
const fs=require('node:fs');const readline=require('node:readline');const c=${JSON.stringify(config)};
const log={argv:process.argv.slice(2),env:process.env,cwd:process.cwd(),pid:process.pid,requests:[]};
const save=()=>fs.writeFileSync(${JSON.stringify(join(root, 'invocation.json'))},JSON.stringify(log));save();
const init=Object.hasOwn(c,'init')?c.init:${JSON.stringify(INIT)};
const account=Object.hasOwn(c,'account')?c.account:${JSON.stringify(ACCOUNT)};
const billing=Object.hasOwn(c,'billing')?c.billing:${JSON.stringify(BILLING)};
const after=Object.hasOwn(c,'after')?c.after:account;
const emit=(row)=>{const value=JSON.stringify(row)+'\\n';if(c.split){const m=Math.floor(value.length/2);process.stdout.write(value.slice(0,m));process.stdout.write(value.slice(m));}else process.stdout.write(value);};
if(c.stderr)process.stderr.write(c.stderr);
if(c.keepFile)fs.writeFileSync('native-created.txt','fixture-only');
if(c.ignoreSignals){process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});}
const reader=readline.createInterface({input:process.stdin});
reader.on('line',(line)=>{const r=JSON.parse(line);log.requests.push(r);save();
 if(c.hangAt===r.id){setInterval(()=>{},1000);return;}
 if(c.earlyAt===r.id){reader.close();process.stdin.destroy();return;}
 if(c.rawAt===r.id){process.stdout.write(c.raw);return;}
 if(c.bytesAt===r.id){process.stdout.write(Buffer.from(c.bytes));return;}
 if(c.errorAt===r.id){emit({jsonrpc:'2.0',id:r.id,error:{code:c.errorCode||-32000,message:'PRIVATE_PROVIDER_ERROR '+${JSON.stringify(EMAIL)}}});return;}
 if(c.requestAt===r.id){emit({jsonrpc:'2.0',id:800,method:'_x.ai/auth/getBearerToken',params:{PRIVATE_SECRET:'secret'}});return;}
 if(c.noticeAt===r.id)for(let i=0;i<(c.noticeCount||1);i++)emit({jsonrpc:'2.0',method:c.noticeMethod||'_fixture/notice',params:{PRIVATE_SECRET:'secret'},...c.noticeExtra});
 const result=r.id===1?init:r.id===2?account:r.id===3?billing:after;
 emit({jsonrpc:'2.0',id:c.wrongAt===r.id?999:r.id,result});
 if(c.duplicateAt===r.id)emit({jsonrpc:'2.0',id:r.id,result});
});
reader.on('close',()=>{if(c.holdAfterEOF)setInterval(()=>{},1000);else if(c.drainMs)setTimeout(()=>{process.exitCode=c.exitCode||0;},c.drainMs);else process.exitCode=c.exitCode||0;});
`);
  return { command: [process.execPath, script], cwd: root, timeoutMs: 7000, ...patch };
}
function invocation(): { argv: string[]; env: Record<string, string>; cwd: string; pid: number; requests: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, 'invocation.json'), 'utf8'));
}
function failClosed(result: Awaited<ReturnType<typeof probeGrokAccount>>): void {
  expect(result).toMatchObject({ accountHint: null, planType: null, loggedIn: null, windows: [], onDemandEnabled: null, observedAt: null, expiresAt: null });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fixture@example|private\.example|\/private\/unknown/);
}
function acceleratedOwnership(): void {
  const real = verify.runVerifySubprocessAsync;
  vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation((argv, config) => real(argv, { ...config, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
}

describe('Grok fixed native metadata protocol', () => {
  it('observes live billing with before/after identity and no session or authentication commands', async () => {
    const result = await probeGrokAccount(options({ split: true, stderr: 'PRIVATE_STDERR' }, { expectedAccountHint: HINT }));
    expect(result).toMatchObject({ schemaVersion: 1, scope: 'grok-native-metadata', status: 'observed', reason: 'probe-observed',
      accountHint: HINT, planType: 'SuperGrok Heavy', loggedIn: true, onDemandEnabled: false,
      windows: [{ id: 'grok_unified_weekly', usedPercent: 37.25, resetsAt: '2030-01-08T00:00:00.000Z' }] });
    expect(result.observedAt).toBe(result.startedAt);
    expect(Date.parse(result.expiresAt!)).toBe(Date.parse(result.startedAt) + 60_000);
    const log = invocation();
    expect(log.argv).toEqual(['--no-auto-update', 'agent', '--no-leader', 'stdio']);
    expect(log.requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'ashlr_hub_grok_account_probe', version: '1' },
        _meta: { startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true } } } },
      { jsonrpc: '2.0', id: 2, method: '_x.ai/auth/info', params: {} },
      { jsonrpc: '2.0', id: 3, method: '_x.ai/billing', params: {} },
      { jsonrpc: '2.0', id: 4, method: '_x.ai/auth/info', params: {} },
    ]);
    expect(log.cwd).not.toBe(root); expect(log.cwd).toContain('ashlr-grok-metadata-'); expect(existsSync(log.cwd)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fixture@example|private\.example|prepaid|history|\/private\/unknown/);
  });
  it('does not inherit credentials, provider homes, endpoint, proxy or loader overrides', async () => {
    for (const key of ['XAI_API_KEY', 'GROK_HOME', 'GROK_XAI_API_BASE_URL', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_AGENT',
      'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY']) vi.stubEnv(key, 'PRIVATE_AMBIENT');
    expect((await probeGrokAccount(options())).status).toBe('observed');
    const env = invocation().env;
    expect(env.HOME).toBe(process.env.HOME);
    expect(Object.keys(env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((k) => process.env[k] !== undefined).sort());
  });
  it.each([null, {}])('keeps absent billing configuration unknown, not zero %#', async (config) => {
    expect(await probeGrokAccount(options({ billing: { config } }))).toMatchObject({ status: 'observed', loggedIn: true, planType: null,
      onDemandEnabled: null, windows: [{ id: 'grok_credits', usedPercent: null, resetsAt: null }] });
  });
  it('preserves explicit zero and never infers allowance from deprecated monthly credits', async () => {
    expect(await probeGrokAccount(options({ billing: { config: { creditUsagePercent: 0, monthlyLimit: { val: 100 }, used: { val: 90 } } } })))
      .toMatchObject({ status: 'observed', windows: [{ id: 'grok_credits', usedPercent: 0, resetsAt: null }] });
  });
  it('projects monthly non-unified scope and RFC3339 offsets', async () => {
    expect(await probeGrokAccount(options({ billing: { config: { creditUsagePercent: 100, isUnifiedBillingUser: false,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2030-01-01T00:00:00Z', end: '2030-02-01T01:00:00.123456+01:00' } } } })))
      .toMatchObject({ status: 'observed', windows: [{ id: 'grok_build_monthly', usedPercent: 100, resetsAt: '2030-02-01T00:00:00.123Z' }] });
  });
  it('does not echo unrecognized plan text from a provider', async () => {
    expect(await probeGrokAccount(options({ billing: { ...BILLING, subscription_tier: EMAIL } })))
      .toMatchObject({ status: 'observed', planType: null });
  });
  it('accepts a null cached method only if a stable identity and live billing succeed', async () => {
    expect(await probeGrokAccount(options({ account: { ...ACCOUNT, methodId: null } })))
      .toMatchObject({ status: 'observed', loggedIn: true });
  });
  it('allows the native two-second clean shutdown drain', async () => {
    expect((await probeGrokAccount(options({ drainMs: 2100 }))).status).toBe('observed');
  });
  it('withholds billing on a mismatched expected account', async () => {
    const result = await probeGrokAccount(options({}, { expectedAccountHint: 'a'.repeat(64) }));
    expect(result.reason).toBe('probe-account-hint-mismatch'); failClosed(result);
    expect(invocation().requests.map((r) => r.method)).toEqual(['initialize', '_x.ai/auth/info']);
  });
  it.each(['email', 'methodId', 'principalId', 'principalType', 'teamId', 'organizationId'])(
    'rejects identity change across billing: %s', async (field) => {
      const after = { ...ACCOUNT, [field]: field === 'methodId' ? 'grok.com' : 'different' };
      const result = await probeGrokAccount(options({ after })); expect(result.reason).toBe('probe-account-changed'); failClosed(result);
    });
});

describe('Grok unsupported, malformed and failed providers', () => {
  it.each([null, {}, { ...INIT, protocolVersion: 2 }, { ...INIT, _meta: {} }])('rejects unsupported initialize %#', async (init) => {
    const result = await probeGrokAccount(options({ init })); expect(result.reason).toBe('probe-protocol-unsupported'); failClosed(result);
  });
  it.each([null, {}, { ...ACCOUNT, email: null }, { ...ACCOUNT, email: '' }, { ...ACCOUNT, email: 'x\nsecret' }])(
    'does not claim cached metadata is authenticated %#', async (account) => {
      const result = await probeGrokAccount(options({ account })); expect(result.reason).toBe('probe-account-unavailable'); failClosed(result);
      expect(invocation().requests).toHaveLength(2);
    });
  it('refuses a cached API-key method instead of silently using another billing route', async () => {
    const result = await probeGrokAccount(options({ account: { ...ACCOUNT, methodId: 'xai.api_key' } }));
    expect(result.reason).toBe('probe-account-unsupported'); failClosed(result);
  });
  it.each([1, 2, 3, 4])('handles a provider error at step %s without exposing raw output', async (errorAt) => {
    const result = await probeGrokAccount(options({ errorAt })); expect(result.reason).toBe('probe-provider-error'); failClosed(result);
  });
  it('classifies missing extensions as unsupported, without fallback requests', async () => {
    const result = await probeGrokAccount(options({ errorAt: 3, errorCode: -32601 }));
    expect(result.reason).toBe('probe-protocol-unsupported'); failClosed(result); expect(invocation().requests).toHaveLength(3);
  });
  it.each([1, 2, 3, 4])('refuses unsolicited server requests at step %s', async (requestAt) => {
    const result = await probeGrokAccount(options({ requestAt })); expect(result.reason).toBe('probe-server-request-refused'); failClosed(result);
    expect(invocation().requests.every((r) => Object.hasOwn(r, 'method') && !Object.hasOwn(r, 'result'))).toBe(true);
  });
  it.each([1, 2, 3, 4])('rejects duplicate replies at step %s', async (duplicateAt) => {
    const result = await probeGrokAccount(options({ duplicateAt })); expect(result.reason).toBe('probe-protocol-invalid'); failClosed(result);
  });
  it.each([1, 2, 3, 4])('rejects unmatched replies at step %s', async (wrongAt) => {
    const result = await probeGrokAccount(options({ wrongAt })); expect(result.reason).toBe('probe-protocol-invalid'); failClosed(result);
  });
  it.each([1, 2, 3, 4])('rejects premature native closure at step %s', async (earlyAt) => {
    const result = await probeGrokAccount(options({ earlyAt })); expect(result.status).toBe('failed'); failClosed(result);
  });
  it.each([null, {}, { config: [] }, { config: { creditUsagePercent: -1 } }, { config: { creditUsagePercent: 101 } },
    { config: { creditUsagePercent: '20' } }, { config: { isUnifiedBillingUser: 'true' } }, { config: { currentPeriod: [] } },
    { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_DAILY' } } },
    { config: { currentPeriod: { end: '2030-02-30T00:00:00Z' } } },
    { config: { currentPeriod: { end: '2030-02-01T24:00:00Z' } } },
    { config: { currentPeriod: { start: '2030-02-02T00:00:00Z', end: '2030-02-01T00:00:00Z' } } },
    { config: null, on_demand_enabled: 'true' }, { config: null, subscription_tier: {} }])('rejects malformed quota %#', async (billing) => {
      const result = await probeGrokAccount(options({ billing })); expect(result.reason).toBe('probe-quota-invalid'); failClosed(result);
    });
  it.each(['[]\n', '{}\n', '{broken}\n', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n',
    '{"id":1,"result":{}}\n'])('rejects malformed envelopes %#', async (raw) => {
    const result = await probeGrokAccount(options({ rawAt: 1, raw })); expect(result.reason).toBe('probe-protocol-invalid'); failClosed(result);
  });
  it('rejects invalid UTF8', async () => {
    const result = await probeGrokAccount(options({ bytesAt: 1, bytes: [255, 10] })); expect(result.reason).toBe('probe-protocol-invalid'); failClosed(result);
  });
  it('discards unknown notifications without interpreting identity or fetching content', async () => {
    expect((await probeGrokAccount(options({ noticeAt: 2 }))).status).toBe('observed');
  });
  it.each(['session/update', '_x.ai/auth/updated'])('invalidates active session/auth notifications %s', async (noticeMethod) => {
    const result = await probeGrokAccount(options({ noticeAt: 3, noticeMethod })); expect(result.reason).toBe('probe-account-changed'); failClosed(result);
  });
  it.each([{ rawAt: 1, raw: ' '.repeat(256 * 1024 + 1) }, { noticeAt: 1, noticeCount: 257 },
    { stderr: 'PRIVATE_'.repeat(160_000) }])('bounds lines, notification count and stderr %#', async (config) => {
    const result = await probeGrokAccount(options(config)); expect(result.reason).toBe('probe-output-limit'); failClosed(result);
  });
  it('withholds an otherwise valid sample after nonzero native exit', async () => {
    const result = await probeGrokAccount(options({ exitCode: 9 })); expect(result.reason).toBe('probe-native-exit-failed'); failClosed(result);
  });
});

describe('Grok probe ownership and caller validation', () => {
  it('keeps scratch creation refusal a no-contact failure', async () => {
    const request = options();
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync');
    vi.stubEnv('TMPDIR', join(root, 'PRIVATE_missing_scratch_root'));
    const result = await probeGrokAccount(request);
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-process-failed' });
    expect(subprocess).not.toHaveBeenCalled(); failClosed(result);
  });
  it.each(['sync-throw', 'rejection'] as const)('retains uncertainty after runner %s without settlement', async (failure) => {
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(() => {
      if (failure === 'sync-throw') throw new Error('PRIVATE_RUNNER');
      return Promise.reject(new Error('PRIVATE_RUNNER'));
    });
    const result = await probeGrokAccount(options());
    expect(result).toMatchObject({ status: 'uncertain', reason: 'probe-termination-uncertain' });
    failClosed(result); expect(subprocess).toHaveBeenCalledTimes(1);
    const scratch = subprocess.mock.calls[0]![1].cwd;
    try { expect(existsSync(scratch)).toBe(true); } finally { rmdirSync(scratch); }
  });
  it.each([{ cwd: 'relative' }, { cwd: '/' }, { cwd: '/absent-grok-fixture' }, { command: [] }, { command: ['relative'] },
    { command: new Array(1) }, { command: [process.execPath, '\n'] }, { command: Array.from({ length: 33 }, () => process.execPath) },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 }, { expectedAccountHint: EMAIL }])('rejects invalid configuration %#', async (patch) => {
      await expect(probeGrokAccount(options({}, patch))).rejects.toThrow('Invalid Grok account probe configuration');
      expect(existsSync(join(root, 'invocation.json'))).toBe(false);
    });
  it('does not launch an already-cancelled probe', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await probeGrokAccount(options({}, { signal: controller.signal }));
    expect(result.status).toBe('cancelled'); failClosed(result); expect(existsSync(join(root, 'invocation.json'))).toBe(false);
  });
  it('kills the owned process group on timeout, including a signal-ignoring child', async () => {
    acceleratedOwnership(); const result = await probeGrokAccount(options({ hangAt: 3, ignoreSignals: true }, { timeoutMs: 1000 }));
    expect(result.status).toBe('timed-out'); failClosed(result);
    expect(() => process.kill(invocation().pid, 0)).toThrow(); expect(existsSync(invocation().cwd)).toBe(false);
  });
  it('cancels pending metadata while retaining group ownership until teardown', async () => {
    acceleratedOwnership(); const controller = new AbortController();
    const pending = probeGrokAccount(options({ hangAt: 3, ignoreSignals: true }, { signal: controller.signal }));
    await vi.waitFor(() => expect(invocation().requests.at(-1)?.method).toBe('_x.ai/billing'));
    controller.abort(); const result = await pending; expect(result.status).toBe('cancelled'); failClosed(result);
    expect(() => process.kill(invocation().pid, 0)).toThrow();
  });
  it.each([undefined, 'unconfirmed'] as const)('requires explicit settlement even for exit0 (%s)', async (processGroupSettlement) => {
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: 'PRIVATE_OUTPUT', stderr: '',
      exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement });
    const report = await probeGrokAccount(options());
    expect(report).toMatchObject({ status: 'uncertain', reason: 'probe-termination-uncertain' }); failClosed(report);
    expect(JSON.stringify(report)).not.toContain('PRIVATE'); expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1].requireProcessGroupExit).toBe(true);
    const scratch = spy.mock.calls[0]![1].cwd; expect(existsSync(scratch)).toBe(true); rmdirSync(scratch);
  });
  it.each(['not-started', 'group-exit-confirmed'] as const)('keeps settled failure semantics for %s', async (processGroupSettlement) => {
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: 'PRIVATE_OUTPUT', stderr: '',
      exitCode: -1, signal: null, timedOut: false, cancelled: false, error: 'PRIVATE_ERROR', processGroupSettlement });
    const report = await probeGrokAccount(options());
    expect(report).toMatchObject({ status: 'failed', reason: 'probe-process-failed' }); failClosed(report);
    expect(existsSync(spy.mock.calls[0]![1].cwd)).toBe(false);
  });
  it('withholds all fields and retains scratch after uncertain termination', async () => {
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR',
      exitCode: -1, signal: null, timedOut: true, cancelled: false, error: 'termination authority lost: fixture' });
    const result = await probeGrokAccount(options()); expect(result.status).toBe('uncertain'); failClosed(result);
    const scratch = spy.mock.calls[0]![1].cwd; expect(existsSync(scratch)).toBe(true); rmdirSync(scratch);
  });
  it('rejects unexpected private helper fields', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: JSON.stringify({ status: 'failed', reason: 'probe-provider-error',
      accountHint: null, planType: null, loggedIn: null, windows: [], onDemandEnabled: null, observedAt: null, expiresAt: null, email: EMAIL }),
    stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' });
    const result = await probeGrokAccount(options()); expect(result.reason).toBe('probe-process-output-invalid'); failClosed(result);
  });
  it('pins caller argv before asynchronous work', async () => {
    let finish!: (v: verify.VerifySubprocessResult) => void;
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(() => new Promise((done) => { finish = done; }));
    const request = options(); const pending = probeGrokAccount(request); request.command.push('--mutated');
    finish({ stdout: '', stderr: '', exitCode: 1, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' }); await pending;
    expect(JSON.parse(spy.mock.calls[0]![1].input!).command).not.toContain('--mutated');
  });
  it.each([{ loggedIn: false }, { accountHint: null }, { accountHint: 'a'.repeat(64) }, { planType: EMAIL },
    { expiresAt: '2000-01-01T00:00:00.000Z' }, { reason: 'PRIVATE_REASON' }, { windows: [] },
    { windows: [{ id: 'grok_credits', usedPercent: 101, resetsAt: null }] },
    { windows: [{ id: 'grok_credits', usedPercent: null, resetsAt: null, email: EMAIL }] },
    { onDemandEnabled: 'true' }])('rejects forged successful helper metadata %#', async (patch) => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (_argv, config) => {
      const input = JSON.parse(config.input!);
      return { stdout: JSON.stringify({ status: 'observed', reason: 'probe-observed', accountHint: HINT, planType: 'SuperGrok', loggedIn: true,
        windows: [{ id: 'grok_credits', usedPercent: null, resetsAt: null }], onDemandEnabled: null,
        observedAt: input.startedAt, expiresAt: new Date(Date.parse(input.startedAt) + 60_000).toISOString(), ...patch }),
      stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' };
    });
    const result = await probeGrokAccount(options({}, { expectedAccountHint: HINT }));
    expect(result.reason).toBe('probe-process-output-invalid'); failClosed(result);
  });
  it('leaves native-created scratch data intact instead of recursively removing it', async () => {
    expect((await probeGrokAccount(options({ keepFile: true }))).status).toBe('observed');
    const scratch = invocation().cwd;
    expect(readFileSync(join(scratch, 'native-created.txt'), 'utf8')).toBe('fixture-only');
    // This exact fresh directory and content are owned by this inert fixture.
    rmSync(scratch, { recursive: true });
  });
});
