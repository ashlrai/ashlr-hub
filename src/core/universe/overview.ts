import { readUniverseOverview as readExperiments } from './store.js';
import { readUniverseCampaigns } from './campaign-store.js';
import type { UniverseOverview, UniverseStoreOptions } from './types.js';

/** Read-only composition: neither missing store creates directories or owners. */
export function readUniverseOverview(options: UniverseStoreOptions = {}): UniverseOverview {
  const experiments = readExperiments(options);
  const campaigns = readUniverseCampaigns(options);
  const reasons = [...experiments.reasons, ...campaigns.reasons];
  return { ...experiments, campaigns: campaigns.campaigns, reasons,
    sourceState: experiments.sourceState === 'degraded' || campaigns.sourceState === 'degraded' ? 'degraded' :
      experiments.sourceState === 'healthy' || campaigns.sourceState === 'healthy' ? 'healthy' : 'missing' };
}
