import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { readControlGraph, runControlGraph, type ControlGraphDefinition, type ControlGraphReport, type ControlGraphHandler } from './control-graph.js';
import { verifyUniverseCold } from './cold-verifier.js';
import { queryDecisionTracesV1, type DecisionTraceKeyOptions, type DecisionTraceV1 } from './decision-trace.js';

const GRAPH_ID = 'firm-inert-xor-v1';
const SPEC = { schemaVersion: 1, operation: 'boolean-exclusive-or', inputOrder: [[false, false], [false, true], [true, false], [true, true]] };
const SPEC_DIGEST = digest(canonical(SPEC));
const ALTERNATIVES = [
  { id: 'sum-of-products', description: 'Exactly one input is true: (left AND NOT right) OR (NOT left AND right).' },
  { id: 'inequality', description: 'The two boolean inputs have different values.' },
];
const SCOPE = 'Inert declarative fixture; no model/provider work, candidate command execution or delivery. Distinct enrolled checker IDs are attested metadata, not process isolation. Signature integrity does not grant execution authority.';

export interface FirmDemoOptions {
  /** Existing canonical private directory; no implicit home or default root. */
  root: string;
  /** Inert library tests only. The CLI never accepts a key. */
  traceKeys?: DecisionTraceKeyOptions;
  /** Cancels new admission while the graph drains its active trusted handler. */
  signal?: AbortSignal;
}
export interface FirmDemoReport {
  schemaVersion: 1;
  status: 'accepted-fixture' | 'incomplete' | 'unavailable' | 'stopped';
  scope: string;
  specDigest: string;
  declaredAlternatives: Array<{ id: string; description: string }>;
  checks: { positiveVerified: boolean; intentionalLiarRejected: boolean; plantedConflictPreserved: boolean };
  counts: { completedNodes: number; rejectedNodes: number; traces: number; conflictLinks: number };
  graph: ControlGraphReport;
}

function optionsSnapshot(options: FirmDemoOptions): FirmDemoOptions {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      !Object.hasOwn(options, 'root') || Reflect.ownKeys(options).some((key) => typeof key !== 'string' ||
        !['root', 'traceKeys', 'signal'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) {
    throw new Error('Invalid firm demo options');
  }
  if (typeof options.root !== 'string' || !options.root.length || options.root.length > 4096 ||
      Array.from(options.root).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      !isAbsolute(options.root) || resolve(options.root) !== options.root) {
    throw new Error('Invalid firm demo root');
  }
  const root = inspectPrivateDirectory(options.root);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid firm demo signal');
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  if (options.traceKeys === undefined) return { root, ...signal };
  const keys = options.traceKeys;
  if (!keys || typeof keys !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(keys)) ||
      Reflect.ownKeys(keys).length !== 1 || !Object.hasOwn(Object.getOwnPropertyDescriptor(keys, 'testKey') ?? {}, 'value') ||
      !Buffer.isBuffer(keys.testKey) || keys.testKey.length !== 32) throw new Error('Invalid fixture key');
  return { root, ...signal, traceKeys: { testKey: Buffer.from(keys.testKey) } };
}

/** Fixed graph only: callers cannot supply code, commands, models or handlers. */
function definition(): ControlGraphDefinition {
  return { schemaVersion: 1, id: GRAPH_ID, maxConcurrent: 1, maxDurationMs: 60_000, nodes: [
    { id: 'plan', kind: 'plan', requires: [], input: { specDigest: SPEC_DIGEST, alternatives: ALTERNATIVES } },
    { id: 'implement', kind: 'implement', requires: ['plan'], input: { fixture: 'positive' } },
    { id: 'verify', kind: 'verify', requires: ['implement'], input: { specDigest: SPEC_DIGEST } },
    { id: 'implement-liar', kind: 'implement', requires: ['plan', 'verify'], input: { fixture: 'intentional-liar' } },
    { id: 'verify-liar', kind: 'verify', requires: ['implement-liar'], input: { specDigest: SPEC_DIGEST } },
  ] };
}

function settled(graph: ControlGraphReport, id: string): DecisionTraceV1 | undefined {
  return graph.traces.find((trace) => trace.action === 'graph-settled' && trace.entities.includes(`node:${id}`));
}
function summarize(graph: ControlGraphReport): FirmDemoReport {
  const matches = graph.sourceState === 'healthy' && graph.graphId === GRAPH_ID && graph.definitionDigest === digest(canonical(definition()));
  const positive = matches ? settled(graph, 'verify') : undefined;
  const negative = matches ? settled(graph, 'verify-liar') : undefined;
  const positiveVerified = !!positive && positive.verifier.verdict === 'pass' && positive.verifier.independent &&
    graph.nodes.some((node) => node.id === 'verify' && node.state === 'completed');
  const intentionalLiarRejected = !!negative && negative.verifier.verdict === 'fail' && negative.verifier.independent &&
    graph.nodes.some((node) => node.id === 'verify-liar' && node.state === 'rejected');
  const plantedConflictPreserved = !!positive && !!negative && negative.conflicts.some((link) => link.otherId === positive.id && link.reason === 'value');
  const accepted = positiveVerified && intentionalLiarRejected && plantedConflictPreserved &&
    graph.nodes.filter((node) => node.state === 'completed').length === 4 && graph.nodes.length === 5;
  return { schemaVersion: 1,
    status: graph.status === 'stopped' ? 'stopped' : graph.status === 'unavailable' || graph.sourceState === 'degraded' ||
      graph.sourceState === 'healthy' && !matches ? 'unavailable' : accepted ? 'accepted-fixture' : 'incomplete',
    scope: SCOPE, specDigest: SPEC_DIGEST, declaredAlternatives: ALTERNATIVES.map((row) => ({ ...row })),
    checks: { positiveVerified, intentionalLiarRejected, plantedConflictPreserved },
    counts: { completedNodes: graph.nodes.filter((node) => node.state === 'completed').length,
      rejectedNodes: graph.nodes.filter((node) => node.state === 'rejected').length,
      traces: graph.traces.length, conflictLinks: graph.traces.reduce((sum, trace) => sum + trace.conflicts.length, 0) }, graph };
}

