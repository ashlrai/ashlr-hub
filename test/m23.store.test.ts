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
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Proposal input (omitting id/status/createdAt). */
function makeInput(overrides?: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>>) {
  return {
    repo: '/tmp/test-repo',
    origin: 'manual' as const,
    kind: 'patch' as const,
    title: 'Test proposal',
    summary: 'A test summary',
    ...overrides,
  };
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

  it('does NOT set decidedAt on creation (pending)', () => {
    const p = createProposal(makeInput());
    expect(p.decidedAt).toBeUndefined();
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
      repo: '/tmp/some-repo',
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
  it('persists the new status to disk', () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'approved');
    const loaded = loadProposal(p.id);
    expect(loaded!.status).toBe('approved');
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
      'approved', 'rejected', 'applied', 'failed',
    ];
    for (const status of statuses) {
      const p = createProposal(makeInput({ title: `status-${status}` }));
      setStatus(p.id, status);
      const loaded = loadProposal(p.id);
      expect(loaded!.status).toBe(status);
    }
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
