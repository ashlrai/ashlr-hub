import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { DecisionEntry, Proposal, RepairDepth, RepairTreatment, WorkItem } from '../types.js';
import { listProposals, listProposalsDetailed, loadProposal } from '../inbox/store.js';
import { hasCurrentVerificationBinding } from '../inbox/merge.js';
import { buildRequiredVerificationManifest } from '../run/verification-manifest.js';
import type { VerifyCommand } from '../run/verify-commands.js';
import { scrubSecrets } from '../util/scrub.js';
import { pruneQueuedSelfHealItems, queueSelfHealItemDetailed } from './self-heal.js';
import { loadQueuedAutonomyItemsDetailed } from '../portfolio/queued-autonomy.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import {
  REJECTED_CAPTURE_REPAIR_MAX_AGE_MS,
  isActionableSelfHealItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
  isTrustedProposalRepairItem,
} from './self-heal-trust.js';
import {
  readDispatchProductionEventsDetailed,
  resolveDispatchProductionAttemptWitnesses,
  resolveDispatchProductionAttemptReceiptWitnesses,
  type DispatchProductionAttemptProofTarget,
  type DispatchProductionEvent,
  type DispatchProductionReadStopReason,
} from './dispatch-production-ledger.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
  recordGeneratedRepairLifecycle,
  readGeneratedRepairLifecycle,
} from './generated-repair-lifecycle.js';
import { workItemCoverageKey } from './proposal-matching.js';
import { workItemObjectiveHash } from './work-item-objective.js';
import {
  compactRepairHandoffs,
  dispatchEventFromRepairHandoff,
  readRepairHandoffs,
  repairHandoffFromDispatchEvent,
} from './repair-handoff-journal.js';
import { repairTreatmentForUnitId, repairTreatmentUnitId } from './generated-repair-identity.js';
import { readDecisionsDetailed } from './decisions-ledger.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from '../inbox/persistence-mismatch.js';
import {
  acquireProposalMutationLock,
  releaseProposalMutationLock,
} from '../inbox/proposal-mutation-lock.js';
import { proposalRepairId } from './proposal-repair-identity.js';

const MAX_TITLE = 140;
const MAX_REASON = 260;
const DISPATCH_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DISPATCH_CAPTURE_MAX_QUEUED = 5;
const DISPATCH_NO_DIFF_MAX_QUEUED = 5;
const REJECTED_CAPTURE_MAX_SCANNED = 32;
const MAX_PARENT_CONTEXT = 1_600;
const PERSISTENCE_MISMATCH_DECISION_WINDOW_MS = 60_000;
const DECISION_TIMESTAMP_SLOP_MS = 1_000;
const PROPOSAL_ATTEMPT_SCAN_SLOP_MS = 1_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_ROOT_ADMISSION_COUNT = 10_000;

export interface GeneratedRepairRootIdentity {
  repairRootId: string;
  repairRootAuthorityId: string;
  repairDepth: RepairDepth;
}

function canonicalRepairRootId(repo: string, rootItemId: string): string | null {
  let canonicalRepo: string;
  try {
    canonicalRepo = resolve(repo);
  } catch {
    return null;
  }
  return createHash('sha256').update(JSON.stringify([
    'ashlr:repair-root:v2',
    canonicalRepo,
    rootItemId,
  ])).digest('hex');
}

/** Canonical repo/root admission key. Runtime validation deliberately rejects widened depths. */
export function generatedRepairRootKey(
  item: Pick<WorkItem, 'repo' | 'repairRootId' | 'repairRootAuthorityId' | 'repairDepth'>,
): string | null {
  if ((item.repairDepth !== 0 && item.repairDepth !== 1) ||
    typeof item.repairRootAuthorityId !== 'string' || !item.repairRootAuthorityId) return null;
  const canonical = canonicalRepairRootId(item.repo, item.repairRootAuthorityId);
  if (!canonical || item.repairRootId !== canonical) return null;
  try {
    return `${resolve(item.repo)}\0${item.repairRootId}`;
  } catch {
    return null;
  }
}

export function proposalRepairRootIdentity(proposal: Proposal, repo: string): GeneratedRepairRootIdentity | null {
  if (!proposal.id || proposal.workItemGenerationId !== undefined || proposal.repairRootId !== undefined || proposal.repairDepth !== undefined) {
    return null;
  }
  // Legacy generated proposals predate bound lineage metadata. Recognizable
  // generated ids are never allowed to masquerade as a fresh depth-zero root.
  if (/:proposal-repair(?:-capture|-nodiff)?:/i.test(proposal.workItemId ?? '')) return null;
  const repairRootAuthorityId = `proposal:${proposal.id}`;
  const repairRootId = canonicalRepairRootId(repo, repairRootAuthorityId);
  return repairRootId ? { repairRootId, repairRootAuthorityId, repairDepth: 0 } : null;
}

/** Immutable generation identity for a depth-zero repair of one failed proposal. */
export function proposalRepairGenerationId(
  proposal: Pick<Proposal, 'id' | 'createdAt'>,
  repo: string,
  root: GeneratedRepairRootIdentity,
): string | null {
  const createdAtMs = Date.parse(proposal.createdAt);
  let canonicalRepo: string;
  try {
    canonicalRepo = resolve(repo);
  } catch {
    return null;
  }
  if (!proposal.id || !Number.isFinite(createdAtMs) || root.repairDepth !== 0 ||
    !SHA256_RE.test(root.repairRootId) || !root.repairRootAuthorityId) return null;
  return createHash('sha256').update(JSON.stringify([
    'ashlr:proposal-repair-generation:v1',
    canonicalRepo,
    proposalRepairId(canonicalRepo, proposal.id),
    new Date(createdAtMs).toISOString(),
    root.repairRootId,
    root.repairRootAuthorityId,
  ])).digest('hex');
}

function dispatchRepairRootIdentity(
  event: DispatchProductionEvent,
  repo: string,
  parent?: Pick<WorkItem, 'id' | 'repo' | 'repairRootId' | 'repairRootAuthorityId' | 'repairDepth'>,
): GeneratedRepairRootIdentity | null {
  if (parent) {
    const parentKey = generatedRepairRootKey(parent);
    let canonicalRepo: string;
    try { canonicalRepo = resolve(repo); } catch { return null; }
    if (!parentKey || resolve(parent.repo) !== canonicalRepo || parent.id !== event.itemId || parent.repairDepth !== 0) {
      return null;
    }
    return {
      repairRootId: parent.repairRootId!,
      repairRootAuthorityId: parent.repairRootAuthorityId!,
      repairDepth: 1,
    };
  }
  // A generated parent without an exact active root is ambiguous. Item-id
  // structure is used only to fail closed, never to infer or mint authority.
  if (/:proposal-repair(?:-capture|-nodiff)?:/i.test(event.itemId)) return null;
  if (!SHA256_RE.test(event.objectiveHash ?? '')) return null;
  const repairRootAuthorityId = `dispatch:${event.itemId}:${event.source}:${event.objectiveHash}`;
  const repairRootId = canonicalRepairRootId(repo, repairRootAuthorityId);
  return repairRootId ? { repairRootId, repairRootAuthorityId, repairDepth: 0 } : null;
}

function incrementBounded(value: number | undefined): number {
  return Math.min(MAX_ROOT_ADMISSION_COUNT, (value ?? 0) + 1);
}

interface CaptureDecisionProof {
  decisions: DecisionEntry[];
  complete: boolean;
}

function readCaptureDecisionProof(now: Date): CaptureDecisionProof {
  const decisionRead = readDecisionsDetailed({
    sinceMs: now.getTime() - REJECTED_CAPTURE_REPAIR_MAX_AGE_MS - PERSISTENCE_MISMATCH_DECISION_WINDOW_MS,
  });
  return {
    decisions: decisionRead.decisions,
    complete: decisionRead.complete && decisionRead.sourceState !== 'degraded',
  };
}

export interface ProposalRepairWorkResult {
  scanned: number;
  eligible: number;
  queued: number;
  failed: number;
  proposalEligible?: number;
  proposalQueued?: number;
  proposalFailed?: number;
  dispatchCaptureScanned?: number;
  dispatchCaptureEligible?: number;
  dispatchCaptureQueued?: number;
  dispatchCaptureFailed?: number;
  dispatchNoDiffScanned?: number;
  dispatchNoDiffEligible?: number;
  dispatchNoDiffQueued?: number;
  dispatchNoDiffFailed?: number;
  dispatchRepairRetired?: number;
  dispatchRepairExhausted?: number;
  dispatchRepairQuarantined?: number;
  dispatchRepairPruned?: number;
  dispatchRepairPruneFailed?: number;
  dispatchRepairLifecycleUnavailable?: number;
  repairRootAdmissionConsidered?: number;
  repairRootAdmissionAdmitted?: number;
  repairRootAdmissionAlreadyActive?: number;
  repairRootAdmissionRootless?: number;
  repairRootAdmissionDepthRejected?: number;
  /** Internal selection guard; never persisted by producer-maintenance summaries. */
  blockedItemKeys?: string[];
  /** Internal root-scoped quarantine guard; never persisted verbatim. */
  blockedRootKeys?: string[];
  handoffObservations?: number;
  handoffInvalidRows?: number;
  handoffConflictingIds?: number;
  handoffSourceState?: 'missing' | 'healthy' | 'degraded';
  handoffAuthorityDigest?: string;
  handoffActivationId?: string;
  handoffActivatedAt?: string;
  handoffActivationAuthorities?: number;
  handoffActivationAuthorityDigest?: string;
  handoffCompacted?: number;
  handoffCompactionUnavailable?: number;
  proposalInboxAvailable?: boolean;
  dispatchSourceState?: 'missing' | 'healthy' | 'degraded';
  dispatchSourceComplete?: boolean;
  dispatchSourceInvalidRows?: number;
  dispatchSourceUnreadableFiles?: number;
  dispatchSourceStopReasons?: DispatchProductionReadStopReason[];
}

