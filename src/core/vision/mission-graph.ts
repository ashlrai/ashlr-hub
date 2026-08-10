/**
 * Planning-only ecosystem mission graph.
 *
 * This module compiles a bounded cross-repository mission DAG, authenticates its
 * canonical shape with a deterministic SHA-256 digest, and projects read-only
 * node readiness from caller-supplied observations. It has no persistence,
 * dispatch, provider, proposal, merge, release, or deployment authority.
 */

import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

export const ECOSYSTEM_MISSION_GRAPH_SCHEMA_VERSION = 1 as const;
export const MAX_MISSION_GRAPH_NODES = 24;
export const MAX_MISSION_GRAPH_DEPENDENCIES = 8;
export const MAX_MISSION_GRAPH_ACCEPTANCE_CRITERIA = 8;
export const MAX_MISSION_GRAPH_CANONICAL_BYTES = 128 * 1024;

const MAX_KEY_LENGTH = 80;
const MAX_TITLE_LENGTH = 200;
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_DELIVERABLE_LENGTH = 1_000;
const MAX_ACCEPTANCE_LENGTH = 500;
const KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const GRAPH_KEYS = new Set([
  'schemaVersion', 'digestAlgorithm', 'graphDigest', 'missionKey', 'title', 'objective', 'createdAt', 'nodes',
]);
const NODE_KEYS = new Set([
  'kind', 'key', 'title', 'objective', 'deliverable', 'riskClass', 'repo', 'dependsOn', 'acceptance',
]);
const NODE_WITH_OUTCOME_KEYS = new Set([...NODE_KEYS, 'outcomeContract']);
const OUTCOME_CONTRACT_KEYS = new Set(['desiredOutcome', 'successSignals', 'guardrails']);

export type MissionGraphNodeKind = 'work' | 'human-gate';
export type MissionGraphRiskClass = 'low' | 'medium' | 'high';

export interface MissionOutcomeContractInput {
  desiredOutcome: string;
  successSignals: readonly string[];
  guardrails: readonly string[];
}

export interface MissionGraphNodeInput {
  kind: MissionGraphNodeKind;
  key: string;
  title: string;
  objective: string;
  deliverable: string;
  riskClass: MissionGraphRiskClass;
  /** Exact enrolled absolute root or an unambiguous exact basename. */
  targetRepo?: string | null;
  dependsOn?: readonly string[];
  acceptance: readonly string[];
  outcomeContract?: MissionOutcomeContractInput;
}

export interface MissionGraphInput {
  missionKey: string;
  title: string;
  objective: string;
  /** Explicit clock input keeps compilation pure and reproducible. */
  createdAt: string;
  nodes: readonly MissionGraphNodeInput[];
}

export interface EcosystemMissionGraphNodeV1 {
  kind: MissionGraphNodeKind;
  key: string;
  title: string;
  objective: string;
  deliverable: string;
  riskClass: MissionGraphRiskClass;
  /** Canonical enrolled root for work; human gates are repository-neutral. */
  repo: string | null;
  dependsOn: string[];
  acceptance: string[];
  outcomeContract?: {
    desiredOutcome: string;
    successSignals: string[];
    guardrails: string[];
  };
}

export interface EcosystemMissionGraphV1 {
  schemaVersion: typeof ECOSYSTEM_MISSION_GRAPH_SCHEMA_VERSION;
  digestAlgorithm: 'sha256';
  graphDigest: string;
  missionKey: string;
  title: string;
  objective: string;
  createdAt: string;
  nodes: EcosystemMissionGraphNodeV1[];
}

export type MissionGraphValidationCode =
  | 'invalid-schema'
  | 'invalid-key'
  | 'invalid-title'
  | 'invalid-objective'
  | 'invalid-deliverable'
  | 'invalid-risk-class'
  | 'invalid-outcome-contract'
  | 'invalid-created-at'
  | 'invalid-node-kind'
  | 'invalid-repository-target'
  | 'repository-not-enrolled'
  | 'repository-target-ambiguous'
  | 'human-gate-repository-target'
  | 'invalid-acceptance'
  | 'too-many-nodes'
  | 'too-many-dependencies'
  | 'too-many-acceptance-criteria'
  | 'duplicate-node-key'
  | 'duplicate-dependency'
  | 'missing-dependency'
  | 'self-dependency'
  | 'cyclic-dependency'
  | 'graph-too-large'
  | 'digest-mismatch'
  | 'duplicate-observation'
  | 'unknown-observation-node'
  | 'invalid-observation';

