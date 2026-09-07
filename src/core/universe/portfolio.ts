import { resolve } from 'node:path';
import { canonical, defaultUniverseRoot, digest } from './artifacts.js';
import { readUniverseCampaign } from './campaign-store.js';
import { runUniverseCampaign } from './campaign.js';
import { readUniversePortfolioPlan } from './portfolio-plan.js';
import type { UniversePortfolioPlan, UniversePortfolioPlanNode } from './portfolio-types.js';
import type { UniverseCampaignSummary, UniverseStoreOptions } from './types.js';

export interface UniversePortfolioOutcome {
  campaignId: string;
  status: 'completed' | 'blocked' | 'busy' | 'unavailable' | 'paused' | 'stopped' | 'failed' | 'interrupted' | 'cancelled';
  /** Invocation attempted the existing campaign runner; not a model-request count. */
  attempted: boolean;
  reason: string | null;
  campaign: UniverseCampaignSummary | null;
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

type PortfolioOptions = UniverseStoreOptions & { signal?: AbortSignal };

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
export async function runUniversePortfolio(input: unknown, options: PortfolioOptions = {}): Promise<UniversePortfolioResult> {
  const startedAt = new Date().toISOString();
  // Resolve the root once: a caller must not redirect in-flight work by mutating
  // its options object while another branch is executing.
  const store: UniverseStoreOptions = { root: resolve(options.root ?? defaultUniverseRoot()) };
  const callerSignal = options.signal;
  const plan = readUniversePortfolioPlan(input, store);
  const deadlineMs = Date.parse(startedAt) + plan.definition.maxDurationMs;
  const deadlineAt = new Date(deadlineMs).toISOString();
  const byId = new Map(plan.nodes.map((node) => [node.campaignId, node]));
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
    outcomes: plan.nodes.map((node) => outcomes.get(node.campaignId)!), reasons });
  for (const node of plan.nodes) {
    if (plan.sourceState === 'healthy' && (node.state === 'ready' || node.state === 'waiting')) pending.add(node.campaignId);
    else outcomes.set(node.campaignId, { ...outcome(node, node.campaign),
      status: node.state === 'completed' ? 'completed' : node.state === 'busy' ? 'busy' :
        node.state === 'unavailable' ? 'unavailable' : 'blocked',
      reason: plan.sourceState !== 'healthy' ? 'Portfolio preflight is degraded; no campaigns were dispatched' : node.reason });
  }
  if (plan.sourceState !== 'healthy') return finish();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const expire = (): void => { stop ??= 'timed-out'; controller.abort(); };
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
  const launch = (node: UniversePortfolioPlanNode, admitted: UniverseCampaignSummary): void => {
    pending.delete(node.campaignId);
    // Deferred start lets the active map own the promise before any synchronous
    // rejection. Every branch catches locally so another rejection cannot be lost.
    const work = Promise.resolve().then(async () => {
      if (Date.now() >= deadlineMs) expire();
      if (controller.signal.aborted) {
        outcomes.set(node.campaignId, { campaignId: node.campaignId, status: 'cancelled', attempted: false,
          reason: 'Portfolio ended before campaign dispatch', campaign: admitted });
        return;
      }
      try {
        const campaign = await runUniverseCampaign(node.campaignId, { ...store, signal: controller.signal,
          expectedIdentity: { universeId: node.universeId!, definitionDigest: node.definitionDigest!,
            manifestDigest: node.manifestDigest!, comparatorDigest: node.comparatorDigest!, summaryDigest: digest(canonical(admitted)) } });
        checkPin(node, campaign);
        // Re-read durable state, rather than treating a fulfilled promise as
        // completion. No dependent starts from a returned-but-unrecorded success.
        const recorded = observe(node);
        if (canonical(recorded) !== canonical(campaign)) throw new Error('Campaign changed before portfolio settlement');
        outcomes.set(node.campaignId, outcome(node, recorded, true));
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
      if (Date.now() >= deadlineMs) expire();
      if (controller.signal.aborted) {
        for (const id of pending) mark(id, 'cancelled', 'Portfolio ended before campaign dispatch');
      } else {
        for (const id of plan.topologicalOrder) {
          if (!pending.has(id)) continue;
          const node = byId.get(id)!;
          if (node.dependsOn.some((dependency) => outcomes.has(dependency) && outcomes.get(dependency)!.status !== 'completed')) {
            mark(id, 'blocked', 'A campaign dependency did not complete');
            continue;
          }
          if (active.size >= plan.definition.maxParallel || node.dependsOn.some((dependency) => !outcomes.has(dependency))) continue;
          let admitted: UniverseCampaignSummary;
          try {
            for (const dependency of node.dependsOn) {
              const current = observe(byId.get(dependency)!);
              if (current.state !== 'completed') throw new Error('Campaign dependency no longer completed');
            }
            admitted = observe(node);
          } catch {
            mark(id, 'unavailable', 'Campaign or dependency evidence changed after portfolio planning');
            continue;
          }
          if (!['ready', 'paused', 'interrupted'].includes(admitted.state)) {
            pending.delete(id); outcomes.set(id, outcome(node, admitted)); continue;
          }
          // Existing paused/interrupted campaigns may be explicitly resumed.
          // Later control/progress changes require a new invocation, not a retry.
          if (canonical(admitted) !== canonical(node.campaign)) {
            mark(id, 'blocked', 'Campaign state changed after portfolio planning; not resumed', admitted); continue;
          }
          if (callerSignal?.aborted) cancel();
          if (Date.now() >= deadlineMs) expire();
          if (controller.signal.aborted) break;
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
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
  const result = finish();
  if (result.status === 'cancelled') reasons.push('Caller cancelled the foreground portfolio invocation');
  if (result.status === 'timed-out') reasons.push('Portfolio invocation duration expired; original campaign budgets are unchanged');
  return result;
}