export interface ProposalRepairWorkOptions {
  /** Restrict mutation to exact pending non-partial deterministic verification failures. */
  verifiedFailureProposalOnly?: boolean;
  dispatchEvents?: DispatchProductionEvent[];
  includeDispatchCaptureFailures?: boolean;
  includeDispatchNoDiffReslices?: boolean;
  dispatchWindowMs?: number;
  maxDispatchCaptureQueued?: number;
  maxDispatchNoDiffQueued?: number;
  terminalLifecycleEnabled?: boolean;
  lifecycleProposals?: Proposal[];
}

export interface DiagnosticResliceParentResolution {
  dispatchable: WorkItem[];
  quarantined: Array<{
    itemId: string;
    reason: 'parent-missing' | 'parent-provenance-missing' | 'parent-objective-changed';
  }>;
  resolved: number;
  missing: number;
}

function bounded(value: unknown, max: number): string {
  const text = scrubSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function boundedRepairReason(value: unknown, max: number): string {
  const stripped = scrubSecrets(String(value ?? ''))
    .replace(/\b(stdout|stderr|diff|prompt|env|argv)\s*[:=]\s*[^;,\n]+/gi, '$1=[omitted]')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max ? `${stripped.slice(0, Math.max(0, max - 3))}...` : stripped;
}

function captureRepairId(repo: string, itemId: string): string {
  const hash = createHash('sha1')
    .update(`${resolve(repo)}\0${itemId}\0dispatch-capture-gate-repair`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:proposal-repair-capture:${hash}`;
}

function noDiffResliceId(repo: string, itemId: string): string {
  const hash = createHash('sha1')
    .update(`${resolve(repo)}\0${itemId}\0dispatch-no-diff-reslice`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:proposal-repair-nodiff:${hash}`;
}

function repairParentItemId(item: WorkItem): string | null {
  if (typeof item.repairParentItemId === 'string' && item.repairParentItemId.trim()) {
    return item.repairParentItemId.trim();
  }
  const match = item.detail.match(/^Original work item:\s*(.+)$/mi);
  const parsed = match?.[1]?.trim();
  return parsed && parsed.length <= 180 ? parsed : null;
}

function parentKey(repo: string, itemId: string): string | null {
  try { return `${resolve(repo)}\0${itemId}`; } catch { return null; }
}

function resliceInstruction(treatment: RepairTreatment): string {
  if (treatment === 'target-localization') {
    return `Action: reslice by first naming exactly one target file or subsystem and citing bounded current-state evidence from repository metadata or inspection. ` +
      `Then make the smallest complete edit if the objective remains actionable. ` +
      `If the current repository already satisfies the objective or a safe edit requires a product decision, report that evidence without forcing a cosmetic change.`;
  }
  return `Action: reslice by inspecting the current target and making the smallest complete edit if it remains actionable. ` +
    `If the current repository already satisfies the objective or a safe edit requires a product decision, report that evidence without forcing a cosmetic change.`;
}

function resolvedResliceDetail(parent: WorkItem, treatment: RepairTreatment): string {
  const title = bounded(parent.title, MAX_TITLE) || parent.id;
  const detail = bounded(parent.detail, MAX_PARENT_CONTEXT);
  return (
    `Diagnostic reslice: retry a currently actionable work item after an earlier dispatch produced no file changes.\n` +
    `Original work item: ${parent.id}\n` +
    `Current objective: ${title}\n` +
    (detail && detail !== title ? `Current context: ${detail}\n` : '') +
    `Original source: ${parent.source}\n` +
    `Dispatch outcome: empty-diff\n` +
    resliceInstruction(treatment)
  );
}

/**
 * Resolve durable diagnostic children against the current scanner backlog.
 * Missing parents are quarantined for this selection pass only; queue and
 * lifecycle authority remain untouched so a later recurrence can recover.
 */
export function resolveDiagnosticResliceParents(items: WorkItem[]): DiagnosticResliceParentResolution {
  const parents = new Map<string, WorkItem>();
  for (const item of items) {
    if (item.tags.includes('proposal-repair') && item.repairDepth !== 0) continue;
    const key = parentKey(item.repo, item.id);
    if (key) parents.set(key, item);
  }

  const dispatchable: WorkItem[] = [];
  const quarantined: DiagnosticResliceParentResolution['quarantined'] = [];
  let resolved = 0;
  let missing = 0;

  for (const item of items) {
    if (!isTrustedDiagnosticResliceItem(item)) {
      dispatchable.push(item);
      continue;
    }
    const parentId = repairParentItemId(item);
    const key = parentId ? parentKey(item.repo, parentId) : null;
    const parent = key ? parents.get(key) : undefined;
    if (item.repairDepth === 1 && !parent) {
      if (
        generatedRepairRootKey(item) === null ||
        item.repairParentSource !== 'self' ||
        item.repairParentTier == null ||
        !SHA256_RE.test(item.repairParentObjectiveHash ?? '') ||
        generatedRepairGenerationId(item) === null
      ) {
        missing += 1;
        quarantined.push({ itemId: item.id, reason: 'parent-provenance-missing' });
        continue;
      }
      resolved += 1;
      dispatchable.push(item);
      continue;
    }
    if (!parent) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-missing' });
      continue;
    }
    if (generatedRepairRootKey(item) === null) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-provenance-missing' });
      continue;
    }
    if (
      item.repairParentTier == null ||
      item.repairParentSource !== parent.source
    ) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-provenance-missing' });
      continue;
    }
    if (item.repairParentObjectiveHash !== workItemObjectiveHash(parent)) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-objective-changed' });
      continue;
    }
    if (generatedRepairGenerationId(item) === null) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-provenance-missing' });
      continue;
    }
    const treatmentUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: item.repo,
      parentItemId: parent.id,
      parentObjectiveHash: item.repairParentObjectiveHash,
    });
    const treatment = treatmentUnitId ? repairTreatmentForUnitId(treatmentUnitId) : null;
    const treatmentMetadataPresent = item.repairTreatmentUnitId !== undefined || item.repairTreatment !== undefined;
    if (
      !treatmentUnitId || !treatment ||
      (treatmentMetadataPresent && (
        item.repairTreatmentUnitId !== treatmentUnitId ||
        item.repairTreatment !== treatment
      ))
    ) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-provenance-missing' });
      continue;
    }
    resolved += 1;
    dispatchable.push({
      ...item,
      title: bounded(parent.title, MAX_TITLE) || parent.id,
      detail: resolvedResliceDetail(parent, treatment),
      repairTreatmentUnitId: treatmentUnitId,
      repairTreatment: treatment,
      repairParentItemId: parent.id,
      repairParentSource: item.repairParentSource ?? parent.source,
    });
  }

  return { dispatchable, quarantined, resolved, missing };
}

function hasMachinePersistenceMismatchDecision(
  proposal: Proposal,
  proof: CaptureDecisionProof | undefined,
): boolean {
  if (proposal.result !== PROPOSAL_PERSISTENCE_MISMATCH_RESULT) return false;
  const createdAtMs = Date.parse(proposal.createdAt);
  const decidedAtMs = Date.parse(proposal.decidedAt ?? '');
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(decidedAtMs) ||
    decidedAtMs < createdAtMs ||
    decidedAtMs - createdAtMs > PERSISTENCE_MISMATCH_DECISION_WINDOW_MS
  ) return false;
  // New writers persist an exact proposal-local machine marker atomically with
  // the rejected capture. The ledger remains causal evidence, while legacy
  // markerless artifacts still require its complete single-decision proof.
  if (proposal.decisionReason === PROPOSAL_PERSISTENCE_MISMATCH_REASON) return true;
  if (!proof?.complete || proposal.decisionReason !== undefined) return false;
  const decisions = proof.decisions.filter((entry) =>
    entry.proposalId === proposal.id && entry.action === 'rejected');
  if (decisions.length !== 1) return false;
  const decision = decisions[0]!;
  const decisionAtMs = Date.parse(decision.ts);
  if (
    !Number.isFinite(decisionAtMs) ||
    Math.abs(decisionAtMs - decidedAtMs) > DECISION_TIMESTAMP_SLOP_MS ||
    decision.runId !== proposal.runId ||
    decision.trajectoryId !== proposal.trajectoryId
  ) return false;
  return decision.reason === undefined;
}

