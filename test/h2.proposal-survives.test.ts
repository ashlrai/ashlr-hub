/**
 * test/h2.proposal-survives.test.ts — H2 BUILD task 4: NO-STUCK-PROPOSAL
 * (crash recovery).
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. Proves a crash
 * can NEVER strand a proposal in a non-terminal/limbo state, and that PENDING
 * proposals survive a restart intact and stay actionable.
 *
 * The inbox store (src/core/inbox/store.ts) is PURE PERSISTENCE: one proposal
 * per file at ~/.ashlr/inbox/<id>.json, written atomically (tmp-write + rename),
 * status changes ONLY through setStatus, and it NEVER mutates a repo. This suite
 * fault-injects against that REAL store + the REAL apply lifecycle states, using
 * the H2 persisted-state crash-simulation technique (we construct the exact
 * on-disk state a kill at a chosen instant would leave, then invoke the genuine
 * read/recovery path) — NO outward action (applyProposal is never called), NO
 * live model, NO real subprocess.
 *
 * THREE CRASH SURFACES PROVEN (matching the BUILD task):
 *
 *  (a) PENDING-SURVIVES-RESTART — a PENDING proposal written before a simulated
 *      crash survives a restart intact and is still ACTIONABLE: load/list see it
 *      byte-for-byte, it is still 'pending', and approve (the REAL setStatus
 *      transition Mason would drive) still works afterwards.
 *
 *  (b) INBOX-STORE-IS-PURE-PERSISTENCE — apply's real lifecycle is gate -> mutate
 *      (branch+patch on a NEW branch) -> setStatus(applied|failed). This section
 *      does NOT invoke applyProposal; it proves the narrower, honest claim that
 *      an out-of-band status write round-trips through the inbox store and that
 *      the store NEVER touches the repo. So whatever status a crash mid-apply
 *      last persisted (e.g. still 'approved' = retryable, or 'applied' = done)
 *      reloads as one of the defined lifecycle states, never a corrupt/limbo
 *      one. (The REAL apply path's crash-safety between gate->mutate->setStatus
 *      — that a kill-before-the-terminal-setStatus leaves 'approved' — is proven
 *      against the genuine applyProposal gate in test/h2.kill-race-abort.test.ts
 *      case (c), not hand-stamped here.)
 *
 *  (c) ATOMIC-WRITE-SURVIVES-INTERRUPTION — the tmp-write+rename means a reader
 *      sees the OLD file or the COMPLETE new file, never a half-written record. A
 *      leftover *.tmp sidecar (an interrupted write that never renamed) and a
 *      truncated/half-written JSON file are SKIPPED — never loaded, never
 *      surfaced as a stuck proposal.
 *
 * The disposable repo tree is asserted BYTE-IDENTICAL throughout every scenario.
 *
 * SAFETY: FRESH isolated tmp HOME per test (H1 fixture asserts homedir()===tmp
 * HOME); ~/.ashlr/inbox lives under the tmp HOME; the real inbox/portfolio is
 * NEVER touched; no applyProposal / push / PR is ever invoked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import { seedPendingProposal } from './helpers/h2-faults.js';
import {
  inboxDir,
  createProposal,
  listProposals,
  loadProposal,
  setStatus,
  pendingCount,
} from '../src/core/inbox/store.js';
import type { Proposal } from '../src/core/types.js';

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers (test-local — no production change)
// ---------------------------------------------------------------------------

/** Absolute path to a proposal's committed file under the isolated inbox. */
function proposalFile(id: string): string {
  return join(inboxDir(), `${id}.json`);
}

/** Raw bytes of a proposal's on-disk file (the byte-round-trip reference). */
function proposalBytes(id: string): string {
  return readFileSync(proposalFile(id), 'utf8');
}

// ===========================================================================
// (a) PENDING-SURVIVES-RESTART — survives intact + still actionable
// ===========================================================================

