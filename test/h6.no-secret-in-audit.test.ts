/**
 * h6.no-secret-in-audit.test.ts — Ashlr v2.1 MILESTONE H6, PART A (the
 * NO-SECRET-IN-AUDIT proof). See docs/contracts/CONTRACT-H6.md §A.2.
 *
 * INVARIANT proven here:
 *
 *   NO-SECRET-IN-AUDIT — every append-only ~/.ashlr/audit/<date>.jsonl record is
 *   METADATA ONLY. Even when secret-SHAPED data is driven into a record's
 *   `summary` through a REAL state-changing path (a proposal TITLE, an
 *   applyProposal refusal `detail`, a repo path), `audit()`'s stripSecrets()
 *   backstop (src/core/sandbox/audit.ts:50-83) redacts every token-shaped value
 *   to `[REDACTED]` BEFORE the line is appended — the raw secret NEVER lands on
 *   disk. And the NEW H6 enroll/unenroll/setKill records (emitted inside
 *   policy.ts per §A.2) carry ONLY metadata: an action verb, a repo ABS PATH (a
 *   path is not a secret), result 'ok' — never a token.
 *
 * WHY THESE PATHS:
 *   - createProposal (inbox/store.ts:144) audits action 'inbox:proposal-created'
 *     with `summary: 'proposal created: [<kind>] <TITLE> (id=<id>)'` — the
 *     proposal TITLE is interpolated VERBATIM into the summary, so a token-shaped
 *     title is the cleanest deterministic way to drive a secret toward a record.
 *   - applyProposal (inbox/apply.ts:282-365) audits action 'inbox:apply' whose
 *     summary embeds the gate `detail` (which contains a resolved repo path) and
 *     the proposal id — another caller-influenced string reaching a summary.
 *   - enroll/unenroll/setKill (policy.ts, the H6 §A.2 additions) audit with a
 *     summary built from the resolved repo ABS PATH — metadata, never a token.
 *
 * stripSecrets() PATTERNS CITED (audit.ts:50-83 — the audit-specific scrubber,
 * distinct from knowledge/index.ts SECRET_PATTERNS). Each SECRET_SHAPE below is
 * chosen to trip a specific one:
 *   - `Bearer <tok>`               → /\b(Bearer|Token|Authorization)\s+…/gi
 *   - `api_key=<8+>`               → /\b(api[_-]?key|secret|token|…)[=:\s]+…{8,}/gi
 *   - `sk-<16+>` (OpenAI/Anthropic)→ /\bsk-[A-Za-z0-9_-]{16,}/g
 *   - `ghp_<16+>` (GitHub PAT)     → /\bgh[poursa]_[A-Za-z0-9]{16,}/g
 *   - `AKIA<16>` (AWS access key)  → /\bAKIA[0-9A-Z]{16}\b/g
 *   - `eyJ….….…` (JWT)            → /\beyJ[A-Za-z0-9_-]+\.…\.…/g
 *   - 64-char hex (raw key/hash)   → /\b[0-9a-fA-F]{64,}\b/g
 *
 * SAFETY (inherited verbatim from H1/H2/H4/H5):
 *   - ISOLATED HOME per test via makeFixture(): every ~/.ashlr read/write
 *     (enrollment, KILL, audit) resolves to a FRESH os.tmpdir() home — NEVER the
 *     real one; the real portfolio ({repos:[]}) is never touched.
 *   - DISPOSABLE REPOS only (fx.makeRepo); DETERMINISTIC (no model, no network).
 *   - Every it() has a real expect() + expect.hasAssertions().
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  enroll,
  unenroll,
  setKill,
} from '../src/core/sandbox/policy.js';
import { createProposal } from '../src/core/inbox/store.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';

let fx: H1Fixture | undefined;
let repo: DisposableRepo;

afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function setupRepo(): void {
  fx = makeFixture();
  repo = fx.makeRepo();
}

// ---------------------------------------------------------------------------
// Audit reader over the ISOLATED ~/.ashlr/audit/ tree (test-local; never the
// real home — `home` is always fx.home, a fresh os.tmpdir() dir).
// ---------------------------------------------------------------------------

interface RawAudit {
  ts?: string;
  action?: string;
  repo?: string | null;
  sandboxId?: string | null;
  summary?: string;
  result?: string;
}

/** Parsed audit records across every JSONL file in the isolated audit dir. */
function readAuditRecords(home: string): RawAudit[] {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return [];
  const out: RawAudit[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as RawAudit);
      } catch {
        /* tolerate a partial trailing line */
      }
    }
  }
  return out;
}

