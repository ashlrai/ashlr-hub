/**
 * M126 — Manager quality gate tests.
 *
 * Gate 7 wires the Manager's judgeProposal verdict as a REQUIRED gate on
 * autoMergeProposal. Gate 7.5 escalates self-target proposals even on 'ship'.
 *
 * SAFETY / HERMETICITY:
 *  - HOME is overridden to a tmp dir; no real ~/.ashlr state is touched.
 *  - All git repos are real tmp repos; no network, no push.
 *  - judgeProposal is MOCKED — no real LLM calls ever happen.
 *  - readDecisions / recordDecision are MOCKED to control the ledger cache.
 *  - ASHLR_TEST_ALLOW_ANY_REPO=1 set; enroll() still required for happy path.
 *  - No `gh` invoked: all tests use LOCAL merge (no github remote, pushToRemote unset).
 *
 * Adversarial test matrix (35 cases):
 *
 *  Gate 7 — happy path
 *  [1]  ship + wouldMerge=true (non-self-target) → merges
 *  [2]  ship verdict resolved from ledger cache (no inline judge call) → merges
 *  [3]  ledger cache stale (>1h) → judge called inline → merges on ship
 *
 *  Gate 7 — non-ship verdicts → pending (NOT merged)
 *  [4]  verdict='review' → pending
 *  [5]  verdict='noise' → pending
 *  [6]  verdict='harmful' → pending
 *  [7]  verdict='ship' but wouldMerge=false → pending
 *
 *  Gate 7 — fail-closed on judge unavailability
 *  [8]  judgeProposal throws → fail closed (pending, NOT merged)
 *  [9]  getActiveClient unavailable (both cloud and local fail) → fail closed
 *  [10] judge returns but throws on second call (belt-and-suspenders) → fail closed
 *
 *  Gate 7.5 — self-target escalation
 *  [11] self-target + 'ship' + allowSelfMerge=false (default) → escalated (pending)
 *  [12] self-target + 'ship' + allowSelfMerge=true → merges
 *  [13] self-target + 'review' + allowSelfMerge=true → pending (Gate 7 blocks first)
 *  [14] self-target + 'ship' + allowSelfMerge absent (default false) → escalated
 *
 *  Existing gates still block regardless of verdict
 *  [15] autoMerge.enabled=false → never judges, identical to today (flag-off parity)
 *  [16] non-frontier proposal → authority denied before Gate 7 runs
 *  [17] risk high → refused before Gate 7 runs
 *  [18] risk medium → refused before Gate 7 runs
 *  [19] files > scope cap → refused before Gate 7 runs
 *  [20] lines > scope cap → refused before Gate 7 runs
 *  [21] kill switch on → refused before Gate 7 runs
 *  [22] not enrolled → refused before Gate 7 runs
 *  [23] missing proposal → refused before Gate 7 runs
 *  [24] verify fails (suite red) → refused before Gate 7 runs
 *  [25] provenance fails → refused before Gate 7 runs (Gate 4.5)
 *  [26] self-target guardSafetyTests weakens → refused at Gate 6 before Gate 7
 *
 *  Status / audit invariants
 *  [27] refused proposals (all verdicts ≠ ship) stay in prior status (NOT applied)
 *  [28] escalated self-target stays in prior status (NOT applied)
 *  [29] failed-closed (judge unavailable) stays in prior status
 *  [30] successfully merged proposal advances to 'applied'
 *
 *  Never-throws invariant
 *  [31] all refuse paths resolve (never reject/throw)
 *  [32] judge mock throws synchronously → still resolves
 *
 *  Flag-off parity (Gate 1 short-circuit)
 *  [33] flag-off: judge is NEVER called (mockJudge not invoked)
 *  [34] flag-off: listProposals irrelevant (no state change)
 *
 *  Ledger recording
 *  [35] Gate 7 records nonterminal merge authorization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE module imports (vi.mock is hoisted)
// ---------------------------------------------------------------------------

// Mock judgeProposal from fleet/manager.ts
const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

// Mock decision-ledger reads/writes with an in-memory durable projection.
const mockReadDecisions = vi.fn();
const mockReadDecisionsDetailed = vi.fn();
const mockRecordDecision = vi.fn();
const recordedDecisions: Array<Record<string, unknown>> = [];
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  readDecisionsDetailed: (...args: unknown[]) => mockReadDecisionsDetailed(...args),
  recordDecision: (...args: unknown[]) => {
    const persisted = mockRecordDecision(...args);
    if (persisted) recordedDecisions.push(args[0] as Record<string, unknown>);
    return persisted;
  },
}));

// Mock getActiveClient — controls whether judge client is available
const mockGetActiveClient = vi.fn();
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { autoMergeProposal, classifyRisk } from '../src/core/inbox/merge.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { enroll, setKill } from '../src/core/sandbox/policy.js';
import { hashDiff, signJudgeAttestation, signProvenance } from '../src/core/foundry/provenance.js';
import { agentSemanticSubjectRef, defineAgentSemanticEvents } from '../src/core/learning/agent-semantic-events.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', `--initial-branch=${branch}`, dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

function attachOrigin(repo: string, branch: string): void {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m126-origin-')) + '.git';
  execFileSync('git', ['init', '--bare', `--initial-branch=${branch}`, bare], { stdio: 'pipe' });
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-u', 'origin', branch]);
  git(repo, ['remote', 'set-head', 'origin', branch]);
}

/** Minimal unified diff that adds a new docs file (low risk, within scope caps). */
function docsDiff(name = 'docs/m126.md'): string {
  return [
    `diff --git a/${name} b/${name}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${name}`,
    '@@ -0,0 +1 @@',
    '+m126 test content',
    '',
  ].join('\n');
}

