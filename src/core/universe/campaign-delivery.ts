import { resolve } from 'node:path';
import { canonical, defaultUniverseRoot, digest } from './artifacts.js';
import { runUniverseCampaign, type UniverseCampaignExpectation } from './campaign.js';
import { campaignDirectory, campaignUniverse, readCampaignEvents, readUniverseCampaign } from './campaign-store.js';
import { deliverUniverseEliteOwned, readUniverseDeliveries, validUniverseDeliveryBranch,
  type UniverseDeliveryReceipt } from './delivery.js';
import { withUniverseExecution } from './execution.js';
import { manifestRecord, universePath } from './store.js';
import type { UniverseCampaignSummary, UniverseRunOptions } from './types.js';

export interface UniverseCampaignDeliveryOptions extends UniverseRunOptions {
  /** Explicit invocation intent, separate from the frozen experiment/campaign definitions. */
  delivery: { branch: string; baseCommit: string };
}
export interface UniverseCampaignDeliveryResult {
  campaign: UniverseCampaignSummary;
  delivery: { status: 'delivered'; receipt: UniverseDeliveryReceipt } |
    { status: 'withheld'; reason: 'campaign-not-completed' | 'cancelled' | 'no-strict-improvement' };
}
export interface UniverseCampaignDeliveryPlan {
  schemaVersion: 1;
  deliveries: Array<{ campaignId: string; branch: string; baseCommit: string }>;
}

function dataRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
      keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

/** Capture a closed invocation plan without invoking accessors or retaining caller-owned rows. */
export function validateUniverseCampaignDeliveryPlan(value: unknown, ids: string[]): UniverseCampaignDeliveryPlan {
  if (!dataRecord(value, ['schemaVersion', 'deliveries']) || value.schemaVersion !== 1 ||
      !Array.isArray(value.deliveries) || Object.getPrototypeOf(value.deliveries) !== Array.prototype ||
      value.deliveries.length < 1 || value.deliveries.length > 32 ||
      Reflect.ownKeys(value.deliveries).length !== value.deliveries.length + 1 ||
      Array.from({ length: value.deliveries.length }, (_, index) => Object.getOwnPropertyDescriptor(value.deliveries, String(index)))
        .some((property) => !property || !Object.hasOwn(property, 'value'))) throw new Error('Invalid campaign delivery plan');
  const seen = new Set<string>();
  const deliveries = value.deliveries.map((row: unknown) => {
    if (!dataRecord(row, ['campaignId', 'branch', 'baseCommit']) || typeof row.campaignId !== 'string' ||
        !ids.includes(row.campaignId) || seen.has(row.campaignId) || !validUniverseDeliveryBranch(row.branch) ||
        typeof row.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.baseCommit)) {
      throw new Error('Invalid campaign delivery plan');
    }
    seen.add(row.campaignId);
    return { campaignId: row.campaignId, branch: row.branch, baseCommit: row.baseCommit };
  });
  return { schemaVersion: 1, deliveries };
}

/** Read-only preflight shared by single-campaign execution and whole-queue admission. */
export function preflightUniverseCampaignDelivery(id: string, options: UniverseCampaignDeliveryOptions): {
  campaign: UniverseCampaignSummary; repo: string;
} {
  const { branch, baseCommit } = options.delivery;
  if (!validUniverseDeliveryBranch(branch) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) {
    throw new Error('Campaign delivery requires a codex/ branch and exact pinned base commit');
  }
  const campaign = readUniverseCampaign(id, options);
  const universe = campaignUniverse(campaign, options);
  if (campaign.sourceState !== 'healthy' || universe.manifest.seed.revision !== baseCommit) {
    throw new Error('Campaign delivery base must match the healthy experiment pinned seed');
  }
  return { campaign, repo: universe.manifest.seed.repo };
}

function identity(summary: UniverseCampaignSummary): UniverseCampaignExpectation {
  return { universeId: summary.definition.universeId, definitionDigest: summary.definitionDigest,
    manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest };
}

/** Run within the existing budget, then materialize one measured improvement locally.
 * This never merges, pushes, checks out a branch, or changes supervisor semantics.
 * Repeating an invocation reuses the evidence-bound branch receipt, not a new commit.
 */
export async function runUniverseCampaignAndDeliver(id: string,
  options: UniverseCampaignDeliveryOptions): Promise<UniverseCampaignDeliveryResult> {
  const store = { root: resolve(options.root ?? defaultUniverseRoot()) };
  const delivery = { ...options.delivery };
  const initial = preflightUniverseCampaignDelivery(id, { ...store, delivery }).campaign;
  const campaign = await runUniverseCampaign(id, { ...store, signal: options.signal,
    resourceRuntime: options.resourceRuntime, expectedIdentity: identity(initial) });
  if (options.signal?.aborted) return { campaign, delivery: { status: 'withheld', reason: 'cancelled' } };
  if (campaign.state !== 'completed') return { campaign, delivery: { status: 'withheld', reason: 'campaign-not-completed' } };
  return deliverCompletedUniverseCampaign(id, { ...store, delivery, signal: options.signal,
    expectedIdentity: { ...identity(initial), summaryDigest: digest(canonical(campaign)) } });
}

