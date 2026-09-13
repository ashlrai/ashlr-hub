/** Shared strict observation codec. No browser client, filesystem or execution imports. */
import type { ResourceEngineeringOutcomes as Outcomes, ResourceEngineeringCampaignOutcome as Campaign,
  ResourceEngineeringOutcomeUsage as Usage, ResourceEngineeringOutcomeTiming as Timing } from './engineering-outcomes-types.js';
import type { ResourceConsoleEngineeringEnrollment as Enrollment } from './console-engineering-types.js';
import { validEngineeringPhaseEvidence } from './engineering-phase-validation.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 &&
  new TextEncoder().encode(v).byteLength <= max && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
const nullable = (v: unknown, valid: (v: unknown) => boolean) => v === null || valid(v);
export const engineeringOutcomeReasons: Record<string, string> = {
  'worker-receipt-unverified': 'A worker attempt could not be joined to its exact shared-ledger receipt.',
  'delivery-evidence-unavailable': 'Current local delivery evidence is unavailable.',
  'delivery-evidence-unverified': 'The planned local delivery could not be verified.',
  'campaign-evidence-unavailable': 'Campaign evidence is unavailable.',
  'outcome-evidence-incomplete': 'Some outcome or usage evidence is incomplete.',
  'enrollment-or-ledger-unavailable': 'The enrolled plan or shared resource ledger could not be verified.',
  'outcome-evidence-bounds-exceeded': 'The evidence exceeds this bounded report; no partial campaign list is shown.',
  'evidence-changed-during-sampling': 'Evidence changed during the read. Read it again for a fresh sample.',
  'usage-accounting-overflow': 'Recorded usage cannot be totaled safely; aggregate usage is unavailable.',
};
const reasons = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 128 && v.every(r => typeof r === 'string' && Object.hasOwn(engineeringOutcomeReasons, r));
const invalid = () => new Error('Outcome evidence could not be verified. Refresh evidence before relying on it.');

function usage(v: unknown): v is Usage {
  if (!object(v) || !exact(v, ['attempts', 'joinedAttempts', 'reportedAttempts', 'unknownAttempts', 'recordedInputTokens',
    'recordedOutputTokens', 'totalTokens', 'complete']) || !count(v.attempts) || !count(v.joinedAttempts) || !count(v.reportedAttempts) ||
    !count(v.unknownAttempts) || !count(v.recordedInputTokens) || !count(v.recordedOutputTokens) || typeof v.complete !== 'boolean' ||
    !nullable(v.totalTokens, count)) return false;
  return v.reportedAttempts <= v.joinedAttempts && v.joinedAttempts <= v.attempts &&
    v.unknownAttempts === v.attempts - v.reportedAttempts &&
    (v.complete ? v.unknownAttempts === 0 && (v.attempts === 0 ? v.totalTokens === null : v.totalTokens === v.recordedInputTokens + v.recordedOutputTokens) : v.totalTokens === null);
}

function timing(v: unknown): v is Timing {
  return object(v) && exact(v, ['scope', 'attempts', 'measuredAttempts', 'recordedDurationMs', 'totalDurationMs', 'complete']) &&
    v.scope === 'summed-worker-execution' && count(v.attempts) && count(v.measuredAttempts) && v.measuredAttempts <= v.attempts &&
    finite(v.recordedDurationMs) && v.recordedDurationMs >= 0 && nullable(v.totalDurationMs, n => finite(n) && n >= 0) &&
    typeof v.complete === 'boolean' && (v.complete ? v.measuredAttempts === v.attempts &&
      (v.attempts === 0 ? v.totalDurationMs === null : v.totalDurationMs === v.recordedDurationMs) : v.totalDurationMs === null);
}

