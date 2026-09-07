import { describe, expect, it } from 'vitest';
import { MAX_RESOURCE_OBSERVATION_AGE_MS, planResourceAssignment, validateResourceObservations, validateResourcePool,
  type ResourceAssignmentInput, type ResourceObservation, type ResourcePool, type ResourceWorker,
} from '../src/core/resources/pool-policy.js';

const nowMs = Date.parse('2026-09-07T12:00:00.000Z');
const at = (delta: number) => new Date(nowMs + delta).toISOString();
function worker(id = 'codex-a', patch: Partial<ResourceWorker> = {}): ResourceWorker {
  return { id, provider: 'codex', model: 'fixture-model', maxConcurrent: 2, reservePercent: 20,
    maxTasksPerWindow: 10, taskWindowMs: 60_000, priority: 0, ...patch };
}
function pool(workers = [worker()]): ResourcePool { return { schemaVersion: 1, id: 'resource-pool', workers }; }
function observation(workerId = 'codex-a', patch: Partial<ResourceObservation> = {}): ResourceObservation {
  return { workerId, observedAt: at(-1_000), expiresAt: at(59_000), health: 'ready',
    windows: [{ id: 'five_hour', usedPercent: 25, resetsAt: at(3_600_000) }], retryAfter: null, ...patch };
}
function input(patch: Partial<ResourceAssignmentInput> = {}): ResourceAssignmentInput {
  return { pool: pool(), observations: [observation()], allowedWorkerIds: ['codex-a'], activeCounts: {}, taskReservationCounts: {}, nowMs, ...patch };
}
const reason = (value: ResourceAssignmentInput) => planResourceAssignment(value).exclusions[0]?.reasons ?? [];