function isRecentRejectedCaptureArtifact(
  proposal: Proposal,
  now: Date,
  decisionProof?: CaptureDecisionProof,
): boolean {
  if (proposal.status !== 'rejected' || proposal.isPartial !== true) return false;
  if (proposal.verifyResult?.source !== 'capture-gate') return false;
  if (proposal.origin !== 'agent' && proposal.origin !== 'swarm') return false;
  const stuckPassCount = (proposal as unknown as Record<string, unknown>)['stuckPassCount'];
  const autoDrained =
    typeof proposal.decisionReason === 'string' &&
    proposal.decisionReason.startsWith('auto-drained: permanent readiness blocker persisted') &&
    typeof stuckPassCount === 'number' &&
    Number.isSafeInteger(stuckPassCount) &&
    stuckPassCount >= 1;
  const captureMismatch = hasMachinePersistenceMismatchDecision(proposal, decisionProof);
  if (!autoDrained && !captureMismatch) return false;
  if (typeof proposal.diff !== 'string' || proposal.diff.trim().length === 0) return false;
  if (typeof proposal.runId !== 'string' || !proposal.runId) return false;
  if (proposal.trajectoryId !== `run:${proposal.runId}`) return false;
  const createdAtMs = Date.parse(proposal.createdAt);
  const ageMs = now.getTime() - createdAtMs;
  return Number.isFinite(createdAtMs) && ageMs >= 0 && ageMs <= REJECTED_CAPTURE_REPAIR_MAX_AGE_MS;
}

function proposalNeedsRepair(
  proposal: Proposal,
  now: Date,
  decisionProof?: CaptureDecisionProof,
): boolean {
  if (proposal.status !== 'pending' && !isRecentRejectedCaptureArtifact(proposal, now, decisionProof)) return false;
  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') return false;
  if (!proposal.repo) return false;
  return proposal.isPartial === true || hasCurrentDeterministicFailureEvidence(proposal);
}

/** A repair-only retry needs current merge-grade failure evidence, not a mutable flag. */
function hasCurrentDeterministicFailureEvidence(proposal: Proposal): boolean {
  const ran = proposal.verifyResult?.ran;
  return proposal.status === 'pending' &&
    proposal.isPartial !== true &&
    proposal.verifyResult?.passed === false &&
    hasCurrentVerificationBinding(proposal) &&
    Array.isArray(ran) &&
    ran.some((command) => command.required !== false &&
      buildRequiredVerificationManifest(proposal.repo!, [command as VerifyCommand]) !== null);
}

function repairReason(proposal: Proposal): string {
  const verify = proposal.verifyResult;
  const failed = Array.isArray(verify?.failed)
    ? verify.failed.find((line) => typeof line === 'string' && line.trim())
    : undefined;
  const raw =
    verify?.detail ??
    failed ??
    (proposal.isPartial === true
      ? 'partial proposal capture needs a complete verified repair'
      : 'verification failed');
  return boundedRepairReason(raw, MAX_REASON);
}

function isRepairableCaptureFailure(event: DispatchProductionEvent): boolean {
  if (event.source !== 'self' && event.source !== 'issue' && event.source !== 'goal') return false;
  if (event.basis !== 'run-proposal-outcome') return false;
  if (event.proposalCreated !== false) return false;
  if (event.proposalId) return false;
  if (!event.repo || !event.itemId) return false;
  if (event.outcome === 'proposal-capture-error') return true;
  if (event.outcome !== 'gate-blocked') return false;
  if ((event.runEventSummary?.actionCounts?.completenessGateRuns ?? 0) > 0) return true;
  if (hasChangedFileEvidence(event)) return true;
  return /\b(?:capture|completeness|gate)\b/i.test(`${event.reason ?? ''}\n${event.routeReason ?? ''}`);
}

function hasChangedFileEvidence(event: DispatchProductionEvent): boolean {
  return positiveCount(event.diffFiles) > 0 ||
    positiveCount(event.runEventSummary?.actionCounts?.diffFiles) > 0;
}

function positiveCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function isDiagnosticNoDiffEvent(event: DispatchProductionEvent): boolean {
  if (event.basis !== 'run-proposal-outcome') return false;
  if (event.outcome !== 'empty-diff') return false;
  if (event.proposalCreated !== false) return false;
  if (event.proposalId) return false;
  if (!event.repo || !event.itemId) return false;
  if (event.learningLabel && event.learningLabel.learningKind !== 'diagnostic-no-proposal') return false;
  return true;
}

export function proposalRepairWorkItem(
  proposal: Proposal,
  now = new Date(),
  decisionProof?: CaptureDecisionProof,
): WorkItem | null {
  if (!proposalNeedsRepair(proposal, now, decisionProof) || !proposal.repo) return null;
  const repo = canonicalEnrolledExistingRepo(proposal.repo);
  if (!repo) return null;
  const root = proposalRepairRootIdentity(proposal, repo);
  if (!root) return null;
  const verifiedFailureRepair = hasCurrentDeterministicFailureEvidence(proposal);
  const repairGenerationId = verifiedFailureRepair
    ? proposalRepairGenerationId(proposal, repo, root)
    : undefined;
  if (verifiedFailureRepair && !repairGenerationId) return null;

  const title = bounded(proposal.title, MAX_TITLE) || proposal.id;
  const reason = repairReason(proposal);
  const value = 5;
  const effort = 1;
  const repairKind = proposal.isPartial === true ? 'partial' : 'verify';

  return {
    id: proposalRepairId(repo, proposal.id),
    repo,
    source: 'self',
    title: `Repair proposal ${proposal.id}: ${title}`,
    detail:
      `Proposal repair: test failure or partial captured proposal needs a complete verified patch.\n` +
      `Proposal: ${bounded(proposal.id, 80)}\n` +
      `Original work item: ${bounded(proposal.workItemId ?? 'unknown', 120)}\n` +
      `Failure: ${reason}\n` +
      `Produce a fresh complete fix, rerun merge-grade verification, and do not apply the existing partial diff directly.`,
    value,
    effort,
    score: value / effort,
    tags: [
      'self-heal',
      'proposal-repair',
      repairKind,
      'verify',
      'high-priority',
      ...(proposal.status === 'rejected' ? ['rejected-capture-recovery'] : []),
    ],
    ts: Number.isFinite(Date.parse(proposal.createdAt)) ? new Date(proposal.createdAt).toISOString() : now.toISOString(),
    ...(repairGenerationId ? { repairGenerationId } : {}),
    ...root,
  };
}

/**
 * Prove that a queued repair is the exact depth-zero projection of a complete
 * pending proposal whose deterministic verification explicitly failed. Queue
 * metadata is not authority: partial/capture and diagnostic repair variants
 * intentionally fail this check.
 */
export function isVerifiedFailureProposalRepairAuthorized(item: WorkItem): boolean {
  if (!isTrustedProposalRepairItem(item) || item.tags.includes('partial')) return false;
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    if (!read.complete || read.sourceState === 'degraded') return false;
    return verifiedFailureProposalRepairParent(item, read.proposals) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Read the complete inbox projection that is eligible for repair-only dispatch.
 * This is intentionally separate from bounded outcome ledgers: an old failure
 * or a proposal without an evidence pack must not disappear from repair policy.
 */
export interface VerifiedFailureProposalRepairRead {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  items: WorkItem[];
}

export function listVerifiedFailureProposalRepairWorkItems(
  now = new Date(),
): VerifiedFailureProposalRepairRead {
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    if (!read.complete || read.sourceState !== 'healthy') {
      return { sourceState: read.sourceState, complete: read.complete, items: [] };
    }
    const items = read.proposals
      .map((proposal) => proposalRepairWorkItem(proposal, now))
      .filter((item): item is WorkItem => item !== null)
      .filter((item) => verifiedFailureProposalRepairParent(item, read.proposals) !== undefined);
    return { sourceState: read.sourceState, complete: read.complete, items };
  } catch {
    return { sourceState: 'degraded', complete: false, items: [] };
  }
}

function verifiedFailureProposalRepairParent(
  item: WorkItem,
  proposals: readonly Proposal[],
): Proposal | undefined {
  const parent = proposals.find((proposal) => {
    if (!hasCurrentDeterministicFailureEvidence(proposal)) {
      return false;
    }
    if (typeof proposal.repo !== 'string' || !proposal.repo) return false;
    const repo = canonicalEnrolledExistingRepo(proposal.repo);
    if (!repo || repo !== item.repo || proposalRepairId(repo, proposal.id) !== item.id) return false;
    const root = proposalRepairRootIdentity(proposal, repo);
    return root !== null &&
      item.repairRootId === root.repairRootId &&
      item.repairRootAuthorityId === root.repairRootAuthorityId &&
      item.repairDepth === root.repairDepth;
  });
  if (!parent) return undefined;
  const canonical = proposalRepairWorkItem(parent);
  if (!canonical || !sameCanonicalVerifiedFailureRepair(item, canonical)) return undefined;

  // A non-partial child from this exact repair is durable evidence that this
  // parent has already consumed its one repair dispatch. The parent remains
  // pending for operator review, but it must not re-enter a repair loop.
  const hasRepairChild = proposals.some((proposal) =>
    proposal.id !== parent.id &&
    proposal.workItemId === item.id &&
    proposal.isPartial !== true &&
    (proposal.kind === 'patch' || proposal.kind === 'pr') &&
    typeof proposal.diff === 'string' && proposal.diff.trim().length > 0,
  );
  return hasRepairChild ? undefined : parent;
}

