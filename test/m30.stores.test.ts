/**
 * M30 store-seam tests — hermetic, all I/O confined to an os.tmpdir() HOME.
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a fresh tmp dir per test
 * so every underlying store (swarmsDir / inboxDir / hubStorePath / reportsDir)
 * resolves under the tmp dir, NEVER the real ~/.ashlr and NEVER the real
 * portfolio. No remote call is ever made — the gated cloud stubs are asserted to
 * throw BEFORE any fetch/fs side effect.
 *
 * Focus: the five STORE seams of M30 (per CONTRACT-M30 §1) —
 *   RunSwarmStore, BacklogSource, InboxStore, GenomeSync, PortfolioSync.
 *
 * Each seam is checked for three properties:
 *   1. LOCAL round-trip — the LOCAL impl delegates 1:1 to the real underlying
 *      store and round-trips through the tmpdir HOME with ZERO behavior change.
 *   2. DEFAULT selector — selectX(defaultConfig()) returns the LOCAL impl.
 *   3. GATED cloud stub — every CloudX method throws the canonical gated error
 *      and performs NO I/O (no fetch, no file written under HOME).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultConfig } from '../src/core/config.js';
import type {
  AshlrConfig,
  SwarmRun,
  SwarmPlan,
  SwarmTaskRun,
  RunBudget,
  RunUsage,
} from '../src/core/types.js';

import {
  // RunSwarmStore
  selectRunSwarmStore,
  LocalRunSwarmStore,
  CloudRunSwarmStore,
  // BacklogSource
  selectBacklogSource,
  LocalBacklogSource,
  CloudBacklogSource,
  // InboxStore
  selectInboxStore,
  LocalInboxStore,
  CloudInboxStore,
  // GenomeSync
  selectGenomeSync,
  LocalGenomeSync,
  CloudGenomeSync,
  // PortfolioSync
  selectPortfolioSync,
  LocalPortfolioSync,
  CloudPortfolioSync,
  CLOUD_GATED_MESSAGE,
} from '../src/core/seams/index.js';

// ---------------------------------------------------------------------------
// Hermetic HOME — relocate before each test so every store resolves under tmp.
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m30-stores-'));
}

beforeEach(() => {
  tmpHome = freshTmpHome();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Count files written anywhere under the tmp HOME (side-effect detector). */
function fileCountUnderHome(): number {
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(tmpHome);
  return count;
}

// ---------------------------------------------------------------------------
// SwarmRun fixture (mirrors the M12 store-test fixture shape).
// ---------------------------------------------------------------------------

function makeBudget(): RunBudget {
  return { maxTokens: 50_000, maxSteps: 100, allowCloud: false };
}
function makeUsage(): RunUsage {
  return { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 };
}
function makePlan(goal: string): SwarmPlan {
  return {
    specId: null,
    goal,
    tasks: [{ id: 'build-1', phase: 'build', goal: 'Implement feature', deps: [] }],
  };
}
let idCounter = 0;
function makeSwarmRun(goal = 'm30 store seam goal'): SwarmRun {
  const id = `m30-store-seam-${Date.now()}-${++idCounter}`;
  const plan = makePlan(goal);
  const tasks: SwarmTaskRun[] = plan.tasks.map((t) => ({
    id: t.id,
    phase: t.phase,
    status: 'pending' as const,
  }));
  return {
    id,
    goal,
    specId: null,
    project: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    budget: makeBudget(),
    usage: makeUsage(),
    parallel: 3,
    status: 'planning',
    plan,
    tasks,
  };
}

// ===========================================================================
// RunSwarmStore
// ===========================================================================

