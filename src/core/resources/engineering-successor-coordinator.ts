/** Bounded successor intake. Proposal effects use the existing account ledger;
 * engineering effects remain exclusively owned by the existing supervisor. */
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from '../universe/artifacts.js';
import { writeImmutablePrivateRecord } from '../util/immutable-private-record-store.js';
import { pinResourceConsoleProject, matchesResourceConsoleProject } from './console-projects.js';
import { validateResourcePool } from './pool-policy.js';
import { resourceAdmissionPreflight, resourcePoolStatus, runResourceTask, validateResourceTask } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { validateResourceBindings } from './worker.js';
import { waitForResourceCapacity } from './capacity-wait.js';
import type { EngineeringCoordinatorLifecycleReport, ResourceEngineeringSuccessorCoordinatorOptions as Options,
  ResourceEngineeringSuccessorCoordinatorSnapshot as Snapshot, ResourceEngineeringSuccessorEvidence as Evidence } from './engineering-successor-coordinator-types.js';
export type * from './engineering-successor-coordinator-types.js';
import { data, hash, evidence, engineeringSuccessorRecordStore, engineeringSuccessorKey, engineeringSuccessorPrompt,
  readEngineeringSuccessorJournal, validateResourceEngineeringSuccessorCoordinatorConfig, parseResourceEngineeringSuccessorProposal,
  type JournalScope, type DurableRecord, type EnrollmentRecord, type Intent, type Result, type Prepared } from './engineering-successor-store.js';
export { validateResourceEngineeringSuccessorCoordinatorConfig, parseResourceEngineeringSuccessorProposal } from './engineering-successor-store.js';

const HASH = /^[a-f0-9]{64}$/; const MAX_OUTPUT = 16 * 1024;
function fail(message: string): never { throw new ResourceSupervisorError('UNAVAILABLE', message); }

