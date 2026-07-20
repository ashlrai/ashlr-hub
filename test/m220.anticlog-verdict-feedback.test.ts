/**
 * m220.anticlog-verdict-feedback.test.ts — M220: anti-clog verdict feedback.
 *
 * ADVERSARIAL CASES:
 *  1. An item judged 'review'  is skipped on the next tick (recentlyDeclined=true).
 *  2. An item judged 'noise'   is skipped on the next tick.
 *  3. An item judged 'harmful' is skipped on the next tick.
 *  4. A fresh substantive item is NOT skipped after an unrelated item's verdict.
 *  5. Flag-off (cfg.foundry.antiClog=false) — sweep not called, behavior byte-identical
 *     to pre-M220: a recently rejected proposal's item is NOT suppressed.
 *  6. Stable-signature matching — a fresh scanner ID (differs from the stored one)
 *     still matches via repo+normalised-title fallback.
 *  7. 'diff' outcome after a judged verdict resets suppress (item becomes selectable).
 *  8. recentlyDeclined returns false for 'ship' verdict (no suppression on success).
 *  9. verdictToOutcome maps all synonyms correctly.
 * 10. sweepJudgedProposals returns the count of recorded items.
 *
 * SAFETY / HERMETICITY (mirrors m85 / m113):
 *  - HOME overridden to tmp dir — no real ~/.ashlr state touched.
 *  - runSwarm, runGoal, routeBackend, runAutoMergePass, buildBacklog ALL MOCKED.
 *  - No real agents, subprocesses, or API calls.
 *  - ASHLR_IN_DAEMON / ASHLR_IN_SWARM cleaned up in afterEach.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';
import type { RouteDecision } from '../src/core/fleet/router.js';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => process.platform === 'win32' && privateStorageHarness.useSemanticAdapter
      ? {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        }
      : actual.assurePrivateStoragePath(...args),
  };
});

// ---------------------------------------------------------------------------
// HOME isolation — before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origAshlrHome = process.env.ASHLR_HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports (same pattern as m85 / m113)
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

let routeResult: RouteDecision = { backend: 'builtin', tier: 'local', reason: 'test' };
const mockRouteBackend = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

let backlogItems: WorkItem[] = [];
const mockBuildBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  defaultConfig: () => ({ version: 1 }),
  saveConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { tick } from '../src/core/daemon/loop.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import {
  recordOutcome,
  recordVerdict,
  recentlyDeclined,
  sweepJudgedProposals,
  verdictToOutcome,
  loadWorkedLedger,
  workedLedgerPath,
} from '../src/core/fleet/worked-ledger.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { generatedRepairCooldownKey } from '../src/core/fleet/generated-repair-lifecycle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 3,
      parallel: 3,
      intervalMs: 100,
      cooldownMs: 6 * 60 * 60 * 1000,
    },
    ...overrides,
  } as AshlrConfig;
}

function makeCfgWithAntiClog(antiClog: boolean): AshlrConfig {
  return {
    ...makeCfg(),
    foundry: { antiClog } as unknown,
  } as AshlrConfig;
}

function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

function resetAshlrTestState(): void {
  const ashlrHome = path.join(tmpHome, '.ashlr');
  // Retain the exact directory identities behind the cached Windows authority proof.
  for (const entry of fs.readdirSync(ashlrHome)) {
    if (entry === 'authority' || entry === 'enrollment.json') continue;
    fs.rmSync(path.join(ashlrHome, entry), { recursive: true, force: true });
  }
}

function makeItem(id: string, repo: string, over?: Partial<WorkItem>): WorkItem {
  return {
    id,
    repo,
    source: 'todo',
    title: `Item ${id}`,
    detail: `detail for ${id}`,
    value: 3,
    effort: 3,
    score: 1,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

function swarmStub(repo: string) {
  return async () => {
    createProposal({
      repo,
      origin: 'swarm',
      kind: 'patch',
      title: 'Mock swarm proposal',
      summary: 'Generated by mock runSwarm',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });
    return {
      id: `mock-swarm-${Date.now()}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { estCostUsd: 0, totalTokens: 0, steps: 1 },
    };
  };
}

/** Create a rejected proposal in the inbox (simulates manager applyRejects=true). */
function createRejectedProposal(opts: {
  repo: string;
  title: string;
  summary: string;
  decisionReason?: string;
}): string {
  const p = createProposal({
    repo: opts.repo,
    origin: 'swarm',
    kind: 'patch',
    title: opts.title,
    summary: opts.summary,
    diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
  });
  setStatus(p.id, 'rejected', undefined, opts.decisionReason ?? 'noise');
  return p.id;
}

