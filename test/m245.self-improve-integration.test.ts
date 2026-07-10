/**
 * test/m245.self-improve-integration.test.ts
 *
 * END-TO-END INTEGRATION: Self-Improvement Loop
 *
 * Proves the four modules (M235, M240, M241, M243) are coherently wired
 * together as a recursive self-improvement loop:
 *
 *   [judge outcomes] ──write──▶ decisions ledger
 *       │
 *       ├─ M235 learnFromRejection  ──▶ anti-playbook genome entries
 *       │                               (tag: m235:anti-playbook)
 *       │
 *       ├─ M243 learnFromApplied    ──▶ skill genome entries
 *       │                               (tag: m243:skill)
 *       │
 *       ├─ M240 buildEngineScores   ──▶ learned routing bias
 *       │       (reads ledger → score map)
 *       │
 *       └─ M241 emit(regression:…) ──▶ enqueues fix goal (proposal-only)
 *
 *   COMPOUNDING CONTRACT: the genome entries written by M235/M243 are
 *   recallable via curateAntiPlaybooks / curateSkills (injectOnRun path)
 *   as grounding for future runs — the loop is self-reinforcing.
 *
 * HERMETICITY
 *  - HOME is overridden to a fresh tmp dir per test; no real ~/.ashlr touched.
 *  - appendHubEntry and recordDecision are run REAL (no mocks) — this is an
 *    integration test; we verify actual file I/O in the isolated tmp HOME.
 *  - Event-bus mocks (goals/store, comms/events, etc.) are kept because those
 *    are downstream IO with no integration value here.
 *  - Fixed timestamp via vi.setSystemTime — deterministic, no boundary flak.
 *  - No network, no LLM, no child processes.
 *
 * SCENARIO (in order):
 *  1. Write synthetic judged decisions to the isolated ledger (ship + reject).
 *  2. Assert M240 buildEngineScores reflects those outcomes:
 *       high-ship engine → score > 0.5
 *       high-reject engine → score < 0.5
 *  3. Call M235 learnFromRejection for each failure → anti-playbook in genome.
 *  4. Call M243 learnFromApplied for each success → skill in genome.
 *  5. Assert genome hub.jsonl has both kinds of entry (by tag).
 *  6. Assert M241 emit('regression:detected') dispatches → createGoal called
 *     (proposal-only, no merge/push/apply).
 *  7. Assert COMPOUNDING: curateAntiPlaybooks + curateSkills over the written
 *     genome return the entries the loop wrote → recall path is coherent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { AutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { persistAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { LEARNED_ROUTING_MIN_SAMPLES } from '../src/core/run/learned-router.js';

// ---------------------------------------------------------------------------
// HOME isolation — must be set before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
const origAshlrHome = process.env['ASHLR_HOME'];
let tmpHome: string;

// ---------------------------------------------------------------------------
// Event-bus downstream mocks (goals/store, comms/events, invent-cycle)
// These are fire-and-forget side-effects; we mock them to keep the test hermetic.
// The destructive primitives are mocked to assert they are NEVER called.
// ---------------------------------------------------------------------------

const {
  mockCreateGoal,
  mockListGoals,
  mockRecordOutcome,
  mockNotifyFleetEvent,
  mockRunInventCycle,
  mockAutoMergeProposal,
  mockApplyDiff,
  mockGitPush,
} = vi.hoisted(() => ({
  mockCreateGoal: vi.fn().mockReturnValue({ id: 'goal-integration-1', objective: 'fix', status: 'planning' }),
  // M282: must be in vi.hoisted() so vi.clearAllMocks() in beforeEach does NOT
  // destroy its implementation. _handleRegressionDetected calls listGoals() for
  // the M258 dedupe check — if it returns undefined (post-clearAllMocks inline
  // mock) then .some() throws and the handler silently swallows the error,
  // meaning createGoal is never reached. Hoisted ref survives clearAllMocks.
  mockListGoals: vi.fn().mockReturnValue([]),
  mockRecordOutcome: vi.fn(),
  mockNotifyFleetEvent: vi.fn().mockResolvedValue(undefined),
  mockRunInventCycle: vi.fn().mockResolvedValue(undefined),
  // destructive — must NEVER be called from any handler
  mockAutoMergeProposal: vi.fn(),
  mockApplyDiff: vi.fn(),
  mockGitPush: vi.fn(),
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: mockCreateGoal,
  listGoals: mockListGoals,
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
  goalsDir: () => path.join(process.env['HOME'] ?? os.tmpdir(), '.ashlr', 'goals'),
}));

vi.mock('../src/core/fleet/worked-ledger.js', () => ({
  recordOutcome: mockRecordOutcome,
  listWorkedItems: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: mockNotifyFleetEvent,
}));

vi.mock('../src/core/generative/invent-cycle.js', () => ({
  runInventCycle: mockRunInventCycle,
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: mockAutoMergeProposal,
}));

vi.mock('../src/core/run/apply.js', () => ({
  applyDiff: mockApplyDiff,
}));

vi.mock('../src/core/run/git.js', () => ({
  gitPush: mockGitPush,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  buildEngineScores,
  engineScoreFor,
  sortEnginesByScore,
} from '../src/core/run/learned-router.js';

import {
  learnFromRejection,
  curateAntiPlaybooks,
} from '../src/core/fleet/self-improve.js';

import {
  learnFromApplied,
  curateSkills,
} from '../src/core/fleet/skill-library.js';

import {
  emit,
  _clearHandlers,
  registerBuiltInHandlers,
} from '../src/core/fleet/event-bus.js';

// ---------------------------------------------------------------------------
// Fixed timestamp — all events "happen" at this instant.
// ---------------------------------------------------------------------------

const FIXED_MS = 1_750_000_000_000; // 2025-06-15 ~22:13 UTC
const FIXED_ISO = new Date(FIXED_MS).toISOString();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write synthetic judged decisions to the isolated decisions ledger.
 * Mirrors the writeDecisions helper from m240.learned-routing.test.ts.
 * proposalId format: `<engine>:<source>:sha<i>` → taskClass derived from source.
 */
