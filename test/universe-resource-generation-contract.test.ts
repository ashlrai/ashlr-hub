/** Pure contracts only: no provider, filesystem workspace or native process. */
import { describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { generationResources, newGenerationReceipt, resourceGenerationTaskId, validateGenerationConfig,
  validGenerationReceipt, validGenerationUsage, validResourceGenerationEvidence } from '../src/core/universe/generation.js';
import { MAX_UNIVERSE_TRIAL_BYTES, preflightTrialEvidenceBudget, universeEvidenceBytes } from '../src/core/universe/evidence-size.js';
import type { UniverseGenerationReceipt, UniverseLocalGenerationConfig, UniverseResourceGenerationConfig,
  UniverseResourceGenerationEvidence, UniverseTrial } from '../src/core/universe/types.js';

const A = 'a'.repeat(64); const B = 'b'.repeat(64);
const IDENTITY = { universeId: 'universe', runId: 'run-one', variantId: 'variant-one' };
const TASK = resourceGenerationTaskId(IDENTITY);
function config(): UniverseResourceGenerationConfig {
  return { kind: 'resource-pool', poolId: 'fleet', poolDigest: A, allowedWorkerIds: ['codex-a'], files: ['main.ts'], maxOutputTokens: 512 };
}
function local(): UniverseLocalGenerationConfig {
  return { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['main.ts'], maxOutputTokens: 512 };
}
function settled(taskStatus: NonNullable<UniverseResourceGenerationEvidence['taskStatus']> = 'completed', reported = true): UniverseGenerationReceipt {
  const value = newGenerationReceipt(config());
  value.promptDigest = A;
  value.status = taskStatus === 'completed' ? 'succeeded' : taskStatus === 'timed-out' || taskStatus === 'cancelled' ? taskStatus : 'failed';
  value.responseDigest = taskStatus === 'completed' ? B : null;
  value.changedFiles = taskStatus === 'completed' ? ['main.ts'] : [];
  value.resource = { ...value.resource!, taskId: TASK, taskDigest: A, workerId: 'codex-a', workerProvider: 'codex', workerModel: 'fixture',
    receiptDigest: B, dispatch: 'settled', taskStatus, usageScope: reported ? 'codex-turn' : null };
  if (reported) value.usage = { state: 'reported', inputTokens: 10, outputTokens: 2 };
  return value;
}
function handoff(dispatch: 'withheld' | 'unavailable'): UniverseGenerationReceipt {
  const value = newGenerationReceipt(config()); value.promptDigest = A;
  value.resource = { ...value.resource!, dispatch, taskId: TASK }; return value;
}
function replay(taskStatus: NonNullable<UniverseResourceGenerationEvidence['taskStatus']> = 'completed'): UniverseGenerationReceipt {
  const value = settled(taskStatus, false); value.status = 'failed'; value.changedFiles = []; value.responseDigest = null;
  value.resource!.dispatch = 'replayed'; return value;
}
function localMeasured(): UniverseGenerationReceipt {
  return { ...newGenerationReceipt(local()), status: 'succeeded', requestStarted: true, promptDigest: A, responseDigest: B,
    usage: { state: 'reported', inputTokens: 3, outputTokens: 1 } };
}
function trial(generation: UniverseGenerationReceipt): UniverseTrial {
  return { id: 'trial', variantId: 'variant-one', niche: 'test', parentTrialId: null, status: 'failed', score: null,
    metrics: {}, artifact: null, durationMs: 0, delta: null, selected: false, generation };
}

describe('portable resource generation configuration', () => {
  it('preserves exact legacy local configuration, receipt and resource-total bytes', () => {
    const input = local(); expect(JSON.stringify(validateGenerationConfig(input))).toBe(JSON.stringify(input));
    expect(JSON.stringify(newGenerationReceipt(input))).toBe(JSON.stringify({ schemaVersion: 1, provider: 'local-openai-compatible',
      endpoint: input.endpoint, model: input.model, status: 'failed', requestStarted: false, promptDigest: null, responseDigest: null,
      durationMs: 0, usage: { state: 'unavailable', inputTokens: null, outputTokens: null }, changedFiles: [] }));
    expect(JSON.stringify(generationResources([trial(localMeasured())]))).toBe(JSON.stringify({ tokensUsed: 4, costUsd: null,
      generationUsage: { scope: 'model-generation', trials: 1, requestsStarted: 1, reportedRequests: 1, inputTokens: 3, outputTokens: 1 } }));
  });
  it('detaches the portable resource identity without accepting private runtime locators', () => {
    const input = { ...config(), fileOperations: { schemaVersion: 1 as const, contextFiles: ['context.ts'] } };
    const validated = validateGenerationConfig(input);
    expect(validated).toEqual(input);
    validated.files.push('extra.ts'); validated.fileOperations!.contextFiles.push('extra-context.ts');
    if (validated.kind === 'resource-pool') validated.allowedWorkerIds.push('other');
    expect(input.files).toEqual(['main.ts']); expect(input.allowedWorkerIds).toEqual(['codex-a']);
    expect(input.fileOperations.contextFiles).toEqual(['context.ts']);
  });
  it.each([
    { poolId: 'Invalid' }, { poolId: '../fleet' }, { poolDigest: 'A'.repeat(64) }, { poolDigest: 'a'.repeat(63) },
    { allowedWorkerIds: [] }, { allowedWorkerIds: ['codex-a', 'codex-a'] }, { allowedWorkerIds: ['worker id'] },
    { allowedWorkerIds: Array.from({ length: 33 }, (_, index) => `worker-${index}`) }, { allowedWorkerIds: new Array(1) },
    { files: [] }, { files: ['../main.ts'] }, { files: new Array(1) }, { maxOutputTokens: 0 }, { maxOutputTokens: 16_385 },
    { endpoint: 'http://127.0.0.1:11434' }, { model: 'private-model-selection' }, { resourceRuntime: '/private/config.json' },
    { accountHint: A }, { command: ['/private/codex'] }, { root: '/private/ledger' },
    { fileOperations: { schemaVersion: 1, contextFiles: ['main.ts'] } },
  ])('rejects malformed or expanded resource configuration %#', (patch) => {
    expect(() => validateGenerationConfig({ ...config(), ...patch })).toThrow(/Invalid Universe/);
  });
  it('rejects hidden properties and getters without reading them', () => {
    const getter = vi.fn(() => ['codex-a']); const input = config();
    Object.defineProperty(input, 'allowedWorkerIds', { enumerable: true, get: getter });
    expect(() => validateGenerationConfig(input)).toThrow(/Invalid Universe/); expect(getter).not.toHaveBeenCalled();
    const hidden = { ...config(), [Symbol('private')]: 'secret' };
    expect(() => validateGenerationConfig(hidden)).toThrow(/Invalid Universe/);
    const discriminator = config(); Object.defineProperty(discriminator, 'kind', { get: getter });
    expect(() => validateGenerationConfig(discriminator)).toThrow(/Invalid Universe/); expect(getter).not.toHaveBeenCalled();
  });
  it('uses a stable, public-scrubber-safe durable task identity', () => {
    const hash = digest(canonical(IDENTITY)); expect(TASK).toBe(`u-${hash.slice(0, 30)}-${hash.slice(30, 60)}`);
    expect(TASK).toHaveLength(63); expect(TASK).toMatch(/^u-[a-f0-9]{30}-[a-f0-9]{30}$/);
    expect(resourceGenerationTaskId({ variantId: 'variant-one', runId: 'run-one', universeId: 'universe' })).toBe(TASK);
    expect(resourceGenerationTaskId({ ...IDENTITY, runId: 'run-two' })).not.toBe(TASK);
    expect(resourceGenerationTaskId({ ...IDENTITY, variantId: 'variant-two' })).not.toBe(TASK);
    expect(() => resourceGenerationTaskId({ ...IDENTITY, runId: '../run' })).toThrow(/identity/);
    expect(() => resourceGenerationTaskId({ ...IDENTITY, extra: true } as typeof IDENTITY)).toThrow(/identity/);
  });
});

describe('resource generation receipt consistency', () => {
  it('starts without an inferred request, selected model, task or usage', () => {
    const receipt = newGenerationReceipt(config()); expect(validGenerationReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({ provider: 'resource-pool', endpoint: null, model: null, requestStarted: false,
      resource: { poolId: 'fleet', poolDigest: A, allowedWorkerIds: ['codex-a'], dispatch: 'not-started',
        taskId: null, taskDigest: null, workerId: null, workerProvider: null, workerModel: null, receiptDigest: null,
        taskStatus: null, usageScope: null }, usage: { state: 'unavailable', inputTokens: null, outputTokens: null } });
  });
  it.each(['completed', 'failed', 'timed-out', 'cancelled', 'uncertain'] as const)('accepts a measured settled %s invocation without inventing provider requests', (status) => {
    const receipt = settled(status); expect(validGenerationReceipt(receipt)).toBe(true); expect(receipt.requestStarted).toBe(false);
  });
  it.each(['codex', 'claude', 'local'] as const)('validates the selected %s usage semantics', (provider) => {
    const receipt = settled(); receipt.resource!.workerProvider = provider;
    receipt.resource!.usageScope = provider === 'codex' ? 'codex-turn' : provider === 'claude' ? 'claude-main-loop' : 'local-chat-completion';
    expect(validGenerationReceipt(receipt)).toBe(true);
  });
  it('allows completed response edits with unknown counters, without inventing zero usage', () => {
    expect(validGenerationReceipt(settled('completed', false))).toBe(true);
  });
  it.each(['withheld', 'unavailable'] as const)('records %s with only the planned task identity', (dispatch) => {
    expect(validGenerationReceipt(handoff(dispatch))).toBe(true);
  });
  it.each(['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'] as const)('retains %s replay identity without replayed output or usage', (status) => {
    expect(validGenerationReceipt(replay(status))).toBe(true);
  });
  it.each([
    { endpoint: 'http://127.0.0.1:11434' }, { model: 'fixture' }, { requestStarted: true },
    { resource: undefined }, { provider: 'local-openai-compatible' }, { promptDigest: null },
    { usage: { state: 'reported', inputTokens: 1, outputTokens: null } },
    { usage: { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } },
  ])('rejects contradictory resource receipt fields %#', (patch) => {
    expect(validGenerationReceipt({ ...settled(), ...patch })).toBe(false);
  });
  it.each([
    { taskId: null }, { taskDigest: null }, { workerId: null }, { workerProvider: null }, { workerModel: null }, { receiptDigest: null },
    { taskStatus: null }, { taskStatus: 'reserved' }, { workerId: 'outside' }, { workerProvider: 'xai' }, { workerModel: '\nsecret' },
    { workerModel: 'x'.repeat(161) }, { usageScope: 'claude-main-loop' }, { usageScope: null }, { taskDigest: 'a'.repeat(63) },
    { receiptDigest: 'B'.repeat(64) }, { accountHint: A }, { allowedWorkerIds: [] },
  ])('rejects incomplete, private or contradictory settled witnesses %#', (patch) => {
    const receipt = settled(); Object.assign(receipt.resource!, patch); expect(validGenerationReceipt(receipt)).toBe(false);
  });
  it('requires every resource witness field and rejects accessor metadata', () => {
    for (const key of Object.keys(settled().resource!)) {
      const resource = { ...settled().resource! }; delete (resource as unknown as Record<string, unknown>)[key];
      expect(validResourceGenerationEvidence(resource), key).toBe(false);
    }
    const resource = settled().resource!; const getter = vi.fn(() => 'codex-a');
    Object.defineProperty(resource, 'workerId', { get: getter });
    expect(validResourceGenerationEvidence(resource)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
  it.each([newGenerationReceipt(config()), handoff('withheld'), handoff('unavailable'), replay()])(
    'cannot promote a precontact, unavailable or replayed handoff %#', (receipt) => {
      expect(validGenerationReceipt({ ...receipt, status: 'succeeded', responseDigest: B })).toBe(false);
      expect(validGenerationReceipt({ ...receipt, usage: { state: 'reported', inputTokens: 0, outputTokens: 0 } })).toBe(false);
    });
  it('does not admit partial receipt identity on withholding or unavailable handoffs', () => {
    for (const dispatch of ['withheld', 'unavailable'] as const) {
      const receipt = handoff(dispatch); receipt.resource!.taskDigest = A; expect(validGenerationReceipt(receipt)).toBe(false);
    }
  });
  it('keeps file-operations evidence coupled to the shared context contract', () => {
    const receipt = settled(); receipt.fileOperations = { schemaVersion: 1, contextDigest: A,
      operations: [{ op: 'replace', path: 'main.ts', beforeDigest: A, afterDigest: B }] };
    expect(validGenerationReceipt(receipt)).toBe(true);
    receipt.fileOperations.contextDigest = null; expect(validGenerationReceipt(receipt)).toBe(false);
  });
});

describe('separate resource handoff accounting', () => {
  it('counts measured resource invocations without adding local request counts', () => {
    const result = generationResources([trial(settled())]);
    expect(result).toEqual({ tokensUsed: 12, costUsd: null, generationUsage: { scope: 'model-generation', trials: 1,
      requestsStarted: 0, reportedRequests: 0, resourceAttempts: 1, resourceReportedAttempts: 1, inputTokens: 10, outputTokens: 2 } });
    expect(validGenerationUsage(result.generationUsage)).toBe(true);
  });
  it.each([newGenerationReceipt(config()), handoff('withheld')])('does not invent spend for known precontact state %#', (receipt) => {
    const alone = generationResources([trial(receipt)]); expect(alone.tokensUsed).toBeNull();
    expect(alone.generationUsage).toMatchObject({ resourceAttempts: 0, resourceReportedAttempts: 0, inputTokens: null, outputTokens: null });
    const mixed = generationResources([trial(localMeasured()), trial(receipt)]);
    expect(mixed.tokensUsed).toBe(4); expect(validGenerationUsage(mixed.generationUsage)).toBe(true);
  });
  it.each([handoff('unavailable'), replay(), replay('reserved'), settled('uncertain'), settled('completed', false)])(
    'preserves incomplete totals for ambiguous, replayed or unmeasured resource state %#', (receipt) => {
      const result = generationResources([trial(localMeasured()), trial(receipt)]);
      expect(result.tokensUsed).toBeNull(); expect(result.generationUsage).toMatchObject({ requestsStarted: 1, reportedRequests: 1,
        resourceAttempts: 1, resourceReportedAttempts: 0, inputTokens: null, outputTokens: null });
      expect(validGenerationUsage(result.generationUsage)).toBe(true);
    });
  it('keeps failed measured attempts charged and incomplete recording unknown', () => {
    expect(generationResources([trial(settled('failed'))]).tokensUsed).toBe(12);
    expect(generationResources([trial(settled())], false).tokensUsed).toBeNull();
  });
  it('permits reported zero counters only with a real settled invocation', () => {
    const receipt = settled(); receipt.usage = { state: 'reported', inputTokens: 0, outputTokens: 0 };
    expect(validGenerationReceipt(receipt)).toBe(true); expect(generationResources([trial(receipt)]).tokensUsed).toBe(0);
  });
  it('withholds overflowing aggregate totals without corrupting attempt counts', () => {
    const receipt = settled(); receipt.usage = { state: 'reported', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 };
    const result = generationResources([trial(receipt), trial(localMeasured())]); expect(result.tokensUsed).toBeNull();
    expect(validGenerationUsage(result.generationUsage)).toBe(true);
  });
  it.each([
    { resourceAttempts: undefined }, { resourceReportedAttempts: undefined }, { resourceAttempts: -1 },
    { resourceReportedAttempts: 2 }, { requestsStarted: 1, reportedRequests: 1 },
    { resourceAttempts: 0, resourceReportedAttempts: 0 }, { resourceReportedAttempts: 0 }, { accountHint: A },
  ])('rejects malformed or fabricated complete aggregate evidence %#', (patch) => {
    const value = generationResources([trial(settled())]).generationUsage!;
    expect(validGenerationUsage({ ...value, ...patch })).toBe(false);
  });
});

describe('resource receipt capacity before contact', () => {
  it('reserves selected-worker identity and worst-case serialized model bytes, not just initial null fields', () => {
    const generation = newGenerationReceipt(config()); const value = trial(generation);
    const planned = { artifact: { path: '/artifact', digest: A, revision: 'revision' }, changedFiles: ['main.ts'] };
    expect(() => preflightTrialEvidenceBudget(value, planned)).not.toThrow();
    let largestAccepted = 0;
    for (let low = 0, high = MAX_UNIVERSE_TRIAL_BYTES; low <= high;) {
      const middle = Math.floor((low + high) / 2); value.niche = 'x'.repeat(middle);
      try { preflightTrialEvidenceBudget(value, planned); largestAccepted = middle; low = middle + 1; }
      catch { high = middle - 1; }
    }
    value.niche = 'x'.repeat(largestAccepted);
    const final = { ...value, artifact: planned.artifact, generation: settled() };
    final.generation.resource!.workerModel = '\ud800'.repeat(160);
    expect(universeEvidenceBytes(final)).toBeLessThan(MAX_UNIVERSE_TRIAL_BYTES);
    value.niche += 'x'; expect(() => preflightTrialEvidenceBudget(value, planned)).toThrow(/before execution/);
    expect(universeEvidenceBytes(value)).toBeLessThan(MAX_UNIVERSE_TRIAL_BYTES);
  });
});
