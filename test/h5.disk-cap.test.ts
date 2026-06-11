/**
 * h5.disk-cap.test.ts — H5 CHANGE 4 (sandbox disk/count cap).
 *
 * INVARIANT proven here:
 *  - DISK-CAP-BOUNDED: sandbox count never exceeds MAX_SANDBOXES. On overflow,
 *    createSandbox FIRST sweeps stale orphans; if still over, it REFUSES with a
 *    clean audited error rather than accumulate — and NEVER removes a non-stale
 *    (in-use) sandbox.
 *
 * The cap is exercised with a SMALL deterministic bound via the ASHLR_MAX_SANDBOXES
 * env override (resolved at call time by worktree.ts's maxSandboxes()), so the
 * suite proves the real createSandbox cap logic without creating 16 worktrees.
 * Every it() has a real expect() + expect.hasAssertions(). Isolated tmp HOME +
 * disposable repos. The allowAnyRepo env toggle is set so tmp repos can be
 * sandboxed (and stays correct whether or not CHANGE 3's env-gate has landed).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSandbox,
  listSandboxes,
  sandboxesDir,
  ORPHAN_STALE_MS,
} from '../src/core/sandbox/worktree.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

let fx: H1Fixture;
let repo: DisposableRepo;

const ALLOW_KEY = 'ASHLR_TEST_ALLOW_ANY_REPO';
const CAP_KEY = 'ASHLR_MAX_SANDBOXES';
let prevAllow: string | undefined;
let prevCap: string | undefined;

afterEach(() => {
  if (prevAllow === undefined) delete process.env[ALLOW_KEY];
  else process.env[ALLOW_KEY] = prevAllow;
  if (prevCap === undefined) delete process.env[CAP_KEY];
  else process.env[CAP_KEY] = prevCap;
  prevAllow = undefined;
  prevCap = undefined;
  fx?.cleanup();
});

/**
 * Spin up an isolated fixture with a SMALL sandbox cap so the cap path is cheap
 * + deterministic. The allowAnyRepo hatch is enabled for the tmp repo.
 */
function setup(cap: number): void {
  fx = makeFixture();
  prevAllow = process.env[ALLOW_KEY];
  prevCap = process.env[CAP_KEY];
  process.env[ALLOW_KEY] = '1';
  process.env[CAP_KEY] = String(cap);
  repo = fx.makeRepo();
}

// Mirror the SHARED, exported production threshold so the test can never drift
// from prod (the cap pre-sweep uses ORPHAN_STALE_MS for its age fallback).
const STALE_MS = ORPHAN_STALE_MS;

/**
 * Back-date a sandbox's createdAt so the cap pre-sweep treats it as a genuine
 * crash leftover. Because these sandboxes were created LIVE in this test process
 * (createSandbox stamps ownerPid: process.pid), we ALSO strip ownerPid so the
 * sweep does not (correctly) protect it as a live worktree — modeling a crashed
 * owner. Stale createdAt + no live owner is exactly what a crash leftover is.
 */
