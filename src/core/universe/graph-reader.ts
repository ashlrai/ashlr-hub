import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultUniverseRoot, inspectPrivateDirectory } from './artifacts.js';
import { readUniverseCampaignsForUniverse } from './campaign-store.js';
import { readUniverseDeliveries } from './delivery.js';
import { buildUniverseGraph } from './graph.js';
import { projectUniverse, universePath } from './store.js';
import type { UniverseGraph } from './graph-types.js';
import type { UniverseOverview, UniverseStoreOptions } from './types.js';

/**
 * Targeted observation: no provider calls, graph store, execution lock or writes.
 * Other universes' artifacts and delivery repositories are never inspected.
 * Historical artifact digests remain recorded evidence, not fresh byte checks.
 */
export function readUniverseGraph(universeId: string, options: UniverseStoreOptions = {}): UniverseGraph {
  const root = resolve(options.root ?? defaultUniverseRoot());
  const directory = universePath(root, universeId); // Validate identity before I/O.
  const overview: UniverseOverview = { schemaVersion: 1, sampledAt: new Date().toISOString(),
    sourceState: 'missing', reasons: [], universes: [], campaigns: [], deliveryReports: [],
    measurementScope: 'local-experiment' };
  try {
    for (const path of [root, join(root, 'universes'), directory]) {
      try { lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return buildUniverseGraph(overview, universeId);
        throw error;
      }
      inspectPrivateDirectory(path);
    }
    const universe = projectUniverse(directory);
    overview.universes.push(universe);
    const campaigns = readUniverseCampaignsForUniverse(universe, { root });
    const delivery = readUniverseDeliveries(universeId, { root });
    overview.campaigns = campaigns.campaigns;
    overview.deliveryReports = [{ universeId, ...delivery }];
    overview.reasons = [...universe.reasons, ...campaigns.reasons, ...delivery.reasons];
    overview.sourceState = universe.sourceState === 'degraded' || campaigns.sourceState === 'degraded' ||
      delivery.sourceState === 'degraded' ? 'degraded' : 'healthy';
  } catch (error) {
    overview.sourceState = 'degraded';
    overview.reasons.push(error instanceof Error ? error.message : 'Universe graph evidence unavailable');
  }
  return buildUniverseGraph(overview, universeId);
}