describe('strict independent resource pool policy schema', () => {
  it('returns detached deeply immutable configuration and observations', () => {
    const definition = pool(); const source = [observation()];
    const result = validateResourcePool(definition); const observed = validateResourceObservations(source, result);
    expect(result).toEqual(definition); expect(observed).toEqual(source);
    definition.workers[0]!.model = 'changed'; source[0]!.windows[0]!.usedPercent = 99;
    expect(result.workers[0]!.model).toBe('fixture-model'); expect(observed[0]!.windows[0]!.usedPercent).toBe(25);
    expect(Object.isFrozen(result.workers[0])).toBe(true); expect(Object.isFrozen(observed[0]!.windows)).toBe(true);
  });

  it('accepts all supported provider types, fractional percentages and maximum configured bounds', () => {
    const definition = pool(Array.from({ length: 32 }, (_, index) => worker(`w-${index}`, {
      provider: (['codex', 'claude', 'local'] as const)[index % 3]!, maxConcurrent: 16, reservePercent: 98.5,
      maxTasksPerWindow: 10_000, taskWindowMs: 604_800_000, priority: 100, allowUnknownQuota: false,
    })));
    expect(validateResourcePool(definition).workers).toHaveLength(32);
  });

  it.each([
    { schemaVersion: 2 }, { id: '' }, { id: '../outside' }, { id: 'UPPER' }, { id: 'x'.repeat(65) },
    { workers: [] }, { workers: new Array(1) }, { workers: Array.from({ length: 33 }, (_, index) => worker(`w-${index}`)) },
    { workers: [worker(), worker()] }, { credential: 'not-part-of-policy' },
  ])('rejects malformed pool fields %#', (patch) => {
    expect(() => validateResourcePool({ ...pool(), ...patch })).toThrow('Invalid resource pool');
  });

  it.each([
    { id: '__proto__' }, { provider: 'api' }, { provider: { toString: () => 'codex' } }, { model: '' }, { model: 'x\n' },
    { model: 'x'.repeat(161) }, { maxConcurrent: 0 }, { maxConcurrent: 17 }, { maxConcurrent: 1.1 },
    { reservePercent: -1 }, { reservePercent: 100 }, { reservePercent: NaN }, { reservePercent: Infinity },
    { maxTasksPerWindow: 0 }, { maxTasksPerWindow: 10_001 }, { maxTasksPerWindow: 1.1 },
    { taskWindowMs: 999 }, { taskWindowMs: 604_800_001 }, { taskWindowMs: Infinity },
    { priority: -1 }, { priority: 101 }, { priority: 0.1 }, { allowUnknownQuota: 'true' },
    { runtimeLocator: '/private/not-accepted' },
  ])('rejects malformed worker configuration %#', (patch) => {
    expect(() => validateResourcePool(pool([{ ...worker(), ...patch } as ResourceWorker]))).toThrow('Invalid resource pool');
  });

  it('rejects hidden keys, accessors and inherited object schemas without evaluating getters', () => {
    const accessor = pool(); let called = false;
    Object.defineProperty(accessor.workers[0], 'model', { enumerable: true, get: () => { called = true; return 'model'; } });
    expect(() => validateResourcePool(accessor)).toThrow(); expect(called).toBe(false);
    expect(() => validateResourcePool({ ...pool(), [Symbol('extra')]: true })).toThrow();
    expect(() => validateResourcePool(Object.assign(Object.create({ inherited: true }), pool()))).toThrow();
  });

  it('accepts explicit unknown quota and the exact five-minute observation TTL ceiling', () => {
    const value = observation('codex-a', { observedAt: at(0), expiresAt: at(MAX_RESOURCE_OBSERVATION_AGE_MS),
      windows: [{ id: 'weekly', usedPercent: null, resetsAt: null }] });
    expect(validateResourceObservations([value], pool())).toEqual([value]);
    expect(validateResourceObservations([], pool())).toEqual([]);
  });

  it('retains latest partial update separately from oldest window freshness and leaves legacy bytes unchanged', () => {
    const legacy = observation(); expect(validateResourceObservations([legacy], pool())[0]).not.toHaveProperty('updatedAt');
    const partial = observation('codex-a', { observedAt: at(-60_000), expiresAt: at(0), updatedAt: at(0) });
    const validated = validateResourceObservations([partial], pool());
    expect(validated[0]).toEqual(partial); expect(validated[0]).not.toBe(partial);
    expect(reason(input({ observations: validated }))).toContain('observation-stale');
  });

  it.each(['bad', '2026-02-30T00:00:00.000Z', at(-1_001), 123])('rejects invalid/backdated partial updatedAt=%j', (updatedAt) => {
    expect(() => validateResourceObservations([{ ...observation(), updatedAt }], pool())).toThrow('Invalid resource observations');
  });

  it.each([
    { workerId: 'orphan' }, { observedAt: '2026-02-30T00:00:00.000Z' }, { observedAt: '2026-09-07T12:00:00Z' },
    { expiresAt: at(-1_000) }, { expiresAt: at(MAX_RESOURCE_OBSERVATION_AGE_MS) }, { health: 'unknown' },
    { health: { toString: () => 'ready' } }, { retryAfter: 'tomorrow' }, { windows: new Array(1) },
    { windows: Array.from({ length: 9 }, (_, index) => ({ id: `w-${index}`, usedPercent: 0, resetsAt: at(1_000) })) },
    { windows: [{ id: 'weekly', usedPercent: 1, resetsAt: at(1_000) }, { id: 'weekly', usedPercent: 2, resetsAt: at(2_000) }] },
    { windows: [{ id: 'weekly', usedPercent: Infinity, resetsAt: at(1_000) }] },
    { windows: [{ id: 'weekly', usedPercent: -1, resetsAt: at(1_000) }] },
    { windows: [{ id: 'weekly', usedPercent: 101, resetsAt: at(1_000) }] },
    { windows: [{ id: 'weekly', usedPercent: 0, resetsAt: 'bad' }] },
    { windows: [{ id: 'weekly', usedPercent: 0, resetsAt: null, secret: true }] },
    { privatePath: 'not-accepted' },
  ])('rejects malformed observation schemas %#', (patch) => {
    expect(() => validateResourceObservations([{ ...observation(), ...patch }], pool())).toThrow('Invalid resource observations');
  });

  it('rejects duplicate observations and orphan count/allowlist references', () => {
    expect(() => validateResourceObservations([observation(), observation()], pool())).toThrow();
    for (const patch of [{ allowedWorkerIds: ['codex-a', 'codex-a'] }, { allowedWorkerIds: ['orphan'] },
      { activeCounts: { orphan: 1 } }, { taskReservationCounts: { orphan: { count: 1, nextEligibleAt: null } } }]) {
      expect(() => planResourceAssignment(input(patch))).toThrow('Invalid resource assignment');
    }
  });

  it.each([
    { nowMs: NaN }, { nowMs: Infinity }, { nowMs: -1 }, { nowMs: nowMs + 0.1 },
    { activeCounts: { 'codex-a': NaN } }, { activeCounts: { 'codex-a': -1 } }, { activeCounts: { 'codex-a': 1.5 } },
    { taskReservationCounts: { 'codex-a': { count: -1, nextEligibleAt: null } } },
    { taskReservationCounts: { 'codex-a': { count: 1, nextEligibleAt: 'bad' } } },
    { taskReservationCounts: { 'codex-a': { count: Number.MAX_SAFE_INTEGER + 1, nextEligibleAt: null } } },
  ])('rejects invalid accounting/time snapshots %#', (patch) => {
    expect(() => planResourceAssignment(input(patch))).toThrow('Invalid resource assignment');
  });
});

