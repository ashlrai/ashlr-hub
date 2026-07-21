/**
 * h7.rollback.test.ts — Ashlr v2.1 MILESTONE H7, BUILD ITEM 4.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H7.md):
 *  - ROLLBACK-INWARD-ONLY: `ashlr onboard --rollback <repo> [--kill]` only
 *    NARROWS state — unenroll(repo) + sweepOrphanSandboxes({staleMs}) (a LIVE
 *    owner-pid sandbox is NEVER force-removed) + (opt-in --kill) setKill(true).
 *    It can NEVER widen access or trigger an outward action. The full trail is
 *    audited by the H6 audit() inside policy.ts (enroll:remove [+ kill:on]).
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5/H6):
 *  - ISOLATED HOME per test via makeFixture; DISPOSABLE REPOS (fx.makeRepo);
 *    DETERMINISTIC (no model, no network). createSandbox on a disposable repo
 *    uses the allowAnyRepo test hatch under ASHLR_TEST_ALLOW_ANY_REPO=1.
 *  - Every it.todo MUST become a real expect() + expect.hasAssertions() in BUILD.
 */

import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixture, type H1Fixture, type DisposableRepo } from './helpers/h1-fixture.js';
import { makeOrphanSandbox, sandboxHomeExists } from './helpers/h2-faults.js';
import { rollback, cmdOnboard } from '../src/cli/onboard.js';
import { enrollmentPath, listEnrolled, killSwitchOn } from '../src/core/sandbox/policy.js';
import {
  listSandboxes,
  sandboxesDir,
  createSandbox,
  ORPHAN_STALE_MS,
} from '../src/core/sandbox/worktree.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import {
  acquireOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import type { AuditEntry } from '../src/core/types.js';

const ENV_KEY = 'ASHLR_TEST_ALLOW_ANY_REPO';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  realCalls: 0,
  nativeFenceAcquired: false,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      privateStorageHarness.realCalls += 1;
      return actual.assurePrivateStoragePath(...args);
    },
  };
});

let fx: H1Fixture | undefined;
let repo: DisposableRepo | undefined;
let prevEnv: string | undefined;

beforeAll(() => {
  const proofFixture = makeFixture();
  privateStorageHarness.useSemanticAdapter = false;
  try {
    const fence = acquireOutwardMutationFence();
    if (!fence) throw new Error('H7 fixture could not acquire native outward authority');
    privateStorageHarness.nativeFenceAcquired = true;
    releaseOutwardMutationFence(fence);
  } finally {
    // The rollback cases prove semantics, not the same expensive Windows ACL
    // adapter invocation twelve times. The native proof above remains explicit.
    privateStorageHarness.useSemanticAdapter = true;
    proofFixture.cleanup();
  }
}, 45_000);

beforeEach(() => {
  privateStorageHarness.useSemanticAdapter = true;
  fx = makeFixture();
  prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = '1'; // H5 env-gate: allow makeOrphanSandbox on a tmp repo
  repo = fx.makeRepo();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  prevEnv = undefined;
  fx?.cleanup();
  fx = undefined;
  repo = undefined;
  vi.restoreAllMocks();
});

