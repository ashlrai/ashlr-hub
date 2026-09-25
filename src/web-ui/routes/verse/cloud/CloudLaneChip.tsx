/**
 * routes/verse/cloud/CloudLaneChip.tsx — "Cloud · N running" at the end of
 * Fleet's lanes row (3.11 unit C3; mounted by fleet/FleetCards.tsx
 * LanesStrip). Styled by the lanes row's own classes, which it passes in,
 * so it reads as one more lane.
 *
 * N counts tasks queued, launching or running — sessions Verse started that
 * have not delivered a PR yet. A server without the cloud lane renders no
 * chip at all: the lanes row is not the place to say "not in this build".
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { inFlightCount } from './cloud-model.js';
import { CLOUD_POLL_MS, cloudQuery } from './cloud-queries.js';
import styles from './cloud.module.css';

export interface CloudLaneChipClasses {
  lane?: string;
  name?: string;
  sep?: string;
  slots?: string;
}

export function CloudLaneChip({ classes = {} }: { classes?: CloudLaneChipClasses }) {
  const read = useQuery(cloudQuery, { freshMs: 15_000 });
  const refetch = useRefetch(cloudQuery);
  usePollWhileVisible(refetch, CLOUD_POLL_MS);
  const overview = read.data?.value ?? null;
  if (!overview) return null;
  const running = inFlightCount(overview.tasks);
  const title = `Claude Code cloud sessions Verse launched that have not delivered a PR yet. ${overview.budget.sessionsToday} of ${overview.budget.budget.maxSessionsPerDay} sessions used today.`;
  return (
    <li className={`${classes.lane ?? ''} ${styles.laneChip}`} data-active={running > 0 || undefined} title={title} aria-label={`Cloud: ${running} running`}>
      <span className={classes.name}>Cloud</span>
      <span className={classes.sep} aria-hidden="true">
        {' · '}
      </span>
      <span className={classes.slots}>{running} running</span>
    </li>
  );
}
