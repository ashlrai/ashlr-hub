/** Protocol/lifecycle units: synthetic reports and a mocked subprocess runner, no providers. */
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceEngineeringOutcomesReader, ENGINEERING_OUTCOMES_READ_BUDGET_MS,
  type ResourceEngineeringOutcomesReader, type EngineeringOutcomesReadRequest } from '../src/core/resources/engineering-outcomes-reader.js';
import type { ResourceEngineeringOutcomesOptions } from '../src/core/resources/engineering-outcomes.js';
import type { ResourceEngineeringOutcomes } from '../src/core/resources/engineering-outcomes-types.js';
import type { VerifySubprocessOptions, VerifySubprocessResult } from '../src/core/run/verify-commands.js';

const fake = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/core/run/verify-commands.js', () => ({ runVerifySubprocessAsync: fake.run }));
const readers: ResourceEngineeringOutcomesReader[] = [];
const hash = (c: string) => c.repeat(64);
function input(): ResourceEngineeringOutcomesOptions {
  return { root: '/private/fixture/ledger', poolFile: '/private/fixture/pool.json', bindingsFile: '/private/fixture/bindings.json',
    enrollment: { id: 'enrollment', enrollmentDigest: hash('a'), campaigns: [{ id: 'campaign' }] },
    host: { root: '/private/fixture/world', resourceRuntime: '/private/fixture/runtime.json' } } as ResourceEngineeringOutcomesOptions;
}
const options = () => ({ expectedNodeInput: { bindingDigest: hash('b'), requestDigest: hash('c') } });
function reader() { const r = createResourceEngineeringOutcomesReader(); readers.push(r); return r; }
function report(): ResourceEngineeringOutcomes {
  const usage = { attempts: 0, joinedAttempts: 0, reportedAttempts: 0, unknownAttempts: 0, recordedInputTokens: 0,
    recordedOutputTokens: 0, totalTokens: null, complete: true };
  const timing = { scope: 'summed-worker-execution' as const, attempts: 0, measuredAttempts: 0, recordedDurationMs: 0, totalDurationMs: null, complete: true };
  return { schemaVersion: 1, enrollmentId: 'enrollment', enrollmentDigest: hash('a'), sampledAt: new Date().toISOString(), sourceState: 'healthy',
    scope: 'campaign-evaluations-and-recorded-worker-usage', authority: 'observation-only', acceptanceScope: 'fixed-evaluator-and-local-branch-only',
    attribution: 'campaign-cumulative-not-graph-invocation', productionAccepted: null, routingChanged: false, complete: true, reasons: [], usage, timing,
    campaigns: [{ campaignId: 'campaign', universeId: 'universe', definitionDigest: hash('d'), comparatorDigest: hash('e'), state: 'running', sourceState: 'healthy',
      reasons: [], metric: { name: 'processes', direction: 'minimize', minImprovement: 1 }, seed: { status: 'unmeasured', score: null, passed: null },
      stages: { trials: 0, evaluated: 0, passed: 0, rejected: 0, selected: 0, strictImprovements: 0, verifiedLocalDeliveries: null },
      usage: { ...usage }, timing: { ...timing }, niches: [], workers: [] }] };
}
function result(opts: VerifySubprocessOptions, change?: (value: { schemaVersion: number; requestId: string; scopeDigest: string; report: ResourceEngineeringOutcomes }) => void): VerifySubprocessResult {
  const request = JSON.parse(opts.input!) as EngineeringOutcomesReadRequest;
  const value = { schemaVersion: 1, requestId: request.requestId, scopeDigest: request.scopeDigest, report: report() };
  change?.(value);
  return { stdout: JSON.stringify(value), stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' };
}
function defer() {
  let resolve!: (value: VerifySubprocessResult) => void;
  fake.run.mockImplementation(() => new Promise<VerifySubprocessResult>(done => { resolve = done; }));
  return { finish: (patch: Partial<VerifySubprocessResult> = {}) => resolve({ ...result(fake.run.mock.calls[0]![1]), ...patch }) };
}
beforeEach(() => { fake.run.mockReset(); fake.run.mockImplementation(async (_argv, opts) => result(opts)); });
afterEach(async () => { for (const r of readers.splice(0)) await r.close().catch(() => {}); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('fixed engineering outcomes reader protocol', () => {
  it('binds fresh report, private stdin and full nodeInput; runs no caller executable', async () => {
    const value = await reader().read(input(), options());
    expect(value).toMatchObject({ authority: 'observation-only', sourceState: 'healthy' });
    const [argv, opts] = fake.run.mock.calls[0] as [string[], VerifySubprocessOptions];
    expect(argv[0]).toBe(process.execPath); expect(argv.join(' ')).toContain('engineering-outcomes-read-process');
    expect(argv.join(' ')).not.toContain('/private/fixture');
    expect(opts).toMatchObject({ requireProcessGroupExit: true, terminationGraceMs: 5000, cwd: input().root });
    expect(opts.timeoutMs).toBeLessThanOrEqual(ENGINEERING_OUTCOMES_READ_BUDGET_MS - 6000);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(JSON.parse(opts.input!)).toMatchObject({ schemaVersion: 1, input: input(), expectedNodeInput: options().expectedNodeInput });
    expect(opts.env).not.toHaveProperty('NODE_OPTIONS');
  });
  it('detaches scope and refuses a simultaneous read without launching or queueing', async () => {
    const d = defer(), r = reader(), supplied = input(), pin = options();
    const first = r.read(supplied, pin);
    supplied.enrollment.id = 'changed'; pin.expectedNodeInput.bindingDigest = hash('f');
    await expect(r.read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_BUSY' });
    expect(JSON.parse(fake.run.mock.calls[0]![1].input)).toMatchObject({ input: { enrollment: { id: 'enrollment' } }, expectedNodeInput: { bindingDigest: hash('b') } });
    d.finish(); await expect(first).resolves.toMatchObject({ enrollmentId: 'enrollment' }); expect(fake.run).toHaveBeenCalledTimes(1);
  });
  it('preserves unavailable, incomplete and optional unavailable phase reports', async () => {
    fake.run.mockImplementation(async (_argv, opts) => result(opts, v => {
      v.report.complete = false; v.report.sourceState = 'degraded'; v.report.reasons = ['outcome-evidence-incomplete'];
      v.report.usage.complete = false; v.report.timing.complete = false;
      v.report.campaigns[0]!.phaseEvidence = { schemaVersion: 1, scope: 'recorded-execution-phases', liveness: 'not-attested',
        sourceState: 'unavailable', reason: 'phase-evidence-changed', seed: null, runs: [] };
    }));
    await expect(reader().read(input(), options())).resolves.toMatchObject({ complete: false, campaigns: [{ phaseEvidence: { sourceState: 'unavailable' } }] });
  });
  it.each(['request-id', 'scope-digest', 'enrollment', 'campaign', 'private-extra', 'contradictory-usage', 'phase-liveness', 'old-sample', 'future-sample', 'too-large'])(
    'refuses %s without returning child content', async kind => {
      fake.run.mockImplementation(async (_argv, opts) => result(opts, v => {
        if (kind === 'request-id') v.requestId = 'wrong';
        if (kind === 'scope-digest') v.scopeDigest = hash('f');
        if (kind === 'enrollment') v.report.enrollmentDigest = hash('f');
        if (kind === 'campaign') v.report.campaigns[0]!.campaignId = 'foreign';
        if (kind === 'private-extra') Object.assign(v.report, { secretPath: '/private/sensitive' });
        if (kind === 'contradictory-usage') v.report.usage.joinedAttempts = 1;
        if (kind === 'phase-liveness') Object.assign(v.report.campaigns[0]!, { phaseEvidence: { liveness: 'live' } });
        if (kind === 'old-sample') v.report.sampledAt = '2000-01-01T00:00:00.000Z';
        if (kind === 'future-sample') v.report.sampledAt = '2099-01-01T00:00:00.000Z';
        if (kind === 'too-large') Object.assign(v.report, { extra: 'x'.repeat(200 * 1024) });
      }));
      await expect(reader().read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE', message: 'Engineering outcome observation unavailable' });
    });
  it.each(['malformed', 'truncated', 'exit', 'error', 'not-started'])('refuses settled %s output without poisoning future reads', async kind => {
    fake.run.mockImplementationOnce(async (_argv, opts) => ({ ...result(opts), ...(
      kind === 'malformed' ? { stdout: 'private malformed output' } : kind === 'truncated' ? { outputTruncated: true } :
        kind === 'exit' ? { exitCode: 1 } : kind === 'error' ? { error: 'private native error' } : { processGroupSettlement: 'not-started' }) }));
    const r = reader(); await expect(r.read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_UNAVAILABLE' });
    await expect(r.read(input(), options())).resolves.toMatchObject({ enrollmentId: 'enrollment' });
  });
  it.each(['unconfirmed', 'missing', 'throw'])('permanently holds the reader after %s cleanup', async kind => {
    fake.run.mockImplementationOnce(async (_argv, opts) => {
      if (kind === 'throw') throw new Error('private runner failure');
      return { ...result(opts), processGroupSettlement: kind === 'missing' ? undefined : 'unconfirmed' };
    });
    const r = reader();
    await expect(r.read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_CLEANUP_UNCONFIRMED' });
    await expect(r.read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_CLEANUP_UNCONFIRMED' });
    await expect(r.close()).rejects.toMatchObject({ code: 'READ_PROJECTION_CLEANUP_UNCONFIRMED' });
    expect(fake.run).toHaveBeenCalledTimes(1);
  });
  it('propagates cancellation, waits for settlement, and never accepts late valid output', async () => {
    const d = defer(), r = reader(), controller = new AbortController();
    const pending = r.read(input(), { ...options(), signal: controller.signal });
    controller.abort(); expect(fake.run.mock.calls[0]![1].signal.aborted).toBe(true);
    d.finish(); await expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_CANCELLED' });
    await expect(r.close()).resolves.toBeUndefined();
  });
  it('close is idempotent, waits for custody, and refuses new reads', async () => {
    const d = defer(), r = reader();
    const pending = r.read(input(), options()).catch(error => error);
    const closing = r.close(); expect(r.close()).toBe(closing);
    expect(fake.run.mock.calls[0]![1].signal.aborted).toBe(true);
    await expect(r.read(input(), options())).rejects.toMatchObject({ code: 'READ_PROJECTION_CLOSED' });
    let finished = false; void closing.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    d.finish(); await closing; expect((await pending).code).toBe('READ_PROJECTION_CANCELLED');
  });
  it('reserves shutdown grace and clears the original deadline timer', async () => {
    vi.useFakeTimers(); const d = defer(), r = reader();
    const pending = r.read(input(), options());
    await vi.advanceTimersByTimeAsync(54_000);
    expect(fake.run.mock.calls[0]![1].signal.aborted).toBe(true);
    d.finish(); await expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks monotonic deadline even if wall time moves back and timer has not fired', async () => {
    let mono = 100; const wall = Date.now();
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    vi.spyOn(Date, 'now').mockReturnValue(wall);
    const d = defer(), r = reader(), pending = r.read(input(), options());
    mono += 54_001; vi.mocked(Date.now).mockReturnValue(wall - 1000);
    d.finish(); await expect(pending).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
  });
  it.each(['own-getter', 'inherited-getter', 'proxy', 'input-getter', 'oversize', 'missing-pin', 'bad-path', 'extra-option'])(
    'rejects %s before subprocess invocation or accessor execution', async kind => {
      const getter = vi.fn(() => { throw new Error('must not run'); });
      const value = input(); let controls: unknown = options();
      if (kind === 'own-getter') Object.defineProperty(controls, 'signal', { get: getter });
      if (kind === 'inherited-getter') controls = Object.assign(Object.create(Object.defineProperty({}, 'signal', { get: getter })), options());
      if (kind === 'proxy') controls = new Proxy(options(), { get: getter });
      if (kind === 'input-getter') Object.defineProperty(value, 'root', { get: getter });
      if (kind === 'oversize') Object.assign(value.host, { privateText: 'x'.repeat(256 * 1024) });
      if (kind === 'missing-pin') controls = {};
      if (kind === 'bad-path') value.root = '/private/fixture/../other';
      if (kind === 'extra-option') Object.assign(controls!, { command: ['unsafe'] });
      await expect(reader().read(value, controls as ReturnType<typeof options>)).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
      expect(getter).not.toHaveBeenCalled(); expect(fake.run).not.toHaveBeenCalled();
    });
  it('does not start a pre-aborted request', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(reader().read(input(), { ...options(), signal: abort.signal })).rejects.toMatchObject({ code: 'READ_PROJECTION_CANCELLED' });
    expect(fake.run).not.toHaveBeenCalled();
  });
});
