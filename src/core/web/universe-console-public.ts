import type { UniverseOverview } from '../universe/types.js';
import type { UniverseGraph } from '../universe/graph-types.js';
import type { UniverseCampaignReadiness } from '../universe/campaign-readiness.js';
import type { UniversePortfolioControllerReport } from '../universe/portfolio-controller-types.js';
import type { UniverseCampaignReadinessView, UniversePortfolioControllerView } from './universe-console-types.js';
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

/** Explicit fields prevent private CAS witnesses or future authority from reaching browsers. */
export function projectUniverseConsoleCampaignReadiness(readiness: UniverseCampaignReadiness): UniverseCampaignReadinessView {
  return { schemaVersion: readiness.schemaVersion, readinessScope: readiness.readinessScope,
    campaignId: readiness.campaignId, universeId: readiness.universeId, observedState: readiness.observedState,
    sourceState: readiness.sourceState, disposition: readiness.disposition, reasonCode: readiness.reasonCode,
    resourceRuntimeRequired: readiness.resourceRuntimeRequired, sampledAt: readiness.sampledAt };
}

export function serializeUniverseConsoleCampaignReadiness(readiness: UniverseCampaignReadiness): string {
  return serialize(projectUniverseConsoleCampaignReadiness(readiness));
}

/** No private digests, future fields or execution authority leave the reader. */
export function projectUniverseConsoleControllerStatus(report: UniversePortfolioControllerReport): UniversePortfolioControllerView {
  const view: UniversePortfolioControllerView = {
    schemaVersion: report.schemaVersion, controllerId: report.controllerId,
    sourceState: report.sourceState, status: report.status, createdAt: report.createdAt,
    deadlineAt: report.deadlineAt, observedAt: report.observedAt, reasons: [...report.reasons],
    outcomes: report.outcomes.map((outcome) => ({ campaignId: outcome.campaignId,
      state: outcome.state, attempted: outcome.attempted, reasonCode: outcome.reasonCode })),
  };
  if (report.control) view.control = { mode: report.control.mode, sequence: report.control.sequence,
    requestedAt: report.control.requestedAt, acknowledgedAt: report.control.acknowledgedAt };
  if (report.topology) view.topology = report.topology.map((node) => ({ campaignId: node.campaignId,
    dependsOn: [...node.dependsOn], prerequisites: [...node.prerequisites] }));
  return view;
}

export function serializeUniverseConsoleControllerStatus(report: UniversePortfolioControllerReport): string {
  return serialize(projectUniverseConsoleControllerStatus(report));
}

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