/** Back-date a sandbox's persisted createdAt so it reads as stale (> staleMs). */
function backdateCreatedAt(id: string, ageMs: number): void {
  const metaFile = join(sandboxesDir(), id, 'sandbox.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { createdAt: string };
  meta.createdAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** Silence the human-readable summary rollback() prints to stdout. */
function muteStdout(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

describe('h7 rollback — one-command inward-only undo', () => {
  it('unenrolls the repo (listEnrolled drops the repo) after rollback', async () => {
    expect.hasAssertions();
    expect(privateStorageHarness.nativeFenceAcquired).toBe(true);
    if (process.platform === 'win32') {
      expect(privateStorageHarness.realCalls).toBeGreaterThan(0);
    }
    const r = repo!;
    r.enroll();
    // Precondition: the disposable repo IS enrolled before rollback.
    expect(listEnrolled()).toContain(resolve(r.dir));

    muteStdout();
    const code = await rollback(r.dir, { kill: false });

    expect(code).toBe(0);
    // The repo is gone from the enrollment registry — the gate is narrowed.
    expect(listEnrolled()).not.toContain(resolve(r.dir));
    expect(listEnrolled()).toEqual([]);
  });

  it('sweeps the repo crash-leftover orphan sandboxes (a dead-owner sandbox is removed)', async () => {
    expect.hasAssertions();
    const r = repo!;
    r.enroll();

    // A crash-leftover sandbox: makeOrphanSandbox strips ownerPid (no live owner),
    // and we back-date it past the stale threshold so the age guard reclaims it.
    const orphan = makeOrphanSandbox(r.dir);
    backdateCreatedAt(orphan.id, ORPHAN_STALE_MS * 2);

    // Precondition: the orphan exists on disk and is listed.
    expect(sandboxHomeExists(orphan.id)).toBe(true);
    expect(listSandboxes().map((s) => s.id)).toContain(orphan.id);

    muteStdout();
    const code = await rollback(r.dir, { kill: false });

    expect(code).toBe(0);
    // The orphan worktree + its home are reclaimed.
    expect(sandboxHomeExists(orphan.id)).toBe(false);
    expect(listSandboxes().map((s) => s.id)).not.toContain(orphan.id);
  });

  it('NEVER force-removes a LIVE owner-pid sandbox during the sweep', async () => {
    expect.hasAssertions();
    const r = repo!;
    r.enroll();

    // A LIVE sandbox: createSandbox stamps ownerPid = THIS test process's pid,
    // which is alive — sweepOrphanSandboxes's ownerAlive guard must SKIP it
    // regardless of age. Back-date it so ONLY the live-owner guard protects it.
    const live = createSandbox(r.dir, { allowAnyRepo: true });
    backdateCreatedAt(live.id, ORPHAN_STALE_MS * 2);
    expect(sandboxHomeExists(live.id)).toBe(true);

    muteStdout();
    const code = await rollback(r.dir, { kill: false });

    expect(code).toBe(0);
    // The live worktree is preserved — a running swarm is never reclaimed.
    expect(sandboxHomeExists(live.id)).toBe(true);
    expect(listSandboxes().map((s) => s.id)).toContain(live.id);
  }, 30_000);

  it('--kill sets the kill switch ON (killSwitchOn() === true); default leaves it OFF', async () => {
    expect.hasAssertions();
    const r1 = repo!;
    r1.enroll();
    expect(killSwitchOn()).toBe(false);

    // Default (no --kill): kill switch stays OFF.
    muteStdout();
    await rollback(r1.dir, { kill: false });
    expect(killSwitchOn()).toBe(false);

    // With --kill: kill switch flips ON (the most restrictive state).
    const r2 = fx!.makeRepo();
    r2.enroll();
    await rollback(r2.dir, { kill: true });
    expect(killSwitchOn()).toBe(true);
  });

  it(
    'ROLLBACK-INWARD-ONLY: the H6 audit trail records enroll:remove (and kill:on with --kill); ' +
      'no outward action is taken',
    async () => {
      expect.hasAssertions();
      const r = repo!;
      r.enroll();

      // Snapshot the disposable repo's tree + branches BEFORE rollback so we can
      // prove rollback touched neither (inward cleanup only — no apply/push/PR).
      const treeBefore = r.shasumTree();
      const branchesBefore = r.branches().sort();
      const headBefore = r.currentBranch();

      muteStdout();
      await rollback(r.dir, { kill: true });

      // --- AUDIT TRAIL (H6): enroll:remove + kill:on recorded, all result 'ok'.
      const records = readAudit();
      const abs = resolve(r.dir);
      const unenrollRec = records.find(
        (e: AuditEntry) => e.action === 'enroll:remove' && e.repo === abs,
      );
      expect(unenrollRec).toBeDefined();
      expect(unenrollRec!.result).toBe('ok');

      const killRec = records.find((e: AuditEntry) => e.action === 'kill:on');
      expect(killRec).toBeDefined();
      expect(killRec!.result).toBe('ok');

      // --- NO OUTWARD ACTION: the only audited verbs are inward — enroll:remove,
      // kill:on, and (if any sandbox was swept) sandbox:remove. There must be NO
      // apply/push/PR/deploy verb anywhere in the trail.
      const verbs = new Set(records.map((e: AuditEntry) => e.action));
      for (const verb of verbs) {
        expect(verb).not.toMatch(/apply|push|pr[:.]|deploy|ship|merge/i);
      }

      // --- REAL REPO UNTOUCHED: tree bytes, branches, and HEAD are identical.
      expect(r.shasumTree()).toBe(treeBefore);
      expect(r.branches().sort()).toEqual(branchesBefore);
      expect(r.currentBranch()).toBe(headBefore);
      expect(r.gitStatus()).toBe(''); // clean working tree
    },
  );

  it('reclaims a FRESH (non-back-dated) dead-owner sandbox of the rolled-back repo', async () => {
    // The just-onboarded repo's crash-leftover worktree is < ORPHAN_STALE_MS old.
    // The scoped rollback sweep drops the age guard (but KEEPS the live-owner
    // guard), so this fresh dead-owner orphan IS reclaimed — proving the
    // marketed one-command undo actually cleans up a fresh first-activation
    // leftover (the generic 6h orphan sweep would have skipped it).
    expect.hasAssertions();
    const r = repo!;
    r.enroll();

    // makeOrphanSandbox strips ownerPid (a GONE owner) but leaves createdAt at
    // NOW — deliberately NOT back-dated, so only the dropped age guard would
    // have protected it under the old generic sweep.
    const fresh = makeOrphanSandbox(r.dir);
    expect(sandboxHomeExists(fresh.id)).toBe(true);
    const ageMs = Date.now() - Date.parse(
      JSON.parse(
        readFileSync(join(sandboxesDir(), fresh.id, 'sandbox.json'), 'utf8'),
      ).createdAt as string,
    );
    expect(ageMs).toBeLessThan(ORPHAN_STALE_MS); // genuinely fresh

    muteStdout();
    const code = await rollback(r.dir, { kill: false });

    expect(code).toBe(0);
    // The fresh leftover is reclaimed despite being younger than ORPHAN_STALE_MS.
    expect(sandboxHomeExists(fresh.id)).toBe(false);
    expect(listSandboxes().map((s) => s.id)).not.toContain(fresh.id);
  });

  it('resolves a lexical repo alias to the physical enrollment and sandbox authority', async () => {
    expect.hasAssertions();
    const r = repo!;
    const other = fx!.makeRepo();
    const physicalRepo = realpathSync.native(r.dir);
    const macVarPrefix = '/private/var/';
    const lexicalAlias = process.platform === 'darwin' && physicalRepo.startsWith(macVarPrefix)
      ? `/var/${physicalRepo.slice(macVarPrefix.length)}`
      : join(fx!.home, 'repo-lexical-alias');
    if (lexicalAlias.startsWith(fx!.home)) {
      symlinkSync(physicalRepo, lexicalAlias, process.platform === 'win32' ? 'junction' : 'dir');
    }

    // On macOS this uses the literal /var -> /private/var alias. Elsewhere an
    // explicit symlink/junction provides the same lexical/physical distinction.
    expect(resolve(lexicalAlias)).not.toBe(physicalRepo);
    expect(realpathSync.native(lexicalAlias)).toBe(physicalRepo);
    r.enroll();
    const orphan = makeOrphanSandbox(r.dir);
    const otherOrphan = makeOrphanSandbox(other.dir);
    expect(listEnrolled()).toContain(physicalRepo);
    expect(listSandboxes().find((sandbox) => sandbox.id === orphan.id)?.sourceRepo)
      .toBe(physicalRepo);

    muteStdout();
    const code = await rollback(lexicalAlias, { kill: false });

    expect(code).toBe(0);
    expect(listEnrolled()).not.toContain(physicalRepo);
    expect(sandboxHomeExists(orphan.id)).toBe(false);
    expect(listSandboxes().map((sandbox) => sandbox.id)).not.toContain(orphan.id);
    expect(sandboxHomeExists(otherOrphan.id)).toBe(true);
    expect(listSandboxes().map((sandbox) => sandbox.id)).toContain(otherOrphan.id);
  }, 15_000);

  it('narrows and sweeps both physical and exact legacy alias-spelled authority', async () => {
    expect.hasAssertions();
    const r = repo!;
    const physicalRepo = realpathSync.native(r.dir);
    const lexicalAlias = join(fx!.home, 'legacy-repo-alias');
    symlinkSync(physicalRepo, lexicalAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const exactLexicalRepo = resolve(lexicalAlias);
    expect(exactLexicalRepo).not.toBe(physicalRepo);

    r.enroll();
    const physicalOrphan = makeOrphanSandbox(r.dir);
    const lexicalOrphan = makeOrphanSandbox(r.dir);
    const lexicalMetaPath = join(sandboxesDir(), lexicalOrphan.id, 'sandbox.json');
    const lexicalMeta = JSON.parse(readFileSync(lexicalMetaPath, 'utf8')) as Record<string, unknown>;
    lexicalMeta.sourceRepo = exactLexicalRepo;
    writeFileSync(lexicalMetaPath, `${JSON.stringify(lexicalMeta, null, 2)}\n`, 'utf8');
    writeFileSync(
      enrollmentPath(),
      `${JSON.stringify({ repos: [physicalRepo, exactLexicalRepo] }, null, 2)}\n`,
      'utf8',
    );
    expect(listEnrolled()).toEqual([physicalRepo, exactLexicalRepo]);

    muteStdout();
    const code = await rollback(lexicalAlias, { kill: false });

    expect(code).toBe(0);
    expect(listEnrolled()).toEqual([]);
    expect(sandboxHomeExists(physicalOrphan.id)).toBe(false);
    expect(sandboxHomeExists(lexicalOrphan.id)).toBe(false);
    expect(listSandboxes().map((sandbox) => sandbox.id)).not.toContain(physicalOrphan.id);
    expect(listSandboxes().map((sandbox) => sandbox.id)).not.toContain(lexicalOrphan.id);
  }, 15_000);

  it('is SCOPED — rollback of repo A leaves a DIFFERENT repo B fresh orphan untouched', async () => {
    expect.hasAssertions();
    const a = repo!;
    const b = fx!.makeRepo();
    a.enroll();
    b.enroll();

    // A fresh dead-owner orphan for EACH repo.
    const orphanA = makeOrphanSandbox(a.dir);
    const orphanB = makeOrphanSandbox(b.dir);
    expect(sandboxHomeExists(orphanA.id)).toBe(true);
    expect(sandboxHomeExists(orphanB.id)).toBe(true);

    muteStdout();
    await rollback(a.dir, { kill: false });

    // A's leftover is reclaimed; B's is NEVER touched (scope guard).
    expect(sandboxHomeExists(orphanA.id)).toBe(false);
    expect(sandboxHomeExists(orphanB.id)).toBe(true);
    expect(listSandboxes().map((s) => s.id)).toContain(orphanB.id);
  }, 15_000);

  it('NEVER force-removes a LIVE owner-pid sandbox during the SCOPED rollback sweep', async () => {
    // The scoped sweep drops the AGE guard but must KEEP the live-owner guard:
    // a fresh sandbox owned by THIS (alive) test process must survive rollback.
    expect.hasAssertions();
    const r = repo!;
    r.enroll();

    const live = createSandbox(r.dir, { allowAnyRepo: true });
    expect(sandboxHomeExists(live.id)).toBe(true);

    muteStdout();
    const code = await rollback(r.dir, { kill: false });

    expect(code).toBe(0);
    expect(sandboxHomeExists(live.id)).toBe(true);
    expect(listSandboxes().map((s) => s.id)).toContain(live.id);
  });

  it('cmdOnboard([--rollback, repo]) resolves the repo positional and unenrolls it', async () => {
    // Drive the REAL CLI entry point (not the internal rollback() helper) so the
    // arg-parsing + repo-resolution path is exercised end-to-end.
    expect.hasAssertions();
    const r = repo!;
    r.enroll();
    expect(listEnrolled()).toContain(resolve(r.dir));

    muteStdout();
    const code = await cmdOnboard(['--rollback', r.dir]);

    expect(code).toBe(0);
    expect(listEnrolled()).not.toContain(resolve(r.dir));
    expect(listEnrolled()).toEqual([]);
    expect(killSwitchOn()).toBe(false); // no --kill ⇒ kill stays OFF
  });

  it('cmdOnboard([--rollback, repo, --kill]) parses --kill and sets the kill switch ON', async () => {
    expect.hasAssertions();
    const r = repo!;
    r.enroll();
    expect(killSwitchOn()).toBe(false);

    muteStdout();
    const code = await cmdOnboard(['--rollback', r.dir, '--kill']);

    expect(code).toBe(0);
    expect(listEnrolled()).not.toContain(resolve(r.dir));
    expect(killSwitchOn()).toBe(true);
  });
});