export function createResourceEngineeringSuccessorCoordinator(options: Options): { snapshot(): Snapshot; observationScope(): JournalScope; start(): void; close(): Promise<void> } {
  const required = ['root', 'config', 'pool', 'bindings', 'cwd', 'supervision', 'readAdmissionEvidence', 'host'];
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || required.some(key => !Object.hasOwn(options, key)) ||
    Reflect.ownKeys(options).some(key => typeof key !== 'string' ||
    !['root', 'config', 'pool', 'bindings', 'cwd', 'supervision', 'readAdmissionEvidence', 'host', 'signal', 'onLifecycle'].includes(key) ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) fail('Invalid successor options');
  const config = validateResourceEngineeringSuccessorCoordinatorConfig(options.config); const configDigest = hash(config);
  const root = options.root, cwd = options.cwd, signal = options.signal;
  const onLifecycle = options.onLifecycle;
  if (onLifecycle !== undefined && typeof onLifecycle !== 'function') fail('Invalid successor lifecycle observer');
  for (const path of [root, cwd]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || parse(path).root === path) fail('Invalid successor path');
  if (signal !== undefined && !(signal instanceof AbortSignal) || signal?.aborted) fail('Successor startup cancelled');
  const pool = validateResourcePool(data(options.pool)); const bindings = validateResourceBindings(data(options.bindings), pool); const poolDigest = hash({ pool, bindings });
  if (config.allowedWorkerIds.some(id => !pool.workers.some(row => row.id === id))) fail('Unknown successor worker');
  function method<T extends object, K extends keyof T>(object: T, key: K): T[K] {
    const property = object && Object.getOwnPropertyDescriptor(object, key);
    if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function') fail('Invalid successor host');
    return property.value.bind(object) as T[K];
  }
  const host = { source: method(options.host, 'source'), prepare: method(options.host, 'prepare'), isExecutionStopped: method(options.host, 'isExecutionStopped') };
  const supervision = { snapshot: method(options.supervision, 'snapshot'), admit: method(options.supervision, 'admit') };
  if (typeof options.readAdmissionEvidence !== 'function') fail('Invalid successor admission reader');
  const readAdmissionEvidence = options.readAdmissionEvidence;
  const initial = data<ReturnType<typeof supervision.snapshot>>(supervision.snapshot());
  if (initial.sourceState !== 'healthy' || initial.configId !== config.supervisionId || !HASH.test(initial.configDigest) || !initial.admission ||
    !['idle', 'running', 'paused', 'completed', 'timed-out'].includes(initial.state) || !Number.isFinite(Date.parse(initial.deadlineAt))) fail('Successor requires an available appendable supervisor');
  const cwdBinding = pinResourceConsoleProject({ id: 'proposal', label: 'Proposal workspace', workspace: cwd });
  inspectPrivateDirectory(root);
  const parent = join(root, 'engineering-successors'), directory = join(parent, config.supervisionId);
  for (const path of [parent, directory]) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } inspectPrivateDirectory(path); }
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') fail('Successor coordinator already owned or unavailable');
  const records = engineeringSuccessorRecordStore(directory); let started = false, closing = false, faulted = false;
  let loop: Promise<void> | undefined, closePromise: Promise<void> | undefined, wake: (() => void) | undefined, active: AbortController | undefined;
  let cached: DurableRecord[] = []; const reasons = new Map<string, string>();
  let live: { key: string; state: 'proposing' | 'waiting-for-capacity' | 'preparing' | 'admitting' } | undefined;
  const expected: EnrollmentRecord = { id: 'enrollment', kind: 'enrollment', configDigest, supervisionDigest: initial.configDigest,
    deadlineAt: initial.deadlineAt, poolDigest, cwd: cwdBinding };
  let lifecycle: EngineeringCoordinatorLifecycleReport | undefined;
  function report(state: EngineeringCoordinatorLifecycleReport['state'], reason: EngineeringCoordinatorLifecycleReport['reason'] = null): void {
    if (lifecycle?.state === state && lifecycle.reason === reason || lifecycle?.sequence === Number.MAX_SAFE_INTEGER) return;
    lifecycle = { schemaVersion: 1, supervisionId: config.supervisionId, configDigest, deadlineAt: expected.deadlineAt,
      sequence: (lifecycle?.sequence ?? 0) + 1, reportedAt: new Date().toISOString(), state, reason };
    // Reporting has no authority. Detached values and isolated failures ensure
    // an observer cannot mutate coordinator identity or interrupt its effects.
    try {
      // A void callback may still be implemented by an async function. Do not
      // await it or let its rejection become an effect-worker failure.
      void Promise.resolve(onLifecycle?.({ ...lifecycle })).catch(() => {});
    } catch { /* Keep the original execution path unchanged. */ }
  }
  const deadline = Date.parse(expected.deadlineAt); const monotonicDeadline = performance.now() + Math.max(0, deadline - Date.now());
  const expired = () => Date.now() >= deadline || performance.now() >= monotonicDeadline;
  function reportStopped(): void {
    if (closing || faulted) return;
    if (expired()) report('timed-out', 'deadline-reached');
    else report('held', signal?.aborted ? 'signal-aborted' : 'execution-guard-refused');
  }
  function owns(): boolean {
    try { return !closing && !faulted && !signal?.aborted && ownsLocalStoreLock(acquired.lock) && matchesResourceConsoleProject(cwdBinding); } catch { return false; }
  }
  function ownsMetadata(): boolean {
    try { return !faulted && ownsLocalStoreLock(acquired.lock); } catch { return false; }
  }
  function cheapGuard(): boolean {
    try { return owns() && !expired() && host.isExecutionStopped() === false; } catch { return false; }
  }
  function current() {
    const snapshot = data<ReturnType<typeof supervision.snapshot>>(supervision.snapshot());
    if (snapshot.sourceState !== 'healthy' || snapshot.configId !== config.supervisionId || snapshot.configDigest !== expected.supervisionDigest ||
      snapshot.deadlineAt !== expected.deadlineAt || !snapshot.admission || !['idle', 'running', 'paused', 'completed', 'timed-out'].includes(snapshot.state) ||
      !Array.isArray(snapshot.entries) || snapshot.entries.length > 32) fail('Successor supervision changed');
    return snapshot;
  }
  function fresh(source: Evidence): boolean {
    if (!cheapGuard()) return false;
    try { const snapshot = current(); const row = snapshot.entries.find(row => row.enrollmentId === source.enrollmentId);
      return !snapshot.paused && row?.state === 'completed' && row.enrollmentDigest === source.enrollmentDigest &&
        canonical(evidence(host.source(source.enrollmentId, row.enrollmentDigest))) === canonical(source) && cheapGuard(); } catch { return false; }
  }
  const observationScope = (): JournalScope => data({ directory, config, expectedEnrollment: expected });
  const keyFor = (source: Evidence) => engineeringSuccessorKey(observationScope(), source);
  const prompt = (source: Evidence) => engineeringSuccessorPrompt(observationScope(), source);
  function read(allowMissing = false): DurableRecord[] {
    const result = readEngineeringSuccessorJournal(observationScope(), { allowMissing });
    cached = result.records; return cached;
  }
  function write(row: DurableRecord, source?: Evidence): void {
    const intent = row.kind === 'result' || row.kind === 'prepared' || row.kind === 'admitted'
      ? cached.find((value): value is Intent => value.kind === 'intent' && value.key === row.key) : undefined;
    const fact = row.kind === 'result' || row.kind === 'prepared' || row.kind === 'admitted';
    if (fact && (!intent || row.intentDigest !== hash(intent))) fail('Successor fact attribution changed');
    const recordFact = () => {
      if (!ownsMetadata()) return false;
      if (row.kind !== 'result') return true;
      const currentReceipt = receipt(intent!);
      return currentReceipt?.status === 'completed' && hash(currentReceipt) === row.receiptDigest && currentReceipt.outputDigest === digest(row.output);
    };
    // Metadata enrollment precedes start(), so a host that is intentionally not
    // executing yet may still acquire its immutable identity. No proposal does.
    // Already completed receipt facts survive a later pause/KILL/source change;
    // consuming them for another effect still requires a fresh source guard.
    const disposition = writeImmutablePrivateRecord(records, row, { prepublish: () => fact ? recordFact() : source ? fresh(source) : owns() &&
      current().configDigest === expected.supervisionDigest });
    if (!['recorded', 'replayed'].includes(disposition)) fail('Successor publication unavailable');
    read();
  }
  function receipt(intent: Intent) {
    const row = resourcePoolStatus(root, pool, bindings, []).attempts.find(row => row.id === intent.task.id);
    if (row && (row.taskDigest !== hash(intent.task) || row.poolDigest !== poolDigest || !config.allowedWorkerIds.includes(row.workerId))) fail('Successor task identity changed');
    return row;
  }
  async function advanceWork(intent: Intent, dispatch: boolean): Promise<void> {
    const key = intent.key; reasons.delete(key); let rows = read();
    if (rows.some(row => row.kind === 'admitted' && row.key === key)) return;
    let result = rows.find((row): row is Result => row.kind === 'result' && row.key === key);
    if (!result && !dispatch) { reasons.set(key, 'proposal-output-unresolved'); return; }
    if (!fresh(intent.source)) { reasons.set(key, 'source-or-authority-unavailable'); return; }
    if (!result) {
      // The intent is already durable. Any throw, replay or missing output holds
      // this identity forever; this branch is only reachable on its first call.
      if (receipt(intent)) { reasons.set(key, 'proposal-output-unresolved'); return; }
      active = new AbortController(); const controller = active;
      const proposalDeadline = performance.now() + Math.max(0, Math.min(intent.task.timeoutMs, deadline - Date.now(), monotonicDeadline - performance.now()));
      const proposalGuard = () => !controller.signal.aborted && cheapGuard() && !controller.signal.aborted && performance.now() < proposalDeadline;
      const proposalEvidence = () => {
        if (!proposalGuard()) fail('Successor proposal deadline exhausted');
        const value = readAdmissionEvidence();
        if (!proposalGuard()) fail('Successor proposal deadline exhausted');
        return value;
      };
      const timer = setTimeout(() => controller.abort(), Math.max(1, proposalDeadline - performance.now()));
      try {
        let response: Awaited<ReturnType<typeof runResourceTask>>;
        while (true) {
          // The source was checked before this proposal's clock began. The
          // mandatory post-reservation check below is the next effect boundary;
          // avoid a duplicate deep proof consuming the same bounded timeout.
          if (!proposalGuard()) fail('Successor dispatch stopped');
          live = { key, state: 'proposing' };
          const admission = data<ReturnType<Options['readAdmissionEvidence']>>(proposalEvidence());
          response = await runResourceTask({ root, pool, bindings, ...admission, task: intent.task, signal: controller.signal,
            // The runtime invokes this after releasing its reservation lock;
            // source proof may read the shared ledger here, but never inside it.
            beforeWorkerDispatch: () => proposalGuard() && fresh(intent.source) && proposalGuard(),
            readAdmissionEvidence: proposalEvidence });
          if (response.receipt || response.replayed || !response.plan?.exclusions.some(row => config.allowedWorkerIds.includes(row.workerId) &&
            row.reasons.length === 1 && row.reasons[0] === 'concurrency-exhausted') || controller.signal.aborted) break;
          // Only explicit no-reservation capacity denial can retry while this
          // invocation is alive. Unknown outcomes and restarted intents cannot.
          const waitMs = Math.max(0, Math.min(60_000, Math.floor(deadline - Date.now()), Math.floor(proposalDeadline - performance.now())));
          const waitStarted = performance.now();
          live = { key, state: 'waiting-for-capacity' };
          const waiting = await waitForResourceCapacity({ root, pool, bindings, task: intent.task, signal: controller.signal, waitMs,
            readEvidence: proposalEvidence });
          if (!waiting.ready && !(waitMs > 0 && performance.now() - waitStarted >= waitMs && proposalGuard())) {
            reasons.set(key, 'proposal-capacity-unavailable'); return;
          }
        }
        const settled = receipt(intent);
        if (response.replayed || !settled || settled.status !== 'completed' || !response.receipt || canonical(settled) !== canonical(response.receipt) ||
          response.output === null || Buffer.byteLength(response.output) > MAX_OUTPUT || digest(response.output) !== settled.outputDigest) {
          reasons.set(key, 'proposal-output-unresolved'); return;
        }
        parseResourceEngineeringSuccessorProposal(response.output);
        result = { id: `result-${key}`, kind: 'result', key, intentDigest: hash(intent), receiptDigest: hash(settled), output: response.output };
        write(result, intent.source);
      } finally { clearTimeout(timer); active = undefined; }
    }
    const settled = receipt(intent);
    if (!settled || settled.status !== 'completed' || hash(settled) !== result.receiptDigest || settled.outputDigest !== digest(result.output)) fail('Successor receipt unavailable');
    const proposal = parseResourceEngineeringSuccessorProposal(result.output);
    if (proposal.action === 'stop') return;
    if (!fresh(intent.source)) fail('Successor source changed');
    rows = read(); let prepared = rows.find((row): row is Prepared => row.kind === 'prepared' && row.key === key);
    if (!prepared) {
      live = { key, state: 'preparing' };
      const enrollment = data<Awaited<ReturnType<Options['host']['prepare']>>>(await host.prepare({ id: intent.successorId, profileId: config.profileId,
        name: proposal.name, objective: proposal.objective, source: data(intent.source) }));
      if (enrollment.id !== intent.successorId || enrollment.projectId !== intent.source.projectId || !HASH.test(enrollment.enrollmentDigest)) fail('Successor preparation identity changed');
      prepared = { id: `prepared-${key}`, kind: 'prepared', key, intentDigest: hash(intent), enrollmentId: enrollment.id,
        enrollmentDigest: enrollment.enrollmentDigest, projectId: enrollment.projectId };
      write(prepared, intent.source);
    }
    if (!fresh(intent.source)) fail('Successor source changed');
    const snapshot = current();
    live = { key, state: 'admitting' };
    const admitted = supervision.admit({ expectedRevision: snapshot.revision,
      enrollments: [{ enrollmentId: prepared.enrollmentId, expectedEnrollmentDigest: prepared.enrollmentDigest }] });
    if (admitted.configId !== config.supervisionId || admitted.configDigest !== expected.supervisionDigest || admitted.deadlineAt !== expected.deadlineAt ||
      !admitted.entries.some(row => row.enrollmentId === prepared.enrollmentId && row.enrollmentDigest === prepared.enrollmentDigest)) fail('Successor admission unavailable');
    write({ id: `admitted-${key}`, kind: 'admitted', key, intentDigest: hash(intent), enrollmentDigest: prepared.enrollmentDigest }, intent.source);
  }
  async function advance(intent: Intent, dispatch: boolean): Promise<void> {
    try { await advanceWork(intent, dispatch); }
    finally { if (live?.key === intent.key) live = undefined; }
  }
  async function tick(): Promise<void> {
    if (!cheapGuard()) { reportStopped(); return; }
    const snapshot = current(); if (snapshot.paused) { reportStopped(); return; }
    report('running');
    let rows = read();
    for (const intent of rows.filter((row): row is Intent => row.kind === 'intent')) {
      try { await advance(intent, false); } catch { reasons.set(intent.key, 'successor-evidence-unavailable'); }
      if (!cheapGuard()) { reportStopped(); return; }
    }
    rows = read();
    for (const candidate of snapshot.entries.filter(row => row.state === 'completed')) {
      if (rows.some(row => row.kind === 'intent' && row.source.enrollmentId === candidate.enrollmentId)) continue;
      if (rows.filter(row => row.kind === 'intent').length >= config.maxSuccessors || current().admission!.remainingEnrollments < 1 || !cheapGuard()) break;
      let eligible = false;
      try {
        const admission = data<ReturnType<Options['readAdmissionEvidence']>>(readAdmissionEvidence());
        if (!cheapGuard()) { reportStopped(); return; }
        const plan = resourceAdmissionPreflight(root, pool, bindings, config.allowedWorkerIds, admission);
        eligible = plan.candidates.some(row => config.allowedWorkerIds.includes(row.workerId));
      } catch {
        // Unavailable preflight evidence must not consume an intent or successor
        // slot. The existing poll can reconsider before any proposal is invoked.
      }
      if (!cheapGuard()) { reportStopped(); return; }
      if (!eligible) continue;
      const sourceValue = host.source(candidate.enrollmentId, candidate.enrollmentDigest); if (sourceValue === null) continue;
      const source = evidence(sourceValue);
      if (source.enrollmentId !== candidate.enrollmentId || source.enrollmentDigest !== candidate.enrollmentDigest || !fresh(source)) continue;
      const key = keyFor(source);
      const task = validateResourceTask({ schemaVersion: 1, id: `proposal-${key}`, mode: 'read-only', cwd, prompt: prompt(source),
        allowedWorkerIds: config.allowedWorkerIds, maxOutputTokens: config.maxOutputTokens,
        timeoutMs: Math.max(1, Math.min(config.proposalTimeoutMs, Math.floor(deadline - Date.now()), Math.floor(monotonicDeadline - performance.now()))) });
      const intent: Intent = { id: `intent-${key}`, kind: 'intent', key, source, task, successorId: `successor-${key}` };
      write(intent, source);
      try { await advance(intent, true); } catch { reasons.set(key, 'successor-evidence-unavailable'); }
      rows = read();
    }
  }
  const onAbort = () => { active?.abort(); wake?.(); if (!closing && !faulted) report('held', 'signal-aborted'); };
  try {
    const prior = read(true);
    if (!prior.length) {
      if (config.maxSuccessors > initial.admission.remainingEnrollments) fail('Successor budget exceeds remaining enrollment capacity');
      write(expected);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  } catch (error) { releaseLocalStoreLock(acquired.lock); throw error; }
  report('idle');
  return {
    observationScope,
    snapshot() {
      const intents = cached.filter((row): row is Intent => row.kind === 'intent');
      return { schemaVersion: 1, supervisionId: config.supervisionId, profileId: config.profileId, configDigest, deadlineAt: expected.deadlineAt,
        state: faulted || !closing && !ownsMetadata() ? 'unavailable' : closing ? 'closed' : expired() ? 'timed-out' : started ? 'running' : 'idle', maxSuccessors: config.maxSuccessors,
        entries: intents.map(intent => {
          const result = cached.find((row): row is Result => row.kind === 'result' && row.key === intent.key);
          const state = live?.key === intent.key ? live.state : cached.some(row => row.kind === 'admitted' && row.key === intent.key) ? 'admitted' :
            cached.some(row => row.kind === 'prepared' && row.key === intent.key) ? 'prepared' :
              result ? parseResourceEngineeringSuccessorProposal(result.output).action === 'stop' ? 'stopped' : 'proposed' : 'held';
          return { sourceEnrollmentId: intent.source.enrollmentId, proposalTaskId: intent.task.id, successorId: intent.successorId,
            state, reason: reasons.get(intent.key) ?? (state === 'held' ? 'proposal-output-unresolved' : null) };
        }) };
    },
    start() {
      if (closing || faulted) fail('Successor coordinator unavailable'); if (started) return; started = true;
      report('running');
      loop = (async () => {
        while (!closing && !signal?.aborted && !expired()) {
          try { await tick(); } catch { faulted = true; active?.abort(); report('faulted', 'coordinator-loop-failed'); break; }
          if (closing || signal?.aborted || expired()) break;
          await new Promise<void>(done => { const timer = setTimeout(() => { wake = undefined; done(); }, Math.min(config.pollIntervalMs, Math.max(1, deadline - Date.now())));
            wake = () => { clearTimeout(timer); wake = undefined; done(); }; });
        }
        if (!closing && !faulted) {
          if (expired()) report('timed-out', 'deadline-reached');
          else if (signal?.aborted) report('held', 'signal-aborted');
        }
      })();
    },
    close() {
      if (closePromise) return closePromise; closing = true; active?.abort(); wake?.(); signal?.removeEventListener('abort', onAbort);
      report('closing');
      closePromise = (async () => {
        await loop;
        let uncertain = false;
        try { for (const intent of cached.filter((row): row is Intent => row.kind === 'intent')) {
          const currentReceipt = receipt(intent);
          if (currentReceipt && ['reserved', 'uncertain'].includes(currentReceipt.status)) uncertain = true;
        } } catch { uncertain = true; }
        const released = releaseLocalStoreLock(acquired.lock);
        if (!released) { report('faulted', 'ownership-release-failed'); fail('Successor ownership release unavailable'); }
        if (uncertain) { report('faulted', 'close-unresolved'); fail('Successor closed with unresolved proposal execution'); }
        report('closed');
      })();
      return closePromise;
    },
  };
}
