/**
 * components/notifications/useNotificationEngine.ts — the one place that
 * turns backend queries into the notification store's active list. Mount
 * this exactly once (NotificationCenter does, unconditionally, regardless
 * of whether its panel is open) — it has no UI of its own.
 *
 * `runsQuery` and `inboxQuery` are already SSE-live (their cache keys
 * 'runs'/'inbox' are in data/sse.ts's EVENT_TO_CACHE_KEYS), so subscribing
 * via useQuery is enough to stay current for those two. `controlSnapshotQuery`
 * and `fleetStatusQuery` are NOT currently wired into any SSE event (their
 * keys 'control-snapshot' / 'fleet' don't appear in that map) — rather than
 * touch data/sse.ts (a file several concurrent view-agents are already
 * editing) this engine polls those two itself on an interval, so
 * notifications grounded in fleet.nextActions / security / limits / daemon
 * health still update continuously instead of only once per page load.
 */
import { useEffect } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlSnapshotQuery, fleetStatusQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { deriveNotifications } from './deriveNotifications.js';
import { reconcileNotifications } from './notification-store.js';

/** control-snapshot / fleet-status aren't SSE-invalidated (see header
 * comment) — this is this engine's own refresh cadence for those two. */
export const NOTIFICATION_SUMMARY_POLL_MS = 8000;

export function useNotificationEngine(): void {
  const control = useQuery(controlSnapshotQuery);
  const fleet = useQuery(fleetStatusQuery);
  const runs = useQuery(runsQuery);
  const inbox = useQuery(inboxQuery);

  const refetchControl = useRefetch(controlSnapshotQuery);
  const refetchFleet = useRefetch(fleetStatusQuery);

  useEffect(() => {
    const id = setInterval(() => {
      refetchControl();
      refetchFleet();
    }, NOTIFICATION_SUMMARY_POLL_MS);
    return () => clearInterval(id);
  }, [refetchControl, refetchFleet]);

  const controlData = control.data;
  const fleetData = fleet.data;
  const runsData = runs.data;
  const inboxData = inbox.data;

  useEffect(() => {
    reconcileNotifications(
      deriveNotifications({
        control: controlData,
        fleet: fleetData,
        runs: runsData,
        inbox: inboxData,
      }),
    );
  }, [controlData, fleetData, runsData, inboxData]);
}
