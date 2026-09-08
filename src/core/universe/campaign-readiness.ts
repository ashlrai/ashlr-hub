import { isAbsolute, parse, resolve } from 'node:path';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { campaignBudgetLimit, type UniverseCampaignExpectation } from './campaign.js';
import {
  campaignDirectory, campaignUniverse, foldCampaignEvents, projectCampaign, readCampaignEvents,
  terminalCampaign, type CampaignEvent,
} from './campaign-store.js';
import { scheduledVariants } from './store.js';
import type { UniverseCampaignSummary, UniverseSummary } from './types.js';

export type UniverseCampaignReadinessDisposition =
  'startable' | 'owned' | 'owner-held' | 'resource-withheld' | 'recovery-required' |
  'attention-required' | 'budget-exhausted' | 'terminal' | 'unavailable';

export type UniverseCampaignReadinessReason =
  'never-started' | 'owner-active' | 'pause-requested' | 'stop-requested' | 'owner-paused' |
  'owner-abandoned' | 'run-incomplete' | 'resource-withheld' | 'resource-outcome-ambiguous' |
  'resource-attention-required' | 'generation-attention-required' | 'duration-budget-exhausted' | 'generation-budget-exhausted' |
  'stagnation-budget-exhausted' | 'request-budget-exhausted' | 'reported-token-budget-exhausted' |
  'usage-unavailable' | 'campaign-completed' | 'campaign-stopped' | 'campaign-failed' |
  'paused-unclassified' | 'interrupted-unclassified' | 'campaign-missing' | 'evidence-degraded' |
  'snapshot-changed';

/** Recorded evidence only, not a provider, capacity, evaluator or execution-lease attestation. */
export interface UniverseCampaignReadiness {
  schemaVersion: 1;
  readinessScope: 'recorded-campaign-evidence';
  campaignId: string;
  universeId: string | null;
  observedState: UniverseCampaignSummary['state'] | null;
  sourceState: 'healthy' | 'missing' | 'degraded';
  disposition: UniverseCampaignReadinessDisposition;
  reasonCode: UniverseCampaignReadinessReason;
  /** Advisory only. The runner must still perform its ordinary admission and identity checks. */
  automaticAction: 'run' | 'none';
  resourceRuntimeRequired: boolean | null;
  expectedIdentity: (UniverseCampaignExpectation & { summaryDigest: string }) | null;
  recordsDigest: string | null;
  sampledAt: string;
}

type Decision = Pick<UniverseCampaignReadiness, 'disposition' | 'reasonCode' | 'automaticAction'>;

function decision(disposition: UniverseCampaignReadinessDisposition, reasonCode: UniverseCampaignReadinessReason): Decision {
  return { disposition, reasonCode, automaticAction: disposition === 'startable' ? 'run' : 'none' };
}

function classify(events: CampaignEvent[], summary: UniverseCampaignSummary, universe: UniverseSummary, nowMs: number): Decision {
  const folded = foldCampaignEvents(events);
  if (terminalCampaign(summary.state)) {
    return decision('terminal', summary.state === 'completed' ? 'campaign-completed' :
      summary.state === 'stopped' ? 'campaign-stopped' : 'campaign-failed');
  }
  if (folded.state === 'pause-requested' || folded.state === 'stop-requested') {
    return decision('owner-held', folded.state);
  }
  const sessionSequence = [...events].reverse().find((event) => event.kind === 'started')?.sequence ?? -1;
  // A later started event consumes an earlier pause; free-form settlement prose
  // never creates or cancels a durable owner instruction.
  const control = [...events].reverse().find((event) => event.kind === 'control' && event.sequence > sessionSequence);
  if (summary.state === 'paused' && control?.kind === 'control' && control.action === 'pause') {
    return decision('owner-held', 'owner-paused');
  }
  if (summary.owner || universe.activeRun) return decision('owned', 'owner-active');
  if (folded.state === 'running') return decision('recovery-required', 'owner-abandoned');
  if (summary.steps.some((step) => step.state !== 'completed') || universe.runs.some((run) => run.finishedAt === null)) {
    return decision('recovery-required', 'run-incomplete');
  }
  const runs = summary.steps.map((step) => universe.runs.find((run) => run.id === step.runId)!);
  // An older uncertain handoff is not repaired by a later clean refusal. This
  // check does not read a pool ledger or infer that external occupancy cleared.
  if (runs.some((run) => run.trials.some((trial) => {
    const resource = trial.generation?.resource;
    return resource && (resource.dispatch === 'unavailable' || resource.dispatch === 'replayed' ||
      resource.taskStatus === 'reserved' || resource.taskStatus === 'uncertain');
  }))) return decision('recovery-required', 'resource-outcome-ambiguous');

  const budget = campaignBudgetLimit(summary, nowMs);
  if (budget) {
    const codes = { duration: 'duration-budget-exhausted', generations: 'generation-budget-exhausted',
      stagnation: 'stagnation-budget-exhausted', 'reported-tokens': 'reported-token-budget-exhausted',
      'unknown-usage': 'usage-unavailable' } as const;
    return decision(budget.code === 'unknown-usage' ? 'attention-required' : 'budget-exhausted', codes[budget.code]);
  }
  // Match the runner's prefix admission: a zero request allowance can still run
  // command-only variants, but cannot skip a leading generative variant.
  const first = scheduledVariants(universe.manifest, universe.runs.length + 1)[0];
  if (first?.generation && summary.progress.reservedModelRequests >= summary.definition.budget.maxModelRequests) {
    return decision('budget-exhausted', 'request-budget-exhausted');
  }
  if (summary.state === 'ready' && folded.startedAt === null && summary.steps.length === 0) {
    return decision('startable', 'never-started');
  }

  const latest = runs.at(-1);
  if (latest?.trials.some((trial) => trial.generation?.provider === 'local-openai-compatible' &&
    trial.generation.status !== 'succeeded')) return decision('attention-required', 'generation-attention-required');
  const resources = latest?.trials.flatMap((trial) => trial.generation?.resource ? [trial.generation.resource] : []) ?? [];
  if (latest?.trials.some((trial) => trial.generation?.resource?.dispatch === 'settled' &&
    trial.generation.status !== 'succeeded') || resources.some((resource) => resource.dispatch === 'not-started' ||
    resource.dispatch === 'settled' && resource.taskStatus !== 'completed')) {
    return decision('attention-required', 'resource-attention-required');
  }
  if (summary.state === 'paused' && latest?.status === 'completed' && latest.finishedAt !== null &&
    resources.some((resource) => resource.dispatch === 'withheld') &&
    resources.every((resource) => resource.dispatch === 'withheld' ||
      resource.dispatch === 'settled' && resource.taskStatus === 'completed')) {
    return decision('resource-withheld', 'resource-withheld');
  }
  return decision(summary.state === 'interrupted' ? 'recovery-required' : 'attention-required',
    summary.state === 'interrupted' ? 'interrupted-unclassified' : 'paused-unclassified');
}