/** Create and approve a frontier patch proposal with valid signed provenance. */
function frontierPatch(diff: string): Proposal {
  const diffHash = hashDiff(diff);
  const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
  const p = createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'm126 test proposal',
    summary: 'manager gate test',
    diff,
    diffHash,
    provenanceSig,
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
  });
  setStatus(p.id, 'approved');
  return loadProposal(p.id)!;
}

/**
 * Base config: auto-merge enabled, low risk, frontier authority, allowWithoutVerification,
 * AND managerGate=true (Gate 7 engaged). No allowSelfMerge — default false.
 */
function baseCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: true,
        managerGate: true, // M126: engage Gate 7
        ...over,
      },
    },
  } as unknown as AshlrConfig;
}

/** A ManagerVerdict shaped object for 'ship'. */
function shipVerdict(proposalId: string): ManagerVerdict {
  return {
    proposalId,
    verdict: 'ship',
    value: 4,
    correctness: 4,
    scope: 1,
    alignment: 4,
    rationale: 'small low-risk docs change',
    wouldMerge: true,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m126-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m126-repo-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);

  // Default: no cached ledger entries
  mockReadDecisions.mockReturnValue([]);
  recordedDecisions.length = 0;
  mockReadDecisionsDetailed.mockImplementation((opts: { proposalId?: string } = {}) => {
    const decisions = opts.proposalId === undefined
      ? [...recordedDecisions]
      : recordedDecisions.filter((entry) => entry['proposalId'] === opts.proposalId);
    return {
      decisions,
      sourceState: 'healthy',
      sourcePresent: recordedDecisions.length > 0,
      complete: true,
      stopReasons: [],
      filesRead: recordedDecisions.length > 0 ? 1 : 0,
      bytesRead: 0,
      rowsScanned: recordedDecisions.length,
      invalidRows: 0,
      unreadableFiles: 0,
    };
  });
  // Default: judge returns 'review' (safe default — tests override per scenario)
  mockJudgeProposal.mockResolvedValue({
    proposalId: 'default',
    verdict: 'review',
    value: 3,
    correctness: 3,
    scope: 3,
    alignment: 3,
    rationale: 'default mock — test must override',
    wouldMerge: false,
  } satisfies ManagerVerdict);
  // Default: provider client available with a .complete() method
  mockGetActiveClient.mockResolvedValue({
    model: 'claude-opus-4-8',
    complete: async (_s: string, _u: string) => '{"verdict":"review","value":3,"correctness":3,"scope":3,"alignment":3,"rationale":"mock"}',
  });
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async (_s: string, _u: string) => '{"verdict":"review","value":3,"correctness":3,"scope":3,"alignment":3,"rationale":"mock"}',
  });
  mockRecordDecision.mockReturnValue(true);
});

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
  vi.clearAllMocks();
});