/**
 * The RAW on-disk bytes of the entire isolated audit dir (every JSONL file
 * concatenated). This is the ULTIMATE backstop check: the secret must not appear
 * ANYWHERE on disk, regardless of which field or record it might have leaked
 * into. Asserting against the raw bytes (not just parsed summaries) means a leak
 * into any field — summary, repo, a malformed line — is still caught.
 */
function rawAuditBytes(home: string): string {
  const dir = join(home, '.ashlr', 'audit');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('');
}

// ---------------------------------------------------------------------------
// Secret SHAPES — each trips a distinct audit.ts stripSecrets() pattern. None of
// these is a real credential; each is a synthetic, well-known-shaped token whose
// raw form must NEVER survive into an audit record.
// ---------------------------------------------------------------------------

const SECRET_BEARER = 'Bearer abcDEF1234567890ghIJKLmnop';
const SECRET_APIKEY = 'api_key=s3cr3tValue0123456789';
const SECRET_SK = 'sk-abcdefghijklmnop0123456789ABCD';
const SECRET_GHP = 'ghp_abcdefghijklmnop0123456789ABCDEF12';
const SECRET_AKIA = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SECRET_HEX64 =
  'deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d';

/** The raw bodies that must NEVER appear in any persisted audit line. */
const SECRET_RAW_BODIES = [
  'abcDEF1234567890ghIJKLmnop', // Bearer body
  's3cr3tValue0123456789', // api_key value
  SECRET_SK,
  SECRET_GHP,
  SECRET_AKIA,
  SECRET_JWT,
  SECRET_HEX64,
];

/** Every secret shape, for title-stuffing a single proposal. */
const ALL_SHAPES = [
  SECRET_BEARER,
  SECRET_APIKEY,
  SECRET_SK,
  SECRET_GHP,
  SECRET_AKIA,
  SECRET_JWT,
  SECRET_HEX64,
];

/** Assert no raw secret body appears anywhere in the on-disk audit bytes. */
function assertNoRawSecretOnDisk(home: string): void {
  const bytes = rawAuditBytes(home);
  for (const body of SECRET_RAW_BODIES) {
    expect(bytes).not.toContain(body);
  }
}

// ===========================================================================
// 1 — Token-shaped PROPOSAL TITLE never lands raw in the proposal-created record.
//     createProposal interpolates the title verbatim into the audit summary;
//     stripSecrets() must redact every shape to [REDACTED] before the append.
// ===========================================================================

describe('H6 · NO-SECRET-IN-AUDIT · proposal title is scrubbed in the record', () => {
  it('a token-shaped proposal title is redacted to [REDACTED] in the audit summary', () => {
    expect.hasAssertions();
    setupRepo();

    // Drive a REAL createProposal whose TITLE carries every secret shape. The
    // title flows verbatim into the 'inbox:proposal-created' audit summary.
    const title = `fix auth: ${ALL_SHAPES.join(' ')}`;
    createProposal({
      repo: repo.dir,
      origin: 'manual',
      kind: 'note',
      title,
      summary: 'a note proposal carrying secret-shaped data in its title',
    });

    const recs = readAuditRecords(fx!.home);
    const created = recs.find((r) => r.action === 'inbox:proposal-created');
    expect(created).toBeDefined();
    // The summary exists, references the proposal, and the redaction marker is
    // present (proving stripSecrets() actually fired over the token-shaped body).
    expect(created?.summary).toContain('proposal created');
    expect(created?.summary).toContain('[REDACTED]');

    // CRITICAL: NO raw secret body survives in the record OR anywhere on disk.
    const line = JSON.stringify(created);
    for (const body of SECRET_RAW_BODIES) {
      expect(line).not.toContain(body);
    }
    assertNoRawSecretOnDisk(fx!.home);
  });

  it('each individual secret SHAPE is redacted (per-pattern coverage)', () => {
    expect.hasAssertions();
    setupRepo();

    // One proposal per shape so a single mis-fire is attributable to its pattern.
    for (const shape of ALL_SHAPES) {
      createProposal({
        repo: repo.dir,
        origin: 'manual',
        kind: 'note',
        title: `leak attempt ${shape}`,
        summary: 'per-shape redaction probe',
      });
    }

    const created = readAuditRecords(fx!.home).filter(
      (r) => r.action === 'inbox:proposal-created',
    );
    // One created record per shape.
    expect(created.length).toBe(ALL_SHAPES.length);
    // Every created summary that carried a shape now shows the redaction marker
    // and NONE retains a raw secret body.
    for (const rec of created) {
      expect(rec.summary).toContain('[REDACTED]');
    }
    assertNoRawSecretOnDisk(fx!.home);
  });
});

