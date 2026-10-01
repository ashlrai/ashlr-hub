/** Inspection-only case projection. All source IO stays in the bounded worker. */
import { createHash } from 'node:crypto';
import { readLedger } from '../authority/ledger.js';
import { STANDING_GRANT_PATTERNS } from '../authority/types.js';
import type { LedgerReadResult } from '../authority/types.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { authenticatedRealizedMergeOf, canonicalRealizedMergeIdentity } from '../inbox/realized-merge.js';
import { hashDiff } from '../foundry/provenance.js';
import { loadRun } from '../run/orchestrator.js';
import { repoIdentityOfPath } from './repo-identity.js';
import { readDispatchProductionEventsDetailed } from './dispatch-production-ledger.js';
import { buildExecutionFeedback, lookupExecutionFeedback } from './execution-feedback.js';
import type { ExecutionFeedbackSnapshot, ExecutionProposalRead } from './execution-feedback.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import type { ExecutionFeedbackCaseDetail, ExecutionCaseTimelineEntry } from './execution-feedback-case-types.js';

interface AuthenticatedMerge {
  source: 'github-host' | 'local-default-branch';
  at: string;
  href?: string;
}
export interface ExecutionCaseSources {
  snapshot: ExecutionFeedbackSnapshot;
  proposals: ExecutionProposalRead;
  /** Raw metadata is projected explicitly, never spread into the response. */
  proposalRecords: readonly unknown[];
  ledger: LedgerReadResult | null;
  repoIdentities: ReadonlyMap<string, string | null>;
  /** Reader-owned, persistence-authenticated evidence, not caller proposal shapes. */
  authenticatedMerges: ReadonlyMap<string, AuthenticatedMerge>;
  readableRuns: ReadonlySet<string>;
  nowMs: number;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function instant(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= nowMs && new Date(ms).toISOString() === value ? value : null;
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function repo(value: unknown): value is string {
  return typeof value === 'string' && STANDING_GRANT_PATTERNS.nameWithOwner.test(value) && !/^\.{1,2}$/u.test(value.split('/')[1]!);
}
/** Never pass stored free-form URLs through to a browser. */
export function executionCasePrHref(nameWithOwner: unknown, number: unknown): string | null {
  if (!repo(nameWithOwner) || !Number.isSafeInteger(number) || (number as number) < 1) return null;
  return `https://github.com/${nameWithOwner.toLowerCase()}/pull/${number}`;
}
function authenticatedHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/u.exec(value);
  return match ? executionCasePrHref(match[1], Number(match[2])) : null;
}

/** PURE metadata projection. Shape-only realizedMerge never earns a merge row. */
export function buildExecutionFeedbackCase(caseId: string, sources: ExecutionCaseSources): ExecutionFeedbackCaseDetail | null {
  const correlation = lookupExecutionFeedback(sources.snapshot, caseId);
  const summary = sources.snapshot.view.cases.find((row) => row.caseId === caseId);
  if (!correlation || !summary || !/^[a-f0-9]{64}$/u.test(caseId)) return null;
  const timeline: ExecutionCaseTimelineEntry[] = [{ stage: 'produced', at: summary.endedAt,
    result: 'recorded', basis: 'dispatch-final',
    ...(isSafeExecutionIdentity(correlation.runId) && sources.readableRuns.has(correlation.runId)
      ? { href: `/work/runs/${encodeURIComponent(correlation.runId)}` } : {}) }];
  let invalidRecords = 0; let conflictingRecords = 0;
  const proposals = new Map<string, Record<string, unknown>>();
  const conflicted = new Set<string>();
  for (const raw of sources.proposalRecords) {
    const p = record(raw);
    if (!p || !isSafeExecutionIdentity(p.id) || !correlation.proposalIds.includes(p.id)) continue;
    // An ID alone must not borrow a different attempt's proposal.
    if (p.runId !== correlation.runId || p.trajectoryId !== correlation.trajectoryId) { invalidRecords++; conflicted.add(p.id); continue; }
    const prior = proposals.get(p.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(p)) { conflictingRecords++; conflicted.add(p.id); }
    else proposals.set(p.id, p);
  }
  for (const id of conflicted) proposals.delete(id);
  for (const [id, p] of proposals) {
    const verify = record(p.verifyResult);
    if (verify && typeof verify.passed === 'boolean') {
      const at = instant(verify.verifiedAt, sources.nowMs);
      const bound = p.isPartial !== true && typeof p.diffHash === 'string' && /^[a-f0-9]{64}$/u.test(p.diffHash)
        && typeof p.diff === 'string' && hashDiff(p.diff) === p.diffHash
        && verify.diffHash === p.diffHash && sha(verify.baseHead) && at !== null;
      timeline.push({ stage: 'verified', at, result: bound ? verify.passed ? 'passed' : 'failed' : 'unbound',
        basis: 'proposal-verification', href: `/inbox/${encodeURIComponent(id)}` });
    }
    const merged = sources.authenticatedMerges.get(id);
    const at = merged && instant(merged.at, sources.nowMs);
    if (merged && at) {
      const href = merged.source === 'github-host' ? authenticatedHref(merged.href) : null;
      if (merged.source === 'github-host' && !href) { invalidRecords++; continue; }
      timeline.push({ stage: 'merged', at, result: merged.source === 'github-host' ? 'host-merged' : 'local-merged',
        basis: merged.source === 'github-host' ? 'authenticated-host' : 'authenticated-local', ...(href ? { href } : {}) });
    }
  }
  const ledger = sources.ledger;
  const ledgerState: ExecutionFeedbackCaseDetail['coverage']['ledger'] = ledger === null ? 'unavailable' : ledger.chain === 'broken' ? 'broken' : ledger.chain === 'empty' ? 'missing' : 'healthy';
  // Even valid-looking rows from a broken hash chain cannot prove a landing.
  if (ledger?.chain === 'ok') {
    const rows = ledger.entries;
    const landings = new Map<string, { proposalId: string; repo: string; headSha: string; mergeSha: string; prNumber: number; at: string }>();
    const badLandings = new Set<string>();
    const prs = new Map<string, { repo: string; headSha: string; number: number; at: string }>();
    const badPrs = new Set<string>();
    for (const entry of rows) {
      if (entry.kind !== 'pr:opened' && entry.kind !== 'merge:landed') continue;
      const d = record(entry.data);
      if (!d || typeof d.proposalId !== 'string' || !proposals.has(d.proposalId)) continue;
      const expectedRepo = sources.repoIdentities.get(d.proposalId);
      const expectedHead = record(proposals.get(d.proposalId)?.remoteHandoff)?.expectedHeadOid;
      const at = instant(entry.kind === 'pr:opened' ? d.at : d.landedAt, sources.nowMs);
      const number = entry.kind === 'pr:opened' ? d.number : d.prNumber;
      const href = executionCasePrHref(d.repo, number);
      if (!href || !expectedRepo || !repo(expectedRepo) || String(d.repo).toLowerCase() !== expectedRepo.toLowerCase()
        || !sha(d.headSha) || expectedHead !== undefined && expectedHead !== d.headSha || !at || d.v !== 1) { invalidRecords++; continue; }
      if (entry.kind === 'pr:opened') {
        if (d.kind !== 'change') { invalidRecords++; continue; }
        const current = { repo: String(d.repo).toLowerCase(), headSha: d.headSha, number: number as number, at };
        const prior = prs.get(d.proposalId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(current)) { badPrs.add(d.proposalId); conflictingRecords++; }
        else prs.set(d.proposalId, current);
      } else {
        if (d.kind !== 'merge' || typeof d.id !== 'string' || !d.id || !sha(d.mergeSha) || d.revertsLandingId !== null) { invalidRecords++; continue; }
        const current = { proposalId: d.proposalId, repo: String(d.repo).toLowerCase(), headSha: d.headSha,
          mergeSha: d.mergeSha, prNumber: number as number, at };
        const prior = landings.get(d.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(current)) { badLandings.add(d.id); conflictingRecords++; }
        else landings.set(d.id, current);
      }
    }
    for (const id of badPrs) prs.delete(id);
    for (const pr of prs.values()) {
      timeline.push({ stage: 'pr-opened', at: pr.at, result: 'recorded', basis: 'authority-ledger', href: executionCasePrHref(pr.repo, pr.number)! });
    }
    for (const id of badLandings) landings.delete(id);
    for (const [id, landing] of landings) {
      const pr = prs.get(landing.proposalId);
      if (badPrs.has(landing.proposalId) || pr && (pr.repo !== landing.repo || pr.headSha !== landing.headSha || pr.number !== landing.prNumber)) {
        invalidRecords++; landings.delete(id); continue;
      }
      timeline.push({ stage: 'merged', at: landing.at, result: 'host-merged', basis: 'authority-ledger',
        href: executionCasePrHref(landing.repo, landing.prNumber)! });
    }
    for (const entry of rows) {
      const d = record(entry.data);
      if (!d || entry.kind !== 'post-merge:result' && entry.kind !== 'revert:landed') continue;
      const landingId = entry.kind === 'post-merge:result' ? d.landingId : d.revertsLandingId;
      const landing = typeof landingId === 'string' ? landings.get(landingId) : undefined;
      if (!landing) continue;
      const at = instant(entry.kind === 'post-merge:result' ? d.checkedAt : d.landedAt, sources.nowMs);
      if (d.v !== 1 || String(d.repo).toLowerCase() !== landing.repo || !at || at < landing.at) { invalidRecords++; continue; }
      if (entry.kind === 'post-merge:result') {
        if (d.mergeSha !== landing.mergeSha || !['green', 'red', 'none', 'unknown'].includes(String(d.ci))
          || !['pass', 'fail', 'not-run'].includes(String(d.suite)) || !['green', 'red'].includes(String(d.verdict))) { invalidRecords++; continue; }
        timeline.push({ stage: 'post-merge', at, result: d.verdict as 'green' | 'red', basis: 'authority-ledger',
          ci: d.ci as 'green' | 'red' | 'none' | 'unknown', suite: d.suite as 'pass' | 'fail' | 'not-run' });
      } else {
        const href = executionCasePrHref(d.repo, d.prNumber);
        if (d.kind !== 'revert' || !href || !sha(d.headSha) || !sha(d.mergeSha) || d.proposalId !== null) { invalidRecords++; continue; }
        timeline.push({ stage: 'reverted', at, result: 'reverted', basis: 'authority-ledger', href });
      }
    }
  }
  // Identical replays disappear; distinct checks/landings retain separate evidence.
  const unique = [...new Map(timeline.map((row) => [JSON.stringify(row), row])).values()];
  unique.sort((a, b) => a.at === null ? b.at === null ? a.stage.localeCompare(b.stage) : 1
    : b.at === null ? -1 : a.at.localeCompare(b.at) || a.stage.localeCompare(b.stage));
  const detail = { schemaVersion: 1 as const, caseId, outcome: summary.outcome, endedAt: summary.endedAt,
    coverage: { dispatch: sources.snapshot.view.sourceState,
      proposals: sources.proposals.complete ? sources.proposals.sourceState : 'degraded' as const,
      ledger: ledgerState, invalidRecords, conflictingRecords }, timeline: unique, shipping: 'not-recorded' as const };
  return { ...detail, digest: hash(detail) };
}

interface CachedSources { at: number; sources: ExecutionCaseSources }
let cached: CachedSources | null = null;
let pending: Promise<ExecutionCaseSources> | null = null;
export function _resetExecutionFeedbackCaseCacheForTest(): void { cached = null; pending = null; }
async function sourcesAt(nowMs: number): Promise<ExecutionCaseSources> {
  if (cached && nowMs >= cached.at && nowMs - cached.at < 30_000) return cached.sources;
  if (pending) return pending;
  pending = (async () => {
    const proposals = listProposalsDetailed({ maxFiles: 2_000, maxBytes: 16 * 1024 * 1024 });
    const snapshot = buildExecutionFeedback(readDispatchProductionEventsDetailed({ sinceMs: nowMs - 7 * 86_400_000,
      inspectionOnly: true, canonicalTimestamps: true }), { sinceMs: nowMs - 7 * 86_400_000, nowMs, proposals });
    let ledger: LedgerReadResult | null = null;
    // Existing asynchronous chain scan is bounded by the shared worker's time/heap fence.
    // No output tail limit: dropping older selected rows cannot prove their absence.
    try { ledger = await readLedger({ kinds: ['pr:opened', 'merge:landed', 'post-merge:result', 'revert:landed'] }); } catch { /* explicit unavailable */ }
    const repoIdentities = new Map<string, string | null>();
    const authenticatedMerges = new Map<string, AuthenticatedMerge>();
    const readableRuns = new Set<string>();
    const joined = new Set([...snapshot.correlations.values()].flatMap((item) => item.proposalIds));
    for (const p of proposals.proposals) {
      if (!joined.has(p.id)) continue;
      repoIdentities.set(p.id, typeof p.repo === 'string' ? repoIdentityOfPath(p.repo) : null);
      const evidence = authenticatedRealizedMergeOf(p);
      const identity = evidence && canonicalRealizedMergeIdentity(p);
      if (evidence && identity) authenticatedMerges.set(p.id, { source: identity.source,
        at: evidence.source === 'github-host' ? evidence.reconciliation.observedAt : evidence.observedAt,
        ...(identity.source === 'github-host' ? { href: identity.prUrl } : {}) });
    }
    const sources: ExecutionCaseSources = { snapshot, proposals, proposalRecords: proposals.proposals, ledger,
      repoIdentities, authenticatedMerges, readableRuns, nowMs };
    cached = { at: nowMs, sources };
    return sources;
  })().finally(() => { pending = null; });
  return pending;
}
/** Fixed projection: caller cannot select stores, repositories, URLs or commands. */
export async function readExecutionFeedbackCase(caseId: string): Promise<ExecutionFeedbackCaseDetail | null> {
  if (!/^[a-f0-9]{64}$/u.test(caseId)) return null;
  const sources = await sourcesAt(Date.now());
  const correlation = lookupExecutionFeedback(sources.snapshot, caseId);
  const readableRuns = new Set<string>();
  if (correlation && isSafeExecutionIdentity(correlation.runId) && loadRun(correlation.runId)?.id === correlation.runId) readableRuns.add(correlation.runId);
  return buildExecutionFeedbackCase(caseId, { ...sources, readableRuns });
}
