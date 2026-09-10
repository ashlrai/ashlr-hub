import { isAbsolute, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from './artifacts.js';
import { runUniverseCampaign } from './campaign.js';
import { deliverCompletedUniverseCampaign, preflightUniverseCampaignDelivery, validateUniverseCampaignDeliveryPlan,
  type UniverseCampaignDeliveryPlan, type UniverseCampaignDeliveryResult } from './campaign-delivery.js';
import { readUniverseCampaignReadiness, type UniverseCampaignReadiness, type UniverseCampaignReadinessReason } from './campaign-readiness.js';
import { resourceAdmissionPreflight, type ResourceAdmissionPreflightReason } from './resource-admission-preflight.js';
import type { UniverseCampaignSummary } from './types.js';

export type UniverseCampaignSupervisorStatus = 'queued' | 'waiting' | 'running' | 'delivering' | 'completed' | 'held' | 'failed' | 'cancelled' | 'unavailable';
export type UniverseCampaignSupervisorReason = UniverseCampaignReadinessReason | ResourceAdmissionPreflightReason | 'queued' | 'waiting-for-universe-owner' |
  'dispatched' | 'evidence-changed' | 'runner-failed' | 'caller-cancelled' | 'invocation-duration-exhausted' |
  'transition-callback-failed' | 'resource-runtime-required' | 'delivery-requested' | 'delivery-completed' | 'delivery-withheld' | 'delivery-failed';
export interface UniverseCampaignSupervisorOutcome {
  campaignId: string;
  status: UniverseCampaignSupervisorStatus;
  attempted: boolean;
  reasonCode: UniverseCampaignSupervisorReason;
  observedState: UniverseCampaignSummary['state'] | null;
  /** Present only for an explicitly planned handoff; campaign completion is separate. */
  delivery?: UniverseCampaignDeliveryResult['delivery'] | { status: 'failed'; reason: 'delivery-failed' } |
    { status: 'withheld'; reason: 'not-attempted' };
}
export interface UniverseCampaignSupervisorTransition {
  sequence: number;
  at: string;
  campaignId: string;
  status: UniverseCampaignSupervisorStatus;
  reasonCode: UniverseCampaignSupervisorReason;
}
export interface UniverseCampaignSupervisorOptions {
  root: string;
  maxDurationMs: number;
  maxConcurrent?: number;
  pollIntervalMs?: number;
  resourceRuntime?: string;
  deliveryPlan?: UniverseCampaignDeliveryPlan;
  signal?: AbortSignal;
  /** Synchronous observer; throwing or returning a promise cancels and drains owned calls. */
  onTransition?: (event: UniverseCampaignSupervisorTransition) => void;
}
export interface UniverseCampaignSupervisorResult {
  schemaVersion: 1;
  executionScope: 'foreground-explicit-queue';
  status: 'completed' | 'incomplete' | 'cancelled' | 'timed-out' | 'failed';
  startedAt: string;
  deadlineAt: string;
  finishedAt: string;
  outcomes: UniverseCampaignSupervisorOutcome[];
  transitions: UniverseCampaignSupervisorTransition[];
}

function path(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 4_096 &&
    ![...value].some((character) => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) &&
    isAbsolute(value) && resolve(value) === value && parse(value).root !== value;
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function snapshot(input: string[], options: UniverseCampaignSupervisorOptions) {
  const keys = ['root', 'maxDurationMs', 'maxConcurrent', 'pollIntervalMs', 'resourceRuntime', 'deliveryPlan', 'signal', 'onTransition'];
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some((key) => typeof key !== 'string' || !keys.includes(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value')) ||
    !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < 1 || input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Array.from({ length: input.length }, (_, index) => Object.getOwnPropertyDescriptor(input, String(index)))
      .some((property) => !property || !Object.hasOwn(property, 'value'))) throw new Error('Invalid Universe supervisor options');
  const { root, maxDurationMs, maxConcurrent = 1, pollIntervalMs = 500, resourceRuntime, deliveryPlan, signal, onTransition } = options;
  const ids = [...input];
  if (ids.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) || new Set(ids).size !== ids.length ||
    !path(root) || !integer(maxDurationMs, 1, 86_400_000) || !integer(maxConcurrent, 1, 4) || !integer(pollIntervalMs, 50, 60_000) ||
    resourceRuntime !== undefined && !path(resourceRuntime) || signal !== undefined && !(signal instanceof AbortSignal) ||
    onTransition !== undefined && typeof onTransition !== 'function') throw new Error('Invalid Universe supervisor options');
  return { ids, root, maxDurationMs, maxConcurrent, pollIntervalMs, resourceRuntime, signal, onTransition,
    deliveryPlan: deliveryPlan === undefined ? undefined : validateUniverseCampaignDeliveryPlan(deliveryPlan, ids) };
}

function eligible(report: UniverseCampaignReadiness): boolean {
  return report.sourceState === 'healthy' && report.expectedIdentity !== null && report.recordsDigest !== null &&
    (report.disposition === 'startable' || report.disposition === 'owned' && report.observedState === 'ready');
}
function unchanged(initial: UniverseCampaignReadiness, current: UniverseCampaignReadiness): boolean {
  return current.sourceState === 'healthy' && current.recordsDigest === initial.recordsDigest &&
    canonical(current.expectedIdentity) === canonical(initial.expectedIdentity);
}
function recorded(report: UniverseCampaignReadiness): UniverseCampaignSupervisorStatus {
  return report.sourceState !== 'healthy' ? 'unavailable' : report.observedState === 'completed' ? 'completed' :
    report.observedState === 'failed' ? 'failed' : 'held';
}

/**
 * Explicit, bounded foreground queue. Each enrolled campaign is dispatched at
 * most once; paused, withheld or abandoned work is never automatically resumed.
 * Existing campaign ledgers retain all durable budgets, controls and ownership.
 */
export async function superviseUniverseCampaigns(ids: string[], options: UniverseCampaignSupervisorOptions): Promise<UniverseCampaignSupervisorResult> {
  const config = snapshot(ids, options);
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.parse(startedAt) + config.maxDurationMs).toISOString();
  const deadline = performance.now() + config.maxDurationMs;
  const deliveryTargets = new Map(config.deliveryPlan?.deliveries.map((row) => [row.campaignId, row]));
  const deliveryPins = new Map<string, UniverseCampaignSummary>();
  const targetRefs = new Set<string>();
  // Resolve every declared base before any observer callback, model request or
  // campaign dispatch. No plan means no extra reads and unchanged queue behavior.
  for (const [id, delivery] of deliveryTargets) {
    if (config.signal?.aborted || performance.now() >= deadline) break;
    const preflight = preflightUniverseCampaignDelivery(id, { root: config.root, delivery });
    const target = canonical([preflight.repo, delivery.branch]);
    if (targetRefs.has(target)) throw new Error('Campaign delivery plan repeats a repository branch');
    targetRefs.add(target); deliveryPins.set(id, preflight.campaign);
    // Let pending SIGINT/abort notifications run between synchronous source reads.
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  }
  if (config.deliveryPlan && (config.signal?.aborted || performance.now() >= deadline)) {
    const cancelled = config.signal?.aborted ?? false;
    return { schemaVersion: 1, executionScope: 'foreground-explicit-queue', status: cancelled ? 'cancelled' : 'timed-out',
      startedAt, deadlineAt, finishedAt: new Date().toISOString(), transitions: [],
      outcomes: config.ids.map((campaignId) => ({ campaignId, status: 'cancelled', attempted: false, observedState: null,
        reasonCode: cancelled ? 'caller-cancelled' : 'invocation-duration-exhausted',
        ...(deliveryTargets.has(campaignId) ? { delivery: { status: 'withheld' as const, reason: 'cancelled' as const } } : {}) })) };
  }
  const deliveryOnly = (id: string, report: UniverseCampaignReadiness): boolean => deliveryTargets.has(id) &&
    report.sourceState === 'healthy' && report.expectedIdentity !== null && report.recordsDigest !== null && report.observedState === 'completed';
  const eligibleForQueue = (id: string, report: UniverseCampaignReadiness): boolean => eligible(report) || deliveryOnly(id, report);
  const controller = new AbortController();
  let stop: 'cancelled' | 'timed-out' | 'failed' | null = null;
  let callbackFailed = false;
  const transitions: UniverseCampaignSupervisorTransition[] = [];
  const outcomes = new Map<string, UniverseCampaignSupervisorOutcome>();
  const pending = new Set<string>();
  const active = new Map<string, Promise<void>>();
  const activeUniverses = new Set<string>();
  const initial = new Map<string, UniverseCampaignReadiness>();
  const checkRuntime = config.resourceRuntime === undefined ? null : resourceAdmissionPreflight(config.resourceRuntime);
  const halt = (reason: NonNullable<typeof stop>): void => { stop ??= reason; controller.abort(); };
  const cancel = (): void => halt('cancelled');
  const expire = (): void => halt('timed-out');
  const stopping = (): boolean => {
    if (config.signal?.aborted) cancel();
    if (performance.now() >= deadline) expire();
    return controller.signal.aborted;
  };
  const stopReason = (): UniverseCampaignSupervisorReason => callbackFailed ? 'transition-callback-failed' :
    stop === 'timed-out' ? 'invocation-duration-exhausted' : 'caller-cancelled';
  const mark = (id: string, status: UniverseCampaignSupervisorStatus, reasonCode: UniverseCampaignSupervisorReason,
    report?: UniverseCampaignReadiness, attempted = outcomes.get(id)?.attempted ?? false): void => {
    const previous = outcomes.get(id);
    outcomes.set(id, { campaignId: id, status, reasonCode, attempted, observedState: report?.observedState ?? previous?.observedState ?? null,
      ...(previous?.delivery ? { delivery: previous.delivery } : {}) });
    if (previous?.status === status && previous.reasonCode === reasonCode) return;
    const event: UniverseCampaignSupervisorTransition = { sequence: transitions.length + 1, at: new Date().toISOString(), campaignId: id, status, reasonCode };
    transitions.push(event);
    if (config.onTransition && !callbackFailed && !controller.signal.aborted) {
      try {
        const returned: unknown = config.onTransition(Object.freeze({ ...event }));
        if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
          typeof (returned as PromiseLike<unknown>).then === 'function') {
          // Async observers are outside this synchronous contract. Attach a
          // rejection handler before cancellation so they cannot leak failures.
          void Promise.resolve(returned).catch(() => undefined);
          throw new Error('Asynchronous supervisor observer');
        }
      } catch { callbackFailed = true; halt('failed'); }
    }
  };
  const observe = (id: string): UniverseCampaignReadiness | null => {
    try { return readUniverseCampaignReadiness(id, { root: config.root }); } catch { return null; }
  };
  config.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(expire, Math.max(0, deadline - performance.now()));
  const deliver = async (id: string, report: UniverseCampaignReadiness): Promise<void> => {
    if (stopping()) { mark(id, 'cancelled', stopReason(), report); return; }
    mark(id, 'delivering', 'delivery-requested', report);
    if (stopping()) { mark(id, 'cancelled', stopReason(), report); return; }
    try {
      const result = await deliverCompletedUniverseCampaign(id, { root: config.root, signal: controller.signal,
        delivery: deliveryTargets.get(id)!, deadlineMonotonicMs: deadline,
        expectedIdentity: { ...report.expectedIdentity!, recordsDigest: report.recordsDigest! } });
      stopping(); // A synchronous receipt verification may outlast the timer without yielding.
      outcomes.get(id)!.delivery = result.delivery;
      if (result.delivery.status === 'delivered') mark(id, 'completed', 'delivery-completed', report);
      else if (result.delivery.reason === 'cancelled') mark(id, 'cancelled', stopReason(), report);
      else mark(id, result.delivery.reason === 'no-strict-improvement' ? 'completed' : 'held', 'delivery-withheld', report);
    } catch {
      if (stopping()) { mark(id, 'cancelled', stopReason(), report); return; }
      outcomes.get(id)!.delivery = { status: 'failed', reason: 'delivery-failed' };
      mark(id, 'failed', 'delivery-failed', report);
    }
  };
  const launch = (id: string, admitted: UniverseCampaignReadiness): void => {
    pending.delete(id);
    activeUniverses.add(admitted.universeId!);
    const work = Promise.resolve().then(async () => {
      if (stopping()) { mark(id, 'cancelled', stopReason()); return; }
      if (deliveryOnly(id, admitted)) { await deliver(id, admitted); return; }
      mark(id, 'running', 'dispatched', admitted);
      if (stopping()) { mark(id, 'cancelled', stopReason()); return; }
      outcomes.get(id)!.attempted = true;
      try {
        const result = await runUniverseCampaign(id, { root: config.root, signal: controller.signal,
          ...(config.resourceRuntime === undefined ? {} : { resourceRuntime: config.resourceRuntime }),
          expectedIdentity: { ...admitted.expectedIdentity!, recordsDigest: admitted.recordsDigest! } });
        const report = observe(id);
        const expected = initial.get(id)!.expectedIdentity!;
        if (!report || report.sourceState !== 'healthy' || !report.expectedIdentity) {
          mark(id, 'unavailable', 'evidence-degraded', report ?? undefined); return;
        }
        if (report.expectedIdentity.universeId !== expected.universeId || report.expectedIdentity.definitionDigest !== expected.definitionDigest ||
          report.expectedIdentity.manifestDigest !== expected.manifestDigest || report.expectedIdentity.comparatorDigest !== expected.comparatorDigest ||
          report.expectedIdentity.summaryDigest !== digest(canonical(result))) {
          mark(id, 'unavailable', 'evidence-changed', report); return;
        }
        if (deliveryTargets.has(id) && report.observedState === 'completed') await deliver(id, report);
        else mark(id, recorded(report), report.reasonCode, report);
      } catch {
        const report = observe(id);
        mark(id, 'failed', 'runner-failed', report ?? undefined);
      }
    }).finally(() => { active.delete(id); activeUniverses.delete(admitted.universeId!); });
    active.set(id, work);
  };
  try {
    // Capture every enrollment before any callback or runner can change another
    // campaign. Subsequent queue polls can reject, but never renew, these pins.
    for (const id of config.ids) {
      if (stopping()) break;
      const report = observe(id);
      const pin = deliveryPins.get(id);
      if (report && (!pin || report.expectedIdentity?.universeId === pin.definition.universeId &&
          report.expectedIdentity.definitionDigest === pin.definitionDigest && report.expectedIdentity.manifestDigest === pin.manifestDigest &&
          report.expectedIdentity.comparatorDigest === pin.comparatorDigest)) initial.set(id, report);
      // Source reads are synchronous; let queued abort notifications run before
      // observing another campaign. No observer or dispatch runs before pinning.
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    for (const id of config.ids) {
      const report = initial.get(id);
      if (stopping()) mark(id, 'cancelled', stopReason(), report);
      else if (!report) mark(id, 'unavailable', 'evidence-degraded');
      else if (!eligibleForQueue(id, report)) mark(id, recorded(report), report.reasonCode, report);
      else if (!deliveryOnly(id, report) && report.resourceRuntimeRequired && config.resourceRuntime === undefined) mark(id, 'held', 'resource-runtime-required', report);
      else {
        pending.add(id);
        mark(id, report.disposition === 'owned' ? 'waiting' : 'queued',
          report.disposition === 'owned' ? 'waiting-for-universe-owner' : 'queued', report);
      }
    }
    while (pending.size || active.size) {
      if (stopping()) {
        for (const id of pending) mark(id, 'cancelled', stopReason());
        pending.clear();
      } else {
        for (const id of pending) {
          if (stopping()) break;
          const report = observe(id);
          if (!report) { pending.delete(id); mark(id, 'unavailable', 'evidence-degraded'); continue; }
          if (!unchanged(initial.get(id)!, report)) {
            pending.delete(id); mark(id, 'held', 'evidence-changed', report); continue;
          }
          if (!eligibleForQueue(id, report)) { pending.delete(id); mark(id, recorded(report), report.reasonCode, report); continue; }
          if (report.disposition === 'owned' || activeUniverses.has(report.universeId!)) {
            mark(id, 'waiting', 'waiting-for-universe-owner', report); continue;
          }
          if (active.size < config.maxConcurrent) {
            if (!deliveryOnly(id, report) && report.resourceRuntimeRequired && checkRuntime) {
              const reason = checkRuntime();
              await new Promise<void>((resolveYield) => setImmediate(resolveYield));
              // A synchronous Git/configuration check can exhaust the budget
              // or queue a cancellation before timers get an opportunity.
              if (stopping()) break;
              if (reason) { pending.delete(id); mark(id, 'held', reason, report); continue; }
            }
            launch(id, initial.get(id)!);
          }
        }
      }
      if (!pending.size && !active.size) break;
      // One cancellable wakeup is disposed on every race; active completion can
      // advance the queue without accumulating timers or abort listeners.
      let wake: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const delay = new Promise<void>((resolveWait) => {
        abort = resolveWait;
        wake = setTimeout(resolveWait, Math.max(1, Math.min(config.pollIntervalMs, deadline - performance.now())));
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
  } catch {
    halt('failed');
    for (const id of pending) mark(id, 'cancelled', 'runner-failed');
    pending.clear();
  } finally {
    await Promise.allSettled(active.values());
    // The final synchronous evidence read or observer can exhaust the budget
    // before the timer gets a turn. Reconcile the invocation after draining,
    // without rewriting completed campaign outcomes or delivered receipts.
    stopping();
    clearTimeout(timer);
    config.signal?.removeEventListener('abort', cancel);
  }
  return { schemaVersion: 1, executionScope: 'foreground-explicit-queue', status: stop ??
    (config.ids.every((id) => outcomes.get(id)?.status === 'completed') ? 'completed' : 'incomplete'),
    startedAt, deadlineAt, finishedAt: new Date().toISOString(),
    outcomes: config.ids.map((id) => {
      const outcome = outcomes.get(id)!;
      return deliveryTargets.has(id) && !outcome.delivery ? { ...outcome, delivery: { status: 'withheld' as const,
        reason: outcome.status === 'cancelled' ? 'cancelled' as const :
          outcome.observedState === null || outcome.observedState === 'completed' ? 'not-attempted' as const : 'campaign-not-completed' as const } } : outcome;
    }), transitions };
}
