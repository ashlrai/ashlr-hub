import { randomUUID } from 'node:crypto';
import { verifiedProcessStartRef, ownsLocalStoreLock } from '../fleet/local-store-lock.js';
import { withUniverseExecution } from './execution.js';
import { runUniverseOwned } from './runner.js';
import { scheduledVariants } from './store.js';
import { canonical, digest } from './artifacts.js';
import {
  appendCampaignEvent, CampaignControlConflictError, campaignDirectory, campaignUniverse, foldCampaignEvents,
  projectCampaign, readCampaignEvents, readUniverseCampaign, terminalCampaign, validCampaignDispatchId,
} from './campaign-store.js';
import type { UniverseCampaignSummary, UniverseRunOptions } from './types.js';

export interface UniverseCampaignExpectation {
  universeId: string;
  definitionDigest: string;
  manifestDigest: string;
  comparatorDigest: string;
  /** Optional exact pre-dispatch state, checked again inside the execution lease. */
  summaryDigest?: string;
  /** Optional exact raw control history, including events omitted by the summary projection. */
  recordsDigest?: string;
}
type CampaignOptions = UniverseRunOptions & {
  expectedIdentity?: UniverseCampaignExpectation;
  /** Optional caller-generated UUIDv4 attribution; never permission to replay a session. */
  dispatchId?: string;
};
type Settlement = 'paused' | 'stopped' | 'completed' | 'interrupted' | 'failed';

class CampaignExpectationError extends Error {}
function assertRecordsExpectation(records: ReturnType<typeof readCampaignEvents>, expected: UniverseCampaignExpectation | undefined): void {
  if (expected?.recordsDigest !== undefined && (typeof expected.recordsDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected.recordsDigest) || expected.recordsDigest !== digest(canonical(records)))) {
    throw new CampaignExpectationError('Campaign evidence changed after portfolio admission');
  }
}
function assertExpectation(summary: UniverseCampaignSummary, expected: UniverseCampaignExpectation | undefined, snapshot: boolean): void {
  if (!expected) return;
  if (summary.sourceState !== 'healthy' || summary.definition.universeId !== expected.universeId ||
      summary.definitionDigest !== expected.definitionDigest || summary.manifestDigest !== expected.manifestDigest ||
      summary.comparatorDigest !== expected.comparatorDigest ||
      (snapshot && expected.summaryDigest !== undefined && expected.summaryDigest !== digest(canonical(summary)))) {
    throw new CampaignExpectationError('Campaign evidence changed after portfolio admission');
  }
}

function settle(id: string, requested: Settlement, reason: string, options: CampaignOptions,
  expectedRecordsDigest?: string, dispatchId?: string): UniverseCampaignSummary {
  const directory = campaignDirectory(id, options);
  const state = foldCampaignEvents(readCampaignEvents(directory)).state;
  if (terminalCampaign(state)) return readUniverseCampaign(id, options);
  const selected = state === 'stop-requested' ? 'stopped' : state === 'pause-requested' ? 'paused' : requested;
  appendCampaignEvent(directory, { kind: 'settled', state: selected,
    reason: state === 'stop-requested' || state === 'pause-requested'
      ? (selected === 'stopped' ? 'Stopped by owner' : 'Paused by owner') : reason,
    at: new Date().toISOString(), ...(dispatchId === undefined ? {} : { dispatchId }) }, { expectedRecordsDigest });
  return readUniverseCampaign(id, options);
}

/** Shared observed-budget policy; a check does not reserve or refund anything. */
export function campaignBudgetLimit(summary: UniverseCampaignSummary, nowMs = Date.now()): {
  state: Settlement; reason: string;
  code: 'duration' | 'generations' | 'stagnation' | 'unknown-usage' | 'reported-tokens';
} | null {
  const { budget } = summary.definition;
  if (summary.deadlineAt && nowMs >= Date.parse(summary.deadlineAt)) return { state: 'completed', code: 'duration', reason: 'Campaign duration budget exhausted' };
  if (summary.progress.attempts >= budget.maxGenerations) return { state: 'completed', code: 'generations', reason: 'Campaign generation budget exhausted' };
  if (summary.progress.stagnantGenerations >= budget.maxStagnantGenerations) return { state: 'completed', code: 'stagnation', reason: 'Campaign measured-improvement stagnation limit reached' };
  if (budget.maxReportedTokens !== null) {
    if (!summary.progress.usageComplete) return { state: 'failed', code: 'unknown-usage', reason: 'Model usage is unavailable; the token-budgeted campaign cannot make another request' };
    if (summary.progress.reportedTokens !== null && summary.progress.reportedTokens >= budget.maxReportedTokens) {
      return { state: 'completed', code: 'reported-tokens', reason: 'Campaign observed-token threshold reached' };
    }
  }
  return null;
}