describe('multi-account resource admission and deterministic pressure ranking', () => {
  it('intersects every quota window and uses the highest observed utilization', () => {
    const value = input({ observations: [observation('codex-a', { windows: [
      { id: 'five_hour', usedPercent: 10, resetsAt: at(1_000) }, { id: 'weekly', usedPercent: 60, resetsAt: at(50_000) },
      { id: 'model', usedPercent: 30, resetsAt: at(100_000) },
    ] })] });
    const plan = planResourceAssignment(value);
    expect(plan.selectedWorkerId).toBe('codex-a');
    expect(plan.candidates[0]).toMatchObject({ usedPercent: 60, pressure: 0.75, reason: 'eligible' });
    value.observations[0]!.windows[1]!.usedPercent = 80;
    expect(reason(value)).toContain('quota-reserve-reached');
  });

  it('enforces the reserve boundary exactly without rounding up spare capacity', () => {
    const value = input(); value.observations[0]!.windows[0]!.usedPercent = 79.999;
    expect(planResourceAssignment(value).selectedWorkerId).toBe('codex-a');
    value.observations[0]!.windows[0]!.usedPercent = 80;
    expect(planResourceAssignment(value).selectedWorkerId).toBeNull();
  });

  it.each([
    [[], 'observation-missing'],
    [[observation('codex-a', { windows: [] })], 'quota-windows-missing'],
    [[observation('codex-a', { windows: [{ id: 'weekly', usedPercent: null, resetsAt: at(1_000) }] })], 'quota-window-unknown'],
    [[observation('codex-a', { windows: [{ id: 'weekly', usedPercent: 0, resetsAt: null }] })], 'quota-window-unknown'],
    [[observation('codex-a', { observedAt: at(-60_000), expiresAt: at(0) })], 'observation-stale'],
    [[observation('codex-a', { windows: [{ id: 'weekly', usedPercent: 0, resetsAt: at(0) }] })], 'quota-window-reset-passed'],
  ] as const)('withholds unknown provider capacity by default %#', (observations, expected) => {
    const value = input({ observations: structuredClone(observations) as ResourceObservation[] });
    const plan = planResourceAssignment(value);
    expect(plan.selectedWorkerId).toBeNull(); expect(plan.exclusions[0]!.reasons).toContain(expected);
    expect(plan.nextEligibleAt).toBeNull(); // An observation refresh is not promised capacity.
  });

  it.each([
    [], [observation('codex-a', { windows: [] })],
    [observation('codex-a', { windows: [{ id: 'weekly', usedPercent: null, resetsAt: null }] })],
    [observation('codex-a', { observedAt: at(-60_000), expiresAt: at(0) })],
    [observation('codex-a', { windows: [{ id: 'weekly', usedPercent: 50, resetsAt: at(0) }] })],
  ])('supports explicit operator-capped unknown quota without inventing utilization %#', (...observations) => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]), observations: observations as ResourceObservation[] });
    const plan = planResourceAssignment(value);
    expect(plan.selectedWorkerId).toBe('codex-a');
    expect(plan.candidates[0]).toMatchObject({ reason: 'operator-capped-unknown-quota', usedPercent: null, pressure: 0 });
  });

  it('never bypasses known exhausted windows after expiry or a calendar reset', () => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]), observations: [observation('codex-a', {
      observedAt: at(-60_000), expiresAt: at(0), windows: [{ id: 'weekly', usedPercent: 100, resetsAt: at(-1) }],
    })] });
    expect(reason(value)).toContain('quota-reserve-reached');
    expect(planResourceAssignment({ ...value, nowMs: nowMs + 60_000 }).selectedWorkerId).toBeNull();
    value.observations = [observation('codex-a', { observedAt: at(0), expiresAt: at(60_000),
      windows: [{ id: 'weekly', usedPercent: 0, resetsAt: at(100_000) }] })];
    expect(planResourceAssignment(value).selectedWorkerId).toBe('codex-a');
  });

  it('keeps provider refusal hard even when stale and operator-capped unknown mode is enabled', () => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]), observations: [observation('codex-a', {
      health: 'unavailable', observedAt: at(-60_000), expiresAt: at(0), windows: [],
    })] });
    expect(reason(value)).toContain('worker-unavailable'); expect(planResourceAssignment(value).selectedWorkerId).toBeNull();
  });

  it('denies future observation timestamps even with explicit unknown allowance', () => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]), observations: [observation('codex-a', {
      observedAt: at(1), expiresAt: at(60_000),
    })] });
    expect(reason(value)).toContain('observation-future');
  });

  it('denies future partial updates even when older window capture is valid and unknown quota is allowed', () => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]),
      observations: [observation('codex-a', { updatedAt: at(1), windows: [] })] });
    expect(reason(value)).toContain('observation-future');
  });

  it('requires fresh ready local health, but no fabricated local quota window', () => {
    const value = input({ pool: pool([worker('local', { provider: 'local', allowUnknownQuota: true })]), allowedWorkerIds: ['local'],
      observations: [observation('local', { windows: [] })] });
    expect(planResourceAssignment(value).candidates[0]).toMatchObject({ workerId: 'local', usedPercent: null, reason: 'eligible' });
    value.observations = []; expect(reason(value)).toContain('observation-missing');
    value.observations = [observation('local', { observedAt: at(-60_000), expiresAt: at(0), windows: [] })];
    expect(reason(value)).toContain('observation-stale');
    value.observations = [observation('local', { health: 'unavailable', windows: [] })];
    expect(reason(value)).toContain('worker-unavailable');
  });

  it('keeps operator task caps separate from provider percentages and concurrent leases', () => {
    const value = input({ activeCounts: { 'codex-a': 2 }, taskReservationCounts: { 'codex-a': { count: 10, nextEligibleAt: at(10_000) } } });
    expect(reason(value)).toEqual(['concurrency-exhausted', 'operator-task-cap-reached']);
    value.activeCounts['codex-a'] = 0;
    expect(planResourceAssignment(value).selectedWorkerId).toBeNull();
    value.taskReservationCounts['codex-a']!.count = 9;
    expect(planResourceAssignment(value).candidates[0]).toMatchObject({ usedPercent: 25, pressure: 0.9, taskReservationCount: 9 });
  });

  it('does not let operator-capped unknown mode bypass actual caps', () => {
    const value = input({ pool: pool([worker('codex-a', { allowUnknownQuota: true })]), observations: [],
      taskReservationCounts: { 'codex-a': { count: 10, nextEligibleAt: null } } });
    expect(reason(value)).toContain('operator-task-cap-reached');
  });

  it('preserves hard retry-after and returns only an explicit re-evaluation hint', () => {
    const value = input({ observations: [observation('codex-a', { retryAfter: at(20_000) })],
      taskReservationCounts: { 'codex-a': { count: 10, nextEligibleAt: at(10_000) } } });
    const plan = planResourceAssignment(value);
    expect(plan.selectedWorkerId).toBeNull(); expect(plan.exclusions[0]!.reasons).toContain('provider-retry-after');
    expect(plan.nextEligibleAt).toBe(at(10_000));
    expect(planResourceAssignment({ ...value, nowMs: nowMs + 10_000 }).selectedWorkerId).toBeNull();
  });

  it('sorts by descending configured priority, lowest pressure, then stable ID, not roster order', () => {
    const workers = [worker('c'), worker('b'), worker('a')]; const observations = workers.map((row) => observation(row.id));
    const value = input({ pool: pool(workers), observations, allowedWorkerIds: ['c', 'b', 'a'], activeCounts: { a: 1 } });
    expect(planResourceAssignment(value).candidates.map((row) => row.workerId)).toEqual(['b', 'c', 'a']);
    value.pool.workers[2]!.priority = 1;
    expect(planResourceAssignment(value).selectedWorkerId).toBe('a');
    value.pool.workers[2]!.priority = 0; value.observations[1]!.windows[0]!.usedPercent = 40;
    expect(planResourceAssignment(value).selectedWorkerId).toBe('c');
  });

  it('never routes outside task eligibility and returns an immutable plan without mutating the snapshot', () => {
    const value = input({ allowedWorkerIds: [] }); const before = JSON.stringify(value);
    const plan = planResourceAssignment(value);
    expect(plan.selectedWorkerId).toBeNull(); expect(plan.exclusions[0]!.reasons).toEqual(['worker-not-allowed']);
    expect(JSON.stringify(value)).toBe(before); expect(Object.isFrozen(plan.exclusions[0]!.reasons)).toBe(true);
  });

  it('retains separate Codex accounts, Claude and local concurrency instead of one provider bucket', () => {
    const workers = [worker('codex-a'), worker('codex-b'), worker('claude', { provider: 'claude' }), worker('local', { provider: 'local' })];
    const value = input({ pool: pool(workers), allowedWorkerIds: workers.map((row) => row.id),
      observations: workers.map((row) => observation(row.id, row.provider === 'local' ? { windows: [] } : {})),
      activeCounts: { 'codex-a': 2, claude: 2, local: 2 } });
    expect(planResourceAssignment(value).selectedWorkerId).toBe('codex-b');
    expect(planResourceAssignment(value).exclusions.map((row) => row.workerId)).toEqual(['codex-a', 'claude', 'local']);
  });
});
