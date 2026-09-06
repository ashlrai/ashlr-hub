/** Universe experiments report local measurements, never inferred business value. */
export interface UniverseManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  objective: string;
  seed: { repo: string; revision: string };
  metric: { name: string; direction: 'maximize' | 'minimize'; minImprovement: number };
  budget: { maxTrials: number; maxDurationMs: number; trialTimeoutMs: number; maxParallel: number };
  evaluation: { command: string[]; timeoutMs: number };
  variants: Array<{ id: string; niche: string; hypothesis: string; command: string[]; model?: string }>;
}

export interface UniverseArtifact {
  path: string;
  digest: string;
  /** Pinned original Git source; evolved artifacts also have a content digest. */
  revision: string;
}

export interface UniverseTrial {
  id: string;
  variantId: string;
  niche: string;
  parentTrialId: string | null;
  status: 'passed' | 'failed' | 'timed-out' | 'cancelled';
  score: number | null;
  metrics: Record<string, number>;
  artifact: UniverseArtifact | null;
  durationMs: number;
  delta: number | null;
  selected: boolean;
  error?: string;
}

export interface UniverseRun {
  id: string;
  universeId: string;
  generation: number;
  manifestDigest: string;
  comparatorDigest: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  trials: UniverseTrial[];
  durationMs: number;
  /** Local programs do not provide model billing or token telemetry. */
  tokensUsed: null;
  costUsd: null;
  error?: string;
}

export interface UniverseElite {
  niche: string;
  variantId: string;
  trialId: string;
  runId: string;
  generation: number;
  score: number;
  metrics: Record<string, number>;
  artifact: UniverseArtifact;
  comparatorDigest: string;
}

export interface UniverseSummary {
  manifest: UniverseManifest;
  manifestDigest: string;
  comparatorDigest: string;
  runs: UniverseRun[];
  elites: UniverseElite[];
  activeRun: UniverseRun | null;
  sourceState: 'healthy' | 'degraded';
  reasons: string[];
}

export interface UniverseOverview {
  schemaVersion: 1;
  sampledAt: string;
  sourceState: 'missing' | 'healthy' | 'degraded';
  reasons: string[];
  universes: UniverseSummary[];
  measurementScope: 'local-experiment';
}

export interface UniverseStoreOptions { root?: string }
export interface UniverseRunOptions extends UniverseStoreOptions { signal?: AbortSignal }
