import { resolve } from 'node:path';
import type { Goal, Proposal, WorkItem } from '../types.js';
import { proposalCompletesGoalMilestone } from '../goals/completion.js';
import { DEFAULT_STALE_GOAL_MILESTONE_MS } from '../goals/store.js';
import { scrubSecrets } from '../util/scrub.js';

export type FleetLaneLockReason =
  | 'active-goal'
  | 'stale-in-progress'
  | 'awaiting-host-merge'
  | 'unverified-applied';

export interface FleetLaneLockSample {
  lane: string;
  repo: string | null;
  reason: FleetLaneLockReason;
  goalId?: string;
  milestoneId?: string;
  proposalId?: string;
  status?: string;
  title?: string;
  ageMs: number | null;
}

export type FleetLaneLockSourceState = 'missing' | 'healthy' | 'degraded';

export type FleetLaneLockSourceReason =
  | 'goals-missing'
  | 'goals-incomplete'
  | 'goals-unreadable'
  | 'goals-limit-exceeded'
  | 'proposals-missing'
  | 'proposals-incomplete'
  | 'proposals-invalid'
  | 'proposals-unreadable'
  | 'proposals-limit-exceeded'
  | 'queue-missing'
  | 'queue-incomplete'
  | 'queue-stale'
  | 'queue-unavailable';

export interface FleetLaneLockSourceQualityPart {
  sourceState: FleetLaneLockSourceState;
  complete: boolean;
  reasons: FleetLaneLockSourceReason[];
}

export interface FleetLaneLockSourceQuality extends FleetLaneLockSourceQualityPart {
  sources: {
    goals: FleetLaneLockSourceQualityPart;
    proposals: FleetLaneLockSourceQualityPart;
    queue: FleetLaneLockSourceQualityPart;
  };
}

export interface FleetLaneLocksStatus {
  generatedAt: string;
  active: number;
  staleInProgress: number;
  awaitingHostMerge: number;
  unverifiedApplied: number;
  lockedVisibleItems: number;
  samples: FleetLaneLockSample[];
  /** Present on current snapshots; omitted only by legacy serialized status. */
  sourceQuality?: FleetLaneLockSourceQuality;
}

export interface BuildFleetLaneLocksInput {
  goals: Goal[];
  proposals: Proposal[];
  visibleQueueItems: WorkItem[];
  generatedAt?: string;
  staleInProgressMs?: number;
  recentAppliedMs?: number;
  sampleLimit?: number;
  sourceQuality?: Partial<FleetLaneLockSourceQuality['sources']>;
}

export const DEFAULT_LANE_LOCK_STALE_IN_PROGRESS_MS = DEFAULT_STALE_GOAL_MILESTONE_MS;
export const DEFAULT_LANE_LOCK_RECENT_APPLIED_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LANE_LOCK_SAMPLE_LIMIT = 8;
export const MAX_LANE_LOCK_SOURCE_REASONS = 8;

const MAX_LANE_LOCK_TITLE_LENGTH = 120;
const MAX_LANE_LOCK_REFERENCE_LENGTH = 96;