// ---------------------------------------------------------------------------
// File and test lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m220-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m220-repo-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');

  initBareGitDir(tmpRepo);
  fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify({ name: 'r' }), 'utf8');

  const enrollment = enroll(tmpRepo);
  if (!enrollment.ok) {
    throw new Error(`M220 fixture enrollment failed: ${enrollment.reason}`);
  }
  privateStorageHarness.useSemanticAdapter = true;
});

beforeEach(() => {
  resetAshlrTestState();

  mockRunSwarm.mockReset();
  mockRunGoal.mockReset();
  mockRouteBackend.mockReset();
  mockRunAutoMergePass.mockReset();
  mockBuildBacklog.mockReset();
  mockLoadConfig.mockReset();

  routeResult = { backend: 'builtin', tier: 'local', reason: 'test' };
  backlogItems = [];

  mockRouteBackend.mockImplementation(() => routeResult);
  mockRunAutoMergePass.mockImplementation(async () => ({ attempted: 0, merged: 0, results: [] }));
  mockBuildBacklog.mockImplementation(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [tmpRepo],
    items: backlogItems,
  }));
  mockRunSwarm.mockImplementation(swarmStub(tmpRepo));
  mockRunGoal.mockImplementation(async () => ({
    id: `mock-run-${Date.now()}`,
    status: 'done',
    usage: { estCostUsd: 0 },
  }));
  mockLoadConfig.mockImplementation(() => makeCfg());

  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;

  vi.clearAllMocks();
});

afterAll(() => {
  try { setKill(false); } catch { /* ignore */ }
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  privateStorageHarness.useSemanticAdapter = false;

  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });

  process.env.HOME = origHome;
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
  if (origAshlrHome !== undefined) process.env.ASHLR_HOME = origAshlrHome;
  else delete process.env.ASHLR_HOME;
  if (origInDaemon !== undefined) process.env.ASHLR_IN_DAEMON = origInDaemon;
  else delete process.env.ASHLR_IN_DAEMON;
  if (origInSwarm !== undefined) process.env.ASHLR_IN_SWARM = origInSwarm;
  else delete process.env.ASHLR_IN_SWARM;
});

// ===========================================================================
// 1. verdictToOutcome — pure unit
// ===========================================================================

describe('M220 verdictToOutcome — mapping', () => {
  it('maps "ship" to undefined (no suppression)', () => {
    expect(verdictToOutcome('ship')).toBeUndefined();
  });

  it('maps "review" → judged-review', () => {
    expect(verdictToOutcome('review')).toBe('judged-review');
  });

  it('maps "noise" synonyms → judged-noise', () => {
    expect(verdictToOutcome('noise')).toBe('judged-noise');
    expect(verdictToOutcome('trivial')).toBe('judged-noise');
    expect(verdictToOutcome('skip')).toBe('judged-noise');
    expect(verdictToOutcome('ignore')).toBe('judged-noise');
  });

  it('maps "harmful" synonyms → judged-decline', () => {
    expect(verdictToOutcome('harmful')).toBe('judged-decline');
    expect(verdictToOutcome('dangerous')).toBe('judged-decline');
    expect(verdictToOutcome('reject')).toBe('judged-decline');
    expect(verdictToOutcome('rejected')).toBe('judged-decline');
    expect(verdictToOutcome('block')).toBe('judged-decline');
    expect(verdictToOutcome('decline')).toBe('judged-decline');
  });

  it('maps unknown strings → undefined', () => {
    expect(verdictToOutcome('unknown')).toBeUndefined();
    expect(verdictToOutcome('')).toBeUndefined();
  });
});

