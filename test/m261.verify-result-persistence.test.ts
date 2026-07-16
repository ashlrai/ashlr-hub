/**
 * M261 — verifyResult persistence in autoMergeProposal (Gate 6).
 *
 * DIAGNOSIS (Blocker 5): under trustBasis='verification', evaluateVerificationGate
 * Criterion 2 requires proposal.verifyResult.passed === true. verifyProposal()
 * ran real tests in a worktree but NEVER persisted the result back to the
 * proposal store. So evaluateVerificationGate always saw verifyResult: absent
 * → REFUSED even for legitimately-verified proposals.
 *
 * FIX (M261): after Gate 6 runs verifyProposal(), autoMergeProposal now calls
 * updateProposalField({ verifyResult: { passed: verify.ok, ... } }) to persist
 * the genuine result before returning. evaluateVerificationGate Criterion 2
 * can then read the real value.
 *
 * TEST CONTRACTS:
 *   1. LEGIT-VERIFIED → verifyResult.passed=true persisted → gate Criterion 2 passes
 *   2. FAILED-VERIFY  → verifyResult.passed=false persisted → gate refuses correctly
 *   3. NEVER-FABRICATED → result always equals verify.ok from the test runner
 *   4. NO-REGRESSION → other gate criteria still enforced with verifyResult present
 *
 * SAFETY:
 *   verifyResult is set exclusively from verifyProposal()'s return value.
 *   A persistence failure leaves verifyResult absent → gate refuses (fail-closed).
 *   All other evaluateVerificationGate criteria (judge ship, HMAC, EDV,
 *   provenance, scope, risk) remain untouched.
 *
 * HERMETICITY:
 *   - HOME isolated to a tmp dir.
 *   - verifyProposal's external deps (isRepo, detectVerifyCommands,
 *     runVerifyCommand, execFileSync for git) are mocked so no real worktree,
 *     git, or test runner executes. verifyProposal itself runs real code — the
 *     mock is at the dependency boundary, not the function boundary.
 *   - updateProposalField is spied via the store mock to assert result origin.
 *   - evaluateVerificationGate runs real so its criteria are actually exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures these are initialised BEFORE vi.mock
// factories run (vi.mock calls are hoisted to the top of the file by Vitest;
// plain vi.fn() declarations at module scope are NOT hoisted with them and
// would be undefined inside the factory closures).
// ---------------------------------------------------------------------------

const {
  mockUpdateProposalField,
  mockLoadProposal,
  mockSetStatus,
  mockIsRepo,
  mockDefaultBranch,
  mockGetGitStatus,
  mockGetRemoteOrg,
  mockExecFileSync,
  mockDetectVerifyCommands,
  mockRunVerifyCommand,
  mockReadDecisions,
  mockRecordDecision,
} = vi.hoisted(() => ({
  mockUpdateProposalField: vi.fn(),
  mockLoadProposal: vi.fn(),
  mockSetStatus: vi.fn(),
  mockIsRepo: vi.fn(() => true),
  mockDefaultBranch: vi.fn(() => 'main'),
  mockGetGitStatus: vi.fn(() => ({ clean: true, staged: [], unstaged: [] })),
  mockGetRemoteOrg: vi.fn(() => null),
  mockExecFileSync: vi.fn(() => 'abc1234'),
  mockDetectVerifyCommands: vi.fn(),
  mockRunVerifyCommand: vi.fn(),
  mockReadDecisions: vi.fn(() => [] as unknown[]),
  mockRecordDecision: vi.fn(),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: (...a: unknown[]) => mockLoadProposal(...a),
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
  updateProposalField: (...a: unknown[]) => mockUpdateProposalField(...a),
  inboxDir: () => path.join(process.env.HOME ?? os.tmpdir(), '.ashlr', 'inbox'),
}));

vi.mock('../src/core/git.js', () => ({
  isRepo: (...a: unknown[]) => mockIsRepo(...a),
  defaultBranch: (...a: unknown[]) => mockDefaultBranch(...a),
  getGitStatus: (...a: unknown[]) => mockGetGitStatus(...a),
  getRemoteOrg: (...a: unknown[]) => mockGetRemoteOrg(...a),
  resolveGitHubOriginAuthorityDetails: () => null,
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => mockExecFileSync(...a),
  execSync: vi.fn(() => Buffer.from('')),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
}));

vi.mock('../src/core/run/verify-commands.js', () => ({
  detectVerifyCommands: (...a: unknown[]) => mockDetectVerifyCommands(...a),
  runVerifyCommand: (...a: unknown[]) => mockRunVerifyCommand(...a),
  runVerifyCommandAsync: async (...a: unknown[]) => mockRunVerifyCommand(...a),
}));

// diff-safety.js — never destructive.
vi.mock('../src/core/run/diff-safety.js', () => ({
  isDestructiveDiff: () => ({ destructive: false }),
}));

// fleet/self.js — no self-target behaviour.
vi.mock('../src/core/fleet/self.js', () => ({
  isSelfTargetProposal: () => false,
  guardSafetyTests: () => ({ weakened: false }),
  selfEvalParity: () => ({ ok: true, reason: 'mock parity' }),
  selfEvalParityAsync: async () => ({ ok: true, reason: 'mock parity' }),
}));

// kill-switch + enrollment.
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => false,
  isEnrolled: () => true,
  assertMayMutate: () => { /* bypass */ },
}));

