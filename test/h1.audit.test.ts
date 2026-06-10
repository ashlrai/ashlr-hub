/**
 * test/h1.audit.test.ts — H1 BUILD task 3: AUDIT TRAIL + ISOLATION proof.
 *
 * Proves (a) the append-only audit log under the ISOLATED ~/.ashlr/audit records
 * the full outward-relevant chain with NO gaps —
 *
 *     inbox:proposal-created (ok)
 *       -> inbox:proposal-approved (ok)
 *       -> inbox:apply (ok)
 *
 * each carrying the AuditEntry shape (repo / sandboxId / summary / result); a
 * refused apply writes inbox:apply (refused); the log is append-only; and NO
 * secret-shaped token ever lands in a summary —
 *
 * and (b) ISOLATION — the REAL ~/.ashlr is never read or written: homedir() stays
 * the tmp HOME, enrollmentPath()/auditDir() resolve under it, the real
 * enrollment.json (captured before the suite) is byte-identical after, and
 * cleanup() removes the tmp HOME and restores process.env.HOME exactly.
 *
 * DETERMINISM: zero live-LLM dependency. The audit trail is exercised by the REAL
 * createProposal / setStatus / applyProposal path against a KNOWN unified diff
 * (exactly as the swarm's propose path would record one) on a DISPOSABLE enrolled
 * repo. No model, no swarm subprocess, no network.
 *
 * Invariants proven: ISOLATED, PROPOSAL-ONLY (apply is the sole outward path and
 * is fully audited), and audit-trail completeness + append-only + no-secrets.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  withTmpHome,
  makeFixture,
  makeAddFileDiff,
} from './helpers/h1-fixture.js';
import { readAudit, auditDir } from '../src/core/sandbox/audit.js';
import { enrollmentPath, listEnrolled } from '../src/core/sandbox/policy.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import type { AuditEntry } from '../src/core/types.js';

// ===========================================================================
// Helpers — read the raw audit log + chronological (oldest-first) view
// ===========================================================================

/** Absolute paths of every .jsonl file in the isolated audit dir. */
function auditFiles(): string[] {
  const dir = auditDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => join(dir, f));
}

/** Concatenated raw bytes of the whole isolated audit log. */
function rawAudit(): string {
  return auditFiles()
    .map((p) => readFileSync(p, 'utf8'))
    .join('');
}

/**
 * Audit entries oldest-first. readAudit() returns newest-first; reverse it so
 * order assertions read as the chain actually fired (created -> approved -> apply).
 */
function chronologicalAudit(): AuditEntry[] {
  return readAudit().slice().reverse();
}

/** First chronological entry matching `action`, or undefined. */
function firstByAction(action: string): AuditEntry | undefined {
  return chronologicalAudit().find((e) => e.action === action);
}

/** Every AuditEntry carries the required forensic fields. */
function assertEntryShape(e: AuditEntry): void {
  expect(typeof e.ts).toBe('string');
  expect(typeof e.action).toBe('string');
  // repo + sandboxId always present (may be null).
  expect('repo' in e).toBe(true);
  expect('sandboxId' in e).toBe(true);
  expect(typeof e.summary).toBe('string');
  expect(['ok', 'refused', 'error']).toContain(e.result);
}

// ===========================================================================
// Audit trail — the chain is fully recorded with no gaps
// ===========================================================================

