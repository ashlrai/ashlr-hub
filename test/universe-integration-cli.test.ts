import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UniverseIntegrationDefinition, UniverseIntegrationDeliveryReceipt, UniverseIntegrationDeliveryRequest,
  UniverseIntegrationEvaluationRequest, UniverseIntegrationEvaluationResult, UniverseIntegrationPlan,
} from '../src/core/universe/index.js';

const core = vi.hoisted(() => ({
  readUniverseIntegrationPlan: vi.fn(), readUniverseIntegrationEvaluation: vi.fn(),
  evaluateUniverseIntegration: vi.fn(), validateUniverseIntegrationEvaluationRequest: vi.fn(),
  validateUniverseIntegrationDeliveryRequest: vi.fn(), deliverUniverseIntegration: vi.fn(),
}));
const files = vi.hoisted(() => ({ readResourceJson: vi.fn() }));
vi.mock('../src/core/universe/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/universe/index.js')>(), ...core,
}));
vi.mock('../src/core/resources/pool-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/resources/pool-runtime.js')>(), readResourceJson: files.readResourceJson,
}));
import { cmdUniverseIntegration } from '../src/cli/universe-integration.js';

function definition(): UniverseIntegrationDefinition {
  return {
    schemaVersion: 1, id: 'combined',
    target: { repo: '/private/source-repo', baseCommit: 'a'.repeat(40), allowedPaths: ['src/one.ts', 'src/two.ts'] },
    sources: [
      { universeId: 'one', deliveryId: '1'.repeat(64), commit: 'b'.repeat(40), tree: 'c'.repeat(40) },
      { universeId: 'two', deliveryId: '2'.repeat(64), commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
    ],
  };
}

function plan(overrides: Partial<UniverseIntegrationPlan> = {}): UniverseIntegrationPlan {
  const value = definition();
  return {
    schemaVersion: 1, scope: 'same-repository-pinned-base-overlay', authority: 'observation-only', definition: value,
    sourceState: 'healthy', reasons: [],
    sources: value.sources.map((source, index) => ({ ...source, receiptDigest: `${index + 1}`.repeat(64), state: 'verified' as const, changedPathCount: 1 })),
    entries: [{ path: 'src/one.ts', oid: 'f'.repeat(40), executable: false, sourceDeliveryIds: [value.sources[0]!.deliveryId] }],
    conflicts: [], compositionDigest: '9'.repeat(64), compositionReady: true,
    ...overrides,
  };
}

function evaluationRequest(): UniverseIntegrationEvaluationRequest {
  return {
    schemaVersion: 1, id: 'evaluation', integration: definition(), expectedCompositionDigest: '9'.repeat(64),
    acceptance: { universeId: 'target', manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64) }, maxDurationMs: 10_000,
  };
}

function evaluation(overrides: Partial<UniverseIntegrationEvaluationResult> = {}): UniverseIntegrationEvaluationResult {
  return {
    schemaVersion: 1, id: 'evaluation', requestDigest: 'c'.repeat(64), status: 'passed',
    startedAt: '2026-09-09T00:00:00.000Z', finishedAt: '2026-09-09T00:00:00.012Z', durationMs: 12,
    acceptance: evaluationRequest().acceptance, compositionDigest: '9'.repeat(64), artifactDigest: 'd'.repeat(64),
    artifactPath: '/private/universe/evaluations/evaluation/artifact', score: 4, metrics: { cases: 2 }, reason: null,
    ...overrides,
  };
}

function inspection(): { request: UniverseIntegrationEvaluationRequest; result: UniverseIntegrationEvaluationResult; resultDigest: string } {
  return { request: evaluationRequest(), result: evaluation(), resultDigest: 'e'.repeat(64) };
}

function deliveryRequest(): UniverseIntegrationDeliveryRequest {
  return { schemaVersion: 1, evaluation: evaluationRequest(), expectedEvaluationDigest: 'f'.repeat(64),
    branch: 'codex/combined-result', maxDurationMs: 10_000 };
}

function delivery(overrides: Partial<UniverseIntegrationDeliveryReceipt> = {}): UniverseIntegrationDeliveryReceipt {
  return {
    schemaVersion: 1, id: '1'.repeat(64), requestDigest: '2'.repeat(64), evaluationRequestDigest: '3'.repeat(64),
    evaluationResultDigest: '4'.repeat(64), universeId: 'target', evaluationId: 'evaluation', manifestDigest: '5'.repeat(64),
    comparatorDigest: '6'.repeat(64), compositionDigest: '7'.repeat(64), artifactDigest: '8'.repeat(64),
    repo: '/private/source-repo', branch: 'codex/combined-result', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40),
    tree: 'c'.repeat(40), changedFiles: ['src/one.ts'], status: 'delivered',
    createdAt: '2026-09-09T00:00:00.000Z', completedAt: '2026-09-09T00:00:00.012Z', ...overrides,
  };
}