const QUOTED_ABSOLUTE_PATH_PATTERN = /(["'])(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/(?!\/))[^"'\r\n]*\1/g;
const WINDOWS_UNC_PATH_PATTERN = /\\\\(?:[?.]\\)?(?:UNC\\)?[^\\/\s"'<>|?*]+\\[^\\/\s"'<>|?*]+(?:\\[^\\/\s"'<>|?*]+)*/gi;
const WINDOWS_FORWARD_UNC_PATH_PATTERN = /(?<!:)\/\/[^/\s"'<>|?*]+\/[^/\s"'<>|?*]+(?:\/[^/\s"'<>|?*]+)*/g;
const WINDOWS_DRIVE_PATH_PATTERN = /\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|?*]+[\\/])*[^\\/\s"'<>|?*,;:!)]*/g;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?<![:/A-Za-z0-9_])\/(?:[A-Za-z0-9._~+@%=-]+\/)*[A-Za-z0-9._~+@%=-]+/g;
const AMBIGUOUS_SPACED_POSIX_PATH_PATTERN = /(?<![:/A-Za-z0-9_])\/(?:[^/\s"'<>|?*]+\/)*[^/\s"'<>|?*]+[ \t]+[^\s"'<>|?*]*[\\/][^\s"'<>|?*]+/;
const AMBIGUOUS_SPACED_DRIVE_PATH_PATTERN = /\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|?*]+[\\/])*[^\\/\s"'<>|?*]+[ \t]+[^\s"'<>|?*]*[\\/][^\s"'<>|?*]+/;
const AMBIGUOUS_SPACED_UNC_PATH_PATTERN = /\\\\(?:[?.]\\)?(?:UNC\\)?[^\\/\s"'<>|?*]+\\[^\\/\s"'<>|?*]+[ \t]+(?:[^\s"'<>|?*]+[ \t]+){0,2}[^\s"'<>|?*]*\\[^\s"'<>|?*]+/i;
const AMBIGUOUS_SPACED_FINAL_COMPONENT_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\(?:[?.]\\)?(?:UNC\\)?|(?<![:/A-Za-z0-9_])\/)(?:[^\\/\s"'<>|?*]+[\\/])*[^\\/\s"'<>|?*]+[ \t]+[^\\/\s"'<>|?*]+\.[A-Za-z0-9]{1,16}(?=$|[\s,;:!?)\]}])/i;

const ACTIVE_GOAL_MILESTONE_STATUSES = new Set(['pending', 'in-progress', 'proposed']);

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function ageMs(nowMs: number, value: string | undefined): number | null {
  const ms = parseMs(value);
  if (ms === null) return null;
  return Math.max(0, nowMs - ms);
}

function repoKey(repo: string | null | undefined): string | null {
  return repo ? resolve(repo) : null;
}

function scrubAbsolutePathSubstrings(value: string): string {
  const withoutQuotedPaths = value.replace(QUOTED_ABSOLUTE_PATH_PATTERN, '[PATH]');
  if (
    AMBIGUOUS_SPACED_POSIX_PATH_PATTERN.test(withoutQuotedPaths) ||
    AMBIGUOUS_SPACED_DRIVE_PATH_PATTERN.test(withoutQuotedPaths) ||
    AMBIGUOUS_SPACED_UNC_PATH_PATTERN.test(withoutQuotedPaths) ||
    AMBIGUOUS_SPACED_FINAL_COMPONENT_PATTERN.test(withoutQuotedPaths)
  ) {
    return '[PATH]';
  }
  return value
    .replace(QUOTED_ABSOLUTE_PATH_PATTERN, '[PATH]')
    .replace(WINDOWS_UNC_PATH_PATTERN, '[PATH]')
    .replace(WINDOWS_FORWARD_UNC_PATH_PATTERN, '[PATH]')
    .replace(WINDOWS_DRIVE_PATH_PATTERN, '[PATH]')
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, '[PATH]');
}

