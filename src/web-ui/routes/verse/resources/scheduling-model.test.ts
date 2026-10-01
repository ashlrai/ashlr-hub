import { describe, expect, it } from 'vitest';
import { lastSchedulingAdvice, schedulingEvidence } from './scheduling-model.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const seat = { seatId: 'grok-work', engine: 'grok' };
const range = { p25: 60_000, p50: 120_000, p75: 180_000, samples: 7 };
function account(over: Record<string, unknown> = {}) {
  return { seatId: seat.seatId, observedAt: new Date(NOW - 60_000).toISOString(), admission: 'eligible', headroomPercent: 24,
    reset: { kind: 'fixed-period', at: new Date(NOW + 3_600_000).toISOString(), startsAt: new Date(NOW - 86_400_000).toISOString(), source: 'native-usage' },
    opportunity: { kind: 'before-reset', reason: 'private-provider-payload' }, forecast: null, ...over };
}
function budget(row: unknown = account()) {
  return { readingMaxAgeMs: 900_000, scheduling: { sourceState: 'ready', observedAt: new Date(NOW).toISOString(), accounts: [row] } };
}
function forecast(over: Record<string, unknown> = {}) {
  return { taskId: 'task-1', durationMs: range, tokens: { ...range, p25: 1200, p50: 1800, p75: 2400, samples: 3 },
    cohort: { engine: 'grok', model: 'grok-code', seatId: seat.seatId, taskKind: 'code' }, fit: 'likely-before-reset', limitations: ['secret'], ...over };
}