function campaign(v: unknown): v is Campaign {
  if (!object(v) || !exact(v, ['campaignId', 'universeId', 'definitionDigest', 'comparatorDigest', 'state', 'sourceState', 'reasons',
    'metric', 'seed', 'stages', 'usage', 'timing', 'niches', 'workers', ...(Object.hasOwn(v, 'phaseEvidence') ? ['phaseEvidence'] : [])]) ||
    Object.hasOwn(v, 'phaseEvidence') && !validEngineeringPhaseEvidence(v.phaseEvidence) || !text(v.campaignId, 64) || !nullable(v.universeId, n => text(n, 64)) ||
    !nullable(v.definitionDigest, hash) || !nullable(v.comparatorDigest, hash) || !nullable(v.state, n => text(n, 64)) ||
    !['healthy', 'unavailable'].includes(String(v.sourceState)) || !reasons(v.reasons) || !usage(v.usage) || !timing(v.timing) || v.timing.attempts !== v.usage.attempts) return false;
  if (v.metric !== null && (!object(v.metric) || !exact(v.metric, ['name', 'direction', 'minImprovement']) || !text(v.metric.name) ||
    !['maximize', 'minimize'].includes(String(v.metric.direction)) || !finite(v.metric.minImprovement) || v.metric.minImprovement < 0)) return false;
  if (!object(v.seed) || !exact(v.seed, ['status', 'score', 'passed']) ||
    !['unmeasured', 'pending', 'measured', 'unavailable'].includes(String(v.seed.status)) || !nullable(v.seed.score, finite) ||
    !(v.seed.passed === null || typeof v.seed.passed === 'boolean') ||
    (v.seed.status !== 'measured' && (v.seed.score !== null || v.seed.passed !== null))) return false;
  if (!object(v.stages) || !exact(v.stages, ['trials', 'evaluated', 'passed', 'rejected', 'selected', 'strictImprovements', 'verifiedLocalDeliveries']) ||
    !Object.entries(v.stages).every(([k, n]) => k === 'verifiedLocalDeliveries' ? nullable(n, count) : count(n))) return false;
  const stages = v.stages as unknown as Campaign['stages'];
  if (stages.passed + stages.rejected !== stages.evaluated || stages.evaluated > stages.trials || stages.selected > stages.passed ||
    stages.strictImprovements > stages.selected || stages.verifiedLocalDeliveries !== null && stages.verifiedLocalDeliveries > 1) return false;
  if (!Array.isArray(v.niches) || v.niches.length > 256 || !v.niches.every(n => object(n) &&
    exact(n, ['niche', 'score', 'deltaFromSeed', 'artifactDigest', 'runId', 'trialId']) && text(n.niche) && finite(n.score) &&
    nullable(n.deltaFromSeed, finite) && hash(n.artifactDigest) && text(n.runId, 128) && text(n.trialId, 128)) ||
    new Set(v.niches.map(n => n.niche)).size !== v.niches.length || v.niches.length > stages.selected) return false;
  if (!Array.isArray(v.workers) || v.workers.length > 256 || !v.workers.every(w => object(w) &&
    exact(w, ['workerId', 'provider', 'model', 'usage', 'timing', 'evaluated', 'passed', 'rejected']) && text(w.workerId, 128) && text(w.provider) &&
    text(w.model) && usage(w.usage) && timing(w.timing) && w.timing.attempts === w.usage.attempts && count(w.evaluated) && count(w.passed) && count(w.rejected) &&
    w.passed + w.rejected === w.evaluated && w.evaluated <= w.usage.attempts) ||
    new Set(v.workers.map(w => w.workerId)).size !== v.workers.length) return false;
  return true;
}

/** The selected host enrollment, not response-provided paths, defines the read scope. */
export function validateResourceEngineeringOutcomes(value: unknown, selected: Enrollment): Outcomes {
  if (!object(selected) || !text(selected.id, 64) || !hash(selected.enrollmentDigest) || !Array.isArray(selected.campaigns) || !object(value) ||
    !exact(value, ['schemaVersion', 'enrollmentId', 'enrollmentDigest', 'sampledAt', 'sourceState', 'scope', 'authority',
      'acceptanceScope', 'attribution', 'productionAccepted', 'routingChanged', 'complete', 'reasons', 'usage', 'timing', 'campaigns']) ||
    value.schemaVersion !== 1 || value.enrollmentId !== selected.id || value.enrollmentDigest !== selected.enrollmentDigest ||
    !['healthy', 'degraded', 'unavailable'].includes(String(value.sourceState)) ||
    value.scope !== 'campaign-evaluations-and-recorded-worker-usage' || value.authority !== 'observation-only' ||
    value.acceptanceScope !== 'fixed-evaluator-and-local-branch-only' || value.attribution !== 'campaign-cumulative-not-graph-invocation' ||
    value.productionAccepted !== null || value.routingChanged !== false || typeof value.complete !== 'boolean' ||
    typeof value.sampledAt !== 'string' || !Number.isFinite(Date.parse(value.sampledAt)) || new Date(value.sampledAt).toISOString() !== value.sampledAt ||
    !reasons(value.reasons) || !usage(value.usage) || !timing(value.timing) || value.timing.attempts !== value.usage.attempts || !Array.isArray(value.campaigns) || value.campaigns.length > 32 ||
    !value.campaigns.every(campaign) || new Set(value.campaigns.map(c => c.campaignId)).size !== value.campaigns.length ||
    !(value.sourceState === 'unavailable' && value.complete === false && value.campaigns.length === 0) && value.campaigns.length !== selected.campaigns.length ||
    value.campaigns.some(c => !selected.campaigns.some(s => s.id === c.campaignId))) throw invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 192 * 1024) throw invalid();
  if (value.complete && (value.sourceState !== 'healthy' || value.reasons.length > 0 || !value.usage.complete || !value.timing.complete ||
    value.campaigns.some(c => c.sourceState !== 'healthy' || c.reasons.length > 0 || !c.usage.complete || !c.timing.complete))) throw invalid();
  return value as unknown as Outcomes;
}
