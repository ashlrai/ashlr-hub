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
  variants: UniverseVariant[];
}

export interface UniverseGenerationConfig {
  kind: 'local-chat';
  /** Explicit numeric-loopback OpenAI-compatible endpoint; no account discovery. */
  endpoint: string;
  model: string;
  /** Existing relative text files; also the complete replacement allowlist. */
  files: string[];
  maxOutputTokens: number;
}

export type UniverseVariant = { id: string; niche: string; hypothesis: string } & (
  { command: string[]; model?: string; generation?: never } |
  { generation: UniverseGenerationConfig; command?: never; model?: never }
);

/** Explicitly shareable evaluator feedback, not captured process output. */
export interface UniverseDiagnostic {
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface UniverseFeedback {
  schemaVersion: 1;
  source: {
    runId: string;
    trialId: string;
    generation: number;
    comparatorDigest: string;
    artifactDigest: string | null;
  };
  status: UniverseTrial['status'];
  score: number | null;
  metrics: Record<string, number>;
  diagnostics: UniverseDiagnostic[];
  previousAttemptFiles: Array<{ path: string; contentDigest: string; content: string }>;
}

export interface UniverseGenerationReceipt {
  schemaVersion: 1;
  provider: 'local-openai-compatible';
  endpoint: string;
  model: string;
  status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled';
  requestStarted: boolean;
  promptDigest: string | null;
  responseDigest: string | null;
  durationMs: number;
  /** Transport-reported counts only, never estimates or model-authored JSON. */
  usage: { state: 'reported' | 'unavailable'; inputTokens: number | null; outputTokens: number | null };
  changedFiles: string[];
  feedback?: UniverseFeedback['source'] & { digest: string };
  error?: string;
}

export interface UniverseGenerationUsage {
  scope: 'model-generation';
  trials: number;
  requestsStarted: number;
  reportedRequests: number;
  /** Null unless the generation completed and every recorded request reported usage. */
  inputTokens: number | null;
  outputTokens: number | null;
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
  generation?: UniverseGenerationReceipt;
  diagnostics?: UniverseDiagnostic[];
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
  /** Completed generations with full recorded usage only; commands remain unmeasured. */
  tokensUsed: number | null;
  costUsd: null;
  generationUsage?: UniverseGenerationUsage;
  campaign?: { id: string; ordinal: number; definitionDigest: string };
  feedbackEnabled?: true;
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
  campaigns?: UniverseCampaignSummary[];
  measurementScope: 'local-experiment';
}

export interface UniverseStoreOptions { root?: string }
export interface UniverseRunOptions extends UniverseStoreOptions { signal?: AbortSignal }

export interface UniverseCampaignDefinition {
  schemaVersion: 1;
  id: string;
  universeId: string;
  budget: {
    maxGenerations: number;
    maxDurationMs: number;
    maxModelRequests: number;
    maxStagnantGenerations: number;
    /** Observed cutoff; reservations cap requests, not unreported token spend. */
    maxReportedTokens: number | null;
  };
  feedback: boolean;
}

export interface UniverseCampaignStep {
  ordinal: number;
  runId: string;
  generation: number;
  variantIds: string[];
  reservedModelRequests: number;
  createdAt: string;
  state: 'pending' | 'running' | 'completed' | 'interrupted' | 'failed';
  trialCount: number;
  passedTrials: number;
  admissions: number;
  improvements: number;
  tokensUsed: number | null;
}

export interface UniverseCampaignSummary {
  definition: UniverseCampaignDefinition;
  definitionDigest: string;
  manifestDigest: string;
  comparatorDigest: string;
  createdAt: string;
  state: 'ready' | 'running' | 'pause-requested' | 'paused' | 'stop-requested' | 'stopped' |
    'completed' | 'interrupted' | 'failed';
  reason: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  finishedAt: string | null;
  steps: UniverseCampaignStep[];
  progress: {
    attempts: number;
    completedRuns: number;
    interruptedRuns: number;
    reservedModelRequests: number;
    reportedTokens: number | null;
    recordedTokens: number;
    usageComplete: boolean;
    admissions: number;
    improvements: number;
    stagnantGenerations: number;
  };
  owner: { pid: number; startRef: string } | null;
  sourceState: 'healthy' | 'degraded';
  reasons: string[];
}