// ===========================================================================
// 2 — applyProposal refusal: secret-shaped detail / id flows into the
//     'inbox:apply' summary and is scrubbed. We drive the not-found refusal with
//     a token-shaped proposal id (interpolated into the summary verbatim) and a
//     gate refusal whose detail embeds a repo path.
// ===========================================================================

describe('H6 · NO-SECRET-IN-AUDIT · applyProposal refusal summaries are scrubbed', () => {
  it('a token-shaped value in a not-found refusal SUMMARY is redacted', async () => {
    expect.hasAssertions();
    setupRepo();

    // applyProposal('<id>', …) on a missing id audits
    //   summary: `refused: proposal <id> not found`
    // — the id string is interpolated verbatim INTO THE SUMMARY. Drive a token
    // shape THROUGH the summary (the field stripSecrets() scrubs). NOTE: we use a
    // token shape as the lookup id purely to land it in the summary; the
    // system-generated id slot itself is not an attacker-controlled secret sink.
    // GitHub-PAT shape (ghp_…) trips /\bgh[poursa]_[A-Za-z0-9]{16,}/g.
    const tokenInSummary = SECRET_GHP;
    const res = await applyProposal(tokenInSummary, { confirmed: true });
    expect(res.ok).toBe(false); // real refusal path exercised

    const recs = readAuditRecords(fx!.home);
    const refused = recs.find(
      (r) => r.action === 'inbox:apply' && r.result === 'refused',
    );
    expect(refused).toBeDefined();
    // The SUMMARY (the scrubbed field) redacted the token-shaped body.
    expect(refused?.summary).toContain('[REDACTED]');
    expect(refused?.summary).not.toContain(tokenInSummary);
  });

  it('a policy-gate refusal detail (kill switch ON) is audited with no secret', async () => {
    expect.hasAssertions();
    setupRepo();
    repo.enroll();

    // Create a real 'patch' proposal, approve it, then turn the kill switch ON so
    // applyProposal hits the assertMayMutate refusal whose detail is folded into
    // the audit summary. The proposal SUMMARY also carries a secret shape to prove
    // nothing token-shaped reaches disk via this path either.
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'manual',
      kind: 'patch',
      title: 'kill-switch refusal probe',
      summary: `context ${SECRET_JWT}`,
      diff: 'diff --git a/x b/x\n', // unused: gate refuses before dispatch
    });

    // Move to approved via the real status primitive (import lazily to avoid an
    // unused import when not needed elsewhere).
    const { setStatus } = await import('../src/core/inbox/store.js');
    setStatus(proposal.id, 'approved');

    setKill(true); // kill switch wins → assertMayMutate throws → refusal audited
    const res = await applyProposal(proposal.id, { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('approved'); // refusal, not a burned proposal

    const recs = readAuditRecords(fx!.home);
    const refused = recs.find(
      (r) =>
        r.action === 'inbox:apply' &&
        r.result === 'refused' &&
        (r.summary ?? '').includes('policy gate'),
    );
    expect(refused).toBeDefined();
    // No secret body anywhere on disk (covers the proposal-created record whose
    // summary carried SECRET_JWT AND the refusal record).
    assertNoRawSecretOnDisk(fx!.home);
  });
});

// ===========================================================================
// 3 — The NEW H6 enroll/unenroll/setKill records carry ONLY metadata.
//     §A.2: action verb + repo ABS PATH (a path is not a secret) + result 'ok'.
//     Assert the record shape AND that no token survives even when the repo is
//     enrolled/unenrolled — these are the records H6 ADDS, so they get the
//     strictest metadata-only check.
// ===========================================================================

