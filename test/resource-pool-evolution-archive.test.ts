/** Real private disk/journal transactions; all jobs and receipts are synthetic, with no provider calls. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { previewResourceConsolePoolEvolution, type ResourceConsoleDurableState } from '../src/core/resources/console-state-codec.js';
import { compactResourceConsoleStorage, prepareResourceConsoleStorage, readResourceConsoleStorage, resourceConsoleArchiveRoot } from '../src/core/resources/console-state-storage.js';
import { createResourceConsoleHistoryArchiveStore } from '../src/core/resources/console-history-archive-store.js';
import * as storage from '../src/core/resources/console-state-storage.js';
import * as writes from '../src/core/util/private-file-write.js';

const bases: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true }); });
const sha = (value: unknown) => digest(canonical(value));
const save = (file: string, value: unknown) => writeFileSync(file, `${canonical(value)}\n`, { mode: 0o600 });
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
type Job = ResourceConsoleDurableState['jobs'][number];
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pool-evolution-archive-'))); bases.push(base);
  const root = join(base, 'runtime'); const workspace = join(base, 'workspace');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  const worker = { id: 'local', provider: 'local', model: 'fixture', maxConcurrent: 1, reservePercent: 10,
    maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 };
  const pool = validateResourcePool({ schemaVersion: 1, id: 'pool', workers: [worker] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'fixture', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
  const nextPool = validateResourcePool({ ...pool, workers: [...pool.workers, { ...worker, id: 'second' }] });
  const nextBindings = validateResourceBindings([...bindings, { ...bindings[0]!, workerId: 'second' }], nextPool);
  const originPoolDigest = sha({ pool, bindings }); const scopeDigest = sha({ pool, bindings, workspace });
  const options = { root, workspace, pool, bindings, nextPool, nextBindings };
  const oldOptions = { root, workspace, pool, bindings, configHistory: [{ pool, bindings, poolDigest: originPoolDigest }] };
  const poolFile = join(root, 'pool-state.json'); const consoleFile = join(root, 'resource-console-state.json');
  const poolState = { schemaVersion: 1, poolDigest: originPoolDigest, observations: [], attempts: [] };
  save(poolFile, poolState);
  const at = '2026-09-13T00:00:00.000Z';
  const job = (id: string): Job => ({ id, state: 'settled', enqueuedAt: at, updatedAt: at,
    allowedWorkerIds: ['local'], mode: 'read-only', workerId: 'local', outcome: 'completed', reason: null,
    taskDigest: sha({ synthetic: id }), input: null, retainHistory: true,
    history: { prompt: `private-prompt-${id}`, output: { text: `private-output-${id}`, truncated: false } } });
  const state: ResourceConsoleDurableState = { schemaVersion: 7, scopeDigest, originPoolDigest, paused: true, jobs: [job('first'), job('second')] };
  save(consoleFile, state);
  const archive = () => createResourceConsoleHistoryArchiveStore({ root: resourceConsoleArchiveRoot(root), scopeDigest });
  const compact = (ids: string[]) => {
    const view = readResourceConsoleStorage(read(consoleFile), oldOptions);
    const next = compactResourceConsoleStorage(view, ids, oldOptions, () => {
      if (sha(read(consoleFile)) !== view.sourceDigest) throw new Error('Fixture source changed');
    });
    save(consoleFile, next.source); return next;
  };
  const nextOptions = () => ({ root, workspace, pool: nextPool, bindings: nextBindings, configHistory: read(poolFile).configurationHistory });
  const journalFile = () => join(root, 'pool-evolution', readdirSync(join(root, 'pool-evolution'))[0]!, 'journal.json');
  return { root, options, oldOptions, nextOptions, poolFile, consoleFile, state, poolState, compact, archive, job, journalFile };
}

/** Independent literal v1 algorithm. This fixture must not call the new journal writer. */
function legacyJournal(f: ReturnType<typeof fixture>, interrupted = true) {
  const from = { pool: f.options.pool, bindings: f.options.bindings, poolDigest: sha({ pool: f.options.pool, bindings: f.options.bindings }) };
  const to = { pool: f.options.nextPool, bindings: f.options.nextBindings, poolDigest: sha({ pool: f.options.nextPool, bindings: f.options.nextBindings }) };
  const history = [from, to]; const afterPool = { ...f.poolState, schemaVersion: 2, poolDigest: to.poolDigest, configurationHistory: history };
  const afterConsole = previewResourceConsolePoolEvolution(f.state, { workspace: f.options.workspace, from, to, configHistory: history })!;
  const consoleProof = { scopeDigest: sha({ scopeDigest: afterConsole.scopeDigest, originPoolDigest: afterConsole.originPoolDigest }), jobs: afterConsole.jobs.map(job => ({
    id: job.id, identityDigest: sha({ id: job.id, taskDigest: job.taskDigest, submissionDigest: job.submissionDigest ?? null,
      parent: job.parent ?? null, projectId: job.projectId ?? 'default', allowedWorkerIds: job.allowedWorkerIds, mode: job.mode,
      enqueuedAt: job.enqueuedAt, originPoolDigest: job.originPoolDigest ?? afterConsole.originPoolDigest, retainHistory: job.retainHistory ?? false }),
    historyDigest: job.history == null ? null : sha(job.history), contextDigest: job.context == null ? null : sha(job.context),
    inputDigest: job.input === null ? null : sha(job.input), queued: job.state === 'queued',
    terminalDigest: job.state === 'queued' ? null : sha({ state: job.state, outcome: job.outcome, workerId: job.workerId }),
  })) };
  const requestDigest = sha({ schemaVersion: 1, root: f.options.root, workspace: f.options.workspace, from, to });
  const stateDigests = { beforePool: sha(f.poolState), afterPool: sha(afterPool), beforeConsole: sha(f.state), afterConsole: sha(afterConsole) };
  const planDigest = sha({ schemaVersion: 1, requestDigest, stateDigests, consoleProof });
  const plan = { schemaVersion: 1, status: 'planned', planDigest, fromPoolDigest: from.poolDigest, toPoolDigest: to.poolDigest,
    historyCount: 2, preservedReceiptCount: 0, preservedJobCount: 2, addedWorkerIds: ['second'], annotatedWorkerIds: [], heldQueuedIds: [],
    executionStarted: false, providerContacted: false };
  const directory = join(f.root, 'pool-evolution', requestDigest); mkdirSync(join(f.root, 'pool-evolution'), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  save(join(directory, 'beforePool.json'), f.poolState); save(join(directory, 'afterPool.json'), afterPool);
  const journal = { schemaVersion: 1, requestDigest, plan, stateDigests, consoleProof }; save(join(directory, 'journal.json'), journal);
  save(f.poolFile, interrupted ? { ...afterPool, pendingEvolution: { planDigest } } : afterPool);
  if (!interrupted) { save(f.consoleFile, afterConsole); save(join(directory, 'ready.json'), { schemaVersion: 1, planDigest }); }
  return { plan, journal, directory, afterConsole };
}

describe('versioned pool evolution with archived history', () => {
  it('emits v2, preserves descriptor bytes, ordered logical identities and private text without copying it into the journal', () => {
    const f = fixture(); const before = f.compact(['first']); const raw = readFileSync(f.consoleFile, 'utf8');
    const plan = checkResourcePoolEvolution(f.options);
    expect(plan).toMatchObject({ schemaVersion: 2, preservedJobCount: 2, executionStarted: false, providerContacted: false });
    expect(readFileSync(f.consoleFile, 'utf8')).toBe(raw); expect(existsSync(join(f.root, 'pool-evolution'))).toBe(false);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('created');
    const after = readResourceConsoleStorage(read(f.consoleFile), f.nextOptions());
    expect(after.source).toEqual(before.source); expect(after.jobs).toEqual(before.jobs); expect(after.archivedRecords).toEqual(before.archivedRecords);
    const journal = read(f.journalFile()); expect(journal.schemaVersion).toBe(2);
    expect(journal.stateDigests.afterConsole).toBe(sha(before.source));
    expect(readFileSync(f.journalFile(), 'utf8')).not.toMatch(/private-prompt|private-output/);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
  });

  it('resumes an independently encoded v1 barrier with its exact original plan and journal bytes', () => {
    const f = fixture(); f.state.schemaVersion = 3; delete f.state.originPoolDigest; save(f.consoleFile, f.state);
    const old = legacyJournal(f); const bytes = readFileSync(join(old.directory, 'journal.json'), 'utf8');
    expect(old.afterConsole.schemaVersion).toBe(5); expect(sha(f.state)).not.toBe(sha(old.afterConsole));
    expect(checkResourcePoolEvolution(f.options)).toEqual(old.plan);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: old.plan.planDigest })).toMatchObject({ schemaVersion: 1, disposition: 'resumed' });
    expect(read(f.consoleFile)).toEqual(old.afterConsole); expect(readFileSync(join(old.directory, 'journal.json'), 'utf8')).toBe(bytes);
  });

  it.each([1, 2] as const)('replays v%s after later compaction, deletion and append without restoring text or removing new history', version => {
    const f = fixture(); const plan = version === 1 ? legacyJournal(f, false).plan : checkResourcePoolEvolution(f.options);
    if (version === 2) applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    const options = f.nextOptions(); const initial = readResourceConsoleStorage(read(f.consoleFile), options);
    const compacted = compactResourceConsoleStorage(initial, ['first'], options, () => {}); save(f.consoleFile, compacted.source);
    f.archive().deleteText(compacted.archivedRecords.get('first')!);
    const deleted = readResourceConsoleStorage(read(f.consoleFile), options);
    const next = prepareResourceConsoleStorage({ ...deleted.hotState, jobs: [...deleted.hotState.jobs, f.job('new-history')] }, deleted, options);
    save(f.consoleFile, next.source); const raw = readFileSync(f.consoleFile, 'utf8');
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toMatchObject({ schemaVersion: version, disposition: 'replayed' });
    expect(readFileSync(f.consoleFile, 'utf8')).toBe(raw);
    expect(readResourceConsoleStorage(read(f.consoleFile), options).getJob('first')!.history).toBeNull();
  });

  it.each(['barrier', 'console', 'ready'] as const)('resumes v2 after an exact durable %s fault', point => {
    const f = fixture(); f.state.schemaVersion = 3; delete f.state.originPoolDigest; save(f.consoleFile, f.state);
    f.compact(['first']); const plan = checkResourcePoolEvolution(f.options); const original = writes.writePrivateFileAtomically; let faulted = false;
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      const hit = point === 'barrier' ? target === f.poolFile && String(bytes).includes('pendingEvolution')
        : point === 'console' ? target === f.consoleFile : target.endsWith('/ready.json');
      if (!faulted && hit) { faulted = true; throw new Error('Exact durable fixture fault'); }
    });
    expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/Exact durable fixture fault/);
    vi.restoreAllMocks(); expect(faulted).toBe(true); expect(checkResourcePoolEvolution(f.options)).toEqual(plan);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('resumed');
    expect(readResourceConsoleStorage(read(f.consoleFile), f.nextOptions()).jobs).toEqual(f.state.jobs);
  });

  it('holds changed archived evidence at the barrier without publishing the console or final ledger', () => {
    const f = fixture(); const view = f.compact(['first']); const original = writes.writePrivateFileAtomically;
    const plan = checkResourcePoolEvolution(f.options); const raw = readFileSync(f.consoleFile, 'utf8'); let changed = false;
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (!changed && target === f.poolFile && String(bytes).includes('pendingEvolution')) {
        changed = true; f.archive().deleteText(view.archivedRecords.get('first')!);
      }
    });
    expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/changed/);
    vi.restoreAllMocks(); expect(changed).toBe(true); expect(readFileSync(f.consoleFile, 'utf8')).toBe(raw);
    expect(read(f.poolFile).pendingEvolution).toEqual({ planDigest: plan.planDigest });
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/transformation changed/);
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
  });

  it('binds immutable execution owner and deadline in v2 replay proofs', () => {
    const f = fixture(); f.state.jobs[0]!.executionOwnerId = '11111111-1111-4111-8111-111111111111';
    f.state.jobs[0]!.executionDeadlineAt = '2026-09-13T00:01:00.000Z'; save(f.consoleFile, f.state);
    const plan = checkResourcePoolEvolution(f.options); applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    const changed = read(f.consoleFile); changed.jobs[0].executionDeadlineAt = '2026-09-13T00:02:00.000Z'; save(f.consoleFile, changed);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/historical console job changed/);
  });

  it('keeps the pending barrier when archive evidence changes immediately before final active-ledger publication', () => {
    const f = fixture(); const view = f.compact(['first']); const original = writes.writePrivateFileAtomically;
    const plan = checkResourcePoolEvolution(f.options); let changed = false;
    vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      if (!changed && target === f.poolFile && !String(bytes).includes('pendingEvolution')) {
        changed = true; f.archive().deleteText(view.archivedRecords.get('first')!);
      }
      return original(temporary, target, bytes, options);
    });
    expect(() => applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest })).toThrow(/changed/);
    vi.restoreAllMocks(); expect(changed).toBe(true);
    expect(read(f.poolFile).pendingEvolution).toEqual({ planDigest: plan.planDigest });
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/transformation changed/);
  });

  it('refuses a journal version downgrade rather than reinterpreting a v2 plan as v1', () => {
    const f = fixture(); f.compact(['first']); const plan = checkResourcePoolEvolution(f.options);
    applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    const journal = read(f.journalFile()); journal.schemaVersion = 1; save(f.journalFile(), journal);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/exact snapshots/);
  });

  it('round-trips a v2 4352-row proof and preserves the recorded v1 4096-row bound (synthetic joined-view seam)', () => {
    const f = fixture(); const original = storage.readResourceConsoleStorage;
    // Deliberately isolates journal capacity from already tested archive codecs:
    // no claim that 4352 jobs were admitted or archived in this fixture.
    const extra = Array.from({ length: 4350 }, (_, index) => f.job(`synthetic-${index}`));
    vi.spyOn(storage, 'readResourceConsoleStorage').mockImplementation((value, options) => {
      const real = original(value, options); return { ...real, jobs: [...real.jobs, ...extra] };
    });
    const plan = checkResourcePoolEvolution(f.options); expect(plan.preservedJobCount).toBe(4352);
    applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest });
    expect(checkResourcePoolEvolution(f.options)).toEqual(plan);
    expect(applyResourcePoolEvolution({ ...f.options, expectedPlanDigest: plan.planDigest }).disposition).toBe('replayed');
    const journal = read(f.journalFile()); expect(journal.consoleProof.jobs).toHaveLength(4352);
    const oversized = structuredClone(journal);
    oversized.consoleProof.jobs.push({ ...oversized.consoleProof.jobs[0], id: 'overflow' });
    save(f.journalFile(), oversized);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/staging is incomplete/);
    journal.schemaVersion = 1; save(f.journalFile(), journal);
    expect(() => checkResourcePoolEvolution(f.options)).toThrow(/staging is incomplete/);
  });
});
