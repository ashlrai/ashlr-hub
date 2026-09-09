import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, defaultUniverseRoot, digest, inspectPrivateDirectory, privateDirectory } from './artifacts.js';
import { readUniverseCampaign } from './campaign-store.js';
import { readCompletedUniverseCampaignDispatch } from './campaign-dispatch.js';
import { readCompletedCampaignDelivery } from './campaign-delivery-recovery.js';
import { runUniverseCampaignOwned } from './campaign.js';
import { acquireUniverseExecution } from './execution.js';
import { readUniverseCampaignReadiness, type UniverseCampaignReadiness } from './campaign-readiness.js';
import { deliverCompletedUniverseCampaign, preflightUniverseCampaignDelivery, validateUniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import { readUniverseDeliveries } from './delivery.js';
import { readUniversePortfolioPlan, validateUniversePortfolioDefinition } from './portfolio-plan.js';
import { appendPortfolioControllerEvent, foldPortfolioController, portfolioControllerDirectory,
  portfolioControllerPrerequisites, readPortfolioControllerEvents } from './portfolio-controller-store.js';
import type { UniversePortfolioRunOptions } from './portfolio.js';
import type { PortfolioControllerEnrollment, PortfolioControllerEvent, PortfolioControllerPin,
  UniversePortfolioControllerReport } from './portfolio-controller-types.js';
import type { UniverseStoreOptions } from './types.js';

function matches(pin: PortfolioControllerPin, report: UniverseCampaignReadiness): boolean {
  return report.sourceState === 'healthy' && report.expectedIdentity !== null && report.recordsDigest !== null &&
    report.expectedIdentity.universeId === pin.universeId && report.expectedIdentity.definitionDigest === pin.definitionDigest &&
    report.expectedIdentity.manifestDigest === pin.manifestDigest && report.expectedIdentity.comparatorDigest === pin.comparatorDigest;
}

/** Only untouched ready work can wait; another campaign session is not adopted. */
function waitable(report: UniverseCampaignReadiness): boolean {
  return report.observedState === 'ready' && report.disposition === 'owned';
}

function empty(id: string, state: 'missing' | 'degraded', at: string): UniversePortfolioControllerReport {
  return { schemaVersion: 1, controllerId: id, definitionDigest: null, sourceState: state, status: 'unavailable',
    createdAt: null, deadlineAt: null, observedAt: at, outcomes: [], reasons: [state === 'missing' ? 'controller-missing' : 'controller-evidence-unavailable'] };
}

/** A projection validates source receipts, not process liveness; unresolved intents stay unresolved. */
function inspect(id: string, events: PortfolioControllerEvent[], root: string, at: string): UniversePortfolioControllerReport {
  if (canonical(readPortfolioControllerEvents(portfolioControllerDirectory(id, { root }))) !== canonical(events)) {
    throw new Error('Controller ledger changed during observation');
  }
  const folded = foldPortfolioController(events);
  if (folded.first.enrollment.definition.id !== id) throw new Error('Controller identity changed');
  const enrollment = folded.first.enrollment;
  const reasons: string[] = [];
  if (at < folded.highWaterAt) reasons.push('controller-clock-rollback');
  const outcomes = [...folded.states.values()].map((row) => {
    if (row.state === 'in-flight') return { ...row };
    const pin = folded.pins.get(row.campaignId)!;
    const readiness = readUniverseCampaignReadiness(row.campaignId, { root });
    const expectedRecords = folded.settlements.get(row.campaignId)?.recordsDigest ?? pin.recordsDigest;
    if (!matches(pin, readiness) || readiness.expectedIdentity!.summaryDigest !== row.campaignDigest || readiness.recordsDigest !== expectedRecords ||
        row.state === 'completed' && readiness.observedState !== 'completed') {
      reasons.push(`${row.campaignId}:campaign-evidence-changed`);
      return { ...row, state: 'held' as const, reasonCode: 'campaign-evidence-changed' };
    }
    if (row.deliveryDigest !== null) {
      const target = enrollment.deliveryPlan?.deliveries.find((item) => item.campaignId === row.campaignId);
      const deliveries = readUniverseDeliveries(pin.universeId, { root });
      if (!target || deliveries.sourceState !== 'healthy' || !deliveries.deliveries.some((receipt) => receipt.status === 'delivered' &&
          receipt.branch === target.branch && receipt.baseCommit === target.baseCommit && digest(canonical(receipt)) === row.deliveryDigest)) {
        reasons.push(`${row.campaignId}:delivery-evidence-changed`);
        return { ...row, state: 'held' as const, reasonCode: 'delivery-evidence-changed' };
      }
    }
    return { ...row, ...(row.state === 'pending' && pin.dispatch === 'campaign' && waitable(readiness)
      ? { reasonCode: 'waiting-for-universe-owner' } : {}) };
  });
  // Declared order need not be topological. Propagate holds to a fixed point
  // without changing either the stored enrollment or scheduling priority.
  for (let pass = 0; pass < outcomes.length; pass++) {
    let changed = false;
    for (const row of outcomes) if (row.state === 'pending') {
      const prerequisites = portfolioControllerPrerequisites(enrollment, row.campaignId)
        .map((dependency) => outcomes.find((item) => item.campaignId === dependency)!);
      if (prerequisites.some((dependency) => dependency.state === 'held')) {
        row.state = 'held'; row.reasonCode = 'dependency-held'; changed = true;
      } else if (prerequisites.some((dependency) => dependency.state !== 'completed')) row.reasonCode = 'waiting-for-dependencies';
    }
    if (!changed) break;
  }
  const sourceState = reasons.length ? 'degraded' : 'healthy';
  return { schemaVersion: 1, controllerId: id, definitionDigest: enrollment.definitionDigest, sourceState,
    status: sourceState === 'degraded' ? 'unavailable' : outcomes.every((row) => row.state === 'completed') ? 'completed' :
      at >= enrollment.deadlineAt ? 'timed-out' : 'incomplete', createdAt: folded.first.at, deadlineAt: enrollment.deadlineAt,
    observedAt: at, outcomes, reasons };
}

/** Read-only: does not initialize storage, settle intents, acquire ownership or run campaigns. */
export function readUniversePortfolioController(id: string, options: UniverseStoreOptions = {}): UniversePortfolioControllerReport {
  const root = resolve(options.root ?? defaultUniverseRoot());
  const directory = portfolioControllerDirectory(id, { root });
  const at = new Date().toISOString();
  try {
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(id, 'missing', at); throw error; }
    inspectPrivateDirectory(root); inspectPrivateDirectory(join(root, 'portfolios'));
    return inspect(id, readPortfolioControllerEvents(directory), root, at);
  } catch { return empty(id, 'degraded', at); }
}

