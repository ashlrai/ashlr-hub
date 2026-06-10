/**
 * M30 seams tests — hermetic, in-memory config; NEVER touches the real ~/.ashlr
 * or the real portfolio, and NEVER makes a remote call.
 *
 * Invariants under test (the M30 HARD safety invariants):
 *   1. INTERFACES + LOCAL ONLY: every selector returns the LOCAL impl on the
 *      default (no-endpoint) config; the local impl is a behavior-preserving
 *      adapter (delegates to the existing module's exports).
 *   2. NO ACTIVATION PATH: a selector returns the GATED cloud stub ONLY when a
 *      cloud endpoint is explicitly configured for that seam — and that stub
 *      THROWS the canonical gated error on EVERY method, before any I/O.
 *   3. NON-REGRESSION: the registry build is read-only metadata; AshlrConfig is
 *      not modified (the seams config is read defensively).
 *   4. READ-ONLY DIAGNOSTIC: buildSeamRegistry triggers no I/O and reports
 *      active=local + cloud=gated by default.
 */

import { describe, it, expect } from 'vitest';

import { defaultConfig } from '../src/core/config.js';
import type { AshlrConfig } from '../src/core/types.js';

import {
  buildSeamRegistry,
  seamEndpoint,
  selectRunSwarmStore,
  LocalRunSwarmStore,
  CloudRunSwarmStore,
  selectBacklogSource,
  LocalBacklogSource,
  CloudBacklogSource,
  selectInboxStore,
  LocalInboxStore,
  CloudInboxStore,
  selectDaemonCoordinator,
  LocalDaemonCoordinator,
  CloudDaemonCoordinator,
  selectGenomeSync,
  LocalGenomeSync,
  CloudGenomeSync,
  selectPortfolioSync,
  LocalPortfolioSync,
  CloudPortfolioSync,
  selectIdentityProvider,
  LocalIdentityProvider,
  CloudIdentityProvider,
  CLOUD_GATED_MESSAGE,
} from '../src/core/seams/index.js';

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

describe('M30 seams — default path returns LOCAL impls', () => {
  const cfg = defaultConfig();

  it('every selector returns the LOCAL impl by default (no endpoint)', () => {
    expect(selectRunSwarmStore(cfg)).toBeInstanceOf(LocalRunSwarmStore);
    expect(selectBacklogSource(cfg)).toBeInstanceOf(LocalBacklogSource);
    expect(selectInboxStore(cfg)).toBeInstanceOf(LocalInboxStore);
    expect(selectDaemonCoordinator(cfg)).toBeInstanceOf(LocalDaemonCoordinator);
    expect(selectGenomeSync(cfg)).toBeInstanceOf(LocalGenomeSync);
    expect(selectPortfolioSync(cfg)).toBeInstanceOf(LocalPortfolioSync);
    expect(selectIdentityProvider(cfg)).toBeInstanceOf(LocalIdentityProvider);
  });

  it('seamEndpoint is null for every seam on a default config', () => {
    for (const id of [
      'runSwarm',
      'backlog',
      'inbox',
      'daemonCoordinator',
      'genome',
      'portfolio',
      'identity',
    ] as const) {
      expect(seamEndpoint(cfg, id)).toBeNull();
    }
  });
});