function writeLedgerEntries(
  entries: Array<{
    proposalId: string;
    engine: string;
    model: string;
    verdict: string;
    ts?: string;
  }>,
): void {
  const dir = path.join(tmpHome, '.ashlr', 'decisions');
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date(FIXED_MS).toISOString().slice(0, 10);
  const file = path.join(dir, `${today}.jsonl`);
  const lines = entries
    .map((e) =>
      JSON.stringify({
        ts: e.ts ?? FIXED_ISO,
        proposalId: e.proposalId,
        action: 'judged',
        engine: e.engine,
        model: e.model,
        verdict: e.verdict,
      }),
    )
    .join('\n');
  fs.writeFileSync(file, lines + '\n', 'utf8');
}

/** Read raw hub.jsonl lines and return parsed entries. */
function readHubEntries(): Array<Record<string, unknown>> {
  const hubPath = path.join(tmpHome, '.ashlr', 'genome', 'hub.jsonl');
  if (!fs.existsSync(hubPath)) return [];
  return fs
    .readFileSync(hubPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Build a minimal AshlrConfig with all four feature flags ON. */
function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 10.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
      cooldownMs: 6 * 60 * 60 * 1000,
    },
    foundry: {
      selfImprove: true,
      skillLibrary: true,
      eventBus: true,
      allowedBackends: ['claude', 'codex', 'builtin'],
      ...overrides,
    },
    genome: {
      maxRecall: 20,
      injectOnRun: true,
    },
  } as AshlrConfig;
}

/** Build a minimal Proposal for a shipped work item. */
function makeProposal(
  id: string,
  title: string,
  engineModel: string,
  repo = '/home/agent/test-repo',
): Proposal {
  const diff = '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n+// fix';
  const diffHash = hashDiff(diff);
  const proposal = {
    id,
    repo,
    origin: 'swarm',
    kind: 'patch',
    title,
    summary: `Successfully completed: ${title}`,
    status: 'applied',
    createdAt: FIXED_ISO,
    engineTier: 'frontier',
    engineModel,
    diff,
    diffHash,
    verifyResult: {
      passed: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      diffHash,
      verifiedAt: FIXED_ISO,
      source: 'auto-merge',
    },
  } as Proposal;
  proposal.provenanceSig = signProvenance(
    proposal.engineModel ?? '',
    proposal.engineTier ?? '',
    diffHash,
  );
  return proposal;
}

