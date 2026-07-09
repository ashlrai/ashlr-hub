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

import type { AshlrConfig, DaemonTick, EngineId, WorkItem } from '../src/core/types.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { buildContextEfficiencyStatus } from '../src/core/fleet/context-efficiency.js';
import { recordUse } from '../src/core/fleet/quota.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { buildAutonomyEvidencePack, persistAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../src/core/autonomy/policy.js';
import { createProposal } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { recordDispatchProduction, type DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { recordAgentAction, type AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import { recordOutcome } from '../src/core/fleet/worked-ledger.js';
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

function makeBacklogItem(
  repo: string,
  id: string,
  title: string,
  score = 5,
  source: WorkItem['source'] = 'goal',
): WorkItem {
  return {
    id,
    repo,
    source,
    title,
    detail: 'detail',
    value: 5,
    effort: 1,
    score,
    tags: ['test'],
    ts: '2026-07-03T00:00:00.000Z',
  };
}

function writeBacklogSnapshot(
  home: string,
  repo: string,
  items: WorkItem[],
  generatedAt = '2026-07-03T00:00:00.000Z',
): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
  writeFileSync(
    join(ashlrDir, 'backlog.json'),
    JSON.stringify({
      generatedAt,
      repos: [repo],
      items,
    }),
    'utf8',
  );
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

function writeRunningDaemon(home: string, ticks: DaemonTick[] = [], lastTickAt = '2026-07-03T00:05:00.000Z'): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(
    join(ashlrDir, 'daemon.json'),
    JSON.stringify({
      running: true,
      pid: process.pid,
      startedAt: '2026-07-03T00:00:00.000Z',
      lastTickAt,
      todayDate: lastTickAt.slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 1,
      ticks,
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

describe('buildFleetStatus — read-only aggregation (M49)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevAshlrHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevAshlrHome = process.env.ASHLR_HOME;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // win32 homedir()
    process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
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
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
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
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      counts: {
        backlogItems: 0,
        pendingProposals: 0,
        preflightReady: 0,
      },
    });
    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      confidence: 'low',
      topBlocker: { id: 'daemon-stopped' },
      sourceSummary: expect.objectContaining({
        blocked: expect.any(Number),
        unknown: expect.any(Number),
      }),
    });
    expect(s.autonomousShipReadiness?.sourceSummary.healthy)
      .toBeLessThan(s.autonomousShipReadiness?.sources.length ?? 0);
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
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const item = {
      id: 'repo:goal:one',
      repo,
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
        repos: [repo],
        items: [
          item,
          { ...item, id: 'repo:goal:two', title: 'Advance goal two' },
          { ...item, id: 'stale:goal:tmp', repo: '/tmp/ashlr-deleted-fixture', title: 'Stale test fixture' },
        ],
      }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(2);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.pendingItems).toBe(0);
    expect(s.queue.nextEligibleAt).toBeNull();
    expect(s.queue.repos).toEqual({
      enrolled: 1,
      existing: 1,
      withBacklog: 1,
      silent: 0,
      executionProfiles: {
        reposWithProjects: 0,
        reposWithVerifyCommands: 0,
        reposMissingVerifyCommands: 1,
        reposWithVerifyContracts: 0,
        reposWithValidVerifyContracts: 0,
        reposWithExplicitMergeContracts: 0,
        reposMissingExplicitMergeContracts: 1,
        missingVerifyCommands: [
          {
            repo,
            name: 'repo',
            projectKinds: [],
            reason: 'no recognized project manifests or ashlr.verify.json',
          },
        ],
        missingExplicitMergeContracts: [
          {
            repo,
            name: 'repo',
            projectKinds: [],
            reason: 'missing ashlr.verify.json merge-profile contract',
          },
        ],
        packageManagers: [],
      },
      byTier: [{ tier: 'inventory', repos: 1, items: 2 }],
      top: [{ repo, items: 2 }],
    });
    expect(s.queue.next).toEqual([
      {
        id: 'repo:goal:one',
        title: 'Advance goal one',
        repo,
        source: 'goal',
        score: 2,
      },
      {
        id: 'repo:goal:two',
        title: 'Advance goal two',
        repo,
        source: 'goal',
        score: 2,
      },
    ]);
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      bottleneck: 'control',
      counts: {
        backlogItems: 2,
        pendingProposals: 0,
      },
    });
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('surfaces missing verify repo names, project kinds, and reasons', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'make-repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'Makefile'), 'build:\n\t@true\n', 'utf8');
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({ generatedAt: '2026-07-03T00:00:00.000Z', repos: [repo], items: [] }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.repos?.executionProfiles).toMatchObject({
      reposWithProjects: 1,
      reposWithVerifyCommands: 0,
      reposMissingVerifyCommands: 1,
      reposWithVerifyContracts: 0,
      reposWithValidVerifyContracts: 0,
      reposWithExplicitMergeContracts: 0,
      reposMissingExplicitMergeContracts: 1,
      missingVerifyCommands: [
        {
          repo,
          name: 'make-repo',
          projectKinds: ['make'],
          reason: 'detected make project(s), but no verify command is configured',
        },
      ],
      missingExplicitMergeContracts: [
        {
          repo,
          name: 'make-repo',
          projectKinds: ['make'],
          reason: 'missing ashlr.verify.json merge-profile contract',
        },
      ],
    });
    expect(s.nextActions?.some((action) => action.detail.includes('make-repo'))).toBe(true);
    expect(s.nextActions?.some((action) => action.id === 'add-explicit-merge-verify-contracts')).toBe(true);
  });

  it('separates inferred verify commands from explicit merge-grade contracts', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const inferredRepo = join(tmpHome, 'inferred-repo');
    const contractRepo = join(tmpHome, 'contract-repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(inferredRepo, { recursive: true });
    mkdirSync(contractRepo, { recursive: true });
    writeFileSync(
      join(inferredRepo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
      'utf8',
    );
    writeFileSync(
      join(contractRepo, 'ashlr.verify.json'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'merge-test',
            kind: 'test',
            cmd: ['npm', 'run', 'test'],
            required: true,
            profiles: ['merge'],
          },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(ashlrDir, 'enrollment.json'),
      JSON.stringify({ repos: [inferredRepo, contractRepo] }),
      'utf8',
    );
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({ generatedAt: '2026-07-03T00:00:00.000Z', repos: [inferredRepo, contractRepo], items: [] }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.repos?.executionProfiles).toMatchObject({
      reposWithVerifyCommands: 2,
      reposMissingVerifyCommands: 0,
      reposWithVerifyContracts: 1,
      reposWithValidVerifyContracts: 1,
      reposWithExplicitMergeContracts: 1,
      reposMissingExplicitMergeContracts: 1,
      missingExplicitMergeContracts: [
        {
          repo: inferredRepo,
          name: 'inferred-repo',
          projectKinds: ['node'],
          reason: 'missing ashlr.verify.json merge-profile contract',
        },
      ],
    });
  });

  it('does not suggest building backlog when all visible items are cooling', async () => {
    const repo = join(tmpHome, 'repo');
    const items = [
      makeBacklogItem(repo, 'repo:goal:cooling-one', 'Cooling one', 9),
      makeBacklogItem(repo, 'repo:goal:cooling-two', 'Cooling two', 5),
    ];
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
      },
    });
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, items);
    recordOutcome('repo:goal:cooling-one', 'empty', new Date().toISOString());
    recordOutcome('repo:goal:cooling-two', 'judged-review', new Date().toISOString());

    const s = await buildFleetStatus(cfg);

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.cooldownItems).toBe(2);
    expect(s.queue.pendingItems).toBe(0);
    expect(s.queue.nextEligibleAt).toMatch(/T/);
    expect(s.queue.next).toBeUndefined();
    expect(s.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
    expect(s.nextActions?.[0]).toMatchObject({
      id: 'cooldown-gated-backlog',
      priority: 'medium',
      label: 'Review cooldown gate',
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'wait-for-backlog-eligibility',
      detail: expect.stringContaining('next eligible at'),
    }));
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'cooldown-gated',
      bottleneck: 'cooldown',
      counts: {
        backlogItems: 2,
        eligibleBacklogItems: 0,
        cooldownItems: 2,
      },
    });
    expect(s.autonomyEffectiveness?.summary).toContain('Next eligible at');
    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'degraded',
      topBlocker: {
        id: 'backlog-cooldown-gated',
        source: 'queue',
      },
      primaryAction: {
        id: 'cooldown-gated-backlog',
      },
    });
  });

  it('does not suggest building backlog when visible items already have pending proposals', async () => {
    const repo = join(tmpHome, 'repo');
    const item = makeBacklogItem(repo, 'repo:goal:pending', 'Pending proposal work', 7);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [item]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Proposal for pending queue work',
        summary: 'This pending proposal covers the queued item without repeating its id.',
        diff: docsDiff('pending'),
        workItemId: item.id,
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(1);
    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next).toBeUndefined();
    expect(s.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'wait-for-backlog-eligibility',
      detail: expect.stringContaining('0 cooling, 1 pending'),
    }));
  });

  it('keeps unrelated backlog eligible when a workItemId proposal mentions another item', async () => {
    const repo = join(tmpHome, 'repo');
    const covered = makeBacklogItem(repo, 'repo:goal:covered', 'Covered proposal work', 7);
    const mentioned = makeBacklogItem(repo, 'repo:goal:mentioned', 'Mentioned but fresh work', 6);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [covered, mentioned]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: `Proposal text mentions ${mentioned.id}`,
        summary: `Stale context mentions ${mentioned.id}, but the causal work item is different.`,
        diff: docsDiff('pending causal item'),
        workItemId: covered.id,
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({ id: mentioned.id, repo });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'build-backlog',
      detail: `Start with ${mentioned.title}`,
      target: repo,
    }));
  });

  it('keeps legacy pending proposal matching for exact item-id mentions', async () => {
    const repo = join(tmpHome, 'repo');
    const item = makeBacklogItem(repo, 'repo:goal:legacy-pending', 'Legacy pending proposal work', 7);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [item]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: `Legacy proposal for ${item.id}`,
        summary: 'Legacy proposal has no workItemId.',
        diff: docsDiff('legacy pending'),
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next).toBeUndefined();
  });

  it('builds queue.next and build-backlog from eligible items instead of higher-scored cooling items', async () => {
    const repo = join(tmpHome, 'repo');
    const cooled = makeBacklogItem(repo, 'repo:goal:cooled', 'High score but cooling', 10);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 2);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [cooled, fresh]);
    recordOutcome(cooled.id, 'empty', new Date().toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({
      id: fresh.id,
      title: fresh.title,
      repo,
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'build-backlog',
      detail: `Start with ${fresh.title}`,
      target: repo,
    }));
  });

  it('summarizes proposal starvation when the daemon is running with backlog but no proposals', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(repo, { recursive: true });
    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 2,
      proposalsCreated: 0,
      spentUsd: 0.02,
      reason: 'ok',
      proposalProduction: {
        selected: 2,
        claimed: 2,
        dispatched: 2,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 2,
        reasons: [{ reason: 'gate-blocked: completeness gate blocked proposal: typecheck failed', count: 2 }],
      },
      dispatches: [
        {
          itemId: 'repo:self-heal:one',
          title: 'Fix broken test in repo',
          repo,
          source: 'self',
          backend: 'builtin',
          tier: 'local',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0.01,
          production: {
            outcome: 'gate-blocked',
            reason: 'completeness gate blocked proposal: typecheck failed',
          },
        },
        {
          itemId: 'repo:self-heal:two',
          title: 'Add missing verify command',
          repo,
          source: 'todo',
          backend: 'builtin',
          tier: 'local',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0.01,
          production: {
            outcome: 'gate-blocked',
            reason: 'completeness gate blocked proposal: typecheck failed',
          },
        },
      ],
    };
    const staleTick: DaemonTick = {
      ts: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      itemsConsidered: 99,
      proposalsCreated: 99,
      spentUsd: 0,
      reason: 'stale',
      proposalProduction: {
        selected: 99,
        claimed: 99,
        dispatched: 99,
        skipped: 0,
        errors: 99,
        proposalsCreated: 99,
        noProposalDispatches: 99,
        reasons: [{ reason: 'stale should be ignored', count: 99 }],
      },
    };
    writeRunningDaemon(tmpHome, [staleTick, recentTick]);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-03T00:00:00.000Z',
        repos: [repo],
        items: [{
          id: 'repo:self-heal:one',
          repo,
          source: 'self',
          title: 'Fix broken test in repo',
          detail: 'detail',
          value: 5,
          effort: 1,
          score: 5,
          tags: ['self-heal'],
          ts: '2026-07-03T00:00:00.000Z',
        }],
      }),
      'utf8',
    );

    const s = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));

    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      counts: {
        backlogItems: 1,
        pendingProposals: 0,
      },
    });
    expect(s.autonomyEffectiveness?.summary).toContain('no pending proposals');
    expect(s.proposalProduction).toMatchObject({
      selected: 2,
      claimed: 2,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 2,
      topReasons: [{ reason: 'gate-blocked: completeness gate blocked proposal: typecheck failed', count: 2 }],
    });
    expect(s.proposalProduction?.recentNoProposalDispatches).toHaveLength(2);
    expect(s.proposalProduction?.recentNoProposalDispatches[0]).toMatchObject({
      productionOutcome: 'gate-blocked',
      reason: 'completeness gate blocked proposal: typecheck failed',
    });
    expect(s.autonomyEffectiveness?.summary).toContain('2 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('top reason: gate-blocked: completeness gate blocked proposal: typecheck failed');
    expect(s.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inspect-proposal-production',
          label: 'Inspect proposal production',
          detail: expect.stringContaining('typecheck failed'),
        }),
      ]),
    );
  });

  it('keeps proposal-disabled attempts out of operator production diagnosis', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 3,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
      proposalProduction: {
        selected: 3,
        claimed: 3,
        dispatched: 3,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 3,
        reasons: [
          { reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt', count: 2 },
          { reason: 'empty-diff: agent returned no diff', count: 1 },
        ],
      },
      dispatches: [
        {
          itemId: 'repo:goal:suppressed-one',
          title: 'Suppressed one',
          repo,
          source: 'goal',
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this sandboxed attempt',
          },
        },
        {
          itemId: 'repo:goal:suppressed-two',
          title: 'Suppressed two',
          repo,
          source: 'goal',
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this sandboxed attempt',
          },
        },
        {
          itemId: 'repo:goal:empty',
          title: 'Empty diff',
          repo,
          source: 'goal',
          backend: 'claude',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'empty-diff',
            reason: 'agent returned no diff',
          },
        },
      ],
    };
    writeRunningDaemon(tmpHome, [recentTick]);
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5),
    ], new Date().toISOString());

    const s = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));

    expect(s.proposalProduction).toMatchObject({
      noProposalDispatches: 3,
      suppressedDispatches: 2,
      diagnosticNoProposalDispatches: 1,
      diagnosticTopReasons: [{ reason: 'empty-diff: agent returned no diff', count: 1 }],
    });
    expect(s.proposalProduction?.topReasons[0]?.reason).toContain('proposal-disabled');
    expect(s.proposalProduction?.recentNoProposalDispatches).toHaveLength(3);
    expect(s.proposalProduction?.recentDiagnosticNoProposalDispatches).toHaveLength(1);
    expect(s.proposalProduction?.recentDiagnosticNoProposalDispatches[0]).toMatchObject({
      itemId: 'repo:goal:empty',
      reason: 'agent returned no diff',
    });
    expect(s.autonomyEffectiveness?.summary).toContain('1 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('top reason: empty-diff: agent returned no diff');
    expect(s.autonomyEffectiveness?.summary).not.toContain('proposal-disabled');
    const inspectAction = s.nextActions?.find((action) => action.id === 'inspect-proposal-production');
    expect(inspectAction?.detail).toContain('agent returned no diff');
    expect(inspectAction?.detail).not.toContain('proposal-disabled');
  });

  it('reports durable dispatch-production yield from the append-only ledger', async () => {
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-a',
      source: 'todo',
      repo: '/repo/a',
      title: 'Improve proposal yield',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', outcome: 'gate-blocked', reason: 'completeness gate blocked proposal' },
      {
        ...baseEvent,
        itemId: 'item-c',
        source: 'goal',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-c',
        reason: 'proposal filed',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      events: 3,
      attempts: 3,
      proposalsCreated: 1,
      noProposal: 2,
      proposalRate: 1 / 3,
      outcomes: {
        proposalCreated: 1,
        emptyDiff: 1,
        gateBlocked: 1,
      },
    });
    expect(s.dispatchProduction?.byBackend[0]).toMatchObject({
      backend: 'local-coder',
      attempts: 2,
      proposalsCreated: 0,
      proposalRate: 0,
    });

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Dispatch yield:');
    expect(formatted).toContain('proposals 1/3');
    expect(formatted).toContain('local-coder 0/2 0%');
    expect(formatted).toContain('codex 1/1 100%');
  });

  it('reports durable global workspace action telemetry from the append-only ledger', async () => {
    const now = new Date().toISOString();
    const repo = join(tmpHome, 'repo-a');
    const staleFixtureRepo = join(tmpHome, 'deleted-fixture');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
    writeFileSync(join(tmpHome, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo, staleFixtureRepo] }), 'utf8');
    const genomeDir = join(tmpHome, '.ashlr', 'genome');
    mkdirSync(genomeDir, { recursive: true });
    writeFileSync(
      join(genomeDir, 'hub.jsonl'),
      [
        {
          id: 'ctx-one',
          project: 'ashlr-hub',
          source: 'hub',
          title: 'Context telemetry',
          text: 'Fleet context efficiency reads workspace attention without storing raw prompts.',
          tags: ['context'],
          ts: now,
        },
        {
          id: 'ctx-two',
          project: 'phantom-secrets',
          source: 'hub',
          title: 'Phantom boundary',
          text: 'Phantom owns real keys while Hub consumes only metadata and scrubbed outputs.',
          tags: ['phantom'],
          ts: now,
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    const baseEvent: AgentActionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'daemon:dispatch',
      summary: 'local-coder empty-diff for Improve proposal yield',
      repo,
      itemId: 'item-a',
      source: 'todo',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      reason: 'agent returned no diff',
      spentUsd: 0.001,
    };
    recordAgentAction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', kind: 'tick', outcome: 'ok', action: 'daemon:tick', summary: 'tick ok', backend: null, repo: undefined },
      {
        ...baseEvent,
        itemId: 'item-c',
        outcome: 'proposal-created',
        action: 'daemon:dispatch',
        proposalId: 'prop-c',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        summary: 'codex proposal-created for Improve proposal yield',
      },
      {
        ...baseEvent,
        repo: staleFixtureRepo,
        itemId: 'item-stale',
        outcome: 'failed',
        action: 'daemon:dispatch',
        summary: 'stale fixture repo should not shape fleet workspace attention',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.workspace).toMatchObject({
      eventCount: 3,
      proposalEvents: 1,
      noProposalEvents: 1,
      activeMachines: ['m49'],
    });
    expect(s.workspace?.byAction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'dispatch', count: 2 }),
        expect.objectContaining({ key: 'tick', count: 1 }),
      ]),
    );
    expect(s.workspace?.recentActions[0]).toMatchObject({ proposalId: 'prop-c' });
    expect(s.contextEfficiency).toMatchObject({
      posture: 'watch',
      signals: {
        workspaceEvents: 3,
        activeRepos: 1,
        memoryEntries: 2,
        hubMemoryEntries: 2,
        retrievalPosture: 'available',
        reflectionEvents: 0,
        proposalRate: null,
      },
      risks: [
        expect.objectContaining({ id: 'reflection-missing', severity: 'low' }),
      ],
    });
    expect(s.contextEfficiency?.recommendations[0]).toContain('compression');

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Global workspace:');
    expect(formatted).toContain('events:    3');
    expect(formatted).toContain('proposals 1, no-proposal 1');
    expect(formatted).toContain('Context efficiency:');
    expect(formatted).toContain('posture:   watch');
    expect(formatted).toContain('memory:    2 entries');
  });

  it('does not report healthy context efficiency when genome health is unavailable', () => {
    const now = new Date().toISOString();
    const status = buildContextEfficiencyStatus(
      {
        workspace: {
          generatedAt: now,
          windowHours: 24,
          eventCount: 2,
          latestAt: now,
          activeMachines: ['m49'],
          spendUsd: 0,
          proposalEvents: 0,
          noProposalEvents: 0,
          repoEventCount: 2,
          repoDistinctCount: 1,
          topRepoCount: 2,
          attention: [],
          byAction: [{ key: 'reflection', count: 1 }],
          byOutcome: [],
          byRepo: [{ key: '/repo/a', count: 2 }],
          byBackend: [],
          entropy: { action: 0, outcome: 0, repo: 0 },
          recentActions: [],
        },
      },
      undefined,
      now,
      24 * 60 * 60 * 1000,
    );

    expect(status.posture).toBe('watch');
    expect(status.signals.retrievalPosture).toBe('unknown');
    expect(status.risks).toEqual([
      expect.objectContaining({ id: 'memory-unavailable', severity: 'medium' }),
    ]);
  });

  it('promotes degraded context efficiency into next actions', async () => {
    const now = new Date().toISOString();
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo-a');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeRunningDaemon(tmpHome, [], now);
    recordAgentAction({
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'daemon:dispatch',
      summary: 'local-coder empty-diff for Improve context',
      repo,
      itemId: 'item-a',
      source: 'todo',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      reason: 'agent returned no diff',
    });

    const s = await buildFleetStatus(baseConfig());

    expect(s.contextEfficiency).toMatchObject({
      posture: 'strained',
      risks: [
        expect.objectContaining({ id: 'memory-empty', severity: 'high' }),
        expect.objectContaining({ id: 'reflection-missing', severity: 'low' }),
      ],
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'improve-context-efficiency',
      priority: 'medium',
      label: 'Improve context efficiency',
      detail: expect.stringContaining('No hub genome memories'),
    }));
  });

  it('promotes poor durable dispatch yield into next actions', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [
          {
            id: 'repo:goal:yield',
            repo,
            source: 'goal',
            title: 'Improve low-yield dispatch',
            detail: 'Investigate repeated no-proposal outcomes.',
            value: 5,
            effort: 1,
            score: 5,
            tags: ['yield'],
            ts: new Date().toISOString(),
          },
        ],
      }),
      'utf8',
    );
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-a',
      source: 'goal',
      repo,
      title: 'Improve low-yield dispatch',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', outcome: 'gate-blocked', reason: 'completeness gate blocked proposal' },
      { ...baseEvent, itemId: 'item-c', outcome: 'engine-failed', reason: 'engine exited without diff' },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      attempts: 3,
      proposalsCreated: 0,
      proposalRate: 0,
    });
    expect(s.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inspect-dispatch-yield',
          priority: 'medium',
          label: 'Inspect dispatch yield',
          detail: expect.stringContaining('local-coder proposal yield 0/3 (0%)'),
          target: 'local-coder',
        }),
      ]),
    );
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('top reason: agent returned no diff');

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('[medium] Inspect dispatch yield [local-coder]');
    expect(formatted).toContain('local-coder proposal yield 0/3 (0%)');
  });

  it('includes queued self-heal work when the persisted backlog snapshot is stale', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const queued = {
      id: 'repo:self-heal:one',
      repo,
      source: 'self',
      title: 'Fix broken test in repo: FAIL src/repo.test.ts: expected true to be false',
      detail: 'Self-heal: test is RED.\nFirst failure: FAIL src/repo.test.ts: expected true to be false.\nInvestigate and verify the suite passes.',
      value: 5,
      effort: 1,
      score: 5,
      tags: ['self-heal', 'test'],
      ts: '2026-07-02T00:00:00.000Z',
    };
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-01T00:00:00.000Z',
        repos: ['/tmp/deleted-fixture'],
        items: [{ ...queued, id: 'stale-temp-item', repo: '/tmp/deleted-fixture' }],
      }),
      'utf8',
    );
    writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([queued]), 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(1);
    expect(s.queue.repos).toMatchObject({
      enrolled: 1,
      existing: 1,
      withBacklog: 1,
      silent: 0,
    });
    expect(s.queue.next).toEqual([
      {
        id: 'repo:self-heal:one',
        title: 'Fix broken test in repo: FAIL src/repo.test.ts: expected true to be false',
        repo,
        source: 'self',
        score: 5,
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

  it('includes resource availability for allowed local backends', async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder'] });
    const s = await buildFleetStatus(cfg);
    const builtin = s.backends.find((b) => b.backend === 'builtin')!;
    const localCoder = s.backends.find((b) => b.backend === 'local-coder')!;

    expect(builtin.resource?.availability).toBe('open');
    expect(builtin.resource?.reason).toMatch(/always available/i);
    expect(['open', 'near', 'unreachable']).toContain(localCoder.resource?.availability);
    expect(localCoder.resource?.availability).not.toBe('not-sensed');
    expect(localCoder.resource?.cap).toBe(1);
    expect(localCoder.resource?.capUnit).toBe('concurrent');
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
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      counts: {
        pendingProposals: 4,
        preflightReady: 1,
        needsVerification: 1,
        blocked: 2,
      },
    });
    const actionIds = s.nextActions?.map((a) => a.id) ?? [];
    expect(actionIds).toContain('start-daemon');
    expect(actionIds).not.toContain('drain-ready-auto-merges');
    expect(actionIds).not.toContain('verify-pending-proposals');
    expect(actionIds).not.toContain('repair-verification-failures');
  });

  it('marks running fleets with preflight-ready proposals as merge-ready', async () => {
    writeRunningDaemon(tmpHome);
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

    const s = await buildFleetStatus(cfg);

    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'merge-ready',
      canAutoMergeNow: true,
      bottleneck: 'merge-drain',
      counts: {
        pendingProposals: 1,
        preflightReady: 1,
      },
    });
  });

  it('marks autonomous ship readiness ready when fresh control, queue, and merge evidence agree', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready ship readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'ready',
      confidence: 'high',
      topBlocker: null,
      freshness: { overall: 'fresh' },
      sourceSummary: {
        healthy: 6,
        degraded: 0,
        blocked: 0,
        unavailable: 0,
        unknown: 0,
      },
    });
    expect(s.autonomousShipReadiness?.primaryAction).toMatchObject({
      id: 'drain-ready-auto-merges',
    });
  });

  it('degrades autonomous ship readiness when ready work depends on a stale source', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, []);
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready docs change with stale queue',
      diff: docsDiff('stale queue readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const s = await buildFleetStatus(cfg);
    const queueSource = s.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'degraded',
      confidence: 'medium',
      topBlocker: null,
      freshness: { overall: 'stale', staleSources: 1 },
    });
    expect(queueSource).toMatchObject({
      status: 'degraded',
      badge: 'degraded',
      freshness: 'stale',
    });
    expect(s.autonomousShipReadiness?.sourceSummary.degraded).toBeGreaterThan(0);
  });

  it('surfaces evidence trust basis in auto-merge readiness', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: ['ci/test'],
        },
      },
    });
    const diff = docsDiff('evidence');
    createSignedProposal(cfg, {
      title: 'Evidence docs change',
      diff,
      verifyResult: {
        passed: true,
        source: 'auto-merge-preflight',
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
        diffHash: hashDiff(diff),
      },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'evidence',
      pending: 1,
      preflightReady: 1,
      needsVerification: 0,
      blocked: 0,
    });
  });

  it('treats evidence-mode verification without current diff binding as needing reverify', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: ['ci/test'],
        },
      },
    });
    createSignedProposal(cfg, {
      title: 'Evidence docs change without diff binding',
      diff: docsDiff('evidence stale'),
      verifyResult: {
        passed: true,
        source: 'auto-merge-preflight',
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'evidence',
      pending: 1,
      preflightReady: 0,
      needsVerification: 1,
      blocked: 0,
    });
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
        {
          backend: 'builtin',
          dispatchesRecent: 4,
          quota: 'unlimited',
          resource: {
            availability: 'open',
            usedPct: 0,
            cap: null,
            capUnit: null,
            capWindow: null,
            resetsAt: null,
            reason: 'builtin backend is always available',
            snapshotAt: '2026-06-17T00:00:00.000Z',
          },
        },
        {
          backend: 'claude',
          dispatchesRecent: 2,
          quota: 'warn',
          resource: {
            availability: 'not-sensed',
            usedPct: null,
            cap: null,
            capUnit: null,
            capWindow: null,
            resetsAt: null,
            reason: 'no resource sensor reported this allowed backend',
            snapshotAt: null,
          },
        },
      ],
      queue: {
        backlogItems: 7,
        eligibleBacklogItems: 5,
        cooldownItems: 1,
        pendingItems: 1,
        nextEligibleAt: '2026-06-17T01:00:00.000Z',
        repos: {
          enrolled: 3,
          existing: 3,
          withBacklog: 2,
          silent: 1,
          executionProfiles: {
            reposWithProjects: 3,
            reposWithVerifyCommands: 2,
            reposMissingVerifyCommands: 1,
            reposWithVerifyContracts: 1,
            reposWithValidVerifyContracts: 1,
            reposWithExplicitMergeContracts: 1,
            reposMissingExplicitMergeContracts: 2,
            missingVerifyCommands: [
              {
                repo: '/repo/c',
                name: 'c',
                projectKinds: ['python'],
                reason: 'detected python project(s), but no verify command is configured',
              },
            ],
            missingExplicitMergeContracts: [
              {
                repo: '/repo/b',
                name: 'b',
                projectKinds: ['rust'],
                reason: 'missing ashlr.verify.json merge-profile contract',
              },
              {
                repo: '/repo/c',
                name: 'c',
                projectKinds: ['python'],
                reason: 'detected python project(s), but no verify command is configured',
              },
            ],
            packageManagers: [
              { manager: 'bun', repos: 1 },
              { manager: 'cargo', repos: 1 },
            ],
          },
          byTier: [
            { tier: 'core-fleet', repos: 1, items: 5 },
            { tier: 'supporting', repos: 1, items: 2 },
          ],
          top: [
            { repo: '/repo/a', items: 5 },
            { repo: '/repo/b', items: 2 },
          ],
        },
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
      proposalProduction: {
        windowHours: 24,
        selected: 5,
        claimed: 4,
        dispatched: 3,
        skipped: 1,
        errors: 1,
        proposalsCreated: 2,
        noProposalDispatches: 1,
        suppressedDispatches: 0,
        diagnosticNoProposalDispatches: 1,
        topReasons: [
          { reason: 'agent returned no diff', count: 2 },
          { reason: 'tool timeout', count: 1 },
        ],
        diagnosticTopReasons: [
          { reason: 'agent returned no diff', count: 2 },
          { reason: 'tool timeout', count: 1 },
        ],
        recentNoProposalDispatches: [
          {
            ts: '2026-06-17T00:03:00.000Z',
            itemId: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            backend: 'builtin',
            reason: 'agent returned no diff',
          },
        ],
        recentDiagnosticNoProposalDispatches: [
          {
            ts: '2026-06-17T00:03:00.000Z',
            itemId: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            backend: 'builtin',
            reason: 'agent returned no diff',
          },
        ],
      },
      dispatchProduction: {
        windowHours: 24,
        attempts: 3,
        events: 3,
        proposalsCreated: 1,
        noProposal: 2,
        proposalRate: 1 / 3,
        spentUsd: 0.003,
        outcomes: {
          proposalCreated: 1,
          emptyDiff: 1,
          gateBlocked: 1,
          engineFailed: 0,
          sandboxFailed: 0,
          proposalCaptureError: 0,
          proposalDisabled: 0,
          unknown: 0,
        },
        topReasons: [
          { reason: 'agent returned no diff', count: 2 },
        ],
        byBackend: [
          {
            key: 'local-coder',
            backend: 'local-coder',
            attempts: 2,
            proposalsCreated: 0,
            noProposal: 2,
            proposalRate: 0,
            spentUsd: 0.002,
            outcomes: {
              proposalCreated: 0,
              emptyDiff: 1,
              gateBlocked: 1,
              engineFailed: 0,
              sandboxFailed: 0,
              proposalCaptureError: 0,
              proposalDisabled: 0,
              unknown: 0,
            },
            topReasons: [{ reason: 'agent returned no diff', count: 2 }],
          },
          {
            key: 'codex',
            backend: 'codex',
            attempts: 1,
            proposalsCreated: 1,
            noProposal: 0,
            proposalRate: 1,
            spentUsd: 0.001,
            outcomes: {
              proposalCreated: 1,
              emptyDiff: 0,
              gateBlocked: 0,
              engineFailed: 0,
              sandboxFailed: 0,
              proposalCaptureError: 0,
              proposalDisabled: 0,
              unknown: 0,
            },
            topReasons: [{ reason: 'proposal filed', count: 1 }],
          },
        ],
        bySource: [],
        byRepo: [],
        byBackendModel: [],
      },
      merges: { recent: 2 },
      nextActions: [
        {
          id: 'drain-ready-auto-merges',
          priority: 'high',
          label: 'Drain ready auto-merges',
          detail: '1 pending proposal has cheap preflight-ready evidence.',
        },
        {
          id: 'build-backlog',
          priority: 'medium',
          label: 'Build backlog proposals',
          detail: 'Start with Ship autonomy debugger',
          target: '/repo/a',
        },
      ],
      autonomyEffectiveness: {
        phase: 'merge-ready',
        canAutoMergeNow: true,
        bottleneck: 'merge-drain',
        summary: '1 proposal is preflight-ready for the auto-merge drain.',
        counts: {
          backlogItems: 7,
          pendingProposals: 3,
          frontierPending: 1,
          awaitingHostMerge: 0,
          preflightReady: 1,
          needsVerification: 1,
          blocked: 2,
          knownVerificationFailed: 1,
          recentMerges: 2,
        },
      },
      autonomousShipReadiness: {
        verdict: 'ready',
        confidence: 'high',
        freshness: {
          generatedAt: '2026-06-17T00:02:00.000Z',
          overall: 'fresh',
          freshestAt: '2026-06-17T00:02:00.000Z',
          stalestAt: '2026-06-17T00:00:00.000Z',
          maxAgeMs: 120_000,
          staleSources: 0,
          unknownSources: 0,
        },
        topBlocker: null,
        primaryAction: {
          id: 'drain-ready-auto-merges',
          priority: 'high',
          label: 'Drain ready auto-merges',
          detail: '1 pending proposal has cheap preflight-ready evidence.',
        },
        sources: [
          {
            id: 'daemon',
            label: 'Daemon',
            status: 'healthy',
            badge: 'healthy',
            freshness: 'fresh',
            observedAt: '2026-06-17T00:00:00.000Z',
            ageMs: 120_000,
            detail: 'daemon running',
          },
          {
            id: 'auto-merge',
            label: 'Auto-Merge Gate',
            status: 'healthy',
            badge: 'healthy',
            freshness: 'fresh',
            observedAt: '2026-06-17T00:02:00.000Z',
            ageMs: 0,
            detail: '1 ready',
          },
        ],
        sourceSummary: {
          healthy: 2,
          degraded: 0,
          blocked: 0,
          unavailable: 0,
          unknown: 0,
        },
      },
      autonomy: {
        evidencePacks: 3,
        latestAt: '2026-06-17T00:01:00.000Z',
        allowed: 2,
        denied: 1,
        byTier: { T4: 2, T0: 1 },
        recent: [],
      },
      autonomyControlMode: 'executable',
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
        verifierContracts: {
          pendingNeedingVerification: 1,
          withoutVerifyCommands: 1,
          withoutExplicitMergeContract: 1,
          recentGaps: [
            {
              proposalId: 'prop-verify',
              title: 'Needs verification',
              repo: '/repo/c',
              name: 'c',
              withoutVerifyCommands: true,
              withoutExplicitMergeContract: true,
              reason: 'detected python project(s), but no verify command is configured',
            },
          ],
        },
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
        productionVelocity: {
          enabled: false,
          profile: 'off',
          fillQueueToSlots: false,
          stalePendingTtlHours: Number.POSITIVE_INFINITY,
          maxSlotsPerBackend: 3,
          caps: { localMaxConcurrent: null, nimMaxConcurrent: null, kimiMaxConcurrent: null },
          flags: { gateway: false, resourceAware: false, concurrentDispatch: false, workhorseDispatch: false },
        },
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
    expect(out).toContain('resource=open used=0%');
    expect(out).toContain('reason=builtin backend is always available');
    expect(out).toContain('resource=not-sensed');
    expect(out).toContain('7 backlog item(s)');
    expect(out).toContain('eligibility:   5 eligible, 1 cooling, 1 pending');
    expect(out).toContain('next eligible: 2026-06-17T01:00:00.000Z');
    expect(out).toContain('repos:         2/3 active (3 enrolled, 1 silent)');
    expect(out).toContain('top repos:     a:5, b:2');
    expect(out).toContain('focus tiers:   core-fleet:1r/5i, supporting:1r/2i');
    expect(out).toContain('verify roots:   2/3 repos (1 missing; bun:1, cargo:1)');
    expect(out).toContain('merge verify:   1/3 explicit (2 missing)');
    expect(out).toContain('missing verify: c [python: detected python project(s), but no verify command is configured]');
    expect(out).toContain('missing merge:  b: missing ashlr.verify.json merge-profile contract; c: detected python project(s), but no verify command is configured');
    expect(out).toContain('next:          Ship autonomy debugger (goal, score 5)');
    expect(out).toContain('shared:        ok / 2 active / 1 owned / 1 reclaimable / 2 cooling / stale lock');
    expect(out).toContain('machine-A:1');
    expect(out).toContain('machine-B:1(+1 reclaimable)');
    expect(out).toContain('frontier pending:  1');
    expect(out).toContain('applied:           5');
    expect(out).toContain('Proposal production:');
    expect(out).toContain('window:    24h');
    expect(out).toContain('queue:     selected 5, claimed 4, dispatched 3, skipped 1');
    expect(out).toContain('output:    proposals 2, no-proposal 1, suppressed 0, errors 1');
    expect(out).toContain('2x agent returned no diff');
    expect(out).toContain('recent:    builtin a Ship autonomy debugger (agent returned no diff)');
    expect(out).toContain('Dispatch yield:');
    expect(out).toContain('output:    proposals 1/3 (33%), no-proposal 2');
    expect(out).toContain('backends:  local-coder 0/2 0%; codex 1/1 100%');
    expect(out).toContain('2 auto-merge(s)');
    expect(out).toContain('Next actions:');
    expect(out).toContain('[high] Drain ready auto-merges');
    expect(out).toContain('[medium] Build backlog proposals [a]: Start with Ship autonomy debugger');
    expect(out).toContain('Autonomy effectiveness:');
    expect(out).toContain('phase:      merge-ready');
    expect(out).toContain('bottleneck: merge-drain');
    expect(out).toContain('merge now:  yes');
    expect(out).toContain('counts:     backlog 7, pending 3, ready 1, verify 1, blocked 2, host 0');
    expect(out).toContain('Autonomous ship readiness:');
    expect(out).toContain('verdict:    ready (high confidence, fresh sources)');
    expect(out).toContain('top block:  none');
    expect(out).toContain('action:     Drain ready auto-merges: 1 pending proposal has cheap preflight-ready evidence.');
    expect(out).toContain('sources:    daemon:healthy, auto-merge:healthy');
    expect(out).toContain('Autonomy evidence:');
    expect(out).toContain('packs:     3');
    expect(out).toContain('denied:    1');
    expect(out).toContain('T4:2');
    expect(out).toContain('Auto-merge readiness:');
    expect(out).toContain('enabled:   yes');
    expect(out).toContain('trust:     verification');
    expect(out).toContain('pending:   4 (preflight 1, verify 1, blocked 2)');
    expect(out).toContain('failed:    1 known verification failure(s)');
    expect(out).toContain('verifiers: 1 need verification (1 no commands, 1 no merge contract)');
    expect(out).toContain('verifier gaps: c: detected python project(s), but no verify command is configured');
    expect(out).toContain('1x known verification failure: npm test');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('control:    executable');
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
    expect(out).toContain('Proposal production:');
    expect(out).toContain('unavailable');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('unavailable');
  });
});
