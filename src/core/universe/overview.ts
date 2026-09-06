import { readUniverseOverview as readExperiments } from './store.js';
import { readUniverseCampaigns } from './campaign-store.js';
import { readUniverseDeliveries } from './delivery.js';
import type { UniverseOverview, UniverseStoreOptions } from './types.js';

/** Read-only composition: neither missing store creates directories or owners. */
export function readUniverseOverview(options: UniverseStoreOptions = {}): UniverseOverview {
  const experiments = readExperiments(options);
  const campaigns = readUniverseCampaigns(options);
  const deliveryReports = experiments.universes.map((universe) => ({
    universeId: universe.manifest.id,
    ...readUniverseDeliveries(universe.manifest.id, options),
  }));
  const reasons = [...experiments.reasons, ...campaigns.reasons,
    ...deliveryReports.flatMap((report) => report.reasons.map((reason) => `${report.universeId}: ${reason}`))];
  return { ...experiments, campaigns: campaigns.campaigns, deliveryReports, reasons,
    sourceState: experiments.sourceState === 'degraded' || campaigns.sourceState === 'degraded' ||
      deliveryReports.some((report) => report.sourceState === 'degraded') ? 'degraded' :
      experiments.sourceState === 'healthy' || campaigns.sourceState === 'healthy' ? 'healthy' : 'missing' };
}
