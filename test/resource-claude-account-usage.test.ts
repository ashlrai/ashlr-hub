/** Native calls are mocked or inert fixtures; tests never use a real provider. */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { CLAUDE_USAGE_VERIFIED_VERSIONS, parseClaudeNativeUsage, parseClaudeNativeUsageStream, probeClaudeAccountUsage } from '../src/core/resources/claude-account-usage.js';
import * as auth from '../src/core/resources/claude-account-status.js';
import * as verify from '../src/core/run/verify-commands.js';

const INTRO = 'You are currently using your subscription to power your Claude Code usage';
const RESET = 'Sep 11 at 7pm (America/New_York)';
const TEXT = `${INTRO}\nCurrent session: 0% used\nCurrent week (all models): 1% used · resets ${RESET}\nCurrent week (Fable): 2% used · resets ${RESET}`;
const envelope = (patch: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false,
  total_cost_usd: 0, duration_api_ms: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, result: TEXT, ...patch });
const OBSERVED = '2026-10-01T12:00:00.000Z';
const SESSION_RESET = '2026-10-01T15:00:00.000Z';
const WEEK_RESET = '2026-10-04T12:00:00.000Z';
const usageRows = () => [
  { kind: 'session', group: 'session', percent: 0, resets_at: SESSION_RESET, is_active: true, severity: 'normal' },
  { kind: 'weekly_all', group: 'weekly', percent: 27.5, resets_at: WEEK_RESET, is_active: false, severity: 'normal' },
  { kind: 'weekly_scoped', group: 'weekly', percent: 2, resets_at: WEEK_RESET, is_active: false, severity: 'normal',
    scope: { model: { display_name: 'Fable' }, surface: null } },
];
const usageFrames = () => [
  { type: 'system', subtype: 'init', session_id: 'fixture-session', uuid: 'init' },
  { type: 'assistant', session_id: 'fixture-session', uuid: 'assistant', parent_tool_use_id: null,
    usage_report: { session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 25,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {} }, rate_limits: { limits: usageRows() } } },
  { ...envelope(), session_id: 'fixture-session', uuid: 'result', num_turns: 0 },
];
const stream = (frames: unknown[] = usageFrames()) => frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n';
const nativeResult = (stdout: string, patch: Partial<verify.VerifySubprocessResult> = {}): verify.VerifySubprocessResult =>
  ({ stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false,
    processGroupSettlement: 'group-exit-confirmed', ...patch });
let root: string;
const scratchDirs: string[] = [];
const options = () => ({ command: ['/fixture/native', '--isolated'], cwd: root, timeoutMs: 5000 });
const status = (patch: Partial<auth.ClaudeAccountStatusResult> = {}): auth.ClaudeAccountStatusResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'status-login-observed',
  loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', accountHint: 'a'.repeat(64),
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...patch,
});
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-claude-usage-test-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
  for (const directory of scratchDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function mocks() {
  const authentication = vi.spyOn(auth, 'probeClaudeAccountStatus').mockResolvedValue(status());
  const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (argv, config) => {
    scratchDirs.push(config.cwd);
    return nativeResult(argv.at(-1) === '--version' ? '2.1.257 (Claude Code)\n' : JSON.stringify(envelope()));
  });
  return { authentication, subprocess };
}