export interface MissionGraphValidationIssue {
  code: MissionGraphValidationCode;
  path: string;
  message: string;
}

export type MissionGraphCompileResult =
  | { ok: true; graph: EcosystemMissionGraphV1; issues: [] }
  | { ok: false; issues: MissionGraphValidationIssue[] };

export type MissionNodeObservedState = 'active' | 'proposed' | 'realized' | 'failed';

export interface MissionNodeObservation {
  nodeKey: string;
  /** Work-node lifecycle evidence supplied by a separately authoritative reader. */
  state?: MissionNodeObservedState;
  /** Human approval is valid only for a human-gate node. */
  humanApproved?: boolean;
}

export type MissionNodeProjectionStatus =
  | 'blocked'
  | 'ready'
  | 'active'
  | 'proposed'
  | 'awaiting-human'
  | 'complete'
  | 'failed';

export interface MissionNodeProjection {
  key: string;
  kind: MissionGraphNodeKind;
  repo: string | null;
  status: MissionNodeProjectionStatus;
  blockedBy: string[];
  observedState: MissionNodeObservedState | null;
}

export interface MissionGraphProjection {
  graphDigest: string;
  status: 'blocked' | 'ready' | 'in-progress' | 'awaiting-human' | 'complete' | 'failed';
  counts: Record<MissionNodeProjectionStatus, number>;
  nodes: MissionNodeProjection[];
}

export type MissionGraphProjectionResult =
  | { ok: true; projection: MissionGraphProjection; issues: [] }
  | { ok: false; issues: MissionGraphValidationIssue[] };

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