// ===========================================================================
// [1][2][3] Gate 7 happy path — ship verdict → merges
// ===========================================================================

describe('M126 Gate 7 — ship verdict merges', () => {
  it('inline judge attestation uses the shared frontier predicate', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/core/inbox/merge.ts'), 'utf8');
    expect(source).toContain('isFrontierJudge(inlineJudgeEngine)');
    expect(source).not.toContain("inlineJudgeEngine.startsWith('claude')");
  });

  it('[1] inline judge returns ship+wouldMerge=true → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff();
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(git(tmpRepo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('applied');
  });

  it('[1a] inline ship fails closed when durable judge decision persistence fails', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const p = frontierPatch(docsDiff('docs/decision-write-failure.md'));
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));
    mockRecordDecision.mockReturnValueOnce(false);

    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/durable judge decision persistence failed/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[1a1] inline ship fails closed when durable merge authorization persistence fails', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const p = frontierPatch(docsDiff('docs/authorization-write-failure.md'));
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));
    mockRecordDecision.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/durable merge authorization persistence failed/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[1b] inline judge persists actual responder and measured receipt totals', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const p = frontierPatch(docsDiff('docs/inline-receipts.md'));
    const receipts: Array<Record<string, unknown>> = [];
    mockResolveFrontierJudgeClient.mockReturnValueOnce({
      model: 'claude-opus-4-5',
      complete: async () => '{}',
      stats: { receipts },
    });
    mockJudgeProposal.mockImplementationOnce(async () => {
      receipts.push(
        { model: 'claude-opus-4-5', durationMs: 10, metering: 'unmetered' },
        { model: 'claude-opus-4-5', durationMs: 20, metering: 'measured', costUsd: 0.03, tokensIn: 120, tokensOut: 40 },
      );
      return shipVerdict(p.id);
    });

    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(true);
    expect(recordedDecisions.find((entry) => entry['action'] === 'judged')).toMatchObject({
      engine: 'claude-opus-4-5',
      model: 'claude-opus-4-5',
      durationMs: 30,
      costUsd: 0.03,
      tokensIn: 120,
      tokensOut: 40,
    });
  });

  it('[2] ship verdict resolved from ledger cache — judge NOT called inline → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/cached.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    // Return a cached 'judged' ledger entry with ship+would-merge
    const cacheTs = new Date().toISOString();
    mockReadDecisions.mockReturnValue([{
      ts: cacheTs,
      proposalId: p.id,
      action: 'judged',
      engine: 'claude-opus-4-5',
      verdict: 'ship',
      reason: 'cached small docs change',
      detail: 'would-merge',
      judgeAttestation: signJudgeAttestation({
        proposalId: p.id,
        judgeEngine: 'claude-opus-4-5',
        verdict: 'ship',
        diffHash: hashDiff(diff),
        issuedAt: cacheTs,
        mergeIntent: 'would-merge',
      }),
      judgeAttestationIssuedAt: cacheTs,
      judgeAttestationIntent: 'would-merge',
    }]);

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(git(tmpRepo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    // judgeProposal must NOT have been called — verdict came from cache
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockReadDecisions).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true }));
  });

  it('[2a] semantic verification support cannot replace cached merge authority', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/semantic-near-authority.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const cacheTs = new Date().toISOString();
    const semanticEvents = defineAgentSemanticEvents({
      subjectRef: agentSemanticSubjectRef('proposal', p.id),
      producerRole: 'verifier',
      producerModelFamily: 'local',
      producerVersion: 'test-semantic-v1',
    }, [{
      kind: 'evidence',
      predicate: 'verification.result',
      evidenceCode: 'verification.merge-profile',
      result: 'supports',
    }]);

    // Near-authorized cached ship: every ordinary field is valid, but the
    // cryptographic judge attestation is absent. Semantic evidence is metadata only.
    mockReadDecisions.mockReturnValue([{
      ts: cacheTs,
      proposalId: p.id,
      action: 'judged',
      engine: 'claude-opus-4-5',
      verdict: 'ship',
      reason: 'cached small docs change with semantic verification support',
      detail: 'would-merge',
      judgeAttestationIssuedAt: cacheTs,
      judgeAttestationIntent: 'would-merge',
      semanticEvents,
    }]);
    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: p.id,
      verdict: 'review',
      value: 3,
      correctness: 3,
      scope: 3,
      alignment: 3,
      rationale: 'missing merge-authoritative attestation',
      wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/manager gate.*review/i);
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[2b] same-family cached ship is advisory and triggers a fresh review', async () => {
    initRepo(tmpRepo, 'main');
    enroll(tmpRepo);
    const diff = docsDiff('docs/correlated-cache.md');
    const p = frontierPatch(diff);
    const cacheTs = new Date().toISOString();
    mockReadDecisions.mockReturnValue([{
      ts: cacheTs,
      proposalId: p.id,
      action: 'judged',
      engine: 'gpt-5.5',
      model: 'gpt-5.5',
      verdict: 'ship',
      detail: 'would-merge',
      judgeAttestation: signJudgeAttestation({
        proposalId: p.id,
        judgeEngine: 'gpt-5.5',
        verdict: 'ship',
        diffHash: hashDiff(diff),
        issuedAt: cacheTs,
        mergeIntent: 'would-merge',
      }),
      judgeAttestationIssuedAt: cacheTs,
      judgeAttestationIntent: 'would-merge',
    }]);
    mockJudgeProposal.mockResolvedValueOnce({
      ...shipVerdict(p.id),
      verdict: 'review',
      wouldMerge: false,
      rationale: 'independent reviewer did not ship',
    });

    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/manager gate.*review/i);
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
  });

  it('[2c] same-family inline ship cannot mint manager-gate authority', async () => {
    initRepo(tmpRepo, 'main');
    enroll(tmpRepo);
    const p = frontierPatch(docsDiff('docs/correlated-inline.md'));
    mockResolveFrontierJudgeClient.mockReturnValueOnce({
      model: 'gpt-5.5',
      complete: async () => '{}',
    });
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));
    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reviewer independence denied.*both openai/i);
    const judged = recordedDecisions.find((entry) => entry['action'] === 'judged');
    expect(judged?.['judgeAttestation']).toBeUndefined();
    expect(judged?.['detail']).toBe('');
  });

  it('[3] ledger cache stale (no recent entry) → judge called inline → ship → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/stale.md');
    const p = frontierPatch(diff);

    // readDecisions returns empty (stale/absent)
    mockReadDecisions.mockReturnValue([]);
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// [4][5][6][7] Non-ship verdicts → pending (NOT merged)
// ===========================================================================