describe('display-only native usage parser', () => {
  it('keeps all known windows, native rounding and reset text, but no freshness timestamp', () => {
    const windows = parseClaudeNativeUsage(JSON.stringify(envelope()));
    expect(windows).toEqual([
      { id: 'five_hour', usedPercent: 0, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: null } },
      { id: 'seven_day', usedPercent: 1, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: RESET } },
      { id: 'seven_day_fable', usedPercent: 2, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: RESET } },
    ]);
  });
  it('drops behavior/activity, identity, session and other native metadata', () => {
    const parsed = parseClaudeNativeUsage(JSON.stringify(envelope({ session_id: 'PRIVATE_SESSION',
      result: `${TEXT}\nActivity: PRIVATE_PATH\nSkills: PRIVATE_SKILL` })));
    expect(parsed).toHaveLength(3); expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
  });
  it.each([
    { type: 'assistant' }, { subtype: 'error' }, { is_error: true }, { total_cost_usd: 1 }, { duration_api_ms: 1 },
    { usage: {} }, { usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { modelUsage: { model: {} } }, { modelUsage: null }, { result: null },
    { result: TEXT.replace(INTRO, 'Using overages') }, { result: TEXT.replace('1% used', '1.5% used') },
    { result: TEXT.replace('1% used', '101% used') }, { result: TEXT.replace('1% used', '-1% used') },
    { result: TEXT.replace('Current session: 0% used\n', '') }, { result: TEXT.replace('all models', 'New model') },
    { result: `${TEXT}\nCurrent week (Fable): 4% used` }, { result: TEXT.replace(RESET, 'PRIVATE_RESET') },
    { result: TEXT.replace(RESET, 'Sep 11 at 99pm (America/New_York)') },
    { result: TEXT.replace('2% used', '2% used\u001b[31m') },
  ])('rejects unsupported, incomplete or inference-bearing payload %#', (patch) => {
    expect(parseClaudeNativeUsage(JSON.stringify(envelope(patch)))).toBeNull();
  });
  it.each(['not json', 'null', '[]', 'x'.repeat(32769)])('rejects malformed or oversized payload %#', (raw) => {
    expect(parseClaudeNativeUsage(raw)).toBeNull();
  });
});