function issue(
  code: MissionGraphValidationCode,
  path: string,
  message: string,
): MissionGraphValidationIssue {
  return { code, path, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonicalize(value: unknown, ancestors = new Set<object>()): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? value.normalize('NFC') : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError('canonical values must be JSON-compatible');
  if (ancestors.has(value)) throw new TypeError('canonical values must not be cyclic');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical objects must be plain records');
    }
    const output: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key.normalize('NFC'), entry] as const)
      .sort(([left], [right]) => canonicalCompare(left, right))) {
      if (Object.prototype.hasOwnProperty.call(output, key)) {
        throw new TypeError('canonical object keys must remain unique after normalization');
      }
      output[key] = canonicalize(entry, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  return normalized.length > 0 ? normalized : null;
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_KEY_LENGTH && KEY_RE.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function graphDigestPayload(graph: Omit<EcosystemMissionGraphV1, 'graphDigest'> | EcosystemMissionGraphV1): unknown {
  return {
    schemaVersion: graph.schemaVersion,
    digestAlgorithm: graph.digestAlgorithm,
    missionKey: graph.missionKey,
    title: graph.title,
    objective: graph.objective,
    createdAt: graph.createdAt,
    nodes: [...graph.nodes]
      .map((node) => ({
        kind: node.kind,
        key: node.key,
        title: node.title,
        objective: node.objective,
        deliverable: node.deliverable,
        riskClass: node.riskClass,
        repo: node.repo,
        dependsOn: [...node.dependsOn].sort(),
        acceptance: [...node.acceptance].sort(),
        ...(node.outcomeContract ? {
          outcomeContract: {
            desiredOutcome: node.outcomeContract.desiredOutcome,
            successSignals: [...node.outcomeContract.successSignals].sort(),
            guardrails: [...node.outcomeContract.guardrails].sort(),
          },
        } : {}),
      }))
      .sort((left, right) => canonicalCompare(left.key, right.key)),
  };
}

/** Compute the canonical graph digest without trusting a persisted graphDigest. */
export function ecosystemMissionGraphDigest(
  graph: Omit<EcosystemMissionGraphV1, 'graphDigest'> | EcosystemMissionGraphV1,
): string {
  return createHash('sha256').update(canonicalJson(graphDigestPayload(graph)), 'utf8').digest('hex');
}

function validateText(
  value: unknown,
  maxLength: number,
  code: 'invalid-title' | 'invalid-objective' | 'invalid-acceptance',
  path: string,
  issues: MissionGraphValidationIssue[],
): string | null {
  const normalized = normalizedText(value);
  if (normalized === null || normalized.length > maxLength) {
    issues.push(issue(code, path, `must be a non-empty string of at most ${maxLength} characters`));
    return null;
  }
  return normalized;
}

function validateOutcomeContract(
  value: EcosystemMissionGraphNodeV1['outcomeContract'],
  path: string,
  issues: MissionGraphValidationIssue[],
): void {
  if (value === undefined) return;
  if (!value || !Array.isArray(value.successSignals) || !Array.isArray(value.guardrails) ||
    value.successSignals.length < 1 || value.successSignals.length > MAX_MISSION_GRAPH_ACCEPTANCE_CRITERIA ||
    value.guardrails.length < 1 || value.guardrails.length > MAX_MISSION_GRAPH_ACCEPTANCE_CRITERIA) {
    issues.push(issue('invalid-outcome-contract', path, 'outcome contract requires bounded successSignals and guardrails'));
    return;
  }
  const desiredOutcome = normalizedText(value.desiredOutcome);
  if (desiredOutcome === null || desiredOutcome.length > MAX_DELIVERABLE_LENGTH) {
    issues.push(issue('invalid-outcome-contract', `${path}.desiredOutcome`, `must be 1..${MAX_DELIVERABLE_LENGTH} characters`));
  }
  for (const [field, signals] of [
    ['successSignals', value.successSignals],
    ['guardrails', value.guardrails],
  ] as const) {
    signals.forEach((signal, index) => {
      const normalized = normalizedText(signal);
      if (normalized === null || normalized.length > MAX_ACCEPTANCE_LENGTH) {
        issues.push(issue('invalid-outcome-contract', `${path}.${field}[${index}]`, `must be 1..${MAX_ACCEPTANCE_LENGTH} characters`));
      }
    });
  }
}

function cycleMembers(nodes: readonly Pick<EcosystemMissionGraphNodeV1, 'key' | 'dependsOn'>[]): string[] {
  const remaining = new Map(nodes.map((node) => [node.key, new Set(node.dependsOn)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, dependencies] of remaining) {
      for (const dependency of [...dependencies]) {
        if (!remaining.has(dependency)) dependencies.delete(dependency);
      }
      if (dependencies.size === 0) {
        remaining.delete(key);
        changed = true;
      }
    }
  }
  return [...remaining.keys()].sort();
}

function structuralIssues(
  graph: EcosystemMissionGraphV1,
  checkDigest: boolean,
): MissionGraphValidationIssue[] {
  const issues: MissionGraphValidationIssue[] = [];
  const graphRecord = graph as unknown;
  if (!isPlainRecord(graphRecord) || !hasExactKeys(graphRecord, GRAPH_KEYS)) {
    issues.push(issue('invalid-schema', '$', 'mission graph must contain only the versioned schema fields'));
  }
  if (graph.schemaVersion !== ECOSYSTEM_MISSION_GRAPH_SCHEMA_VERSION || graph.digestAlgorithm !== 'sha256') {
    issues.push(issue('invalid-schema', '$', 'unsupported mission graph schema or digest algorithm'));
  }
  if (!validKey(graph.missionKey)) issues.push(issue('invalid-key', 'missionKey', 'invalid mission key'));
  validateText(graph.title, MAX_TITLE_LENGTH, 'invalid-title', 'title', issues);
  validateText(graph.objective, MAX_OBJECTIVE_LENGTH, 'invalid-objective', 'objective', issues);
  if (!validTimestamp(graph.createdAt)) issues.push(issue('invalid-created-at', 'createdAt', 'must be canonical ISO-8601'));
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_MISSION_GRAPH_NODES) {
    issues.push(issue('too-many-nodes', 'nodes', `must contain 1..${MAX_MISSION_GRAPH_NODES} nodes`));
    return issues;
  }

  const keys = new Set<string>();
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index]!;
    const path = `nodes[${index}]`;
    const nodeRecord = node as unknown;
    const expectedNodeKeys = isPlainRecord(nodeRecord) && Object.prototype.hasOwnProperty.call(nodeRecord, 'outcomeContract')
      ? NODE_WITH_OUTCOME_KEYS
      : NODE_KEYS;
    if (!isPlainRecord(nodeRecord) || !hasExactKeys(nodeRecord, expectedNodeKeys)) {
      issues.push(issue('invalid-schema', path, 'mission node must contain only the versioned schema fields'));
    }
    if (!validKey(node.key)) issues.push(issue('invalid-key', `${path}.key`, 'invalid node key'));
    else if (keys.has(node.key)) issues.push(issue('duplicate-node-key', `${path}.key`, `duplicate node key '${node.key}'`));
    else keys.add(node.key);
    if (node.kind !== 'work' && node.kind !== 'human-gate') {
      issues.push(issue('invalid-node-kind', `${path}.kind`, 'node kind must be work or human-gate'));
    }
    validateText(node.title, MAX_TITLE_LENGTH, 'invalid-title', `${path}.title`, issues);
    validateText(node.objective, MAX_OBJECTIVE_LENGTH, 'invalid-objective', `${path}.objective`, issues);
    const deliverable = normalizedText(node.deliverable);
    if (deliverable === null || deliverable.length > MAX_DELIVERABLE_LENGTH) {
      issues.push(issue('invalid-deliverable', `${path}.deliverable`, `must be 1..${MAX_DELIVERABLE_LENGTH} characters`));
    }
    if (node.riskClass !== 'low' && node.riskClass !== 'medium' && node.riskClass !== 'high') {
      issues.push(issue('invalid-risk-class', `${path}.riskClass`, 'risk class must be low, medium, or high'));
    }
    if (node.kind === 'work' && (typeof node.repo !== 'string' || !isAbsolute(node.repo))) {
      issues.push(issue('invalid-repository-target', `${path}.repo`, 'work node requires an absolute enrolled root'));
    }
    if (node.kind === 'human-gate' && node.repo !== null) {
      issues.push(issue('human-gate-repository-target', `${path}.repo`, 'human gate must be repository-neutral'));
    }
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length > MAX_MISSION_GRAPH_DEPENDENCIES) {
      issues.push(issue('too-many-dependencies', `${path}.dependsOn`, `must contain at most ${MAX_MISSION_GRAPH_DEPENDENCIES} dependencies`));
    } else {
      const dependencies = new Set<string>();
      for (let dependencyIndex = 0; dependencyIndex < node.dependsOn.length; dependencyIndex++) {
        const dependency = node.dependsOn[dependencyIndex]!;
        const dependencyPath = `${path}.dependsOn[${dependencyIndex}]`;
        if (!validKey(dependency)) issues.push(issue('invalid-key', dependencyPath, 'invalid dependency key'));
        else if (dependencies.has(dependency)) issues.push(issue('duplicate-dependency', dependencyPath, `duplicate dependency '${dependency}'`));
        else dependencies.add(dependency);
        if (dependency === node.key) issues.push(issue('self-dependency', dependencyPath, 'node cannot depend on itself'));
      }
    }
    if (!Array.isArray(node.acceptance) || node.acceptance.length < 1 ||
      node.acceptance.length > MAX_MISSION_GRAPH_ACCEPTANCE_CRITERIA) {
      issues.push(issue('too-many-acceptance-criteria', `${path}.acceptance`, `must contain 1..${MAX_MISSION_GRAPH_ACCEPTANCE_CRITERIA} criteria`));
    } else {
      node.acceptance.forEach((criterion, criterionIndex) => {
        validateText(criterion, MAX_ACCEPTANCE_LENGTH, 'invalid-acceptance', `${path}.acceptance[${criterionIndex}]`, issues);
      });
    }
    if (node.outcomeContract !== undefined) {
      const outcomeRecord = node.outcomeContract as unknown;
      if (!isPlainRecord(outcomeRecord) || !hasExactKeys(outcomeRecord, OUTCOME_CONTRACT_KEYS)) {
        issues.push(issue('invalid-outcome-contract', `${path}.outcomeContract`, 'outcome contract contains unknown fields'));
      }
    }
    validateOutcomeContract(node.outcomeContract, `${path}.outcomeContract`, issues);
  }

  for (let index = 0; index < graph.nodes.length; index++) {
    for (let dependencyIndex = 0; dependencyIndex < graph.nodes[index]!.dependsOn.length; dependencyIndex++) {
      const dependency = graph.nodes[index]!.dependsOn[dependencyIndex]!;
      if (validKey(dependency) && !keys.has(dependency)) {
        issues.push(issue('missing-dependency', `nodes[${index}].dependsOn[${dependencyIndex}]`, `unknown dependency '${dependency}'`));
      }
    }
  }
  if (!issues.some((entry) => entry.code === 'missing-dependency' || entry.code === 'duplicate-node-key')) {
    const cyclic = cycleMembers(graph.nodes);
    if (cyclic.length > 0) {
      issues.push(issue('cyclic-dependency', 'nodes', `dependency cycle includes: ${cyclic.join(', ')}`));
    }
  }
  try {
    if (Buffer.byteLength(canonicalJson(graphDigestPayload(graph)), 'utf8') > MAX_MISSION_GRAPH_CANONICAL_BYTES) {
      issues.push(issue('graph-too-large', '$', `canonical graph exceeds ${MAX_MISSION_GRAPH_CANONICAL_BYTES} bytes`));
    }
  } catch {
    issues.push(issue('invalid-schema', '$', 'graph is not canonically serializable'));
  }
  if (checkDigest && ecosystemMissionGraphDigest(graph) !== graph.graphDigest) {
    issues.push(issue('digest-mismatch', 'graphDigest', 'graph digest does not match canonical content'));
  }
  return issues;
}