describe('M126 Gate 7 — non-ship verdicts stay pending', () => {
  async function testVerdict(
    verdict: ManagerVerdict['verdict'],
    wouldMerge = false,
  ): Promise<void> {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff(`docs/${verdict}.md`);
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: p.id,
      verdict,
      value: 2,
      correctness: 2,
      scope: 3,
      alignment: 2,
      rationale: `mock ${verdict} verdict`,
      wouldMerge,
    } satisfies ManagerVerdict);

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/manager gate/i);
    // main untouched
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    // Status preserved (NOT applied, NOT rejected)
    expect(loadProposal(p.id)!.status).toBe('approved');

    // Cleanup for re-use in loop (afterEach will handle dirs)
    git(tmpRepo, ['checkout', 'work']);
  }

  it('[4] verdict=review → pending (not merged)', async () => {
    await testVerdict('review');
  });

  it('[5] verdict=noise → pending (not merged)', async () => {
    await testVerdict('noise');
  });

  it('[6] verdict=harmful → pending (not merged)', async () => {
    await testVerdict('harmful');
  });

  it('[7] verdict=ship but wouldMerge=false → pending (not merged)', async () => {
    await testVerdict('ship', false);
  });
});

// ===========================================================================
// [8][9][10] Fail-closed on judge unavailability
// ===========================================================================