/** Queue rows are transport only: execution-bearing text must match the parent-derived item. */
function sameCanonicalVerifiedFailureRepair(item: WorkItem, canonical: WorkItem): boolean {
  return item.id === canonical.id &&
    item.repo === canonical.repo &&
    item.source === canonical.source &&
    item.title === canonical.title &&
    item.detail === canonical.detail &&
    item.value === canonical.value &&
    item.effort === canonical.effort &&
    item.score === canonical.score &&
    item.ts === canonical.ts &&
    item.repairRootId === canonical.repairRootId &&
    item.repairRootAuthorityId === canonical.repairRootAuthorityId &&
    item.repairGenerationId === canonical.repairGenerationId &&
    item.repairDepth === canonical.repairDepth &&
    item.tags.length === canonical.tags.length &&
    item.tags.every((tag, index) => tag === canonical.tags[index]);
}

/**
 * Fence a repair parent from its final authority check through producer start.
 * Proposal writers share this per-proposal lock, so a concurrent lifecycle
 * transition cannot turn a stale repair selection into a launched dispatch.
 */
export function beginVerifiedFailureProposalRepairDispatch<T>(
  item: WorkItem,
  begin: () => T,
): { authorized: true; value: T } | { authorized: false } {
  if (!isTrustedProposalRepairItem(item) || item.tags.includes('partial')) return { authorized: false };
  let initial: Proposal | undefined;
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    if (!read.complete || read.sourceState === 'degraded') return { authorized: false };
    initial = verifiedFailureProposalRepairParent(item, read.proposals);
  } catch {
    return { authorized: false };
  }
  if (!initial) return { authorized: false };

  const lock = acquireProposalMutationLock(initial.id);
  if (!lock) return { authorized: false };
  try {
    const read = listProposalsDetailed({ requireComplete: true });
    if (!read.complete || read.sourceState === 'degraded' ||
      verifiedFailureProposalRepairParent(item, read.proposals)?.id !== initial.id) {
      return { authorized: false };
    }
    return { authorized: true, value: begin() };
  } catch {
    return { authorized: false };
  } finally {
    releaseProposalMutationLock(lock);
  }
}

/**
 * Revalidate a rejected-capture queue projection against its authoritative
 * proposal and decision ledger immediately before dispatch. Queue cleanup is
 * best-effort, so a stale row must never grant execution authority by itself.
 */
export function isRejectedCaptureRecoveryAuthorized(
  item: WorkItem,
  now = new Date(),
): boolean {
  const result = beginRejectedCaptureRecoveryDispatch(item, () => true, now);
  return result.authorized && result.value;
}

/** Begin producer execution while the parent proposal authority is fenced. */
export function beginRejectedCaptureRecoveryDispatch<T>(
  item: WorkItem,
  begin: () => T,
  now = new Date(),
): { authorized: true; value: T } | { authorized: false } {
  if (!item.tags.includes('rejected-capture-recovery')) {
    return { authorized: true, value: begin() };
  }
  let candidate: Proposal | undefined;
  try {
    candidate = listProposals({ status: 'rejected' }).find((proposal) =>
      typeof proposal.repo === 'string' && proposalRepairId(proposal.repo, proposal.id) === item.id);
  } catch {
    return { authorized: false };
  }
  if (!candidate) return { authorized: false };

  const mutationLock = acquireProposalMutationLock(candidate.id);
  if (!mutationLock) return { authorized: false };
  let began = false;
  try {
    const current = loadProposal(candidate.id);
    if (!current) return { authorized: false };
    const currentItem = proposalRepairWorkItem(current, now, readCaptureDecisionProof(now));
    if (currentItem?.id !== item.id || currentItem.repo !== resolve(item.repo)) {
      return { authorized: false };
    }
    began = true;
    return { authorized: true, value: begin() };
  } catch (error) {
    if (began) throw error;
    return { authorized: false };
  } finally {
    releaseProposalMutationLock(mutationLock);
  }
}

export function captureGateRepairWorkItem(
  event: DispatchProductionEvent,
  now = new Date(),
  parentRepair?: WorkItem,
): WorkItem | null {
  if (!isRepairableCaptureFailure(event)) return null;
  const eventMs = Date.parse(event.ts);
  const nowMs = now.getTime();
  const durableHandoff = event.assignedBy === 'repair-handoff-journal';
  if (!Number.isFinite(eventMs) || eventMs > nowMs || (!durableHandoff && nowMs - eventMs > DISPATCH_CAPTURE_WINDOW_MS)) {
    return null;
  }
  const repo = canonicalEnrolledExistingRepo(event.repo);
  if (!repo) return null;
  const reason = boundedRepairReason(event.reason ?? event.routeReason ?? event.outcome, MAX_REASON) || event.outcome;
  const itemId = bounded(event.itemId, 120) || 'unknown';
  const repairItemId = captureRepairId(repo, itemId);
  const root = dispatchRepairRootIdentity(event, repo, parentRepair);
  if (!root) return null;
  const title = bounded(event.title, MAX_TITLE);
  const outcome = event.outcome;
  const value = 5;
  const effort = 1;
  const runId = bounded(event.runId, 120);
  const diffFacts = [
    typeof event.diffFiles === 'number' ? `files=${Math.max(0, Math.trunc(event.diffFiles))}` : undefined,
    typeof event.diffLines === 'number' ? `lines=${Math.max(0, Math.trunc(event.diffLines))}` : undefined,
  ].filter(Boolean).join(', ');

  const item: WorkItem = {
    id: repairItemId,
    repo,
    source: 'self',
    title: `Repair dispatch capture failure for ${bounded(basename(repo), 80) || 'repo'} item ${itemId}`,
    detail:
      `Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n` +
      `Original work item: ${itemId}\n` +
      (title ? `Original title: ${title}\n` : '') +
      (runId ? `Run: ${runId}\n` : '') +
      `Dispatch outcome: ${outcome}\n` +
      (diffFacts ? `Diff metadata: ${diffFacts}\n` : '') +
      `Failure: ${reason}\n` +
      `Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.`,
    value,
    effort,
    score: value / effort,
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority'],
    ts: new Date(eventMs).toISOString(),
    ...root,
    ...(event.repairHandoffId ? { repairHandoffId: event.repairHandoffId } : {}),
    ...(event.repairGenerationId ? { repairGenerationId: event.repairGenerationId } : {}),
    ...(typeof event.objectiveHash === 'string' && /^[a-f0-9]{64}$/.test(event.objectiveHash)
      ? {
          repairParentItemId: itemId,
          repairParentSource: event.source,
          repairParentBackend: event.backend,
          repairParentTier: event.tier,
          repairParentObjectiveHash: event.objectiveHash,
        }
      : {}),
  };
  return isActionableSelfHealItem(item, {
    nowMs,
    ...(durableHandoff ? { maxAgeMs: Number.MAX_SAFE_INTEGER } : {}),
  }) ? item : null;
}

