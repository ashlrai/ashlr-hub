/**
 * M30 coord+identity tests — focused on the DaemonCoordinator + IdentityProvider
 * seams and the read-only seam registry.
 *
 * HERMETIC: process.env.HOME is relocated to an os.tmpdir() so the LOCAL
 * DaemonCoordinator's delegate (core/daemon/state.ts) reads/writes a tmp
 * ~/.ashlr/daemon.json — NEVER the real ~/.ashlr. The IdentityProvider local
 * impl delegates to getIdentity() (phantom probe) which NEVER throws and is
 * values-free; the cloud stubs THROW before any I/O so no remote call ever
 * happens.
 *
 * Invariants under test:
 *   1. INTERFACES + LOCAL ONLY: the LOCAL coordinator grants a lease + round-trips
 *      daemon state via the existing exported functions; the LOCAL identity
 *      provider returns getIdentity() unchanged.
 *   2. NO ACTIVATION PATH: the cloud stubs THROW the canonical gated error on
 *      EVERY method (before any I/O); selectors only return them when an endpoint
 *      is explicitly configured.
 *   3. READ-ONLY REGISTRY: listSeams()/buildSeamRegistry reports every seam with
 *      active=local + cloud=gated by default (telemetry cited with cloud=false).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultConfig } from '../src/core/config.js';
import type { AshlrConfig, DaemonState } from '../src/core/types.js';

import {
  buildSeamRegistry,
  seamEndpoint,
  selectDaemonCoordinator,
  LocalDaemonCoordinator,
  CloudDaemonCoordinator,
  selectIdentityProvider,
  LocalIdentityProvider,
  CloudIdentityProvider,
  CLOUD_GATED_MESSAGE,
} from '../src/core/seams/index.js';

// ---------------------------------------------------------------------------
// Relocate HOME to a tmp dir so the LOCAL coordinator's daemon.json delegate
// lands under tmp, not the real ~/.ashlr.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m30-coord-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

/** A config with a cloud endpoint configured for a given seam (gated route). */
function cfgWithEndpoint(seam: string): AshlrConfig {
  const base = defaultConfig();
  return {
    ...base,
    // The `seams` block is read defensively off AshlrConfig (NON-REGRESSION):
    // it is NOT part of the AshlrConfig type, so we attach it via a cast.
    ...({ seams: { [seam]: { endpoint: 'https://team.example.invalid/backbone' } } } as object),
  } as AshlrConfig;
}

function freshDaemonState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DaemonCoordinator — LOCAL single-machine
// ---------------------------------------------------------------------------

