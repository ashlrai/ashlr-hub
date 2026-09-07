import { describe, expect, it } from 'vitest';
import { mergeClaudeResourceObservation, normalizeCodexResourceObservation } from '../src/core/resources/provider-observations.js';
import { RESOURCE_OBSERVATION_OVERFLOW, planResourceAssignment, validateResourceObservations,
  type ResourceObservation, type ResourcePool } from '../src/core/resources/pool-policy.js';

const NOW = Date.parse('2026-09-07T16:00:00.000Z');
const RESET = NOW / 1000 + 3600;
const options = { nowMs: NOW, ttlMs: 60_000 };
const codexOptions = { ...options, bucketIds: ['codex'] };
const timestamp = (ms: number) => new Date(ms).toISOString();
const window = (usedPercent: unknown = 25, resetsAt: unknown = RESET) => ({ usedPercent, resetsAt, windowDurationMins: 300 });
const bucket = (limitId = 'codex') => ({ limitId, limitName: null, primary: window(), secondary: window(70, RESET + 86400), rateLimitReachedType: null });
const codex = () => ({ rateLimits: bucket(), rateLimitsByLimitId: { codex: bucket() } });
const claude = (fields: Record<string, unknown> = {}) => ({ type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: RESET, ...fields },
  session_id: 'private-session', uuid: 'private-uuid' });
const normalize = (payload: unknown, opts = codexOptions) => normalizeCodexResourceObservation('codex-worker', payload, opts);
const merge = (payload: unknown, previous: ResourceObservation | null = null, opts = options) =>
  mergeClaudeResourceObservation('claude-worker', payload, previous, opts);

