/** Real private controller ownership/records; subordinate execution is deliberately inert. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as immutable from '../src/core/util/immutable-private-record-store.js';
import { appendPortfolioControllerEvent, foldPortfolioController, portfolioControllerDirectory, readPortfolioControllerEvents } from '../src/core/universe/portfolio-controller-store.js';
import { PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES, type PortfolioControllerEvent } from '../src/core/universe/portfolio-controller-types.js';
import type { UniverseCampaignReadiness } from '../src/core/universe/campaign-readiness.js';
import type { UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';
const hooks = vi.hoisted(() => ({ readiness: vi.fn(), run: vi.fn(), campaign: vi.fn(), plan: vi.fn(), preflight: vi.fn(), deliver: vi.fn(), deliveries: vi.fn(), acquire: vi.fn() }));
vi.mock('../src/core/universe/campaign-readiness.js', () => ({ readUniverseCampaignReadiness: hooks.readiness }));
vi.mock('../src/core/universe/campaign.js', async original => ({ ...await original<object>(), runUniverseCampaignOwned: hooks.run }));
vi.mock('../src/core/universe/execution.js', async original => ({ ...await original<object>(), acquireUniverseExecution: hooks.acquire }));
vi.mock('../src/core/universe/campaign-store.js', async original => ({ ...await original<object>(), readUniverseCampaign: hooks.campaign }));
vi.mock('../src/core/universe/portfolio-plan.js', async original => ({ ...await original<object>(), readUniversePortfolioPlan: hooks.plan }));
vi.mock('../src/core/universe/campaign-delivery.js', async original => ({ ...await original<object>(), preflightUniverseCampaignDelivery: hooks.preflight,
  deliverCompletedUniverseCampaign: hooks.deliver }));
vi.mock('../src/core/universe/delivery.js', async original => ({ ...await original<object>(), readUniverseDeliveries: hooks.deliveries }));
import { readUniversePortfolioController, runUniversePortfolioController } from '../src/core/universe/portfolio-controller.js';
const roots: string[] = [];
beforeEach(() => { for (const mock of Object.values(hooks)) mock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const HASH = 'a'.repeat(64); const RECORDS = 'b'.repeat(64);
function temporary() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'controller-diagnostics-'))); roots.push(path); return path; }
function fixture(delivery = false) {
  const root = temporary(); const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'controller',
    tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 10_000 };
  let summary = { fixtureId: 'campaign', state: 'ready' } as unknown as UniverseCampaignSummary;
  let readiness: UniverseCampaignReadiness = { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'campaign', universeId: 'universe',
    sourceState: 'healthy', observedState: 'ready', disposition: 'startable', reasonCode: 'never-started', automaticAction: 'run', resourceRuntimeRequired: false,
    recordsDigest: RECORDS, sampledAt: new Date().toISOString(), expectedIdentity: { universeId: 'universe', definitionDigest: HASH,
      manifestDigest: HASH, comparatorDigest: HASH, summaryDigest: digest(canonical(summary)) } };
  hooks.readiness.mockImplementation(() => structuredClone(readiness)); hooks.campaign.mockImplementation(() => structuredClone(summary));
  hooks.plan.mockImplementation(() => ({ schemaVersion: 1, sourceState: 'healthy', definition, definitionDigest: digest(canonical(definition)),
    topologicalOrder: ['campaign'], nodes: [{ campaignId: 'campaign', campaign: structuredClone(summary) }] }));
  hooks.preflight.mockImplementation(() => ({ repo: '/synthetic/repo', campaign: structuredClone(summary) }));
  hooks.deliveries.mockReturnValue({ sourceState: 'healthy', deliveries: [] });
  const finish = () => {
    summary = { fixtureId: 'campaign', state: 'completed' } as unknown as UniverseCampaignSummary;
    readiness = { ...readiness, observedState: 'completed', disposition: 'terminal', reasonCode: 'campaign-completed', automaticAction: 'none',
      recordsDigest: 'c'.repeat(64), expectedIdentity: { ...readiness.expectedIdentity!, summaryDigest: digest(canonical(summary)) } };
    return structuredClone(summary);
  };
  hooks.run.mockImplementation(async () => finish());
  const executionLock = { path: '/synthetic/.execution.lock', token: 'fixture', dev: 1n, ino: 1n };
  const originalOwns = locks.ownsLocalStoreLock;
  vi.spyOn(locks, 'ownsLocalStoreLock').mockImplementation(lock => lock === executionLock || originalOwns(lock));
  hooks.acquire.mockReturnValue({ state: 'acquired', lock: executionLock });
  const options = { root, ...(delivery ? { deliveryPlan: { schemaVersion: 1 as const,
    deliveries: [{ campaignId: 'campaign', branch: 'codex/fixture', baseCommit: 'a'.repeat(40) }] } } : {}) };
  return { root, definition, options, finish,
    events: () => readPortfolioControllerEvents(portfolioControllerDirectory('controller', { root })) };
}

describe('durable dispatch diagnosis without settlement authority', () => {
  it.each([
    ['campaign-execution', 'campaign-call-threw'], ['campaign-verification', 'campaign-evidence-changed'],
    ['delivery-execution', 'delivery-call-threw'], ['delivery-verification', 'delivery-evidence-changed'],
    ['delivery-verification', 'delivery-receipt-unverified'], ['settlement-publication', 'settlement-write-failed'],
  ] as const)('records %s/%s and retains its unresolved intent on restart', async (phase, code) => {
    const f = fixture(phase.startsWith('delivery-'));
    if (phase === 'campaign-execution') hooks.run.mockRejectedValue(new Error('PRIVATE/raw/path?token=secret'));
    if (phase === 'campaign-verification') hooks.run.mockResolvedValue({ fixtureId: 'changed', state: 'completed' });
    if (phase === 'delivery-execution') hooks.deliver.mockRejectedValue(new Error('PRIVATE delivery exception'));
    if (phase === 'delivery-verification') hooks.deliver.mockImplementation(async () => ({
      campaign: code === 'delivery-evidence-changed' ? { fixtureId: 'different' } : f.finish(),
      delivery: { status: 'delivered', receipt: { universeId: 'universe', branch: 'codex/fixture', baseCommit: 'a'.repeat(40), status: 'delivered' } },
    }));
    if (phase === 'settlement-publication') {
      const original = immutable.writeImmutablePrivateRecord;
      vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) =>
        (record as { kind?: string }).kind === 'settled' ? 'failed' : original(config, record, options));
    }
    const report = await runUniversePortfolioController(f.definition, f.options);
    expect(report.outcomes[0]).toMatchObject({ state: 'in-flight', reasonCode: 'reconciliation-required' });
    const intent = f.events().find(event => event.kind === 'intent')!;
    expect(report.diagnostics).toEqual([{ campaignId: 'campaign', intentDigest: digest(canonical(intent)), phase, code, at: expect.any(String) }]);
    expect(canonical(f.events())).not.toContain('PRIVATE');
    expect(f.events().filter(event => event.kind === 'dispatch-diagnostic')).toHaveLength(1);
    expect(f.events().some(event => event.kind === 'settled')).toBe(false);
    const before = readUniversePortfolioController('controller', { root: f.root });
    expect(before.diagnostics).toEqual(report.diagnostics);
    const replay = await runUniversePortfolioController(f.definition, f.options);
    expect(replay.diagnostics).toEqual(report.diagnostics); expect(hooks.run).toHaveBeenCalledOnce();
  });
  it('does not read hostile exception properties or manufacture diagnostic detail', async () => {
    const f = fixture(); const getter = vi.fn(() => { throw new Error('getter ran'); }); const error = {};
    for (const key of ['message', 'stack', 'code', 'cause']) Object.defineProperty(error, key, { get: getter });
    hooks.run.mockRejectedValue(error);
    const report = await runUniversePortfolioController(f.definition, f.options);
    expect(report.diagnostics?.[0]?.code).toBe('campaign-call-threw'); expect(getter).not.toHaveBeenCalled();
  });
  it('can persist a diagnosis after caller cancellation without allowing another call', async () => {
    const f = fixture(); const controller = new AbortController();
    hooks.run.mockImplementation(async () => { controller.abort(); throw new Error('cancelled call'); });
    const result = await runUniversePortfolioController(f.definition, { ...f.options, signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(result.diagnostics?.[0]?.code).toBe('campaign-call-threw');
    expect(result.outcomes[0]?.state).toBe('in-flight'); expect(hooks.run).toHaveBeenCalledOnce();
  });
  it('leaves the intent unresolved when the diagnostic writer refuses', async () => {
    const f = fixture(); hooks.run.mockRejectedValue(new Error('call failed')); const original = immutable.writeImmutablePrivateRecord;
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) =>
      (record as { kind?: string }).kind === 'dispatch-diagnostic' ? 'failed' : original(config, record, options));
    const report = await runUniversePortfolioController(f.definition, f.options);
    expect(report).not.toHaveProperty('diagnostics'); expect(report.outcomes[0]?.state).toBe('in-flight');
    expect(report.reasons).toContain('campaign:dispatch-diagnostic-unavailable'); expect(f.events().some(event => event.kind === 'settled')).toBe(false);
  });
  it('keeps successful legacy reports free of optional diagnostics', async () => {
    const f = fixture(); const report = await runUniversePortfolioController(f.definition, f.options);
    expect(report.status).toBe('completed'); expect(report).not.toHaveProperty('diagnostics');
  });
});

function history(): PortfolioControllerEvent[] {
  const definition: UniversePortfolioDefinition = { schemaVersion: 1, id: 'controller', tasks: [{ campaignId: 'campaign', dependsOn: [] }], maxParallel: 1, maxDurationMs: 60_000 };
  return [{ id: '00000000', sequence: 0, at: '2026-09-10T12:00:00.000Z', kind: 'created', enrollment: { definition,
    definitionDigest: digest(canonical(definition)), deadlineAt: '2026-09-10T12:01:00.000Z', deliveryPlan: null,
    pins: [{ campaignId: 'campaign', universeId: 'universe', definitionDigest: HASH, manifestDigest: HASH, comparatorDigest: HASH,
      campaignDigest: HASH, recordsDigest: RECORDS, initialState: 'pending', dispatch: 'campaign', reasonCode: 'never-dispatched' }] } }];
}
type Input<T = PortfolioControllerEvent> = T extends PortfolioControllerEvent ? Omit<T, 'id' | 'sequence'> : never;
function add(records: PortfolioControllerEvent[], input: Input): PortfolioControllerEvent[] {
  return [...records, { ...input, sequence: records.length, id: String(records.length).padStart(8, '0') } as PortfolioControllerEvent];
}
function readResult(records: PortfolioControllerEvent[]): ReturnType<typeof immutable.readImmutablePrivateRecords> {
  return { sourceState: 'healthy', sourcePresent: true, complete: true, records, stopReasons: [], filesRead: records.length,
    bytesRead: Buffer.byteLength(canonical(records)), invalidFiles: 0, limitExceeded: false };
}
const time = '2026-09-10T12:00:00.010Z';
function intended() { return add(history(), { kind: 'intent', campaignId: 'campaign', at: time }); }
function diagnosis(records = intended()): Input & { kind: 'dispatch-diagnostic' } {
  return { kind: 'dispatch-diagnostic', campaignId: 'campaign', intentDigest: digest(canonical(records.find(event => event.kind === 'intent'))),
    phase: 'campaign-execution', code: 'campaign-call-threw', at: time };
}
const settlement: Input = { kind: 'settled', at: time, recordsDigest: RECORDS, outcome: { campaignId: 'campaign', state: 'completed', attempted: true,
  reasonCode: 'campaign-completed', campaignDigest: HASH, deliveryDigest: null } };
describe('closed diagnostic ledger and capacity protocol', () => {
  it('permits one exact diagnosis while in flight and retains it after genuine settlement', () => {
    const before = intended(); const records = add(before, diagnosis(before));
    const folded = foldPortfolioController(records); expect(folded.states.get('campaign')?.state).toBe('in-flight');
    const finished = foldPortfolioController(add(records, settlement));
    expect(finished.states.get('campaign')?.state).toBe('completed'); expect(finished.diagnostics).toEqual(folded.diagnostics);
  });
  it('refuses diagnostics without an intent, after settlement, duplicated, or naming a foreign intent', () => {
    const records = intended(); const row = diagnosis(records);
    for (const bad of [add(history(), row), add(add(records, settlement), row), add(add(records, row), row),
      add(records, { ...row, intentDigest: 'f'.repeat(64) }), add(records, { ...row, campaignId: 'other' })]) expect(() => foldPortfolioController(bad)).toThrow();
  });
  it.each([{ phase: 'other' }, { code: 'raw-private-error' }, { phase: 'campaign-verification', code: 'campaign-call-threw' },
    { phase: 'delivery-execution', code: 'delivery-call-threw' }, { message: 'PRIVATE' }, { intentDigest: 'bad' }, { at: 'not-date' }])(
    'refuses invalid diagnostic fields/pairs %j', patch => {
      const records = intended(); expect(() => foldPortfolioController(add(records, { ...diagnosis(records), ...patch } as Input))).toThrow();
    });
  it('rejects getters without invocation and keeps the exported closed map frozen', () => {
    const records = intended(); const row = add(records, diagnosis(records)); const getter = vi.fn();
    Object.defineProperty(row[2]!, 'code', { enumerable: true, get: getter }); expect(() => foldPortfolioController(row)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(Object.isFrozen(PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES)).toBe(true);
    expect(Object.values(PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES).every(Object.isFrozen)).toBe(true);
  });
  it('reserves enough slots for intent, diagnostic, settlement, drain and acknowledgement', () => {
    const directory = temporary(); mkdirSync(join(directory, 'ledger'), { mode: 0o700 }); let records = history();
    while (records.length < 506) records = add(records, { kind: 'observed', at: time });
    vi.spyOn(immutable, 'readImmutablePrivateRecords').mockImplementation(() => readResult(records));
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((_config, record) => { records = [...records, record as PortfolioControllerEvent]; return 'recorded'; });
    const append = (input: Input) => appendPortfolioControllerEvent(directory, input);
    append({ kind: 'observed', at: time }); // 507 + three effect slots + two controls = 512.
    expect(() => append({ kind: 'observed', at: time })).toThrow('capacity');
    append({ kind: 'intent', campaignId: 'campaign', at: time }); append(diagnosis(records)); append(settlement);
    append({ kind: 'control', action: 'drain', at: time }); append({ kind: 'drained', drainSequence: 510, at: time });
    expect(records).toHaveLength(512); expect(foldPortfolioController(records).control?.acknowledgedAt).toBe(time);
  });
  it('does not strand old admitted effects or drain/ACK capacity behind new optional diagnostic reserves', () => {
    const directory = temporary(); mkdirSync(join(directory, 'ledger'), { mode: 0o700 }); let records = history();
    const created = records[0]!; if (created.kind !== 'created') throw new Error('Expected creation');
    created.enrollment.definition.tasks.push({ campaignId: 'sibling', dependsOn: [] }); created.enrollment.definition.maxParallel = 2;
    created.enrollment.definitionDigest = digest(canonical(created.enrollment.definition));
    created.enrollment.pins.push({ ...created.enrollment.pins[0]!, campaignId: 'sibling', universeId: 'other' });
    records = add(records, { kind: 'control', action: 'drain', at: time });
    records = add(records, { kind: 'drained', drainSequence: 1, at: time });
    records = add(records, { kind: 'control', action: 'resume', drainSequence: 1, at: time });
    records = add(records, { kind: 'intent', campaignId: 'campaign', at: time });
    records = add(records, { kind: 'intent', campaignId: 'sibling', at: time });
    while (records.length < 508) records = add(records, { kind: 'observed', at: time });
    vi.spyOn(immutable, 'readImmutablePrivateRecords').mockImplementation(() => readResult(records));
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((_config, record) => { records = [...records, record as PortfolioControllerEvent]; return 'recorded'; });
    const append = (input: Input) => appendPortfolioControllerEvent(directory, input);
    expect(() => append(diagnosis(records))).toThrow('capacity'); expect(records).toHaveLength(508);
    append(settlement);
    append({ ...settlement, outcome: { ...settlement.outcome, campaignId: 'sibling' } });
    append({ kind: 'control', action: 'drain', at: time }); append({ kind: 'drained', drainSequence: 510, at: time });
    expect(records).toHaveLength(512); expect(foldPortfolioController(records).control?.acknowledgedAt).toBe(time);
  });
  it.each(['ownership', 'proof'] as const)('rechecks settlement %s at the final immutable publication boundary', (changed) => {
    const directory = temporary(); const records = intended();
    for (const event of records) { const { id: _id, sequence: _sequence, ...input } = event; appendPortfolioControllerEvent(directory, input); }
    let valid = true; const checks: boolean[] = [];
    expect(() => appendPortfolioControllerEvent(directory, settlement, { beforeSettlement: current => {
      // Flip the host-owned verdict only after the real writer prepares its
      // publication stage, immediately before the no-clobber record link.
      if (readdirSync(join(directory, 'ledger', 'staging')).length > 0) valid = false;
      checks.push(valid); expect(current).toEqual(records);
      if (!valid) throw new Error(`${changed} changed`);
    } })).toThrow();
    expect(checks.slice(0, -1).every(Boolean)).toBe(true); expect(checks.at(-1)).toBe(false);
    expect(readPortfolioControllerEvents(directory)).toEqual(records);
  });
});
