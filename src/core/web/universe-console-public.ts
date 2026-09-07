import type { UniverseOverview } from '../universe/types.js';
import type { UniverseGraph } from '../universe/graph-types.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES = 16 * 1024 * 1024;

function serialize(value: unknown): string {
  const encoded = JSON.stringify(sanitizePublicJson(value));
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES) {
    throw new Error('Universe console projection exceeds its response byte budget');
  }
  return encoded;
}

/** Runs inside the dedicated bounded worker, including recursive redaction and serialization. */
export function serializeUniverseConsoleOverview(overview: UniverseOverview): string {
  const redactRun = (run: UniverseOverview['universes'][number]['runs'][number]) => ({ ...run,
    trials: run.trials.map((trial) => ({ ...trial, ...(trial.diagnostics ? {
      diagnostics: trial.diagnostics.map(({ code }) => ({ code, message: '[omitted from web view]' })),
    } : {}) })) });
  return serialize({ ...overview, universes: overview.universes.map((universe) => ({ ...universe,
    runs: universe.runs.map(redactRun), activeRun: universe.activeRun ? redactRun(universe.activeRun) : null })) });
}

export function serializeUniverseConsoleGraph(graph: UniverseGraph): string { return serialize(graph); }

/** Bound the fixed worker protocol before passing its already-public JSON to HTTP. */
export function validateUniverseConsoleResponse(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_UNIVERSE_CONSOLE_RESPONSE_BYTES) throw new Error('Invalid Universe console response');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Invalid Universe console response'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error('Invalid Universe console response');
  return value;
}