describe('H2 stuck-proposal (a): a PENDING proposal survives a crash + restart intact', () => {
  it('is loadable, byte-identical, and still PENDING after a simulated restart', () => {
    const treeBefore = repo.shasumTree();

    // Crash-and-restart: createProposal writes atomically (tmp+rename), so the
    // proposal a crashed-but-completed swarm left behind is fully committed on
    // disk. Capture the exact bytes the writer left, then simulate a restart by
    // re-reading through the REAL store after NO further writes.
    const p = seedPendingProposal(repo.dir, 'survives-restart');
    const bytesAtCrash = proposalBytes(p.id);

    // ── restart: re-read via the genuine store entry points ──
    const reloaded = loadProposal(p.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.status).toBe('pending');
    // Byte round-trip: the persisted record is unchanged across the restart.
    expect(proposalBytes(p.id)).toBe(bytesAtCrash);
    // Field round-trip: nothing was dropped/rewritten by the read path.
    expect(reloaded).toEqual(p);

    // It is surfaced by the list view and counted as pending.
    const listed = listProposals();
    expect(listed.map((x) => x.id)).toContain(p.id);
    expect(listProposals({ status: 'pending' }).map((x) => x.id)).toContain(p.id);
    expect(pendingCount()).toBe(1);

    // The repo working tree is byte-identical — the store never touched it.
    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('is still ACTIONABLE after restart — approve (the REAL setStatus) works', () => {
    const treeBefore = repo.shasumTree();
    const p = seedPendingProposal(repo.dir, 'actionable-after-restart');

    // Restart: confirm it is still pending (not auto-advanced) ...
    expect(loadProposal(p.id)?.status).toBe('pending');

    // ... and that the operator can still act on it — approve via the SAME
    // setStatus transition the inbox CLI drives. This proves the survived
    // proposal is not trapped: it can move to a terminal/decided state on demand.
    setStatus(p.id, 'approved', 'h2: approved after restart');
    const approved = loadProposal(p.id);
    expect(approved?.status).toBe('approved');
    // setStatus stamps decidedAt on an approve/reject decision.
    expect(typeof approved?.decidedAt).toBe('string');
    // The rest of the record is preserved (only status/decidedAt/result changed).
    expect(approved?.id).toBe(p.id);
    expect(approved?.title).toBe(p.title);
    expect(approved?.diff).toBe(p.diff);

    // Still no repo mutation — setStatus is pure persistence.
    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('multiple PENDING proposals all survive a restart (pendingCount stable)', () => {
    const treeBefore = repo.shasumTree();

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(seedPendingProposal(repo.dir, `multi-${i}`).id);
    }
    const before = pendingCount();
    expect(before).toBe(4);

    // Restart path = a pure re-read; nothing in the store auto-advances status.
    const reloaded = listProposals({ status: 'pending' }).map((x) => x.id).sort();
    expect(reloaded).toEqual([...ids].sort());
    expect(pendingCount()).toBe(before); // unchanged — pending stays pending

    expect(repo.shasumTree()).toBe(treeBefore);
  });
});

// ===========================================================================
// (b) STATUS-ROUND-TRIPS — approved (retryable) or applied (done), never limbo
//     (status writes only; the REAL apply gate is proven in h2.kill-race-abort)
// ===========================================================================

describe('H2 stuck-proposal (b): an out-of-band status write round-trips to approved (retryable) or applied (done), never limbo', () => {
  /**
   * Seed an APPROVED proposal carrying a captured sandbox diff — the exact
   * pre-mutation state apply reaches once Gate 1/2/3 pass and just before it
   * touches the repo. From here a crash can land at one of exactly two persisted
   * statuses, both non-limbo.
   */
  function seedApprovedWithDiff(title: string): Proposal {
    const created = createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title,
      summary: 'H2 mid-apply crash: an approved patch proposal with a captured diff',
      // A real captured sandbox diff. Note: a proposal NEVER applies this itself;
      // the inbox store is pure persistence and never touches the repo.
      diff:
        `diff --git a/${title}.txt b/${title}.txt\n` +
        'new file mode 100644\n' +
        '--- /dev/null\n' +
        `+++ b/${title}.txt\n` +
        '@@ -0,0 +1,1 @@\n' +
        '+captured-by-sandbox\n',
    });
    setStatus(created.id, 'approved', 'h2: approved, eligible for apply');
    const approved = loadProposal(created.id);
    expect(approved?.status).toBe('approved');
    return approved as Proposal;
  }

  it('a status left at APPROVED (no setStatus(applied) written) reloads as APPROVED — safely retryable, tree untouched', () => {
    const treeBefore = repo.shasumTree();
    const approved = seedApprovedWithDiff('crash-before-write');

    // Simulate the crash: the process died after the gate but before the
    // setStatus(applied) write landed. The on-disk status is the LAST one that
    // was persisted — 'approved'. We model "crash" as "no further write
    // happens", then drive the REAL recovery read.
    const recovered = loadProposal(approved.id);
    expect(recovered).not.toBeNull();
    // NEVER a corrupt/limbo status — it is one of the well-defined lifecycle
    // states, and specifically the safely-RETRYABLE one.
    expect(['approved', 'applied']).toContain(recovered?.status);
    expect(recovered?.status).toBe('approved');
    // The captured diff is intact so a retry can re-drive apply deterministically.
    expect(recovered?.diff).toBe(approved.diff);

    // CRITICAL: the inbox write left NO partial mutation of the real working
    // tree — byte-identical, clean git status, branch set unchanged.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo.branches()).toEqual([repo.branch]);
  });

  it('a status advanced to APPLIED via the same setStatus the apply path uses reloads as APPLIED — terminal/done, tree untouched', () => {
    const treeBefore = repo.shasumTree();
    const approved = seedApprovedWithDiff('crash-after-write');

    // The successful apply persisted its terminal outcome just before the crash.
    // We reproduce the EXACT post-write state via the same setStatus the apply
    // path uses on success (setStatus(id,'applied',detail)).
    setStatus(approved.id, 'applied', 'branch ashlr/h2-apply created; patch applied');

    const recovered = loadProposal(approved.id);
    expect(recovered?.status).toBe('applied'); // terminal — never re-runs
    expect(['approved', 'applied']).toContain(recovered?.status); // never limbo
    expect(recovered?.result).toContain('patch applied');

    // The inbox store still never touched the source repo (apply mutates a NEW
    // branch in real life; the persistence layer under test does not).
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
  });

  it('a crash can NEVER produce a non-lifecycle/limbo status (only the 5 valid states ever load)', () => {
    const valid = new Set(['pending', 'approved', 'rejected', 'applied', 'failed']);

    // Walk the realistic crash points across the lifecycle, each persisted via
    // the REAL setStatus, and assert every recovered status is a defined
    // terminal-or-actionable state — never a corrupt in-between.
    const p = seedApprovedWithDiff('lifecycle-walk');
    for (const status of ['approved', 'applied'] as const) {
      if (status !== 'approved') setStatus(p.id, status, `crash-recovered: ${status}`);
      const recovered = loadProposal(p.id);
      expect(recovered).not.toBeNull();
      expect(valid.has(recovered?.status as string)).toBe(true);
    }
  });
});

// ===========================================================================
// (c) ATOMIC-WRITE-SURVIVES-INTERRUPTION — no half-written JSON is ever loaded
// ===========================================================================

describe('H2 stuck-proposal (c): atomic writes survive an interrupted write', () => {
  it('a leftover *.tmp sidecar (an interrupted, never-renamed write) is never surfaced', () => {
    const treeBefore = repo.shasumTree();
    const committed = seedPendingProposal(repo.dir, 'committed');

    // Simulate a crash DURING a second write: writeFileSync(tmp) ran but the
    // process died before renameSync(tmp, dest). The store writes <id>.json.tmp
    // then renames — so the surviving artifact is a stray .tmp sidecar holding
    // the in-flight (here, deliberately partial) bytes.
    const strayTmp = proposalFile('interrupted') + '.tmp';
    writeFileSync(strayTmp, '{ "id": "interrupted", "status": "pen', 'utf8'); // truncated mid-write
    expect(existsSync(strayTmp)).toBe(true);

    // The committed proposal is surfaced; the .tmp sidecar is NOT — listProposals
    // filters out *.tmp, so a reader never sees the partial write.
    const ids = listProposals().map((x) => x.id);
    expect(ids).toContain(committed.id);
    expect(ids).not.toContain('interrupted');
    // loadProposal targets <id>.json (never the .tmp), so the in-flight id is absent.
    expect(loadProposal('interrupted')).toBeNull();
    // Only the one real PENDING proposal is counted — nothing trapped in limbo.
    expect(pendingCount()).toBe(1);

    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('a half-written / truncated <id>.json is skipped, not loaded as a partial proposal', () => {
    const treeBefore = repo.shasumTree();
    const good = seedPendingProposal(repo.dir, 'good');

    // Worst case: a rename DID land but with truncated bytes (a torn write on a
    // non-atomic FS). The store must never return a half-parsed record. Write a
    // syntactically-broken JSON to a committed <id>.json path.
    const tornPath = proposalFile('torn');
    writeFileSync(tornPath, '{ "id": "torn", "status": "pending", "title": "tr', 'utf8');
    expect(existsSync(tornPath)).toBe(true);

    // listProposals skips the unparseable file (try/catch around JSON.parse) and
    // still surfaces the good one; loadProposal('torn') returns null, not a
    // partial. Neither throws.
    const ids = listProposals().map((x) => x.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain('torn');
    expect(loadProposal('torn')).toBeNull();

    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('a structurally-valid-JSON-but-not-a-Proposal file is skipped, never surfaced as limbo', () => {
    const treeBefore = repo.shasumTree();
    const good = seedPendingProposal(repo.dir, 'good2');

    // A complete write that is valid JSON but missing required Proposal fields
    // (e.g. an unrelated object dropped into the inbox dir). isValidProposal
    // rejects it so it can never masquerade as a stuck/limbo proposal.
    const bogusPath = proposalFile('bogus');
    writeFileSync(bogusPath, JSON.stringify({ hello: 'world' }, null, 2), 'utf8');

    const ids = listProposals().map((x) => x.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain('bogus');
    expect(loadProposal('bogus')).toBeNull();
    expect(pendingCount()).toBe(1); // only the genuine pending proposal

    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('the committed proposal round-trips byte-equal even amid interrupted-write debris', () => {
    const treeBefore = repo.shasumTree();
    const p = seedPendingProposal(repo.dir, 'amid-debris');
    const bytesAtCrash = proposalBytes(p.id);

    // Surround the good record with every flavor of crash debris at once.
    writeFileSync(proposalFile('a') + '.tmp', '{ partial', 'utf8');
    writeFileSync(proposalFile('b'), 'not json at all', 'utf8');
    writeFileSync(proposalFile('c'), JSON.stringify({ id: 'c' }), 'utf8'); // missing fields

    // The genuine PENDING proposal is unaffected — byte-identical, still loadable.
    expect(proposalBytes(p.id)).toBe(bytesAtCrash);
    const reloaded = loadProposal(p.id);
    expect(reloaded).toEqual(p);
    expect(reloaded?.status).toBe('pending');
    // Exactly one real proposal survives the debris field.
    expect(listProposals().map((x) => x.id)).toEqual([p.id]);
    expect(pendingCount()).toBe(1);

    expect(repo.shasumTree()).toBe(treeBefore);
  });
});
