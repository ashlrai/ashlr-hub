/**
 * fixes.ts — Deterministic advisory SAFE FIXES + PROPOSAL emission (M27).
 *
 * HARD SAFETY INVARIANTS (enforced throughout this file):
 *  - PROPOSAL-ONLY: emitFixProposals routes each SafeFix to the M23 Approval
 *    Inbox via createProposal() as a PENDING proposal (status 'pending', NEVER
 *    auto-advanced/applied). The default proposal kind is 'note' (advisory, no
 *    diff), origin 'manual'.
 *  - READ-ONLY / NO MUTATION: deriveSafeFixes is a pure function of a
 *    HealthScore. NEITHER function writes to a user repo, writes CONFIG, pushes,
 *    opens a PR, or deploys. There is NO apply path here.
 *  - OPTIONAL SANDBOX-PATCH (STRETCH, documented only): if a deterministic fix
 *    diff is ever generated, it MUST be produced in an M21 sandbox worktree
 *    (src/core/sandbox/*) and attached to a PENDING 'patch' proposal — NEVER
 *    written to the real tree, NEVER pushed. The DEFAULT is advisory 'note's.
 *  - Bounded: caps fixes emitted per run. Never throws (createProposal best-effort).
 *  - No secrets: SafeFix / proposal fields are advisory metadata only.
 */

import type { HealthDimension, HealthScore, Proposal, SafeFix, WorkItem } from '../types.js';
import { createProposal } from '../inbox/store.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard cap on advisory fixes derived per repo (bounds inbox noise). */
const MAX_FIXES_PER_REPO = 10;

/** Max worst-offenders to mine for fixes (defensive — worstOffenders is already capped upstream). */
const MAX_OFFENDERS_SCANNED = 20;

// ---------------------------------------------------------------------------
// Convention probe -> advisory fix mapping
// ---------------------------------------------------------------------------

/**
 * Deterministic mapping from a FAILED ConventionFinding.key to the advisory
 * fix it implies. Each entry yields a stable SafeFix.key, the dimension the fix
 * improves, and a short title. The rationale is composed from the probe's own
 * (already secret-free) detail at derive time. Keys not present here are
 * skipped — we only advise fixes we can phrase concretely.
 */
const CONVENTION_FIXES: Record<
  string,
  { key: string; dimension: HealthDimension; title: string }
> = {
  license: { key: 'docs.add-license', dimension: 'docs', title: 'Add a LICENSE file' },
  readme: { key: 'docs.add-readme', dimension: 'docs', title: 'Add or expand the README' },
  gitignore: {
    key: 'conventions.add-gitignore',
    dimension: 'conventions',
    title: 'Add a .gitignore',
  },
  lockfile: {
    key: 'conventions.add-lockfile',
    dimension: 'conventions',
    title: 'Commit a dependency lockfile',
  },
  ci: { key: 'conventions.add-ci', dimension: 'conventions', title: 'Add a CI workflow' },
  testdir: { key: 'tests.add-test', dimension: 'tests', title: 'Add a test suite' },
};

// ---------------------------------------------------------------------------
// WorkItem (worst-offender) -> advisory fix mapping
// ---------------------------------------------------------------------------

/** Deterministic, key-safe slug of an arbitrary title (bounded length). */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Map a worst-offender WorkItem onto a SafeFix when it represents an actionable,
 * concretely-phraseable gap (vulnerable/stale dep, missing test, high TODO debt).
 * Returns null for sources we cannot phrase a safe deterministic advisory for
 * (e.g. open issues, security findings — surfaced in the report, not auto-noted).
 *
 * Deterministic; the per-item `key` is namespaced by source so distinct findings
 * dedupe independently (e.g. one fix per vulnerable dependency).
 */
function fixFromOffender(item: WorkItem): SafeFix | null {
  switch (item.source) {
    case 'dep':
      return {
        repo: item.repo,
        dimension: 'deps',
        key: `deps.upgrade:${slug(item.title)}`,
        title: `Update dependency: ${item.title}`,
        rationale: `A dependency finding is dragging the deps score down: ${item.detail}`,
        proposalKind: 'note',
      };
    case 'test':
      return {
        repo: item.repo,
        dimension: 'tests',
        key: `tests.add-test:${slug(item.title)}`,
        title: `Add test coverage: ${item.title}`,
        rationale: `A test gap is lowering the tests score: ${item.detail}`,
        proposalKind: 'note',
      };
    case 'todo':
      return {
        repo: item.repo,
        dimension: 'codeDebt',
        key: `codeDebt.resolve:${slug(item.title)}`,
        title: `Resolve code-debt marker: ${item.title}`,
        rationale: `An accumulating TODO/FIXME marker is adding code debt: ${item.detail}`,
        proposalKind: 'note',
      };
    default:
      // issue / doc / security offenders are reported but not auto-noted as fixes
      // here — they map onto convention probes (docs) or are advisory-only signals.
      return null;
  }
}

