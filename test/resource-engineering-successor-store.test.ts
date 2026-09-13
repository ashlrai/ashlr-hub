/** Real private journal reads; no coordinator, provider, or execution owner is created. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { createResourceEngineeringSuccessorCoordinator } from '../src/core/resources/engineering-successor-coordinator.js';
import { writeImmutablePrivateRecord } from '../src/core/util/immutable-private-record-store.js';
import { EngineeringSuccessorJournalReadError, engineeringSuccessorKey, engineeringSuccessorPrompt, engineeringSuccessorRecordStore, hash,
  projectEngineeringSuccessorJournal, readEngineeringSuccessorJournal, engineeringSuccessorTaskOrigin,
  type JournalScope, type DurableRecord, type Intent, type Result, type Prepared, type Admitted } from '../src/core/resources/engineering-successor-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(enroll = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'successor-journal-'))); roots.push(root);
  const parent = join(root, 'engineering-successors'); mkdirSync(parent, { mode: 0o700 });
  const directory = join(parent, 'fleet'); mkdirSync(directory, { mode: 0o700 });
  const config: JournalScope['config'] = { schemaVersion: 1, supervisionId: 'fleet', profileId: 'fixed', allowedWorkerIds: ['worker'],
    maxOutputTokens: 1000, proposalTimeoutMs: 5000, maxSuccessors: 2, pollIntervalMs: 100 };
  const scope: JournalScope = { directory, config, expectedEnrollment: { id: 'enrollment', kind: 'enrollment', configDigest: hash(config),
    supervisionDigest: 'd'.repeat(64), deadlineAt: '2026-09-12T00:00:00.000Z', poolDigest: 'e'.repeat(64),
    cwd: { id: 'proposal', label: 'Proposal workspace', workspace: root, dev: '1', ino: '2' } } };
  const source = { enrollmentId: 'source', enrollmentDigest: 'a'.repeat(64), projectId: 'project', deliveryDigest: 'b'.repeat(64),
    commit: 'c'.repeat(40), objective: 'PRIVATE_OBJECTIVE', context: 'PRIVATE_CONTEXT' };
  const key = engineeringSuccessorKey(scope, source);
  const intent: Intent = { id: `intent-${key}`, kind: 'intent', key, source, successorId: `successor-${key}`,
    task: { schemaVersion: 1, id: `proposal-${key}`, mode: 'read-only', cwd: root, prompt: engineeringSuccessorPrompt(scope, source),
      allowedWorkerIds: ['worker'], maxOutputTokens: 1000, timeoutMs: 5000 } };
  const result: Result = { id: `result-${key}`, kind: 'result', key, intentDigest: hash(intent), receiptDigest: 'f'.repeat(64),
    output: JSON.stringify({ action: 'propose', name: 'PRIVATE_NAME', objective: 'PRIVATE_OUTPUT' }) };
  const prepared: Prepared = { id: `prepared-${key}`, kind: 'prepared', key, intentDigest: hash(intent),
    enrollmentId: intent.successorId, enrollmentDigest: '1'.repeat(64), projectId: source.projectId };
  const admitted: Admitted = { id: `admitted-${key}`, kind: 'admitted', key, intentDigest: hash(intent), enrollmentDigest: prepared.enrollmentDigest };
  const store = engineeringSuccessorRecordStore(directory);
  const write = (record: DurableRecord) => expect(writeImmutablePrivateRecord(store, record)).toBe('recorded');
  const bytes = () => {
    const walk = (path: string): unknown => Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map(row => [row.name, row.isDirectory() ? walk(join(path, row.name)) : readFileSync(join(path, row.name), 'hex')]));
    return walk(root);
  };
  if (enroll) write(scope.expectedEnrollment);
  return { scope, intent, result, prepared, admitted, write, bytes };
}

describe('shared successor journal observation', () => {
  it('binds new proposal origin to the full enrollment without rewriting legacy intents', () => {
    const f = fixture(); f.intent.task.origin = engineeringSuccessorTaskOrigin(f.scope, f.intent.source); f.write(f.intent);
    const before = f.bytes(); const read = readEngineeringSuccessorJournal(f.scope);
    expect(read.records.find(row => row.kind === 'intent')).toEqual(f.intent); expect(f.bytes()).toEqual(before);
    expect(f.intent.task.origin).toEqual({ kind: 'engineering-successor-proposal',
      scopeDigest: hash(f.scope.expectedEnrollment), proposalKey: f.intent.key });
    expect(JSON.stringify(f.intent.task.origin)).not.toContain(f.scope.expectedEnrollment.cwd.workspace);
  });
  it('refuses a structurally valid origin from a different enrollment', () => {
    const f = fixture(); f.intent.task.origin = { ...engineeringSuccessorTaskOrigin(f.scope, f.intent.source), scopeDigest: '0'.repeat(64) };
    f.write(f.intent); const before = f.bytes();
    expect(() => readEngineeringSuccessorJournal(f.scope)).toThrow('Successor intent changed'); expect(f.bytes()).toEqual(before);
  });
  it('classifies only a pure writer mutation as retryable and rereads after the writer releases', () => {
    const f = fixture(); f.write(f.intent);
    const events = join(f.scope.directory, 'events');
    const lease = acquireLocalStoreLockWithOutcome(join(events, '.records.lock'), 0, { anchorPath: events, exactPrivateStorage: true });
    expect(lease.state).toBe('acquired'); if (lease.state !== 'acquired') throw new Error('Fixture lock unavailable');
    const before = f.bytes();
    try {
      expect(() => projectEngineeringSuccessorJournal(f.scope)).toThrowError(EngineeringSuccessorJournalReadError);
      try { projectEngineeringSuccessorJournal(f.scope); throw new Error('Expected read refusal'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'UNAVAILABLE', stopReasons: ['source-mutated'], canRetry: true });
        expect(JSON.stringify(error)).not.toContain(f.scope.directory);
      }
      expect(f.bytes()).toEqual(before);
    } finally { expect(releaseLocalStoreLock(lease.lock)).toBe(true); }
    expect(projectEngineeringSuccessorJournal(f.scope).snapshot.entries[0]?.state).toBe('intent-recorded');
  });
  it.each(['staging', 'invalid', 'missing'] as const)('does not retry %s evidence', kind => {
    const f = fixture(kind !== 'missing');
    if (kind === 'staging') writeFileSync(join(f.scope.directory, 'events', 'staging', '.partial.stage'), 'PRIVATE_TEXT', { mode: 0o600 });
    if (kind === 'invalid') writeFileSync(join(f.scope.directory, 'events', 'records', 'enrollment.json'), '{}', { mode: 0o600 });
    const before = f.bytes();
    try { projectEngineeringSuccessorJournal(f.scope); throw new Error('Expected read refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(EngineeringSuccessorJournalReadError);
      expect(error).toMatchObject({ code: 'UNAVAILABLE', canRetry: false,
        stopReasons: kind === 'missing' ? [] : kind === 'staging' ? ['source-mutated', 'invalid-file'] : ['invalid-file'] });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_TEXT');
    }
    expect(f.bytes()).toEqual(before);
  });
  it.each([
    { stopReasons: ['source-mutated'] as const, invalidFiles: 1, limitExceeded: false, sourcePresent: true },
    { stopReasons: ['source-mutated'] as const, invalidFiles: 0, limitExceeded: true, sourcePresent: true },
    { stopReasons: ['source-mutated'] as const, invalidFiles: 0, limitExceeded: false, sourcePresent: false },
    { stopReasons: ['unsafe-storage'] as const, invalidFiles: 0, limitExceeded: false, sourcePresent: true },
  ])('rejects non-pure mutation retry metadata %#', input => {
    expect(new EngineeringSuccessorJournalReadError({ ...input, stopReasons: [...input.stopReasons] }).canRetry).toBe(false);
  });
  it('returns detached initialized observation pins without starting execution', async () => {
    const f = fixture(false);
    let calls = 0;
    const owner = createResourceEngineeringSuccessorCoordinator({ root: f.scope.expectedEnrollment.cwd.workspace,
      cwd: f.scope.expectedEnrollment.cwd.workspace, config: f.scope.config,
      pool: { schemaVersion: 1, id: 'pool', workers: [{ id: 'worker', provider: 'local', model: 'fixture', maxConcurrent: 1,
        reservePercent: 25, maxTasksPerWindow: 5, taskWindowMs: 60_000, priority: 1 }] },
      bindings: [{ workerId: 'worker', capacityKey: 'shared', kind: 'local-chat', endpoint: 'http://127.0.0.1:9/v1' }],
      readAdmissionEvidence: () => { calls++; throw new Error('No execution expected'); },
      supervision: { snapshot: () => ({ schemaVersion: 1, configId: 'fleet', configDigest: 'd'.repeat(64), sourceState: 'healthy',
        state: 'running', deadlineAt: '2026-09-12T00:00:00.000Z', paused: false, revision: 0, entries: [],
        admission: { maxEnrollments: 2, remainingEnrollments: 2, autoAdmitPrepared: false } }),
        admit: () => { calls++; throw new Error('No admission expected'); } },
      host: { source: () => { calls++; return null; }, prepare: async () => { calls++; throw new Error('No preparation expected'); },
        isExecutionStopped: () => true } });
    try {
      const pins = owner.observationScope(); const saved = structuredClone(pins); const bytes = f.bytes();
      pins.config.allowedWorkerIds.push('other'); pins.expectedEnrollment.cwd.ino = '999'; pins.directory += '/other';
      expect(owner.observationScope()).toEqual(saved);
      expect(projectEngineeringSuccessorJournal(saved).snapshot.entries).toEqual([]);
      expect(owner.snapshot().observation).toBeUndefined(); expect(calls).toBe(0); expect(f.bytes()).toEqual(bytes);
    } finally { await owner.close(); }
  });
  it('reads exact existing record bytes and projects only fresh durable facts without writes', () => {
    const f = fixture(); f.write(f.intent);
    const before = f.bytes();
    const first = projectEngineeringSuccessorJournal(f.scope);
    expect(first.snapshot.state).toBe('observing'); expect(first.snapshot.entries[0]?.state).toBe('intent-recorded');
    expect(first.snapshot.entries[0]?.reason).toBeNull(); expect(first.snapshot.observation).toBeUndefined();
    expect(first.recordsDigest).toBe(hash(readEngineeringSuccessorJournal(f.scope).records));
    expect(new Date(first.sampledAt).toISOString()).toBe(first.sampledAt); expect(f.bytes()).toEqual(before);
    const recordPath = join(f.scope.directory, 'events', 'records', `${f.intent.id}.json`);
    expect(readFileSync(recordPath, 'utf8')).toBe(canonical(f.intent) + '\n');
    f.write(f.result);
    const next = projectEngineeringSuccessorJournal(f.scope);
    expect(next.snapshot.entries[0]?.state).toBe('proposed'); expect(next.recordsDigest).not.toBe(first.recordsDigest);
    f.write(f.prepared); expect(projectEngineeringSuccessorJournal(f.scope).snapshot.entries[0]?.state).toBe('prepared');
    f.write(f.admitted); const last = projectEngineeringSuccessorJournal(f.scope);
    expect(last.snapshot.entries[0]?.state).toBe('admitted');
    for (const secret of ['PRIVATE_', f.scope.directory, f.scope.expectedEnrollment.cwd.workspace, 'receiptDigest', 'allowedWorkerIds']) {
      expect(JSON.stringify(last)).not.toContain(secret);
    }
    const saved = f.bytes(); const mutable = readEngineeringSuccessorJournal(f.scope); mutable.records.splice(0);
    expect(projectEngineeringSuccessorJournal(f.scope)).toMatchObject({ recordsDigest: last.recordsDigest }); expect(f.bytes()).toEqual(saved);
  });
  it('allows missing only for explicit coordinator startup and never creates a store', () => {
    const f = fixture(false); const saved = f.bytes();
    expect(() => readEngineeringSuccessorJournal(f.scope)).toThrow();
    expect(readEngineeringSuccessorJournal(f.scope, { allowMissing: true }).records).toEqual([]);
    expect(() => projectEngineeringSuccessorJournal(f.scope)).toThrow(); expect(f.bytes()).toEqual(saved);
  });
  it('projects a recorded stop without claiming worker liveness or current receipt verification', () => {
    const f = fixture(); f.write(f.intent); f.write({ ...f.result, output: '{"action":"stop"}' });
    expect(projectEngineeringSuccessorJournal(f.scope).snapshot.entries[0]).toMatchObject({ state: 'stopped', reason: null });
  });
  it.each(['config', 'deadline', 'pool', 'cwd', 'directory'] as const)('refuses independently pinned %s drift without writes', field => {
    const f = fixture(); f.write(f.intent); const saved = f.bytes(); const changed = structuredClone(f.scope);
    if (field === 'config') changed.config.maxOutputTokens++;
    if (field === 'deadline') changed.expectedEnrollment.deadlineAt = '2026-09-13T00:00:00.000Z';
    if (field === 'pool') changed.expectedEnrollment.poolDigest = '0'.repeat(64);
    if (field === 'cwd') changed.expectedEnrollment.cwd.ino = '3';
    if (field === 'directory') changed.directory += '/other';
    expect(() => projectEngineeringSuccessorJournal(changed)).toThrow(); expect(f.bytes()).toEqual(saved);
  });
  it.each(['writer', 'staging', 'malformed', 'missing-enrollment'] as const)('withholds %s journal evidence without cleanup', kind => {
    const f = fixture(); f.write(f.intent); const events = join(f.scope.directory, 'events');
    if (kind === 'writer') writeFileSync(join(events, '.records.lock'), 'held', { mode: 0o600 });
    if (kind === 'staging') writeFileSync(join(events, 'staging', '.partial.stage'), 'partial', { mode: 0o600 });
    if (kind === 'malformed') writeFileSync(join(events, 'records', f.intent.id + '.json'), '{}\n', { mode: 0o600 });
    if (kind === 'missing-enrollment') rmSync(join(events, 'records', 'enrollment.json'));
    const saved = f.bytes(); expect(() => projectEngineeringSuccessorJournal(f.scope)).toThrow(); expect(f.bytes()).toEqual(saved);
  });
  it.each(['task', 'attribution', 'orphan', 'stop-prepared', 'admitted-digest'] as const)('rejects %s cross-record corruption', kind => {
    const f = fixture();
    if (kind === 'task') f.write({ ...f.intent, task: { ...f.intent.task, mode: 'workspace-write' } });
    else if (kind === 'orphan') f.write(f.result);
    else {
      f.write(f.intent);
      f.write(kind === 'attribution' ? { ...f.result, intentDigest: '0'.repeat(64) } :
        kind === 'stop-prepared' ? { ...f.result, output: '{"action":"stop"}' } : f.result);
      if (kind === 'stop-prepared' || kind === 'admitted-digest') f.write(f.prepared);
      if (kind === 'admitted-digest') f.write({ ...f.admitted, enrollmentDigest: '2'.repeat(64) });
    }
    const saved = f.bytes(); expect(() => projectEngineeringSuccessorJournal(f.scope)).toThrow(); expect(f.bytes()).toEqual(saved);
  });
});