describe('M30 RunSwarmStore seam', () => {
  it('LOCAL round-trips a SwarmRun through the real swarm store (tmpdir HOME)', () => {
    const store = new LocalRunSwarmStore();
    const run = makeSwarmRun();

    store.save(run);

    const loaded = store.load(run.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(run.id);
    expect(loaded?.goal).toBe(run.goal);

    const all = store.list();
    expect(all.some((s) => s.id === run.id)).toBe(true);

    // A file landed under the tmp HOME, never the real ~/.ashlr.
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'swarms'))).toBe(true);
  });

  it('LOCAL.load returns null for an unknown id (delegated behavior)', () => {
    expect(new LocalRunSwarmStore().load('does-not-exist')).toBeNull();
  });

  it('selector returns the LOCAL impl by default', () => {
    expect(selectRunSwarmStore(defaultConfig())).toBeInstanceOf(LocalRunSwarmStore);
  });

  it('GATED stub throws and performs NO I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const cloud = new CloudRunSwarmStore();
    const before = fileCountUnderHome();

    expect(() => cloud.list()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.load('x')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.save(makeSwarmRun())).toThrow(CLOUD_GATED_MESSAGE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fileCountUnderHome()).toBe(before);
  });
});

// ===========================================================================
// InboxStore
// ===========================================================================

describe('M30 InboxStore seam', () => {
  it('LOCAL round-trips a proposal through the real inbox store (tmpdir HOME)', () => {
    const store = new LocalInboxStore();
    expect(store.pendingCount()).toBe(0);

    const created = store.create({
      repo: null,
      origin: 'manual',
      kind: 'note',
      title: 'm30 seam note',
      summary: 'round-trip via LocalInboxStore',
    });
    expect(created.status).toBe('pending');

    const loaded = store.load(created.id);
    expect(loaded?.id).toBe(created.id);
    expect(store.pendingCount()).toBe(1);

    store.setStatus(created.id, 'approved');
    expect(store.load(created.id)?.status).toBe('approved');
    expect(store.pendingCount()).toBe(0);

    const pending = store.list({ status: 'approved' });
    expect(pending.some((p) => p.id === created.id)).toBe(true);

    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'inbox'))).toBe(true);
  });

  it('selector returns the LOCAL impl by default', () => {
    expect(selectInboxStore(defaultConfig())).toBeInstanceOf(LocalInboxStore);
  });

  it('GATED stub throws and performs NO I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const cloud = new CloudInboxStore();
    const before = fileCountUnderHome();

    expect(() => cloud.list()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() =>
      cloud.create({ repo: null, origin: 'manual', kind: 'note', title: 't', summary: 's' }),
    ).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.load('x')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.setStatus('x', 'approved')).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.pendingCount()).toThrow(CLOUD_GATED_MESSAGE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fileCountUnderHome()).toBe(before);
  });
});

// ===========================================================================
// GenomeSync
// ===========================================================================

describe('M30 GenomeSync seam', () => {
  it('LOCAL appends + loads a hub entry through the real genome store (tmpdir HOME)', () => {
    const sync = new LocalGenomeSync();
    const cfg = defaultConfig();

    const entry = sync.append({ text: 'm30 seam memory body', title: 'm30 seam', hubOnly: true });
    expect(entry.id).toBeTruthy();

    const all = sync.load(cfg);
    expect(all.some((e) => e.id === entry.id)).toBe(true);

    const health = sync.hubHealth();
    expect(health.hubEntries).toBeGreaterThanOrEqual(1);
  });

  it('selector returns the LOCAL impl by default', () => {
    expect(selectGenomeSync(defaultConfig())).toBeInstanceOf(LocalGenomeSync);
  });

  it('GATED stub throws and performs NO I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const cloud = new CloudGenomeSync();
    const before = fileCountUnderHome();

    expect(() => cloud.load(defaultConfig())).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.append({ text: 'x' })).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.hubHealth()).toThrow(CLOUD_GATED_MESSAGE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fileCountUnderHome()).toBe(before);
  });
});

// ===========================================================================
// PortfolioSync
// ===========================================================================

