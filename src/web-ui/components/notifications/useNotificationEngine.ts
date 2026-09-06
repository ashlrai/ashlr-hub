/**
 * components/notifications/useNotificationEngine.ts — the one place that
 * turns backend queries into the notification store's active list. Mount
 * this exactly once (NotificationCenter does, unconditionally, regardless
 * of whether its panel is open) — it has no UI of its own.
 *
 * All four queries share the authenticated SSE refresh channel. Runs/inbox
 * have direct events; daemon observations invalidate control-snapshot and
 * fleet-activity observations invalidate fleet. useQuery fetches initially
 * and subscribes to those cache updates, so a second notification poller
 * would duplicate the same expensive reads even with the panel closed.
 */
import { useEffect } from 'react';
import { useQuery } from '../../data/hooks.js';
import { controlSnapshotQuery, fleetStatusQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { deriveNotifications } from './deriveNotifications.js';
import { reconcileNotifications } from './notification-store.js';

export function useNotificationEngine(): void {
  const control = useQuery(controlSnapshotQuery);
  const fleet = useQuery(fleetStatusQuery);
  const runs = useQuery(runsQuery);
  const inbox = useQuery(inboxQuery);

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
