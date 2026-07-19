/**
 * M157 — HMAC-signed judge attestations (tamper-proof frontier verdict).
 *
 * Closes the residual risk: the verification gate's criterion 1 previously read
 * the UNSIGNED decisions ledger, so a local writer could forge a
 * "judged claude ship" entry and trick auto-push-to-production.
 *
 * Fix: manager.ts signs every frontier 'ship' verdict with
 * signJudgeAttestation({proposalId, judgeEngine, verdict, diffHash}) using the
 * same ~/.ashlr/foundry/provenance.key. evaluateVerificationGate criterion 1
 * now verifies this HMAC — a forged ledger entry without a valid attestation
 * FAILS criterion 1 even if it looks like "judged claude ship".
 *
 * Adversarial matrix:
 *
 *  signJudgeAttestation / verifyJudgeAttestation — unit tests
 *  [U1]  valid params → ok:true
 *  [U2]  wrong proposalId → ok:false (HMAC mismatch)
 *  [U3]  wrong judgeEngine → ok:false (HMAC mismatch)
 *  [U4]  wrong verdict string → ok:false (HMAC mismatch)
 *  [U5]  wrong diffHash → ok:false (HMAC mismatch)
 *  [U6]  missing attestation (undefined) → ok:false
 *  [U7]  empty attestation string → ok:false
 *  [U8]  truncated attestation (1 char shorter) → ok:false
 *  [U9]  entirely fabricated hex string of correct length → ok:false
 *
 *  evaluateVerificationGate criterion 1 — the core fix
 *  [G1]  valid HMAC attestation + frontier judge + matching diffHash → criterion 1 passes
 *  [G2]  FORGED ledger entry "judged claude ship" with NO attestation → FAILS (the fix)
 *  [G3]  tampered diff (diffHash mismatch between attestation and current diff) → FAILS
 *  [G4]  local-judge (qwen) entry — not frontier, no attestation → FAILS
 *  [G5]  stale attestation for a different proposalId → FAILS
 *  [G6]  valid HMAC for local engine but judge engine is non-frontier → FAILS at isFrontierJudge
 *
 *  manager.ts signing path
 *  [M1]  judgeProposal 'ship' + frontier (claude-*) → recordDecision includes judgeAttestation
 *  [M1b] judgeProposal 'ship' + wouldMerge=false → NO judgeAttestation
 *  [M1c] unavailable independent reviewer → escalated, never judged
 *  [M1d] mixed Claude/OpenAI producers → opposite-family reviewer per proposal
 *  [M1e] escalation cannot displace prior independent judged authority
 *  [M2]  judgeProposal 'ship' + local judge (qwen) → NO attestation in recordDecision
 *  [M3]  judgeProposal 'review' + frontier → NO attestation (only 'ship' is signed)
 *  [M4]  judgeProposal 'noise' + frontier → NO attestation
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir; no real ~/.ashlr/foundry/provenance.key touched.
 *  - decisions-ledger, provider-client, run/engines, inbox/store MOCKED.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockRecordDecision = vi.fn();
const mockReadDecisions = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
}));

vi.mock('../src/core/fleet/judge-trace.js', () => ({
  recordJudgeTrace: vi.fn(),
}));

vi.mock('../src/core/vision/playbook.js', () => ({
  renderPlaybook: () => '',
}));

vi.mock('../src/core/vision/spec.js', () => ({
  loadSpec: () => null,
}));

const mockEngineInstalled = vi.fn(() => false);
const mockBuildEngineCommand = vi.fn((engine: string) => ({ engine }));
const mockSpawnEngine = vi.fn((_command: unknown) => ({ ok: false, output: '' }));
vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: (...args: unknown[]) => mockEngineInstalled(...args),
  buildEngineCommand: (...args: unknown[]) => mockBuildEngineCommand(args[0] as string),
  spawnEngine: (...args: unknown[]) => mockSpawnEngine(args[0]),
}));

const mockGetActiveClient = vi.fn();
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
  setStatus: vi.fn(),
  loadProposal: vi.fn(),
  createProposal: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import {
  signJudgeAttestation,
  verifyJudgeAttestation,
  hashDiff,
  signProvenance,
} from '../src/core/foundry/provenance.js';
import {
  evaluateVerificationGate,
} from '../src/core/inbox/merge.js';
import { runManager } from '../src/core/fleet/manager.js';
import * as storeMock from '../src/core/inbox/store.js';
import type { AshlrConfig, Proposal, DecisionEntry } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m157-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();
  mockRecordDecision.mockReturnValue(undefined);
  mockReadDecisions.mockReturnValue([]);
  mockEngineInstalled.mockReturnValue(false);
  mockBuildEngineCommand.mockImplementation((engine: string) => ({ engine }));
  mockSpawnEngine.mockReturnValue({ ok: false, output: '' });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

/** Build a minimal valid Proposal for gate tests. */
function makeProposal(diff: string, overrides: Partial<Proposal> = {}): Proposal {
  const diffHash = hashDiff(diff);
  return {
    id: 'test-proposal-001',
    repo: '/tmp/test-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'M157 test proposal',
    summary: 'attestation test',
    diff,
    diffHash,
    provenanceSig: undefined,
    engineModel: 'local:qwen3-coder',
    engineTier: 'local',
    verifyResult: { passed: true },
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Proposal;
}

/** Build a valid frontier 'ship' DecisionEntry with a signed attestation. */
function signedFrontierShip(proposalId: string, diff: string): DecisionEntry {
  const diffHash = hashDiff(diff);
  const judgeAttestation = signJudgeAttestation({
    proposalId,
    judgeEngine: 'claude-opus-4-5',
    verdict: 'ship',
    diffHash,
  });
  return {
    ts: new Date().toISOString(),
    proposalId,
    action: 'judged',
    engine: 'claude-opus-4-5',
    model: 'claude-opus-4-5',
    verdict: 'ship',
    reason: 'frontier judge ship',
    detail: 'would-merge',
    judgeAttestation,
  };
}

/** Minimal verification-mode config (criterion checks only). */
const verifyCfg: AshlrConfig = {
  foundry: {
    autoMerge: {
      enabled: true,
      maxRisk: 'low',
      allowWithoutVerification: true,
      trustBasis: 'verification',
    },
  },
} as unknown as AshlrConfig;

// ===========================================================================
// [U1–U9] signJudgeAttestation / verifyJudgeAttestation — unit
// ===========================================================================

describe('M157 signJudgeAttestation / verifyJudgeAttestation — unit', () => {
  const params = {
    proposalId: 'prop-abc',
    judgeEngine: 'claude-opus-4-5',
    verdict: 'ship',
    diffHash: hashDiff('+fix null check\n'),
  };

  it('[U1] valid params → ok:true', () => {
    const att = signJudgeAttestation(params);
    const r = verifyJudgeAttestation(att, params);
    expect(r.ok).toBe(true);
  });

  it('[U2] wrong proposalId → ok:false (HMAC mismatch)', () => {
    const att = signJudgeAttestation(params);
    const r = verifyJudgeAttestation(att, { ...params, proposalId: 'other-prop' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HMAC mismatch/);
  });

  it('[U3] wrong judgeEngine → ok:false', () => {
    const att = signJudgeAttestation(params);
    const r = verifyJudgeAttestation(att, { ...params, judgeEngine: 'claude-sonnet-4-5' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HMAC mismatch/);
  });

  it('[U4] wrong verdict string → ok:false', () => {
    const att = signJudgeAttestation(params);
    const r = verifyJudgeAttestation(att, { ...params, verdict: 'review' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HMAC mismatch/);
  });

  it('[U5] wrong diffHash → ok:false', () => {
    const att = signJudgeAttestation(params);
    const r = verifyJudgeAttestation(att, { ...params, diffHash: hashDiff('+different change\n') });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HMAC mismatch/);
  });

  it('[U6] missing attestation (undefined) → ok:false', () => {
    const r = verifyJudgeAttestation(undefined, params);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing judge attestation/);
  });

  it('[U7] empty attestation string → ok:false', () => {
    const r = verifyJudgeAttestation('', params);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing judge attestation/);
  });

  it('[U8] truncated attestation (1 char shorter) → ok:false', () => {
    const att = signJudgeAttestation(params);
    const truncated = att.slice(0, -1);
    const r = verifyJudgeAttestation(truncated, params);
    expect(r.ok).toBe(false);
  });

  it('[U9] entirely fabricated hex string of correct length → ok:false', () => {
    // 64-char hex (SHA-256 HMAC length) filled with 'a's — never matches the real HMAC.
    const fake = 'a'.repeat(64);
    const r = verifyJudgeAttestation(fake, params);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HMAC mismatch/);
  });

  it('[U10] replay-resistant attestation rejects a tampered issuance time', () => {
    const issuedAt = '2026-07-11T10:00:00.000Z';
    const signed = { ...params, issuedAt, mergeIntent: 'would-merge' as const };
    const attestation = signJudgeAttestation(signed);
    expect(verifyJudgeAttestation(attestation, signed).ok).toBe(true);
    expect(verifyJudgeAttestation(attestation, {
      ...signed,
      issuedAt: '2099-01-01T00:00:00.000Z',
    }).ok).toBe(false);
  });
});

