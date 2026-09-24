/**
 * V3.10 integration (IB2) — the routing gate's SCOPE.
 *
 * A9 closed the Claude/Codex usage fail-open ("unknown usage = NOT eligible
 * for AUTONOMY", Mason 2026-09-24). Applied to every route, it also turned
 * plain interactive routing (`ashlr run`, goal, learned routing) builtin-only
 * for every npm user without the Verse account collector. The fix scopes it:
 *
 *   - run/router.ts#routeTask: RoutingContext.autonomous — absent = interactive
 *     (the pre-3.10 rule: only a KNOWN window ≥ maxPercent blocks; budget
 *     reserves do not apply); true = autonomous (fail closed + budget).
 *   - fleet/subscription-usage.ts#subscriptionAllows: the gate's own default
 *     stays autonomous, because every direct caller is a daemon / fleet /
 *     gateway dispatch gate; `autonomous:false` opts into the interactive rule.
 *   - engineAvailable: a THROWING check closes the engine in BOTH modes — a
 *     throw is a bug, not a usage reading.
 *
 * HOME-isolated per test; readCodexRateLimits is mocked so no real ~/.codex
 * session is ever read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodexRateLimits } from '../src/core/observability/codex-source.js';

let mockRateLimitsReturn: CodexRateLimits | null = null;

vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => mockRateLimitsReturn,
  CODEX_PROVIDER_KEY: 'codex',
  collectCodexEvents: () => [],
}));

// Pass-through wrapper so one test can make the subscription check THROW.
let throwFromSubscriptionAllows = false;
vi.mock('../src/core/fleet/subscription-usage.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/fleet/subscription-usage.js')>();
  return {
    ...real,
    subscriptionAllows: (...args: Parameters<typeof real.subscriptionAllows>) => {
      if (throwFromSubscriptionAllows) throw new Error('simulated reader bug');
      return real.subscriptionAllows(...args);
    },
  };
});

import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';
import { routeTask, routeTaskCascade, type RoutingContext } from '../src/core/run/router.js';
import { writeCapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  mockRateLimitsReturn = null;
  throwFromSubscriptionAllows = false;
  savedHome = process.env['HOME'];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ib2-routing-scope-'));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function hardItem(source = 'security'): WorkItem {
  return {
    id: `repo:${source}:ib2`,
    repo: '/tmp/ib2-repo',
    title: `IB2 ${source} item`,
    source: source as WorkItem['source'],
    effort: 5,
    score: 9,
    description: '',
    filePaths: [],
  } as unknown as WorkItem;
}

function cfg(foundry: Record<string, unknown> = {}): AshlrConfig {
  return { version: 1, foundry } as unknown as AshlrConfig;
}

function ctx(engines: EngineId[], autonomous?: boolean): RoutingContext {
  return autonomous === undefined ? { availableEngines: engines } : { availableEngines: engines, autonomous };
}

function claudeSeat(session: number, weekly: number, observedAt = new Date()): SeatCapacity {
  return {
    seatId: 'claude',
    engine: 'claude',
    label: 'Claude Code',
    free: false,
    windows: [
      { id: 'five_hour', usedPercent: session, resetsAt: null, resetDescription: null, limitReached: false },
      { id: 'seven_day', usedPercent: weekly, resetsAt: null, resetDescription: null, limitReached: false },
    ],
    signedOut: false,
    reachable: null,
    contextWindow: 200_000,
    observedAt: observedAt.toISOString(),
    spentTodayUsd: null,
  };
}

function codexReading(usedPercent: number): CodexRateLimits {
  return {
    primary: { usedPercent, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
  } as unknown as CodexRateLimits;
}

describe('interactive routing (default) keeps the pre-3.10 rule', () => {
  it('no capacity snapshot: a hard item still routes to claude', () => {
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin']));
    expect(d.engine).toBe('claude');
  });

  it('explicit autonomous:false behaves exactly like the default', () => {
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], false));
    expect(d.engine).toBe('claude');
  });

  it('budget reserves do NOT apply interactively (they protect interactive headroom)', () => {
    // 80% of the five-hour window is above the balanced 70% autonomy ceiling.
    writeCapacitySnapshot([claudeSeat(80, 10)]);
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin']));
    expect(d.engine).toBe('claude');
  });

  it('codex is not switched off interactively (the "Codex OFF" default is an autonomy rule)', () => {
    mockRateLimitsReturn = codexReading(20);
    const d = routeTask(hardItem('feature'), cfg(), ctx(['codex', 'builtin']));
    expect(d.engine).toBe('codex');
  });

  it('a KNOWN window at/above maxPercent still blocks interactively (the old rule)', () => {
    mockRateLimitsReturn = codexReading(95);
    const d = routeTask(hardItem('feature'), cfg(), ctx(['codex', 'builtin']));
    expect(d.engine).not.toBe('codex');
    const r = subscriptionAllows('codex', { autonomous: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('95% used');
  });
});

describe('autonomous routing fails closed and applies the budget', () => {
  it('no capacity snapshot: claude is not eligible', () => {
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], true));
    expect(d.engine).not.toBe('claude');
  });

  it('a fresh reading inside the balanced budget: claude is eligible', () => {
    writeCapacitySnapshot([claudeSeat(10, 10)]);
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], true));
    expect(d.engine).toBe('claude');
  });

  it('a stale reading (20 minutes old) is unknown, not headroom', () => {
    const old = new Date(Date.now() - 20 * 60_000);
    writeCapacitySnapshot([claudeSeat(10, 10, old)], old);
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], true));
    expect(d.engine).not.toBe('claude');
  });

  it('balanced: above the 70% five-hour ceiling holds claude back', () => {
    writeCapacitySnapshot([claudeSeat(80, 10)]);
    const d = routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], true));
    expect(d.engine).not.toBe('claude');
  });

  it('default budget: codex is off for autonomy even with a fresh, low reading', () => {
    mockRateLimitsReturn = codexReading(5);
    const d = routeTask(hardItem('feature'), cfg(), ctx(['codex', 'builtin'], true));
    expect(d.engine).not.toBe('codex');
  });

  it('routeTaskCascade keeps the autonomous flag through the cheap-first and escalation contexts', () => {
    const cascade = cfg({ cascade: true });
    // Escalation re-dispatch (forceTier) builds a new context.
    const escalated = routeTaskCascade(hardItem(), cascade, ctx(['claude', 'builtin'], true), 'frontier', 2);
    expect(escalated.engine).not.toBe('claude');
    // Cheap-first path (low difficulty) builds a new context too.
    const easy = { ...hardItem('todo'), effort: 2, score: 3 } as WorkItem;
    const cheap = routeTaskCascade(easy, cascade, ctx(['claude', 'builtin'], true));
    expect(cheap.engine).not.toBe('claude');
    // Same calls, interactive: claude is reachable again.
    const interactive = routeTaskCascade(hardItem(), cascade, ctx(['claude', 'builtin']), 'frontier', 2);
    expect(interactive.engine).toBe('claude');
  });
});

describe('the subscription gate itself defaults to autonomous', () => {
  it('no flag + no reading → blocked; autonomous:false → allowed (pre-3.10)', () => {
    expect(subscriptionAllows('claude').allowed).toBe(false);
    const interactive = subscriptionAllows('claude', { autonomous: false });
    expect(interactive.allowed).toBe(true);
    expect(interactive.reason).toContain('unknown');
  });
});

describe('engineAvailable: a THROWING check closes the engine in both modes', () => {
  it('interactive and autonomous both fall back off claude when the check throws', () => {
    throwFromSubscriptionAllows = true;
    expect(routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'])).engine).not.toBe('claude');
    expect(routeTask(hardItem(), cfg(), ctx(['claude', 'builtin'], true)).engine).not.toBe('claude');
  });
});
