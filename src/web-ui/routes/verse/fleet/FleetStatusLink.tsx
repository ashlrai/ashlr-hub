/**
 * routes/verse/fleet/FleetStatusLink.tsx — Command's one line about the fleet
 * (3.15). The fleet is operated in ONE place, the Fleet tab; Command states
 * where it stands and links there, instead of repeating its controls, its
 * ladder or its setup steps.
 *
 *   ● Running · 3 agents working · stage shadow            [Open Fleet ⌘2]
 */
import type { FleetControlStateV1 } from '../../../../core/fleet/fleet-control-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery } from '../../../data/hooks.js';
import { setVerseSection } from '../verse-ui-store.js';
import { detectKeyPlatform, formatChord } from '../shell/command-catalog.js';
import { commandChord } from '../shell/command-keys.js';
import { fleetControlQuery } from './fleet-control-queries.js';
import styles from './fleet-control.module.css';

const TONE: Record<FleetControlStateV1['state'], string> = {
  running: 'running',
  idle: 'ok',
  paused: 'warning',
  stopped: 'danger',
  blocked: 'danger',
  off: 'muted',
};

export function FleetStatusLink() {
  const read = useQuery(fleetControlQuery, { freshMs: 10_000 });
  const state = read.data?.value ?? null;
  // An older server without the control route: nothing to link from here.
  if (!state) return null;
  const chord = commandChord('surface.fleet');
  const key = chord ? formatChord(chord, detectKeyPlatform()) : null;
  const anchor = state.blocker ? 'fleet-control' : state.grant.state === 'active' ? 'autonomy' : 'fleet-control';
  return (
    <div className={styles.statusLink} data-testid="fleet-status-link" data-state={state.state}>
      <p className={styles.statusLinkLine}>
        <span className={styles.dot} data-tone={TONE[state.state]} aria-hidden="true" />
        <span>{state.headline}</span>
      </p>
      <Button size="sm" variant={state.blocker ? 'primary' : 'subtle'} onClick={() => setVerseSection('fleet', anchor)} aria-keyshortcuts={key ?? undefined}>
        {state.blocker && state.blocker.action.kind !== 'wait' ? `${state.blocker.action.label} in Fleet` : 'Open Fleet'}
        {key ? <kbd className={styles.kbd}>{key}</kbd> : null}
      </Button>
    </div>
  );
}
