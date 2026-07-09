/**
 * agent-action-ledger.ts — append-only metadata stream for autonomous action traces.
 *
 * This is Ashlr's software-level global workspace substrate: compact, scrubbed
 * events that describe what the fleet attended to, tried, skipped, produced,
 * or blocked on. It is analytics/learning input only. It never grants outward
 * authority and never throws.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  RouteSnapshot,
  RunEventSummary,
  WorkSource,
} from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { causalMetadata } from '../learning/causal.js';
import { classifyProductionAttemptForLearning } from '../learning/attempt-shape.js';
import { listEnrolled } from '../sandbox/policy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type AgentActionActor =
  | 'daemon'
  | 'agent'
  | 'judge'
  | 'verifier'
  | 'merge'
  | 'fleet'
  | 'system';

export type AgentActionKind =
  | 'tick'
  | 'selection'
  | 'route'
  | 'dispatch'
  | 'proposal'
  | 'verification'
  | 'judge'
  | 'merge'
  | 'guard'
  | 'maintenance'
  | 'reflection';

export type AgentActionOutcome =
  | 'started'
  | 'ok'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'proposal-created'
  | 'no-proposal'
  | 'verified'
  | 'judged'
  | 'merged'
  | 'rejected'
  | 'unknown';

export interface AgentActionEvent {
  schemaVersion: 1;
  ts: string;
  machineId?: string;
  actor: AgentActionActor;
  kind: AgentActionKind;
  outcome: AgentActionOutcome;
  action: string;
  summary: string;
  repo?: string;
  itemId?: string;
  source?: WorkSource;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  reason?: string;
  durationMs?: number;
  spentUsd?: number;
  tags?: string[];
  counts?: Record<string, number>;
}

const AGENT_ACTION_ACTORS = new Set<AgentActionActor>([
  'daemon',
  'agent',
  'judge',
  'verifier',
  'merge',
  'fleet',
  'system',
]);

const AGENT_ACTION_KINDS = new Set<AgentActionKind>([
  'tick',
  'selection',
  'route',
  'dispatch',
  'proposal',
  'verification',
  'judge',
  'merge',
  'guard',
  'maintenance',
  'reflection',
]);

const AGENT_ACTION_OUTCOMES = new Set<AgentActionOutcome>([
  'started',
  'ok',
  'skipped',
  'blocked',
  'failed',
  'proposal-created',
  'no-proposal',
  'verified',
  'judged',
  'merged',
  'rejected',
  'unknown',
]);

const ENGINE_IDS = new Set<EngineId>([
  'builtin',
  'local-coder',
  'ashlrcode',
  'aw',
  'claude',
  'codex',
  'hermes',
  'kimi',
  'nim',
  'opencode',
  'grok',
]);

const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

const WORK_SOURCES = new Set<WorkSource>([
  'issue',
  'todo',
  'test',
  'dep',
  'doc',
  'security',
  'plugin',
  'self',
  'lint',
  'goal',
  'hygiene',
  'invent',
]);

export interface AgentActionCount {
  key: string;
  count: number;
}

export interface AgentWorkspaceAttention {
  kind: 'repo' | 'backend' | 'action' | 'outcome' | 'source';
  topic: string;
  weight: number;
  detail: string;
}

export interface AgentWorkspaceRecentAction {
  ts: string;
  actor: AgentActionActor;
  kind: AgentActionKind;
  outcome: AgentActionOutcome;
  action: string;
  summary: string;
  repo?: string;
  itemId?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  backend?: EngineId | null;
  model?: string | null;
}

export interface AgentWorkspaceStatus {
  generatedAt: string;
  windowHours: number;
  eventCount: number;
  latestAt: string | null;
  activeMachines: string[];
  spendUsd: number;
  proposalEvents: number;
  noProposalEvents: number;
  diagnosticNoProposalEvents?: number;
  policySuppressedEvents?: number;
  diagnosticProposalRate?: number | null;
  diagnosticNoProposalRate?: number | null;
  repoEventCount: number;
  repoDistinctCount: number;
  topRepoCount: number;
  attention: AgentWorkspaceAttention[];
  byAction: AgentActionCount[];
  byOutcome: AgentActionCount[];
  byRepo: AgentActionCount[];
  byBackend: AgentActionCount[];
  entropy: {
    action: number;
    outcome: number;
    repo: number;
  };
  recentActions: AgentWorkspaceRecentAction[];
}

export type AgentActionRepoScope = 'enrolled-existing' | 'all';

export function agentActionsDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'agent-actions');
}

function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString().slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function boundedText(value: string, max: number): string {
  const stripped = scrubSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function sanitizeCounts(counts: unknown): Record<string, number> | undefined {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts).slice(0, 20)) {
    if (!Number.isFinite(value)) continue;
    out[boundedText(key, 64)] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
    .slice(0, 12)
    .map((tag) => boundedText(tag.trim(), 48));
  return out.length > 0 ? out : undefined;
}

function sanitizeEvent(event: AgentActionEvent): AgentActionEvent {
  const ts = eventTimestamp(event.ts);
  const tags = sanitizeTags(event.tags);
  const counts = sanitizeCounts(event.counts);
  const durationMs = finiteNumber(event.durationMs);
  const spentUsd = finiteNumber(event.spentUsd);
  const source = enumValue(event.source, WORK_SOURCES);
  const backend = event.backend === null ? null : enumValue(event.backend, ENGINE_IDS);
  const tier = event.tier === null ? null : enumValue(event.tier, ENGINE_TIERS);
  const machineId = boundedOptionalText(event.machineId, 120);
  const repo = boundedOptionalText(event.repo, 500);
  const itemId = boundedOptionalText(event.itemId, 240);
  const proposalId = boundedOptionalText(event.proposalId, 160);
  const runId = boundedOptionalText(event.runId, 160);
  const model = boundedOptionalText(event.model, 160);
  const reason = boundedOptionalText(event.reason, 240);
  const causal = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId: event.trajectoryId,
    routeSnapshot: event.routeSnapshot,
    runEventSummary: event.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ?? 'agent-action',
    labelBasis: event.labelBasis ?? (event.kind === 'dispatch' ? 'dispatch-outcome' : 'unknown'),
    routerPolicyVersion: event.routerPolicyVersion,
    learningEpoch: event.learningEpoch,
  });

  return {
    schemaVersion: 1,
    ts,
    actor: enumValue(event.actor, AGENT_ACTION_ACTORS) ?? 'system',
    kind: enumValue(event.kind, AGENT_ACTION_KINDS) ?? 'reflection',
    outcome: enumValue(event.outcome, AGENT_ACTION_OUTCOMES) ?? 'unknown',
    action: boundedText(event.action, 120),
    summary: boundedText(event.summary, 240),
    ...(machineId ? { machineId } : {}),
    ...(repo ? { repo } : {}),
    ...(itemId ? { itemId } : {}),
    ...(source ? { source } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    ...(backend !== undefined ? { backend } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(model ? { model } : {}),
    ...(reason ? { reason } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
    ...(spentUsd !== undefined ? { spentUsd: Math.max(0, spentUsd) } : {}),
    ...(tags ? { tags } : {}),
    ...(counts ? { counts } : {}),
  };
}

function isAgentActionEvent(value: unknown): value is AgentActionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['schemaVersion'] === 1 &&
    typeof obj['ts'] === 'string' &&
    typeof obj['actor'] === 'string' &&
    typeof obj['kind'] === 'string' &&
    typeof obj['outcome'] === 'string' &&
    typeof obj['action'] === 'string' &&
    typeof obj['summary'] === 'string'
  );
}

export function recordAgentAction(input: AgentActionEvent | AgentActionEvent[]): void {
  try {
    const events = Array.isArray(input) ? input : [input];
    if (events.length === 0) return;
    const dir = agentActionsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const event of events) {
      try {
        const record = sanitizeEvent(event);
        appendFileSync(join(dir, `${eventDateString(record.ts)}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
      } catch {
        // Skip only this record; telemetry must never disrupt the caller.
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
  }
}

export function readAgentActions(opts?: {
  sinceMs?: number;
  limit?: number;
  maxFiles?: number;
}): AgentActionEvent[] {
  try {
    const dir = agentActionsDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .reverse();
    const cap = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : Infinity;
    const maxFiles = opts?.maxFiles !== undefined && opts.maxFiles > 0 ? Math.floor(opts.maxFiles) : Infinity;
    const out: AgentActionEvent[] = [];
    let datedFilesRead = 0;
    let looseFilesRead = 0;

    for (const file of files) {
      if (out.length >= cap) break;
      if (opts?.sinceMs !== undefined && !fileMayContainSince(file, opts.sinceMs)) continue;
      const isDatedFile = DATE_LEDGER_FILE_RE.test(file);
      if (isDatedFile) {
        if (datedFilesRead >= maxFiles) continue;
        datedFilesRead++;
      } else {
        if (looseFilesRead >= 3) continue;
        looseFilesRead++;
      }
      let raw: string;
      try {
        raw = readFileSync(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n').reverse()) {
        if (out.length >= cap) break;
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isAgentActionEvent(parsed)) continue;
          const sanitized = sanitizeEvent(parsed);
          if (opts?.sinceMs !== undefined) {
            const eventMs = Date.parse(sanitized.ts);
            if (Number.isFinite(eventMs) && eventMs < opts.sinceMs) continue;
          }
          out.push(sanitized);
        } catch {
          // Malformed lines are skipped.
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function enrolledExistingRepos(repos?: readonly string[]): Set<string> {
  const candidates = repos ?? listEnrolled();
  const out = new Set<string>();
  for (const repo of candidates) {
    if (typeof repo !== 'string' || repo.trim() === '') continue;
    const abs = resolve(repo);
    if (existsSync(abs)) out.add(abs);
  }
  return out;
}

export function filterAgentActionsByRepoScope(
  events: readonly AgentActionEvent[],
  opts?: {
    repoScope?: AgentActionRepoScope;
    enrolledRepos?: readonly string[];
  },
): AgentActionEvent[] {
  if (opts?.repoScope === 'all') return [...events];
  const allowed = enrolledExistingRepos(opts?.enrolledRepos);
  return events.filter((event) => {
    if (!event.repo) return true;
    return allowed.has(resolve(event.repo));
  });
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function increment(map: Map<string, number>, key: string | null | undefined): void {
  const normalized = key && key.trim() ? key.trim() : 'unknown';
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, limit: number): AgentActionCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function entropy(counts: AgentActionCount[]): number {
  const total = counts.reduce((sum, count) => sum + count.count, 0);
  if (total <= 0) return 0;
  const value = counts.reduce((sum, count) => {
    const p = count.count / total;
    return p > 0 ? sum - p * Math.log2(p) : sum;
  }, 0);
  return Math.round(value * 1000) / 1000;
}

function recentAction(event: AgentActionEvent): AgentWorkspaceRecentAction {
  return {
    ts: event.ts,
    actor: event.actor,
    kind: event.kind,
    outcome: event.outcome,
    action: event.action,
    summary: event.summary,
    ...(event.repo ? { repo: event.repo } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.trajectoryId ? { trajectoryId: event.trajectoryId } : {}),
    ...(event.learningSource ? { learningSource: event.learningSource } : {}),
    ...(event.labelBasis ? { labelBasis: event.labelBasis } : {}),
    ...(event.backend !== undefined ? { backend: event.backend } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
  };
}

function isAgentWorkspaceProductionEvent(event: AgentActionEvent): boolean {
  return event.kind === 'dispatch' ||
    event.kind === 'proposal' ||
    event.outcome === 'proposal-created' ||
    event.outcome === 'no-proposal';
}

function proposalCreatedSignal(event: AgentActionEvent): boolean | undefined {
  if (event.runEventSummary?.proposalCreated === true) return true;
  if (event.runEventSummary?.proposalCreated === false) return false;
  if (event.outcome === 'proposal-created') return true;
  if (event.outcome === 'no-proposal') return false;
  return undefined;
}

function attentionFromCounts(
  kind: AgentWorkspaceAttention['kind'],
  rows: AgentActionCount[],
  detailPrefix: string,
  limit: number,
): AgentWorkspaceAttention[] {
  return rows.slice(0, limit).map((row) => ({
    kind,
    topic: row.key,
    weight: row.count,
    detail: `${detailPrefix}: ${row.count}`,
  }));
}

export function summarizeAgentWorkspace(
  events: AgentActionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
    recentLimit?: number;
  },
): AgentWorkspaceStatus {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  const recentLimit = opts?.recentLimit !== undefined && opts.recentLimit > 0
    ? Math.floor(opts.recentLimit)
    : 10;
  const byAction = new Map<string, number>();
  const byOutcome = new Map<string, number>();
  const byRepo = new Map<string, number>();
  const byBackend = new Map<string, number>();
  const bySource = new Map<string, number>();
  const activeMachines = new Set<string>();
  let spendUsd = 0;
  let proposalEvents = 0;
  let noProposalEvents = 0;
  let diagnosticNoProposalEvents = 0;
  let policySuppressedEvents = 0;
  let latestAt: string | null = null;

  for (const event of events) {
    increment(byAction, event.kind);
    increment(byOutcome, event.outcome);
    if (event.repo) increment(byRepo, event.repo);
    if (event.backend) increment(byBackend, event.backend);
    if (event.source) increment(bySource, event.source);
    if (event.machineId) activeMachines.add(event.machineId);
    spendUsd += finiteNumber(event.spentUsd) ?? 0;
    if (event.outcome === 'proposal-created') proposalEvents++;
    if (event.outcome === 'no-proposal') noProposalEvents++;
    if (isAgentWorkspaceProductionEvent(event)) {
      const classification = classifyProductionAttemptForLearning({
        outcome: event.runEventSummary?.outcome ?? event.outcome,
        proposalCreated: proposalCreatedSignal(event),
        actionCounts: event.runEventSummary?.actionCounts,
      });
      if (classification.diagnosticNoProposal) diagnosticNoProposalEvents++;
      if (classification.policySuppressed) policySuppressedEvents++;
    }
    if (!latestAt || Date.parse(event.ts) > Date.parse(latestAt)) latestAt = event.ts;
  }

  const actionRows = topCounts(byAction, limit);
  const outcomeRows = topCounts(byOutcome, limit);
  const repoRows = topCounts(byRepo, limit);
  const backendRows = topCounts(byBackend, limit);
  const sourceRows = topCounts(bySource, limit);
  const repoEventCount = [...byRepo.values()].reduce((sum, count) => sum + count, 0);
  const topRepoCount = [...byRepo.values()].reduce((max, count) => Math.max(max, count), 0);
  const diagnosticProposalDenominator = proposalEvents + diagnosticNoProposalEvents;

  const attention = [
    ...attentionFromCounts('repo', repoRows, 'repo events', 3),
    ...attentionFromCounts('outcome', outcomeRows, 'outcomes', 2),
    ...attentionFromCounts('backend', backendRows, 'backend events', 2),
    ...attentionFromCounts('source', sourceRows, 'source events', 1),
  ].slice(0, 8);

  return {
    generatedAt: new Date().toISOString(),
    windowHours: opts?.windowHours ?? 24,
    eventCount: events.length,
    latestAt,
    activeMachines: [...activeMachines].sort().slice(0, 10),
    spendUsd,
    proposalEvents,
    noProposalEvents,
    diagnosticNoProposalEvents,
    policySuppressedEvents,
    diagnosticProposalRate: diagnosticProposalDenominator > 0
      ? proposalEvents / diagnosticProposalDenominator
      : null,
    diagnosticNoProposalRate: diagnosticProposalDenominator > 0
      ? diagnosticNoProposalEvents / diagnosticProposalDenominator
      : null,
    repoEventCount,
    repoDistinctCount: byRepo.size,
    topRepoCount,
    attention,
    byAction: actionRows,
    byOutcome: outcomeRows,
    byRepo: repoRows,
    byBackend: backendRows,
    entropy: {
      action: entropy(actionRows),
      outcome: entropy(outcomeRows),
      repo: entropy(repoRows),
    },
    recentActions: events.slice(0, recentLimit).map(recentAction),
  };
}

export function readAgentWorkspace(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  recentLimit?: number;
  repoScope?: AgentActionRepoScope;
  enrolledRepos?: readonly string[];
}): AgentWorkspaceStatus {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const rawEvents = readAgentActions({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
  });
  const events = filterAgentActionsByRepoScope(rawEvents, {
    repoScope: opts?.repoScope,
    enrolledRepos: opts?.enrolledRepos,
  });
  return summarizeAgentWorkspace(events, {
    windowHours: windowMs / (60 * 60 * 1000),
    limitPerDimension: opts?.limitPerDimension,
    recentLimit: opts?.recentLimit,
  });
}