describe('documented Codex native quota result normalization', () => {
  it('preserves primary and secondary windows with exact seconds and local timestamps', () => {
    expect(normalize(codex())).toEqual({ workerId: 'codex-worker', observedAt: timestamp(NOW), expiresAt: timestamp(NOW + 60_000), updatedAt: timestamp(NOW),
      health: 'ready', retryAfter: null, windows: [
        { id: 'codex_codex_primary', usedPercent: 25, resetsAt: timestamp(RESET * 1000) },
        { id: 'codex_codex_secondary', usedPercent: 70, resetsAt: timestamp((RESET + 86400) * 1000) },
      ] });
  });

  it('prefers the authoritative map over a divergent legacy result', () => {
    const payload = codex(); payload.rateLimits.primary.usedPercent = 100;
    expect(normalize(payload)?.windows[0]?.usedPercent).toBe(25);
  });

  it('never falls back when the authoritative map is empty', () => {
    expect(normalize({ rateLimitsByLimitId: {}, rateLimits: bucket() })?.windows).toEqual([
      { id: 'codex_codex_primary', usedPercent: null, resetsAt: null },
    ]);
  });

  it('requires every explicitly selected bucket without guessing absent capacity', () => {
    const result = normalize(codex(), { ...codexOptions, bucketIds: ['codex', 'codex_other'] });
    expect(result?.health).toBe('ready');
    expect(result?.windows).toHaveLength(3);
    expect(result?.windows[2]).toEqual({ id: 'codex_codex_other_primary', usedPercent: null, resetsAt: null });
  });

  it('accepts only matching legacy limit identity when the map is absent', () => {
    expect(normalize({ rateLimits: bucket() })?.windows).toHaveLength(2);
    expect(normalize({ rateLimits: bucket('other') })?.windows[0]?.usedPercent).toBeNull();
    expect(normalize({ rateLimits: { ...bucket(), limitId: null } })?.windows[0]?.usedPercent).toBeNull();
  });

  it('does not select unrelated map buckets or copy labels/credits/source timestamps', () => {
    const result = normalize({ rateLimitsByLimitId: { codex: { ...bucket(), limitName: 'secret', credits: 'secret' },
      other: { primary: window(100) } }, capturedAt: 'secret' });
    expect(result?.windows).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/secret|credits|capturedAt/);
  });

  it.each([{}, { usedPercent: null }, { resetsAt: null }, { usedPercent: undefined }])('keeps incomplete windows unknown: %j', (primary) => {
    const result = normalize({ rateLimits: { limitId: 'codex', primary, secondary: null } });
    expect(result?.windows).toEqual([{ id: 'codex_codex_primary', usedPercent: null, resetsAt: null }]);
  });

  it('does not invent an absent secondary window when one primary window is provided', () => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: window(), secondary: null } })?.windows).toHaveLength(1);
  });

  it.each(['primary', 'secondary', 'future_reached_kind'])('classifies provider reached state as hard denial: %s', (rateLimitReachedType) => {
    const result = normalize({ rateLimits: { limitId: 'codex', primary: {}, secondary: window(40), rateLimitReachedType } });
    expect(result?.windows[0]?.usedPercent).toBe(100);
    expect(result?.windows[1]?.usedPercent).toBe(40);
  });

  it('keeps observed exhaustion a denial above100 instead of wrapping or inventing remaining tokens', () => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: window(120) } })?.windows[0]?.usedPercent).toBe(100);
  });

  it.each([null, [], 1, 'bad', undefined])('rejects malformed authoritative map even with good legacy: %j', (map) => {
    expect(normalize({ rateLimitsByLimitId: map, rateLimits: bucket() })).toBeNull();
  });

  it.each([null, [], 'private', { limitId: 'wrong' }, { primary: false }, { rateLimitReachedType: false },
    { rateLimitReachedType: '' }, { rateLimitReachedType: 'private\n' }])('rejects malformed selected bucket: %j', (value) => {
    expect(normalize({ rateLimitsByLimitId: { codex: value } })).toBeNull();
  });

  it.each([-1, NaN, Infinity, '25', 1_000_001])('rejects invalid percentages: %j', (usedPercent) => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: window(usedPercent) } })).toBeNull();
  });

  it.each([-1, 1.5, NaN, Infinity, '300', 525_601])('rejects invalid duration metadata: %j', (windowDurationMins) => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: { ...window(), windowDurationMins } } })).toBeNull();
  });

  it.each([-1, RESET * 1000, 1.5, Infinity, NaN, '1730947200'])('rejects nonseconds or invalid reset timestamps: %j', (resetsAt) => {
    expect(normalize({ rateLimits: { limitId: 'codex', primary: window(25, resetsAt) } })).toBeNull();
  });

  it.each([{}, null, [], { type: 'result' }, { result: codex() }])('rejects unrelated payloads: %j', (payload) => {
    expect(normalize(payload)).toBeNull();
  });

  it.each([[], ['codex', 'codex'], ['UPPER'], ['private\n'], ['a'.repeat(65)], Array(1), ['a', 'b', 'c', 'd', 'e']])('rejects invalid selected buckets: %j', (bucketIds) => {
    expect(normalize(codex(), { ...codexOptions, bucketIds })).toBeNull();
  });

  it('supports eight windows and stable bounded distinct IDs for long bucket identities', () => {
    const bucketIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
    const payload = { rateLimitsByLimitId: Object.fromEntries(bucketIds.map((id) => [id, bucket(id)])) };
    const result = normalize(payload, { ...codexOptions, bucketIds });
    expect(result?.windows).toHaveLength(8);
    expect(new Set(result?.windows.map((value) => value.id)).size).toBe(8);
    expect(result?.windows.every((value) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id))).toBe(true);
    expect(normalize(payload, { ...codexOptions, bucketIds })?.windows).toEqual(result?.windows);
  });
});