/** Explicit foreground ownership; resumption never installs or activates a resident daemon. */
export async function runUniverseCampaign(id: string, options: CampaignOptions = {}): Promise<UniverseCampaignSummary> {
  // Capture the caller value before any ownership or durable writes. Never infer
  // attribution from a previous runner's started record or generic owner controls.
  const dispatchId = options.dispatchId;
  if (dispatchId !== undefined && !validCampaignDispatchId(dispatchId)) throw new Error('Invalid campaign dispatch identity');
  const initial = readUniverseCampaign(id, options);
  assertExpectation(initial, options.expectedIdentity, true);
  if (options.expectedIdentity?.recordsDigest !== undefined) {
    assertRecordsExpectation(readCampaignEvents(campaignDirectory(id, options)), options.expectedIdentity);
  }
  if (initial.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
  if (terminalCampaign(initial.state)) return initial;
  return await withUniverseExecution(initial.definition.universeId, options, async (lock) => {
    const directory = campaignDirectory(id, options);
    // The execution lease excludes other runners, not owner controls. Project
    // the exact captured ledger and CAS that checkpoint under the control lock
    // when starting; a pause cannot slip between a snapshot check and admission.
    let admissionEvents = readCampaignEvents(directory);
    assertRecordsExpectation(admissionEvents, options.expectedIdentity);
    if (dispatchId !== undefined && admissionEvents.some((event) => event.kind === 'started' && event.dispatchId === dispatchId)) {
      throw new CampaignExpectationError('Campaign dispatch identity cannot be reused');
    }
    const admission = projectCampaign(admissionEvents,
      campaignUniverse(foldCampaignEvents(admissionEvents).created, options));
    assertExpectation(admission, options.expectedIdentity, true);
    let admissionDigest = options.expectedIdentity ? digest(canonical(admissionEvents)) : undefined;
    let ownedDispatchId: string | undefined;
    const finish = (state: Settlement, reason: string, checkpoint?: string): UniverseCampaignSummary =>
      settle(id, state, reason, options, checkpoint, ownedDispatchId);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExpired = false;
    let controlError: string | null = null;
    try {
      let summary = admission;
      assertExpectation(summary, options.expectedIdentity, false);
      if (summary.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
      if (terminalCampaign(summary.state)) return summary;
      const folded = foldCampaignEvents(admissionEvents);
      if (folded.state === 'stop-requested' || folded.state === 'pause-requested') {
        return finish(folded.state === 'stop-requested' ? 'stopped' : 'paused', 'Acknowledged pending owner control', admissionDigest);
      }
      if (controller.signal.aborted) return finish('paused', 'Campaign paused by caller cancellation', admissionDigest);

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
        admissionEvents = appendCampaignEvent(directory, { kind: 'settled', state: 'interrupted', at: new Date().toISOString(),
          reason: 'Recovered a campaign owner interruption without replaying reserved work' }, { expectedRecordsDigest: admissionDigest });
        if (admissionDigest !== undefined) admissionDigest = digest(canonical(admissionEvents));
      }
      summary = readUniverseCampaign(id, options);
      assertExpectation(summary, options.expectedIdentity, false);
      if (summary.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
      const before = campaignBudgetLimit(summary);
      if (before) return finish(before.state, before.reason, admissionDigest);
      const startRef = verifiedProcessStartRef(process.pid);
      if (!startRef) throw new Error('Cannot establish campaign process ownership');
      const at = new Date().toISOString();
      const deadlineAt = summary.deadlineAt ?? new Date(Date.parse(at) + summary.definition.budget.maxDurationMs).toISOString();
      appendCampaignEvent(directory, { kind: 'started', at, deadlineAt, owner: { pid: process.pid, startRef },
        ...(dispatchId === undefined ? {} : { dispatchId }) },
        { expectedRecordsDigest: admissionDigest });
      ownedDispatchId = dispatchId;
      admissionDigest = undefined;
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
        assertExpectation(summary, options.expectedIdentity, false);
        if (summary.sourceState !== 'healthy') throw new Error('Campaign evidence is degraded');
        if (summary.state === 'pause-requested' || summary.state === 'stop-requested') {
          return finish(summary.state === 'stop-requested' ? 'stopped' : 'paused', 'Acknowledged owner control');
        }
        if (controlError) throw new Error(controlError);
        if (options.signal?.aborted) return finish('paused', 'Campaign paused by caller cancellation');
        if (deadlineExpired) return finish('completed', 'Campaign duration budget exhausted');
        const exhausted = campaignBudgetLimit(summary);
        if (exhausted) return finish(exhausted.state, exhausted.reason);
        if (controller.signal.aborted) return finish('paused', 'Campaign paused by caller cancellation');

        const current = campaignUniverse(summary, options);
        if (current.sourceState !== 'healthy') throw new Error('Universe evidence is degraded');
        const generation = current.runs.length + 1;
        const previous = summary.steps.at(-1);
        if (previous) {
          const previousRun = current.runs.find((run) => run.id === previous.runId);
          if (generation !== previous.generation + (previousRun ? 1 : 0)) {
            return finish('failed', 'Unexpected Universe generation interleaving; campaign reservation scope changed');
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
        if (!variants.length) return finish('completed', 'Campaign model-request reservation budget exhausted');
        const runId = randomUUID();
        const ordinal = summary.progress.attempts + 1;
        // Reserve the complete scheduled request envelope before any worker or
        // provider contact. Interrupted/unused reservations are never refunded.
        appendCampaignEvent(directory, { kind: 'step', at: new Date().toISOString(), ordinal, runId, generation,
          variantIds: variants.map((variant) => variant.id), reservedModelRequests });
        const result = await runUniverseOwned(summary.definition.universeId, { root: options.root, resourceRuntime: options.resourceRuntime,
          signal: controller.signal, runId, campaign: { id, ordinal, definitionDigest: summary.definitionDigest },
          deadlineMs: Date.parse(deadlineAt), trialLimit: variants.length,
          ...(summary.definition.feedback ? { feedback: true as const } : {}),
        }, lock);
        if (result.status === 'failed') return finish('failed', 'Universe generation failed; inspect its durable evidence');
        if (result.status === 'interrupted' && !controller.signal.aborted) {
          return finish('interrupted', 'Universe generation interrupted before campaign completion');
        }
        // Existing owner controls and terminal time budgets take precedence over
        // an operational pause. The top of the loop reconciles their exact state.
        if (controller.signal.aborted || Date.now() >= Date.parse(deadlineAt)) continue;
        // Withheld capacity and lost handoffs are operational outcomes, not
        // evidence that another candidate would improve the objective. Keep the
        // reservation, but do not burn the remaining campaign on rapid retries.
        if (result.trials.some((trial) => trial.generation?.resource &&
            (trial.generation.resource.dispatch !== 'settled' ||
             trial.generation.resource.taskStatus !== 'completed'))) {
          return finish('paused', 'Resource generation requires attention; inspect task evidence before resuming');
        }
        // No bounded local completion means there is no candidate to learn from.
        // Keep this generation's reservations, but do not spend the remaining
        // campaign retrying an unavailable service. Recorded malformed responses
        // and evaluator rejections still feed ordinary autonomous correction.
        if (result.trials.some((trial) => trial.generation?.provider === 'local-openai-compatible' &&
            trial.generation.status !== 'succeeded' && trial.generation.responseDigest === null)) {
          return finish('paused', 'Local generation did not receive a completion; inspect the local service before resuming');
        }
      }
    } catch (error) {
      controller.abort();
      if (error instanceof CampaignExpectationError || error instanceof CampaignControlConflictError) throw error;
      if (!ownsLocalStoreLock(lock)) throw error;
      const summary = readUniverseCampaign(id, options);
      if (summary.sourceState !== 'healthy') return summary;
      return finish('failed', error instanceof Error ? error.message.slice(0, 1_024) : 'Campaign execution failed', admissionDigest);
    } finally {
      if (poll) clearInterval(poll);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', cancel);
    }
  });
}