// decisions-ledger — controlled per test (mocks are in vi.hoisted above).
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...a: unknown[]) => mockReadDecisions(...a),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));

// provenance — always valid (Criterion 5 passes).
vi.mock('../src/core/foundry/provenance.js', () => ({
  verifyProvenance: () => ({ ok: true, reason: 'mock-valid' }),
  hashDiff: (d: string) => (d ? d.slice(0, 8) : 'mockhash'),
  signJudgeAttestation: () => 'mock-attestation',
  verifyJudgeAttestation: () => ({ ok: true }),
}));

// EDV — always confirmed (Criterion 4 passes).
vi.mock('../src/core/portfolio/edv-verify.js', () => ({
  edvConfirmationWeight: () => ({ confirmed: true, weight: 1.0, source: 'mock-edv' }),
}));

// audit + telemetry — no-op.
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/integrations/pulse-sync.js', () => ({
  emitFleetEvent: async () => {},
  pulseSyncEnabled: () => false,
}));
vi.mock('../src/core/fleet/judge-trace.js', () => ({ linkOutcome: vi.fn() }));
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: () => [],
  updateMilestoneStatus: vi.fn(),
}));
vi.mock('../src/core/knowledge/index.js', () => ({
  scrubSecrets: (s: string) => s,
}));
vi.mock('../src/core/integrations/github.js', () => ({
  createPr: async () => ({ number: 1, url: 'https://github.com/mock/pr/1' }),
}));
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: vi.fn(async () => ({ verdict: 'ship', wouldMerge: true, rationale: 'mock' })),
  resolveFrontierJudgeClient: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after all mocks are registered
// ---------------------------------------------------------------------------

let autoMergeProposal: typeof import('../src/core/inbox/merge.js').autoMergeProposal;
let evaluateVerificationGate: typeof import('../src/core/inbox/merge.js').evaluateVerificationGate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A low-risk diff: touches only a .md file so classifyRisk → 'low'.
 * Used for tests that need risk=low to pass evaluateVerificationGate Criterion 3.
 * The autoMergeProposal path uses this too — verifyProposal sees it as a valid diff.
 */
const SMALL_DIFF = [
  'diff --git a/docs/CHANGES.md b/docs/CHANGES.md',
  'index 0000000..1111111 100644',
  '--- a/docs/CHANGES.md',
  '+++ b/docs/CHANGES.md',
  '@@ -1,2 +1,3 @@',
  ' # Changes',
  '+- M261: fix verifyResult persistence',
  ' ',
].join('\n');

function makeProposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    repo: '/tmp/fake-repo',
    origin: 'swarm',
    kind: 'patch',
    title: 'M261 test proposal',
    summary: 'Fix something small',
    diff: SMALL_DIFF,
    status: 'pending',
    engineTier: 'frontier',
    engineModel: 'codex:gpt-5.5',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Decisions-ledger entry: frontier 'ship' with mocked HMAC attestation. */