describe('documented nested Claude rate-limit event merging', () => {
  it('converts fractional utilization to percent and uses local capture time', () => {
    expect(merge({ ...claude(), capturedAt: '2099-01-01T00:00:00.000Z' })).toEqual({ workerId: 'claude-worker',
      observedAt: timestamp(NOW), expiresAt: timestamp(NOW + 60_000), updatedAt: timestamp(NOW), health: 'ready', retryAfter: null,
      windows: [{ id: 'five_hour', usedPercent: 25, resetsAt: timestamp(RESET * 1000) }] });
  });

  it.each(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'])('accepts documented named bucket %s', (rateLimitType) => {
    expect(merge(claude({ rateLimitType }))?.windows[0]?.id).toBe(rateLimitType);
  });

  it.each(['seven_day_fable', 'future_model_limit', 'daily'])('preserves future opaque bucket %s without inventing its time or model meaning', (rateLimitType) => {
    expect(merge(claude({ rateLimitType }))?.windows[0]).toEqual({ id: rateLimitType, usedPercent: 25, resetsAt: timestamp(RESET * 1000) });
    expect(merge(claude({ rateLimitType, status: 'rejected', utilization: undefined }))?.windows[0]?.usedPercent).toBe(100);
  });

  it('hashes bounded provider labels outside the window-ID grammar without leaking raw text', () => {
    const payload = claude({ rateLimitType: '../private future.model', status: 'rejected' });
    const result = merge(payload);
    expect(result?.windows[0]?.id).toMatch(/^claude_[a-f0-9]{40}$/);
    expect(result?.windows[0]?.usedPercent).toBe(100);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(merge(payload)?.windows).toEqual(result?.windows);
  });

  it.each([NaN, Infinity, -0.01, 1.01, '0.5', {}, []])('unknown utilization units remain unknown, while explicit rejection still denies: %j', (utilization) => {
    expect(merge(claude({ utilization }))?.windows[0]?.usedPercent).toBeNull();
    expect(merge(claude({ status: 'rejected', utilization }))?.windows[0]?.usedPercent).toBe(100);
  });

  it('does not discard explicit rejection when future or malformed ancillary metadata is unusable', () => {
    expect(merge(claude({ status: 'rejected', rateLimitType: 'x'.repeat(257), resetsAt: RESET * 1000 }))?.windows[0])
      .toEqual({ id: 'unclassified', usedPercent: 100, resetsAt: null });
  });

  it.each([null, undefined])('does not invent zero from missing utilization: %j', (utilization) => {
    expect(merge(claude({ status: 'allowed_warning', utilization }))?.windows[0]?.usedPercent).toBeNull();
  });

  it.each([null, undefined, 0.1])('hard rejection denies even when utilization is absent or contradictory: %j', (utilization) => {
    expect(merge(claude({ status: 'rejected', utilization }))?.windows[0]?.usedPercent).toBe(100);
  });

  it('retains unnamed rejection when a later named window is allowed', () => {
    const rejected = merge(claude({ status: 'rejected', rateLimitType: undefined, utilization: undefined }));
    const result = merge(claude(), rejected, { ...options, nowMs: NOW + 1000 });
    expect(result?.windows).toEqual([{ id: 'unclassified', usedPercent: 100, resetsAt: timestamp(RESET * 1000) },
      { id: 'five_hour', usedPercent: 25, resetsAt: timestamp(RESET * 1000) }]);
  });

  it('preserves a blocked weekly window and its age when another window changes', () => {
    const previous = merge(claude({ status: 'rejected', rateLimitType: 'seven_day' }));
    const result = merge(claude(), previous, { ...options, nowMs: NOW + 30_000 });
    expect(result?.windows.map((value) => [value.id, value.usedPercent])).toEqual([['seven_day', 100], ['five_hour', 25]]);
    expect(result?.observedAt).toBe(timestamp(NOW));
    expect(result?.expiresAt).toBe(timestamp(NOW + 60_000));
    expect(result?.updatedAt).toBe(timestamp(NOW + 30_000));
  });

  it.each([{ utilization: undefined }, { utilization: null }, { utilization: 25 }, { resetsAt: null },
    { resetsAt: (NOW + 1000) / 1000 }, { resetsAt: 0 }])('does not turn a known same-window denial into bootstrap capacity: %j', (fields) => {
    const previous = merge(claude({ status: 'rejected' }))!;
    const result = merge(claude(fields), previous, { ...options, nowMs: NOW + 1000 });
    expect(result?.windows[0]).toEqual(previous.windows[0]);
    expect(result?.observedAt).toBe(previous.observedAt);
    expect(result?.expiresAt).toBe(previous.expiresAt);
    expect(result?.updatedAt).toBe(timestamp(NOW + 1000));
  });

  it('same-capture changes can strengthen but not reduce a known window', () => {
    const previous = merge(claude({ utilization: 0.9 }))!;
    expect(merge(claude({ utilization: 0.1 }), previous)?.windows[0]?.usedPercent).toBe(90);
    expect(merge(claude({ status: 'rejected', resetsAt: undefined }), previous)?.windows[0]?.usedPercent).toBe(100);
  });

  it('a newer fully known same-window observation can record recovery', () => {
    const previous = merge(claude({ status: 'rejected' }))!;
    const result = merge(claude({ utilization: 0.1 }), previous, { ...options, nowMs: NOW + 1000 });
    expect(result?.windows[0]?.usedPercent).toBe(10);
    expect(result?.observedAt).toBe(timestamp(NOW + 1000));
    expect(result?.updatedAt).toBe(timestamp(NOW + 1000));
  });

  it('retained stale evidence does not gain freshness from another event', () => {
    const previous = merge(claude({ rateLimitType: 'seven_day' }));
    const result = merge(claude(), previous, { ...options, nowMs: NOW + 90_000 });
    expect(result?.observedAt).toBe(timestamp(NOW));
    expect(result?.expiresAt).toBe(timestamp(NOW + 60_000));
    expect(result?.updatedAt).toBe(timestamp(NOW + 90_000));
  });

  it('fully replaced windows receive fresh capture and expiration without mutating previous', () => {
    const previous = merge(claude({ status: 'rejected' }))!;
    Object.freeze(previous.windows[0]); Object.freeze(previous.windows); Object.freeze(previous);
    const result = merge(claude({ utilization: 0.05 }), previous, { ...options, nowMs: NOW + 90_000 });
    expect(result?.observedAt).toBe(timestamp(NOW + 90_000));
    expect(result?.expiresAt).toBe(timestamp(NOW + 150_000));
    expect(result?.windows[0]?.usedPercent).toBe(5);
    expect(previous.windows[0]?.usedPercent).toBe(100);
  });

  it('accepts legacy previous observations without latest-capture metadata', () => {
    const previous = merge(claude({ rateLimitType: 'seven_day' }))!;
    delete previous.updatedAt;
    const result = merge(claude(), previous, { ...options, nowMs: NOW + 1000 });
    expect(result?.observedAt).toBe(timestamp(NOW));
    expect(result?.updatedAt).toBe(timestamp(NOW + 1000));
    expect(result?.windows).toHaveLength(2);
  });

  it.each([timestamp(NOW - 1), timestamp(NOW + 1), '2026-09-07', null])('rejects invalid previous latest-capture metadata: %j', (updatedAt) => {
    const previous = { ...merge(claude())!, updatedAt } as ResourceObservation;
    expect(merge(claude(), previous)).toBeNull();
  });

  it('ignores ancillary paid-overage fields rather than denying allowed subscription capacity', () => {
    const result = merge(claude({ overageStatus: 'rejected', overageResetsAt: RESET, overageDisabledReason: 'private' }));
    expect(result?.windows).toHaveLength(1);
    expect(result?.windows[0]?.usedPercent).toBe(25);
    expect(JSON.stringify(result)).not.toMatch(/overage|private|session_id|uuid/);
  });

  it('does preserve overage when it is the actual named rejected bucket', () => {
    const previous = merge(claude({ status: 'rejected', rateLimitType: 'overage' }));
    expect(merge(claude(), previous)?.windows.find((value) => value.id === 'overage')?.usedPercent).toBe(100);
  });

  it('preserves independent retry-after evidence and hard unavailable health when retaining windows', () => {
    const previous = merge(claude({ rateLimitType: 'seven_day' }))!;
    previous.health = 'unavailable'; previous.retryAfter = timestamp(NOW + 120_000);
    expect(merge(claude(), previous)).toMatchObject({ health: 'unavailable', retryAfter: timestamp(NOW + 120_000) });
  });

  it.each([null, [], {}, { type: 'result' }, { type: 'rate_limit_event', status: 'allowed', utilization: 0.1 },
    { type: 'rate_limit_event', rate_limit_info: null }, { type: 'rate_limit_event', rate_limit_info: [] }])('rejects unrelated, flattened or malformed events: %j', (payload) => {
    expect(merge(payload)).toBeNull();
  });

  it.each([{ status: 'private-error' }, { status: null }, { rateLimitType: '' }, { rateLimitType: 'private\n' },
    { rateLimitType: 'x'.repeat(257) }, { rateLimitType: 1 },
    { resetsAt: RESET * 1000 }, { resetsAt: '1730947200' }, { resetsAt: -1 }, { resetsAt: 1.5 }])('rejects invalid known metadata: %j', (fields) => {
    expect(merge(claude(fields))).toBeNull();
  });

  it('missing reset remains unknown; epoch0 remains an exact past timestamp', () => {
    expect(merge(claude({ resetsAt: undefined }))?.windows[0]?.resetsAt).toBeNull();
    expect(merge(claude({ resetsAt: 0 }))?.windows[0]?.resetsAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it.each(['wrong-worker', 'future', 'bad-expiry', 'bad-time', 'duplicate', 'invalid-window', 'too-old-ttl'])('rejects malformed previous observation: %s', (kind) => {
    const previous = merge(claude())!;
    if (kind === 'wrong-worker') previous.workerId = 'other';
    if (kind === 'future') { previous.observedAt = timestamp(NOW + 1); previous.expiresAt = timestamp(NOW + 60_001); }
    if (kind === 'bad-expiry') previous.expiresAt = previous.observedAt;
    if (kind === 'bad-time') previous.observedAt = '2026-09-07';
    if (kind === 'duplicate') previous.windows.push({ ...previous.windows[0]! });
    if (kind === 'invalid-window') previous.windows[0]!.usedPercent = Infinity;
    if (kind === 'too-old-ttl') previous.expiresAt = timestamp(NOW + 300_001);
    expect(merge(claude(), previous)).toBeNull();
  });

  it.each([
    { status: 'allowed', utilization: 0.25 },
    { status: 'allowed', utilization: undefined },
    { status: 'allowed_warning', utilization: undefined },
    { status: 'rejected', utilization: undefined },
  ])('retains a sticky bounded denial for any ninth valid bucket: %j', (fields) => {
    const previous = merge(claude())!;
    previous.windows = Array.from({ length: 8 }, (_, index) => ({ id: `window_${index}`, usedPercent: null, resetsAt: null }));
    previous.retryAfter = timestamp(NOW + 120_000);
    const result = merge(claude({ ...fields, rateLimitType: 'ninth_future_limit' }), previous,
      { ...options, nowMs: NOW + 1000 });
    expect(result).toMatchObject({ health: 'unavailable', updatedAt: timestamp(NOW + 1000), observedAt: timestamp(NOW),
      expiresAt: timestamp(NOW + 60_000), retryAfter: timestamp(NOW + 120_000) });
    expect(result?.windows).toHaveLength(8);
    expect(result?.windows.at(-1)).toEqual({ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null });
    expect(previous.windows).toHaveLength(8);
    expect(previous.windows.some((value) => value.id === RESOURCE_OBSERVATION_OVERFLOW)).toBe(false);
  });

  it('retains the seven strongest readings deterministically alongside the overflow denial', () => {
    const previous = merge(claude())!;
    previous.windows = Array.from({ length: 8 }, (_, index) => ({ id: `window_${index}`, usedPercent: index * 10, resetsAt: null }));
    const result = merge(claude({ rateLimitType: 'ninth_future_limit', utilization: 0.99 }), previous,
      { ...options, nowMs: NOW + 1000 });
    expect(result?.windows.map((value) => value.id)).toEqual(['ninth_future_limit', 'window_7', 'window_6', 'window_5',
      'window_4', 'window_3', 'window_2', RESOURCE_OBSERVATION_OVERFLOW]);
  });

  it('cannot clear overflow by repeatedly refreshing fresh allowed named windows', () => {
    const previous = merge(claude())!;
    previous.windows = Array.from({ length: 8 }, (_, index) => ({ id: `window_${index}`, usedPercent: null, resetsAt: null }));
    let result = merge(claude({ rateLimitType: 'ninth_future_limit', utilization: undefined }), previous)!;
    for (let index = 0; index < 12; index++) {
      result = merge(claude({ rateLimitType: `window_${index % 8}`, utilization: 0 }), result,
        { ...options, nowMs: NOW + (index + 1) * 10_000 })!;
      expect(result).toMatchObject({ health: 'unavailable', observedAt: timestamp(NOW), expiresAt: timestamp(NOW + 60_000),
        updatedAt: timestamp(NOW + (index + 1) * 10_000) });
      expect(result.windows).toHaveLength(8);
      expect(result.windows.at(-1)).toEqual({ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null });
    }
  });

  it('a fully fresh exact-marker event cannot clear or refresh the synthetic denial', () => {
    const previous = merge(claude())!;
    previous.windows = [{ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null }];
    previous.health = 'unavailable';
    const result = merge(claude({ rateLimitType: RESOURCE_OBSERVATION_OVERFLOW, utilization: 0 }), previous,
      { ...options, nowMs: NOW + 90_000 });
    expect(result).toMatchObject({ health: 'unavailable', observedAt: timestamp(NOW), expiresAt: timestamp(NOW + 60_000),
      updatedAt: timestamp(NOW + 90_000), windows: [{ id: RESOURCE_OBSERVATION_OVERFLOW, usedPercent: 100, resetsAt: null }] });
  });
});

describe('normalizer common input bounds', () => {
  it.each([{ nowMs: NaN }, { nowMs: -1 }, { nowMs: 1.5 }, { nowMs: 253_402_300_800_000 },
    { ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: Infinity }, { ttlMs: 300_001 }, { ttlMs: 0.5 }])('rejects invalid clock/TTL options: %j', (changed) => {
    const opts = { ...options, ...changed };
    expect(merge(claude(), null, opts)).toBeNull();
    expect(normalize(codex(), { ...opts, bucketIds: ['codex'] })).toBeNull();
  });

  it.each(['', 'private\n', '../worker', 'UPPER', 'a'.repeat(65)])('rejects invalid worker identity: %j', (workerId) => {
    expect(normalizeCodexResourceObservation(workerId, codex(), codexOptions)).toBeNull();
    expect(mergeClaudeResourceObservation(workerId, claude(), null, options)).toBeNull();
  });

  it('contains accessor exceptions without returning raw private error text', () => {
    const payload = Object.defineProperty({}, 'rateLimitsByLimitId', { get() { throw new Error('private-secret'); } });
    expect(normalize(payload)).toBeNull();
  });
});

describe('normalized evidence admission compatibility', () => {
  const pool: ResourcePool = { schemaVersion: 1, id: 'test-pool', workers: [{ id: 'claude-worker', provider: 'claude',
    model: 'sonnet', maxConcurrent: 1, reservePercent: 5, maxTasksPerWindow: 5, taskWindowMs: 60_000,
    priority: 0, allowUnknownQuota: true }] };

  it('unknown usage may bootstrap only through explicit policy, not invented capacity', () => {
    const value = merge(claude({ utilization: undefined }))!;
    expect(validateResourceObservations([value], pool)).toEqual([value]);
    const plan = planResourceAssignment({ pool, observations: [value], allowedWorkerIds: ['claude-worker'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: NOW });
    expect(plan.selectedWorkerId).toBe('claude-worker');
    expect(plan.candidates[0]).toMatchObject({ usedPercent: null, reason: 'operator-capped-unknown-quota' });
  });

  it('a retained stale block still denies even when policy allows unknown quota', () => {
    const previous = merge(claude({ rateLimitType: 'seven_day', status: 'rejected', utilization: undefined }))!;
    const value = merge(claude(), previous, { ...options, nowMs: NOW + 90_000 })!;
    expect(validateResourceObservations([value], pool)).toEqual([value]);
    const plan = planResourceAssignment({ pool, observations: [value], allowedWorkerIds: ['claude-worker'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: NOW + 90_000 });
    expect(plan.selectedWorkerId).toBeNull();
    expect(plan.exclusions[0]?.reasons).toContain('quota-reserve-reached');
  });

  it('an allowed unknown ninth bucket preserves valid evidence that denies bootstrap', () => {
    const previous = merge(claude())!;
    previous.windows = Array.from({ length: 8 }, (_, index) => ({ id: `window_${index}`, usedPercent: null, resetsAt: null }));
    const value = merge(claude({ rateLimitType: 'ninth_future_limit', utilization: undefined }), previous,
      { ...options, nowMs: NOW + 90_000 })!;
    expect(validateResourceObservations([value], pool)).toEqual([value]);
    const plan = planResourceAssignment({ pool, observations: [value], allowedWorkerIds: ['claude-worker'],
      activeCounts: {}, taskReservationCounts: {}, nowMs: NOW + 90_000 });
    expect(plan.selectedWorkerId).toBeNull();
    expect(plan.exclusions[0]?.reasons).toContain('worker-unavailable');
    expect(plan.exclusions[0]?.reasons).toContain('quota-reserve-reached');
  });
});
