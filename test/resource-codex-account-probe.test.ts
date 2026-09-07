/** Native protocol fixtures only: no Codex executable, credentials or provider requests. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeCodexResourceAccount, type CodexResourceProbeOptions } from '../src/core/resources/codex-account-probe.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import * as verify from '../src/core/run/verify-commands.js';

let fixtureRoot: string;
beforeEach(() => { fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-codex-probe-test-'))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(fixtureRoot, { recursive: true, force: true }); });

const EMAIL = 'fixture@example.invalid';
const PLAN = 'pro';
const ACCOUNT = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: EMAIL, planType: PLAN } };
const HINT = digest(canonical({ schemaVersion: 1, type: 'chatgpt', email: EMAIL, planType: PLAN }));
const INIT = { codexHome: '/private/fixture-auth-location', userAgent: 'codex-cli/fixture', platformFamily: 'unix', platformOs: 'macos' };
function pool(): ResourcePool {
  return { schemaVersion: 1, id: 'fixture', workers: [{ id: 'codex-a', provider: 'codex', model: 'fixture-model',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] };
}
function quota() {
  return { rateLimits: { limitId: 'codex', primary: { usedPercent: 99, resetsAt: 1_999_999_999 } },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_999_999_999 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 2_000_000_000 }, rateLimitReachedType: null } } };
}
function fixture(config: Record<string, unknown> = {}): ResourceBinding[] {
  const script = join(fixtureRoot, 'native.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const readline = require('node:readline');
const config = ${JSON.stringify(config)};
const path = ${JSON.stringify(join(fixtureRoot, 'invocation.json'))};
const log = {argv:process.argv.slice(2),cwd:process.cwd(),env:process.env,pid:process.pid,requests:[]};
const writeLog = () => fs.writeFileSync(path, JSON.stringify(log));
writeLog();
const init = Object.hasOwn(config,'initialize') ? config.initialize : ${JSON.stringify(INIT)};
const account = Object.hasOwn(config,'account') ? config.account : ${JSON.stringify(ACCOUNT)};
const after = Object.hasOwn(config,'after') ? config.after : account;
const quota = Object.hasOwn(config,'quota') ? config.quota : ${JSON.stringify(quota())};
function write(row) {
  const value = JSON.stringify(row) + '\\n';
  if (config.split) { const middle=Math.floor(value.length/2); process.stdout.write(value.slice(0,middle)); process.stdout.write(value.slice(middle)); }
  else process.stdout.write(value);
}
if (config.stderr) process.stderr.write(config.stderr);
if (config.ignoreSignals) {process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});}
const reader = readline.createInterface({input:process.stdin});
reader.on('line', (line) => {
 const request=JSON.parse(line);log.requests.push(request);writeLog();
 if (request.method==='initialized') return;
 if (config.hangAt===request.id) {setInterval(()=>{},1000);return;}
 if (config.earlyAt===request.id) {process.exitCode=0;reader.close();process.stdin.destroy();return;}
 if (config.rawAt===request.id) {process.stdout.write(config.raw);return;}
 if (config.bytesAt===request.id) {process.stdout.write(Buffer.from(config.bytes));return;}
 if (config.errorAt===request.id) {write({id:request.id,error:{code:-1,message:'PRIVATE_ERROR '+${JSON.stringify(EMAIL)}}});return;}
 if (config.requestAt===request.id) {write({id:'native-request',method:'account/chatgptAuthTokens/refresh',params:{PRIVATE_SECRET:'do-not-expose'},...config.requestExtra});return;}
 if (config.notificationsAt===request.id) for(let i=0;i<(config.notificationCount||1);i++) write({method:config.notificationMethod||'fixture/notice',params:{PRIVATE_SECRET:'do-not-expose'},...config.notificationExtra});
 const result=request.id===1?init:request.id===2?account:request.id===3?quota:after;
 write({id:config.wrongIdAt===request.id?999:request.id,result});
 if (config.duplicateAt===request.id) write({id:request.id,result});
});
reader.on('close',()=>{if(config.holdAfterEOF){setInterval(()=>{},1000);}else process.exitCode=config.exitCode||0;});
`);
  return [{ workerId: 'codex-a', capacityKey: 'fixture-account', kind: 'native-cli', command: [process.execPath, script] }];
}
function options(config: Record<string, unknown> = {}, patch: Partial<CodexResourceProbeOptions> = {}): CodexResourceProbeOptions {
  return { pool: pool(), bindings: fixture(config), workerId: 'codex-a', cwd: fixtureRoot, bucketIds: ['codex'],
    timeoutMs: 5_000, ...patch };
}
function invocation() {
  return JSON.parse(readFileSync(join(fixtureRoot, 'invocation.json'), 'utf8')) as {
    argv: string[]; cwd: string; env: Record<string, string>; pid: number; requests: Array<Record<string, unknown>>;
  };
}
function acceleratedOwnership() {
  const original = verify.runVerifySubprocessAsync;
  vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation((argv, opts) =>
    original(argv, { ...opts, _terminationGraceMs: 75, _terminationDrainMs: 150 }));
}

describe('explicit Codex metadata protocol and identity hints', () => {
  it('uses exact no-generation handshake in a private cwd and emits only projected metadata', async () => {
    const request = options({ split: true, notificationsAt: 1, stderr: 'PRIVATE_STDERR fixture@example.invalid' }, { expectedAccountHint: HINT });
    const result = await probeCodexResourceAccount(request);
    expect(result).toMatchObject({ schemaVersion: 1, scope: 'codex-native-metadata', workerId: 'codex-a',
      poolDigest: digest(canonical({ pool: request.pool, bindings: request.bindings })), status: 'observed', reason: 'probe-observed',
      accountHint: HINT, planType: 'pro', observation: { workerId: 'codex-a', health: 'ready', retryAfter: null,
        windows: [{ id: 'codex_codex_primary', usedPercent: 25, resetsAt: '2033-05-18T03:33:19.000Z' },
          { id: 'codex_codex_secondary', usedPercent: 40, resetsAt: '2033-05-18T03:33:20.000Z' }] } });
    expect(result.observation?.observedAt).toBe(result.startedAt);
    expect(result.observation?.updatedAt).toBe(result.startedAt);
    expect(Date.parse(result.observation!.expiresAt) - Date.parse(result.startedAt)).toBe(60_000);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    const recorded = invocation();
    expect(recorded.argv).toEqual(['app-server', '--stdio', '-c', 'analytics.enabled=false']);
    expect(recorded.requests).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'ashlr_hub_resource_probe', version: '1' },
        capabilities: { experimentalApi: false, requestAttestation: false } } },
      { method: 'initialized' },
      { id: 2, method: 'account/read', params: { refreshToken: false } },
      { id: 3, method: 'account/rateLimits/read' },
      { id: 4, method: 'account/read', params: { refreshToken: false } },
    ]);
    expect(recorded.cwd).not.toBe(fixtureRoot);
    expect(recorded.cwd).toContain('ashlr-codex-metadata-'); expect(existsSync(recorded.cwd)).toBe(false);
    const exposed = JSON.stringify(result);
    for (const secret of [EMAIL, INIT.codexHome, 'PRIVATE_STDERR', 'PRIVATE_SECRET', 'PRIVATE_ERROR', recorded.cwd]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it('preserves HOME unchanged while omitting ambient auth, endpoint, proxy and loader overrides', async () => {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS',
      'NODE_PATH', 'OPENAI_BASE_URL', 'HTTPS_PROXY']) vi.stubEnv(key, '/fixture/not-used');
    expect((await probeCodexResourceAccount(options())).status).toBe('observed');
    const env = invocation().env;
    expect(env.HOME).toBe(process.env.HOME);
    expect(Object.keys(env).filter((key) => key !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key] !== undefined).sort());
  });

  it('provides a discoverable opaque hint without an expected hint, without claiming separate account capacity', async () => {
    const result = await probeCodexResourceAccount(options());
    expect(result.accountHint).toBe(HINT); expect(result.status).toBe('observed');
    expect(result).not.toHaveProperty('accountId'); expect(result).not.toHaveProperty('workspaceId');
  });

  it('withholds quota and all later requests when the expected account hint differs', async () => {
    const result = await probeCodexResourceAccount(options({}, { expectedAccountHint: 'a'.repeat(64) }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-hint-mismatch', accountHint: HINT, observation: null });
    expect(invocation().requests.map((request) => request.method)).not.toContain('account/rateLimits/read');
  });

  it.each([
    { requiresOpenaiAuth: true, account: null },
    { requiresOpenaiAuth: false, account: null },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: null, planType: 'pro' } },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: '', planType: 'pro' } },
    { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: EMAIL, planType: 'future-unknown-plan' } },
  ])('does not invent an identity for unavailable account metadata %#', async (account) => {
    const result = await probeCodexResourceAccount(options({ account }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-unavailable', accountHint: null, planType: null, observation: null });
    expect(invocation().requests.map((request) => request.method)).not.toContain('account/rateLimits/read');
  });

  it.each([
    { requiresOpenaiAuth: true, account: { type: 'apiKey' } },
    { requiresOpenaiAuth: true, account: { type: 'amazonBedrock' } },
    { ...ACCOUNT, requiresOpenaiAuth: false },
  ])('refuses API-key or non-active ChatGPT provider quota %#', async (account) => {
    const result = await probeCodexResourceAccount(options({ account }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-unsupported', observation: null });
    expect(invocation().requests).toHaveLength(3);
  });

  it.each([
    { ...ACCOUNT, account: { ...ACCOUNT.account, email: 'second@example.invalid' } },
    { ...ACCOUNT, account: { ...ACCOUNT.account, planType: 'plus' } },
  ])('withholds a mixed before/quota/after account sample %#', async (after) => {
    const result = await probeCodexResourceAccount(options({ after }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-changed', observation: null });
    expect(result.accountHint).toBe(HINT);
  });

  it('rejects an account-updated notification during quota sampling', async () => {
    const result = await probeCodexResourceAccount(options({ notificationsAt: 3, notificationMethod: 'account/updated' }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-changed', observation: null });
  });

  it.each([1, 2, 3, 4])('accepts timestamped native notifications at protocol step %s without changing quota freshness', async (notificationsAt) => {
    const result = await probeCodexResourceAccount(options({ notificationsAt, notificationMethod: 'remoteControl/status/changed',
      notificationExtra: { emittedAtMs: 1_000 } }, { expectedAccountHint: HINT }));
    expect(result).toMatchObject({ status: 'observed', reason: 'probe-observed', accountHint: HINT });
    expect(result.observation?.observedAt).toBe(result.startedAt);
    expect(result.observation?.updatedAt).toBe(result.startedAt);
    expect(Date.parse(result.observation!.expiresAt)).toBe(Date.parse(result.startedAt) + 60_000);
    expect(invocation().requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/read',
    ]);
    for (const secret of ['PRIVATE_SECRET', 'emittedAtMs', EMAIL]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])('accepts a safe notification timestamp boundary %s', async (emittedAtMs) => {
    expect(await probeCodexResourceAccount(options({ notificationsAt: 2, notificationExtra: { emittedAtMs } })))
      .toMatchObject({ status: 'observed', reason: 'probe-observed', accountHint: HINT });
  });

  it('still rejects an account-updated notification with an emission timestamp', async () => {
    expect(await probeCodexResourceAccount(options({ notificationsAt: 3, notificationMethod: 'account/updated',
      notificationExtra: { emittedAtMs: 1_000 } }))).toMatchObject({ status: 'failed', reason: 'probe-account-changed', observation: null });
  });

  it('still checks a pinned account after accepting notification metadata', async () => {
    const result = await probeCodexResourceAccount(options({ notificationsAt: 2, notificationExtra: { emittedAtMs: 1_000 } },
      { expectedAccountHint: 'a'.repeat(64) }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-account-hint-mismatch', observation: null });
    expect(invocation().requests.map((request) => request.method)).not.toContain('account/rateLimits/read');
  });
});

describe('bounded Codex protocol and quota failures', () => {
  it.each([1, 2, 3, 4])('rejects duplicate response id at protocol step %s', async (duplicateAt) => {
    expect(await probeCodexResourceAccount(options({ duplicateAt }))).toMatchObject({
      status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it.each([1, 2, 3, 4])('rejects mismatched response id at protocol step %s', async (wrongIdAt) => {
    expect(await probeCodexResourceAccount(options({ wrongIdAt }))).toMatchObject({
      status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it.each([1, 2, 3, 4])('redacts provider errors at protocol step %s', async (errorAt) => {
    const result = await probeCodexResourceAccount(options({ errorAt }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-provider-error', observation: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR'); expect(JSON.stringify(result)).not.toContain(EMAIL);
  });
  it.each([1, 2, 3, 4])('refuses unsolicited server/token requests at protocol step %s', async (requestAt) => {
    const result = await probeCodexResourceAccount(options({ requestAt }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-server-request-refused', observation: null });
    expect(invocation().requests.every((request) => !Object.hasOwn(request, 'result') && !Object.hasOwn(request, 'error'))).toBe(true);
  });
  it.each([1, 2, 3, 4])('refuses timestamped server/token requests at protocol step %s', async (requestAt) => {
    const result = await probeCodexResourceAccount(options({ requestAt, requestExtra: { emittedAtMs: 1_000 } }));
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-server-request-refused', observation: null });
    expect(invocation().requests.every((request) => !Object.hasOwn(request, 'result') && !Object.hasOwn(request, 'error'))).toBe(true);
  });
  it.each([null, '1000', true, [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed notification timestamps %#', async (emittedAtMs) => {
      expect(await probeCodexResourceAccount(options({ notificationsAt: 2, notificationExtra: { emittedAtMs } })))
        .toMatchObject({ status: 'failed', reason: 'probe-protocol-invalid', observation: null });
    });
  it('rejects a non-finite decoded notification timestamp', async () => {
    expect(await probeCodexResourceAccount(options({ rawAt: 2,
      raw: '{"method":"fixture/notice","params":{},"emittedAtMs":1e400}\n' })))
      .toMatchObject({ status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it('still rejects unknown notification metadata beside a valid timestamp', async () => {
    expect(await probeCodexResourceAccount(options({ notificationsAt: 2, notificationExtra: { emittedAtMs: 1_000, unexpected: true } })))
      .toMatchObject({ status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it('does not relax response envelopes to accept notification metadata', async () => {
    expect(await probeCodexResourceAccount(options({ rawAt: 1, raw: JSON.stringify({ id: 1, result: INIT, emittedAtMs: 1_000 }) + '\n' })))
      .toMatchObject({ status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it('still rejects malformed quota following timestamped notifications', async () => {
    expect(await probeCodexResourceAccount(options({ notificationsAt: 3, notificationExtra: { emittedAtMs: 1_000 }, quota: {} })))
      .toMatchObject({ status: 'failed', reason: 'probe-quota-invalid', observation: null });
  });
  it.each(['[]\n', '{}\n', '{broken}\n', '{"id":1,"result":{},"error":{}}\n'])('rejects malformed native envelopes %#', async (raw) => {
    expect(await probeCodexResourceAccount(options({ rawAt: 1, raw }))).toMatchObject({
      status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it('rejects invalid UTF-8 rather than treating replacement characters as identity', async () => {
    expect(await probeCodexResourceAccount(options({ bytesAt: 1, bytes: [0xff, 0x0a] }))).toMatchObject({
      status: 'failed', reason: 'probe-protocol-invalid', observation: null });
  });
  it.each([
    { rawAt: 1, raw: ' '.repeat(256 * 1024 + 1) },
    { notificationsAt: 1, notificationCount: 257 },
    { stderr: 'private'.repeat(180_000) },
  ])('bounds line, event count and discarded stderr bytes %#', async (config) => {
    expect(await probeCodexResourceAccount(options(config))).toMatchObject({
      status: 'failed', reason: 'probe-output-limit', observation: null });
  });
  it('does not accept a valid sample followed by a nonzero native exit', async () => {
    expect(await probeCodexResourceAccount(options({ exitCode: 7 }))).toMatchObject({
      status: 'failed', reason: 'probe-native-exit-failed', observation: null });
  });
  it('requires native closure after EOF and withholds a sample from an uncooperative process', async () => {
    expect(await probeCodexResourceAccount(options({ holdAfterEOF: true }))).toMatchObject({
      status: 'failed', reason: 'probe-native-exit-failed', observation: null });
  });
  it.each([1, 2, 3, 4])('rejects early native termination at step %s', async (earlyAt) => {
    const result = await probeCodexResourceAccount(options({ earlyAt }));
    expect(result.status).toBe('failed'); expect(result.observation).toBeNull();
  });
  it('preserves authoritative empty-map quota as unknown, not legacy percentages', async () => {
    const result = await probeCodexResourceAccount(options({ quota: { ...quota(), rateLimitsByLimitId: {} } }));
    expect(result).toMatchObject({ status: 'observed', observation: {
      windows: [{ id: 'codex_codex_primary', usedPercent: null, resetsAt: null }] } });
  });
  it('retains an explicitly requested missing bucket as unknown beside observed windows', async () => {
    const result = await probeCodexResourceAccount(options({}, { bucketIds: ['codex', 'other'] }));
    expect(result.observation?.windows.at(-1)).toEqual({ id: 'codex_other_primary', usedPercent: null, resetsAt: null });
  });
  it('uses legacy matching limit only when the map is absent', async () => {
    const result = await probeCodexResourceAccount(options({ quota: { rateLimits: quota().rateLimits } }));
    expect(result.observation?.windows[0]?.usedPercent).toBe(99);
  });
  it('retains a native reached classification without fabricating measured headroom', async () => {
    const result = await probeCodexResourceAccount(options({ quota: { rateLimitsByLimitId: {
      codex: { limitId: 'codex', rateLimitReachedType: 'workspace_owner_credits_depleted' } } } }));
    expect(result.observation?.windows).toEqual([{ id: 'codex_codex_primary', usedPercent: 100, resetsAt: null }]);
  });
  it.each([{}, null, { rateLimitsByLimitId: null }, { rateLimitsByLimitId: { codex: { primary: { usedPercent: -1 } } } }])(
    'withholds malformed quota evidence %#', async (value) => {
      expect(await probeCodexResourceAccount(options({ quota: value }))).toMatchObject({
        status: 'failed', reason: 'probe-quota-invalid', observation: null });
    });
});

describe('probe preflight, cancellation and output trust boundary', () => {
  it.each([
    { cwd: 'relative' }, { cwd: '/' }, { cwd: '/not-present-fixture' }, { workerId: 'unknown' },
    { bucketIds: [] }, { bucketIds: ['codex', 'codex'] }, { bucketIds: new Array(1) },
    { bucketIds: ['codex', 'b', 'c', 'd', 'e'] }, { bucketIds: ['codex\n'] },
    { expectedAccountHint: EMAIL }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 },
  ])('rejects invalid explicit configuration before creating native processes %#', async (patch) => {
    await expect(probeCodexResourceAccount(options({}, patch as Partial<CodexResourceProbeOptions>))).rejects.toThrow(
      'Invalid Codex resource probe configuration');
    expect(existsSync(join(fixtureRoot, 'invocation.json'))).toBe(false);
  });
  it('rejects non-Codex enrollment before starting a child', async () => {
    const request = options(); request.pool.workers[0]!.provider = 'claude';
    await expect(probeCodexResourceAccount(request)).rejects.toThrow('Invalid Codex resource probe configuration');
    expect(existsSync(join(fixtureRoot, 'invocation.json'))).toBe(false);
  });
  it('honors already-cancelled input without subprocesses', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await probeCodexResourceAccount(options({}, { signal: controller.signal }))).toMatchObject({
      status: 'cancelled', reason: 'probe-cancelled', observation: null });
    expect(existsSync(join(fixtureRoot, 'invocation.json'))).toBe(false);
  });
  it('retains helper group ownership during timeout and confirms child cleanup', async () => {
    acceleratedOwnership();
    const result = await probeCodexResourceAccount(options({ hangAt: 3, ignoreSignals: true }, { timeoutMs: 1_000 }));
    expect(result).toMatchObject({ status: 'timed-out', reason: 'probe-timed-out', observation: null });
    expect(() => process.kill(invocation().pid, 0)).toThrow(); expect(existsSync(invocation().cwd)).toBe(false);
  });
  it('retains helper group ownership during cancellation even when native ignores it', async () => {
    acceleratedOwnership(); const controller = new AbortController();
    const running = probeCodexResourceAccount(options({ hangAt: 3, ignoreSignals: true }, { signal: controller.signal }));
    await vi.waitFor(() => { expect(invocation().requests.at(-1)?.method).toBe('account/rateLimits/read'); });
    controller.abort();
    expect(await running).toMatchObject({ status: 'cancelled', reason: 'probe-cancelled', observation: null });
    expect(() => process.kill(invocation().pid, 0)).toThrow(); expect(existsSync(invocation().cwd)).toBe(false);
  });
  it('withholds all native output after uncertain teardown', async () => {
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR',
      exitCode: -1, signal: null, timedOut: true, cancelled: false,
      error: 'termination authority lost: fixture' });
    expect(await probeCodexResourceAccount(options())).toMatchObject({ status: 'uncertain', reason: 'probe-termination-uncertain',
      accountHint: null, planType: null, observation: null });
    // This mock starts no process. Verify the production path leaves its cwd
    // intact, then remove this exact empty test-owned directory ourselves.
    const scratch = spy.mock.calls[0]![1].cwd;
    expect(existsSync(scratch)).toBe(true); rmdirSync(scratch);
  });
  it('rejects a helper payload with unexpected fields without leaking them', async () => {
    vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue({ stdout: JSON.stringify({ schemaVersion: 1,
      status: 'failed', reason: 'probe-provider-error', accountHint: null, planType: null, observation: null, email: EMAIL }),
    stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false });
    const result = await probeCodexResourceAccount(options());
    expect(result).toMatchObject({ status: 'failed', reason: 'probe-process-output-invalid', observation: null });
    expect(JSON.stringify(result)).not.toContain(EMAIL);
  });
  it('pins the entire policy, binding and bucket scope before awaiting process work', async () => {
    let finish!: (value: verify.VerifySubprocessResult) => void;
    const spy = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(() => new Promise((done) => { finish = done; }));
    const request = options(); const expected = digest(canonical({ pool: request.pool, bindings: request.bindings }));
    const running = probeCodexResourceAccount(request);
    request.pool.workers[0]!.model = 'mutated-model'; request.bucketIds[0] = 'mutated-bucket';
    (request.bindings[0] as Extract<ResourceBinding, { kind: 'native-cli' }>).command.push('--mutated');
    finish({ stdout: '', stderr: '', exitCode: 1, signal: null, timedOut: false, cancelled: false });
    expect((await running).poolDigest).toBe(expected);
    const sent = JSON.parse(spy.mock.calls[0]![1].input!);
    expect(sent.bucketIds).toEqual(['codex']); expect(sent.command).not.toContain('--mutated');
  });
});