export function readFirmDemo(options: FirmDemoOptions): FirmDemoReport {
  const config = optionsSnapshot(options);
  return summarize(readControlGraph(config.root, config.traceKeys));
}

/** The graph reader verifies HMAC integrity first; the bounded query preserves out-of-page conflict links. */
export function queryFirmDemo(options: FirmDemoOptions, query: { entity?: string; limit?: number } = {}) {
  const report = readFirmDemo(options);
  const integrityVerified = report.graph.sourceState === 'healthy' && report.graph.graphId === GRAPH_ID &&
    report.graph.definitionDigest === digest(canonical(definition()));
  return { schemaVersion: 1 as const, status: report.status, scope: SCOPE, integrityVerified,
    keyScope: options.traceKeys ? 'injected-fixture-key' as const : 'existing-host-key' as const,
    query: queryDecisionTracesV1(integrityVerified ? report.graph.traces : [], query) };
}

/** Run once or inspect the same durable graph on replay; interrupted intents are never silently re-executed. */
export async function runFirmDemo(options: FirmDemoOptions): Promise<FirmDemoReport> {
  const config = optionsSnapshot(options);
  const plannedArtifact = {
    schemaVersion: 1, specDigest: SPEC_DIGEST, alternatives: ALTERNATIVES, selected: 'sum-of-products',
  };
  const plan: ControlGraphHandler = async () => ({ artifact: plannedArtifact });
  const implement: ControlGraphHandler = async ({ node, artifacts }) => {
    const selected = artifacts.find((artifact) => artifact.nodeId === 'plan');
    if (!selected || canonical(selected.value) !== canonical(plannedArtifact)) {
      throw new Error('Pinned plan unavailable');
    }
    // Declarative output, not executable source. The negative fixture deliberately lies about its log.
    return { artifact: { schemaVersion: 1, specDigest: SPEC_DIGEST,
      rows: [[false, false, false], [false, true, true], [true, false, true], [true, true, node.id === 'implement-liar']],
      testLog: 'Claim: 4 of 4 rows pass.' } };
  };
  const verify: ControlGraphHandler = async ({ node, artifacts, signal }) => {
    const liar = node.id === 'verify-liar';
    const candidate = artifacts.find((artifact) => artifact.nodeId === (liar ? 'implement-liar' : 'implement'));
    if (!candidate) throw new Error('Candidate unavailable');
    const builder = liar ? 'fixture-builder-liar' : 'fixture-builder';
    const checker = liar ? 'fixture-checker-liar' : 'fixture-checker';
    let checkedRows = 0;
    const result = await verifyUniverseCold({ schemaVersion: 1, specDigest: SPEC_DIGEST,
      candidateDiff: canonical(candidate.value), testLog: 'Claim: 4 of 4 rows pass.' }, {
      builderExecutionId: builder, verifierExecutionId: checker, enrolledExecutionIds: [builder, checker],
      maxDurationMs: 1_000, signal,
      transport: (request, context) => {
        // Independently resolve the pinned spec and check every row. Never trust the supplied log.
        const value = JSON.parse(request.candidateDiff) as { schemaVersion?: unknown; specDigest?: unknown; rows?: unknown; testLog?: unknown };
        let passes = request.specDigest === SPEC_DIGEST && value.schemaVersion === 1 && value.specDigest === SPEC_DIGEST &&
          Object.keys(value).sort().join(',') === 'rows,schemaVersion,specDigest,testLog' && Array.isArray(value.rows) && value.rows.length === 4;
        if (passes && Array.isArray(value.rows)) {
          for (let index = 0; index < 4; index++) {
            const row: unknown = value.rows[index];
            const [left, right] = SPEC.inputOrder[index]!;
            checkedRows++;
            if (!Array.isArray(row) || row.length !== 3 || row[0] !== left || row[1] !== right || row[2] !== (left !== right)) passes = false;
          }
        }
        return { inputDigest: request.inputDigest, invocationId: context.invocationId, executionId: context.executionId,
          verdict: passes ? 'pass' : 'fail' };
      },
    });
    const positive = liar ? settled(readControlGraph(config.root, config.traceKeys), 'verify') : undefined;
    if (liar && !positive) throw new Error('Conflict source unavailable');
    return { artifact: { schemaVersion: 1, fixture: liar ? 'intentional-liar' : 'positive', checkedRows, result,
      independenceScope: 'Distinct enrolled IDs and independent in-process checker; not process isolation.' },
    verifier: { id: checker, verdict: result.verdict, independent: result.independent },
    conflicts: positive ? [{ otherId: positive.id, reason: 'value' }] : [] };
  };
  return summarize(await runControlGraph(definition(), { ...config, handlers: { plan, implement, verify } }));
}
import { isAbsolute, resolve } from 'node:path';
