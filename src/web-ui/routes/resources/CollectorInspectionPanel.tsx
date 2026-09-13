import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { validResourceCollectorInspection } from '../../data/resource-pool-queries.js';
import { resourceTime } from './CapacityBoard.js';
import styles from './ResourcePoolView.module.css';

type Inspection = NonNullable<ResourceConsoleSnapshot['collectorInspection']>;
const COPY = {
  'no-pending-record': { label: 'No pending record observed', detail: 'No pending collector record was found at this sample. This does not establish collector readiness or fresh quota evidence.' },
  'legacy-owner-evidence-missing': { label: 'Legacy ownership evidence missing', detail: 'The legacy pending record lacks original owner, boot and process-group proof. Preserve the marker and reconcile the original shutdown evidence; do not delete it. A restart or reboot alone does not establish cleanup.' },
  'recovery-not-evaluated': { label: 'Pending record observed', detail: 'A versioned pending record was found. Recovery was not evaluated; this inspection does not mean the record is unrecoverable or establish that its processes have stopped.' },
  'pending-evidence-unavailable': { label: 'Record inspection unavailable', detail: 'The pending record could not be inspected safely. Its presence and contents are not established by this sample.' },
} as const;

export function CollectorInspectionPanel({ inspection, historical = false }: {
  inspection?: Inspection; historical?: boolean;
}) {
  if (inspection === undefined) return null;
  // The network decoder rejects these too. Direct component callers must never
  // turn an unknown reason/path or contradictory state into operator guidance.
  const valid = validResourceCollectorInspection(inspection);
  const copy = valid ? COPY[inspection.reasonCode] : COPY['pending-evidence-unavailable'];
  const tone = historical || !valid || inspection.state === 'unavailable' ? 'unknown' : inspection.state === 'pending' ? 'warning' : 'neutral';
  return <section className={styles.board} aria-labelledby="collector-inspection-title">
    <div className={styles.sectionHeading}><div><h2 id="collector-inspection-title">Collector record inspection</h2>
      <p>Passive local record inspection only. No collector startup or recovery was attempted; provider freshness and execution readiness are not attested.</p>
    </div></div>
    <div className={styles.collectorNotice} role="status">
      <StatusBadge status={tone} tone={tone}>{historical ? 'Last reported: ' : ''}{copy.label}</StatusBadge>
      {historical ? <p className={styles.warning}>Retained sample only. Current collector records, activity and quota freshness are unverified.</p> : null}
      <p>{historical ? 'At that sample: ' : ''}{copy.detail}</p>
      {valid ? <p className={styles.boardNote}>{historical ? 'Retained inspection sample' : 'Local inspection sampled'}: <time dateTime={inspection.sampledAt}>{resourceTime(inspection.sampledAt)}</time>.</p> : null}
      <p className={styles.boardNote}>Inspection does not change account pauses, quota reservations or usage ceilings.</p>
    </div>
  </section>;
}
