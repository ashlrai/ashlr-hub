import type { UniverseCampaignReadiness } from '../universe/campaign-readiness.js';

/** Advisory recorded state only; no execution identity or automatic authority. */
export type UniverseCampaignReadinessView = Pick<UniverseCampaignReadiness,
  'schemaVersion' | 'readinessScope' | 'campaignId' | 'universeId' | 'observedState' |
  'sourceState' | 'disposition' | 'reasonCode' | 'resourceRuntimeRequired' | 'sampledAt'>;

export interface UniverseConsoleServerOptions { root: string; port?: number }
export interface UniverseConsoleServerHandle {
  url: string;
  consoleUrl: string;
  port: number;
  readToken: string;
  close(): Promise<void>;
}
