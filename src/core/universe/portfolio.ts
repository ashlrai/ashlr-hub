import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, defaultUniverseRoot, digest } from './artifacts.js';
import { readUniverseCampaign } from './campaign-store.js';
import { runUniverseCampaign } from './campaign.js';
import { readUniversePortfolioPlan, validateUniversePortfolioDefinition } from './portfolio-plan.js';
import { deliverCompletedUniverseCampaign, preflightUniverseCampaignDelivery, validateUniverseCampaignDeliveryPlan,
  type UniverseCampaignDeliveryPlan, type UniverseCampaignDeliveryResult } from './campaign-delivery.js';
import type { UniversePortfolioPlan, UniversePortfolioPlanNode } from './portfolio-types.js';
import type { UniverseCampaignSummary, UniverseRunOptions, UniverseStoreOptions } from './types.js';

export interface UniversePortfolioRunOptions extends UniverseRunOptions {
  /** Explicit local handoffs; declared dependencies wait for these receipts. */
  deliveryPlan?: UniverseCampaignDeliveryPlan;
}

export interface UniversePortfolioOutcome {
  campaignId: string;
  status: 'completed' | 'blocked' | 'busy' | 'unavailable' | 'paused' | 'stopped' | 'failed' | 'interrupted' | 'cancelled';
  /** Invocation attempted the existing campaign runner; not a model-request count. */
  attempted: boolean;
  reason: string | null;
  campaign: UniverseCampaignSummary | null;
  delivery?: UniverseCampaignDeliveryResult['delivery'] | { status: 'failed'; reason: 'delivery-failed' } |
    { status: 'withheld'; reason: 'not-attempted' };
}

export interface UniversePortfolioResult {
  schemaVersion: 1;
  definitionDigest: string;
  measurementScope: 'local-experiment';
  status: 'completed' | 'incomplete' | 'cancelled' | 'timed-out' | 'failed';
  startedAt: string;
  deadlineAt: string;
  finishedAt: string;
  /** Initial read-only plan, not a claim about final live state. */
  plan: UniversePortfolioPlan;
  outcomes: UniversePortfolioOutcome[];
  reasons: string[];
}

function checkPin(node: UniversePortfolioPlanNode, campaign: UniverseCampaignSummary): void {
  if (campaign.sourceState !== 'healthy' || campaign.definition.id !== node.campaignId ||
      campaign.definition.universeId !== node.universeId || campaign.definitionDigest !== node.definitionDigest ||
      campaign.manifestDigest !== node.manifestDigest || campaign.comparatorDigest !== node.comparatorDigest ||
      campaign.createdAt !== node.campaign?.createdAt ||
      canonical(campaign.definition) !== canonical(node.campaign?.definition)) {
    throw new Error('Campaign evidence is unavailable or changed after portfolio planning');
  }
}

function outcome(node: UniversePortfolioPlanNode, campaign: UniverseCampaignSummary | null,
  attempted = false): UniversePortfolioOutcome {
  const state = campaign?.state;
  const status: UniversePortfolioOutcome['status'] = !campaign || campaign.sourceState !== 'healthy' ? 'unavailable' :
    state === 'running' ? 'busy' : state === 'ready' || state === 'pause-requested' || state === 'stop-requested' ? 'blocked' : state!;
  return { campaignId: node.campaignId, status, attempted, campaign,
    reason: campaign?.reason ?? (status === 'completed' ? 'Campaign completed; ordering satisfied, not accepted production work' :
      status === 'busy' ? 'Campaign already has an execution owner' : `Campaign is ${state ?? 'unavailable'}`) };
}

/**
 * Foreground DAG composition, not a resident scheduler. Campaign ledgers retain
 * all durable budgets and recovery state; the caller retains the portfolio file.
 * A dependency is an ordering prerequisite, never permission to import code or
 * proof of product success. Each enrolled campaign is attempted at most once.
 */