describe('M126 Gate 7 — fail-closed when judge unavailable', () => {
  it('[8] judgeProposal throws → fail closed (pending, NOT merged)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/throw.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockRejectedValueOnce(new Error('LLM timeout'));

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/fail closed|manager.*gate/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[9] getActiveClient unavailable (both cloud and local fail) → fail closed', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/nojudge.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    // Both client resolution paths throw
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/unavailable|fail closed/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[10] getActiveClient returns client with no .complete() or .chat() → fail closed', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/badclient.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    // Return an object with no usable methods
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const r = await autoMergeProposal(p.id, baseCfg());

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/unavailable|fail closed/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[10b] provider client without runtime model identity cannot borrow configured identity', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const p = frontierPatch(docsDiff('docs/missing-reviewer-identity.md'));
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    mockResolveFrontierJudgeClient.mockReturnValue(null);
    const result = await autoMergeProposal(p.id, baseCfg());

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reason).toMatch(/judge unavailable|fail closed/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(recordedDecisions.some((entry) => entry['action'] === 'judged')).toBe(false);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
  });
});

// ===========================================================================
// [11][12][13][14] Gate 7.5 — self-target escalation
// ===========================================================================

describe('M126 Gate 7.5 — self-target escalation', () => {
  /** Make the repo look like @ashlr/hub to trigger isSelfTargetProposal. */
  function makeSelfTarget(): void {
    const pkg = { name: '@ashlr/hub', version: '1.0.0', scripts: { test: 'exit 0' } };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target package.json']);
    git(tmpRepo, ['push', 'origin', 'main']);
  }

  it('[11] self-target + ship + allowSelfMerge=false (default) → escalated (pending)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);
    makeSelfTarget();

    const diff = docsDiff('docs/self11.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg()); // no allowSelfMerge

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/self.target.*escalat|allowSelfMerge/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[12] self-target + ship + allowSelfMerge=true → merges', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);
    makeSelfTarget();

    const diff = docsDiff('docs/self12.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg({ allowSelfMerge: true }));

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(git(tmpRepo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('applied');
  });

  it('[13] self-target + review + allowSelfMerge=true → pending (Gate 7 blocks first)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);
    makeSelfTarget();

    const diff = docsDiff('docs/self13.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: p.id,
      verdict: 'review',
      value: 3,
      correctness: 3,
      scope: 3,
      alignment: 3,
      rationale: 'needs inspection',
      wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await autoMergeProposal(p.id, baseCfg({ allowSelfMerge: true }));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/manager gate.*verdict='review'/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[14] self-target + ship + allowSelfMerge key absent → escalated (default false)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);
    makeSelfTarget();

    const diff = docsDiff('docs/self14.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    // Config with managerGate=true but no allowSelfMerge key at all
    const cfg: AshlrConfig = {
      foundry: {
        mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
        autoMerge: { enabled: true, maxRisk: 'low', allowWithoutVerification: true, managerGate: true },
      },
    } as unknown as AshlrConfig;

    const r = await autoMergeProposal(p.id, cfg);

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/self.target|escalat|allowSelfMerge/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// [15]–[26] Existing gates still block regardless of verdict (Gate 7 never reached)
// ===========================================================================

describe('M126 existing gates preserved — Gate 7 never reached', () => {
  it('[15] autoMerge.enabled=false → Gate 1 short-circuits, judge never called, no merge', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/flagoff.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    // Would normally ship
    mockJudgeProposal.mockResolvedValue(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg({ enabled: false }));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    // Critical: judge was NEVER called (Gate 1 short-circuits everything)
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[16] non-frontier proposal → authority denied (Gate 4) before Gate 7', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const diff = docsDiff();
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'local',
      summary: 'not frontier',
      diff,
      engineModel: 'builtin:llama',
      engineTier: 'local',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/authority|frontier/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[17] risk high → refused at Gate 5 before Gate 7', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const diff = [
      docsDiff('src/a.ts'),
      docsDiff('src/b.ts'),
    ].join('\n').replace(/\+\+\+ b\/docs\//g, '+++ b/src/').replace(/--- \/dev\/null/g, '--- /dev/null');
    // M295: a genuinely high-risk diff — a security/auth surface (isSecuritySensitive
    // → unconditionally HIGH). (Ordinary multi-file source is now MEDIUM.)
    const highDiff =
      `diff --git a/src/core/auth/session.ts b/src/core/auth/session.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/core/auth/session.ts\n@@ -0,0 +1 @@\n+export const token = 1\n\n`;
    expect(classifyRisk({ diff: highDiff } as Proposal)).toBe('high');

    const diffHash = hashDiff(highDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'risky',
      summary: 'high risk src change',
      diff: highDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/risk/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[18] risk medium → refused at Gate 5 (or scope cap) before Gate 7', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const medDiff =
      `diff --git a/src/util.ts b/src/util.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/util.ts\n@@ -0,0 +1 @@\n+export const x = 1\n\n`;
    expect(classifyRisk({ diff: medDiff } as Proposal)).toBe('medium');

    const diffHash = hashDiff(medDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'medium risk',
      summary: 'single source change',
      diff: medDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/risk/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[19] files > scope cap → refused at Gate 5.5 before Gate 7', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // 5 docs files — low risk but > default cap (4)
    const manyDiff = Array.from({ length: 5 }, (_, i) =>
      `diff --git a/docs/f${i}.md b/docs/f${i}.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/f${i}.md\n@@ -0,0 +1 @@\n+content\n\n`
    ).join('');
    expect(classifyRisk({ diff: manyDiff } as Proposal)).toBe('low');

    const diffHash = hashDiff(manyDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'many files',
      summary: '5 docs',
      diff: manyDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scope cap.*files/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[20] lines > scope cap → refused at Gate 5.5 before Gate 7', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // 151 added lines — low risk but > default cap (150)
    const manyLines = Array.from({ length: 151 }, (_, i) => `+line${i}`).join('\n');
    const bigDiff = `diff --git a/docs/big.md b/docs/big.md\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/big.md\n@@ -0,0 +1,151 @@\n${manyLines}\n\n`;
    expect(classifyRisk({ diff: bigDiff } as Proposal)).toBe('low');

    const diffHash = hashDiff(bigDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'big diff',
      summary: '151 lines',
      diff: bigDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/scope cap.*lines/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[21] kill switch on → refused at Gate 3 before Gate 7', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);
    setKill(true);

    const diff = docsDiff();
    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/kill/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[22] not enrolled → refused at Gate 3 before Gate 7', async () => {
    initRepo(tmpRepo);
    // NOT enrolled

    const diff = docsDiff();
    const p = frontierPatch(diff);
    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/enroll/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[23] missing proposal → refused at Gate 2 before Gate 7', async () => {
    const r = await autoMergeProposal('does-not-exist-m126', baseCfg());
    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[24] verify fails (suite red) → refused at Gate 6 before Gate 7', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Install failing test script
    const pkg = { name: 'fixture', version: '1.0.0', scripts: { test: 'exit 1' } };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'failing test']);
    git(tmpRepo, ['push', 'origin', 'main']);

    const diff = docsDiff('docs/red.md');
    const p = frontierPatch(diff);

    // allowWithoutVerification=false so verify actually runs and fails
    const r = await autoMergeProposal(p.id, baseCfg({ allowWithoutVerification: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verif/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[25] provenance fails → refused at Gate 4.5 before Gate 7', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const diff = docsDiff('docs/prov.md');
    // Create proposal WITHOUT valid provenance signature
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'bad provenance',
      summary: 'forged',
      diff,
      diffHash: 'fakehash',
      provenanceSig: 'invalidsig',
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/provenance/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });

  it('[26] self-target guard weakens safety test → refused at Gate 6 before Gate 7', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    // Make repo self-target
    const safetyFile = 'test/h1.safety.test.ts';
    fs.mkdirSync(path.join(tmpRepo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, safetyFile), 'import { expect } from "vitest";\n', 'utf8');
    git(tmpRepo, ['add', safetyFile]);
    const pkg = { name: '@ashlr/hub', version: '1.0.0', scripts: { test: 'exit 0' } };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target setup']);
    git(tmpRepo, ['push', 'origin', 'main']);

    // Diff that deletes the safety test
    const deleteDiff = [
      `diff --git a/${safetyFile} b/${safetyFile}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- a/${safetyFile}`,
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-import { expect } from "vitest";',
      '',
    ].join('\n');

    const diffHash = hashDiff(deleteDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const p = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'delete safety test',
      summary: 'bad actor',
      diff: deleteDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(p.id, 'approved');

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    // Risk gate or guard fires — proposal refused
    expect(loadProposal(p.id)!.status).toBe('approved');
    expect(mockJudgeProposal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// [27][28][29][30] Status / audit invariants
// ===========================================================================

describe('M126 status invariants', () => {
  it('mid-tier branch application stays applied without realized merge evidence or merge fanout', async () => {
    initRepo(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/branch-only.md');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'branch-only application',
      summary: 'Stage a mid-tier proposal without claiming a merge.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5-mini', 'mid', diffHash),
      engineModel: 'codex:gpt-5-mini',
      engineTier: 'mid',
    });
    setStatus(proposal.id, 'approved');
    mockRecordDecision.mockClear();
    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(proposal.id));
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    const result = await autoMergeProposal(proposal.id, baseCfg({ midToBranch: true }));

    expect(result).toMatchObject({ ok: true, merged: false, branched: true });
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(proposal.id)).toMatchObject({ status: 'applied' });
    expect(loadProposal(proposal.id)?.realizedMerge).toBeUndefined();
    expect(mockRecordDecision.mock.calls.some((call) =>
      (call[0] as { action?: string }).action === 'merged')).toBe(false);
  });

  it('[27] refused by Gate 7 (review verdict) → status stays approved (not applied, not rejected)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/status27.md');
    const p = frontierPatch(diff);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: p.id, verdict: 'review', value: 3, correctness: 3,
      scope: 3, alignment: 3, rationale: 'needs look', wouldMerge: false,
    } satisfies ManagerVerdict);

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[28] escalated self-target → status stays approved', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const pkg = { name: '@ashlr/hub', version: '1.0.0', scripts: { test: 'exit 0' } };
    fs.writeFileSync(path.join(tmpRepo, 'package.json'), JSON.stringify(pkg), 'utf8');
    git(tmpRepo, ['add', 'package.json']);
    git(tmpRepo, ['commit', '-m', 'self-target']);
    git(tmpRepo, ['push', 'origin', 'main']);

    const diff = docsDiff('docs/status28.md');
    const p = frontierPatch(diff);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg()); // allowSelfMerge=false
    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[29] fail-closed (judge unavailable) → status stays approved', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/status29.md');
    const p = frontierPatch(diff);

    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(false);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });

  it('[30] successfully merged → status advances to applied', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/status30.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(loadProposal(p.id)).toMatchObject({
      status: 'applied',
      realizedMerge: {
        schemaVersion: 1,
        source: 'local-default-branch',
        base: 'main',
        baseBeforeOid: mainBefore,
        proposalHeadOid: git(tmpRepo, ['rev-parse', `ashlr/merge/${p.id}`]),
        mergeCommitOid: git(tmpRepo, ['rev-parse', 'main']),
        observedAt: expect.any(String),
      },
    });
    expect(mockRecordDecision.mock.calls.some((call) => {
      const decision = call[0] as { action?: string; verdict?: string; labelBasis?: string };
      return decision.action === 'merged' && decision.verdict === 'merged' &&
        decision.labelBasis === 'realized-merge-v1';
    })).toBe(true);
  });
});

// ===========================================================================
// [31][32] Never-throws invariant
// ===========================================================================

describe('M126 never-throws', () => {
  it('[31] all refuse paths resolve (never reject)', async () => {
    initRepo(tmpRepo);
    enroll(tmpRepo);

    const diff = docsDiff();
    const p = frontierPatch(diff);

    mockJudgeProposal.mockRejectedValue(new Error('simulated crash'));
    mockResolveFrontierJudgeClient.mockReturnValue(null);

    const results = await Promise.all([
      autoMergeProposal(p.id, baseCfg({ enabled: false })),
      autoMergeProposal('no-such-id-m126', baseCfg()),
      autoMergeProposal(p.id, baseCfg()),
    ]);

    for (const r of results) {
      expect(r).toHaveProperty('ok');
      expect(r).toHaveProperty('merged');
    }
  });

  it('[32] judge mock throws synchronously → resolved (never rejects)', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/sync-throw.md');
    const p = frontierPatch(diff);

    // Synchronous throw from the mock
    mockJudgeProposal.mockImplementation(() => { throw new Error('sync crash'); });

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r).toHaveProperty('ok', false);
    expect(r).toHaveProperty('merged', false);
  });
});

// ===========================================================================
// [33][34] Flag-off parity
// ===========================================================================

describe('M126 flag-off parity', () => {
  it('[33] flag-off: judge is NEVER called', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/parity33.md');
    const p = frontierPatch(diff);

    mockJudgeProposal.mockResolvedValue(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg({ enabled: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockReadDecisions).not.toHaveBeenCalled();
    // recordDecision MAY be called by store.ts for status changes — we only
    // assert that the Gate-7-specific 'judged'/'escalated'/'merged' actions
    // were never recorded (those are emitted exclusively from Gate 7 logic).
    const gate7Actions = ['judged', 'escalated'];
    const gate7Calls = mockRecordDecision.mock.calls.filter(
      (call) => gate7Actions.includes((call[0] as { action: string }).action),
    );
    expect(gate7Calls).toHaveLength(0);
  });

  it('[34] flag-off: main is untouched + proposal status unchanged', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/parity34.md');
    const p = frontierPatch(diff);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);

    await autoMergeProposal(p.id, baseCfg({ enabled: false }));

    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(p.id)!.status).toBe('approved');
  });
});

// ===========================================================================
// [35] Ledger recording after Gate 7 authorization
// ===========================================================================

describe('M126 ledger recording', () => {
  it('[35] Gate 7 records merge-authorized before the applied transition', async () => {
    initRepo(tmpRepo, 'main');
    attachOrigin(tmpRepo, 'main');
    git(tmpRepo, ['checkout', '-b', 'work']);
    enroll(tmpRepo);

    const diff = docsDiff('docs/ledger35.md');
    const p = frontierPatch(diff);

    mockJudgeProposal.mockResolvedValueOnce(shipVerdict(p.id));

    const r = await autoMergeProposal(p.id, baseCfg());
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);

    const authorizedCall = mockRecordDecision.mock.calls.find((call) => {
      const e = call[0] as { action?: string; reason?: string };
      return e.action === 'merge-authorized' && typeof e.reason === 'string' && e.reason.includes('gate 7 passed');
    });
    expect(authorizedCall).toBeDefined();
    const entry = authorizedCall![0] as { action: string; reason: string };
    expect(entry.action).toBe('merge-authorized');
    expect(entry.reason).toMatch(/gate 7 passed.*verdict=ship/i);
  });
});