describe('read-only scheduling evidence', () => {
  it.each([
    ['stop-active', 'Stop is active'],
    ['preparation-cancelled', 'Scheduling preparation was cancelled'],
  ])('explains the recorded %s skip without treating it as an empty candidate set', (reason, label) => {
    const value = { scheduling: { advisory: { observedAt: new Date(NOW - 5000).toISOString(), state: 'skipped', reason } } };
    expect(lastSchedulingAdvice(value, NOW)).toContain(label);
    expect(lastSchedulingAdvice(value, NOW)).not.toContain('No comparable eligible pairs');
  });
  it('shows only real last-batch advice metadata and never infers calls, connections or raw reasons', () => {
    expect(lastSchedulingAdvice(budget(), NOW)).toBeNull();
    const value = { scheduling: { advisory: { observedAt: new Date(NOW - 5000).toISOString(), state: 'choice-returned', reason: 'eligible-choice-returned' } } };
    expect(lastSchedulingAdvice(value, NOW)).toMatch(/may be cached.*batch history, not a live connection or dispatch check/);
    value.scheduling.advisory.reason = '/Users/private/sk-secret';
    expect(lastSchedulingAdvice(value, NOW)).toBe('Last scheduling advice unavailable.');
  });
  it('uses actual provider period, reserve-adjusted percentage and provider age without inventing tokens', () => {
    const view = schedulingEvidence(budget(), seat, NOW);
    expect(view).toMatchObject({ state: 'ready', availability: '24% available after your reserve.', timing: 'Allowance resets in 1h 00m.', freshness: 'Reading 1m 00s ago.' });
    expect(view.opportunity).toMatch(/before this reset/);
    expect(view.forecast).toEqual(['Task completion estimate unavailable.']);
  });
  it('qualifies eligible local runtime without inventing subscription telemetry, while unknown remote readings stay unknown', () => {
    const row = account({ observedAt: null, headroomPercent: null, reset: { kind: 'unknown', at: null } });
    const local = schedulingEvidence(budget(row), { ...seat, engine: 'local' }, NOW);
    expect(local).toMatchObject({ state: 'ready', availability: 'Local throughput available under current runtime limits.',
      timing: 'Local work has no expiring subscription quota; runtime capacity still applies.',
      freshness: 'Local runtime admission reported; no subscription quota reading applies.', opportunity: null });
    expect(local.forecast).toEqual(['Task completion estimate unavailable.']);
    const remote = schedulingEvidence(budget(row), seat, NOW);
    expect(remote).toMatchObject({ state: 'stale', availability: 'Work capacity needs a fresh reading.', freshness: 'Provider reading time unknown.' });
    expect(schedulingEvidence(budget(account({ ...row, admission: 'unknown' })), { ...seat, engine: 'local' }, NOW).availability).not.toMatch(/available under current/);
  });
  it.each([{}, { scheduling: { sourceState: 'unavailable' } }, budget(account({ seatId: 'other-account' }))])('keeps old, unavailable and other-account DTOs unknown', (value) => {
    expect(schedulingEvidence(value, seat, NOW).state).toBe('unavailable');
  });
  it('never treats reset dates with unknown semantics as expiring capacity', () => {
    const view = schedulingEvidence(budget(account({ reset: { kind: 'unknown', at: new Date(NOW + 3000).toISOString() } })), seat, NOW);
    expect(view.opportunity).toBeNull();
    expect(view.timing).toBe('Reset behavior not reported.');
  });
  it('shows a qualified native Claude weekly deadline without inventing a period start or quota tokens', () => {
    const claude = { ...seat, engine: 'claude' };
    const row = account({ reset: { kind: 'weekly-deadline', at: new Date(NOW + 3_600_000).toISOString(), source: 'claude-native-usage-report', plan: 'max' },
      forecast: forecast({ cohort: { engine: 'claude', model: 'sonnet-5', seatId: seat.seatId, taskKind: 'code' } }) });
    const view = schedulingEvidence(budget(row), claude, NOW);
    expect(view.timing).toBe('Reported weekly allowance deadline in 1h 00m.');
    expect(view.opportunity).toMatch(/before this deadline/);
    expect(view.forecast.join(' ')).toMatch(/Recorded task is estimated to fit before this deadline/);
    expect(schedulingEvidence(budget(row), seat, NOW).opportunity).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/period start|no.rollover|saved|remaining account tokens:|expired savings/);
    expect(schedulingEvidence(budget(row), claude, NOW + 3_600_000).timing).toMatch(/weekly deadline has passed/);
  });
  it.each([
    { source: 'claude-native-usage-report', plan: 'unknown' },
    { source: 'cached-header', plan: 'max' },
    { source: 'claude-native-usage-report', plan: 'max', startsAt: new Date(NOW - 7 * 86_400_000).toISOString() },
    { source: 'claude-native-usage-report', plan: { toString() { throw new Error('private payload'); } } },
    { plan: 'pro' },
    { source: 'claude-native-usage-report', plan: 'max', at: null },
  ])('keeps unqualified Claude weekly reports unknown instead of modeling a deadline', (over) => {
    const row = account({ reset: { kind: 'weekly-deadline', at: new Date(NOW + 3000).toISOString(), ...over } });
    const view = schedulingEvidence(budget(row), { ...seat, engine: 'claude' }, NOW);
    expect(view.timing).toBe('Reset behavior not reported.'); expect(view.opportunity).toBeNull();
    expect(schedulingEvidence(budget(row), seat, NOW).opportunity).toBeNull();
  });
  it('distinguishes gradual release and nonexpiring balances', () => {
    const rolling = schedulingEvidence(budget(account({ reset: { kind: 'rolling-release', at: new Date(NOW + 600_000).toISOString() } })), seat, NOW);
    expect(rolling.timing).toMatch(/gradually.*10m/); expect(rolling.opportunity).toBeNull();
    expect(schedulingEvidence(budget(account({ reset: { kind: 'balance', at: null } })), seat, NOW).timing).toMatch(/Balance-based/);
  });
  it.each(['held', 'unknown'])('does not suggest dispatch for %s admissions or conflicting windows', (admission) => {
    const view = schedulingEvidence(budget(account({ admission })), seat, NOW);
    expect(view.opportunity).toBeNull(); expect(view.availability).not.toMatch(/24%/);
  });
  it('assembly time cannot freshen an old provider reading or past reset', () => {
    const view = schedulingEvidence(budget(account({ observedAt: new Date(NOW - 900_001).toISOString(), forecast: forecast() })), seat, NOW);
    expect(view.state).toBe('stale'); expect(view.opportunity).toBeNull(); expect(view.forecast).toEqual(['Task completion estimate unavailable.']);
    expect(schedulingEvidence(budget(), seat, NOW + 3_600_000).timing).toMatch(/reset has passed/);
  });
  it('qualifies a genuine recorded task with field-specific sample counts, not current-chat work or quota', () => {
    const view = schedulingEvidence(budget(account({ forecast: forecast() })), seat, NOW);
    expect(view.forecast[0]).toMatch(/Last selected task estimate.*recording time unknown.*recorded model grok-code/);
    expect(view.forecast[1]).toMatch(/1m 00s–3m 00s.*7 samples/);
    expect(view.forecast[2]).toMatch(/1,200–2,400.*3 samples; not remaining account tokens/);
    expect(view.forecast.join(' ')).toMatch(/not a completion guarantee/);
    expect(view.forecast.join(' ')).not.toMatch(/task-1|secret|current chat/);
    expect(view.forecastSummary).toMatchObject({
      recorded: 'Last selected task · recording time unknown. Not the current task or model.',
      duration: view.forecast[1], fit: 'Recorded task is estimated to fit before this reset.',
    });
  });
  it.each([
    { engine: 'claude', model: 'grok-code', seatId: seat.seatId, taskKind: 'code' },
    { engine: 'grok', model: null, seatId: seat.seatId, taskKind: 'code' },
    { engine: 'grok', model: 'grok-code', seatId: 'other-account', taskKind: 'code' },
  ])('refuses cross-engine/account or unknown-model cohorts', (cohort) => {
    expect(schedulingEvidence(budget(account({ forecast: forecast({ cohort }) })), seat, NOW).forecast).toEqual(['Task completion estimate unavailable.']);
  });
  it('refuses zero-initialized forecast fields instead of inventing instantaneous work or quota', () => {
    const view = schedulingEvidence(budget(account({ forecast: forecast({ durationMs: null, tokens: { p25: 0, p50: 0, p75: 0, samples: 2 } }) })), seat, NOW);
    expect(view.forecast).toEqual(['Task completion estimate unavailable.']);
    expect(view.forecast.join(' ')).not.toMatch(/estimated to fit/);
  });
  it.each([{ ...range, p25: 200_000 }, { ...range, samples: 0 }, { ...range, p75: Infinity }])('refuses malformed/empty percentiles', (durationMs) => {
    expect(schedulingEvidence(budget(account({ forecast: forecast({ durationMs, tokens: null }) })), seat, NOW).forecast).toEqual(['Task completion estimate unavailable.']);
  });
  it('ignores raw secrets, getters, duplicate bindings and oversized sparse payloads', () => {
    const value = budget(account({ forecast: forecast({ limitations: ['/Users/private/key sk-secret'], taskId: '/Users/private/key' }) }));
    Object.defineProperty(value.scheduling.accounts[0], 'headroomPercent', { get() { throw Error('secret'); } });
    expect(JSON.stringify(schedulingEvidence(value, seat, NOW))).not.toMatch(/secret|private/);
    value.scheduling.accounts = [account(), account()];
    expect(schedulingEvidence(value, seat, NOW).state).toBe('unavailable');
    value.scheduling.accounts = new Array(1_000_000_000);
    expect(schedulingEvidence(value, seat, NOW).state).toBe('unavailable');
  });
  it('requires a real started fixed period and source before claiming expiry', () => {
    const view = schedulingEvidence(budget(account({ reset: { kind: 'fixed-period', at: new Date(NOW + 6000).toISOString(), startsAt: new Date(NOW + 1000).toISOString(), source: 'native-usage' } })), seat, NOW);
    expect(view.opportunity).toBeNull(); expect(view.timing).toBe('Reset behavior not reported.');
  });
  it('recognizes only the established native Grok alias, not arbitrary custom engines', () => {
    const cohort = { engine: 'grok-cli', model: 'grok-code', seatId: seat.seatId, taskKind: 'code' };
    expect(schedulingEvidence(budget(account({ forecast: forecast({ cohort }) })), seat, NOW).forecast[0]).toMatch(/Last selected task estimate/);
    cohort.engine = 'custom-grok';
    expect(schedulingEvidence(budget(account({ forecast: forecast({ cohort }) })), seat, NOW).forecast).toEqual(['Task completion estimate unavailable.']);
  });
  it('labels real account-less historical cohorts as pooled without inventing account attribution', () => {
    const view = schedulingEvidence(budget(account({ forecast: forecast({ cohort: { engine: 'grok-cli', model: 'grok-code', seatId: null, taskKind: 'code' } }) })), seat, NOW);
    expect(view.forecast[0]).toMatch(/Last selected task estimate/);
    expect(view.forecast.join(' ')).toMatch(/pooled across accounts; account attribution unavailable/);
    expect(view.forecast.join(' ')).not.toMatch(/engine\/model\/account\/task/);
  });
  it('accepts real enrolled inventory beyond the old defensive count and keeps recording age separate from fresh quota', () => {
    const value = budget(); value.scheduling.accounts = Array.from({ length: 5000 }, (_, index) => account({ seatId: `other-${index}` }));
    value.scheduling.accounts.push(account({ forecast: forecast({ recordedAt: new Date(NOW - 86_400_000).toISOString() }) }));
    const view = schedulingEvidence(value, seat, NOW);
    expect(view.state).toBe('ready'); expect(view.forecast[0]).toMatch(/recorded 24h 00m ago/);
    expect(view.forecast[0]).toMatch(/not the current task or model selection/);
  });
  it('does not print private or credential-like model payloads', () => {
    const cohort = { engine: 'grok', model: 'sk-secret', seatId: null, taskKind: 'code' };
    expect(schedulingEvidence(budget(account({ forecast: forecast({ cohort }) })), seat, NOW).forecast).toEqual(['Task completion estimate unavailable.']);
  });
});
