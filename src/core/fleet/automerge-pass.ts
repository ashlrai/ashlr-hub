/**
 * automerge-pass.ts — M48: the daemon's OPT-IN auto-merge pass.
 *
 * Kept DELIBERATELY OUT of daemon/loop.ts so the daemon file itself imports no
 * merge/apply/push primitive (the `daemon-no-primitive` safety contract stays
 * literally true: loop.ts only *triggers* this pass). All merge authority lives
 * behind the M47 gate (`autoMergeProposal`), which enforces, per proposal:
 *   frontier merge-authority model ∈ cfg.foundry.mergeAuthority
 *   AND risk class ≤ maxRisk AND full verification passes
 *   AND kill-switch off AND repo enrolled.
 *
 * DEFAULT OFF: new judge/merge progression is a no-op unless
 * cfg.foundry.autoMerge.enabled === true. Absent or disabled configuration may
 * still repair projections for authenticated merges. Never throws.
 *
 * M172: judge-then-merge loop.
 * Before merging, each PENDING proposal that has no recent frontier 'ship'
 * verdict + valid HMAC attestation (checked via the decisions ledger) is sent
 * to the frontier judge (judgeProposal from manager.ts). This closes the gap where
 * proposals accumulate in 'pending' state because the daily oversight cron is
 * the only place the judge ran.
 *
 * Cost guard: at most cfg.foundry.judgePerPass (default 5) unjudged proposals
 * are judged per pass. Proposals that already have a recent 'ship' verdict in
 * the decisions ledger are skipped (idempotent).
 *
 * Fail-closed: if the judge is unavailable the proposal stays unjudged and
 * autoMergeProposal will refuse it (no regression). If judgeProposal throws,
 * the error is swallowed and the pass continues.
 */

import type { AshlrConfig, Proposal } from '../types.js';
import {
  listProposalsDetailed,
  replayRealizedMergeFanout,
  setStatus,
  updateProposalField,
} from '../inbox/store.js';
import {
  autoMergeProposal,
  evaluateAutoMergeReadinessPreflight,
  hasCurrentVerificationBinding,
  isFrontierJudge,
  verifyAndPersistProposal,
  type AutoMergeResult,
} from '../inbox/merge.js';
import { isEnrolled, killSwitchOn } from '../sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { readDecisions, recordDecision } from './decisions-ledger.js';
import { judgeProposal, resolveFrontierJudgeClient, type ManagerVerdict } from './manager.js';
// M294: sign + record the attested 'judged'/ship ledger entry that the merge gate
// (hasRecentShipVerdict / evaluateVerificationGate) requires. Previously the
// automerge-pass judged 'ship' but never wrote this entry → every merge refused.
import { hashDiff, signJudgeAttestation, verifyJudgeAttestation } from '../foundry/provenance.js';
// M193: additive gate-modules (flag-gated, default OFF, only tighten)
import { redTeamProposal } from './red-team.js';
import { analyzeBlastRadius } from '../run/blast-radius.js';
import { checkSpecContract } from '../run/spec-contract.js';
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
// M214: fleet→pulse OTLP emit (fire-and-forget, flag-gated cfg.foundry.pulseEmit, default OFF)
import { emitMerge, emitJudgeVerdict } from '../integrations/fleet-pulse-emit.js';
import { estCostUsd } from '../run/budget.js';
// M235: recursive self-improvement write-back (fire-and-forget, gated cfg.foundry.selfImprove, default ON)
import { learnFromRejection } from './self-improve.js';
import { recordAgentAction } from './agent-action-ledger.js';
import { causalMetadataFromProposal } from '../learning/causal.js';
import { isApprovedRemoteHandoffRetryCandidate } from '../inbox/remote-handoff.js';
import {
  evaluateReviewerIndependence,
  reviewModelFamily,
} from './reviewer-independence.js';
import {
  acquireProposalMutationLock,
  ownsProposalMutationLock,
  releaseProposalMutationLock,
  type ProposalMutationLock,
} from '../inbox/proposal-mutation-lock.js';

const MAX_REALIZED_MERGE_FANOUT_REPLAYS_PER_PASS = 16;
let realizedMergeFanoutReplayCursor: string | null = null;

