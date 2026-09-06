import { randomUUID } from 'node:crypto';
import { verifiedProcessStartRef, ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import { withUniverseExecution } from './execution.js';
import { runUniverseOwned } from './runner.js';
import { scheduledVariants } from './store.js';
import {
  appendCampaignEvent, campaignDirectory, campaignUniverse, foldCampaignEvents,
  readCampaignEvents, readUniverseCampaign, terminalCampaign,
} from './campaign-store.js';
import type { UniverseCampaignSummary, UniverseStoreOptions } from './types.js';

type CampaignOptions = UniverseStoreOptions & { signal?: AbortSignal };
type Settlement = 'paused' | 'stopped' | 'completed' | 'interrupted' | 'failed';

function settle(id: string, requested: Settlement, reason: string, options: CampaignOptions): UniverseCampaignSummary {
  const directory = campaignDirectory(id, options);
  const state = foldCampaignEvents(readCampaignEvents(directory)).state;
  if (terminalCampaign(state)) return readUniverseCampaign(id, options);
  const selected = state === 'stop-requested' ? 'stopped' : state === 'pause-requested' ? 'paused' : requested;
  appendCampaignEvent(directory, { kind: 'settled', state: selected,
    reason: selected !== requested ? (selected === 'stopped' ? 'Stopped by owner' : 'Paused by owner') : reason,
    at: new Date().toISOString() });
  return readUniverseCampaign(id, options);
}

function limit(summary: UniverseCampaignSummary): { state: Settlement; reason: string } | null {
  const { budget } = summary.definition;
  if (summary.deadlineAt && Date.now() >= Date.parse(summary.deadlineAt)) return { state: 'completed', reason: 'Campaign duration budget exhausted' };
  if (summary.progress.attempts >= budget.maxGenerations) return { state: 'completed', reason: 'Campaign generation budget exhausted' };
  if (summary.progress.stagnantGenerations >= budget.maxStagnantGenerations) return { state: 'completed', reason: 'Campaign measured-improvement stagnation limit reached' };
  if (budget.maxReportedTokens !== null) {
    if (!summary.progress.usageComplete) return { state: 'failed', reason: 'Model usage is unavailable; the token-budgeted campaign cannot make another request' };
    if (summary.progress.reportedTokens !== null && summary.progress.reportedTokens >= budget.maxReportedTokens) {
      return { state: 'completed', reason: 'Campaign observed-token threshold reached' };
    }
  }
  return null;
}

/** Explicit foreground ownership; resumption never installs or activates a resident daemon. */
export async function runUniverseCampaign(id: string, options: CampaignOptions = {}): Promise<UniverseCampaignSummary> {
  const initial = readUniverseCampaign(id, options);
  if (initial.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
  if (terminalCampaign(initial.state)) return initial;
  return await withUniverseExecution(initial.definition.universeId, options, async (lock) => {
    const directory = campaignDirectory(id, options);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExpired = false;
    let controlError: string | null = null;
    try {
      let summary = readUniverseCampaign(id, options);
      if (summary.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
      if (terminalCampaign(summary.state)) return summary;
      const folded = foldCampaignEvents(readCampaignEvents(directory));
      if (folded.state === 'stop-requested' || folded.state === 'pause-requested') {
        return settle(id, folded.state === 'stop-requested' ? 'stopped' : 'paused', 'Acknowledged pending owner control', options);
      }
      if (controller.signal.aborted) return settle(id, 'paused', 'Campaign paused by caller cancellation', options);

      // The common Universe lease excludes other runs while abandoned starts
      // are reconciled. Existing run IDs finalize interruption; they never replay.
      const universe = campaignUniverse(summary, options);
      for (const step of summary.steps) {
        const prior = universe.runs.find((run) => run.id === step.runId);
        if (prior && prior.finishedAt === null) {
          await runUniverseOwned(summary.definition.universeId, { ...options, runId: step.runId,
            campaign: { id, ordinal: step.ordinal, definitionDigest: summary.definitionDigest },
            deadlineMs: summary.deadlineAt ? Date.parse(summary.deadlineAt) : undefined,
            trialLimit: step.variantIds.length,
            ...(summary.definition.feedback ? { feedback: true as const } : {}),
          }, lock);
        }
      }
      if (folded.state === 'running') {
        appendCampaignEvent(directory, { kind: 'settled', state: 'interrupted', at: new Date().toISOString(),
          reason: 'Recovered a campaign owner interruption without replaying reserved work' });
      }
      summary = readUniverseCampaign(id, options);
      const before = limit(summary);
      if (before) return settle(id, before.state, before.reason, options);
      const startRef = verifiedProcessStartRef(process.pid);
      if (!startRef) throw new Error('Cannot establish campaign process ownership');
      const at = new Date().toISOString();
      const deadlineAt = summary.deadlineAt ?? new Date(Date.parse(at) + summary.definition.budget.maxDurationMs).toISOString();
      appendCampaignEvent(directory, { kind: 'started', at, deadlineAt, owner: { pid: process.pid, startRef } });
      deadlineTimer = setTimeout(() => { deadlineExpired = true; cancel(); }, Math.max(1, Date.parse(deadlineAt) - Date.now()));
      poll = setInterval(() => {
        try {
          if (!ownsLocalStoreLock(lock)) throw new Error('Campaign execution ownership was lost');
          const current = foldCampaignEvents(readCampaignEvents(directory));
          if (current.state === 'pause-requested' || current.state === 'stop-requested') cancel();
          else if (current.state !== 'running') throw new Error('Campaign control state changed outside its execution owner');
        } catch (error) {
          controlError = error instanceof Error ? error.message : 'Campaign control observation failed';
          cancel();
        }
      }, 300);

      while (true) {
        if (!ownsLocalStoreLock(lock)) throw new Error('Campaign execution ownership was lost');
        summary = readUniverseCampaign(id, options);
        if (summary.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
        if (summary.state === 'pause-requested' || summary.state === 'stop-requested') {
          return settle(id, summary.state === 'stop-requested' ? 'stopped' : 'paused', 'Acknowledged owner control', options);
        }
        if (controlError) throw new Error(controlError);
        if (options.signal?.aborted) return settle(id, 'paused', 'Campaign paused by caller cancellation', options);
        if (deadlineExpired) return settle(id, 'completed', 'Campaign duration budget exhausted', options);
        const exhausted = limit(summary);
        if (exhausted) return settle(id, exhausted.state, exhausted.reason, options);
        if (controller.signal.aborted) return settle(id, 'paused', 'Campaign paused by caller cancellation', options);

        const current = campaignUniverse(summary, options);
        if (current.sourceState !== 'healthy') throw new Error('Universe evidence is degraded');
        const generation = current.runs.length + 1;
        const previous = summary.steps.at(-1);
        if (previous) {
          const previousRun = current.runs.find((run) => run.id === previous.runId);
          if (generation !== previous.generation + (previousRun ? 1 : 0)) {
            return settle(id, 'failed', 'Unexpected Universe generation interleaving; campaign reservation scope changed', options);
          }
        }
        const availableRequests = summary.definition.budget.maxModelRequests - summary.progress.reservedModelRequests;
        const variants = [] as ReturnType<typeof scheduledVariants>;
        let reservedModelRequests = 0;
        for (const variant of scheduledVariants(current.manifest, generation)) {
          const required = variant.generation ? 1 : 0;
          if (reservedModelRequests + required > availableRequests) break;
          variants.push(variant); reservedModelRequests += required;
        }
        if (!variants.length) return settle(id, 'completed', 'Campaign model-request reservation budget exhausted', options);
        const runId = randomUUID();
        const ordinal = summary.progress.attempts + 1;
        // Reserve the complete scheduled request envelope before any worker or
        // provider contact. Interrupted/unused reservations are never refunded.
        appendCampaignEvent(directory, { kind: 'step', at: new Date().toISOString(), ordinal, runId, generation,
          variantIds: variants.map((variant) => variant.id), reservedModelRequests });
        const result = await runUniverseOwned(summary.definition.universeId, { root: options.root,
          signal: controller.signal, runId, campaign: { id, ordinal, definitionDigest: summary.definitionDigest },
          deadlineMs: Date.parse(deadlineAt), trialLimit: variants.length,
          ...(summary.definition.feedback ? { feedback: true as const } : {}),
        }, lock);
        if (result.status === 'failed') return settle(id, 'failed', 'Universe generation failed; inspect its durable evidence', options);
        if (result.status === 'interrupted' && !controller.signal.aborted) {
          return settle(id, 'interrupted', 'Universe generation interrupted before campaign completion', options);
        }
      }
    } catch (error) {
      controller.abort();
      if (!ownsLocalStoreLock(lock)) throw error;
      const summary = readUniverseCampaign(id, options);
      if (summary.sourceState !== 'healthy') return summary;
      return settle(id, 'failed', error instanceof Error ? error.message.slice(0, 1_024) : 'Campaign execution failed', options);
    } finally {
      if (poll) clearInterval(poll);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', cancel);
    }
  });
}
