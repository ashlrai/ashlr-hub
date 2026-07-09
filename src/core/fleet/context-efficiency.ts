import type { GenomeHealth } from '../types.js';
import type { AgentWorkspaceStatus } from './agent-action-ledger.js';

export type FleetContextEfficiencyPosture = 'healthy' | 'watch' | 'strained' | 'unknown';
export type FleetContextEfficiencyRiskSeverity = 'low' | 'medium' | 'high';

export interface FleetContextEfficiencyRisk {
  id:
    | 'workspace-quiet'
    | 'memory-unavailable'
    | 'memory-empty'
    | 'memory-stale'
    | 'attention-concentrated'
    | 'reflection-missing'
    | 'proposal-yield-low';
  severity: FleetContextEfficiencyRiskSeverity;
  detail: string;
}

export interface FleetContextEfficiencyStatus {
  generatedAt: string;
  windowHours: number;
  posture: FleetContextEfficiencyPosture;
  score: number;
  summary: string;
  signals: {
    workspaceEvents: number;
    activeMachines: number;
    activeRepos: number;
    repoEntropy: number;
    topRepoShare: number | null;
    reflectionEvents: number;
    memoryEntries: number;
    memoryProjects: number;
    hubMemoryEntries: number;
    lastMemoryAt: string | null;
    memoryAgeHours: number | null;
    proposalRate: number | null;
    noProposalRate: number | null;
    suppressedNoProposalDispatches: number;
    contextBloatRisk: 'low' | 'medium' | 'high' | 'unknown';
    retrievalPosture: 'available' | 'stale' | 'empty' | 'unknown';
  };
  risks: FleetContextEfficiencyRisk[];
  recommendations: string[];
}

export interface FleetContextEfficiencyInput {
  workspace?: AgentWorkspaceStatus;
  proposalProduction?: {
    proposalsCreated: number;
    diagnosticNoProposalDispatches: number;
    suppressedDispatches: number;
  };
  queue?: {
    repos?: {
      withBacklog: number;
    };
  };
}

export function buildContextEfficiencyStatus(
  input: FleetContextEfficiencyInput,
  genome: GenomeHealth | undefined,
  generatedAt: string,
  windowMs: number,
): FleetContextEfficiencyStatus {
  const workspace = input.workspace;
  const workspaceEvents = workspace?.eventCount ?? 0;
  const activeMachines = workspace?.activeMachines?.length ?? 0;
  const byRepo = workspace?.byRepo ?? [];
  const activeRepos = workspace?.repoDistinctCount ?? byRepo.length;
  const totalRepoEvents = workspace?.repoEventCount ?? byRepo.reduce((sum, row) => sum + row.count, 0);
  const topRepoCount = workspace?.topRepoCount ?? byRepo[0]?.count ?? 0;
  const topRepoShare = totalRepoEvents > 0 ? roundRatio(topRepoCount / totalRepoEvents) : null;
  const repoEntropy = workspace?.entropy?.repo ?? 0;
  const reflectionEvents = workspace?.byAction?.find((row) => row.key === 'reflection')?.count ?? 0;
  const memoryEntries = genome?.totalEntries ?? 0;
  const hubMemoryEntries = genome?.hubEntries ?? 0;
  const memoryProjects = genome?.projects ?? 0;
  const lastMemoryAt = genome?.lastLearnedAt ?? null;
  const memoryAgeHours = ageHours(lastMemoryAt, generatedAt);
  const retrievalPosture = contextRetrievalPosture(genome, memoryAgeHours);
  const proposalAttempts = (input.proposalProduction?.proposalsCreated ?? 0) +
    (input.proposalProduction?.diagnosticNoProposalDispatches ?? 0);
  const proposalRate = proposalAttempts > 0
    ? roundRatio((input.proposalProduction?.proposalsCreated ?? 0) / proposalAttempts)
    : null;
  const noProposalRate = proposalAttempts > 0
    ? roundRatio((input.proposalProduction?.diagnosticNoProposalDispatches ?? 0) / proposalAttempts)
    : null;
  const suppressedNoProposalDispatches = input.proposalProduction?.suppressedDispatches ?? 0;

  const risks: FleetContextEfficiencyRisk[] = [];
  if (workspaceEvents === 0) {
    risks.push({
      id: 'workspace-quiet',
      severity: 'low',
      detail: 'No recent agent-action telemetry is available for context efficiency scoring.',
    });
  }
  if (!genome) {
    risks.push({
      id: 'memory-unavailable',
      severity: workspaceEvents > 0 ? 'medium' : 'low',
      detail: 'Hub genome health is unavailable, so retrieval quality cannot be trusted.',
    });
  } else if (memoryEntries === 0) {
    risks.push({
      id: 'memory-empty',
      severity: 'high',
      detail: 'No hub genome memories are available for long-running context recovery.',
    });
  } else if (memoryAgeHours !== null && memoryAgeHours > 24 * 7) {
    risks.push({
      id: 'memory-stale',
      severity: memoryAgeHours > 24 * 30 ? 'high' : 'medium',
      detail: `Latest hub genome memory is ${Math.round(memoryAgeHours)}h old.`,
    });
  }
  const backlogRepos = input.queue?.repos?.withBacklog ?? 0;
  if (
    topRepoShare !== null &&
    topRepoShare >= 0.75 &&
    (activeRepos > 1 || backlogRepos > 1 || workspaceEvents >= 8)
  ) {
    risks.push({
      id: 'attention-concentrated',
      severity: topRepoShare >= 0.9 ? 'high' : 'medium',
      detail: `Top repo owns ${Math.round(topRepoShare * 100)}% of recent workspace attention.`,
    });
  }
  if (workspaceEvents > 0 && reflectionEvents === 0) {
    risks.push({
      id: 'reflection-missing',
      severity: workspaceEvents >= 25 ? 'medium' : 'low',
      detail: 'Recent workspace activity has no reflection/compaction event.',
    });
  }
  if (proposalAttempts >= 3 && proposalRate !== null && proposalRate < 0.25) {
    risks.push({
      id: 'proposal-yield-low',
      severity: proposalRate === 0 ? 'high' : 'medium',
      detail: `Diagnostic proposal yield is ${Math.round(proposalRate * 100)}% over ${proposalAttempts} recent attempt(s).`,
    });
  }

  const score = contextEfficiencyScore(risks, workspaceEvents, genome);
  const posture = contextEfficiencyPosture(score, risks, workspaceEvents, genome);
  const contextBloatRisk = contextBloatRiskFromSignals(workspaceEvents, topRepoShare, risks);
  const summary = contextEfficiencySummary({
    posture,
    workspaceEvents,
    activeRepos,
    memoryEntries,
    topRepoShare,
    proposalRate,
  });

  return {
    generatedAt,
    windowHours: windowMs / (60 * 60 * 1000),
    posture,
    score,
    summary,
    signals: {
      workspaceEvents,
      activeMachines,
      activeRepos,
      repoEntropy,
      topRepoShare,
      reflectionEvents,
      memoryEntries,
      memoryProjects,
      hubMemoryEntries,
      lastMemoryAt,
      memoryAgeHours,
      proposalRate,
      noProposalRate,
      suppressedNoProposalDispatches,
      contextBloatRisk,
      retrievalPosture,
    },
    risks,
    recommendations: contextEfficiencyRecommendations(risks),
  };
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function ageHours(iso: string | null, generatedAt: string): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round(((now - ts) / (60 * 60 * 1000)) * 10) / 10);
}