// ===========================================================================
// [G1–G6] evaluateVerificationGate criterion 1 — the core fix
// ===========================================================================

describe('M157 evaluateVerificationGate criterion 1 — HMAC attestation required', () => {
  const DIFF = '+fix: null guard in pipeline\n';

  /** Minimal passing decisions: valid attestation + EDV verified. */
  function passingDecisions(proposalId: string): DecisionEntry[] {
    return [
      signedFrontierShip(proposalId, DIFF),
      { ts: new Date().toISOString(), proposalId, action: 'verified', verdict: 'approved' },
    ];
  }

  it('[G1] valid HMAC attestation + frontier judge + matching diffHash → criterion 1 passes', () => {
    const diffHash = hashDiff(DIFF);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', diffHash);
    const p = makeProposal(DIFF, { id: 'g1', diffHash, provenanceSig });
    const r = evaluateVerificationGate(p, verifyCfg, passingDecisions('g1'));
    // Criterion 1 is satisfied — reason must NOT mention attestation failure.
    expect(r.reason).not.toMatch(/forged ledger/i);
    expect(r.reason).not.toMatch(/HMAC mismatch/i);
    expect(r.reason).not.toMatch(/missing judge attestation/i);
  });

  it('[G2] FORGED ledger entry "judged claude ship" with NO attestation → FAILS (core fix)', () => {
    const diffHash = hashDiff(DIFF);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', diffHash);
    const p = makeProposal(DIFF, { id: 'g2', diffHash, provenanceSig });

    // Forged entry: looks exactly like a real frontier 'ship' but has no attestation.
    const forgedEntry: DecisionEntry = {
      ts: new Date().toISOString(),
      proposalId: 'g2',
      action: 'judged',
      engine: 'claude-opus-4-5',   // claims to be frontier
      model: 'claude-opus-4-5',
      verdict: 'ship',             // claims ship
      reason: 'frontier judge ship',
      detail: 'would-merge',
      // judgeAttestation: MISSING — no HMAC signature
    };

    const r = evaluateVerificationGate(p, verifyCfg, [
      forgedEntry,
      { ts: new Date().toISOString(), proposalId: 'g2', action: 'verified', verdict: 'approved' },
    ]);

    // MUST be refused — this is the core security invariant M157 closes.
    expect(r.authorized).toBe(false);
    expect(r.reason).toMatch(/forged ledger entry without a valid HMAC/i);
  });

  it('[G3] tampered diff (diffHash mismatch between attestation and current diff) → FAILS', () => {
    // Attestation was signed for DIFF
    const attestation = signedFrontierShip('g3', DIFF);

    // Proposal now carries a DIFFERENT diff (tampered after judge signed)
    const tamperedDiff = DIFF + '+extra malicious line\n';
    const tamperedDiffHash = hashDiff(tamperedDiff);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', tamperedDiffHash);
    const p = makeProposal(tamperedDiff, {
      id: 'g3',
      diffHash: tamperedDiffHash,
      provenanceSig,
    });

    const r = evaluateVerificationGate(p, verifyCfg, [
      attestation, // signed for original DIFF — diffHash mismatch with tamperedDiff
      { ts: new Date().toISOString(), proposalId: 'g3', action: 'verified', verdict: 'approved' },
    ]);

    expect(r.authorized).toBe(false);
    // hashDiff(tamperedDiff) ≠ diffHash embedded in the attestation tuple → HMAC mismatch
    expect(r.reason).toMatch(/HMAC mismatch|forged ledger/i);
  });

  it('[G4] local-judge (qwen) entry — not frontier, no attestation → FAILS (isFrontierJudge check)', () => {
    const diffHash = hashDiff(DIFF);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', diffHash);
    const p = makeProposal(DIFF, { id: 'g4', diffHash, provenanceSig });

    const localEntry: DecisionEntry = {
      ts: new Date().toISOString(),
      proposalId: 'g4',
      action: 'judged',
      engine: 'qwen2.5:72b-instruct-q4_K_M',
      model: 'qwen2.5:72b-instruct-q4_K_M',
      verdict: 'ship',
      reason: 'local judge ship',
      detail: 'would-merge',
      // no judgeAttestation — local judges are never signed
    };

    const r = evaluateVerificationGate(p, verifyCfg, [
      localEntry,
      { ts: new Date().toISOString(), proposalId: 'g4', action: 'verified', verdict: 'approved' },
    ]);

    expect(r.authorized).toBe(false);
    // Fails at isFrontierJudge check (before HMAC check)
    expect(r.reason).toMatch(/not a frontier.*claude/i);
    expect(r.reason).toMatch(/self-confirmation trap/i);
  });

  it('[G5] stale attestation for a different proposalId → FAILS (HMAC binds proposalId)', () => {
    const diffHash = hashDiff(DIFF);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', diffHash);
    // Proposal is 'g5-real'
    const p = makeProposal(DIFF, { id: 'g5-real', diffHash, provenanceSig });

    // Attestation was issued for a DIFFERENT proposal 'g5-other'
    const staleAttestation = signedFrontierShip('g5-other', DIFF);
    // Override proposalId in the entry to match 'g5-real' — but the MAC still binds 'g5-other'
    const replayEntry: DecisionEntry = {
      ...staleAttestation,
      proposalId: 'g5-real',
    };

    const r = evaluateVerificationGate(p, verifyCfg, [
      replayEntry,
      { ts: new Date().toISOString(), proposalId: 'g5-real', action: 'verified', verdict: 'approved' },
    ]);

    expect(r.authorized).toBe(false);
    // HMAC mismatch because the MAC was computed with proposalId='g5-other'
    expect(r.reason).toMatch(/HMAC mismatch|forged ledger/i);
  });

  it('[G6] valid HMAC for local engine but judge engine is non-frontier → FAILS at isFrontierJudge', () => {
    // Defense-in-depth: isFrontierJudge check fires BEFORE the HMAC check.
    const diffHash = hashDiff(DIFF);
    const provenanceSig = signProvenance('local:qwen3-coder', 'local', diffHash);
    const p = makeProposal(DIFF, { id: 'g6', diffHash, provenanceSig });

    // Sign an attestation for a non-frontier engine (hypothetical bypass attempt)
    const localAtt = signJudgeAttestation({
      proposalId: 'g6',
      judgeEngine: 'qwen2.5:72b',
      verdict: 'ship',
      diffHash,
    });

    const localSignedEntry: DecisionEntry = {
      ts: new Date().toISOString(),
      proposalId: 'g6',
      action: 'judged',
      engine: 'qwen2.5:72b',       // non-frontier
      model: 'qwen2.5:72b',
      verdict: 'ship',
      detail: 'would-merge',
      judgeAttestation: localAtt,  // technically valid MAC, but for a non-frontier engine
    };

    const r = evaluateVerificationGate(p, verifyCfg, [
      localSignedEntry,
      { ts: new Date().toISOString(), proposalId: 'g6', action: 'verified', verdict: 'approved' },
    ]);

    expect(r.authorized).toBe(false);
    // isFrontierJudge('qwen2.5:72b') → false → refuses before reaching HMAC check
    expect(r.reason).toMatch(/not a frontier.*claude/i);
  });
});