function backdateCreatedAt(id: string, ageMs: number): void {
  const metaFile = join(sandboxesDir(), id, 'sandbox.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
  meta['createdAt'] = new Date(Date.now() - ageMs).toISOString();
  delete meta['ownerPid'];
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** Count on-disk per-sandbox home directories under sandboxesDir(). */
function sandboxHomeDirCount(): number {
  const dir = sandboxesDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  ).length;
}

describe('H5 · sandbox disk/count cap · DISK-CAP-BOUNDED', () => {
  it('creating up to the cap SUCCEEDS (count tracks the creates, never exceeds the cap)', () => {
    expect.hasAssertions();
    const CAP = 3;
    setup(CAP);

    const created: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const sb = createSandbox(repo.dir, { allowAnyRepo: true });
      expect(sb.id).toMatch(/^[0-9a-f]+$/);
      created.push(sb.id);
    }

    // Exactly CAP sandboxes persisted; every created id is present; none lost.
    const ids = listSandboxes().map((s) => s.id);
    expect(ids).toHaveLength(CAP);
    for (const id of created) expect(ids).toContain(id);
    // Never exceeded the bound.
    expect(listSandboxes().length).toBeLessThanOrEqual(CAP);
  });

  it('at the cap with only FRESH sandboxes, a new createSandbox REFUSES (clean audited error, no partial worktree)', () => {
    expect.hasAssertions();
    const CAP = 3;
    setup(CAP);

    const fresh: string[] = [];
    for (let i = 0; i < CAP; i++) {
      fresh.push(createSandbox(repo.dir, { allowAnyRepo: true }).id);
    }
    expect(listSandboxes()).toHaveLength(CAP);

    const homesBefore = sandboxHomeDirCount();
    const auditsBefore = readAudit().length;

    // The (CAP+1)-th create must REFUSE with a clean error mentioning the cap.
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /sandbox cap reached \(MAX_SANDBOXES=3\)/,
    );

    // Still exactly CAP — refusal did not accumulate, and every fresh sandbox
    // survives untouched (no eviction to make room).
    const idsAfter = listSandboxes().map((s) => s.id);
    expect(idsAfter).toHaveLength(CAP);
    for (const id of fresh) expect(idsAfter).toContain(id);

    // No partial worktree home left behind by the refused create — the on-disk
    // home-dir count is unchanged (the refusal happens BEFORE any mkdir / git
    // worktree add for the new id).
    expect(sandboxHomeDirCount()).toBe(homesBefore);

    // The refusal is AUDITED as result:'refused' with the cap reason, and no
    // 'ok' create audit was emitted for the refused attempt.
    const allAudits = readAudit();
    const newAudits = allAudits.slice(0, allAudits.length - auditsBefore);
    const refusal = newAudits.find(
      (a) =>
        a.action === 'sandbox:create' &&
        a.result === 'refused' &&
        /sandbox cap reached/.test(a.summary),
    );
    expect(refusal).toBeTruthy();
    expect(refusal?.sandboxId).toBeNull();
    expect(
      newAudits.some((a) => a.action === 'sandbox:create' && a.result === 'ok'),
    ).toBe(false);
  });

  it('at the cap with a STALE orphan, the auto-sweep reclaims it and the create then SUCCEEDS (self-heal)', () => {
    expect.hasAssertions();
    const CAP = 3;
    setup(CAP);

    const ids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      ids.push(createSandbox(repo.dir, { allowAnyRepo: true }).id);
    }
    expect(listSandboxes()).toHaveLength(CAP);

    // Back-date ONE existing sandbox so the pre-sweep treats it as a genuine
    // crash leftover (older than ORPHAN_STALE_MS).
    const staleId = ids[0]!;
    backdateCreatedAt(staleId, STALE_MS * 2);

    // At the cap → createSandbox sweeps the stale one FIRST, then succeeds.
    const fresh = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(fresh.id).toMatch(/^[0-9a-f]+$/);

    const after = listSandboxes().map((s) => s.id);
    // The stale orphan was reclaimed; the new one exists; still bounded at CAP.
    expect(after).not.toContain(staleId);
    expect(after).toContain(fresh.id);
    expect(after).toHaveLength(CAP);
    expect(after.length).toBeLessThanOrEqual(CAP);
    // The stale orphan's on-disk home is gone (swept, not merely de-listed).
    expect(existsSync(join(sandboxesDir(), staleId))).toBe(false);
  });

  it('the cap pre-sweep NEVER removes a LIVE (owner-alive) sandbox even when aged PAST staleMs (the HIGH-finding fix)', () => {
    expect.hasAssertions();
    const CAP = 2;
    setup(CAP);

    // Two sandboxes created LIVE in this process (createSandbox stamps ownerPid =
    // this alive process). Age ONE of them far past ORPHAN_STALE_MS WITHOUT
    // killing its owner — modeling a genuinely long-running swarm worktree (no
    // wall-clock cap exists). A naive age-only pre-sweep would force-remove it;
    // the positive ownerPid liveness guard must protect it.
    const live = createSandbox(repo.dir, { allowAnyRepo: true });
    createSandbox(repo.dir, { allowAnyRepo: true });
    expect(listSandboxes()).toHaveLength(CAP);

    // Age createdAt only — KEEP the live owner pid (no backdateCreatedAt here,
    // which would strip ownerPid).
    const metaFile = join(sandboxesDir(), live.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    meta['createdAt'] = new Date(Date.now() - STALE_MS * 4).toISOString();
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // At the cap → pre-sweep runs. It must NOT reclaim the live-but-old sandbox
    // (owner still alive), so the cap is still full → the new create REFUSES.
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /sandbox cap reached/,
    );

    // The live-but-old sandbox survives (was never force-removed out from under
    // its running owner) and its scratch branch is intact.
    expect(listSandboxes().map((s) => s.id)).toContain(live.id);
    expect(existsSync(join(sandboxesDir(), live.id))).toBe(true);
    expect(repo.branches()).toContain(`ashlr/sandbox/${live.id}`);
  });

  it('the cap NEVER removes a live/FRESH sandbox to make room (no stale → refuse, all fresh survive byte-identical)', () => {
    expect.hasAssertions();
    const CAP = 2;
    setup(CAP);

    const a = createSandbox(repo.dir, { allowAnyRepo: true });
    const b = createSandbox(repo.dir, { allowAnyRepo: true });
    expect(listSandboxes()).toHaveLength(CAP);

    // Snapshot both fresh sandboxes' on-disk metadata before the refused create.
    const metaA = readFileSync(join(sandboxesDir(), a.id, 'sandbox.json'), 'utf8');
    const metaB = readFileSync(join(sandboxesDir(), b.id, 'sandbox.json'), 'utf8');

    // No sandbox is stale → the pre-sweep reclaims nothing → REFUSE. The cap must
    // NEVER evict a live/fresh sandbox to make room.
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(
      /sandbox cap reached/,
    );

    // Both fresh sandboxes still present AND their metadata is byte-identical —
    // proving the cap removed nothing in-use.
    const idsAfter = listSandboxes().map((s) => s.id);
    expect(idsAfter).toContain(a.id);
    expect(idsAfter).toContain(b.id);
    expect(idsAfter).toHaveLength(CAP);
    expect(readFileSync(join(sandboxesDir(), a.id, 'sandbox.json'), 'utf8')).toBe(metaA);
    expect(readFileSync(join(sandboxesDir(), b.id, 'sandbox.json'), 'utf8')).toBe(metaB);

    // The source repo's branches still include both sandbox scratch branches —
    // no branch was deleted by an eviction.
    const branches = repo.branches();
    expect(branches).toContain(`ashlr/sandbox/${a.id}`);
    expect(branches).toContain(`ashlr/sandbox/${b.id}`);
  });
});