function contextRetrievalPosture(
  genome: GenomeHealth | undefined,
  memoryAgeHours: number | null,
): FleetContextEfficiencyStatus['signals']['retrievalPosture'] {
  if (!genome) return 'unknown';
  if (genome.totalEntries <= 0) return 'empty';
  if (memoryAgeHours !== null && memoryAgeHours > 24 * 7) return 'stale';
  return 'available';
}

function contextEfficiencyScore(
  risks: FleetContextEfficiencyRisk[],
  workspaceEvents: number,
  genome: GenomeHealth | undefined,
): number {
  if (workspaceEvents === 0 && (!genome || genome.totalEntries === 0)) return 0;
  const penalty = risks.reduce((sum, risk) => {
    if (risk.severity === 'high') return sum + 28;
    if (risk.severity === 'medium') return sum + 16;
    return sum + 8;
  }, 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function contextEfficiencyPosture(
  score: number,
  risks: FleetContextEfficiencyRisk[],
  workspaceEvents: number,
  genome: GenomeHealth | undefined,
): FleetContextEfficiencyPosture {
  if (workspaceEvents === 0 && (!genome || genome.totalEntries === 0)) return 'unknown';
  if (score < 70 || risks.some((risk) => risk.severity === 'high')) return 'strained';
  if (score < 92 || risks.length > 0) return 'watch';
  return 'healthy';
}

function contextBloatRiskFromSignals(
  workspaceEvents: number,
  topRepoShare: number | null,
  risks: FleetContextEfficiencyRisk[],
): FleetContextEfficiencyStatus['signals']['contextBloatRisk'] {
  if (workspaceEvents === 0) return 'unknown';
  if (
    workspaceEvents >= 1000 ||
    risks.some((risk) => risk.id === 'attention-concentrated' && risk.severity === 'high')
  ) {
    return 'high';
  }
  if (workspaceEvents >= 300 || (topRepoShare !== null && topRepoShare >= 0.75)) return 'medium';
  return 'low';
}

function contextEfficiencySummary(input: {
  posture: FleetContextEfficiencyPosture;
  workspaceEvents: number;
  activeRepos: number;
  memoryEntries: number;
  topRepoShare: number | null;
  proposalRate: number | null;
}): string {
  const attention = input.topRepoShare === null
    ? 'no repo attention signal'
    : `top repo ${Math.round(input.topRepoShare * 100)}%`;
  const proposal = input.proposalRate === null
    ? 'proposal yield unknown'
    : `proposal yield ${Math.round(input.proposalRate * 100)}%`;
  return `${input.posture}: ${input.workspaceEvents} workspace event(s), ${input.activeRepos} active repo(s), ${input.memoryEntries} hub memory entr${input.memoryEntries === 1 ? 'y' : 'ies'}, ${attention}, ${proposal}.`;
}

function contextEfficiencyRecommendations(risks: FleetContextEfficiencyRisk[]): string[] {
  const recommendations = new Set<string>();
  for (const risk of risks) {
    if (risk.id === 'workspace-quiet') {
      recommendations.add('Let the daemon record agent-action telemetry before learning from context quality.');
    } else if (risk.id === 'memory-unavailable') {
      recommendations.add('Repair or initialize the hub genome before trusting retrieved context quality.');
    } else if (risk.id === 'memory-empty' || risk.id === 'memory-stale') {
      recommendations.add('Run a reflection pass and capture current cross-repo decisions into the genome.');
    } else if (risk.id === 'attention-concentrated') {
      recommendations.add('Split broad work into scoped repo/task agents and return bounded summaries.');
    } else if (risk.id === 'reflection-missing') {
      recommendations.add('Schedule a compression/reflection pass before the next long-running fleet batch.');
    } else if (risk.id === 'proposal-yield-low') {
      recommendations.add('Reslice low-yield backlog items and route them with tighter retrieved context.');
    }
  }
  return [...recommendations].slice(0, 5);
}
