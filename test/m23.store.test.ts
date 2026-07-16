/**
 * M23 inbox store tests — createProposal, listProposals, loadProposal,
 * setStatus, pendingCount, persistence.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/inbox/ is never touched.
 *  - All functions are pure persistence — NEVER applies anything, NEVER mutates a repo.
 *  - Each test is hermetic: fresh tmp HOME per test.
 *
 * Invariants asserted:
 *  - createProposal returns status='pending', createdAt set, unique id, persisted to disk
 *  - listProposals returns most-recent first; optional status filter
 *  - loadProposal returns the proposal by id, null for unknown ids
 *  - setStatus persists new status; sets decidedAt on approved/rejected; no-op for unknown id
 *  - pendingCount returns count of status==='pending' proposals; 0 on empty
 *  - inboxDir() is under HOME/.ashlr/inbox
 *  - persisted file is valid JSON with correct Proposal shape
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module import resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m23-store-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Lazy imports — MUST be after HOME isolation is set up in each test
// ---------------------------------------------------------------------------

import {
  inboxDir,
  createProposal,
  listProposals,
  loadProposal,
  setStatus,
  pendingCount,
} from '../src/core/inbox/store.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { readJudgeTraces, recordJudgeTrace } from '../src/core/fleet/judge-trace.js';
import {
  hashDiff,
  signProvenance,
  verifyProducerProvenanceV2,
  verifyProvenance,
} from '../src/core/foundry/provenance.js';
import { canonicalizeProposalDiff } from '../src/core/util/scrub.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Proposal input (omitting id/status/createdAt). */
function makeInput(overrides?: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>>) {
  return {
    repo: path.join(fs.realpathSync.native(os.tmpdir()), 'test-repo'),
    origin: 'manual' as const,
    kind: 'patch' as const,
    title: 'Test proposal',
    summary: 'A test summary',
    ...overrides,
  };
}

const SECRET_VALUE = 'abcdefghijklmnopqrstuvwxyz1234567890';
const SECRET_ASSIGNMENT = `secret_key = "${SECRET_VALUE}"`;

function diffWithSecret(): string {
  return [
    'diff --git a/app.ts b/app.ts',
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1 +1 @@',
    `+const ${SECRET_ASSIGNMENT};`,
    '+console.log("review context survives");',
    '',
  ].join('\n');
}

function safeDiff(): string {
  return [
    'diff --git a/app.ts b/app.ts',
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1 +1 @@',
    '+console.log("safe review context");',
    '',
  ].join('\n');
}

// ===========================================================================
// inboxDir
// ===========================================================================

describe('M23 inboxDir — location', () => {
  it('returns a path under HOME/.ashlr/inbox', () => {
    const dir = inboxDir();
    expect(dir).toContain('.ashlr');
    expect(dir).toContain('inbox');
    expect(dir.startsWith(tmpHome)).toBe(true);
  });

  it('ends with /inbox', () => {
    const dir = inboxDir();
    expect(dir.endsWith(path.sep + 'inbox') || dir.endsWith('/inbox')).toBe(true);
  });
});

// ===========================================================================
// createProposal
// ===========================================================================

