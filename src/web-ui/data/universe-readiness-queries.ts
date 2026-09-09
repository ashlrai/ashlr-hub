import type { UniverseCampaignReadinessView } from '../../core/web/universe-console-types.js';
import { apiGet } from './client.js';
import type { QueryDef } from './queries.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELDS = ['schemaVersion', 'readinessScope', 'campaignId', 'universeId', 'observedState', 'sourceState',
  'disposition', 'reasonCode', 'resourceRuntimeRequired', 'sampledAt'];
const STATES = ['ready', 'running', 'pause-requested', 'stop-requested', 'paused', 'interrupted', 'completed', 'stopped', 'failed'];
const DISPOSITIONS: Record<UniverseCampaignReadinessView['disposition'], true> = {
  startable: true, owned: true, 'owner-held': true, 'resource-withheld': true, 'recovery-required': true,
  'attention-required': true, 'budget-exhausted': true, terminal: true, unavailable: true,
};
const REASONS: Record<UniverseCampaignReadinessView['reasonCode'], true> = {
  'never-started': true, 'owner-active': true, 'pause-requested': true, 'stop-requested': true, 'owner-paused': true,
  'owner-abandoned': true, 'run-incomplete': true, 'resource-withheld': true, 'resource-outcome-ambiguous': true,
  'resource-attention-required': true, 'generation-attention-required': true, 'duration-budget-exhausted': true, 'generation-budget-exhausted': true,
  'stagnation-budget-exhausted': true, 'request-budget-exhausted': true, 'reported-token-budget-exhausted': true,
  'usage-unavailable': true, 'campaign-completed': true, 'campaign-stopped': true, 'campaign-failed': true,
  'paused-unclassified': true, 'interrupted-unclassified': true, 'campaign-missing': true, 'evidence-degraded': true, 'snapshot-changed': true,
};

/** Reject mismatched identities and uncontracted/private fields before they reach the view. */
export function validateUniverseCampaignReadinessView(value: unknown, campaignId: string, universeId: string): UniverseCampaignReadinessView {
  const invalid = () => new Error('Recorded campaign check is unavailable.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const report = value as Record<string, unknown>;
  if (Object.keys(report).length !== FIELDS.length || Object.keys(report).some((field) => !FIELDS.includes(field)) ||
    report.schemaVersion !== 1 || report.readinessScope !== 'recorded-campaign-evidence' || report.campaignId !== campaignId ||
    typeof report.sourceState !== 'string' || !['healthy', 'missing', 'degraded'].includes(report.sourceState) ||
    !(report.universeId === universeId || report.universeId === null && report.sourceState !== 'healthy') ||
    !(report.observedState === null && report.sourceState !== 'healthy' || typeof report.observedState === 'string' && STATES.includes(report.observedState)) ||
    typeof report.disposition !== 'string' || !Object.hasOwn(DISPOSITIONS, report.disposition) ||
    typeof report.reasonCode !== 'string' || !Object.hasOwn(REASONS, report.reasonCode) ||
    !(typeof report.resourceRuntimeRequired === 'boolean' || report.resourceRuntimeRequired === null && report.sourceState !== 'healthy') ||
    typeof report.sampledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.sampledAt) ||
    !Number.isFinite(Date.parse(report.sampledAt)) || new Date(report.sampledAt).toISOString() !== report.sampledAt ||
    report.sourceState !== 'healthy' && (report.universeId !== null || report.observedState !== null ||
      report.resourceRuntimeRequired !== null || report.disposition !== 'unavailable')) throw invalid();
  return value as UniverseCampaignReadinessView;
}

/** On demand only: independent from the overview's polling and SSE invalidation keys. */
export function universeCampaignReadinessQuery(campaignId: string, universeId: string): QueryDef<UniverseCampaignReadinessView> {
  if (!ID.test(campaignId) || !ID.test(universeId)) throw new Error('Invalid recorded campaign check identity.');
  return {
    key: `universe-campaign-readiness:${universeId}:${campaignId}`,
    fetch: async (signal) => validateUniverseCampaignReadinessView(
      await apiGet<unknown>(`/api/universe/campaign-readiness?campaignId=${encodeURIComponent(campaignId)}`, signal), campaignId, universeId),
  };
}
