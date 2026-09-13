/** A bounded view of retained proposal intent, not proof it was dispatched or consumed. */
import { canonical, digest } from '../universe/artifacts.js';
import { MAX_MISSION_FEEDBACK_PROMPT_BYTES, MISSION_MEASURED_FEEDBACK } from './engineering-mission-feedback.js';
import type { MissionRecord } from './engineering-mission-store.js';

export interface RecordedMissionFeedbackStatus {
  mode: typeof MISSION_MEASURED_FEEDBACK;
  scope: 'retained-proposal-intent-only';
  evidenceState: 'not-revalidated';
  state: 'not-recorded' | 'recorded' | 'invalid';
  scopeIndex: number | null;
  availability: 'available' | 'unavailable' | null;
  reason: 'outcome-evidence-unavailable' | 'feedback-bounds-exceeded' | 'proposal-feedback-invalid' | null;
  evidenceDigest: string | null;
  campaignCount: number | null;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function requireFact(value: unknown): asserts value { if (!value) throw new Error('Recorded feedback unavailable'); }

/** The immutable record reader validates ordering and task shape first. This
 * projection checks the retained envelope and its digest, never rereads live
 * delivery/usage evidence or returns arbitrary prompt/model text. */
export function readRecordedMissionFeedbackStatus(rows: readonly MissionRecord[]): RecordedMissionFeedbackStatus {
  const result: RecordedMissionFeedbackStatus = { mode: MISSION_MEASURED_FEEDBACK,
    scope: 'retained-proposal-intent-only', evidenceState: 'not-revalidated', state: 'not-recorded',
    scopeIndex: null, availability: null, reason: null, evidenceDigest: null, campaignCount: null };
  const proposal = rows.filter(row => row.kind === 'proposal').sort((a, b) => b.index - a.index)[0];
  if (!proposal) return result;
  result.scopeIndex = proposal.index;
  try {
    requireFact(object(proposal.payload) && object(proposal.payload.task));
    const text = proposal.payload.task.prompt;
    requireFact(typeof text === 'string' && Buffer.byteLength(text) <= MAX_MISSION_FEEDBACK_PROMPT_BYTES);
    const prompt: unknown = JSON.parse(text);
    requireFact(object(prompt) && canonical(prompt) === text && prompt.schemaVersion === 1 &&
      prompt.kind === 'engineering-mission-proposal' && prompt.feedbackVersion === MISSION_MEASURED_FEEDBACK);
    const completion = rows.find(row => row.kind === 'settled' && row.index === proposal.index)?.payload;
    requireFact(object(completion) && object(completion.tip) && canonical(prompt.delivered) === canonical(completion.tip));
    const feedback = prompt.measuredFeedback;
    requireFact(exact(feedback, ['schemaVersion', 'kind', 'scope', 'authority', 'productionAccepted', 'routingChanged',
      'acceptanceScope', 'attribution', 'source', 'evidenceDigest', 'availability', 'reason', 'campaigns']) &&
      feedback.schemaVersion === 1 && feedback.kind === 'engineering-measured-feedback' && feedback.scope === 'latest-delivered-enrollment' &&
      feedback.authority === 'observation-only' && feedback.productionAccepted === null && feedback.routingChanged === false &&
      feedback.acceptanceScope === 'fixed-evaluator-and-local-branch-only' && feedback.attribution === 'campaign-cumulative-not-graph-invocation');
    requireFact(exact(feedback.source, ['enrollmentId', 'enrollmentDigest', 'projectId', 'commit', 'deliveryDigest']) && hash(feedback.source.deliveryDigest));
    const { deliveryDigest: _deliveryDigest, ...tip } = feedback.source;
    requireFact(canonical(tip) === canonical(completion.tip) && Array.isArray(feedback.campaigns));
    if (feedback.availability === 'available') {
      requireFact(feedback.reason === null && feedback.campaigns.length > 0 && feedback.campaigns.length <= 32 && hash(feedback.evidenceDigest) &&
        feedback.evidenceDigest === digest(canonical({ source: feedback.source, campaigns: feedback.campaigns })));
    } else {
      requireFact(feedback.availability === 'unavailable' && feedback.campaigns.length === 0 &&
        (feedback.reason === 'outcome-evidence-unavailable' && feedback.evidenceDigest === null ||
          feedback.reason === 'feedback-bounds-exceeded' && hash(feedback.evidenceDigest)));
    }
    return { ...result, state: 'recorded', availability: feedback.availability as 'available' | 'unavailable',
      reason: feedback.reason as RecordedMissionFeedbackStatus['reason'], evidenceDigest: feedback.evidenceDigest as string | null,
      campaignCount: feedback.campaigns.length };
  } catch {
    return { ...result, state: 'invalid', reason: 'proposal-feedback-invalid' };
  }
}
