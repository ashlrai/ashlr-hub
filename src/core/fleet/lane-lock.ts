import { resolve } from 'node:path';
import type { Goal, Proposal, WorkItem } from '../types.js';
import { proposalCompletesGoalMilestone } from '../goals/completion.js';

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

export interface FleetLaneLocksStatus {
  generatedAt: string;
  active: number;
  staleInProgress: number;
  awaitingHostMerge: number;
  unverifiedApplied: number;
  lockedVisibleItems: number;
  samples: FleetLaneLockSample[];
}

export interface BuildFleetLaneLocksInput {
  goals: Goal[];
  proposals: Proposal[];
  visibleQueueItems: WorkItem[];
  generatedAt?: string;
  staleInProgressMs?: number;
  recentAppliedMs?: number;
  sampleLimit?: number;
}

export const DEFAULT_LANE_LOCK_STALE_IN_PROGRESS_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_LANE_LOCK_RECENT_APPLIED_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LANE_LOCK_SAMPLE_LIMIT = 8;

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

function laneKey(repo: string | null, suffix: string): string {
  return `${repo ?? 'unknown'}#${suffix}`;
}

function goalItemIds(item: WorkItem): { goalId: string; milestoneId?: string } | null {
  if (item.source !== 'goal') return null;
  const match = /^goal:([^:]+)(?::([^:]+))?/.exec(item.id);
  if (!match?.[1]) return null;
  return {
    goalId: match[1],
    ...(match[2] ? { milestoneId: match[2] } : {}),
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
  const sampleLimit = Math.max(0, input.sampleLimit ?? DEFAULT_LANE_LOCK_SAMPLE_LIMIT);

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
        lane,
        repo,
        reason: stale ? 'stale-in-progress' : 'active-goal',
        goalId: goal.id,
        milestoneId: milestone.id,
        ...(milestone.proposalId ? { proposalId: milestone.proposalId } : {}),
        status: milestone.status,
        title: milestone.title,
        ageMs: milestoneAgeMs,
      },
      sampleLimit,
    );
  }

  let awaitingHostMerge = 0;
  let unverifiedApplied = 0;

  for (const proposal of input.proposals) {
    const repo = repoKey(proposal.repo);
    const proposalAgeMs = ageMs(safeNowMs, proposal.decidedAt ?? proposal.createdAt);
    if (proposal.status === 'awaiting-host-merge') {
      awaitingHostMerge++;
      pushSample(
        samples,
        seenSamples,
        {
          lane: laneKey(repo, `proposal:${proposal.id}`),
          repo,
          reason: 'awaiting-host-merge',
          proposalId: proposal.id,
          status: proposal.status,
          title: proposal.title,
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
        lane: laneKey(repo, `proposal:${proposal.id}`),
        repo,
        reason: 'unverified-applied',
        proposalId: proposal.id,
        status: proposal.status,
        title: proposal.title,
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
  };
}