export async function runUniversePortfolio(input: unknown, options: UniversePortfolioRunOptions = {}): Promise<UniversePortfolioResult> {
  const startedAt = new Date().toISOString();
  const startedMonotonicMs = performance.now();
  // Resolve the root once: a caller must not redirect in-flight work by mutating
  // its options object while another branch is executing.
  const store: UniverseStoreOptions = { root: resolve(options.root ?? defaultUniverseRoot()) };
  // Snapshot the invocation-only locator separately: planning and durable
  // observations receive only the store root, never private runtime bindings.
  const resourceRuntime = options.resourceRuntime;
  const callerSignal = options.signal;
  // Capture all handoff intent before source reads or asynchronous work can
  // mutate caller-owned rows. No plan keeps legacy ordering-only semantics.
  const deliveryPlan = options.deliveryPlan === undefined ? undefined : validateUniverseCampaignDeliveryPlan(options.deliveryPlan,
    validateUniversePortfolioDefinition(input).tasks.map((task) => task.campaignId));
  const plan = readUniversePortfolioPlan(input, store);
  const deadlineMs = Date.parse(startedAt) + plan.definition.maxDurationMs;
  const deadlineMonotonicMs = startedMonotonicMs + plan.definition.maxDurationMs;
  const deadlineAt = new Date(deadlineMs).toISOString();
  const byId = new Map(plan.nodes.map((node) => [node.campaignId, node]));
  const deliveryTargets = new Map(deliveryPlan?.deliveries.map((row) => [row.campaignId, row]));
  const deliveryAncestors = new Map<string, Set<string>>();
  for (const id of plan.topologicalOrder) {
    const inherited = new Set<string>();
    for (const dependency of byId.get(id)!.dependsOn) {
      if (deliveryTargets.has(dependency)) inherited.add(dependency);
      for (const ancestor of deliveryAncestors.get(dependency) ?? []) inherited.add(ancestor);
    }
    deliveryAncestors.set(id, inherited);
  }
  // Completed intermediates retain their historical result, but cannot sever a
  // planned ancestor's handoff gate for work that has not yet been dispatched.
  const prerequisites = (node: UniversePortfolioPlanNode): string[] =>
    [...new Set([...node.dependsOn, ...deliveryAncestors.get(node.campaignId)!])];
  if (plan.sourceState === 'healthy') {
    const refs = new Set<string>();
    for (const [id, delivery] of deliveryTargets) {
      if (callerSignal?.aborted || Date.now() >= deadlineMs || performance.now() >= deadlineMonotonicMs) break;
      try {
        const preflight = preflightUniverseCampaignDelivery(id, { ...store, delivery });
        checkPin(byId.get(id)!, preflight.campaign);
        if (canonical(preflight.campaign) !== canonical(byId.get(id)!.campaign)) throw new Error('Changed campaign');
        const target = canonical([preflight.repo, delivery.branch]);
        if (refs.has(target)) throw new Error('Repeated repository branch');
        refs.add(target);
      } catch {
        // Underlying Git/source errors may contain private paths or runtime data.
        throw new Error('Portfolio delivery preflight failed; verify pinned campaign evidence, base commits and unique target branches');
      }
      // Permit queued caller cancellation between synchronous repository reads.
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  }
  const outcomes = new Map<string, UniversePortfolioOutcome>();
  const pending = new Set<string>();
  const active = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let stop: 'cancelled' | 'timed-out' | 'failed' | null = null;
  const reasons: string[] = [...plan.reasons];
  const cancel = (): void => { stop ??= 'cancelled'; controller.abort(); };
  const finish = (): UniversePortfolioResult => ({ schemaVersion: 1, definitionDigest: plan.definitionDigest,
    measurementScope: 'local-experiment', status: stop ?? (plan.sourceState !== 'healthy' ? 'failed' :
      plan.nodes.every((node) => outcomes.get(node.campaignId)?.status === 'completed') ? 'completed' : 'incomplete'),
    startedAt, deadlineAt, finishedAt: new Date().toISOString(), plan,
    outcomes: plan.nodes.map((node) => {
      const value = outcomes.get(node.campaignId)!;
      return deliveryTargets.has(node.campaignId) && !value.delivery ? { ...value,
        delivery: { status: 'withheld' as const, reason: 'not-attempted' as const } } : value;
    }), reasons });
  for (const node of plan.nodes) {
    if (plan.sourceState === 'healthy' && (node.state === 'ready' || node.state === 'waiting' ||
      node.state === 'completed' && deliveryTargets.has(node.campaignId))) pending.add(node.campaignId);
    else outcomes.set(node.campaignId, { ...outcome(node, node.campaign),
      status: node.state === 'completed' ? 'completed' : node.state === 'busy' ? 'busy' :
        node.state === 'unavailable' ? 'unavailable' : 'blocked',
      reason: plan.sourceState !== 'healthy' ? 'Portfolio preflight is degraded; no campaigns were dispatched' : node.reason });
  }
  if (plan.sourceState !== 'healthy') return finish();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const expire = (): void => { stop ??= 'timed-out'; controller.abort(); };
  const stopping = (): boolean => {
    if (callerSignal?.aborted) cancel();
    if (Date.now() >= deadlineMs || deliveryPlan && performance.now() >= deadlineMonotonicMs) expire();
    return controller.signal.aborted;
  };
  const timer = setTimeout(expire, Math.max(1, deadlineMs - Date.now()));
  const mark = (id: string, status: UniversePortfolioOutcome['status'], reason: string, campaign = byId.get(id)!.campaign): void => {
    pending.delete(id);
    outcomes.set(id, { campaignId: id, status, attempted: false, reason, campaign });
  };
  const observe = (node: UniversePortfolioPlanNode): UniverseCampaignSummary => {
    const campaign = readUniverseCampaign(node.campaignId, store);
    checkPin(node, campaign);
    return campaign;
  };
  const deliver = async (node: UniversePortfolioPlanNode, campaign: UniverseCampaignSummary, attempted: boolean): Promise<void> => {
    const previous = outcome(node, campaign, attempted);
    if (stopping()) {
      outcomes.set(node.campaignId, { ...previous, status: 'cancelled', reason: 'Portfolio ended before local delivery',
        delivery: { status: 'withheld', reason: 'cancelled' } });
      return;
    }
    try {
      const result = await deliverCompletedUniverseCampaign(node.campaignId, { ...store, signal: controller.signal,
        delivery: deliveryTargets.get(node.campaignId)!, deadlineMonotonicMs,
        expectedIdentity: { universeId: node.universeId!, definitionDigest: node.definitionDigest!,
          manifestDigest: node.manifestDigest!, comparatorDigest: node.comparatorDigest!, summaryDigest: digest(canonical(campaign)) } });
      stopping();
      outcomes.set(node.campaignId, { ...previous, delivery: result.delivery,
        status: result.delivery.status === 'delivered' ? 'completed' : result.delivery.reason === 'cancelled' ? 'cancelled' : 'blocked',
        reason: result.delivery.status === 'delivered' ? 'Campaign completed and verified local branch delivered; not merged or accepted production work' :
          `Local delivery withheld: ${result.delivery.reason}` });
    } catch {
      const cancelled = stopping();
      outcomes.set(node.campaignId, { ...previous, status: cancelled ? 'cancelled' : 'failed',
        reason: cancelled ? 'Portfolio ended during local delivery; inspect durable delivery evidence' :
          'Local delivery failed; the completed campaign remains recorded',
        delivery: { status: 'failed', reason: 'delivery-failed' } });
    }
  };
  const launch = (node: UniversePortfolioPlanNode, admitted: UniverseCampaignSummary): void => {
    pending.delete(node.campaignId);
    // Deferred start lets the active map own the promise before any synchronous
    // rejection. Every branch catches locally so another rejection cannot be lost.
    const work = Promise.resolve().then(async () => {
      if (stopping()) {
        outcomes.set(node.campaignId, { campaignId: node.campaignId, status: 'cancelled', attempted: false,
          reason: 'Portfolio ended before campaign dispatch', campaign: admitted });
        return;
      }
      try {
        if (admitted.state === 'completed' && deliveryTargets.has(node.campaignId)) {
          await deliver(node, admitted, false); return;
        }
        const campaign = await runUniverseCampaign(node.campaignId, { ...store, signal: controller.signal,
          ...(resourceRuntime === undefined ? {} : { resourceRuntime }),
          expectedIdentity: { universeId: node.universeId!, definitionDigest: node.definitionDigest!,
            manifestDigest: node.manifestDigest!, comparatorDigest: node.comparatorDigest!, summaryDigest: digest(canonical(admitted)) } });
        checkPin(node, campaign);
        // Re-read durable state, rather than treating a fulfilled promise as
        // completion. No dependent starts from a returned-but-unrecorded success.
        const recorded = observe(node);
        if (canonical(recorded) !== canonical(campaign)) throw new Error('Campaign changed before portfolio settlement');
        if (recorded.state === 'completed' && deliveryTargets.has(node.campaignId)) await deliver(node, recorded, true);
        else outcomes.set(node.campaignId, outcome(node, recorded, true));
      } catch {
        let campaign: UniverseCampaignSummary | null = null;
        try { campaign = observe(node); } catch { /* Unavailable is not a fresh campaign. */ }
        const observed = outcome(node, campaign, true);
        // A thrown runner is never retroactively counted as our completed call,
        // even if an unrelated owner subsequently wrote terminal evidence.
        outcomes.set(node.campaignId, { ...observed,
          status: observed.status === 'busy' ? 'busy' : campaign === null ? 'unavailable' : 'failed',
          reason: 'Campaign dispatch did not settle successfully; inspect its durable evidence before retrying' });
      }
    }).finally(() => { active.delete(node.campaignId); });
    active.set(node.campaignId, work);
  };
  try {
    while (pending.size || active.size) {
      if (stopping()) {
        for (const id of pending) mark(id, 'cancelled', 'Portfolio ended before campaign dispatch');
      } else {
        for (const id of plan.topologicalOrder) {
          if (!pending.has(id)) continue;
          const node = byId.get(id)!;
          const required = prerequisites(node);
          if (required.some((dependency) => outcomes.has(dependency) && outcomes.get(dependency)!.status !== 'completed')) {
            mark(id, 'blocked', 'A campaign dependency did not complete');
            continue;
          }
          if (active.size >= plan.definition.maxParallel || required.some((dependency) => !outcomes.has(dependency))) continue;
          let admitted: UniverseCampaignSummary;
          try {
            for (const dependency of required) {
              const current = observe(byId.get(dependency)!);
              if (current.state !== 'completed') throw new Error('Campaign dependency no longer completed');
            }
            admitted = observe(node);
          } catch {
            mark(id, 'unavailable', 'Campaign or dependency evidence changed after portfolio planning');
            continue;
          }
          if (!['ready', 'paused', 'interrupted'].includes(admitted.state) &&
            !(admitted.state === 'completed' && deliveryTargets.has(id))) {
            pending.delete(id); outcomes.set(id, outcome(node, admitted)); continue;
          }
          // Existing paused/interrupted campaigns may be explicitly resumed.
          // Later control/progress changes require a new invocation, not a retry.
          if (canonical(admitted) !== canonical(node.campaign)) {
            mark(id, 'blocked', 'Campaign state changed after portfolio planning; not resumed', admitted); continue;
          }
          if (stopping()) break;
          launch(node, admitted);
        }
      }
      if (active.size) await Promise.race(active.values());
      else if (pending.size && !controller.signal.aborted) {
        for (const id of pending) mark(id, 'blocked', 'No eligible campaign dependency path remains');
      }
    }
  } catch {
    stop = 'failed'; controller.abort();
    reasons.push('Portfolio orchestration failed; owned campaign calls were cancelled and awaited');
    for (const id of pending) mark(id, 'cancelled', 'Portfolio orchestration failed before dispatch');
  } finally {
    // Do not return while an owned worker can still spend its reserved budget.
    // Existing campaign cancellation is cooperative and has its own timeouts.
    await Promise.allSettled(active.values());
    // Final synchronous settlement can outlast the deadline without letting its
    // timer fire. Preserve recorded outcomes, but report the invocation bound;
    // an existing cancellation/failure keeps its original precedence.
    stopping();
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
  const result = finish();
  if (result.status === 'cancelled') reasons.push('Caller cancelled the foreground portfolio invocation');
  if (result.status === 'timed-out') reasons.push('Portfolio invocation duration expired; original campaign budgets are unchanged');
  return result;
}