export function noDiffResliceWorkItem(
  event: DispatchProductionEvent,
  now = new Date(),
  parentRepair?: WorkItem,
): WorkItem | null {
  if (!isDiagnosticNoDiffEvent(event)) return null;
  const eventMs = Date.parse(event.ts);
  const nowMs = now.getTime();
  const durableHandoff = event.assignedBy === 'repair-handoff-journal';
  if (!Number.isFinite(eventMs) || eventMs > nowMs || (!durableHandoff && nowMs - eventMs > DISPATCH_CAPTURE_WINDOW_MS)) {
    return null;
  }
  const repo = canonicalEnrolledExistingRepo(event.repo);
  if (!repo) return null;
  const reason = boundedRepairReason(event.reason ?? event.routeReason ?? event.outcome, MAX_REASON) || event.outcome;
  const itemId = bounded(event.itemId, 120) || 'unknown';
  const repairItemId = noDiffResliceId(repo, itemId);
  const root = dispatchRepairRootIdentity(event, repo, parentRepair);
  if (!root) return null;
  const title = bounded(event.title, MAX_TITLE);
  const backend = bounded(event.backend ?? 'unknown', 80) || 'unknown';
  const source = bounded(event.source, 80) || 'unknown';
  const routeReason = boundedRepairReason(event.routeReason, MAX_REASON);
  const runId = bounded(event.runId, 120);
  const value = 4;
  const effort = 1;
  const derivedHandoff = repairHandoffFromDispatchEvent(event);
  const generationId = event.repairGenerationId ?? derivedHandoff?.generationId;
  const treatmentUnitId = event.repairTreatmentUnitId ?? derivedHandoff?.repairTreatmentUnitId ?? repairTreatmentUnitId({
    kind: 'no-diff-reslice',
    repo,
    parentItemId: event.itemId,
    parentObjectiveHash: event.objectiveHash ?? '',
  });
  const assignedTreatment = treatmentUnitId ? repairTreatmentForUnitId(treatmentUnitId) : null;
  if (
    !generationId || !treatmentUnitId || !assignedTreatment ||
    (event.repairTreatmentUnitId !== undefined && event.repairTreatmentUnitId !== treatmentUnitId) ||
    (event.repairTreatment !== undefined && event.repairTreatment !== assignedTreatment)
  ) return null;
  const treatment = assignedTreatment;

  const item: WorkItem = {
    id: repairItemId,
    repo,
    source: 'self',
    title: `Reslice no-diff dispatch for ${bounded(basename(repo), 80) || 'repo'} item ${itemId}`,
    detail:
      `Diagnostic reslice: a dispatch completed without file changes, so the task likely needs tighter scope and retrieved context.\n` +
      `Original work item: ${itemId}\n` +
      (title ? `Original title: ${title}\n` : '') +
      (runId ? `Run: ${runId}\n` : '') +
      `Original source: ${source}\n` +
      `Backend: ${backend}\n` +
      (routeReason ? `Route: ${routeReason}\n` : '') +
      `Dispatch outcome: empty-diff\n` +
      `Failure: ${reason}\n` +
      `${resliceInstruction(treatment)} ` +
      `Run merge-grade verification for any edit. ` +
      `Do not copy raw prompts, stdout, stderr, env, file contents, or prior diff output.`,
    value,
    effort,
    score: value / effort,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority'],
    ts: new Date(eventMs).toISOString(),
    ...root,
    ...(event.repairHandoffId
      ? { repairHandoffId: event.repairHandoffId }
      : derivedHandoff ? { repairHandoffId: derivedHandoff.eventId } : {}),
    repairGenerationId: generationId,
    repairTreatmentUnitId: treatmentUnitId,
    repairTreatment: treatment,
    repairParentItemId: itemId,
    repairParentSource: event.source,
    repairParentBackend: event.backend,
    repairParentTier: event.tier,
    ...(typeof event.objectiveHash === 'string' && /^[a-f0-9]{64}$/.test(event.objectiveHash)
      ? { repairParentObjectiveHash: event.objectiveHash }
      : {}),
  };
  return isActionableSelfHealItem(item, {
    nowMs,
    ...(durableHandoff ? { maxAgeMs: Number.MAX_SAFE_INTEGER } : {}),
  }) ? item : null;
}

interface RecentDispatchEventsRead {
  events: DispatchProductionEvent[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  invalidRows: number;
  unreadableFiles: number;
  stopReasons: DispatchProductionReadStopReason[];
}

function readRecentDispatchEvents(
  now: Date,
  opts?: ProposalRepairWorkOptions,
  handoffRead?: ReturnType<typeof readRepairHandoffs>,
): RecentDispatchEventsRead {
  if (opts?.dispatchEvents) {
    return {
      events: opts.dispatchEvents,
      sourceState: 'healthy',
      complete: true,
      invalidRows: 0,
      unreadableFiles: 0,
      stopReasons: [],
    };
  }
  if (opts?.includeDispatchCaptureFailures === false && opts?.includeDispatchNoDiffReslices === false) {
    return {
      events: [],
      sourceState: 'missing',
      complete: true,
      invalidRows: 0,
      unreadableFiles: 0,
      stopReasons: [],
    };
  }
  try {
    const handoffSource = handoffRead ?? readRepairHandoffs();
    const handoffs = handoffSource.observations.map(dispatchEventFromRepairHandoff);
    const sinceMs = now.getTime() - Math.max(0, opts?.dispatchWindowMs ?? DISPATCH_CAPTURE_WINDOW_MS);
    const production = readDispatchProductionEventsDetailed({ sinceMs });
    const byIdentity = new Map<string, DispatchProductionEvent>();
    // Handoff projections carry the canonical generation identity for parent
    // failures. Let them replace the analytics copy of the same parent row,
    // while retaining child proposal-production rows that have no handoff.
    for (const event of [...production.events, ...handoffs]) {
      byIdentity.set(JSON.stringify([event.ts, event.itemId, event.repo, event.outcome, event.proposalId ?? null]), event);
    }
    const handoffsComplete = handoffSource.sourceState !== 'degraded' && !handoffSource.limitExceeded;
    const complete = production.complete && production.sourceState !== 'degraded' && handoffsComplete;
    return {
      events: [...byIdentity.values()],
      sourceState: complete
        ? production.sourceState === 'healthy' || handoffSource.sourceState === 'healthy' ? 'healthy' : 'missing'
        : 'degraded',
      complete,
      invalidRows: production.invalidRows,
      unreadableFiles: production.unreadableFiles,
      stopReasons: production.stopReasons,
    };
  } catch {
    return {
      events: [],
      sourceState: 'degraded',
      complete: false,
      invalidRows: 0,
      unreadableFiles: 1,
      stopReasons: ['io-error'],
    };
  }
}

function canonicalEnrolledExistingRepo(repo: string): string | null {
  let repoKey: string;
  try {
    repoKey = resolve(repo);
  } catch {
    return null;
  }
  for (const enrolled of listEnrolled()) {
    try {
      if (resolve(enrolled) !== repoKey) continue;
      return existsSync(enrolled) ? enrolled : null;
    } catch {
      // Ignore malformed enrollment rows.
    }
  }
  return null;
}

function byNewestEvent(a: DispatchProductionEvent, b: DispatchProductionEvent): number {
  const ams = Date.parse(a.ts);
  const bms = Date.parse(b.ts);
  const safeA = Number.isFinite(ams) ? ams : 0;
  const safeB = Number.isFinite(bms) ? bms : 0;
  return safeB - safeA;
}

function canonicalDiagnosticReceiptEvent(
  item: WorkItem,
  event: DispatchProductionEvent,
  generationId: string,
  ordinal: 1 | 2,
): boolean {
  if (
    event.itemId !== item.id ||
    event.source !== item.source ||
    event.objectiveHash !== workItemObjectiveHash(item) ||
    event.repairHandoffId !== item.repairHandoffId ||
    event.repairGenerationId !== generationId ||
    event.repairTreatmentUnitId !== item.repairTreatmentUnitId ||
    event.repairTreatment !== item.repairTreatment ||
    event.repairAttemptOrdinal !== ordinal ||
    event.basis !== 'run-proposal-outcome'
  ) return false;
  try {
    return resolve(event.repo) === resolve(item.repo);
  } catch {
    return false;
  }
}

function diagnosticProposalAttemptTarget(
  item: WorkItem,
  proposal: Proposal,
  generationId: string,
  repairAttemptOrdinal: 1 | 2,
  ts: string,
): DispatchProductionAttemptProofTarget | null {
  const objectiveHash = workItemObjectiveHash(item);
  if (
    objectiveHash === null ||
    typeof item.repairHandoffId !== 'string' ||
    typeof item.repairTreatmentUnitId !== 'string' ||
    item.repairTreatment == null
  ) return null;
  return {
    ts,
    itemId: item.id,
    repo: item.repo,
    source: item.source,
    outcome: 'proposal-created',
    proposalId: proposal.id,
    objectiveHash,
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: generationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal,
  };
}

function canonicalDiagnosticProposalEvent(
  item: WorkItem,
  proposal: Proposal,
  event: DispatchProductionEvent,
  generationId: string,
  ordinal: 1 | 2,
): boolean {
  return canonicalDiagnosticReceiptEvent(item, event, generationId, ordinal) &&
    event.outcome === 'proposal-created' &&
    event.proposalCreated === true &&
    event.proposalId === proposal.id &&
    event.runId === proposal.runId &&
    event.trajectoryId === proposal.trajectoryId;
}

export type GeneratedRepairProposalDispatchAuthority =
  | 'not-applicable'
  | 'proven'
  | 'unavailable';

/**
 * Decide whether one pending proposal may suppress redispatch of a diagnostic
 * repair. A proposal is never proof by itself: only its exact immutable attempt
 * receipt grants terminal lifecycle authority. A durable pending proposal stays
 * blocking even when its receipt is absent: proposal persistence precedes the
 * receipt intent, so absence can represent a completed producer crash. An
 * uncommitted intent, malformed evidence, and unreadable storage also fail closed.
 */
export function generatedRepairProposalDispatchAuthority(
  item: WorkItem,
  proposal: Proposal,
): GeneratedRepairProposalDispatchAuthority {
  if (!isTrustedDiagnosticResliceItem(item) || proposal.status !== 'pending') {
    return 'not-applicable';
  }
  const generationIds = generatedRepairGenerationIds(item);
  if (
    proposal.workItemId !== item.id ||
    typeof proposal.workItemGenerationId !== 'string' ||
    !generationIds.includes(proposal.workItemGenerationId)
  ) return 'not-applicable';
  try {
    if (!proposal.repo || resolve(proposal.repo) !== resolve(item.repo)) return 'not-applicable';
  } catch {
    return 'not-applicable';
  }

  const generationId = generatedRepairGenerationId(item);
  if (
    generationId === null ||
    item.repairGenerationId !== generationId ||
    proposal.workItemGenerationId !== generationId ||
    !durableGeneratedRepairProposal(item, proposal) ||
    proposal.runEventSummary?.outcome !== 'proposal-created' ||
    proposal.runEventSummary.proposalCreated !== true
  ) return 'unavailable';

  const targets = ([1, 2] as const).map((repairAttemptOrdinal) => ({
    repairGenerationId: generationId,
    repairAttemptOrdinal,
  }));
  const witnessed = resolveDispatchProductionAttemptReceiptWitnesses(targets);
  if (witnessed.status !== 'resolved') return 'unavailable';

  let canonicalEmptyReceipts = 0;
  const missingOrdinals: Array<1 | 2> = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const resolution = witnessed.resolutions[index];
    if (resolution?.status === 'missing' && resolution.reason === 'receipt-missing') {
      missingOrdinals.push(target.repairAttemptOrdinal);
      continue;
    }
    if (
      resolution?.status !== 'proven' ||
      resolution.proof.repairGenerationId !== generationId ||
      resolution.proof.repairAttemptOrdinal !== target.repairAttemptOrdinal ||
      resolution.proof.eventTs !== resolution.event.ts ||
      !canonicalDiagnosticReceiptEvent(item, resolution.event, generationId, target.repairAttemptOrdinal)
    ) return 'unavailable';

    const event = resolution.event;
    if (
      event.outcome === 'empty-diff' &&
      event.proposalCreated === false &&
      event.proposalId === undefined
    ) {
      canonicalEmptyReceipts++;
      continue;
    }
    if (canonicalDiagnosticProposalEvent(
      item,
      proposal,
      event,
      generationId,
      target.repairAttemptOrdinal,
    )) return 'proven';
    return 'unavailable';
  }