function boundedMetadata(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const printable = Array.from(scrubSecrets(scrubAbsolutePathSubstrings(value)), (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  const normalized = printable
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function publicRepoName(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const normalized = repo.replace(/\\/g, '/').replace(/\/+$/, '');
  return boundedMetadata(normalized.split('/').pop(), MAX_LANE_LOCK_REFERENCE_LENGTH) ?? null;
}

function publicLane(repo: string | null | undefined, suffix: string): string {
  return laneKey(publicRepoName(repo), boundedMetadata(suffix, MAX_LANE_LOCK_REFERENCE_LENGTH) ?? 'unknown');
}

function laneKey(repo: string | null, suffix: string): string {
  return `${repo ?? 'unknown'}#${suffix}`;
}

function sourceQualityPart(
  input: FleetLaneLockSourceQualityPart | undefined,
  missingReason: FleetLaneLockSourceReason,
): FleetLaneLockSourceQualityPart {
  if (!input) return { sourceState: 'missing', complete: false, reasons: [missingReason] };
  return {
    sourceState: input.sourceState === 'healthy' && !input.complete ? 'degraded' : input.sourceState,
    complete: input.complete,
    reasons: input.reasons.slice(0, MAX_LANE_LOCK_SOURCE_REASONS),
  };
}

function buildSourceQuality(
  input: BuildFleetLaneLocksInput['sourceQuality'],
): FleetLaneLockSourceQuality {
  const sources = {
    goals: sourceQualityPart(input?.goals, 'goals-missing'),
    proposals: sourceQualityPart(input?.proposals, 'proposals-missing'),
    queue: sourceQualityPart(input?.queue, 'queue-missing'),
  };
  const parts = Object.values(sources);
  const sourceState: FleetLaneLockSourceState = parts.some((part) => part.sourceState === 'degraded')
    ? 'degraded'
    : parts.some((part) => part.sourceState === 'missing')
      ? 'missing'
      : 'healthy';
  const reasons = Array.from(new Set(parts.flatMap((part) => part.reasons)))
    .slice(0, MAX_LANE_LOCK_SOURCE_REASONS);
  return {
    sourceState,
    complete: sourceState === 'healthy' && parts.every((part) => part.complete),
    reasons,
    sources,
  };
}

function goalItemIds(item: WorkItem): { goalId: string; milestoneId?: string } | null {
  if (item.source !== 'goal') return null;
  const match = /^goal:([^:]+)(?::([^:]+))?/.exec(item.id);
  if (match?.[1]) {
    return {
      goalId: match[1],
      ...(match[2] ? { milestoneId: match[2] } : {}),
    };
  }
  const [kind, goalId, milestoneId] = item.tags;
  if (kind !== 'goal' || !goalId) return null;
  return {
    goalId,
    ...(milestoneId ? { milestoneId } : {}),
  };
}

function pushSample(
  samples: FleetLaneLockSample[],
  seen: Set<string>,
  sample: FleetLaneLockSample,
  limit: number,
): void {
  if (samples.length >= limit) return;
  const key = `${sample.reason}\0${sample.lane}\0${sample.proposalId ?? ''}\0${sample.milestoneId ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  samples.push(sample);
}

function proposalById(proposals: Proposal[]): Map<string, Proposal> {
  const byId = new Map<string, Proposal>();
  for (const proposal of proposals) byId.set(proposal.id, proposal);
  return byId;
}

function activeGoalMilestone(goal: Goal, proposals: Map<string, Proposal>): Goal['milestones'][number] | null {
  const milestones = goal.milestones.slice().sort((a, b) => a.order - b.order);
  for (const milestone of milestones) {
    if (milestone.status === 'done' || milestone.status === 'skipped' || milestone.status === 'paused') continue;
    if (milestone.proposalId && proposalCompletesGoalMilestone(proposals.get(milestone.proposalId))) continue;
    if (ACTIVE_GOAL_MILESTONE_STATUSES.has(milestone.status)) return milestone;
  }
  return null;
}

export function buildFleetLaneLocks(input: BuildFleetLaneLocksInput): FleetLaneLocksStatus {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const safeNowMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
  const staleMs = input.staleInProgressMs ?? DEFAULT_LANE_LOCK_STALE_IN_PROGRESS_MS;
  const recentAppliedMs = input.recentAppliedMs ?? DEFAULT_LANE_LOCK_RECENT_APPLIED_MS;
  const requestedSampleLimit = input.sampleLimit;
  const normalizedSampleLimit = typeof requestedSampleLimit === 'number' && Number.isFinite(requestedSampleLimit)
    ? Math.max(0, Math.floor(requestedSampleLimit))
    : DEFAULT_LANE_LOCK_SAMPLE_LIMIT;
  const sampleLimit = Math.min(DEFAULT_LANE_LOCK_SAMPLE_LIMIT, normalizedSampleLimit);

  const samples: FleetLaneLockSample[] = [];
  const seenSamples = new Set<string>();
  const activeGoalLanes = new Set<string>();
  const activeGoalIds = new Set<string>();
  const linkedProposalIds = new Set<string>();
  const proposals = proposalById(input.proposals);
  let staleInProgress = 0;

  for (const goal of input.goals) {
    if (goal.status !== 'active') continue;
    const repo = repoKey(goal.project);
    for (const milestone of goal.milestones) {
      if (milestone.proposalId) linkedProposalIds.add(milestone.proposalId);
    }
    const milestone = activeGoalMilestone(goal, proposals);
    if (!milestone) continue;
    const lane = laneKey(repo, `goal:${goal.id}`);
    activeGoalLanes.add(lane);
    activeGoalIds.add(goal.id);
    const milestoneAgeMs = ageMs(safeNowMs, milestone.updatedAt ?? goal.updatedAt ?? goal.createdAt);
    const stale = milestone.status === 'in-progress' && milestoneAgeMs !== null && milestoneAgeMs > staleMs;
    if (stale) staleInProgress++;
    pushSample(
      samples,
      seenSamples,
      {
        lane: publicLane(goal.project, `goal:${goal.id}`),
        repo: publicRepoName(goal.project),
        reason: stale ? 'stale-in-progress' : 'active-goal',
        goalId: goal.id,
        milestoneId: milestone.id,
        ...(milestone.proposalId ? { proposalId: milestone.proposalId } : {}),
        status: milestone.status,
        title: boundedMetadata(milestone.title, MAX_LANE_LOCK_TITLE_LENGTH),
        ageMs: milestoneAgeMs,
      },
      sampleLimit,
    );
  }

  let awaitingHostMerge = 0;
  let unverifiedApplied = 0;

  for (const proposal of input.proposals) {
    const proposalAgeMs = ageMs(safeNowMs, proposal.decidedAt ?? proposal.createdAt);
    if (proposal.status === 'awaiting-host-merge') {
      awaitingHostMerge++;
      pushSample(
        samples,
        seenSamples,
        {
          lane: publicLane(proposal.repo, `proposal:${proposal.id}`),
          repo: publicRepoName(proposal.repo),
          reason: 'awaiting-host-merge',
          proposalId: proposal.id,
          status: proposal.status,
          title: boundedMetadata(proposal.title, MAX_LANE_LOCK_TITLE_LENGTH),
          ageMs: proposalAgeMs,
        },
        sampleLimit,
      );
      continue;
    }
    if (proposal.status !== 'applied' || proposalCompletesGoalMilestone(proposal)) continue;
    const recent = proposalAgeMs === null || proposalAgeMs <= recentAppliedMs;
    const linked = linkedProposalIds.has(proposal.id);
    if (!recent && !linked) continue;
    unverifiedApplied++;
    pushSample(
      samples,
      seenSamples,
      {
        lane: publicLane(proposal.repo, `proposal:${proposal.id}`),
        repo: publicRepoName(proposal.repo),
        reason: 'unverified-applied',
        proposalId: proposal.id,
        status: proposal.status,
        title: boundedMetadata(proposal.title, MAX_LANE_LOCK_TITLE_LENGTH),
        ageMs: proposalAgeMs,
      },
      sampleLimit,
    );
  }

  let lockedVisibleItems = 0;
  for (const item of input.visibleQueueItems) {
    const ids = goalItemIds(item);
    if (!ids) continue;
    if (activeGoalIds.has(ids.goalId)) lockedVisibleItems++;
  }

  return {
    generatedAt,
    active: activeGoalLanes.size,
    staleInProgress,
    awaitingHostMerge,
    unverifiedApplied,
    lockedVisibleItems,
    samples,
    sourceQuality: buildSourceQuality(input.sourceQuality),
  };
}