describe('Universe integration CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  const manifest = '/private/integration.json';
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    files.readResourceJson.mockReturnValue(definition());
    core.readUniverseIntegrationPlan.mockReturnValue(plan());
    core.readUniverseIntegrationEvaluation.mockReturnValue(inspection());
    core.validateUniverseIntegrationEvaluationRequest.mockImplementation((value: unknown) => value as UniverseIntegrationEvaluationRequest);
    core.evaluateUniverseIntegration.mockResolvedValue(evaluation());
    core.validateUniverseIntegrationDeliveryRequest.mockImplementation((value: unknown) => value as UniverseIntegrationDeliveryRequest);
    core.deliverUniverseIntegration.mockResolvedValue(delivery());
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [], ['unknown'], ['plan'], ['evaluate'], ['inspect'], ['deliver'], ['plan', 'extra'], ['evaluate', 'extra'], ['inspect', 'extra'], ['deliver', 'extra'],
    ['plan', '--manifest'], ['evaluate', '--manifest'], ['inspect', '--manifest'], ['deliver', '--manifest'], ['plan', '--manifest', 'relative.json'],
    ['plan', '--manifest', '/'], ['plan', '--manifest', '/private/one/../two'], ['plan', '--manifest=private.json'],
    ['plan', '--manifest', manifest, '--manifest', '/private/other.json'], ['plan', '--manifest', manifest, '--json', '--json'],
    ['plan', '--manifest', manifest, '--root'], ['plan', '--manifest', manifest, '--root', 'relative'],
    ['plan', '--manifest', manifest, '--root', '/private/store/'], ['plan', '--manifest', manifest, '--root', '/', '--json'],
    ['plan', '--manifest', manifest, '--branch', 'codex/fix'], ['evaluate', '--manifest', manifest, '--branch', 'codex/fix'],
    ['inspect', '--manifest', manifest, '--branch', 'codex/fix'], ['deliver', '--manifest', manifest, '--branch', 'main'],
    ['plan', '--manifest', manifest, '--unknown'], ['plan', '--manifest', '/private/a\n.json'], ['plan', '--manifest', '/private/a\u0085.json'],
  ])('rejects invalid invocation before reading or planning %j', async (...args) => {
    expect(await cmdUniverseIntegration([...args, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationEvaluation).not.toHaveBeenCalled();
    expect(core.deliverUniverseIntegration).not.toHaveBeenCalled();
  });

  it('rejects malformed manifests as usage errors without invoking the planner', async () => {
    files.readResourceJson.mockReturnValue({ schemaVersion: 1, id: 'bad' });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration manifest is invalid or unavailable' });
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationEvaluation).not.toHaveBeenCalled();
    expect(core.deliverUniverseIntegration).not.toHaveBeenCalled();
  });

  it('reads exactly one bounded private manifest and forwards the selected root', async () => {
    const value = definition();
    files.readResourceJson.mockReturnValue(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--root', '/private/store', '--json'])).toBe(0);
    expect(files.readResourceJson).toHaveBeenCalledExactlyOnceWith(manifest, 256 * 1024);
    expect(core.readUniverseIntegrationPlan).toHaveBeenCalledExactlyOnceWith(value, { root: '/private/store' });
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationEvaluation).not.toHaveBeenCalled();
    expect(core.deliverUniverseIntegration).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
  });

  it('preserves the exact planner DTO in JSON and labels text as structural only', async () => {
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(plan());
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[1]![0] as string;
    expect(text).toContain('Scope: same-repository-pinned-base-overlay · authority: observation-only');
    expect(text).toContain('Composition: ready · digest');
    expect(text).toContain('Sources: 2');
    expect(text).toContain('one · verified · delivery');
    expect(text).toContain('Entries: 1 deterministic overlay entries');
    expect(text).toContain('src/one.ts ·');
    expect(text).toContain('Composition digest is a recipe identity only');
    expect(text).toContain('No Git tree, ref, artifact, delivery, evaluator, provider, or deployment action was performed');
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
  });

  it('validates and forwards an explicit evaluation request, preserving the exact result JSON', async () => {
    const request = evaluationRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationEvaluationRequest.mockReturnValue(request);
    const result = evaluation();
    core.evaluateUniverseIntegration.mockResolvedValue(result);
    expect(await cmdUniverseIntegration(['evaluate', '--manifest', manifest, '--root', '/private/store', '--json'])).toBe(0);
    expect(files.readResourceJson).toHaveBeenCalledExactlyOnceWith(manifest, 256 * 1024);
    expect(core.validateUniverseIntegrationEvaluationRequest).toHaveBeenCalledExactlyOnceWith(request);
    expect(core.evaluateUniverseIntegration).toHaveBeenCalledExactlyOnceWith(request, {
      root: '/private/store', signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
  });

  it('inspects a prior evaluation as exact read-only evidence and never evaluates', async () => {
    const request = evaluationRequest();
    const result = inspection();
    files.readResourceJson.mockReturnValue(request);
    core.readUniverseIntegrationEvaluation.mockReturnValue(result);
    expect(await cmdUniverseIntegration(['inspect', '--manifest', manifest, '--root', '/private/store', '--json'])).toBe(0);
    expect(files.readResourceJson).toHaveBeenCalledExactlyOnceWith(manifest, 256 * 1024);
    expect(core.readUniverseIntegrationEvaluation).toHaveBeenCalledExactlyOnceWith(request, { root: '/private/store' });
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
    expect(core.deliverUniverseIntegration).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result);
  });

  it('renders inspect as prior fixed-evaluator evidence without execution authorization', async () => {
    files.readResourceJson.mockReturnValue(evaluationRequest());
    core.readUniverseIntegrationEvaluation.mockReturnValue(inspection());
    expect(await cmdUniverseIntegration(['inspect', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('integration evaluation inspection · passed');
    expect(text).toContain('Result digest:');
    expect(text).toContain('Read-only prior fixed-evaluator evidence');
    expect(text).toContain('not acceptance or production authorization');
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
  });

  it('returns unavailable for missing inspection evidence without evaluating', async () => {
    core.readUniverseIntegrationEvaluation.mockImplementation(() => { throw new Error('private missing evidence'); });
    expect(await cmdUniverseIntegration(['inspect', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration evaluation evidence unavailable' });
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
  });

  it('validates and forwards delivery requests with the selected branch and root', async () => {
    const request = deliveryRequest();
    const receipt = delivery();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    core.deliverUniverseIntegration.mockResolvedValue(receipt);
    expect(await cmdUniverseIntegration(['deliver', '--manifest', manifest, '--root', '/private/store', '--json'])).toBe(0);
    expect(files.readResourceJson).toHaveBeenCalledExactlyOnceWith(manifest, 256 * 1024);
    expect(core.validateUniverseIntegrationDeliveryRequest).toHaveBeenCalledExactlyOnceWith(request);
    expect(core.deliverUniverseIntegration).toHaveBeenCalledExactlyOnceWith(request, {
      root: '/private/store', signal: expect.any(AbortSignal),
    });
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(receipt);
  });

  it.each([
    ['delivered', 0], ['unchanged', 0], ['pending', 1],
  ] as const)('maps %s delivery receipts to exit status %i', async (status, exitCode) => {
    const request = deliveryRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    core.deliverUniverseIntegration.mockResolvedValue(delivery({ status, ...(status === 'pending' ? { completedAt: null } : {}) }));
    expect(await cmdUniverseIntegration(['deliver', '--manifest', manifest, '--json'])).toBe(exitCode);
  });

  it('labels local delivery and warns that interruption does not establish branch absence', async () => {
    const request = deliveryRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    core.deliverUniverseIntegration.mockResolvedValue(delivery());
    expect(await cmdUniverseIntegration(['deliver', '--manifest', manifest])).toBe(0);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('Local branch delivered. Checkout, index, and HEAD were not changed.');
    expect(text).toContain('No evaluator or provider rerun occurred');
    expect(text).toContain('interruption does not prove that a branch was not published');
    expect(text).not.toContain('accepted as a production change');
  });

  it('awaits interrupted delivery settlement and cleans up signal handlers', async () => {
    const request = deliveryRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    const before = process.listenerCount('SIGINT');
    let settle!: (receipt: UniverseIntegrationDeliveryReceipt) => void;
    let observedAbort = false;
    let listenersDuringDelivery = 0;
    core.deliverUniverseIntegration.mockImplementation(async (_request: UniverseIntegrationDeliveryRequest, options: { signal: AbortSignal }) => {
      const pending = new Promise<UniverseIntegrationDeliveryReceipt>((resolve) => { settle = resolve; });
      listenersDuringDelivery = process.listenerCount('SIGINT');
      process.emit('SIGINT');
      observedAbort = options.signal.aborted;
      return pending;
    });
    const pending = cmdUniverseIntegration(['deliver', '--manifest', manifest, '--json']);
    await vi.waitFor(() => expect(observedAbort).toBe(true));
    expect(listenersDuringDelivery).toBe(before + 1);
    settle(delivery({ status: 'pending', completedAt: null }));
    expect(await pending).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('returns cancellation separately when delivery does not settle', async () => {
    const request = deliveryRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    core.deliverUniverseIntegration.mockImplementation(async () => {
      process.emit('SIGINT');
      throw new Error('private cancellation after ref publication');
    });
    expect(await cmdUniverseIntegration(['deliver', '--manifest', manifest, '--json'])).toBe(130);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration delivery cancelled; inspect the receipt and Git ref' });
  });

  it('rejects malformed delivery requests before installing signal handlers', async () => {
    files.readResourceJson.mockReturnValue({ schemaVersion: 1, id: 'bad' });
    core.validateUniverseIntegrationDeliveryRequest.mockImplementation(() => { throw new Error('invalid'); });
    const before = process.listenerCount('SIGINT');
    expect(await cmdUniverseIntegration(['deliver', '--manifest', manifest, '--json'])).toBe(2);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(core.deliverUniverseIntegration).not.toHaveBeenCalled();
  });

  it('renders evaluator status and explicit private-evidence boundaries without raw evaluator output', async () => {
    const request = evaluationRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationEvaluationRequest.mockReturnValue(request);
    core.evaluateUniverseIntegration.mockResolvedValue(evaluation({ status: 'rejected', score: 0, reason: 'fixed-evaluator-rejected' }));
    expect(await cmdUniverseIntegration(['evaluate', '--manifest', manifest])).toBe(1);
    const text = output.mock.calls[0]![0] as string;
    expect(text).toContain('integration evaluation · rejected');
    expect(text).toContain('Local fixed-evaluator execution only');
    expect(text).toContain('frozen artifact and result are private evidence');
    expect(text).toContain('No model generation, provider, scheduler, branch, Git ref/publication, delivery, or automatic retry occurred');
    expect(text).not.toContain('PRIVATE_EVALUATOR_STDOUT');
  });

  it.each(['failed', 'timed-out'] as const)('returns generic failure status for %s evaluator results', async (status) => {
    const request = evaluationRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationEvaluationRequest.mockReturnValue(request);
    core.evaluateUniverseIntegration.mockResolvedValue(evaluation({ status, artifactPath: null, artifactDigest: null, score: null, metrics: {}, reason: status === 'failed' ? 'evaluator-failed' : 'evaluation-timed-out' }));
    expect(await cmdUniverseIntegration(['evaluate', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string).status).toBe(status);
  });

  it('does not install signal handlers or evaluate malformed requests', async () => {
    files.readResourceJson.mockReturnValue({ schemaVersion: 1, id: 'bad' });
    core.validateUniverseIntegrationEvaluationRequest.mockImplementation(() => { throw new Error('invalid'); });
    const before = process.listenerCount('SIGINT');
    expect(await cmdUniverseIntegration(['evaluate', '--manifest', manifest, '--json'])).toBe(2);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(core.validateUniverseIntegrationEvaluationRequest).toHaveBeenCalledOnce();
    expect(core.evaluateUniverseIntegration).not.toHaveBeenCalled();
  });

  it('awaits cancellation settlement, returns 130, and removes signal listeners afterward', async () => {
    const request = evaluationRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationEvaluationRequest.mockReturnValue(request);
    const before = process.listenerCount('SIGINT');
    let resolveEvaluation!: (result: UniverseIntegrationEvaluationResult) => void;
    let observedAbort = false;
    let listenersDuringEvaluation = 0;
    core.evaluateUniverseIntegration.mockImplementation(async (_request: UniverseIntegrationEvaluationRequest, options: { signal: AbortSignal }) => {
      const pending = new Promise<UniverseIntegrationEvaluationResult>((resolve) => { resolveEvaluation = resolve; });
      listenersDuringEvaluation = process.listenerCount('SIGINT');
      process.emit('SIGINT');
      observedAbort = options.signal.aborted;
      return pending;
    });
    const pending = cmdUniverseIntegration(['evaluate', '--manifest', manifest, '--json']);
    await vi.waitFor(() => expect(observedAbort).toBe(true));
    expect(observedAbort).toBe(true);
    expect(listenersDuringEvaluation).toBe(before + 1);
    resolveEvaluation(evaluation({ status: 'cancelled', artifactPath: null, artifactDigest: null, score: null, metrics: {}, reason: 'evaluation-cancelled' }));
    expect(await pending).toBe(130);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('returns incomplete for unavailable or conflicting composition evidence', async () => {
    const value = plan({ sourceState: 'healthy', compositionReady: false, compositionDigest: null,
      reasons: ['composition-conflicts'], conflicts: [{ code: 'path-conflict', paths: ['src/one.ts'], sourceDeliveryIds: ['1'.repeat(64), '2'.repeat(64)] }] });
    core.readUniverseIntegrationPlan.mockReturnValue(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(value);
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(1);
    expect(output.mock.calls[1]![0]).toContain('Composition: blocked');
    expect(output.mock.calls[1]![0]).toContain('digest unavailable');
    expect(output.mock.calls[1]![0]).toContain('Conflict: path-conflict · src/one.ts');
  });

  it('redacts planner failures and keeps the invalid manifest path out of output', async () => {
    core.readUniverseIntegrationPlan.mockImplementation(() => { throw new Error(`EACCES ${manifest}`); });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration plan unavailable' });
    expect(output.mock.calls[0]![0]).not.toContain(manifest);
    expect(files.readResourceJson).toHaveBeenCalledOnce();
  });

  it('redacts evaluator failures and keeps private paths out of output', async () => {
    const request = evaluationRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationEvaluationRequest.mockReturnValue(request);
    core.evaluateUniverseIntegration.mockRejectedValue(new Error(`EACCES ${manifest}`));
    expect(await cmdUniverseIntegration(['evaluate', '--manifest', manifest, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ error: 'Integration evaluation unavailable' });
    expect(output.mock.calls[0]![0]).not.toContain(manifest);
  });

  it('routes integration planning through the Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    expect(await cmdUniverse(['integration', 'plan', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.readUniverseIntegrationPlan).toHaveBeenCalledOnce();
  });

  it('routes inspection and delivery through the Universe dispatcher', async () => {
    const { cmdUniverse } = await import('../src/cli/universe.js');
    files.readResourceJson.mockReturnValue(evaluationRequest());
    core.readUniverseIntegrationEvaluation.mockReturnValue(inspection());
    expect(await cmdUniverse(['integration', 'inspect', '--manifest', manifest, '--json'])).toBe(0);
    const request = deliveryRequest();
    files.readResourceJson.mockReturnValue(request);
    core.validateUniverseIntegrationDeliveryRequest.mockReturnValue(request);
    expect(await cmdUniverse(['integration', 'deliver', '--manifest', manifest, '--json'])).toBe(0);
    expect(core.readUniverseIntegrationEvaluation).toHaveBeenCalledOnce();
    expect(core.deliverUniverseIntegration).toHaveBeenCalledOnce();
  });

  it('prints help without reading the manifest', async () => {
    expect(await cmdUniverseIntegration(['--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('combined-artifact composition plan');
    expect(output.mock.calls[0]![0]).toContain('inspect');
    expect(output.mock.calls[0]![0]).toContain('deliver');
    expect(files.readResourceJson).not.toHaveBeenCalled();
    expect(core.readUniverseIntegrationPlan).not.toHaveBeenCalled();
  });

  it.each(['bash', 'zsh'])('includes integration in %s completions', async (shell) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdCompletions } = await import('../src/cli/completions.js');
    expect(await cmdCompletions([shell])).toBe(0);
    expect(stdout.mock.calls.map(([value]) => value).join('')).toMatch(/universe\).*integration/);
  });

  it('reports non-JSON planner errors on stderr without leaking private paths', async () => {
    core.readUniverseIntegrationPlan.mockImplementation(() => { throw new Error('source unavailable'); });
    expect(await cmdUniverseIntegration(['plan', '--manifest', manifest])).toBe(1);
    expect(errors).toHaveBeenCalledWith('universe integration: Integration plan unavailable');
    expect(errors.mock.calls[0]![0]).not.toContain(manifest);
  });
});
