import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Proposal, WorkItem } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { pruneQueuedSelfHealItems, queueSelfHealItem, queueSelfHealItemDetailed } from './self-heal.js';
import {
  isActionableSelfHealItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from './self-heal-trust.js';
import type { DispatchProductionEvent } from './dispatch-production-ledger.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  generatedRepairGenerationId,
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

const MAX_TITLE = 140;
const MAX_REASON = 260;
const DISPATCH_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DISPATCH_CAPTURE_MAX_QUEUED = 5;
const DISPATCH_NO_DIFF_MAX_QUEUED = 5;
const MAX_PARENT_CONTEXT = 1_600;

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
  dispatchRepairPruned?: number;
  dispatchRepairPruneFailed?: number;
  dispatchRepairLifecycleUnavailable?: number;
  /** Internal selection guard; never persisted by producer-maintenance summaries. */
  blockedItemKeys?: string[];
  handoffObservations?: number;
  handoffInvalidRows?: number;
  handoffConflictingIds?: number;
  handoffSourceState?: 'missing' | 'healthy' | 'degraded';
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

function repairId(repo: string, proposalId: string): string {
  const hash = createHash('sha1')
    .update(`${resolve(repo)}\0${proposalId}\0proposal-repair`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:proposal-repair:${hash}`;
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

function resolvedResliceDetail(parent: WorkItem): string {
  const title = bounded(parent.title, MAX_TITLE) || parent.id;
  const detail = bounded(parent.detail, MAX_PARENT_CONTEXT);
  return (
    `Diagnostic reslice: retry a currently actionable work item after an earlier dispatch produced no file changes.\n` +
    `Original work item: ${parent.id}\n` +
    `Current objective: ${title}\n` +
    (detail && detail !== title ? `Current context: ${detail}\n` : '') +
    `Original source: ${parent.source}\n` +
    `Dispatch outcome: empty-diff\n` +
    `Action: reslice by inspecting the current target and making the smallest complete edit if it remains actionable. ` +
    `If the current repository already satisfies the objective or a safe edit requires a product decision, report that evidence without forcing a cosmetic change.`
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
    resolved += 1;
    dispatchable.push({
      ...item,
      title: bounded(parent.title, MAX_TITLE) || parent.id,
      detail: resolvedResliceDetail(parent),
      repairParentItemId: parent.id,
      repairParentSource: item.repairParentSource ?? parent.source,
    });
  }

  return { dispatchable, quarantined, resolved, missing };
}

function proposalNeedsRepair(proposal: Proposal): boolean {
  if (proposal.status !== 'pending') return false;
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
  if (event.source !== 'self') return false;
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

export function proposalRepairWorkItem(proposal: Proposal, now = new Date()): WorkItem | null {
  if (!proposalNeedsRepair(proposal) || !proposal.repo) return null;

  const title = bounded(proposal.title, MAX_TITLE) || proposal.id;
  const reason = repairReason(proposal);
  const value = 5;
  const effort = 1;
  const repairKind = proposal.isPartial === true ? 'partial' : 'verify';

  return {
    id: repairId(proposal.repo, proposal.id),
    repo: proposal.repo,
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
    tags: ['self-heal', 'proposal-repair', repairKind, 'verify', 'high-priority'],
    ts: Number.isFinite(Date.parse(proposal.createdAt)) ? new Date(proposal.createdAt).toISOString() : now.toISOString(),
  };
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
      `Dispatch capture repair: a self-improvement dispatch produced repairable work but no proposal.\n` +
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
      `Action: reslice the work into a smaller concrete edit and name the target file or subsystem before editing. ` +
      `If the task remains actionable, produce the smallest complete change and run merge-grade verification. ` +
      `If it is already satisfied or not safely actionable, report that evidence without forcing an edit. ` +
      `Do not copy raw prompts, stdout, stderr, env, file contents, or prior diff output.`,
    value,
    effort,
    score: value / effort,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority'],
    ts: new Date(eventMs).toISOString(),
    ...(event.repairHandoffId
      ? { repairHandoffId: event.repairHandoffId }
      : derivedHandoff ? { repairHandoffId: derivedHandoff.eventId } : {}),
    ...(event.repairGenerationId
      ? { repairGenerationId: event.repairGenerationId }
      : derivedHandoff ? { repairGenerationId: derivedHandoff.generationId } : {}),
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
  try {
    pending = proposals ?? listProposals({ status: 'pending' });
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
  }

  const terminalLifecycleEnabled = opts?.terminalLifecycleEnabled !== false;
  const terminalByKey = new Map<string, 'retired' | 'exhausted'>();
  const blockedItemKeys = new Set<string>();
  const lifecycleUnavailableKeys = new Set<string>();
  const observeLifecycle = (
    item: WorkItem,
  ): 'not-generated' | 'active' | 'terminal' | 'unavailable' => {
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
    return 'terminal';
  };
  const prune = terminalLifecycleEnabled
    ? pruneQueuedSelfHealItems((item) => {
        if (isTrustedDiagnosticResliceItem(item) && generatedRepairGenerationId(item) === null) return true;
        return observeLifecycle(item) === 'terminal';
      })
    : { scanned: 0, removed: 0, failed: false };
  result.dispatchRepairPruned = prune.removed;
  result.dispatchRepairPruneFailed = prune.failed ? 1 : 0;

  if (terminalLifecycleEnabled) for (const proposal of pending) {
    const item = proposalRepairWorkItem(proposal, now);
    if (!item) continue;
    const lifecycle = observeLifecycle(item);
    if (lifecycle === 'terminal' || lifecycle === 'unavailable') continue;
    result.eligible++;
    result.proposalEligible!++;
    if (queueSelfHealItem(item)) {
      result.queued++;
      result.proposalQueued!++;
    } else {
      result.failed++;
      result.proposalFailed!++;
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
    if (lifecycle === 'terminal' || lifecycle === 'unavailable') continue;
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
    if (lifecycle === 'terminal' || lifecycle === 'unavailable') continue;
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
  const itemGenerationId = generatedRepairGenerationId(item);
  if (!itemGenerationId || proposal.workItemGenerationId !== itemGenerationId) return false;
  if (proposal.origin !== 'agent' && proposal.origin !== 'swarm') return false;
  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') return false;
  if (!proposal.diff || !proposal.repo || !proposal.runId || !proposal.trajectoryId) return false;
  if (proposal.trajectoryId !== `run:${proposal.runId}`) return false;
  if (proposal.runEventSummary?.runId !== proposal.runId) return false;
  if (proposal.runEventSummary.status !== 'done' || proposal.isPartial === true) return false;
  const itemMs = Date.parse(item.ts);
  const proposalMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(itemMs) || !Number.isFinite(proposalMs) || proposalMs < itemMs) return false;
  try {
    return resolve(proposal.repo) === resolve(item.repo);
  } catch {
    return false;
  }
}
