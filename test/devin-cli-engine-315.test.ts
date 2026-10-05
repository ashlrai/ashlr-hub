/**
 * 3.15 — the local Devin CLI as a fleet producer (`devin-cli`): the pure and
 * filesystem-only half. The spawned half (a fake `devin` on PATH, a real
 * sandbox worktree, sandbox-exec) is test/devin-cli-engine-realio-315.test.ts.
 *
 * Covered here:
 *  - the registry argv (exact, injection-safe, `smart` — never `dangerous` —
 *    and not redefinable from config);
 *  - model resolution (devin.fleetModel, per-run override, the free-model rule);
 *  - the lane verdict's order (opt-in → grant → budget mode → free model → CLI);
 *  - identity: `devin-cli` is a LANE authorized by the grant engine `devin`,
 *    never a grant engine of its own; a Devin seat still opens no other lane;
 *  - planLanes / resolveLaneEngines / the router's Devin CLI overflow;
 *  - the tick's readiness (the probe is asked only after every other check)
 *    and grantAllowedBackends never admitting `devin-cli`;
 *  - locality / spend: metered (refused under local-only), $0 for SWE-2;
 *  - the autonomous overlay's per-run copy of the Devin login.
 *
 * Hermetic: no Devin call, no network. HOME is isolated by test/setup/home.ts;
 * every path here is a temp dir.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshDevinCliExecutionBinding, resetDevinCliAdmissionForTest } from '../src/core/devin/cli-admission.js';

import {
  DEVIN_CLI_CONTEXT_TOKENS,
  DEVIN_CLI_ENGINE_ID,
  DEVIN_CLI_FLEET_DEFAULT_MODEL,
  DEVIN_CLI_FREE_MODELS,
  DEVIN_CLI_PERMISSION_MODE,
  DEVIN_CLI_STALL_IDLE_MS,
  devinCliLaneVerdict,
  isDevinCliFreeModel,
  resolveDevinCliFleetModel,
  type DevinCliLaneInput,
} from '../src/core/devin/cli-engine.js';
import { buildEngineCommand } from '../src/core/run/engines.js';
import { BUILTIN_ENGINE_REGISTRY, compileArgv, registryEngineForFleetEngine, resolveEngineSpec } from '../src/core/run/engine-registry.js';
import { devinCliStallIdleMs, engineTierOf } from '../src/core/run/sandboxed-engine.js';
import { engineIdForBin, engineMeteredness, enginePermitted } from '../src/core/policy/local-only.js';
import {
  DEVIN_CLI_LANE,
  FLEET_ENGINES,
  GRANT_ENGINES,
  grantEngineOfLane,
  type FleetEngine,
} from '../src/core/fleet/fleet-types.js';
import {
  LANE_DEFAULT_SLOTS,
  FLEET_LOCAL_SEAT_ID,
  devinCliOverflow,
  fleetLaneOf,
  grantHasDevinProducer,
  laneOfSeat,
  planLanes,
  resolveLaneEngines,
  routeWorkItem,
  routingRequestFor,
  type DispatchRouterContext,
  type LanePlan,
  type LegacyRoute,
} from '../src/core/fleet/dispatch-router.js';
import { devinCliReadiness, grantAllowedBackends } from '../src/core/fleet/tick-hooks-live.js';
import { defaultBudgetPolicy, DEVIN_SEAT_ID } from '../src/core/routing/policy.js';
import { standingAuthorizesDevin } from '../src/core/authority/effective-config.js';
import { autonomousConfinementProfile } from '../src/core/sandbox/confine.js';
import { autonomousEngineClass, buildAutonomousEnvOverlay } from '../src/core/sandbox/autonomous-env.js';
import { runBilling } from '../src/core/verse/fleet-history.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { EffectivePolicy, EffectiveSeatPolicy } from '../src/core/authority/types.js';
import type { AshlrConfig, EngineId, WorkItem } from '../src/core/types.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const REPO = 'ashlrai/binshield';
const REPO_PATH = '/tmp/mirrors/ashlrai__binshield';
const CFG = { foundry: {} } as unknown as AshlrConfig;
const OPTED_IN: NonNullable<AshlrConfig['devin']> = { enabled: true, fleet: true };
const admissionRoots: string[] = [];
beforeEach(() => { vi.spyOn(Date,'now').mockReturnValue(NOW); });
afterEach(() => { vi.restoreAllMocks(); resetDevinCliAdmissionForTest(); for (const root of admissionRoots.splice(0)) rmSync(root,{recursive:true,force:true}); });
async function nativeBinding(model: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'devin-native-evidence-'))); admissionRoots.push(root);
  const executable = join(root,'devin'); writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o755});
  mkdirSync(join(root,'data','devin'),{recursive:true,mode:0o700});
  const credentialsPath = join(root,'data','devin','credentials.toml'); writeFileSync(credentialsPath,'fixture-not-login',{mode:0o600});
  return refreshDevinCliExecutionBinding(model,{cliPath:executable,credentialsPath,
    runMetadata:async (_bin,args) => args[0] === 'auth'
      ? 'Logged in\nUser ID: fixture-user\nTeam ID: fixture-team\nAPI server: https://server.codeium.com\nDevin API: https://api.devin.ai\n'
      : `Available models (1 family)\nFixture (fixture)\n  ${model}  Fixture Model  [262K context, ${model === 'swe-2-high' ? 'Free' : '$4 / 1M Input · $20 / 1M Output'}]\n`,
  });
}


// ---------------------------------------------------------------------------
// Registry argv
// ---------------------------------------------------------------------------

describe('devin-cli registry entry and argv', () => {
  it('is a mid-tier cli-agent on the `devin` binary with the exact headless argv', () => {
    const spec = BUILTIN_ENGINE_REGISTRY[DEVIN_CLI_ENGINE_ID]!;
    expect(spec).toMatchObject({ id: 'devin-cli', kind: 'cli-agent', tier: 'mid', bin: 'devin', bins: ['devin'], defaultModel: 'swe-2-high' });
    expect(spec.autonomousArgv).toBeUndefined();
    const cmd = buildEngineCommand('devin-cli' as EngineId, 'fix the parser', CFG, { cwd: '/wt/sb1', model: 'swe-2-high', autonomous: true });
    expect(cmd).toEqual({
      bin: 'devin',
      args: ['-p', '--model', 'swe-2-high', '--permission-mode', 'smart', '--respect-workspace-trust', 'false', '--', 'fix the parser'],
      cwd: '/wt/sb1',
    });
    expect(DEVIN_CLI_PERMISSION_MODE).toBe('smart');
  });

  it('autonomous and interactive argv are identical — never `dangerous`, never Devin\'s own --sandbox', () => {
    const auto = buildEngineCommand('devin-cli' as EngineId, 'g', CFG, { cwd: '/wt', model: 'swe-2-max', autonomous: true })!;
    const manual = buildEngineCommand('devin-cli' as EngineId, 'g', CFG, { cwd: '/wt', model: 'swe-2-max', autonomous: false })!;
    expect(auto.args).toEqual(manual.args);
    for (const args of [auto.args, manual.args]) {
      expect(args).not.toContain('dangerous');
      expect(args).not.toContain('--sandbox');
      expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    }
  });

  it('keeps a hostile goal as ONE element after `--` (a leading dash is still the prompt)', () => {
    const goal = '--permission-mode dangerous; rm -rf $HOME `id`\n--model x';
    const cmd = buildEngineCommand('devin-cli' as EngineId, goal, CFG, { cwd: '/wt', model: 'swe-2-high' })!;
    expect(cmd.args.at(-1)).toBe(goal);
    expect(cmd.args.at(-2)).toBe('--');
    expect(cmd.args.indexOf('--')).toBe(cmd.args.length - 2);
  });

  it('omits --model only when no model is named (optModel)', () => {
    const spec = BUILTIN_ENGINE_REGISTRY[DEVIN_CLI_ENGINE_ID]!;
    expect(compileArgv(spec.argv!, { goal: 'g', cwd: '/wt' })).toEqual(
      ['-p', '--permission-mode', 'smart', '--respect-workspace-trust', 'false', '--', 'g'],
    );
  });

  it('cannot be redefined from cfg.foundry.engines (binary and permission mode are authority)', () => {
    const cfg = {
      foundry: {
        engines: {
          'devin-cli': { id: 'devin-cli', kind: 'cli-agent', tier: 'frontier', bin: 'sh', argv: ['-p', '--permission-mode', 'dangerous', '$GOAL'] },
        },
      },
    } as unknown as AshlrConfig;
    expect(resolveEngineSpec('devin-cli', cfg)).toEqual(BUILTIN_ENGINE_REGISTRY['devin-cli']);
    expect(engineTierOf('devin-cli' as EngineId, cfg)).toBe('mid');
  });

  it('maps the lane to the engine and back', () => {
    expect(registryEngineForFleetEngine('devin-cli')).toBe('devin-cli');
    expect(fleetLaneOf('devin-cli')).toBe('devin-cli');
    expect(fleetLaneOf('DEVIN-CLI')).toBe('devin-cli');
    // The Devin cloud identity is NOT the CLI lane.
    expect(fleetLaneOf('devin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Model resolution and the lane verdict
// ---------------------------------------------------------------------------

describe('model resolution', () => {
  it('defaults to swe-2-high; devin.fleetModel and a per-run override win in that order', () => {
    expect(DEVIN_CLI_FLEET_DEFAULT_MODEL).toBe('swe-2-high');
    expect(resolveDevinCliFleetModel(undefined)).toBe('swe-2-high');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max' })).toBe('swe-2-max');
    expect(resolveDevinCliFleetModel({ fleetModel: 'swe-2-max' }, 'swe-2-medium')).toBe('swe-2-medium');
  });

  it('ignores a malformed model instead of passing it to --model', () => {
    for (const bad of ['--sandbox', 'swe 2', 'SWE-2-HIGH', '', ' ', 'x'.repeat(65), '-p']) {
      expect(resolveDevinCliFleetModel({ fleetModel: bad })).toBe('swe-2-high');
      expect(resolveDevinCliFleetModel(undefined, bad)).toBe('swe-2-high');
    }
  });

  it('only the three exact SWE-2 ids are free (aliases are not proof of the model)', () => {
    expect([...DEVIN_CLI_FREE_MODELS]).toEqual(['swe-2-high', 'swe-2-medium', 'swe-2-max']);
    for (const m of DEVIN_CLI_FREE_MODELS) expect(isDevinCliFreeModel(m)).toBe(true);
    for (const m of ['swe', 'swe-2', 'swe-1-7-lightning', 'claude-opus-5-5-high', 'adaptive', null, 3]) {
      expect(isDevinCliFreeModel(m)).toBe(false);
    }
  });
});

function verdictInput(over: Partial<DevinCliLaneInput> = {}): DevinCliLaneInput {
  return {
    section: OPTED_IN,
    grant: { ok: true, reason: 'granted' },
    budgetAllowsDevin: true,
    budgetMode: 'balanced',
    probe: { state: 'ready', reason: null },
    model: 'swe-2-high',
    nativeFreeModelVerified: true,
    ...over,
  };
}

describe('devinCliLaneVerdict — every check, first failure wins', () => {
  it('opens only when opt-in, grant, budget mode, free model and CLI all pass', () => {
    expect(devinCliLaneVerdict(verdictInput())).toMatchObject({ ok:process.platform !== 'win32' });
  });

  it('refuses in order: enabled, fleet opt-in, grant, budget, probe, qualified pricing', () => {
    const closedAll = verdictInput({
      section: {}, grant: { ok: false, reason: 'no grant' }, budgetAllowsDevin: false,
      model: 'claude-opus-5-5-high', probe: { state: 'missing', reason: 'not installed' },
    });
    expect(devinCliLaneVerdict(closedAll).reason).toMatch(/Devin lane is turned off/);
    expect(devinCliLaneVerdict({ ...closedAll, section: { enabled: true } }).reason).toMatch(/fleet opt-in is off/);
    expect(devinCliLaneVerdict({ ...closedAll, section: OPTED_IN }).reason).toBe('no grant');
    expect(devinCliLaneVerdict({ ...closedAll, section: OPTED_IN, grant: { ok: true, reason: '' } }).reason)
      .toBe('The balanced budget mode keeps the Devin seat off for autonomy.');
    expect(devinCliLaneVerdict({ ...closedAll, section: OPTED_IN, grant: { ok: true, reason: '' }, budgetAllowsDevin: true }).reason)
      .toBe('not installed');
    expect(devinCliLaneVerdict({ ...closedAll, section: OPTED_IN, grant: { ok: true, reason: '' }, budgetAllowsDevin: true, model: 'swe-2-high' }).reason)
      .toBe('not installed');
  });

  it('source model IDs alone never authorize free pricing', () => {
    expect(devinCliLaneVerdict(verdictInput({ nativeFreeModelVerified:undefined })).ok).toBe(false);
    expect(devinCliLaneVerdict(verdictInput({ model:'claude-opus-5-5-high',nativeFreeModelVerified:false }))).toMatchObject({ok:false,reason:expect.stringMatching(/unconfirmed/)});
  });

  it('an unreadable budget or an unprobed CLI fails closed', () => {
    expect(devinCliLaneVerdict(verdictInput({ budgetAllowsDevin: null }))).toMatchObject({ ok: false, reason: expect.stringMatching(/budget could not be read/) });
    expect(devinCliLaneVerdict(verdictInput({ probe: null }))).toMatchObject({ ok: false });
    expect(devinCliLaneVerdict(verdictInput({ probe: { state: 'logged-out', reason: null } }))).toMatchObject({ ok: false });
  });

  it('`fleet` must be exactly true (a truthy non-boolean is not an opt-in)', () => {
    const section = { enabled: true, fleet: 'yes' } as unknown as AshlrConfig['devin'];
    expect(devinCliLaneVerdict(verdictInput({ section })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity: a lane, authorized by the grant engine `devin`
// ---------------------------------------------------------------------------

describe('identity — `devin-cli` is a lane the grant\'s `devin` authorizes', () => {
  it('is a fleet lane but never a grant engine', () => {
    expect(FLEET_ENGINES).toContain('devin-cli');
    expect(GRANT_ENGINES as readonly string[]).not.toContain('devin-cli');
    expect(grantEngineOfLane(DEVIN_CLI_LANE)).toBe('devin');
    for (const lane of FLEET_ENGINES.filter((l) => l !== 'devin-cli')) expect(grantEngineOfLane(lane)).toBe(lane);
  });

  it('a Devin seat still opens no seat-router lane (the Devin CLI is reached only through its own lane)', () => {
    expect(laneOfSeat({ engine: 'devin' })).toBeNull();
  });

  it('the grant\'s Devin producer seat is what the lane needs (same rule as the cloud launcher)', () => {
    expect(grantHasDevinProducer(policy())).toBe(true);
    expect(grantHasDevinProducer(policy({ devinSeat: null }))).toBe(false);
    expect(grantHasDevinProducer(policy({ devinSeat: seat(DEVIN_SEAT_ID, ['producer'], false) }))).toBe(false);
    expect(standingAuthorizesDevin(policy() as EffectivePolicy).ok).toBe(true);
    expect(standingAuthorizesDevin(policy({ engines: ['local'] }) as EffectivePolicy).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lanes and the router
// ---------------------------------------------------------------------------

function seat(seatId: string, roles: EffectiveSeatPolicy['roles'], enabled = true): EffectiveSeatPolicy {
  return { seatId, enabled, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles };
}

function policy(over: { engines?: EffectivePolicy['engines']; devinSeat?: EffectiveSeatPolicy | null } = {}): Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'> {
  const seats: Record<string, EffectiveSeatPolicy> = { local: seat('local', ['producer']) };
  const devinSeat = over.devinSeat === undefined ? seat(DEVIN_SEAT_ID, ['producer']) : over.devinSeat;
  if (devinSeat) seats[DEVIN_SEAT_ID] = devinSeat;
  return {
    engines: over.engines ?? ['local', 'devin'],
    spend: { maxMode: 'balanced', meteredUsdPerDay: 0, seats },
    repos: [{
      nameWithOwner: REPO, stage: 'merge', enforcement: 'server', maxRisk: 'low', maxFiles: 4, maxLines: 150, maxMergesPerDay: 6, selfRepo: null,
    }],
  };
}

const ABSENT = { present: false, reason: 'Nobody is at the keyboard.', evidenceAt: null };

function local(window = 65_536): SeatCapacity {
  return {
    seatId: FLEET_LOCAL_SEAT_ID, engine: 'local', label: 'Local fleet', free: true, windows: [], signedOut: false,
    reachable: true, contextWindow: window, observedAt: null, spentTodayUsd: null,
  };
}

function lanes(over: Partial<Record<FleetEngine, number>> = {}): Record<FleetEngine, LanePlan> {
  const out = {} as Record<FleetEngine, LanePlan>;
  for (const lane of FLEET_ENGINES) out[lane] = { lane, slots: over[lane] ?? LANE_DEFAULT_SLOTS[lane], capReason: null };
  return out;
}

function ctx(capacity: SeatCapacity[], over: Partial<DispatchRouterContext> = {}): DispatchRouterContext {
  return {
    nowMs: NOW,
    policy: policy(),
    budget: defaultBudgetPolicy(),
    capacity,
    lanes: lanes(),
    laneEngines: {
      local: 'llama-server' as EngineId, 'grok-cli': null, 'claude-cli': null, codex: null, 'devin-cli': 'devin-cli' as EngineId,
    },
    demotions: [],
    repoOf: (path) => (path === REPO_PATH ? REPO : null),
    tierOf: (engine) => {
      const id: string = engine;
      return id === 'devin-cli' || id === 'llama-server' ? 'mid' : 'local';
    },
    cfg: { devin: OPTED_IN } as unknown as AshlrConfig,
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1', repo: REPO_PATH, source: 'todo', title: 'Fix the parser edge case', detail: 'Short detail.',
    value: 3, effort: 3, score: 1, tags: [], ts: NOW_ISO, ...over,
  };
}

const LEGACY: LegacyRoute = { backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy: builtin' };

describe('planLanes — the Devin CLI lane', () => {
  const base = { directives: null, presence: ABSENT, localServingSlots: 4 };

  it('one slot when the grant names devin with a producer seat and the engine is ready', () => {
    const planned = planLanes({ ...base, policy: policy(), engineUnavailable: {} });
    expect(LANE_DEFAULT_SLOTS['devin-cli']).toBe(1);
    expect(planned['devin-cli']).toEqual({ lane: 'devin-cli', slots: 1, capReason: null });
  });

  it('zero, with the reason, when the grant stage lacks devin, the seat is missing, or the engine is not ready', () => {
    expect(planLanes({ ...base, policy: policy({ engines: ['local'] }), engineUnavailable: {} })['devin-cli'])
      .toMatchObject({ slots: 0, capReason: "The grant's current rollout stage does not include Devin." });
    expect(planLanes({ ...base, policy: policy({ devinSeat: null }), engineUnavailable: {} })['devin-cli'])
      .toMatchObject({ slots: 0, capReason: 'The grant gives Devin no producer seat.' });
    expect(planLanes({ ...base, policy: policy(), engineUnavailable: { 'devin-cli': 'The Devin CLI is logged out.' } })['devin-cli'])
      .toMatchObject({ slots: 0, capReason: 'The Devin CLI is logged out.' });
  });

  it('is not held back by presence (it spends no seat Mason uses)', () => {
    const present = planLanes({ ...base, presence: { present: true, reason: 'Verse turn', evidenceAt: NOW_ISO }, policy: policy(), engineUnavailable: {} });
    expect(present['devin-cli'].slots).toBe(1);
  });
});

describe('resolveLaneEngines — Devin readiness, not allowedBackends', () => {
  const input = { allowedBackends: ['builtin'], installed: () => true, localFleetEngine: null };

  it('the lane has the engine exactly when the Devin verdict is ok', () => {
    expect(resolveLaneEngines({ ...input, devinCli: { ok: true, reason: 'ok' } }).engines['devin-cli']).toBe('devin-cli');
    const closed = resolveLaneEngines({ ...input, devinCli: { ok: false, reason: 'The Devin CLI is logged out.' } });
    expect(closed.engines['devin-cli']).toBeNull();
    expect(closed.unavailable['devin-cli']).toBe('The Devin CLI is logged out.');
  });

  it('closed when not evaluated at all', () => {
    const r = resolveLaneEngines(input);
    expect(r.engines['devin-cli']).toBeNull();
    expect(r.unavailable['devin-cli']).toMatch(/not evaluated/);
  });
});

describe('routeWorkItem — the Devin CLI as overflow', () => {
  it('takes work no seat-router seat can (here: too big for the local window)', () => {
    const route = routeWorkItem(item({ tags: ['difficulty:high', 'context:150000'] }), LEGACY, ctx([local()]));
    expect(route.hold).toBeNull();
    expect(route).toMatchObject({ backend: 'devin-cli', lane: 'devin-cli', model: 'swe-2-high', tier: 'mid', repo: REPO });
    expect(route.seatDecision?.seatId).toBe(DEVIN_SEAT_ID);
    expect(route.reason).toMatch(/Devin CLI \(swe-2-high, free\)/);
  });

  it('runs devin.fleetModel', () => {
    const route = routeWorkItem(item({ tags: ['context:150000'] }), LEGACY, ctx([local()], { cfg: { devin: { ...OPTED_IN, fleetModel: 'swe-2-max' } } as unknown as AshlrConfig }));
    expect(route.model).toBe('swe-2-max');
  });

  it('never displaces a seat the router chose (neutral default)', () => {
    const route = routeWorkItem(item({ tags: ['difficulty:low'] }), LEGACY, ctx([local()]));
    expect(route.lane).toBe('local');
  });

  it('parks (with the Devin reason) when its lane is closed', () => {
    const route = routeWorkItem(item({ tags: ['context:150000'] }), LEGACY, ctx([local()], {
      lanes: { ...lanes(), 'devin-cli': { lane: 'devin-cli', slots: 0, capReason: 'The Devin CLI is logged out.' } },
    }));
    expect(route.hold?.kind).toBe('park');
    const devin = route.seatDecision?.exclusions.find((e) => e.seatId === DEVIN_SEAT_ID);
    expect(devin?.reasons).toContain('The Devin CLI is logged out.');
  });

  it('an item only SWE-2 could fit parks while the lane is merely busy, but splits when the lane is off', () => {
    const big = item({ tags: ['context:150000'] });
    const busy = routeWorkItem(big, LEGACY, ctx([local()], {
      lanes: { ...lanes(), 'devin-cli': { lane: 'devin-cli', slots: 0, capReason: 'Held.' } },
    }));
    expect(busy.hold?.kind).toBe('park');
    const off = routeWorkItem(big, LEGACY, ctx([local()], {
      laneEngines: { local: 'llama-server' as EngineId, 'grok-cli': null, 'claude-cli': null, codex: null, 'devin-cli': null },
    }));
    expect(off.hold?.kind).toBe('split');
  });

  it('is not in play at all when the grant does not name devin (split as before)', () => {
    const route = routeWorkItem(item({ tags: ['context:150000'] }), LEGACY, ctx([local()], { policy: policy({ engines: ['local'] }) }));
    expect(route.hold?.kind).toBe('split');
    expect(route.seatDecision?.exclusions.some((e) => e.seatId === DEVIN_SEAT_ID)).toBe(false);
  });

  it('refuses work beyond SWE-2\'s window, and honours a demotion of the route', () => {
    const tooBig = routeWorkItem(item({ tags: [`context:${DEVIN_CLI_CONTEXT_TOKENS}`] }), LEGACY, ctx([local()]));
    expect(tooBig.hold?.kind).toBe('split');
    const demoted = routeWorkItem(item({ tags: ['context:150000'] }), LEGACY, ctx([local()], {
      demotions: [{ engine: 'devin-cli', repo: REPO, kind: 'todo', since: NOW_ISO, until: new Date(NOW + 3_600_000).toISOString(), reason: 'three failures' }],
    }));
    expect(demoted.hold?.kind).toBe('park');
    expect(demoted.seatDecision?.exclusions.find((e) => e.seatId === DEVIN_SEAT_ID)?.details?.map((d) => d.kind)).toEqual(['demoted']);
  });

  it('devinCliOverflow is pure and reports nothing when the grant has no Devin producer', () => {
    expect(devinCliOverflow(routingRequestFor(item()), REPO, 'todo', ctx([local()], { policy: policy({ devinSeat: null }) }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The tick: readiness and the allowed-backend filter
// ---------------------------------------------------------------------------

describe('devinCliReadiness (tick-hooks-live)', () => {
  const budget: BudgetPolicy = defaultBudgetPolicy();

  it('reads native pricing only after opt-in, grant and budget; IDs alone cannot open the lane', async () => {
    const probe = vi.fn(async () => ({ state: 'ready' as const, cliPath: '/fake/devin', reason: null, checkedAt: NOW }));
    const off = await devinCliReadiness({ devin: { enabled: true } } as AshlrConfig, policy() as EffectivePolicy, budget, { probeDevinCli: probe });
    expect(off.ok).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    const evidence = vi.fn(nativeBinding);
    const paid = await devinCliReadiness({ devin: { ...OPTED_IN, fleetModel: 'claude-opus-5-5-high' } } as AshlrConfig, policy() as EffectivePolicy, budget, { probeDevinCli: probe,devinCliExecutionBinding:evidence });
    expect(paid.ok).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledWith('claude-opus-5-5-high','/fake/devin');
    const ready = await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, budget, { probeDevinCli: probe,devinCliExecutionBinding:evidence });
    expect(probe).toHaveBeenCalledTimes(2);
    // balanced mode (the default) lets autonomy use the Devin seat.
    expect(ready).toMatchObject(process.platform === 'win32'
      ? {ok:false,reason:expect.stringMatching(/unconfirmed/)}
      : { ok:true,reason:expect.stringMatching(/swe-2-high \(native-verified free\)/) });
  });

  it('the probe\'s refusal (with its fixing command) becomes the lane\'s reason; a throwing or absent probe is closed', async () => {
    const loggedOut = async () => ({ state: 'logged-out' as const, cliPath: '/fake/devin', reason: 'The Devin CLI is logged out. Run `devin auth login`.', checkedAt: NOW });
    const allowAll: BudgetPolicy = { mode: 'all-in', updatedAt: NOW_ISO, seats: {} };
    expect(await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, allowAll, { probeDevinCli: loggedOut }))
      .toEqual({ ok: false, reason: 'The Devin CLI is logged out. Run `devin auth login`.' });
    expect((await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, allowAll, { probeDevinCli: async () => { throw new Error('x'); } })).ok).toBe(false);
    expect((await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, allowAll, {})).ok).toBe(false);
    const ready = async () => ({ state: 'ready' as const, cliPath: '/fake/devin', reason: null, checkedAt: NOW });
    expect(await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, allowAll, { probeDevinCli: ready,devinCliExecutionBinding:nativeBinding }))
      .toMatchObject({ ok:process.platform !== 'win32' });
  });

  it('reserve mode keeps the lane off (A9: Devin disabled in reserve)', async () => {
    const reserve: BudgetPolicy = { mode: 'reserve', updatedAt: NOW_ISO, seats: {} };
    const ready = async () => ({ state: 'ready' as const, cliPath: '/fake/devin', reason: null, checkedAt: NOW });
    expect(await devinCliReadiness({ devin: OPTED_IN } as AshlrConfig, policy() as EffectivePolicy, reserve, { probeDevinCli: ready }))
      .toEqual({ ok: false, reason: 'The reserve budget mode keeps the Devin seat off for autonomy.' });
  });

  it('grantAllowedBackends never admits devin-cli, even with `devin` in the grant', () => {
    expect(grantAllowedBackends(['devin-cli', 'builtin'], policy() as EffectivePolicy)).toEqual(['builtin']);
  });
});

// ---------------------------------------------------------------------------
// Locality, spend, confinement
// ---------------------------------------------------------------------------

describe('locality and spend', () => {
  it('is metered (a network vendor), so local-only refuses it', () => {
    expect(engineMeteredness('devin-cli')).toBe('metered');
    expect(enginePermitted('devin-cli', { foundry: { localOnly: true } } as unknown as AshlrConfig).permitted).toBe(false);
    expect(engineIdForBin('/opt/homebrew/bin/devin')).toBe('devin-cli');
  });

  it('bills as a flat-plan seat CLI in fleet history', () => {
    expect(runBilling('devin-cli')).toBe('subscription');
  });

  it('gets a 30-minute idle-stall floor (print mode is silent until its answer)', () => {
    expect(DEVIN_CLI_STALL_IDLE_MS).toBe(30 * 60_000);
    expect(devinCliStallIdleMs(CFG)).toBe(DEVIN_CLI_STALL_IDLE_MS);
    expect(devinCliStallIdleMs({ foundry: { stallIdleMs: 60_000 } } as unknown as AshlrConfig)).toBe(DEVIN_CLI_STALL_IDLE_MS);
    expect(devinCliStallIdleMs({ foundry: { stallIdleMs: 45 * 60_000 } } as unknown as AshlrConfig)).toBe(45 * 60_000);
  });
});

describe('autonomous confinement — a per-run copy of the Devin login', () => {
  function scratch(): { home: string; run: string; creds: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devin-cli-env-')));
    const home = join(root, 'home');
    const run = join(root, 'run');
    mkdirSync(home, { recursive: true });
    mkdirSync(run, { mode: 0o700 });
    const dir = join(home, '.local', 'share', 'devin');
    mkdirSync(dir, { recursive: true });
    const creds = join(dir, 'credentials.toml');
    writeFileSync(creds, 'windsurf_api_key = "fake-test-key"\napi_server_url = "https://example.invalid"\n', { mode: 0o644 });
    return { home, run, creds };
  }

  it('is its own class with network egress (inference is on Devin\'s servers)', () => {
    expect(autonomousEngineClass('devin-cli')).toBe('devin-cli');
    expect(autonomousConfinementProfile('devin-cli')).toMatchObject({ mode: 'os', networkEgress: true, autonomous: true, loopbackPorts: [] });
  });

  it('copies credentials.toml (0600) into the run\'s own XDG_DATA_HOME and denies the real directory', () => {
    const { home, run, creds } = scratch();
    const o = buildAutonomousEnvOverlay({ engine: 'devin-cli', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin', devinCredentialsPath: creds });
    const copy = join(o.set['XDG_DATA_HOME']!, 'devin', 'credentials.toml');
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(creds, 'utf8'));
    expect(lstatSync(copy).mode & 0o777).toBe(0o600);
    expect(o.deniedReadPaths).toContain(join(home, '.local', 'share', 'devin'));
    expect(o.engineClass).toBe('devin-cli');
    // Nothing is written back: the login is a static key.
    expect(o.vendorState).toEqual([]);
  });

  it('defaults to <home>/.local/share/devin/credentials.toml when XDG_DATA_HOME is unset', () => {
    const { home, run } = scratch();
    const prev = process.env['XDG_DATA_HOME'];
    delete process.env['XDG_DATA_HOME'];
    try {
      const o = buildAutonomousEnvOverlay({ engine: 'devin-cli', runTmpDir: run, home, seatId: null, path: '/usr/bin:/bin' });
      expect(readFileSync(join(o.set['XDG_DATA_HOME']!, 'devin', 'credentials.toml'), 'utf8')).toMatch(/fake-test-key/);
    } finally {
      if (prev !== undefined) process.env['XDG_DATA_HOME'] = prev;
    }
  });

  it('refuses a logged-out CLI or a symlinked credentials file (never runs against the real directory)', () => {
    const { home, run } = scratch();
    expect(() => buildAutonomousEnvOverlay({ engine: 'devin-cli', runTmpDir: run, home, seatId: null, devinCredentialsPath: join(home, 'nope.toml') }))
      .toThrow(/logged out/);
    const other = scratch();
    const link = join(other.home, 'linked.toml');
    symlinkSync(other.creds, link);
    expect(() => buildAutonomousEnvOverlay({ engine: 'devin-cli', runTmpDir: other.run, home: other.home, seatId: null, devinCredentialsPath: link }))
      .toThrow(/not a regular file/);
  });
});