describe('M30 DaemonCoordinator — LOCAL single-machine', () => {
  it('selectDaemonCoordinator returns the LOCAL impl by default (no endpoint)', () => {
    expect(selectDaemonCoordinator(defaultConfig())).toBeInstanceOf(LocalDaemonCoordinator);
    expect(seamEndpoint(defaultConfig(), 'daemonCoordinator')).toBeNull();
  });

  it('grants the operator lease (always true on one machine) + release is a no-op', () => {
    const coord = new LocalDaemonCoordinator();
    expect(coord.acquireLease()).toBe(true);
    expect(() => coord.releaseLease()).not.toThrow();
    // Idempotent — a second acquire still grants (no contention).
    expect(coord.acquireLease()).toBe(true);
  });

  it('reads zeroed state by default and round-trips a save via state.ts (tmp HOME)', () => {
    const coord = new LocalDaemonCoordinator();

    // Default: no daemon.json yet → zeroed state (delegates to loadDaemonState).
    const initial = coord.load();
    expect(initial.running).toBe(false);
    expect(initial.pid).toBeNull();
    expect(initial.todaySpentUsd).toBe(0);
    expect(initial.ticks).toEqual([]);

    // Save then reload — the write lands under the tmp HOME, never real ~/.ashlr.
    // H5 CHANGE 2: coord.load() routes through loadDaemonState(), which now
    // reconciles a phantom-live daemon (running:true + DEAD pid) at the load
    // chokepoint. To round-trip a GENUINELY-running daemon we use the live test
    // process pid (process.pid) so the liveness check keeps running:true.
    const next = freshDaemonState({
      running: true,
      pid: process.pid,
      startedAt: '2026-06-10T00:00:00.000Z',
      itemsProcessed: 7,
      todaySpentUsd: 1.25,
    });
    coord.save(next);

    const reloaded = coord.load();
    expect(reloaded.running).toBe(true);
    expect(reloaded.pid).toBe(process.pid);
    expect(reloaded.startedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(reloaded.itemsProcessed).toBe(7);
    expect(reloaded.todaySpentUsd).toBe(1.25);

    // The persisted file lives under the tmp HOME (proves it delegates to
    // state.ts and never touches the real home dir).
    const daemonPath = path.join(tmpHome, '.ashlr', 'daemon.json');
    expect(fs.existsSync(daemonPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IdentityProvider — LOCAL phantom probe
// ---------------------------------------------------------------------------

describe('M30 IdentityProvider — LOCAL phantom probe', () => {
  it('selectIdentityProvider returns the LOCAL impl by default (no endpoint)', () => {
    expect(selectIdentityProvider(defaultConfig())).toBeInstanceOf(LocalIdentityProvider);
    expect(seamEndpoint(defaultConfig(), 'identity')).toBeNull();
  });

  it('get() delegates to getIdentity(): never throws + returns a values-free snapshot', () => {
    const provider = new LocalIdentityProvider();
    let id: ReturnType<typeof provider.get>;
    expect(() => {
      id = provider.get();
    }).not.toThrow();
    // Shape contract: names/status only — booleans/strings/nulls, no secrets.
    expect(typeof id!.loggedIn).toBe('boolean');
    expect(id!.user === null || typeof id!.user === 'string').toBe(true);
    expect(id!.tier === null || typeof id!.tier === 'string').toBe(true);
    expect(id!.team === null || typeof id!.team === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GATED cloud stubs — refuse before any I/O
// ---------------------------------------------------------------------------

describe('M30 cloud stubs — GATED: throw before any I/O', () => {
  it('selectors return the cloud stub ONLY when an endpoint is configured', () => {
    expect(selectDaemonCoordinator(cfgWithEndpoint('daemonCoordinator'))).toBeInstanceOf(
      CloudDaemonCoordinator,
    );
    expect(selectIdentityProvider(cfgWithEndpoint('identity'))).toBeInstanceOf(
      CloudIdentityProvider,
    );
  });

  it('CloudDaemonCoordinator throws the canonical gated error on EVERY method', () => {
    const coord = new CloudDaemonCoordinator();
    expect(() => coord.load()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => coord.save(freshDaemonState())).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => coord.acquireLease()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => coord.releaseLease()).toThrow(CLOUD_GATED_MESSAGE);
  });

  it('CloudIdentityProvider throws the canonical gated error on get()', () => {
    const provider = new CloudIdentityProvider();
    expect(() => provider.get()).toThrow(CLOUD_GATED_MESSAGE);
  });

  it('a gated daemon save performs NO disk I/O (no file written under tmp HOME)', () => {
    const coord = new CloudDaemonCoordinator();
    expect(() => coord.save(freshDaemonState({ running: true }))).toThrow(CLOUD_GATED_MESSAGE);
    // The stub throws first — nothing should have been persisted.
    const daemonPath = path.join(tmpHome, '.ashlr', 'daemon.json');
    expect(fs.existsSync(daemonPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// READ-ONLY registry — enumerates every seam
// ---------------------------------------------------------------------------

describe('M30 seam registry — listSeams reports every seam active=local / cloud=gated', () => {
  it('default config: all gated seams active=local, cloud=gated; telemetry cited cloud=false', () => {
    const reg = buildSeamRegistry(defaultConfig());
    expect(reg.allLocal).toBe(true);
    expect(reg.gatedConfigured).toBe(0);
    expect(reg.seams.length).toBe(8); // 7 gated v2 seams + the cited telemetry seam

    const byId = new Map(reg.seams.map((s) => [s.id, s]));

    // Every v2 seam is present, active=local, cloud=gated, endpoint unset.
    for (const id of [
      'runSwarm',
      'backlog',
      'inbox',
      'daemonCoordinator',
      'genome',
      'portfolio',
      'identity',
    ] as const) {
      const row = byId.get(id);
      expect(row, `seam ${id} must be enumerated`).toBeDefined();
      expect(row?.active).toBe('local');
      expect(row?.cloud).toBe('gated');
      expect(row?.endpointConfigured).toBe(false);
      expect(typeof row?.delegatesTo).toBe('string');
      expect((row?.delegatesTo ?? '').length).toBeGreaterThan(0);
    }

    // The TelemetrySink seam (M19) is CITED, not gated: cloud=false.
    const tel = byId.get('telemetry');
    expect(tel).toBeDefined();
    expect(tel?.active).toBe('local');
    expect(tel?.cloud).toBe(false);
    expect(tel?.delegatesTo).toContain('telemetry-sink');
  });

  it('a configured daemonCoordinator endpoint flips ONLY that row to active=gated', () => {
    const reg = buildSeamRegistry(cfgWithEndpoint('daemonCoordinator'));
    expect(reg.allLocal).toBe(false);
    expect(reg.gatedConfigured).toBe(1);

    const coord = reg.seams.find((s) => s.id === 'daemonCoordinator');
    expect(coord?.active).toBe('gated');
    expect(coord?.endpointConfigured).toBe(true);

    // Identity (and the rest) stay local.
    const identity = reg.seams.find((s) => s.id === 'identity');
    expect(identity?.active).toBe('local');
    expect(identity?.endpointConfigured).toBe(false);
  });
});
