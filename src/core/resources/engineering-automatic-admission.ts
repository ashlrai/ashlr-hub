/** Recover only explicit ordinary-registration obligations within their original queue budget. */
import { ResourceEngineeringAutomaticAdmissionOwnershipError, type ResourceConsoleEngineeringPreparationOwner } from './console-engineering-preparation.js';
import type { ResourceConsoleEngineeringSupervisor } from './console-engineering-supervisor.js';
import { validateResourceEngineeringAutomaticAdmission } from './engineering-preparation-registry.js';
import { ResourceSupervisorError } from './pool-supervisor.js';

type Preparation = {
  prepareAutomatically(...args: Parameters<ResourceConsoleEngineeringPreparationOwner['prepareAutomatically']>):
    ReturnType<ResourceConsoleEngineeringPreparationOwner['prepareAutomatically']> | Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['prepareAutomatically']>>;
  pendingAutomaticAdmissions(...args: Parameters<ResourceConsoleEngineeringPreparationOwner['pendingAutomaticAdmissions']>):
    ReturnType<ResourceConsoleEngineeringPreparationOwner['pendingAutomaticAdmissions']> | Promise<ReturnType<ResourceConsoleEngineeringPreparationOwner['pendingAutomaticAdmissions']>>;
};
type Hold = 'binding-changed' | 'evidence-unavailable' | 'verification-pending' | 'capacity' | 'admission-unavailable';
export interface ResourceEngineeringAutomaticAdmissionStatus {
  schemaVersion: 1; supervisionId: string; configDigest: string; deadlineAt: string;
  sampledAt: string | null; state: 'idle' | 'reconciling' | 'ready' | 'held' | 'closed';
  reason: 'admission-unavailable' | 'capacity' | null;
  pending: Array<{ enrollmentId: string; enrollmentDigest: string; reason: Hold }>;
}
export function createResourceEngineeringAutomaticAdmission(options: {
  preparation: Preparation; supervision: Pick<ResourceConsoleEngineeringSupervisor, 'snapshot' | 'admit'>;
  isClosing(): boolean;
  onFatal(): void;
}) {
  const prepare = options.preparation.prepareAutomatically.bind(options.preparation);
  const pending = options.preparation.pendingAutomaticAdmissions.bind(options.preparation);
  const snapshot = options.supervision.snapshot.bind(options.supervision), admit = options.supervision.admit.bind(options.supervision);
  const isClosing = options.isClosing;
  const onFatal = options.onFatal;
  const initial = snapshot();
  if (initial.admission?.autoAdmitPrepared !== true) throw new ResourceSupervisorError('CONFLICT', 'Automatic admission is not enabled');
  const binding = validateResourceEngineeringAutomaticAdmission({ schemaVersion: 1, supervisionId: initial.configId,
    configDigest: initial.configDigest, deadlineAt: initial.deadlineAt });
  let closed = false, timer: ReturnType<typeof setInterval> | undefined, inflight: Promise<void> | undefined;
  let status: ResourceEngineeringAutomaticAdmissionStatus = { ...binding, sampledAt: null, state: 'idle', reason: null, pending: [] };
  function current() {
    if (closed || isClosing()) throw new ResourceSupervisorError('UNAVAILABLE', 'Automatic admission is closing');
    const value = snapshot();
    if (value.configId !== binding.supervisionId || value.configDigest !== binding.configDigest || value.deadlineAt !== binding.deadlineAt ||
        value.admission?.autoAdmitPrepared !== true || value.sourceState !== 'healthy' || !['idle', 'running', 'paused', 'completed'].includes(value.state) ||
        Date.now() >= Date.parse(binding.deadlineAt)) {
      throw new ResourceSupervisorError('UNAVAILABLE', 'Automatic admission budget unavailable');
    }
    return value;
  }
  function reconcile(preferredEnrollmentId?: string): Promise<void> {
    if (inflight) return inflight;
    if (closed || isClosing()) return Promise.resolve();
    status = { ...status, state: 'reconciling' };
    inflight = Promise.resolve().then(async () => {
      const held: ResourceEngineeringAutomaticAdmissionStatus['pending'] = [];
      try {
        const before = current();
        // A full queue cannot accept a new member. Do not repeatedly reconstruct
        // up to 32 bundle proofs merely to rediscover its durable capacity cap.
        if (before.admission!.remainingEnrollments < 1) {
          status = { ...status, sampledAt: new Date().toISOString(), state: 'held', reason: 'capacity',
            pending: status.pending.filter(row => !before.entries.some(entry => entry.enrollmentId === row.enrollmentId && entry.enrollmentDigest === row.enrollmentDigest)) }; return;
        }
        const rows = await pending(binding, before.entries.map(row => ({ enrollmentId: row.enrollmentId, enrollmentDigest: row.enrollmentDigest })), preferredEnrollmentId);
        for (const row of rows) {
          if (closed || isClosing()) break;
          if (row.reason) { held.push({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest, reason: row.reason }); continue; }
          try {
            const latest = current();
            admit({ expectedRevision: latest.revision, enrollments: [{ enrollmentId: row.enrollmentId, expectedEnrollmentDigest: row.expectedEnrollmentDigest }] });
          } catch (error) {
            held.push({ enrollmentId: row.enrollmentId, enrollmentDigest: row.expectedEnrollmentDigest,
              reason: error instanceof ResourceSupervisorError && error.code === 'CAPACITY' ? 'capacity' : 'admission-unavailable' });
          }
        }
        if (!closed && !isClosing()) status = { ...status, sampledAt: new Date().toISOString(), state: held.length ? 'held' : 'ready', reason: null, pending: held };
      } catch (error) {
        if (closed || isClosing()) return;
        if (error instanceof ResourceEngineeringAutomaticAdmissionOwnershipError) {
          closed = true; if (timer) clearInterval(timer); status = { ...status, state: 'closed', reason: 'admission-unavailable' }; onFatal();
        } else if (!closed && !isClosing()) status = { ...status, sampledAt: new Date().toISOString(), state: 'held', reason: 'admission-unavailable' };
      }
    }).finally(() => { inflight = undefined; });
    return inflight;
  }
  return {
    reconcile,
    snapshot(): ResourceEngineeringAutomaticAdmissionStatus { return structuredClone(status); },
    start() {
      if (closed || timer) return;
      timer = setInterval(() => { void reconcile(); }, 3000); timer.unref(); void reconcile();
    },
    async prepare(input: unknown) {
      current();
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try { prepared = await prepare(input, binding); }
      catch (error) { void reconcile(); throw error; }
      // A pass already in progress may predate this publication. Complete it,
      // then verify this exact newly prepared obligation with priority once.
      if (inflight) await inflight;
      await reconcile(prepared.enrollment.id);
      let state: 'admitted' | 'unavailable' = 'unavailable';
      try { if (current().entries.some(row => row.enrollmentId === prepared.enrollment.id && row.enrollmentDigest === prepared.enrollment.enrollmentDigest)) state = 'admitted'; } catch { /* Retain the durable obligation and safe partial result. */ }
      return { ...prepared, automaticAdmission: { state, supervisionId: binding.supervisionId } };
    },
    async close() { closed = true; if (timer) clearInterval(timer); await inflight; status = { ...status, state: 'closed' }; },
  };
}
