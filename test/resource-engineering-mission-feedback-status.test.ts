/** Pure retained-envelope projection: not fresh delivery or model acceptance. */
import { describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readRecordedMissionFeedbackStatus } from '../src/core/resources/engineering-mission-feedback-status.js';
import { missionRecord } from '../src/core/resources/engineering-mission-store.js';

function fixture(index = 1) {
  const tip = { enrollmentId: 'enrollment', enrollmentDigest: 'a'.repeat(64), projectId: 'hub', commit: 'b'.repeat(40) };
  const source = { ...tip, deliveryDigest: 'c'.repeat(64) };
  // Summary is explicitly envelope-only; detailed campaign facts are not
  // returned or promoted to fresh evidence by this reader.
  const campaigns = [{ campaignId: 'example', privateDetail: '/private/not-returned' }];
  const feedback = { schemaVersion: 1, kind: 'engineering-measured-feedback', scope: 'latest-delivered-enrollment',
    authority: 'observation-only', productionAccepted: null, routingChanged: false,
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', attribution: 'campaign-cumulative-not-graph-invocation',
    source, evidenceDigest: digest(canonical({ source, campaigns })), availability: 'available', reason: null, campaigns };
  const prompt = { schemaVersion: 1, kind: 'engineering-mission-proposal', instruction: 'PRIVATE_PROMPT', delivered: tip,
    feedbackVersion: 'measured-outcomes-v1', measuredFeedback: feedback };
  const rows = (input: unknown = prompt) => [missionRecord('settled', index, { tip }),
    missionRecord('proposal', index, { task: { prompt: canonical(input) } })];
  return { tip, feedback, prompt, rows };
}
describe('retained mission feedback visibility', () => {
  it('distinguishes absent intent from unavailable evidence', () => {
    expect(readRecordedMissionFeedbackStatus([])).toMatchObject({ state: 'not-recorded', scopeIndex: null,
      availability: null, campaignCount: null, evidenceState: 'not-revalidated' });
  });
  it('summarizes only fixed metadata and preserves input', () => {
    const f = fixture(); const rows = f.rows(); const before = canonical(rows);
    const summary = readRecordedMissionFeedbackStatus(rows);
    expect(summary).toMatchObject({ state: 'recorded', scopeIndex: 1, availability: 'available',
      evidenceDigest: f.feedback.evidenceDigest, campaignCount: 1, scope: 'retained-proposal-intent-only', evidenceState: 'not-revalidated' });
    expect(canonical(summary)).not.toMatch(/PRIVATE_PROMPT|privateDetail|not-returned|instruction/);
    expect(canonical(rows)).toBe(before);
  });
  it.each(['outcome-evidence-unavailable', 'feedback-bounds-exceeded'])('makes %s explicit', reason => {
    const f = fixture();
    const prompt = { ...f.prompt, measuredFeedback: { ...f.feedback, availability: 'unavailable', reason,
      campaigns: [], evidenceDigest: reason === 'feedback-bounds-exceeded' ? 'd'.repeat(64) : null } };
    expect(readRecordedMissionFeedbackStatus(f.rows(prompt))).toMatchObject({ state: 'recorded', availability: 'unavailable', reason, campaignCount: 0 });
  });
  it('uses the latest retained proposal independent of record enumeration order', () => {
    const a = fixture(1); const b = fixture(2);
    expect(readRecordedMissionFeedbackStatus([...b.rows(), ...a.rows()]).scopeIndex).toBe(2);
  });
  it.each(['digest', 'source', 'delivered', 'mode', 'reason', 'authority', 'campaigns', 'extra'])('marks malformed %s invalid without leaking details', key => {
    const f = fixture(); const prompt = structuredClone(f.prompt);
    if (key === 'digest') prompt.measuredFeedback.evidenceDigest = 'e'.repeat(64);
    if (key === 'source') prompt.measuredFeedback.source.commit = 'f'.repeat(40);
    if (key === 'delivered') prompt.delivered.commit = 'f'.repeat(40);
    if (key === 'mode') prompt.feedbackVersion = 'PRIVATE_SECRET';
    if (key === 'reason') Object.assign(prompt.measuredFeedback, { reason: 'PRIVATE_SECRET' });
    if (key === 'authority') prompt.measuredFeedback.authority = 'PRIVATE_SECRET';
    if (key === 'campaigns') prompt.measuredFeedback.campaigns = [];
    if (key === 'extra') Object.assign(prompt.measuredFeedback, { privateSecret: 'PRIVATE_SECRET' });
    const result = readRecordedMissionFeedbackStatus(f.rows(prompt));
    expect(result).toMatchObject({ state: 'invalid', reason: 'proposal-feedback-invalid', availability: null, evidenceDigest: null, campaignCount: null });
    expect(canonical(result)).not.toContain('PRIVATE_SECRET');
  });
  it('refuses absent completion, malformed JSON and over-bound prompts', () => {
    const f = fixture();
    expect(readRecordedMissionFeedbackStatus(f.rows().slice(1)).state).toBe('invalid');
    for (const prompt of ['{', 'x'.repeat(65537), JSON.stringify(f.prompt, null, 2)]) {
      expect(readRecordedMissionFeedbackStatus([f.rows()[0]!, missionRecord('proposal', 1, { task: { prompt } })]).state).toBe('invalid');
    }
  });
  it('does not accept unavailable evidence with contradictory details', () => {
    const f = fixture();
    for (const patch of [{ reason: 'outcome-evidence-unavailable', evidenceDigest: 'd'.repeat(64), campaigns: [] },
      { reason: 'feedback-bounds-exceeded', evidenceDigest: null, campaigns: [] },
      { reason: 'outcome-evidence-unavailable', evidenceDigest: null, campaigns: f.feedback.campaigns }]) {
      expect(readRecordedMissionFeedbackStatus(f.rows({ ...f.prompt, measuredFeedback: { ...f.feedback, availability: 'unavailable', ...patch } })).state).toBe('invalid');
    }
  });
});