describe('M23 createProposal — persistence + initial state', () => {
  it('returns a Proposal with status="pending"', () => {
    const p = createProposal(makeInput());
    expect(p.status).toBe('pending');
  });

  it('returns a Proposal with a non-empty id', () => {
    const p = createProposal(makeInput());
    expect(typeof p.id).toBe('string');
    expect(p.id.length).toBeGreaterThan(0);
  });

  it('returns a Proposal with a valid ISO createdAt', () => {
    const before = new Date().toISOString();
    const p = createProposal(makeInput());
    const after = new Date().toISOString();
    expect(typeof p.createdAt).toBe('string');
    expect(p.createdAt >= before).toBe(true);
    expect(p.createdAt <= after).toBe(true);
  });

  it('persists the proposal to disk at inboxDir()/<id>.json', () => {
    const p = createProposal(makeInput());
    const filePath = path.join(inboxDir(), `${p.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('persisted file is valid JSON with the correct Proposal shape', () => {
    const p = createProposal(makeInput());
    const filePath = path.join(inboxDir(), `${p.id}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(typeof parsed['id']).toBe('string');
    expect(parsed['id']).toBe(p.id);
    expect(parsed['status']).toBe('pending');
    expect(typeof parsed['createdAt']).toBe('string');
    expect(typeof parsed['title']).toBe('string');
    expect(typeof parsed['summary']).toBe('string');
  });

  it('assigns unique ids to different proposals', () => {
    const p1 = createProposal(makeInput({ title: 'First' }));
    const p2 = createProposal(makeInput({ title: 'Second' }));
    expect(p1.id).not.toBe(p2.id);
  });

  it('preserves all input fields in the returned Proposal', () => {
    const input = makeInput({
      repo: '/some/repo',
      origin: 'backlog',
      kind: 'pr',
      title: 'My PR proposal',
      summary: 'Does important work',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n',
      workItemId: 'repo:todo:refresh-token',
      workSource: 'todo',
      runId: 'run-causal-1',
    });
    const p = createProposal(input);
    expect(p.repo).toBe(input.repo);
    expect(p.origin).toBe(input.origin);
    expect(p.kind).toBe(input.kind);
    expect(p.title).toBe(input.title);
    expect(p.summary).toBe(input.summary);
    expect(p.diff).toBe(input.diff);
    expect(p.workItemId).toBe(input.workItemId);
    expect(p.workSource).toBe(input.workSource);
    expect(p.runId).toBe(input.runId);
  });

  it('rebinds a conflicting run summary to the generated durable proposal id', () => {
    const p = createProposal(makeInput({
      workItemId: 'repo:goal:causal-binding',
      workSource: 'goal',
      runId: 'run-causal-binding',
      runEventSummary: {
        runId: 'caller-controlled-run-id',
        status: 'done',
        outcome: 'filed',
        proposalCreated: true,
        proposalId: 'caller-controlled-proposal-id',
        actionCounts: { proposalCreated: 1, toolSteps: 2 },
      },
    }));

    expect(p.id).not.toBe('caller-controlled-proposal-id');
    expect(p.runEventSummary).toMatchObject({
      runId: 'run-causal-binding',
      proposalCreated: true,
      proposalId: p.id,
    });
    expect(loadProposal(p.id)?.runEventSummary?.proposalId).toBe(p.id);
  });

  it.each([false, undefined])('removes an unbound proposal id when proposalCreated is %s', (proposalCreated) => {
    const p = createProposal(makeInput({
      runId: 'run-causal-non-created',
      runEventSummary: {
        runId: 'caller-controlled-run-id',
        status: 'failed',
        outcome: 'gate-blocked',
        ...(proposalCreated !== undefined ? { proposalCreated } : {}),
        proposalId: 'caller-controlled-proposal-id',
      },
    }));

    expect(p.runEventSummary).toMatchObject({ runId: 'run-causal-non-created' });
    expect(p.runEventSummary?.proposalId).toBeUndefined();
    expect(p.runEventSummary?.proposalCreated).toBe(proposalCreated);
    expect(loadProposal(p.id)?.runEventSummary).toEqual(p.runEventSummary);
  });

  it('normalizes causal identity on a diff-hash dedup return', () => {
    const diff = safeDiff();
    const diffHash = hashDiff(diff);
    const first = createProposal(makeInput({ title: 'Canonical diff owner', diff, diffHash }));
    const duplicate = createProposal(makeInput({
      title: 'Duplicate causal attempt',
      diff,
      diffHash,
      runId: 'run-dedup-attempt',
      runEventSummary: {
        runId: 'caller-controlled-run-id',
        status: 'done',
        outcome: 'filed',
        proposalCreated: true,
        proposalId: 'caller-controlled-proposal-id',
        actionCounts: { proposalCreated: 1, toolSteps: 2 },
      },
    }));

    expect(duplicate).toMatchObject({
      id: first.id,
      status: 'rejected',
      runEventSummary: {
        runId: 'run-dedup-attempt',
        proposalCreated: false,
      },
    });
    expect(duplicate.runEventSummary?.proposalId).toBeUndefined();
    expect(duplicate.runEventSummary?.outcome).toBeUndefined();
    expect(duplicate.runEventSummary?.actionCounts).toEqual({ toolSteps: 2 });
    expect(loadProposal(first.id)?.title).toBe('Canonical diff owner');
  });

  it('does not claim proposal creation when persistence fails', () => {
    const rejected = createProposal(makeInput({
      repo: 'relative/repo',
      runId: 'run-persistence-failed',
      runEventSummary: {
        runId: 'caller-controlled-run-id',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'caller-controlled-proposal-id',
        actionCounts: { proposalCreated: 1 },
      },
    }));

    expect(rejected).toMatchObject({
      status: 'rejected',
      decisionReason: 'invalid proposal repository identity',
      runEventSummary: {
        runId: 'run-persistence-failed',
        proposalCreated: false,
      },
    });
    expect(rejected.runEventSummary?.proposalId).toBeUndefined();
    expect(rejected.runEventSummary?.outcome).toBeUndefined();
    expect(rejected.runEventSummary?.actionCounts).toBeUndefined();
    expect(loadProposal(rejected.id)).toBeNull();
  });

  it('refuses invalid repo identities without persisting or auditing raw path values', () => {
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const rawSecretRepo = path.join(tmpHome, `token=${secret}`);
    const invalidRepos = ['relative/repo', rawSecretRepo];

    for (const repo of invalidRepos) {
      const first = createProposal(makeInput({ repo, title: 'Invalid repo first attempt' }));
      const second = createProposal(makeInput({ repo, title: 'Invalid repo retry' }));
      for (const rejected of [first, second]) {
        expect(rejected).toMatchObject({
          repo: null,
          status: 'rejected',
          decisionReason: 'invalid proposal repository identity',
        });
        expect(fs.existsSync(path.join(inboxDir(), `${rejected.id}.json`))).toBe(false);
      }
    }

    const audits = readAudit().filter((entry) => entry.action === 'inbox:proposal-rejected');
    expect(audits).toHaveLength(4);
    expect(audits.every((entry) => entry.repo === null)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(secret);
    expect(JSON.stringify(audits)).not.toContain('[REDACTED]');
  });

  it('scrubs proposal text and diffs on write while preserving diff review context', () => {
    const rawDiff = diffWithSecret();
    const diffHash = hashDiff(rawDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);

    const p = createProposal(makeInput({
      title: `Rotate leaked ${SECRET_ASSIGNMENT}`,
      summary: `Remove password = "swordfish" from the config`,
      diff: rawDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    }));

    expect(p.title).toContain('[REDACTED]');
    expect(p.summary).toContain('[REDACTED]');
    expect(p.diff).toContain('diff --git a/app.ts b/app.ts');
    expect(p.diff).toContain('review context survives');
    expect(p.diff).toContain('[REDACTED]');
    expect(p.diff).not.toContain(SECRET_VALUE);
    expect(p.diffHash).toBeUndefined();
    expect(p.provenanceSig).toBeUndefined();

    const raw = fs.readFileSync(path.join(inboxDir(), `${p.id}.json`), 'utf8');
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).not.toContain('swordfish');
    const loaded = loadProposal(p.id);
    expect(loaded!.diff).toContain('review context survives');
    expect(loaded!.diff).toContain('[REDACTED]');
    expect(loaded!.diffHash).toBeUndefined();
    expect(listProposals().find((item) => item.id === p.id)!.diff).toContain('[REDACTED]');
  });

  it('preserves trust metadata signed over canonicalized proposal bytes', () => {
    const rawDiff =
      'diff --git a/config.ts b/config.ts\n' +
      '--- a/config.ts\n+++ b/config.ts\n' +
      '+const password = "github_pat_1234567890abcdefghijklmnop";\n';
    const canonical = canonicalizeProposalDiff(rawDiff);
    const diffHash = hashDiff(canonical);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);

    expect(canonicalizeProposalDiff(canonical)).toBe(canonical);
    const proposal = createProposal(makeInput({
      diff: canonical,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    }));

    expect(proposal.diff).toBe(canonical);
    expect(proposal.diffHash).toBe(diffHash);
    expect(proposal.provenanceSig).toBe(provenanceSig);
    expect(verifyProvenance(proposal).ok).toBe(true);
  });

  it('upgrades trusted producer metadata to a proposal-bound v2 attestation', () => {
    const repo = path.join(tmpHome, 'repo');
    fs.mkdirSync(repo);
    const diff = 'diff --git a/a.ts b/a.ts\n+export const value = 1;\n';
    const diffHash = hashDiff(diff);
    const proposal = createProposal(makeInput({
      repo,
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      workItemId: `${repo}:issue:42`,
      workSource: 'issue',
    }));

    expect(proposal.producerProvenanceVersion).toBe(2);
    expect(verifyProducerProvenanceV2(proposal).ok).toBe(true);
    expect(verifyProducerProvenanceV2({ ...proposal, workSource: 'goal' }).ok).toBe(false);
  });

  it.each([
    `sk_${'live'}_1234567890abcdefghijklmnop`,
    'ASIA1234567890ABCDEF',
    '0123456789abcdef0123456789abcdef',
  ])('canonical proposal bytes redact legacy secret class %s', (secret) => {
    const canonical = canonicalizeProposalDiff(`diff --git a/a b/a\n+const value = "${secret}";\n`);
    expect(canonical).not.toContain(secret);
    expect(canonical).toContain('[REDACTED]');
    expect(canonicalizeProposalDiff(canonical)).toBe(canonical);
  });

  it('keeps diffHash and provenanceSig when only non-diff text is redacted', () => {
    const diff = safeDiff();
    const diffHash = hashDiff(diff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);

    const p = createProposal(makeInput({
      title: `Document ${SECRET_ASSIGNMENT}`,
      summary: 'Safe summary',
      diff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    }));

    expect(p.title).toContain('[REDACTED]');
    expect(p.diff).toBe(diff);
    expect(p.diffHash).toBe(diffHash);
    expect(p.provenanceSig).toBe(provenanceSig);
    expect(verifyProvenance(p).ok).toBe(true);
  });

  it('does NOT set decidedAt on creation (pending)', () => {
    const p = createProposal(makeInput());
    expect(p.decidedAt).toBeUndefined();
  });

  it('records causal fields on lifecycle decision entries', () => {
    const p = createProposal(makeInput({
      workItemId: 'repo:todo:causal-lifecycle',
      workSource: 'todo',
      runId: 'run-causal-lifecycle',
      engineModel: 'codex:gpt-5.5',
    }));

    setStatus(p.id, 'approved', 'causal approval');

    const decisions = readDecisions({ proposalId: p.id, limit: 5 });
    const authorized = decisions.find((d) => d.action === 'merge-authorized');
    expect(authorized).toMatchObject({
      proposalId: p.id,
      workItemId: 'repo:todo:causal-lifecycle',
      workSource: 'todo',
      runId: 'run-causal-lifecycle',
      model: 'codex:gpt-5.5',
      verdict: 'approved',
    });
    expect(decisions.some((d) => d.action === 'merged')).toBe(false);
  });

  it('partial review evidence cannot gain authority or emit a merged decision', () => {
    const p = createProposal(makeInput({
      isPartial: true,
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    }));

    setStatus(p.id, 'approved', 'must be refused');
    setStatus(p.id, 'awaiting-host-merge', 'must be refused');
    setStatus(p.id, 'applied', 'must be refused');

    expect(loadProposal(p.id)?.status).toBe('pending');
    expect(readDecisions({ proposalId: p.id }).some((decision) => decision.action === 'merged')).toBe(false);
  });

  it('does NOT apply anything — repo is unchanged', () => {
    // createProposal must be pure persistence: no repo mutation
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m23-noop-repo-'));
    try {
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'original content\n', 'utf8');
      createProposal(makeInput({ repo: repoDir, kind: 'patch', diff: 'some diff' }));
      const content = fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8');
      expect(content).toBe('original content\n');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// listProposals
// ===========================================================================

describe('M23 listProposals — ordering + filtering', () => {
  it('returns [] when inbox is empty', () => {
    const list = listProposals();
    expect(list).toEqual([]);
  });

  it('returns all proposals when no filter is given', () => {
    createProposal(makeInput({ title: 'A' }));
    createProposal(makeInput({ title: 'B' }));
    createProposal(makeInput({ title: 'C' }));
    expect(listProposals().length).toBe(3);
  });

  it('returns most-recent first by createdAt', () => {
    const p1 = createProposal(makeInput({ title: 'First' }));
    const p2 = createProposal(makeInput({ title: 'Second' }));
    const p3 = createProposal(makeInput({ title: 'Third' }));
    const list = listProposals();
    // Most-recent (latest createdAt) should be first
    const ids = list.map(p => p.id);
    // p3 was created last, so should appear first (or equal — within same ms)
    const idxP3 = ids.indexOf(p3.id);
    const idxP1 = ids.indexOf(p1.id);
    // p3 should appear before p1
    expect(idxP3).toBeLessThanOrEqual(idxP1);
    // p2 should be between them or ordered by createdAt
    const idxP2 = ids.indexOf(p2.id);
    expect(idxP2).toBeLessThanOrEqual(idxP1);
  });

  it('filters by status=pending', () => {
    const p1 = createProposal(makeInput({ title: 'Pending A' }));
    const p2 = createProposal(makeInput({ title: 'Will be approved' }));
    setStatus(p2.id, 'approved');

    const pending = listProposals({ status: 'pending' });
    const ids = pending.map(p => p.id);
    expect(ids).toContain(p1.id);
    expect(ids).not.toContain(p2.id);
    expect(pending.every(p => p.status === 'pending')).toBe(true);
  });

  it('filters by status=approved', () => {
    const p1 = createProposal(makeInput({ title: 'Pending' }));
    const p2 = createProposal(makeInput({ title: 'Approved' }));
    setStatus(p2.id, 'approved');

    const approved = listProposals({ status: 'approved' });
    const ids = approved.map(p => p.id);
    expect(ids).not.toContain(p1.id);
    expect(ids).toContain(p2.id);
  });

  it('filters by status=rejected', () => {
    const p1 = createProposal(makeInput({ title: 'Pending' }));
    const p2 = createProposal(makeInput({ title: 'Rejected' }));
    setStatus(p2.id, 'rejected');

    const rejected = listProposals({ status: 'rejected' });
    const ids = rejected.map(p => p.id);
    expect(ids).not.toContain(p1.id);
    expect(ids).toContain(p2.id);
  });

  it('never throws even when inbox dir does not exist', () => {
    // Before any proposals are created, inboxDir does not exist
    expect(() => listProposals()).not.toThrow();
  });

  it('skips corrupt files silently', () => {
    const p = createProposal(makeInput({ title: 'Good proposal' }));
    // Write a corrupt file alongside the good one
    fs.writeFileSync(path.join(inboxDir(), 'corrupt.json'), '{ NOT VALID JSON }{{', 'utf8');
    const list = listProposals();
    // Good proposal should still appear
    expect(list.some(item => item.id === p.id)).toBe(true);
  });
});

// ===========================================================================
// loadProposal
// ===========================================================================

describe('M23 loadProposal — by id', () => {
  it('returns the proposal by id', () => {
    const p = createProposal(makeInput({ title: 'Load me' }));
    const loaded = loadProposal(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(p.id);
    expect(loaded!.title).toBe('Load me');
    expect(loaded!.status).toBe('pending');
  });

  it('scrubs legacy on-disk proposal text and diffs on load and list', () => {
    const p = createProposal(makeInput({ title: 'Legacy shell' }));
    const rawDiff = diffWithSecret();
    const diffHash = hashDiff(rawDiff);
    const provenanceSig = signProvenance('codex:gpt-5.5', 'frontier', diffHash);
    const legacy: Proposal = {
      ...p,
      title: `Legacy ${SECRET_ASSIGNMENT}`,
      summary: `Legacy password = "swordfish"`,
      diff: rawDiff,
      diffHash,
      provenanceSig,
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    };
    const filePath = path.join(inboxDir(), `${p.id}.json`);
    const legacyRaw = JSON.stringify(legacy, null, 2) + '\n';
    fs.writeFileSync(filePath, legacyRaw, 'utf8');

    const loaded = loadProposal(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toContain('[REDACTED]');
    expect(loaded!.summary).toContain('[REDACTED]');
    expect(loaded!.diff).toContain('diff --git a/app.ts b/app.ts');
    expect(loaded!.diff).toContain('review context survives');
    expect(loaded!.diff).not.toContain(SECRET_VALUE);
    expect(loaded!.diffHash).toBeUndefined();
    expect(loaded!.provenanceSig).toBeUndefined();

    const listed = listProposals().find((item) => item.id === p.id);
    expect(listed).toBeDefined();
    expect(listed!.title).toContain('[REDACTED]');
    expect(listed!.diff).not.toContain(SECRET_VALUE);
    expect(listed!.diffHash).toBeUndefined();
    expect(listed!.provenanceSig).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(legacyRaw);
  });

  it('returns null for unknown id', () => {
    const loaded = loadProposal('nonexistent-id-xyz');
    expect(loaded).toBeNull();
  });

  it('returns null when inbox dir does not exist', () => {
    expect(loadProposal('any-id')).toBeNull();
  });

  it('returns null for a corrupt file', () => {
    createProposal(makeInput()); // ensure dir exists
    const badId = 'bad-corrupt-id';
    fs.writeFileSync(path.join(inboxDir(), `${badId}.json`), 'NOT JSON', 'utf8');
    expect(loadProposal(badId)).toBeNull();
  });

  it('round-trips all fields correctly', () => {
    const input = makeInput({
      repo: path.join(fs.realpathSync.native(os.tmpdir()), 'some-repo'),
      origin: 'swarm',
      kind: 'deploy',
      title: 'Deploy to prod',
      summary: 'Ship it',
    });
    const p = createProposal(input);
    const loaded = loadProposal(p.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(p.id);
    expect(loaded!.repo).toBe(input.repo);
    expect(loaded!.origin).toBe(input.origin);
    expect(loaded!.kind).toBe(input.kind);
    expect(loaded!.title).toBe(input.title);
    expect(loaded!.summary).toBe(input.summary);
    expect(loaded!.status).toBe('pending');
    expect(loaded!.createdAt).toBe(p.createdAt);
  });
});

// ===========================================================================
// setStatus
// ===========================================================================

describe('M23 setStatus — persistence only, no application', () => {
  it('records authorization on approval but no merge outcome for generic application', () => {
    const p = createProposal(makeInput());
    recordJudgeTrace({
      proposalId: p.id,
      judgeEngine: 'test-judge',
      verdict: 'ship',
      scores: { value: 5, correctness: 5, scope: 1, alignment: 5 },
      fullReasoning: 'focused lifecycle test',
      promptContext: 'proposal metadata only',
    });

    setStatus(p.id, 'approved', 'authorized for application');

    const approvedDecisions = readDecisions({ proposalId: p.id });
    expect(approvedDecisions.filter((d) => d.action === 'merge-authorized')).toHaveLength(1);
    expect(approvedDecisions.filter((d) => d.action === 'merged')).toHaveLength(0);
    const approvedTraces = readJudgeTraces({ proposalId: p.id });
    expect(approvedTraces).toHaveLength(1);
    expect(approvedTraces[0]?.outcome).toBeUndefined();

    setStatus(p.id, 'applied', 'application completed');

    const appliedDecisions = readDecisions({ proposalId: p.id });
    expect(appliedDecisions.filter((d) => d.action === 'merge-authorized')).toHaveLength(1);
    expect(appliedDecisions.filter((d) => d.action === 'merged')).toHaveLength(0);
    const appliedTraces = readJudgeTraces({ proposalId: p.id });
    expect(appliedTraces).toHaveLength(1);
    expect(appliedTraces[0]?.outcome).toBeUndefined();
  });

  it('persists the new status to disk', () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'approved');
    const loaded = loadProposal(p.id);
    expect(loaded!.status).toBe('approved');
  });

  it('refuses a stale conditional cleanup after the proposal leaves pending', () => {
    const p = createProposal(makeInput());
    expect(setStatus(p.id, 'applied', 'completed elsewhere')).toBe(true);

    expect(setStatus(
      p.id,
      'rejected',
      undefined,
      'stale cleanup',
      undefined,
      {},
      'pending',
    )).toBe(false);
    expect(loadProposal(p.id)).toMatchObject({
      status: 'applied',
      result: 'completed elsewhere',
    });
  });

  it('sets decidedAt when moving to approved', () => {
    const p = createProposal(makeInput());
    const before = new Date().toISOString();
    setStatus(p.id, 'approved');
    const after = new Date().toISOString();
    const loaded = loadProposal(p.id);
    expect(typeof loaded!.decidedAt).toBe('string');
    expect(loaded!.decidedAt! >= before).toBe(true);
    expect(loaded!.decidedAt! <= after).toBe(true);
  });

  it('sets decidedAt when moving to rejected', () => {
    const p = createProposal(makeInput());
    const before = new Date().toISOString();
    setStatus(p.id, 'rejected');
    const after = new Date().toISOString();
    const loaded = loadProposal(p.id);
    expect(typeof loaded!.decidedAt).toBe('string');
    expect(loaded!.decidedAt! >= before).toBe(true);
    expect(loaded!.decidedAt! <= after).toBe(true);
  });

  it('does NOT set decidedAt for applied/failed transitions', () => {
    // decidedAt is set on the approve/reject decision, not on apply outcome
    // (applied/failed come from applyProposal, not the human decision point)
    const p = createProposal(makeInput());
    setStatus(p.id, 'approved');
    const approvedDecidedAt = loadProposal(p.id)!.decidedAt;
    setStatus(p.id, 'applied', 'applied successfully');
    const applied = loadProposal(p.id);
    // decidedAt should remain the same (set at approved time)
    expect(applied!.decidedAt).toBe(approvedDecidedAt);
  });

  it('persists the result field when provided', () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'failed', 'branch creation failed');
    const loaded = loadProposal(p.id);
    expect(loaded!.result).toBe('branch creation failed');
  });

  it('scrubs status result and decision reason on write', () => {
    const p = createProposal(makeInput());

    setStatus(
      p.id,
      'rejected',
      `apply failed with ${SECRET_ASSIGNMENT}`,
      `blocked because password = "swordfish"`,
    );

    const loaded = loadProposal(p.id);
    expect(loaded!.result).toContain('[REDACTED]');
    expect(loaded!.decisionReason).toContain('[REDACTED]');
    expect(loaded!.result).not.toContain(SECRET_VALUE);
    expect(loaded!.decisionReason).not.toContain('swordfish');

    const raw = fs.readFileSync(path.join(inboxDir(), `${p.id}.json`), 'utf8');
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).not.toContain('swordfish');
  });

  it('is a no-op for unknown ids (does not throw)', () => {
    expect(() => setStatus('unknown-id-xyz', 'approved')).not.toThrow();
  });

  it('does NOT apply anything — remains pure persistence', () => {
    // setStatus must never trigger any repo mutation
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m23-setstatus-noop-'));
    try {
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'unchanged\n', 'utf8');
      const p = createProposal(makeInput({ repo: repoDir, kind: 'patch', diff: 'diff content' }));
      setStatus(p.id, 'approved');
      const content = fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8');
      expect(content).toBe('unchanged\n');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('all valid status values round-trip correctly', () => {
    const statuses: Array<import('../src/core/types.js').ProposalStatus> = [
      'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed',
    ];
    for (const status of statuses) {
      const p = createProposal(makeInput({ title: `status-${status}` }));
      setStatus(p.id, status);
      const loaded = loadProposal(p.id);
      expect(loaded!.status).toBe(status);
    }
  });

  it('awaiting-host-merge is not pending and is not counted as landed', () => {
    const p = createProposal(makeInput());

    setStatus(p.id, 'awaiting-host-merge', 'PR opened; awaiting host merge');

    expect(pendingCount()).toBe(0);
    expect(listProposals({ status: 'pending' })).toHaveLength(0);
    expect(listProposals({ status: 'applied' })).toHaveLength(0);
    expect(listProposals({ status: 'awaiting-host-merge' })[0]?.id).toBe(p.id);

    const decision = readDecisions({ proposalId: p.id }).at(-1);
    expect(decision?.action).toBe('handoff');
    expect(decision?.verdict).toBe('awaiting-host-merge');
  });
});

// ===========================================================================
// pendingCount
// ===========================================================================

describe('M23 pendingCount — count of pending proposals', () => {
  it('returns 0 when inbox is empty', () => {
    expect(pendingCount()).toBe(0);
  });

  it('returns 0 when inbox dir does not exist', () => {
    expect(pendingCount()).toBe(0);
  });

  it('counts only proposals with status=pending', () => {
    createProposal(makeInput({ title: 'P1' }));
    createProposal(makeInput({ title: 'P2' }));
    const p3 = createProposal(makeInput({ title: 'P3' }));
    setStatus(p3.id, 'approved');

    expect(pendingCount()).toBe(2);
  });

  it('decreases when proposals are approved/rejected', () => {
    const p1 = createProposal(makeInput({ title: 'A' }));
    const p2 = createProposal(makeInput({ title: 'B' }));
    expect(pendingCount()).toBe(2);

    setStatus(p1.id, 'approved');
    expect(pendingCount()).toBe(1);

    setStatus(p2.id, 'rejected');
    expect(pendingCount()).toBe(0);
  });

  it('returns 0 when all proposals are applied', () => {
    const p1 = createProposal(makeInput({ title: 'X' }));
    setStatus(p1.id, 'applied');
    expect(pendingCount()).toBe(0);
  });

  it('never throws (returns 0 on error)', () => {
    expect(() => pendingCount()).not.toThrow();
  });
});
