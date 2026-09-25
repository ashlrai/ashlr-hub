import { describe, expect, it } from 'vitest';
import { CAP_FIELDS, capFieldByKey, capPatch, readCap, validateCap, validateFoundryMax, type CapKey } from './caps-spec.js';
import { VERSE_CAPS_BOUNDS } from './control-types.js';
import type { VerseCaps } from './control-types.js';

const CAPS: VerseCaps = {
  dailyBudgetUsd: 25,
  perTickItems: 4,
  parallel: 2,
  intervalMs: 900_000,
  mode: 'batch',
  maxConcurrent: 8,
  concurrency: { local: 2, cloud: 6, total: 8 },
  subscriptionMaxPercent: 80,
  defaulted: [],
  foundryLimits: [{ engine: 'claude', window: '7d', max: 2000 }],
};

describe('caps-spec', () => {
  it('mirrors every server range from the V2 contract', () => {
    const ranges = Object.fromEntries(CAP_FIELDS.map((f) => [f.key, [f.min, f.max]]));
    expect(ranges['dailyBudgetUsd']).toEqual([0, 1000]);
    expect(ranges['perTickItems']).toEqual([1, 50]);
    expect(ranges['parallel']).toEqual([1, 16]);
    expect(ranges['maxConcurrent']).toEqual([1, 32]);
    // 1, not the contract's 0: the daemon cannot honour a zero tier (see the
    // comment on VERSE_CAPS_BOUNDS.concurrency). The drift block below pins
    // this against the server constant, so the two can never disagree.
    expect(ranges['concurrency.local']).toEqual([1, 32]);
    expect(ranges['concurrency.cloud']).toEqual([1, 32]);
    expect(ranges['concurrency.total']).toEqual([1, 32]);
    expect(ranges['subscriptionMaxPercent']).toEqual([1, 100]);
  });

  it('edits the tick interval in minutes but stores the contract range in ms', () => {
    const spec = capFieldByKey('intervalMs');
    expect(spec.toDisplay(900_000)).toBe(15);
    // The display bounds must map exactly onto the server's 30s..24h window.
    expect(spec.fromDisplay(spec.min)).toBe(30_000);
    expect(spec.fromDisplay(spec.max)).toBe(86_400_000);
  });

  it('reads nested concurrency caps and reports absent ones as unknown, not zero', () => {
    expect(readCap(CAPS, 'concurrency.cloud')).toBe(6);
    expect(readCap(CAPS, 'dailyBudgetUsd')).toBe(25);
    expect(readCap({ ...CAPS, concurrency: {} as VerseCaps['concurrency'] }, 'concurrency.total')).toBeNull();
    expect(readCap(undefined, 'parallel')).toBeNull();
  });

  it('rejects out-of-range, blank, and fractional values before the round trip', () => {
    const items = capFieldByKey('perTickItems');
    expect(validateCap(items, '51')).toEqual({ ok: false, error: 'Items per tick must be between 1 and 50 items.' });
    expect(validateCap(items, '0')).toMatchObject({ ok: false });
    expect(validateCap(items, '')).toMatchObject({ ok: false });
    expect(validateCap(items, 'four')).toMatchObject({ ok: false });
    expect(validateCap(items, '2.5')).toEqual({ ok: false, error: 'Items per tick must be a whole number of items.' });
    // A percent unit hugs its number and has its own whole-number phrase.
    const ceiling = capFieldByKey('subscriptionMaxPercent');
    expect(validateCap(ceiling, '101')).toEqual({ ok: false, error: 'Subscription ceiling must be between 1 and 100% of window.' });
    expect(validateCap(ceiling, '50.5')).toEqual({ ok: false, error: 'Subscription ceiling must be a whole percentage.' });
    expect(validateCap(items, '7')).toEqual({ ok: true, stored: 7, display: 7 });
  });

  it('accepts a daily budget of exactly 0 — "stopped" is a legal configuration', () => {
    expect(validateCap(capFieldByKey('dailyBudgetUsd'), '0')).toEqual({ ok: true, stored: 0, display: 0 });
  });

  it('builds the smallest possible partial patch body', () => {
    expect(capPatch('parallel', 4)).toEqual({ parallel: 4 });
    expect(capPatch('concurrency.local', 3)).toEqual({ concurrency: { local: 3 } });
  });

  it('holds foundry limit max at >= 0 and whole', () => {
    expect(validateFoundryMax('0', 'claude')).toEqual({ ok: true, stored: 0, display: 0 });
    expect(validateFoundryMax('-1', 'claude')).toMatchObject({ ok: false });
    expect(validateFoundryMax('1.5', 'claude')).toMatchObject({ ok: false });
  });
});