describe('bounded version-gated report collection', () => {
  it.each([false, true])('passes the same lifecycle through auth/version/usage/auth without invoking it (null prototype: %s)', async (nullPrototype) => {
    const prepare = vi.fn();
    const lifecycle = Object.assign(Object.create(nullPrototype ? null : Object.prototype), { prepare });
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (argv) => {
      if (argv.includes('auth')) return nativeResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai',
        subscriptionType: 'max', email: 'fixture@example.invalid', orgId: 'fixture-org' }));
      return nativeResult(argv.at(-1) === '--version' ? '2.1.257 (Claude Code)' : JSON.stringify(envelope()));
    });
    expect(await probeClaudeAccountUsage({ ...options(), processGroupLifecycle: lifecycle }))
      .toMatchObject({ status: 'observed', reason: 'usage-native-reported' });
    expect(subprocess.mock.calls.map(([argv]) => argv[2])).toEqual(['auth', '--version', '--safe-mode', 'auth']);
    for (const [, config] of subprocess.mock.calls) {
      expect(config.processGroupLifecycle).toBe(lifecycle); expect(config.requireProcessGroupExit).toBe(true);
      expect(config.input).toBeUndefined();
    }
    expect(prepare).not.toHaveBeenCalled();
  });
  it('rejects malformed lifecycle hooks before any authentication or usage transport', async () => {
    const getter = vi.fn(() => vi.fn()); const prepare = vi.fn();
    const accessor = Object.defineProperty({}, 'prepare', { get: getter, enumerable: true });
    const { authentication, subprocess } = mocks();
    for (const value of [null, [], {}, { prepare: null }, Object.create({ prepare }),
      { prepare, extra: true }, { prepare, [Symbol('extra')]: true }, accessor]) {
      await expect(probeClaudeAccountUsage({ ...options(),
        processGroupLifecycle: value as verify.VerifyProcessGroupLifecycle,
      })).rejects.toThrow('Invalid Claude account status configuration');
    }
    expect(getter).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(authentication).not.toHaveBeenCalled(); expect(subprocess).not.toHaveBeenCalled();
  });
  it('runs the complete flow through an inert native fixture without input or real authentication', async () => {
    const fixture = join(root, 'native.cjs'); const receipt = join(root, 'receipt.jsonl');
    writeFileSync(fixture, `const fs=require('node:fs'); const args=process.argv.slice(2); let input='';
      process.stdin.on('data',x=>input+=x); process.stdin.on('end',()=>{
        fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({args,input,cwd:process.cwd(),mode:fs.statSync(process.cwd()).mode&511})+'\\n');
        if(args[0]==='auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:'fixture@example.invalid',orgId:'fixture-org'}));
        else if(args[0]==='--version') console.log('2.1.257 (Claude Code)');
        else console.log(${JSON.stringify(JSON.stringify(envelope()))});
      });`);
    const result = await probeClaudeAccountUsage({ command: [process.execPath, fixture], cwd: root, timeoutMs: 10000 });
    expect(result).toMatchObject({ status: 'observed', reason: 'usage-native-reported' });
    expect(result.windows).toHaveLength(3);
    const rows = readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.args[0])).toEqual(['auth', '--version', '--safe-mode', 'auth']);
    for (const row of rows) { expect(row.input).toBe(''); expect(row.mode).toBe(0o700); expect(existsSync(row.cwd)).toBe(false); }
  });
  it('uses the verified local command and unchanged auth before/after with private scratch', async () => {
    const { authentication, subprocess } = mocks(); const result = await probeClaudeAccountUsage(options());
    expect(result).toMatchObject({ status: 'observed', reason: 'usage-native-reported', loggedIn: true });
    expect(result.windows).toHaveLength(3); expect(authentication).toHaveBeenCalledTimes(2);
    expect(subprocess.mock.calls.map((call) => call[0])).toEqual([
      ['/fixture/native', '--isolated', '--version'],
      ['/fixture/native', '--isolated', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config',
        '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence', '--output-format', 'json', '-p', '/usage'],
    ]);
    for (const [, config] of subprocess.mock.calls) {
      expect(config.requireProcessGroupExit).toBe(true);
      expect(config.cwd).not.toBe(root); expect(existsSync(config.cwd)).toBe(false);
      expect(config.input).toBeUndefined(); expect(config.timeoutMs).toBeGreaterThan(0);
      expect(config.timeoutMs).toBeLessThanOrEqual(5000); expect(config.maxOutputChars).toBe(32768);
    }
    expect(result).not.toHaveProperty('observation'); expect(result).not.toHaveProperty('quotaObservedAt');
  });
  it.each(CLAUDE_USAGE_VERIFIED_VERSIONS)('reads usage on every verified build (%s)', async (version) => {
    const { subprocess, authentication } = mocks();
    authentication.mockResolvedValue(status({ startedAt: OBSERVED }));
    subprocess.mockImplementation(async (argv, config) => {
      scratchDirs.push(config.cwd);
      return nativeResult(argv.at(-1) === '--version' ? `${version} (Claude Code)\n`
        : version === '2.1.280' ? stream() : JSON.stringify(envelope()));
    });
    const result = await probeClaudeAccountUsage(options());
    expect(result).toMatchObject({ status: 'observed', reason: version === '2.1.280' ? 'usage-native-current' : 'usage-native-reported' });
    expect(result.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable']);
  });
  it.each(['2.1.256 (Claude Code)', '2.1.258 (Claude Code)', '2.1.279 (Claude Code)', '2.1.281 (Claude Code)', '2.1.280', 'PRIVATE_VERSION'])('never sends /usage to unverified version %s', async (version) => {
    const { subprocess, authentication } = mocks(); subprocess.mockResolvedValue(nativeResult(version));
    expect(await probeClaudeAccountUsage(options())).toMatchObject({ status: 'observed', reason: 'usage-version-unsupported', windows: [] });
    expect(subprocess).toHaveBeenCalledTimes(1); expect(authentication).toHaveBeenCalledTimes(1);
  });
  it.each([{ loggedIn: false }, { authMethod: 'api-key' }, { accountHint: null }, { status: 'uncertain' }])(
    'does not issue usage without the required auth identity %#', async (patch) => {
      const { authentication, subprocess } = mocks(); authentication.mockResolvedValue(status(patch as Partial<auth.ClaudeAccountStatusResult>));
      expect((await probeClaudeAccountUsage(options())).windows).toEqual([]); expect(subprocess).not.toHaveBeenCalled();
    });
  it.each([{ accountHint: 'b'.repeat(64) }, { loggedIn: false }, { subscriptionType: 'pro' }, { authMethod: 'api-key' }])(
    'clears all evidence on changed post-read identity %#', async (patch) => {
      const { authentication } = mocks(); authentication.mockResolvedValueOnce(status()).mockResolvedValueOnce(status(patch as Partial<auth.ClaudeAccountStatusResult>));
      expect(await probeClaudeAccountUsage(options())).toMatchObject({ status: 'failed', reason: 'usage-account-changed', windows: [], loggedIn: null, accountHint: null });
    });
  it('preserves post-auth cleanup uncertainty', async () => {
    const { authentication } = mocks(); authentication.mockResolvedValueOnce(status()).mockResolvedValueOnce(status({ status: 'uncertain', loggedIn: null }));
    expect(await probeClaudeAccountUsage(options())).toMatchObject({ status: 'uncertain', windows: [] });
  });
  it.each([
    [{ timedOut: true }, 'timed-out', 'status-timed-out'], [{ cancelled: true }, 'cancelled', 'status-cancelled'],
    [{ exitCode: 2 }, 'observed', 'usage-process-failed'], [{ outputTruncated: true }, 'observed', 'usage-output-invalid'],
    [{ stderr: 'é'.repeat(20000) }, 'observed', 'usage-output-invalid'],
    [{ error: 'termination authority lost: PRIVATE', processGroupSettlement: 'unconfirmed' }, 'uncertain', 'status-termination-uncertain'],
    [{ error: 'termination deadline elapsed with process-group exit unconfirmed', processGroupSettlement: 'unconfirmed' }, 'uncertain', 'status-termination-uncertain'],
  ] as const)('handles process failure %# without quota', async (patch, state, reason) => {
    const { subprocess } = mocks(); subprocess.mockImplementation(async (_, config) => {
      scratchDirs.push(config.cwd); return nativeResult('', patch);
    });
    const result = await probeClaudeAccountUsage(options());
    expect(result).toMatchObject({ status: state, reason, windows: [] }); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    if (state === 'uncertain') expect(existsSync(scratchDirs[0]!)).toBe(true);
  });
  it.each([1, 2, 3, 4].flatMap((stage) => [undefined, 'unconfirmed' as const].map((processGroupSettlement) =>
    ({ stage, processGroupSettlement }))))('stops composite collection at unsettled native stage $stage ($processGroupSettlement)', async ({ stage, processGroupSettlement }) => {
    let calls = 0;
    const subprocess = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async (argv, config) => {
      scratchDirs.push(config.cwd); calls += 1;
      const stdout = argv.includes('auth')
        ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'PRIVATE_EMAIL', orgId: 'PRIVATE_ORG' })
        : argv.at(-1) === '--version' ? '2.1.257 (Claude Code)' : JSON.stringify(envelope());
      return nativeResult(stdout, calls === stage ? { processGroupSettlement } : {});
    });
    const report = await probeClaudeAccountUsage(options());
    expect(report).toMatchObject({ status: 'uncertain', reason: 'status-termination-uncertain',
      windows: [], loggedIn: null, authMethod: 'unknown', accountHint: null, subscriptionType: null });
    expect(subprocess).toHaveBeenCalledTimes(stage);
    expect(subprocess.mock.calls.every(([, config]) => config.requireProcessGroupExit === true)).toBe(true);
    expect(existsSync(subprocess.mock.calls.at(-1)![1].cwd)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('withholds quota when the entire monotonic budget expired during auth', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { authentication, subprocess } = mocks(); authentication.mockImplementation(async () => { now = 5000; return status(); });
    expect(await probeClaudeAccountUsage(options())).toMatchObject({ status: 'timed-out', windows: [] });
    expect(subprocess).not.toHaveBeenCalled();
  });
  it('pins command options against mutation between awaits', async () => {
    const config = options(); const { authentication, subprocess } = mocks();
    authentication.mockImplementation(async () => { config.command[0] = '/unexpected'; return status(); });
    await probeClaudeAccountUsage(config);
    expect(subprocess.mock.calls.every(([argv]) => argv[0] === '/fixture/native')).toBe(true);
    expect(authentication.mock.calls[1]![0].command[0]).toBe('/fixture/native');
  });
});