async function runAuthorizedPostMergeEffects(proposal: Proposal, cfg: AshlrConfig): Promise<void> {
  const repo = proposal.repo;
  if (!repo) return;
  const fence = acquireOutwardMutationFence();
  if (!fence || !ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return;
  }
  const authorized = (): boolean => ownsOutwardMutationFence(fence) &&
    !killSwitchOn() && isEnrolled(repo);
  try {
    if (!authorized()) return;
    try {
      await notifyFleetEvent(
        'merge',
        { repo, title: proposal.title, engine: proposal.engineTier },
        cfg,
      );
    } catch { /* best-effort observation */ }

    if (!authorized()) return;
    try {
      await emitMerge(cfg, proposal.id, repo, proposal.engineTier, { authority: fence });
    } catch { /* best-effort observation */ }

    if (!authorized()) return;
    try {
      const { emit } = await import('./event-bus.js');
      if (!authorized()) return;
      await emit('merge:shipped', {
        proposalId: proposal.id,
        title: proposal.title,
        repo,
        engineTier: proposal.engineTier,
      }, cfg);
    } catch { /* best-effort operational notification */ }

    // Reusable skills remain withheld. The future proof-bound release worker
    // will own skill distillation after independent stability observation.
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

interface AuthorizedJudgeResult {
  requested: boolean;
  verdict: ManagerVerdict | null;
  decisionPersisted: boolean;
  authorityLive: boolean;
}

async function runAuthorizedFrontierJudge(
  proposal: Proposal,
  cfg: AshlrConfig,
  judgeClient: { complete: (system: string, user: string) => Promise<string>; model: string },
): Promise<AuthorizedJudgeResult> {
  const repo = proposal.repo;
  const refused = (): AuthorizedJudgeResult => ({
    requested: false,
    verdict: null,
    decisionPersisted: false,
    authorityLive: false,
  });
  if (!repo) return refused();
  const fence = acquireOutwardMutationFence();
  if (!fence || !ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return refused();
  }
  const authorized = (): boolean => ownsOutwardMutationFence(fence) &&
    !killSwitchOn() && isEnrolled(repo);
  let requested = false;
  let verdict: ManagerVerdict | null = null;
  let decisionPersisted = false;
  try {
    if (!authorized()) return refused();
    requested = true;
    try {
      verdict = await judgeProposal(proposal, cfg, judgeClient);
    } catch {
      verdict = null;
    }

    // KILL is armed before pause waits for this fence. A judge response that
    // loses that race must never become fresh durable merge authority.
    if (!authorized()) {
      return { requested, verdict, decisionPersisted, authorityLive: false };
    }

    if (verdict?.verdict === 'ship' && verdict.wouldMerge === true) {
      try {
        const judgeEngine = judgeClient.model;
        let judgeAttestation: string | undefined;
        const ts = new Date().toISOString();
        const reviewerIndependent = evaluateReviewerIndependence(proposal, judgeEngine).independent;
        if (isFrontierJudge(judgeEngine) && reviewerIndependent) {
          try {
            judgeAttestation = signJudgeAttestation({
              proposalId: proposal.id,
              judgeEngine,
              verdict: 'ship',
              diffHash: hashDiff(proposal.diff ?? ''),
              issuedAt: ts,
              mergeIntent: 'would-merge',
            });
          } catch {
            judgeAttestation = undefined;
          }
        }
        if (authorized()) {
          recordDecision({
            ts,
            proposalId: proposal.id,
            ...causalMetadataFromProposal(proposal, {
              ts,
              learningSource: 'decision-ledger',
              labelBasis: 'judge-verdict',
            }),
            action: 'judged',
            engine: judgeEngine,
            model: judgeEngine,
            verdict: 'ship',
            detail: reviewerIndependent ? 'would-merge' : '',
            ...(verdict.semanticEvents ? { semanticEvents: verdict.semanticEvents } : {}),
            ...(judgeAttestation !== undefined ? { judgeAttestation } : {}),
            ...(judgeAttestation !== undefined
              ? { judgeAttestationIssuedAt: ts, judgeAttestationIntent: 'would-merge' as const }
              : {}),
          });
          decisionPersisted = true;
        }
      } catch {
        decisionPersisted = false;
      }
    }

    if (authorized()) {
      try {
        await emitJudgeVerdict(
          cfg,
          proposal.id,
          verdict?.verdict ?? 'null',
          repo,
          proposal.engineTier,
          { authority: fence },
        );
      } catch { /* best-effort observation */ }
    }
    return { requested, verdict, decisionPersisted, authorityLive: authorized() };
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

function replayAuthorizedRealizedMergeFanout(proposal: Proposal): boolean {
  const repo = proposal.repo;
  if (!repo) return false;
  const proposalLock = acquireProposalMutationLock(proposal.id);
  if (!proposalLock) return false;
  const fence = acquireOutwardMutationFence();
  if (!fence || !ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    releaseProposalMutationLock(proposalLock);
    return false;
  }
  const authorized = (): boolean => ownsProposalMutationLock(proposal.id, proposalLock) &&
    ownsOutwardMutationFence(fence) &&
    !killSwitchOn() && isEnrolled(repo);
  try {
    if (!authorized()) return false;
    return replayRealizedMergeFanout(proposal.id, proposalLock, authorized) && authorized();
  } finally {
    releaseOutwardMutationFence(fence);
    releaseProposalMutationLock(proposalLock);
  }
}

interface AuthorizedPostJudgeResult {
  entered: boolean;
  persisted: boolean;
  authorityLive: boolean;
  archived: boolean;
}

interface ProposalWriteAuthority {
  proposalLock: ProposalMutationLock;
  outwardFence: OutwardMutationFence;
}

function runAuthorizedPostJudgePersistence(
  proposal: Proposal,
  verdict: ManagerVerdict | null,
  cfg: AshlrConfig,
  autoArchiveAfterRejects: number,
): AuthorizedPostJudgeResult {
  const refused = (): AuthorizedPostJudgeResult => ({
    entered: false,
    persisted: false,
    authorityLive: false,
    archived: false,
  });
  const repo = proposal.repo;
  if (!repo) return refused();
  const proposalLock = acquireProposalMutationLock(proposal.id);
  if (!proposalLock) return refused();
  const fence = acquireOutwardMutationFence();
  if (!fence || !ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    releaseProposalMutationLock(proposalLock);
    return refused();
  }
  const authorized = (): boolean => ownsOutwardMutationFence(fence) &&
    !killSwitchOn() && isEnrolled(repo);
  try {
    if (!authorized()) return refused();
    const mergeable = verdict?.verdict === 'ship' && verdict.wouldMerge === true;
    if (!mergeable) {
      try {
        learnFromRejection(
          proposal.id,
          '',
          verdict?.verdict ?? 'review',
          '',
          cfg,
        );
      } catch { /* best-effort learning */ }
      if (!authorized()) {
        return { entered: true, persisted: false, authorityLive: false, archived: false };
      }
      const newCount = ((proposal as unknown as Record<string, unknown>)['judgeNonShipCount'] as number ?? 0) + 1;
      const archived = newCount >= autoArchiveAfterRejects;
      const persisted = archived
        ? writeProposalStatus(
            proposal,
            `auto-archived: judge returned non-mergeable verdict ${newCount} time(s) (threshold: ${autoArchiveAfterRejects})`,
            { proposalLock, outwardFence: fence },
          )
        : writeProposalField(
            proposal,
            { judgeNonShipCount: newCount },
            { proposalLock, outwardFence: fence },
          );
      return { entered: true, persisted, authorityLive: authorized(), archived: persisted && archived };
    }

    const existingCount = (proposal as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
    const persisted = existingCount !== undefined && existingCount > 0
      ? writeProposalField(
          proposal,
          { judgeNonShipCount: 0 },
          { proposalLock, outwardFence: fence },
        )
      : true;
    return { entered: true, persisted, authorityLive: authorized(), archived: false };
  } finally {
    releaseOutwardMutationFence(fence);
    releaseProposalMutationLock(proposalLock);
  }
}

export interface AutoMergePassResult {
  /** Proposals the gate was run against this pass (frontier + branch-eligible mid). */
  attempted: number;
  /** Of those, how many actually merged to main (frontier only). */
  merged: number;
  /** Of those, how many a MID-tier proposal applied to a branch/PR (M56). */
  branched: number;
  /** Of those, how many opened a remote host PR awaiting host-side merge. */
  handoffs: number;
  /** Per-proposal gate results (for observability/audit). */
  results: AutoMergeResult[];
	  /** M172: how many proposals were judged inline this pass. */
	  judged: number;
	  /** M172: configured maximum inline judge calls for this pass. */
	  judgePerPass: number;
	  /** M172: how many proposals were skipped by the judge-per-pass cap. */
	  judgeCapped: number;
	  /** M307: configured maximum verification-before-judge runs for this pass. */
	  verifyBeforeJudgePerPass: number;
	  /** M307: how many verification-before-judge runs executed this pass. */
	  verifyBeforeJudgeRan: number;
	  /** M307: how many proposals were skipped by the verification-before-judge cap. */
	  verifyBeforeJudgeCapped: number;
	  /** Display-only estimate for inline frontier judge calls; not measured spend. */
	  judgeEstimatedSpendUsd: number;
  /**
   * M193: proposals that passed the ship-verdict gate but were blocked by an
   * additive check (red-team / blast-radius / spec-contract). Per-skip detail
   * recorded here for observability.
   */
  skipped: Array<{ proposalId: string; check: string; reason: string }>;
  /**
   * M259: proposals auto-archived this pass (K non-ship verdicts reached).
   * These proposals are now 'rejected' and will not be re-judged.
   */
  autoArchived: number;
  /**
   * M259: proposals TTL-rejected this pass (older than proposalTtlDays).
   * These proposals are now 'rejected' and will not be re-judged.
   */
  ttlRejected: number;
  /**
   * M314: proposals rejected because they were produced from ephemeral Ashlr
   * temp-worktree regression goals. Reject-only; never merges.
   */
  invalidRejected: number;
}

// ---------------------------------------------------------------------------
// M172: judge-cache helpers
// ---------------------------------------------------------------------------

const JUDGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — mirrors Gate 7 staleness window
const JUDGE_ESTIMATE_TOKENS_IN = 4_000;
const JUDGE_ESTIMATE_TOKENS_OUT = 1_000;

function recordAutoMergeVerificationAgentAction(fields: {
  proposal: Proposal;
  check: string;
  phase: 'start' | 'finish';
  ok?: boolean;
  detail?: string;
  durationMs?: number;
  ranCount?: number;
}): void {
  const status =
    fields.phase === 'start'
      ? 'started'
      : fields.ok === true
        ? 'passed'
        : 'failed';
  const ts = new Date().toISOString();
  const causal = causalMetadataFromProposal(fields.proposal, {
    ts,
    learningSource: 'agent-action',
    labelBasis: 'verification-outcome',
  });
  recordAgentAction({
    schemaVersion: 1,
    ts,
    actor: 'verifier',
    kind: 'verification',
    outcome: fields.phase === 'start' ? 'unknown' : fields.ok === true ? 'verified' : 'failed',
    action: `auto-merge:${fields.check}-${fields.phase}`,
    summary: `${fields.check} ${status} for ${fields.proposal.title ?? fields.proposal.id}`,
    ...(typeof fields.proposal.repo === 'string' && fields.proposal.repo ? { repo: fields.proposal.repo } : {}),
    ...(causal.workItemId ? { itemId: causal.workItemId } : {}),
    ...(causal.workSource ? { source: causal.workSource } : {}),
    proposalId: fields.proposal.id,
    ...(causal.runId ? { runId: causal.runId } : {}),
    ...(causal.trajectoryId ? { trajectoryId: causal.trajectoryId } : {}),
    ...(causal.routeSnapshot ? { routeSnapshot: causal.routeSnapshot } : {}),
    ...(causal.runEventSummary ? { runEventSummary: causal.runEventSummary } : {}),
    ...(causal.evidenceOutcome ? { evidenceOutcome: causal.evidenceOutcome } : {}),
    learningSource: causal.learningSource ?? 'agent-action',
    labelBasis: causal.labelBasis ?? 'verification-outcome',
    ...(causal.routerPolicyVersion ? { routerPolicyVersion: causal.routerPolicyVersion } : {}),
    ...(causal.learningEpoch ? { learningEpoch: causal.learningEpoch } : {}),
    reason: fields.detail ?? fields.check,
    durationMs: fields.durationMs,
    tags: ['auto-merge', fields.check, fields.phase],
    counts: {
      ...(typeof fields.ranCount === 'number' ? { commands: fields.ranCount } : {}),
    },
  });
}

/**
 * Return true when the decisions ledger already contains a recent frontier
 * 'ship' verdict for this proposal with an HMAC-valid frontier judge attestation.
 * "Recent" = within the last hour (idempotent skip).
 *
 * Never throws.
 */
function hasRecentShipVerdict(proposal: Proposal): boolean | 'degraded' {
  try {
    const sinceMs = Date.now() - JUDGE_CACHE_TTL_MS;
    const decisions = readDecisions({ proposalId: proposal.id, sinceMs, requireComplete: true });
    const quality = (decisions as typeof decisions & {
      sourceQuality?: { sourceState?: string; complete?: boolean };
    }).sourceQuality;
    if (quality !== undefined && (quality.sourceState === 'degraded' || quality.complete !== true)) {
      return 'degraded';
    }
    const diffHash = hashDiff(proposal.diff ?? '');
    const latest = decisions.find((decision) => decision.action === 'judged');
    if (!latest || latest.verdict !== 'ship' || latest.detail !== 'would-merge') return false;
    const judgeEngine = latest.engine ?? latest.model;
    if (!judgeEngine || !isFrontierJudge(judgeEngine)) return false;
    if (!evaluateReviewerIndependence(proposal, judgeEngine).independent) return false;
    const issuedAt = latest.judgeAttestationIssuedAt;
    const issuedMs = typeof issuedAt === 'string' ? Date.parse(issuedAt) : NaN;
    const now = Date.now();
    if (
      latest.judgeAttestationIntent !== 'would-merge' ||
      issuedAt !== latest.ts ||
      !Number.isFinite(issuedMs) ||
      issuedMs > now + 60_000 ||
      issuedMs < now - JUDGE_CACHE_TTL_MS
    ) return false;
    const attestation = (latest as unknown as Record<string, unknown>)['judgeAttestation'];
    if (typeof attestation !== 'string' || attestation.length === 0) return false;
    return verifyJudgeAttestation(attestation, {
      proposalId: proposal.id,
      judgeEngine,
      verdict: 'ship',
      diffHash,
      issuedAt,
      mergeIntent: 'would-merge',
    }).ok;
  } catch {
    return 'degraded';
  }
}

function recordSafetySkip(
  out: AutoMergePassResult,
  proposalId: string,
  check: string,
  reason: string,
): void {
  out.results.push({ ok: false, merged: false, branched: false, reason });
  out.skipped.push({ proposalId, check, reason });
}

function runAuthorizedProposalWrite(
  proposal: Proposal,
  write: (authority: ProposalWriteAuthority, stillAuthorized: () => boolean) => boolean,
  suppliedAuthority?: ProposalWriteAuthority,
): boolean {
  const repo = proposal.repo;
  if (!repo) return false;

  const borrowed = suppliedAuthority !== undefined;
  const proposalLock = suppliedAuthority?.proposalLock ?? acquireProposalMutationLock(proposal.id);
  if (!ownsProposalMutationLock(proposal.id, proposalLock)) {
    if (!borrowed) releaseProposalMutationLock(proposalLock);
    return false;
  }

  const outwardFence = suppliedAuthority?.outwardFence ?? acquireOutwardMutationFence();
  if (!ownsOutwardMutationFence(outwardFence)) {
    if (!borrowed) {
      releaseOutwardMutationFence(outwardFence);
      releaseProposalMutationLock(proposalLock);
    }
    return false;
  }

  const authority: ProposalWriteAuthority = {
    proposalLock: proposalLock!,
    outwardFence: outwardFence!,
  };
  const stillAuthorized = (): boolean =>
    ownsProposalMutationLock(proposal.id, proposalLock) &&
    ownsOutwardMutationFence(outwardFence) &&
    !killSwitchOn() &&
    isEnrolled(repo);

  try {
    // Recheck at entry and again at the write boundary. The second check closes
    // a revocation that lands during enrollment validation while the held fence
    // keeps pause/unenrollment from reporting quiescence prematurely.
    if (!stillAuthorized() || !stillAuthorized()) return false;
    return write(authority, stillAuthorized);
  } catch {
    return false;
  } finally {
    if (!borrowed) {
      releaseOutwardMutationFence(outwardFence);
      releaseProposalMutationLock(proposalLock);
    }
  }
}

function writeProposalField(
  proposal: Proposal,
  patch: Partial<Proposal>,
  authority?: ProposalWriteAuthority,
): boolean {
  return runAuthorizedProposalWrite(
    proposal,
    ({ proposalLock }) => updateProposalField(proposal.id, patch, proposalLock),
    authority,
  );
}

function writeProposalStatus(
  proposal: Proposal,
  reason: string,
  authority?: ProposalWriteAuthority,
): boolean {
  return runAuthorizedProposalWrite(
    proposal,
    ({ proposalLock }) =>
      setStatus(proposal.id, 'rejected', undefined, reason, proposalLock, {}, 'pending'),
    authority,
  );
}

function incrementStuckOrArchive(
  proposal: Proposal,
  threshold: number,
  reason: string,
): { archived: boolean; stuckPassCount: number } | null {
  const current = (proposal as unknown as Record<string, unknown>)['stuckPassCount'];
  const stuckPassCount = (typeof current === 'number' && Number.isFinite(current) ? current : 0) + 1;
  let outcome: { archived: boolean; stuckPassCount: number } | null = null;
  const persisted = runAuthorizedProposalWrite(proposal, ({ proposalLock }, stillAuthorized) => {
    if (!updateProposalField(proposal.id, { stuckPassCount }, proposalLock)) return false;
    if (stuckPassCount >= threshold) {
      if (!stillAuthorized()) return false;
      if (!setStatus(proposal.id, 'rejected', undefined, reason, proposalLock, {}, 'pending')) return false;
      outcome = { archived: true, stuckPassCount };
      return true;
    }
    outcome = { archived: false, stuckPassCount };
    return true;
  });
  return persisted ? outcome : null;
}

function knownFailedVerificationDetail(p: Proposal): string {
  return p.verifyResult?.failed?.filter(Boolean).join('; ') ?? '';
}

function referencesEphemeralAshlrPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  return (
    normalized.includes('/.ashlr/sandboxes/') ||
    /\/\.ashlr\/tmp\/vwt-[^/\s"'`)]*/.test(normalized)
  );
}

function isEphemeralRegressionGoalProposal(p: Proposal): boolean {
  const rec = p as unknown as Record<string, unknown>;
  return (
    rec['workSource'] === 'goal' &&
    typeof p.title === 'string' &&
    p.title.includes('Fix regression in') &&
    referencesEphemeralAshlrPath(p.title)
  );
}

interface AutoMergeQueues {
  pending: Proposal[];
  recovered: Proposal[];
  fanoutRecovery: Proposal[];
}

function readHealthyAutoMergeQueues(): AutoMergeQueues | null {
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    if (read.sourceState !== 'healthy' || read.complete !== true) return null;
    return {
      pending: read.proposals.filter((proposal) => proposal.status === 'pending'),
      recovered: read.proposals.filter(isApprovedRemoteHandoffRetryCandidate),
      fanoutRecovery: read.proposals.filter((proposal) =>
        proposal.status === 'applied' &&
        proposal.realizedMerge !== undefined),
    };
  } catch {
    return null;
  }
}

function boundedFanoutRecoveryBatch(candidates: Proposal[]): Proposal[] {
  if (candidates.length === 0) {
    realizedMergeFanoutReplayCursor = null;
    return [];
  }
  const ordered = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const start = realizedMergeFanoutReplayCursor === null
    ? 0
    : Math.max(0, ordered.findIndex((proposal) => proposal.id > realizedMergeFanoutReplayCursor!));
  const batch: Proposal[] = [];
  const count = Math.min(MAX_REALIZED_MERGE_FANOUT_REPLAYS_PER_PASS, ordered.length);
  for (let offset = 0; offset < count; offset++) {
    batch.push(ordered[(start + offset) % ordered.length]!);
  }
  realizedMergeFanoutReplayCursor = batch.at(-1)?.id ?? null;
  return batch;
}

function errorDetail(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isRedTeamResult(value: unknown): value is { verdict: 'broken' | 'survived'; detail?: unknown } {
  return isRecord(value) && (value['verdict'] === 'broken' || value['verdict'] === 'survived');
}

function isBlastRadiusResult(
  value: unknown,
): value is { risk: 'none' | 'low' | 'medium' | 'high'; detail?: unknown } {
  return (
    isRecord(value) &&
    (value['risk'] === 'none' || value['risk'] === 'low' || value['risk'] === 'medium' || value['risk'] === 'high')
  );
}

function isSpecContractResult(value: unknown): value is { satisfied: boolean; detail?: unknown } {
  return isRecord(value) && typeof value['satisfied'] === 'boolean';
}

// ---------------------------------------------------------------------------
// Public: runAutoMergePass
// ---------------------------------------------------------------------------

/**
 * Run the M47 tiered-trust gate over PENDING proposals. No-op (returns zeros)
 * unless auto-merge is explicitly enabled. Honors the kill switch before and
 * during the pass. Never throws.
 *
 * M172 extension: before attempting to merge each eligible proposal, if it has
 * no recent frontier 'ship' verdict in the decisions ledger, run the frontier
 * judge on it (via judgeProposal from manager.ts). The judge records a
 * decisions-ledger entry + HMAC attestation (on mergeable 'ship'), enabling
 * autoMergeProposal's verification gate to proceed. Only proposals whose judge
 * verdict is `ship` with `wouldMerge === true` are forwarded to autoMergeProposal.
 *
 * Bounds: at most cfg.foundry.judgePerPass (default 5) unjudged proposals are
 * judged per pass. Already-judged proposals (cache hit) do NOT count against
 * the cap.
 */
export async function runAutoMergePass(cfg: AshlrConfig): Promise<AutoMergePassResult> {
  const out: AutoMergePassResult = {
    attempted: 0,
    merged: 0,
    branched: 0,
    handoffs: 0,
	    results: [],
	    judged: 0,
	    judgePerPass: 0,
	    judgeCapped: 0,
	    verifyBeforeJudgePerPass: 0,
	    verifyBeforeJudgeRan: 0,
	    verifyBeforeJudgeCapped: 0,
	    judgeEstimatedSpendUsd: 0,
	    skipped: [],
	    autoArchived: 0,
    ttlRejected: 0,
    invalidRejected: 0,
  };
  if (killSwitchOn()) return out;

  let queues = readHealthyAutoMergeQueues();
  if (queues === null) return out;
  let { pending, recovered } = queues;
  const { fanoutRecovery } = queues;

  // A crash can land after the authenticated applied receipt but before its
  // idempotent projections are acknowledged. Replay a bounded rotating slice
  // from the complete source without ever putting applied proposals back into
  // the judge or merge queue.
  for (const proposal of boundedFanoutRecoveryBatch(fanoutRecovery)) {
    if (killSwitchOn()) return out;
    try { replayAuthorizedRealizedMergeFanout(proposal); } catch { /* retry next pass */ }
  }

  // The opt-in controls new judge/merge progression, not repair of projections
  // for an already-authenticated merge receipt.
  if (cfg.foundry?.autoMerge?.enabled !== true) return out;

  // M259: resolve drain config from foundry (all additive — only add reject paths).
  const foundry = cfg.foundry as Record<string, unknown> | undefined;

  // judgePerPass: default 8 (raised from 5 to drain backlog faster — M259).
  const judgePerPass =
    typeof foundry?.['judgePerPass'] === 'number' && foundry['judgePerPass'] > 0
      ? (foundry['judgePerPass'] as number)
      : 8;

  const autoMergeCfg = foundry?.['autoMerge'] as Record<string, unknown> | undefined;
	  const verifyBeforeJudgePerPass =
	    typeof autoMergeCfg?.['verifyBeforeJudgePerPass'] === 'number' &&
	    (autoMergeCfg['verifyBeforeJudgePerPass'] as number) >= 0
	      ? Math.floor(autoMergeCfg['verifyBeforeJudgePerPass'] as number)
	      : judgePerPass;
	  out.judgePerPass = judgePerPass;
	  out.verifyBeforeJudgePerPass = verifyBeforeJudgePerPass;
	  let verifyBeforeJudgeUsed = 0;

  // autoArchiveAfterRejects: default 3 — archive after K non-ship verdicts.
  const autoArchiveAfterRejects =
    typeof foundry?.['autoArchiveAfterRejects'] === 'number' && (foundry['autoArchiveAfterRejects'] as number) > 0
      ? (foundry['autoArchiveAfterRejects'] as number)
      : 3;

  // proposalTtlDays: default 7 — auto-reject proposals older than N days.
  const proposalTtlDays =
    typeof foundry?.['proposalTtlDays'] === 'number'
      ? (foundry['proposalTtlDays'] as number)
      : 7;

  const ttlCutoffMs = proposalTtlDays > 0
    ? Date.now() - proposalTtlDays * 24 * 60 * 60 * 1000
    : null;
  const isTtlExpired = (proposal: Proposal): boolean => {
    if (ttlCutoffMs === null) return false;
    const createdMs = new Date(proposal.createdAt).getTime();
    return Number.isFinite(createdMs) && createdMs < ttlCutoffMs;
  };

  // Status cleanup used to mutate from one snapshot and only then discover
  // that its refresh was incomplete. Refresh authority before the first write
  // and recompute the cleanup plan from that complete snapshot instead.
  if (pending.some((proposal) => isEphemeralRegressionGoalProposal(proposal) || isTtlExpired(proposal))) {
    queues = readHealthyAutoMergeQueues();
    if (queues === null) return out;
    pending = queues.pending;
    recovered = queues.recovered;
  }

  // M263: sort oldest-first before the judge loop so the stalest proposals
  // drain first and are never perpetually starved by a most-recent-first queue.
  // Proposal reads return most-recent-first (for UI); the drain loop needs the
  // inverse so the oldest pending entry is always the first to be judged/counted.
  // SAFETY: sort is in-place on the local array only — no store mutation.
  pending.sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });

  // M314: reject stale proposals generated from goals that targeted ephemeral
  // Ashlr execution worktrees. Those goals cannot be acted on after teardown,
  // and letting their proposals remain pending pins the fleet in verify-only.
  const invalidRejectedIds = new Set<string>();
  for (const p of pending) {
    if (!isEphemeralRegressionGoalProposal(p)) continue;
    const reason = 'auto-rejected: proposal came from an ephemeral Ashlr temp-worktree regression goal';
    let persisted = false;
    try {
      persisted = writeProposalStatus(p, reason);
    } catch {
      return out;
    }
    if (!persisted) return out;
    invalidRejectedIds.add(p.id);
    out.invalidRejected++;
    out.skipped.push({ proposalId: p.id, check: 'ephemeral-regression-goal', reason });
    out.results.push({ ok: false, merged: false, branched: false, reason });
  }
  if (invalidRejectedIds.size > 0) {
    pending = pending.filter((p) => !invalidRejectedIds.has(p.id));
  }

  // M259: TTL pre-pass — reject stale proposals before spending any judge calls.
  // Belt-and-suspenders: runs independently of the judge loop.
  // SAFETY: only adds 'rejected' status — NEVER merges anything.
  if (proposalTtlDays > 0) {
    const ttlRejectedIds = new Set<string>();
    for (const p of pending) {
      if (!isTtlExpired(p)) continue;
      let persisted = false;
      try {
        persisted = writeProposalStatus(
          p,
          `auto-rejected: proposal older than ${proposalTtlDays} days (TTL)`,
        );
      } catch {
        return out;
      }
      if (!persisted) return out;
      ttlRejectedIds.add(p.id);
      out.ttlRejected++;
    }
    if (ttlRejectedIds.size > 0) pending = pending.filter((p) => !ttlRejectedIds.has(p.id));
  }

  // Recovered URL-less handoffs bypass pending-only queue maintenance, then
  // re-enter the normal readiness/gate pipeline. Ordinary approved proposals
  // never appear here because the predicate requires the signed one-retry
  // marker and matching live origin authority.
  pending.push(...recovered);
  pending.sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return 0;
  });

  // Resolve at most once per signed producer family. Mixed-family queues need
  // different reviewers; null remains fail-closed for that family.
  type JudgeClient = { complete: (system: string, user: string) => Promise<string>; model: string };
  const judgeClientsByProducerFamily = new Map<string, JudgeClient | null>();

  for (const p of pending) {
    if (killSwitchOn()) break;
    // Pre-filter: decide whether this proposal is eligible to be judged/merged
    // this pass. The decision is trust-basis-aware (M175).
    //
    // trustBasis='verification' (M153/M175): ANY tier may be judged. The full
    // verification gate (frontier-judge-ship + verifyResult + risk + scope +
    // EDV + signed attestation) enforces the safety bar — the GATE is the
    // trust, not the producer's tier.  We do NOT skip local/mid proposals here;
    // autoMergeProposal will refuse them if any criterion is unmet.
    //
    // trustBasis='evidence': ANY tier may proceed to the deterministic evidence
    // gate after verification. This mode intentionally skips frontier judging.
    //
    // trustBasis='tier' or absent (default / M51): frontier proposals are
    // main-merge-eligible; mid proposals are branch/PR-eligible ONLY when the
    // separate default-off midToBranch flag is on; local/undefined are skipped.
    // This path is BYTE-IDENTICAL to pre-M175 behaviour — M51 is untouched.
    const trustBasis = (cfg.foundry as Record<string, unknown> | undefined)
      ?.['autoMerge'] as Record<string, unknown> | undefined;
    const trustMode = trustBasis?.['trustBasis'] as string | undefined;
    const isVerificationMode = trustMode === 'verification';
    const isEvidenceMode = trustMode === 'evidence';
    const isEvidenceBackedMode = isVerificationMode || isEvidenceMode;
    const managerGateEnabled = trustBasis?.['managerGate'] === true;
    const shouldJudgeBeforeMerge = isVerificationMode || managerGateEnabled;
    const verificationResultIsCurrent = isVerificationMode && hasCurrentVerificationBinding(p);

    if (!isEvidenceBackedMode) {
      // Tier-mode pre-filter (M51 — unchanged).
      const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
      if (p.engineTier !== 'frontier' && !midEligible) continue;
    }
    // In evidence-backed modes: no tier pre-filter — the full gate is authority.

    // Cheap static readiness gate before spending judge/merge resources.
    // autoMergeProposal remains authoritative; this only avoids judging records
    // that already fail immutable, pure, no-I/O merge prerequisites.
    // Only an exact verification-mode binding may make a cached failure a
    // permanent readiness blocker. Evidence and tier modes verify afresh in the
    // authoritative merge path, while stale verification-mode outcomes must not
    // accrue stuck/archive state.
    const readinessProposal = !isVerificationMode || !verificationResultIsCurrent
      ? { ...p, verifyResult: undefined }
      : p;
    const readiness = evaluateAutoMergeReadinessPreflight(readinessProposal, cfg);
    if (!readiness.ready) {
      const advisorySuffix =
        readiness.advisories.length > 0
          ? `; advisories: ${readiness.advisories.join('; ')}`
          : '';
      const reason = `readiness preflight: ${readiness.reason ?? 'not ready'}${advisorySuffix}`;
      out.results.push({ ok: false, merged: false, branched: false, reason });
      out.skipped.push({ proposalId: p.id, check: 'readiness-preflight', reason });
      if (readiness.permanent === true) {
        const priorStuck = (p as unknown as Record<string, unknown>)['stuckPassCount'];
        const nextStuck = (typeof priorStuck === 'number' && Number.isFinite(priorStuck) ? priorStuck : 0) + 1;
        const failed = knownFailedVerificationDetail(readinessProposal);
        const detail = readinessProposal.verifyResult?.passed === false && failed
          ? `${readiness.reason ?? 'permanent readiness blocker'} (${failed})`
          : (readiness.reason ?? 'permanent readiness blocker');
        const drain = incrementStuckOrArchive(
          p,
          autoArchiveAfterRejects,
          `auto-drained: permanent readiness blocker persisted for ${nextStuck} pass(es): ${detail}`,
        );
        if (drain === null) return out;
        if (drain?.archived) out.autoArchived++;
      }
      continue;
    }

    if (isEvidenceBackedMode) {
      const verifyCheck = isEvidenceMode ? 'verify-before-merge' : 'verify-before-judge';
      const verifyResultIsReusable = verificationResultIsCurrent;
      if (verifyResultIsReusable && p.verifyResult.passed === false) {
        const failed = p.verifyResult.failed?.filter(Boolean).join('; ');
        const reason = `${verifyCheck}: known failed verification${failed ? `: ${failed}` : ''}`;
        out.results.push({ ok: false, merged: false, branched: false, reason });
        out.skipped.push({ proposalId: p.id, check: verifyCheck, reason });
        continue;
      }

      if (!verifyResultIsReusable) {
        if (verifyBeforeJudgeUsed >= verifyBeforeJudgePerPass) {
          const reason = `${verifyCheck}: cap reached (${verifyBeforeJudgePerPass}/pass)`;
          out.verifyBeforeJudgeCapped++;
          out.skipped.push({ proposalId: p.id, check: `${verifyCheck}-cap`, reason });
          continue;
        }
        verifyBeforeJudgeUsed++;
        out.verifyBeforeJudgeRan++;

        const verifyStartedAt = Date.now();
        recordAutoMergeVerificationAgentAction({
          proposal: p,
          check: verifyCheck,
          phase: 'start',
        });
        let transaction: Awaited<ReturnType<typeof verifyAndPersistProposal>>;
        try {
          transaction = await verifyAndPersistProposal(p, cfg, 'auto-merge-preflight');
        } catch (err) {
          recordAutoMergeVerificationAgentAction({
            proposal: p,
            check: verifyCheck,
            phase: 'finish',
            ok: false,
            detail: (err as Error)?.message ?? String(err),
            durationMs: Date.now() - verifyStartedAt,
          });
          throw err;
        }
        const verify = transaction.verify;
        recordAutoMergeVerificationAgentAction({
          proposal: p,
          check: verifyCheck,
          phase: 'finish',
          ok: verify.ok,
          detail: verify.detail,
          durationMs: Date.now() - verifyStartedAt,
          ranCount: verify.ran.length,
        });
        if (!transaction.persisted || !transaction.verifyResult) {
          const reason = `${verifyCheck}: ${transaction.reason}`;
          out.results.push({ ok: false, merged: false, branched: false, reason });
          out.skipped.push({ proposalId: p.id, check: `${verifyCheck}-persistence`, reason });
          return out;
        }
        p.verifyResult = transaction.verifyResult;

        if (!transaction.authorityLive) {
          const reason = `${verifyCheck}: verification authority revoked: ${transaction.reason}`;
          out.results.push({ ok: false, merged: false, branched: false, reason });
          out.skipped.push({ proposalId: p.id, check: `${verifyCheck}-authority`, reason });
          return out;
        }

        if (!verify.ok) {
          const reason = `${verifyCheck}: verification failed: ${verify.detail}`;
          out.results.push({ ok: false, merged: false, branched: false, reason });
          out.skipped.push({ proposalId: p.id, check: verifyCheck, reason });
          continue;
        }
      }
    }

    // ── M172: judge-then-merge ─────────────────────────────────────────────
    // Judge in explicit judge-backed modes only: verification trust or
    // managerGate. Tier/evidence modes proceed to autoMergeProposal(), whose
    // merge gate remains authoritative for verification, risk/scope, provenance,
    // enrollment, kill switch, self-target, and host/local merge safety.
    const recentShipVerdict = shouldJudgeBeforeMerge ? hasRecentShipVerdict(p) : false;
    if (recentShipVerdict === 'degraded') {
      recordSafetySkip(
        out,
        p.id,
        'decision-source',
        'decisions ledger source is degraded or incomplete; refusing judge cache and merge progression',
      );
      continue;
    }
    if (shouldJudgeBeforeMerge && !recentShipVerdict) {

      // Check per-pass cap before spending a frontier judge call.
      if (out.judged >= judgePerPass) {
        out.judgeCapped++;
        // M271: CHEAP DRAIN PATH — proposals already seen as non-ship (judgeNonShipCount>=1)
        // but capped out of judging this pass accumulate a stuckPassCount WITHOUT spending
        // a fresh judge call. When stuckPassCount reaches autoArchiveAfterRejects they are
        // archived (status→rejected). This drains the queue over K cheap passes.
        // SAFETY: NEVER archives a proposal that might receive a ship verdict next pass —
        // only proposals that have already been judged non-ship at least once qualify.
        // NEVER hard-deletes (status change only). NEVER weakens the merge gate.
        try {
          const priorNonShip = (p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
          if (typeof priorNonShip === 'number' && priorNonShip >= 1) {
            const newStuck = ((p as unknown as Record<string, unknown>)['stuckPassCount'] as number ?? 0) + 1;
            if (newStuck >= autoArchiveAfterRejects) {
              if (!writeProposalStatus(
                p,
                `M271 drained: persistently non-ship/non-mergeable (stuck ${newStuck} pass(es), judgeNonShipCount=${priorNonShip})`,
              )) return out;
              out.autoArchived++;
            } else {
              if (!writeProposalField(p, { stuckPassCount: newStuck })) return out;
            }
          }
        } catch {
          return out;
        }
        continue; // Skip: backlog will be processed in subsequent pass ticks.
      }

      const producerFamily = reviewModelFamily(p.engineModel);
      if (!judgeClientsByProducerFamily.has(producerFamily)) {
        judgeClientsByProducerFamily.set(producerFamily, resolveFrontierJudgeClient(cfg, {
          producerModel: p.engineModel,
          requireIndependent: true,
        }));
      }
      const judgeClient = judgeClientsByProducerFamily.get(producerFamily) ?? null;

      if (judgeClient !== null) {
        const judgeResult = await runAuthorizedFrontierJudge(p, cfg, judgeClient);
        if (!judgeResult.requested) continue;
        const verdict = judgeResult.verdict;
	      out.judged++;
	      out.judgeEstimatedSpendUsd += estCostUsd(
	        judgeClient.model,
	        JUDGE_ESTIMATE_TOKENS_IN,
	        JUDGE_ESTIMATE_TOKENS_OUT,
	      );
        if (!judgeResult.authorityLive || killSwitchOn() || !p.repo || !isEnrolled(p.repo)) {
          if (killSwitchOn()) break;
          continue;
        }

        const postJudge = runAuthorizedPostJudgePersistence(
          p,
          verdict,
          cfg,
          autoArchiveAfterRejects,
        );
        if (!postJudge.entered) {
          if (killSwitchOn()) break;
          continue;
        }
        if (!postJudge.persisted) return out;
        if (postJudge.archived) out.autoArchived++;
        if (!postJudge.authorityLive || killSwitchOn() || !p.repo || !isEnrolled(p.repo)) {
          if (killSwitchOn()) break;
          continue;
        }

        // Only proposals the judge would actually merge proceed to the merge gate.
        // 'ship' with wouldMerge=false is non-mergeable and must not create
        // durable merge authority.
        // SAFETY: this ONLY adds a reject path — it can NEVER cause a merge.
        if (!verdict || verdict.verdict !== 'ship' || verdict.wouldMerge !== true) continue;
        if (!judgeResult.decisionPersisted) continue;

      } else {
        // No judge available → fail-closed: skip this proposal for merging.
        // M273: when no judge client is available AND the proposal has already
        // been seen as non-ship at least once (judgeNonShipCount>=1), apply the
        // same M271-style cheap drain so the proposal doesn't idle forever.
        // SAFETY: never accrues stuckPassCount for fresh (never-judged) proposals
        // — only proposals that have already received ≥1 non-ship verdict.
        // NEVER archives or merges a proposal that might receive a ship verdict
        // if a judge becomes available — the stuckPassCount path is additive-only.
        try {
          const priorNonShip = (p as unknown as Record<string, unknown>)['judgeNonShipCount'] as number | undefined;
          if (typeof priorNonShip === 'number' && priorNonShip >= 1) {
            const newStuck = ((p as unknown as Record<string, unknown>)['stuckPassCount'] as number ?? 0) + 1;
            if (newStuck >= autoArchiveAfterRejects) {
              if (!writeProposalStatus(
                p,
                `M273 drained: judge unavailable, persistently non-ship (stuck ${newStuck} pass(es), judgeNonShipCount=${priorNonShip})`,
              )) return out;
              out.autoArchived++;
            } else {
              if (!writeProposalField(p, { stuckPassCount: newStuck })) return out;
            }
          }
        } catch {
          return out;
        }
        continue;
      }
    }
    // ── End M172 ──────────────────────────────────────────────────────────

    out.attempted++;

    // ── M193: additive gate-checks (flag-gated, default OFF, only tighten) ──
    // Each check runs only when its feature flag is enabled. A check that
    // throws or returns an untrustworthy shape fails closed: the proposal is
    // skipped (stays pending) and the reason is recorded. These checks NEVER
    // cause a merge that wouldn't happen otherwise.

    // M191 — Red-team critic
    if ((foundry as Record<string, unknown> | undefined)?.['redTeam'] === true) {
      let shouldSkip = false;
      try {
        const rt = await redTeamProposal(p, cfg);
        if (!isRedTeamResult(rt)) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'red-team', 'red-team check produced an untrustworthy result');
        } else if (rt.verdict === 'broken') {
          shouldSkip = true;
          const detail = typeof rt.detail === 'string' && rt.detail ? rt.detail : 'red-team check failed';
          recordSafetySkip(out, p.id, 'red-team', detail);
        }
      } catch (err) {
        shouldSkip = true;
        recordSafetySkip(out, p.id, 'red-team', `red-team check failed closed: ${errorDetail(err)}`);
      }
      if (shouldSkip) continue;
    }

    // M188 — Blast-radius
    if ((foundry as Record<string, unknown> | undefined)?.['blastRadius'] === true) {
      let shouldSkip = false;
      try {
        const changedFiles = p.diff
          ? p.diff
              .split('\n')
              .filter((l: string) => l.startsWith('+++ '))
              .map((l: string) => l.slice(4).replace(/^[ab]\//, '').trim())
              .filter((f: string) => f && f !== '/dev/null')
          : [];
        const br = await analyzeBlastRadius(
          { repo: p.repo ?? '', changedFiles },
          cfg as unknown as import('../run/blast-radius.js').BlastRadiusConfig,
        );
        if (!isBlastRadiusResult(br)) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'blast-radius', 'blast-radius check produced an untrustworthy result');
        } else if (br.risk === 'high') {
          shouldSkip = true;
          const detail = typeof br.detail === 'string' && br.detail ? br.detail : 'blast-radius risk is high';
          recordSafetySkip(out, p.id, 'blast-radius', detail);
        }
      } catch (err) {
        shouldSkip = true;
        recordSafetySkip(out, p.id, 'blast-radius', `blast-radius check failed closed: ${errorDetail(err)}`);
      }
      if (shouldSkip) continue;
    }

    // M190 — Spec-contract
    if ((foundry as Record<string, unknown> | undefined)?.['specContract'] === true) {
      const specId = (p as unknown as Record<string, unknown>)['specId'];
      if (specId && typeof specId === 'string') {
        let shouldSkip = false;
        try {
          // Lazily load the spec body so this path costs nothing when no spec is present.
          let specInput: import('../run/spec-contract.js').SpecInput = null;
          try {
            const { loadSpec } = await import('../spec/spec-store.js');
            const loaded = loadSpec(specId, p.repo ?? undefined);
            if (loaded) specInput = { meta: loaded.meta, body: loaded.body };
          } catch {
            shouldSkip = true;
            recordSafetySkip(out, p.id, 'spec-contract', `spec-contract could not load spec '${specId}'`);
          }
          if (!shouldSkip && specInput === null) {
            shouldSkip = true;
            recordSafetySkip(out, p.id, 'spec-contract', `spec-contract could not load spec '${specId}'`);
          }
          if (!shouldSkip && specInput !== null) {
            const sc = await checkSpecContract(
              { spec: specInput, repoDir: p.repo ?? undefined, diff: p.diff },
              cfg,
            );
            if (!isSpecContractResult(sc)) {
              shouldSkip = true;
              recordSafetySkip(out, p.id, 'spec-contract', 'spec-contract check produced an untrustworthy result');
            } else if (!sc.satisfied) {
              shouldSkip = true;
              const detail =
                isRecord(sc.detail) && typeof sc.detail['reason'] === 'string'
                  ? sc.detail['reason']
                  : 'spec contract unsatisfied';
              recordSafetySkip(out, p.id, 'spec-contract', detail);
            }
          }
        } catch (err) {
          shouldSkip = true;
          recordSafetySkip(out, p.id, 'spec-contract', `spec-contract check failed closed: ${errorDetail(err)}`);
        }
        if (shouldSkip) continue;
      }
    }
    // ── End M193 ──────────────────────────────────────────────────────────

    try {
      const res = await autoMergeProposal(p.id, cfg);
      out.results.push(res);
      if (res.merged) {
        out.merged++;
        await runAuthorizedPostMergeEffects(p, cfg);
      }
      if (res.branched) out.branched++;
      if (res.handoff) out.handoffs++;
    } catch {
      // autoMergeProposal never throws by contract; defensive only.
    }
  }
  return out;
}
