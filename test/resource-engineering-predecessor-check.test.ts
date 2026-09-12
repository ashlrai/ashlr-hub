/** Synthetic reader projections exercise the real join. No filesystem, owner or provider execution. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { checkResourceEngineeringPredecessor, type ResourceEngineeringPredecessorCheckOptions } from '../src/core/resources/engineering-predecessor-check.js';

const hooks = vi.hoisted(() => ({ stat: vi.fn(), setup: vi.fn(), json: vi.fn(), registry: vi.fn(), prepared: vi.fn(),
  graph: vi.fn(), source: vi.fn(), queue: vi.fn(), preview: vi.fn(), console: vi.fn(), project: vi.fn(),
  accounting: vi.fn(), history: vi.fn(), journal: vi.fn(), campaign: vi.fn(), universe: vi.fn(), outcomes: vi.fn(), seed: vi.fn(), capture: vi.fn(), builtin: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<object>(), lstatSync: hooks.stat }));
vi.mock('../src/core/resources/engineering-autonomous-setup.js', async original => ({ ...await original<object>(), readResourceEngineeringAutonomousSetupEvidence: hooks.setup }));
vi.mock('../src/core/resources/engineering-preparation-registry.js', async original => ({ ...await original<object>(), createResourceEngineeringPreparationRegistry: hooks.registry }));
vi.mock('../src/core/resources/console-engineering.js', async original => ({ ...await original<object>(), prepareResourceConsoleEngineeringEnrollments: hooks.prepared, readResourceConsoleEngineeringGraphCompletion: hooks.graph }));
vi.mock('../src/core/resources/engineering-outcomes.js', () => ({ readResourceEngineeringOutcomes: hooks.outcomes }));
vi.mock('../src/core/resources/console-engineering-supervision-state.js', async original => ({ ...await original<object>(), readResourceConsoleEngineeringSupervisionState: hooks.queue }));
vi.mock('../src/core/resources/console-projects.js', async original => ({ ...await original<object>(), pinResourceConsoleProject: hooks.project }));
vi.mock('../src/core/resources/pool-supervisor.js', async original => ({ ...await original<object>(), previewResourceConsoleProjects: hooks.preview, decodeResourceConsoleState: hooks.console }));
vi.mock('../src/core/resources/pool-runtime.js', async original => ({ ...await original<object>(), readResourceJson: hooks.json,
  resourcePoolStatus: hooks.accounting, readResourcePoolHistory: hooks.history }));
vi.mock('../src/core/resources/engineering-successor-store.js', async original => ({ ...await original<object>(), readEngineeringSuccessorJournal: hooks.journal }));
vi.mock('../src/core/universe/campaign-store.js', async original => ({ ...await original<object>(), readUniverseCampaign: hooks.campaign, campaignUniverse: hooks.universe, assertCampaignSeedEvaluatorsSettled: hooks.seed }));
vi.mock('../src/core/universe/preparation-measurement-capture-store.js', async original => ({ ...await original<object>(), assertPreparationMeasurementsSettled: hooks.capture }));
vi.mock('../src/core/universe/builtin-trial-custody.js', async original => ({ ...await original<object>(), assertBuiltinTrialEvaluatorsSettled: hooks.builtin }));

const hash = (value: unknown) => digest(canonical(value));
const h = (text: string) => digest(text);
const deadline = '2025-01-01T00:01:00.000Z';
type Registration = { request: { id: string; profileId: string; name: string; objective: string }; enrollmentDigest: string; source?: { expectedDeliveryDigest: string } };
type Source = { source: { expectedDeliveryDigest: string }; projectId: string; commit: string; objective: string; context: string };
type JournalRow = { kind: string; key: string; id?: string; source?: unknown; task?: { id: string; mode: string };
  successorId?: string; output?: string; receiptDigest?: string; enrollmentId?: string; enrollmentDigest?: string; projectId?: string };
type Receipt = { id: string; status: string; taskDigest: string; poolDigest: string; workerId: string; outputDigest: string };
function fixture() {
  const pool = { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'fixture',
    maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] };
  const bindings = [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }];
  const runtime = { schemaVersion: 1, root: '/fixture/ledger', workspace: '/fixture/transport',
    poolPath: '/fixture/pool.json', bindingsPath: '/fixture/bindings.json', observationsPath: '/fixture/observations.json' };
  const config = { schemaVersion: 1, outputRoot: '/fixture/prepared', resourceRuntime: '/fixture/runtime.json', registrationScope: 'scope',
    profiles: [{ id: 'profile', label: 'Fixed', acceptance: 'Fixed acceptance', recipe: { seedRevision: 'a'.repeat(40) } }] };
  const supervision = { schemaVersion: 1, id: 'queue', maxDurationMs: 60_000, pollIntervalMs: 100,
    maxConcurrent: 1, maxAttemptsPerEnrollment: 3, maxEnrollments: 4, enrollments: [{ enrollmentId: 'initial', expectedEnrollmentDigest: h('initial') }] };
  const successor = { schemaVersion: 1, supervisionId: 'queue', profileId: 'profile', allowedWorkerIds: ['worker'],
    maxOutputTokens: 100, proposalTimeoutMs: 1000, maxSuccessors: 3, pollIntervalMs: 100 };
  const plan = { planDigest: h('plan'), projectId: 'default', initialEnrollmentDigest: h('initial'), holds: [] as string[],
    paths: { profiles: '/fixture/profiles.json', supervision: '/fixture/supervision.json', successors: '/fixture/successors.json' } };
  const project = { id: 'default', label: 'Default', workspace: '/fixture/project', enabled: true };
  const registrations: Registration[] = [];
  const sources = new Map<string, Source>(); const rows: JournalRow[] = []; const attempts: Receipt[] = [];
  const add = (id: string) => {
    registrations.push({ request: { id, profileId: 'profile', name: 'Next', objective: 'Useful next work' }, enrollmentDigest: h(id) });
    sources.set(id, { source: { expectedDeliveryDigest: h('delivery-' + id) }, projectId: 'default',
      commit: h('commit-' + id).slice(0, 40), objective: 'Objective ' + id, context: canonical({ files: [], score: 1 }) });
  };
  const link = (from: string, to?: string) => {
    const source = sources.get(from)!; const key = 'key-' + from;
    const task = { id: 'task-' + from, mode: 'read-only' };
    const output = canonical(to ? { action: 'propose', name: 'Next', objective: 'Useful next work' } : { action: 'stop' });
    const receipt = { id: task.id, status: 'completed', taskDigest: hash(task), poolDigest: hash({ pool, bindings }),
      workerId: 'worker', outputDigest: digest(output) };
    attempts.push(receipt);
    rows.push({ kind: 'intent', key, task, successorId: to ?? 'unused', source: { enrollmentId: from, enrollmentDigest: h(from),
      projectId: source.projectId, deliveryDigest: source.source.expectedDeliveryDigest, commit: source.commit, objective: source.objective,
      context: canonical({ acceptance: config.profiles[0]!.acceptance, source: JSON.parse(source.context) }) } },
    { kind: 'result', key, output, receiptDigest: hash(receipt) });
    if (to) {
      registrations.find(row => row.request.id === to)!.source = structuredClone(source.source);
      rows.push({ kind: 'prepared', key, enrollmentId: to, enrollmentDigest: h(to), projectId: 'default' },
        { kind: 'admitted', key, enrollmentDigest: h(to) });
    }
  };
  add('initial'); add('child'); link('initial', 'child');
  const queue = { state: { configDigest: hash(supervision), deadlineAt: deadline,
    entries: registrations.map(row => ({ enrollmentId: row.request.id, enrollmentDigest: row.enrollmentDigest, attempts: 1, lastOutcome: 'settled' })) }, stateDigest: h('queue') };
  const documents = new Map<string, unknown>([['/fixture/runtime.json', runtime], [runtime.poolPath, pool], [runtime.bindingsPath, bindings],
    [plan.paths.profiles, config], [plan.paths.supervision, supervision], [plan.paths.successors, successor],
    ['/fixture/projects.json', { schemaVersion: 1, projects: [] }], ['/fixture/ledger/resource-console-state.json', {}]]);
  hooks.stat.mockImplementation(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  hooks.json.mockImplementation((path: string) => { if (!documents.has(path)) throw Error('Unexpected read'); return structuredClone(documents.get(path)); });
  const catalogRow = (id: string) => ({ id, graphRoot: '/fixture/graph-' + id, host: { root: '/fixture/universe-' + id,
    definition: { id: 'controller-' + id, tasks: [{ campaignId: 'campaign-' + id }] } } });
  hooks.registry.mockReturnValue({ registrations: () => structuredClone(registrations),
    committed: (row: Registration) => ({ catalog: { enrollments: [catalogRow(row.request.id)] } }) });
  hooks.setup.mockImplementation(() => ({ plan: structuredClone(plan), registry: hooks.registry(),
    entries: registrations.map(row => ({ registration: structuredClone(row),
      verified: { catalog: { enrollments: [catalogRow(row.request.id)] } },
      source: hooks.source(null, row.request.id, row.enrollmentDigest) })) }));
  hooks.prepared.mockImplementation(() => registrations.map(row => ({ summary: { id: row.request.id, enrollmentDigest: row.enrollmentDigest,
    campaigns: [{ id: 'campaign-' + row.request.id }] }, row: catalogRow(row.request.id) })));
  hooks.graph.mockImplementation((enrollment: { summary: { id: string; enrollmentDigest: string } }) => ({ enrollmentId: enrollment.summary.id, enrollmentDigest: enrollment.summary.enrollmentDigest, graphDigest: h(enrollment.summary.id) }));
  hooks.source.mockImplementation((_registry: unknown, id: string) => structuredClone(sources.get(id)));
  hooks.queue.mockImplementation(() => structuredClone(queue));
  hooks.preview.mockReturnValue({ bindings: [project], projects: [project] }); hooks.project.mockReturnValue(project);
  hooks.console.mockReturnValue({ schemaVersion: 1, paused: false, jobs: [] }); hooks.history.mockReturnValue([]);
  hooks.accounting.mockImplementation(() => ({ sourceState: 'healthy', attempts: structuredClone(attempts) }));
  hooks.journal.mockImplementation(() => ({ records: structuredClone(rows), recordsDigest: hash(rows) }));
  hooks.campaign.mockImplementation((id: string) => ({ definition: { id, universeId: id + '-universe' }, definitionDigest: h(id), steps: [] }));
  hooks.universe.mockReturnValue({ sourceState: 'healthy', runs: [] });
  hooks.outcomes.mockReturnValue({ sourceState: 'healthy', campaigns: [{ sourceState: 'healthy', reasons: [] }], usage: { attempts: 1, joinedAttempts: 1 } });
  const options = { setup: { recipe: {}, policy: {}, output: '/fixture/setup', resourceRuntime: '/fixture/runtime.json',
    workspace: '/fixture/project', projectsFile: '/fixture/projects.json' }, expectedPlanDigest: plan.planDigest, expectedDeadlineAt: deadline } as ResourceEngineeringPredecessorCheckOptions;
  return { options, plan, rows, attempts, registrations, sources, queue, add, link, runtime };
}
beforeEach(() => { vi.resetAllMocks(); });
const held = (options: ResourceEngineeringPredecessorCheckOptions, stage?: string) => {
  const result = checkResourceEngineeringPredecessor(options);
  expect(result).toMatchObject({ status: 'held', evidenceDigest: null, tip: null, continuation: null,
    executionAuthorized: false, effectsExecuted: false, providerContacted: false });
  if (stage) expect(result.reasons).toEqual([stage + '-evidence-unavailable']);
  expect(JSON.stringify(result)).not.toContain('/fixture'); return result;
};

describe('predecessor completion joins over mocked host evidence', () => {
  it('verifies a complete linked chain without turning historical expiry into execution permission', () => {
    const f = fixture(); const result = checkResourceEngineeringPredecessor(f.options);
    expect(result).toMatchObject({ status: 'verified', reasons: [], continuation: 'eligible', executionAuthorized: false,
      effectsExecuted: false, providerContacted: false, tip: { enrollmentId: 'child', enrollmentDigest: h('child'),
        projectId: 'default', commit: f.sources.get('child')!.commit } });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/); expect(hooks.setup).toHaveBeenCalledTimes(2);
    expect(hooks.seed).toHaveBeenCalledTimes(4); expect(hooks.capture).toHaveBeenCalledTimes(4); expect(hooks.builtin).toHaveBeenCalledTimes(4);
  });
  it('retains a verified stop outcome as stop-requested, not eligibility', () => {
    const f = fixture(); f.link('child');
    expect(checkResourceEngineeringPredecessor(f.options)).toMatchObject({ status: 'verified', continuation: 'stop-requested', tip: { enrollmentId: 'child' } });
  });
  it.each(['result', 'prepared', 'admitted'])('holds missing %s rather than silently dropping the intent', kind => {
    const f = fixture(); f.rows.splice(f.rows.findIndex(row => row.kind === kind), 1); held(f.options, 'successors');
  });
  it.each(['missing', 'status', 'task', 'pool', 'worker', 'receipt', 'output'])('holds proposal receipt mismatch %s', change => {
    const f = fixture(); const receipt = f.attempts[0]!;
    if (change === 'missing') f.attempts.length = 0;
    if (change === 'status') receipt.status = 'failed';
    if (change === 'task') receipt.taskDigest = h('foreign');
    if (change === 'pool') receipt.poolDigest = h('foreign');
    if (change === 'worker') receipt.workerId = 'foreign';
    // Keep the result's receipt hash consistent so each attribution/status
    // fence is exercised independently, not masked by the later hash check.
    if (['status', 'task', 'pool', 'worker'].includes(change)) f.rows.find(row => row.kind === 'result')!.receiptDigest = hash(receipt);
    if (change === 'receipt') f.rows.find(row => row.kind === 'result')!.receiptDigest = h('foreign');
    if (change === 'output') f.rows.find(row => row.kind === 'result')!.output = canonical({ action: 'stop' });
    held(f.options, 'successors');
  });
  it.each(['commit', 'objective', 'context', 'delivery'])('holds source %s drift', field => {
    const f = fixture(); const source = f.sources.get('initial')!;
    if (field === 'delivery') source.source.expectedDeliveryDigest = h('changed');
    else source[field as 'commit' | 'objective' | 'context'] = field === 'context' ? '{}' : 'changed';
    held(f.options, 'successors');
  });
  it('holds an orphan ordinary registration even when admitted and completed', () => {
    const f = fixture(); f.add('orphan'); f.queue.state.entries.push({ enrollmentId: 'orphan', enrollmentDigest: h('orphan'), attempts: 1, lastOutcome: 'settled' });
    held(f.options, 'lineage');
  });
  it('holds a disconnected successor cycle rather than selecting a delivered tip by timestamp', () => {
    const f = fixture(); f.rows.length = 0; f.attempts.length = 0; delete f.registrations[1]!.source;
    f.add('cycle'); f.link('child', 'cycle'); f.link('cycle', 'child');
    f.queue.state.entries.push({ enrollmentId: 'cycle', enrollmentDigest: h('cycle'), attempts: 1, lastOutcome: 'settled' });
    held(f.options, 'lineage');
  });
  it.each(['missing', 'digest', 'attempting', 'unavailable', 'zero-attempts'])('holds unadmitted or unsettled queue entry %s', mode => {
    const f = fixture(); const row = f.queue.state.entries[1]!;
    if (mode === 'missing') f.queue.state.entries.pop();
    if (mode === 'digest') row.enrollmentDigest = h('other');
    if (mode === 'attempting' || mode === 'unavailable') row.lastOutcome = mode;
    if (mode === 'zero-attempts') row.attempts = 0;
    held(f.options, 'queue');
  });
  it.each(['plan', 'deadline'])('requires the original expected %s', mode => {
    const f = fixture(); if (mode === 'plan') f.plan.planDigest = h('other'); else f.queue.state.deadlineAt = '2025-01-01T00:02:00.000Z';
    held(f.options, mode === 'plan' ? 'setup' : 'queue');
  });
  it.each(['.console-engineering.lock', '.control-execution.lock', '.control.lock', '.execution.lock', '.resource-console.lock',
    '.run.lock', '.pool.lock', '.resource-quota-refresh.lock', '.resource-quota-refresh-pending.json'])('holds present custody path %s', name => {
    const f = fixture(); hooks.stat.mockImplementation((path: string) => {
      if (path.endsWith('/' + name)) return {};
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }); held(f.options, 'custody');
  });
  it.each(['/fixture/ledger/engineering-supervision/queue/.execution.lock', '/fixture/ledger/engineering-successors/queue/.execution.lock'])(
  'holds the exact predecessor owner lock %s', target => {
    const f = fixture(); hooks.stat.mockImplementation((path: string) => {
      if (path === target) return {};
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }); held(f.options, 'custody');
  });
  it('treats an unreadable ownership path as uncertainty, not absence', () => {
    const f = fixture(); hooks.stat.mockImplementation(() => { throw Object.assign(new Error('private detail'), { code: 'EACCES' }); });
    held(f.options, 'custody');
  });
  it.each(['reserved', 'uncertain'])('holds shared ledger %s even if unrelated to this chain', status => {
    const f = fixture(); f.attempts.push({ ...f.attempts[0]!, id: 'unrelated', status }); held(f.options, 'custody');
  });
  it.each(['seed', 'capture', 'builtin'] as const)('holds unresolved %s evaluator custody', key => {
    const f = fixture(); hooks[key].mockImplementation(() => { throw Error('/private/raw-detail'); }); held(f.options, 'custody');
  });
  it.each(['graph', 'source'] as const)('holds absent verified %s proof', key => {
    const f = fixture(); hooks[key].mockReturnValue(null); held(f.options, 'completion');
  });
  it.each(['unavailable', 'missing-campaign', 'campaign-reason', 'unjoined'])('holds accounting outcome %s', mode => {
    const f = fixture(); const outcomes = { sourceState: 'healthy', campaigns: [{ sourceState: 'healthy', reasons: [] as string[] }], usage: { attempts: 1, joinedAttempts: 1 } };
    if (mode === 'unavailable') outcomes.sourceState = 'unavailable';
    if (mode === 'missing-campaign') outcomes.campaigns = [];
    if (mode === 'campaign-reason') outcomes.campaigns[0]!.reasons.push('missing-generation-receipt');
    if (mode === 'unjoined') outcomes.usage.joinedAttempts = 0;
    hooks.outcomes.mockReturnValue(outcomes); held(f.options, 'completion');
  });
  it('ignores only the changing observation timestamp in otherwise stable outcome evidence', () => {
    const f = fixture(); let sampledAt = 0;
    hooks.outcomes.mockImplementation(() => ({ sourceState: 'healthy', campaigns: [{ sourceState: 'healthy', reasons: [] }],
      usage: { attempts: 1, joinedAttempts: 1 }, sampledAt: new Date(++sampledAt).toISOString() }));
    expect(checkResourceEngineeringPredecessor(f.options).status).toBe('verified');
  });
  it.each(['orphan', 'ordinal', 'definition', 'generation'])('holds campaign-attributed run %s', mode => {
    const f = fixture();
    hooks.universe.mockImplementation((campaign: { definition: { id: string }; definitionDigest: string }) => ({ sourceState: 'healthy',
      runs: [{ id: 'run', generation: 1, campaign: { id: campaign.definition.id, ordinal: 1, definitionDigest: campaign.definitionDigest } }] }));
    hooks.campaign.mockImplementation((id: string) => ({ definition: { id, universeId: id + '-universe' }, definitionDigest: h(id), steps: mode === 'orphan' ? []
      : [{ runId: 'run', ordinal: mode === 'ordinal' ? 2 : 1, generation: mode === 'generation' ? 2 : 1 }] }));
    if (mode === 'definition') hooks.universe.mockImplementation((campaign: { definition: { id: string } }) => ({ sourceState: 'healthy',
      runs: [{ id: 'run', generation: 1, campaign: { id: campaign.definition.id, ordinal: 1, definitionDigest: h('other') } }] }));
    held(f.options, 'custody');
  });
  it.each(['name', 'objective', 'profileId'])('holds prepared child %s differing from fixed proposal/profile', field => {
    const f = fixture(); f.registrations[1]!.request[field as 'name' | 'objective' | 'profileId'] = 'changed'; held(f.options, 'successors');
  });
  it('refuses stop output accompanied by prepared/admitted work', () => {
    const f = fixture(); const result = f.rows.find(row => row.kind === 'result')!;
    result.output = canonical({ action: 'stop' }); f.attempts[0]!.outputDigest = digest(result.output); result.receiptDigest = hash(f.attempts[0]);
    held(f.options, 'successors');
  });
  it.each(['resource-work-unresolved', 'console-ownership-present', 'ordinary-queued-work-retained'])('holds setup condition %s', reason => {
    const f = fixture(); f.plan.holds.push(reason); held(f.options, 'setup');
  });
  it('does not erase historical completion because global KILL is currently active', () => {
    const f = fixture(); f.plan.holds.push('global-kill-active-or-unavailable');
    expect(checkResourceEngineeringPredecessor(f.options)).toMatchObject({ status: 'verified', executionAuthorized: false, effectsExecuted: false });
  });
  it('rejects changed second-read evidence even when both samples independently verify', () => {
    const f = fixture(); let calls = 0;
    hooks.queue.mockImplementation(() => ({ ...structuredClone(f.queue), stateDigest: h('sample-' + ++calls) }));
    held(f.options, 'stability'); expect(hooks.setup).toHaveBeenCalledTimes(2);
  });
  it('reconstructs delivered sources for the second sample rather than retaining the first projection', () => {
    const f = fixture(); let reads = 0;
    hooks.source.mockImplementation((_registry: unknown, id: string) => {
      const source = structuredClone(f.sources.get(id));
      if (++reads > f.registrations.length && id === 'initial') source!.commit = 'f'.repeat(40);
      return source;
    });
    held(f.options, 'successors'); expect(hooks.setup).toHaveBeenCalledTimes(2);
    expect(hooks.source).toHaveBeenCalledTimes(4);
  });
  it('rejects accessors before calling any host reader', () => {
    const f = fixture(); const getter = vi.fn(() => f.options.setup);
    const input = Object.defineProperty({ ...f.options }, 'setup', { enumerable: true, get: getter });
    held(input, 'inputs'); expect(getter).not.toHaveBeenCalled(); expect(hooks.setup).not.toHaveBeenCalled();
  });
  it('does not recognize JSON-shaped lock tokens as acquired host ownership', () => {
    const f = fixture();
    const result = checkResourceEngineeringPredecessor(f.options, [{ path: '/fixture/ledger/.pool.lock', token: 'forged', dev: 1n, ino: 2n }]);
    expect(result).toMatchObject({ status: 'held', reasons: ['inputs-evidence-unavailable'], executionAuthorized: false });
    expect(hooks.setup).not.toHaveBeenCalled();
  });
});