  // Two canonical empty attempts are terminal lifecycle evidence. If projection
  // has not pruned the item yet, keep it blocked rather than permit a third run.
  if (canonicalEmptyReceipts >= 2 || missingOrdinals.length === 0) return 'unavailable';

  const proposalMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(proposalMs)) return 'unavailable';
  let productionRead: ReturnType<typeof readDispatchProductionEventsDetailed>;
  try {
    productionRead = readDispatchProductionEventsDetailed({
      sinceMs: Math.max(0, proposalMs - PROPOSAL_ATTEMPT_SCAN_SLOP_MS),
    });
  } catch {
    return 'unavailable';
  }
  if (
    productionRead.sourceState !== 'healthy' ||
    !productionRead.complete ||
    productionRead.invalidRows > 0 ||
    productionRead.unreadableFiles > 0
  ) return 'unavailable';

  const missing = new Set<1 | 2>(missingOrdinals);
  const partitionEmptyOrdinals = new Set<1 | 2>();
  const proposalEvents: DispatchProductionEvent[] = [];
  for (const event of productionRead.events) {
    if (
      event.repairGenerationId !== generationId ||
      (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
      !missing.has(event.repairAttemptOrdinal)
    ) continue;
    if (!canonicalDiagnosticReceiptEvent(
      item,
      event,
      generationId,
      event.repairAttemptOrdinal,
    )) return 'unavailable';
    if (
      event.outcome === 'empty-diff' &&
      event.proposalCreated === false &&
      event.proposalId === undefined
    ) {
      partitionEmptyOrdinals.add(event.repairAttemptOrdinal);
      continue;
    }
    if (canonicalDiagnosticProposalEvent(
      item,
      proposal,
      event,
      generationId,
      event.repairAttemptOrdinal,
    )) {
      proposalEvents.push(event);
      continue;
    }
    return 'unavailable';
  }

  for (const event of proposalEvents) {
    const target = diagnosticProposalAttemptTarget(
      item,
      proposal,
      generationId,
      event.repairAttemptOrdinal!,
      event.ts,
    );
    if (target === null) return 'unavailable';
    const resolved = resolveDispatchProductionAttemptWitnesses([target]);
    const proof = resolved.status === 'resolved' ? resolved.resolutions[0] : undefined;
    if (
      proof?.status !== 'proven' ||
      proof.proof.eventTs !== event.ts ||
      !canonicalDiagnosticProposalEvent(
        item,
        proposal,
        proof.event,
        generationId,
        event.repairAttemptOrdinal!,
      )
    ) return 'unavailable';
  }
  if (proposalEvents.length > 0) return 'proven';
  if (canonicalEmptyReceipts + partitionEmptyOrdinals.size >= 2) return 'unavailable';

  // Receipt retention can make an otherwise clean partition miss ambiguous.
  // Resolve each missing ordinal at the proposal timestamp so retention,
  // mutation, or sequence ambiguity remains fail-closed.
  const absenceTargets = missingOrdinals.map((ordinal) => diagnosticProposalAttemptTarget(
      item,
      proposal,
      generationId,
      ordinal,
      new Date(proposalMs).toISOString(),
    ));
  if (absenceTargets.some((target) => target === null)) return 'unavailable';
  const absence = resolveDispatchProductionAttemptWitnesses(
    absenceTargets as DispatchProductionAttemptProofTarget[],
  );
  if (
    absence.status !== 'resolved' ||
    absence.resolutions.some((resolution) =>
      resolution.status !== 'missing' &&
      !(resolution.status === 'unproven' && resolution.reason === 'attempt-sequence-missing'))
  ) return 'unavailable';
  return 'unavailable';
}

function reconcileDiagnosticLifecycleFromReceipts(
  item: WorkItem,
  durableProposal: Proposal | undefined,
): boolean {
  const generationId = generatedRepairGenerationId(item);
  if (generationId === null || item.repairGenerationId !== generationId) return false;
  const targets = ([1, 2] as const).map((repairAttemptOrdinal) => ({
    repairGenerationId: generationId,
    repairAttemptOrdinal,
  }));
  const witnessed = resolveDispatchProductionAttemptReceiptWitnesses(targets);
  if (witnessed.status !== 'resolved') return false;

  const first = witnessed.resolutions[0];
  const second = witnessed.resolutions[1];
  if (durableProposal && witnessed.resolutions.every((resolution) =>
    resolution.status === 'missing' && resolution.reason === 'receipt-missing')) {
    return false;
  }
  const freshGeneration = first?.status === 'missing' && first.reason === 'receipt-missing' &&
    second?.status === 'unproven' && second.reason === 'attempt-sequence-missing';
  if (freshGeneration) return true;

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const resolution = witnessed.resolutions[index];
    if (resolution?.status === 'missing' && resolution.reason === 'receipt-missing') continue;
    if (
      resolution?.status !== 'proven' ||
      resolution.proof.repairGenerationId !== generationId ||
      resolution.proof.repairAttemptOrdinal !== target.repairAttemptOrdinal ||
      resolution.proof.eventTs !== resolution.event.ts ||
      !canonicalDiagnosticReceiptEvent(
        item,
        resolution.event,
        generationId,
        target.repairAttemptOrdinal,
      )
    ) return false;

    const event = resolution.event;
    if (
      event.outcome === 'empty-diff' &&
      event.proposalCreated === false &&
      event.proposalId === undefined
    ) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'dispatch-proof-empty-diff',
        eventTs: event.ts,
      });
      continue;
    }
    if (
      event.outcome === 'proposal-created' &&
      event.proposalCreated === true &&
      durableProposal?.trajectoryId &&
      durableProposal.workItemGenerationId === generationId &&
      event.proposalId === durableProposal.id &&
      event.runId === durableProposal.runId &&
      event.trajectoryId === durableProposal.trajectoryId
    ) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'proposal-created',
        attemptId: event.trajectoryId,
        proposalId: event.proposalId,
        ts: event.ts,
      });
      continue;
    }
    // Any other proven receipt is not terminal lifecycle evidence. Keep the
    // generation operator-visible and blocked rather than minting new authority.
    return false;
  }
  return true;
}