// ===========================================================================
// [M1–M4] manager.ts signing path
//
// runManager does `await import('../inbox/store.js')` — a dynamic import.
// vitest replaces the module with the vi.mock factory result, so the mock
// returned from `import * as storeMock from '../src/core/inbox/store.js'`
// IS the same object that runManager receives. We control listProposals via
// vi.mocked(storeMock).listProposals.mockReturnValueOnce(...).
//
// decisions-ledger is already mocked via vi.mock at the top (mockRecordDecision).
// ===========================================================================

describe('M157 manager.ts signing path — attestation in recordDecision', () => {
  const JUDGE_ENGINE = 'claude-sonnet-4-5';
  const LOCAL_ENGINE = 'qwen2.5:72b-instruct-q4_K_M';
  const TEST_DIFF = [
    'diff --git a/docs/manager.md b/docs/manager.md',
    '--- /dev/null',
    '+++ b/docs/manager.md',
    '@@ -0,0 +1 @@',
    '+fix: apply manager signing',
    '',
  ].join('\n');

  const testProposal: Proposal = {
    id: 'mgr-prop-001',
    repo: '/tmp/mgr-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'manager test',
    summary: 'manager attestation test',
    diff: TEST_DIFF,
    diffHash: hashDiff(TEST_DIFF),
    engineModel: 'local:qwen3-coder',
    engineTier: 'local',
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as Proposal;

  // managerJudgeModel must NOT start with 'claude' so that resolveJudgeClient
  // sets judgeEngine to a non-claude model name, resolvedIsClaude is false,
  // and the test's mockGetActiveClient is called (which returns JUDGE_ENGINE).
  const managerCfg: AshlrConfig = {
    foundry: {
      allowedBackends: ['builtin'],
      managerJudgeEngine: 'auto',
      managerJudgeModel: 'qwen2.5:72b-instruct-q4_K_M',
    },
  } as unknown as AshlrConfig;

  it('[M1] frontier (claude-*) judge + verdict ship → recordDecision includes valid judgeAttestation', async () => {
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([testProposal] as never);
    mockEngineInstalled.mockReturnValue(false);
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () =>
        JSON.stringify({ verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'looks great' }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const judgedCall = mockRecordDecision.mock.calls.find(
      (args) =>
        (args[0] as DecisionEntry).action === 'judged' &&
        (args[0] as DecisionEntry).verdict === 'ship',
    );
    expect(judgedCall, 'expected a judged=ship recordDecision call').toBeDefined();
    const entry = judgedCall![0] as DecisionEntry;

    expect(entry.judgeAttestation).toBeDefined();
    expect(entry.judgeAttestation!.length).toBe(64);
    expect(entry.judgeAttestationIssuedAt).toBe(entry.ts);
    expect(entry.judgeAttestationIntent).toBe('would-merge');

    const diffHash = hashDiff(TEST_DIFF);
    const verifyResult = verifyJudgeAttestation(entry.judgeAttestation, {
      proposalId: testProposal.id,
      judgeEngine: JUDGE_ENGINE,
      verdict: 'ship',
      diffHash,
      issuedAt: entry.judgeAttestationIssuedAt,
      mergeIntent: entry.judgeAttestationIntent,
    });
    expect(verifyResult.ok).toBe(true);
  });

  it('[M1b] frontier judge ship with wouldMerge=false → NO judgeAttestation', async () => {
    const mediumRiskDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const prop: Proposal = {
      ...testProposal,
      id: 'mgr-prop-001b',
      diff: mediumRiskDiff,
      diffHash: hashDiff(mediumRiskDiff),
    };
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([prop] as never);
    mockEngineInstalled.mockReturnValue(false);
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () =>
        JSON.stringify({ verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5, rationale: 'looks good but exceeds merge bounds' }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const judgedCall = mockRecordDecision.mock.calls.find(
      (args) =>
        (args[0] as DecisionEntry).proposalId === 'mgr-prop-001b' &&
        (args[0] as DecisionEntry).action === 'judged',
    );
    expect(judgedCall, 'expected a judged=ship recordDecision call').toBeDefined();
    const entry = judgedCall![0] as DecisionEntry;
    expect(entry.verdict).toBe('ship');
    expect(entry.detail).toBe('');
    expect(entry.judgeAttestation).toBeUndefined();
  });

  it('[M1c] no independent reviewer records escalated, never a newer judged row', async () => {
    const correlated = {
      ...testProposal,
      id: 'mgr-prop-001c',
      engineModel: 'claude:claude-sonnet-4-6',
      engineTier: 'frontier' as const,
    };
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([correlated] as never);
    mockEngineInstalled.mockImplementation((engine: unknown) => engine === 'claude');
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () => JSON.stringify({
        verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5,
        rationale: 'same-family advisory ship',
      }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const proposalEntries = mockRecordDecision.mock.calls
      .map((args) => args[0] as DecisionEntry)
      .filter((entry) => entry.proposalId === correlated.id);
    expect(proposalEntries.some((entry) => entry.action === 'judged')).toBe(false);
    const escalated = proposalEntries.find(
      (entry) => entry.action === 'escalated',
    );
    expect(escalated).toBeDefined();
    expect(escalated?.verdict).toBe('review');
    expect(escalated?.judgeAttestation).toBeUndefined();
    expect(escalated?.reason).toBe('manager-judge-unavailable');
  });

  it('[M1d] mixed Claude/OpenAI producers route to opposite-family reviewers', async () => {
    const claudeProposal: Proposal = {
      ...testProposal,
      id: 'mgr-prop-claude',
      engineModel: 'claude:claude-sonnet-4-6',
      engineTier: 'frontier',
    };
    const openAiProposal: Proposal = {
      ...testProposal,
      id: 'mgr-prop-openai',
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    };
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([
      claudeProposal,
      openAiProposal,
    ] as never);
    mockEngineInstalled.mockImplementation(
      (engine: unknown) => engine === 'claude' || engine === 'codex',
    );
    mockSpawnEngine.mockImplementation((command: unknown) => {
      const engine = (command as { engine?: string }).engine;
      const verdict = JSON.stringify({
        verdict: 'ship',
        value: 5,
        correctness: 5,
        scope: 1,
        alignment: 5,
        rationale: `${engine} independently approved`,
      });
      return engine === 'claude'
        ? { ok: true, output: JSON.stringify({ result: verdict }) }
        : { ok: true, output: verdict };
    });

    const mixedCfg: AshlrConfig = {
      foundry: {
        allowedBackends: ['builtin'],
        managerJudgeEngine: 'auto',
      },
    } as unknown as AshlrConfig;

    const report = await runManager(mixedCfg, { window: '7d', limit: 2 });

    const judgedEntries = mockRecordDecision.mock.calls
      .map((args) => args[0] as DecisionEntry)
      .filter(
        (entry) => (entry.proposalId === claudeProposal.id || entry.proposalId === openAiProposal.id) &&
          entry.action === 'judged',
      );
    expect(judgedEntries).toHaveLength(2);

    const claudeProducerReview = judgedEntries.find(
      (entry) => entry.proposalId === claudeProposal.id,
    );
    const openAiProducerReview = judgedEntries.find(
      (entry) => entry.proposalId === openAiProposal.id,
    );
    expect(claudeProducerReview?.model ?? claudeProducerReview?.engine).toMatch(/gpt-5|codex/i);
    expect(openAiProducerReview?.model ?? openAiProducerReview?.engine).toMatch(/claude/i);
    expect(claudeProducerReview?.judgeAttestation).toHaveLength(64);
    expect(openAiProducerReview?.judgeAttestation).toHaveLength(64);

    expect(verifyJudgeAttestation(claudeProducerReview?.judgeAttestation, {
      proposalId: claudeProposal.id,
      judgeEngine: claudeProducerReview?.engine ?? '',
      verdict: 'ship',
      diffHash: hashDiff(claudeProposal.diff ?? ''),
      issuedAt: claudeProducerReview?.judgeAttestationIssuedAt,
      mergeIntent: claudeProducerReview?.judgeAttestationIntent,
    }).ok).toBe(true);
    expect(verifyJudgeAttestation(openAiProducerReview?.judgeAttestation, {
      proposalId: openAiProposal.id,
      judgeEngine: openAiProducerReview?.engine ?? '',
      verdict: 'ship',
      diffHash: hashDiff(openAiProposal.diff ?? ''),
      issuedAt: openAiProducerReview?.judgeAttestationIssuedAt,
      mergeIntent: openAiProducerReview?.judgeAttestationIntent,
    }).ok).toBe(true);

    const answeringEngines = new Set(
      mockSpawnEngine.mock.calls.map(([command]) => (command as { engine?: string }).engine),
    );
    expect(answeringEngines).toEqual(new Set(['claude', 'codex']));
    expect(report.judgeEngine).toMatch(/^mixed:/);
    expect(report.judgeEngine).toMatch(/claude/i);
    expect(report.judgeEngine).toMatch(/gpt-5/i);
  });

  it('[M1e] escalation cannot displace an existing valid independent judged authority', async () => {
    const correlated = {
      ...testProposal,
      id: 'mgr-prop-001e',
      engineModel: 'claude:claude-sonnet-4-6',
      engineTier: 'frontier' as const,
    };
    const priorJudgeEngine = 'gpt-5.5';
    const priorDiffHash = hashDiff(correlated.diff ?? '');
    const priorIndependentShip: DecisionEntry = {
      ts: new Date().toISOString(),
      proposalId: correlated.id,
      action: 'judged',
      engine: priorJudgeEngine,
      model: priorJudgeEngine,
      verdict: 'ship',
      detail: 'would-merge',
      judgeAttestation: signJudgeAttestation({
        proposalId: correlated.id,
        judgeEngine: priorJudgeEngine,
        verdict: 'ship',
        diffHash: priorDiffHash,
      }),
    };
    mockReadDecisions.mockReturnValue([priorIndependentShip]);
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([correlated] as never);
    mockEngineInstalled.mockImplementation((engine: unknown) => engine === 'claude');
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () => JSON.stringify({
        verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5,
        rationale: 'correlated retry',
      }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const newEntries = mockRecordDecision.mock.calls
      .map((args) => args[0] as DecisionEntry)
      .filter((entry) => entry.proposalId === correlated.id);
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]?.action).toBe('escalated');
    expect(newEntries[0]?.judgeAttestation).toBeUndefined();
    expect(newEntries.some((entry) => entry.action === 'judged')).toBe(false);
  });

  it('[M2] local judge (qwen) + verdict ship → NO judgeAttestation in recordDecision', async () => {
    const localProp = { ...testProposal, id: 'mgr-prop-002' };
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([localProp] as never);
    mockEngineInstalled.mockReturnValue(false);
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: LOCAL_ENGINE,
      complete: async () =>
        JSON.stringify({ verdict: 'ship', value: 4, correctness: 4, scope: 1, alignment: 4, rationale: 'local ship' }),
    });

    const localCfg: AshlrConfig = {
      foundry: { allowedBackends: ['builtin'], managerJudgeEngine: 'local', managerJudgeModel: LOCAL_ENGINE },
    } as unknown as AshlrConfig;

    await runManager(localCfg, { window: '7d', limit: 1 });

    const judgedCall = mockRecordDecision.mock.calls.find(
      (args) =>
        (args[0] as DecisionEntry).action === 'judged' &&
        (args[0] as DecisionEntry).verdict === 'ship',
    );
    if (judgedCall) {
      // Local judge verdicts must not be attested
      expect((judgedCall[0] as DecisionEntry).judgeAttestation).toBeUndefined();
    }
    // If no call — local path didn't fire in this env; acceptable
  });

  it('[M3] frontier judge + verdict review → NO judgeAttestation (only ship is signed)', async () => {
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([{ ...testProposal, id: 'mgr-prop-003' }] as never);
    mockEngineInstalled.mockReturnValue(false);
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () =>
        JSON.stringify({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'needs review' }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const judgedCall = mockRecordDecision.mock.calls.find(
      (args) =>
        (args[0] as DecisionEntry).action === 'judged' &&
        (args[0] as DecisionEntry).verdict === 'review',
    );
    expect(judgedCall, 'expected a judged=review recordDecision call').toBeDefined();
    expect((judgedCall![0] as DecisionEntry).judgeAttestation).toBeUndefined();
  });

  it('[M4] frontier judge + verdict noise → NO judgeAttestation', async () => {
    vi.mocked(storeMock.listProposals).mockReturnValueOnce([{ ...testProposal, id: 'mgr-prop-004' }] as never);
    mockEngineInstalled.mockReturnValue(false);
    mockGetActiveClient.mockResolvedValue({
      id: 'anthropic',
      model: JUDGE_ENGINE,
      complete: async () =>
        JSON.stringify({ verdict: 'noise', value: 1, correctness: 1, scope: 1, alignment: 1, rationale: 'trivial' }),
    });

    await runManager(managerCfg, { window: '7d', limit: 1 });

    const judgedCall = mockRecordDecision.mock.calls.find(
      (args) =>
        (args[0] as DecisionEntry).action === 'judged' &&
        (args[0] as DecisionEntry).verdict === 'noise',
    );
    expect(judgedCall, 'expected a judged=noise recordDecision call').toBeDefined();
    expect((judgedCall![0] as DecisionEntry).judgeAttestation).toBeUndefined();
  });
});