// ---------------------------------------------------------------------------
// deriveSafeFixes — pure, deterministic
// ---------------------------------------------------------------------------

/**
 * Derive deterministic, advisory SafeFix[] from a per-repo HealthScore.
 *
 * Walks the score's failed convention probes (ok === false) and worst offenders,
 * mapping each actionable, concretely-phraseable gap into an advisory SafeFix:
 *  - missing LICENSE      -> { dimension:'docs',        key:'docs.add-license' }
 *  - missing README       -> { dimension:'docs',        key:'docs.add-readme' }
 *  - missing .gitignore   -> { dimension:'conventions', key:'conventions.add-gitignore' }
 *  - missing lockfile/CI  -> { dimension:'conventions', key:'conventions.add-{lockfile,ci}' }
 *  - vulnerable/stale dep  -> { dimension:'deps',        key:'deps.upgrade:<pkg>' }
 *  - missing test          -> { dimension:'tests',       key:'tests.add-test[:…]' }
 *  - high TODO debt        -> { dimension:'codeDebt',    key:'codeDebt.resolve:…' }
 *
 * Pure function (no I/O), deterministic ordering, deduped by `key`, bounded to
 * MAX_FIXES_PER_REPO. Every SafeFix defaults to proposalKind 'note' (advisory).
 * NEVER mutates anything.
 */
export function deriveSafeFixes(score: HealthScore): SafeFix[] {
  const repo = score.repo;
  // Insertion-ordered dedupe by key. Convention fixes are collected first
  // (highest-leverage, lowest-effort gaps), then offender-derived fixes.
  const byKey = new Map<string, SafeFix>();

  // 1) Failed convention probes -> known advisory fixes.
  for (const finding of score.conventions) {
    if (finding.ok) continue;
    const mapped = CONVENTION_FIXES[finding.key];
    if (mapped === undefined) continue;
    if (byKey.has(mapped.key)) continue;
    byKey.set(mapped.key, {
      repo,
      dimension: mapped.dimension,
      key: mapped.key,
      title: mapped.title,
      rationale: finding.detail || `${finding.label} convention is not satisfied.`,
      proposalKind: 'note',
    });
  }

  // 2) Worst-offender WorkItems -> per-finding advisory fixes.
  const offenders = score.worstOffenders.slice(0, MAX_OFFENDERS_SCANNED);
  for (const item of offenders) {
    const fix = fixFromOffender(item);
    if (fix === null) continue;
    if (byKey.has(fix.key)) continue;
    byKey.set(fix.key, fix);
  }

  // Deterministic ordering: convention fixes lead (insertion order); offender
  // fixes preserve the upstream worst-first ordering of worstOffenders.
  return [...byKey.values()].slice(0, MAX_FIXES_PER_REPO);
}

// ---------------------------------------------------------------------------
// emitFixProposals — PENDING inbox proposals (PROPOSAL-ONLY)
// ---------------------------------------------------------------------------

/**
 * Emit each SafeFix as a PENDING M23 Approval Inbox proposal.
 *
 * For each fix: createProposal({ repo, origin: 'manual', kind: 'note', title,
 * summary }) — status is assigned 'pending' BY THE STORE and NEVER auto-advanced.
 * Default kind is 'note' (advisory, no diff). M27 does NOT apply patches and does
 * NOT mutate working trees here; this module advances no proposal status, pushes
 * nothing, opens no PR, and deploys nothing — createProposal() is its ONLY effect.
 *
 * (STRETCH, NOT wired by default) A fix with proposalKind 'patch' would require
 * generating its diff in an M21 sandbox worktree and attaching it as a PENDING
 * 'patch' proposal with the sandboxId — never written to the real tree. This
 * build emits NOTES ONLY; any 'patch'-kind SafeFix is downgraded to a 'note'
 * proposal here (no diff is produced), keeping the inbox advisory.
 *
 * Returns the created Proposal[] (pending). Never throws (createProposal is
 * best-effort and returns the in-memory proposal even on persistence failure).
 */
export function emitFixProposals(fixes: SafeFix[]): Proposal[] {
  const proposals: Proposal[] = [];
  for (const fix of fixes) {
    try {
      const proposal = createProposal({
        repo: fix.repo,
        origin: 'manual',
        // NOTES-ONLY in this build: never attach a diff, never request 'patch'
        // application. A 'patch' SafeFix is recorded as an advisory note here.
        kind: 'note',
        title: `[health] ${fix.title}`,
        summary:
          `${fix.rationale}\n\n` +
          `Dimension: ${fix.dimension} · fix-key: ${fix.key} · repo: ${fix.repo}\n` +
          `Advisory only — review and apply manually. This proposal mutates nothing.`,
      });
      proposals.push(proposal);
    } catch {
      // Best-effort: a single createProposal failure must not abort the batch.
    }
  }
  return proposals;
}
