/**
 * Positive post-merge learning authority — the release protocol.
 *
 * A realized merge is an immutable operational fact, not proof that the
 * change remained beneficial. This module is the ONLY place allowed to mint
 * "post-merge credit release" authority, and it does so conservatively:
 *
 *   1. The proposal must carry an AUTHENTICATED realized-merge witness
 *      (authenticatedRealizedMergeOf — binds to this exact proposal via a
 *      local receipt HMAC or host reconciliation; shape alone is never
 *      authority).
 *   2. At least MIN_POST_MERGE_OBSERVATION_WINDOW_MS must have elapsed since
 *      the merge was observed. The regression sentinel / outcome watcher
 *      (outcome-watcher.ts) sweeps merged proposals on a 6h throttle with a
 *      7-day follow-up window; 14 days gives ~2x that follow-up window and
 *      dozens of scan cycles of headroom before we trust the silence.
 *   3. The signed, observation-only post-merge-observations ledger
 *      (post-merge-observations.ts) must contain NO adverse record
 *      ('regressed' | 'reverted' | 'followed-up') for this exact
 *      (repo, proposalId, mergeCommit) event, and the ledger must have read
 *      back healthy/complete (a degraded read fails closed — we never treat
 *      "couldn't check" as "checked clean").
 *
 * That ledger is adverse-only (it never records a positive "we checked, it's
 * clean" row), so eligibility here is inherently a "silence after a
 * conservative window" heuristic, not a positive confirmation. That is a
 * known, documented limitation — see sweepPostMergeCreditReleases' doc
 * comment — not an oversight.
 *
 * MINTING: hasReleasedPostMergeCredit(labelBasis) verifies a self-describing,
 * HMAC-signed token — NOT bare string equality against
 * POST_MERGE_CREDIT_RELEASE_LABEL. This is deliberate: several downstream
 * consumers persist labelBasis-shaped fields on structures that are, at least
 * in tests and in caller-authored proposal/ledger data, fully attacker/
 * test-controlled. A bare literal is trivially replayable; only a value
 * carrying a valid local-key HMAC over the specific (repo, proposalId,
 * mergeCommit) event can pass. isPostMergeCreditReleaseLabel() remains
 * "structural recognition only" — matching the bare literal — for the
 * existing defensive filters elsewhere that specifically reject the
 * unauthenticated literal (e.g. skill-records.ts, decisions-ledger.ts).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { loadOrCreateKey, signSkillCardAttestation } from '../foundry/provenance.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { causalMetadataFromProposal } from '../learning/causal.js';
import type { Proposal, SkillCard } from '../types.js';
import { readDecisions, recordDecision } from './decisions-ledger.js';
import { postMergeObservationEventId, readPostMergeObservations } from './post-merge-observations.js';
import { skillCardContentHash } from './skill-attestation.js';

// ---------------------------------------------------------------------------
// Structural constants
// ---------------------------------------------------------------------------

export const POST_MERGE_CREDIT_POLICY_VERSION = 'post-merge-credit-v1' as const;
export const POST_MERGE_CREDIT_RELEASE_LABEL = 'post-merge-credit-release-v1' as const;

/** Structural recognition only; this string is not release authority. */
export function isPostMergeCreditReleaseLabel(labelBasis: unknown): boolean {
  return labelBasis === POST_MERGE_CREDIT_RELEASE_LABEL;
}

/**
 * Minimum wall-clock time since the realized merge before credit MAY be
 * released. See module doc for rationale (~2x the outcome-watcher follow-up
 * window, dozens of throttled scan cycles of headroom).
 */
export const MIN_POST_MERGE_OBSERVATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Domain-separated HMAC payload prefix for minted credit tokens. */
const CREDIT_TOKEN_DOMAIN = 'ashlr:post-merge-credit-release:v1';