export function queueProposalRepairWorkForPendingProposals(
  proposals?: Proposal[],
  now = new Date(),
  opts?: ProposalRepairWorkOptions,
): ProposalRepairWorkResult {
  const verifiedFailureProposalOnly = opts?.verifiedFailureProposalOnly === true;
  let handoffs: ReturnType<typeof readRepairHandoffs> | undefined;
  let pending: Proposal[];
  let availableProposals: Proposal[];
  let captureDecisionProof: CaptureDecisionProof;
  try {
    handoffs = proposals === undefined && !opts?.dispatchEvents ? readRepairHandoffs() : undefined;
    captureDecisionProof = readCaptureDecisionProof(now);
    if (proposals === undefined) {
      const read = listProposalsDetailed({ requireComplete: true });
      if (!read.complete || read.sourceState === 'degraded') {
        throw new Error('proposal inbox is degraded or incomplete');
      }
      availableProposals = read.proposals;
    } else {
      availableProposals = proposals;
    }
    const rejectedCapture = availableProposals
      .filter((proposal) => isRecentRejectedCaptureArtifact(proposal, now, captureDecisionProof))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, REJECTED_CAPTURE_MAX_SCANNED);
    pending = verifiedFailureProposalOnly
      ? availableProposals.filter((proposal) =>
          hasCurrentDeterministicFailureEvidence(proposal))
      : [
          ...availableProposals.filter((proposal) => proposal.status === 'pending'),
          ...rejectedCapture,
        ];
  } catch {
    return {
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalInboxAvailable: false,
      dispatchSourceState: 'degraded',
      dispatchSourceComplete: false,
      dispatchSourceInvalidRows: 0,
      dispatchSourceUnreadableFiles: 1,
      dispatchSourceStopReasons: ['io-error'],
      ...(handoffs ? {
        handoffObservations: handoffs.observations.length,
        handoffInvalidRows: handoffs.invalidRows,
        handoffConflictingIds: handoffs.conflictingIds,
        handoffSourceState: handoffs.sourceState,
        handoffAuthorityDigest: handoffs.authorityDigest,
      } : {}),
    };
  }
  let lifecycleProposals: Proposal[] = [];
  if (opts?.terminalLifecycleEnabled !== false) {
    lifecycleProposals = opts?.lifecycleProposals ?? availableProposals;
  }
  const terminalLifecycleEnabled = opts?.terminalLifecycleEnabled !== false;
  const includeCaptureRepairs = !verifiedFailureProposalOnly && opts?.includeDispatchCaptureFailures !== false;
  const includeNoDiffReslices = !verifiedFailureProposalOnly && opts?.includeDispatchNoDiffReslices !== false;
  const dispatchRead: RecentDispatchEventsRead = includeCaptureRepairs || includeNoDiffReslices
    ? proposals === undefined
      ? readRecentDispatchEvents(now, opts, handoffs)
      : opts?.dispatchEvents
        ? readRecentDispatchEvents(now, opts)
        : {
            events: [], sourceState: 'missing', complete: true,
            invalidRows: 0, unreadableFiles: 0, stopReasons: [],
          }
    : {
        events: [], sourceState: 'missing', complete: true,
        invalidRows: 0, unreadableFiles: 0, stopReasons: [],
      };
  if (!dispatchRead.complete || dispatchRead.sourceState === 'degraded') {
    return {
      scanned: pending.length,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalEligible: 0,
      proposalQueued: 0,
      proposalFailed: 0,
      dispatchCaptureScanned: 0,
      dispatchCaptureEligible: 0,
      dispatchCaptureQueued: 0,
      dispatchCaptureFailed: includeCaptureRepairs ? 1 : 0,
      dispatchNoDiffScanned: 0,
      dispatchNoDiffEligible: 0,
      dispatchNoDiffQueued: 0,
      dispatchNoDiffFailed: includeNoDiffReslices ? 1 : 0,
      proposalInboxAvailable: true,
      dispatchSourceState: dispatchRead.sourceState,
      dispatchSourceComplete: dispatchRead.complete,
      dispatchSourceInvalidRows: dispatchRead.invalidRows,
      dispatchSourceUnreadableFiles: dispatchRead.unreadableFiles,
      dispatchSourceStopReasons: dispatchRead.stopReasons,
      ...(handoffs ? {
        handoffObservations: handoffs.observations.length,
        handoffInvalidRows: handoffs.invalidRows,
        handoffConflictingIds: handoffs.conflictingIds,
        handoffSourceState: handoffs.sourceState,
        handoffAuthorityDigest: handoffs.authorityDigest,
      } : {}),
    };
  }
  const dispatchEvents = dispatchRead.events
    .slice()
    .sort(byNewestEvent);
  const maxCaptureQueued = Math.max(
    0,
    Math.min(DISPATCH_CAPTURE_MAX_QUEUED, Math.floor(opts?.maxDispatchCaptureQueued ?? DISPATCH_CAPTURE_MAX_QUEUED)),
  );
  const maxNoDiffQueued = Math.max(
    0,
    Math.min(DISPATCH_NO_DIFF_MAX_QUEUED, Math.floor(opts?.maxDispatchNoDiffQueued ?? DISPATCH_NO_DIFF_MAX_QUEUED)),
  );

  const result: ProposalRepairWorkResult = {
    scanned: pending.length + dispatchEvents.length,
    eligible: 0,
    queued: 0,
    failed: 0,
    proposalEligible: 0,
    proposalQueued: 0,
    proposalFailed: 0,
    dispatchCaptureScanned: includeCaptureRepairs ? dispatchEvents.length : 0,
    dispatchCaptureEligible: 0,
    dispatchCaptureQueued: 0,
    dispatchCaptureFailed: 0,
    dispatchNoDiffScanned: includeNoDiffReslices ? dispatchEvents.length : 0,
    dispatchNoDiffEligible: 0,
    dispatchNoDiffQueued: 0,
    dispatchNoDiffFailed: 0,
    dispatchRepairRetired: 0,
    dispatchRepairExhausted: 0,
    dispatchRepairQuarantined: 0,
    dispatchRepairPruned: 0,
    dispatchRepairPruneFailed: 0,
    dispatchRepairLifecycleUnavailable: 0,
    repairRootAdmissionConsidered: 0,
    repairRootAdmissionAdmitted: 0,
    repairRootAdmissionAlreadyActive: 0,
    repairRootAdmissionRootless: 0,
    repairRootAdmissionDepthRejected: 0,
    blockedItemKeys: [],
    blockedRootKeys: [],
    proposalInboxAvailable: true,
    dispatchSourceState: dispatchRead.sourceState,
    dispatchSourceComplete: dispatchRead.complete,
    dispatchSourceInvalidRows: dispatchRead.invalidRows,
    dispatchSourceUnreadableFiles: dispatchRead.unreadableFiles,
    dispatchSourceStopReasons: dispatchRead.stopReasons,
  };
  if (handoffs) {
    result.handoffObservations = handoffs.observations.length;
    result.handoffInvalidRows = handoffs.invalidRows;
    result.handoffConflictingIds = handoffs.conflictingIds;
    result.handoffSourceState = handoffs.sourceState;
    result.handoffAuthorityDigest = handoffs.authorityDigest;
  }

  const terminalByKey = new Map<string, 'retired' | 'exhausted' | 'quarantined'>();
  const blockedItemKeys = new Set<string>();
  const blockedRootKeys = new Set<string>();
  const lifecycleUnavailableKeys = new Set<string>();
  const activeRepairItemsByRoot = new Map<string, Map<string, WorkItem>>();
  const activeRepairItemsById = new Map<string, WorkItem>();
  const registerActiveRoot = (item: WorkItem): void => {
    const rootKey = generatedRepairRootKey(item);
    if (!rootKey) return;
    const items = activeRepairItemsByRoot.get(rootKey) ?? new Map<string, WorkItem>();
    items.set(item.id, item);
    activeRepairItemsByRoot.set(rootKey, items);
    activeRepairItemsById.set(item.id, item);
  };
  const observeLifecycle = (
    item: WorkItem,
  ): 'not-generated' | 'active' | 'terminal' | 'quarantined' | 'unavailable' => {
    if (!terminalLifecycleEnabled) return 'not-generated';
    if (!isTrustedGeneratedRepairItem(item)) return 'not-generated';
    let key: string;
    try {
      key = workItemCoverageKey(item);
    } catch {
      return 'unavailable';
    }
    const durableProposal = lifecycleProposals
      .filter((proposal) => durableGeneratedRepairProposal(item, proposal))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    const diagnosticProposalProofRequired = isTrustedDiagnosticResliceItem(item);
    if (diagnosticProposalProofRequired) {
      if (!reconcileDiagnosticLifecycleFromReceipts(item, durableProposal)) {
        terminalByKey.delete(key);
        blockedItemKeys.add(key);
        lifecycleUnavailableKeys.add(key);
        return 'unavailable';
      }
    } else if (durableProposal?.trajectoryId) {
      recordGeneratedRepairLifecycle(item, {
        kind: 'proposal-created',
        attemptId: durableProposal.trajectoryId,
        proposalId: durableProposal.id,
        ts: durableProposal.createdAt,
      });
    }
    const lifecycle = readGeneratedRepairLifecycle(item);
    if (!lifecycle.available) {
      terminalByKey.delete(key);
      blockedItemKeys.add(key);
      const rootKey = generatedRepairRootKey(item);
      if (rootKey) blockedRootKeys.add(rootKey);
      lifecycleUnavailableKeys.add(key);
      return 'unavailable';
    }
    if (lifecycle.disposition === 'active') {
      terminalByKey.delete(key);
      blockedItemKeys.delete(key);
      return 'active';
    }
    terminalByKey.set(key, lifecycle.disposition);
    blockedItemKeys.add(key);
    return lifecycle.disposition === 'quarantined' ? 'quarantined' : 'terminal';
  };
  const prune = terminalLifecycleEnabled && !verifiedFailureProposalOnly
      ? pruneQueuedSelfHealItems((item) => {
        if (
          item.tags.includes('rejected-capture-recovery') &&
          !isActionableSelfHealItem(item, {
            nowMs: now.getTime(),
            maxAgeMs: REJECTED_CAPTURE_REPAIR_MAX_AGE_MS,
          })
        ) return true;
        if (isTrustedGeneratedRepairItem(item) && generatedRepairRootKey(item) === null) {
          result.repairRootAdmissionRootless = incrementBounded(result.repairRootAdmissionRootless);
          return true;
        }
        if (isTrustedDiagnosticResliceItem(item) && generatedRepairGenerationId(item) === null) return true;
        const lifecycle = observeLifecycle(item);
        if (lifecycle === 'active' || lifecycle === 'unavailable') registerActiveRoot(item);
        return lifecycle === 'terminal' || lifecycle === 'quarantined';
      })
    : { scanned: 0, removed: 0, failed: false };
  result.dispatchRepairPruned = prune.removed;
  result.dispatchRepairPruneFailed = prune.failed ? 1 : 0;

  const persistAdmittedRoot = (item: WorkItem): { admitted: boolean; changed: boolean } => {
    result.repairRootAdmissionConsidered = incrementBounded(result.repairRootAdmissionConsidered);
    if (item.repairDepth !== 0 && item.repairDepth !== 1) {
      result.repairRootAdmissionDepthRejected = incrementBounded(result.repairRootAdmissionDepthRejected);
      return { admitted: false, changed: false };
    }
    const rootKey = generatedRepairRootKey(item);
    if (!rootKey) {
      result.repairRootAdmissionRootless = incrementBounded(result.repairRootAdmissionRootless);
      return { admitted: false, changed: false };
    }
    if (blockedRootKeys.has(rootKey)) return { admitted: false, changed: false };
    const lockId = createHash('sha256').update(rootKey).digest('hex');
    const lock = acquireLocalStoreLock(join(homedir(), '.ashlr', 'repair-root-admission', `${lockId}.lock`), 0);
    if (!lock) {
      blockedRootKeys.add(rootKey);
      return { admitted: false, changed: false };
    }
    try {
      const queued = loadQueuedAutonomyItemsDetailed();
      if (queued.sourceState === 'unavailable') {
        blockedRootKeys.add(rootKey);
        return { admitted: false, changed: false };
      }
      const active = [...new Map([
        ...queued.items,
        ...(activeRepairItemsByRoot.get(rootKey)?.values() ?? []),
      ].filter((candidate) => generatedRepairRootKey(candidate) === rootKey).map((candidate) => [candidate.id, candidate])).values()];
      const same = active.filter((candidate) => candidate.id === item.id);
      const replaceIds = active
        .filter((parent) => item.repairDepth === 1 && parent.repairDepth === 0 && item.repairParentItemId === parent.id)
        .map((parent) => parent.id);
      if (active.length > same.length && replaceIds.length !== active.length - same.length) {
        result.repairRootAdmissionAlreadyActive = incrementBounded(result.repairRootAdmissionAlreadyActive);
        return { admitted: false, changed: false };
      }
      // Remove the parent projection before publishing its child. The root lock
      // prevents a concurrent pass from observing the gap and publishing a sibling.
      if (replaceIds.length > 0) {
        const replace = new Set(replaceIds);
        const pruned = pruneQueuedSelfHealItems((candidate) =>
          replace.has(candidate.id) && generatedRepairRootKey(candidate) === rootKey);
        result.dispatchRepairPruned = (result.dispatchRepairPruned ?? 0) + pruned.removed;
        if (pruned.failed) {
          result.dispatchRepairPruneFailed = 1;
          blockedRootKeys.add(rootKey);
          return { admitted: false, changed: false };
        }
      }
      const persisted = queueSelfHealItemDetailed(item);
      if (!persisted.ok) {
        blockedRootKeys.add(rootKey);
        return { admitted: false, changed: false };
      }
      activeRepairItemsByRoot.set(rootKey, new Map([[item.id, item]]));
      for (const id of replaceIds) activeRepairItemsById.delete(id);
      activeRepairItemsById.set(item.id, item);
      result.repairRootAdmissionAdmitted = incrementBounded(result.repairRootAdmissionAdmitted);
      return { admitted: true, changed: persisted.changed };
    } finally {
      releaseLocalStoreLock(lock);
    }
  };

  if (terminalLifecycleEnabled) for (const proposal of pending) {
    const requiresLiveFence = proposals === undefined && proposal.status === 'rejected';
    const mutationLock = requiresLiveFence ? acquireProposalMutationLock(proposal.id) : null;
    if (requiresLiveFence && !mutationLock) {
      result.failed++;
      result.proposalFailed!++;
      continue;
    }
    try {
      const current = requiresLiveFence ? loadProposal(proposal.id) : proposal;
      const currentProof = requiresLiveFence ? readCaptureDecisionProof(now) : captureDecisionProof;
      if (!current) continue;
      if (verifiedFailureProposalOnly && (
        current.status !== 'pending' || current.isPartial === true || current.verifyResult?.passed !== false
      )) continue;
      const item = proposalRepairWorkItem(current, now, currentProof);
      if (!item) continue;
      const lifecycle = observeLifecycle(item);
      if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
      const admission = persistAdmittedRoot(item);
      if (!admission.admitted) continue;
      result.eligible++;
      result.proposalEligible!++;
      result.queued++;
      result.proposalQueued!++;
    } finally {
      if (mutationLock) releaseProposalMutationLock(mutationLock);
    }
  }
  const seenCaptureIds = new Set<string>();
  let captureMutations = 0;
  if (terminalLifecycleEnabled && includeCaptureRepairs) for (const event of dispatchEvents) {
    if (captureMutations >= maxCaptureQueued) break;
    const item = captureGateRepairWorkItem(event, now, activeRepairItemsById.get(event.itemId));
    if (!item) continue;
    if (seenCaptureIds.has(item.id)) continue;
    seenCaptureIds.add(item.id);
    const lifecycle = observeLifecycle(item);
    if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
    const admission = persistAdmittedRoot(item);
    if (!admission.admitted) continue;
    result.eligible++;
    result.dispatchCaptureEligible!++;
    result.queued++;
    result.dispatchCaptureQueued!++;
    if (admission.changed) captureMutations++;
  }
  const seenNoDiffIds = new Set<string>();
  let noDiffMutations = 0;
  if (terminalLifecycleEnabled && includeNoDiffReslices) for (const event of dispatchEvents) {
    if (noDiffMutations >= maxNoDiffQueued) break;
    const item = noDiffResliceWorkItem(event, now, activeRepairItemsById.get(event.itemId));
    if (!item) continue;
    if (seenNoDiffIds.has(item.id)) continue;
    seenNoDiffIds.add(item.id);
    const lifecycle = observeLifecycle(item);
    if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
    const admission = persistAdmittedRoot(item);
    if (!admission.admitted) continue;
    result.eligible++;
    result.dispatchNoDiffEligible!++;
    result.queued++;
    result.dispatchNoDiffQueued!++;
    if (admission.changed) noDiffMutations++;
  }

  result.dispatchRepairRetired = [...terminalByKey.values()].filter((value) => value === 'retired').length;
  result.dispatchRepairExhausted = [...terminalByKey.values()].filter((value) => value === 'exhausted').length;
  result.dispatchRepairQuarantined = [...terminalByKey.values()].filter((value) => value === 'quarantined').length;
  result.dispatchRepairLifecycleUnavailable = lifecycleUnavailableKeys.size;
  result.blockedItemKeys = [...blockedItemKeys];
  result.blockedRootKeys = [...blockedRootKeys];
  if (
    proposals === undefined &&
    !opts?.dispatchEvents &&
    result.failed === 0 &&
    result.dispatchRepairPruneFailed === 0 &&
    result.dispatchRepairLifecycleUnavailable === 0
  ) {
    const compacted = compactRepairHandoffs();
    result.handoffCompacted = compacted.removed;
    result.handoffCompactionUnavailable = compacted.available ? 0 : 1;
  }

  return result;
}