describe('H1 audit trail — the chain is fully recorded', () => {
  it('audit dir resolves UNDER the tmp HOME (~/.ashlr/audit), not the real one', async () => {
    await withTmpHome((fx) => {
      const dir = auditDir();
      // Under the isolated HOME, ending in .ashlr/audit.
      expect(resolve(dir).startsWith(resolve(fx.home))).toBe(true);
      expect(dir).toMatch(/[/\\]\.ashlr[/\\]audit$/);
      expect(resolve(dir).startsWith(resolve(fx.ashlrDir))).toBe(true);
    });
  });

  it(
    'a completed chain writes inbox:proposal-created -> inbox:proposal-approved ' +
      '-> inbox:apply(ok), each with the AuditEntry shape',
    async () => {
      await withTmpHome(async (fx) => {
        const repo = fx.makeRepo();
        repo.enroll();

        const diff = makeAddFileDiff('docs/audit-chain.md', '# audit chain\n');
        const created = createProposal({
          repo: repo.dir,
          origin: 'swarm',
          kind: 'patch',
          title: 'add audit-chain doc',
          summary: 'adds docs/audit-chain.md',
          diff,
          sandboxId: 'sb-audit-1',
        });

        setStatus(created.id, 'approved');
        const result = await applyProposal(created.id, { confirmed: true });
        expect(result.ok).toBe(true);
        expect(result.status).toBe('applied');

        // ── completeness: every outward-relevant action is recorded ──────────
        const createdEntry = firstByAction('inbox:proposal-created');
        const approvedEntry = firstByAction('inbox:proposal-approved');
        const applyEntries = chronologicalAudit().filter(
          (e) => e.action === 'inbox:apply',
        );

        expect(createdEntry).toBeDefined();
        expect(approvedEntry).toBeDefined();
        expect(applyEntries.length).toBeGreaterThanOrEqual(1);

        // The apply success entry (result 'ok') exists — that is the outward act.
        const applyOk = applyEntries.find((e) => e.result === 'ok');
        expect(applyOk).toBeDefined();

        // ── shape: each entry carries repo / sandboxId / summary / result ────
        for (const e of [createdEntry!, approvedEntry!, applyOk!]) {
          assertEntryShape(e);
        }

        // ── field fidelity: repo + sandboxId propagate to the trail ──────────
        expect(createdEntry!.repo).toBe(repo.dir);
        expect(createdEntry!.sandboxId).toBe('sb-audit-1');
        expect(createdEntry!.result).toBe('ok');

        expect(approvedEntry!.repo).toBe(repo.dir);
        expect(approvedEntry!.result).toBe('ok');

        expect(applyOk!.repo).toBe(repo.dir);
        expect(applyOk!.result).toBe('ok');

        // summaries reference the proposal so the trail is auditable end-to-end.
        expect(createdEntry!.summary).toContain(created.id);
        expect(approvedEntry!.summary).toContain(created.id);
        expect(applyOk!.summary).toContain(created.id);
      });
    },
  );

  it(
    'the three chain actions are recorded in chain order ' +
      '(created before approved before apply-ok)',
    async () => {
      await withTmpHome(async (fx) => {
        const repo = fx.makeRepo();
        repo.enroll();

        const created = createProposal({
          repo: repo.dir,
          origin: 'swarm',
          kind: 'patch',
          title: 'ordered chain',
          summary: 'order proof',
          diff: makeAddFileDiff('order.txt', 'ordered\n'),
          sandboxId: 'sb-order',
        });
        setStatus(created.id, 'approved');
        const r = await applyProposal(created.id, { confirmed: true });
        expect(r.ok).toBe(true);

        const chron = chronologicalAudit();
        const idxCreated = chron.findIndex(
          (e) => e.action === 'inbox:proposal-created',
        );
        const idxApproved = chron.findIndex(
          (e) => e.action === 'inbox:proposal-approved',
        );
        const idxApplyOk = chron.findIndex(
          (e) => e.action === 'inbox:apply' && e.result === 'ok',
        );

        expect(idxCreated).toBeGreaterThanOrEqual(0);
        expect(idxApproved).toBeGreaterThan(idxCreated);
        expect(idxApplyOk).toBeGreaterThan(idxApproved);
      });
    },
  );

  it('a refused applyProposal writes an inbox:apply entry with result "refused"', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();

      // Proposal is created but NEVER approved — applyProposal must refuse.
      const created = createProposal({
        repo: repo.dir,
        origin: 'swarm',
        kind: 'patch',
        title: 'pending patch',
        summary: 'should be refused while pending',
        diff: makeAddFileDiff('refused.txt', 'nope\n'),
        sandboxId: 'sb-refuse',
      });

      const result = await applyProposal(created.id, { confirmed: true });
      expect(result.ok).toBe(false);

      const refusal = chronologicalAudit().find(
        (e) => e.action === 'inbox:apply' && e.result === 'refused',
      );
      expect(refusal).toBeDefined();
      assertEntryShape(refusal!);
      expect(refusal!.result).toBe('refused');
      // The refusal carries the proposal id (as sandboxId) for forensics.
      expect(refusal!.sandboxId).toBe(created.id);
      expect(refusal!.summary).toContain(created.id);

      // PROPOSAL-ONLY: a refusal mutated nothing — the real tree is untouched.
      expect(repo.gitStatus()).toBe('');
      expect(repo.branches()).not.toContain(`ashlr/proposal/${created.id}`);
    });
  });

  it('every refusal mode in a refusal run is audited (unconfirmed, pending, rejected, not-found)', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();

      const diff = makeAddFileDiff('r.txt', 'r\n');

      // (1) approved + UNCONFIRMED -> refused
      const p1 = createProposal({
        repo: repo.dir, origin: 'swarm', kind: 'patch',
        title: 'unconfirmed', summary: 'no confirm', diff, sandboxId: 'sb-1',
      });
      setStatus(p1.id, 'approved');
      expect((await applyProposal(p1.id, { confirmed: false })).ok).toBe(false);

      // (2) PENDING + confirmed -> refused
      const p2 = createProposal({
        repo: repo.dir, origin: 'swarm', kind: 'patch',
        title: 'pending', summary: 'still pending', diff, sandboxId: 'sb-2',
      });
      expect((await applyProposal(p2.id, { confirmed: true })).ok).toBe(false);

      // (3) REJECTED + confirmed -> refused
      const p3 = createProposal({
        repo: repo.dir, origin: 'swarm', kind: 'patch',
        title: 'rejected', summary: 'was rejected', diff, sandboxId: 'sb-3',
      });
      setStatus(p3.id, 'rejected');
      expect((await applyProposal(p3.id, { confirmed: true })).ok).toBe(false);

      // (4) NOT FOUND -> refused
      expect(
        (await applyProposal('prop-does-not-exist', { confirmed: true })).ok,
      ).toBe(false);

      // Each refusal produced an audited inbox:apply(refused) line.
      const refusals = chronologicalAudit().filter(
        (e) => e.action === 'inbox:apply' && e.result === 'refused',
      );
      expect(refusals.length).toBeGreaterThanOrEqual(4);
      for (const e of refusals) assertEntryShape(e);

      // The not-found refusal references the missing id.
      expect(
        refusals.some((e) => e.summary.includes('prop-does-not-exist')),
      ).toBe(true);

      // No outward action occurred across the entire refusal run.
      expect(repo.gitStatus()).toBe('');
    });
  });

  it('audit log is append-only: a second action never rewrites a prior line', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();

      const created = createProposal({
        repo: repo.dir, origin: 'swarm', kind: 'patch',
        title: 'append-only', summary: 'append-only proof',
        diff: makeAddFileDiff('append.txt', 'one\n'), sandboxId: 'sb-append',
      });

      // Snapshot the raw log right after creation.
      const rawAfterCreate = rawAudit();
      expect(rawAfterCreate.length).toBeGreaterThan(0);
      const sizeAfterCreate = rawAfterCreate.length;

      // Drive two more actions.
      setStatus(created.id, 'approved');
      await applyProposal(created.id, { confirmed: true });

      const rawAfterApply = rawAudit();

      // Append-only: the file only GREW, and the exact earlier prefix bytes are
      // unchanged — no prior line was rewritten or truncated.
      expect(rawAfterApply.length).toBeGreaterThan(sizeAfterCreate);
      expect(rawAfterApply.startsWith(rawAfterCreate)).toBe(true);

      // Every line is independently parseable JSON (JSONL integrity).
      const lines = rawAfterApply.split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      // All three chain actions survived into the final log.
      expect(rawAfterApply).toContain('"action":"inbox:proposal-created"');
      expect(rawAfterApply).toContain('"action":"inbox:proposal-approved"');
      expect(rawAfterApply).toContain('"action":"inbox:apply"');
    });
  });

  it('no secret-shaped tokens appear in any audit summary', async () => {
    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();

      // Plant secret-shaped tokens in the human-readable proposal fields that
      // flow into audit summaries. stripSecrets() must redact them before they
      // are persisted — the raw audit bytes must never contain them.
      const OPENAI = 'sk-live-ABCDEF0123456789ABCDEF0123456789';
      const GH_PAT = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const BEARER_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789';

      const created = createProposal({
        repo: repo.dir,
        origin: 'swarm',
        kind: 'patch',
        // Secrets planted in BOTH title and summary (both reach audit summaries).
        title: `leak ${OPENAI}`,
        summary: `token ${GH_PAT} and Bearer ${BEARER_TOKEN}`,
        diff: makeAddFileDiff('secret.txt', 'safe content\n'),
        sandboxId: 'sb-secret',
      });
      setStatus(created.id, 'approved', `decided with ${OPENAI}`);
      await applyProposal(created.id, { confirmed: true });

      const raw = rawAudit();
      expect(raw.length).toBeGreaterThan(0);

      // No planted secret survives verbatim anywhere in the audit log.
      expect(raw).not.toContain(OPENAI);
      expect(raw).not.toContain(GH_PAT);
      expect(raw).not.toContain(BEARER_TOKEN);

      // Defense-in-depth: no common secret pattern matches anywhere in the log.
      expect(raw).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
      expect(raw).not.toMatch(/\bgh[poursa]_[A-Za-z0-9]{16,}/);
      expect(raw).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{20,}/);

      // And readAudit() returns the same redacted content (no secrets parsed back).
      for (const e of readAudit()) {
        expect(e.summary).not.toContain(OPENAI);
        expect(e.summary).not.toContain(GH_PAT);
        expect(e.summary).not.toContain(BEARER_TOKEN);
      }
    });
  });
});