/** Validate a persisted graph, including its canonical digest. */
export function validateEcosystemMissionGraph(graph: EcosystemMissionGraphV1): MissionGraphValidationIssue[] {
  try {
    return structuralIssues(graph, true);
  } catch {
    return [issue('invalid-schema', '$', 'mission graph is structurally invalid')];
  }
}

function resolveRepoTarget(
  target: unknown,
  enrolledRepos: readonly string[],
): { repo: string | null; issue?: MissionGraphValidationIssue } {
  const normalized = normalizedText(target);
  if (normalized === null) {
    return { repo: null, issue: issue('invalid-repository-target', '', 'work node requires a repository target') };
  }
  const enrolled = [...new Set(enrolledRepos
    .filter((repo): repo is string => typeof repo === 'string' && repo.trim().length > 0 &&
      isAbsolute(repo) && resolve(repo) === repo)
    .map((repo) => repo.normalize('NFC')))].sort();
  if (isAbsolute(normalized)) {
    const exact = normalized.normalize('NFC');
    if (resolve(exact) !== exact) {
      return { repo: null, issue: issue('invalid-repository-target', '', 'absolute repository targets must be canonical roots') };
    }
    return enrolled.includes(exact)
      ? { repo: exact }
      : { repo: null, issue: issue('repository-not-enrolled', '', `'${normalized}' is not enrolled`) };
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    return { repo: null, issue: issue('invalid-repository-target', '', 'relative repository targets must be exact basenames') };
  }
  const matches = enrolled.filter((repo) => basename(repo) === normalized);
  if (matches.length === 1) return { repo: matches[0]! };
  if (matches.length > 1) {
    return { repo: null, issue: issue('repository-target-ambiguous', '', `basename '${normalized}' matches multiple enrolled roots`) };
  }
  return { repo: null, issue: issue('repository-not-enrolled', '', `'${normalized}' is not enrolled`) };
}