/**
 * Observe an explicitly scoped, existing private store without acquiring locks,
 * writing recovery records, running evaluators, probing providers or dispatching.
 * Existing projections check pinned source/evaluator bytes; they do not establish
 * fresh evaluation or resource readiness. A healthy identity is a future CAS
 * precondition, never permission to bypass the runner's admission checks.
 */
export function readUniverseCampaignReadiness(id: string, options: { root: string }): UniverseCampaignReadiness {
  const root = options?.root;
  if (typeof root !== 'string' || Buffer.byteLength(root, 'utf8') > 4_096 ||
    [...root].some((character) => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) ||
    !isAbsolute(root) || resolve(root) !== root || parse(root).root === root) {
    throw new Error('Campaign readiness requires an explicit canonical absolute root');
  }
  const directory = campaignDirectory(id, { root });
  const base: UniverseCampaignReadiness = { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence',
    campaignId: id, universeId: null, observedState: null, sourceState: 'degraded',
    disposition: 'unavailable', reasonCode: 'evidence-degraded', automaticAction: 'none',
    resourceRuntimeRequired: null, expectedIdentity: null, recordsDigest: null, sampledAt: new Date().toISOString() };
  try {
    inspectPrivateDirectory(root);
    inspectPrivateDirectory(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ...base, sourceState: 'missing', reasonCode: 'campaign-missing' } : base;
  }
  try {
    const events = readCampaignEvents(directory);
    const folded = foldCampaignEvents(events);
    if (folded.created.definition.id !== id) return base;
    const recordsDigest = digest(canonical(events));
    const universe = campaignUniverse(folded.created, { root });
    const summary = projectCampaign(events, universe);
    // Owner controls appended during source projection invalidate this sample.
    // No second projection may quietly replace the captured control history.
    if (digest(canonical(readCampaignEvents(directory))) !== recordsDigest) {
      return { ...base, reasonCode: 'snapshot-changed' };
    }
    if (summary.sourceState !== 'healthy') return base;
    const nowMs = Date.now();
    return { ...base, ...classify(events, summary, universe, nowMs), sourceState: 'healthy',
      universeId: summary.definition.universeId, observedState: summary.state, recordsDigest,
      resourceRuntimeRequired: universe.manifest.variants.some((variant) => variant.generation?.kind === 'resource-pool'),
      expectedIdentity: { universeId: summary.definition.universeId, definitionDigest: summary.definitionDigest,
        manifestDigest: summary.manifestDigest, comparatorDigest: summary.comparatorDigest, summaryDigest: digest(canonical(summary)) },
      sampledAt: new Date(nowMs).toISOString() };
  } catch {
    // Diagnostic text may contain private paths. Fixed unavailable reports do not
    // echo raw storage errors or turn a damaged history into a fresh campaign.
    return base;
  }
}