describe('M30 seams — NO ACTIVATION PATH: configured endpoint routes to a GATED stub that throws', () => {
  it('selectors return the cloud stub ONLY when an endpoint is configured', () => {
    expect(selectRunSwarmStore(cfgWithEndpoint('runSwarm'))).toBeInstanceOf(CloudRunSwarmStore);
    expect(selectBacklogSource(cfgWithEndpoint('backlog'))).toBeInstanceOf(CloudBacklogSource);
    expect(selectInboxStore(cfgWithEndpoint('inbox'))).toBeInstanceOf(CloudInboxStore);
    expect(selectDaemonCoordinator(cfgWithEndpoint('daemonCoordinator'))).toBeInstanceOf(
      CloudDaemonCoordinator,
    );
    expect(selectGenomeSync(cfgWithEndpoint('genome'))).toBeInstanceOf(CloudGenomeSync);
    expect(selectPortfolioSync(cfgWithEndpoint('portfolio'))).toBeInstanceOf(CloudPortfolioSync);
    expect(selectIdentityProvider(cfgWithEndpoint('identity'))).toBeInstanceOf(
      CloudIdentityProvider,
    );
  });

  it('every cloud stub method THROWS the canonical gated error (no I/O)', () => {
    const run = new CloudRunSwarmStore();
    expect(() => run.list()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => run.load('x')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => run.save({ id: 'x' } as never)).toThrow(CLOUD_GATED_MESSAGE);

    const backlog = new CloudBacklogSource();
    expect(() => backlog.load()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => backlog.build()).toThrow(CLOUD_GATED_MESSAGE);

    const inbox = new CloudInboxStore();
    expect(() => inbox.list()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => inbox.create({} as never)).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => inbox.load('x')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => inbox.setStatus('x', 'approved')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => inbox.pendingCount()).toThrow(CLOUD_GATED_MESSAGE);

    const daemon = new CloudDaemonCoordinator();
    expect(() => daemon.load()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => daemon.save({} as never)).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => daemon.acquireLease()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => daemon.releaseLease()).toThrow(CLOUD_GATED_MESSAGE);

    const genome = new CloudGenomeSync();
    expect(() => genome.load(defaultConfig())).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => genome.append({ text: 'x' } as never)).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => genome.hubHealth()).toThrow(CLOUD_GATED_MESSAGE);

    const portfolio = new CloudPortfolioSync();
    expect(() => portfolio.saveReport({} as never)).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => portfolio.listReports()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => portfolio.loadPreviousReport()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => portfolio.buildSnapshot(defaultConfig())).toThrow(CLOUD_GATED_MESSAGE);

    const identity = new CloudIdentityProvider();
    expect(() => identity.get()).toThrow(CLOUD_GATED_MESSAGE);
  });
});

describe('M30 seams — LOCAL DaemonCoordinator preserves single-machine semantics', () => {
  it('acquireLease is always true and releaseLease is a no-op (no contention)', () => {
    const local = new LocalDaemonCoordinator();
    expect(local.acquireLease()).toBe(true);
    expect(() => local.releaseLease()).not.toThrow();
  });
});

describe('M30 seams — READ-ONLY registry diagnostic', () => {
  it('reports active=local + cloud=gated for every gated seam by default', () => {
    const reg = buildSeamRegistry(defaultConfig());
    expect(reg.allLocal).toBe(true);
    expect(reg.gatedConfigured).toBe(0);
    expect(reg.seams.length).toBe(8); // 7 gated seams + the cited telemetry seam

    const byId = new Map(reg.seams.map((s) => [s.id, s]));
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
      expect(row).toBeDefined();
      expect(row?.active).toBe('local');
      expect(row?.cloud).toBe('gated');
      expect(row?.endpointConfigured).toBe(false);
    }

    // The telemetry reference seam is CITED with cloud=false (its OTLP sink is a
    // real local-network sink, not a gated team backbone).
    const tel = byId.get('telemetry');
    expect(tel?.active).toBe('local');
    expect(tel?.cloud).toBe(false);
  });

  it('marks a seam active=gated ONLY when its endpoint is configured', () => {
    const reg = buildSeamRegistry(cfgWithEndpoint('inbox'));
    expect(reg.allLocal).toBe(false);
    expect(reg.gatedConfigured).toBe(1);
    const inbox = reg.seams.find((s) => s.id === 'inbox');
    expect(inbox?.active).toBe('gated');
    expect(inbox?.endpointConfigured).toBe(true);
    // Other seams remain local.
    const run = reg.seams.find((s) => s.id === 'runSwarm');
    expect(run?.active).toBe('local');
  });
});
