import { describe, expect, it } from 'vitest';
import type { ResourceAccountConnection } from '../../../core/resources/connection-types.js';
import { summarizeAccountUsage } from './account-usage-summary.js';

const NOW = '2026-09-08T12:00:30.000Z';
const RESET = '2026-09-08T16:00:00.000Z';
const account = (patch: Partial<ResourceAccountConnection> = {}): ResourceAccountConnection => ({
  id: 'codex-personal', label: 'Personal', provider: 'codex', state: 'observed', authentication: 'signed-in',
  health: 'reachable', planType: 'pro', observedAt: '2026-09-08T12:00:00.000Z', expiresAt: '2026-09-08T12:01:00.000Z',
  windows: [{ id: 'primary', usedPercent: 10, resetsAt: RESET },
    { id: 'weekly', usedPercent: 70, resetsAt: '2026-09-15T12:00:00.000Z' }],
  reason: 'probe-observed', onDemandEnabled: false, executionSupported: true, ...patch,
});
const options = { sampledAt: NOW, ceilingPercent: 75 };
const unavailable = (reason: string) => ({ state: 'unavailable', headroomPercent: null, limitingWindowIds: [],
  atOrAboveCeiling: null, nextResetAt: null, reason });

describe('account usage reference summary', () => {
  it('uses the most-used window, not summed windows or percentage of remaining tokens', () => {
    expect(summarizeAccountUsage(account(), options)).toEqual({ state: 'known', headroomPercent: 5,
      limitingWindowIds: ['weekly'], atOrAboveCeiling: false, nextResetAt: RESET, reason: 'measured-reference' });
  });

  it.each([[75, 0, true], [97, 0, true], [74.9, 0.1, false], [74.876, 0.12, false]] as const)(
    'compares usage %s without negative or noisy margins', (usedPercent, headroomPercent, reached) => {
      expect(summarizeAccountUsage(account({ windows: [{ id: 'primary', usedPercent, resetsAt: RESET }] }), options))
        .toMatchObject({ headroomPercent, atOrAboveCeiling: reached, limitingWindowIds: ['primary'] });
    },
  );

  it('returns all tied windows in sorted order without changing frozen inputs', () => {
    const input = account({ windows: [{ id: 'z', usedPercent: 70, resetsAt: RESET }, { id: 'a', usedPercent: 70, resetsAt: RESET }] });
    input.windows.forEach(Object.freeze); Object.freeze(input.windows); Object.freeze(input);
    const frozenOptions = Object.freeze({ ...options });
    const before = JSON.stringify(input);
    expect(summarizeAccountUsage(input, frozenOptions).limitingWindowIds).toEqual(['a', 'z']);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([[0, 0, 0, true], [100, 99, 1, false]] as const)(
    'supports the %s%% ceiling endpoint', (ceilingPercent, usedPercent, headroomPercent, reached) => {
      expect(summarizeAccountUsage(account({ windows: [{ id: 'primary', usedPercent, resetsAt: RESET }] }),
        { ...options, ceilingPercent })).toMatchObject({ headroomPercent, atOrAboveCeiling: reached });
    },
  );

  it.each([null, -1, 101, NaN, Infinity, -Infinity])('withholds unknown or invalid partial usage %s', (usedPercent) => {
    const input = account(); input.windows[0]!.usedPercent = usedPercent;
    expect(summarizeAccountUsage(input, options)).toEqual(unavailable('unverified-quota'));
  });

  it.each([null, NOW, '2026-09-08T12:00:29.999Z', '2026-09-15T12:00:00Z', 'invalid'])(
    'does not reopen quota using reset %s', (resetsAt) => {
      const input = account(); input.windows[0]!.resetsAt = resetsAt;
      expect(summarizeAccountUsage(input, options)).toEqual(unavailable('unverified-quota'));
    },
  );

  it.each([
    { state: 'checking' }, { state: 'unavailable' }, { state: 'signed-out', authentication: 'signed-out' },
    { authentication: 'unknown' }, { health: 'unknown' }, { health: 'unavailable' },
    { observedAt: null }, { observedAt: '2026-09-08T12:00:31.000Z' }, { expiresAt: NOW },
  ] satisfies Array<Partial<ResourceAccountConnection>>)('withholds non-current account evidence %#', (patch) => {
    expect(summarizeAccountUsage(account(patch), options)).toEqual(unavailable('unavailable-evidence'));
  });

  it.each([null, -1, 101, 75.5, NaN, Infinity, -Infinity])('withholds invalid ceiling %s', (ceilingPercent) => {
    expect(summarizeAccountUsage(account(), { ...options, ceilingPercent })).toEqual(unavailable('invalid-ceiling'));
  });

  it('gives historical state priority over missing ceiling and unavailable account', () => {
    expect(summarizeAccountUsage(account({ state: 'unavailable' }), { ...options, ceilingPercent: null, historical: true }))
      .toEqual(unavailable('historical'));
  });

  it('keeps approximate cached Claude reports out of numerical reference summaries', () => {
    const input = account({ provider: 'claude' });
    input.windows[0]!.nativeReport = { source: 'claude-usage', resetDescription: 'Sep 15 at noon' };
    expect(summarizeAccountUsage(input, options)).toEqual(unavailable('unverified-quota'));
  });

  it.each([{ windows: [] }, { windows: [{ id: '', usedPercent: 10, resetsAt: RESET }] },
    { windows: [{ id: 'same', usedPercent: 10, resetsAt: RESET }, { id: 'same', usedPercent: 10, resetsAt: RESET }] }])(
    'withholds missing or ambiguous inventory %#', ({ windows }) => {
      expect(summarizeAccountUsage(account({ windows }), options)).toEqual(unavailable('unverified-quota'));
    },
  );

  it.each([64, 65])('matches the existing connection transport inventory bound at %s windows', (count) => {
    const windows = Array.from({ length: count }, (_, index) => ({ id: `window-${index}`, usedPercent: 10, resetsAt: RESET }));
    const result = summarizeAccountUsage(account({ windows }), options);
    expect(result.state).toBe(count === 64 ? 'known' : 'unavailable');
    expect(result.limitingWindowIds).toHaveLength(count === 64 ? 64 : 0);
  });

  it('keeps Grok reference measurements separate from execution adapter availability', () => {
    expect(summarizeAccountUsage(account({ provider: 'grok', executionSupported: false }), options))
      .toMatchObject({ state: 'known', headroomPercent: 5 });
  });

  it('matches an independent quarter-point oracle across 505 ceiling and usage combinations', () => {
    for (let ceilingPercent = 0; ceilingPercent <= 100; ceilingPercent++) {
      // Integer quarter-points avoid repeating the candidate's floating-point rounding formula.
      for (const quarters of [0, ceilingPercent * 2, ceilingPercent * 4, Math.min(400, ceilingPercent * 4 + 1), 400]) {
        const input = account({ windows: [{ id: 'single', usedPercent: quarters / 4, resetsAt: RESET }] });
        const result = summarizeAccountUsage(input, { ...options, ceilingPercent });
        expect(result).toEqual({ state: 'known', headroomPercent: Math.max(0, ceilingPercent * 4 - quarters) / 4,
          limitingWindowIds: ['single'], atOrAboveCeiling: quarters >= ceilingPercent * 4,
          nextResetAt: RESET, reason: 'measured-reference' });
      }
    }
  });

  it.each(['2026-02-30T12:00:00.000Z', '2026-09-08T25:00:00.000Z', '2026-09-08T12:00:00.000Z\n'])(
    'rejects noncanonical observed timestamp %j', (observedAt) => {
      expect(summarizeAccountUsage(account({ observedAt }), options)).toEqual(unavailable('unavailable-evidence'));
    },
  );

  it('accepts the capture boundary but not the expiry boundary', () => {
    expect(summarizeAccountUsage(account({ observedAt: NOW }), options).state).toBe('known');
    expect(summarizeAccountUsage(account({ expiresAt: NOW }), options)).toEqual(unavailable('unavailable-evidence'));
  });
});
