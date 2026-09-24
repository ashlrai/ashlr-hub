/**
 * V3.10 Track B (unit B-U1, day 0): DEFAULT_TICK_HOOKS reproduce master's
 * tick exactly. U5 swaps `routeBackend(...)` / `subscriptionAllows(...)` in
 * daemon/loop.ts for `hooks.route(...)` / `hooks.seatAllows(...)`; with the
 * default hooks installed that swap must be invisible — same callee, same
 * arguments (by identity), same result — and nothing else may be imposed.
 *
 * Kept in its own file because it mocks fleet/router and
 * fleet/subscription-usage module-wide; nothing else is imported here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/fleet/router.js', () => ({ routeBackend: vi.fn() }));
vi.mock('../src/core/fleet/subscription-usage.js', () => ({ subscriptionAllows: vi.fn() }));

import { routeBackend } from '../src/core/fleet/router.js';
import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';
import { DEFAULT_TICK_HOOKS } from '../src/core/daemon/tick-hooks.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';
import type { DispatchOutcome, LandingRecord } from '../src/core/fleet/fleet-types.js';

describe('DEFAULT_TICK_HOOKS — master parity', () => {
  beforeEach(() => {
    vi.mocked(routeBackend).mockReset();
    vi.mocked(subscriptionAllows).mockReset();
  });

  it('route delegates to routeBackend with the same arguments and adds no seat decision or hold', () => {
    const item = { id: 'i1', repo: '/tmp/repo' } as WorkItem;
    const cfg = { foundry: {} } as AshlrConfig;
    vi.mocked(routeBackend).mockReturnValue({ backend: 'claude', tier: 'frontier', model: 'm', reason: 'r' });
    const routed = DEFAULT_TICK_HOOKS.route(item, cfg);
    expect(routeBackend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(routeBackend).mock.calls[0]?.[0]).toBe(item);
    expect(vi.mocked(routeBackend).mock.calls[0]?.[1]).toBe(cfg);
    expect(routed).toEqual({ backend: 'claude', tier: 'frontier', model: 'm', reason: 'r', seatDecision: null, hold: null });
  });

  it('route preserves an absent model exactly (the loop reads routed.model)', () => {
    vi.mocked(routeBackend).mockReturnValue({ backend: 'builtin', tier: 'local', reason: 'default' });
    const routed = DEFAULT_TICK_HOOKS.route({} as WorkItem, {} as AshlrConfig);
    expect('model' in routed).toBe(false);
  });

  it('seatAllows delegates to subscriptionAllows with the very same options object', () => {
    const verdict = { allowed: false, reason: 'window at 95%' };
    vi.mocked(subscriptionAllows).mockReturnValue(verdict);
    const opts = { maxPercent: 90 };
    expect(DEFAULT_TICK_HOOKS.seatAllows('codex' as EngineId, opts)).toBe(verdict);
    expect(subscriptionAllows).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subscriptionAllows).mock.calls[0]?.[0]).toBe('codex');
    expect(vi.mocked(subscriptionAllows).mock.calls[0]?.[1]).toBe(opts);
  });

  it('effectiveConfig is the identity and the other hooks impose nothing', async () => {
    const cfg = { foundry: {} } as AshlrConfig;
    expect(DEFAULT_TICK_HOOKS.effectiveConfig(cfg)).toBe(cfg);
    const constraints = await DEFAULT_TICK_HOOKS.beforeTick({ nowMs: 0, cfg, dryRun: true, capabilityKind: null });
    expect(constraints).toEqual({ pausedRepos: [], laneCaps: {}, holdProduction: null });
    expect(Object.isFrozen(constraints)).toBe(true);
    await expect(DEFAULT_TICK_HOOKS.afterDispatch({} as DispatchOutcome)).resolves.toBeUndefined();
    await expect(DEFAULT_TICK_HOOKS.afterLanding({} as LandingRecord)).resolves.toBeUndefined();
    expect(routeBackend).not.toHaveBeenCalled();
    expect(subscriptionAllows).not.toHaveBeenCalled();
  });

  it('cannot be monkey-patched at runtime', () => {
    expect(Object.isFrozen(DEFAULT_TICK_HOOKS)).toBe(true);
  });
});