/**
 * Checkpointed explicit DAG, not a resident daemon. An unresolved dispatch consumes
 * its concurrency slot and can never be reissued by this controller. New dispatch
 * identities permit receipt-only recovery; an arbitrary later completion does not.
 */
export async function runUniversePortfolioController(input: unknown, options: UniversePortfolioRunOptions = {}): Promise<UniversePortfolioControllerReport> {
  const startedAt = new Date().toISOString();
  const startedMonotonic = performance.now();
  const definition = validateUniversePortfolioDefinition(input);
  const deliveryPlan = options.deliveryPlan === undefined ? null : validateUniverseCampaignDeliveryPlan(options.deliveryPlan,
    definition.tasks.map((task) => task.campaignId));
  const root = resolve(options.root ?? defaultUniverseRoot());
  const resourceRuntime = options.resourceRuntime;
  const signal = options.signal;
  const directory = portfolioControllerDirectory(definition.id, { root });
  if (signal?.aborted) return { ...readUniversePortfolioController(definition.id, { root }), status: 'cancelled' };
  inspectPrivateDirectory(root);
  for (const path of [join(root, 'portfolios'), directory]) {
    try { privateDirectory(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; inspectPrivateDirectory(path); }
  }
  const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0, { anchorPath: directory, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') {
    const report = readUniversePortfolioController(definition.id, { root });
    return { ...report, reasons: [...report.reasons, acquired.state === 'contended' ? 'controller-owned' : 'controller-ownership-unavailable'] };
  }
  const controller = new AbortController();
  const active = new Map<string, Promise<void>>();
  let stopped: 'cancelled' | 'timed-out' | 'unavailable' | null = null;
  const errors: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let events: PortfolioControllerEvent[] = [];
  let deadlineMonotonic = Infinity;
  const halt = (status: NonNullable<typeof stopped>, reason?: string): void => {
    stopped ??= status; if (reason && !errors.includes(reason)) errors.push(reason); controller.abort();
  };
  const cancel = (): void => halt('cancelled');
  const owned = (): void => { if (!ownsLocalStoreLock(acquired.lock)) throw new Error('Controller execution ownership lost'); };
  const stopping = (): boolean => {
    if (signal?.aborted) cancel();
    const now = new Date().toISOString();
    const folded = foldPortfolioController(events);
    if (now < folded.highWaterAt) halt('unavailable', 'controller-clock-rollback');
    if (now >= folded.first.enrollment.deadlineAt || performance.now() >= deadlineMonotonic) halt('timed-out');
    try { owned(); } catch { halt('unavailable', 'controller-ownership-lost'); }
    return controller.signal.aborted;
  };
  const append = (event: Parameters<typeof appendPortfolioControllerEvent>[1]): void => {
    owned();
    if (events.length && canonical(readPortfolioControllerEvents(directory)) !== canonical(events)) throw new Error('Controller ledger changed before append');
    events = appendPortfolioControllerEvent(directory, event);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    try { lstatSync(join(directory, 'ledger')); events = readPortfolioControllerEvents(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const plan = readUniversePortfolioPlan(definition, { root });
      if (plan.sourceState !== 'healthy') throw new Error('Controller requires healthy fixed campaign enrollment');
      const deliveryIds = new Set(deliveryPlan?.deliveries.map((row) => row.campaignId));
      const pins = plan.nodes.map((node): PortfolioControllerPin => {
        const report = readUniverseCampaignReadiness(node.campaignId, { root });
        if (report.sourceState !== 'healthy' || !report.expectedIdentity || !report.recordsDigest ||
            report.expectedIdentity.summaryDigest !== digest(canonical(node.campaign))) throw new Error('Campaign changed during controller enrollment');
        const completed = report.observedState === 'completed';
        const runnable = report.automaticAction === 'run' || waitable(report);
        return { campaignId: node.campaignId, universeId: report.expectedIdentity.universeId,
          definitionDigest: report.expectedIdentity.definitionDigest, manifestDigest: report.expectedIdentity.manifestDigest,
          comparatorDigest: report.expectedIdentity.comparatorDigest, campaignDigest: report.expectedIdentity.summaryDigest,
          recordsDigest: report.recordsDigest,
          initialState: completed && !deliveryIds.has(node.campaignId) ? 'completed' : completed || runnable ? 'pending' : 'held',
          dispatch: completed ? deliveryIds.has(node.campaignId) ? 'delivery' : 'none' : runnable ? 'campaign' : 'none',
          reasonCode: completed ? deliveryIds.has(node.campaignId) ? 'delivery-pending' : 'preexisting-completion' : runnable ? 'never-dispatched' : report.reasonCode };
      });
      const refs = new Set<string>();
      for (const target of deliveryPlan?.deliveries ?? []) {
        const preflight = preflightUniverseCampaignDelivery(target.campaignId, { root, delivery: target });
        if (digest(canonical(preflight.campaign)) !== pins.find((pin) => pin.campaignId === target.campaignId)!.campaignDigest) {
          throw new Error('Campaign changed during controller delivery preflight');
        }
        const ref = canonical([preflight.repo, target.branch]);
        if (refs.has(ref)) throw new Error('Controller delivery targets must be unique');
        refs.add(ref);
      }
      const enrollment: PortfolioControllerEnrollment = { definition, deliveryPlan, definitionDigest: digest(canonical(definition)), pins,
        deadlineAt: new Date(Date.parse(startedAt) + definition.maxDurationMs).toISOString() };
      append({ kind: 'created', at: startedAt, enrollment });
    }
    const initial = foldPortfolioController(events);
    const enrollment = initial.first.enrollment;
    if (canonical(enrollment.definition) !== canonical(definition) || canonical(enrollment.deliveryPlan) !== canonical(deliveryPlan)) {
      throw new Error('Controller definition or delivery plan differs from its fixed enrollment');
    }
    deadlineMonotonic = startedMonotonic + Math.max(0, Date.parse(enrollment.deadlineAt) - Date.parse(startedAt));
    const initialReport = inspect(definition.id, events, root, new Date().toISOString());
    if (initialReport.sourceState !== 'healthy' || initialReport.status === 'completed') return initialReport;
    // Recovery observes already completed effects, including after the original
    // deadline. It cannot launch workers, deliver branches, or renew admission.
    for (const [campaignId, intent] of initial.intentEvents) {
      if (initial.states.get(campaignId)?.state !== 'in-flight' || !intent.dispatchId) continue;
      const pin = initial.pins.get(campaignId)!;
      if (pin.dispatch !== 'campaign') continue;
      if (signal?.aborted) { cancel(); break; }
      owned();
      const proof = readCompletedUniverseCampaignDispatch(campaignId, { dispatchId: intent.dispatchId, intentAt: intent.at,
        universeId: pin.universeId, definitionDigest: pin.definitionDigest, manifestDigest: pin.manifestDigest,
        comparatorDigest: pin.comparatorDigest, recordsDigest: pin.recordsDigest }, { root });
      if (!proof) continue;
      const target = deliveryPlan?.deliveries.find((row) => row.campaignId === campaignId);
      const delivery = target ? readCompletedCampaignDelivery(proof.campaign, target, { root }) : null;
      if (target && !delivery) { errors.push(`${campaignId}:reconciliation-delivery-unavailable`); continue; }
      const current = readUniverseCampaignReadiness(campaignId, { root });
      if (!matches(pin, current) || current.recordsDigest !== proof.recordsDigest ||
          current.expectedIdentity!.summaryDigest !== digest(canonical(proof.campaign))) continue;
      if (signal?.aborted) { cancel(); break; }
      try {
        append({ kind: 'settled', at: new Date().toISOString(), recordsDigest: proof.recordsDigest,
          outcome: { campaignId, state: 'completed', attempted: true, reasonCode: 'completed-dispatch-reconciled',
            campaignDigest: current.expectedIdentity!.summaryDigest, deliveryDigest: delivery ? digest(canonical(delivery)) : null } });
      } catch { halt('unavailable', 'controller-reconciliation-persistence-failed'); break; }
    }
    const recoveredReport = inspect(definition.id, events, root, new Date().toISOString());
    if (stopped || recoveredReport.sourceState !== 'healthy' || recoveredReport.status === 'completed') {
      return { ...recoveredReport, ...(stopped ? { status: stopped } : {}), reasons: [...recoveredReport.reasons, ...errors] };
    }
    if (stopping()) return { ...recoveredReport, status: stopped!, reasons: [...recoveredReport.reasons, ...errors] };
    append({ kind: 'observed', at: new Date().toISOString() });
    timer = setTimeout(() => halt('timed-out'), Math.max(1, deadlineMonotonic - performance.now()));
    poll = setInterval(stopping, 250);
    const plan = readUniversePortfolioPlan(definition, { root });
    const targets = new Map(deliveryPlan?.deliveries.map((row) => [row.campaignId, row]));
    const launch = (campaignId: string, admitted: UniverseCampaignReadiness, executionLock?: LocalStoreLock): void => {
      const pin = initial.pins.get(campaignId)!;
      let dispatchId: string | undefined;
      try {
        dispatchId = pin.dispatch === 'campaign' ? randomUUID() : undefined;
        append({ kind: 'intent', at: new Date().toISOString(), campaignId, ...(dispatchId ? { dispatchId } : {}) });
      }
      catch (error) { releaseLocalStoreLock(executionLock); throw error; }
      const work = Promise.resolve().then(async () => {
        try {
          let result;
          try {
            if (stopping()) return;
            result = pin.dispatch === 'campaign' ? await runUniverseCampaignOwned(campaignId, { root, signal: controller.signal,
              dispatchId,
              ...(resourceRuntime === undefined ? {} : { resourceRuntime }),
              expectedIdentity: { ...admitted.expectedIdentity!, recordsDigest: admitted.recordsDigest! } }, executionLock!) : readUniverseCampaign(campaignId, { root });
          } finally {
            // Delivery acquires its own execution lease. Never retain the
            // campaign lease across that separate handoff or any early return.
            releaseLocalStoreLock(executionLock);
          }
          let current = readUniverseCampaignReadiness(campaignId, { root });
          if (!matches(pin, current) || current.expectedIdentity!.summaryDigest !== digest(canonical(result))) throw new Error('Runner settlement changed');
          const settledRecordsDigest = current.recordsDigest;
          let deliveryDigest: string | null = null;
          let reasonCode = result.state === 'completed' ? 'campaign-completed' : 'campaign-held';
          let completed = result.state === 'completed';
          const target = targets.get(campaignId);
          if (target && completed) {
            if (stopping()) { completed = false; reasonCode = 'delivery-not-attempted'; }
            else {
              const delivered = await deliverCompletedUniverseCampaign(campaignId, { root, delivery: target, signal: controller.signal,
                deadlineMonotonicMs: deadlineMonotonic, expectedIdentity: { ...current.expectedIdentity!, recordsDigest: current.recordsDigest! } });
              if (digest(canonical(delivered.campaign)) !== current.expectedIdentity!.summaryDigest) throw new Error('Delivery campaign evidence changed');
              completed = delivered.delivery.status === 'delivered';
              reasonCode = completed ? 'campaign-and-delivery-completed' : 'delivery-withheld';
              if (delivered.delivery.status === 'delivered') {
                const receipts = readUniverseDeliveries(pin.universeId, { root });
                deliveryDigest = digest(canonical(delivered.delivery.receipt));
                if (delivered.delivery.receipt.universeId !== pin.universeId || delivered.delivery.receipt.branch !== target.branch ||
                    delivered.delivery.receipt.baseCommit !== target.baseCommit || delivered.delivery.receipt.status !== 'delivered' ||
                    receipts.sourceState !== 'healthy' || !receipts.deliveries.some((receipt) => digest(canonical(receipt)) === deliveryDigest)) {
                  throw new Error('Delivery receipt was not durably verified');
                }
              }
            }
          }
          current = readUniverseCampaignReadiness(campaignId, { root });
          if (!matches(pin, current) || current.expectedIdentity!.summaryDigest !== digest(canonical(result)) ||
              current.recordsDigest !== settledRecordsDigest) throw new Error('Campaign changed before settlement');
          try {
            append({ kind: 'settled', at: new Date().toISOString(), recordsDigest: current.recordsDigest!,
              outcome: { campaignId, state: completed ? 'completed' : 'held', attempted: pin.dispatch === 'campaign',
                reasonCode, campaignDigest: current.expectedIdentity!.summaryDigest, deliveryDigest } });
          } catch { halt('unavailable', 'controller-settlement-persistence-failed'); }
        } catch {
          // A thrown runner/delivery may have made progress. Leave the durable
          // intent unresolved. Only an exact dispatch-linked completed receipt
          // may close it during a later invocation; workers are never replayed.
          errors.push(`${campaignId}:dispatch-unsettled`);
        }
      }).finally(() => { active.delete(campaignId); });
      active.set(campaignId, work);
    };
    while (true) {
      let waitingForOwner = false;
      if (!stopping()) {
        const report = inspect(definition.id, events, root, new Date().toISOString());
        if (report.sourceState !== 'healthy') halt('unavailable', 'controller-source-evidence-changed');
        else for (const campaignId of plan.topologicalOrder) {
          const folded = foldPortfolioController(events);
          if (stopping() || [...folded.states.values()].filter((row) => row.state === 'in-flight').length >= definition.maxParallel) break;
          if (folded.states.get(campaignId)?.state !== 'pending' || portfolioControllerPrerequisites(enrollment, campaignId)
            .some((dependency) => folded.states.get(dependency)?.state !== 'completed')) continue;
          const pin = folded.pins.get(campaignId)!;
          const admitted = readUniverseCampaignReadiness(campaignId, { root });
          if (!matches(pin, admitted) || admitted.expectedIdentity!.summaryDigest !== pin.campaignDigest || admitted.recordsDigest !== pin.recordsDigest) {
            halt('unavailable', 'controller-admission-evidence-changed'); break;
          }
          if (pin.dispatch === 'campaign' && admitted.automaticAction !== 'run' && !waitable(admitted) || pin.dispatch === 'delivery' && admitted.observedState !== 'completed') continue;
          if (pin.dispatch === 'campaign' && admitted.resourceRuntimeRequired && resourceRuntime === undefined) {
            const reason = `${campaignId}:resource-runtime-required`;
            if (!errors.includes(reason)) errors.push(reason);
            continue;
          }
          // Fresh dependency receipts are checked again after potentially slow
          // campaign source reads, immediately before durable dispatch intent.
          if (inspect(definition.id, events, root, new Date().toISOString()).sourceState !== 'healthy') {
            halt('unavailable', 'controller-dependency-evidence-changed'); break;
          }
          if (stopping()) break;
          if (pin.dispatch === 'campaign' && waitable(admitted)) { waitingForOwner = true; continue; }
          let executionLock: LocalStoreLock | undefined;
          if (pin.dispatch === 'campaign') {
            let execution;
            try { execution = acquireUniverseExecution(pin.universeId, { root }); }
            catch { halt('unavailable', 'campaign-execution-ownership-unavailable'); break; }
            if (execution.state === 'contended') { waitingForOwner = true; continue; }
            if (execution.state !== 'acquired') { halt('unavailable', 'campaign-execution-ownership-unavailable'); break; }
            executionLock = execution.lock;
          }
          try {
            // The exact campaign CAS is read under the lease passed into the
            // runner, closing the probe/release/reacquire race before intent.
            const current = readUniverseCampaignReadiness(campaignId, { root });
            if (!matches(pin, current) || current.expectedIdentity!.summaryDigest !== pin.campaignDigest || current.recordsDigest !== pin.recordsDigest) {
              halt('unavailable', 'controller-admission-evidence-changed'); break;
            }
            if (pin.dispatch === 'campaign' && current.automaticAction !== 'run') {
              if (waitable(current)) waitingForOwner = true;
              continue;
            }
            if (inspect(definition.id, events, root, new Date().toISOString()).sourceState !== 'healthy') {
              halt('unavailable', 'controller-dependency-evidence-changed'); break;
            }
            if (stopping()) break;
            const transferred = executionLock;
            executionLock = undefined;
            launch(campaignId, current, transferred);
          } finally { releaseLocalStoreLock(executionLock); }
        }
      }
      if (!active.size && (!waitingForOwner || controller.signal.aborted)) break;
      if (!waitingForOwner) {
        // Active workers already inherit cancellation and the deadline timer.
        // Without contention, their settlement is the only useful queue wakeup.
        await Promise.race(active.values());
        continue;
      }
      // A bounded disposable wakeup observes lease release even while another
      // branch runs. Polling does not append records or renew any allowance.
      let wake: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const delay = new Promise<void>((resolveWait) => {
        abort = resolveWait;
        wake = setTimeout(resolveWait, Math.max(1, Math.min(250, deadlineMonotonic - performance.now())));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) resolveWait();
      });
      try {
        if (controller.signal.aborted) await Promise.allSettled(active.values());
        else await Promise.race([...active.values(), delay]);
      } finally {
        clearTimeout(wake);
        if (abort) controller.signal.removeEventListener('abort', abort);
      }
    }
    stopping();
    const result = inspect(definition.id, events, root, new Date().toISOString());
    return { ...result, ...(stopped ? { status: stopped } : {}), reasons: [...result.reasons, ...errors] };
  } finally {
    controller.abort();
    await Promise.allSettled(active.values());
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    signal?.removeEventListener('abort', cancel);
    releaseLocalStoreLock(acquired.lock);
  }
}
