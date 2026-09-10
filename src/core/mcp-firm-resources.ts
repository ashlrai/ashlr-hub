/** SDK-free, read-only signed graph resources. No audit, enrollment, or key creation.
 * The surrounding gateway retains its existing startup and native-tool behavior.
 */
import { isAbsolute, resolve } from 'node:path';
import { loadConfigReadOnlyStrict } from './config.js';
import { inspectPrivateDirectory } from './universe/artifacts.js';
import { readFirmGraph, queryFirmGraph } from './universe/firm-graph.js';
import { queryDecisionTracesV1, type DecisionTraceQueryV1 } from './universe/decision-trace.js';

export const FIRM_GRAPH_URI = 'ashlr://firm/graph';
export const FIRM_TRACES_URI = 'ashlr://firm/traces';
export const MAX_FIRM_RESOURCE_BYTES = 64 * 1024;
const MIME = 'application/json';
const DESCRIPTION = 'Read-only signed history from the explicitly configured firm root. Verification proves history integrity, not execution authority, liveness, or rollback protection.';

function configuredRoot(): string {
  const firm = loadConfigReadOnlyStrict().firm;
  if (!firm || typeof firm !== 'object' || Array.isArray(firm) ||
      Object.keys(firm).some((key) => key !== 'graphRoot')) throw new Error('Firm configuration unavailable');
  const root = firm.graphRoot;
  if (typeof root !== 'string' || !root.length || root.length > 4096 ||
      [...root].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      !isAbsolute(root) || resolve(root) !== root) {
    throw new Error('Firm configuration unavailable');
  }
  return inspectPrivateDirectory(root);
}

export function listFirmResources() {
  try { configuredRoot(); } catch { return { resources: [] }; }
  return { resources: [
    { uri: FIRM_GRAPH_URI, name: 'Signed firm graph', description: DESCRIPTION, mimeType: MIME },
    { uri: FIRM_TRACES_URI, name: 'Signed firm traces', description: DESCRIPTION, mimeType: MIME },
  ] };
}

export function listFirmResourceTemplates() {
  try { configuredRoot(); } catch { return { resourceTemplates: [] }; }
  return { resourceTemplates: [{
    uriTemplate: `${FIRM_TRACES_URI}{?entity,action,since,until,limit}`,
    name: 'Filter signed firm traces', mimeType: MIME,
    description: `${DESCRIPTION} Inclusive UTC ISO times; limit 1..256, default 100. Conflict links are retained.`,
  }] };
}

function parseUri(uri: unknown): { uri: string; query?: DecisionTraceQueryV1 } {
  if (uri === FIRM_GRAPH_URI) return { uri };
  if (typeof uri !== 'string' || uri.length > 4096 || uri.includes('#') ||
      [...uri].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
      !(uri === FIRM_TRACES_URI || uri.startsWith(`${FIRM_TRACES_URI}?`))) throw new Error('Invalid resource URI');
  const raw = uri.slice(FIRM_TRACES_URI.length);
  if (raw === '?' || /%(?![\da-f]{2})/i.test(raw)) throw new Error('Invalid resource URI');
  const query: DecisionTraceQueryV1 = {};
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    if (seen.has(key) || !['entity', 'action', 'since', 'until', 'limit'].includes(key)) throw new Error('Invalid resource URI');
    seen.add(key);
    if (key === 'limit') {
      if (!/^[1-9]\d{0,2}$/.test(value)) throw new Error('Invalid query limit');
      query.limit = Number(value);
    } else query[key as 'entity' | 'action' | 'since' | 'until'] = value;
  }
  queryDecisionTracesV1([], query);
  return { uri, query };
}

function unavailable(reason: string) {
  return { schemaVersion: 1, status: 'unavailable', integrityVerified: false,
    signatureVerification: 'not-verified', reason };
}

/** Exact JSON bytes are retained: truncating or scrubbing signed evidence would change it. */
export function readFirmResource(uri: unknown) {
  let selected: ReturnType<typeof parseUri>;
  try { selected = parseUri(uri); }
  catch { return response(FIRM_GRAPH_URI, unavailable('invalid-firm-resource-uri')); }
  let root: string;
  try { root = configuredRoot(); }
  catch { return response(selected.uri, unavailable('firm-configuration-unavailable')); }
  try {
    return response(selected.uri, selected.query === undefined ? readFirmGraph({ root }) : queryFirmGraph({ root }, selected.query));
  } catch { return response(selected.uri, unavailable('firm-graph-input-or-evidence-unavailable')); }
}

function response(uri: string, payload: unknown) {
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > MAX_FIRM_RESOURCE_BYTES) {
    text = JSON.stringify(unavailable('firm-resource-output-limit-exceeded'));
  }
  return { contents: [{ uri, mimeType: MIME, text }] };
}