function durableGeneratedRepairProposal(item: WorkItem, proposal: Proposal): boolean {
  if (
    proposal.status !== 'pending' &&
    proposal.status !== 'approved' &&
    proposal.status !== 'awaiting-host-merge' &&
    proposal.status !== 'applied'
  ) return false;
  if (proposal.workItemId !== item.id || proposal.workSource !== 'self') return false;
  const itemGenerationIds = generatedRepairGenerationIds(item);
  if (
    typeof proposal.workItemGenerationId !== 'string' ||
    !itemGenerationIds.includes(proposal.workItemGenerationId)
  ) return false;
  if (proposal.origin !== 'agent' && proposal.origin !== 'swarm') return false;
  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') return false;
  if (!proposal.diff || !proposal.repo || !proposal.runId || !proposal.trajectoryId) return false;
  if (proposal.trajectoryId !== `run:${proposal.runId}`) return false;
  if (proposal.runEventSummary?.runId !== proposal.runId) return false;
  if (proposal.runEventSummary.status !== 'done' || proposal.isPartial === true) return false;
  const itemMs = Date.parse(item.ts);
  const proposalMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(itemMs) || !Number.isFinite(proposalMs)) return false;
  try {
    return resolve(proposal.repo) === resolve(item.repo);
  } catch {
    return false;
  }
}