describe('M30 PortfolioSync seam', () => {
  it('LOCAL round-trips a HealthReport through the real quality store (tmpdir HOME)', () => {
    const sync = new LocalPortfolioSync();

    const report = {
      generatedAt: new Date().toISOString(),
      repos: [],
      scores: [],
      averageScore: 0,
      averageGrade: 'F',
      delta: {},
    } as unknown as Parameters<typeof sync.saveReport>[0];

    const savedPath = sync.saveReport(report);
    expect(savedPath).not.toBeNull();
    expect(savedPath && fs.existsSync(savedPath)).toBe(true);

    const reports = sync.listReports();
    expect(reports.length).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'quality'))).toBe(true);
  });

  it('selector returns the LOCAL impl by default', () => {
    expect(selectPortfolioSync(defaultConfig())).toBeInstanceOf(LocalPortfolioSync);
  });

  it('GATED stub throws and performs NO I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const cloud = new CloudPortfolioSync();
    const before = fileCountUnderHome();

    expect(() => cloud.saveReport({} as never)).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.listReports()).toThrow(CLOUD_GATED_MESSAGE);
    expect(() => cloud.loadPreviousReport()).toThrow(CLOUD_GATED_MESSAGE);
    // buildSnapshot returns a Promise normally; the stub throws synchronously
    // (before any I/O), so a plain toThrow assertion is correct.
    expect(() => cloud.buildSnapshot(defaultConfig())).toThrow(CLOUD_GATED_MESSAGE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fileCountUnderHome()).toBe(before);
  });
});

// ===========================================================================
// BacklogSource
// ===========================================================================

describe('M30 BacklogSource seam', () => {
  it('LOCAL.load returns null when no backlog is persisted (delegated behavior)', () => {
    expect(new LocalBacklogSource().load()).toBeNull();
  });

  it('LOCAL.build rebuilds a backlog over an explicit empty repo set (no real portfolio)', async () => {
    const source = new LocalBacklogSource();
    // Empty repo set keeps the scan hermetic — never touches the real portfolio.
    const backlog = await source.build({ repos: [] });
    expect(backlog).toBeTruthy();
    expect(Array.isArray(backlog.items)).toBe(true);

    // After a build the backlog is persisted under the tmp HOME and reloadable.
    const reloaded = source.load();
    expect(reloaded).not.toBeNull();
  });

  it('selector returns the LOCAL impl by default', () => {
    expect(selectBacklogSource(defaultConfig())).toBeInstanceOf(LocalBacklogSource);
  });

  it('GATED stub throws and performs NO I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
    const cloud = new CloudBacklogSource();
    const before = fileCountUnderHome();

    expect(() => cloud.load()).toThrow(CLOUD_GATED_MESSAGE);
    // build() throws synchronously (before any I/O), despite its Promise return.
    expect(() => cloud.build()).toThrow(CLOUD_GATED_MESSAGE);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fileCountUnderHome()).toBe(before);
  });
});

// ===========================================================================
// Cross-seam: configured endpoint is the ONLY route to a (refusing) cloud stub.
// ===========================================================================

describe('M30 store seams — endpoint config routes ONLY to a refusing stub', () => {
  function cfgWithEndpoint(seam: string): AshlrConfig {
    return {
      ...defaultConfig(),
      ...({ seams: { [seam]: { endpoint: 'https://team.example.invalid/backbone' } } } as object),
    } as AshlrConfig;
  }

  it('a configured endpoint selects the GATED stub for each store seam', () => {
    expect(selectRunSwarmStore(cfgWithEndpoint('runSwarm'))).toBeInstanceOf(CloudRunSwarmStore);
    expect(selectBacklogSource(cfgWithEndpoint('backlog'))).toBeInstanceOf(CloudBacklogSource);
    expect(selectInboxStore(cfgWithEndpoint('inbox'))).toBeInstanceOf(CloudInboxStore);
    expect(selectGenomeSync(cfgWithEndpoint('genome'))).toBeInstanceOf(CloudGenomeSync);
    expect(selectPortfolioSync(cfgWithEndpoint('portfolio'))).toBeInstanceOf(CloudPortfolioSync);
  });
});
