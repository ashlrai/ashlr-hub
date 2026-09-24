/**
 * routes/verse/sections/AutonomySection.tsx — the 3.9 rail entry for the
 * legacy Autonomy cockpit. 3.10 moved the cockpit to Fleet ▸ Advanced
 * (fleet/Advanced.tsx; SPEC-310C §5, unit C7); stored `autonomy` sections
 * migrate to Fleet (workbench-types migrateSectionId).
 *
 * WHY this wrapper still exists: the shell (C1) retires the old rail entry in
 * the same release, and until it lands the current rail still lazy-loads
 * `sections/AutonomySection.tsx` by name — deleting it first would turn the
 * rail item into a MissingSection. Delete this file once C1's rail no longer
 * lists `autonomy` (follow-up noted in the C7 report).
 */
import { FleetAdvanced } from '../fleet/Advanced.js';

export function AutonomySection() {
  return <FleetAdvanced />;
}