/**
 * Both segments are truncated to 24 hex chars (96 bits each) — plenty for
 * MAC-forgery infeasibility and event-identifier collision-resistance at
 * fleet scale, and DELIBERATELY short for two independent reasons discovered
 * empirically (see test/post-merge-credit-release.test.ts):
 *   1. decisions-ledger.ts's generic secret-scrubber (util/scrub.ts) redacts
 *      any bare 64+ char hex run as a likely API key/hash — a 64-char segment
 *      would be silently corrupted the moment it passed through
 *      recordDecision().
 *   2. recordDecision() -> sanitizeDecisionEntry() unconditionally ends with
 *      normalizeDecisionLearningFields() (learning/causal.ts), which re-runs
 *      causalMetadata() and applies boundedText(labelBasis, 80) — ANY
 *      labelBasis over 80 chars is silently truncated, with no way to opt
 *      out from a caller outside that module. The full token
 *      ("post-merge-credit-release-v1:" (30 chars) + eventRef + ':' + mac)
 *      must fit in 80 chars total, so each hex segment is capped at 24
 *      (30 + 24 + 1 + 24 = 79).
 * Neither constraint is owned by this module; 24 hex chars satisfies both
 * with margin.
 */
const CREDIT_REF_HEX_CHARS = 24;

/** `post-merge-credit-release-v1:<event-ref-hex32>:<hmac-hex32>` */
const CREDIT_TOKEN_RE = new RegExp(
  `^post-merge-credit-release-v1:([a-f0-9]{${CREDIT_REF_HEX_CHARS}}):([a-f0-9]{${CREDIT_REF_HEX_CHARS}})$`,
);

/** Truncate a full sha256 eventId to the reference used inside the token. */
function creditEventRef(eventId: string): string {
  return eventId.slice(0, CREDIT_REF_HEX_CHARS);
}

function computeCreditMac(eventRef: string): string | null {
  try {
    return createHmac('sha256', loadOrCreateKey())
      .update(`${CREDIT_TOKEN_DOMAIN}:${eventRef}`)
      .digest('hex')
      .slice(0, CREDIT_REF_HEX_CHARS);
  } catch {
    return null;
  }
}

