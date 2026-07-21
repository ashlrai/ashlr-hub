/**
 * m90.fleet-dashboard.test.ts — M90: Fleet Activity panel.
 *
 * Units under test:
 *   buildFleetActivity (src/core/web/control.ts) — read-only aggregation.
 *   resetReadinessCache — readiness throttle cache control.
 *
 * HOME is relocated to a fresh tmp dir per test so all ~/.ashlr reads are
 * isolated. Mirrors the pattern from m61.control.test.ts.
 *
 * Engine-readiness probes (subprocess + fs) are stubbed via ProbeOverrides so
 * no real binaries are required.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import {
  buildFleetActivity,
  resetReadinessCache,
} from '../src/core/web/control.js';
import { buildSnapshot } from '../src/core/dashboard.js';
import { recordAgentAction } from '../src/core/fleet/agent-action-ledger.js';

// ---------------------------------------------------------------------------
// Config helpers (mirror m61 pattern)
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: [],
    },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m90-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
  resetReadinessCache();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  resetReadinessCache();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Shape tests — empty state
// ---------------------------------------------------------------------------

describe('buildFleetActivity — shape on empty state', () => {
  it('returns all required top-level keys', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(snap).toHaveProperty('ts');
    expect(snap).toHaveProperty('repos');
    expect(snap).toHaveProperty('totalProposed');
    expect(snap).toHaveProperty('totalAutoMerged');
    expect(snap).toHaveProperty('totalPending');
    expect(snap).toHaveProperty('totalDeclined');
    expect(snap).toHaveProperty('proposalSourceQuality');
    expect(snap).toHaveProperty('recentMerges');
    expect(snap).toHaveProperty('recentMergesSourceQuality');
    expect(snap).toHaveProperty('recentActions');
    expect(snap).toHaveProperty('engineReadiness');
    expect(snap).toHaveProperty('subscriptionUsage');
    expect(snap).toHaveProperty('cooldownCount');
    expect(snap).toHaveProperty('recentTicks');
  });

  it('ts is a valid ISO string', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(typeof snap.ts).toBe('string');
    expect(Date.parse(snap.ts)).not.toBeNaN();
  });

  it('arrays are empty on fresh ~/.ashlr', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(snap.repos).toBeInstanceOf(Array);
    expect(snap.recentMerges).toBeInstanceOf(Array);
    expect(snap.recentActions).toBeInstanceOf(Array);
    expect(snap.recentTicks).toBeInstanceOf(Array);
    expect(snap.engineReadiness).toBeInstanceOf(Array);
    expect(snap.subscriptionUsage).toBeInstanceOf(Array);
  });

  it('numeric totals are 0 on empty state', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(snap.totalProposed).toBe(0);
    expect(snap.totalAutoMerged).toBe(0);
    expect(snap.totalPending).toBe(0);
    expect(snap.totalDeclined).toBe(0);
    expect(snap.cooldownCount).toBe(0);
  });
});

describe('dashboard source quality', () => {
  it('keeps degraded proposal and decision sources distinguishable from zero', async () => {
    const inboxDir = join(tmpHome, '.ashlr', 'inbox');
    const decisionsDir = join(tmpHome, '.ashlr', 'decisions');
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(join(inboxDir, 'corrupt.json'), '{not-json', 'utf8');
    writeFileSync(join(decisionsDir, '2026-07-14.jsonl'), '{not-json\n', 'utf8');

    const snap = await buildSnapshot(baseConfig());

    expect(snap.production?.proposals24h.total).toBe(0);
    expect(snap.production?.proposalSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
    expect(snap.intelligence?.engineScorecards).toEqual([]);
    expect(snap.intelligence?.proposalSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
    expect(snap.intelligence?.decisionSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
  });
});

describe('buildFleetActivity — proposal source quality', () => {
  it('withholds repository and merge evidence when the inbox is corrupt', async () => {
    const inboxDir = join(tmpHome, '.ashlr', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'corrupt.json'), '{not-json', 'utf8');

    const snap = await buildFleetActivity(baseConfig());

    expect(snap.repos).toEqual([]);
    expect(snap.recentMerges).toEqual([]);
    expect(snap.proposalSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
    expect(snap.recentMergesSourceQuality).toMatchObject({
      sourceState: 'degraded',
      complete: false,
    });
  });

  it('keeps a complete empty inbox distinct from degraded evidence', async () => {
    const snap = await buildFleetActivity(baseConfig());

    expect(snap.repos).toEqual([]);
    expect(snap.recentMerges).toEqual([]);
    expect(snap.proposalSourceQuality).toMatchObject({ complete: true });
    expect(snap.recentMergesSourceQuality).toMatchObject({ complete: true });
  });
});

// ---------------------------------------------------------------------------
// Never-throws contract
// ---------------------------------------------------------------------------

describe('buildFleetActivity — never throws', () => {
  it('resolves on minimal config with no data', async () => {
    await expect(buildFleetActivity(baseConfig())).resolves.toBeDefined();
  });

  it('resolves when foundry is absent', async () => {
    const cfg: AshlrConfig = { ...baseConfig(), foundry: undefined };
    await expect(buildFleetActivity(cfg)).resolves.toBeDefined();
  });

  it('resolves when daemon.json is missing', async () => {
    // No daemon.json written — should degrade to empty ticks
    const snap = await buildFleetActivity(baseConfig());
    expect(snap.recentTicks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-repo counts from seeded inbox proposals
// ---------------------------------------------------------------------------

describe('buildFleetActivity — per-repo counts from proposals', () => {
  it('does not count forged on-disk merge evidence as landed work', async () => {
    // Seed inbox proposals via the inbox store
    const ashlrDir = join(tmpHome, '.ashlr');
    const inboxDir = join(ashlrDir, 'inbox');
    mkdirSync(inboxDir, { recursive: true });

    const now = new Date();
    const recent = (offset: number) =>
      new Date(now.getTime() - offset * 60 * 1000).toISOString();
    const realizedMerge = (observedAt: string) => ({
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40),
      observedAt,
    });
    const p1At = recent(30);
    const p2At = recent(60);

    const proposals = [
      { id: 'p1', repo: '/repo/alpha', status: 'applied',  createdAt: p1At, title: 'Fix A', kind: 'patch', origin: 'backlog', summary: 'fix a', realizedMerge: realizedMerge(p1At) },
      { id: 'p2', repo: '/repo/alpha', status: 'applied',  createdAt: p2At, title: 'Fix B', kind: 'patch', origin: 'backlog', summary: 'fix b', realizedMerge: realizedMerge(p2At) },
      { id: 'p3', repo: '/repo/alpha', status: 'pending',  createdAt: recent(10), title: 'Fix C', kind: 'patch', origin: 'backlog', summary: 'fix c' },
      { id: 'p4', repo: '/repo/beta',  status: 'rejected', createdAt: recent(20), title: 'Decline D', kind: 'patch', origin: 'backlog', summary: 'decline d' },
    ];
    for (const p of proposals) {
      writeFileSync(join(inboxDir, `${p.id}.json`), JSON.stringify(p));
    }

    const snap = await buildFleetActivity(baseConfig());

    // Find repo rows
    const alpha = snap.repos.find((r) => r.repo === '/repo/alpha');
    const beta  = snap.repos.find((r) => r.repo === '/repo/beta');

    expect(alpha).toBeDefined();
    expect(alpha!.autoMerged).toBe(0);
    expect(alpha!.pending).toBe(1);
    expect(alpha!.proposed).toBeGreaterThanOrEqual(2); // applied ones counted

    expect(beta).toBeDefined();
    expect(beta!.declined).toBe(1);

    // Totals
    expect(snap.totalAutoMerged).toBe(0);
    expect(snap.totalPending).toBeGreaterThanOrEqual(1);
    expect(snap.totalDeclined).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Worked-ledger cooldown count
// ---------------------------------------------------------------------------

describe('buildFleetActivity — cooldown count from worked ledger', () => {
  it('counts active cooldowns (recent empty outcomes)', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const fleetDir = join(ashlrDir, 'fleet');
    mkdirSync(fleetDir, { recursive: true });

    const now = new Date();
    const recentTs = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // 10m ago
    const oldTs    = new Date(now.getTime() - 8 * 60 * 60 * 1000).toISOString(); // 8h ago (past 6h window)

    const ledger = {
      events: [
        { itemId: 'item-1', outcome: 'empty', ts: recentTs },
        { itemId: 'item-2', outcome: 'empty', ts: recentTs },
        { itemId: 'item-3', outcome: 'empty', ts: oldTs },     // outside window
        { itemId: 'item-4', outcome: 'diff',  ts: recentTs },  // not 'empty'
      ],
    };
    writeFileSync(join(fleetDir, 'worked.json'), JSON.stringify(ledger, null, 2));

    const snap = await buildFleetActivity(baseConfig());
    expect(snap.cooldownCount).toBe(2); // only the two recent 'empty' outcomes
  });

  it('cooldown count is 0 when ledger is absent', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(snap.cooldownCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Daemon ticks
// ---------------------------------------------------------------------------

describe('buildFleetActivity — recent ticks', () => {
  it('surfaces ticks from daemon.json (newest-first, capped 20)', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });

    // DaemonState.ticks are stored oldest-first (most-recent last).
    // i=0 is oldest (29 min ago), i=29 is newest (0 min ago, has merged=1).
    const ticks = Array.from({ length: 30 }, (_, i) => ({
      ts: new Date(Date.now() - (29 - i) * 60_000).toISOString(),
      reason: 'ok',
      backends: { builtin: 1 },
      spentUsd: 0.001,
      merged: i === 29 ? 1 : 0, // newest tick has merged=1
      dryRun: i === 29,
      directionMode: i === 29 ? 'verify-only' : 'backlog-build',
      directionReason: i === 29 ? 'pending proposals need verification' : 'healthy resources',
	      autoMerge: i === 29 ? {
	        attempted: 3,
	        judgePerPass: 4,
	        judged: 2,
	        judgeCapped: 1,
	        verifyBeforeJudgePerPass: 3,
	        verifyBeforeJudgeRan: 2,
	        verifyBeforeJudgeCapped: 1,
	        judgeEstimatedSpendUsd: 0.0123,
	        merged: 1,
        autoArchived: 1,
        ttlRejected: 1,
      } : undefined,
      remoteHandoff: i === 29 ? {
        checked: 2,
        merged: 1,
        closed: 0,
        open: 1,
        unknown: 0,
      } : undefined,
      proposalProduction: i === 29 ? {
        selected: 1,
        claimed: 1,
        dispatched: 1,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 1,
        reasons: [{ reason: 'test route', count: 1 }],
      } : undefined,
      dispatches: i === 29 ? [{
        itemId: 'item-29',
        title: 'Trace backend assignment',
        repo: '/tmp/repo-alpha',
        source: 'todo',
        backend: 'builtin',
        tier: 'local',
        assignedBy: 'router',
        reason: 'test route',
        dispatched: true,
        spentUsd: 0.001,
      }] : undefined,
    }));
    writeFileSync(
      join(ashlrDir, 'daemon.json'),
      JSON.stringify({
        running: false, pid: null, startedAt: null,
        lastTickAt: ticks[0]!.ts, todayDate: null,
        todaySpentUsd: 0, itemsProcessed: 30, ticks,
      }),
    );

    const snap = await buildFleetActivity(baseConfig());
    expect(snap.recentTicks.length).toBe(20); // capped at 20
    // newest-first: first entry should be the tick at index 0
    expect(snap.recentTicks[0]!.merged).toBe(1);
    expect(snap.recentTicks[0]!.dryRun).toBe(true);
    expect(snap.recentTicks[0]!.directionMode).toBe('verify-only');
    expect(snap.recentTicks[0]!.directionReason).toBe('pending proposals need verification');
    expect(snap.recentTicks[0]!.autoMerge).toEqual({
	      attempted: 3,
	      judgePerPass: 4,
	      judged: 2,
	      judgeCapped: 1,
	      verifyBeforeJudgePerPass: 3,
	      verifyBeforeJudgeRan: 2,
	      verifyBeforeJudgeCapped: 1,
	      judgeEstimatedSpendUsd: 0.0123,
	      merged: 1,
      autoArchived: 1,
      ttlRejected: 1,
    });
    expect(snap.recentTicks[0]!.remoteHandoff).toEqual({
      checked: 2,
      merged: 1,
      closed: 0,
      open: 1,
      unknown: 0,
    });
    expect(snap.recentTicks[0]!.dispatches?.[0]).toMatchObject({
      itemId: 'item-29',
      backend: 'builtin',
      reason: 'test route',
      dispatched: true,
    });
    expect(snap.recentTicks[0]!.proposalProduction).toMatchObject({
      selected: 1,
      claimed: 1,
      dispatched: 1,
      proposalsCreated: 0,
      noProposalDispatches: 1,
      reasons: [{ reason: 'test route', count: 1 }],
    });
    // Each tick has required shape
    for (const t of snap.recentTicks) {
      expect(typeof t.ts).toBe('string');
      expect(typeof t.spentUsd).toBe('number');
      expect(typeof t.merged).toBe('number');
      expect(typeof t.dryRun).toBe('boolean');
      expect(typeof t.backends).toBe('object');
      expect(t.directionMode === null || typeof t.directionMode === 'string').toBe(true);
      expect(t.directionReason === null || typeof t.directionReason === 'string').toBe(true);
      expect(t.autoMerge === null || typeof t.autoMerge === 'object').toBe(true);
      expect(t.remoteHandoff === null || typeof t.remoteHandoff === 'object').toBe(true);
      expect(t.proposalProduction === null || typeof t.proposalProduction === 'object').toBe(true);
      expect(Array.isArray(t.dispatches)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Merge truth ignores audit summaries
// ---------------------------------------------------------------------------

describe('buildFleetActivity — recent merge truth', () => {
  it('does not treat merge.* audit entries as realized merges', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const auditDir = join(ashlrDir, 'audit');
    mkdirSync(auditDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const mergeEntry = {
      ts: new Date().toISOString(),
      action: 'merge.auto',
      repo: '/repo/alpha',
      sandboxId: null,
      summary: 'proposalId=p1 engine=claude result=applied',
      result: 'ok',
    };
    const otherEntry = {
      ts: new Date().toISOString(),
      action: 'sandbox.create',
      repo: '/repo/beta',
      sandboxId: 's1',
      summary: 'created sandbox',
      result: 'ok',
    };
    appendFileSync(join(auditDir, `${today}.jsonl`), JSON.stringify(mergeEntry) + '\n');
    appendFileSync(join(auditDir, `${today}.jsonl`), JSON.stringify(otherEntry) + '\n');

    const snap = await buildFleetActivity(baseConfig());
    expect(snap.recentMerges).toEqual([]);
  });

  it('recentMerges is [] when audit directory is absent', async () => {
    const snap = await buildFleetActivity(baseConfig());
    expect(snap.recentMerges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recent agent action events
// ---------------------------------------------------------------------------

describe('buildFleetActivity — recent agent action telemetry', () => {
  it('surfaces metadata-only agent action rows', async () => {
    recordAgentAction({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      machineId: 'm90',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'proposal-created',
      action: 'daemon:dispatch',
      summary: 'codex proposal-created for Useful work',
      repo: '/repo/alpha',
      itemId: 'item-a',
      source: 'goal',
      proposalId: 'prop-a',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
    });

    const snap = await buildFleetActivity(baseConfig());

    expect(snap.recentActions).toHaveLength(1);
    expect(snap.recentActions[0]).toMatchObject({
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'proposal-created',
      repo: '/repo/alpha',
      proposalId: 'prop-a',
    });
  });
});

// ---------------------------------------------------------------------------
// Readiness throttle cache
// ---------------------------------------------------------------------------

describe('buildFleetActivity — readiness throttle', () => {
  it('returns same reference within TTL window (cache hit)', async () => {
    const snap1 = await buildFleetActivity(baseConfig());
    const snap2 = await buildFleetActivity(baseConfig());
    // Both calls within 10s TTL should return same engineReadiness array reference
    expect(snap1.engineReadiness).toBe(snap2.engineReadiness);
  });

  it('resets cache on resetReadinessCache()', async () => {
    const snap1 = await buildFleetActivity(baseConfig());
    resetReadinessCache();
    const snap2 = await buildFleetActivity(baseConfig());
    // After reset, new array is returned
    expect(snap1.engineReadiness).not.toBe(snap2.engineReadiness);
  });
});

// ---------------------------------------------------------------------------
// Engine readiness shape
// ---------------------------------------------------------------------------

describe('buildFleetActivity — engineReadiness shape', () => {
  it('all readiness entries have required fields', async () => {
    const snap = await buildFleetActivity(baseConfig());
    for (const e of snap.engineReadiness) {
      expect(typeof e.engine).toBe('string');
      expect(typeof e.tier).toBe('string');
      expect(typeof e.installed).toBe('boolean');
      expect(typeof e.ready).toBe('boolean');
      expect(typeof e.detail).toBe('string');
    }
  });

  it('includes builtin engine (always ready)', async () => {
    const snap = await buildFleetActivity(baseConfig());
    const builtin = snap.engineReadiness.find((e) => e.engine === 'builtin');
    expect(builtin).toBeDefined();
    expect(builtin!.ready).toBe(true);
    expect(builtin!.installed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// subscriptionUsage shape
// ---------------------------------------------------------------------------

describe('buildFleetActivity — subscriptionUsage shape', () => {
  it('includes claude engine entry', async () => {
    const snap = await buildFleetActivity(baseConfig());
    const claude = snap.subscriptionUsage.find((e) => e.engine === 'claude');
    expect(claude).toBeDefined();
    expect(typeof claude!.hasData).toBe('boolean');
    expect(claude!.windows).toBeInstanceOf(Array);
  });
});