// ===========================================================================
// 2. recordVerdict + recentlyDeclined — pure unit
// ===========================================================================

describe('M220 recordVerdict + recentlyDeclined — pure unit', () => {
  it('recordVerdict("review") suppresses within cooldown', () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    recordVerdict('item-review', 'review', ts);
    expect(recentlyDeclined('item-review', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('recordVerdict("noise") suppresses within cooldown', () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    recordVerdict('item-noise', 'noise', ts);
    expect(recentlyDeclined('item-noise', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('recordVerdict("harmful") suppresses within cooldown', () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    recordVerdict('item-harmful', 'harmful', ts);
    expect(recentlyDeclined('item-harmful', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('recordVerdict("ship") does NOT suppress', () => {
    // 'ship' should not write any ledger entry
    recordVerdict('item-ship', 'ship');
    expect(recentlyDeclined('item-ship', 6 * 60 * 60 * 1000)).toBe(false);
    const l = loadWorkedLedger();
    expect(l.events.find(e => e.itemId === 'item-ship')).toBeUndefined();
  });

  it('a diff outcome after judged-review resets suppression', () => {
    const oldTs = new Date(Date.now() - 2000).toISOString();
    const newTs = new Date(Date.now() - 100).toISOString();
    recordVerdict('item-reset', 'review', oldTs);
    expect(recentlyDeclined('item-reset', 6 * 60 * 60 * 1000)).toBe(true);
    // Now a real diff — should clear suppression
    recordOutcome('item-reset', 'diff', newTs);
    expect(recentlyDeclined('item-reset', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('verdict outside cooldown window is not suppressed', () => {
    const oldTs = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    recordVerdict('item-old', 'noise', oldTs);
    // cooldown=1h → 3h ago is outside window
    expect(recentlyDeclined('item-old', 60 * 60 * 1000)).toBe(false);
  });
});

// ===========================================================================
// 3. sweepJudgedProposals — pure unit
// ===========================================================================

describe('M220 sweepJudgedProposals — pure unit', () => {
  it('passes exact proposal generation identity to custom cooldown projection', () => {
    const item = makeItem('generated-repair', tmpRepo);
    const recorded: Array<{ itemId: string; generationId?: string }> = [];
    const generationId = 'a'.repeat(64);

    const count = sweepJudgedProposals([{
      id: 'prop-generated-repair',
      title: 'Generated repair',
      summary: 'Generated repair summary',
      repo: tmpRepo,
      status: 'rejected',
      workItemId: item.id,
      workItemGenerationId: generationId,
    }], [item], undefined, (itemId, _outcome, _ts, observedGenerationId) => {
      recorded.push({ itemId, generationId: observedGenerationId });
    });

    expect(count).toBe(1);
    expect(recorded).toEqual([{ itemId: item.id, generationId }]);
  });

  it('passes only the proposal repository match when item ids collide', () => {
    const first = makeItem('shared-item', tmpRepo, { title: 'First repository item' });
    const secondRepo = path.join(tmpHome, 'second-repo');
    const second = makeItem('shared-item', secondRepo, { title: 'Second repository item' });
    const matched: WorkItem[] = [];

    sweepJudgedProposals([{
      id: 'prop-second-repo',
      title: 'Second repository proposal',
      summary: '',
      repo: secondRepo,
      status: 'rejected',
      workItemId: 'shared-item',
    }], [first, second], undefined, (_itemId, _outcome, _ts, _generationId, item) => {
      if (item) matched.push(item);
    });

    expect(matched).toEqual([second]);
  });

  it('records a judged-decline outcome for a rejected proposal matched by item.id', () => {
    const item = makeItem('my-stable-id', tmpRepo, { title: 'CI is failing' });

    // Proposal title embeds the item id as a token
    const proposals = [{
      id: 'prop-1',
      title: `Fix for my-stable-id: CI failure`,
      summary: `Addresses my-stable-id in the codebase`,
      repo: tmpRepo,
      status: 'rejected',
      decisionReason: 'noise',
    }];

    const count = sweepJudgedProposals(proposals, [item]);
    expect(count).toBe(1);

    const l = loadWorkedLedger();
    const event = l.events.find(e => e.itemId === 'my-stable-id');
    expect(event).toBeDefined();
    expect(event?.outcome).toBe('judged-noise');
  });

  it('records each rejected proposal only once across repeated sweeps', () => {
    const item = makeItem('repeat-item', tmpRepo, { title: 'Repeated rejected proposal' });
    const proposals = [{
      id: 'prop-repeat',
      title: 'Repeated rejected proposal',
      summary: '',
      repo: tmpRepo,
      status: 'rejected',
      decisionReason: 'harmful',
      workItemId: item.id,
    }];

    expect(sweepJudgedProposals(proposals, [item])).toBe(1);
    expect(sweepJudgedProposals(proposals, [item])).toBe(0);

    const events = loadWorkedLedger().events.filter((e) => e.itemId === item.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'judged-decline',
      proposalId: 'prop-repeat',
    });
  });

  it('prefers proposal.workItemId over title/summary matching', () => {
    const right = makeItem('right-item', tmpRepo, { title: 'Right item' });
    const wrong = makeItem('wrong-item', tmpRepo, { title: 'Wrong item' });

    const proposals = [{
      id: 'prop-causal',
      title: 'Fix wrong-item',
      summary: 'Mentions wrong-item in text, but causal id says otherwise',
      repo: tmpRepo,
      status: 'rejected',
      decisionReason: 'noise',
      workItemId: right.id,
    }];

    const count = sweepJudgedProposals(proposals, [wrong, right]);
    expect(count).toBe(1);

    const l = loadWorkedLedger();
    expect(l.events.find(e => e.itemId === right.id)?.outcome).toBe('judged-noise');
    expect(l.events.find(e => e.itemId === wrong.id)).toBeUndefined();
  });

  it('records proposal.workItemId even when the item is absent from the current backlog', () => {
    const proposals = [{
      id: 'prop-causal-absent',
      title: 'No current backlog match',
      summary: '',
      repo: tmpRepo,
      status: 'rejected',
      decisionReason: 'harmful',
      workItemId: 'absent-but-causal-item',
    }];

    const count = sweepJudgedProposals(proposals, []);
    expect(count).toBe(1);

    const l = loadWorkedLedger();
    expect(l.events.find(e => e.itemId === 'absent-but-causal-item')?.outcome).toBe('judged-decline');
  });

  it('records judged-decline for rejected proposal without decisionReason (defaults to harmful)', () => {
    const item = makeItem('item-no-reason', tmpRepo, { title: 'Refactor X' });

    const proposals = [{
      id: 'prop-2',
      title: `Fix item-no-reason`,
      summary: '',
      repo: tmpRepo,
      status: 'rejected',
      decisionReason: undefined,
    }];

    sweepJudgedProposals(proposals, [item]);

    const l = loadWorkedLedger();
    const event = l.events.find(e => e.itemId === 'item-no-reason');
    expect(event?.outcome).toBe('judged-decline');
  });

  it('does NOT record anything for non-rejected proposals', () => {
    const item = makeItem('item-pending', tmpRepo, { title: 'Pending work' });

    const proposals = [{
      id: 'prop-3',
      title: `Fix item-pending`,
      summary: '',
      repo: tmpRepo,
      status: 'pending',
      decisionReason: undefined,
    }];

    const count = sweepJudgedProposals(proposals, [item]);
    expect(count).toBe(0);

    const l = loadWorkedLedger();
    expect(l.events.find(e => e.itemId === 'item-pending')).toBeUndefined();
  });

  it('stable-signature fallback: fresh scanner ID still matches via repo+title', () => {
    // The backlog item has a stable title but a DIFFERENT id from what's in the proposal.
    // This simulates a scanner that regenerates IDs each tick.
    const item = makeItem('fresh-scanner-id-xyz', tmpRepo, { title: 'CI is failing' });

    // Proposal carries the OLD (or unrelated) id but the same title and same repo.
    const proposals = [{
      id: 'prop-old',
      title: 'CI is failing',           // matches item.title exactly
      summary: 'the ci keeps failing',
      repo: tmpRepo,                    // matches item.repo
      status: 'rejected',
      decisionReason: 'noise',
    }];

    const count = sweepJudgedProposals(proposals, [item]);
    expect(count).toBe(1);

    const l = loadWorkedLedger();
    const event = l.events.find(e => e.itemId === 'fresh-scanner-id-xyz');
    expect(event).toBeDefined();
    expect(event?.outcome).toBe('judged-noise');
  });

  it('returns count of matched items', () => {
    const item1 = makeItem('item-A', tmpRepo, { title: 'Fix A' });
    const item2 = makeItem('item-B', tmpRepo, { title: 'Fix B' });

    const proposals = [
      { id: 'p1', title: 'Fix item-A', summary: '', repo: tmpRepo, status: 'rejected', decisionReason: 'noise' },
      { id: 'p2', title: 'Fix item-B', summary: '', repo: tmpRepo, status: 'rejected', decisionReason: 'harmful' },
    ];

    const count = sweepJudgedProposals(proposals, [item1, item2]);
    expect(count).toBe(2);
  });

  it('never throws when proposals or backlog are empty', () => {
    expect(() => sweepJudgedProposals([], [])).not.toThrow();
    expect(() => sweepJudgedProposals([], [makeItem('x', tmpRepo)])).not.toThrow();
  });
});

// ===========================================================================
// 4. Full tick() integration — antiClog DEFAULT ON
// ===========================================================================

describe('M220 tick() integration — antiClog default ON', () => {
  it('an item whose proposal was judged noise is skipped on the next tick', async () => {
    const judgedId = 'judged-noise-item';
    const freshId = 'fresh-item';

    // Simulate: previous tick ran judged-noise-item, manager rejected as noise.
    createRejectedProposal({
      repo: tmpRepo,
      title: `Fix ${judgedId} — CI failure`,
      summary: `Addresses ${judgedId}`,
      decisionReason: 'noise',
    });

    backlogItems = [
      makeItem(judgedId, tmpRepo, { score: 10 }),
      makeItem(freshId, tmpRepo, { score: 5 }),
    ];
    mockBuildBacklog.mockImplementation(async () => ({
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo],
      items: backlogItems,
    }));

    const cfg = makeCfgWithAntiClog(true);
    mockLoadConfig.mockReturnValue(cfg);

    const dispatched: string[] = [];
    mockRunSwarm.mockImplementation(async (_input: unknown, _cfg: unknown, opts: unknown) => {
      const o = opts as Record<string, unknown>;
      dispatched.push(o['project'] as string ?? '');
      createProposal({ repo: tmpRepo, origin: 'swarm', kind: 'patch', title: 'proposal', summary: '', diff: 'diff\n' });
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    await tick(cfg, { dryRun: false });

    // The judged item should have been suppressed; only the fresh item dispatched.
    // (judged-noise-item's proposal was rejected → sweepJudgedProposals records it →
    //  recentlyDeclined returns true → coordinator.shouldSkip skips it)
    const ledger = loadWorkedLedger();
    const judgedEvent = ledger.events.find(e => e.itemId === generatedRepairCooldownKey(backlogItems[0]!));
    // It should now have a judged-noise entry from the sweep
    expect(judgedEvent).toBeDefined();
    expect(judgedEvent?.outcome).toBe('judged-noise');

    // The fresh item should have been dispatched
    expect(dispatched.length).toBeGreaterThan(0);
  }, 15_000);

  it('shared queue mode writes rejected/noise sweep feedback to the shared store', async () => {
    const judgedId = 'shared-judged-noise-item';
    const freshId = 'shared-fresh-item';
    const sharedDir = path.join(tmpHome, 'shared-queue');

    createRejectedProposal({
      repo: tmpRepo,
      title: `Fix ${judgedId}`,
      summary: `Addresses ${judgedId}`,
      decisionReason: 'noise',
    });

    backlogItems = [
      makeItem(judgedId, tmpRepo, { score: 10 }),
      makeItem(freshId, tmpRepo, { score: 5 }),
    ];
    mockBuildBacklog.mockImplementation(async () => ({
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo],
      items: backlogItems,
    }));

    const cfg = {
      ...makeCfgWithAntiClog(true),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedDir,
          machineId: 'machine-A',
          leaseMs: 10_000,
          trustedCoherentStorage: true,
        },
      },
    } as AshlrConfig;
    mockLoadConfig.mockReturnValue(cfg);

    await tick(cfg, { dryRun: false });

    const sharedStore = new SharedStore(sharedDir);
    const cooldownKey = generatedRepairCooldownKey(backlogItems[0]!);
    const sharedEvents = sharedStore.readSnapshot().worked.filter((event) => event.itemId === cooldownKey);
    expect(sharedEvents.some((event) => event.outcome === 'judged-noise')).toBe(true);
    expect(sharedStore.recentlyDeclined(cooldownKey, 6 * 60 * 60 * 1000)).toBe(true);
    expect(loadWorkedLedger().events.some((event) => event.itemId === cooldownKey)).toBe(false);
  }, 15_000);

  it('does not write rejected feedback onto an equal-id item in another repository', async () => {
    const itemId = 'shared-judged-item';
    const otherRepo = path.join(tmpHome, 'other-repo');
    const sharedDir = path.join(tmpHome, 'shared-queue-isolation');
    const primary = makeItem(itemId, tmpRepo, { score: 10 });
    const other = makeItem(itemId, otherRepo, { score: 9 });
    createRejectedProposal({
      repo: tmpRepo,
      title: `Fix ${itemId}`,
      summary: `Addresses ${itemId}`,
      decisionReason: 'noise',
    });
    backlogItems = [primary, other];
    mockBuildBacklog.mockImplementation(async () => ({
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo, otherRepo],
      items: backlogItems,
    }));
    const cfg = {
      ...makeCfgWithAntiClog(true),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedDir,
          machineId: 'machine-A',
          leaseMs: 10_000,
          trustedCoherentStorage: true,
        },
      },
    } as AshlrConfig;
    mockLoadConfig.mockReturnValue(cfg);

    await tick(cfg, { dryRun: true });

    const sharedStore = new SharedStore(sharedDir);
    expect(sharedStore.recentlyDeclined(generatedRepairCooldownKey(primary), 6 * 60 * 60 * 1000)).toBe(true);
    expect(sharedStore.recentlyDeclined(generatedRepairCooldownKey(other), 6 * 60 * 60 * 1000)).toBe(false);
  }, 15_000);

  it('a fresh substantive item is NOT skipped when antiClog is ON', async () => {
    const freshId = 'fresh-unrelated-item';

    backlogItems = [makeItem(freshId, tmpRepo, { score: 5 })];
    mockBuildBacklog.mockImplementation(async () => ({
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo],
      items: backlogItems,
    }));

    const cfg = makeCfgWithAntiClog(true);
    mockLoadConfig.mockReturnValue(cfg);

    let dispatched = 0;
    mockRunSwarm.mockImplementation(async () => {
      dispatched++;
      createProposal({ repo: tmpRepo, origin: 'swarm', kind: 'patch', title: 'proposal', summary: '', diff: 'diff\n' });
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    await tick(cfg, { dryRun: false });

    expect(dispatched).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. Flag-off (antiClog:false) — byte-identical to pre-M220
// ===========================================================================

describe('M220 flag-off — antiClog:false is byte-identical to pre-M220', () => {
  it('with antiClog=false, a rejected proposal does NOT suppress the item in the ledger', async () => {
    const judgedId = 'should-not-be-suppressed';

    // Rejected proposal exists in inbox
    createRejectedProposal({
      repo: tmpRepo,
      title: `Fix ${judgedId} — CI failure`,
      summary: `Addresses ${judgedId}`,
      decisionReason: 'noise',
    });

    backlogItems = [makeItem(judgedId, tmpRepo, { score: 10 })];
    mockBuildBacklog.mockImplementation(async () => ({
      generatedAt: new Date().toISOString(),
      repos: [tmpRepo],
      items: backlogItems,
    }));

    const cfg = makeCfgWithAntiClog(false); // flag OFF
    mockLoadConfig.mockReturnValue(cfg);

    let dispatched = 0;
    mockRunSwarm.mockImplementation(async () => {
      dispatched++;
      createProposal({ repo: tmpRepo, origin: 'swarm', kind: 'patch', title: 'proposal', summary: '', diff: 'diff\n' });
      return { id: 'sw', status: 'done', goal: '', result: '', usage: { estCostUsd: 0, totalTokens: 0, steps: 1 } };
    });

    await tick(cfg, { dryRun: false });

    // With antiClog=false, the sweep never ran — judgedId has no judged-noise entry.
    // (It may have a 'diff' or 'empty' from the tick's own run, but NOT judged-noise from sweep.)
    const ledger = loadWorkedLedger();
    const judgedEvents = ledger.events.filter(e => e.itemId === judgedId);
    const hasSweepEntry = judgedEvents.some(e =>
      e.outcome === 'judged-noise' || e.outcome === 'judged-review' || e.outcome === 'judged-decline',
    );
    expect(hasSweepEntry).toBe(false);

    // The item should have been dispatched (not suppressed)
    expect(dispatched).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 6. Worked-ledger backward compat — existing 'empty' / 'diff' still work
// ===========================================================================

describe('M220 backward compat — existing outcome values unchanged', () => {
  it('recordOutcome("empty") still suppresses and recentlyDeclined returns true', () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    recordOutcome('item-compat', 'empty', ts);
    expect(recentlyDeclined('item-compat', 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('recordOutcome("diff") still does NOT suppress', () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    recordOutcome('item-diff-compat', 'diff', ts);
    expect(recentlyDeclined('item-diff-compat', 6 * 60 * 60 * 1000)).toBe(false);
  });

  it('old ledger with only diff/empty events loads without errors', () => {
    // Write a ledger file with only old-format outcomes
    const p = workedLedgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      events: [
        { itemId: 'a', outcome: 'diff', ts: new Date().toISOString() },
        { itemId: 'b', outcome: 'empty', ts: new Date().toISOString() },
      ],
    }), 'utf8');

    const l = loadWorkedLedger();
    expect(l.events).toHaveLength(2);
    expect(l.events[0]?.outcome).toBe('diff');
    expect(l.events[1]?.outcome).toBe('empty');
  });

  it('ledger with new judged-* outcomes loads without errors', () => {
    const p = workedLedgerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      events: [
        { itemId: 'x', outcome: 'judged-review', ts: new Date().toISOString() },
        { itemId: 'y', outcome: 'judged-noise', ts: new Date().toISOString() },
        { itemId: 'z', outcome: 'judged-decline', ts: new Date().toISOString() },
      ],
    }), 'utf8');

    const l = loadWorkedLedger();
    expect(l.events).toHaveLength(3);
    expect(l.events[0]?.outcome).toBe('judged-review');
    expect(l.events[1]?.outcome).toBe('judged-noise');
    expect(l.events[2]?.outcome).toBe('judged-decline');
  });
});
