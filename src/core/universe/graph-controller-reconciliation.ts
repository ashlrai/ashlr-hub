/** Graph-owned acknowledgment of completed effects, never authority to execute work. */
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { readCompletedUniverseCampaignDispatch } from './campaign-dispatch.js';
import { readCompletedCampaignDelivery } from './campaign-delivery-recovery.js';
import type { UniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import { readUniverseCampaignReadiness } from './campaign-readiness.js';
import { readUniversePortfolioController } from './portfolio-controller.js';
import { appendPortfolioControllerEvent, foldPortfolioController, portfolioControllerDirectory,
  readPortfolioControllerEvents, validatePortfolioControllerGraphDispatch } from './portfolio-controller-store.js';
import type { PortfolioControllerEvent, PortfolioControllerGraphDispatch, PortfolioControllerPin,
  UniversePortfolioControllerReport } from './portfolio-controller-types.js';
import type { UniversePortfolioDefinition } from './portfolio-types.js';

type CampaignPin = Pick<PortfolioControllerPin, 'campaignId' | 'universeId' | 'definitionDigest' | 'manifestDigest' | 'comparatorDigest'>;
export interface GraphControllerReconciliationOptions {
  root: string;
  definition: UniversePortfolioDefinition;
  deliveryPlan: UniverseCampaignDeliveryPlan;
  graphDispatch: PortfolioControllerGraphDispatch;
  pins: CampaignPin[];
  /** Factory-owned checks over captured host/runtime pins and parent ownership/KILL. */
  checkEnrollment: () => void;
  isExecutionStopped: () => boolean;
  deadlineMonotonicMs?: number;
}

/**
 * Only existing, exactly linked dispatches can be acknowledged. This bounded,
 * synchronous path has no enrollment, campaign, evaluator, delivery or ref writer.
 * Missing evidence and every contention/drift/stop leave the intent unresolved.
 */
export function reconcileGraphControllerDispatch(options: GraphControllerReconciliationOptions): UniversePortfolioControllerReport | null {
  let release: (() => boolean) | undefined;
  try {
    const directory = portfolioControllerDirectory(options.definition.id, { root: options.root });
    inspectPrivateDirectory(options.root); inspectPrivateDirectory(join(options.root, 'portfolios')); inspectPrivateDirectory(directory);
    // Validate before acquiring ownership, including the original parent guard.
    const guard = reconciliationGuard(options);
    guard(readPortfolioControllerEvents(directory));
    const acquired = acquireLocalStoreLockWithOutcome(join(directory, '.execution.lock'), 0,
      { anchorPath: directory, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return null;
    release = () => releaseLocalStoreLock(acquired.lock);
    const owned = (): void => { if (!ownsLocalStoreLock(acquired.lock)) throw new Error('Reconciliation ownership lost'); };
    const events = reconcileGraphControllerDispatchOwned(options, readPortfolioControllerEvents(directory), owned);
    guard(events); owned();
    const report = readUniversePortfolioController(options.definition.id, { root: options.root });
    guard(events); owned();
    const released = release(); release = undefined;
    return released && report.sourceState === 'healthy' && report.status === 'completed' && report.reasons.length === 0 ? report : null;
  } catch { return null; }
  finally { release?.(); }
}

function reconciliationGuard(options: GraphControllerReconciliationOptions): (events: readonly PortfolioControllerEvent[]) => void {
  const link = validatePortfolioControllerGraphDispatch(options.graphDispatch);
  const deadline = options.deadlineMonotonicMs ?? performance.now() + 10_000;
  if (!Number.isFinite(deadline) || deadline < 0) throw new Error('Invalid reconciliation deadline');
  return (events: readonly PortfolioControllerEvent[]): void => {
    if (performance.now() >= deadline || options.isExecutionStopped()) throw new Error('Reconciliation stopped');
    const folded = foldPortfolioController([...events]); const enrollment = folded.first.enrollment;
    const now = new Date().toISOString();
    if (now < folded.highWaterAt ||
        canonical(enrollment.graphDispatch) !== canonical(link) ||
        canonical(enrollment.definition) !== canonical(options.definition) ||
        enrollment.definitionDigest !== digest(canonical(options.definition)) ||
        canonical(enrollment.deliveryPlan) !== canonical(options.deliveryPlan) ||
        canonical(enrollment.pins.map(({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }) =>
          ({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }))) !== canonical(options.pins)) {
      throw new Error('Reconciliation enrollment unavailable');
    }
    options.checkEnrollment();
    if (performance.now() >= deadline || options.isExecutionStopped()) {
      throw new Error('Reconciliation stopped');
    }
  };
}

/**
 * Internal acknowledgment core for a caller already holding the controller lease.
 * It never acquires/releases that lease or admits work. Pending preservation is
 * only for the graph-owned runner, which separately validates untouched pins.
 * A throw may follow successful earlier acknowledgments; callers must reread.
 */
export function reconcileGraphControllerDispatchOwned(options: GraphControllerReconciliationOptions,
  captured: readonly PortfolioControllerEvent[], owned: () => void, preservePending = false): PortfolioControllerEvent[] {
  const directory = portfolioControllerDirectory(options.definition.id, { root: options.root });
  const guard = reconciliationGuard(options);
  let events = [...captured]; guard(events); owned();
  if (canonical(readPortfolioControllerEvents(directory)) !== canonical(events)) throw new Error('Reconciliation history changed');
  const initial = foldPortfolioController(events);
  if ([...initial.states.values()].some(row => row.state !== 'completed' && row.state !== 'in-flight' &&
      !(preservePending && row.state === 'pending'))) throw new Error('Reconciliation dispatch state unavailable');
  const prove = (current: readonly PortfolioControllerEvent[], campaignId: string) => {
    guard(current); owned();
    const folded = foldPortfolioController([...current]);
    const intent = folded.intentEvents.get(campaignId); const pin = folded.pins.get(campaignId);
    const target = options.deliveryPlan.deliveries.find(row => row.campaignId === campaignId);
    if (!intent?.dispatchId || !pin || pin.dispatch !== 'campaign' || !target || folded.states.get(campaignId)?.state !== 'in-flight') {
      throw new Error('Reconciliation dispatch unavailable');
    }
    const proof = readCompletedUniverseCampaignDispatch(campaignId, { dispatchId: intent.dispatchId, intentAt: intent.at,
      universeId: pin.universeId, definitionDigest: pin.definitionDigest, manifestDigest: pin.manifestDigest,
      comparatorDigest: pin.comparatorDigest, recordsDigest: pin.recordsDigest }, { root: options.root });
    if (!proof) throw new Error('Reconciliation campaign unavailable');
    const receipt = readCompletedCampaignDelivery(proof.campaign, target, { root: options.root });
    const readiness = readUniverseCampaignReadiness(campaignId, { root: options.root });
    if (!receipt || readiness.sourceState !== 'healthy' || readiness.recordsDigest !== proof.recordsDigest ||
        readiness.expectedIdentity?.summaryDigest !== digest(canonical(proof.campaign))) throw new Error('Reconciliation receipt unavailable');
    guard(current); owned();
    return { recordsDigest: proof.recordsDigest, campaignDigest: digest(canonical(proof.campaign)),
      deliveryDigest: digest(canonical(receipt)), intentDigest: digest(canonical(intent)) };
  };
  for (const [campaignId, state] of initial.states) {
    if (state.state !== 'in-flight') continue;
    const proof = prove(events, campaignId);
    events = appendPortfolioControllerEvent(directory, { kind: 'settled', at: new Date().toISOString(), recordsDigest: proof.recordsDigest,
      outcome: { campaignId, state: 'completed', attempted: true, reasonCode: 'completed-dispatch-reconciled',
        campaignDigest: proof.campaignDigest, deliveryDigest: proof.deliveryDigest } }, {
      expectedRecords: events,
      beforeSettlement: current => {
        if (canonical(prove(current, campaignId)) !== canonical(proof)) throw new Error('Reconciliation evidence changed');
        // Expensive proof reads cannot bypass the final metadata-publication fence.
        guard(current); owned();
      },
    });
  }
  guard(events); owned();
  return events;
}
