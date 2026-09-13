import { isAbsolute, resolve } from 'node:path';
import { inspectPrivateDirectory } from './artifacts.js';
import { readControlGraph, type ControlGraphReport } from './control-graph.js';
import { queryDecisionTracesV1, type DecisionTraceKeyOptions, type DecisionTraceQueryV1 } from './decision-trace.js';

const SCOPE = 'Read-only persisted graph inspection. HMAC verification covers the loaded history and its chain; it does not establish execution authority, verifier independence, liveness or rollback protection. Query filtering performs structural validation only after history verification.';

export interface FirmGraphReadOptions {
  /** Explicit existing canonical private directory. */
  root: string;
  /** Inert library fixtures only; the CLI accepts no key option. */
  traceKeys?: DecisionTraceKeyOptions;
}

export interface FirmGraphReport {
  schemaVersion: 1;
  /** Evidence availability, separate from graph execution status. */
  status: 'available' | 'missing' | 'unavailable';
  integrityVerified: boolean;
  signatureVerification: 'verified-history' | 'not-verified';
  keyScope: 'injected-fixture-key' | 'existing-host-key';
  scope: string;
  guidance: string;
  graph: ControlGraphReport;
}

function snapshotOptions(options: FirmGraphReadOptions): FirmGraphReadOptions {
  if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      !Object.hasOwn(options, 'root') || Reflect.ownKeys(options).some((key) => typeof key !== 'string' ||
        !['root', 'traceKeys'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key)!, 'value'))) {
    throw new Error('Invalid firm graph options');
  }
  const { root, traceKeys } = options;
  if (typeof root !== 'string' || !root.length || root.length > 4096 ||
      Array.from(root).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      !isAbsolute(root) || resolve(root) !== root) throw new Error('Invalid firm graph root');
  inspectPrivateDirectory(root);
  if (traceKeys === undefined) return { root };
  if (!traceKeys || typeof traceKeys !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(traceKeys)) ||
      Reflect.ownKeys(traceKeys).length !== 1 || !Object.hasOwn(Object.getOwnPropertyDescriptor(traceKeys, 'testKey') ?? {}, 'value') ||
      !Buffer.isBuffer(traceKeys.testKey) || traceKeys.testKey.length !== 32) throw new Error('Invalid fixture key');
  return { root, traceKeys: { testKey: Buffer.from(traceKeys.testKey) } };
}

/** Uses only the verifying reader: never acquires execution ownership or repairs evidence. */
export function readFirmGraph(options: FirmGraphReadOptions): FirmGraphReport {
  const config = snapshotOptions(options);
  const graph = readControlGraph(config.root, config.traceKeys);
  const integrityVerified = graph.sourceState === 'healthy';
  return { schemaVersion: 1, status: integrityVerified ? 'available' : graph.sourceState === 'missing' ? 'missing' : 'unavailable',
    integrityVerified, signatureVerification: integrityVerified ? 'verified-history' : 'not-verified',
    keyScope: config.traceKeys ? 'injected-fixture-key' : 'existing-host-key', scope: SCOPE,
    guidance: integrityVerified ? 'Inspect node states and signed verdicts; graph completion is reported separately.' :
      graph.sourceState === 'missing' ? 'No persisted graph was found under this root. Select an existing graph root.' :
        'History could not be verified. Check root custody, record completeness and the existing signing key; preserve evidence before repair.',
    graph };
}

/** Filters only fully verified history, preserving conflict links outside the selected page. */
export function queryFirmGraph(options: FirmGraphReadOptions, query: DecisionTraceQueryV1 = {}) {
  // Validate filters even when evidence is missing, before any filesystem read.
  queryDecisionTracesV1([], query);
  const { graph, ...report } = readFirmGraph(options);
  return { ...report, sourceState: graph.sourceState, graphStatus: graph.status,
    graphId: graph.graphId, definitionDigest: graph.definitionDigest, reasons: graph.reasons,
    query: queryDecisionTracesV1(report.integrityVerified ? graph.traces : [], query) };
}
