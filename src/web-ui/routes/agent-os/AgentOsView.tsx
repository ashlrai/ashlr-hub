/**
 * Authenticated, read-only Agent OS route.
 *
 * The cockpit is mounted only for a complete healthy snapshot with an
 * authenticated persistence envelope and every authority bit false. Missing,
 * degraded, unauthenticated, or unexpectedly authoritative responses render
 * an explicit evidence state and never fall back to sample values.
 */

import { useRef } from 'react';

import { AgentOsCockpit } from '../../components/agent-os/AgentOsCockpit.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { useQuery } from '../../data/hooks.js';
import { agentOsSnapshotQuery } from '../../data/queries.js';
import type { AgentOsSnapshotResponse } from '../../data/api-types.js';
import { useScrollRestore } from '../../hooks/useScrollRestore.js';
import styles from './AgentOsView.module.css';

function hasNoOperationalAuthority(response: AgentOsSnapshotResponse): boolean {
  return response.authority === 'observation-only' && response.sameUserTamperResistant === false &&
    response.rollbackProtected === false &&
    response.historicalAuthority === false && response.executionAuthority === false &&
    response.proposalAuthority === false && response.mergeAuthority === false &&
    response.deployAuthority === false && response.publicationAuthority === false &&
    response.externalMutationAuthority === false;
}

function unavailableReason(response: AgentOsSnapshotResponse): string {
  if (response.reason) return response.reason;
  if (response.sourceState === 'missing') return 'No authenticated Agent OS snapshot has been recorded.';
  if (response.authentication !== 'authenticated') return 'Snapshot authentication is unavailable or invalid.';
  if (response.sameUserTamperResistant !== false) return 'The response made an unsupported same-user tamper-resistance claim.';
  if (!hasNoOperationalAuthority(response)) return 'The response crossed the observation-only authority boundary.';
  if (!response.complete) return 'The snapshot chain is incomplete.';
  if (!response.snapshot) return 'No verified Agent OS snapshot is available.';
  return 'The Agent OS snapshot is degraded.';
}

function sourceTone(response: AgentOsSnapshotResponse): Tone {
  if (response.sourceState === 'healthy' && response.complete && response.authentication === 'authenticated' &&
    hasNoOperationalAuthority(response) && response.snapshot !== null) {
    return 'success';
  }
  if (response.sourceState === 'degraded' || response.authentication === 'invalid' ||
    !hasNoOperationalAuthority(response)) return 'warning';
  return 'unknown';
}

export function AgentOsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/agent-os', containerRef);
  const query = useQuery(agentOsSnapshotQuery);
  const response = query.data;
  const renderable = response?.sourceState === 'healthy' && response.complete &&
    response.authentication === 'authenticated' && hasNoOperationalAuthority(response) && response.snapshot !== null;

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Overview</p>
          <h1 className={styles.title}>Agent-native engineering OS</h1>
          <p className={styles.subtitle}>Authenticated fleet intelligence. Observation only.</p>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          {response ? (
            <StatusBadge status={response.sourceState} tone={sourceTone(response)}>
              {response.sourceState}
            </StatusBadge>
          ) : null}
        </div>
      </header>

      {query.status === 'loading' ? (
        <section className={styles.loading} aria-label="Loading Agent OS snapshot">
          <SkeletonLine width="65%" />
          <SkeletonLine width="90%" />
          <SkeletonLine width="75%" />
        </section>
      ) : query.status === 'error' ? (
        <section className={styles.unavailable} role="alert">
          <h2>Agent OS snapshot unavailable</h2>
          <p>{query.error?.message ?? 'The read-only Agent OS endpoint could not be reached.'}</p>
          <p className={styles.boundary}>No capability, value, or next-action values are inferred when the source cannot be read.</p>
        </section>
      ) : response && renderable && response.snapshot ? (
        <AgentOsCockpit snapshot={response.snapshot} />
      ) : response ? (
        <section className={styles.unavailable} role="status">
          <div className={styles.unavailableHeading}>
            <h2>{response.sourceState === 'missing' ? 'No Agent OS snapshot yet' : 'Agent OS snapshot degraded'}</h2>
            <StatusBadge status={response.authentication} tone={response.authentication === 'authenticated' ? 'success' : 'warning'} />
          </div>
          <p>{unavailableReason(response)}</p>
          <p className={styles.boundary}>The cockpit remains hidden until a complete authenticated observation-only snapshot is available.</p>
        </section>
      ) : (
        <section className={styles.unavailable} role="status">
          <h2>Agent OS snapshot unavailable</h2>
          <p>No response was provided by the read-only Agent OS endpoint.</p>
        </section>
      )}
    </div>
  );
}