function makeShipDecision(proposalId: string) {
  return {
    ts: new Date().toISOString(),
    proposalId,
    action: 'judged' as const,
    verdict: 'ship',
    engine: 'claude-sonnet-4-5',
    model: 'claude-sonnet-4-5',
    judgeAttestation: 'mock-attestation',
    reason: 'looks good',
    detail: 'would-merge',
  };
}

function verificationCfg(): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: {
        enabled: true,
        trustBasis: 'verification' as unknown as never,
        maxRisk: 'low' as unknown as never,
        maxAutomergeFiles: 4,
        maxAutomergeLines: 150,
      },
      mergeAuthority: [{ engine: 'claude', model: 'claude-sonnet-4-5' }],
    },
  } as unknown as AshlrConfig;
}

/** Filter updateProposalField calls that wrote a verifyResult field. */
function verifyResultWrites() {
  return mockUpdateProposalField.mock.calls.filter(
    (call) => call[1] != null && typeof call[1] === 'object' && 'verifyResult' in call[1],
  );
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m261-home-'));
  process.env.HOME = tmpHome;

  mockUpdateProposalField.mockReset();
  mockUpdateProposalField.mockReturnValue(true);
  mockLoadProposal.mockReset();
  mockSetStatus.mockReset();
  mockReadDecisions.mockReset();
  mockReadDecisions.mockReturnValue([]);
  mockRecordDecision.mockReset();
  mockIsRepo.mockReset();
  mockIsRepo.mockReturnValue(true);
  mockDefaultBranch.mockReset();
  mockDefaultBranch.mockReturnValue('main');
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue('abc1234');
  mockDetectVerifyCommands.mockReset();
  mockRunVerifyCommand.mockReset();

  const m = await import('../src/core/inbox/merge.js');
  autoMergeProposal = m.autoMergeProposal;
  evaluateVerificationGate = m.evaluateVerificationGate;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// CONTRACT 1 — LEGIT-VERIFIED: verifyResult.passed=true persisted, gate passes
// ===========================================================================

describe('M261 Contract 1 — legit-verified: verifyResult persisted, Criterion 2 clears', () => {
  it('persists verifyResult.passed=true when the test runner passes', async () => {
    const proposal = makeProposal('prop-m261-c1-a');
    mockLoadProposal.mockReturnValue(proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);

    // Test runner: one typecheck command passes.
    const cmd = { kind: 'typecheck' as const, command: 'tsc --noEmit' };
    mockDetectVerifyCommands.mockReturnValue([cmd]);
    mockRunVerifyCommand.mockReturnValue({ ok: true, exitCode: 0 });

    await autoMergeProposal(proposal.id, verificationCfg());

    const writes = verifyResultWrites();
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0][1].verifyResult.passed).toBe(true);
    expect(writes[0][1].verifyResult.failed).toBeUndefined();
  });

  it('evaluateVerificationGate Criterion 2 returns authorized:true with verifyResult.passed=true', () => {
    const proposal = makeProposal('prop-m261-c1-b', { verifyResult: { passed: true } });
    const decisions = [makeShipDecision(proposal.id)];

    const result = evaluateVerificationGate(proposal, verificationCfg(), decisions);

    expect(result.authorized).toBe(true);
    expect(result.reason).toContain('suite green');
  });
});

// ===========================================================================
// CONTRACT 2 — FAILED-VERIFY: verifyResult.passed=false persisted, gate refuses
// ===========================================================================

