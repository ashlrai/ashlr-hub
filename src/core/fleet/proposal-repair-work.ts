import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { DecisionEntry, Proposal, RepairTreatment, WorkItem } from '../types.js';
import { listProposals, loadProposal } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { pruneQueuedSelfHealItems, queueSelfHealItem, queueSelfHealItemDetailed } from './self-heal.js';
import {
  REJECTED_CAPTURE_REPAIR_MAX_AGE_MS,
  isActionableSelfHealItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from './self-heal-trust.js';
import type { DispatchProductionEvent } from './dispatch-production-ledger.js';
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
  /** Internal selection guard; never persisted by producer-maintenance summaries. */
  blockedItemKeys?: string[];
  handoffObservations?: number;
  handoffInvalidRows?: number;
  handoffConflictingIds?: number;
  handoffSourceState?: 'missing' | 'healthy' | 'degraded';
  handoffAuthorityDigest?: string;
  handoffCompacted?: number;
  handoffCompactionUnavailable?: number;
  proposalInboxAvailable?: boolean;
}

export interface ProposalRepairWorkOptions {
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
    if (item.tags.includes('proposal-repair')) continue;
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
    if (!parent) {
      missing += 1;
      quarantined.push({ itemId: item.id, reason: 'parent-missing' });
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
  return proposal.isPartial === true || proposal.verifyResult?.passed === false;
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
  if (/\b(?:proposal-repair|dispatch-capture-repair|proposal-repair-capture)\b/i.test(`${event.itemId}\n${event.title}`)) {
    return false;
  }
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
  if (/\b(?:proposal-repair|dispatch-capture-repair|proposal-repair-capture|proposal-repair-nodiff|diagnostic-reslice|no-diff-reslice)\b/i.test(`${event.itemId}\n${event.title}`)) {
    return false;
  }
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
  };
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
    id: captureRepairId(repo, itemId),
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
    id: noDiffResliceId(repo, itemId),
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

function readRecentDispatchEvents(_now: Date, opts?: ProposalRepairWorkOptions): DispatchProductionEvent[] {
  if (opts?.dispatchEvents) return opts.dispatchEvents;
  if (opts?.includeDispatchCaptureFailures === false && opts?.includeDispatchNoDiffReslices === false) return [];
  try {
    const handoffs = readRepairHandoffs().observations.map(dispatchEventFromRepairHandoff);
    return handoffs;
  } catch {
    return [];
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

export function queueProposalRepairWorkForPendingProposals(
  proposals?: Proposal[],
  now = new Date(),
  opts?: ProposalRepairWorkOptions,
): ProposalRepairWorkResult {
  const handoffs = proposals === undefined && !opts?.dispatchEvents ? readRepairHandoffs() : undefined;
  let pending: Proposal[];
  let captureDecisionProof: CaptureDecisionProof;
  try {
    captureDecisionProof = readCaptureDecisionProof(now);
    const available = proposals ?? listProposals();
    const rejectedCapture = available
      .filter((proposal) => isRecentRejectedCaptureArtifact(proposal, now, captureDecisionProof))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, REJECTED_CAPTURE_MAX_SCANNED);
    pending = [
      ...available.filter((proposal) => proposal.status === 'pending'),
      ...rejectedCapture,
    ];
  } catch {
    return {
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalInboxAvailable: false,
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
    try {
      lifecycleProposals = opts?.lifecycleProposals ?? (proposals === undefined ? listProposals() : proposals);
    } catch {
      lifecycleProposals = [];
    }
  }
  const includeCaptureRepairs = opts?.includeDispatchCaptureFailures !== false;
  const includeNoDiffReslices = opts?.includeDispatchNoDiffReslices !== false;
  const dispatchEvents = (includeCaptureRepairs || includeNoDiffReslices
    ? (proposals === undefined ? readRecentDispatchEvents(now, opts) : (opts?.dispatchEvents ?? []))
    : [])
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
    blockedItemKeys: [],
    proposalInboxAvailable: true,
  };
  if (handoffs) {
    result.handoffObservations = handoffs.observations.length;
    result.handoffInvalidRows = handoffs.invalidRows;
    result.handoffConflictingIds = handoffs.conflictingIds;
    result.handoffSourceState = handoffs.sourceState;
    result.handoffAuthorityDigest = handoffs.authorityDigest;
  }

  const terminalLifecycleEnabled = opts?.terminalLifecycleEnabled !== false;
  const terminalByKey = new Map<string, 'retired' | 'exhausted' | 'quarantined'>();
  const blockedItemKeys = new Set<string>();
  const lifecycleUnavailableKeys = new Set<string>();
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
    if (durableProposal?.trajectoryId) {
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
  const prune = terminalLifecycleEnabled
      ? pruneQueuedSelfHealItems((item) => {
        if (
          item.tags.includes('rejected-capture-recovery') &&
          !isActionableSelfHealItem(item, {
            nowMs: now.getTime(),
            maxAgeMs: REJECTED_CAPTURE_REPAIR_MAX_AGE_MS,
          })
        ) return true;
        if (isTrustedDiagnosticResliceItem(item) && generatedRepairGenerationId(item) === null) return true;
        const lifecycle = observeLifecycle(item);
        return lifecycle === 'terminal' || lifecycle === 'quarantined';
      })
    : { scanned: 0, removed: 0, failed: false };
  result.dispatchRepairPruned = prune.removed;
  result.dispatchRepairPruneFailed = prune.failed ? 1 : 0;

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
      const item = proposalRepairWorkItem(current, now, currentProof);
      if (!item) continue;
      const lifecycle = observeLifecycle(item);
      if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
      result.eligible++;
      result.proposalEligible!++;
      if (queueSelfHealItem(item)) {
        result.queued++;
        result.proposalQueued!++;
      } else {
        result.failed++;
        result.proposalFailed!++;
      }
    } finally {
      if (mutationLock) releaseProposalMutationLock(mutationLock);
    }
  }
  const seenCaptureIds = new Set<string>();
  let captureMutations = 0;
  if (terminalLifecycleEnabled && includeCaptureRepairs) for (const event of dispatchEvents) {
    if (captureMutations >= maxCaptureQueued) break;
    const item = captureGateRepairWorkItem(event, now);
    if (!item) continue;
    if (seenCaptureIds.has(item.id)) continue;
    seenCaptureIds.add(item.id);
    const lifecycle = observeLifecycle(item);
    if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
    result.eligible++;
    result.dispatchCaptureEligible!++;
    const queued = queueSelfHealItemDetailed(item);
    if (queued.ok) {
      result.queued++;
      result.dispatchCaptureQueued!++;
      if (queued.changed) captureMutations++;
    } else {
      result.failed++;
      result.dispatchCaptureFailed!++;
      break;
    }
  }
  const seenNoDiffIds = new Set<string>();
  let noDiffMutations = 0;
  if (terminalLifecycleEnabled && includeNoDiffReslices) for (const event of dispatchEvents) {
    if (noDiffMutations >= maxNoDiffQueued) break;
    const item = noDiffResliceWorkItem(event, now);
    if (!item) continue;
    if (seenNoDiffIds.has(item.id)) continue;
    seenNoDiffIds.add(item.id);
    const lifecycle = observeLifecycle(item);
    if (lifecycle === 'terminal' || lifecycle === 'quarantined' || lifecycle === 'unavailable') continue;
    result.eligible++;
    result.dispatchNoDiffEligible!++;
    const queued = queueSelfHealItemDetailed(item);
    if (queued.ok) {
      result.queued++;
      result.dispatchNoDiffQueued!++;
      if (queued.changed) noDiffMutations++;
    } else {
      result.failed++;
      result.dispatchNoDiffFailed!++;
      break;
    }
  }

  result.dispatchRepairRetired = [...terminalByKey.values()].filter((value) => value === 'retired').length;
  result.dispatchRepairExhausted = [...terminalByKey.values()].filter((value) => value === 'exhausted').length;
  result.dispatchRepairQuarantined = [...terminalByKey.values()].filter((value) => value === 'quarantined').length;
  result.dispatchRepairLifecycleUnavailable = lifecycleUnavailableKeys.size;
  result.blockedItemKeys = [...blockedItemKeys];
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