// ===========================================================================
// ISOLATION — the real ~/.ashlr is never touched
// ===========================================================================

describe('H1 ISOLATION — the real ~/.ashlr is never touched', () => {
  it('homedir() resolves to the tmp HOME for the whole fixture lifetime', async () => {
    await withTmpHome((fx) => {
      expect(resolve(homedir())).toBe(resolve(fx.home));
      // A full chain runs entirely under the tmp HOME — homedir() never drifts.
      const repo = fx.makeRepo();
      repo.enroll();
      expect(resolve(homedir())).toBe(resolve(fx.home));
    });
  });

  it('enrollmentPath() and auditDir() point under the tmp HOME, not $REAL_HOME/.ashlr', async () => {
    await withTmpHome((fx) => {
      expect(resolve(enrollmentPath()).startsWith(resolve(fx.home))).toBe(true);
      expect(resolve(auditDir()).startsWith(resolve(fx.home))).toBe(true);
      expect(enrollmentPath()).toMatch(/[/\\]\.ashlr[/\\]enrollment\.json$/);
    });
  });

  it(
    'the real ~/.ashlr/enrollment.json (captured before the suite) is byte-identical ' +
      'after a full chain — the real portfolio is never enrolled/unenrolled',
    async () => {
      // Capture the REAL enrollment registry BEFORE relocating HOME.
      const realEnrollmentPath = enrollmentPath();
      const realExisted = existsSync(realEnrollmentPath);
      const realBefore = realExisted
        ? readFileSync(realEnrollmentPath, 'utf8')
        : null;
      // Sanity: the real portfolio is the empty default the suite must preserve.
      if (realBefore !== null) {
        expect(JSON.parse(realBefore)).toEqual({ repos: [] });
      }

      await withTmpHome(async (fx) => {
        const repo = fx.makeRepo();
        repo.enroll();
        // Only the tmp repo is enrolled — in the ISOLATED registry.
        expect(listEnrolled()).toContain(repo.dir);

        const created = createProposal({
          repo: repo.dir, origin: 'swarm', kind: 'patch',
          title: 'isolation', summary: 'isolation proof',
          diff: makeAddFileDiff('iso.txt', 'iso\n'), sandboxId: 'sb-iso',
        });
        setStatus(created.id, 'approved');
        await applyProposal(created.id, { confirmed: true });
      });

      // After HOME is restored, the REAL enrollment.json is byte-for-byte intact.
      expect(existsSync(realEnrollmentPath)).toBe(realExisted);
      if (realBefore !== null) {
        expect(readFileSync(realEnrollmentPath, 'utf8')).toBe(realBefore);
        expect(JSON.parse(readFileSync(realEnrollmentPath, 'utf8'))).toEqual({
          repos: [],
        });
      }
    },
  );

  it('the real audit dir gains NO new files from the suite (audit wrote only under tmp HOME)', async () => {
    // Capture the real audit dir's file list BEFORE relocating HOME.
    const realAuditDir = auditDir();
    const realFilesBefore = existsSync(realAuditDir)
      ? readdirSync(realAuditDir).sort()
      : [];

    await withTmpHome(async (fx) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const created = createProposal({
        repo: repo.dir, origin: 'swarm', kind: 'patch',
        title: 'audit-iso', summary: 'audit isolation',
        diff: makeAddFileDiff('a.txt', 'a\n'), sandboxId: 'sb-aiso',
      });
      setStatus(created.id, 'approved');
      await applyProposal(created.id, { confirmed: true });
      // The chain DID write audit lines — under the tmp HOME.
      expect(readAudit().length).toBeGreaterThan(0);
    });

    // The REAL audit dir is unchanged: same files (or still absent).
    const realFilesAfter = existsSync(realAuditDir)
      ? readdirSync(realAuditDir).sort()
      : [];
    expect(realFilesAfter).toEqual(realFilesBefore);
  });

  it('cleanup() removes the tmp HOME and restores process.env.HOME exactly', () => {
    const prevHome = process.env.HOME;

    const fx = makeFixture();
    // Inside the fixture, HOME points at the fresh tmp dir and it exists.
    expect(process.env.HOME).toBe(fx.home);
    expect(existsSync(fx.home)).toBe(true);
    expect(resolve(homedir())).toBe(resolve(fx.home));

    fx.cleanup();

    // HOME is restored EXACTLY and the tmp HOME is gone.
    expect(process.env.HOME).toBe(prevHome);
    expect(existsSync(fx.home)).toBe(false);

    // cleanup() is idempotent — a second call never throws.
    expect(() => fx.cleanup()).not.toThrow();
    expect(process.env.HOME).toBe(prevHome);
  });
});
