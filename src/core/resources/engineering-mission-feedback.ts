/** Bounded proposal context, never acceptance, causal credit or routing authority. */
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import type { ResourceEngineeringOutcomes } from './engineering-outcomes-types.js';

export const MISSION_MEASURED_FEEDBACK = 'measured-outcomes-v1' as const;
export const MAX_MISSION_FEEDBACK_BYTES = 16 * 1024;
export const MAX_MISSION_FEEDBACK_PROMPT_BYTES = 64 * 1024;
type Tip = { enrollmentId: string; enrollmentDigest: string; projectId: string; commit: string };
type Outcome = Omit<ResourceEngineeringOutcomes, 'sampledAt'>;
type Campaign = {
  campaignId: string; definitionDigest: string; comparatorDigest: string;
  metric: NonNullable<Outcome['campaigns'][number]['metric']>;
  seed: Outcome['campaigns'][number]['seed'];
  stages: Outcome['campaigns'][number]['stages'];
  selected: Array<{ niche: string; score: number; deltaFromSeed: number | null; artifactDigest: string }>;
  usage: { coverage: 'complete' | 'incomplete'; attempts: number; reportedAttempts: number; recordedInputTokens: number; recordedOutputTokens: number; totalTokens: number | null };
  timing: { scope: 'summed-worker-execution'; coverage: 'complete' | 'incomplete'; attempts: number; measuredAttempts: number; recordedDurationMs: number; totalDurationMs: number | null };
};
export interface EngineeringMissionFeedback {
  schemaVersion: 1; kind: 'engineering-measured-feedback'; scope: 'latest-delivered-enrollment';
  authority: 'observation-only'; productionAccepted: null; routingChanged: false;
  acceptanceScope: 'fixed-evaluator-and-local-branch-only'; attribution: 'campaign-cumulative-not-graph-invocation';
  source: Tip & { deliveryDigest: string }; evidenceDigest: string | null;
  availability: 'available' | 'unavailable'; reason: null | 'outcome-evidence-unavailable' | 'feedback-bounds-exceeded';
  campaigns: Campaign[];
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function requireFact(value: unknown): asserts value { if (!value) throw new Error('Mission feedback unavailable'); }

/** Called only with the existing predecessor reader's double-verified tip and
 * outcome join. Hashes exclude timestamps and unrelated account-wide activity.
 * An unavailable projection cannot invalidate or improve a completed outcome. */
export function projectEngineeringMissionFeedback(input: { tip: Tip; deliveryDigest: string; outcomes: Outcome }): EngineeringMissionFeedback {
  const captured = canonicalEvidencePackJsonV3(input);
  requireFact(captured !== null && Buffer.byteLength(captured) <= 256 * 1024);
  input = JSON.parse(captured) as typeof input;
  const sourceText = canonicalEvidencePackJsonV3({ ...input.tip, deliveryDigest: input.deliveryDigest });
  requireFact(sourceText !== null && Buffer.byteLength(sourceText) <= 1024);
  const source = JSON.parse(sourceText) as EngineeringMissionFeedback['source'];
  requireFact(Object.keys(source).sort().join(',') === 'commit,deliveryDigest,enrollmentDigest,enrollmentId,projectId' &&
    id(source.enrollmentId) && hash(source.enrollmentDigest) && id(source.projectId) && hash(source.deliveryDigest) &&
    typeof source.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit));
  const report: EngineeringMissionFeedback = { schemaVersion: 1, kind: 'engineering-measured-feedback',
    scope: 'latest-delivered-enrollment', authority: 'observation-only', productionAccepted: null, routingChanged: false,
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation',
    source, evidenceDigest: null, availability: 'unavailable', reason: 'outcome-evidence-unavailable', campaigns: [] };
  try {
    const text = canonicalEvidencePackJsonV3(input.outcomes);
    requireFact(text !== null && Buffer.byteLength(text) <= 192 * 1024);
    const outcomes = JSON.parse(text) as Outcome;
    requireFact(outcomes.schemaVersion === 1 && outcomes.enrollmentId === source.enrollmentId && outcomes.enrollmentDigest === source.enrollmentDigest &&
      ['healthy', 'degraded'].includes(outcomes.sourceState) && outcomes.authority === 'observation-only' && outcomes.productionAccepted === null &&
      outcomes.scope === 'campaign-evaluations-and-recorded-worker-usage' && outcomes.acceptanceScope === 'fixed-evaluator-and-local-branch-only' &&
      outcomes.attribution === 'campaign-cumulative-not-graph-invocation' && outcomes.routingChanged === false &&
      Array.isArray(outcomes.campaigns) && outcomes.campaigns.length > 0 && outcomes.campaigns.length <= 32 &&
      new Set(outcomes.campaigns.map(row => row.campaignId)).size === outcomes.campaigns.length);
    const campaigns = outcomes.campaigns.map((row): Campaign => {
      requireFact(row.sourceState === 'healthy' && row.reasons.length === 0 && id(row.campaignId) &&
        hash(row.definitionDigest) && hash(row.comparatorDigest) && row.metric &&
        typeof row.metric.name === 'string' && row.metric.name.length > 0 && Buffer.byteLength(row.metric.name) <= 120 &&
        ['minimize', 'maximize'].includes(row.metric.direction) && finite(row.metric.minImprovement) && row.metric.minImprovement >= 0);
      requireFact(['unmeasured', 'pending', 'measured', 'unavailable'].includes(row.seed.status) &&
        (row.seed.status === 'measured' ? finite(row.seed.score) && typeof row.seed.passed === 'boolean' : row.seed.score === null && row.seed.passed === null));
      requireFact(['trials', 'evaluated', 'passed', 'rejected', 'selected', 'strictImprovements'].every(key => count(row.stages[key as keyof typeof row.stages])) &&
        (row.stages.verifiedLocalDeliveries === null || row.stages.verifiedLocalDeliveries === 0 || row.stages.verifiedLocalDeliveries === 1) &&
        Array.isArray(row.niches) && row.niches.length <= 64);
      const selected = row.niches.map(value => {
        requireFact(typeof value.niche === 'string' && value.niche.length > 0 && Buffer.byteLength(value.niche) <= 256 && finite(value.score) && (value.deltaFromSeed === null || finite(value.deltaFromSeed)) && hash(value.artifactDigest));
        return { niche: value.niche, score: value.score, deltaFromSeed: value.deltaFromSeed, artifactDigest: value.artifactDigest };
      });
      requireFact(count(row.usage.attempts) && count(row.usage.reportedAttempts) && row.usage.reportedAttempts <= row.usage.attempts &&
        row.usage.joinedAttempts === row.usage.attempts && typeof row.usage.complete === 'boolean' &&
        row.usage.unknownAttempts === row.usage.attempts - row.usage.reportedAttempts &&
        count(row.usage.recordedInputTokens) && count(row.usage.recordedOutputTokens) &&
        (!row.usage.complete || row.usage.reportedAttempts === row.usage.attempts) &&
        (row.usage.complete && row.usage.attempts > 0 ? count(row.usage.totalTokens) &&
          row.usage.totalTokens === row.usage.recordedInputTokens + row.usage.recordedOutputTokens : row.usage.totalTokens === null));
      requireFact(row.timing.scope === 'summed-worker-execution' && typeof row.timing.complete === 'boolean' &&
        count(row.timing.attempts) && count(row.timing.measuredAttempts) && row.timing.measuredAttempts <= row.timing.attempts &&
        row.timing.attempts === row.usage.attempts && finite(row.timing.recordedDurationMs) && row.timing.recordedDurationMs >= 0 &&
        (!row.timing.complete || row.timing.measuredAttempts === row.timing.attempts) &&
        (row.timing.complete && row.timing.attempts > 0 ? finite(row.timing.totalDurationMs) &&
          row.timing.totalDurationMs === row.timing.recordedDurationMs : row.timing.totalDurationMs === null));
      return { campaignId: row.campaignId, definitionDigest: row.definitionDigest, comparatorDigest: row.comparatorDigest,
        metric: { name: row.metric.name, direction: row.metric.direction, minImprovement: row.metric.minImprovement },
        seed: { status: row.seed.status, score: row.seed.score, passed: row.seed.passed },
        stages: { trials: row.stages.trials, evaluated: row.stages.evaluated, passed: row.stages.passed, rejected: row.stages.rejected,
          selected: row.stages.selected, strictImprovements: row.stages.strictImprovements, verifiedLocalDeliveries: row.stages.verifiedLocalDeliveries }, selected,
        usage: { coverage: row.usage.complete ? 'complete' : 'incomplete', attempts: row.usage.attempts,
          reportedAttempts: row.usage.reportedAttempts, recordedInputTokens: row.usage.recordedInputTokens,
          recordedOutputTokens: row.usage.recordedOutputTokens, totalTokens: row.usage.totalTokens },
        timing: { scope: 'summed-worker-execution', coverage: row.timing.complete ? 'complete' : 'incomplete',
          attempts: row.timing.attempts, measuredAttempts: row.timing.measuredAttempts,
          recordedDurationMs: row.timing.recordedDurationMs, totalDurationMs: row.timing.totalDurationMs } };
    });
    requireFact(campaigns.some(row => row.stages.verifiedLocalDeliveries === 1));
    const projected = { ...report, availability: 'available' as const, reason: null, campaigns,
      evidenceDigest: digest(canonical({ source, campaigns })) };
    // Omitted detail still binds the exact meaningful evidence on restart.
    if (Buffer.byteLength(canonical(projected)) > MAX_MISSION_FEEDBACK_BYTES) return { ...report,
      evidenceDigest: projected.evidenceDigest, reason: 'feedback-bounds-exceeded' };
    return projected;
  } catch { return report; }
}
