/** Explicit offline two-store upgrade. This is not a scheduler or automatic repair path. */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { decodeResourcePoolState, readResourceJson, requireResourcePoolSettlementHeadroom, type ResourcePoolState } from './pool-runtime.js';
import { previewResourceConsolePoolEvolution, type ResourceConsoleDurableState } from './console-state-codec.js';
import { readResourceConsoleStorage, type ResourceConsoleStoredState, type ResourceConsoleStorageView } from './console-state-storage.js';
import { MAX_RESOURCE_POOL_CONFIGURATIONS, resourcePoolConfigSnapshot, validateResourcePoolAdditiveEvolution,
  validateResourcePoolConfigHistory } from './pool-evolution-policy.js';
import type { ResourcePoolEvolutionOptions, ResourcePoolEvolutionPlan, ResourcePoolEvolutionReport } from './pool-evolution-types.js';
import { ResourcePoolEvolutionError } from './pool-evolution-types.js';
export { ResourcePoolEvolutionError } from './pool-evolution-types.js';
export type { ResourcePoolEvolutionOptions, ResourcePoolEvolutionPlan, ResourcePoolEvolutionReport, ResourcePoolConfigSnapshot } from './pool-evolution-types.js';

const MAX_BYTES = 4 * 1024 * 1024;
const sha = (value: unknown): string => digest(canonical(value));
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function data<T>(value: unknown): T {
  const json = canonicalEvidencePackJsonV3(value);
  if (json === null || Buffer.byteLength(json) + 1 > MAX_BYTES) throw new Error('Invalid bounded pool evolution data');
  return JSON.parse(json) as T;
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && value !== parse(value).root &&
    [...value].every(c => c.charCodeAt(0) >= 32 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
function present(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function readOptional(file: string): unknown { return present(file) ? readResourceJson(file, MAX_BYTES) : null; }
function capture(input: ResourcePoolEvolutionOptions) {
  const options = data<ResourcePoolEvolutionOptions>(input);
  if (!exact(options, ['root', 'workspace', 'pool', 'bindings', 'nextPool', 'nextBindings']) || !path(options.root) || !path(options.workspace)) {
    throw new Error('Invalid pool evolution options');
  }
  inspectPrivateDirectory(options.root);
  const within = relative(options.workspace, options.root);
  if (within === '' || within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)) throw new Error('Pool evolution root must be outside workspace');
  const from = resourcePoolConfigSnapshot(options.pool, options.bindings); const to = resourcePoolConfigSnapshot(options.nextPool, options.nextBindings);
  const changes = validateResourcePoolAdditiveEvolution(from, to);
  const requestDigest = sha({ schemaVersion: 1, root: options.root, workspace: options.workspace, from, to });
  const directory = join(options.root, 'pool-evolution', requestDigest);
  return { options, from, to, changes, requestDigest, directory,
    poolFile: join(options.root, 'pool-state.json'), consoleFile: join(options.root, 'resource-console-state.json') };
}
type Captured = ReturnType<typeof capture>;
interface Staged {
  beforePool: unknown; afterPool: ResourcePoolState; afterConsole?: ResourceConsoleStoredState | null;
  assertConsoleCurrent?: () => void;
  stateDigests: { beforePool: string; afterPool: string; beforeConsole: string; afterConsole: string };
  consoleProof: ConsoleProof; plan: ResourcePoolEvolutionPlan;
}
interface ConsoleProof {
  scopeDigest: string | null;
  jobs: Array<{ id: string; identityDigest: string; historyDigest: string | null; contextDigest: string | null;
    inputDigest: string | null; terminalDigest: string | null; queued: boolean }>;
}
const STAGES = ['beforePool', 'afterPool'] as const;
type JournalVersion = 1 | 2;
type LogicalConsole = Omit<ResourceConsoleDurableState, 'jobs'> & { jobs: readonly ResourceConsoleDurableState['jobs'][number][] };
function consoleProof(state: LogicalConsole | null, version: JournalVersion): ConsoleProof {
  return { scopeDigest: state ? sha({ scopeDigest: state.scopeDigest, originPoolDigest: state.originPoolDigest }) : null,
    jobs: state?.jobs.map(job => ({ id: job.id, identityDigest: sha({ id: job.id, taskDigest: job.taskDigest,
      submissionDigest: job.submissionDigest ?? null, parent: job.parent ?? null, projectId: job.projectId ?? 'default',
      allowedWorkerIds: job.allowedWorkerIds, mode: job.mode, enqueuedAt: job.enqueuedAt,
      originPoolDigest: job.originPoolDigest ?? state.originPoolDigest, retainHistory: job.retainHistory ?? false,
      // Keep the recorded v1 hash domain byte-for-byte compatible.
      ...(version === 2 ? { executionOwnerId: job.executionOwnerId ?? null, executionDeadlineAt: job.executionDeadlineAt ?? null,
        recoveryOf: job.recoveryOf ?? null } : {}) }),
    historyDigest: job.history == null ? null : sha(job.history), contextDigest: job.context == null ? null : sha(job.context),
    inputDigest: job.input === null ? null : sha(job.input), queued: job.state === 'queued',
    terminalDigest: job.state === 'queued' ? null : sha({ state: job.state, outcome: job.outcome, workerId: job.workerId }) })) ?? [] };
}
function validConsoleProof(value: unknown, version: JournalVersion): value is ConsoleProof {
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (!exact(value, ['scopeDigest', 'jobs']) || value.scopeDigest !== null && !hash(value.scopeDigest) ||
    !Array.isArray(value.jobs) || value.jobs.length > (version === 1 ? 4096 : 4352) || value.scopeDigest === null && value.jobs.length !== 0) return false;
  return value.jobs.every(row => exact(row, ['id', 'identityDigest', 'historyDigest', 'contextDigest', 'inputDigest', 'terminalDigest', 'queued']) &&
    typeof row.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(row.id) && hash(row.identityDigest) &&
    ['historyDigest', 'contextDigest', 'inputDigest', 'terminalDigest'].every(key => row[key] === null || hash(row[key])) &&
    typeof row.queued === 'boolean' && (row.queued ? row.terminalDigest === null : hash(row.terminalDigest))) &&
    new Set(value.jobs.map(row => row.id)).size === value.jobs.length;
}
function assertConsolePreserved(current: LogicalConsole | null, original: ConsoleProof, version: JournalVersion): void {
  if (original.scopeDigest === null) return; // No console existed to preserve.
  const proof = consoleProof(current, version);
  if (proof.scopeDigest !== original.scopeDigest) throw new Error('Pool evolution console origin changed');
  const rows = new Map(proof.jobs.map(row => [row.id, row])); const jobs = new Map(current!.jobs.map(row => [row.id, row]));
  for (const old of original.jobs) {
    const row = rows.get(old.id); const live = jobs.get(old.id)!;
    if (!row || row.identityDigest !== old.identityDigest || old.terminalDigest !== null && row.terminalDigest !== old.terminalDigest ||
      old.queued && live.state !== 'queued' && (live.state !== 'cancelled' || live.outcome !== 'cancelled' || live.workerId !== null) ||
      row.historyDigest !== null && row.historyDigest !== old.historyDigest || row.contextDigest !== null && row.contextDigest !== old.contextDigest ||
      row.inputDigest !== null && row.inputDigest !== old.inputDigest) throw new Error('Pool evolution historical console job changed');
  }
}
function derivePool(scope: Captured, beforePool: unknown): ResourcePoolState {
  const old = beforePool === null ? { schemaVersion: 1 as const, poolDigest: scope.from.poolDigest, observations: [], attempts: [] }
    : decodeResourcePoolState(beforePool, scope.from.pool, scope.from.bindings);
  if (old.attempts.some(row => row.status === 'reserved' || row.status === 'uncertain')) throw new ResourcePoolEvolutionError('uncertain-work');
  const history = old.configurationHistory ?? [scope.from];
  if (history.length >= MAX_RESOURCE_POOL_CONFIGURATIONS) throw new Error('Resource configuration history capacity reached');
  const configurationHistory = validateResourcePoolConfigHistory([...history, scope.to]);
  // Scope annotations invalidate the interpretation of legacy combined windows.
  // Archive their exact bytes in beforePool; do not relabel them fresh evidence
  // or turn a known refusal into an allowUnknownQuota bootstrap opportunity.
  const observations = old.observations.map(row => scope.changes.annotatedWorkerIds.includes(row.workerId)
    ? { ...row, windows: [], health: 'unavailable' as const } : row);
  const afterPool = decodeResourcePoolState({ ...old, schemaVersion: 2, poolDigest: scope.to.poolDigest, configurationHistory, observations }, scope.to.pool, scope.to.bindings);
  requireResourcePoolSettlementHeadroom(afterPool, scope.to.pool);
  if (Buffer.byteLength(canonical({ ...afterPool,
    pendingEvolution: { planDigest: '0'.repeat(64) } })) + 1 > MAX_BYTES) throw new Error('Pool evolution state capacity reached');
  return afterPool;
}
function assemble(scope: Captured, beforePool: unknown, afterPool: ResourcePoolState, stateDigests: Staged['stateDigests'], proof: ConsoleProof, version: JournalVersion): Staged {
  const planDigest = sha({ schemaVersion: version, requestDigest: scope.requestDigest, stateDigests, consoleProof: proof });
  const plan: ResourcePoolEvolutionPlan = { schemaVersion: version, status: 'planned', planDigest, fromPoolDigest: scope.from.poolDigest,
    toPoolDigest: scope.to.poolDigest, historyCount: afterPool.configurationHistory!.length, preservedReceiptCount: afterPool.attempts.length,
    preservedJobCount: proof.jobs.length, ...scope.changes,
    heldQueuedIds: proof.jobs.filter(job => job.queued).map(job => job.id), executionStarted: false, providerContacted: false };
  return { beforePool, afterPool, stateDigests, consoleProof: proof, plan };
}
function consoleRead(scope: Captured, value: unknown, pool: ResourcePoolState): ResourceConsoleStorageView | null {
  return value === null ? null : readResourceConsoleStorage(value, { root: scope.options.root, workspace: scope.options.workspace,
    pool: scope.to.pool, bindings: scope.to.bindings, configHistory: pool.configurationHistory });
}
function logical(view: ResourceConsoleStorageView | null): LogicalConsole | null { return view ? { ...view.hotState, jobs: view.jobs } : null; }
function currentGuard(...views: Array<ResourceConsoleStorageView | null>): () => void {
  return () => { if (views.some(view => view && !view.isCurrent())) throw new ResourcePoolEvolutionError('state-conflict'); };
}
/** Preserve the persisted union and order; never flatten archived rows into a legacy root. */
function transformConsole(scope: Captured, value: unknown, afterPool: ResourcePoolState, version: JournalVersion) {
  const history = afterPool.configurationHistory!;
  const previewOptions = { workspace: scope.options.workspace, from: scope.from, to: scope.to, configHistory: history };
  const before = value === null ? null : readResourceConsoleStorage(value, { root: scope.options.root, workspace: scope.options.workspace,
    pool: scope.from.pool, bindings: scope.from.bindings, configHistory: history.slice(0, -1) });
  let source: ResourceConsoleStoredState | null;
  if (version === 1 || before === null) source = previewResourceConsolePoolEvolution(value, previewOptions);
  else {
    if (before.jobs.some(job => job.state === 'dispatching' || job.state === 'unresolved')) throw new ResourcePoolEvolutionError('uncertain-work');
    const { jobs: _jobs, ...header } = previewResourceConsolePoolEvolution({ ...before.hotState, jobs: [] }, previewOptions)!;
    source = 'kind' in before.source ? { ...before.source, console: header, currentJobs: before.hotState.jobs }
      : { ...header, jobs: before.hotState.jobs };
  }
  const after = consoleRead(scope, source, afterPool); const assertCurrent = currentGuard(before, after); assertCurrent();
  return { source, proof: consoleProof(logical(after), version), assertCurrent };
}
function derive(scope: Captured, beforePool: unknown, beforeConsole: unknown): Staged {
  const afterPool = derivePool(scope, beforePool);
  const transformed = transformConsole(scope, beforeConsole, afterPool, 2); const afterConsole = transformed.source;
  if (Buffer.byteLength(canonical(afterConsole)) + 1 > MAX_BYTES) throw new Error('Console evolution state capacity reached');
  return { ...assemble(scope, beforePool, afterPool, { beforePool: sha(beforePool), afterPool: sha(afterPool),
    beforeConsole: sha(beforeConsole), afterConsole: sha(afterConsole) }, transformed.proof, 2), afterConsole,
    assertConsoleCurrent: transformed.assertCurrent };
}
function loadJournal(scope: Captured): Staged | null {
  if (!present(scope.directory)) return null;
  inspectPrivateDirectory(join(scope.options.root, 'pool-evolution')); inspectPrivateDirectory(scope.directory);
  const journal = readOptional(join(scope.directory, 'journal.json'));
  if (!exact(journal, ['schemaVersion', 'requestDigest', 'plan', 'stateDigests', 'consoleProof']) || (journal.schemaVersion !== 1 && journal.schemaVersion !== 2) ||
    journal.requestDigest !== scope.requestDigest || !validConsoleProof(journal.consoleProof, journal.schemaVersion) ||
    !exact(journal.stateDigests, ['beforePool', 'afterPool', 'beforeConsole', 'afterConsole']) ||
    Object.values(journal.stateDigests).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new ResourcePoolEvolutionError('incomplete-journal');
  }
  const stages = Object.fromEntries(STAGES.map(key => [key, readResourceJson(join(scope.directory, `${key}.json`), MAX_BYTES)])) as unknown as Staged;
  const afterPool = derivePool(scope, stages.beforePool);
  const stateDigests = journal.stateDigests as Staged['stateDigests'];
  const expected = assemble(scope, stages.beforePool, afterPool, stateDigests, journal.consoleProof, journal.schemaVersion);
  if (canonical(journal.plan) !== canonical(expected.plan) || STAGES.some(key => stateDigests[key] !== sha(expected[key])) ||
    STAGES.some(key => canonical(stages[key]) !== canonical(expected[key]))) throw new Error('Pool evolution journal differs from its exact snapshots');
  return expected;
}
function barrier(staged: Staged): ResourcePoolState { return { ...staged.afterPool, pendingEvolution: { planDigest: staged.plan.planDigest } }; }
function consoleTemporary(scope: Captured): string { return join(scope.options.root, `.pool-evolution-console-${scope.requestDigest}.tmp`); }
/** Only an explicit locked resume may remove this exact complete private copy. */
function removeConsoleTemporary(scope: Captured, staged: Staged, guard: () => void): void {
  const file = consoleTemporary(scope);
  if (!present(file)) return;
  guard();
  const before = lstatSync(file, { bigint: true });
  const read = readStableRegularFile(file, { anchorPath: scope.options.root, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (staged.afterConsole == null || !read.ok || read.text !== canonical(staged.afterConsole) + '\n' ||
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n ||
    typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new ResourcePoolEvolutionError('incomplete-journal');
  guard();
  const after = lstatSync(file, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].some(key =>
    before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new ResourcePoolEvolutionError('state-conflict');
  unlinkSync(file); fsyncDirectory(scope.options.root); guard();
}
function finalized(scope: Captured, staged: Staged): boolean {
  if (!present(join(scope.directory, 'ready.json'))) return false;
  if (present(consoleTemporary(scope))) throw new ResourcePoolEvolutionError('incomplete-journal');
  if (canonical(readResourceJson(join(scope.directory, 'ready.json'))) !== canonical({ schemaVersion: 1, planDigest: staged.plan.planDigest })) {
    throw new Error('Pool evolution finalization record changed');
  }
  const current = readOptional(scope.poolFile);
  if (current === null || (current as ResourcePoolState).pendingEvolution !== undefined) return false;
  const pool = decodeResourcePoolState(current, scope.to.pool, scope.to.bindings);
  if (canonical(pool.configurationHistory) !== canonical(staged.afterPool.configurationHistory)) throw new Error('Pool evolution history changed after publication');
  // A completed migration may already have admitted new work. Never overwrite
  // those later receipts or console changes merely to replay this configuration.
  for (const old of staged.afterPool.attempts) if (canonical(pool.attempts.find(row => row.id === old.id)) !== canonical(old)) {
    throw new Error('Pool evolution historical receipt changed');
  }
  const console = readOptional(scope.consoleFile);
  const currentConsole = consoleRead(scope, console, pool);
  assertConsolePreserved(logical(currentConsole), staged.consoleProof, staged.plan.schemaVersion);
  currentGuard(currentConsole)();
  if (sha(readOptional(scope.poolFile)) !== sha(current) || sha(readOptional(scope.consoleFile)) !== sha(console)) throw new ResourcePoolEvolutionError('state-conflict');
  currentGuard(currentConsole)();
  return true;
}
function phase(scope: Captured, staged: Staged): 'before' | 'barrier' | 'console' | 'done' {
  staged.assertConsoleCurrent?.();
  if (finalized(scope, staged)) return 'done';
  const pool = readOptional(scope.poolFile); const console = readOptional(scope.consoleFile);
  const oldPool = canonical(pool) === canonical(staged.beforePool); const oldConsole = sha(console) === staged.stateDigests.beforeConsole;
  const pending = canonical(pool) === canonical(barrier(staged)); const newConsole = sha(console) === staged.stateDigests.afterConsole;
  if (oldConsole) {
    const transformed = transformConsole(scope, console, staged.afterPool, staged.plan.schemaVersion);
    if (sha(transformed.source) !== staged.stateDigests.afterConsole || canonical(transformed.proof) !== canonical(staged.consoleProof)) {
      throw new Error('Pool evolution live console transformation changed');
    }
    staged.afterConsole = transformed.source; staged.assertConsoleCurrent = transformed.assertCurrent;
  } else if (newConsole) {
    const transformed = consoleRead(scope, console, staged.afterPool);
    if (canonical(consoleProof(logical(transformed), staged.plan.schemaVersion)) !== canonical(staged.consoleProof)) throw new Error('Pool evolution console proof changed');
    staged.afterConsole = transformed?.source ?? null; staged.assertConsoleCurrent = currentGuard(transformed);
  }
  staged.assertConsoleCurrent?.();
  if (oldPool && oldConsole) return 'before';
  if (pending && newConsole) return 'console';
  if (pending && oldConsole) return 'barrier';
  throw new ResourcePoolEvolutionError('state-conflict');
}
/** Read-only plan or exact interrupted-plan inspection; never acquires ownership. */
export function checkResourcePoolEvolution(input: ResourcePoolEvolutionOptions): ResourcePoolEvolutionPlan {
  const scope = capture(input); const staged = loadJournal(scope);
  if (staged && phase(scope, staged) === 'done') {
    if (!finalized(scope, staged)) throw new Error('Pool evolution replay evidence changed'); return staged.plan;
  }
  requireOffline(scope.options.root);
  if (staged) { phase(scope, staged); return staged.plan; }
  const beforePool = readOptional(scope.poolFile); const beforeConsole = readOptional(scope.consoleFile);
  const derived = derive(scope, beforePool, beforeConsole); const plan = derived.plan;
  if (canonical(readOptional(scope.poolFile)) !== canonical(beforePool) || canonical(readOptional(scope.consoleFile)) !== canonical(beforeConsole)) {
    throw new ResourcePoolEvolutionError('state-conflict');
  }
  derived.assertConsoleCurrent?.();
  return plan;
}
function requireOffline(root: string): void {
  if (['.resource-console.lock', '.pool.lock', '.resource-quota-refresh.lock'].some(file => present(join(root, file)))) {
    throw new ResourcePoolEvolutionError('ownership-present');
  }
  if (present(join(root, '.resource-quota-refresh-pending.json'))) throw new ResourcePoolEvolutionError('uncertain-work');
}
function write(root: string, target: string, value: unknown, guard: () => void, temporary?: string): void {
  guard(); const bytes = canonical(value) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Pool evolution evidence exceeds bounds');
  writePrivateFileAtomically(temporary ?? join(root, `.pool-evolution-${randomUUID()}.tmp`), target, bytes,
    { anchorPath: root, label: 'Pool evolution state', prepublish: guard });
  guard();
}
/** Offline explicit apply/resume, under the same console and pool leases as ordinary ownership. */
export function applyResourcePoolEvolution(input: ResourcePoolEvolutionOptions & { expectedPlanDigest: string }): ResourcePoolEvolutionReport {
  const captured = data<ResourcePoolEvolutionOptions & { expectedPlanDigest: string }>(input);
  if (!exact(captured, ['root', 'workspace', 'pool', 'bindings', 'nextPool', 'nextBindings', 'expectedPlanDigest']) ||
    typeof captured.expectedPlanDigest !== 'string' || !/^[a-f0-9]{64}$/.test(captured.expectedPlanDigest)) throw new Error('Pool evolution requires an exact plan digest');
  const { expectedPlanDigest, ...options } = captured; const scope = capture(options);
  // Validate before acquiring any lease, including malformed existing snapshots.
  if (checkResourcePoolEvolution(options).planDigest !== expectedPlanDigest) throw new ResourcePoolEvolutionError('state-conflict');
  const completed = loadJournal(scope);
  if (completed && finalized(scope, completed)) {
    if (!finalized(scope, completed)) throw new Error('Pool evolution replay evidence changed');
    return { ...completed.plan, status: 'applied', disposition: 'replayed' };
  }
  const consoleLock = acquireLocalStoreLock(join(options.root, '.resource-console.lock'), 0, { anchorPath: options.root, exactPrivateStorage: true });
  if (!consoleLock) throw new ResourcePoolEvolutionError('ownership-present');
  let poolLock: ReturnType<typeof acquireLocalStoreLock> = null;
  let quotaLock: ReturnType<typeof acquireLocalStoreLock> = null;
  let outcome: { result: ResourcePoolEvolutionReport } | { error: unknown };
  try {
    poolLock = acquireLocalStoreLock(join(options.root, '.pool.lock'), 0, { anchorPath: options.root, exactPrivateStorage: true });
    if (!poolLock) throw new ResourcePoolEvolutionError('ownership-present');
    quotaLock = acquireLocalStoreLock(join(options.root, '.resource-quota-refresh.lock'), 0, { anchorPath: options.root, exactPrivateStorage: true });
    if (!quotaLock) throw new ResourcePoolEvolutionError('ownership-present');
    if (present(join(options.root, '.resource-quota-refresh-pending.json'))) throw new ResourcePoolEvolutionError('uncertain-work');
    let staged: Staged | null = null;
    const guard = (): void => { inspectPrivateDirectory(options.root); staged?.assertConsoleCurrent?.();
      if (!ownsLocalStoreLock(consoleLock) || !poolLock || !ownsLocalStoreLock(poolLock) || !quotaLock || !ownsLocalStoreLock(quotaLock)) throw new Error('Pool evolution ownership lost'); };
    outcome = { result: (() => {
    staged = loadJournal(scope); const resumed = staged !== null;
    if (!staged) {
      staged = derive(scope, readOptional(scope.poolFile), readOptional(scope.consoleFile));
      if (staged.plan.planDigest !== expectedPlanDigest) throw new ResourcePoolEvolutionError('state-conflict');
      const parent = join(options.root, 'pool-evolution');
      if (!present(parent)) { guard(); mkdirSync(parent, { mode: 0o700 }); fsyncDirectory(options.root); }
      inspectPrivateDirectory(parent); guard(); mkdirSync(scope.directory, { mode: 0o700 }); fsyncDirectory(parent);
      for (const key of STAGES) write(scope.directory, join(scope.directory, `${key}.json`), staged[key], guard);
      // Never archive console prompt/output/context text. Exact hashes and
      // immutable job proofs support recovery without shadow transcript copies.
      write(scope.directory, join(scope.directory, 'journal.json'), { schemaVersion: staged.plan.schemaVersion, requestDigest: scope.requestDigest,
        plan: staged.plan, stateDigests: staged.stateDigests, consoleProof: staged.consoleProof }, guard);
    }
    if (staged.plan.planDigest !== expectedPlanDigest) throw new Error('Pool evolution journal plan mismatch');
    let current = phase(scope, staged);
    if (current === 'done') return { ...staged.plan, status: 'applied', disposition: 'replayed' };
    removeConsoleTemporary(scope, staged, guard);
    if (current === 'before') { write(options.root, scope.poolFile, barrier(staged), guard); current = phase(scope, staged); }
    if (current === 'barrier') {
      if (staged.afterConsole === undefined) throw new Error('Pool evolution console proof unavailable');
      if (staged.afterConsole !== null) write(options.root, scope.consoleFile, staged.afterConsole, guard, consoleTemporary(scope));
      current = phase(scope, staged);
      // Missing console is deliberately preserved; there is no new workspace registration.
      if (staged.afterConsole === null) current = 'console';
    }
    if (current !== 'console') throw new Error('Pool evolution did not reach exact console publication');
    if (present(consoleTemporary(scope))) throw new ResourcePoolEvolutionError('incomplete-journal');
    if (!present(join(scope.directory, 'ready.json'))) write(scope.directory, join(scope.directory, 'ready.json'), { schemaVersion: 1, planDigest: expectedPlanDigest }, guard);
    else if (canonical(readResourceJson(join(scope.directory, 'ready.json'))) !== canonical({ schemaVersion: 1, planDigest: expectedPlanDigest })) throw new Error('Pool evolution finalization record changed');
    // Final active state is the last publication: old binaries refuse schema2,
    // new binaries refuse the pending barrier until this exact point.
    guard(); phase(scope, staged); write(options.root, scope.poolFile, staged.afterPool, guard);
    if (!finalized(scope, staged)) throw new Error('Pool evolution final state unavailable');
    return { ...staged.plan, status: 'applied', disposition: resumed ? 'resumed' : 'created' };
    })() };
  } catch (error) { outcome = { error }; }
  const quotaReleased = quotaLock === null || releaseLocalStoreLock(quotaLock);
    const poolReleased = poolLock === null || releaseLocalStoreLock(poolLock);
    const consoleReleased = releaseLocalStoreLock(consoleLock);
  if (!quotaReleased || !poolReleased || !consoleReleased) throw new Error('Pool evolution ownership release uncertain');
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}