describe('M261 Contract 2 — failed-verify: verifyResult.passed=false persisted, gate refuses', () => {
  it('persists verifyResult.passed=false with failure detail when tests fail', async () => {
    const proposal = makeProposal('prop-m261-c2-a');
    mockLoadProposal.mockReturnValue(proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);

    // Test runner: typecheck fails.
    const cmd = { kind: 'typecheck' as const, command: 'tsc --noEmit' };
    mockDetectVerifyCommands.mockReturnValue([cmd]);
    mockRunVerifyCommand.mockReturnValue({ ok: false, exitCode: 1 });

    const result = await autoMergeProposal(proposal.id, verificationCfg());

    // Gate 6 fails → autoMergeProposal refuses.
    expect(result.merged).toBe(false);
    expect(result.reason).toContain('verification failed');

    const writes = verifyResultWrites();
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0][1].verifyResult.passed).toBe(false);
    expect(Array.isArray(writes[0][1].verifyResult.failed)).toBe(true);
    expect(writes[0][1].verifyResult.failed.length).toBeGreaterThan(0);
  });

  it('evaluateVerificationGate Criterion 2 refuses when verifyResult.passed=false', () => {
    const proposal = makeProposal('prop-m261-c2-b', {
      verifyResult: { passed: false, failed: ['tsc failed'] },
    });
    const decisions = [makeShipDecision(proposal.id)];
    const result = evaluateVerificationGate(proposal, verificationCfg(), decisions);

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('verifyResult.passed is false');
  });

  it('evaluateVerificationGate Criterion 2 refuses when verifyResult is absent (pre-M261 state)', () => {
    const proposal = makeProposal('prop-m261-c2-c');
    // verifyResult intentionally absent — the pre-M261 state for every proposal.
    const decisions = [makeShipDecision(proposal.id)];
    const result = evaluateVerificationGate(proposal, verificationCfg(), decisions);

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('verifyResult.passed is absent');
  });
});

// ===========================================================================
// CONTRACT 3 — NEVER-FABRICATED: result always comes from the test runner
// ===========================================================================