function equalHex(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify that `labelBasis` is a validly-signed post-merge-credit release
 * token minted by evaluatePostMergeCreditRelease. Pure, synchronous
 * (host-local key read only), never throws. Deliberately rejects the bare
 * POST_MERGE_CREDIT_RELEASE_LABEL literal and any other string that is not a
 * correctly-formed, correctly-signed token — so raw ledgers, injected
 * dependencies, and caller-controlled metadata cannot mint credit.
 */
export function hasReleasedPostMergeCredit(labelBasis: unknown): boolean {
  try {
    if (typeof labelBasis !== 'string') return false;
    const match = CREDIT_TOKEN_RE.exec(labelBasis);
    if (!match) return false;
    const eventRef = match[1]!;
    const mac = match[2]!;
    const expected = computeCreditMac(eventRef);
    if (!expected) return false;
    return equalHex(mac, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// evaluatePostMergeCreditRelease — the release protocol's eligibility check
// ---------------------------------------------------------------------------

export type PostMergeCreditEligibilityReason =
  | 'clean-window-elapsed'
  | 'no-authenticated-merge-witness'
  | 'invalid-merge-timestamp'
  | 'observation-window-not-elapsed'
  | 'observation-ledger-degraded'
  | 'adverse-outcome-observed'
  | 'signing-unavailable'
  | 'error';

export interface PostMergeCreditEligibility {
  eligible: boolean;
  /** Signed token to persist as labelBasis when eligible; null otherwise. */
  label: string | null;
  reason: PostMergeCreditEligibilityReason;
}

/**
 * Determine whether `proposal` is eligible for post-merge credit release
 * RIGHT NOW, and mint the signed token when it is. Fail-closed on every
 * ambiguous path (missing witness, unparseable timestamp, window not yet
 * elapsed, degraded/incomplete observation-ledger read, any adverse
 * observation for this exact merge event, signing failure). Never throws.
 *
 * This function does NOT persist anything — see sweepPostMergeCreditReleases
 * for the write-back that records a minted label to the decisions ledger.
 */
export function evaluatePostMergeCreditRelease(
  proposal: Proposal,
  opts: { nowMs?: number } = {},
): PostMergeCreditEligibility {
  try {
    if (!proposal || typeof proposal.id !== 'string' || proposal.id.length === 0) {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const evidence = authenticatedRealizedMergeOf(proposal);
    if (!evidence || typeof proposal.repo !== 'string' || proposal.repo.length === 0) {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const observedAtIso = evidence.source === 'github-host'
      ? evidence.reconciliation.observedAt
      : evidence.observedAt;
    const mergedAtMs = Date.parse(observedAtIso);
    if (!Number.isFinite(mergedAtMs)) {
      return { eligible: false, label: null, reason: 'invalid-merge-timestamp' };
    }
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs < mergedAtMs || nowMs - mergedAtMs < MIN_POST_MERGE_OBSERVATION_WINDOW_MS) {
      return { eligible: false, label: null, reason: 'observation-window-not-elapsed' };
    }

    let repoAbs: string;
    try {
      repoAbs = resolve(proposal.repo);
    } catch {
      return { eligible: false, label: null, reason: 'no-authenticated-merge-witness' };
    }
    const eventId = postMergeObservationEventId({
      repo: repoAbs,
      proposalId: proposal.id,
      mergeCommit: evidence.mergeCommitOid.toLowerCase(),
    });

    // Adverse-only ledger: absence of a row is the only "clean" signal it can
    // ever give us. A degraded/incomplete read must NOT be treated as clean.
    const read = readPostMergeObservations({ requireComplete: true });
    if (read.sourceState === 'degraded' || !read.complete) {
      return { eligible: false, label: null, reason: 'observation-ledger-degraded' };
    }
    if (read.observations.some((observation) => observation.eventId === eventId)) {
      return { eligible: false, label: null, reason: 'adverse-outcome-observed' };
    }

    const eventRef = creditEventRef(eventId);
    const mac = computeCreditMac(eventRef);
    if (!mac) return { eligible: false, label: null, reason: 'signing-unavailable' };
    return {
      eligible: true,
      label: `${POST_MERGE_CREDIT_RELEASE_LABEL}:${eventRef}:${mac}`,
      reason: 'clean-window-elapsed',
    };
  } catch {
    return { eligible: false, label: null, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// sweepPostMergeCreditReleases — periodic write-back
// ---------------------------------------------------------------------------

/**
 * Bound on candidates inspected per sweep pass — mirrors outcome-watcher.ts's
 * own bounding so a large backlog degrades gracefully instead of blocking.
 */
const MAX_SWEEP_CANDIDATES = 200;

export interface PostMergeCreditSweepResult {
  /** Applied proposals inspected this pass. */
  scanned: number;
  /** Proposals for which a new credit-release decision row was recorded. */
  released: number;
  /** Proposals inspected but not released this pass (not yet eligible, or a
   *  transient error) — never a reason to trust the negative permanently. */
  skipped: number;
  /** False when the proposal or decisions source was incomplete/degraded, or
   *  the candidate cap was hit — a hint the pass should be retried. */
  sourceComplete: boolean;
}

/**
 * Sweep applied proposals for newly-eligible post-merge credit and record it
 * to the decisions ledger (a new 'merged' row with the signed labelBasis
 * token — decisions-ledger.ts's own newest-row-wins semantics let this
 * supersede the plain merge-fact row written at merge time). Idempotent: a
 * proposal that already carries a released decision row is left alone.
 *
 * KNOWN LIMITATION (by design, not a bug): the post-merge-observations ledger
 * only ever records ADVERSE outcomes. This sweep therefore releases credit on
 * "no adverse record after a conservative window", not on a positive
 * "actively confirmed clean" signal — there is no such positive signal
 * anywhere in the fleet today. If a repo's outcome-watcher coverage were
 * somehow disabled for a specific proposal's repo (not enrolled, or the local
 * clone was deleted), this sweep cannot detect that and would release credit
 * on elapsed time alone. The MIN_POST_MERGE_OBSERVATION_WINDOW_MS margin
 * exists specifically to bound that risk; closing it fully would require
 * outcome-watcher.ts (unowned here) to also persist a positive "swept clean"
 * marker per merge event.
 *
 * SCALING NOTE: unlike outcome-watcher.ts, this sweep has no persistent
 * cursor — it re-scans applied proposals from the top of listProposalsDetailed
 * every pass, bounded by MAX_SWEEP_CANDIDATES. At small-to-moderate applied-
 * proposal counts this converges fine (already-released proposals are
 * skipped instantly via the decisions-ledger dedup check, so the cap mostly
 * matters for proposals still awaiting their window). At very large scale a
 * persistent cursor (mirroring monitoring-cursor.ts) would be needed to
 * guarantee every proposal eventually gets swept; out of scope here.
 *
 * Never throws.
 */
export function sweepPostMergeCreditReleases(
  opts: { nowMs?: number; listProposals?: () => Proposal[] } = {},
): PostMergeCreditSweepResult {
  const result: PostMergeCreditSweepResult = {
    scanned: 0, released: 0, skipped: 0, sourceComplete: true,
  };
  try {
    const nowMs = opts.nowMs ?? Date.now();

    let proposals: Proposal[];
    if (typeof opts.listProposals === 'function') {
      try {
        proposals = opts.listProposals();
      } catch {
        proposals = [];
      }
    } else {
      const read = listProposalsDetailed({ status: 'applied', requireComplete: true });
      if (!read.complete || read.sourceState === 'degraded') {
        result.sourceComplete = false;
        return result;
      }
      proposals = read.proposals;
    }

    let inspected = 0;
    for (const proposal of proposals) {
      if (proposal.status !== 'applied') continue;
      if (inspected >= MAX_SWEEP_CANDIDATES) {
        result.sourceComplete = false;
        break;
      }
      inspected++;
      result.scanned++;
      try {
        const existing = readDecisions({ proposalId: proposal.id, requireComplete: true });
        const existingQuality = (existing as typeof existing & {
          sourceQuality?: { sourceState?: string; complete?: boolean };
        }).sourceQuality;
        if (existingQuality && (existingQuality.sourceState === 'degraded' || existingQuality.complete === false)) {
          result.skipped++;
          result.sourceComplete = false;
          continue;
        }
        const alreadyReleased = existing.some(
          (entry) => entry.action === 'merged' && hasReleasedPostMergeCredit(entry.labelBasis),
        );
        if (alreadyReleased) continue;

        const eligibility = evaluatePostMergeCreditRelease(proposal, { nowMs });
        if (!eligibility.eligible || !eligibility.label) {
          result.skipped++;
          continue;
        }

        const ts = new Date(nowMs).toISOString();
        recordDecision({
          ts,
          proposalId: proposal.id,
          // NOTE: labelBasis is intentionally NOT routed through
          // causalMetadataFromProposal's `input.labelBasis` — causalMetadata()
          // (learning/causal.ts) applies boundedText(value, 80) to that field,
          // which would silently truncate our signed token (>80 chars) into
          // an unverifiable fragment. Set it directly below instead, after the
          // spread, so the full token survives.
          ...causalMetadataFromProposal(proposal, { ts, learningSource: 'outcome-record' }),
          action: 'merged',
          verdict: 'applied',
          labelBasis: eligibility.label,
          repo: proposal.repo ?? '',
          engine: proposal.engineModel ?? '',
          model: '',
        } as Parameters<typeof recordDecision>[0]);
        result.released++;
      } catch {
        result.skipped++;
      }
    }
    return result;
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------
// attestPostMergeCreditSkillCard — dedicated signing boundary
// ---------------------------------------------------------------------------

/**
 * Sign a SkillCard that legitimately carries released post-merge credit.
 *
 * skill-attestation.ts's generic attestSkillCard() deliberately refuses any
 * card for which hasReleasedPostMergeCredit(card.labelBasis) is true — its
 * signature payload doesn't cover the credit-release claim, so it must not
 * be the thing vouching for it. This module owns that proof, so it owns this
 * signing boundary too: same crypto primitive (signSkillCardAttestation),
 * same payload shape, so verifyAttestedSkillCard() on the read side still
 * validates cards signed here — only the gating differs (this function signs
 * ONLY when hasReleasedPostMergeCredit is true; attestSkillCard signs only
 * when it is false).
 *
 * Never throws.
 */
export function attestPostMergeCreditSkillCard(card: SkillCard): SkillCard | null {
  try {
    if (!hasReleasedPostMergeCredit(card.labelBasis)) return null;
    const diffHash = card.verification?.diffHash;
    if (!card.proposalId || !diffHash) return null;
    const contentHash = skillCardContentHash(card);
    const attestation = signSkillCardAttestation({
      contentHash,
      skillId: card.skillId,
      revision: card.revision,
      proposalId: card.proposalId,
      diffHash,
    });
    return attestation ? { ...card, contentHash, attestation } : null;
  } catch {
    return null;
  }
}
