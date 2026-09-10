import type { UniverseCampaignReadiness } from '../universe/campaign-readiness.js';
import type { UniversePortfolioControllerReport } from '../universe/portfolio-controller-types.js';

/** Advisory recorded state only; no execution identity or automatic authority. */
export type UniverseCampaignReadinessView = Pick<UniverseCampaignReadiness,
  'schemaVersion' | 'readinessScope' | 'campaignId' | 'universeId' | 'observedState' |
  'sourceState' | 'disposition' | 'reasonCode' | 'resourceRuntimeRequired' | 'sampledAt'>;

/** Persisted evidence only; in-flight records do not prove a process is alive. */
export type UniversePortfolioControllerView = Pick<UniversePortfolioControllerReport,
  'schemaVersion' | 'controllerId' | 'sourceState' | 'status' | 'createdAt' | 'deadlineAt' | 'observedAt' | 'reasons'> & {
  outcomes: Array<Pick<UniversePortfolioControllerReport['outcomes'][number],
    'campaignId' | 'state' | 'attempted' | 'reasonCode'>>;
  control?: Pick<NonNullable<UniversePortfolioControllerReport['control']>,
    'mode' | 'sequence' | 'requestedAt' | 'acknowledgedAt'>;
};

export interface UniverseConsoleServerOptions { root: string; port?: number }
export interface UniverseConsoleServerHandle {
  url: string;
  consoleUrl: string;
  port: number;
  readToken: string;
  close(): Promise<void>;
}