describe('the client table agrees with the server bounds', () => {
  // caps-spec.ts is a courtesy gate — it refuses a bad value before the round
  // trip. That is only worth having while it agrees with the range the route
  // actually enforces, so the agreement is pinned here against the SERVER's
  // own constant rather than against a second copy of the numbers.
  const SERVER: Record<CapKey, { min: number; max: number }> = {
    dailyBudgetUsd: VERSE_CAPS_BOUNDS.dailyBudgetUsd,
    perTickItems: VERSE_CAPS_BOUNDS.perTickItems,
    parallel: VERSE_CAPS_BOUNDS.parallel,
    intervalMs: VERSE_CAPS_BOUNDS.intervalMs,
    maxConcurrent: VERSE_CAPS_BOUNDS.maxConcurrent,
    'concurrency.local': VERSE_CAPS_BOUNDS.concurrency,
    'concurrency.cloud': VERSE_CAPS_BOUNDS.concurrency,
    'concurrency.total': VERSE_CAPS_BOUNDS.concurrency,
    subscriptionMaxPercent: VERSE_CAPS_BOUNDS.subscriptionMaxPercent,
  };

  it('maps every field’s display range onto the server’s stored range', () => {
    expect(CAP_FIELDS.length).toBe(Object.keys(SERVER).length);
    for (const field of CAP_FIELDS) {
      const bound = SERVER[field.key];
      expect(bound, `no server bound for ${field.key}`).toBeDefined();
      // Compare in STORED units: tick interval is typed in minutes.
      expect(field.fromDisplay(field.min), `${field.key} min`).toBe(bound.min);
      expect(field.fromDisplay(field.max), `${field.key} max`).toBe(bound.max);
    }
  });

  /**
   * `foundryLimitMax` is the one bound in VERSE_CAPS_BOUNDS with no CAP_FIELDS
   * entry, so the loop above never reached it — and validateFoundryMax had no
   * upper bound at all while the route rejects above 1,000,000. Typing 2000000
   * passed the client gate, was POSTed, and came back 400.
   */
  it('bounds the foundry limit max at the server’s ceiling too', () => {
    const { max, min } = VERSE_CAPS_BOUNDS.foundryLimitMax;
    expect(validateFoundryMax(String(max), 'codex').ok).toBe(true);
    expect(validateFoundryMax(String(max + 1), 'codex').ok).toBe(false);
    expect(validateFoundryMax(String(min), 'codex').ok).toBe(true);
    expect(validateFoundryMax(String(min - 1), 'codex').ok).toBe(false);
  });

  it('refuses at both edges of the server range, so no out-of-range value is ever POSTed', () => {
    for (const field of CAP_FIELDS) {
      const below = field.integer ? field.min - 1 : field.min - field.step;
      expect(validateCap(field, String(below)).ok, `${field.key} below min`).toBe(false);
      expect(validateCap(field, String(field.max + field.step)).ok, `${field.key} above max`).toBe(false);
      expect(validateCap(field, String(field.min)).ok, `${field.key} at min`).toBe(true);
      expect(validateCap(field, String(field.max)).ok, `${field.key} at max`).toBe(true);
    }
  });
});
