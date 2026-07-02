/**
 * m49.fleet-status.test.ts — M49: fleet control plane + observability.
 *
 * Units under test:
 *   1. buildFleetStatus (src/core/fleet/status.ts) — READ-ONLY aggregation that
 *      NEVER throws. HOME is relocated to a fresh tmp dir per test so the whole
 *      ~/.ashlr surface (daemon state, quota ledger, backlog, inbox, kill
 *      switch) is isolated; restored afterward.
 *   2. formatFleetStatus (src/cli/fleet.ts) — the pure no-color formatter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId } from '../src/core/types.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { recordUse } from '../src/core/fleet/quota.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { buildAutonomyEvidencePack, persistAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../src/core/autonomy/policy.js';
import { createProposal } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config helpers
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
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

function makeEvidencePack(id: string, generatedAt: string) {
  const proposal: Proposal = {
    id,
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'summary',
    diff: [
      'diff --git a/docs/fleet.md b/docs/fleet.md',
      '--- /dev/null',
      '+++ b/docs/fleet.md',
      '@@ -0,0 +1 @@',
      '+fleet',
      '',
    ].join('\n'),
    diffHash: `sha256:${id}`,
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: generatedAt,
  };
  const pack = buildAutonomyEvidencePack({
    proposal,
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: true,
    riskClass: 'low',
    authority: { ok: true, detail: 'authority ok' },
    provenance: { ok: true, detail: 'provenance ok' },
    verification: { passed: true, detail: 'verify ok', commandKinds: ['test'] },
    risk: { ok: true, detail: 'risk ok' },
    scope: { ok: true, detail: 'scope ok' },
  });
  pack.generatedAt = generatedAt;
  pack.policy = evaluateAutonomyPolicy(pack, baseConfig());
  return pack;
}

function docsDiff(body: string): string {
  return [
    'diff --git a/docs/fleet.md b/docs/fleet.md',
    '--- /dev/null',
    '+++ b/docs/fleet.md',
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
}

function createSignedProposal(
  cfg: AshlrConfig,
  opts: {
    title: string;
    diff: string;
    verifyResult?: Proposal['verifyResult'];
    engineTier?: Proposal['engineTier'];
    engineModel?: string;
  },
): Proposal {
  const engineModel = opts.engineModel ?? 'codex:gpt-5.5';
  const engineTier = opts.engineTier ?? 'frontier';
  const diffHash = hashDiff(opts.diff);
  return createProposal(
    {
      repo: '/tmp/repo',
      origin: 'agent',
      kind: 'patch',
      title: opts.title,
      summary: opts.title,
      diff: opts.diff,
      diffHash,
      engineModel,
      engineTier,
      provenanceSig: signProvenance(engineModel, engineTier, diffHash),
      ...(opts.verifyResult ? { verifyResult: opts.verifyResult } : {}),
    },
    cfg,
  );
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

describe('buildFleetStatus — read-only aggregation (M49)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // win32 homedir()
  });

  afterEach(() => {
    // Always clear the kill switch we may have set (it lives under tmpHome, but
    // be explicit so a stray sentinel never leaks between tests).
    try {
      setKill(false);
    } catch {
      // best-effort
    }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns the full shape with sane fallbacks on an empty ~/.ashlr', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);

    // Shape
    expect(typeof s.generatedAt).toBe('string');
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.daemon).toBeDefined();
    expect(s.backends).toBeInstanceOf(Array);
    expect(s.queue).toBeDefined();
    expect(s.proposals).toBeDefined();
    expect(s.merges).toBeDefined();

    // Fallbacks on a pristine HOME
    expect(s.killed).toBe(false);
    expect(s.daemon.running).toBe(false);
    expect(s.daemon.lastTickAt).toBeNull();
    expect(s.daemon.todaySpentUsd).toBe(0);
    expect(s.queue.backlogItems).toBe(0);
    expect(s.queue.next).toBeUndefined();
    expect(s.queue.shared).toBeUndefined();
    expect(s.proposals.pending).toBe(0);
    expect(s.proposals.frontierPending).toBe(0);
    expect(s.proposals.applied).toBe(0);
    expect(s.merges.recent).toBe(0);
    expect(s.autonomy).toMatchObject({
      evidencePacks: 0,
      latestAt: null,
      allowed: 0,
      denied: 0,
    });
    expect(s.autonomyDirection).toMatchObject({
      confidence: expect.any(String),
      resources: {
        posture: expect.any(String),
        constrained: expect.any(Number),
        depleted: expect.any(Number),
      },
      guardHealth: {
        blocked: expect.any(Boolean),
        blocks: expect.any(Number),
      },
      budgets: {
        daemonBudgetLevel: expect.any(String),
        daemonSpentTodayUsd: 0,
      },
    });
    expect(['pause', 'local-only', 'verify-only', 'backlog-build', 'auto-merge-ready']).toContain(
      s.autonomyDirection?.mode,
    );
  });

  it('does not refresh, persist, or audit backlog while building a status snapshot', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);

    expect(s.queue.backlogItems).toBe(0);
    expect(existsSync(join(tmpHome, '.ashlr', 'backlog.json'))).toBe(false);
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('reports backlog count from the last persisted backlog snapshot only', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const item = {
      id: 'repo:goal:one',
      repo: '/tmp/repo',
      source: 'goal',
      title: 'Advance goal one',
      detail: 'detail',
      value: 4,
      effort: 2,
      score: 2,
      tags: ['goal'],
      ts: '2026-07-01T00:00:00.000Z',
    };
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-01T00:00:00.000Z',
        repos: ['/tmp/repo'],
        items: [item, { ...item, id: 'repo:goal:two', title: 'Advance goal two' }],
      }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.next).toEqual([
      {
        id: 'repo:goal:one',
        title: 'Advance goal one',
        repo: '/tmp/repo',
        source: 'goal',
        score: 2,
      },
      {
        id: 'repo:goal:two',
        title: 'Advance goal two',
        repo: '/tmp/repo',
        source: 'goal',
        score: 2,
      },
    ]);
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('reflects allowedBackends — defaults to [builtin] when no foundry', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);
    expect(s.backends.map((b) => b.backend)).toEqual(['builtin']);
    const builtin = s.backends.find((b) => b.backend === 'builtin')!;
    expect(builtin.dispatchesRecent).toBe(0);
    // No limit configured => unlimited.
    expect(builtin.quota).toBe('unlimited');
  });

  it("includes 'claude' with quota 'unlimited' when allowed but no limit set", async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const s = await buildFleetStatus(cfg);
    const names = s.backends.map((b) => b.backend);
    expect(names).toContain('claude');
    const claude = s.backends.find((b) => b.backend === 'claude')!;
    expect(claude.quota).toBe('unlimited');
    expect(claude.dispatchesRecent).toBe(0);
  });

  it('dispatchesRecent reflects recorded quota uses', async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({ allowedBackends: [backend] });

    recordUse(backend);
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(3);
  });

  it("evaluates quota status when a limit is configured", async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({
      allowedBackends: [backend],
      limits: { [backend]: { window: '1d', max: 2 } },
    });

    // 2 uses against a max of 2 => at/over the cap => 'over'.
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(2);
    expect(claude.quota).toBe('over');
  });

  it('reports killed:true when the kill switch is set', async () => {
    setKill(true);
    const s = await buildFleetStatus(baseConfig());
    expect(s.killed).toBe(true);
  });

  it('includes shared queue health when filesystem coordination is enabled', async () => {
    const sharedPath = join(tmpHome, 'shared-queue');
    const store = new SharedStore(sharedPath, 20_000);
    expect(store.claimItems(['owned', 'other'], 1, 'machine-A')).toEqual(['owned']);
    expect(store.claimItems(['other'], 1, 'machine-B')).toEqual(['other']);

    const cfg: AshlrConfig = {
      ...baseConfig(),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'machine-A',
          leaseMs: 20_000,
        },
      },
    };

    const s = await buildFleetStatus(cfg);
    expect(s.queue.shared).toMatchObject({
      enabled: true,
      mode: 'filesystem',
      path: sharedPath,
      machineId: 'machine-A',
      leaseMs: 20_000,
      readable: true,
      activeClaims: 2,
      ownedClaims: 1,
      reclaimableClaims: 0,
    });
    expect(s.queue.shared?.claimsByMachine).toEqual([
      { machineId: 'machine-A', active: 1, expired: 0 },
      { machineId: 'machine-B', active: 1, expired: 0 },
    ]);
  });

  it('includes autonomy evidence summary when packs exist', async () => {
    expect(persistAutonomyEvidencePack(makeEvidencePack('prop-old', '2026-07-01T00:00:00.000Z'))).toBe(true);
    expect(persistAutonomyEvidencePack(makeEvidencePack('prop-new', '2026-07-02T00:00:00.000Z'))).toBe(true);

    const s = await buildFleetStatus(baseConfig());
    expect(s.autonomy).toMatchObject({
      evidencePacks: 2,
      latestAt: '2026-07-02T00:00:00.000Z',
      allowed: 2,
      denied: 0,
    });
    expect(s.autonomy?.byTier).toMatchObject({ T4: 2 });
    expect(s.autonomy?.recent[0]).toMatchObject({
      proposalId: 'prop-new',
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      changedFiles: 1,
      changedLines: 1,
    });
  });

  it('includes read-only auto-merge readiness for pending proposals', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });

    createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready'),
      verifyResult: { passed: true, source: 'manual' },
    });
    createSignedProposal(cfg, {
      title: 'Needs verify docs change',
      diff: docsDiff('needs verify'),
    });
    createSignedProposal(cfg, {
      title: 'Failed verify docs change',
      diff: docsDiff('failed verify'),
      verifyResult: { passed: false, failed: ['npm test'], source: 'auto-merge-preflight' },
    });
    createProposal(
      {
        repo: '/tmp/repo',
        origin: 'agent',
        kind: 'patch',
        title: 'Unsigned docs change',
        summary: 'missing provenance',
        diff: docsDiff('unsigned'),
        engineModel: 'codex:gpt-5.5',
        engineTier: 'frontier',
      },
      cfg,
    );

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'verification',
      pending: 4,
      preflightReady: 1,
      needsVerification: 1,
      knownVerificationFailed: 1,
      blocked: 2,
    });
    expect(s.autoMergeReadiness?.byReason).toMatchObject({
      'known verification failure: npm test': 1,
      'provenance check failed: missing diffHash': 1,
    });
    expect(s.autoMergeReadiness?.recentBlockers.map((b) => b.title)).toEqual([
      'Unsigned docs change',
      'Failed verify docs change',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------

describe('formatFleetStatus — pure formatter (M49)', () => {
  it('renders all sections and flags the paused banner when killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: true, lastTickAt: '2026-06-17T00:00:00.000Z', todaySpentUsd: 1.2345 },
      backends: [
        { backend: 'builtin', dispatchesRecent: 4, quota: 'unlimited' },
        { backend: 'claude', dispatchesRecent: 2, quota: 'warn' },
      ],
      queue: {
        backlogItems: 7,
        next: [
          {
            id: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            score: 5,
          },
        ],
        shared: {
          enabled: true,
          mode: 'filesystem',
          path: '/shared',
          machineId: 'machine-A',
          leaseMs: 300_000,
          readable: true,
          activeClaims: 2,
          ownedClaims: 1,
          expiredClaims: 1,
          reclaimableClaims: 1,
          claimsByMachine: [
            { machineId: 'machine-A', active: 1, expired: 0 },
            { machineId: 'machine-B', active: 1, expired: 1 },
          ],
          nextLeaseExpiryAt: '2026-06-17T00:05:00.000Z',
          oldestExpiredMs: 1_000,
          workedEvents: 4,
          cooldownItems: 2,
          usageEntries: 1,
          lock: { present: true, ageMs: 900_000, stale: true },
        },
      },
      proposals: { pending: 3, frontierPending: 1, applied: 5 },
      merges: { recent: 2 },
      autonomy: {
        evidencePacks: 3,
        latestAt: '2026-06-17T00:01:00.000Z',
        allowed: 2,
        denied: 1,
        byTier: { T4: 2, T0: 1 },
        recent: [],
      },
      autoMergeReadiness: {
        enabled: true,
        trustBasis: 'verification',
        pending: 4,
        preflightReady: 1,
        needsVerification: 1,
        knownVerificationFailed: 1,
        blocked: 2,
        byReason: {
          'known verification failure: npm test': 1,
          'provenance check failed: missing diffHash': 1,
        },
        recentBlockers: [],
      },
      autonomyDirection: {
        generatedAt: '2026-06-17T00:02:00.000Z',
        mode: 'local-only',
        confidence: 'medium',
        reasons: ['cloud/frontier resources are constrained while local capacity is available'],
        recommendedActions: ['prefer local or builtin engines for new work'],
        resources: { posture: 'constrained', constrained: 1, depleted: 0 },
        guardHealth: { blocked: false, blocks: 0 },
        budgets: { daemonBudgetLevel: 'near', daemonSpentTodayUsd: 1.2345 },
      },
      killed: true,
    });

    expect(out).toContain('Fleet status');
    expect(out).toContain('[PAUSED');
    expect(out).toContain('Daemon:');
    expect(out).toContain('running');
    expect(out).toContain('$1.2345');
    expect(out).toContain('builtin');
    expect(out).toContain('claude');
    expect(out).toContain('quota=warn');
    expect(out).toContain('7 backlog item(s)');
    expect(out).toContain('next:          Ship autonomy debugger (goal, score 5)');
    expect(out).toContain('shared:        ok / 2 active / 1 owned / 1 reclaimable / 2 cooling / stale lock');
    expect(out).toContain('machine-A:1');
    expect(out).toContain('machine-B:1(+1 reclaimable)');
    expect(out).toContain('frontier pending:  1');
    expect(out).toContain('applied:           5');
    expect(out).toContain('2 auto-merge(s)');
    expect(out).toContain('Autonomy evidence:');
    expect(out).toContain('packs:     3');
    expect(out).toContain('denied:    1');
    expect(out).toContain('T4:2');
    expect(out).toContain('Auto-merge readiness:');
    expect(out).toContain('enabled:   yes');
    expect(out).toContain('trust:     verification');
    expect(out).toContain('pending:   4 (preflight 1, verify 1, blocked 2)');
    expect(out).toContain('failed:    1 known verification failure(s)');
    expect(out).toContain('1x known verification failure: npm test');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('mode:       local-only');
    expect(out).toContain('confidence: medium');
    expect(out).toContain('resources:  constrained (1 constrained, 0 depleted)');
    expect(out).toContain('budget:     near');
  });

  it('omits the paused banner when not killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });
    expect(out).not.toContain('[PAUSED');
    expect(out).toContain('(none)');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('unavailable');
  });
});