/** Persist the authoritative applied proposal and matching evidence pack. */
function persistVerifiedAppliedProposal(proposal: Proposal): void {
  const inboxDir = path.join(tmpHome, '.ashlr', 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${proposal.id}.json`),
    JSON.stringify(proposal, null, 2) + '\n',
    'utf8',
  );

  const diffHash = hashDiff(proposal.diff ?? '');
  const evidence: AutonomyEvidencePack = {
    version: 1,
    generatedAt: FIXED_ISO,
    proposal: {
      id: proposal.id,
      repo: proposal.repo,
      kind: proposal.kind,
      status: proposal.status,
      origin: proposal.origin,
      title: proposal.title,
      createdAt: proposal.createdAt,
    },
    producer: {
      engineModel: proposal.engineModel,
      engineTier: proposal.engineTier,
    },
    diff: { hash: diffHash, files: ['src/foo.ts'], changedLines: 1 },
    target: 'main',
    trustBasis: 'verification',
    remotePreferred: false,
    riskClass: 'low',
    gates: {
      authority: { ok: true, detail: 'authority passed' },
      provenance: { ok: true, detail: 'provenance passed' },
      verification: { ok: true, detail: 'verification passed' },
      risk: { ok: true, detail: 'risk passed' },
      scope: { ok: true, detail: 'scope passed' },
    },
    verification: {
      passed: true,
      detail: 'verification passed',
      commandKinds: ['test'],
      diffHash,
      verifiedAt: FIXED_ISO,
      source: 'auto-merge',
    },
    policy: {
      tier: 'verified-source',
      action: 'merge-main',
      allowed: true,
      reason: 'verified evidence passed',
    },
  };
  expect(persistAutonomyEvidencePack(evidence)).toBe(true);
}

function learnVerifiedApplied(proposal: Proposal, cfg: AshlrConfig): void {
  persistVerifiedAppliedProposal(proposal);
  learnFromApplied(proposal, cfg);
}

/**
 * Flush async event-bus handler tails.
 *
 * M282 determinism fix: _handleRegressionDetected is async and chains multiple
 * awaits (dynamic import → listGoals → createGoal). vi.runAllTimersAsync() alone
 * only advances fake setTimeout/setInterval; it does NOT drain chained microtasks
 * that come from dynamic import(). We need several microtask-yield rounds BEFORE
 * advancing timers so in-flight promises can fully settle.
 * Pattern mirrors the proven m241 flush, adapted for fake-timer context.
 */
async function flush(): Promise<void> {
  // Drain in-flight microtasks (dynamic import chains, Promise.resolve chains)
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // Advance fake timers so any queued setTimeout callbacks fire
  await vi.runAllTimersAsync();
  // One final microtask yield so timer-callback continuations settle
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m245-'));
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = path.join(tmpHome, '.ashlr');

  vi.useFakeTimers();
  vi.setSystemTime(FIXED_MS);

  // Reset all mocks
  vi.clearAllMocks();
  mockCreateGoal.mockReturnValue({ id: 'goal-integration-1', objective: 'fix', status: 'planning' });
  // M282: restore listGoals after clearAllMocks so dedupe check returns [] (not undefined)
  mockListGoals.mockReturnValue([]);
  mockNotifyFleetEvent.mockResolvedValue(undefined);
  mockRunInventCycle.mockResolvedValue(undefined);

  // Reset event-bus state to a clean slate
  _clearHandlers();
  registerBuiltInHandlers();
});

afterEach(() => {
  vi.useRealTimers();
  process.env['HOME'] = origHome;
  if (origAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = origAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ===========================================================================
// SCENARIO 1 — Decisions ledger → M240 learned router bias
//
// Seed the ledger with enough judged outcomes for two engines on the same
// task class, then assert buildEngineScores correctly biases toward the
// high-ship engine and away from the high-reject engine.
// ===========================================================================

describe('INTEGRATION S1: decisions ledger → M240 learned routing bias', () => {
  const N = LEARNED_ROUTING_MIN_SAMPLES + 3; // just above the floor
  const TASK_CLASS = 'issue';

  beforeEach(() => {
    // claude:opus → all ships (positive history)
    // codex:gpt-5.5 → all noise/harmful (negative history)
    writeLedgerEntries([
      ...Array.from({ length: N }, (_, i) => ({
        proposalId: `test-repo:${TASK_CLASS}:claude${i}`,
        engine: 'claude',
        model: 'opus',
        verdict: 'ship',
        ts: FIXED_ISO,
      })),
      ...Array.from({ length: N }, (_, i) => ({
        proposalId: `test-repo:${TASK_CLASS}:codex${i}`,
        engine: 'codex',
        model: 'gpt-5.5',
        verdict: 'noise',
        ts: FIXED_ISO,
      })),
    ]);
  });

  it('high-ship engine (claude:opus) scores > 0.5 for task-class', () => {
    const scores = buildEngineScores(TASK_CLASS, FIXED_MS);
    const s = scores.get('claude:opus');
    expect(s, 'claude:opus score must be present in map').toBeDefined();
    expect(s!.score).toBeGreaterThan(0.5);
    expect(s!.samples).toBeGreaterThanOrEqual(LEARNED_ROUTING_MIN_SAMPLES);
  });

  it('high-reject engine (codex:gpt-5.5) scores < 0.5 for task-class', () => {
    const scores = buildEngineScores(TASK_CLASS, FIXED_MS);
    const s = scores.get('codex:gpt-5.5');
    expect(s, 'codex:gpt-5.5 score must be present in map').toBeDefined();
    expect(s!.score).toBeLessThan(0.5);
    expect(s!.samples).toBeGreaterThanOrEqual(LEARNED_ROUTING_MIN_SAMPLES);
  });

  it('sortEnginesByScore promotes claude over codex for task-class', () => {
    const scores = buildEngineScores(TASK_CLASS, FIXED_MS);
    const ordered = sortEnginesByScore(['codex', 'claude'] as never[], scores, null);
    // claude should be sorted first even though codex was listed first
    expect(ordered[0]).toBe('claude');
    expect(ordered[1]).toBe('codex');
  });

  it('engineScoreFor returns neutral (0.5) for an engine with no history', () => {
    const scores = buildEngineScores(TASK_CLASS, FIXED_MS);
    // local-coder has no history in this ledger
    const s = engineScoreFor(scores, 'local-coder' as never, null);
    expect(s).toBe(0.5);
  });

  it('scores are task-class isolated — todo task sees empty map', () => {
    // We only seeded 'issue' verdicts; 'todo' should get an empty map
    const todoScores = buildEngineScores('todo', FIXED_MS);
    expect(todoScores.size).toBe(0);
  });
});

// ===========================================================================
// SCENARIO 2 — M235 learnFromRejection writes anti-playbooks to genome
//
// Call learnFromRejection with rejection verdicts and assert the genome
// hub.jsonl file contains the expected anti-playbook entries.
// ===========================================================================

describe('INTEGRATION S2: M235 learnFromRejection → anti-playbooks in genome', () => {
  const cfg = makeCfg();

  it('writes one anti-playbook entry per rejection verdict', () => {
    const cases: Array<[string, string, 'noise' | 'harmful' | 'review', string]> = [
      ['prop-noise-001', 'Rename a trivial variable', 'noise', 'too trivial'],
      ['prop-harmful-002', 'Drop production table', 'harmful', 'deletes prod data'],
      ['prop-review-003', 'Add logging to auth', 'review', 'needs human review'],
    ];

    for (const [id, title, verdict, reasoning] of cases) {
      learnFromRejection(id, title, verdict, reasoning, cfg);
    }

    const entries = readHubEntries();
    const antiPlaybooks = entries.filter(
      (e) => Array.isArray(e['tags']) && (e['tags'] as string[]).includes('m235:anti-playbook'),
    );

    expect(antiPlaybooks).toHaveLength(3);

    // Every anti-playbook must carry the correct verdict tag
    const noiseEntry = antiPlaybooks.find(
      (e) => (e['tags'] as string[]).includes('verdict:noise'),
    );
    const harmfulEntry = antiPlaybooks.find(
      (e) => (e['tags'] as string[]).includes('verdict:harmful'),
    );
    const reviewEntry = antiPlaybooks.find(
      (e) => (e['tags'] as string[]).includes('verdict:review'),
    );

    expect(noiseEntry, 'anti-playbook for noise verdict must exist').toBeDefined();
    expect(harmfulEntry, 'anti-playbook for harmful verdict must exist').toBeDefined();
    expect(reviewEntry, 'anti-playbook for review verdict must exist').toBeDefined();

    // hubOnly is an input field to appendHubEntry; it is not persisted to hub.jsonl
    // (GenomeEntry does not carry hubOnly). Verify instead that no entry has a
    // 'project' field (which would indicate it was written into a project genome dir).
    for (const e of antiPlaybooks) {
      expect(e['project'], `anti-playbook must have null project (hub-only write)`).toBeNull();
    }
  });

  it('"ship" verdict does NOT write an anti-playbook', () => {
    learnFromRejection('prop-ship-ok', 'Great feature', 'ship', 'all good', cfg);
    const entries = readHubEntries();
    const antiPlaybooks = entries.filter(
      (e) => Array.isArray(e['tags']) && (e['tags'] as string[]).includes('m235:anti-playbook'),
    );
    expect(antiPlaybooks).toHaveLength(0);
  });

  it('also writes a decisions-ledger telemetry entry for each rejection', () => {
    learnFromRejection('prop-ledger-001', 'Some noisy change', 'noise', 'too small', cfg);

    const decisionsDir = path.join(tmpHome, '.ashlr', 'decisions');
    expect(fs.existsSync(decisionsDir), 'decisions dir must exist').toBe(true);

    const today = new Date(FIXED_MS).toISOString().slice(0, 10);
    const ledgerFile = path.join(decisionsDir, `${today}.jsonl`);
    expect(fs.existsSync(ledgerFile), 'today ledger file must exist').toBe(true);

    const lines = fs
      .readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const telemetry = lines.filter((l) => l['action'] === 'self-improve:written');
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!['proposalId']).toBe('prop-ledger-001');
    expect(String(telemetry[0]!['detail'])).toContain('verdict=noise');
  });
});

// ===========================================================================
// SCENARIO 3 — M243 learnFromApplied writes skills to genome
//
// Call learnFromApplied with shipped proposals and assert the genome
// hub.jsonl contains m243:skill entries with abstracted (not raw-diff) text.
// ===========================================================================

describe('INTEGRATION S3: M243 learnFromApplied → skills in genome', () => {
  const cfg = makeCfg();

  it('writes one skill entry per applied proposal', () => {
    const proposals = [
      makeProposal('prop-applied-001', 'Fix null pointer in auth', 'claude:claude-opus-4-5'),
      makeProposal('prop-applied-002', 'Add rate limiting to API', 'codex:gpt-5.5'),
      makeProposal('prop-applied-003', 'Refactor database module', 'claude:claude-opus-4-5'),
    ];

    for (const p of proposals) {
      learnVerifiedApplied(p, cfg);
    }

    const entries = readHubEntries();
    const skills = entries.filter(
      (e) => Array.isArray(e['tags']) && (e['tags'] as string[]).includes('m243:skill'),
    );

    expect(skills).toHaveLength(3);

    // hubOnly is an input field to appendHubEntry; it is not persisted to hub.jsonl.
    // Verify instead that no skill entry has a 'project' field (hub-only write).
    for (const e of skills) {
      expect(e['project'], `skill must have null project (hub-only write)`).toBeNull();
    }

    // Workflow text must NOT contain raw diff markers (AWM/Voyager principle)
    for (const e of skills) {
      const text = String(e['text']);
      expect(text).not.toContain('--- a/');
      expect(text).not.toContain('+++ b/');
      expect(text).not.toContain('@@ -1 +1 @@');
    }
  });

  it('skill text contains the proposal title and engine info', () => {
    const p = makeProposal('prop-applied-detail', 'Fix crash in parser', 'claude:claude-opus-4-5');
    learnVerifiedApplied(p, cfg);

    const entries = readHubEntries();
    const skills = entries.filter(
      (e) => Array.isArray(e['tags']) && (e['tags'] as string[]).includes('m243:skill'),
    );
    expect(skills).toHaveLength(1);

    const text = String(skills[0]!['text']);
    expect(text).toContain('Fix crash in parser');
    expect(text).toContain('claude:claude-opus-4-5');
  });

  it('skill also writes a decisions-ledger telemetry entry', () => {
    const p = makeProposal('prop-skill-ledger-01', 'Add rate limiting', 'claude:claude-opus-4-5');
    learnVerifiedApplied(p, cfg);

    const today = new Date(FIXED_MS).toISOString().slice(0, 10);
    const ledgerFile = path.join(tmpHome, '.ashlr', 'decisions', `${today}.jsonl`);
    expect(fs.existsSync(ledgerFile)).toBe(true);

    const lines = fs
      .readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const telemetry = lines.filter((l) => l['action'] === 'skill-library:written');
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!['proposalId']).toBe('prop-skill-ledger-01');
    expect(String(telemetry[0]!['detail'])).toContain('engine=');
  });
});

// ===========================================================================
// SCENARIO 4 — Full loop: genome has BOTH anti-playbooks AND skills
//
// Run both M235 and M243 over the same tmpHome and assert the genome has
// entries from both modules — the loop wrote both the failure lessons and
// the success skills.
// ===========================================================================

describe('INTEGRATION S4: full loop — genome contains both anti-playbooks and skills', () => {
  it('genome has m235:anti-playbook AND m243:skill entries after one loop cycle', () => {
    const cfg = makeCfg();

    // Failures → anti-playbooks
    learnFromRejection('loop-rej-001', 'Rename a variable', 'noise', 'too trivial', cfg);
    learnFromRejection('loop-rej-002', 'Drop table users', 'harmful', 'deletes prod data', cfg);

    // Successes → skills
    learnVerifiedApplied(makeProposal('loop-app-001', 'Fix null pointer', 'claude:claude-opus-4-5'), cfg);
    learnVerifiedApplied(makeProposal('loop-app-002', 'Add rate limit', 'codex:gpt-5.5'), cfg);

    const entries = readHubEntries();
    const allTags = entries.flatMap((e) => (Array.isArray(e['tags']) ? (e['tags'] as string[]) : []));

    const hasAntiPlaybooks = allTags.some((t) => t === 'm235:anti-playbook');
    const hasSkills = allTags.some((t) => t === 'm243:skill');

    expect(hasAntiPlaybooks, 'genome must have m235:anti-playbook entries').toBe(true);
    expect(hasSkills, 'genome must have m243:skill entries').toBe(true);

    // Exact counts
    const antiPlaybookCount = entries.filter(
      (e) => (e['tags'] as string[]).includes('m235:anti-playbook'),
    ).length;
    const skillCount = entries.filter(
      (e) => (e['tags'] as string[]).includes('m243:skill'),
    ).length;

    expect(antiPlaybookCount).toBe(2);
    expect(skillCount).toBe(2);
  });
});

// ===========================================================================
// SCENARIO 5 — M241 event-bus: regression:detected enqueues a fix (proposal-only)
//
// Assert emit('regression:detected') dispatches to the built-in handler,
// which calls createGoal (enqueue-only). Destructive primitives must remain
// untouched — this is the SAFETY assertion.
// ===========================================================================

describe('INTEGRATION S5: M241 event-bus — regression:detected enqueues fix goal', () => {
  it('dispatches regression:detected → createGoal called with correct objective', async () => {
    const cfg = makeCfg();
    emit(
      'regression:detected',
      { signal: 'test suite failed on main', repo: '/home/agent/proj' },
      cfg,
    );
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective, opts] = mockCreateGoal.mock.calls[0] as [string, { project?: string | null }];

    expect(objective).toContain('regression');
    expect(objective).toContain('/home/agent/proj');
    expect(objective).toContain('test suite failed on main');
    expect(opts?.project).toBe('/home/agent/proj');
  });

  it('SAFETY: createGoal is called — autoMergeProposal / applyDiff / gitPush are NOT', async () => {
    const cfg = makeCfg();
    emit('regression:detected', { signal: 'broken build', repo: '/r' }, cfg);
    await flush();

    expect(mockCreateGoal).toHaveBeenCalled();
    expect(mockAutoMergeProposal, 'autoMergeProposal must NOT be called').not.toHaveBeenCalled();
    expect(mockApplyDiff, 'applyDiff must NOT be called').not.toHaveBeenCalled();
    expect(mockGitPush, 'gitPush must NOT be called').not.toHaveBeenCalled();
  });

  it('flag-off (eventBus:false) → regression:detected handler does NOT fire', async () => {
    const cfgOff = makeCfg({ eventBus: false });
    emit('regression:detected', { signal: 'oops', repo: '/r' }, cfgOff);
    await flush();

    expect(mockCreateGoal).not.toHaveBeenCalled();
  });

  it('regression:detected with long signal truncates to ≤120 chars in objective', async () => {
    const cfg = makeCfg();
    emit('regression:detected', { signal: 'x'.repeat(200), repo: '/r' }, cfg);
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    const [objective] = mockCreateGoal.mock.calls[0] as [string];
    // The handler slices signal to 120 chars
    const signalPart = objective.split(': ')[1] ?? '';
    expect(signalPart.length).toBeLessThanOrEqual(120);
  });
});

// ===========================================================================
// SCENARIO 6 — COMPOUNDING CONTRACT: recall path (injectOnRun)
//
// Asserts the loop is self-reinforcing:
//  - The genome entries written by M235/M243 are recallable via
//    curateAntiPlaybooks() and curateSkills() — the curation functions used
//    at inject-time (the injectOnRun path).
//  - This proves: if injectOnRun is true, the genome/playbooks the loop
//    wrote ARE available as grounding for a future run.
// ===========================================================================

describe('INTEGRATION S6: COMPOUNDING — written entries are recallable for future runs', () => {
  it('curateAntiPlaybooks returns the anti-playbooks the loop wrote', async () => {
    const cfg = makeCfg();

    learnFromRejection('recall-rej-001', 'Trivial rename', 'noise', 'too trivial', cfg);
    learnFromRejection('recall-rej-002', 'Dangerous drop', 'harmful', 'deletes data', cfg);

    // Now simulate what the injectOnRun path does: read genome hub entries
    // and filter them through the curator.
    const hubEntries = readHubEntries().map((e) => ({
      id: String(e['id']),
      project: (e['project'] as string | null) ?? null,
      source: 'hub' as const,
      title: String(e['title']),
      text: String(e['text']),
      tags: Array.isArray(e['tags']) ? (e['tags'] as string[]) : [],
      ts: String(e['ts']),
    }));

    const recalled = curateAntiPlaybooks(hubEntries);

    // Both anti-playbooks must be present in the recalled set
    expect(recalled.length).toBeGreaterThanOrEqual(2);
    const verdictTags = recalled.flatMap((e) => e.tags.filter((t) => t.startsWith('verdict:')));
    expect(verdictTags).toContain('verdict:noise');
    expect(verdictTags).toContain('verdict:harmful');

    // Total recalled chars must not exceed the inject cap
    const { ANTI_PLAYBOOK_INJECT_CAP } = await import('../src/core/fleet/self-improve.js');
    const total = recalled.reduce((sum, e) => sum + e.title.length + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(ANTI_PLAYBOOK_INJECT_CAP);
  });

  it('curateSkills returns the skills the loop wrote', async () => {
    const cfg = makeCfg();

    learnVerifiedApplied(makeProposal('recall-app-001', 'Fix null pointer in auth', 'claude:claude-opus-4-5'), cfg);
    learnVerifiedApplied(makeProposal('recall-app-002', 'Add rate limiting', 'codex:gpt-5.5'), cfg);

    // Simulate the injectOnRun recall path
    const hubEntries = readHubEntries().map((e) => ({
      id: String(e['id']),
      project: (e['project'] as string | null) ?? null,
      source: 'hub' as const,
      title: String(e['title']),
      text: String(e['text']),
      tags: Array.isArray(e['tags']) ? (e['tags'] as string[]) : [],
      ts: String(e['ts']),
    }));

    const recalled = curateSkills(hubEntries);

    // curateSkills caps at SKILL_INJECT_CAP (800 chars). Two full skill entries
    // combined (~880 chars) may exceed the cap, so at least 1 entry is guaranteed
    // to be recalled; the cap may trim the second.
    expect(recalled.length).toBeGreaterThanOrEqual(1);
    // All recalled entries must carry the m243:skill tag
    for (const e of recalled) {
      expect(e.tags).toContain('m243:skill');
    }

    // Total recalled chars must not exceed the inject cap
    const { SKILL_INJECT_CAP } = await import('../src/core/fleet/skill-library.js');
    const total = recalled.reduce((sum, e) => sum + e.title.length + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(SKILL_INJECT_CAP);
  });

  it('both anti-playbooks AND skills are recallable together from the same genome', async () => {
    const cfg = makeCfg();

    // Write mixed outcomes — exactly what a fleet loop cycle produces
    learnFromRejection('compound-rej-001', 'Trivial rename', 'noise', 'too trivial', cfg);
    learnVerifiedApplied(makeProposal('compound-app-001', 'Fix null pointer', 'claude:claude-opus-4-5'), cfg);

    const hubEntries = readHubEntries().map((e) => ({
      id: String(e['id']),
      project: (e['project'] as string | null) ?? null,
      source: 'hub' as const,
      title: String(e['title']),
      text: String(e['text']),
      tags: Array.isArray(e['tags']) ? (e['tags'] as string[]) : [],
      ts: String(e['ts']),
    }));

    const antiPlaybooks = curateAntiPlaybooks(hubEntries);
    const skills = curateSkills(hubEntries);

    expect(antiPlaybooks.length).toBeGreaterThanOrEqual(1);
    expect(skills.length).toBeGreaterThanOrEqual(1);

    // The two curators must NOT cross-contaminate each other's entries
    const antiPlaybookIds = new Set(antiPlaybooks.map((e) => e.id));
    const skillIds = new Set(skills.map((e) => e.id));
    const overlap = [...antiPlaybookIds].filter((id) => skillIds.has(id));
    expect(overlap).toHaveLength(0); // no entry appears in both sets
  });
});

// ===========================================================================
// SCENARIO 7 — Cross-module wiring: S1 + S2 + S3 together (full-loop smoke)
//
// A single test that exercises the full loop coherently:
//  1. Seed decisions ledger with ship+reject history
//  2. Run M235 for failures + M243 for successes
//  3. Verify M240 scoring reflects the ledger
//  4. Verify genome has both anti-playbooks and skills
//  5. Emit a regression event → createGoal is enqueued
//  6. curateAntiPlaybooks + curateSkills → both recall their respective entries
// ===========================================================================

describe('INTEGRATION S7: full self-improvement loop smoke test', () => {
  it('all four modules are coherently wired across one loop cycle', async () => {
    const cfg = makeCfg();
    const TASK_CLASS = 'issue';
    const N = LEARNED_ROUTING_MIN_SAMPLES + 3;

    // ─── Step 1: Seed decisions ledger ──────────────────────────────────────
    writeLedgerEntries([
      ...Array.from({ length: N }, (_, i) => ({
        proposalId: `test-repo:${TASK_CLASS}:claudeShip${i}`,
        engine: 'claude',
        model: 'opus',
        verdict: 'ship',
        ts: FIXED_ISO,
      })),
      ...Array.from({ length: N }, (_, i) => ({
        proposalId: `test-repo:${TASK_CLASS}:codexReject${i}`,
        engine: 'codex',
        model: 'gpt-5.5',
        verdict: 'harmful',
        ts: FIXED_ISO,
      })),
    ]);

    // ─── Step 2: M240 scores must reflect the seeded ledger ─────────────────
    const scores = buildEngineScores(TASK_CLASS, FIXED_MS);
    const claudeScore = scores.get('claude:opus');
    const codexScore = scores.get('codex:gpt-5.5');

    expect(claudeScore?.score, 'claude must score > 0.5 (high ship rate)').toBeGreaterThan(0.5);
    expect(codexScore?.score, 'codex must score < 0.5 (high reject rate)').toBeLessThan(0.5);

    // ─── Step 3: M235 writes anti-playbooks for failures ─────────────────────
    learnFromRejection('smoke-rej-001', 'Trivial rename', 'noise', 'too trivial', cfg);
    learnFromRejection('smoke-rej-002', 'Dangerous drop', 'harmful', 'deletes prod data', cfg);

    // ─── Step 4: M243 writes skills for successes ────────────────────────────
    learnVerifiedApplied(makeProposal('smoke-app-001', 'Fix null pointer in auth', 'claude:claude-opus-4-5'), cfg);
    learnVerifiedApplied(makeProposal('smoke-app-002', 'Add rate limiting to API', 'codex:gpt-5.5'), cfg);

    // ─── Step 5: genome has both anti-playbooks AND skills ───────────────────
    const rawHub = readHubEntries();
    const antiPlaybooks = rawHub.filter(
      (e) => (e['tags'] as string[]).includes('m235:anti-playbook'),
    );
    const skills = rawHub.filter(
      (e) => (e['tags'] as string[]).includes('m243:skill'),
    );

    expect(antiPlaybooks).toHaveLength(2);
    expect(skills).toHaveLength(2);

    // ─── Step 6: M241 regression event → createGoal enqueued ────────────────
    emit('regression:detected', { signal: 'CI failed on main', repo: '/home/agent/proj' }, cfg);
    await flush();

    expect(mockCreateGoal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockApplyDiff).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();

    // ─── Step 7: COMPOUNDING — recall path returns both kinds of entry ───────
    const hubEntries = rawHub.map((e) => ({
      id: String(e['id']),
      project: (e['project'] as string | null) ?? null,
      source: 'hub' as const,
      title: String(e['title']),
      text: String(e['text']),
      tags: Array.isArray(e['tags']) ? (e['tags'] as string[]) : [],
      ts: String(e['ts']),
    }));

    const recalledAntiPlaybooks = curateAntiPlaybooks(hubEntries);
    const recalledSkills = curateSkills(hubEntries);

    expect(recalledAntiPlaybooks.length, 'anti-playbooks must be recallable (injectOnRun)').toBeGreaterThanOrEqual(1);
    expect(recalledSkills.length, 'skills must be recallable (injectOnRun)').toBeGreaterThanOrEqual(1);

    // The recall results must not cross-contaminate
    const apIds = new Set(recalledAntiPlaybooks.map((e) => e.id));
    const sIds = new Set(recalledSkills.map((e) => e.id));
    expect([...apIds].filter((id) => sIds.has(id))).toHaveLength(0);
  });
});
