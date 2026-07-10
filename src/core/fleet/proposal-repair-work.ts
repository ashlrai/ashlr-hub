import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Proposal, WorkItem } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { queueSelfHealItem } from './self-heal.js';
import { isActionableSelfHealItem } from './self-heal-trust.js';
import {
  readDispatchProductionEvents,
  type DispatchProductionEvent,
} from './dispatch-production-ledger.js';
import { listEnrolled } from '../sandbox/policy.js';

const MAX_TITLE = 140;
const MAX_REASON = 260;
const DISPATCH_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DISPATCH_CAPTURE_LIMIT = 100;
const DISPATCH_CAPTURE_MAX_QUEUED = 5;
const DISPATCH_NO_DIFF_MAX_QUEUED = 5;

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
}

export interface ProposalRepairWorkOptions {
  dispatchEvents?: DispatchProductionEvent[];
  includeDispatchCaptureFailures?: boolean;
  includeDispatchNoDiffReslices?: boolean;
  dispatchWindowMs?: number;
  maxDispatchCaptureQueued?: number;
  maxDispatchNoDiffQueued?: number;
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
  return /\b(?:capture|completeness|gate)\b/i.test(`${event.reason ?? ''}\n${event.routeReason ?? ''}`);
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
    ts: now.toISOString(),
  };
}

export function captureGateRepairWorkItem(
  event: DispatchProductionEvent,
  now = new Date(),
): WorkItem | null {
  if (!isRepairableCaptureFailure(event)) return null;
  const eventMs = Date.parse(event.ts);
  const nowMs = now.getTime();
  if (!Number.isFinite(eventMs) || eventMs > nowMs || nowMs - eventMs > DISPATCH_CAPTURE_WINDOW_MS) {
    return null;
  }
  const repo = canonicalEnrolledExistingRepo(event.repo);
  if (!repo) return null;

  const reason = boundedRepairReason(event.reason ?? event.routeReason ?? event.outcome, MAX_REASON) || event.outcome;
  const itemId = bounded(event.itemId, 120) || 'unknown';
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
  };
  return isActionableSelfHealItem(item, { nowMs }) ? item : null;
}

export function noDiffResliceWorkItem(
  event: DispatchProductionEvent,
  now = new Date(),
): WorkItem | null {
  if (!isDiagnosticNoDiffEvent(event)) return null;
  const eventMs = Date.parse(event.ts);
  const nowMs = now.getTime();
  if (!Number.isFinite(eventMs) || eventMs > nowMs || nowMs - eventMs > DISPATCH_CAPTURE_WINDOW_MS) {
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
      `Action: reslice the work into a smaller concrete edit, name the target file or subsystem before editing, produce a fresh complete file diff, and run merge-grade verification.\n` +
      `Constraint: the next attempt must change repository files or explicitly fail the capture gate; do not return explanation-only work. Do not copy raw prompts, stdout, stderr, env, file contents, or prior diff output.`,
    value,
    effort,
    score: value / effort,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority'],
    ts: new Date(eventMs).toISOString(),
  };
  return isActionableSelfHealItem(item, { nowMs }) ? item : null;
}

function readRecentDispatchEvents(now: Date, opts?: ProposalRepairWorkOptions): DispatchProductionEvent[] {
  if (opts?.dispatchEvents) return opts.dispatchEvents;
  if (opts?.includeDispatchCaptureFailures === false && opts?.includeDispatchNoDiffReslices === false) return [];
  const windowMs = opts?.dispatchWindowMs && opts.dispatchWindowMs > 0
    ? opts.dispatchWindowMs
    : DISPATCH_CAPTURE_WINDOW_MS;
  try {
    return readDispatchProductionEvents({
      sinceMs: now.getTime() - windowMs,
      limit: DISPATCH_CAPTURE_LIMIT,
      maxFiles: Math.max(1, Math.ceil(windowMs / (24 * 60 * 60 * 1000)) + 1),
    });
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
  let pending: Proposal[];
  try {
    pending = proposals ?? listProposals({ status: 'pending' });
  } catch {
    return {
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
    };
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
  };

  for (const proposal of pending) {
    const item = proposalRepairWorkItem(proposal, now);
    if (!item) continue;
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
  if (includeCaptureRepairs) for (const event of dispatchEvents) {
    if ((result.dispatchCaptureQueued ?? 0) >= maxCaptureQueued) break;
    const item = captureGateRepairWorkItem(event, now);
    if (!item) continue;
    if (seenCaptureIds.has(item.id)) continue;
    seenCaptureIds.add(item.id);
    result.eligible++;
    result.dispatchCaptureEligible!++;
    if (queueSelfHealItem(item)) {
      result.queued++;
      result.dispatchCaptureQueued!++;
    } else {
      result.failed++;
      result.dispatchCaptureFailed!++;
    }
  }
  const seenNoDiffIds = new Set<string>();
  if (includeNoDiffReslices) for (const event of dispatchEvents) {
    if ((result.dispatchNoDiffQueued ?? 0) >= maxNoDiffQueued) break;
    const item = noDiffResliceWorkItem(event, now);
    if (!item) continue;
    if (seenNoDiffIds.has(item.id)) continue;
    seenNoDiffIds.add(item.id);
    result.eligible++;
    result.dispatchNoDiffEligible!++;
    if (queueSelfHealItem(item)) {
      result.queued++;
      result.dispatchNoDiffQueued!++;
    } else {
      result.failed++;
      result.dispatchNoDiffFailed!++;
    }
  }

  return result;
}