/** Compile untrusted planning input into a canonical, bounded mission graph. */
function compileEcosystemMissionGraphInternal(
  input: MissionGraphInput,
  enrolledRepos: readonly string[],
): MissionGraphCompileResult {
  const issues: MissionGraphValidationIssue[] = [];
  if (!validKey(input.missionKey)) issues.push(issue('invalid-key', 'missionKey', 'invalid mission key'));
  const title = validateText(input.title, MAX_TITLE_LENGTH, 'invalid-title', 'title', issues);
  const objective = validateText(input.objective, MAX_OBJECTIVE_LENGTH, 'invalid-objective', 'objective', issues);
  if (!validTimestamp(input.createdAt)) issues.push(issue('invalid-created-at', 'createdAt', 'must be canonical ISO-8601'));
  if (!Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_MISSION_GRAPH_NODES) {
    issues.push(issue('too-many-nodes', 'nodes', `must contain 1..${MAX_MISSION_GRAPH_NODES} nodes`));
  }

  const nodes: EcosystemMissionGraphNodeV1[] = [];
  for (let index = 0; index < Math.min(input.nodes?.length ?? 0, MAX_MISSION_GRAPH_NODES + 1); index++) {
    const candidate = input.nodes[index]!;
    const path = `nodes[${index}]`;
    const nodeTitle = validateText(candidate.title, MAX_TITLE_LENGTH, 'invalid-title', `${path}.title`, issues);
    const nodeObjective = validateText(candidate.objective, MAX_OBJECTIVE_LENGTH, 'invalid-objective', `${path}.objective`, issues);
    const deliverable = normalizedText(candidate.deliverable);
    if (deliverable === null || deliverable.length > MAX_DELIVERABLE_LENGTH) {
      issues.push(issue('invalid-deliverable', `${path}.deliverable`, `must be 1..${MAX_DELIVERABLE_LENGTH} characters`));
    }
    if (candidate.riskClass !== 'low' && candidate.riskClass !== 'medium' && candidate.riskClass !== 'high') {
      issues.push(issue('invalid-risk-class', `${path}.riskClass`, 'risk class must be low, medium, or high'));
    }
    if (!validKey(candidate.key)) issues.push(issue('invalid-key', `${path}.key`, 'invalid node key'));
    if (candidate.kind !== 'work' && candidate.kind !== 'human-gate') {
      issues.push(issue('invalid-node-kind', `${path}.kind`, 'node kind must be work or human-gate'));
    }
    const dependsOn = Array.isArray(candidate.dependsOn) ? [...candidate.dependsOn].sort() : [];
    const acceptance = Array.isArray(candidate.acceptance) ? [...candidate.acceptance]
      .map((criterion) => normalizedText(criterion) ?? '')
      .sort() : [];
    const outcomeContract = candidate.outcomeContract === undefined ? undefined : {
      desiredOutcome: normalizedText(candidate.outcomeContract.desiredOutcome) ?? '',
      successSignals: Array.isArray(candidate.outcomeContract.successSignals)
        ? [...candidate.outcomeContract.successSignals].map((signal) => normalizedText(signal) ?? '').sort()
        : [],
      guardrails: Array.isArray(candidate.outcomeContract.guardrails)
        ? [...candidate.outcomeContract.guardrails].map((guardrail) => normalizedText(guardrail) ?? '').sort()
        : [],
    };
    let repo: string | null = null;
    if (candidate.kind === 'human-gate') {
      if (candidate.targetRepo !== undefined && candidate.targetRepo !== null) {
        issues.push(issue('human-gate-repository-target', `${path}.targetRepo`, 'human gate must be repository-neutral'));
      }
    } else if (candidate.kind === 'work') {
      const resolved = resolveRepoTarget(candidate.targetRepo, enrolledRepos);
      repo = resolved.repo;
      if (resolved.issue) issues.push({ ...resolved.issue, path: `${path}.targetRepo` });
    }
    nodes.push({
      kind: candidate.kind,
      key: candidate.key,
      title: nodeTitle ?? '',
      objective: nodeObjective ?? '',
      deliverable: deliverable ?? '',
      riskClass: candidate.riskClass,
      repo,
      dependsOn,
      acceptance,
      ...(outcomeContract ? { outcomeContract } : {}),
    });
  }

  const base: Omit<EcosystemMissionGraphV1, 'graphDigest'> = {
    schemaVersion: ECOSYSTEM_MISSION_GRAPH_SCHEMA_VERSION,
    digestAlgorithm: 'sha256',
    missionKey: input.missionKey,
    title: title ?? '',
    objective: objective ?? '',
    createdAt: input.createdAt,
    nodes: nodes.sort((left, right) => canonicalCompare(left.key, right.key)),
  };
  const graph: EcosystemMissionGraphV1 = { ...base, graphDigest: ecosystemMissionGraphDigest(base) };
  issues.push(...structuralIssues(graph, false));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, graph, issues: [] };
}