/** Delivery-only reconciliation: never starts/resumes a campaign or contacts its resource runtime. */
export async function deliverCompletedUniverseCampaign(id: string,
  options: UniverseCampaignDeliveryOptions & { expectedIdentity?: UniverseCampaignExpectation;
    /** Absolute performance.now() deadline for in-process orchestration. */
    deadlineMonotonicMs?: number }): Promise<UniverseCampaignDeliveryResult> {
  const { branch, baseCommit } = options.delivery;
  const store = { root: resolve(options.root ?? defaultUniverseRoot()) };
  const initial = preflightUniverseCampaignDelivery(id, { ...store, delivery: { branch, baseCommit } }).campaign;
  const expectedIdentity = { ...(options.expectedIdentity ?? identity(initial)) };
  const universeId = initial.definition.universeId;
  const directory = universePath(store.root, universeId);
  return withUniverseExecution(universeId, store, async (lock) => {
    const current = readUniverseCampaign(id, store);
    const universe = campaignUniverse(current, store);
    if (current.sourceState !== 'healthy' || current.definition.universeId !== expectedIdentity.universeId ||
        current.definition.universeId !== universeId || current.definitionDigest !== expectedIdentity.definitionDigest ||
        current.manifestDigest !== expectedIdentity.manifestDigest || current.comparatorDigest !== expectedIdentity.comparatorDigest ||
        expectedIdentity.summaryDigest !== undefined && digest(canonical(current)) !== expectedIdentity.summaryDigest ||
        expectedIdentity.recordsDigest !== undefined && digest(canonical(readCampaignEvents(campaignDirectory(id, store)))) !== expectedIdentity.recordsDigest ||
        universe.manifest.seed.revision !== baseCommit) throw new Error('Campaign delivery evidence changed after execution');
    if (options.signal?.aborted) return { campaign: current, delivery: { status: 'withheld', reason: 'cancelled' } };
    if (current.state !== 'completed') return { campaign: current, delivery: { status: 'withheld', reason: 'campaign-not-completed' } };
    const seedDigest = manifestRecord(directory).seedArtifact.digest;
    const allTrials = new Map(universe.runs.flatMap((run) => run.trials).map((trial) => [trial.id, trial]));
    const trials = universe.runs.flatMap((run) => run.status === 'completed' &&
      run.campaign?.id === id && run.campaign.definitionDigest === current.definitionDigest &&
      current.steps.some((step) => step.runId === run.id && step.ordinal === run.campaign!.ordinal)
      ? run.trials.filter((trial) => {
        const parent = trial.parentTrialId ? allTrials.get(trial.parentTrialId) : undefined;
        return trial.selected && trial.status === 'passed' && trial.score !== null && trial.delta !== null && trial.delta > 0 &&
          trial.artifact && trial.artifact.digest !== seedDigest && parent?.artifact && trial.artifact.digest !== parent.artifact.digest;
      }) : []);
    const prior = readUniverseDeliveries(universeId, store);
    if (prior.sourceState === 'degraded') throw new Error('Campaign delivery ledger is degraded');
    const existing = prior.deliveries.find((receipt) => receipt.branch === branch);
    if (existing && (existing.baseCommit !== baseCommit || !trials.some((trial) => trial.id === existing.trialId))) {
      throw new Error('Campaign delivery branch belongs to different or non-improving evidence');
    }
    // Existing receipts remain replayable even after a later campaign replaces the elite.
    const direction = universe.manifest.metric.direction === 'maximize' ? -1 : 1;
    const selected = existing ? trials.find((trial) => trial.id === existing.trialId) : trials
      .filter((trial) => universe.elites.some((elite) => elite.trialId === trial.id))
      .sort((a, b) => direction * (a.score! - b.score!) || a.id.localeCompare(b.id))[0];
    if (!selected) return { campaign: current, delivery: { status: 'withheld', reason: 'no-strict-improvement' } };
    const receipt = await deliverUniverseEliteOwned(universeId, { ...store, trialId: selected.id, branch, signal: options.signal,
      deadlineMonotonicMs: options.deadlineMonotonicMs }, lock);
    if (receipt.status !== 'delivered') throw new Error('Campaign delivery did not produce a changed local branch');
    return { campaign: current, delivery: { status: 'delivered', receipt } };
  });
}