describe('H6 · NO-SECRET-IN-AUDIT · enroll/unenroll/setKill records are metadata-only', () => {
  it('enroll → enroll:add ok, repo=abs path, no token; sandboxId null', () => {
    expect.hasAssertions();
    setupRepo();

    enroll(repo.dir);

    const rec = readAuditRecords(fx!.home).find(
      (r) => r.action === 'enroll:add' && r.result === 'ok',
    );
    expect(rec).toBeDefined();
    // repo is the resolved ABS PATH — metadata, not a secret.
    expect(rec?.repo).toBe(resolve(repo.dir));
    expect(rec?.sandboxId).toBeNull();
    // The whole serialized record contains NO secret-shaped body.
    const line = JSON.stringify(rec);
    for (const body of SECRET_RAW_BODIES) {
      expect(line).not.toContain(body);
    }
  });

  it('unenroll → enroll:remove ok with repo=abs path and no token', () => {
    expect.hasAssertions();
    setupRepo();

    enroll(repo.dir);
    unenroll(repo.dir);

    const rec = readAuditRecords(fx!.home).find(
      (r) => r.action === 'enroll:remove' && r.result === 'ok',
    );
    expect(rec).toBeDefined();
    expect(rec?.repo).toBe(resolve(repo.dir));
    const line = JSON.stringify(rec);
    for (const body of SECRET_RAW_BODIES) {
      expect(line).not.toContain(body);
    }
  });

  it('setKill on/off → kill:on / kill:off ok with repo=null and no token', () => {
    expect.hasAssertions();
    setupRepo();

    setKill(true);
    setKill(false);

    const recs = readAuditRecords(fx!.home);
    const on = recs.find((r) => r.action === 'kill:on' && r.result === 'ok');
    const off = recs.find((r) => r.action === 'kill:off' && r.result === 'ok');
    expect(on).toBeDefined();
    expect(off).toBeDefined();
    // Kill toggle is not repo-scoped — repo MUST be null (no path, no token).
    expect(on?.repo).toBeNull();
    expect(off?.repo).toBeNull();
    // And the summaries carry no token-shaped value.
    for (const body of SECRET_RAW_BODIES) {
      expect(JSON.stringify(on)).not.toContain(body);
      expect(JSON.stringify(off)).not.toContain(body);
    }
  });
});

// ===========================================================================
// 4 — WHOLE-TRAIL backstop: drive a mixed sequence of state-changing actions —
//     enroll, a secret-titled proposal, a refused apply, kill toggle — and assert
//     the ENTIRE audit trail on disk contains NO raw secret body, while still
//     showing the redaction marker (proving the scrubber ran, not that nothing
//     was written).
// ===========================================================================

describe('H6 · NO-SECRET-IN-AUDIT · whole audit trail is secret-free end-to-end', () => {
  it('a mixed action sequence leaves zero raw secrets across the entire trail', async () => {
    expect.hasAssertions();
    setupRepo();

    enroll(repo.dir);
    createProposal({
      repo: repo.dir,
      origin: 'manual',
      kind: 'note',
      title: `trail probe ${SECRET_SK} ${SECRET_AKIA}`,
      summary: `body ${SECRET_BEARER}`,
    });
    await applyProposal('prop-does-not-exist', { confirmed: true }); // not-found refusal
    setKill(true);
    setKill(false);
    unenroll(repo.dir);

    const recs = readAuditRecords(fx!.home);
    // We exercised at least: enroll:add, inbox:proposal-created, inbox:apply
    // (refused), kill:on, kill:off, enroll:remove.
    const actions = new Set(recs.map((r) => r.action));
    expect(actions.has('enroll:add')).toBe(true);
    expect(actions.has('inbox:proposal-created')).toBe(true);
    expect(actions.has('inbox:apply')).toBe(true);
    expect(actions.has('kill:on')).toBe(true);
    expect(actions.has('kill:off')).toBe(true);
    expect(actions.has('enroll:remove')).toBe(true);

    // Redaction DID fire somewhere in the trail (the token-shaped title/body/id).
    const bytes = rawAuditBytes(fx!.home);
    expect(bytes).toContain('[REDACTED]');

    // CRITICAL: not one raw secret body anywhere on disk.
    assertNoRawSecretOnDisk(fx!.home);
  });
});