export function compileEcosystemMissionGraph(
  input: MissionGraphInput,
  enrolledRepos: readonly string[],
): MissionGraphCompileResult {
  try {
    return compileEcosystemMissionGraphInternal(input, enrolledRepos);
  } catch {
    return {
      ok: false,
      issues: [issue('invalid-schema', '$', 'mission graph input is structurally invalid')],
    };
  }
}

/** Project read-only mission/node statuses from already-observed lifecycle evidence. */
export function projectEcosystemMissionGraph(
  graph: EcosystemMissionGraphV1,
  observations: readonly MissionNodeObservation[],
): MissionGraphProjectionResult {
  const issues = validateEcosystemMissionGraph(graph);
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const observationByKey = new Map<string, MissionNodeObservation>();
  for (let index = 0; index < observations.length; index++) {
    const observation = observations[index]!;
    const path = `observations[${index}]`;
    if (!nodeByKey.has(observation.nodeKey)) {
      issues.push(issue('unknown-observation-node', `${path}.nodeKey`, `unknown node '${observation.nodeKey}'`));
      continue;
    }
    if (observationByKey.has(observation.nodeKey)) {
      issues.push(issue('duplicate-observation', `${path}.nodeKey`, `duplicate observation for '${observation.nodeKey}'`));
      continue;
    }
    const node = nodeByKey.get(observation.nodeKey)!;
    if ((node.kind === 'human-gate' && observation.state !== undefined) ||
      (node.kind === 'work' && observation.humanApproved !== undefined)) {
      issues.push(issue('invalid-observation', path, `observation fields do not match ${node.kind} node`));
      continue;
    }
    observationByKey.set(observation.nodeKey, observation);
  }
  if (issues.length > 0) return { ok: false, issues };

  const projections = new Map<string, MissionNodeProjection>();
  const pending = new Map(graph.nodes.map((node) => [node.key, node]));
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((node) => node.dependsOn.every((dependency) => projections.has(dependency)))
      .sort((left, right) => canonicalCompare(left.key, right.key));
    if (ready.length === 0) {
      return { ok: false, issues: [issue('cyclic-dependency', 'nodes', 'projection cannot order dependency graph')] };
    }
    for (const node of ready) {
      const observation = observationByKey.get(node.key);
      const blockedBy = node.dependsOn.filter((dependency) => projections.get(dependency)!.status !== 'complete');
      let status: MissionNodeProjectionStatus;
      if (blockedBy.length > 0) status = 'blocked';
      else if (node.kind === 'human-gate') status = observation?.humanApproved === true ? 'complete' : 'awaiting-human';
      else if (observation?.state === 'failed') status = 'failed';
      else if (observation?.state === 'realized') status = 'complete';
      else if (observation?.state === 'proposed') status = 'proposed';
      else if (observation?.state === 'active') status = 'active';
      else status = 'ready';
      projections.set(node.key, {
        key: node.key,
        kind: node.kind,
        repo: node.repo,
        status,
        blockedBy,
        observedState: observation?.state ?? null,
      });
      pending.delete(node.key);
    }
  }

  const nodes = graph.nodes.map((node) => projections.get(node.key)!);
  const statuses: MissionNodeProjectionStatus[] = [
    'blocked', 'ready', 'active', 'proposed', 'awaiting-human', 'complete', 'failed',
  ];
  const counts = Object.fromEntries(statuses.map((status) => [
    status,
    nodes.filter((node) => node.status === status).length,
  ])) as Record<MissionNodeProjectionStatus, number>;
  const status: MissionGraphProjection['status'] = counts.failed > 0
    ? 'failed'
    : counts.complete === nodes.length
      ? 'complete'
      : counts.active + counts.proposed > 0
        ? 'in-progress'
        : counts['awaiting-human'] > 0
          ? 'awaiting-human'
          : counts.ready > 0
            ? 'ready'
            : 'blocked';
  return { ok: true, projection: { graphDigest: graph.graphDigest, status, counts, nodes }, issues: [] };
}