describe('M261 Contract 3 — never-fabricated: verifyResult origin is the test runner', () => {
  it('refuses when proposal status changes while fresh verification is being persisted', async () => {
    const proposal = makeProposal('prop-m261-race');
    mockLoadProposal.mockImplementation(() => proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);
    mockDetectVerifyCommands.mockReturnValue([{ kind: 'test', command: 'vitest run' }]);
    mockRunVerifyCommand.mockReturnValue({ ok: true, exitCode: 0 });
    mockUpdateProposalField.mockImplementation((_id, patch) => {
      proposal.verifyResult = (patch as { verifyResult: Proposal['verifyResult'] }).verifyResult;
      proposal.status = 'rejected';
      return true;
    });

    const result = await autoMergeProposal(proposal.id, verificationCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/proposal status 'rejected' has no active merge authority/);
  });

  it('refuses when durable verification changes after verification-mode evaluation begins', async () => {
    const initial = makeProposal('prop-m261-verify-race');
    let durable = structuredClone(initial);
    mockLoadProposal.mockImplementation(() => structuredClone(durable));
    mockDetectVerifyCommands.mockReturnValue([{ kind: 'test', command: 'vitest run' }]);
    mockRunVerifyCommand.mockReturnValue({ ok: true, exitCode: 0 });
    mockUpdateProposalField.mockImplementation((_id, patch) => {
      durable = { ...durable, ...structuredClone(patch as Partial<Proposal>) };
      return true;
    });
    mockReadDecisions.mockImplementation(() => {
      durable.verifyResult = {
        ...durable.verifyResult!,
        passed: false,
        failed: ['concurrent verifier failed'],
        verifiedAt: new Date(Date.now() + 1_000).toISOString(),
      };
      return [makeShipDecision(initial.id)];
    });

    const result = await autoMergeProposal(initial.id, verificationCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/verification binding changed during merge evaluation/);
  });

  it('does NOT write verifyResult when Gate 6 is never reached (no repo)', async () => {
    // repo=undefined → refused at Gate 2 before Gate 6.
    const proposal = makeProposal('prop-m261-c3-a', { repo: undefined as unknown as string });
    mockLoadProposal.mockReturnValue(proposal);

    await autoMergeProposal(proposal.id, verificationCfg());

    expect(mockDetectVerifyCommands).not.toHaveBeenCalled();
    expect(verifyResultWrites().length).toBe(0);
  });

  it('verifyResult.passed equals the actual test runner outcome (not hardcoded)', async () => {
    const proposal = makeProposal('prop-m261-c3-b');
    mockLoadProposal.mockReturnValue(proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);

    const cmd = { kind: 'test' as const, command: 'vitest run' };
    mockDetectVerifyCommands.mockReturnValue([cmd]);
    mockRunVerifyCommand.mockReturnValue({ ok: true, exitCode: 0 });

    await autoMergeProposal(proposal.id, verificationCfg());

    const writes = verifyResultWrites();
    expect(writes.length).toBeGreaterThanOrEqual(1);
    // Value is true because the runner returned ok:true — not hardcoded.
    // Contract 2 above verifies the ok:false direction.
    expect(writes[0][1].verifyResult.passed).toBe(true);
  });

  it('fail-closed on verify failure even when persistence throws', async () => {
    const proposal = makeProposal('prop-m261-c3-c');
    mockLoadProposal.mockReturnValue(proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);

    const cmd = { kind: 'typecheck' as const, command: 'tsc --noEmit' };
    mockDetectVerifyCommands.mockReturnValue([cmd]);
    mockRunVerifyCommand.mockReturnValue({ ok: false, exitCode: 1 });

    // Persistence throws — must not convert failure into pass.
    mockUpdateProposalField.mockImplementation(() => { throw new Error('disk full'); });

    const result = await autoMergeProposal(proposal.id, verificationCfg());
    expect(result.merged).toBe(false);
    expect(result.reason).toContain('verification failed');
  });

  it('fail-closed on passing verify when persistence throws (verifyResult stays absent)', async () => {
    const proposal = makeProposal('prop-m261-c3-d');
    mockLoadProposal.mockReturnValue(proposal);
    mockReadDecisions.mockReturnValue([makeShipDecision(proposal.id)]);

    const cmd = { kind: 'typecheck' as const, command: 'tsc --noEmit' };
    mockDetectVerifyCommands.mockReturnValue([cmd]);
    mockRunVerifyCommand.mockReturnValue({ ok: true, exitCode: 0 });

    // Persistence throws — verifyResult cannot be written to store.
    // autoMergeProposal swallows the error. evaluateVerificationGate then reads
    // the in-memory proposal (no verifyResult) → Criterion 2 refuses. Correct.
    mockUpdateProposalField.mockImplementation(() => { throw new Error('disk full'); });

    const result = await autoMergeProposal(proposal.id, verificationCfg());
    expect(result.merged).toBe(false);
    // Either Gate 4 (verifyResult absent on in-memory read) or Gate 6 may fire —
    // both are correct fail-closed outcomes. The key assertion is merged:false.
    expect(result.reason).toBeTruthy();
  });
});

// ===========================================================================
// CONTRACT 4 — NO-REGRESSION: other gate criteria still enforced
// ===========================================================================

describe('M261 Contract 4 — no-regression: other criteria still enforced with verifyResult.passed=true', () => {
  it('refuses when no frontier judge ship entry (Criterion 1)', () => {
    const proposal = makeProposal('prop-m261-c4-a', { verifyResult: { passed: true } });
    const result = evaluateVerificationGate(proposal, verificationCfg(), []);

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("no 'judged' decision");
  });

  it('refuses when judge engine is not frontier (Criterion 1)', () => {
    const proposal = makeProposal('prop-m261-c4-b', { verifyResult: { passed: true } });
    const decisions = [{
      ...makeShipDecision(proposal.id),
      engine: 'qwen2.5:72b',
      model: 'qwen2.5:72b',
    }];
    const result = evaluateVerificationGate(proposal, verificationCfg(), decisions);

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('not a frontier');
  });

  it('refuses when diff exceeds scope cap (Criterion 3)', () => {
    const manyLines = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
    const bigDiff = `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1,200 @@\n${manyLines}`;
    const proposal = makeProposal('prop-m261-c4-c', {
      diff: bigDiff,
      verifyResult: { passed: true },
    });
    const decisions = [makeShipDecision(proposal.id)];
    const result = evaluateVerificationGate(proposal, verificationCfg(), decisions);

    expect(result.authorized).toBe(false);
    expect(result.reason).toMatch(/scope cap|risk class/);
  });
});
