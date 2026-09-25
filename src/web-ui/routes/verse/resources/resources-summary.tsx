/**
 * routes/verse/resources/resources-summary.tsx — the edge handle's dot,
 * loaded after first paint (unit 3.11 C6).
 *
 * Mounted by the shell once, renders nothing, and publishes one tone and one
 * sentence to resources-store for the handle and the rail button. It reads the
 * same app-wide seat + health caches as the rail's capacity ring
 * (useCapacityData, budget OFF), so it adds no request of its own and keeps
 * no poll alive that the rail does not already keep — the cheap summary the
 * handle needs, never the drawer's heavier reads.
 */
import { useEffect, useMemo } from 'react';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { buildCapacityRows } from '../usage/capacity-strip-model.js';
import { summarizeResources } from './resources-model.js';
import { setResourcesSummary } from './resources-store.js';

export function ResourcesSummaryProbe() {
  const data = useCapacityData({ withBudget: false });
  const healthRead = data.health !== null;
  const summary = useMemo(
    () => (data.loading ? null : summarizeResources(buildCapacityRows(data.seats, { health: data.health, local: 'hide' }), { healthRead })),
    [data.loading, data.seats, data.health, healthRead],
  );
  useEffect(() => {
    setResourcesSummary(summary);
  }, [summary]);
  return null;
}
