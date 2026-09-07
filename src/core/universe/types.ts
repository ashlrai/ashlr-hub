import type { UniverseDeliveryReceipt } from './delivery.js';
import type { UniverseFileOperationsConfig, UniverseFileOperationsReceipt } from './file-operations-types.js';
import type { ResourceWorker } from '../resources/pool-policy.js';
import type { ResourceTaskReceipt } from '../resources/pool-runtime.js';
import type { ResourceUsageScope } from '../resources/performance.js';

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

interface UniverseGenerationFileScope {
  /** Mutable path scope. Paths must exist unless fileOperations explicitly opts in. */
  files: string[];
  maxOutputTokens: number;
  fileOperations?: UniverseFileOperationsConfig;
}

export interface UniverseLocalGenerationConfig extends UniverseGenerationFileScope {
  kind: 'local-chat';
  /** Explicit numeric-loopback OpenAI-compatible endpoint; no account discovery. */
  endpoint: string;
  model: string;
}

export interface UniverseResourceGenerationConfig extends UniverseGenerationFileScope {
  kind: 'resource-pool';
  poolId: string;
  /** Pins the operator-owned policy and bindings without disclosing private locators. */
  poolDigest: string;
  allowedWorkerIds: string[];
}

export type UniverseGenerationConfig = UniverseLocalGenerationConfig | UniverseResourceGenerationConfig;

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

export interface UniverseSearchAttempt {
  runId: string;
  trialId: string;
  generation: number;
  /** Recorded content identity, not a fresh artifact byte verification. */
  artifactDigest: string | null;
}

/** Separate decision context: legacy evaluator feedback and its byte digest remain unchanged. */
export interface UniverseSearchContext {
  schemaVersion: 2;
  universeId: string;
  manifestDigest: string;
  comparatorDigest: string;
  variantId: string;
  niche: string;
  generation: number;
  metric: UniverseManifest['metric'];
  /** Null means the pinned seed is the edit base; its score has not been measured. */
  parent: (Omit<UniverseSearchAttempt, 'artifactDigest'> & { artifactDigest: string; score: number }) | null;
  previous: (UniverseSearchAttempt & {
    status: UniverseTrial['status'];
    score: number | null;
    selected: boolean;
    delta: number | null;
  }) | null;
  repetition: {
    scope: 'same-variant-current-parent';
    limit: 16;
    totalAttempts: number;
    /** Latest 16 eligible completed attempts, in chronological order. */
    sampledAttempts: UniverseSearchAttempt[];
    truncated: boolean;
    latestArtifactDigest: string | null;
    /** Exact matches to the latest sampled non-null digest, including that occurrence. */
    matchingArtifactCount: number;
  };
}

export interface UniverseSearchContextReceipt {
  schemaVersion: 2;
  digest: string;
}

/** Resource handoff evidence is not a provider-request count or artifact acceptance. */
export interface UniverseResourceGenerationEvidence {
  schemaVersion: 1;
  poolId: string;
  poolDigest: string;
  allowedWorkerIds: string[];
  taskId: string | null;
  taskDigest: string | null;
  workerId: string | null;
  workerProvider: ResourceWorker['provider'] | null;
  workerModel: string | null;
  receiptDigest: string | null;
  dispatch: 'not-started' | 'withheld' | 'settled' | 'replayed' | 'unavailable';
  taskStatus: ResourceTaskReceipt['status'] | null;
  usageScope: ResourceUsageScope | null;
}

export interface UniverseGenerationReceipt {
  schemaVersion: 1;
  provider: 'local-openai-compatible' | 'resource-pool';
  /** Null for resources: the selected model is recorded in the resource witness. */
  endpoint: string | null;
  model: string | null;
  status: 'succeeded' | 'failed' | 'timed-out' | 'cancelled';
  requestStarted: boolean;
  promptDigest: string | null;
  responseDigest: string | null;
  durationMs: number;
  /** Transport-reported counts only, never estimates or model-authored JSON. */
  usage: { state: 'reported' | 'unavailable'; inputTokens: number | null; outputTokens: number | null };
  changedFiles: string[];
  feedback?: UniverseFeedback['source'] & { digest: string };
  search?: UniverseSearchContextReceipt;
  fileOperations?: UniverseFileOperationsReceipt;
  resource?: UniverseResourceGenerationEvidence;
  error?: string;
}

export interface UniverseGenerationUsage {
  scope: 'model-generation';
  trials: number;
  requestsStarted: number;
  reportedRequests: number;
  /** Resource handoffs, not provider requests. Omitted on legacy local-only runs. */
  resourceAttempts?: number;
  /** Measured settled handoffs only; replayed and uncertain attempts are excluded. */
  resourceReportedAttempts?: number;
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
  /** Absent denotes legacy v1 feedback; new decision-context runs pin version 2 before execution. */
  feedbackVersion?: 2;
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
  deliveryReports?: Array<{
    universeId: string;
    deliveries: UniverseDeliveryReceipt[];
    sourceState: 'missing' | 'healthy' | 'degraded';
    reasons: string[];
  }>;
  measurementScope: 'local-experiment';
}

export interface UniverseStoreOptions { root?: string }
export interface UniverseRunOptions extends UniverseStoreOptions {
  signal?: AbortSignal;
  /** Explicit private operator configuration path; never part of a portable manifest. */
  resourceRuntime?: string;
}

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