describe('current structured quota-only usage', () => {
  it('retains reported fractional and actual zero usage/deadlines, excluding raw session/content', () => {
    const parsed = parseClaudeNativeUsageStream(stream(), OBSERVED);
    expect(parsed?.quotaFresh).toBe(true);
    expect(parsed?.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt }))).toEqual([
      { id: 'five_hour', usedPercent: 0, resetsAt: SESSION_RESET },
      { id: 'seven_day', usedPercent: 27.5, resetsAt: WEEK_RESET },
      { id: 'seven_day_fable', usedPercent: 2, resetsAt: WEEK_RESET },
    ]);
    expect(parsed?.windows[0]?.resetProvenance).toMatchObject({ kind: 'rolling-release', at: SESSION_RESET });
    expect(parsed?.windows[1]).not.toHaveProperty('resetProvenance'); // plan comes ONLY from bracketing native auth.
    expect(JSON.stringify(parsed)).not.toContain('fixture-session');
    expect(JSON.stringify(parsed)).not.toContain(INTRO);
  });
  it.each([null, { limits: null }, { limits: [] }])('keeps cached/prose fallback display-only when current rows are absent (%j)', (rate_limits) => {
    const frames = usageFrames(); frames[1]!.usage_report!.rate_limits = rate_limits as never;
    const parsed = parseClaudeNativeUsageStream(stream(frames), OBSERVED);
    expect(parsed?.quotaFresh).toBe(false);
    expect(parsed?.windows).toEqual(parseClaudeNativeUsage(JSON.stringify(envelope())));
    expect(parsed?.windows.every((window) => window.resetsAt === null && window.nativeReport?.source === 'claude-usage')).toBe(true);
  });
  it('does not claim freshness when only a zero-inference prose terminal remains', () => {
    const frames = usageFrames(); frames.splice(1, 1);
    expect(parseClaudeNativeUsageStream(stream(frames), OBSERVED)?.quotaFresh).toBe(false);
  });
  it.each([
    ['positive turns', (f: any[]) => { f[2].num_turns = 1; }],
    ['missing turns', (f: any[]) => { delete f[2].num_turns; }],
    ['API duration', (f: any[]) => { f[2].duration_api_ms = 1; }],
    ['token usage', (f: any[]) => { f[2].usage.input_tokens = 1; }],
    ['model usage', (f: any[]) => { f[2].modelUsage = { model: {} }; }],
    ['session cost', (f: any[]) => { f[1].usage_report.session.total_cost_usd = 1; }],
    ['session API duration', (f: any[]) => { f[1].usage_report.session.total_api_duration_ms = 1; }],
    ['session model usage', (f: any[]) => { f[1].usage_report.session.model_usage = { model: {} }; }],
    ['session mismatch', (f: any[]) => { f[1].session_id = 'another-session'; }],
    ['missing session', (f: any[]) => { delete f[2].session_id; }],
    ['missing wrapper uuid', (f: any[]) => { delete f[1].uuid; }],
    ['missing terminal uuid', (f: any[]) => { delete f[2].uuid; }],
    ['missing wrapper session', (f: any[]) => { delete f[1].session_id; }],
    ['duplicate uuid', (f: any[]) => { f[1].uuid = f[0].uuid; }],
    ['subagent report', (f: any[]) => { f[1].parent_tool_use_id = 'child'; }],
    ['duplicate report', (f: any[]) => { f.splice(1, 0, { ...f[1], uuid: 'duplicate-report' }); }],
    ['duplicate result', (f: any[]) => { f.push({ ...f[2], uuid: 'duplicate-result' }); }],
    ['terminal not last', (f: any[]) => { f.push({ ...f[0], uuid: 'late-init' }); }],
    ['real streaming frame', (f: any[]) => { f.splice(1, 0, { type: 'stream_event', session_id: 'fixture-session' }); }],
    ['unrelated assistant', (f: any[]) => { f.splice(1, 0, { type: 'assistant', session_id: 'fixture-session' }); }],
    ['missing session meter', (f: any[]) => { f[1].usage_report.rate_limits.limits.shift(); }],
    ['missing weekly meter', (f: any[]) => { f[1].usage_report.rate_limits.limits.splice(1, 1); }],
    ['duplicate meter', (f: any[]) => { const rows = f[1].usage_report.rate_limits.limits; rows.push(rows[0]); }],
    ['unknown account meter', (f: any[]) => { f[1].usage_report.rate_limits.limits[0].kind = 'new-meter'; }],
    ['mismatched group', (f: any[]) => { f[1].usage_report.rate_limits.limits[0].group = 'weekly'; }],
    ['unknown model scope', (f: any[]) => { f[1].usage_report.rate_limits.limits[2].scope.model.display_name = 'UNKNOWN'; }],
    ['unknown surface', (f: any[]) => { f[1].usage_report.rate_limits.limits[2].scope.surface = { display_name: 'other' }; }],
    ['invalid percent', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].percent = 101; }],
    ['missing percent', (f: any[]) => { delete f[1].usage_report.rate_limits.limits[1].percent; }],
    ['impossible calendar reset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = '2027-02-30T12:00:00Z'; }],
    ['24hour reset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = '2026-10-04T24:00:00Z'; }],
    ['invalid offset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = '2026-10-04T12:00:00+04:99'; }],
    ['nonleap calendar reset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = '2027-02-29T12:00:00Z'; }],
    ['human reset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = 'Oct 4 2026'; }],
    ['expired reset', (f: any[]) => { f[1].usage_report.rate_limits.limits[1].resets_at = OBSERVED; }],
  ])('refuses %s without invented snapshot', (_name, mutate) => {
    const frames = usageFrames(); mutate(frames);
    expect(parseClaudeNativeUsageStream(stream(frames), OBSERVED)).toBeNull();
  });
  it.each([
    ['2028-02-29T12:00:00.123456Z', '2028-02-29T12:00:00.123Z'],
    ['2026-10-04T08:00:00.1-04:00', '2026-10-04T12:00:00.100Z'],
    ['2026-10-04T17:30:00+05:30', WEEK_RESET],
  ])('keeps valid real calendar/fraction/offset %s', (value, normalized) => {
    const frames = usageFrames(); frames[1]!.usage_report!.rate_limits!.limits[1]!.resets_at = value;
    expect(parseClaudeNativeUsageStream(stream(frames), OBSERVED)?.windows[1]?.resetsAt).toBe(normalized);
  });
  it('keeps genuinely missing reset unknown and accepts actual100%', () => {
    const frames = usageFrames(); const row = frames[1]!.usage_report!.rate_limits!.limits[1]!;
    row.percent = 100; row.resets_at = null as never;
    expect(parseClaudeNativeUsageStream(stream(frames), OBSERVED)?.windows[1]).toMatchObject({ usedPercent: 100, resetsAt: null });
  });
  it.each(['not json', 'null', '[]', 'x'.repeat(32769)])('rejects malformed/oversized stream %#', (raw) => {
    expect(parseClaudeNativeUsageStream(raw, OBSERVED)).toBeNull();
  });
  it.each(['pro', 'max', 'team', 'enterprise', null])('brackets structured collection and qualifies deadline only on actualPro/Max (%s)', async (plan) => {
    const { authentication, subprocess } = mocks();
    authentication.mockResolvedValue(status({ startedAt: OBSERVED, subscriptionType: plan }));
    subprocess.mockImplementation(async (argv, config) => {
      scratchDirs.push(config.cwd);
      return nativeResult(argv.at(-1) === '--version' ? '2.1.280 (Claude Code)' : stream());
    });
    const result = await probeClaudeAccountUsage(options());
    expect(result).toMatchObject({ reason: 'usage-native-current', quotaFresh: true });
    expect(authentication).toHaveBeenCalledTimes(2);
    expect(subprocess.mock.calls[1]?.[0]).toEqual(['/fixture/native', '--isolated', '--safe-mode', '--restricted',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--no-session-persistence',
      '--output-format', 'stream-json', '--verbose', '-p', '/usage']);
    const weekly = result.windows.find(({ id }) => id === 'seven_day')!;
    if (plan === 'pro' || plan === 'max') {
      expect(weekly.resetProvenance).toMatchObject({ kind: 'weekly-deadline', at: WEEK_RESET, plan,
        source: 'claude-native-usage-report' });
      expect(weekly.resetProvenance).not.toHaveProperty('startsAt');
    } else expect(weekly).not.toHaveProperty('resetProvenance');
    expect(result).not.toHaveProperty('subscriptionCredentials');
  });
  it('clears valid structured telemetry when native account changes after collection', async () => {
    const { authentication, subprocess } = mocks();
    authentication.mockResolvedValueOnce(status({ startedAt: OBSERVED })).mockResolvedValueOnce(status({ accountHint: 'b'.repeat(64) }));
    subprocess.mockImplementation(async (argv, config) => {
      scratchDirs.push(config.cwd);
      return nativeResult(argv.at(-1) === '--version' ? '2.1.280 (Claude Code)' : stream());
    });
    expect(await probeClaudeAccountUsage(options())).toMatchObject({ reason: 'usage-account-changed', windows: [] });
  });
});
